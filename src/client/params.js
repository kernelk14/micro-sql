import { SqlError, ErrorCodes } from '../errors.js';
import { assertBindableValue } from '../values.js';

/**
 * Parameter handling for live database connections.
 *
 * A driver only accepts its own placeholder syntax, so every statement is
 * scanned for `?`, `$n` and `:name` parameters (ignoring quoted text and
 * comments) and rewritten to the style the driver understands:
 *
 * - SQLite and MySQL receive positional `?` placeholders.
 * - PostgreSQL receives `$1`, `$2`, ... placeholders.
 *
 * The scan is intentionally forgiving: it never validates the SQL itself, so
 * statements that the in-memory engine cannot parse (subqueries, ALTER TABLE,
 * casts) still reach the server untouched. Only parameter count and style
 * mismatches are reported.
 */

const ROW_KEYWORDS = new Set([
  'SELECT', 'WITH', 'VALUES', 'SHOW', 'EXPLAIN', 'PRAGMA', 'DESCRIBE', 'DESC', 'TABLE'
]);

/**
 * Scan SQL text for parameters and statement boundaries.
 *
 * @param {string} sql
 * @param {import('../dialects/base.js').BaseDialect} dialect
 * @param {{ identifierEscapes?: boolean }} [options] treat `??` as an escaped identifier (MySQL)
 * @returns {{
 *   parameters: {style: 'positional'|'named', index?: number, name?: string, prefix?: string, start: number, end: number}[],
 *   statements: string[]
 * }}
 */
export function scanSql(sql, dialect, options = {}) {
  const identifierEscapes = Boolean(options.identifierEscapes);
  /** @type {object[]} */
  const parameters = [];
  /** @type {{start: number, end: number}[]} */
  const ranges = [];
  let statementStart = 0;
  let positionalCount = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i + 2);
      continue;
    }
    if (ch === '#' && dialect.hashComments) {
      i = skipLineComment(sql, i + 1);
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i);
      continue;
    }

    if (ch === "'" || (ch === '"' && dialect.doubleQuoteStrings)) {
      i = skipQuoted(sql, i, ch, Boolean(dialect.backslashEscapes) || isEscapePrefixed(sql, i));
      continue;
    }
    const quote = dialect.identifierQuotes.find((entry) => entry.open === ch);
    if (quote) {
      i = skipQuoted(sql, i, quote.close, false);
      continue;
    }

    if (ch === '$') {
      const next = sql[i + 1];
      if (isDigit(next)) {
        let j = i + 1;
        while (isDigit(sql[j])) j += 1;
        const index = Number(sql.slice(i + 1, j));
        if (!Number.isSafeInteger(index) || index < 1) {
          throw new SqlError(
            ErrorCodes.PARAMETER_ERROR,
            'Positional parameters use 1-based indexes such as $1.'
          );
        }
        parameters.push({ style: 'positional', index, start: i, end: j });
        i = j;
        continue;
      }
      // PostgreSQL dollar-quoted string: $$...$$ or $tag$...$tag$.
      if (next === '$') {
        i = skipDollarQuoted(sql, i, '$$');
        continue;
      }
      if (isIdentifierStart(next)) {
        let j = i + 1;
        while (isNamePart(sql[j])) j += 1;
        if (sql[j] === '$') {
          i = skipDollarQuoted(sql, i, sql.slice(i, j + 1));
          continue;
        }
        parameters.push({ style: 'named', name: sql.slice(i + 1, j), prefix: '$', start: i, end: j });
        i = j;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '?') {
      // MySQL uses `??` to quote an identifier. It still consumes one value,
      // so it is kept as a single positional placeholder.
      if (identifierEscapes && sql[i + 1] === '?') {
        positionalCount += 1;
        parameters.push({
          style: 'positional',
          index: positionalCount,
          start: i,
          end: i + 2,
          placeholder: '??'
        });
        i += 2;
        continue;
      }
      positionalCount += 1;
      parameters.push({ style: 'positional', index: positionalCount, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    if (ch === ':' && sql[i + 1] === ':') {
      // PostgreSQL cast operator; not a parameter.
      i += 2;
      continue;
    }

    if (ch === ':' || ch === '@') {
      if (isIdentifierStart(sql[i + 1])) {
        let j = i + 1;
        while (isNamePart(sql[j])) j += 1;
        parameters.push({ style: 'named', name: sql.slice(i + 1, j), prefix: ch, start: i, end: j });
        i = j;
        continue;
      }
      // Not a parameter (for example a PostgreSQL `::` cast); leave it alone.
      i += 1;
      continue;
    }

    if (ch === ';') {
      ranges.push({ start: statementStart, end: i });
      statementStart = i + 1;
      i += 1;
      continue;
    }

    i += 1;
  }

  ranges.push({ start: statementStart, end: sql.length });

  return {
    parameters,
    statements: ranges
      .map((range) => sql.slice(range.start, range.end))
      .filter((text) => text.trim() !== '')
  };
}

/**
 * Rewrite a statement's parameters to the driver's placeholder style and
 * return the values in the order the placeholders appear.
 *
 * @param {string} sql
 * @param {unknown} params
 * @param {import('../dialects/base.js').BaseDialect} dialect
 * @param {string} [dialectName]
 * @returns {{ text: string, values: unknown[] }}
 */
export function normalizeParameters(sql, params, dialect, dialectName = dialect.name) {
  const isMysql = dialectName === 'mysql';
  const { parameters } = scanSql(sql, dialect, { identifierEscapes: isMysql });
  const style = dialectName === 'postgres' ? '$' : '?';

  if (parameters.length === 0) {
    if (!hasNoValues(params)) {
      throw new SqlError(
        ErrorCodes.PARAMETER_ERROR,
        'This statement has no parameters, but values were supplied.'
      );
    }
    return { text: sql, values: [] };
  }

  const positional = parameters.filter((token) => token.style === 'positional');
  const named = parameters.filter((token) => token.style === 'named');

  if (positional.length > 0 && named.length > 0) {
    throw new SqlError(
      ErrorCodes.PARAMETER_ERROR,
      'A statement cannot mix positional and named parameters.'
    );
  }

  /** @type {{ value: unknown, label: string }[]} */
  let entries;

  if (positional.length > 0) {
    if (!Array.isArray(params)) {
      throw new SqlError(
        ErrorCodes.PARAMETER_ERROR,
        'Positional parameters require an array of values.'
      );
    }
    const required = Math.max(...positional.map((token) => token.index));
    if (params.length !== required) {
      throw new SqlError(
        ErrorCodes.PARAMETER_ERROR,
        `Expected ${required} parameter value(s), received ${params.length}.`
      );
    }
    entries = positional.map((token) => ({
      value: params[token.index - 1],
      label: `parameter ${token.index}`
    }));
  } else {
    if (!isNamedBag(params)) {
      throw new SqlError(
        ErrorCodes.PARAMETER_ERROR,
        'Named parameters require an object of values, for example { name: "Ada" }.'
      );
    }
    const values = toObject(params);
    entries = named.map((token) => {
      if (!Object.prototype.hasOwnProperty.call(values, token.name)) {
        throw new SqlError(
          ErrorCodes.PARAMETER_ERROR,
          `Missing value for named parameter ${token.prefix}${token.name}.`
        );
      }
      return { value: values[token.name], label: `parameter ${token.prefix}${token.name}` };
    });
  }

  const values = entries.map((entry) => {
    assertBindableValue(entry.value, entry.label);
    if (style === '?' && typeof entry.value === 'boolean') return entry.value ? 1 : 0;
    return entry.value;
  });

  let text = '';
  let cursor = 0;
  let index = 0;
  for (const token of parameters) {
    text += sql.slice(cursor, token.start);
    index += 1;
    text += style === '$' ? `$${index}` : token.placeholder || '?';
    cursor = token.end;
  }
  text += sql.slice(cursor);

  return { text, values };
}

/**
 * Split SQL into separate statements, ignoring semicolons inside quotes and
 * comments.
 * @param {string} sql
 * @param {import('../dialects/base.js').BaseDialect} dialect
 * @param {string} [dialectName]
 * @returns {string[]}
 */
export function splitStatements(sql, dialect, dialectName = dialect.name) {
  return scanSql(sql, dialect, { identifierEscapes: dialectName === 'mysql' }).statements;
}

/**
 * Whether a statement returns rows. This is a leading-keyword heuristic, which
 * keeps drivers that need a different method for reads and writes simple.
 * @param {string} sql
 * @returns {'rows'|'run'}
 */
export function statementKind(sql) {
  if (ROW_KEYWORDS.has(firstKeyword(sql))) return 'rows';
  if (hasReturningClause(sql)) return 'rows';
  return 'run';
}

/**
 * Whether a statement only reads data (`SELECT`, `WITH`, `SHOW`, ...).
 * @param {string} sql
 * @returns {boolean}
 */
export function isReadStatement(sql) {
  return ROW_KEYWORDS.has(firstKeyword(sql));
}

/**
 * First keyword of a statement in upper case, for example `'INSERT'`.
 * @param {string} sql
 * @returns {string}
 */
export function statementVerb(sql) {
  return firstKeyword(sql);
}

/** Whether a statement ends with a `RETURNING` clause. */
function hasReturningClause(sql) {
  return /\bRETURNING\b/i.test(sql);
}

/** First keyword of a statement, skipping whitespace and comments. */
function firstKeyword(sql) {
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) {
      i += 1;
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i + 2);
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i);
      continue;
    }
    break;
  }
  let j = i;
  while (j < sql.length && isIdentifierPart(sql[j])) j += 1;
  return sql.slice(i, j).toUpperCase();
}

function hasNoValues(params) {
  if (params === undefined || params === null) return true;
  if (Array.isArray(params)) return params.length === 0;
  if (params instanceof Map) return params.size === 0;
  if (typeof params === 'object') return Object.keys(params).length === 0;
  return false;
}

function isNamedBag(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toObject(value) {
  if (value instanceof Map) {
    const out = {};
    for (const [key, entry] of value) out[key] = entry;
    return out;
  }
  return value;
}

function skipLineComment(sql, start) {
  let i = start;
  while (i < sql.length && sql[i] !== '\n') i += 1;
  return i;
}

function skipBlockComment(sql, start) {
  const close = sql.indexOf('*/', start + 2);
  return close === -1 ? sql.length : close + 2;
}

function skipQuoted(sql, start, close, backslash) {
  let i = start + 1;
  while (i < sql.length) {
    if (backslash && sql[i] === '\\') {
      i += 2;
      continue;
    }
    if (sql[i] === close) {
      if (sql[i + 1] === close) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  // Unterminated: leave the rest alone so the server reports the real error.
  return sql.length;
}

function skipDollarQuoted(sql, start, delimiter) {
  const close = sql.indexOf(delimiter, start + delimiter.length);
  return close === -1 ? sql.length : close + delimiter.length;
}

/** PostgreSQL `E'...'` strings process backslash escapes. */
function isEscapePrefixed(sql, index) {
  if (index === 0) return false;
  const previous = sql[index - 1];
  if (previous !== 'E' && previous !== 'e') return false;
  return index < 2 || !isIdentifierPart(sql[index - 2]);
}

function isDigit(ch) {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isIdentifierStart(ch) {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36 ||
    code >= 128
  );
}

function isIdentifierPart(ch) {
  return isIdentifierStart(ch) || isDigit(ch);
}

/** Parameter names and dollar-quote tags never contain `$`. */
function isNamePart(ch) {
  return isIdentifierPart(ch) && ch !== '$';
}
