import crypto from 'node:crypto';
import os from 'node:os';
import { SqlError, ErrorCodes } from '../../errors.js';
import { resolveConnection } from './options.js';
import { ScramSha256 } from './scram.js';
import { createReader, openStream } from './stream.js';

/**
 * PostgreSQL frontend/backend protocol, version 3.0.
 *
 * Speaks the wire protocol directly over TCP or TLS: startup, password and
 * SASL (SCRAM-SHA-256) authentication, the simple query protocol for
 * statements without parameters, and the extended query protocol (Parse,
 * Bind, Describe, Execute, Sync) for parameterised statements. Text-format
 * values are decoded using the type OIDs in each RowDescription.
 *
 * @param {object} options options passed to `connect()`
 */
export async function createPostgresConnection(options = {}) {
  const settings = resolveConnection(options, {
    port: 5432,
    user: options.user ?? process.env.PGUSER ?? os.userInfo().username,
    ssl: 'prefer'
  });

  const socket = await openStream(settings, { negotiate: true });
  const connection = new PostgresConnection(socket, settings);
  try {
    await connection.start();
  } catch (error) {
    socket.destroy();
    throw error instanceof SqlError ? error : wrap(error, 'The PostgreSQL connection could not be started.');
  }
  return connection;
}

class PostgresConnection {
  /**
   * @param {import('node:net').Socket} socket
   * @param {Record<string, any>} settings
   */
  constructor(socket, settings) {
    this.socket = socket;
    this.settings = settings;
    this.reader = createReader(socket, (buffer) =>
      buffer.length < 5 ? null : 1 + buffer.readInt32BE(1)
    );
    this.queue = Promise.resolve();
    this.closed = false;
  }

  /** Send the startup message and authenticate. */
  async start() {
    const parameters = [
      ['user', this.settings.user],
      ['client_encoding', 'UTF8'],
      ['application_name', 'micro-sql']
    ];
    if (this.settings.database) parameters.push(['database', this.settings.database]);

    const parts = [int32(196608)];
    for (const [key, value] of parameters) parts.push(cstr(key), cstr(String(value)));
    parts.push(Buffer.from([0]));

    this.socket.write(Buffer.concat([int32(Buffer.concat(parts).length + 4), ...parts]));
    await this.authenticate();
  }

  async authenticate() {
    /** @type {ScramSha256 | null} */
    let scram = null;
    let authenticated = false;

    while (true) {
      const { type, payload } = await this.read();
      if (type === 'E') throw this.errorFrom(payload);

      if (type === 'R') {
        const code = payload.readInt32BE(0);
        if (code === 0) {
          authenticated = true;
        } else if (code === 3) {
          this.send('p', cstr(this.settings.password));
        } else if (code === 5) {
          const salt = payload.subarray(4, 8);
          this.send('p', cstr(md5Password(this.settings.password, this.settings.user, salt)));
        } else if (code === 10) {
          const mechanisms = payload.subarray(4).toString('utf8').split('\0').filter(Boolean);
          if (!mechanisms.includes('SCRAM-SHA-256')) {
            throw new SqlError(
              ErrorCodes.DRIVER_ERROR,
              `Unsupported PostgreSQL SASL mechanism(s): ${mechanisms.join(', ') || 'none'}.`
            );
          }
          scram = new ScramSha256(this.settings.password);
          const initial = Buffer.from(scram.initialResponse, 'utf8');
          this.send('p', cstr('SCRAM-SHA-256'), int32(initial.length), initial);
        } else if (code === 11) {
          if (!scram) throw new SqlError(ErrorCodes.DRIVER_ERROR, 'Unexpected PostgreSQL SASL continuation.');
          this.send('p', Buffer.from(scram.continue(payload.subarray(4).toString('utf8')), 'utf8'));
        } else if (code === 12) {
          if (!scram) throw new SqlError(ErrorCodes.DRIVER_ERROR, 'Unexpected PostgreSQL SASL final message.');
          scram.finish(payload.subarray(4).toString('utf8'));
        } else {
          throw new SqlError(
            ErrorCodes.DRIVER_ERROR,
            `Unsupported PostgreSQL authentication method (${code}).`
          );
        }
        continue;
      }

      if (type === 'Z') {
        if (!authenticated) {
          throw new SqlError(ErrorCodes.DRIVER_ERROR, 'The PostgreSQL server finished authentication unexpectedly.');
        }
        return;
      }
      // ParameterStatus, BackendKeyData and NoticeResponse need no handling.
    }
  }

  /** @param {string} sql @param {unknown[]} values @param {{returnsRows: boolean}} options */
  async query(sql, values = [], options = {}) {
    return this.enqueue(() =>
      values.length === 0 ? this.simpleQuery(sql) : this.extendedQuery(sql, values)
    ).catch((error) => {
      // Errors reported by the server carry a SQLSTATE in `code`; keep them so
      // the client can map them to a stable SqlError code.
      if (error instanceof SqlError || (error && error.code !== undefined)) throw error;
      throw wrap(error, 'The query could not be sent.');
    });
  }

  /** @param {string} sql */
  async exec(sql) {
    return this.enqueue(() => this.simpleQuery(sql)).then(() => undefined);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.send('X');
    } catch {
      // The socket may already be gone.
    }
    await new Promise((resolve) => {
      this.socket.once('close', resolve);
      this.socket.end();
      setTimeout(resolve, 1000).unref?.();
    });
  }

  /** @param {() => Promise<any>} task */
  enqueue(task) {
    if (this.closed) {
      return Promise.reject(new SqlError(ErrorCodes.DRIVER_ERROR, 'This connection is closed.'));
    }
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async simpleQuery(sql) {
    this.send('Q', cstr(sql));
    return this.readResults();
  }

  async extendedQuery(sql, values) {
    const parse = Buffer.concat([cstr(''), cstr(sql), int16(0)]);

    const valueParts = [int16(values.length)];
    for (const value of values) {
      if (value === null || value === undefined) {
        valueParts.push(int32(-1));
        continue;
      }
      const bytes = encodeParameter(value);
      valueParts.push(int32(bytes.length), bytes);
    }
    const bind = Buffer.concat([
      cstr(''),
      cstr(''),
      int16(0),
      ...valueParts,
      int16(0)
    ]);

    this.socket.write(
      Buffer.concat([
        frame('P', parse),
        frame('B', bind),
        frame('D', Buffer.concat([Buffer.from('P'), cstr('')])),
        frame('E', Buffer.concat([cstr(''), int32(0)])),
        frame('S')
      ])
    );

    return this.readResults();
  }

  /** Read messages until ReadyForQuery. */
  async readResults() {
    /** @type {{name: string, dataTypeID: number}[] | null} */
    let fields = null;
    const rows = [];
    let tag = '';
    /** @type {Error | null} */
    let failure = null;

    while (true) {
      const { type, payload } = await this.read();
      if (type === 'T') {
        fields = parseRowDescription(payload);
      } else if (type === 'D') {
        if (fields) rows.push(parseDataRow(payload, fields));
      } else if (type === 'C') {
        tag = cstrToString(payload, 0).value;
      } else if (type === 'E') {
        failure = this.errorFrom(payload);
      } else if (type === 'Z') {
        break;
      }
      // ParseComplete, BindComplete, NoData, NoticeResponse and friends are
      // deliberately ignored.
    }

    if (failure) throw failure;
    const changes = parseCommandTag(tag);
    if (fields) return { rows, changes };
    return { changes, lastInsertRowid: 0 };
  }

  /** @returns {Promise<{ type: string, payload: Buffer }>} */
  async read() {
    const frameBuffer = await this.reader.read();
    const type = String.fromCharCode(frameBuffer[0]);
    const length = frameBuffer.readInt32BE(1);
    return { type, payload: frameBuffer.subarray(5, 1 + length) };
  }

  /** @param {string} type @param {...Buffer} parts */
  send(type, ...parts) {
    this.socket.write(frame(type, ...parts));
  }

  /** @param {Buffer} payload */
  errorFrom(payload) {
    let offset = 0;
    /** @type {Record<string, string>} */
    const fields = {};
    while (offset < payload.length && payload[offset] !== 0) {
      const code = String.fromCharCode(payload[offset]);
      const { value, next } = cstrToString(payload, offset + 1);
      fields[code] = value;
      offset = next;
    }

    const error = new Error(fields.M || 'The PostgreSQL server reported an error.');
    error.code = fields.C;
    error.severity = fields.S;
    error.detail = fields.D;
    error.hint = fields.H;
    if (fields.P) error.position = Number(fields.P);
    if (fields.n) error.table = fields.n;
    if (fields.c) error.column = fields.c;
    return error;
  }
}

/* ------------------------------------------------------------------ */
/* Protocol encoding                                                   */
/* ------------------------------------------------------------------ */

function frame(type, ...parts) {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(5);
  header[0] = type.charCodeAt(0);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

function int16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value, 0);
  return buffer;
}

function int32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function cstr(value) {
  return Buffer.from(`${value}\0`, 'utf8');
}

function cstrToString(buffer, start) {
  const end = buffer.indexOf(0, start);
  return {
    value: buffer.toString('utf8', start, end === -1 ? buffer.length : end),
    next: end === -1 ? buffer.length : end + 1
  };
}

function encodeParameter(value) {
  if (value instanceof Uint8Array) {
    return Buffer.from(`\\x${Buffer.from(value).toString('hex')}`, 'utf8');
  }
  if (typeof value === 'boolean') return Buffer.from(value ? 'true' : 'false', 'utf8');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SqlError(ErrorCodes.PARAMETER_ERROR, 'Only finite numbers can be sent to PostgreSQL.');
    }
    return Buffer.from(String(value), 'utf8');
  }
  return Buffer.from(String(value), 'utf8');
}

function md5Password(password, user, salt) {
  const inner = md5(`${password ?? ''}${user ?? ''}`);
  return `md5${md5(Buffer.concat([Buffer.from(inner, 'utf8'), salt]))}`;
}

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Protocol decoding                                                   */
/* ------------------------------------------------------------------ */

function parseRowDescription(payload) {
  const count = payload.readInt16BE(0);
  let offset = 2;
  const fields = [];
  for (let i = 0; i < count; i += 1) {
    const name = cstrToString(payload, offset);
    offset = name.next + 4 + 2; // table OID + column attribute
    const dataTypeID = payload.readInt32BE(offset);
    offset += 4 + 2 + 4 + 2; // type length + type modifier + format code
    fields.push({ name: name.value, dataTypeID });
  }
  return fields;
}

function parseDataRow(payload, fields) {
  const count = payload.readInt16BE(0);
  let offset = 2;
  const row = {};
  for (let i = 0; i < count; i += 1) {
    const length = payload.readInt32BE(offset);
    offset += 4;
    const field = fields[i];
    if (length === -1) {
      row[field.name] = null;
      continue;
    }
    const text = payload.toString('utf8', offset, offset + length);
    offset += length;
    row[field.name] = decodeValue(text, field.dataTypeID);
  }
  return row;
}

/** Decode a text-format value using its PostgreSQL type OID. */
function decodeValue(text, oid) {
  switch (oid) {
    case 16: // bool
      return text === 't';
    case 21: // int2
    case 23: // int4
    case 26: // oid
      return Number(text);
    case 20: {
      // int8: keep precision instead of silently rounding.
      const value = Number(text);
      return Number.isSafeInteger(value) ? value : text;
    }
    case 700: // float4
    case 701: // float8
      return Number(text);
    case 17: // bytea
      return text.startsWith('\\x') ? Buffer.from(text.slice(2), 'hex') : Buffer.from(text, 'binary');
    default:
      return text;
  }
}

function parseCommandTag(tag) {
  if (!tag) return 0;
  if (tag.startsWith('INSERT')) {
    const parts = tag.split(' ');
    return Number(parts[2] ?? 0) || 0;
  }
  const parts = tag.split(' ');
  const last = Number(parts[parts.length - 1]);
  return Number.isFinite(last) ? last : 0;
}

function wrap(error, prefix) {
  const wrapped = new SqlError(
    ErrorCodes.DRIVER_ERROR,
    `${prefix} ${error && error.message ? error.message : error}`
  );
  wrapped.cause = error;
  return wrapped;
}
