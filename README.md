# micro-sql

Zero-dependency embedded SQL database for Node.js and modern browsers, with
configurable SQLite, PostgreSQL and MySQL dialects.

The store is in memory. The SQL parser, execution engine, value rules and
error reporting are shared; each dialect supplies its own lexical rules,
quoting, type names, coercion and comparison semantics.

A separate `micro-sql/client` entry point runs statements against a real
SQLite, PostgreSQL or MySQL database with the same API surface. The
PostgreSQL and MySQL wire protocols are implemented here rather than delegated
to a driver package (see
[Connecting to a real database](#connecting-to-a-real-database)).

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

## Connecting to a real database

`micro-sql/client` sends statements to a live database instead of the
in-memory engine. PostgreSQL and MySQL/MariaDB are spoken to directly: this
package implements their wire protocols over `node:net`/`node:tls`, so no
database driver has to be installed. The methods mirror `Database`, but they
return promises because the connection is asynchronous.

```js
import { connect } from 'micro-sql/client';

const db = await connect({ dialect: 'sqlite', filename: './app.db' });

await db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
await db.run('INSERT INTO users (name) VALUES (?)', ['Ada']);

const rows = await db.all('SELECT * FROM users WHERE name = :name', { name: 'Ada' });

await db.transaction(async (tx) => {
  await tx.run('INSERT INTO users (name) VALUES (?)', ['Alan']);
});

await db.close();
```

### Connection options

| Dialect    | Options                                                                  | Transport                                      |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| `sqlite`   | `filename` (defaults to `':memory:'`)                                     | `node:sqlite` (Node 22.5+), `better-sqlite3` as fallback |
| `postgres` | `connectionString`, `host`, `port` (5432), `user`, `password`, `database`, `ssl`/`sslmode` | PostgreSQL protocol 3.0 over TCP or TLS        |
| `mysql`    | `connectionString`, `host`, `port` (3306), `user`, `password`, `database`, `ssl`/`sslmode` | MySQL protocol 10 over TCP or TLS              |

```js
const pg = await connect({ dialect: 'postgres', connectionString: process.env.DATABASE_URL });
const my = await connect({ dialect: 'mysql', host: 'localhost', user: 'app', password: 'secret', database: 'app' });
```

A URL supplies the defaults (`postgres://user:pass@host:5432/db?sslmode=require`),
`connectionOptions` overrides individual fields, and the top-level shortcuts
(`host`, `port`, `user`, `password`, `database`, `ssl`, `sslmode`) win over
both. `connectTimeout` (default 10000 ms) bounds the TCP and TLS handshakes.

SQLite is an embedded file format rather than a network protocol, so it is
read and written through Node's built-in `node:sqlite` binding. On older Node
releases the optional `better-sqlite3` peer dependency is used instead.
PostgreSQL and MySQL need no package at all.

### TLS

`sslmode` (or `ssl`) controls transport security:

| Value                                   | Behaviour                                                        |
| --------------------------------------- | ---------------------------------------------------------------- |
| `disable`                               | Plain TCP. MySQL's default.                                     |
| `prefer`                                | TLS when the server offers it, plain TCP otherwise. PostgreSQL's default. |
| `require`                               | TLS, but the server certificate is not verified.                 |
| `verify-ca`, `verify-full`, `verify`    | TLS with certificate verification.                               |

Pass an object as `ssl` to hand extra options (`ca`, `cert`, `key`,
`rejectUnauthorized`, ...) to `node:tls`. PostgreSQL negotiates TLS with an
SSLRequest before the startup message; MySQL upgrades the connection after
the server's handshake packet.

### Authentication

- PostgreSQL: cleartext, MD5, and SCRAM-SHA-256 (including the server
  signature check).
- MySQL: `mysql_native_password`, `caching_sha2_password` (fast path and full
  authentication over TLS or with the server's RSA public key) and
  `mysql_clear_password`.

Passwords are only sent over the connection as each protocol requires; use
`sslmode: 'require'` or stronger when the server is not on a trusted network.

### Client API

`client.run`, `all`, `get`, `exec` and `prepare` follow the same rules as
`Database`, but every call returns a promise. `client.transaction(fn)` wraps
the callback in `BEGIN`/`COMMIT` and issues `ROLLBACK` if it throws.
`client.close()` ends the connection and is safe to call twice.

`run` also accepts `INSERT`, `UPDATE` and `DELETE` statements with a
`RETURNING` clause. Those resolve to `{ changes, lastInsertRowid, rows }`, so a
generated key can be read without a second query:

```js
const { lastInsertRowid, rows } = await db.run(
  'INSERT INTO users (name) VALUES (?) RETURNING id, name',
  ['Ada']
);
```

`exec` splits statements on semicolons outside quotes and comments and returns
one result per statement. As with `Database#exec`, the supplied parameters
apply to every statement, so a statement without placeholders rejects extra
values with `PARAMETER_ERROR`.

### Parameters

Any placeholder style is accepted and rewritten to what the server expects:
`?`, `$1`, `:name`, `@name` and `$name`. MySQL `??` identifier escapes are
kept for MySQL. Boolean values bind as `0`/`1` on SQLite and MySQL and as
`true`/`false` on PostgreSQL. Statements without parameters use the simple
query protocol; parameterised ones are prepared and executed with bound
values (extended query on PostgreSQL, `COM_STMT_PREPARE`/`COM_STMT_EXECUTE`
on MySQL).

Only the parameters are scanned; the SQL text is not parsed. Statements the
in-memory engine does not support (`ALTER TABLE`, subqueries, casts) therefore
pass straight through to the server.

### Result decoding

Values arrive in each protocol's native encoding and are decoded before they
reach your code:

- PostgreSQL text values are decoded by type OID: booleans become `true`/
  `false`, `int2`/`int4`/`oid` and `int8` (when it fits) become numbers,
  `float4`/`float8` become numbers, `numeric` stays a string to avoid losing
  precision, and `bytea` becomes a `Buffer`.
- MySQL text and binary result sets are decoded from their column types;
  `TINYINT(1)` is not special-cased, so booleans come back as `0`/`1` unless
  the query casts them.
- SQLite values keep the types `node:sqlite` returns.

### Differences from the in-memory engine

- `INSERT ... RETURNING` is supported on all three drivers. `lastInsertRowid`
  comes from the driver when it reports one (SQLite, MySQL) and otherwise from
  the first column of the first returned row, which is how PostgreSQL exposes
  serial ids. A write without `RETURNING` reports `0` there.
- Type coercion and constraint enforcement are the server's, not the dialect
  profile's.
- Server errors become `SqlError`s with the matching code when one is known
  (`UNIQUE_CONSTRAINT`, `NOT_NULL_CONSTRAINT`, `MISSING_TABLE`,
  `MISSING_COLUMN`, `TABLE_EXISTS`, `SYNTAX_ERROR`, `DIVISION_BY_ZERO`,
  `TYPE_ERROR`). SQLSTATE values from PostgreSQL and `ER_*` numbers from MySQL
  drive the mapping. Everything else, including connection failures, raises
  `DRIVER_ERROR`. The original error is kept as `error.cause`.
- A custom driver may be passed as `driver` (implementing `query`, `exec` and
  `close`) to reuse an existing pool or to reach a server this package has no
  protocol for. It replaces the bundled implementation for that connection.

## TypeScript

Type declarations ship with the package for all three entry points. Branded
result types (`Row`, `RunResult`, `ExecResult`, `DatabaseSnapshot`) and
`SqlValue` are exported from `micro-sql`.

```ts
import { Database, type Row } from 'micro-sql';
import { toJSON } from 'micro-sql/adapter';
import { connect } from 'micro-sql/client';
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
`DIVISION_BY_ZERO`, `ADAPTER_ERROR`, `DRIVER_ERROR`). Syntax errors also carry `sql`,
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
