import type { SqlValue } from '../types.js';

export type TypeFamily = 'integer' | 'real' | 'text' | 'boolean';

export interface ResolvedType {
  name: string;
  family: TypeFamily;
  args: number[];
  autoincrement: boolean;
}

/** The shape of a column as read by type coercion. */
export interface ColumnTypeInfo {
  name: string;
  type: { name: string; family: string };
}

export interface BaseDialectOptions {
  name?: string;
  label?: string;
  extraKeywords?: string[];
  identifierQuotes?: { open: string; close: string }[];
  doubleQuoteStrings?: boolean;
  backslashEscapes?: boolean;
  hashComments?: boolean;
  supportsQuestionParams?: boolean;
  supportsDollarParams?: boolean;
  namedParamPrefixes?: string[];
  supportsDoubleEquals?: boolean;
  types?: Record<string, TypeFamily>;
  autoIncrementTypes?: string[];
  autoIncrementKeywords?: string[];
  implicitRowid?: boolean;
  likeCaseInsensitive?: boolean;
  integerDivision?: boolean;
  zeroDivisionReturnsNull?: boolean;
  concatOperator?: boolean;
  supportsNullsOrdering?: boolean;
  supportsLimitComma?: boolean;
  supportsOffsetWithoutLimit?: boolean;
  nullsFirstAscending?: boolean;
  booleanStorage?: 'boolean' | 'number';
  scalarFunctions?: Record<string, { min: number; max: number }>;
}

/**
 * A SQL dialect profile: lexical rules, quoting, type names, coercion,
 * comparison semantics and syntax feature switches.
 */
export class BaseDialect {
  constructor(options?: BaseDialectOptions);

  name: string;
  label: string;
  reservedKeywords: Set<string>;
  identifierQuotes: { open: string; close: string }[];
  doubleQuoteStrings: boolean;
  backslashEscapes: boolean;
  hashComments: boolean;
  supportsQuestionParams: boolean;
  supportsDollarParams: boolean;
  namedParamPrefixes: string[];
  supportsDoubleEquals: boolean;
  typeFamilies: Record<string, TypeFamily>;
  autoIncrementTypes: Set<string>;
  autoIncrementKeywords: string[];
  implicitRowid: boolean;
  likeCaseInsensitive: boolean;
  integerDivision: boolean;
  zeroDivisionReturnsNull: boolean;
  concatOperator: boolean;
  supportsNullsOrdering: boolean;
  supportsLimitComma: boolean;
  supportsOffsetWithoutLimit: boolean;
  nullsFirstAscending: boolean;
  booleanStorage: 'boolean' | 'number';
  scalarFunctions: Map<string, { min: number; max: number }>;
  aggregateFunctions: Set<string>;

  isKeyword(word: string): boolean;
  quoteIdentifier(name: string): string;
  formatStringLiteral(value: string): string;
  formatLiteral(value: SqlValue): string;
  resolveType(rawName: string, args?: number[]): ResolvedType;
  coerceColumnValue(value: SqlValue, column: ColumnTypeInfo): SqlValue;
  compare(a: SqlValue, b: SqlValue): number;
  predicate(value: SqlValue): boolean | null;
  toNumber(value: unknown, operator: string): number;
  toTextForLike(value: SqlValue): string;
  toText(value: SqlValue): string;
  nullsFirst(descending: boolean): boolean;
  hasScalarFunction(name: string): boolean;
  hasAggregateFunction(name: string): boolean;
  assertBindable(name: string): void;
  toString(): string;
}
