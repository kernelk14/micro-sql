import { Database } from '../src/index.js';

const db = new Database({ dialect: 'sqlite' });

db.exec(`
  CREATE TABLE expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT
  );
  CREATE TABLE budgets (
    category TEXT PRIMARY KEY,
    monthly REAL NOT NULL
  );
  INSERT INTO budgets (category, monthly) VALUES ('food', 50), ('transport', 20);
`);

const insert = db.prepare('INSERT INTO expenses (category, amount, note) VALUES (?, ?, ?)');
insert.run(['food', 12.5, 'lunch']);
insert.run(['food', 4.25, 'coffee']);
insert.run(['transport', 30, 'train pass']);

db.run('INSERT INTO expenses (category, amount) VALUES (:category, :amount)', {
  category: 'food',
  amount: 8
});

console.log('All expenses:');
console.table(db.all('SELECT id, category, amount FROM expenses ORDER BY amount DESC'));

console.log('\nSpend against budget:');
console.table(db.all(`
  SELECT b.category, b.monthly, COALESCE(SUM(e.amount), 0) AS spent
  FROM budgets b
  LEFT JOIN expenses e ON e.category = b.category
  GROUP BY b.category
  ORDER BY b.category
`));

console.log('\nTotals by category:');
console.table(db.all(`
  SELECT category, COUNT(*) AS count, SUM(amount) AS total, ROUND(AVG(amount), 2) AS average
  FROM expenses
  GROUP BY category
  HAVING count > 1
  ORDER BY total DESC
`));

const cheap = db.all('SELECT note FROM expenses WHERE amount < ? AND note IS NOT NULL', [10]);
console.log('\nNotes for expenses under 10:', cheap);

db.exec('BEGIN');
db.run('UPDATE expenses SET amount = amount * 2 WHERE category = ?', ['transport']);
console.log(
  '\nTransport inside the transaction:',
  db.get('SELECT amount FROM expenses WHERE category = ?', ['transport'])
);
db.exec('ROLLBACK');
console.log(
  'Transport after ROLLBACK:',
  db.get('SELECT amount FROM expenses WHERE category = ?', ['transport'])
);

db.exec('BEGIN');
db.run("INSERT INTO expenses (category, amount, note) VALUES ('food', 3, 'tea')");
db.exec('COMMIT');
console.log('Remaining rows:', db.all('SELECT COUNT(*) AS n FROM expenses')[0].n);
