import crypto from 'node:crypto';
import tls from 'node:tls';
import { SqlError, ErrorCodes } from '../../errors.js';
import { resolveConnection, tlsPolicy, tlsOptions } from './options.js';
import { createReader, openStream } from './stream.js';

/**
 * MySQL client/server protocol (protocol version 10).
 *
 * Implements the handshake, `mysql_native_password` and
 * `caching_sha2_password` authentication (including full authentication over
 * TLS or with the server's RSA key), COM_QUERY with the text result set
 * protocol, and COM_STMT_PREPARE/COM_STMT_EXECUTE with binary parameter
 * encoding and binary row decoding.
 *
 * @param {object} options options passed to `connect()`
 */
export async function createMysqlConnection(options = {}) {
  const settings = resolveConnection(options, {
    port: 3306,
    user: options.user ?? process.env.MYSQL_USER ?? 'root',
    ssl: undefined
  });

  const socket = await openStream(settings, { ssl: false });
  const connection = new MysqlConnection(socket, settings);
  try {
    await connection.start();
  } catch (error) {
    socket.destroy();
    throw error instanceof SqlError ? error : wrap(error, 'The MySQL connection could not be started.');
  }
  return connection;
}

const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_SSL = 0x00000800;
const CLIENT_TRANSACTIONS = 0x00002000;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_MULTI_RESULTS = 0x00020000;
const CLIENT_PS_MULTI_RESULTS = 0x00040000;
const CLIENT_PLUGIN_AUTH = 0x00080000;
const CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA = 0x00200000;

const COM_QUIT = 0x01;
const COM_QUERY = 0x03;
const COM_STMT_PREPARE = 0x16;
const COM_STMT_EXECUTE = 0x17;
const COM_STMT_CLOSE = 0x19;

const TYPE = {
  DECIMAL: 0,
  TINY: 1,
  SHORT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  NULL: 6,
  TIMESTAMP: 7,
  LONGLONG: 8,
  INT24: 9,
  DATE: 10,
  TIME: 11,
  DATETIME: 12,
  YEAR: 13,
  NEWDATE: 14,
  VARCHAR: 15,
  BIT: 16,
  JSON: 245,
  NEWDECIMAL: 246,
  ENUM: 247,
  SET: 248,
  TINY_BLOB: 249,
  MEDIUM_BLOB: 250,
  LONG_BLOB: 251,
  BLOB: 252,
  VAR_STRING: 253,
  STRING: 254,
  GEOMETRY: 255
};

const UNSIGNED_FLAG = 0x20;

/** Numeric error codes mapped to the names used by `mapDriverError`. */
const ERROR_NAMES = {
  1040: 'ER_CON_COUNT_ERROR',
  1044: 'ER_DBACCESS_DENIED_ERROR',
  1045: 'ER_ACCESS_DENIED_ERROR',
  1048: 'ER_BAD_NULL_ERROR',
  1050: 'ER_TABLE_EXISTS_ERROR',
  1054: 'ER_BAD_FIELD_ERROR',
  1062: 'ER_DUP_ENTRY',
  1064: 'ER_PARSE_ERROR',
  1146: 'ER_NO_SUCH_TABLE',
  1264: 'ER_DATA_TOO_LONG',
  1292: 'ER_TRUNCATED_WRONG_VALUE',
  1365: 'ER_DIVISION_BY_ZERO',
  1366: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
  1406: 'ER_DATA_TOO_LONG'
};

class MysqlConnection {
  /**
   * @param {import('node:net').Socket} socket
   * @param {Record<string, any>} settings
   */
  constructor(socket, settings) {
    this.socket = socket;
    this.settings = settings;
    this.reader = null;
    this.queue = Promise.resolve();
    this.closed = false;
    // The server's handshake packet is sequence 0, so ours starts at 1.
    this.sequence = 1;
    this.secure = false;
    this.salt = Buffer.alloc(0);
  }

  async start() {
    const handshake = await readFirstPacket(this.socket);
    const server = parseHandshake(handshake);
    this.salt = server.salt;

    const wantsTls = tlsPolicy(this.settings.sslmode) !== 'disable';
    let capabilities =
      CLIENT_PROTOCOL_41 |
      CLIENT_SECURE_CONNECTION |
      CLIENT_TRANSACTIONS |
      CLIENT_MULTI_RESULTS |
      CLIENT_PS_MULTI_RESULTS;
    if (server.capabilities & CLIENT_PLUGIN_AUTH) capabilities |= CLIENT_PLUGIN_AUTH;
    if (server.capabilities & CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA) {
      capabilities |= CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA;
    }
    if (this.settings.database && server.capabilities & CLIENT_CONNECT_WITH_DB) {
      capabilities |= CLIENT_CONNECT_WITH_DB;
    }
    if (wantsTls && server.capabilities & CLIENT_SSL) capabilities |= CLIENT_SSL;

    if (wantsTls && server.capabilities & CLIENT_SSL) {
      this.writePacket(sslRequest(capabilities));
      this.socket = await upgradeToTls(this.socket, this.settings);
      this.secure = true;
    } else if (wantsTls) {
      throw new SqlError(
        ErrorCodes.DRIVER_ERROR,
        'The MySQL server does not support TLS, so the requested secure connection cannot be made.'
      );
    }

    this.reader = createReader(this.socket, mysqlFrameSize);

    const plugin = this.secure
      ? server.authPlugin
      : server.authPlugin || 'mysql_native_password';
    this.writePacket(handshakeResponse(capabilities, this.settings, this.salt, plugin));
    await this.authenticate(plugin);
  }

  async authenticate(plugin) {
    let current = plugin;
    while (true) {
      const packet = await this.readPacket();
      const header = packet[0];

      if (header === 0x00) return parseOk(packet);
      if (header === 0xff) throw errorFromPacket(packet);

      if (header === 0xfe) {
        // AuthSwitchRequest.
        if (packet.length === 1) {
          current = 'mysql_native_password';
          this.writePacket(nativeScramble(this.settings.password, this.salt));
          continue;
        }
        const name = readNulString(packet, 1);
        current = name.value;
        this.salt = trimTrailingNul(packet.subarray(name.next));
        this.writePacket(authResponse(current, this.settings.password, this.salt));
        continue;
      }

      if (header === 0x01) {
        const data = packet.subarray(1);
        const status = data[0];
        if (current === 'caching_sha2_password' || current === 'sha256_password') {
          if (status === 0x03) continue; // fast authentication succeeded
          if (status === 0x04 || current === 'sha256_password') {
            if (this.secure) {
              this.writePacket(Buffer.from(`${this.settings.password}\0`, 'utf8'));
              continue;
            }
            this.writePacket(Buffer.from([0x02]));
            const keyPacket = await this.readPacket();
            if (keyPacket[0] !== 0x01) {
              throw new SqlError(ErrorCodes.DRIVER_ERROR, 'The MySQL server did not send its public key.');
            }
            const pem = keyPacket.subarray(1).toString('utf8');
            this.writePacket(encryptPassword(this.settings.password, pem, this.salt));
            continue;
          }
        }
        throw new SqlError(
          ErrorCodes.DRIVER_ERROR,
          `Unexpected MySQL authentication data (0x${status.toString(16)}).`
        );
      }

      throw new SqlError(
        ErrorCodes.DRIVER_ERROR,
        `Unexpected MySQL authentication packet (0x${header.toString(16)}).`
      );
    }
  }

  /** @param {string} sql @param {unknown[]} values */
  async query(sql, values = []) {
    return this.enqueue(async () => {
      if (!values || values.length === 0) {
        const first = await this.command(Buffer.concat([Buffer.from([COM_QUERY]), Buffer.from(sql, 'utf8')]));
        return this.readResult(first);
      }

      const prepared = await this.prepare(sql);
      try {
        const first = await this.command(buildExecute(prepared.id, values));
        return await this.readResult(first, true);
      } finally {
        this.writer().reset();
        this.writer().write(Buffer.concat([Buffer.from([COM_STMT_CLOSE]), uint32le(prepared.id)]));
      }
    }).catch((error) => {
      // Server errors carry an `ER_*` name in `code`; keep them so the client
      // can map them to a stable SqlError code.
      if (error instanceof SqlError || (error && error.code !== undefined)) throw error;
      throw wrap(error, 'The query could not be sent.');
    });
  }

  /** @param {string} sql */
  async exec(sql) {
    return this.enqueue(async () => {
      const first = await this.command(Buffer.concat([Buffer.from([COM_QUERY]), Buffer.from(sql, 'utf8')]));
      await this.readResult(first);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writer().reset();
      this.writer().write(Buffer.from([COM_QUIT]));
    } catch {
      // The socket may already be gone.
    }
    await new Promise((resolve) => {
      this.socket.once('close', resolve);
      this.socket.end();
      setTimeout(resolve, 1000).unref?.();
    });
  }

  enqueue(task) {
    if (this.closed) {
      return Promise.reject(new SqlError(ErrorCodes.DRIVER_ERROR, 'This connection is closed.'));
    }
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  writer() {
    return {
      reset: () => {
        this.sequence = 0;
      },
      write: (payload) => this.writePacket(payload)
    };
  }

  writePacket(payload) {
    let offset = 0;
    let size;
    do {
      size = Math.min(payload.length - offset, 0xffffff);
      const header = Buffer.alloc(4);
      header.writeUIntLE(size, 0, 3);
      header[3] = this.sequence & 0xff;
      this.sequence = (this.sequence + 1) & 0xff;
      this.socket.write(Buffer.concat([header, payload.subarray(offset, offset + size)]));
      offset += size;
    } while (size === 0xffffff && offset < payload.length);
  }

  async command(payload) {
    this.writer().reset();
    this.writePacket(payload);
    return this.readPacket();
  }

  async readPacket() {
    const chunks = [];
    while (true) {
      const frame = await this.reader.read();
      const length = frame.readUIntLE(0, 3);
      this.sequence = (frame[3] + 1) & 0xff;
      chunks.push(frame.subarray(4, 4 + length));
      if (length < 0xffffff) break;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  }

  async prepare(sql) {
    const packet = await this.command(
      Buffer.concat([Buffer.from([COM_STMT_PREPARE]), Buffer.from(sql, 'utf8')])
    );
    if (packet[0] === 0xff) throw errorFromPacket(packet);
    if (packet[0] !== 0x00) {
      throw new SqlError(ErrorCodes.DRIVER_ERROR, 'Unexpected response to COM_STMT_PREPARE.');
    }

    const id = packet.readUInt32LE(1);
    const columnCount = packet.readUInt16LE(5);
    const parameterCount = packet.readUInt16LE(7);

    for (let i = 0; i < parameterCount; i += 1) await this.readPacket();
    if (parameterCount > 0) await this.readPacket();
    for (let i = 0; i < columnCount; i += 1) await this.readPacket();
    if (columnCount > 0) await this.readPacket();

    return { id };
  }

  /**
   * Read an OK packet or a complete result set.
   * @param {Buffer} first
   * @param {boolean} [binary]
   */
  async readResult(first, binary = false) {
    if (first[0] === 0xff) throw errorFromPacket(first);
    if (first[0] === 0xfb) {
      throw new SqlError(ErrorCodes.DRIVER_ERROR, 'LOCAL INFILE requests are not supported.');
    }
    if (first[0] === 0x00) {
      const ok = parseOk(first);
      return { changes: ok.affectedRows, lastInsertRowid: ok.insertId };
    }

    const columnCount = readLenEncInt(first, 0).value;
    const columns = [];
    for (let i = 0; i < columnCount; i += 1) columns.push(parseColumnDef(await this.readPacket()));
    await this.readPacket(); // EOF after column definitions

    const rows = [];
    while (true) {
      const packet = await this.readPacket();
      if (isEofPacket(packet)) break;
      rows.push(binary ? parseBinaryRow(packet, columns) : parseTextRow(packet, columns));
    }

    return { rows, changes: rows.length };
  }
}

/* ------------------------------------------------------------------ */
/* Handshake and authentication                                        */
/* ------------------------------------------------------------------ */

function mysqlFrameSize(buffer) {
  return buffer.length < 4 ? null : 4 + buffer.readUIntLE(0, 3);
}

function readFirstPacket(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUIntLE(0, 3);
      if (buffer.length < 4 + length) return;
      cleanup();
      resolve(buffer.subarray(4, 4 + length));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('The MySQL server closed the connection during the handshake.'));
    };
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function parseHandshake(payload) {
  if (payload[0] !== 10) {
    throw new SqlError(
      ErrorCodes.DRIVER_ERROR,
      `Unsupported MySQL protocol version ${payload[0]}.`
    );
  }

  let offset = 1;
  const version = readNulString(payload, offset);
  offset = version.next + 4; // connection id
  const salt1 = payload.subarray(offset, offset + 8);
  offset += 8 + 1; // filler
  const capabilitiesLower = payload.readUInt16LE(offset);
  offset += 2;

  if (offset >= payload.length) {
    return {
      version: version.value,
      capabilities: capabilitiesLower,
      salt: salt1,
      authPlugin: 'mysql_native_password'
    };
  }

  offset += 1; // character set
  offset += 2; // status flags
  const capabilitiesUpper = payload.readUInt16LE(offset);
  offset += 2;
  const capabilities = (capabilitiesUpper << 16) | capabilitiesLower;
  const authLength = payload[offset];
  offset += 1 + 10; // auth plugin data length + reserved

  const salt2Length = Math.max(13, authLength - 8);
  const salt2 = trimTrailingNul(payload.subarray(offset, offset + salt2Length));
  offset += salt2Length;

  let authPlugin = 'mysql_native_password';
  if (capabilities & CLIENT_PLUGIN_AUTH && offset < payload.length) {
    authPlugin = readNulString(payload, offset).value || authPlugin;
  }

  return {
    version: version.value,
    capabilities,
    salt: Buffer.concat([salt1, salt2]),
    authPlugin
  };
}

function sslRequest(capabilities) {
  const payload = Buffer.alloc(32);
  payload.writeUInt32LE(capabilities, 0);
  payload.writeUInt32LE(0x01000000, 4);
  payload[8] = 45; // utf8mb4_general_ci
  return payload;
}

function handshakeResponse(capabilities, settings, salt, plugin) {
  const base = Buffer.alloc(32);
  base.writeUInt32LE(capabilities, 0);
  base.writeUInt32LE(0x01000000, 4);
  base[8] = 45; // utf8mb4_general_ci, then 23 reserved zero bytes

  const token = authResponse(plugin, settings.password, salt);
  const auth = Buffer.concat([
    capabilities & CLIENT_PLUGIN_AUTH_LENENC_CLIENT_DATA
      ? encodeLenEncInt(token.length)
      : Buffer.from([token.length]),
    token
  ]);
  const parts = [base, Buffer.from(`${settings.user}\0`, 'utf8'), auth];
  if (capabilities & CLIENT_CONNECT_WITH_DB) {
    parts.push(Buffer.from(`${settings.database}\0`, 'utf8'));
  }
  parts.push(Buffer.from(`${plugin}\0`, 'utf8'));
  return Buffer.concat(parts);
}

function authResponse(plugin, password, salt) {
  if (!password) return Buffer.alloc(0);
  switch (plugin) {
    case 'mysql_native_password':
      return nativeScramble(password, salt);
    case 'caching_sha2_password':
      return cachingSha2Scramble(password, salt);
    case 'mysql_clear_password':
      return Buffer.from(`${password}\0`, 'utf8');
    case 'sha256_password':
      // Without TLS the server asks for its public key after this response.
      return Buffer.from([0x01]);
    default:
      throw new SqlError(
        ErrorCodes.DRIVER_ERROR,
        `Unsupported MySQL authentication plugin: ${plugin}.`
      );
  }
}

function nativeScramble(password, salt) {
  const stage1 = sha1(Buffer.from(password, 'utf8'));
  const stage2 = sha1(stage1);
  return xor(stage1, sha1(Buffer.concat([salt, stage2])));
}

function cachingSha2Scramble(password, salt) {
  const stage1 = sha256(Buffer.from(password, 'utf8'));
  const stage2 = sha256(stage1);
  const stage3 = sha256(stage2);
  return xor(stage1, sha256(Buffer.concat([stage3, salt])));
}

async function upgradeToTls(socket, settings) {
  const policy = tlsPolicy(settings.sslmode);
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ ...tlsOptions(settings, policy), socket });
    secure.setNoDelay(true);
    secure.once('secureConnect', () => {
      secure.removeAllListeners('error');
      resolve(secure);
    });
    secure.once('error', (error) => {
      secure.destroy();
      reject(new SqlError(ErrorCodes.DRIVER_ERROR, `TLS handshake failed: ${error.message}`));
    });
  });
}

function encryptPassword(password, pem, salt) {
  const plain = Buffer.concat([Buffer.from(`${password}\0`, 'utf8')]);
  const scrambled = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i += 1) scrambled[i] = plain[i] ^ salt[i % salt.length];
  return crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    scrambled
  );
}

/* ------------------------------------------------------------------ */
/* Packets                                                             */
/* ------------------------------------------------------------------ */

function parseOk(packet) {
  const affected = readLenEncInt(packet, 1);
  const insert = readLenEncInt(packet, affected.next);
  return {
    affectedRows: Number(affected.value),
    insertId: Number(insert.value)
  };
}

function errorFromPacket(packet) {
  const errno = packet.readUInt16LE(1);
  let offset = 3;
  let sqlState;
  if (packet[offset] === 0x23 /* '#' */) {
    sqlState = packet.toString('utf8', offset + 1, offset + 6);
    offset += 6;
  }
  const error = new Error(packet.toString('utf8', offset));
  error.code = ERROR_NAMES[errno] || String(errno);
  error.errno = errno;
  error.sqlState = sqlState;
  return error;
}

function parseColumnDef(packet) {
  let offset = 0;
  let name = '';
  // catalog, schema, table, org_table, name, org_name
  for (let i = 0; i < 6; i += 1) {
    const entry = readLenEncInt(packet, offset);
    const start = entry.next;
    if (i === 4) name = packet.toString('utf8', start, start + entry.value);
    offset = start + entry.value;
  }
  offset = readLenEncInt(packet, offset).next; // fixed length (0x0c)
  const charset = packet.readUInt16LE(offset);
  offset += 2 + 4; // character set + column length
  const type = packet[offset];
  offset += 1;
  const flags = packet.readUInt16LE(offset);
  return { name, type, flags, charset };
}

function parseTextRow(packet, columns) {
  const row = {};
  let offset = 0;
  for (let i = 0; i < columns.length; i += 1) {
    if (packet[offset] === 0xfb) {
      row[i] = null;
      offset += 1;
      continue;
    }
    const entry = readLenEncInt(packet, offset);
    const start = entry.next;
    row[i] = decodeTextValue(packet.toString('utf8', start, start + entry.value), columns[i]);
    offset = start + entry.value;
  }
  return renameRow(row, columns);
}

function parseBinaryRow(packet, columns) {
  const bitmapLength = (columns.length + 9) >> 3;
  const bitmap = packet.subarray(1, 1 + bitmapLength);
  let offset = 1 + bitmapLength;
  const row = {};
  for (let i = 0; i < columns.length; i += 1) {
    const bit = i + 2;
    if (bitmap[bit >> 3] & (1 << (bit & 7))) {
      row[i] = null;
      continue;
    }
    const decoded = decodeBinaryValue(packet, offset, columns[i]);
    row[i] = decoded.value;
    offset = decoded.next;
  }
  return renameRow(row, columns);
}

function renameRow(row, columns) {
  /** @type {Record<string, unknown>} */
  const named = {};
  columns.forEach((column, index) => {
    named[column.name ?? String(index)] = row[index];
  });
  return named;
}

function decodeTextValue(text, column) {
  switch (column.type) {
    case TYPE.TINY:
    case TYPE.SHORT:
    case TYPE.LONG:
    case TYPE.INT24:
    case TYPE.LONGLONG:
    case TYPE.FLOAT:
    case TYPE.DOUBLE:
    case TYPE.YEAR: {
      const value = Number(text);
      return Number.isFinite(value) ? value : text;
    }
    default:
      return text;
  }
}

function decodeBinaryValue(packet, offset, column) {
  const unsigned = (column.flags & UNSIGNED_FLAG) !== 0;
  switch (column.type) {
    case TYPE.TINY: {
      const value = unsigned ? packet.readUInt8(offset) : packet.readInt8(offset);
      return { value, next: offset + 1 };
    }
    case TYPE.SHORT:
    case TYPE.YEAR: {
      const value = unsigned ? packet.readUInt16LE(offset) : packet.readInt16LE(offset);
      return { value, next: offset + 2 };
    }
    case TYPE.LONG:
    case TYPE.INT24: {
      const value = unsigned ? packet.readUInt32LE(offset) : packet.readInt32LE(offset);
      return { value, next: offset + 4 };
    }
    case TYPE.LONGLONG: {
      const big = unsigned ? packet.readBigUInt64LE(offset) : packet.readBigInt64LE(offset);
      const value = Number(big);
      return { value: Number.isSafeInteger(value) ? value : big.toString(), next: offset + 8 };
    }
    case TYPE.FLOAT:
      return { value: packet.readFloatLE(offset), next: offset + 4 };
    case TYPE.DOUBLE:
      return { value: packet.readDoubleLE(offset), next: offset + 8 };
    case TYPE.DATE:
    case TYPE.DATETIME:
    case TYPE.TIMESTAMP:
    case TYPE.NEWDATE:
      return decodeBinaryDate(packet, offset);
    case TYPE.TIME:
      return decodeBinaryTime(packet, offset);
    case TYPE.BIT: {
      const value = readLenEncInt(packet, offset);
      return {
        value: Buffer.from(packet.subarray(value.next, value.next + value.value)),
        next: value.next + value.value
      };
    }
    default: {
      const value = readLenEncInt(packet, offset);
      const text = packet.toString('utf8', value.next, value.next + value.value);
      return { value: decodeTextValue(text, column), next: value.next + value.value };
    }
  }
}

function decodeBinaryDate(packet, offset) {
  const length = packet[offset];
  const start = offset + 1;
  if (length === 0) return { value: null, next: start };
  const year = packet.readUInt16LE(start);
  const month = packet[start + 2];
  const day = packet[start + 3];
  let value = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (length >= 7) {
    value += ` ${pad(packet[start + 4])}:${pad(packet[start + 5])}:${pad(packet[start + 6])}`;
    if (length >= 11) value += `.${String(packet.readUInt32LE(start + 7)).padStart(6, '0')}`;
  }
  return { value, next: start + length };
}

function decodeBinaryTime(packet, offset) {
  const length = packet[offset];
  const start = offset + 1;
  if (length === 0) return { value: '00:00:00', next: start };
  const negative = packet[start] === 1;
  const days = packet.readUInt32LE(start + 1);
  const hours = packet[start + 5] + days * 24;
  let value = `${negative ? '-' : ''}${pad(hours)}:${pad(packet[start + 6])}:${pad(packet[start + 7])}`;
  if (length >= 12) value += `.${String(packet.readUInt32LE(start + 8)).padStart(6, '0')}`;
  return { value, next: start + length };
}

function buildExecute(statementId, values) {
  const count = values.length;
  const bitmap = Buffer.alloc((count + 7) >> 3);
  const types = Buffer.alloc(count * 2);
  const encoded = [];

  values.forEach((value, index) => {
    if (value === null || value === undefined) {
      bitmap[index >> 3] |= 1 << (index & 7);
      types[index * 2] = TYPE.NULL;
      return;
    }

    if (typeof value === 'boolean') {
      types[index * 2] = TYPE.TINY;
      encoded.push(Buffer.from([value ? 1 : 0]));
      return;
    }

    if (typeof value === 'bigint') {
      types[index * 2] = TYPE.LONGLONG;
      const buffer = Buffer.alloc(8);
      buffer.writeBigInt64LE(value);
      encoded.push(buffer);
      return;
    }

    if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) {
        types[index * 2] = TYPE.LONG;
        const buffer = Buffer.alloc(4);
        buffer.writeInt32LE(value);
        encoded.push(buffer);
      } else if (Number.isInteger(value)) {
        types[index * 2] = TYPE.LONGLONG;
        const buffer = Buffer.alloc(8);
        buffer.writeBigInt64LE(BigInt(value));
        encoded.push(buffer);
      } else {
        types[index * 2] = TYPE.DOUBLE;
        const buffer = Buffer.alloc(8);
        buffer.writeDoubleLE(value);
        encoded.push(buffer);
      }
      return;
    }

    if (value instanceof Uint8Array) {
      types[index * 2] = TYPE.BLOB;
      const bytes = Buffer.from(value);
      encoded.push(encodeLenEncInt(bytes.length), bytes);
      return;
    }

    types[index * 2] = TYPE.VAR_STRING;
    const bytes = Buffer.from(String(value), 'utf8');
    encoded.push(encodeLenEncInt(bytes.length), bytes);
  });

  return Buffer.concat([
    Buffer.from([COM_STMT_EXECUTE]),
    uint32le(statementId),
    Buffer.from([0x00]),
    uint32le(1),
    bitmap,
    Buffer.from([0x01]),
    types,
    ...encoded
  ]);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isEofPacket(packet) {
  return packet[0] === 0xfe && packet.length < 9;
}

function readLenEncInt(buffer, offset) {
  const first = buffer[offset];
  if (first < 0xfb) return { value: first, length: 1, next: offset + 1 };
  if (first === 0xfc) return { value: buffer.readUInt16LE(offset + 1), length: 3, next: offset + 3 };
  if (first === 0xfd) return { value: buffer.readUIntLE(offset + 1, 3), length: 4, next: offset + 4 };
  if (first === 0xfe) {
    return { value: Number(buffer.readBigUInt64LE(offset + 1)), length: 9, next: offset + 9 };
  }
  return { value: 0, length: 1, next: offset + 1 };
}

function encodeLenEncInt(value) {
  if (value < 0xfb) return Buffer.from([value]);
  if (value < 0x10000) {
    const buffer = Buffer.alloc(3);
    buffer[0] = 0xfc;
    buffer.writeUInt16LE(value, 1);
    return buffer;
  }
  if (value < 0x1000000) {
    const buffer = Buffer.alloc(4);
    buffer[0] = 0xfd;
    buffer.writeUIntLE(value, 1, 3);
    return buffer;
  }
  const buffer = Buffer.alloc(9);
  buffer[0] = 0xfe;
  buffer.writeBigUInt64LE(BigInt(value), 1);
  return buffer;
}

function readNulString(buffer, start) {
  const end = buffer.indexOf(0, start);
  return {
    value: buffer.toString('utf8', start, end === -1 ? buffer.length : end),
    next: end === -1 ? buffer.length : end + 1
  };
}

function trimTrailingNul(buffer) {
  let length = buffer.length;
  while (length > 0 && buffer[length - 1] === 0) length -= 1;
  return buffer.subarray(0, length);
}

function uint32le(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest();
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function xor(left, right) {
  const length = Math.min(left.length, right.length);
  const output = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) output[i] = left[i] ^ right[i];
  return output;
}

function wrap(error, prefix) {
  const wrapped = new SqlError(
    ErrorCodes.DRIVER_ERROR,
    `${prefix} ${error && error.message ? error.message : error}`
  );
  wrapped.cause = error;
  return wrapped;
}
