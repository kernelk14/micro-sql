import { SqlError, ErrorCodes } from './errors.js';
import { getDialect } from './dialects/index.js';
import { createDriver } from './client/drivers/index.js';
import { mapDriverError } from './client/errors.js';
import {
  isReadStatement,
  normalizeParameters,
  splitStatements,
  statementKind,
  statementVerb
} from './client/params.js';

/**
 * Async client for a real SQLite, PostgreSQL or MySQL database.
 *
 * The API mirrors `Database`, but every method returns a Promise because the
 * drivers are asynchronous. Statements and parameters are sent to the server;
 * the in-memory engine is not involved.
 *
 * ```js
 * import { connect } from 'micro-sql/client';
 *
 * const db = await connect({ dialect: 'sqlite', filename: './app.db' });
 * await db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)');
 * await db.run('INSERT INTO users (name) VALUES (?)', ['Ada']);
 * const rows = await db.all('SELECT * FROM users WHERE name = :name', { name: 'Ada' });
 * await db.close();
 * ```
 *
 * Parameters may be written in any dialect's style (`?`, `$1` or `:name`) and
 * are rewritten to the placeholder syntax the driver expects.
 */

/**
 * Open a connection to a real database.
 *
 * @param {{
 *   dialect?: string,
 *   filename?: string,
 *   connectionString?: string,
 *   url?: string,
 *   connectionOptions?: object,
 *   driver?: object
 * }} [options]
 * @returns {Promise<Client>}
 */
export async function connect(options = {}) {
  const dialect = getDialect(options.dialect ?? 'sqlite');
  const driver = await createDriver(dialect.name, options);
  return new Client(dialect, driver);
}

/** A live connection with the same surface as `Database`. */
export class Client {
  /**
   * @param {import('./dialects/base.js').BaseDialect} dialect
   * @param {{ query: Function, exec: Function, close: Function }} driver
   */
  constructor(dialect, driver) {
    this.dialect = dialect;
    this.driver = driver;
    this.closed = false;
  }

  /**
   * Compile a statement for repeated execution.
   * @param {string} sql
   * @returns {PreparedStatement}
   */
  prepare(sql) {
    if (typeof sql !== 'string') throw new TypeError('SQL must be a string.');
    return new PreparedStatement(this, sql);
  }

  /**
   * Execute a statement that does not return rows. `INSERT`, `UPDATE` and
   * `DELETE` statements with a `RETURNING` clause are executed too; their rows
   * are returned alongside the counts.
   * @param {string} sql
   * @param {unknown} [params]
   * @returns {Promise<{ changes: number, lastInsertRowid: number, rows?: object[] }>}
   */
  async run(sql, params) {
    return this.prepare(sql).run(params);
  }

  /**
   * Execute a SELECT and return every row.
   * @param {string} sql
   * @param {unknown} [params]
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async all(sql, params) {
    return this.prepare(sql).all(params);
  }

  /**
   * Execute a SELECT and return the first row, or undefined.
   * @param {string} sql
   * @param {unknown} [params]
   * @returns {Promise<Record<string, unknown>|undefined>}
   */
  async get(sql, params) {
    return this.prepare(sql).get(params);
  }

  /**
   * Execute one or more statements separated by semicolons.
   * @param {string} sql
   * @param {unknown} [params]
   * @returns {Promise<object[]>} one result per statement
   */
  async exec(sql, params) {
    if (typeof sql !== 'string') throw new TypeError('SQL must be a string.');
    const results = [];
    for (const statement of splitStatements(sql, this.dialect)) {
      const kind = statementKind(statement);
      const result = await this.execute(statement, params, kind);
      results.push(toPublicResult(kind, result));
    }
    return results;
  }

  /**
   * Run a function inside a transaction. The callback receives this client;
   * its result is returned after COMMIT. Any error triggers ROLLBACK.
   *
   * @template T
   * @param {(client: Client) => T|Promise<T>} fn
   * @returns {Promise<T>}
   */
  async transaction(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('transaction() expects a function to run.');
    }
    await this.exec('BEGIN');
    try {
      const value = await fn(this);
      await this.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        await this.exec('ROLLBACK');
      } catch {
        // The original error is more useful than a failed rollback.
      }
      throw error;
    }
  }

  /** Close the connection. Safe to call more than once. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.driver.close();
  }

  /**
   * @param {string} sql
   * @param {unknown} params
   * @param {'rows'|'run'} kind
   */
  async execute(sql, params, kind) {
    if (this.closed) {
      throw new SqlError(ErrorCodes.DRIVER_ERROR, 'This client is closed.');
    }
    const { text, values } = normalizeParameters(sql, params, this.dialect);
    try {
      return await this.driver.query(text, values, { returnsRows: kind === 'rows' });
    } catch (error) {
      throw mapDriverError(error, this.dialect.name, sql);
    }
  }
}

/** A statement that can be executed repeatedly against a live connection. */
export class PreparedStatement {
  /**
   * @param {Client} client
   * @param {string} sql
   */
  constructor(client, sql) {
    this.client = client;
    this.sql = sql;
    this.dialect = client.dialect;
  }

  /**
   * Execute a statement. A `RETURNING` clause is allowed: its rows are
   * returned as `rows` and an inserted id becomes `lastInsertRowid`.
   * @param {unknown} [params]
   * @returns {Promise<{ changes: number, lastInsertRowid: number, rows?: object[] }>}
   */
  async run(params) {
    const kind = statementKind(this.sql);
    if (kind === 'rows') {
      if (isReadStatement(this.sql)) {
        throw new SqlError(
          ErrorCodes.INVALID_QUERY,
          'run() cannot execute a SELECT statement; use all() or get() instead.'
        );
      }
      const result = await this.client.execute(this.sql, params, 'rows');
      return toReturningResult(result, statementVerb(this.sql) === 'INSERT');
    }
    return toPublicResult('run', await this.client.execute(this.sql, params, 'run'));
  }

  /**
   * @param {unknown} [params]
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async all(params) {
    if (statementKind(this.sql) !== 'rows') {
      throw new SqlError(ErrorCodes.INVALID_QUERY, 'all() requires a SELECT statement.');
    }
    return toPublicResult('rows', await this.client.execute(this.sql, params, 'rows')).rows;
  }

  /**
   * @param {unknown} [params]
   * @returns {Promise<Record<string, unknown>|undefined>}
   */
  async get(params) {
    return (await this.all(params))[0];
  }
}

function toPublicResult(kind, result) {
  if (kind === 'rows') return { rows: normalizeRows(result) };
  return {
    changes: Number((result && result.changes) ?? 0),
    lastInsertRowid: Number((result && result.lastInsertRowid) ?? 0)
  };
}

/**
 * Build the result of a write statement that also returns rows.
 *
 * Drivers that report a change count keep it; otherwise the number of
 * returned rows is used. `lastInsertRowid` comes from the driver when it knows
 * it, and from the first column of the first row for `INSERT ... RETURNING`
 * (which is how PostgreSQL reports generated ids).
 *
 * @param {object} result
 * @param {boolean} isInsert
 */
function toReturningResult(result, isInsert) {
  const rows = normalizeRows(result);
  const reported = result && result.changes;
  const changes = reported === undefined || reported === null ? rows.length : Number(reported);
  const reportedId = result && result.lastInsertRowid;
  return {
    changes,
    lastInsertRowid:
      reportedId === undefined || reportedId === null
        ? isInsert
          ? firstColumnAsId(rows)
          : 0
        : Number(reportedId),
    rows
  };
}

/** Rows lose any null prototype so every driver produces ordinary objects. */
function normalizeRows(result) {
  const rows = result && result.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({ ...row }));
}

/** Numeric value of the first column of the first row, or 0. */
function firstColumnAsId(rows) {
  if (rows.length === 0) return 0;
  const value = Object.values(rows[0])[0];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}
