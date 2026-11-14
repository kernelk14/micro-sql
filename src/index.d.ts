import type { BaseDialect } from './dialects/base.js';
import type { DialectName } from './dialects/index.js';
import type {
  BindParameters,
  ExecResult,
  ParameterToken,
  Row,
  RunResult,
  SqlValue
} from './types.js';

export type {
  BindParameters,
  ExecResult,
  NamedParameters,
  ParameterToken,
  Row,
  RunResult,
  SqlValue
} from './types.js';
export type {
  BaseDialectOptions,
  ColumnTypeInfo,
  DialectName,
  ResolvedType,
  TypeFamily
} from './dialects/index.js';
export {
  BaseDialect,
  MysqlDialect,
  PostgresDialect,
  SqliteDialect,
  getDialect,
  listDialects
} from './dialects/index.js';

export interface DatabaseOptions {
  /** Built-in dialect name or a custom dialect instance. Defaults to 'sqlite'. */
  dialect?: DialectName | BaseDialect;
}

export interface SqlErrorDetails {
  sql?: string;
  position?: number;
  line?: number;
  column?: number;
  table?: string;
  columnName?: string;
}

/** Error type raised for every failure in this library. */
export class SqlError extends Error {
  constructor(code: ErrorCode | string, message: string, details?: SqlErrorDetails);
  code: ErrorCode;
  sql?: string;
  position?: number;
  line?: number;
  column?: number;
  table?: string;
  columnName?: string;
}

/** Stable machine-readable error codes. */
export const ErrorCodes: {
  readonly SYNTAX_ERROR: 'SYNTAX_ERROR';
  readonly UNSUPPORTED: 'UNSUPPORTED';
  readonly INVALID_QUERY: 'INVALID_QUERY';
  readonly MISSING_TABLE: 'MISSING_TABLE';
  readonly TABLE_EXISTS: 'TABLE_EXISTS';
  readonly MISSING_COLUMN: 'MISSING_COLUMN';
  readonly DUPLICATE_COLUMN: 'DUPLICATE_COLUMN';
  readonly TYPE_ERROR: 'TYPE_ERROR';
  readonly UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE';
  readonly NOT_NULL_CONSTRAINT: 'NOT_NULL_CONSTRAINT';
  readonly UNIQUE_CONSTRAINT: 'UNIQUE_CONSTRAINT';
  readonly PARAMETER_ERROR: 'PARAMETER_ERROR';
  readonly DIVISION_BY_ZERO: 'DIVISION_BY_ZERO';
  readonly ADAPTER_ERROR: 'ADAPTER_ERROR';
  readonly DRIVER_ERROR: 'DRIVER_ERROR';
};

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** An embedded SQL database with an in-memory store. */
export class Database {
  constructor(options?: DatabaseOptions);

  readonly dialect: BaseDialect;

  /** Compile a single statement once and execute it many times. */
  prepare(sql: string): Statement;

  /** Run a non-SELECT statement. */
  run(sql: string, params?: BindParameters): RunResult;

  /** Run a SELECT and return every row. */
  all(sql: string, params?: BindParameters): Row[];

  /** Run a SELECT and return the first row, or undefined. */
  get(sql: string, params?: BindParameters): Row | undefined;

  /** Run one or more semicolon-separated statements. */
  exec(sql: string, params?: BindParameters): ExecResult[];
}

/** A single compiled SQL statement. */
export class Statement {
  constructor(database: Database, sql: string);

  readonly database: Database;
  readonly sql: string;
  readonly dialect: BaseDialect;
  readonly ast: unknown;
  readonly parameters: ParameterToken[];

  run(params?: BindParameters): RunResult;
  all(params?: BindParameters): Row[];
  get(params?: BindParameters): Row | undefined;
}

/** Build a function that resolves a parameter token to a bound value. */
export function createBinder(
  parameters: readonly ParameterToken[],
  params?: BindParameters
): (token: ParameterToken) => SqlValue;
