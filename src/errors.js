/**
 * Error type used for every failure raised by this library.
 *
 * Every error has a stable machine-readable `code` and, when available,
 * the source location of the token that caused it.
 */
export class SqlError extends Error {
  /**
   * @param {string} code stable error code (see ErrorCodes)
   * @param {string} message human readable message
   * @param {{ sql?: string, position?: number, line?: number, column?: number, table?: string, columnName?: string }} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SqlError';
    this.code = code;
    if (details.sql !== undefined) this.sql = details.sql;
    if (details.position !== undefined) this.position = details.position;
    if (details.line !== undefined) this.line = details.line;
    if (details.column !== undefined) this.column = details.column;
    if (details.table !== undefined) this.table = details.table;
    if (details.columnName !== undefined) this.columnName = details.columnName;
    if (Error.captureStackTrace) Error.captureStackTrace(this, SqlError);
  }
}

/** Stable error codes exposed by the library. */
export const ErrorCodes = Object.freeze({
  SYNTAX_ERROR: 'SYNTAX_ERROR',
  UNSUPPORTED: 'UNSUPPORTED',
  INVALID_QUERY: 'INVALID_QUERY',
  MISSING_TABLE: 'MISSING_TABLE',
  TABLE_EXISTS: 'TABLE_EXISTS',
  MISSING_COLUMN: 'MISSING_COLUMN',
  DUPLICATE_COLUMN: 'DUPLICATE_COLUMN',
  TYPE_ERROR: 'TYPE_ERROR',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  NOT_NULL_CONSTRAINT: 'NOT_NULL_CONSTRAINT',
  UNIQUE_CONSTRAINT: 'UNIQUE_CONSTRAINT',
  PARAMETER_ERROR: 'PARAMETER_ERROR',
  DIVISION_BY_ZERO: 'DIVISION_BY_ZERO',
  ADAPTER_ERROR: 'ADAPTER_ERROR'
});

/**
 * Build a syntax error that points at a token.
 * @param {string} message
 * @param {import('./tokenizer.js').Token} token
 * @param {string} [sql]
 */
export function syntaxError(message, token, sql) {
  const line = token && token.line ? token.line : undefined;
  const column = token && token.column ? token.column : undefined;
  const where = line !== undefined ? ` (line ${line}, column ${column})` : '';
  return new SqlError(ErrorCodes.SYNTAX_ERROR, `${message}${where}`, {
    sql,
    position: token ? token.start : undefined,
    line,
    column
  });
}

/**
 * Build an "unsupported by this dialect / by this library" error.
 * @param {string} message
 * @param {object} [details]
 */
export function unsupported(message, details) {
  return new SqlError(ErrorCodes.UNSUPPORTED, message, details);
}
