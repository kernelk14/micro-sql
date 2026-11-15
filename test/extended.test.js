import test from 'node:test';
import assert from 'node:assert/strict';

import { Database, ErrorCodes } from '../src/index.js';

function shopDatabase() {
  const db = new Database({ dialect: 'sqlite' });
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total REAL);
  `);
  db.exec(`
    INSERT INTO users (name, age) VALUES ('Ada', 36), ('Alan', 41), ('Grace', NULL);
    INSERT INTO orders (user_id, total) VALUES (1, 10.5), (1, 4.5), (2, 7);
  `);
  return db;
}

test('CASE expressions choose the first matching branch', () => {
  const db = shopDatabase();
  assert.deepEqual(
    db.all(`
      SELECT name,
             CASE
               WHEN age IS NULL THEN 'unknown'
               WHEN age >= 40 THEN 'senior'
               ELSE 'adult'
             END AS band
      FROM users
      ORDER BY id
    `),
    [
      { name: 'Ada', band: 'adult' },
      { name: 'Alan', band: 'senior' },
      { name: 'Grace', band: 'unknown' }
    ]
  );
  assert.deepEqual(
    db.all(`SELECT name, CASE name WHEN 'Ada' THEN 1 ELSE 0 END AS first FROM users ORDER BY id`),
    [
      { name: 'Ada', first: 1 },
      { name: 'Alan', first: 0 },
      { name: 'Grace', first: 0 }
    ]
  );
  // A CASE without ELSE yields NULL, and one branch may name an aggregate.
  assert.deepEqual(
    db.get(`
      SELECT SUM(CASE WHEN total > 5 THEN total ELSE 0 END) AS big
      FROM orders
    `),
    { big: 17.5 }
  );
});

test('CAST converts between the canonical types', () => {
  const db = shopDatabase();
  assert.deepEqual(
    db.get(`SELECT CAST(age AS TEXT) AS text_age, CAST('42' AS INTEGER) AS parsed, CAST(4.7 AS INTEGER) AS truncated FROM users WHERE id = 1`),
    { text_age: '36', parsed: 42, truncated: 4 }
  );
  assert.deepEqual(
    db.get(`SELECT CAST(total AS INTEGER) AS whole, CAST(0 AS BOOLEAN) AS flag FROM orders WHERE id = 1`),
    { whole: 10, flag: false }
  );
  assert.throws(
    () => db.all(`SELECT CAST('abc' AS INTEGER)`),
    (error) => error.code === ErrorCodes.TYPE_ERROR
  );
});

test('scalar subqueries run per row and can be correlated', () => {
  const db = shopDatabase();
  assert.deepEqual(
    db.all(`
      SELECT name, (SELECT MAX(total) FROM orders o WHERE o.user_id = u.id) AS top
      FROM users u
      ORDER BY u.id
    `),
    [
      { name: 'Ada', top: 10.5 },
      { name: 'Alan', top: 7 },
      { name: 'Grace', top: null }
    ]
  );
  assert.deepEqual(db.get('SELECT (SELECT COUNT(*) FROM orders) AS n'), { n: 3 });
  assert.throws(
    () => db.all('SELECT (SELECT id FROM orders) AS id'),
    (error) => error.code === ErrorCodes.INVALID_QUERY
  );
});

test('IN and EXISTS accept subqueries', () => {
  const db = shopDatabase();
  assert.deepEqual(
    db.all('SELECT name FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > 5) ORDER BY id'),
    [{ name: 'Ada' }, { name: 'Alan' }]
  );
  assert.deepEqual(
    db.all('SELECT name FROM users WHERE id NOT IN (SELECT user_id FROM orders WHERE total > 5) ORDER BY id'),
    [{ name: 'Grace' }]
  );
  assert.deepEqual(
    db.all(`
      SELECT name FROM users u
      WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.total > 10)
      ORDER BY id
    `),
    [{ name: 'Ada' }]
  );
  assert.deepEqual(
    db.all(`
      SELECT name FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)
    `),
    [{ name: 'Grace' }]
  );
});

test('CROSS, RIGHT and FULL joins and JOIN ... USING', () => {
  const db = new Database({ dialect: 'sqlite' });
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER, title TEXT NOT NULL);
  `);
  db.exec(`
    INSERT INTO users (name) VALUES ('Ada'), ('Alan');
    INSERT INTO posts (author_id, title) VALUES (1, 'One'), (NULL, 'Orphan');
  `);

  assert.deepEqual(db.get('SELECT COUNT(*) AS n FROM users CROSS JOIN posts'), { n: 4 });

  assert.deepEqual(
    db.all('SELECT u.name, p.title FROM users u RIGHT JOIN posts p ON u.id = p.author_id ORDER BY p.id'),
    [
      { name: 'Ada', title: 'One' },
      { name: null, title: 'Orphan' }
    ]
  );

  assert.deepEqual(
    db.all('SELECT u.name, p.title FROM users u FULL JOIN posts p ON u.id = p.author_id ORDER BY p.id'),
    [
      // SQLite sorts NULLs first in ascending order, so the unmatched user leads.
      { name: 'Alan', title: null },
      { name: 'Ada', title: 'One' },
      { name: null, title: 'Orphan' }
    ]
  );

  assert.deepEqual(
    db.all('SELECT u.name, p.title FROM users u JOIN posts p USING (id) ORDER BY p.id'),
    [
      { name: 'Ada', title: 'One' },
      // posts.id 2 is 'Orphan' (author_id NULL) and still joins on the id column.
      { name: 'Alan', title: 'Orphan' }
    ]
  );
  assert.throws(
    () => db.all('SELECT * FROM users u CROSS JOIN posts p ON u.id = p.author_id'),
    (error) => error.code === ErrorCodes.SYNTAX_ERROR
  );
});

test('GROUP BY and ORDER BY accept select-list ordinals', () => {
  const db = shopDatabase();
  assert.deepEqual(
    db.all('SELECT name, age FROM users ORDER BY 2 DESC'),
    [
      { name: 'Alan', age: 41 },
      { name: 'Ada', age: 36 },
      { name: 'Grace', age: null }
    ]
  );
  assert.deepEqual(
    db.all('SELECT age, COUNT(*) AS n FROM users GROUP BY 1 ORDER BY 2 DESC, 1'),
    [
      { age: null, n: 1 },
      { age: 36, n: 1 },
      { age: 41, n: 1 }
    ]
  );
});

test('ALTER TABLE adds, drops and renames columns and tables', () => {
  const db = shopDatabase();

  db.exec('ALTER TABLE users ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE');
  assert.deepEqual(db.get('SELECT active FROM users WHERE id = 1'), { active: 1 });

  db.exec('ALTER TABLE users ADD COLUMN nickname TEXT');
  db.run("UPDATE users SET nickname = 'A' WHERE id = 1");
  assert.deepEqual(db.get('SELECT nickname, active FROM users WHERE id = 1'), { nickname: 'A', active: 1 });

  db.exec('ALTER TABLE orders RENAME COLUMN total TO amount');
  assert.deepEqual(db.get('SELECT amount FROM orders ORDER BY id LIMIT 1'), { amount: 10.5 });

  db.exec('ALTER TABLE orders RENAME TO purchases');
  assert.deepEqual(db.get('SELECT COUNT(*) AS n FROM purchases'), { n: 3 });
  assert.throws(() => db.get('SELECT * FROM orders'), (error) => error.code === ErrorCodes.MISSING_TABLE);

  db.exec('ALTER TABLE users DROP COLUMN nickname');
  assert.deepEqual(Object.keys(db.get('SELECT * FROM users WHERE id = 1')).sort(), ['active', 'age', 'id', 'name']);

  assert.throws(
    () => db.exec('ALTER TABLE users ADD COLUMN required TEXT NOT NULL'),
    (error) => error.code === ErrorCodes.INVALID_QUERY
  );
  assert.throws(
    () => db.exec('ALTER TABLE users ADD COLUMN name TEXT'),
    (error) => error.code === ErrorCodes.DUPLICATE_COLUMN
  );

  db.exec('BEGIN');
  db.exec('ALTER TABLE users ADD COLUMN temporary TEXT');
  db.exec('ROLLBACK');
  assert.deepEqual(Object.keys(db.get('SELECT * FROM users WHERE id = 1')).sort(), ['active', 'age', 'id', 'name']);
});

test('CREATE INDEX and DROP INDEX track index metadata', () => {
  const db = shopDatabase();
  db.exec('CREATE INDEX users_age ON users (age)');
  db.exec('CREATE UNIQUE INDEX orders_user_total ON orders (user_id, total)');
  assert.throws(
    () => db.exec('CREATE INDEX users_age ON users (age)'),
    (error) => error.code === ErrorCodes.INVALID_QUERY
  );
  assert.throws(
    () => db.exec('CREATE INDEX missing_column ON users (nope)'),
    (error) => error.code === ErrorCodes.MISSING_COLUMN
  );
  db.exec('DROP INDEX users_age');
  db.exec('DROP INDEX IF EXISTS users_age');
  assert.throws(() => db.exec('DROP INDEX users_age'), (error) => error.code === ErrorCodes.INVALID_QUERY);
});
