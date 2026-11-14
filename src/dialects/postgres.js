import { BaseDialect } from './base.js';

const POSTGRES_TYPES = {
  SMALLINT: 'integer',
  INTEGER: 'integer',
  INT: 'integer',
  BIGINT: 'integer',
  SERIAL: 'integer',
  BIGSERIAL: 'integer',
  SMALLSERIAL: 'integer',
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
  BOOLEAN: 'boolean',
  BOOL: 'boolean'
};

/**
 * PostgreSQL-style dialect (implemented subset).
 *
 * Notable behaviours:
 * - double quotes quote identifiers; single quotes quote strings; standard
 *   conforming strings (no backslash escapes).
 * - `$1` positional and `:name` named parameters (the named form is a library
 *   extension, not part of PostgreSQL itself).
 * - Declared types are restricted to the list in the README.
 * - Strict value typing: no implicit conversion between text and numbers.
 * - WHERE requires a boolean expression.
 * - integer / integer truncates; division by zero raises an error.
 * - `||` concatenates text.
 * - NULLs sort last for ASC, first for DESC.
 * - `SERIAL` / `BIGSERIAL` / `SMALLSERIAL` are integer auto-increment columns.
 */
export class PostgresDialect extends BaseDialect {
  constructor() {
    super({
      name: 'postgres',
      label: 'PostgreSQL (implemented subset)',
      identifierQuotes: [{ open: '"', close: '"' }],
      supportsQuestionParams: false,
      supportsDollarParams: true,
      namedParamPrefixes: [':'],
      types: POSTGRES_TYPES,
      autoIncrementTypes: ['SERIAL', 'BIGSERIAL', 'SMALLSERIAL'],
      likeCaseInsensitive: false,
      integerDivision: true,
      zeroDivisionReturnsNull: false,
      concatOperator: true,
      supportsNullsOrdering: true,
      supportsLimitComma: false,
      supportsOffsetWithoutLimit: true,
      nullsFirstAscending: false,
      booleanStorage: 'boolean',
      scalarFunctions: {
        CONCAT: { min: 1, max: Infinity },
        CHAR_LENGTH: { min: 1, max: 1 }
      }
    });
  }
}
