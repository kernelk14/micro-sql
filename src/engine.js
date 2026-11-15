import { SqlError, ErrorCodes } from './errors.js';
import { containsAggregate } from './parser.js';
import {
  likeMatch,
  sqlAnd,
  sqlNot,
  sqlOr,
  valueKey
} from './values.js';

/**
 * In-memory table store and statement executor.
 *
 * A table is `{ name, columns, rows }` where every column is
 * `{ name, key, type, notNull, primaryKey, unique, autoIncrement, defaultValue }`
 * and every row is a plain object keyed by the lower-cased column name.
 */
export class Engine {
  /** @param {import('./dialects/base.js').BaseDialect} dialect */
  constructor(dialect) {
    this.dialect = dialect;
    /** @type {Map<string, object>} */
    this.tables = new Map();
    /** @type {Map<string, object>} index metadata declared with CREATE INDEX */
    this.indexes = new Map();
    /** @type {Map<string, object>|null} tables captured at BEGIN */
    this.transactionSnapshot = null;
    /** @type {Map<string, object>|null} indexes captured at BEGIN */
    this.indexSnapshot = null;
  }

  /**
   * Execute one parsed statement.
   * @param {object} statement
   * @param {(token: object) => unknown} bind
   */
  execute(statement, bind) {
    switch (statement.type) {
      case 'Select':
        return this.executeSelect(statement, bind);
      case 'Insert':
        return this.executeInsert(statement, bind);
      case 'Update':
        return this.executeUpdate(statement, bind);
      case 'Delete':
        return this.executeDelete(statement, bind);
      case 'CreateTable':
        return this.executeCreateTable(statement, bind);
      case 'DropTable':
        return this.executeDropTable(statement);
      case 'AlterTable':
        return this.executeAlterTable(statement, bind);
      case 'CreateIndex':
        return this.executeCreateIndex(statement);
      case 'DropIndex':
        return this.executeDropIndex(statement);
      case 'Begin':
        return this.executeBegin();
      case 'Commit':
        return this.executeCommit();
      case 'Rollback':
        return this.executeRollback();
      default:
        throw new SqlError(ErrorCodes.INVALID_QUERY, `Cannot execute statement of type ${statement.type}.`);
    }
  }

  // ----------------------------------------------------------------- tables

  findTable(name) {
    return this.tables.get(String(name).toLowerCase()) || null;
  }

  requireTable(name) {
    const table = this.findTable(name);
    if (!table) {
      throw new SqlError(ErrorCodes.MISSING_TABLE, `Table "${name}" does not exist.`, { table: name });
    }
    return table;
  }

  executeCreateTable(statement, bind) {
    const key = statement.table.toLowerCase();
    if (this.tables.has(key)) {
      if (statement.ifNotExists) {
        return { type: 'create', changes: 0, table: statement.table };
      }
      throw new SqlError(ErrorCodes.TABLE_EXISTS, `Table "${statement.table}" already exists.`, { table: statement.table });
    }

    const seen = new Set();
    const columns = [];
    for (const definition of statement.columns) {
      const columnKey = definition.name.toLowerCase();
      if (seen.has(columnKey)) {
        throw new SqlError(
          ErrorCodes.DUPLICATE_COLUMN,
          `Column "${definition.name}" is declared more than once in table "${statement.table}".`,
          { table: statement.table, columnName: definition.name }
        );
      }
      seen.add(columnKey);
      const type = this.dialect.resolveType(definition.type, definition.args);
      const column = {
        name: definition.name,
        key: columnKey,
        type,
        notNull: Boolean(definition.notNull),
        primaryKey: Boolean(definition.primaryKey),
        unique: Boolean(definition.unique),
        autoIncrement: Boolean(definition.autoIncrement) || Boolean(type.autoincrement),
        defaultValue: undefined
      };
      if (definition.defaultExpr) {
        if (containsColumnReference(definition.defaultExpr) || containsParameter(definition.defaultExpr)) {
          throw new SqlError(
            ErrorCodes.INVALID_QUERY,
            `DEFAULT for column "${definition.name}" must be a constant expression.`,
            { table: statement.table, columnName: definition.name }
          );
        }
        const raw = evaluate(definition.defaultExpr, this.context(null, null, bind), this);
        column.defaultValue = this.dialect.coerceColumnValue(raw, column);
      }
      columns.push(column);
    }

    if (columns.length === 0) {
      throw new SqlError(ErrorCodes.INVALID_QUERY, `Table "${statement.table}" must declare at least one column.`);
    }

    const uniques = statement.uniques.map((names) => names.map((name) => this.columnKey(statement.table, columns, name)));
    const primaryKey = columns.filter((column) => column.primaryKey).map((column) => column.key);
    if (this.dialect.implicitRowid && primaryKey.length === 1) {
      const column = columns.find((entry) => entry.key === primaryKey[0]);
      if (column.type.family === 'integer') column.autoIncrement = true;
    }
    const table = { name: statement.table, columns, rows: [], uniques, primaryKey };
    this.tables.set(key, table);
    return { type: 'create', changes: 0, table: statement.table };
  }

  executeDropTable(statement) {
    const key = statement.table.toLowerCase();
    if (!this.tables.has(key)) {
      if (statement.ifExists) return { type: 'drop', changes: 0, table: statement.table };
      throw new SqlError(ErrorCodes.MISSING_TABLE, `Table "${statement.table}" does not exist.`, { table: statement.table });
    }
    this.tables.delete(key);
    for (const [indexKey, index] of this.indexes) {
      if (index.table.toLowerCase() === key) this.indexes.delete(indexKey);
    }
    return { type: 'drop', changes: 0, table: statement.table };
  }

  executeAlterTable(statement, bind) {
    const table = this.requireTable(statement.table);
    const dialect = this.dialect;

    switch (statement.action) {
      case 'addColumn': {
        const definition = statement.column;
        const key = definition.name.toLowerCase();
        if (table.columns.some((column) => column.key === key)) {
          throw new SqlError(
            ErrorCodes.DUPLICATE_COLUMN,
            `Table "${table.name}" already has a column named "${definition.name}".`,
            { table: table.name, columnName: definition.name }
          );
        }
        if (definition.primaryKey) {
          throw new SqlError(
            ErrorCodes.INVALID_QUERY,
            'ALTER TABLE cannot add a column declared PRIMARY KEY.'
          );
        }
        const type = dialect.resolveType(definition.type, definition.args);
        const column = {
          name: definition.name,
          key,
          type,
          notNull: Boolean(definition.notNull),
          primaryKey: false,
          unique: Boolean(definition.unique),
          autoIncrement: Boolean(definition.autoIncrement) || Boolean(type.autoincrement),
          defaultValue: undefined
        };
        if (definition.defaultExpr) {
          if (containsColumnReference(definition.defaultExpr) || containsParameter(definition.defaultExpr)) {
            throw new SqlError(
              ErrorCodes.INVALID_QUERY,
              `DEFAULT for column "${definition.name}" must be a constant expression.`,
              { table: table.name, columnName: definition.name }
            );
          }
          const raw = evaluate(definition.defaultExpr, this.context(null, null, bind), this);
          column.defaultValue = dialect.coerceColumnValue(raw, column);
        }
        if (column.notNull && column.defaultValue === undefined) {
          throw new SqlError(
            ErrorCodes.INVALID_QUERY,
            `Cannot add NOT NULL column "${column.name}" to table "${table.name}" without a DEFAULT.`,
            { table: table.name, columnName: column.name }
          );
        }
        table.columns = [...table.columns, column];
        for (const row of table.rows) {
          row[key] = column.defaultValue === undefined ? null : column.defaultValue;
        }
        return { type: 'alter', table: table.name, action: 'addColumn', changes: 0 };
      }

      case 'dropColumn': {
        const key = this.columnKey(table.name, table.columns, statement.columnName);
        if (table.columns.length === 1) {
          throw new SqlError(
            ErrorCodes.INVALID_QUERY,
            `Table "${table.name}" must keep at least one column.`,
            { table: table.name }
          );
        }
        table.columns = table.columns.filter((column) => column.key !== key);
        for (const row of table.rows) delete row[key];
        table.uniques = table.uniques
          .map((columns) => columns.filter((column) => column !== key))
          .filter((columns) => columns.length > 0);
        table.primaryKey = table.primaryKey.filter((column) => column !== key);
        return { type: 'alter', table: table.name, action: 'dropColumn', changes: 0 };
      }

      case 'renameTable': {
        const newKey = String(statement.newName).toLowerCase();
        if (this.tables.has(newKey)) {
          throw new SqlError(
            ErrorCodes.TABLE_EXISTS,
            `Table "${statement.newName}" already exists.`,
            { table: statement.newName }
          );
        }
        this.tables.delete(table.name.toLowerCase());
        table.name = statement.newName;
        this.tables.set(newKey, table);
        for (const index of this.indexes.values()) {
          if (index.table.toLowerCase() === newKey) index.table = statement.newName;
        }
        return { type: 'alter', table: table.name, action: 'renameTable', changes: 0 };
      }

      case 'renameColumn': {
        const key = this.columnKey(table.name, table.columns, statement.columnName);
        const newKey = String(statement.newName).toLowerCase();
        if (table.columns.some((column) => column.key === newKey)) {
          throw new SqlError(
            ErrorCodes.DUPLICATE_COLUMN,
            `Table "${table.name}" already has a column named "${statement.newName}".`,
            { table: table.name, columnName: statement.newName }
          );
        }
        const column = table.columns.find((entry) => entry.key === key);
        column.name = statement.newName;
        column.key = newKey;
        for (const row of table.rows) {
          row[newKey] = row[key];
          delete row[key];
        }
        const rename = (columns) => columns.map((entry) => (entry === key ? newKey : entry));
        table.uniques = table.uniques.map(rename);
        table.primaryKey = rename(table.primaryKey);
        return { type: 'alter', table: table.name, action: 'renameColumn', changes: 0 };
      }

      default:
        throw new SqlError(ErrorCodes.INVALID_QUERY, `Unknown ALTER TABLE action ${statement.action}.`);
    }
  }

  executeCreateIndex(statement) {
    const table = this.requireTable(statement.table);
    const key = String(statement.name).toLowerCase();
    if (this.indexes.has(key)) {
      if (statement.ifNotExists) {
        return { type: 'createIndex', table: table.name, changes: 0 };
      }
      throw new SqlError(
        ErrorCodes.INVALID_QUERY,
        `Index "${statement.name}" already exists.`,
        { table: table.name }
      );
    }
    const columns = statement.columns.map((name) => this.columnKey(table.name, table.columns, name));
    this.indexes.set(key, {
      name: statement.name,
      table: table.name,
      columns,
      unique: Boolean(statement.unique)
    });
    return { type: 'createIndex', table: table.name, changes: 0 };
  }

  executeDropIndex(statement) {
    const key = String(statement.name).toLowerCase();
    if (!this.indexes.has(key)) {
      if (statement.ifExists) return { type: 'dropIndex', changes: 0 };
      throw new SqlError(ErrorCodes.INVALID_QUERY, `Index "${statement.name}" does not exist.`);
    }
    const index = this.indexes.get(key);
    this.indexes.delete(key);
    return { type: 'dropIndex', table: index.table, changes: 0 };
  }

  /** Resolve a column name inside CREATE TABLE constraints. */
  columnKey(tableName, columns, name) {
    const found = columns.find((column) => column.key === String(name).toLowerCase());
    if (!found) {
      throw new SqlError(
        ErrorCodes.MISSING_COLUMN,
        `Table "${tableName}" has no column named "${name}".`,
        { table: tableName, columnName: name }
      );
    }
    return found.key;
  }

  // ----------------------------------------------------------------- SELECT

  executeSelect(statement, bind) {
    const result = this.select(statement, bind, null);
    return { type: 'select', columns: result.columns, rows: result.rows };
  }

  /**
   * Run a SELECT and return its projected rows.
   *
   * `outer` is the context of an enclosing statement; it is what makes a
   * correlated subquery able to read columns from the outer query.
   *
   * @param {object} statement
   * @param {(token: object) => unknown} bind
   * @param {object|null} outer
   */
  select(statement, bind, outer = null) {
    const dialect = this.dialect;
    const source = this.buildSource(statement.from, statement.joins, bind, outer);

    let filtered;
    if (!source) {
      filtered = [null];
    } else if (statement.where) {
      filtered = source.rows.filter((row) => {
        const value = evaluate(statement.where, this.context(row, null, bind, source, outer), this, source);
        return dialect.predicate(value) === true;
      });
    } else {
      filtered = source.rows;
    }

    const selectItems = statement.columns;
    const grouped =
      statement.groupBy.length > 0 ||
      selectItems.some((item) => containsAggregate(item.expr)) ||
      containsAggregate(statement.having) ||
      statement.orderBy.some((item) => containsAggregate(item.expr));

    /** @type {{ row: object|null, group: object[]|null }[]} */
    let contexts;
    if (grouped) {
      let groups;
      if (statement.groupBy.length === 0) {
        groups = [filtered];
      } else {
        const groupExprs = statement.groupBy.map((expr) => resolveOutputExpression(expr, selectItems));
        groups = groupRows(filtered, groupExprs, this, bind, source, outer);
      }
      contexts = groups.map((group) => this.context(group.length > 0 ? group[0] : null, group, bind, source, outer));
    } else {
      contexts = filtered.map((row) => this.context(row, null, bind, source, outer));
    }

    // Resolve output names, expanding "*" or "alias.*" against the source.
    const outputItems = [];
    for (const item of selectItems) {
      if (item.expr.type === 'Star') {
        if (!source) {
          throw new SqlError(ErrorCodes.INVALID_QUERY, 'SELECT * requires a FROM clause.');
        }
        let bindings = source.bindings;
        if (item.expr.table) {
          const alias = item.expr.table.toLowerCase();
          if (!source.bindings.some((binding) => binding.alias === alias)) {
            throw new SqlError(
              ErrorCodes.MISSING_COLUMN,
              `Table or alias "${item.expr.table}" is not in scope.`,
              { table: item.expr.table }
            );
          }
          bindings = bindings.filter((binding) => binding.alias === alias);
        }
        for (const binding of bindings) {
          outputItems.push({ binding, name: binding.outputName });
        }
        continue;
      }
      outputItems.push({ expr: item.expr, name: item.name });
    }

    const projected = [];
    for (const context of contexts) {
      if (statement.having) {
        const having = resolveOutputExpression(statement.having, selectItems);
        const value = evaluate(having, context, this, source);
        if (dialect.predicate(value) !== true) continue;
      }
      const record = {};
      for (const item of outputItems) {
        if (item.binding) {
          record[item.name] = readBinding(context.row, item.binding);
        } else {
          record[item.name] = evaluate(item.expr, context, this, source);
        }
      }
      projected.push({ record, context });
    }

    let results = statement.distinct ? distinctRecords(projected) : projected;

    if (statement.orderBy.length > 0) {
      const keys = statement.orderBy.map((item) => resolveOutputExpression(item.expr, statement.columns));
      const decorated = results.map((entry) => ({
        entry,
        sortKeys: keys.map((expr) => evaluate(expr, entry.context, this, source))
      }));
      decorated.sort((a, b) => compareSortKeys(a.sortKeys, b.sortKeys, statement.orderBy, dialect));
      results = decorated.map((entry) => entry.entry);
    }

    const offset = statement.offset ? this.limitValue(statement.offset, bind) : 0;
    const limit = statement.limit ? this.limitValue(statement.limit, bind) : null;
    if (offset > 0 || limit !== null) {
      const start = offset;
      const end = limit === null ? undefined : start + limit;
      results = results.slice(start, end);
    }

    return {
      columns: outputItems.map((item) => item.name),
      rows: results.map((entry) => entry.record)
    };
  }

  /**
   * Resolve FROM and JOIN clauses into a merged row source.
   *
   * Each source column gets a slot in the merged rows. Non-ambiguous columns
   * keep their bare name; columns that appear in more than one source are
   * stored under `alias\0column` and reported as `alias.column`.
   *
   * @param {{table: string, alias: string|null}|null} from
   * @param {{kind: 'inner'|'left'|'right'|'full'|'cross', table: string, alias: string|null, on: object|null}[]} joins
   * @param {(token: object) => unknown} bind
   * @param {object|null} outer context of an enclosing statement
   */
  buildSource(from, joins, bind, outer = null) {
    if (!from) return null;

    const sources = [];
    const seenAliases = new Set();
    for (const ref of [from, ...joins]) {
      const table = this.requireTable(ref.table);
      const label = ref.alias || table.name;
      const alias = String(label).toLowerCase();
      if (seenAliases.has(alias)) {
        throw new SqlError(
          ErrorCodes.INVALID_QUERY,
          `Table name or alias "${label}" is used more than once in FROM; give each table a distinct alias.`,
          { table: label }
        );
      }
      seenAliases.add(alias);
      sources.push({ table, alias, label });
    }

    const columnCounts = new Map();
    for (const source of sources) {
      for (const column of source.table.columns) {
        columnCounts.set(column.key, (columnCounts.get(column.key) || 0) + 1);
      }
    }

    const bindings = [];
    for (const source of sources) {
      source.bindings = [];
      for (const column of source.table.columns) {
        const ambiguous = columnCounts.get(column.key) > 1;
        const binding = {
          column,
          key: column.key,
          name: column.name,
          alias: source.alias,
          slot: ambiguous ? `${source.alias}\u0000${column.key}` : column.key,
          outputName: ambiguous ? `${source.alias}.${column.name}` : column.name
        };
        source.bindings.push(binding);
        bindings.push(binding);
      }
    }

    const sourceRows = (source, row) => {
      const out = {};
      for (const binding of source.bindings) out[binding.slot] = row ? row[binding.key] ?? null : null;
      return out;
    };

    const rowSets = sources.map((source) => source.table.rows.map((row) => sourceRows(source, row)));
    let rows = rowSets[0];
    for (let i = 0; i < joins.length; i += 1) {
      const join = joins[i];
      const rightRows = rowSets[i + 1];
      const emptyRight = sourceRows(sources[i + 1], null);
      const emptyLeft = {};
      for (const binding of sources.slice(0, i + 1).flatMap((entry) => entry.bindings)) {
        emptyLeft[binding.slot] = null;
      }
      const visible = sources.slice(0, i + 2).flatMap((entry) => entry.bindings);
      const rightMatched = new Set();
      const merged = [];

      for (const left of rows) {
        let matched = false;
        for (let r = 0; r < rightRows.length; r += 1) {
          const combined = { ...left, ...rightRows[r] };
          if (join.kind === 'cross') {
            merged.push(combined);
            matched = true;
            continue;
          }
          const scope = { bindings: visible };
          const value = evaluate(join.on, this.context(combined, null, bind, scope, outer), this, scope);
          if (this.dialect.predicate(value) === true) {
            merged.push(combined);
            matched = true;
            rightMatched.add(r);
          }
        }
        if (!matched && (join.kind === 'left' || join.kind === 'full')) {
          merged.push({ ...left, ...emptyRight });
        }
      }

      if (join.kind === 'right' || join.kind === 'full') {
        for (let r = 0; r < rightRows.length; r += 1) {
          if (!rightMatched.has(r)) merged.push({ ...emptyLeft, ...rightRows[r] });
        }
      }

      rows = merged;
    }

    return { sources, bindings, rows };
  }

  // --------------------------------------------------------- TRANSACTIONS

  executeBegin() {
    if (this.transactionSnapshot) {
      throw new SqlError(
        ErrorCodes.INVALID_QUERY,
        'A transaction is already active; nested transactions are not supported.'
      );
    }
    this.transactionSnapshot = this.snapshotTables();
    this.indexSnapshot = new Map([...this.indexes].map(([key, index]) => [key, { ...index }]));
    return { type: 'begin', changes: 0 };
  }

  executeCommit() {
    if (!this.transactionSnapshot) {
      throw new SqlError(ErrorCodes.INVALID_QUERY, 'COMMIT without an active transaction.');
    }
    this.transactionSnapshot = null;
    this.indexSnapshot = null;
    return { type: 'commit', changes: 0 };
  }

  executeRollback() {
    if (!this.transactionSnapshot) {
      throw new SqlError(ErrorCodes.INVALID_QUERY, 'ROLLBACK without an active transaction.');
    }
    this.tables = this.transactionSnapshot;
    if (this.indexSnapshot) this.indexes = this.indexSnapshot;
    this.transactionSnapshot = null;
    this.indexSnapshot = null;
    return { type: 'rollback', changes: 0 };
  }

  snapshotTables() {
    const copy = new Map();
    for (const [key, table] of this.tables) {
      copy.set(key, {
        ...table,
        columns: table.columns.map((column) => ({ ...column })),
        rows: table.rows.map((row) => ({ ...row })),
        uniques: table.uniques.map((entry) => entry.slice()),
        primaryKey: table.primaryKey.slice()
      });
    }
    return copy;
  }

  limitValue(expr, bind) {
    const value = evaluate(expr, this.context(null, null, bind), this);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new SqlError(
        ErrorCodes.PARAMETER_ERROR,
        'LIMIT and OFFSET parameters must bind to a non-negative integer.'
      );
    }
    return value;
  }

  // ----------------------------------------------------------------- INSERT

  executeInsert(statement, bind) {
    const table = this.requireTable(statement.table);
    const dialect = this.dialect;
    const scope = tableScope(table);

    let columnKeys;
    if (statement.columns.length > 0) {
      columnKeys = statement.columns.map((name) => this.columnKey(table.name, table.columns, name));
      const unique = new Set(columnKeys);
      if (unique.size !== columnKeys.length) {
        throw new SqlError(
          ErrorCodes.DUPLICATE_COLUMN,
          'The same column is listed more than once in INSERT.'
        );
      }
    } else {
      columnKeys = table.columns.map((column) => column.key);
    }    const pending = table.rows.slice();
    let changes = 0;
    let lastInsertRowid = 0;

    for (const valueExprs of statement.rows) {
      if (valueExprs.length !== columnKeys.length) {
        throw new SqlError(
          ErrorCodes.INVALID_QUERY,
          `INSERT for table "${table.name}" supplies ${valueExprs.length} value(s) for ${columnKeys.length} column(s).`,
          { table: table.name }
        );
      }

      const row = {};
      for (const column of table.columns) row[column.key] = column.defaultValue === undefined ? null : column.defaultValue;

      columnKeys.forEach((key, index) => {
        row[key] = evaluate(valueExprs[index], this.context(null, null, bind, scope), this, scope);
      });

      for (const column of table.columns) {
        const provided = columnKeys.includes(column.key) && row[column.key] !== null;
        if (!provided && column.autoIncrement) {
          row[column.key] = nextRowid(pending, column.key);
        }
        if (column.autoIncrement && typeof row[column.key] === 'number') {
          lastInsertRowid = row[column.key];
        }
        if (row[column.key] !== null && row[column.key] !== undefined) {
          row[column.key] = dialect.coerceColumnValue(row[column.key], column);
        } else {
          row[column.key] = null;
        }
        if (row[column.key] === null && column.notNull) {
          throw new SqlError(
            ErrorCodes.NOT_NULL_CONSTRAINT,
            `Column "${column.name}" of table "${table.name}" cannot be NULL.`,
            { table: table.name, columnName: column.name }
          );
        }
      }

      assertUnique(table, [...pending, row], this);
      pending.push(row);
      changes += 1;
    }

    table.rows = pending;
    return {
      type: 'insert',
      table: table.name,
      changes,
      lastInsertRowid
    };
  }

  // ----------------------------------------------------------------- UPDATE

  executeUpdate(statement, bind) {
    const table = this.requireTable(statement.table);
    const dialect = this.dialect;
    const scope = tableScope(table);
    const assignments = statement.assignments.map((assignment) => ({
      key: this.columnKey(table.name, table.columns, assignment.column),
      columnName: assignment.column,
      expr: assignment.expr
    }));

    for (const assignment of assignments) {
      const column = table.columns.find((entry) => entry.key === assignment.key);
      if (!column) {
        throw new SqlError(
          ErrorCodes.MISSING_COLUMN,
          `Table "${table.name}" has no column named "${assignment.columnName}".`,
          { table: table.name, columnName: assignment.columnName }
        );
      }
    }

    const rows = table.rows.map((row) => {
      if (statement.where) {
        const value = evaluate(statement.where, this.context(row, null, bind, scope), this, scope);
        if (dialect.predicate(value) !== true) return row;
      }
      const updated = { ...row };
      for (const assignment of assignments) {
        const column = table.columns.find((entry) => entry.key === assignment.key);
        const raw = evaluate(assignment.expr, this.context(row, null, bind, scope), this, scope);
        if (raw === null || raw === undefined) {
          updated[assignment.key] = null;
        } else {
          updated[assignment.key] = dialect.coerceColumnValue(raw, column);
        }
        if (updated[assignment.key] === null && column.notNull) {
          throw new SqlError(
            ErrorCodes.NOT_NULL_CONSTRAINT,
            `Column "${column.name}" of table "${table.name}" cannot be NULL.`,
            { table: table.name, columnName: column.name }
          );
        }
      }
      return updated;
    });

    assertUnique(table, rows, this);
    let changes = 0;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i] !== table.rows[i]) changes += 1;
    }
    table.rows = rows;
    return { type: 'update', table: table.name, changes };
  }

  // ----------------------------------------------------------------- DELETE

  executeDelete(statement, bind) {
    const table = this.requireTable(statement.table);
    const dialect = this.dialect;
    const scope = tableScope(table);
    if (!statement.where) {
      const changes = table.rows.length;
      table.rows = [];
      return { type: 'delete', table: table.name, changes };
    }
    const remaining = table.rows.filter((row) => {
      const value = evaluate(statement.where, this.context(row, null, bind, scope), this, scope);
      return dialect.predicate(value) !== true;
    });
    const changes = table.rows.length - remaining.length;
    table.rows = remaining;
    return { type: 'delete', table: table.name, changes };
  }

  // ------------------------------------------------------------- evaluation

  /**
   * Build an evaluation context.
   *
   * `source` is the row scope visible here and `outer` links to the context of
   * an enclosing statement, which is how correlated subqueries resolve names
   * that their own FROM clause does not define.
   */
  context(row, group, bind, source = null, outer = null) {
    return { row, group, bind, engine: this, source, outer };
  }

  /**
   * Evaluate an expression tree.
   * @param {object} expr
   * @param {{row: object|null, group: object[]|null, bind: Function}} context
   * @param {object|null} source scope produced by buildSource or tableScope
   */
  evaluate(expr, context, source) {
    return evaluate(expr, context, this, source);
  }
}

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------

function groupRows(rows, groupBy, engine, bind, table, outer = null) {
  const groupsByKey = new Map();
  for (const row of rows) {
    const values = groupBy.map((expr) => evaluate(expr, engine.context(row, null, bind, table, outer), engine, table));
    const key = values.map(valueKey).join('\u0000');
    if (!groupsByKey.has(key)) groupsByKey.set(key, []);
    groupsByKey.get(key).push(row);
  }
  return [...groupsByKey.values()];
}

function distinctRecords(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const key = Object.keys(entry.record).map((name) => valueKey(entry.record[name])).join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function compareSortKeys(a, b, items, dialect) {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const left = a[i];
    const right = b[i];
    const nullsFirst = item.nulls ? item.nulls === 'first' : dialect.nullsFirst(item.descending);

    if (left === null || right === null) {
      if (left === right) continue;
      if (left === null) return nullsFirst ? -1 : 1;
      return nullsFirst ? 1 : -1;
    }

    const comparison = dialect.compare(left, right);
    if (comparison !== 0) return item.descending ? -comparison : comparison;
  }
  return 0;
}

function nextRowid(rows, columnKey) {
  let max = 0;
  for (const row of rows) {
    const value = row[columnKey];
    if (typeof value === 'number' && Number.isFinite(value) && value > max) max = value;
  }
  return max + 1;
}

function assertUnique(table, rows, engine) {
  const constraints = [];
  for (const column of table.columns) {
    if (column.primaryKey || column.unique) constraints.push([column.key]);
  }
  for (const composite of table.uniques) constraints.push(composite);

  for (const constraint of constraints) {
    const seen = new Set();
    for (const row of rows) {
      const values = constraint.map((key) => row[key]);
      if (values.some((value) => value === null || value === undefined)) continue;
      const key = values.map(valueKey).join('\u0000');
      if (seen.has(key)) {
        const names = constraint.map((key) => {
          const column = table.columns.find((entry) => entry.key === key);
          return column ? column.name : key;
        });
        throw new SqlError(
          ErrorCodes.UNIQUE_CONSTRAINT,
          `UNIQUE constraint failed on table "${table.name}" for (${names.join(', ')}).`,
          { table: table.name }
        );
      }
      seen.add(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

function evaluate(expr, context, engine, table) {
  const dialect = engine.dialect;

  switch (expr.type) {
    case 'Literal':
      return expr.value;

    case 'Parameter':
      return context.bind(expr);

    case 'Column':
      return resolveColumn(expr, context, table);

    case 'Star':
      throw new SqlError(ErrorCodes.INVALID_QUERY, '"*" is only allowed in a select list or COUNT(*).');

    case 'Unary': {
      const value = evaluate(expr.operand, context, engine, table);
      if (value === null) return null;
      const number = dialect.toNumber(value, expr.op);
      return expr.op === '-' ? -number : number;
    }

    case 'Binary':
      return evaluateBinary(expr, context, engine, table);

    case 'Logical': {
      const left = dialect.predicate(evaluate(expr.left, context, engine, table));
      const right = dialect.predicate(evaluate(expr.right, context, engine, table));
      return expr.op === 'AND' ? sqlAnd(left, right) : sqlOr(left, right);
    }

    case 'Not':
      return sqlNot(dialect.predicate(evaluate(expr.operand, context, engine, table)));

    case 'Is': {
      const value = evaluate(expr.operand, context, engine, table);
      let result;
      if (expr.value === null) {
        result = value === null;
      } else {
        const predicate = value === null ? null : dialect.predicate(value);
        result = predicate === expr.value;
      }
      return expr.negated ? !result : result;
    }

    case 'Case': {
      if (expr.operand) {
        const subject = evaluate(expr.operand, context, engine, table);
        for (const branch of expr.branches) {
          const candidate = evaluate(branch.when, context, engine, table);
          if (subject === null || candidate === null) continue;
          if (dialect.compare(subject, candidate) === 0) {
            return evaluate(branch.then, context, engine, table);
          }
        }
      } else {
        for (const branch of expr.branches) {
          if (dialect.predicate(evaluate(branch.when, context, engine, table)) === true) {
            return evaluate(branch.then, context, engine, table);
          }
        }
      }
      return expr.else ? evaluate(expr.else, context, engine, table) : null;
    }

    case 'Cast':
      return dialect.castValue(evaluate(expr.operand, context, engine, table), expr.targetType);

    case 'Subquery': {
      const result = engine.select(expr.select, context.bind, context);
      if (result.columns.length !== 1) {
        throw new SqlError(
          ErrorCodes.INVALID_QUERY,
          'A subquery used as an expression must return exactly one column.'
        );
      }
      if (result.rows.length > 1) {
        throw new SqlError(
          ErrorCodes.INVALID_QUERY,
          'A subquery used as an expression must return at most one row.'
        );
      }
      if (result.rows.length === 0) return null;
      return result.rows[0][result.columns[0]] ?? null;
    }

    case 'Exists': {
      const result = engine.select(expr.select, context.bind, context);
      return result.rows.length > 0;
    }

    case 'In': {
      const value = evaluate(expr.operand, context, engine, table);
      if (value === null) return null;
      let candidates;
      if (expr.subquery) {
        const result = engine.select(expr.subquery, context.bind, context);
        if (result.columns.length !== 1) {
          throw new SqlError(
            ErrorCodes.INVALID_QUERY,
            'A subquery used with IN must return exactly one column.'
          );
        }
        candidates = result.rows.map((row) => row[result.columns[0]] ?? null);
      } else {
        candidates = expr.list.map((item) => evaluate(item, context, engine, table));
      }
      let sawNull = false;
      let matched = false;
      for (const candidate of candidates) {
        if (candidate === null) {
          sawNull = true;
          continue;
        }
        if (dialect.compare(value, candidate) === 0) {
          matched = true;
          break;
        }
      }
      if (matched) return !expr.negated;
      if (sawNull) return null;
      return expr.negated;
    }

    case 'Between': {
      const value = evaluate(expr.operand, context, engine, table);
      const low = evaluate(expr.low, context, engine, table);
      const high = evaluate(expr.high, context, engine, table);
      if (value === null || low === null || high === null) return null;
      const within = dialect.compare(value, low) >= 0 && dialect.compare(value, high) <= 0;
      return expr.negated ? !within : within;
    }

    case 'Like': {
      const value = evaluate(expr.operand, context, engine, table);
      const pattern = evaluate(expr.pattern, context, engine, table);
      if (value === null || pattern === null) return null;
      const matched = likeMatch(
        dialect.toTextForLike(value),
        dialect.toTextForLike(pattern),
        dialect.likeCaseInsensitive
      );
      return expr.negated ? !matched : matched;
    }

    case 'Function': {
      if (expr.star || dialect.hasAggregateFunction(expr.name)) {
        return evaluateAggregate(expr, context, engine, table);
      }
      const args = expr.args.map((arg) => evaluate(arg, context, engine, table));
      return evaluateScalar(expr.name, args, dialect);
    }

    default:
      throw new SqlError(ErrorCodes.INVALID_QUERY, `Cannot evaluate expression of type ${expr.type}.`);
  }
}

function evaluateBinary(expr, context, engine, table) {
  const dialect = engine.dialect;
  const left = evaluate(expr.left, context, engine, table);
  const right = evaluate(expr.right, context, engine, table);
  if (left === null || right === null) return null;

  switch (expr.op) {
    case '=':
    case '==':
      return dialect.compare(left, right) === 0;
    case '<>':
    case '!=':
      return dialect.compare(left, right) !== 0;
    case '<':
      return dialect.compare(left, right) < 0;
    case '<=':
      return dialect.compare(left, right) <= 0;
    case '>':
      return dialect.compare(left, right) > 0;
    case '>=':
      return dialect.compare(left, right) >= 0;
    case '||':
      return dialect.toText(left) + dialect.toText(right);
    case '+':
      return dialect.toNumber(left, '+') + dialect.toNumber(right, '+');
    case '-':
      return dialect.toNumber(left, '-') - dialect.toNumber(right, '-');
    case '*':
      return dialect.toNumber(left, '*') * dialect.toNumber(right, '*');
    case '/':
      return divide(dialect, left, right, integerOperands(expr, left, right, table));
    case '%':
      return modulo(dialect, left, right);
    default:
      throw new SqlError(ErrorCodes.INVALID_QUERY, `Unknown operator "${expr.op}".`);
  }
}

function divide(dialect, left, right, integer) {
  const a = dialect.toNumber(left, '/');
  const b = dialect.toNumber(right, '/');
  if (b === 0) {
    if (dialect.zeroDivisionReturnsNull) return null;
    throw new SqlError(ErrorCodes.DIVISION_BY_ZERO, `Division by zero in the ${dialect.name} dialect.`);
  }
  const result = a / b;
  if (dialect.integerDivision && integer) return Math.trunc(result);
  return result;
}

/** Whether both operands of a division are integer-typed. */
function integerOperands(expr, left, right, table) {
  return isIntegerExpression(expr.left, table) && isIntegerExpression(expr.right, table);
}

/** Structural integer check used to pick integer vs real division. */
function isIntegerExpression(expr, table) {
  switch (expr.type) {
    case 'Literal':
      return !expr.real && typeof expr.value === 'number' && Number.isInteger(expr.value);
    case 'Unary':
      return isIntegerExpression(expr.operand, table);
    case 'Column': {
      if (!table) return false;
      const binding = table.bindings.find((entry) => {
        if (entry.key !== expr.name.toLowerCase()) return false;
        return !expr.table || entry.alias === expr.table.toLowerCase();
      });
      return Boolean(binding) && binding.column.type.family === 'integer';
    }
    case 'Binary':
      if (expr.op === '/' || expr.op === '||') return false;
      return isIntegerExpression(expr.left, table) && isIntegerExpression(expr.right, table);
    default:
      // Parameters and function results are not known to be integers.
      return false;
  }
}

function modulo(dialect, left, right) {
  const a = dialect.toNumber(left, '%');
  const b = dialect.toNumber(right, '%');
  if (b === 0) {
    if (dialect.zeroDivisionReturnsNull) return null;
    throw new SqlError(ErrorCodes.DIVISION_BY_ZERO, `Modulo by zero in the ${dialect.name} dialect.`);
  }
  return a % b;
}

/** Sentinel returned when a column name is absent from one row scope. */
const NO_COLUMN = Symbol('no column');

/**
 * Look a column up in a single scope, or return NO_COLUMN.
 * Ambiguous references still raise, because qualification is the fix.
 */
function lookupColumn(expr, context, source) {
  if (!source) return NO_COLUMN;
  const key = expr.name.toLowerCase();
  let candidates = source.bindings.filter((binding) => binding.key === key);

  if (expr.table) {
    const alias = expr.table.toLowerCase();
    if (!source.bindings.some((binding) => binding.alias === alias)) return NO_COLUMN;
    candidates = candidates.filter((binding) => binding.alias === alias);
  }

  if (candidates.length === 0) return NO_COLUMN;
  if (candidates.length > 1) {
    throw new SqlError(
      ErrorCodes.INVALID_QUERY,
      `Column reference "${expr.name}" is ambiguous; qualify it with a table name or alias.`,
      { columnName: expr.name }
    );
  }
  return readBinding(context ? context.row : null, candidates[0]);
}

function resolveColumn(expr, context, source) {
  const value = lookupColumn(expr, context, source);
  if (value !== NO_COLUMN) return value;

  // Correlated subqueries fall back to the enclosing query's scopes.
  for (let scope = context ? context.outer : null; scope; scope = scope.outer) {
    const outerValue = lookupColumn(expr, scope, scope.source);
    if (outerValue !== NO_COLUMN) return outerValue;
  }

  if (expr.table) {
    throw new SqlError(
      ErrorCodes.MISSING_COLUMN,
      `Table or alias "${expr.table}" is not in scope.`,
      { table: expr.table, columnName: expr.name }
    );
  }
  if (!source) {
    throw new SqlError(
      ErrorCodes.MISSING_COLUMN,
      `Column "${expr.name}" cannot be used without a FROM clause.`,
      { columnName: expr.name }
    );
  }
  const aliases = [...new Set(source.bindings.map((binding) => binding.alias))];
  const where = aliases.length === 1 ? `Table "${aliases[0]}"` : 'The FROM clause';
  throw new SqlError(
    ErrorCodes.MISSING_COLUMN,
    `${where} has no column named "${expr.name}".`,
    { columnName: expr.name }
  );
}

/** Read the value of a source binding from a merged row. */
function readBinding(row, binding) {
  if (!row) return null;
  const value = row[binding.slot];
  return value === undefined ? null : value;
}

/** Wrap a single table as a row source for INSERT/UPDATE/DELETE expressions. */
function tableScope(table) {
  const alias = table.name.toLowerCase();
  const bindings = table.columns.map((column) => ({
    column,
    key: column.key,
    name: column.name,
    alias,
    slot: column.key,
    outputName: column.name
  }));
  return { sources: [{ table, alias, label: table.name, bindings }], bindings };
}

function evaluateAggregate(expr, context, engine, table) {
  const dialect = engine.dialect;
  const group = context.group;
  if (!group) {
    throw new SqlError(
      ErrorCodes.INVALID_QUERY,
      `Aggregate function ${expr.name} is not available in this context.`
    );
  }
  if (expr.star) {
    if (expr.name !== 'COUNT') {
      throw new SqlError(ErrorCodes.INVALID_QUERY, `Only COUNT accepts "*" as an argument.`);
    }
    return group.length;
  }

  const args = expr.args;
  const values = group.map((row) => evaluate(args[0], engine.context(row, null, context.bind, table, context), engine, table));

  switch (expr.name) {
    case 'COUNT':
      return values.filter((value) => value !== null).length;
    case 'SUM':
    case 'AVG': {
      const numbers = values.filter((value) => value !== null).map((value) => dialect.toNumber(value, expr.name));
      if (numbers.length === 0) return null;
      const sum = numbers.reduce((total, value) => total + value, 0);
      return expr.name === 'SUM' ? sum : sum / numbers.length;
    }
    case 'MIN':
    case 'MAX': {
      const present = values.filter((value) => value !== null);
      if (present.length === 0) return null;
      let best = present[0];
      for (const value of present.slice(1)) {
        const comparison = dialect.compare(value, best);
        if (expr.name === 'MIN' ? comparison < 0 : comparison > 0) best = value;
      }
      return best;
    }
    default:
      throw new SqlError(ErrorCodes.UNSUPPORTED, `Unknown aggregate function ${expr.name}.`);
  }
}

function evaluateScalar(name, args, dialect) {
  const first = args.length > 0 ? args[0] : null;
  switch (name) {
    case 'COALESCE':
    case 'IFNULL': {
      for (const value of args) {
        if (value !== null) return value;
      }
      return null;
    }
    case 'ABS':
      if (first === null) return null;
      return Math.abs(dialect.toNumber(first, 'ABS'));
    case 'LOWER':
      if (first === null) return null;
      return dialect.toTextForLike(first).toLowerCase();
    case 'UPPER':
      if (first === null) return null;
      return dialect.toTextForLike(first).toUpperCase();
    case 'LENGTH':
    case 'CHAR_LENGTH':
      if (first === null) return null;
      return [...dialect.toTextForLike(first)].length;
    case 'ROUND': {
      if (first === null) return null;
      const value = dialect.toNumber(first, 'ROUND');
      const digits = args.length > 1 && args[1] !== null ? dialect.toNumber(args[1], 'ROUND') : 0;
      if (!Number.isInteger(digits) || digits < 0) {
        throw new SqlError(ErrorCodes.TYPE_ERROR, 'ROUND precision must be a non-negative integer.');
      }
      const factor = 10 ** digits;
      return Math.round(value * factor) / factor;
    }
    case 'CONCAT': {
      let out = '';
      for (const value of args) {
        if (value === null) return null;
        out += dialect.toText(value);
      }
      return out;
    }
    case 'TYPEOF': {
      if (first === null) return 'null';
      if (typeof first === 'string') return 'text';
      if (typeof first === 'boolean') return 'integer';
      return Number.isInteger(first) ? 'integer' : 'real';
    }
    default:
      throw new SqlError(ErrorCodes.UNSUPPORTED, `Unknown function ${name}.`);
  }
}

/**
 * Resolve a GROUP BY / HAVING / ORDER BY expression, accepting select-list
 * ordinals (`ORDER BY 2 DESC`) in addition to output aliases.
 */
function resolveOutputExpression(expr, selectItems) {
  if (expr && expr.type === 'Literal' && typeof expr.value === 'number' && !expr.real) {
    const position = expr.value;
    if (Number.isInteger(position) && position >= 1 && position <= selectItems.length) {
      const item = selectItems[position - 1];
      if (item.expr.type !== 'Star') return item.expr;
    }
    return expr;
  }
  return resolveAliases(expr, selectItems);
}

/**
 * Replace bare output aliases with their expressions. Used by GROUP BY,
 * HAVING and ORDER BY so `ORDER BY total` and `HAVING total > 10` work.
 */
function resolveAliases(expr, selectItems) {
  if (!expr || typeof expr !== 'object') return expr;
  if (expr.type === 'Column' && !expr.table) {
    const name = expr.name.toLowerCase();
    const match = selectItems.find((item) => {
      if (item.expr.type === 'Star') return false;
      return String(item.alias || item.name).toLowerCase() === name;
    });
    return match ? match.expr : expr;
  }
  if (
    expr.type === 'Star' ||
    expr.type === 'Literal' ||
    expr.type === 'Parameter' ||
    expr.type === 'Subquery' ||
    expr.type === 'Exists'
  ) {
    return expr;
  }

  const copy = { ...expr };
  for (const key of Object.keys(copy)) {
    const value = copy[key];
    if (Array.isArray(value)) {
      copy[key] = value.map((entry) => (entry && typeof entry === 'object' ? resolveAliases(entry, selectItems) : entry));
    } else if (value && typeof value === 'object') {
      copy[key] = resolveAliases(value, selectItems);
    }
  }
  return copy;
}

function containsColumnReference(expr) {
  if (!expr || typeof expr !== 'object') return false;
  if (expr.type === 'Column') return true;
  return childNodes(expr).some(containsColumnReference);
}

function containsParameter(expr) {
  if (!expr || typeof expr !== 'object') return false;
  if (expr.type === 'Parameter') return true;
  return childNodes(expr).some(containsParameter);
}

function childNodes(node) {
  const children = [];
  for (const key of Object.keys(node)) {
    if (key === 'type') continue;
    const value = node[key];
    if (Array.isArray(value)) children.push(...value);
    else if (value && typeof value === 'object') children.push(value);
  }
  return children;
}
