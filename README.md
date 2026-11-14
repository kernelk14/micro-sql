# micro-sql

Zero-dependency embedded SQL database for Node.js and modern browsers, with
configurable SQLite, PostgreSQL and MySQL dialects.

The store is in memory. The SQL parser, execution engine, value rules and
error reporting are shared; each dialect supplies its own lexical rules,
quoting, type names, coercion and comparison semantics.

```js
import { Database } from 'micro-sql';

const db = new Database({ dialect: 'sqlite' });

db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    age INTEGER,
    active BOOLEAN NOT NULL DEFAULT TRUE
  )
`);

db.run('INSERT INTO users (name, email, age) VALUES (?, ?, ?)', ['Ada', 'ada@example.com', 36]);
db.run('INSERT INTO users (name, email) VALUES (:name, :email)', {
  name: 'Alan',
  email: 'alan@example.com'
});

db.all('SELECT name, age FROM users WHERE age > ? ORDER BY age DESC', [30]);
// [ { name: 'Ada', age: 36 }, { name: 'Alan', age: null } ]
```

## API

### `new Database({ dialect })`

`dialect` is `'sqlite'` (default), `'postgres'`/`'postgresql'`/`'pg'`,
`'mysql'`/`'mariadb'`, or a `BaseDialect` instance for a custom profile.

### `db.exec(sql, params?)`

Runs one or more `;`-separated statements. Returns one result per statement:
`{ rows }` for `SELECT`, otherwise `{ changes, lastInsertRowid }`.

### `db.run(sql, params?)`

Runs a non-`SELECT` statement. Returns `{ changes, lastInsertRowid }`.
Calling `run` with a `SELECT` throws.

### `db.all(sql, params?)` / `db.get(sql, params?)`

Runs a `SELECT` and returns every row, or the first row / `undefined`.

### `db.prepare(sql)`

Compiles a statement once (the AST is reused) and returns an object with
`all(params)`, `get(params)` and `run(params)`.

## Parameters

| Dialect    | Positional        | Named        |
| ---------- | ----------------- | ------------ |
| SQLite     | `?`               | `:name`, `@name`, `$name` |
| PostgreSQL | `$1`, `$2`, ...   | `:name` (extension) |
| MySQL      | `?`               | `:name`      |

Pass an array for positional parameters and an object for named parameters.
A statement cannot mix the two, the array length must match the number of
placeholders, and missing names raise `PARAMETER_ERROR`. Only `null`, string,
finite number and boolean values can be bound.

## Supported SQL

- `SELECT [DISTINCT] expr [AS alias], ... [FROM table [[AS] alias]
  {[INNER] JOIN | LEFT [OUTER] JOIN} table [[AS] alias] ON expr ...]
  [WHERE ...] [GROUP BY ...] [HAVING ...] [ORDER BY ... [ASC|DESC]
  [NULLS FIRST|LAST]] [LIMIT n] [OFFSET n]`, including `LIMIT offset, count`
  where the dialect allows it. `*` and `alias.*` expand source columns.
- `INSERT INTO t [(columns)] VALUES (...), (...)`.
- `UPDATE t SET column = expr, ... [WHERE ...]`.
- `DELETE FROM t [WHERE ...]`.
- `CREATE TABLE [IF NOT EXISTS] t (column TYPE [PRIMARY KEY [AUTOINCREMENT]]
  [NOT NULL] [UNIQUE] [DEFAULT expr], ..., [PRIMARY KEY (cols)], [UNIQUE (cols)])`.
- `DROP TABLE [IF EXISTS] t`.
- `BEGIN [TRANSACTION]`, `COMMIT [TRANSACTION]`, `ROLLBACK [TRANSACTION]`.

## Joins

`INNER JOIN` (the default for `JOIN`) and `LEFT [OUTER] JOIN` are supported
with an `ON` condition. Each joined table may have an alias. Unqualified
columns are an error when both sides define the same name, so duplicate names
in `SELECT *` are returned as `alias.column`.

```js
const rows = db.all(`
  SELECT u.name, COUNT(p.id) AS posts
  FROM users u
  LEFT JOIN posts p ON u.id = p.author_id
  GROUP BY u.name
  ORDER BY posts DESC
`);
```

## Transactions

The in-memory store supports explicit transactions. `BEGIN` snapshots the
current tables; `ROLLBACK` restores that snapshot, including schema changes,
while `COMMIT` keeps the changes. Nested transactions, and `COMMIT`/`ROLLBACK`
without an active transaction, raise `INVALID_QUERY`. Transactions cover every
dialect and are scoped to one `Database` instance.

```js
const transfer = db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?');
db.exec('BEGIN');
try {
  transfer.run([-50, 1]);
  transfer.run([50, 2]);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
```

Expressions support `AND`, `OR`, `NOT`, comparisons (`=`, `<>`, `!=`, `<`,
`<=`, `>`, `>=`), `IS [NOT] NULL/TRUE/FALSE`, `[NOT] IN`, `[NOT] LIKE`,
`[NOT] BETWEEN`, arithmetic (`+`, `-`, `*`, `/`, `%`), unary `+`/`-` and
`||` where the dialect supports it. `NULL` follows three-valued logic.

Functions:

- All dialects: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, `ABS`, `LOWER`, `UPPER`,
  `LENGTH`, `COALESCE`, `ROUND`.
- SQLite: `IFNULL`, `TYPEOF`.
- MySQL: `IFNULL`, `CONCAT`, `CHAR_LENGTH`.
- PostgreSQL: `CONCAT`, `CHAR_LENGTH`.

## Dialect differences

| Behaviour              | SQLite                      | PostgreSQL              | MySQL                     |
| ---------------------- | --------------------------- | ----------------------- | ------------------------- |
| Identifier quotes      | `"..."`                     | `"..."`                 | `` `...` ``               |
| String quotes          | `'...'`                     | `'...'`                 | `'...'` and `"..."`       |
| Backslash escapes      | no                          | no                      | yes                       |
| `#` line comments      | no                          | no                      | yes                       |
| `?` parameters         | yes                         | no                      | yes                       |
| `$n` parameters        | no                          | yes                     | no                        |
| `||` concatenation     | yes                         | yes                     | no (use `CONCAT`)         |
| `LIKE` case            | insensitive (ASCII)         | sensitive               | insensitive (ASCII)       |
| Integer `/` integer    | yes                         | yes                     | no (always real)          |
| Division by zero       | `NULL`                      | `DIVISION_BY_ZERO`      | `NULL`                    |
| `WHERE` predicate      | truthy (numbers/text)       | must be boolean         | truthy (numbers/text)     |
| NULLs in `ORDER BY ASC`| first                       | last                    | first                     |
| Declared types         | affinity rules, `BLOB` rejected | fixed list (incl. `SERIAL`) | fixed list (incl. `SERIAL`) |
| BOOLEAN values         | stored as `0`/`1`           | `true`/`false`          | stored as `0`/`1`         |

SQLite `INTEGER PRIMARY KEY` columns assign rowids automatically, as do
`AUTOINCREMENT` and PostgreSQL `SERIAL` columns. MySQL `AUTO_INCREMENT` is not
supported.

## Persistence adapter

The store is in memory. `micro-sql/adapter` snapshots a database to plain JSON
and restores it, which is useful for `localStorage`, fixtures and tests.

```js
import { toJSON, fromJSON } from 'micro-sql/adapter';

const snapshot = toJSON(db);            // JSON-safe object
const restored = fromJSON(snapshot);    // new Database with the same tables
localStorage.setItem('db', JSON.stringify(snapshot));
```

`fromJSON` accepts the parsed snapshot or a JSON string and takes an optional
`{ dialect }` override. Invalid snapshots raise `ADAPTER_ERROR`.

## TypeScript

Type declarations ship with the package for all three entry points. Branded
result types (`Row`, `RunResult`, `ExecResult`, `DatabaseSnapshot`) and
`SqlValue` are exported from `micro-sql`.

```ts
import { Database, type Row } from 'micro-sql';
import { toJSON } from 'micro-sql/adapter';
import { getDialect } from 'micro-sql/dialects';

const db = new Database({ dialect: 'postgres' });
const rows: Row[] = db.all('SELECT * FROM users');
const dialect = getDialect('postgres');
```

## Errors

Every failure is a `SqlError` with a stable `code` (`SYNTAX_ERROR`,
`UNSUPPORTED`, `INVALID_QUERY`, `MISSING_TABLE`, `TABLE_EXISTS`,
`MISSING_COLUMN`, `DUPLICATE_COLUMN`, `TYPE_ERROR`, `UNSUPPORTED_TYPE`,
`NOT_NULL_CONSTRAINT`, `UNIQUE_CONSTRAINT`, `PARAMETER_ERROR`,
`DIVISION_BY_ZERO`, `ADAPTER_ERROR`). Syntax errors also carry `sql`,
`position`, `line` and `column`.

```js
try {
  db.all('SELECT * FROM nope');
} catch (error) {
  console.log(error.code); // MISSING_TABLE
}
```

## Not supported

No subqueries, `RIGHT`/`FULL`/`CROSS JOIN`, `JOIN ... USING`, `ALTER TABLE`,
indexes, views, savepoints, `HAVING`/`ORDER BY` ordinal positions, `CASE`,
dates or BLOBs. Unsupported syntax raises `UNSUPPORTED` or `SYNTAX_ERROR`.

## Development

```sh
npm test          # node --test
npm run example   # examples/node-demo.js
```
