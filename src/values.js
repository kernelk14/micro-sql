import { SqlError, ErrorCodes } from './errors.js';

/**
 * Runtime value helpers shared by dialects and the engine.
 *
 * A runtime value is one of: null, number (finite), string, boolean.
 * Dates, blobs, bigints, objects and undefined are not supported.
 */

/**
 * @param {unknown} value
 * @returns {'null'|'boolean'|'integer'|'real'|'text'}
 */
export function sqlTypeOf(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SqlError(ErrorCodes.TYPE_ERROR, 'NaN and Infinity are not valid SQL values.');
    return Number.isInteger(value) ? 'integer' : 'real';
  }
  if (typeof value === 'string') return 'text';
  throw new SqlError(ErrorCodes.TYPE_ERROR, `Unsupported value of JavaScript type "${typeof value}".`);
}

/**
 * Reject values that cannot be bound or stored, with a clear message.
 * @param {unknown} value
 * @param {string} context
 */
export function assertBindableValue(value, context = 'parameter') {
  if (value === null) return;
  if (typeof value === 'string') return;
  if (typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SqlError(ErrorCodes.PARAMETER_ERROR, `Invalid ${context}: NaN and Infinity are not supported.`);
    }
    return;
  }
  throw new SqlError(
    ErrorCodes.PARAMETER_ERROR,
    `Invalid ${context}: expected null, string, number or boolean, received ${describeJsValue(value)}.`
  );
}

/** @param {unknown} value */
function describeJsValue(value) {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') return 'object';
  return typeof value;
}

/**
 * Compare two strings by UTF-16 code units. Deterministic and locale independent.
 * @param {string} a
 * @param {string} b
 */
export function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * SQL LIKE matcher implemented directly (no regular expressions).
 * `%` matches any sequence, `_` matches one character.
 * @param {string} value
 * @param {string} pattern
 * @param {boolean} caseInsensitive
 * @returns {boolean}
 */
export function likeMatch(value, pattern, caseInsensitive) {
  const text = caseInsensitive ? value.toLowerCase() : value;
  const pat = caseInsensitive ? pattern.toLowerCase() : pattern;
  let ti = 0;
  let pi = 0;
  let star = -1;
  let mark = 0;

  while (ti < text.length) {
    if (pi < pat.length && (pat[pi] === '_' || pat[pi] === text[ti])) {
      ti += 1;
      pi += 1;
    } else if (pi < pat.length && pat[pi] === '%') {
      star = pi;
      pi += 1;
      mark = ti;
    } else if (star !== -1) {
      pi = star + 1;
      mark += 1;
      ti = mark;
    } else {
      return false;
    }
  }
  while (pi < pat.length && pat[pi] === '%') pi += 1;
  return pi === pat.length;
}

/**
 * Parse a string that should contain a base-10 integer.
 * @param {string} text
 * @returns {number|null}
 */
export function parseIntegerText(text) {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  let index = 0;
  if (trimmed[0] === '+' || trimmed[0] === '-') index = 1;
  if (index >= trimmed.length) return null;
  for (let i = index; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 48 || code > 57) return null;
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

/**
 * Parse a string that should contain a decimal number (no hex, no Infinity).
 * @param {string} text
 * @returns {number|null}
 */
export function parseNumericText(text) {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return value;
}

/**
 * Check whether a string looks like a decimal number; used by SQLite affinity.
 * @param {string} text
 */
export function isNumericText(text) {
  return parseNumericText(text) !== null;
}

/**
 * Format a finite number for generated SQL.
 * @param {number} value
 */
export function formatNumber(value) {
  if (Object.is(value, -0)) return '0';
  return String(value);
}

/**
 * Stable key for equality/grouping that keeps SQL types distinct.
 * @param {unknown} value
 */
export function valueKey(value) {
  if (value === null || value === undefined) return 'N';
  if (typeof value === 'number') return `D:${value}`;
  if (typeof value === 'string') return `S:${value}`;
  if (typeof value === 'boolean') return `B:${value ? 1 : 0}`;
  return `X:${String(value)}`;
}

/** Three-valued AND. */
export function sqlAnd(a, b) {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}

/** Three-valued OR. */
export function sqlOr(a, b) {
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

/** Three-valued NOT. */
export function sqlNot(value) {
  if (value === null) return null;
  return !value;
}

/**
 * Byte length of a UTF-8 string using the standard TextEncoder API.
 * @param {string} text
 */
export function utf8ByteLength(text) {
  return new TextEncoder().encode(text).length;
}
