import { SqlError, ErrorCodes } from './errors.js';
import { Engine } from './engine.js';
import { collectParameters, parse, parseAll } from './parser.js';
import { assertBindableValue } from './values.js';
import { getDialect, listDialects } from './dialects/index.js';

export { SqlError, ErrorCodes } from './errors.js';
export { getDialect, listDialects } from './dialects/index.js';
export { BaseDialect, SqliteDialect, PostgresDialect, MysqlDialect } from './dialects/index.js';

/**
 * An embedded SQL database with an in-memory store.
 *
 * ```js
 * import { Database } from 'micro-sql';
 * const db = new Database({ dialect: 'sqlite' });
 * db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
 * db.run('INSERT INTO users (name) VALUES (?)', ['Ada']);
 * db.all('SELECT * FROM users WHERE name = :name', { name: 'Ada' });
 * ```
 */
export class Database {
  /** @param {{ dialect?: string|import('./dialects/base.js').BaseDialect }} [options] */
  constructor(options = {}) {
    this.dialect = getDialect(options.dialect ?? 'sqlite');
    this.engine = new Engine(this.dialect);
  }

  /**
   * Compile a single statement. The returned Statement can be executed many
   * times with different parameters.
   * @param {string} sql
   * @returns {Statement}
   */
  prepare(sql) {
    return new Statement(this, sql);
  }

  /**
   * Execute a statement that does not return rows.
   * @param {string} sql
   * @param {unknown} [params]
   * @returns {{ changes: number, lastInsertRowid: number }}
   */
  run(sql, params) {
    return this.prepare(sql).run(params);
  }

  /**
   * Execute a SELECT and return every row.
   * @param {string} sql
   * @param {unknown} [params]
   * @returns {Record<string, unknown>[]}
   */
  all(sql, params) {
    return this.prepare(sql).all(params);
  }

  /**
   * Execute a SELECT and return the first row, or undefined.
   * @param {string} sql
   * @param {unknown} [params]
   * @returns {Record<string, unknown>|undefined}
   */
  get(sql, params) {
    return this.prepare(sql).get(params);
  }

  /**
   * Execute one or more statements separated by semicolons.
   * @param {string} sql
   * @param {unknown} [params]
   * @returns {object[]} one result per statement
   */
  exec(sql, params) {
    const statements = parseAll(sql, this.dialect);
    return statements.map((statement) => {
      const bind = createBinder(collectParameters(statement), params);
      const result = this.engine.execute(statement, bind);
      if (result.type === 'select') return { rows: result.rows };
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid ?? 0 };
    });
  }
}

/** A single compiled SQL statement. */
export class Statement {
  /**
   * @param {Database} database
   * @param {string} sql
   */
  constructor(database, sql) {
    if (typeof sql !== 'string') throw new TypeError('SQL must be a string.');
    this.database = database;
    this.sql = sql;
    this.dialect = database.dialect;
    this.ast = parse(sql, this.dialect);
    this.parameters = collectParameters(this.ast);
  }

  /**
   * @param {unknown} [params]
   * @returns {{ changes: number, lastInsertRowid: number }}
   */
  run(params) {
    const result = this.execute(params);
    if (result.type === 'select') {
      throw new SqlError(
        ErrorCodes.INVALID_QUERY,
        'run() cannot execute a SELECT statement; use all() or get() instead.'
      );
    }
    return { changes: result.changes ?? 0, lastInsertRowid: result.lastInsertRowid ?? 0 };
  }

  /**
   * @param {unknown} [params]
   * @returns {Record<string, unknown>[]}
   */
  all(params) {
    const result = this.execute(params);
    if (result.type !== 'select') {
      throw new SqlError(
        ErrorCodes.INVALID_QUERY,
        `all() requires a SELECT statement, received ${result.type.toUpperCase()}.`
      );
    }
    return result.rows;
  }

  /**
   * @param {unknown} [params]
   * @returns {Record<string, unknown>|undefined}
   */
  get(params) {
    return this.all(params)[0];
  }

  execute(params) {
    const bind = createBinder(this.parameters, params);
    return this.database.engine.execute(this.ast, bind);
  }
}

/**
 * Build a function that resolves a parameter token to a bound value.
 * @param {object[]} parameters
 * @param {unknown} params
 */
export function createBinder(parameters, params) {
  if (parameters.length === 0) {
    if (params === undefined || params === null) return () => null;
    const isEmpty =
      (Array.isArray(params) && params.length === 0) ||
      (isNamedParameterBag(params) && Object.keys(toObject(params)).length === 0);
    if (isEmpty) return () => null;
    throw new SqlError(
      ErrorCodes.PARAMETER_ERROR,
      'This statement has no parameters, but values were supplied.'
    );
  }

  if (params === undefined || params === null) {
    throw new SqlError(
      ErrorCodes.PARAMETER_ERROR,
      `Missing ${parameters.length} parameter value(s) for this statement.`
    );
  }

  const positional = parameters.filter((token) => token.style === 'positional');
  const named = parameters.filter((token) => token.style === 'named');

  if (positional.length > 0 && named.length > 0) {
    throw new SqlError(
      ErrorCodes.PARAMETER_ERROR,
      'A statement cannot mix positional and named parameters.'
    );
  }

  if (positional.length > 0) {
    if (!Array.isArray(params)) {
      throw new SqlError(
        ErrorCodes.PARAMETER_ERROR,
        'Positional parameters require an array of values.'
      );
    }
    const required = Math.max(...positional.map((token) => token.index));
    if (params.length !== required) {
      throw new SqlError(
        ErrorCodes.PARAMETER_ERROR,
        `Expected ${required} parameter value(s), received ${params.length}.`
      );
    }
    params.forEach((value, index) => assertBindableValue(value, `parameter ${index + 1}`));
    return (token) => params[token.index - 1];
  }

  if (!isNamedParameterBag(params)) {
    throw new SqlError(
      ErrorCodes.PARAMETER_ERROR,
      'Named parameters require an object of values, for example { name: "Ada" }.'
    );
  }

  const values = toObject(params);
  for (const token of named) {
    if (!Object.prototype.hasOwnProperty.call(values, token.name)) {
      throw new SqlError(
        ErrorCodes.PARAMETER_ERROR,
        `Missing value for named parameter ${token.prefix}${token.name}.`
      );
    }
    assertBindableValue(values[token.name], `parameter ${token.prefix}${token.name}`);
  }
  return (token) => values[token.name];
}

function isNamedParameterBag(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toObject(value) {
  if (value instanceof Map) {
    const out = {};
    for (const [key, entry] of value) out[key] = entry;
    return out;
  }
  return value;
}
