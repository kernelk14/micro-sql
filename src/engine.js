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
    /** @type {Map<string, object>|null} tables captured at BEGIN */
    this.transactionSnapshot = null;
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
    return { type: 'drop', changes: 0, table: statement.table };
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
    const dialect = this.dialect;
    const source = this.buildSource(statement.from, statement.joins, bind);

    let filtered;
    if (!source) {
      filtered = [null];
    } else if (statement.where) {
      filtered = source.rows.filter((row) => {
        const value = evaluate(statement.where, this.context(row, null, bind), this, source);
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
        const groupExprs = statement.groupBy.map((expr) => resolveAliases(expr, selectItems));
        groups = groupRows(filtered, groupExprs, this, bind, source);
      }
      contexts = groups.map((group) => ({ row: group.length > 0 ? group[0] : null, group }));
    } else {
      contexts = filtered.map((row) => ({ row, group: null }));
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
        const having = resolveAliases(statement.having, selectItems);
        const value = evaluate(having, this.context(context.row, context.group, bind), this, source);
        if (dialect.predicate(value) !== true) continue;
      }
      const record = {};
      for (const item of outputItems) {
        if (item.binding) {
          record[item.name] = readBinding(context.row, item.binding);
        } else {
          record[item.name] = evaluate(item.expr, this.context(context.row, context.group, bind), this, source);
        }
      }
      projected.push({ record, context });
    }

    let results = statement.distinct ? distinctRecords(projected) : projected;

    if (statement.orderBy.length > 0) {
      const keys = statement.orderBy.map((item) => resolveAliases(item.expr, statement.columns));
      const decorated = results.map((entry) => ({
        entry,
        sortKeys: keys.map((expr) => evaluate(expr, this.context(entry.context.row, entry.context.group, bind), this, source))
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
      type: 'select',
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
   * @param {{kind: 'inner'|'left', table: string, alias: string|null, on: object}[]} joins
   * @param {(token: object) => unknown} bind
   */
  buildSource(from, joins, bind) {
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
      const merged = [];
      for (const left of rows) {
        let matched = false;
        for (const right of rightRows) {
          const combined = { ...left, ...right };
          const visible = sources.slice(0, i + 2).flatMap((entry) => entry.bindings);
          const value = evaluate(join.on, this.context(combined, null, bind), this, { bindings: visible });
          if (this.dialect.predicate(value) === true) {
            merged.push(combined);
            matched = true;
          }
        }
        if (!matched && join.kind === 'left') merged.push({ ...left, ...emptyRight });
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
    return { type: 'begin', changes: 0 };
  }

  executeCommit() {
    if (!this.transactionSnapshot) {
      throw new SqlError(ErrorCodes.INVALID_QUERY, 'COMMIT without an active transaction.');
    }
    this.transactionSnapshot = null;
    return { type: 'commit', changes: 0 };
  }

  executeRollback() {
    if (!this.transactionSnapshot) {
      throw new SqlError(ErrorCodes.INVALID_QUERY, 'ROLLBACK without an active transaction.');
    }
    this.tables = this.transactionSnapshot;
    this.transactionSnapshot = null;
    return { type: 'rollback', changes: 0 };
  }

  snapshotTables() {
    const copy = new Map();
    for (const [key, table] of this.tables) {
      copy.set(key, {
        ...table,
        columns: table.columns.slice(),
        rows: table.rows.slice(),
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
        row[key] = evaluate(valueExprs[index], this.context(null, null, bind), this, scope);
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
        const value = evaluate(statement.where, this.context(row, null, bind), this, scope);
        if (dialect.predicate(value) !== true) return row;
      }
      const updated = { ...row };
      for (const assignment of assignments) {
        const column = table.columns.find((entry) => entry.key === assignment.key);
        const raw = evaluate(assignment.expr, this.context(row, null, bind), this, scope);
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
      const value = evaluate(statement.where, this.context(row, null, bind), this, scope);
      return dialect.predicate(value) !== true;
    });
    const changes = table.rows.length - remaining.length;
    table.rows = remaining;
    return { type: 'delete', table: table.name, changes };
  }

  // ------------------------------------------------------------- evaluation

  context(row, group, bind) {
    return { row, group, bind, engine: this };
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

function groupRows(rows, groupBy, engine, bind, table) {
  const groupsByKey = new Map();
  for (const row of rows) {
    const values = groupBy.map((expr) => evaluate(expr, engine.context(row, null, bind), engine, table));
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

    case 'In': {
      const value = evaluate(expr.operand, context, engine, table);
      if (value === null) return null;
      let sawNull = false;
      let matched = false;
      for (const item of expr.list) {
        const candidate = evaluate(item, context, engine, table);
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

function resolveColumn(expr, context, source) {
  if (!source) {
    throw new SqlError(
      ErrorCodes.MISSING_COLUMN,
      `Column "${expr.name}" cannot be used without a FROM clause.`,
      { columnName: expr.name }
    );
  }
  const key = expr.name.toLowerCase();
  let candidates = source.bindings.filter((binding) => binding.key === key);

  if (expr.table) {
    const alias = expr.table.toLowerCase();
    if (!source.bindings.some((binding) => binding.alias === alias)) {
      throw new SqlError(
        ErrorCodes.MISSING_COLUMN,
        `Table or alias "${expr.table}" is not in scope.`,
        { table: expr.table, columnName: expr.name }
      );
    }
    candidates = candidates.filter((binding) => binding.alias === alias);
  }

  if (candidates.length === 0) {
    const aliases = [...new Set(source.bindings.map((binding) => binding.alias))];
    const where = aliases.length === 1 ? `Table "${aliases[0]}"` : 'The FROM clause';
    throw new SqlError(
      ErrorCodes.MISSING_COLUMN,
      `${where} has no column named "${expr.name}".`,
      { columnName: expr.name }
    );
  }
  if (candidates.length > 1) {
    throw new SqlError(
      ErrorCodes.INVALID_QUERY,
      `Column reference "${expr.name}" is ambiguous; qualify it with a table name or alias.`,
      { columnName: expr.name }
    );
  }

  return readBinding(context.row, candidates[0]);
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
  const values = group.map((row) => evaluate(args[0], engine.context(row, null, context.bind), engine, table));

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
  if (expr.type === 'Star' || expr.type === 'Literal' || expr.type === 'Parameter') return expr;

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
