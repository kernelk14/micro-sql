import type { BaseDialect } from './dialects/base.js';
import type { DialectName } from './dialects/index.js';
import type { BindParameters, ExecResult, Row, RunResult, SqlValue } from './types.js';

export type {
  BindParameters,
  ExecResult,
  NamedParameters,
  Row,
  RunResult,
  SqlValue
} from './types.js';
export type { DialectName } from './dialects/index.js';

/** Result a driver returns for one statement. */
export type DriverQueryResult =
  | { rows: Row[]; changes?: number; lastInsertRowid?: number }
  | RunResult;

/**
 * Result of `run()`. Statements with a `RETURNING` clause also report the
 * rows they returned, and an inserted id is picked up from the first one.
 */
export interface ClientRunResult extends RunResult {
  rows?: Row[];
}

/**
 * A driver adapter. Implement this to reuse an existing connection pool or to
 * target a database this package does not ship an adapter for.
 */
export interface ClientDriver {
  query(
    sql: string,
    values: SqlValue[],
    options: { returnsRows: boolean }
  ): DriverQueryResult | Promise<DriverQueryResult>;
  exec(sql: string): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface ConnectOptions {
  /** `'sqlite'` (default), `'postgres'`/`'pg'` or `'mysql'`/`'mariadb'`. */
  dialect?: DialectName | string | BaseDialect;
  /** SQLite database file; defaults to `':memory:'`. */
  filename?: string;
  /** Server URL (`postgres://...`, `mysql://...`). */
  connectionString?: string;
  /** Alias for `connectionString`. */
  url?: string;
  /** Server host; defaults to `localhost`. */
  host?: string;
  /** Server port; defaults to 5432 for PostgreSQL and 3306 for MySQL. */
  port?: number;
  /** Login role or user. */
  user?: string;
  password?: string;
  /** Database to connect to. */
  database?: string;
  /**
   * TLS policy: `'disable'`, `'prefer'`, `'require'` or `'verify-full'`.
   * PostgreSQL defaults to `'prefer'`; MySQL only uses TLS when asked.
   */
  ssl?: boolean | string | Record<string, unknown>;
  sslmode?: string;
  /** Other protocol settings (timeouts, TLS extras, ...). */
  connectionOptions?: Record<string, unknown>;
  /** Use a custom driver instead of the bundled protocol implementation. */
  driver?: ClientDriver;
}

/** Open a connection to a real database. */
export function connect(options?: ConnectOptions): Promise<Client>;

/** A live database connection with the same surface as `Database`. */
export class Client {
  readonly dialect: BaseDialect;
  readonly driver: ClientDriver;

  /** Compile a statement for repeated execution. */
  prepare(sql: string): PreparedStatement;

  /** Run a non-SELECT statement; `RETURNING` rows are included. */
  run(sql: string, params?: BindParameters): Promise<ClientRunResult>;

  /** Run a SELECT and return every row. */
  all(sql: string, params?: BindParameters): Promise<Row[]>;

  /** Run a SELECT and return the first row, or undefined. */
  get(sql: string, params?: BindParameters): Promise<Row | undefined>;

  /** Run one or more semicolon-separated statements. */
  exec(sql: string, params?: BindParameters): Promise<ExecResult[]>;

  /** Run a function inside a transaction; errors roll back. */
  transaction<T>(fn: (client: Client) => T | Promise<T>): Promise<T>;

  /** Close the connection. Safe to call more than once. */
  close(): Promise<void>;
}

/** A statement prepared against a live connection. */
export class PreparedStatement {
  constructor(client: Client, sql: string);

  readonly client: Client;
  readonly sql: string;
  readonly dialect: BaseDialect;

  run(params?: BindParameters): Promise<ClientRunResult>;
  all(params?: BindParameters): Promise<Row[]>;
  get(params?: BindParameters): Promise<Row | undefined>;
}
