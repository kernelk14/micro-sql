import { SqlError, ErrorCodes } from '../../errors.js';
import { createSqliteDriver } from './sqlite.js';
import { createPostgresDriver } from './postgres.js';
import { createMysqlDriver } from './mysql.js';

/**
 * Create the driver for a dialect.
 *
 * A custom driver can be supplied as `options.driver`; it only has to
 * implement `query(sql, values, { returnsRows })`, `exec(sql)` and `close()`.
 * That makes it possible to reuse an existing connection pool or to test
 * against a server this library does not ship an adapter for.
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
      return createPostgresDriver(options);
    case 'mysql':
      return createMysqlDriver(options);
    default:
      throw new SqlError(
        ErrorCodes.DRIVER_ERROR,
        `No driver is available for the "${dialectName}" dialect.`
      );
  }
}
