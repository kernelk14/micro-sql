import { SqlError, ErrorCodes } from '../../errors.js';
import { createSqliteDriver } from './sqlite.js';
import { createPostgresConnection } from '../protocols/postgres.js';
import { createMysqlConnection } from '../protocols/mysql.js';

/**
 * Create the connection for a dialect.
 *
 * PostgreSQL and MySQL use this package's own implementations of their wire
 * protocols; SQLite is read and written through Node's built-in `node:sqlite`
 * binding because it is an embedded file format rather than a network
 * protocol.
 *
 * A custom driver can be supplied as `options.driver`; it only has to
 * implement `query(sql, values, { returnsRows })`, `exec(sql)` and `close()`.
 * That makes it possible to reuse an existing connection pool or to test
 * against a server this library does not ship a protocol for.
 *
 * @param {string} dialectName
 * @param {object} options
 */
export async function createDriver(dialectName, options = {}) {
  if (options.driver) {
    const driver = options.driver;
    if (typeof driver.query !== 'function' || typeof driver.exec !== 'function') {
      throw new SqlError(
        ErrorCodes.INVALID_QUERY,
        'A custom driver must provide query(), exec() and close() functions.'
      );
    }
    return driver;
  }

  switch (dialectName) {
    case 'sqlite':
      return createSqliteDriver(options);
    case 'postgres':
      return createPostgresConnection(options);
    case 'mysql':
      return createMysqlConnection(options);
    default:
      throw new SqlError(
        ErrorCodes.DRIVER_ERROR,
        `No protocol is implemented for the "${dialectName}" dialect.`
      );
  }
}
