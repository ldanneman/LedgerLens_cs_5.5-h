/**
 * Reporting engine. Every number is aggregated from canonical transactions.
 *
 * Classification (spec 3.3):
 *  - income     : kind 'income'. Amount = effect. Category/splits apply.
 *  - expense    : kind 'expense'. Spending = -effect, so a refund (positive effect)
 *                 REDUCES net spending of its category instead of showing as income.
 *  - transfer   : never income/expense. Internal transfers are zero-sum across
 *                 accounts; external (one-legged) transfers change net worth and are
 *                 reported on their own line.
 *  - adjustment : non-cash valuation or correction entries; reported separately.
 *
 *  net cash flow       = income - net spending
 *  net worth change    = net cash flow + external transfers + valuation + corrections
 *                        (+ internal transfer net effect when only SOME accounts selected)
 */
import { buildIndex, categoryParts, merchantOf } from './ledger.js';
import { monthKey, monthRange, addMonthKey, monthStart, monthEnd } from './dates.js';

function emptyAcc() {
  return {
    incomeCents: 0,
    grossExpenseCents: 0,
    refundCents: 0,
    transferInCents: 0,
    transferOutCents: 0,
    externalInCents: 0,
    externalOutCents: 0,
    valuationCents: 0,
    correctionCents: 0,
    count: 0,
    byCategory: new Map(), // categoryId|null -> { incomeCents, expenseCents }
    byMerchant: new Map(), // lower-case merchant -> { name, expenseCents, count }
    byAccount: new Map(), // accountId -> { incomeCents, expenseCents, transferNetCents, otherCents }
  };
}

function catEntry(acc, key) {
  let e = acc.byCategory.get(key);
  if (!e) {
    e = { incomeCents: 0, expenseCents: 0 };
    acc.byCategory.set(key, e);
  }
  return e;
}

function acctEntry(acc, id) {
  let e = acc.byAccount.get(id);
  if (!e) {
    e = { incomeCents: 0, expenseCents: 0, transferNetCents: 0, otherCents: 0 };
    acc.byAccount.set(id, e);
  }
  return e;
}

/**
 * Add one transaction to an accumulator, honouring the optional category filter.
 * @param {object} acc accumulator @param {object} tx
 * @param {{index:object, categoryIds?:Set<*>|null}} ctx
 */
function accumulate(acc, tx, ctx) {
  const catFilter = ctx.categoryIds;
  const ae = acctEntry(acc, tx.accountId);
  if (tx.kind === 'income' || tx.kind === 'expense') {
    for (const part of categoryParts(tx)) {
      if (catFilter && !catFilter.has(part.categoryId)) continue;
      const ce = catEntry(acc, part.categoryId);
      if (tx.kind === 'income') {
        acc.incomeCents += part.amountCents;
        ce.incomeCents += part.amountCents;
        ae.incomeCents += part.amountCents;
      } else {
        const spend = -part.amountCents;
        if (spend >= 0) acc.grossExpenseCents += spend;
        else acc.refundCents += -spend;
        ce.expenseCents += spend;
        ae.expenseCents += spend;
        const name = merchantOf(tx) || 'Unknown';
        const mk = name.toLowerCase();
        let me = acc.byMerchant.get(mk);
        if (!me) {
          me = { name, expenseCents: 0, count: 0 };
          acc.byMerchant.set(mk, me);
        }
        me.expenseCents += spend;
        me.count += 1;
      }
    }
    acc.count += 1;
    return;
  }
  if (catFilter) return; // transfers/adjustments carry no category
  if (tx.kind === 'transfer') {
    const external = ctx.index.transfersById.get(tx.transferId)?.external === true;
    if (external) {
      if (tx.amountCents >= 0) acc.externalInCents += tx.amountCents;
      else acc.externalOutCents += -tx.amountCents;
    } else if (tx.amountCents >= 0) acc.transferInCents += tx.amountCents;
    else acc.transferOutCents += -tx.amountCents;
    ae.transferNetCents += tx.amountCents;
    acc.count += 1;
    return;
  }
  if (tx.kind === 'adjustment') {
    if (tx.adjustmentKind === 'valuation') acc.valuationCents += tx.amountCents;
    else acc.correctionCents += tx.amountCents;
    ae.otherCents += tx.amountCents;
    acc.count += 1;
  }
}

function finish(acc, accountIds) {
  const netExpenseCents = acc.grossExpenseCents - acc.refundCents;
  const netCashFlowCents = acc.incomeCents - netExpenseCents;
  // Internal transfers are zero-sum when every account is selected; with a subset the
  // net movement into/out of the selection is reported so the identity still closes.
  const internalNetCents = acc.transferInCents - acc.transferOutCents;
  const externalNetCents = acc.externalInCents - acc.externalOutCents;
  const netWorthChangeCents = netCashFlowCents + externalNetCents + acc.valuationCents + acc.correctionCents + internalNetCents;
  return {
    ...acc,
    netExpenseCents,
    netCashFlowCents,
    internalNetCents,
    externalNetCents,
    netWorthChangeCents,
    savingsRatePct: acc.incomeCents > 0 ? Math.round((netCashFlowCents / acc.incomeCents) * 1000) / 10 : null,
    accountsFiltered: Boolean(accountIds),
  };
}

/**
 * Normalise report filters.
 * @param {{start?:string,end?:string,accountIds?:string[]|Set<string>|null,categoryIds?:Array|Set|null,includePending?:boolean}} f
 */
function prep(f) {
  return {
    start: f.start || '0000-01-01',
    end: f.end || '9999-12-31',
    accountIds: f.accountIds && (f.accountIds.size ?? f.accountIds.length) ? new Set(f.accountIds) : null,
    categoryIds: f.categoryIds && (f.categoryIds.size ?? f.categoryIds.length) ? new Set(f.categoryIds) : null,
    includePending: Boolean(f.includePending),
  };
}

function eligible(tx, p) {
  if (tx.date < p.start || tx.date > p.end) return false;
  if (p.accountIds && !p.accountIds.has(tx.accountId)) return false;
  return tx.status === 'posted' || (p.includePending && tx.status === 'pending');
}

/**
 * Aggregate a period. Dates are inclusive on both ends, so transactions on the first
 * and last day of a month or year are always counted exactly once.
 * @returns {object} totals plus byCategory/byMerchant/byAccount Maps
 */
export function summarizePeriod(data, filters) {
  const index = buildIndex(data);
  const p = prep(filters);
  const acc = emptyAcc();
  const ctx = { index, categoryIds: p.categoryIds };
  for (const tx of index.sortedTx) if (eligible(tx, p)) accumulate(acc, tx, ctx);
  return finish(acc, p.accountIds);
}

/**
 * One summary per calendar month from startMonth..endMonth inclusive (zero-filled so
 * months without activity show exact zeros rather than gaps).
 */
export function monthlySeries(data, filters) {
  const index = buildIndex(data);
  const p = prep(filters);
  const startMonth = filters.startMonth || monthKey(p.start);
  const endMonth = filters.endMonth || monthKey(p.end);
  const months = monthRange(startMonth, endMonth);
  const accs = new Map(months.map((m) => [m, emptyAcc()]));
  const lo = monthStart(startMonth);
  const hi = monthEnd(endMonth);
  const ctx = { index, categoryIds: p.categoryIds };
  for (const tx of index.sortedTx) {
    if (tx.date < lo || tx.date > hi) continue;
    if (tx.date < p.start || tx.date > p.end) continue;
    if (!eligible(tx, { ...p, start: lo, end: hi })) continue;
    accumulate(accs.get(monthKey(tx.date)), tx, ctx);
  }
  return months.map((month) => ({ month, ...finish(accs.get(month), p.accountIds) }));
}

/** Sorted category breakdown rows (descending net spending) with a display name. */
export function categoryBreakdown(data, summary, kind = 'expense') {
  const index = buildIndex(data);
  const rows = [];
  for (const [categoryId, e] of summary.byCategory) {
    const amount = kind === 'expense' ? e.expenseCents : e.incomeCents;
    if (amount === 0) continue;
    const cat = categoryId === null ? null : index.categoriesById.get(categoryId);
    rows.push({ categoryId, name: cat ? cat.name : 'Uncategorized', color: cat?.color || '', amountCents: amount });
  }
  rows.sort((a, b) => b.amountCents - a.amountCents || String(a.name).localeCompare(String(b.name)));
  return rows;
}

/** Sorted merchant breakdown rows (descending net spending). */
export function merchantBreakdown(summary) {
  return [...summary.byMerchant.values()]
    .filter((m) => m.expenseCents !== 0)
    .sort((a, b) => b.expenseCents - a.expenseCents || a.name.localeCompare(b.name));
}

/** Transactions that make up a summary (for drill-down), newest first. */
export function transactionsForFilters(data, filters) {
  const index = buildIndex(data);
  const p = prep(filters);
  return index.sortedTx
    .filter((tx) => {
      if (!eligible(tx, p)) return false;
      if (p.categoryIds) {
        if (tx.kind !== 'income' && tx.kind !== 'expense') return false;
        return categoryParts(tx).some((part) => p.categoryIds.has(part.categoryId));
      }
      return true;
    })
    .reverse();
}

/** Month-end dates for the `count` months ending with endMonth. */
export function monthEndDates(endMonth, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) out.push(monthEnd(addMonthKey(endMonth, -i)));
  return out;
}

/**
 * Default reporting period for an as-of date: month-to-date, unless fewer than 7 days
 * of the month have elapsed, in which case the previous complete month is shown (a
 * 1-day "month" is not a useful default). Returned with a human explanation.
 */
export function defaultPeriod(asOfDate) {
  const day = Number(asOfDate.slice(8, 10));
  const cur = monthKey(asOfDate);
  if (day < 7) {
    const prev = addMonthKey(cur, -1);
    return { start: monthStart(prev), end: monthEnd(prev), month: prev, preset: 'last_month', complete: true };
  }
  return { start: monthStart(cur), end: asOfDate, month: cur, preset: 'this_month', complete: false };
}
