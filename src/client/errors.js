import { SqlError, ErrorCodes } from '../errors.js';

/**
 * Translate driver errors into this library's stable error codes, so code that
 * already handles `SqlError.code` works the same against a live database.
 */

/** PostgreSQL SQLSTATE codes. */
const POSTGRES_CODES = new Map([
  ['23505', ErrorCodes.UNIQUE_CONSTRAINT],
  ['23502', ErrorCodes.NOT_NULL_CONSTRAINT],
  ['42P01', ErrorCodes.MISSING_TABLE],
  ['42703', ErrorCodes.MISSING_COLUMN],
  ['42P07', ErrorCodes.TABLE_EXISTS],
  ['42601', ErrorCodes.SYNTAX_ERROR],
  ['22012', ErrorCodes.DIVISION_BY_ZERO],
  ['22P02', ErrorCodes.TYPE_ERROR],
  ['22003', ErrorCodes.TYPE_ERROR],
  ['42804', ErrorCodes.TYPE_ERROR]
]);

/** MySQL error codes (`error.code`). */
const MYSQL_CODES = new Map([
  ['ER_DUP_ENTRY', ErrorCodes.UNIQUE_CONSTRAINT],
  ['ER_BAD_NULL_ERROR', ErrorCodes.NOT_NULL_CONSTRAINT],
  ['ER_NO_SUCH_TABLE', ErrorCodes.MISSING_TABLE],
  ['ER_BAD_FIELD_ERROR', ErrorCodes.MISSING_COLUMN],
  ['ER_TABLE_EXISTS_ERROR', ErrorCodes.TABLE_EXISTS],
  ['ER_PARSE_ERROR', ErrorCodes.SYNTAX_ERROR],
  ['ER_SYNTAX_ERROR', ErrorCodes.SYNTAX_ERROR],
  ['ER_DIVISION_BY_ZERO', ErrorCodes.DIVISION_BY_ZERO],
  ['ER_TRUNCATED_WRONG_VALUE', ErrorCodes.TYPE_ERROR],
  ['ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', ErrorCodes.TYPE_ERROR],
  ['ER_WRONG_VALUE', ErrorCodes.TYPE_ERROR],
  ['ER_DATA_TOO_LONG', ErrorCodes.TYPE_ERROR]
]);

/** SQLite reports constraints and schema problems by message text. */
const SQLITE_PATTERNS = [
  [/UNIQUE constraint failed/i, ErrorCodes.UNIQUE_CONSTRAINT],
  [/NOT NULL constraint failed/i, ErrorCodes.NOT_NULL_CONSTRAINT],
  [/FOREIGN KEY constraint failed/i, ErrorCodes.UNIQUE_CONSTRAINT],
  [/no such table/i, ErrorCodes.MISSING_TABLE],
  [/no such column/i, ErrorCodes.MISSING_COLUMN],
  [/already exists/i, ErrorCodes.TABLE_EXISTS],
  [/has no column named/i, ErrorCodes.MISSING_COLUMN],
  [/datatype mismatch|cannot store/i, ErrorCodes.TYPE_ERROR],
  [/syntax error|near "/i, ErrorCodes.SYNTAX_ERROR]
];

/**
 * @param {unknown} error driver error
 * @param {string} dialectName
 * @param {string} [sql]
 * @returns {SqlError}
 */
export function mapDriverError(error, dialectName, sql) {
  if (error instanceof SqlError) return error;

  const message = error && error.message ? error.message : String(error);
  let code = ErrorCodes.DRIVER_ERROR;

  if (dialectName === 'postgres' && error && error.code) {
    code = POSTGRES_CODES.get(String(error.code)) || code;
  } else if (dialectName === 'mysql' && error && error.code) {
    code = MYSQL_CODES.get(String(error.code)) || code;
  } else if (dialectName === 'sqlite') {
    for (const [pattern, mapped] of SQLITE_PATTERNS) {
      if (pattern.test(message)) {
        code = mapped;
        break;
      }
    }
  }

  const wrapped = new SqlError(code, message, { sql });
  wrapped.cause = error;
  if (error && typeof error === 'object') {
    if (typeof error.table === 'string') wrapped.table = error.table;
    if (typeof error.column === 'string') wrapped.columnName = error.column;
  }
  return wrapped;
}
