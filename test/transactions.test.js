import test from 'node:test';
import assert from 'node:assert/strict';

import { Database, ErrorCodes } from '../src/index.js';

function seededDatabase() {
  const db = new Database({ dialect: 'sqlite' });
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
  db.exec("INSERT INTO items (name) VALUES ('one'), ('two')");
  return db;
}

test('ROLLBACK undoes inserts, updates and deletes', () => {
  const db = seededDatabase();
  db.exec('BEGIN');
  db.run("INSERT INTO items (name) VALUES ('three')");
  db.run("UPDATE items SET name = 'ONE' WHERE id = 1");
  db.run('DELETE FROM items WHERE id = 2');
  assert.deepEqual(db.all('SELECT id, name FROM items ORDER BY id'), [
    { id: 1, name: 'ONE' },
    { id: 3, name: 'three' }
  ]);
  db.exec('ROLLBACK');
  assert.deepEqual(db.all('SELECT id, name FROM items ORDER BY id'), [
    { id: 1, name: 'one' },
    { id: 2, name: 'two' }
  ]);

  // Rowids continue from the restored data, not the rolled-back attempts.
  assert.equal(db.run("INSERT INTO items (name) VALUES ('three')").lastInsertRowid, 3);
});

test('ROLLBACK undoes schema changes', () => {
  const db = seededDatabase();
  db.exec('BEGIN');
  db.exec('CREATE TABLE extra (id INTEGER PRIMARY KEY, value TEXT)');
  db.exec('DROP TABLE items');
  assert.throws(
    () => db.all('SELECT * FROM items'),
    (error) => error.code === ErrorCodes.MISSING_TABLE
  );
  db.exec('ROLLBACK');
  assert.deepEqual(db.all('SELECT name FROM items ORDER BY id'), [{ name: 'one' }, { name: 'two' }]);
  assert.throws(
    () => db.all('SELECT * FROM extra'),
    (error) => error.code === ErrorCodes.MISSING_TABLE
  );
});

test('COMMIT keeps the changes and closes the transaction', () => {
  const db = seededDatabase();
  db.exec('BEGIN TRANSACTION');
  db.run('UPDATE items SET name = ? WHERE id = ?', ['ONE', 1]);
  db.run("INSERT INTO items (name) VALUES ('three')");
  db.exec('COMMIT');

  assert.deepEqual(db.all('SELECT id, name FROM items ORDER BY id'), [
    { id: 1, name: 'ONE' },
    { id: 2, name: 'two' },
    { id: 3, name: 'three' }
  ]);

  db.exec('BEGIN');
  db.run("INSERT INTO items (name) VALUES ('four')");
  db.exec('COMMIT');
  assert.equal(db.all('SELECT COUNT(*) AS n FROM items')[0].n, 4);
});

test('transaction statements validate their state', () => {
  const db = seededDatabase();
  assert.throws(
    () => db.exec('COMMIT'),
    (error) => error.code === ErrorCodes.INVALID_QUERY && /active transaction/.test(error.message)
  );
  assert.throws(
    () => db.exec('ROLLBACK'),
    (error) => error.code === ErrorCodes.INVALID_QUERY && /active transaction/.test(error.message)
  );

  db.exec('BEGIN');
  assert.throws(
    () => db.exec('BEGIN'),
    (error) => error.code === ErrorCodes.INVALID_QUERY && /already active/.test(error.message)
  );
  db.exec('ROLLBACK');

  // A failed statement does not end the transaction by itself.
  db.exec('BEGIN');
  assert.throws(
    () => db.run('INSERT INTO items (name) VALUES (NULL)'),
    (error) => error.code === ErrorCodes.NOT_NULL_CONSTRAINT
  );
  db.run("INSERT INTO items (name) VALUES ('kept')");
  db.exec('ROLLBACK');
  assert.equal(db.all("SELECT COUNT(*) AS n FROM items WHERE name = 'kept'")[0].n, 0);
});

test('transactions apply to every dialect and to exec batches', () => {
  const pg = new Database({ dialect: 'postgres' });
  pg.exec(`
    CREATE TABLE accounts (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
    BEGIN;
    INSERT INTO accounts (name) VALUES ('first');
    INSERT INTO accounts (name) VALUES ('second');
    ROLLBACK;
    SELECT COUNT(*) AS n FROM accounts
  `);
  assert.equal(pg.all('SELECT COUNT(*) AS n FROM accounts')[0].n, 0);

  const mysql = new Database({ dialect: 'mysql' });
  mysql.exec('CREATE TABLE t (id INT PRIMARY KEY, label VARCHAR(10))');
  mysql.exec('BEGIN');
  mysql.run("INSERT INTO t VALUES (1, 'a')");
  mysql.exec('COMMIT');
  assert.deepEqual(mysql.all('SELECT id, label FROM t'), [{ id: 1, label: 'a' }]);
});
