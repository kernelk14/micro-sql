import { SqlError, ErrorCodes } from './errors.js';
import { Database } from './index.js';

const FORMAT_VERSION = 1;

/**
 * JSON persistence adapter.
 *
 * An embedded database can be saved and restored as plain JSON, which makes it
 * usable for browser storage (localStorage/IndexedDB), fixtures and tests.
 *
 * ```js
 * import { toJSON, fromJSON } from 'micro-sql/adapter';
 * const saved = JSON.stringify(toJSON(db));
 * const restored = fromJSON(JSON.parse(saved));
 * ```
 *
 * The snapshot uses only the public SQL surface, so it stays valid across
 * versions of the engine.
 */

/**
 * Serialize a database to a JSON-safe snapshot.
 * @param {Database} database
 * @returns {{ version: number, dialect: string, tables: object[] }}
 */
export function toJSON(database) {
  if (!(database instanceof Database)) {
    throw new SqlError(ErrorCodes.ADAPTER_ERROR, 'toJSON() expects a Database instance.');
  }
  const tables = [];
  for (const table of database.engine.tables.values()) {
    tables.push({
      name: table.name,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type.name,
        args: column.type.args.slice(),
        notNull: column.notNull,
        primaryKey: column.primaryKey,
        unique: column.unique,
        autoIncrement: column.autoIncrement,
        defaultValue: column.defaultValue === undefined ? null : column.defaultValue
      })),
      primaryKey: table.primaryKey.slice(),
      uniques: table.uniques.map((entry) => entry.slice()),
      rows: table.rows.map((row) => ({ ...row }))
    });
  }
  return { version: FORMAT_VERSION, dialect: database.dialect.name, tables };
}

/**
 * Rebuild a database from a snapshot produced by `toJSON`.
 * @param {object} snapshot
 * @param {{ dialect?: string }} [options] override the recorded dialect
 * @returns {Database}
 */
export function fromJSON(snapshot, options = {}) {
  const data = typeof snapshot === 'string' ? safeParse(snapshot) : snapshot;
  if (!data || typeof data !== 'object') {
    throw new SqlError(ErrorCodes.ADAPTER_ERROR, 'Invalid database snapshot.');
  }
  if (data.version !== FORMAT_VERSION) {
    throw new SqlError(
      ErrorCodes.ADAPTER_ERROR,
      `Unsupported snapshot version ${data.version}; expected ${FORMAT_VERSION}.`
    );
  }
  if (!Array.isArray(data.tables)) {
    throw new SqlError(ErrorCodes.ADAPTER_ERROR, 'Snapshot is missing a "tables" array.');
  }

  const database = new Database({ dialect: options.dialect || data.dialect });
  const dialect = database.dialect;

  for (const table of data.tables) {
    const columnSql = table.columns.map((column) => {
      const type = dialect.resolveType(column.type, column.args || []);
      let sql = `${dialect.quoteIdentifier(column.name)} ${type.name}`;
      if (column.args && column.args.length > 0) sql += `(${column.args.join(', ')})`;
      if (column.primaryKey) sql += ' PRIMARY KEY';
      if (column.autoIncrement && !column.primaryKey) {
        const keyword = dialect.autoIncrementKeywords[0];
        if (keyword) sql += ` ${keyword}`;
      } else if (column.autoIncrement && column.primaryKey) {
        const keyword = dialect.autoIncrementKeywords[0];
        if (keyword) sql += ` ${keyword}`;
      }
      if (column.notNull && !column.primaryKey) sql += ' NOT NULL';
      if (column.unique && !column.primaryKey) sql += ' UNIQUE';
      if (column.defaultValue !== null && column.defaultValue !== undefined) {
        sql += ` DEFAULT ${dialect.formatLiteral(column.defaultValue)}`;
      }
      return sql;
    });

    const constraints = [];
    // A single-column primary key is already declared on the column above.
    if ((table.primaryKey || []).length > 1) {
      const names = table.primaryKey.map((name) => dialect.quoteIdentifier(name)).join(', ');
      constraints.push(`PRIMARY KEY (${names})`);
    }
    for (const unique of table.uniques || []) {
      constraints.push(`UNIQUE (${unique.map((name) => dialect.quoteIdentifier(name)).join(', ')})`);
    }

    const definitions = [...columnSql, ...constraints].join(', ');
    database.run(`CREATE TABLE ${dialect.quoteIdentifier(table.name)} (${definitions})`);

    if (Array.isArray(table.rows) && table.rows.length > 0) {
      const names = table.columns.map((column) => dialect.quoteIdentifier(column.name)).join(', ');
      const placeholders = table.columns.map(() => '?').join(', ');
      const columns = table.columns.map((column) => column.name);
      for (const row of table.rows) {
        const values = columns.map((name) => {
          const value = row[name] ?? row[name.toLowerCase()] ?? null;
          return value;
        });
        database.run(
          `INSERT INTO ${dialect.quoteIdentifier(table.name)} (${names}) VALUES (${placeholders})`,
          values
        );
      }
    }
  }

  return database;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SqlError(ErrorCodes.ADAPTER_ERROR, `Snapshot is not valid JSON: ${error.message}`);
  }
}
