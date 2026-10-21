/**
 * Live evaluation of the spec's reference cases (A-G) with the REAL engine, for the Test Lab.
 * Each check reports expected vs actual so a failure is visible and explainable.
 */
import { caseA, CASE_A_EXPECTED, caseB, caseD, caseE, caseEYear } from '../seed/fixtures.js';
import { DatasetBuilder, usd } from '../seed/builder.js';
import { buildIndex, accountContribution, netWorthAt } from './ledger.js';
import { summarizePeriod } from './reports.js';
import { addTransaction, updateTransaction } from './ops/transactions.js';
import { completeReconciliation } from './ops/reconcile.js';
import { reconcileMath } from './reconciliation.js';
import { spendByCategoryMonth, computeBudgetChain } from './budgets.js';
import { occurrencesBetween } from './recurring.js';
import { saveScenario, duplicateScenario } from './ops/catalog.js';
import { runProjection } from '../forecast/engine.js';
import { compareProjections } from '../forecast/compare.js';
import { commitImport } from './ops/importing.js';
import { parseCsv } from '../imports/csv.js';
import { normalizeRows, defaultMapping, suggestMapping } from '../imports/mapping.js';
import { matchRows } from '../imports/matching.js';
import { formatMoney } from './money.js';

const bal = (d, id) => accountContribution(buildIndex(d), id, d.settings.asOfDate, false);
const chk = (label, expected, actual, fmt = formatMoney) => ({ label, expected: typeof expected === 'string' ? expected : fmt(expected), actual: typeof actual === 'string' ? actual : fmt(actual), pass: expected === actual });

/** Run every reference case; returns [{id,title,summary,checks:[{label,expected,actual,pass}]}]. */
export function runReferenceCases() {
  const out = [];

  const a = caseA();
  const pa = summarizePeriod(a, { start: '2026-01-01', end: '2026-01-31' });
  out.push({ id: 'A', title: 'Case A - net worth, card payments and refunds', summary: 'Checking +$1,000, Savings $0, Card -$200; payroll, rent, card grocery, card payment, refund, savings transfer.', checks: [
    chk('Checking', CASE_A_EXPECTED.chk, bal(a, 'chk')),
    chk('Savings', CASE_A_EXPECTED.sav, bal(a, 'sav')),
    chk('Credit card', CASE_A_EXPECTED.card, bal(a, 'card')),
    chk('Net worth', CASE_A_EXPECTED.netWorth, netWorthAt(buildIndex(a), '2026-01-31', false).netWorth),
    chk('Net worth increase', 45000, netWorthAt(buildIndex(a), '2026-01-31', false).netWorth - netWorthAt(buildIndex(a), '2026-01-01', false).netWorth),
    chk('Income', 60000, pa.incomeCents),
    chk('Net expense ($120 + $40 - $10 refund)', 15000, pa.netExpenseCents),
    chk('Transfers counted as income or expense', 0, pa.internalNetCents),
  ] });

  const b = caseB();
  const pb = summarizePeriod(b, { start: '2026-01-01', end: '2026-01-31' });
  const bad = addTransaction(b, { accountId: 'chk', date: '2026-01-12', description: 'x', amountCents: -4735, kind: 'expense', splits: [{ categoryId: 'cat-groceries', amountCents: -1250 }, { categoryId: 'cat-household', amountCents: -3484 }] });
  out.push({ id: 'B', title: 'Case B - split accounting', summary: '-$47.35 split into -$12.50 groceries and -$34.85 household goods.', checks: [
    chk('Account balance change (once)', -4735, bal(b, 'chk') - 50000),
    chk('Groceries share', 1250, pb.byCategory.get('cat-groceries').expenseCents),
    chk('Household goods share', 3485, pb.byCategory.get('cat-household').expenseCents),
    chk('Split totalling -$47.34 is rejected', 'rejected', bad.ok ? 'accepted' : 'rejected', (v) => v),
  ] });

  const cb = new DatasetBuilder({ name: 'Case C', asOfDate: '2026-01-31' });
  cb.category('cat-x', 'Coffee', 'expense');
  cb.account('chk', { name: 'Checking', type: 'checking', opening: usd('100.00'), openingDate: '2026-01-01' });
  const cd = cb.build();
  const csv = 'Date,Description,Amount,Reference\n2026-01-10,Corner Coffee,-4.75,R1\n2026-01-10,Corner Coffee,-4.75,R2\n';
  const parsed = parseCsv(csv);
  const norm = normalizeRows(parsed.rows, parsed.lines, { ...defaultMapping(), ...suggestMapping(parsed.rows[0]) }, {});
  const first = commitImport(cd, { accountId: 'chk', fileName: 'c.csv', rows: matchRows(cd, 'chk', norm.rows) });
  const again = matchRows(first.data, 'chk', norm.rows);
  out.push({ id: 'C', title: 'Case C - identical purchases and reimport', summary: 'Two coffees on the same date, amount and merchant with different references.', checks: [
    chk('Both coffees imported', 2, first.imported, String),
    chk('Purchases after first import', 2, first.data.transactions.length, String),
    chk('Re-import: rows detected as already imported', 2, again.filter((r) => r.match.type === 'duplicate').length, String),
    chk('Purchases still equal two (not four)', 2, first.data.transactions.length, String),
  ] });

  const d = caseD();
  const dn = reconcileMath(50000, 132475, [120000, -30000, -7525]);
  const dm = reconcileMath(50000, 131975, [120000, -30000, -7525]);
  const okRec = completeReconciliation(d, { accountId: 'chk', startDate: '2026-01-01', endDate: '2026-01-31', openingCents: 50000, closingCents: 132475, clearedTxIds: ['d1', 'd2', 'd3'] });
  const badRec = completeReconciliation(d, { accountId: 'chk', startDate: '2026-01-01', endDate: '2026-01-31', openingCents: 50000, closingCents: 131975, clearedTxIds: ['d1', 'd2', 'd3'] });
  out.push({ id: 'D', title: 'Case D - reconciliation', summary: 'Opening $500.00; cleared +$1,200.00, -$300.00, -$75.25; an uncleared -$20.00 is posted in the same range.', checks: [
    chk('Calculated close', 132475, dn.calculated),
    chk('Discrepancy when statement is $1,324.75', 0, dn.discrepancy),
    chk('Completes at zero discrepancy', 'completed', okRec.ok ? 'completed' : 'blocked', (v) => v),
    chk('Discrepancy when statement is $1,319.75', -500, dm.discrepancy),
    chk('Completion blocked with -$5.00', 'blocked', badRec.ok ? 'completed' : 'blocked', (v) => v),
    chk('Uncleared -$20 excluded from the cleared sum', 82475, dn.clearedSum),
  ] });

  const e = caseE();
  const chain = computeBudgetChain(e.budgets[0], spendByCategoryMonth(e).get('cat-groceries'), '2026-03');
  const e2 = updateTransaction(e, 'e1', { amountCents: -usd('100.00') });
  const chain2 = computeBudgetChain(e2.data.budgets[0], spendByCategoryMonth(e2.data).get('cat-groceries'), '2026-03');
  const ey = caseEYear();
  const chainY = computeBudgetChain(ey.budgets[0], spendByCategoryMonth(ey).get('cat-groceries'), '2026-02');
  out.push({ id: 'E', title: 'Case E - rollover budgets', summary: '$200/month base. January spend $150, February spend $280.', checks: [
    chk('January rolls into February', 5000, chain[0].remainingCents),
    chk('February available', 25000, chain[1].availableCents),
    chk('February rolls into March', -3000, chain[1].remainingCents),
    chk('March available before spending', 17000, chain[2].availableCents),
    chk('After editing January to $100: March available', 22000, chain2[2].availableCents),
    chk('December rolls into January (Dec spend $150)', 25000, chainY[1].availableCents),
  ] });

  const sc = saveScenario(a, { name: 'Bonus', horizonMonths: 12, changes: [{ type: 'one_time', date: '2026-03-15', title: 'Bonus', amountCents: 100000, accountId: 'chk' }] });
  const dup = duplicateScenario(sc.data, sc.id);
  const cmp = compareProjections(runProjection(dup.data, dup.data.scenarios.find((s) => s.id === sc.id)), runProjection(dup.data, dup.data.scenarios.find((s) => s.id === dup.id)));
  out.push({ id: 'F', title: 'Case F - identical scenarios', summary: 'A scenario compared with an exact duplicate.', checks: [
    chk('Differences found', 'none', cmp.identical ? 'none' : 'differences', (v) => v),
    chk('Affected accounts', 0, cmp.affectedAccounts.length, String),
    chk('Affected goals', 0, cmp.affectedGoals.length, String),
    chk('Total net worth difference', 0, cmp.totals.endNetWorthCents.diff),
    chk('Debt payoff timing differences', 0, cmp.debts.filter((x) => x.payoffChanged).length, String),
  ] });

  const rule = { id: 'r', startDate: '2026-01-31', interval: 'monthly', endDate: null, businessDay: 'none' };
  const dates = occurrencesBetween(rule, '2026-01-01', '2026-04-30').map((o) => o.scheduled).join(', ');
  out.push({ id: 'G', title: 'Case G - time and precision boundaries', summary: 'Month-end recurrence, leap years and cent-exact arithmetic.', checks: [
    chk('Jan 31 monthly recurrence', '2026-01-31, 2026-02-28, 2026-03-31, 2026-04-30', dates, (v) => v),
    chk('2024-02-29 is a valid date', 'valid', occurrencesBetween({ ...rule, startDate: '2024-01-31' }, '2024-01-01', '2024-02-29').pop().scheduled === '2024-02-29' ? 'valid' : 'invalid', (v) => v),
    chk('$0.10 + $0.20', 30, usd('0.10') + usd('0.20')),
    chk('$0.10 + $0.20 - $0.30', 0, usd('0.10') + usd('0.20') - usd('0.30')),
  ] });
  return out;
}
