import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';

import { connect } from '../src/client.js';
import { ErrorCodes } from '../src/errors.js';

const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_TRANSACTIONS = 0x00002000;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_MULTI_RESULTS = 0x00020000;
const CLIENT_PS_MULTI_RESULTS = 0x00040000;
const CLIENT_PLUGIN_AUTH = 0x00080000;

const TYPE = { LONG: 3, LONGLONG: 8, DOUBLE: 5, VAR_STRING: 253 };

/**
 * A small MySQL server: performs the handshake with
 * mysql_native_password, then answers COM_QUERY, COM_STMT_PREPARE and
 * COM_STMT_EXECUTE using the plans returned by `plan(sql, values)`.
 */
async function startMysqlMock({ password = 'secret', plan }) {
  const commands = [];
  const salt1 = Buffer.from('12345678');
  const salt2 = Buffer.from('abcdefghijkl');
  const scrambleSalt = Buffer.concat([salt1, salt2]);

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = 'handshake';
    let prepared = null;

    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });

    writePacket(
      handshakePacket({
        capabilities:
          CLIENT_PROTOCOL_41 |
          CLIENT_CONNECT_WITH_DB |
          CLIENT_TRANSACTIONS |
          CLIENT_SECURE_CONNECTION |
          CLIENT_MULTI_RESULTS |
          CLIENT_PS_MULTI_RESULTS |
          CLIENT_PLUGIN_AUTH,
        salt1,
        salt2
      })
    );

    function pump() {
      while (true) {
        if (buffer.length < 4) return;
        const length = buffer.readUIntLE(0, 3);
        if (buffer.length < 4 + length) return;
        const packet = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        handle(packet);
      }
    }

    function handle(packet) {
      if (stage === 'handshake') {
        const user = readNul(packet, 32);
        const authLength = packet[user.next];
        const token = packet.subarray(user.next + 1, user.next + 1 + authLength);
        if (!token.equals(nativeScramble(password, scrambleSalt))) {
          writePacket(errorPacket(1045, '28000', 'Access denied for user'));
          socket.end();
          return;
        }
        writePacket(okPacket(0, 0));
        stage = 'command';
        return;
      }

      const command = packet[0];
      if (command === 0x01) {
        socket.end();
        return;
      }

      if (command === 0x03) {
        const sql = packet.toString('utf8', 1);
        commands.push({ sql, values: [], kind: 'query' });
        sendPlan(plan(sql, []), false);
        return;
      }

      if (command === 0x16) {
        const sql = packet.toString('utf8', 1);
        const result = plan(sql, []);
        prepared = { sql, result };
        commands.push({ sql, values: [], kind: 'prepare' });
        const parameterCount = (sql.match(/\?/g) || []).length;
        const columnCount = result.ok || result.error ? 0 : result.columns.length;
        const response = Buffer.concat([
          Buffer.from([0x00]),
          uint32le(1),
          uint16le(columnCount),
          uint16le(parameterCount),
          Buffer.from([0x00]),
          uint16le(0)
        ]);
        writePacket(response);
        for (let i = 0; i < parameterCount; i += 1) writePacket(columnDefinition('?', TYPE.VAR_STRING));
        if (parameterCount > 0) writePacket(eofPacket());
        const columns = result.ok || result.error ? [] : result.columns;
        for (const column of columns) writePacket(columnDefinition(column.name, column.type));
        if (columns.length > 0) writePacket(eofPacket());
        return;
      }

      if (command === 0x17) {
        const values = readExecuteValues(packet, prepared.sql.match(/\?/g)?.length || 0);
        commands.push({ sql: prepared.sql, values, kind: 'execute' });
        const result = plan(prepared.sql, values);
        if (result.ok) {
          writePacket(okPacket(result.ok.affectedRows, result.ok.insertId));
        } else {
          sendPlan(result, true);
        }
        return;
      }

      if (command === 0x19) return; // COM_STMT_CLOSE has no response
    }

    function sendPlan(result, binary) {
      if (result.error) {
        writePacket(errorPacket(result.error.errno, result.error.sqlState, result.error.message));
        return;
      }
      if (result.ok) {
        writePacket(okPacket(result.ok.affectedRows, result.ok.insertId));
        return;
      }
      writePacket(encodeLenEnc(result.columns.length));
      for (const column of result.columns) writePacket(columnDefinition(column.name, column.type));
      writePacket(eofPacket());
      for (const row of result.rows) {
        writePacket(binary ? binaryRow(result.columns, row) : textRow(result.columns, row));
      }
      writePacket(eofPacket());
    }

    function writePacket(payload) {
      const header = Buffer.alloc(4);
      header.writeUIntLE(payload.length, 0, 3);
      socket.write(Buffer.concat([header, payload]));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    commands,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      })
  };
}

function handshakePacket({ capabilities, salt1, salt2 }) {
  return Buffer.concat([
    Buffer.from([0x0a]),
    Buffer.from('8.0.36\0', 'utf8'),
    uint32le(99),
    salt1,
    Buffer.from([0x00]),
    uint16le(capabilities & 0xffff),
    Buffer.from([45]),
    uint16le(0x0002),
    uint16le((capabilities >>> 16) & 0xffff),
    Buffer.from([21]),
    Buffer.alloc(10),
    salt2,
    Buffer.from([0x00]),
    Buffer.from('mysql_native_password\0', 'utf8')
  ]);
}

function columnDefinition(name, type) {
  return Buffer.concat([
    encodeLenEncString('def'),
    encodeLenEncString(''),
    encodeLenEncString('users'),
    encodeLenEncString('users'),
    encodeLenEncString(name),
    encodeLenEncString(name),
    Buffer.from([0x0c]),
    uint16le(45),
    uint32le(255),
    Buffer.from([type]),
    uint16le(0),
    Buffer.from([0]),
    Buffer.from([0, 0])
  ]);
}

function textRow(columns, values) {
  const parts = [];
  for (let i = 0; i < columns.length; i += 1) {
    const value = values[i];
    if (value === null) {
      parts.push(Buffer.from([0xfb]));
    } else {
      parts.push(encodeLenEncString(String(value)));
    }
  }
  return Buffer.concat(parts);
}

function binaryRow(columns, values) {
  const bitmapLength = (columns.length + 9) >> 3;
  const bitmap = Buffer.alloc(bitmapLength);
  const parts = [];
  columns.forEach((column, index) => {
    const value = values[index];
    if (value === null) {
      const bit = index + 2;
      bitmap[bit >> 3] |= 1 << (bit & 7);
      return;
    }
    if (column.type === TYPE.LONG) {
      const buffer = Buffer.alloc(4);
      buffer.writeInt32LE(Number(value));
      parts.push(buffer);
    } else if (column.type === TYPE.LONGLONG) {
      const buffer = Buffer.alloc(8);
      buffer.writeBigInt64LE(BigInt(value));
      parts.push(buffer);
    } else if (column.type === TYPE.DOUBLE) {
      const buffer = Buffer.alloc(8);
      buffer.writeDoubleLE(Number(value));
      parts.push(buffer);
    } else {
      parts.push(encodeLenEncString(String(value)));
    }
  });
  return Buffer.concat([Buffer.from([0x00]), bitmap, ...parts]);
}

function readExecuteValues(packet, count) {
  let offset = 1 + 4 + 1 + 4;
  const bitmapLength = (count + 7) >> 3;
  const bitmap = packet.subarray(offset, offset + bitmapLength);
  offset += bitmapLength;
  const bound = packet[offset] === 1;
  offset += 1;
  let types = [];
  if (bound) {
    types = [];
    for (let i = 0; i < count; i += 1) {
      types.push(packet[offset]);
      offset += 2;
    }
  }
  const values = [];
  for (let i = 0; i < count; i += 1) {
    const bit = i;
    if (bitmap[bit >> 3] & (1 << (bit & 7))) {
      values.push(null);
      continue;
    }
    const type = types[i];
    if (type === TYPE.LONG) {
      values.push(packet.readInt32LE(offset));
      offset += 4;
    } else if (type === TYPE.LONGLONG) {
      values.push(Number(packet.readBigInt64LE(offset)));
      offset += 8;
    } else if (type === TYPE.DOUBLE) {
      values.push(packet.readDoubleLE(offset));
      offset += 8;
    } else if (type === 1) {
      values.push(packet.readInt8(offset));
      offset += 1;
    } else {
      const length = readLenEnc(packet, offset);
      values.push(packet.toString('utf8', length.next, length.next + length.value));
      offset = length.next + length.value;
    }
  }
  return values;
}

function okPacket(affectedRows, insertId) {
  return Buffer.concat([
    Buffer.from([0x00]),
    encodeLenEnc(affectedRows),
    encodeLenEnc(insertId),
    uint16le(0x0002),
    uint16le(0)
  ]);
}

function errorPacket(errno, sqlState, message) {
  return Buffer.concat([
    Buffer.from([0xff]),
    uint16le(errno),
    Buffer.from('#', 'utf8'),
    Buffer.from(sqlState, 'utf8'),
    Buffer.from(message, 'utf8')
  ]);
}

function eofPacket() {
  return Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00]);
}

function encodeLenEnc(value) {
  if (value < 0xfb) return Buffer.from([value]);
  const buffer = Buffer.alloc(3);
  buffer[0] = 0xfc;
  buffer.writeUInt16LE(value, 1);
  return buffer;
}

function encodeLenEncString(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeLenEnc(bytes.length), bytes]);
}

function readLenEnc(buffer, offset) {
  const first = buffer[offset];
  if (first < 0xfb) return { value: first, next: offset + 1 };
  if (first === 0xfc) return { value: buffer.readUInt16LE(offset + 1), next: offset + 3 };
  throw new Error(`Unsupported length-encoded integer prefix ${first}`);
}

function readNul(buffer, start) {
  const end = buffer.indexOf(0, start);
  return { value: buffer.toString('utf8', start, end), next: end + 1 };
}

function uint16le(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function uint32le(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function nativeScramble(password, salt) {
  const stage1 = crypto.createHash('sha1').update(password).digest();
  const stage2 = crypto.createHash('sha1').update(stage1).digest();
  const scrambled = crypto.createHash('sha1').update(Buffer.concat([salt, stage2])).digest();
  return Buffer.from(stage1.map((byte, index) => byte ^ scrambled[index]));
}

const selectPlan = () => ({
  columns: [
    { name: 'id', type: TYPE.LONG },
    { name: 'name', type: TYPE.VAR_STRING }
  ],
  rows: [
    [1, 'Ada'],
    [2, 'Alan']
  ]
});

test('MySQL protocol: handshake, COM_QUERY and text result sets', async (t) => {
  const mock = await startMysqlMock({
    plan: (sql) => (sql.startsWith('INSERT') ? { ok: { affectedRows: 1, insertId: 3 } } : selectPlan())
  });
  t.after(() => mock.close());

  const db = await connect({
    dialect: 'mysql',
    host: '127.0.0.1',
    port: mock.port,
    user: 'root',
    password: 'secret',
    database: 'app'
  });

  assert.deepEqual(await db.all('SELECT id, name FROM users'), [
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Alan' }
  ]);
  assert.equal(mock.commands[0].kind, 'query');

  const inserted = await db.run('INSERT INTO users (name) VALUES (?)', ['Grace']);
  assert.deepEqual(inserted, { changes: 1, lastInsertRowid: 3 });
  assert.equal(mock.commands[1].kind, 'prepare');
  assert.deepEqual(mock.commands[2].values, ['Grace']);

  await db.close();
});

test('MySQL protocol: binary result sets, parameters and error codes', async (t) => {
  const mock = await startMysqlMock({
    plan: (sql, values) => {
      if (/dup/.test(sql)) {
        return {
          error: { errno: 1062, sqlState: '23000', message: "Duplicate entry for key 'users.email'" }
        };
      }
      if (sql.startsWith('INSERT')) return { ok: { affectedRows: 1, insertId: 7 } };
      if (/WHERE id/.test(sql)) {
        return {
          columns: [
            { name: 'id', type: TYPE.LONG },
            { name: 'name', type: TYPE.VAR_STRING },
            { name: 'score', type: TYPE.DOUBLE }
          ],
          rows: [[values[0], 'Ada', 9.5]]
        };
      }
      return selectPlan();
    }
  });
  t.after(() => mock.close());

  const db = await connect({
    dialect: 'mysql',
    host: '127.0.0.1',
    port: mock.port,
    user: 'root',
    password: 'secret',
    sslmode: 'disable'
  });

  assert.deepEqual(await db.get('SELECT id, name, score FROM users WHERE id = ?', [5]), {
    id: 5,
    name: 'Ada',
    score: 9.5
  });
  assert.deepEqual(mock.commands.at(-1).values, [5]);

  await assert.rejects(
    () => db.run('INSERT dup INTO users (name) VALUES (?)', ['Ada']),
    (error) => error.code === ErrorCodes.UNIQUE_CONSTRAINT
  );

  await db.close();
});

test('MySQL protocol: rejected passwords and unreachable servers', async (t) => {
  const mock = await startMysqlMock({ plan: selectPlan });
  t.after(() => mock.close());

  await assert.rejects(
    () =>
      connect({
        dialect: 'mysql',
        host: '127.0.0.1',
        port: mock.port,
        user: 'root',
        password: 'wrong'
      }),
    (error) => error.code === ErrorCodes.DRIVER_ERROR
  );

  await assert.rejects(
    () =>
      connect({
        dialect: 'mysql',
        host: '127.0.0.1',
        port: 1,
        user: 'root',
        password: 'secret',
        connectionOptions: { connectTimeout: 1000 }
      }),
    (error) => error.code === ErrorCodes.DRIVER_ERROR
  );
});
