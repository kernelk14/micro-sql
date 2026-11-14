import { SqlError, ErrorCodes } from '../../errors.js';

/**
 * SQLite driver.
 *
 * Node's built-in `node:sqlite` module is preferred (Node 22.5+, no
 * dependency). When it is unavailable the optional `better-sqlite3` package is
 * used instead.
 *
 * ```js
 * const driver = await createSqliteDriver({ filename: './app.db' });
 * ```
 *
 * @param {{ filename?: string, connectionString?: string, url?: string, connectionOptions?: object }} [options]
 */
export async function createSqliteDriver(options = {}) {
  const filename =
    options.filename ?? options.connectionString ?? options.url ?? ':memory:';
  const connectionOptions = { ...(options.connectionOptions || {}) };
  const backend = await loadSqlite();

  if (backend.kind === 'node') {
    const database = new backend.DatabaseSync(filename, connectionOptions);
    return {
      name: 'sqlite',
      async query(sql, values, { returnsRows }) {
        const statement = database.prepare(sql);
        if (returnsRows) return { rows: statement.all(...values) };
        const result = statement.run(...values);
        return {
          changes: Number(result.changes ?? 0),
          lastInsertRowid: Number(result.lastInsertRowid ?? 0)
        };
      },
      async exec(sql) {
        database.exec(sql);
      },
      async close() {
        database.close();
      }
    };
  }

  const database = new backend.Database(filename, connectionOptions);
  return {
    name: 'sqlite',
    async query(sql, values, { returnsRows }) {
      const statement = database.prepare(sql);
      if (returnsRows) return { rows: statement.all(...values) };
      const result = statement.run(...values);
      return {
        changes: Number(result.changes ?? 0),
        lastInsertRowid: Number(result.lastInsertRowid ?? 0)
      };
    },
    async exec(sql) {
      database.exec(sql);
    },
    async close() {
      database.close();
    }
  };
}

async function loadSqlite() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return { kind: 'node', DatabaseSync };
  } catch {
    // Older Node versions do not ship node:sqlite; fall back to the add-on.
  }

  try {
    const module = await import('better-sqlite3');
    const Database = module.default ?? module;
    return { kind: 'better-sqlite3', Database };
  } catch {
    throw new SqlError(
      ErrorCodes.DRIVER_ERROR,
      'No SQLite driver is available. Use Node 22.5+ (which ships node:sqlite) or install the optional "better-sqlite3" package.'
    );
  }
}
