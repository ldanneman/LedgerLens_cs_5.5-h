/**
 * Test Lab presets: small deterministic datasets that each exercise a different financial situation.
 * Every preset carries a plain-language summary and a "what to look for" list so it is useful in the
 * UI and not just a hidden test object.
 */
import { DatasetBuilder, usd, addCompletedReconciliation } from './builder.js';
import { caseD } from './fixtures.js';
import { monthlyInterest } from '../domain/money.js';

function stdCategories(b) {
  b.category('cat-salary', 'Salary', 'income', 'Income', '#15803d');
  b.category('cat-other-income', 'Other Income', 'income', 'Income', '#65a30d');
  b.category('cat-rent', 'Rent', 'expense', 'Housing', '#6366f1');
  b.category('cat-utilities', 'Utilities', 'expense', 'Housing', '#0ea5e9');
  b.category('cat-household', 'Household Goods', 'expense', 'Housing', '#8b5cf6');
  b.category('cat-groceries', 'Groceries', 'expense', 'Food', '#16a34a');
  b.category('cat-dining', 'Dining Out', 'expense', 'Food', '#f97316');
  b.category('cat-shopping', 'Shopping', 'expense', 'Lifestyle', '#ec4899');
  b.category('cat-fuel', 'Fuel', 'expense', 'Transport', '#eab308');
  b.category('cat-interest', 'Interest & Fees', 'expense', 'Financial', '#ef4444');
  b.category('cat-gifts', 'Gifts & Donations', 'expense', 'Personal', '#f59e0b');
}

const presetBase = (id, name, description, asOfDate) => new DatasetBuilder({ name, kind: 'preset', presetId: id, description, asOfDate });

function balancedMonth() {
  const b = presetBase('balanced-month', 'Balanced month', 'A calm month: paycheck, rent, groceries, a savings transfer and a card payment; the checking account is fully reconciled.', '2026-09-30');
  stdCategories(b);
  b.account('chk', { name: 'Everyday Checking', type: 'checking', institution: 'Demo Bank', opening: usd('2000.00'), openingDate: '2026-09-01' });
  b.account('sav', { name: 'Savings', type: 'savings', institution: 'Demo Bank', opening: usd('1000.00'), openingDate: '2026-09-01', aprBps: 400 });
  b.account('card', { name: 'Everyday Card', type: 'credit_card', institution: 'Demo Card Co', opening: -usd('300.00'), openingDate: '2026-09-01', limit: usd('4000.00'), aprBps: 1999, payment: usd('250.00'), dueDay: 20 });
  b.tx({ account: 'chk', date: '2026-09-01', desc: 'Rent', merchant: 'Landmark Properties', amount: -usd('1200.00'), kind: 'expense', category: 'cat-rent' });
  b.tx({ account: 'chk', date: '2026-09-04', desc: 'Payroll', merchant: 'Acme Payroll', amount: usd('3000.00'), kind: 'income', category: 'cat-salary' });
  b.tx({ account: 'chk', date: '2026-09-08', desc: 'Cascade Electric', merchant: 'Cascade Electric', amount: -usd('92.40'), kind: 'expense', category: 'cat-utilities' });
  b.tx({ account: 'chk', date: '2026-09-11', desc: 'Green Basket Market', merchant: 'Green Basket Market', amount: -usd('118.75'), kind: 'expense', category: 'cat-groceries' });
  b.tx({ account: 'chk', date: '2026-09-25', desc: 'Green Basket Market', merchant: 'Green Basket Market', amount: -usd('96.20'), kind: 'expense', category: 'cat-groceries' });
  b.transfer({ from: 'chk', to: 'sav', amount: usd('500.00'), date: '2026-09-05', desc: 'Monthly savings' });
  b.transfer({ from: 'chk', to: 'card', amount: usd('250.00'), date: '2026-09-20', desc: 'Card payment' });
  b.tx({ account: 'card', date: '2026-09-10', desc: 'Green Basket Market', merchant: 'Green Basket Market', amount: -usd('85.40'), kind: 'expense', category: 'cat-groceries' });
  b.tx({ account: 'card', date: '2026-09-12', desc: 'Ember & Oak Bistro', merchant: 'Ember & Oak Bistro', amount: -usd('42.10'), kind: 'expense', category: 'cat-dining' });
  b.tx({ account: 'card', date: '2026-09-25', desc: 'Volt Fuel', merchant: 'Volt Fuel', amount: -usd('48.00'), kind: 'expense', category: 'cat-fuel' });
  b.budget({ id: 'bud-groc', category: 'cat-groceries', base: usd('400.00'), startMonth: '2026-09' });
  b.budget({ id: 'bud-dine', category: 'cat-dining', base: usd('150.00'), startMonth: '2026-09' });
  const d = b.build();
  return addCompletedReconciliation(d, { id: 'recon-balanced', accountId: 'chk', start: '2026-09-01', end: '2026-09-30' });
}

function cardCycle() {
  const b = presetBase('card-cycle', 'Credit-card cycle', 'One card through a statement cycle: purchases, a refund, a payment, an interest charge, and a merchant that two rules could categorize differently.', '2026-09-30');
  stdCategories(b);
  b.account('chk', { name: 'Everyday Checking', type: 'checking', institution: 'Demo Bank', opening: usd('3000.00'), openingDate: '2026-09-01' });
  b.account('card', { name: 'Rewards Card', type: 'credit_card', institution: 'Demo Card Co', opening: -usd('1200.00'), openingDate: '2026-09-01', limit: usd('5000.00'), aprBps: 2199, payment: usd('300.00'), dueDay: 20, statementDay: 25, autopay: 'chk' });
  b.tx({ id: 'cc-1', account: 'card', date: '2026-09-02', desc: 'NorthMart', merchant: 'NorthMart', amount: -usd('64.18'), kind: 'expense', category: 'cat-shopping', catSource: 'rule' });
  b.tx({ id: 'cc-2', account: 'card', date: '2026-09-06', desc: 'NorthMart', merchant: 'NorthMart', amount: -usd('112.90'), kind: 'expense', category: 'cat-groceries', catSource: 'manual', notes: 'Manually set to Groceries: rules would say Shopping, but this was a food run.' });
  b.tx({ id: 'cc-3', account: 'card', date: '2026-09-09', desc: 'NorthMart', merchant: 'NorthMart', amount: -usd('38.00'), kind: 'expense', category: null, catSource: null });
  b.tx({ id: 'cc-4', account: 'card', date: '2026-09-12', desc: 'Ember & Oak Bistro', merchant: 'Ember & Oak Bistro', amount: -usd('56.30'), kind: 'expense', category: 'cat-dining' });
  b.tx({ id: 'cc-5', account: 'card', date: '2026-09-14', desc: 'Volt Fuel', merchant: 'Volt Fuel', amount: -usd('47.25'), kind: 'expense', category: 'cat-fuel' });
  b.tx({ id: 'cc-6', account: 'card', date: '2026-09-16', desc: 'NorthMart - return', merchant: 'NorthMart', amount: usd('30.00'), kind: 'expense', category: 'cat-shopping', tags: ['refund'] });
  b.transfer({ from: 'chk', to: 'card', amount: usd('600.00'), date: '2026-09-20', desc: 'Statement payment' });
  b.tx({ id: 'cc-7', account: 'card', date: '2026-09-22', desc: 'Giftly', merchant: 'Giftly', amount: -usd('74.99'), kind: 'expense', category: 'cat-gifts' });
  b.tx({ id: 'cc-8', account: 'card', date: '2026-09-29', desc: 'Volt Fuel', merchant: 'Volt Fuel', amount: -usd('51.10'), kind: 'expense', category: 'cat-fuel', status: 'pending' });
  b.rule({ id: 'rule-mart-shop', name: 'Any "Mart" is Shopping', pattern: 'Mart', category: 'cat-shopping', priority: 20 });
  b.rule({ id: 'rule-northmart-house', name: 'NorthMart is Household', pattern: 'NorthMart', category: 'cat-household', priority: 30 });
  const d = b.build();
  // interest on the statement date, from the real running balance (posted, up to the 25th)
  const owed = -(d.accounts[1].openingCents + d.transactions.filter((t) => t.accountId === 'card' && t.status === 'posted' && t.date <= '2026-09-25').reduce((s, t) => s + t.amountCents, 0));
  d.transactions.push({ id: 'cc-9', accountId: 'card', date: '2026-09-25', description: 'Purchase interest charge', merchant: 'Demo Card Co', amountCents: -monthlyInterest(owed, 2199), kind: 'expense', status: 'posted', adjustmentKind: null, categoryId: 'cat-interest', categorySource: 'rule', splits: [], notes: '', tags: [], transferId: null, reversalOf: null, recurrence: null, source: { type: 'manual', batchId: null, externalId: null, importedAt: null, rawDescription: null } });
  d.meta.seq = Math.max(d.meta.seq, 100);
  return d;
}

const DUP_CSV = `Date,Description,Amount,Reference
2026-09-14,Corner Bean Coffee,-4.75,C-1001
2026-09-14,Corner Bean Coffee,-4.75,C-1002
2026-09-15,Green Basket Market,-23.10,C-1003
2026-09-16,Brewline Cafe,-5.20,C-1004
2026-09-16,Brewline Cafe,-5.20,C-1005
2026-09-17,Acme Payroll,2500.00,C-1006
`;

function duplicateImports() {
  const b = presetBase('duplicate-imports', 'Duplicate-looking imports', 'Two coffees with the same amount, date and merchant are BOTH real (different bank references). The sample CSV re-imports three existing rows plus new ones, so you can see true duplicates skipped and legitimate look-alikes kept.', '2026-09-30');
  stdCategories(b);
  b.category('cat-coffee', 'Coffee & Cafes', 'expense', 'Food', '#a16207');
  b.account('chk', { name: 'Everyday Checking', type: 'checking', institution: 'Demo Bank', opening: usd('1500.00'), openingDate: '2026-09-01' });
  const src = (ext) => ({ type: 'import', batchId: 'batch-dup-1', externalId: ext, importedAt: '2026-09-18T12:00:00.000Z', rawDescription: null });
  const t1 = b.tx({ account: 'chk', date: '2026-09-14', desc: 'Corner Bean Coffee', merchant: 'Corner Bean Coffee', amount: -usd('4.75'), kind: 'expense', category: 'cat-coffee', catSource: 'import', source: src('C-1001') });
  const t2 = b.tx({ account: 'chk', date: '2026-09-14', desc: 'Corner Bean Coffee', merchant: 'Corner Bean Coffee', amount: -usd('4.75'), kind: 'expense', category: 'cat-coffee', catSource: 'import', source: src('C-1002') });
  const t3 = b.tx({ account: 'chk', date: '2026-09-15', desc: 'Green Basket Market', merchant: 'Green Basket Market', amount: -usd('23.10'), kind: 'expense', category: 'cat-groceries', catSource: 'import', source: src('C-1003') });
  b.tx({ account: 'chk', date: '2026-09-16', desc: 'Brewline Cafe', merchant: 'Brewline Cafe', amount: -usd('5.20'), kind: 'expense', category: 'cat-coffee', status: 'pending', notes: 'Pending: may settle with a slightly different description/date.' });
  b.batch({ id: 'batch-dup-1', account: 'chk', fileName: 'earlier-export.csv', importedAt: '2026-09-18T12:00:00.000Z', created: [t1, t2, t3] });
  const d = b.build();
  d.samples = undefined;
  return d;
}

function reconciliationMismatch() {
  const d = caseD();
  d.meta = { ...d.meta, name: 'Reconciliation mismatch', kind: 'preset', presetId: 'reconciliation-mismatch', description: 'Statement closes at $1,319.75 but the ledger cleared items total $1,324.75: a $5.00 bank fee is missing from the ledger. One posted $20.00 item is deliberately NOT on the statement.' };
  d.reconciliations.push({
    id: 'recon-mismatch',
    accountId: 'chk',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    openingCents: usd('500.00'),
    closingCents: usd('1319.75'),
    clearedTxIds: ['d1', 'd2', 'd3'],
    status: 'in_progress',
    createdAt: '2026-02-01T09:00:00.000Z',
    completedAt: null,
    calculatedCents: usd('1324.75'),
    discrepancyCents: -usd('5.00'),
    snapshots: [],
    adjustmentTxId: null,
    note: 'Bank statement shows a $5.00 monthly service fee on Jan 31 that is not yet in the ledger.',
  });
  return d;
}

function yearEndRollover() {
  const b = presetBase('year-end-rollover', 'Year-end rollover', 'Budgets carry unused (or overspent) amounts across December into January: groceries rolls over; dining does not.', '2026-02-28');
  stdCategories(b);
  b.account('chk', { name: 'Everyday Checking', type: 'checking', institution: 'Demo Bank', opening: usd('6000.00'), openingDate: '2025-11-01' });
  const months = [['2025-11', 120, 90], ['2025-12', 150, 260], ['2026-01', 280, 120], ['2026-02', 60, 100]];
  for (const [m, g, di] of months) {
    b.tx({ account: 'chk', date: `${m}-10`, desc: 'Green Basket Market', merchant: 'Green Basket Market', amount: -usd(`${g}.00`), kind: 'expense', category: 'cat-groceries' });
    b.tx({ account: 'chk', date: `${m}-18`, desc: 'Ember & Oak Bistro', merchant: 'Ember & Oak Bistro', amount: -usd(`${di}.00`), kind: 'expense', category: 'cat-dining' });
  }
  b.tx({ account: 'chk', date: '2025-12-31', desc: 'Green Basket Market - New Year party', merchant: 'Green Basket Market', amount: -usd('48.60'), kind: 'expense', category: 'cat-groceries' });
  b.tx({ account: 'chk', date: '2026-01-01', desc: 'Green Basket Market - Jan 1', merchant: 'Green Basket Market', amount: -usd('22.15'), kind: 'expense', category: 'cat-groceries' });
  b.budget({ id: 'bud-groc', category: 'cat-groceries', base: usd('200.00'), rollover: true, startMonth: '2025-11' });
  b.budget({ id: 'bud-dine', category: 'cat-dining', base: usd('120.00'), rollover: false, startMonth: '2025-11' });
  return b.build();
}

function debtAcceleration() {
  const b = presetBase('debt-acceleration', 'Debt acceleration', 'A card and two loans with saved scenarios: extra monthly payments, a lump sum, and a deliberately insufficient card payment that never pays off.', '2026-09-30');
  stdCategories(b);
  b.account('chk', { name: 'Everyday Checking', type: 'checking', institution: 'Demo Bank', opening: usd('6500.00'), openingDate: '2026-06-01' });
  b.account('card', { name: 'High-APR Card', type: 'credit_card', institution: 'Demo Card Co', opening: -usd('3500.00'), openingDate: '2026-06-01', limit: usd('6000.00'), aprBps: 2499, payment: usd('150.00'), dueDay: 18, autopay: 'chk' });
  b.account('auto', { name: 'Auto Loan', type: 'auto_loan', institution: 'Demo Credit', opening: -usd('20000.00'), openingDate: '2026-06-01', aprBps: 690, payment: usd('450.00'), dueDay: 10, autopay: 'chk', loan: { originalPrincipalCents: usd('24000.00'), termMonths: 72, startDate: '2025-02-10' } });
  b.account('stu', { name: 'Student Loan', type: 'student_loan', institution: 'Demo Servicing', opening: -usd('12000.00'), openingDate: '2026-06-01', aprBps: 550, payment: usd('200.00'), dueDay: 5, autopay: 'chk', loan: { originalPrincipalCents: usd('15000.00'), termMonths: 120, startDate: '2024-01-05' } });
  b.recurring({ id: 'rec-pay', title: 'Payroll', kind: 'income', amount: usd('4500.00'), account: 'chk', category: 'cat-salary', start: '2026-06-01', interval: 'monthly', group: 'income' });
  b.recurring({ id: 'rec-rent', title: 'Rent', kind: 'expense', amount: usd('1500.00'), account: 'chk', category: 'cat-rent', start: '2026-06-01', interval: 'monthly', group: 'bill' });
  for (const m of ['2026-06', '2026-07', '2026-08', '2026-09']) {
    b.tx({ account: 'chk', date: `${m}-01`, desc: 'Payroll', amount: usd('4500.00'), kind: 'income', category: 'cat-salary', recurrence: { ruleId: 'rec-pay', occurrence: `${m}-01` } });
    b.tx({ account: 'chk', date: `${m}-01`, desc: 'Rent', amount: -usd('1500.00'), kind: 'expense', category: 'cat-rent', recurrence: { ruleId: 'rec-rent', occurrence: `${m}-01` } });
    b.tx({ account: 'chk', date: `${m}-14`, desc: 'Groceries', merchant: 'Green Basket Market', amount: -usd('650.00'), kind: 'expense', category: 'cat-groceries' });
    b.tx({ account: 'chk', date: `${m}-20`, desc: 'Everyday spending', merchant: 'Misc', amount: -usd('550.00'), kind: 'expense', category: 'cat-shopping' });
  }
  const sc = (id, name, description, horizonMonths, changes) => b.scenario({ id, name, description, horizonMonths, changes });
  sc('scn-card-extra', 'Extra $250/mo on the card', 'Pay $250 more per month on the high-APR card.', 60, [{ id: 'chg1', type: 'debt_payment', label: '+$250/mo card', effectiveDate: '2026-10-01', mode: 'extra', amountCents: usd('250.00'), accountId: 'card', enabled: true }]);
  sc('scn-auto-lump', 'Lump sum + extra on auto loan', '$2,000 lump sum in January and $100 extra monthly on the auto loan.', 60, [
    { id: 'chg1', type: 'debt_lump', label: '$2,000 lump on auto loan', date: '2027-01-15', amountCents: usd('2000.00'), accountId: 'auto', enabled: true },
    { id: 'chg2', type: 'debt_payment', label: '+$100/mo auto', effectiveDate: '2026-10-01', mode: 'extra', amountCents: usd('100.00'), accountId: 'auto', enabled: true },
  ]);
  sc('scn-card-underpay', 'Underpay the card ($50/mo)', 'A payment below the monthly interest: the projection shows the balance never pays off.', 60, [{ id: 'chg1', type: 'debt_payment', label: 'Card payment $50', effectiveDate: '2026-10-01', mode: 'set', amountCents: usd('50.00'), accountId: 'card', enabled: true }]);
  return b.build();
}

function edgeLedger() {
  const b = presetBase('edge-ledger', 'Edge-case ledger', 'Boundary dates (leap day, year end), unusual-but-valid ids ("__proto__", "constructor"), splits, huge and tiny amounts, long names. Use the "Invalid candidates" library in the Test Lab to see malformed variants rejected.', '2026-03-01');
  b.category('__proto__', 'Prototype Pollution Test', 'expense', 'Edge', '#475569');
  b.category('constructor', 'Constructor Category', 'expense', 'Edge', '#0f766e');
  b.category('toString', 'toString Income', 'income', 'Edge', '#15803d');
  stdCategories(b);
  b.account('__proto__acct', { name: '__proto__ checking', type: 'checking', opening: usd('0.10'), openingDate: '2024-01-01' });
  b.account('constructor-card', { name: 'Constructor card', type: 'credit_card', opening: 0, openingDate: '2024-01-01', limit: usd('1000.00'), aprBps: 0 });
  b.account('big', { name: 'Whale savings', type: 'savings', opening: usd('999999999.99'), openingDate: '2024-01-01' });
  b.tx({ id: 'hasOwnProperty', account: '__proto__acct', date: '2024-02-29', desc: 'Leap day purchase', merchant: 'Leap Day Diner', amount: -usd('0.10'), kind: 'expense', category: '__proto__' });
  b.tx({ id: 'edge-2', account: '__proto__acct', date: '2024-12-31', desc: 'Year-end salary with a really, really long description that goes on and on to check that tables and cards wrap instead of clipping important information', merchant: 'The International Association of Extremely Long Employer Names And Payroll Services Incorporated', amount: usd('0.20'), kind: 'income', category: 'toString' });
  b.tx({ id: 'edge-3', account: '__proto__acct', date: '2025-01-01', desc: 'New year coffee', amount: -usd('0.30'), kind: 'expense', category: 'constructor' });
  b.tx({ id: 'edge-4', account: '__proto__acct', date: '2025-01-01', desc: 'New year coffee', amount: -usd('0.30'), kind: 'expense', category: 'constructor' });
  b.tx({ id: 'edge-5', account: 'constructor-card', date: '2026-02-28', desc: 'Split dinner (3 ways)', merchant: 'Split & Co', amount: -usd('100.00'), kind: 'expense', splits: [['__proto__', -usd('33.33')], ['constructor', -usd('33.33')], ['cat-dining', -usd('33.34')]] });
  b.tx({ id: 'edge-6', account: '__proto__acct', date: '2026-03-01', desc: 'Payroll on the as-of date', merchant: 'Edge Payroll', amount: usd('1000.00'), kind: 'income', category: 'cat-salary' });
  b.tx({ id: 'edge-7', account: 'big', date: '2026-02-01', desc: 'Interest on a very large balance', amount: usd('3333.33'), kind: 'income', category: 'toString' });
  b.transfer({ id: 'xfer-edge', legIds: ['edge-8a', 'edge-8b'], from: '__proto__acct', to: 'constructor-card', amount: usd('0.07'), date: '2026-02-20', desc: 'Seven cents toward the card' });
  b.tx({ id: 'edge-9', account: '__proto__acct', date: '2026-02-15', desc: 'Unicode: Café Münch - 東京 - 🍣', merchant: 'Café Münch 東京 🍣', amount: -usd('12.34'), kind: 'expense', category: 'cat-dining' });
  b.tx({ id: 'edge-10', account: '__proto__acct', date: '2026-02-16', desc: 'Receipt <script>alert(1)</script> & "quotes"', merchant: '<b>bold</b>', amount: -usd('9.99'), kind: 'expense', category: 'cat-shopping', notes: '=HYPERLINK("http://example.com")' });
  return b.build();
}

/** All Test Lab presets. */
export const PRESETS = [
  { id: 'balanced-month', title: 'Balanced month', summary: 'Income, expenses, a transfer and a card payment, with a completed reconciliation.', lookFor: ['Net cash flow excludes both transfers', 'The checking reconciliation shows a $0.00 discrepancy', 'Verification panel is all green'], build: balancedMonth },
  { id: 'card-cycle', title: 'Credit-card cycle', summary: 'Purchases, a refund, a statement payment, interest and competing categorizations.', lookFor: ['The refund reduces Shopping spending instead of showing as income', 'The card payment is a transfer, not spending', 'Rules: "Any Mart" (priority 20) beats "NorthMart is Household" (30); the manual Groceries categorization is protected', 'Open Transactions > Rules to preview applying rules to the uncategorized NorthMart purchase'], build: cardCycle },
  { id: 'duplicate-imports', title: 'Duplicate-looking imports', summary: 'Legitimate identical purchases plus a sample CSV that contains a true re-import.', lookFor: ['Load the sample CSV into Import & Reconcile', 'Rows C-1001..C-1003 are skipped as already imported', 'C-1004 settles the pending Brewline Cafe item', 'C-1005 (identical amount/date/merchant, different reference) is kept'], csv: { name: 'reimport-sample.csv', text: DUP_CSV }, build: duplicateImports },
  { id: 'reconciliation-mismatch', title: 'Reconciliation mismatch', summary: 'A statement that misses a $5.00 fee and has an uncleared $20.00 item.', lookFor: ['Open Reconcile on Checking: discrepancy -$5.00', 'Completion is blocked', 'Add the missing -$5.00 fee on Jan 31 and clear it to reach $0.00', 'The uncleared -$20.00 item is not counted in the cleared sum'], build: reconciliationMismatch },
  { id: 'year-end-rollover', title: 'Year-end rollover', summary: 'A rollover grocery budget carried across December into January, next to a non-rollover budget.', lookFor: ['Groceries available in January includes December leftovers', 'Edit a December transaction and watch every later month change', 'Dining does not carry anything forward'], build: yearEndRollover },
  { id: 'debt-acceleration', title: 'Debt acceleration', summary: 'A card and two loans with accelerated-payment scenarios and an underpayment case.', lookFor: ['Scenario Planner: compare each saved scenario with the baseline', 'Extra payments shorten payoff and save interest', 'The $50 card payment is below the monthly interest, so the projection says it never pays off', 'Actual balances stay unchanged'], build: debtAcceleration },
  { id: 'edge-ledger', title: 'Edge-case ledger', summary: 'Leap day, year-end, special ids, extreme amounts, a 3-way split, tiny amounts and HTML-looking text.', lookFor: ['IDs like "__proto__" and "constructor" behave as normal data', '$0.10 + $0.20 - $0.30 produce no phantom cents', 'HTML/formula-looking text is shown as plain text', 'Try the Invalid candidates library to see each corruption rejected'], build: edgeLedger },
];

/** Look up a preset by id. */
export function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}
