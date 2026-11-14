import { SqlError, ErrorCodes } from '../errors.js';
import { BaseDialect } from './base.js';
import { SqliteDialect } from './sqlite.js';
import { PostgresDialect } from './postgres.js';
import { MysqlDialect } from './mysql.js';

const FACTORIES = {
  sqlite: () => new SqliteDialect(),
  postgres: () => new PostgresDialect(),
  postgresql: () => new PostgresDialect(),
  pg: () => new PostgresDialect(),
  mysql: () => new MysqlDialect(),
  mariadb: () => new MysqlDialect()
};

const instances = new Map();

/**
 * Resolve a dialect from a name or pass through a Dialect instance.
 * @param {string|BaseDialect} [spec]
 * @returns {BaseDialect}
 */
export function getDialect(spec = 'sqlite') {
  if (spec instanceof BaseDialect) return spec;
  if (typeof spec !== 'string') {
    throw new SqlError(
      ErrorCodes.INVALID_QUERY,
      'dialect must be a string ("sqlite", "postgres", "mysql") or a BaseDialect instance.'
    );
  }
  const key = spec.trim().toLowerCase();
  const factory = FACTORIES[key];
  if (!factory) {
    throw new SqlError(
      ErrorCodes.UNSUPPORTED,
      `Unknown dialect "${spec}". Available dialects: sqlite, postgres, mysql.`
    );
  }
  if (!instances.has(key)) instances.set(key, factory());
  return instances.get(key);
}

/** Names accepted by `getDialect`. */
export function listDialects() {
  return ['sqlite', 'postgres', 'mysql'];
}

export { BaseDialect, SqliteDialect, PostgresDialect, MysqlDialect };
