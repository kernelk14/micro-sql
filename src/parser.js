import { syntaxError, unsupported } from './errors.js';
import { tokenize } from './tokenizer.js';

/**
 * @typedef {import('./tokenizer.js').Token} Token
 * @typedef {import('./dialects/base.js').BaseDialect} BaseDialect
 */

/** Words that may appear inside a multi-word type name. */
const TYPE_CONTINUATIONS = new Set(['PRECISION', 'VARYING']);

const COMPARISON_OPERATORS = new Set(['=', '==', '<', '>', '<=', '>=', '<>', '!=']);

/**
 * Recursive-descent parser for the SQL subset supported by this library.
 *
 * The parser is shared by every dialect; behaviour that differs between
 * dialects (operator support, LIMIT forms, NULLS ordering, type names) is
 * driven by the dialect record passed to the constructor.
 */
export class Parser {
  /**
   * @param {string} sql
   * @param {BaseDialect} dialect
   */
  constructor(sql, dialect) {
    this.sql = sql;
    this.dialect = dialect;
    this.tokens = tokenize(sql, dialect);
    this.position = 0;
  }

  /**
   * Parse every statement in the source text.
   * @returns {object[]}
   */
  parseStatements() {
    const statements = [];
    this.skipSemicolons();
    while (!this.atEnd()) {
      statements.push(this.parseStatement());
      if (this.matchPunctuation(';')) {
        this.skipSemicolons();
      } else if (!this.atEnd()) {
        throw this.unexpected('Expected ";" or end of input');
      }
    }
    return statements;
  }

  /** Parse exactly one statement. */
  parseSingle() {
    this.skipSemicolons();
    if (this.atEnd()) {
      throw syntaxError('Empty SQL statement', this.peek(), this.sql);
    }
    const statement = this.parseStatement();
    this.skipSemicolons();
    if (!this.atEnd()) {
      throw this.unexpected('Only a single statement is allowed here');
    }
    return statement;
  }

  parseStatement() {
    const token = this.peek();
    if (token.type !== 'keyword') {
      throw this.unexpected('Expected a statement (SELECT, INSERT, UPDATE, DELETE, CREATE or DROP)');
    }
    switch (token.value) {
      case 'SELECT':
        return this.parseSelect();
      case 'INSERT':
        return this.parseInsert();
      case 'UPDATE':
        return this.parseUpdate();
      case 'DELETE':
        return this.parseDelete();
      case 'CREATE':
        return this.parseCreateTable();
      case 'DROP':
        return this.parseDropTable();
      case 'BEGIN':
        return this.parseBegin();
      case 'COMMIT':
        return this.parseCommit();
      case 'ROLLBACK':
        return this.parseRollback();
      default:
        throw this.unexpected(`Unsupported statement "${token.value}"`);
    }
  }

  // ----------------------------------------------------------------- SELECT

  parseSelect() {
    const start = this.expectKeyword('SELECT').start;
    let distinct = false;
    if (this.matchKeyword('DISTINCT')) distinct = true;
    else this.matchKeyword('ALL');

    const columns = [];
    do {
      columns.push(this.parseSelectItem());
    } while (this.matchPunctuation(','));

    let from = null;
    const joins = [];
    if (this.matchKeyword('FROM')) {
      from = this.parseTableRef();
      this.parseJoins(joins);
    }

    let where = null;
    if (this.matchKeyword('WHERE')) where = this.parseExpression();

    const groupBy = [];
    if (this.matchKeyword('GROUP')) {
      this.expectKeyword('BY');
      do {
        groupBy.push(this.parseExpression());
      } while (this.matchPunctuation(','));
    }

    let having = null;
    if (this.matchKeyword('HAVING')) having = this.parseExpression();

    const orderBy = [];
    if (this.matchKeyword('ORDER')) {
      this.expectKeyword('BY');
      do {
        orderBy.push(this.parseOrderItem());
      } while (this.matchPunctuation(','));
    }

    const { limit, offset } = this.parseLimitAndOffset();

    return {
      type: 'Select',
      distinct,
      columns,
      from,
      joins,
      where,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
      start
    };
  }

  parseSelectItem() {
    if (this.matchOperator('*')) {
      return { expr: { type: 'Star' }, alias: null, name: '*' };
    }
    const { expr, text } = this.parseExpressionWithText();
    let alias = null;
    if (this.matchKeyword('AS')) {
      const aliasToken = this.expectAlias('Expected a column alias after AS');
      // Keyword tokens are upper-cased; keep the alias as the user wrote it.
      alias = aliasToken.type === 'keyword' ? aliasToken.raw : aliasToken.value;
    } else if (this.isBareAlias()) {
      alias = this.next().value;
    }
    return { expr, alias, name: alias || defaultColumnName(expr, text) };
  }

  parseOrderItem() {
    const expr = this.parseExpression();
    let descending = false;
    if (this.matchKeyword('ASC')) descending = false;
    else if (this.matchKeyword('DESC')) descending = true;

    let nulls = null;
    if (this.matchKeyword('NULLS')) {
      if (!this.dialect.supportsNullsOrdering) {
        throw unsupported(`The ${this.dialect.name} dialect does not support explicit NULLS ordering.`);
      }
      if (this.matchKeyword('FIRST')) nulls = 'first';
      else if (this.matchKeyword('LAST')) nulls = 'last';
      else throw this.unexpected('Expected FIRST or LAST after NULLS');
    }
    return { expr, descending, nulls };
  }

  parseLimitAndOffset() {
    let limit = null;
    let offset = null;
    if (this.matchKeyword('LIMIT')) {
      const first = this.parseLimitValue();
      if (this.dialect.supportsLimitComma && this.matchPunctuation(',')) {
        if (!this.dialect.supportsLimitComma) {
          throw unsupported(`The ${this.dialect.name} dialect does not support "LIMIT offset, count".`);
        }
        offset = first;
        limit = this.parseLimitValue();
      } else {
        limit = first;
      }
    }
    if (this.matchKeyword('OFFSET')) {
      if (limit === null && !this.dialect.supportsOffsetWithoutLimit) {
        throw unsupported(`The ${this.dialect.name} dialect requires LIMIT before OFFSET.`);
      }
      offset = this.parseLimitValue();
    }
    return { limit, offset };
  }

  parseLimitValue() {
    if (this.peek().type === 'parameter') return this.parsePrimary();
    const token = this.peek();
    if (token.type === 'number') {
      if (!Number.isSafeInteger(token.value) || token.value < 0) {
        throw syntaxError('LIMIT and OFFSET require a non-negative integer', token, this.sql);
      }
      this.next();
      return { type: 'Literal', value: token.value };
    }
    throw this.unexpected('Expected a non-negative integer or parameter');
  }

  // ----------------------------------------------------------------- INSERT

  parseInsert() {
    this.expectKeyword('INSERT');
    this.expectKeyword('INTO');
    const table = this.parseObjectName();

    const columns = [];
    if (this.matchPunctuation('(')) {
      do {
        columns.push(this.expectIdentifier('Expected a column name').value);
      } while (this.matchPunctuation(','));
      this.expectPunctuation(')');
    }

    this.expectKeyword('VALUES');
    const rows = [];
    do {
      this.expectPunctuation('(');
      const values = [];
      do {
        values.push(this.parseExpression());
      } while (this.matchPunctuation(','));
      this.expectPunctuation(')');
      rows.push(values);
    } while (this.matchPunctuation(','));

    return { type: 'Insert', table, columns, rows };
  }

  // ----------------------------------------------------------------- UPDATE

  parseUpdate() {
    this.expectKeyword('UPDATE');
    const table = this.parseObjectName();
    this.expectKeyword('SET');
    const assignments = [];
    do {
      const column = this.expectIdentifier('Expected a column name to assign').value;
      this.expectOperator('=');
      assignments.push({ column, expr: this.parseExpression() });
    } while (this.matchPunctuation(','));
    let where = null;
    if (this.matchKeyword('WHERE')) where = this.parseExpression();
    return { type: 'Update', table, assignments, where };
  }

  // ----------------------------------------------------------------- DELETE

  parseDelete() {
    this.expectKeyword('DELETE');
    this.expectKeyword('FROM');
    const table = this.parseObjectName();
    let where = null;
    if (this.matchKeyword('WHERE')) where = this.parseExpression();
    return { type: 'Delete', table, where };
  }

  // --------------------------------------------------------------- JOIN / FROM

  parseTableRef() {
    const table = this.parseObjectName();
    let alias = null;
    if (this.matchKeyword('AS')) {
      const aliasToken = this.expectAlias('Expected a table alias after AS');
      alias = aliasToken.type === 'keyword' ? aliasToken.raw : aliasToken.value;
    } else if (this.peek().type === 'identifier') {
      alias = String(this.next().value);
    }
    return { table, alias };
  }

  parseJoins(joins) {
    for (;;) {
      const token = this.peek();
      if (token.type !== 'keyword') return;

      if (token.value === 'RIGHT' || token.value === 'FULL' || token.value === 'CROSS') {
        throw unsupported(`${token.value} JOIN is not supported; use INNER JOIN or LEFT JOIN.`);
      }

      let kind = null;
      if (token.value === 'JOIN') {
        this.next();
        kind = 'inner';
      } else if (token.value === 'INNER') {
        this.next();
        this.expectKeyword('JOIN');
        kind = 'inner';
      } else if (token.value === 'LEFT') {
        this.next();
        this.matchKeyword('OUTER');
        this.expectKeyword('JOIN');
        kind = 'left';
      }
      if (!kind) return;

      const ref = this.parseTableRef();
      if (this.peek().type === 'keyword' && this.peek().value === 'USING') {
        throw unsupported('JOIN ... USING is not supported; write an ON condition instead.');
      }
      this.expectKeyword('ON');
      joins.push({ kind, table: ref.table, alias: ref.alias, on: this.parseExpression() });
    }
  }

  // ----------------------------------------------------------- CREATE TABLE

  parseCreateTable() {
    this.expectKeyword('CREATE');
    this.expectKeyword('TABLE');
    let ifNotExists = false;
    if (this.matchKeyword('IF')) {
      this.expectKeyword('NOT');
      this.expectKeyword('EXISTS');
      ifNotExists = true;
    }
    const table = this.parseObjectName();
    this.expectPunctuation('(');

    const columns = [];
    const primaryKey = [];
    const uniques = [];
    let primaryKeySeen = false;

    do {
      this.skipConstraintName();
      if (this.peek().type === 'keyword' && this.peek().value === 'PRIMARY') {
        if (primaryKeySeen) throw this.unexpected('Table has more than one PRIMARY KEY');
        this.expectKeyword('PRIMARY');
        this.expectKeyword('KEY');
        this.expectPunctuation('(');
        do {
          primaryKey.push(this.expectIdentifier('Expected a column name').value);
        } while (this.matchPunctuation(','));
        this.expectPunctuation(')');
        primaryKeySeen = true;
        continue;
      }
      if (this.peek().type === 'keyword' && this.peek().value === 'UNIQUE') {
        this.expectKeyword('UNIQUE');
        this.expectPunctuation('(');
        const columnsInConstraint = [];
        do {
          columnsInConstraint.push(this.expectIdentifier('Expected a column name').value);
        } while (this.matchPunctuation(','));
        this.expectPunctuation(')');
        uniques.push(columnsInConstraint);
        continue;
      }
      columns.push(this.parseColumnDefinition());
    } while (this.matchPunctuation(','));

    this.expectPunctuation(')');

    if (primaryKeySeen) {
      for (const column of columns) {
        column.primaryKey = primaryKey.some((name) => name.toLowerCase() === column.name.toLowerCase());
        if (column.primaryKey) column.notNull = true;
      }
      if (columns.every((column) => !column.primaryKey)) {
        throw this.unexpected('PRIMARY KEY refers to an unknown column');
      }
    }

    return { type: 'CreateTable', table, ifNotExists, columns, primaryKey, uniques };
  }

  parseColumnDefinition() {
    const nameToken = this.expectIdentifier('Expected a column name');
    const type = this.parseTypeName();
    const column = {
      name: nameToken.value,
      type: type.name,
      args: type.args,
      notNull: false,
      primaryKey: false,
      unique: false,
      autoIncrement: false,
      defaultExpr: null
    };

    for (;;) {
      this.skipConstraintName();
      if (this.matchKeyword('PRIMARY')) {
        this.expectKeyword('KEY');
        if (column.primaryKey) throw this.unexpected('Duplicate PRIMARY KEY on column');
        column.primaryKey = true;
        column.notNull = true;
        if (this.peek().type === 'keyword' && this.dialect.autoIncrementKeywords.includes(this.peek().value)) {
          this.next();
          column.autoIncrement = true;
        }
        continue;
      }
      if (this.matchKeyword('NOT')) {
        this.expectKeyword('NULL');
        column.notNull = true;
        continue;
      }
      if (this.matchKeyword('NULL')) {
        column.notNull = false;
        continue;
      }
      if (this.matchKeyword('UNIQUE')) {
        column.unique = true;
        continue;
      }
      if (this.matchKeyword('DEFAULT')) {
        column.defaultExpr = this.parseExpression();
        continue;
      }
      break;
    }
    return column;
  }

  parseTypeName() {
    const words = [];
    const first = this.peek();
    if (first.type !== 'identifier' && !TYPE_CONTINUATIONS.has(first.value)) {
      throw this.unexpected('Expected a column type');
    }
    words.push(String(this.next().value));
    while (this.peek().type === 'identifier' || TYPE_CONTINUATIONS.has(this.peek().value)) {
      words.push(String(this.next().value));
    }
    let args = [];
    if (this.matchPunctuation('(')) {
      do {
        const token = this.peek();
        if (token.type !== 'number' || !Number.isSafeInteger(token.value) || token.value < 0) {
          throw this.unexpected('Type arguments must be non-negative integers');
        }
        args.push(token.value);
        this.next();
      } while (this.matchPunctuation(','));
      this.expectPunctuation(')');
    }
    return { name: words.join(' '), args };
  }

  skipConstraintName() {
    if (this.peek().type === 'keyword' && this.peek().value === 'CONSTRAINT') {
      this.next();
      this.expectIdentifier('Expected a constraint name');
    }
  }

  // --------------------------------------------------------- TRANSACTIONS

  parseBegin() {
    this.expectKeyword('BEGIN');
    this.matchKeyword('TRANSACTION');
    return { type: 'Begin' };
  }

  parseCommit() {
    this.expectKeyword('COMMIT');
    this.matchKeyword('TRANSACTION');
    return { type: 'Commit' };
  }

  parseRollback() {
    this.expectKeyword('ROLLBACK');
    this.matchKeyword('TRANSACTION');
    return { type: 'Rollback' };
  }

  // ------------------------------------------------------------------- DROP

  parseDropTable() {
    this.expectKeyword('DROP');
    this.expectKeyword('TABLE');
    let ifExists = false;
    if (this.matchKeyword('IF')) {
      this.expectKeyword('EXISTS');
      ifExists = true;
    }
    const table = this.parseObjectName();
    return { type: 'DropTable', table, ifExists };
  }

  // ------------------------------------------------------------ expressions

  /** Parse an expression and also return its source text. */
  parseExpressionWithText() {
    const startToken = this.peek();
    const expr = this.parseExpression();
    const endToken = this.tokens[Math.max(0, this.position - 1)];
    const text = this.sql.slice(startToken.start, endToken.end).trim();
    return { expr, text };
  }

  parseExpression() {
    return this.parseOr();
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.matchKeyword('OR')) {
      left = { type: 'Logical', op: 'OR', left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.matchKeyword('AND')) {
      left = { type: 'Logical', op: 'AND', left, right: this.parseNot() };
    }
    return left;
  }

  parseNot() {
    if (this.matchKeyword('NOT')) {
      return { type: 'Not', operand: this.parseNot() };
    }
    return this.parseComparison();
  }

  parseComparison() {
    let left = this.parseAdditive();
    for (;;) {
      if (this.matchKeyword('IS')) {
        const negated = this.matchKeyword('NOT');
        const token = this.peek();
        if (token.type === 'keyword' && token.value === 'NULL') {
          this.next();
          left = { type: 'Is', operand: left, negated, value: null };
          continue;
        }
        if (token.type === 'keyword' && (token.value === 'TRUE' || token.value === 'FALSE')) {
          this.next();
          left = { type: 'Is', operand: left, negated, value: token.value === 'TRUE' };
          continue;
        }
        throw this.unexpected('Expected NULL, TRUE or FALSE after IS');
      }

      const negated = this.isNegatedInfix();
      if (negated) this.next();

      if (this.matchKeyword('IN')) {
        this.expectPunctuation('(');
        if (this.matchPunctuation(')')) {
          throw this.unexpected('IN requires at least one value');
        }
        const list = [];
        do {
          list.push(this.parseExpression());
        } while (this.matchPunctuation(','));
        this.expectPunctuation(')');
        left = { type: 'In', operand: left, negated, list };
        continue;
      }

      if (this.matchKeyword('LIKE')) {
        left = { type: 'Like', operand: left, negated, pattern: this.parseAdditive() };
        continue;
      }

      if (this.matchKeyword('BETWEEN')) {
        const low = this.parseAdditive();
        this.expectKeyword('AND');
        const high = this.parseAdditive();
        left = { type: 'Between', operand: left, negated, low, high };
        continue;
      }

      if (negated) {
        throw this.unexpected('Expected IN, LIKE or BETWEEN after NOT');
      }

      const token = this.peek();
      if (token.type === 'operator' && COMPARISON_OPERATORS.has(token.value)) {
        this.next();
        left = { type: 'Binary', op: token.value, left, right: this.parseAdditive() };
        continue;
      }
      return left;
    }
  }

  isNegatedInfix() {
    if (this.peek().type !== 'keyword' || this.peek().value !== 'NOT') return false;
    const next = this.tokens[this.position + 1];
    return Boolean(next) && next.type === 'keyword' && (next.value === 'IN' || next.value === 'LIKE' || next.value === 'BETWEEN');
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    for (;;) {
      const token = this.peek();
      if (token.type === 'operator' && (token.value === '+' || token.value === '-')) {
        this.next();
        left = { type: 'Binary', op: token.value, left, right: this.parseMultiplicative() };
        continue;
      }
      return left;
    }
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token.type === 'operator' && (token.value === '*' || token.value === '/' || token.value === '%')) {
        this.next();
        left = { type: 'Binary', op: token.value, left, right: this.parseUnary() };
        continue;
      }
      if (token.type === 'operator' && token.value === '||') {
        this.next();
        left = { type: 'Binary', op: '||', left, right: this.parseUnary() };
        continue;
      }
      return left;
    }
  }

  parseUnary() {
    const token = this.peek();
    if (token.type === 'operator' && (token.value === '-' || token.value === '+')) {
      this.next();
      return { type: 'Unary', op: token.value, operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.peek();

    if (token.type === 'number') {
      this.next();
      // Track real literals so `7.0 / 2` is float division even though the
      // runtime value is the integer 7.
      return { type: 'Literal', value: token.value, real: /[.eE]/.test(token.raw) };
    }

    if (token.type === 'string') {
      this.next();
      return { type: 'Literal', value: token.value };
    }

    if (token.type === 'parameter') {
      this.next();
      return {
        type: 'Parameter',
        style: token.style,
        index: token.index,
        name: token.name,
        prefix: token.prefix
      };
    }

    if (token.type === 'keyword') {
      if (token.value === 'NULL') {
        this.next();
        return { type: 'Literal', value: null };
      }
      if (token.value === 'TRUE' || token.value === 'FALSE') {
        this.next();
        return { type: 'Literal', value: token.value === 'TRUE' };
      }
      throw this.unexpected(`Unexpected keyword "${token.value}"`);
    }

    if (token.type === 'punctuation' && token.value === '(') {
      this.next();
      const expr = this.parseExpression();
      this.expectPunctuation(')');
      return expr;
    }

    if (token.type === 'identifier') {
      this.next();
      if (this.matchPunctuation('(')) {
        return this.parseFunctionCall(token);
      }
      if (this.matchPunctuation('.')) {
        if (this.matchOperator('*')) return { type: 'Star', table: String(token.value) };
        const name = this.expectIdentifier('Expected a column name after "."');
        return { type: 'Column', table: token.value, name: name.value };
      }
      return { type: 'Column', table: null, name: token.value };
    }

    throw this.unexpected('Expected an expression');
  }

  parseFunctionCall(nameToken) {
    const name = String(nameToken.value);
    const upper = name.toUpperCase();
    const dialect = this.dialect;

    if (this.matchOperator('*')) {
      this.expectPunctuation(')');
      if (!dialect.hasAggregateFunction(upper)) {
        throw unsupported(`Function ${upper} does not accept "*".`);
      }
      return { type: 'Function', name: upper, args: [], star: true };
    }

    const args = [];
    if (!this.matchPunctuation(')')) {
      do {
        args.push(this.parseExpression());
      } while (this.matchPunctuation(','));
      this.expectPunctuation(')');
    }

    const isAggregate = dialect.hasAggregateFunction(upper);
    const scalar = dialect.scalarFunctions.get(upper);
    if (!isAggregate && !scalar) {
      throw unsupported(`Unknown function "${name}" in the ${dialect.name} dialect.`);
    }
    if (isAggregate) {
      if (args.length !== 1) {
        throw syntaxError(`Aggregate function ${upper} takes exactly one argument`, nameToken, this.sql);
      }
      if (containsAggregate(args[0])) {
        throw unsupported('Aggregate functions cannot be nested.');
      }
    } else {
      if (args.length < scalar.min || args.length > scalar.max) {
        const expected = scalar.max === Infinity ? `at least ${scalar.min}` : scalar.min === scalar.max ? `${scalar.min}` : `${scalar.min} to ${scalar.max}`;
        throw syntaxError(`Function ${upper} expects ${expected} argument(s), received ${args.length}`, nameToken, this.sql);
      }
    }
    return { type: 'Function', name: upper, args, star: false, aggregate: isAggregate };
  }

  // -------------------------------------------------------------- utilities

  parseObjectName() {
    const first = this.expectIdentifier('Expected a table name');
    if (this.matchPunctuation('.')) {
      const second = this.expectIdentifier('Expected a table name after "."');
      throw unsupported('Schema-qualified table names are not supported.');
    }
    return first.value;
  }

  peek(offset = 0) {
    const index = Math.min(this.position + offset, this.tokens.length - 1);
    return this.tokens[index];
  }

  next() {
    const token = this.tokens[this.position];
    if (this.position < this.tokens.length - 1) this.position += 1;
    return token;
  }

  atEnd() {
    return this.peek().type === 'eof';
  }

  matchKeyword(word) {
    const token = this.peek();
    if (token.type === 'keyword' && token.value === word) {
      this.next();
      return true;
    }
    return false;
  }

  expectKeyword(word) {
    const token = this.peek();
    if (token.type === 'keyword' && token.value === word) return this.next();
    throw this.unexpected(`Expected ${word}`);
  }

  matchPunctuation(char) {
    const token = this.peek();
    if (token.type === 'punctuation' && token.value === char) {
      this.next();
      return true;
    }
    return false;
  }

  expectPunctuation(char) {
    const token = this.peek();
    if (token.type === 'punctuation' && token.value === char) return this.next();
    throw this.unexpected(`Expected "${char}"`);
  }

  matchOperator(op) {
    const token = this.peek();
    if (token.type === 'operator' && token.value === op) {
      this.next();
      return true;
    }
    return false;
  }

  expectOperator(op) {
    const token = this.peek();
    if (token.type === 'operator' && token.value === op) return this.next();
    throw this.unexpected(`Expected "${op}"`);
  }

  expectIdentifier(message) {
    const token = this.peek();
    if (token.type === 'identifier') return this.next();
    throw this.unexpected(message);
  }

  /**
   * An alias may be a quoted/bare identifier or a non-clause keyword, so
   * `SELECT 1 AS first` and `SELECT 1 AS key` work as in real SQL.
   */
  expectAlias(message) {
    const token = this.peek();
    const clauseKeywords = ['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET'];
    if (token.type === 'identifier') return this.next();
    if (token.type === 'keyword' && !clauseKeywords.includes(token.value)) return this.next();
    throw this.unexpected(message);
  }

  /** True when the current token could be an alias without AS. */
  isBareAlias() {
    if (this.peek().type !== 'identifier') return false;
    const next = this.peek(1);
    if (next.type === 'eof') return true;
    if (next.type === 'punctuation' && (next.value === ',' || next.value === ';' || next.value === ')')) return true;
    return next.type === 'keyword' && [
      'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'ASC', 'DESC', 'NULLS'
    ].includes(next.value);
  }

  skipSemicolons() {
    while (this.matchPunctuation(';')) {
      // Side effects only.
    }
  }

  unexpected(message) {
    return syntaxError(message, this.peek(), this.sql);
  }
}

/**
 * Derive a result column name from an expression.
 * @param {object} expr
 * @param {string} text original source text
 */
export function defaultColumnName(expr, text) {
  if (expr.type === 'Column') return expr.name;
  if (expr.type === 'Function') return expr.name.toLowerCase();
  if (expr.type === 'Literal') return text;
  return text || 'column';
}

/**
 * Whether an expression tree contains an aggregate function call.
 * @param {object|null} expr
 * @returns {boolean}
 */
export function containsAggregate(expr) {
  if (!expr || typeof expr !== 'object') return false;
  switch (expr.type) {
    case 'Function':
      if (expr.star || expr.aggregate) return true;
      return expr.args.some(containsAggregate);
    case 'Binary':
    case 'Logical':
      return containsAggregate(expr.left) || containsAggregate(expr.right);
    case 'Unary':
    case 'Not':
    case 'Is':
      return containsAggregate(expr.operand);
    case 'Like':
      return containsAggregate(expr.operand) || containsAggregate(expr.pattern);
    case 'Between':
      return containsAggregate(expr.operand) || containsAggregate(expr.low) || containsAggregate(expr.high);
    case 'In':
      return containsAggregate(expr.operand) || expr.list.some(containsAggregate);
    default:
      return false;
  }
}

/**
 * Collect every parameter placeholder in a parsed statement, in source order.
 * @param {unknown} node
 * @returns {object[]}
 */
export function collectParameters(node) {
  /** @type {object[]} */
  const found = [];
  /** @param {unknown} value */
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.type === 'Parameter') {
      found.push(value);
      return;
    }
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child && typeof child === 'object') walk(child);
    }
  };
  walk(node);
  return found;
}

/**
 * Parse one statement.
 * @param {string} sql
 * @param {BaseDialect} dialect
 */
export function parse(sql, dialect) {
  return new Parser(sql, dialect).parseSingle();
}

/**
 * Parse every statement in the source text.
 * @param {string} sql
 * @param {BaseDialect} dialect
 */
export function parseAll(sql, dialect) {
  return new Parser(sql, dialect).parseStatements();
}
