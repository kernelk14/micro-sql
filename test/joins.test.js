import test from 'node:test';
import assert from 'node:assert/strict';

import { Database, ErrorCodes } from '../src/index.js';

function blogDatabase() {
  const db = new Database({ dialect: 'sqlite' });
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER, title TEXT NOT NULL);
  `);
  db.exec(`
    INSERT INTO users (name) VALUES ('Ada'), ('Alan'), ('Grace');
    INSERT INTO posts (author_id, title) VALUES (1, 'One'), (1, 'Two'), (2, 'Three'), (NULL, 'Orphan');
  `);
  return db;
}

test('inner joins match rows across tables', () => {
  const db = blogDatabase();
  assert.deepEqual(
    db.all(`
      SELECT users.name, posts.title
      FROM users
      JOIN posts ON users.id = posts.author_id
      ORDER BY posts.id
    `),
    [
      { name: 'Ada', title: 'One' },
      { name: 'Ada', title: 'Two' },
      { name: 'Alan', title: 'Three' }
    ]
  );
  assert.deepEqual(
    db.all(`
      SELECT p.title
      FROM posts p
      INNER JOIN users u ON u.id = p.author_id
      WHERE p.title = ?
    `, ['Three']),
    [{ title: 'Three' }]
  );
});

test('left joins keep unmatched rows with NULL columns', () => {
  const db = blogDatabase();
  assert.deepEqual(
    db.all(`
      SELECT u.name, p.title
      FROM users AS u
      LEFT JOIN posts p ON u.id = p.author_id
      ORDER BY u.id, p.id
    `),
    [
      { name: 'Ada', title: 'One' },
      { name: 'Ada', title: 'Two' },
      { name: 'Alan', title: 'Three' },
      { name: 'Grace', title: null }
    ]
  );
  assert.deepEqual(
    db.all(`
      SELECT u.name, COUNT(p.id) AS posts
      FROM users u
      LEFT JOIN posts p ON u.id = p.author_id
      GROUP BY u.name
      HAVING posts = 0
    `),
    [{ name: 'Grace', posts: 0 }]
  );
});

test('joins resolve qualified columns, qualified stars and aliases', () => {
  const db = blogDatabase();
  assert.deepEqual(
    db.all('SELECT u.* FROM users u WHERE u.id = ?', [2]),
    [{ id: 2, name: 'Alan' }]
  );
  assert.deepEqual(
    db.all('SELECT p.title FROM users u JOIN posts p ON u.id = p.author_id WHERE p.id = 4'),
    []
  );

  // Duplicate column names are reported with their table alias.
  assert.deepEqual(
    db.all('SELECT * FROM users u JOIN posts p ON u.id = p.author_id WHERE p.id = 1'),
    [{ 'u.id': 1, name: 'Ada', 'p.id': 1, author_id: 1, title: 'One' }]
  );
});

test('joins report ambiguous, unknown and unsupported references', () => {
  const db = blogDatabase();
  assert.throws(
    () => db.all('SELECT id FROM users JOIN posts ON users.id = posts.author_id'),
    (error) => error.code === ErrorCodes.INVALID_QUERY
  );
  assert.throws(
    () => db.all('SELECT nope FROM users u JOIN posts p ON u.id = p.author_id'),
    (error) => error.code === ErrorCodes.MISSING_COLUMN
  );
  assert.throws(
    () => db.all('SELECT u.id FROM users u JOIN posts p ON x.id = p.author_id'),
    (error) => error.code === ErrorCodes.MISSING_COLUMN
  );
  assert.throws(
    () => db.all('SELECT * FROM users u JOIN users u2 ON u.id = u2.id JOIN users u ON u.id = u.id'),
    (error) => error.code === ErrorCodes.INVALID_QUERY && /alias/i.test(error.message)
  );
  assert.throws(
    () => db.all('SELECT * FROM users JOIN posts'),
    (error) => error.code === ErrorCodes.SYNTAX_ERROR
  );
  assert.throws(
    () => db.all('SELECT * FROM users JOIN posts USING (id)'),
    (error) => error.code === ErrorCodes.UNSUPPORTED
  );
  assert.throws(
    () => db.all('SELECT * FROM users RIGHT JOIN posts ON users.id = posts.author_id'),
    (error) => error.code === ErrorCodes.UNSUPPORTED
  );
});

test('joined expressions still follow dialect value rules', () => {
  const db = blogDatabase();
  assert.deepEqual(
    db.all(`
      SELECT u.name, p.id * 10 AS scaled
      FROM users u JOIN posts p ON u.id = p.author_id
      WHERE p.id <= 2
      ORDER BY p.id
    `),
    [
      { name: 'Ada', scaled: 10 },
      { name: 'Ada', scaled: 20 }
    ]
  );

  const pg = new Database({ dialect: 'postgres' });
  pg.exec(`
    CREATE TABLE a (id SERIAL PRIMARY KEY, label TEXT);
    CREATE TABLE b (id SERIAL PRIMARY KEY, a_id INTEGER, note TEXT);
  `);
  pg.exec(`
    INSERT INTO a (label) VALUES ('x');
    INSERT INTO b (a_id, note) VALUES (1, 'y'), (1, 'z');
  `);
  assert.deepEqual(
    pg.all("SELECT a.label, b.note FROM a JOIN b ON a.id = b.a_id ORDER BY b.note || '!' DESC"),
    [
      { label: 'x', note: 'z' },
      { label: 'x', note: 'y' }
    ]
  );
});
