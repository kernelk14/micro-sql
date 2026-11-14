import { BaseDialect } from './base.js';

export type DialectName = 'sqlite' | 'postgres' | 'postgresql' | 'pg' | 'mysql' | 'mariadb';

export class SqliteDialect extends BaseDialect {}
export class PostgresDialect extends BaseDialect {}
export class MysqlDialect extends BaseDialect {}

/** Resolve a dialect from a name, or pass through a dialect instance. */
export function getDialect(spec?: DialectName | BaseDialect): BaseDialect;

/** Canonical dialect names accepted by `getDialect`. */
export function listDialects(): DialectName[];

export { BaseDialect } from './base.js';
export type {
  BaseDialectOptions,
  ColumnTypeInfo,
  ResolvedType,
  TypeFamily
} from './base.js';
