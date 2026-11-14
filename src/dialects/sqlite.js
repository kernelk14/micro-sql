import { SqlError, ErrorCodes } from '../errors.js';
import { compareText, formatNumber, parseNumericText } from '../values.js';
import { BaseDialect } from './base.js';

/**
 * SQLite-style dialect (implemented subset).
 *
 * Notable behaviours:
 * - double quotes quote identifiers; single quotes quote strings; no backslash
 *   escapes inside strings.
 * - `?`, `:name`, `@name` and `$name` parameters.
 * - `==` is accepted as `=`.
 * - declared types use SQLite affinity rules; INTEGER/REAL/NUMERIC affinity
 *   columns store numeric-looking text as numbers but keep other text as text
 *   (dynamic typing). BLOB is not supported.
 * - `INTEGER PRIMARY KEY AUTOINCREMENT` is supported.
 * - LIKE is ASCII case-insensitive.
 * - integer / integer truncates; division by zero yields NULL.
 * - `||` concatenates text.
 * - NULLs sort first for ASC, last for DESC.
 */
export class SqliteDialect extends BaseDialect {
  constructor() {
    super({
      name: 'sqlite',
      label: 'SQLite (implemented subset)',
      extraKeywords: ['AUTOINCREMENT'],
      identifierQuotes: [{ open: '"', close: '"' }],
      supportsQuestionParams: true,
      supportsDollarParams: false,
      namedParamPrefixes: [':', '@', '$'],
      supportsDoubleEquals: true,
      likeCaseInsensitive: true,
      integerDivision: true,
      zeroDivisionReturnsNull: true,
      concatOperator: true,
      supportsNullsOrdering: true,
      supportsLimitComma: true,
      supportsOffsetWithoutLimit: true,
      nullsFirstAscending: true,
      booleanStorage: 'integer',
      autoIncrementKeywords: ['AUTOINCREMENT'],
      implicitRowid: true,
      scalarFunctions: {
        IFNULL: { min: 2, max: 2 },
        TYPEOF: { min: 1, max: 1 }
      }
    });
  }

  /**
   * SQLite matches declared types by affinity, so arbitrary type names are
   * accepted. BLOB affinity is rejected because this engine has no blob values.
   */
  resolveType(rawName, args = []) {
    const key = String(rawName).trim().toUpperCase().replace(/\s+/g, ' ');
    if (key === 'BOOLEAN' || key === 'BOOL') {
      return { name: key, family: 'boolean', args: args.slice(), autoincrement: false };
    }
    if (key.includes('BLOB')) {
      throw new SqlError(
        ErrorCodes.UNSUPPORTED_TYPE,
        'BLOB columns are not supported by this engine. Use TEXT, INTEGER, REAL or BOOLEAN.'
      );
    }
    let family;
    if (key.includes('INT')) family = 'integer';
    else if (key.includes('CHAR') || key.includes('CLOB') || key.includes('TEXT')) family = 'text';
    else if (key.includes('REAL') || key.includes('FLOA') || key.includes('DOUB')) family = 'real';
    else family = 'real'; // NUMERIC affinity
    return { name: key, family, args: args.slice(), autoincrement: false };
  }

  coerceColumnValue(value, column) {
    if (value === null) return null;
    const family = column.type.family;
    const fail = () => {
      throw new SqlError(
        ErrorCodes.TYPE_ERROR,
        `Column "${column.name}" of type ${column.type.name} cannot store ${typeof value} in the sqlite dialect.`,
        { columnName: column.name }
      );
    };

    if (family === 'boolean') {
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (typeof value === 'number' && (value === 0 || value === 1)) return value;
      if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (lowered === 'true' || lowered === 't' || lowered === '1') return 1;
        if (lowered === 'false' || lowered === 'f' || lowered === '0') return 0;
      }
      return fail();
    }

    if (family === 'text') {
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return formatNumber(value);
      if (typeof value === 'boolean') return value ? '1' : '0';
      return fail();
    }

    // INTEGER / REAL / NUMERIC affinity.
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = parseNumericText(value);
      // Numeric text is converted; other text is kept as text (dynamic typing).
      return parsed === null ? value : parsed;
    }
    return fail();
  }

  compare(a, b) {
    const left = typeof a === 'boolean' ? (a ? 1 : 0) : a;
    const right = typeof b === 'boolean' ? (b ? 1 : 0) : b;
    if (typeof left === 'number' && typeof right === 'number') {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    if (typeof left === 'string' && typeof right === 'string') return compareText(left, right);
    // SQLite orders storage classes: numbers before text.
    const rank = (value) => (typeof value === 'number' ? 0 : 1);
    return rank(left) - rank(right);
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
      if (parsed !== null) return parsed;
      return 0; // SQLite converts non-numeric text to 0 in arithmetic.
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
