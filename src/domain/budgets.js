/**
 * Monthly category budgets with optional rollover (spec section 12).
 *
 *   base(m)      = override for month m, else budget.baseCents
 *   available(m) = base(m) + carryIn(m)          carryIn(m) = carryOut(m-1) if rollover else 0
 *   remaining(m) = available(m) - spent(m)       carryOut(m) = remaining(m)  (may be negative)
 *
 * The chain starts at budget.startMonth with carryIn = 0 and walks month by month
 * across year boundaries, so editing any earlier month re-flows every later month.
 * Spending is NET spending: refunds reduce it, income and transfers are excluded.
 * A budget of $0 is valid: any spending is an overage (progress is reported as null).
 * Transactions are never excluded implicitly: uncategorized spend appears under
 * "Uncategorized" in reports but cannot be budgeted.
 */
import { buildIndex, categoryParts } from './ledger.js';
import { monthKey, monthRange, addMonthKey } from './dates.js';

/**
 * Net spending per category per month.
 * @returns {Map<string|null, Map<string, number>>} categoryId -> month -> cents
 */
export function spendByCategoryMonth(data, includePending = false) {
  const index = buildIndex(data);
  const out = new Map();
  for (const tx of index.sortedTx) {
    if (tx.kind !== 'expense') continue;
    if (tx.status !== 'posted' && !(includePending && tx.status === 'pending')) continue;
    const m = monthKey(tx.date);
    for (const part of categoryParts(tx)) {
      let byMonth = out.get(part.categoryId);
      if (!byMonth) {
        byMonth = new Map();
        out.set(part.categoryId, byMonth);
      }
      byMonth.set(m, (byMonth.get(m) || 0) - part.amountCents);
    }
  }
  return out;
}

/** Base allocation of a budget for a month (override wins). */
export function baseForMonth(budget, month) {
  const o = budget.overrides.find((x) => x.month === month);
  return o ? o.amountCents : budget.baseCents;
}

/**
 * Compute every month of one budget from its start month through `throughMonth`.
 * @param {object} budget @param {Map<string,number>|undefined} spendByMonth
 * @param {string} throughMonth 'YYYY-MM'
 * @returns {Array<{month,baseCents,rolloverInCents,availableCents,spentCents,remainingCents,carryOutCents,pct,overspent,hasOverride}>}
 */
export function computeBudgetChain(budget, spendByMonth, throughMonth) {
  const rows = [];
  if (throughMonth < budget.startMonth) return rows;
  let carry = 0;
  for (const month of monthRange(budget.startMonth, throughMonth)) {
    const baseCents = baseForMonth(budget, month);
    const rolloverInCents = budget.rollover ? carry : 0;
    const availableCents = baseCents + rolloverInCents;
    const spentCents = spendByMonth?.get(month) || 0;
    const remainingCents = availableCents - spentCents;
    carry = budget.rollover ? remainingCents : 0;
    rows.push({
      month,
      baseCents,
      rolloverInCents,
      availableCents,
      spentCents,
      remainingCents,
      carryOutCents: carry,
      pct: availableCents > 0 ? Math.round((spentCents / availableCents) * 1000) / 10 : null,
      overspent: remainingCents < 0,
      hasOverride: budget.overrides.some((o) => o.month === month),
    });
  }
  return rows;
}

/** Row for a single month, or a "not started" placeholder. */
export function budgetMonth(budget, spendByMonth, month) {
  const rows = computeBudgetChain(budget, spendByMonth, month);
  const row = rows[rows.length - 1];
  if (!row || row.month !== month) {
    return { month, notStarted: true, baseCents: 0, rolloverInCents: 0, availableCents: 0, spentCents: spendByMonth?.get(month) || 0, remainingCents: 0, carryOutCents: 0, pct: null, overspent: false, hasOverride: false };
  }
  return { ...row, notStarted: false };
}

/**
 * Status of every enabled budget for a month, enriched with category info, a risk
 * level and an "unusual change" flag (spend >= 1.5x the prior 3-month average and at
 * least $25 higher).
 */
export function budgetOverview(data, month, { includePending = false, asOfDate = null } = {}) {
  const index = buildIndex(data);
  const spend = spendByCategoryMonth(data, includePending);
  return data.budgets
    .filter((b) => b.enabled)
    .map((budget) => {
      const cat = index.categoriesById.get(budget.categoryId);
      const row = budgetMonth(budget, spend.get(budget.categoryId), month);
      const prior = [1, 2, 3].map((i) => spend.get(budget.categoryId)?.get(addMonthKey(month, -i)) || 0);
      const priorWithData = prior.filter((v) => v !== 0);
      const avg = priorWithData.length ? Math.round(priorWithData.reduce((a, b) => a + b, 0) / priorWithData.length) : 0;
      const unusual = avg > 0 && row.spentCents >= avg * 1.5 && row.spentCents - avg >= 2500;
      let risk = 'ok';
      if (row.notStarted) risk = 'not_started';
      else if (row.overspent) risk = 'over';
      else if (row.availableCents > 0 && row.spentCents / row.availableCents >= 0.85) risk = 'at_risk';
      else if (asOfDate && monthKey(asOfDate) === month && row.availableCents > 0) {
        const day = Number(asOfDate.slice(8, 10));
        const dim = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
        if (day >= 7 && (row.spentCents / day) * dim > row.availableCents) risk = 'at_risk';
      }
      return { budget, category: cat, categoryName: cat ? cat.name : '(missing category)', row, unusual, avgPriorCents: avg, risk };
    })
    .sort((a, b) => a.categoryName.localeCompare(b.categoryName));
}

/** Year-at-a-glance: for each enabled budget, its 12 months of a calendar year. */
export function budgetYear(data, year, { includePending = false } = {}) {
  const index = buildIndex(data);
  const spend = spendByCategoryMonth(data, includePending);
  const months = monthRange(`${year}-01`, `${year}-12`);
  return data.budgets.map((budget) => {
    const chain = new Map(computeBudgetChain(budget, spend.get(budget.categoryId), `${year}-12`).map((r) => [r.month, r]));
    return {
      budget,
      categoryName: index.categoriesById.get(budget.categoryId)?.name || '(missing category)',
      months: months.map((m) => chain.get(m) || { month: m, notStarted: true, baseCents: 0, rolloverInCents: 0, availableCents: 0, spentCents: spend.get(budget.categoryId)?.get(m) || 0, remainingCents: 0, overspent: false, pct: null }),
    };
  });
}
