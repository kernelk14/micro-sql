/** A value that can be stored in a table or bound to a parameter. */
export type SqlValue = null | string | number | boolean;

/** A single result row. */
export type Row = Record<string, SqlValue>;

/** Named parameter bag accepted by the API. */
export type NamedParameters = Record<string, SqlValue> | Map<string, SqlValue>;

/** Values accepted as the second argument of run/all/get/exec. */
export type BindParameters = SqlValue[] | NamedParameters | null | undefined;

/** Result of a statement that does not return rows. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** Result of one statement executed through `Database#exec`. */
export type ExecResult = { rows: Row[] } | { changes: number; lastInsertRowid: number };

/** A parameter placeholder found in a compiled statement. */
export interface ParameterToken {
  style: 'positional' | 'named';
  index?: number;
  name?: string;
  prefix?: string;
}
