import test from 'node:test';
import assert from 'node:assert/strict';

import { Database, SqlError, ErrorCodes } from '../src/index.js';
import { toJSON, fromJSON } from '../src/adapter.js';

function sqliteDatabase() {
  const db = new Database({ dialect: 'sqlite' });
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      age INTEGER,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY,
      author_id INTEGER NOT NULL,
      title TEXT NOT NULL
    );
  `);
  db.run('INSERT INTO users (name, email, age) VALUES (?, ?, ?)', ['Ada', 'ada@example.com', 36]);
  db.run('INSERT INTO users (name, email, age) VALUES (?, ?, ?)', ['Alan', 'alan@example.com', 41]);
  db.run('INSERT INTO users (name, email) VALUES (?, ?)', ['Grace', 'grace@example.com']);
  return db;
}

test('creates rows, assigns rowids and applies defaults', () => {
  const db = sqliteDatabase();
  assert.deepEqual(
    db.all('SELECT id, name, age, active FROM users ORDER BY id'),
    [
      { id: 1, name: 'Ada', age: 36, active: 1 },
      { id: 2, name: 'Alan', age: 41, active: 1 },
      { id: 3, name: 'Grace', age: null, active: 1 }
    ]
  );
  const result = db.run('INSERT INTO users (name) VALUES (?)', ['Linus']);
  assert.equal(result.changes, 1);
  assert.equal(result.lastInsertRowid, 4);
});

test('rejects NULL, duplicate and unknown columns', () => {
  const db = sqliteDatabase();
  assert.throws(
    () => db.run('INSERT INTO users (name) VALUES (NULL)'),
    (error) => error instanceof SqlError && error.code === ErrorCodes.NOT_NULL_CONSTRAINT
  );
  assert.throws(
    () => db.run('INSERT INTO users (name, email) VALUES (?, ?)', ['X', 'ada@example.com']),
    (error) => error.code === ErrorCodes.UNIQUE_CONSTRAINT
  );
  assert.throws(
    () => db.run('INSERT INTO users (name, nope) VALUES (?, ?)', ['X', 1]),
    (error) => error.code === ErrorCodes.MISSING_COLUMN
  );
  assert.throws(
    () => db.run('INSERT INTO missing (name) VALUES (?)', ['X']),
    (error) => error.code === ErrorCodes.MISSING_TABLE
  );
  assert.throws(
    () => db.exec('CREATE TABLE users (id INTEGER)'),
    (error) => error.code === ErrorCodes.TABLE_EXISTS
  );
  db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER)');
  assert.throws(
    () => db.exec('CREATE TABLE bad (id INTEGER, id TEXT)'),
    (error) => error.code === ErrorCodes.DUPLICATE_COLUMN
  );
});

test('supports positional, named and dollar parameters', () => {
  const db = sqliteDatabase();
  assert.deepEqual(db.get('SELECT name FROM users WHERE id = ?', [2]), { name: 'Alan' });
  assert.deepEqual(db.get('SELECT name FROM users WHERE id = 1 AND name = :name', { name: 'Ada' }), { name: 'Ada' });

  const pg = new Database({ dialect: 'postgres' });
  pg.exec('CREATE TABLE items (id SERIAL PRIMARY KEY, label TEXT)');
  pg.run('INSERT INTO items (label) VALUES ($1), ($2)', ['a', 'b']);
  assert.deepEqual(pg.all('SELECT label FROM items WHERE id = $1', [2]), [{ label: 'b' }]);

  assert.throws(
    () => db.all('SELECT ?', [1, 2]),
    (error) => error.code === ErrorCodes.PARAMETER_ERROR
  );
  assert.throws(
    () => db.all('SELECT :a, ?', [1]),
    (error) => error.code === ErrorCodes.PARAMETER_ERROR
  );
  assert.throws(
    () => db.all('SELECT :a', { b: 1 }),
    (error) => error.code === ErrorCodes.PARAMETER_ERROR
  );
  assert.throws(
    () => db.all('SELECT 1', [1]),
    (error) => error.code === ErrorCodes.PARAMETER_ERROR
  );
  assert.throws(
    () => db.run('SELECT * FROM users'),
    (error) => error.code === ErrorCodes.INVALID_QUERY
  );
});

test('evaluates predicates, operators and three-valued logic', () => {
  const db = sqliteDatabase();
  assert.deepEqual(
    db.all('SELECT name FROM users WHERE age BETWEEN 36 AND 41 AND name IN (?, ?) ORDER BY name', ['Ada', 'Alan']),
    [{ name: 'Ada' }, { name: 'Alan' }]
  );
  assert.deepEqual(
    db.all('SELECT name FROM users WHERE age IS NULL'),
    [{ name: 'Grace' }]
  );
  assert.deepEqual(
    db.all('SELECT name FROM users WHERE name LIKE ?', ['A%']),
    [{ name: 'Ada' }, { name: 'Alan' }]
  );
  // SQLite: LIKE is case-insensitive.
  assert.equal(db.all('SELECT name FROM users WHERE name LIKE ?', ['a%']).length, 2);
  // NULL comparisons yield NULL, which WHERE treats as false.
  assert.deepEqual(db.all('SELECT name FROM users WHERE age = NULL'), []);
  assert.deepEqual(
    db.all('SELECT name FROM users WHERE NOT (age = 36) ORDER BY name'),
    [{ name: 'Alan' }]
  );
  assert.deepEqual(
    db.get('SELECT 7 / 2 AS ints, 7.0 / 2 AS reals, 1 / 0 AS zero, 2 + 3 * 4 AS precedence'),
    { ints: 3, reals: 3.5, zero: null, precedence: 14 }
  );
  assert.deepEqual(
    db.get("SELECT 'a' || 'b' AS joined, UPPER('x') AS up, LENGTH('hé') AS len, COALESCE(NULL, 1) AS first"),
    { joined: 'ab', up: 'X', len: 2, first: 1 }
  );
});

test('groups, filters and orders aggregate results', () => {
  const db = sqliteDatabase();
  db.run('UPDATE users SET active = FALSE WHERE name = ?', ['Alan']);
  assert.deepEqual(
    db.all('SELECT active, COUNT(*) AS n, MIN(age) AS youngest FROM users GROUP BY active ORDER BY active'),
    [
      { active: 0, n: 1, youngest: 41 },
      { active: 1, n: 2, youngest: 36 }
    ]
  );
  assert.deepEqual(
    db.all('SELECT active, COUNT(*) AS n FROM users GROUP BY active HAVING n > 1'),
    [{ active: 1, n: 2 }]
  );
  assert.deepEqual(
    db.all('SELECT COUNT(*) AS total FROM users WHERE age > ?', [100]),
    [{ total: 0 }]
  );
  assert.deepEqual(
    db.get('SELECT SUM(age) AS sum, AVG(age) AS avg FROM users'),
    { sum: 77, avg: 38.5 }
  );
  assert.deepEqual(
    db.all('SELECT DISTINCT active FROM users'),
    [{ active: 1 }, { active: 0 }]
  );
});

test('orders NULLs per dialect and supports LIMIT/OFFSET forms', () => {
  const db = sqliteDatabase();
  assert.deepEqual(
    db.all('SELECT age FROM users ORDER BY age ASC'),
    [{ age: null }, { age: 36 }, { age: 41 }]
  );
  assert.deepEqual(
    db.all('SELECT age FROM users ORDER BY age DESC'),
    [{ age: 41 }, { age: 36 }, { age: null }]
  );
  assert.deepEqual(
    db.all('SELECT name FROM users ORDER BY age NULLS LAST, name'),
    [{ name: 'Ada' }, { name: 'Alan' }, { name: 'Grace' }]
  );
  assert.deepEqual(
    db.all('SELECT name FROM users ORDER BY id LIMIT 1 OFFSET 1'),
    [{ name: 'Alan' }]
  );
  assert.deepEqual(
    db.all('SELECT name FROM users ORDER BY id LIMIT 1, 2'),
    [{ name: 'Alan' }, { name: 'Grace' }]
  );
});

test('updates and deletes rows', () => {
  const db = sqliteDatabase();
  const updated = db.run('UPDATE users SET age = age + 1, active = FALSE WHERE name = ?', ['Ada']);
  assert.equal(updated.changes, 1);
  assert.deepEqual(db.get('SELECT age, active FROM users WHERE name = ?', ['Ada']), { age: 37, active: 0 });
  assert.equal(db.run('UPDATE users SET age = NULL').changes, 3);
  assert.throws(
    () => db.run("UPDATE users SET active = NULL WHERE name = 'Ada'"),
    (error) => error.code === ErrorCodes.NOT_NULL_CONSTRAINT
  );
  assert.equal(db.run('DELETE FROM users WHERE age IS NULL').changes, 3);
  assert.deepEqual(db.all('SELECT * FROM users'), []);
});

test('MySQL uses backticks, real division and forbids ||', () => {
  const db = new Database({ dialect: 'mysql' });
  db.exec('CREATE TABLE `t` (`id` INT PRIMARY KEY, `label` VARCHAR(20))');
  db.run('INSERT INTO `t` VALUES (?, ?)', [1, 'x']);
  assert.deepEqual(db.get('SELECT "quoted" AS s, 7 / 2 AS half'), { s: 'quoted', half: 3.5 });
  assert.throws(
    () => db.all("SELECT 'a' || 'b'"),
    (error) => error.code === ErrorCodes.UNSUPPORTED
  );
  assert.throws(
    () => db.all('SELECT * FROM t OFFSET 1'),
    (error) => error.code === ErrorCodes.UNSUPPORTED
  );
  // MySQL accepts LIMIT offset, count.
  db.run('INSERT INTO `t` VALUES (2, \'y\')');
  assert.deepEqual(db.all('SELECT id FROM `t` ORDER BY id LIMIT 0, 1'), [{ id: 1 }]);
});

test('PostgreSQL is strict about types and boolean predicates', () => {
  const db = new Database({ dialect: 'postgres' });
  db.exec('CREATE TABLE t (id SERIAL PRIMARY KEY, score INTEGER)');
  db.run('INSERT INTO t (score) VALUES (1), (2)');

  assert.throws(
    () => db.all('SELECT * FROM t WHERE score'),
    (error) => error.code === ErrorCodes.TYPE_ERROR
  );
  assert.throws(
    () => db.run("INSERT INTO t (score) VALUES ('not a number')"),
    (error) => error.code === ErrorCodes.TYPE_ERROR
  );
  assert.throws(
    () => db.all('SELECT 1 / 0'),
    (error) => error.code === ErrorCodes.DIVISION_BY_ZERO
  );
  assert.deepEqual(
    db.all('SELECT id FROM t ORDER BY score DESC'),
    [{ id: 2 }, { id: 1 }]
  );
  assert.equal(db.all("SELECT 'a' LIKE 'A' AS matched")[0].matched, false);
});

test('reports syntax errors with line and column', () => {
  const db = new Database();
  assert.throws(
    () => db.all('SELECT *\nFROM'),
    (error) =>
      error instanceof SqlError &&
      error.code === ErrorCodes.SYNTAX_ERROR &&
      error.line === 2 &&
      typeof error.column === 'number'
  );
  assert.throws(
    () => db.all('SELECT nope FROM users'),
    (error) => error.code === ErrorCodes.MISSING_TABLE
  );
  assert.throws(
    () => db.all('SELECT 1 AS'),
    (error) => error.code === ErrorCodes.SYNTAX_ERROR
  );
  assert.throws(
    () => db.all("SELECT 'unterminated"),
    (error) => error.code === ErrorCodes.SYNTAX_ERROR
  );
});

test('adapter round-trips a database through JSON', () => {
  const db = sqliteDatabase();
  db.exec('CREATE TABLE tags (name TEXT UNIQUE)');
  db.run('INSERT INTO tags (name) VALUES (:name)', { name: 'db' });

  const snapshot = toJSON(db);
  assert.equal(snapshot.version, 1);

  const restored = fromJSON(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.all('SELECT * FROM users ORDER BY id'), db.all('SELECT * FROM users ORDER BY id'));
  assert.deepEqual(restored.all('SELECT * FROM tags'), [{ name: 'db' }]);

  const next = restored.run('INSERT INTO users (name) VALUES (?)', ['Linus']);
  assert.equal(next.lastInsertRowid, 4, 'autoincrement continues after restore');
  assert.throws(
    () => restored.run('INSERT INTO users (name, email) VALUES (?, ?)', ['X', 'ada@example.com']),
    (error) => error.code === ErrorCodes.UNIQUE_CONSTRAINT
  );
  assert.throws(
    () => fromJSON({ version: 99 }),
    (error) => error.code === ErrorCodes.ADAPTER_ERROR
  );
});
