import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';

import { connect } from '../src/client.js';
import { ErrorCodes } from '../src/errors.js';

/**
 * A tiny PostgreSQL server that speaks enough of protocol 3.0 to exercise the
 * client: SCRAM or MD5 authentication, simple queries and the extended query
 * protocol. `respond(sql, values)` returns the result to send back.
 */
async function startPostgresMock({ password = 'secret', auth = 'scram', respond }) {
  const queries = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = 'startup';
    let scram = null;
    let pendingSql = null;
    let pendingValues = [];
    let pendingResult = null;

    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });

    function pump() {
      while (true) {
        if (stage === 'startup') {
          if (buffer.length < 4) return;
          const length = buffer.readInt32BE(0);
          if (buffer.length < length) return;
          const body = buffer.subarray(0, length);
          buffer = buffer.subarray(length);
          const code = body.readInt32BE(4);
          if (code === 80877103) {
            socket.write(Buffer.from([0x4e])); // 'N': no TLS
            continue;
          }
          if (code !== 196608) throw new Error(`Unexpected startup code ${code}`);
          stage = 'auth';
          if (auth === 'md5') {
            socket.write(authMessage(5, Buffer.from([9, 9, 9, 9])));
            stage = 'md5';
          } else {
            socket.write(authMessage(10, Buffer.from('SCRAM-SHA-256\0\0')));
            stage = 'sasl-initial';
          }
          continue;
        }

        if (buffer.length < 5) return;
        const length = buffer.readInt32BE(1);
        if (buffer.length < 1 + length) return;
        const type = String.fromCharCode(buffer[0]);
        const payload = buffer.subarray(5, 1 + length);
        buffer = buffer.subarray(1 + length);
        handle(type, payload);
      }
    }

    function handle(type, payload) {
      if (stage === 'md5') {
        const expected = `md5${crypto
          .createHash('md5')
          .update(
            Buffer.concat([
              Buffer.from(
                crypto.createHash('md5').update(`${password}postgres`).digest('hex'),
                'utf8'
              ),
              Buffer.from([9, 9, 9, 9])
            ])
          )
          .digest('hex')}`;
        if (payload.toString('utf8').replace(/\0$/, '') !== expected) {
          socket.write(errorMessage('28P01', 'password authentication failed'));
          socket.end();
          return;
        }
        finishAuth();
        return;
      }

      if (stage === 'sasl-initial' && type === 'p') {
        const mechanismEnd = payload.indexOf(0);
        const initialLength = payload.readInt32BE(mechanismEnd + 1);
        const initial = payload.toString('utf8', mechanismEnd + 5, mechanismEnd + 5 + initialLength);
        const clientFirstBare = initial.slice(3);
        const clientNonce = /r=([^,]+)/.exec(clientFirstBare)[1];
        const salt = crypto.randomBytes(16);
        const serverFirst = `r=${clientNonce}server,s=${salt.toString('base64')},i=4096`;
        scram = {
          password,
          salt,
          clientFirstBare,
          serverFirst,
          clientFinalWithoutProof: null
        };
        socket.write(authMessage(11, Buffer.from(serverFirst, 'utf8')));
        stage = 'sasl-final';
        return;
      }

      if (stage === 'sasl-final' && type === 'p') {
        const clientFinal = payload.toString('utf8');
        const proofIndex = clientFinal.lastIndexOf(',p=');
        const withoutProof = clientFinal.slice(0, proofIndex);
        const proof = Buffer.from(clientFinal.slice(proofIndex + 3), 'base64');
        const signed = `${scram.clientFirstBare},${scram.serverFirst},${withoutProof}`;
        const salted = crypto.pbkdf2Sync(scram.password, scram.salt, 4096, 32, 'sha256');
        const clientKey = hmac(salted, 'Client Key');
        const storedKey = crypto.createHash('sha256').update(clientKey).digest();
        const signature = hmac(storedKey, signed);
        const expected = Buffer.from(clientKey.map((byte, index) => byte ^ signature[index]));
        if (!expected.equals(proof)) {
          socket.write(errorMessage('28P01', 'password authentication failed'));
          socket.end();
          return;
        }
        const serverSignature = hmac(hmac(salted, 'Server Key'), signed);
        socket.write(authMessage(12, Buffer.from(`v=${serverSignature.toString('base64')}`, 'utf8')));
        finishAuth();
        return;
      }

      if (stage !== 'query') return;

      if (type === 'X') {
        socket.end();
        return;
      }

      if (type === 'Q') {
        const sql = payload.toString('utf8').replace(/\0$/, '');
        queries.push({ sql, values: [], simple: true });
        const result = respond(sql, []);
        sendResult(result);
        return;
      }

      if (type === 'P') {
        const first = payload.indexOf(0);
        pendingSql = payload.toString('utf8', first + 1, payload.indexOf(0, first + 1));
        socket.write(message('1'));
        return;
      }

      if (type === 'B') {
        const first = payload.indexOf(0);
        const second = payload.indexOf(0, first + 1);
        let offset = second + 1 + 2; // skip parameter format codes
        const count = payload.readInt16BE(offset);
        offset += 2;
        pendingValues = [];
        for (let i = 0; i < count; i += 1) {
          const length = payload.readInt32BE(offset);
          offset += 4;
          if (length === -1) {
            pendingValues.push(null);
            continue;
          }
          pendingValues.push(payload.toString('utf8', offset, offset + length));
          offset += length;
        }
        queries.push({ sql: pendingSql, values: pendingValues, simple: false });
        socket.write(message('2'));
        return;
      }

      if (type === 'D') {
        pendingResult = respond(pendingSql, pendingValues);
        if (pendingResult.error) {
          socket.write(errorMessage(pendingResult.error.code, pendingResult.error.message));
        } else if (pendingResult.fields) {
          socket.write(message('T', rowDescription(pendingResult.fields)));
        } else {
          socket.write(message('n'));
        }
        return;
      }

      if (type === 'S') {
        if (!pendingResult.error) {
          if (pendingResult.rows) {
            for (const row of pendingResult.rows) {
              socket.write(message('D', dataRow(row)));
            }
          }
          socket.write(message('C', cstr(pendingResult.tag || 'SELECT 0')));
        }
        socket.write(message('Z', Buffer.from('I')));
        pendingSql = null;
        pendingValues = [];
        pendingResult = null;
      }
    }

    function sendResult(result) {
      if (result.error) {
        socket.write(errorMessage(result.error.code, result.error.message));
      } else {
        if (result.fields) socket.write(message('T', rowDescription(result.fields)));
        for (const row of result.rows || []) socket.write(message('D', dataRow(row)));
        socket.write(message('C', cstr(result.tag || 'SELECT 0')));
      }
      socket.write(message('Z', Buffer.from('I')));
      pendingSql = null;
      pendingValues = [];
      pendingResult = null;
    }

    function finishAuth() {
      socket.write(authMessage(0));
      socket.write(message('S', cstr('server_version'), cstr('16.0')));
      socket.write(message('K', Buffer.alloc(8)));
      socket.write(message('Z', Buffer.from('I')));
      stage = 'query';
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    queries,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      })
  };
}

function message(type, ...parts) {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(5);
  header[0] = type.charCodeAt(0);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

function authMessage(code, data = Buffer.alloc(0)) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(code, 0);
  return message('R', buffer, data);
}

function cstr(value) {
  return Buffer.from(`${value}\0`, 'utf8');
}

function errorMessage(code, text) {
  return message(
    'E',
    Buffer.from([0x53]),
    cstr('ERROR'),
    Buffer.from([0x43]),
    cstr(code),
    Buffer.from([0x4d]),
    cstr(text),
    Buffer.from([0])
  );
}

function rowDescription(fields) {
  const parts = [int16(fields.length)];
  for (const field of fields) {
    parts.push(cstr(field.name), int32(0), int16(0), int32(field.oid), int16(-1), int32(-1), int16(0));
  }
  return Buffer.concat(parts);
}

function dataRow(values) {
  const parts = [int16(values.length)];
  for (const value of values) {
    if (value === null || value === undefined) {
      parts.push(int32(-1));
      continue;
    }
    const text = typeof value === 'boolean' ? (value ? 't' : 'f') : String(value);
    const bytes = Buffer.from(text, 'utf8');
    parts.push(int32(bytes.length), bytes);
  }
  return Buffer.concat(parts);
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

function hmac(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest();
}

test('PostgreSQL protocol: SCRAM auth, simple query and text decoding', async (t) => {
  const mock = await startPostgresMock({
    respond: () => ({
      fields: [
        { name: 'id', oid: 23 },
        { name: 'name', oid: 25 },
        { name: 'active', oid: 16 },
        { name: 'note', oid: 25 }
      ],
      rows: [[1, 'Ada', true, null]],
      tag: 'SELECT 1'
    })
  });
  t.after(() => mock.close());

  const db = await connect({
    dialect: 'postgres',
    host: '127.0.0.1',
    port: mock.port,
    user: 'postgres',
    password: 'secret',
    database: 'app'
  });

  assert.deepEqual(await db.all('SELECT id, name, active, note FROM users'), [
    { id: 1, name: 'Ada', active: true, note: null }
  ]);
  assert.equal(mock.queries[0].simple, true);
  await db.close();
});

test('PostgreSQL protocol: extended query sends parsed and bound parameters', async (t) => {
  const mock = await startPostgresMock({
    respond: (sql, values) => ({
      fields: [{ name: 'id', oid: 23 }],
      rows: [[Number(values[0])]],
      tag: 'SELECT 1'
    })
  });
  t.after(() => mock.close());

  const db = await connect({
    dialect: 'postgres',
    host: '127.0.0.1',
    port: mock.port,
    user: 'postgres',
    password: 'secret',
    sslmode: 'disable'
  });

  assert.deepEqual(await db.all('SELECT id FROM users WHERE id = ?', [5]), [{ id: 5 }]);
  assert.equal(mock.queries[0].simple, false);
  assert.equal(mock.queries[0].sql, 'SELECT id FROM users WHERE id = $1');
  assert.deepEqual(mock.queries[0].values, ['5']);

  assert.deepEqual(await db.get('SELECT id FROM users WHERE id = :id', { id: 8 }), { id: 8 });
  assert.equal(mock.queries[1].sql, 'SELECT id FROM users WHERE id = $1');

  await db.close();
});

test('PostgreSQL protocol: command tags, RETURNING and error codes', async (t) => {
  const mock = await startPostgresMock({
    respond: (sql) => {
      if (/dup/.test(sql)) {
        return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      }
      if (/RETURNING/i.test(sql)) {
        return { fields: [{ name: 'id', oid: 23 }], rows: [[4]], tag: 'INSERT 0 1' };
      }
      if (/INSERT/i.test(sql)) return { tag: 'INSERT 0 1' };
      return { tag: 'UPDATE 3' };
    }
  });
  t.after(() => mock.close());

  const db = await connect({
    dialect: 'postgres',
    host: '127.0.0.1',
    port: mock.port,
    user: 'postgres',
    password: 'secret',
    sslmode: 'disable'
  });

  assert.deepEqual(await db.run('UPDATE users SET active = false'), {
    changes: 3,
    lastInsertRowid: 0
  });

  assert.deepEqual(await db.run('INSERT INTO users (name) VALUES (?) RETURNING id', ['Ada']), {
    changes: 1,
    lastInsertRowid: 4,
    rows: [{ id: 4 }]
  });

  await assert.rejects(
    () => db.run('INSERT dup INTO users (name) VALUES (?)', ['Ada']),
    (error) => error.code === ErrorCodes.UNIQUE_CONSTRAINT
  );

  await db.close();
});

test('PostgreSQL protocol: MD5 authentication and rejected passwords', async (t) => {
  const md5Mock = await startPostgresMock({
    auth: 'md5',
    respond: () => ({ fields: [{ name: 'n', oid: 23 }], rows: [[1]], tag: 'SELECT 1' })
  });
  t.after(() => md5Mock.close());

  const db = await connect({
    dialect: 'postgres',
    host: '127.0.0.1',
    port: md5Mock.port,
    user: 'postgres',
    password: 'secret',
    sslmode: 'disable'
  });
  assert.deepEqual(await db.all('SELECT 1 AS n'), [{ n: 1 }]);
  await db.close();

  const scramMock = await startPostgresMock({
    respond: () => ({ fields: [{ name: 'n', oid: 23 }], rows: [[1]], tag: 'SELECT 1' })
  });
  t.after(() => scramMock.close());

  await assert.rejects(
    () =>
      connect({
        dialect: 'postgres',
        host: '127.0.0.1',
        port: scramMock.port,
        user: 'postgres',
        password: 'wrong',
        sslmode: 'disable'
      }),
    (error) => error.code === ErrorCodes.DRIVER_ERROR
  );
});
