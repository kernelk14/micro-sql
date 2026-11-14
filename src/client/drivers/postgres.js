import { SqlError, ErrorCodes } from '../../errors.js';

/**
 * PostgreSQL driver backed by the optional `pg` package.
 *
 * ```js
 * const driver = await createPostgresDriver({
 *   connectionString: 'postgres://user:pass@localhost:5432/app'
 * });
 * ```
 *
 * Extra driver settings can be passed through `connectionOptions` (TLS,
 * `statement_timeout`, pool-free single connection options, and so on).
 *
 * @param {{ connectionString?: string, url?: string, connectionOptions?: object }} [options]
 */
export async function createPostgresDriver(options = {}) {
  const module = await loadPg();
  const Client = module.Client ?? module.default?.Client;
  if (typeof Client !== 'function') {
    throw new SqlError(
      ErrorCodes.DRIVER_ERROR,
      'The "pg" package did not expose a Client constructor.'
    );
  }

  const config = { ...(options.connectionOptions || {}) };
  const connectionString = options.connectionString ?? options.url;
  if (connectionString) config.connectionString = connectionString;

  const client = new Client(config);
  try {
    await client.connect();
  } catch (error) {
    throw new SqlError(
      ErrorCodes.DRIVER_ERROR,
      `Could not connect to PostgreSQL: ${error && error.message ? error.message : error}`
    );
  }

  return {
    name: 'postgres',
    async query(sql, values, { returnsRows }) {
      const result = await client.query({ text: sql, values });
      const returnsResultSet = returnsRows || (result.fields && result.fields.length > 0);
      // RETURNING statements report both the rows and the affected row count.
      if (returnsResultSet) {
        return { rows: result.rows || [], changes: result.rowCount ?? undefined };
      }
      return { changes: result.rowCount ?? 0, lastInsertRowid: 0 };
    },
    async exec(sql) {
      await client.query(sql);
    },
    async close() {
      await client.end();
    }
  };
}

async function loadPg() {
  try {
    return await import('pg');
  } catch {
    throw new SqlError(
      ErrorCodes.DRIVER_ERROR,
      'The "postgres" dialect requires the optional "pg" package. Install it with: npm install pg'
    );
  }
}
