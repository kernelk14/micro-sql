import { SqlError, ErrorCodes } from '../errors.js';
import { compareText, formatNumber, parseIntegerText, parseNumericText } from '../values.js';
import { BaseDialect } from './base.js';

const MYSQL_TYPES = {
  TINYINT: 'integer',
  SMALLINT: 'integer',
  MEDIUMINT: 'integer',
  INTEGER: 'integer',
  INT: 'integer',
  BIGINT: 'integer',
  SERIAL: 'integer',
  DECIMAL: 'real',
  NUMERIC: 'real',
  FLOAT: 'real',
  DOUBLE: 'real',
  'DOUBLE PRECISION': 'real',
  REAL: 'real',
  VARCHAR: 'text',
  CHAR: 'text',
  TEXT: 'text',
  TINYTEXT: 'text',
  MEDIUMTEXT: 'text',
  LONGTEXT: 'text',
  BOOLEAN: 'boolean',
  BOOL: 'boolean'
};

/**
 * MySQL-style dialect (implemented subset).
 *
 * Notable behaviours:
 * - backticks quote identifiers; `"` quotes strings (as with MySQL's default
 *   sql_mode, without ANSI_QUOTES); backslash escapes are recognised.
 * - `#` line comments are accepted.
 * - `?` positional and `:name` named parameters.
 * - Lenient value coercion: numbers are truncated for integer columns,
 *   numeric strings are parsed, numbers/booleans can be stored in text columns.
 * - `||` is *not* supported (as in MySQL without PIPES_AS_CONCAT); use CONCAT.
 * - `/` always produces a real; division by zero yields NULL.
 * - LIKE is ASCII case-insensitive.
 * - `LIMIT offset, count` is supported; OFFSET requires LIMIT.
 * - NULLs sort first for ASC, last for DESC; explicit NULLS FIRST/LAST is not
 *   part of the supported syntax.
 */
export class MysqlDialect extends BaseDialect {
  constructor() {
    super({
      name: 'mysql',
      label: 'MySQL (implemented subset)',
      identifierQuotes: [{ open: '`', close: '`' }],
      doubleQuoteStrings: true,
      backslashEscapes: true,
      hashComments: true,
      supportsQuestionParams: true,
      supportsDollarParams: false,
      namedParamPrefixes: [':'],
      types: MYSQL_TYPES,
      likeCaseInsensitive: true,
      integerDivision: false,
      zeroDivisionReturnsNull: true,
      concatOperator: false,
      supportsNullsOrdering: false,
      supportsLimitComma: true,
      supportsOffsetWithoutLimit: false,
      nullsFirstAscending: true,
      booleanStorage: 'integer',
      scalarFunctions: {
        IFNULL: { min: 2, max: 2 },
        CONCAT: { min: 1, max: Infinity },
        CHAR_LENGTH: { min: 1, max: 1 }
      }
    });
  }

  coerceColumnValue(value, column) {
    if (value === null) return null;
    const family = column.type.family;
    const fail = () => {
      throw new SqlError(
        ErrorCodes.TYPE_ERROR,
        `Column "${column.name}" of type ${column.type.name} cannot store ${typeof value} in the mysql dialect.`,
        { columnName: column.name }
      );
    };

    switch (family) {
      case 'integer':
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'number') return Math.trunc(value);
        if (typeof value === 'string') {
          const parsed = parseNumericText(value);
          if (parsed !== null) return Math.trunc(parsed);
        }
        return fail();
      case 'real':
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
          const parsed = parseNumericText(value);
          if (parsed !== null) return parsed;
        }
        return fail();
      case 'text':
        if (typeof value === 'string') return value;
        if (typeof value === 'number') return formatNumber(value);
        if (typeof value === 'boolean') return value ? '1' : '0';
        return fail();
      case 'boolean':
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'number') {
          if (value === 0 || value === 1) return value;
          return fail();
        }
        if (typeof value === 'string') {
          const lowered = value.trim().toLowerCase();
          if (lowered === 'true' || lowered === 't' || lowered === '1') return 1;
          if (lowered === 'false' || lowered === 'f' || lowered === '0') return 0;
          const parsed = parseIntegerText(value);
          if (parsed === 0 || parsed === 1) return parsed;
        }
        return fail();
      default:
        return fail();
    }
  }

  compare(a, b) {
    const left = typeof a === 'boolean' ? (a ? 1 : 0) : a;
    const right = typeof b === 'boolean' ? (b ? 1 : 0) : b;
    if (typeof left === 'number' && typeof right === 'number') {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    if (typeof left === 'string' && typeof right === 'string') return compareText(left, right);
    if (typeof left === 'number' && typeof right === 'string') {
      const numeric = parseNumericText(right);
      return compareNumbers(left, numeric === null ? 0 : numeric);
    }
    if (typeof left === 'string' && typeof right === 'number') {
      const numeric = parseNumericText(left);
      return compareNumbers(numeric === null ? 0 : numeric, right);
    }
    throw new SqlError(ErrorCodes.TYPE_ERROR, 'Cannot compare these values in the mysql dialect.');
  }

  predicate(value) {
    if (value === null) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const parsed = parseNumericText(value);
      return parsed !== null && parsed !== 0;
    }
    return false;
  }

  toNumber(value, operator) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string') {
      const parsed = parseNumericText(value);
      return parsed === null ? 0 : parsed;
    }
    throw new SqlError(
      ErrorCodes.TYPE_ERROR,
      `Operator ${operator} requires numeric operands, received ${String(value)}.`
    );
  }

  toTextForLike(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return formatNumber(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    throw new SqlError(ErrorCodes.TYPE_ERROR, `LIKE requires text, received ${typeof value}.`);
  }

  toText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return formatNumber(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    throw new SqlError(ErrorCodes.TYPE_ERROR, `Cannot convert ${typeof value} to text.`);
  }
}

function compareNumbers(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
