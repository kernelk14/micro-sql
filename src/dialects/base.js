import { SqlError, ErrorCodes } from '../errors.js';
import {
  assertBindableValue,
  compareText,
  formatNumber,
  parseIntegerText,
  parseNumericText,
  sqlTypeOf
} from '../values.js';

/**
 * Shared grammar keywords. Dialects may add words but the parser needs at
 * least these. Type names are *not* keywords; they are parsed as identifiers.
 */
const BASE_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC',
  'LIMIT', 'OFFSET', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN',
  'AS', 'DISTINCT', 'ALL', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'TABLE', 'DROP', 'IF', 'EXISTS', 'PRIMARY', 'KEY', 'UNIQUE', 'DEFAULT',
  'TRUE', 'FALSE', 'NULLS', 'FIRST', 'LAST', 'PRECISION', 'VARYING',
  'JOIN', 'INNER', 'LEFT', 'OUTER', 'RIGHT', 'FULL', 'CROSS', 'ON', 'USING',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION'
];

const BASE_TYPES = {
  INTEGER: 'integer',
  INT: 'integer',
  BIGINT: 'integer',
  SMALLINT: 'integer',
  TINYINT: 'integer',
  MEDIUMINT: 'integer',
  REAL: 'real',
  DOUBLE: 'real',
  'DOUBLE PRECISION': 'real',
  FLOAT: 'real',
  NUMERIC: 'real',
  DECIMAL: 'real',
  TEXT: 'text',
  VARCHAR: 'text',
  CHAR: 'text',
  'CHARACTER VARYING': 'text',
  CLOB: 'text',
  BOOLEAN: 'boolean',
  BOOL: 'boolean'
};

/**
 * A SQL dialect profile.
 *
 * A dialect owns lexical rules, quoting, literal formatting, type names,
 * type coercion, comparison semantics and a few syntax feature switches.
 * The tokenizer, parser and engine are shared and read these settings.
 *
 * This class is usable directly for custom dialects; the built-in profiles
 * for SQLite, PostgreSQL and MySQL extend it.
 */
export class BaseDialect {
  /** @param {object} [options] */
  constructor(options = {}) {
    /** @type {string} stable dialect name used by `new Database({ dialect })` */
    this.name = options.name || 'custom';
    /** @type {string} human readable description */
    this.label = options.label || 'Custom SQL dialect';

    /** @type {Set<string>} */
    this.reservedKeywords = new Set([...BASE_KEYWORDS, ...(options.extraKeywords || [])]);

    /** @type {{open: string, close: string}[]} accepted identifier quote pairs */
    this.identifierQuotes = options.identifierQuotes || [{ open: '"', close: '"' }];
    /** MySQL style: `"` is a string delimiter, not an identifier quote. */
    this.doubleQuoteStrings = Boolean(options.doubleQuoteStrings);
    /** Support backslash escapes inside string literals. */
    this.backslashEscapes = Boolean(options.backslashEscapes);
    /** Support `#` line comments. */
    this.hashComments = Boolean(options.hashComments);

    /** `?` placeholders. */
    this.supportsQuestionParams = options.supportsQuestionParams !== false;
    /** `$1` placeholders (1-based). */
    this.supportsDollarParams = Boolean(options.supportsDollarParams);
    /** Prefixes for named placeholders such as `:name`. */
    this.namedParamPrefixes = options.namedParamPrefixes || [':'];
    /** SQLite's `==` alias for `=`. */
    this.supportsDoubleEquals = Boolean(options.supportsDoubleEquals);

    /** @type {Record<string, 'integer'|'real'|'text'|'boolean'>} */
    this.typeFamilies = { ...BASE_TYPES, ...(options.types || {}) };
    /** Types that are integer plus auto-incrementing (PostgreSQL SERIAL). */
    this.autoIncrementTypes = new Set(options.autoIncrementTypes || []);
    /** Column attribute words accepted by CREATE TABLE. */
    this.autoIncrementKeywords = options.autoIncrementKeywords || [];
    /** A single-column INTEGER PRIMARY KEY assigns rowids automatically. */
    this.implicitRowid = Boolean(options.implicitRowid);

    /** `like` matching ignores ASCII case. */
    this.likeCaseInsensitive = Boolean(options.likeCaseInsensitive);
    /** `a / b` with integer operands truncates instead of producing a real. */
    this.integerDivision = options.integerDivision !== false;
    /** Division/modulo by zero yields NULL instead of an error. */
    this.zeroDivisionReturnsNull = options.zeroDivisionReturnsNull !== false;
    /** `||` is string concatenation. */
    this.concatOperator = options.concatOperator !== false;
    /** Whether explicit `NULLS FIRST/LAST` is accepted. */
    this.supportsNullsOrdering = options.supportsNullsOrdering !== false;
    /** `LIMIT offset, count` accepted. */
    this.supportsLimitComma = Boolean(options.supportsLimitComma);
    /** `OFFSET` may appear without `LIMIT`. */
    this.supportsOffsetWithoutLimit = options.supportsOffsetWithoutLimit !== false;
    /** NULLs sort first for ASC and last for DESC (SQLite/MySQL ordering). */
    this.nullsFirstAscending = Boolean(options.nullsFirstAscending);
    /** Storage representation of BOOLEAN columns. */
    this.booleanStorage = options.booleanStorage || 'boolean';

    /** @type {Map<string, {min: number, max: number}>} */
    this.scalarFunctions = new Map(Object.entries({
      ABS: { min: 1, max: 1 },
      LOWER: { min: 1, max: 1 },
      UPPER: { min: 1, max: 1 },
      LENGTH: { min: 1, max: 1 },
      COALESCE: { min: 1, max: Infinity },
      ROUND: { min: 1, max: 2 },
      ...(options.scalarFunctions || {})
    }));
    /** @type {Set<string>} */
    this.aggregateFunctions = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
  }

  /** @param {string} word */
  isKeyword(word) {
    return this.reservedKeywords.has(word.toUpperCase());
  }

  /**
   * Quote an identifier with this dialect's primary quote character.
   * @param {string} name
   */
  quoteIdentifier(name) {
    const quote = this.identifierQuotes[0];
    if (!quote) throw new SqlError(ErrorCodes.UNSUPPORTED, `Dialect "${this.name}" defines no identifier quote.`);
    const escaped = String(name).split(quote.close).join(quote.close + quote.close);
    return quote.open + escaped + quote.close;
  }

  /**
   * Format a string literal for generated SQL.
   * @param {string} value
   */
  formatStringLiteral(value) {
    let out = '';
    for (const ch of value) {
      if (ch === "'") out += "''";
      else if (ch === '\\' && this.backslashEscapes) out += '\\\\';
      else if (ch === '\n') out += this.backslashEscapes ? '\\n' : '\n';
      else if (ch === '\r') out += this.backslashEscapes ? '\\r' : '\r';
      else out += ch;
    }
    return `'${out}'`;
  }

  /**
   * Format a runtime value as SQL source.
   * @param {null|number|string|boolean} value
   */
  formatLiteral(value) {
    if (value === null) return 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') return formatNumber(value);
    if (typeof value === 'string') return this.formatStringLiteral(value);
    throw new SqlError(ErrorCodes.TYPE_ERROR, `Cannot format SQL literal for value of type ${typeof value}.`);
  }

  /**
   * Resolve a declared type name to a canonical type record.
   * @param {string} rawName
   * @param {number[]} [args]
   * @returns {{name: string, family: 'integer'|'real'|'text'|'boolean', args: number[], autoincrement: boolean}}
   */
  resolveType(rawName, args = []) {
    const key = String(rawName).trim().toUpperCase().replace(/\s+/g, ' ');
    const family = this.typeFamilies[key];
    if (!family) {
      throw new SqlError(
        ErrorCodes.UNSUPPORTED_TYPE,
        `Type "${rawName}" is not supported by the ${this.name} dialect. Supported types: ${Object.keys(this.typeFamilies).join(', ')}.`
      );
    }
    return {
      name: key,
      family,
      args: args.slice(),
      autoincrement: this.autoIncrementTypes.has(key)
    };
  }

  /**
   * Convert a JavaScript value to the value stored in a column, applying
   * this dialect's documented coercion rules. NULL passes through.
   * @param {null|number|string|boolean} value
   * @param {{name: string, type: {name: string, family: string}}} column
   * @returns {null|number|string|boolean}
   */
  coerceColumnValue(value, column) {
    if (value === null) return null;
    const family = column.type.family;
    const fail = () => {
      throw new SqlError(
        ErrorCodes.TYPE_ERROR,
        `Column "${column.name}" of type ${column.type.name} cannot store ${describeValue(value)} in the ${this.name} dialect.`,
        { columnName: column.name }
      );
    };
    switch (family) {
      case 'integer':
        if (typeof value === 'number' && Number.isInteger(value)) return value;
        if (typeof value === 'string') {
          const parsed = parseIntegerText(value);
          if (parsed !== null) return parsed;
        }
        return fail();
      case 'real':
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string') {
          const parsed = parseNumericText(value);
          if (parsed !== null) return parsed;
        }
        return fail();
      case 'text':
        if (typeof value === 'string') return value;
        return fail();
      case 'boolean':
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
          const lowered = value.trim().toLowerCase();
          if (lowered === 'true' || lowered === 't' || lowered === '1') return true;
          if (lowered === 'false' || lowered === 'f' || lowered === '0') return false;
        }
        return fail();
      default:
        return fail();
    }
  }

  /**
   * Compare two non-NULL runtime values.
   * @param {number|string|boolean} a
   * @param {number|string|boolean} b
   * @returns {number} negative, zero or positive
   */
  compare(a, b) {
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
      throw new SqlError(
        ErrorCodes.TYPE_ERROR,
        `Cannot compare ${sqlTypeOf(a)} with ${sqlTypeOf(b)} in the ${this.name} dialect.`
      );
    }
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'string' && typeof b === 'string') return compareText(a, b);
    throw new SqlError(
      ErrorCodes.TYPE_ERROR,
      `Cannot compare ${sqlTypeOf(a)} with ${sqlTypeOf(b)} in the ${this.name} dialect.`
    );
  }

  /** Check that a value can be used as a predicate (WHERE/HAVING/ON). */
  predicate(value) {
    if (value === null) return null;
    if (typeof value === 'boolean') return value;
    throw new SqlError(
      ErrorCodes.TYPE_ERROR,
      `Predicate value must be boolean in the ${this.name} dialect, received ${sqlTypeOf(value)}.`
    );
  }

  /**
   * Coerce a value for arithmetic. NULL is handled by the evaluator.
   * @param {unknown} value
   * @param {string} operator
   */
  toNumber(value, operator) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    throw new SqlError(
      ErrorCodes.TYPE_ERROR,
      `Operator ${operator} requires numeric operands in the ${this.name} dialect, received ${describeValue(value)}.`
    );
  }

  /** Coerce a value used with LIKE to text. */
  toTextForLike(value) {
    if (typeof value === 'string') return value;
    throw new SqlError(
      ErrorCodes.TYPE_ERROR,
      `LIKE requires text in the ${this.name} dialect, received ${describeValue(value)}.`
    );
  }

  /** Convert an arithmetic result to text for `||`. */
  toText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return formatNumber(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    throw new SqlError(ErrorCodes.TYPE_ERROR, `Cannot convert ${describeValue(value)} to text.`);
  }

  /** Default null ordering for ORDER BY. */
  nullsFirst(descending) {
    return this.nullsFirstAscending ? !descending : descending;
  }

  /** @param {string} name */
  hasScalarFunction(name) {
    return this.scalarFunctions.has(name.toUpperCase());
  }

  /** @param {string} name */
  hasAggregateFunction(name) {
    return this.aggregateFunctions.has(name.toUpperCase());
  }

  /** @param {string} name */
  assertBindable(name) {
    assertBindableValue(name);
  }

  /** Text shown in unknown-dialect errors. */
  toString() {
    return this.label;
  }
}

/** @param {unknown} value */
function describeValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'NULL';
  if (typeof value === 'string') return `text ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `number ${value}`;
  if (typeof value === 'boolean') return `boolean ${value}`;
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : typeof value;
}
