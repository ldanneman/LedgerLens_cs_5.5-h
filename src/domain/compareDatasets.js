/**
 * Compare two datasets (a baseline and a variant) and report what changes: account balances, totals,
 * budgets and reconciliation status. Used by the Test Lab to show the effect of an edit.
 */
import { buildIndex, accountContribution, netWorthAt } from './ledger.js';
import { summarizePeriod } from './reports.js';
import { budgetOverview } from './budgets.js';
import { reconciliationHealth } from './reconciliation.js';
import { monthKey } from './dates.js';

const d = (a, b) => ({ before: a, after: b, diff: b - a, changed: a !== b });

export function compareDatasets(a, b) {
  const ia = buildIndex(a);
  const ib = buildIndex(b);
  const asOf = b.settings.asOfDate;
  const ids = [...new Set([...a.accounts.map((x) => x.id), ...b.accounts.map((x) => x.id)])];
  const accounts = ids.map((id) => ({
    id,
    name: ib.accountsById.get(id)?.name || ia.accountsById.get(id)?.name || id,
    status: !ia.accountsById.has(id) ? 'added' : !ib.accountsById.has(id) ? 'removed' : 'kept',
    posted: d(accountContribution(ia, id, asOf, false), accountContribution(ib, id, asOf, false)),
    pending: d(accountContribution(ia, id, asOf, true), accountContribution(ib, id, asOf, true)),
  }));
  const range = { start: '1970-01-01', end: asOf };
  const sa = summarizePeriod(a, range);
  const sb = summarizePeriod(b, range);
  const totals = {
    netWorth: d(netWorthAt(ia, asOf, false).netWorth, netWorthAt(ib, asOf, false).netWorth),
    income: d(sa.incomeCents, sb.incomeCents),
    netExpense: d(sa.netExpenseCents, sb.netExpenseCents),
    netCashFlow: d(sa.netCashFlowCents, sb.netCashFlowCents),
    transfersMoved: d(sa.transferInCents, sb.transferInCents),
    transactions: d(a.transactions.length, b.transactions.length),
  };
  const month = monthKey(asOf);
  const ba = new Map(budgetOverview(a, month).map((x) => [x.budget.id, x]));
  const budgets = budgetOverview(b, month).map((x) => ({ id: x.budget.id, name: x.categoryName, spent: d(ba.get(x.budget.id)?.row.spentCents ?? 0, x.row.spentCents), available: d(ba.get(x.budget.id)?.row.availableCents ?? 0, x.row.availableCents) }));
  const recs = b.reconciliations.map((r) => {
    const before = a.reconciliations.find((x) => x.id === r.id);
    const hb = reconciliationHealth(b, r);
    const ha = before ? reconciliationHealth(a, before) : null;
    return { id: r.id, before: before ? (before.status === 'completed' ? (ha.valid ? 'completed' : 'out of date') : 'draft') : 'new', after: r.status === 'completed' ? (hb.valid ? 'completed' : 'out of date') : 'draft', changed: !before || (before.status === 'completed' ? (ha.valid ? 'completed' : 'out of date') : 'draft') !== (r.status === 'completed' ? (hb.valid ? 'completed' : 'out of date') : 'draft') };
  });
  const anyChange = accounts.some((x) => x.posted.changed || x.pending.changed || x.status !== 'kept') || Object.values(totals).some((t) => t.changed) || budgets.some((x) => x.spent.changed || x.available.changed) || recs.some((r) => r.changed);
  return { accounts, totals, budgets, recs, anyChange };
}
