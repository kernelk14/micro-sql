import type { Database } from './index.js';
import type { DialectName } from './dialects/index.js';
import type { SqlValue } from './types.js';

export interface SnapshotColumn {
  name: string;
  type: string;
  args: number[];
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  defaultValue: SqlValue;
}

export interface SnapshotTable {
  name: string;
  columns: SnapshotColumn[];
  primaryKey: string[];
  uniques: string[][];
  rows: Record<string, SqlValue>[];
}

export interface DatabaseSnapshot {
  version: 1;
  dialect: string;
  tables: SnapshotTable[];
}

/** Serialize a database to a JSON-safe snapshot. */
export function toJSON(database: Database): DatabaseSnapshot;

/** Rebuild a database from a snapshot produced by `toJSON`. */
export function fromJSON(
  snapshot: DatabaseSnapshot | string,
  options?: { dialect?: DialectName | string }
): Database;
