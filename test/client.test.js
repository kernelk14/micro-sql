import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../src/client.js';
import { normalizeParameters, splitStatements, statementKind } from '../src/client/params.js';
import { getDialect } from '../src/dialects/index.js';
import { ErrorCodes } from '../src/errors.js';

const postgres = getDialect('postgres');
const mysql = getDialect('mysql');
const sqlite = getDialect('sqlite');

test('rewrites parameters to PostgreSQL placeholders', () => {
  assert.deepEqual(
    normalizeParameters('SELECT * FROM users WHERE id = ? AND name = ?', [1, 'Ada'], postgres),
    {
      text: 'SELECT * FROM users WHERE id = $1 AND name = $2',
      values: [1, 'Ada']
    }
  );

  assert.deepEqual(
    normalizeParameters(
      'SELECT * FROM users WHERE id = :id AND name = :name',
      { name: 'Ada', id: 7 },
      postgres
    ),
    {
      text: 'SELECT * FROM users WHERE id = $1 AND name = $2',
      values: [7, 'Ada']
    }
  );

  // PostgreSQL positional input is renumbered in appearance order.
  assert.deepEqual(
    normalizeParameters('SELECT $2 AS b, $1 AS a', ['a', 'b'], postgres),
    { text: 'SELECT $1 AS b, $2 AS a', values: ['b', 'a'] }
  );

  // `::` casts are not parameters, and dollar-quoted strings are skipped.
  assert.deepEqual(
    normalizeParameters("SELECT $$?$$, $tag$:x$tag$, id::text FROM t WHERE id = :id", { id: 3 }, postgres),
    { text: 'SELECT $$?$$, $tag$:x$tag$, id::text FROM t WHERE id = $1', values: [3] }
  );
});

test('leaves quoted text and comments alone when rewriting', () => {
  const result = normalizeParameters(
    "SELECT '?' AS q, \"?\" AS c -- ?\n FROM t /* ? */ WHERE id = ?",
    [5],
    postgres
  );
  assert.equal(result.text, "SELECT '?' AS q, \"?\" AS c -- ?\n FROM t /* ? */ WHERE id = $1");
  assert.deepEqual(result.values, [5]);
});

test('keeps MySQL identifier escapes and converts booleans', () => {
  assert.deepEqual(
    normalizeParameters('SELECT * FROM ?? WHERE active = ? AND id = ?', ['users', true, 3], mysql),
    {
      text: 'SELECT * FROM ?? WHERE active = ? AND id = ?',
      values: ['users', 1, 3]
    }
  );
  // PostgreSQL keeps booleans as booleans.
  assert.deepEqual(normalizeParameters('SELECT ? AS ok', [true], postgres).values, [true]);
  // SQLite uses positional placeholders.
  assert.equal(
    normalizeParameters('SELECT * FROM t WHERE a = $1', [1], sqlite).text,
    'SELECT * FROM t WHERE a = ?'
  );
});

test('rejects invalid parameter shapes before reaching the server', () => {
  assert.throws(
    () => normalizeParameters('SELECT :a, ?', [1], postgres),
    (error) => error.code === ErrorCodes.PARAMETER_ERROR
  );
  assert.throws(
    () => normalizeParameters('SELECT ?, ?', [1], postgres),
    (error) => error.code === ErrorCodes.PARAMETER_ERROR
  );
  assert.throws(
    () => normalizeParameters('SELECT :a', { b: 1 }, postgres),
    (error) => error.code === ErrorCodes.PARAMETER_ERROR
  );
  assert.throws(
    () => normalizeParameters('SELECT 1', [1], postgres),
    (error) => error.code === ErrorCodes.PARAMETER_ERROR
  );
  assert.throws(
    () => normalizeParameters('SELECT :a', { a: undefined }, postgres),
    (error) => error.code === ErrorCodes.PARAMETER_ERROR
  );
});

test('splits statements outside quotes and detects row statements', () => {
  assert.deepEqual(splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1; -- tail\n", sqlite), [
    "INSERT INTO t VALUES ('a;b')",
    ' SELECT 1',
    ' -- tail\n'
  ]);
  assert.equal(statementKind('SELECT 1'), 'rows');
  assert.equal(statementKind('  -- note\nSELECT 1'), 'rows');
  assert.equal(statementKind('INSERT INTO t VALUES (1) RETURNING id'), 'rows');
  assert.equal(statementKind('UPDATE t SET a = 1'), 'run');
});

test('runs statements against a real SQLite database file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'micro-sql-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'app.db');

  const db = await connect({ dialect: 'sqlite', filename });
  t.after(() => db.close());

  await db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      active BOOLEAN NOT NULL DEFAULT 1
    );
    INSERT INTO users (name, email) VALUES ('Ada', 'ada@example.com');
  `);

  const inserted = await db.run('INSERT INTO users (name, email, active) VALUES (?, ?, ?)', [
    'Alan',
    'alan@example.com',
    true
  ]);
  assert.equal(inserted.changes, 1);
  assert.equal(inserted.lastInsertRowid, 2);

  assert.deepEqual(await db.all('SELECT name, active FROM users WHERE active = :active ORDER BY id', { active: 1 }), [
    { name: 'Ada', active: 1 },
    { name: 'Alan', active: 1 }
  ]);

  assert.deepEqual(await db.get('SELECT name FROM users WHERE id = $1', [2]), { name: 'Alan' });
  assert.equal(await db.get('SELECT name FROM users WHERE id = ?', [99]), undefined);

  // Prepared statements can be executed repeatedly.
  const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
  await insert.run(['Grace', 'grace@example.com']);
  await insert.run(['Linus', 'linus@example.com']);
  assert.equal(await db.get('SELECT COUNT(*) AS n FROM users').then((row) => row.n), 4);

  // Exec returns one result per statement.
  const results = await db.exec('SELECT COUNT(*) AS n FROM users; SELECT name FROM users ORDER BY id LIMIT 1');
  assert.equal(results[0].rows[0].n, 4);
  assert.deepEqual(results[1].rows, [{ name: 'Ada' }]);
  assert.equal((await db.run('UPDATE users SET active = 0 WHERE name = ?', ['Ada'])).changes, 1);

  // A RETURNING clause is executed by run() and its rows come back too.
  await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)');
  const returned = await db.run('INSERT INTO items (label) VALUES (?) RETURNING id, label', ['first']);
  assert.equal(returned.changes, 1);
  assert.equal(returned.lastInsertRowid, returned.rows[0].id);
  assert.deepEqual(returned.rows, [{ id: 1, label: 'first' }]);

  const returnedUpdate = await db.run('UPDATE items SET label = ? WHERE id = ? RETURNING id', [
    'changed',
    1
  ]);
  assert.equal(returnedUpdate.changes, 1);
  assert.equal(returnedUpdate.lastInsertRowid, 0);
  assert.deepEqual(returnedUpdate.rows, [{ id: 1 }]);

  // Driver errors are mapped to the library's stable codes.
  await assert.rejects(
    () => db.run('INSERT INTO users (name, email) VALUES (?, ?)', ['X', 'ada@example.com']),
    (error) => error.code === ErrorCodes.UNIQUE_CONSTRAINT
  );
  await assert.rejects(
    () => db.all('SELECT * FROM missing'),
    (error) => error.code === ErrorCodes.MISSING_TABLE
  );
  await assert.rejects(
    () => db.run('SELEC 1'),
    (error) => error.code === ErrorCodes.SYNTAX_ERROR
  );
  await assert.rejects(
    () => db.run('SELECT * FROM users'),
    (error) => error.code === ErrorCodes.INVALID_QUERY
  );
  await assert.rejects(
    () => db.all('DELETE FROM users'),
    (error) => error.code === ErrorCodes.INVALID_QUERY
  );

  // Transactions roll back on failure and commit on success.
  await assert.rejects(() =>
    db.transaction(async (tx) => {
      await tx.run('INSERT INTO users (name) VALUES (?)', ['Rollback']);
      throw new Error('boom');
    })
  );
  assert.equal(await db.get('SELECT COUNT(*) AS n FROM users').then((row) => row.n), 4);
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO users (name) VALUES (?)', ['Committed']);
  });
  assert.equal(await db.get('SELECT COUNT(*) AS n FROM users').then((row) => row.n), 5);

  // The data really lives in the file: a new connection sees it.
  await db.close();
  const reopened = await connect({ dialect: 'sqlite', filename });
  try {
    assert.deepEqual(await reopened.get('SELECT name FROM users WHERE name = ?', ['Committed']), {
      name: 'Committed'
    });
  } finally {
    await reopened.close();
  }
});

test('derives generated ids from RETURNING on MySQL as well', async () => {
  const queries = [];
  const driver = {
    async query(sql) {
      queries.push(sql);
      return { rows: [{ id: 9 }] };
    },
    async exec() {},
    async close() {}
  };

  const db = await connect({ dialect: 'mysql', driver });
  assert.deepEqual(await db.run('INSERT INTO users (name) VALUES (?) RETURNING id', ['Ada']), {
    changes: 1,
    lastInsertRowid: 9,
    rows: [{ id: 9 }]
  });
  // MySQL keeps `?` placeholders.
  assert.equal(queries[0], 'INSERT INTO users (name) VALUES (?) RETURNING id');
});

test('drives a custom client with PostgreSQL placeholders and error mapping', async () => {
  const calls = [];
  const driver = {
    async query(sql, values, options) {
      calls.push({ sql, values, options });
      if (options.returnsRows) return { rows: [{ id: 1 }] };
      return { changes: 2, lastInsertRowid: 0 };
    },
    async exec() {},
    async close() {}
  };

  const db = await connect({ dialect: 'postgres', driver });
  assert.deepEqual(await db.all('SELECT * FROM users WHERE id = ? AND name = ?', [1, 'Ada']), [
    { id: 1 }
  ]);
  assert.equal(calls[0].sql, 'SELECT * FROM users WHERE id = $1 AND name = $2');
  assert.deepEqual(calls[0].values, [1, 'Ada']);
  assert.deepEqual(await db.run('UPDATE users SET name = :name', { name: 'Ada' }), {
    changes: 2,
    lastInsertRowid: 0
  });
  assert.equal(calls[1].sql, 'UPDATE users SET name = $1');

  // PostgreSQL has no lastInsertRowid; the id comes from `RETURNING`.
  assert.deepEqual(await db.run('INSERT INTO users (name) VALUES (?) RETURNING id', ['Ada']), {
    changes: 1,
    lastInsertRowid: 1,
    rows: [{ id: 1 }]
  });

  const failing = {
    async query() {
      const error = new Error('duplicate key value violates unique constraint');
      error.code = '23505';
      throw error;
    },
    async exec() {},
    async close() {}
  };
  const broken = await connect({ dialect: 'postgres', driver: failing });
  await assert.rejects(
    () => broken.run('INSERT INTO users (id) VALUES (?)', [1]),
    (error) => error.code === ErrorCodes.UNIQUE_CONSTRAINT && error.cause !== undefined
  );
});
