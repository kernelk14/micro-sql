import { SqlError, ErrorCodes } from '../../errors.js';

/**
 * MySQL / MariaDB driver backed by the optional `mysql2` package.
 *
 * ```js
 * const driver = await createMysqlDriver({
 *   connectionString: 'mysql://user:pass@localhost:3306/app'
 * });
 * ```
 *
 * @param {{ connectionString?: string, url?: string, connectionOptions?: object }} [options]
 */
export async function createMysqlDriver(options = {}) {
  const module = await loadMysql();
  const mysql = module.default ?? module;
  if (!mysql || typeof mysql.createConnection !== 'function') {
    throw new SqlError(
      ErrorCodes.DRIVER_ERROR,
      'The "mysql2/promise" package did not expose createConnection().'
    );
  }

  const config = { ...(options.connectionOptions || {}) };
  const connectionString = options.connectionString ?? options.url;
  if (connectionString) config.uri = connectionString;

  let connection;
  try {
    connection = await mysql.createConnection(config);
  } catch (error) {
    throw new SqlError(
      ErrorCodes.DRIVER_ERROR,
      `Could not connect to MySQL: ${error && error.message ? error.message : error}`
    );
  }

  return {
    name: 'mysql',
    async query(sql, values, { returnsRows }) {
      const [result] = await connection.query(sql, values);
      if (Array.isArray(result)) return { rows: result };
      if (returnsRows) return { rows: [] };
      return {
        changes: Number(result.affectedRows ?? 0),
        lastInsertRowid: Number(result.insertId ?? 0)
      };
    },
    async exec(sql) {
      await connection.query(sql);
    },
    async close() {
      await connection.end();
    }
  };
}

async function loadMysql() {
  try {
    return await import('mysql2/promise');
  } catch {
    throw new SqlError(
      ErrorCodes.DRIVER_ERROR,
      'The "mysql" dialect requires the optional "mysql2" package. Install it with: npm install mysql2'
    );
  }
}
