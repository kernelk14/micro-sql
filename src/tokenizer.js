import { syntaxError, unsupported } from './errors.js';

/**
 * @typedef {object} Token
 * @property {'keyword'|'identifier'|'number'|'string'|'parameter'|'operator'|'punctuation'|'eof'} type
 * @property {string|number} value
 * @property {string} raw
 * @property {number} start
 * @property {number} end
 * @property {number} line 1-based
 * @property {number} column 1-based
 * @property {boolean} [quoted]
 * @property {'positional'|'named'} [style]
 * @property {number} [index] 1-based positional index
 * @property {string} [name] named parameter (without prefix)
 * @property {string} [prefix]
 */

const SINGLE_CHAR_OPERATORS = new Set(['=', '<', '>', '+', '-', '*', '/', '%']);
const PUNCTUATION = new Set(['(', ')', ',', ';', '.']);

/**
 * Turn SQL text into tokens using the rules of a dialect.
 *
 * This is a character scanner, not a regex-based splitter. It handles quoted
 * identifiers, string escapes, line/block comments and every parameter style.
 *
 * @param {string} sql
 * @param {import('./dialects/base.js').BaseDialect} dialect
 * @returns {Token[]}
 */
export function tokenize(sql, dialect) {
  if (typeof sql !== 'string') throw new TypeError('SQL must be a string.');

  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let positionalCount = 0;

  const advanceTo = (position) => {
    for (let k = i; k < position; k += 1) {
      if (sql[k] === '\n') {
        line += 1;
        lineStart = k + 1;
      }
    }
    i = position;
  };

  const push = (token) => {
    tokens.push(token);
  };

  const makeToken = (type, value, start, end, startLine, startColumn, extra = {}) => ({
    type,
    value,
    raw: sql.slice(start, end),
    start,
    end,
    line: startLine,
    column: startColumn,
    ...extra
  });

  while (i < sql.length) {
    const ch = sql[i];
    const start = i;
    const startLine = line;
    const startColumn = i - lineStart + 1;

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v') {
      advanceTo(i + 1);
      continue;
    }

    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      let j = i + 2;
      while (j < sql.length && sql[j] !== '\n') j += 1;
      advanceTo(j);
      continue;
    }

    // # line comment (MySQL)
    if (ch === '#' && dialect.hashComments) {
      let j = i + 1;
      while (j < sql.length && sql[j] !== '\n') j += 1;
      advanceTo(j);
      continue;
    }

    // Block comment
    if (ch === '/' && sql[i + 1] === '*') {
      let j = i + 2;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === '*' && sql[j + 1] === '/') {
          j += 2;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        throw syntaxError('Unterminated block comment', makeToken('operator', '', start, i + 2, startLine, startColumn), sql);
      }
      advanceTo(j);
      continue;
    }

    // String literal (single quotes, plus double quotes where the dialect says so)
    if (ch === "'" || (ch === '"' && dialect.doubleQuoteStrings)) {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            value += ch;
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        if (sql[j] === '\\' && dialect.backslashEscapes) {
          const next = sql[j + 1];
          if (next === undefined) break;
          value += decodeBackslashEscape(next);
          j += 2;
          continue;
        }
        value += sql[j];
        j += 1;
      }
      if (!closed) {
        throw syntaxError('Unterminated string literal', makeToken('string', '', start, i + 1, startLine, startColumn), sql);
      }
      const token = makeToken('string', value, start, j, startLine, startColumn);
      push(token);
      advanceTo(j);
      continue;
    }

    // Quoted identifier
    const quote = dialect.identifierQuotes.find((entry) => entry.open === ch);
    if (quote) {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === quote.close) {
          if (sql[j + 1] === quote.close) {
            value += quote.close;
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        value += sql[j];
        j += 1;
      }
      if (!closed) {
        throw syntaxError(
          `Unterminated quoted identifier (expected ${quote.close})`,
          makeToken('identifier', '', start, i + 1, startLine, startColumn),
          sql
        );
      }
      if (value === '') {
        throw syntaxError('Empty quoted identifier', makeToken('identifier', '', start, j, startLine, startColumn), sql);
      }
      const token = makeToken('identifier', value, start, j, startLine, startColumn, { quoted: true });
      push(token);
      advanceTo(j);
      continue;
    }

    // Number literal
    if (isDigit(ch) || (ch === '.' && isDigit(sql[i + 1]))) {
      let j = i;
      while (isDigit(sql[j])) j += 1;
      if (sql[j] === '.') {
        j += 1;
        while (isDigit(sql[j])) j += 1;
      }
      if (sql[j] === 'e' || sql[j] === 'E') {
        let k = j + 1;
        if (sql[k] === '+' || sql[k] === '-') k += 1;
        if (isDigit(sql[k])) {
          while (isDigit(sql[k])) k += 1;
          j = k;
        }
      }
      if (isIdentifierStart(sql[j])) {
        throw syntaxError(
          `Invalid numeric literal "${sql.slice(start, j + 1)}"`,
          makeToken('number', '', start, j + 1, startLine, startColumn),
          sql
        );
      }
      const raw = sql.slice(start, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw syntaxError(`Numeric literal "${raw}" is out of range`, makeToken('number', 0, start, j, startLine, startColumn), sql);
      }
      push(makeToken('number', value, start, j, startLine, startColumn));
      advanceTo(j);
      continue;
    }

    // Parameters
    if (ch === '?') {
      if (!dialect.supportsQuestionParams) {
        throw unsupported(
          `The ${dialect.name} dialect does not support "?" parameters; use ${dialect.supportsDollarParams ? '$1-style positional' : 'named'} parameters.`
        );
      }
      positionalCount += 1;
      push(makeToken('parameter', '?', start, i + 1, startLine, startColumn, {
        style: 'positional',
        index: positionalCount
      }));
      advanceTo(i + 1);
      continue;
    }

    if (ch === '$' && dialect.supportsDollarParams && isDigit(sql[i + 1])) {
      let j = i + 1;
      while (isDigit(sql[j])) j += 1;
      const index = Number(sql.slice(i + 1, j));
      if (!Number.isSafeInteger(index) || index < 1) {
        throw syntaxError(
          'Positional parameters use 1-based indexes such as $1',
          makeToken('parameter', '', start, j, startLine, startColumn),
          sql
        );
      }
      if (isIdentifierStart(sql[j])) {
        throw syntaxError(
          'Invalid positional parameter (unexpected identifier character)',
          makeToken('parameter', '', start, j + 1, startLine, startColumn),
          sql
        );
      }
      push(makeToken('parameter', `$${index}`, start, j, startLine, startColumn, {
        style: 'positional',
        index
      }));
      advanceTo(j);
      continue;
    }

    if (dialect.namedParamPrefixes.includes(ch) && isIdentifierStart(sql[i + 1])) {
      let j = i + 1;
      while (isIdentifierPart(sql[j])) j += 1;
      push(makeToken('parameter', sql.slice(i + 1, j), start, j, startLine, startColumn, {
        style: 'named',
        name: sql.slice(i + 1, j),
        prefix: ch
      }));
      advanceTo(j);
      continue;
    }

    if (ch === '$' || ch === ':' || ch === '@') {
      throw syntaxError(`Unexpected character "${ch}"`, makeToken('operator', ch, start, i + 1, startLine, startColumn), sql);
    }

    // Identifiers and keywords
    if (isIdentifierStart(ch)) {
      let j = i + 1;
      while (isIdentifierPart(sql[j])) j += 1;
      const raw = sql.slice(start, j);
      const upper = raw.toUpperCase();
      if (dialect.isKeyword(upper)) {
        push(makeToken('keyword', upper, start, j, startLine, startColumn));
      } else {
        push(makeToken('identifier', raw, start, j, startLine, startColumn));
      }
      advanceTo(j);
      continue;
    }

    // Two-character operators
    const two = sql.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=' || two === '||') {
      if (two === '||' && !dialect.concatOperator) {
        throw unsupported(
          `The ${dialect.name} dialect does not support the || concatenation operator; use the CONCAT function.`
        );
      }
      push(makeToken('operator', two, start, i + 2, startLine, startColumn));
      advanceTo(i + 2);
      continue;
    }
    if (two === '==' && dialect.supportsDoubleEquals) {
      push(makeToken('operator', '==', start, i + 2, startLine, startColumn));
      advanceTo(i + 2);
      continue;
    }

    if (SINGLE_CHAR_OPERATORS.has(ch)) {
      push(makeToken('operator', ch, start, i + 1, startLine, startColumn));
      advanceTo(i + 1);
      continue;
    }

    if (PUNCTUATION.has(ch)) {
      push(makeToken('punctuation', ch, start, i + 1, startLine, startColumn));
      advanceTo(i + 1);
      continue;
    }

    throw syntaxError(
      `Unexpected character "${ch}"`,
      makeToken('operator', ch, start, i + 1, startLine, startColumn),
      sql
    );
  }

  push({
    type: 'eof',
    value: '',
    raw: '',
    start: sql.length,
    end: sql.length,
    line,
    column: sql.length - lineStart + 1
  });
  return tokens;
}

function decodeBackslashEscape(ch) {
  switch (ch) {
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'b': return '\b';
    case '0': return '\0';
    case '\\': return '\\';
    case "'": return "'";
    case '"': return '"';
    default: return ch;
  }
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
    code === 95 || // _
    code === 36 || // $
    code >= 128
  );
}

function isIdentifierPart(ch) {
  return isIdentifierStart(ch) || isDigit(ch);
}
