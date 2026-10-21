/**
 * Ledger engine: indexing, account balances, net worth, running ledgers.
 *
 * Sign convention (spec 3.2): every transaction stores `amountCents`, its signed
 * effect on the owning account's NET-WORTH CONTRIBUTION.
 *   - asset accounts   : contribution = balance            (deposit +, withdrawal -)
 *   - liability accounts: contribution = -(amount owed)    (purchase -, payment +)
 *
 *   contribution(account, D) = opening (if D >= openingDate)
 *                            + sum(effect of eligible transactions dated <= D)
 *   net worth(D)             = sum(contribution over all accounts)
 *
 * "Eligible" means status 'posted', or also 'pending' when includePending is set.
 * Nothing here caches money amounts: every figure is derived from canonical records.
 */
import { ASSET_TYPES, LIABILITY_TYPES } from './schema.js';

const indexCache = new WeakMap();

/** True for liability account types (credit card, loans). */
export function isLiabilityType(type) {
  return LIABILITY_TYPES.includes(type);
}

/** True for asset account types. */
export function isAssetType(type) {
  return ASSET_TYPES.includes(type);
}

/**
 * Build (and memoise per dataset object) lookup tables. All id lookups use Map so
 * ids such as "__proto__" or "constructor" behave like ordinary data.
 * @param {object} data dataset
 */
export function buildIndex(data) {
  const hit = indexCache.get(data);
  if (hit) return hit;
  const accountsById = new Map();
  for (const a of data.accounts) accountsById.set(a.id, a);
  const categoriesById = new Map();
  for (const c of data.categories) categoriesById.set(c.id, c);
  const txById = new Map();
  const orderOf = new Map();
  data.transactions.forEach((t, i) => {
    txById.set(t.id, t);
    orderOf.set(t.id, i);
  });
  const sortedTx = [...data.transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : orderOf.get(a.id) - orderOf.get(b.id)));
  const txByAccount = new Map();
  for (const a of data.accounts) txByAccount.set(a.id, []);
  for (const t of sortedTx) {
    const list = txByAccount.get(t.accountId);
    if (list) list.push(t);
  }
  const transfersById = new Map();
  for (const tr of data.transfers) transfersById.set(tr.id, tr);
  const legsByTransfer = new Map();
  for (const t of data.transactions) {
    if (t.transferId) {
      if (!legsByTransfer.has(t.transferId)) legsByTransfer.set(t.transferId, []);
      legsByTransfer.get(t.transferId).push(t);
    }
  }
  const idx = { data, accountsById, categoriesById, txById, orderOf, sortedTx, txByAccount, transfersById, legsByTransfer };
  indexCache.set(data, idx);
  return idx;
}

/** Whether a transaction counts for the given basis. */
export function isEligible(tx, includePending) {
  return tx.status === 'posted' || (includePending && tx.status === 'pending');
}

/** Whether the dataset's chosen reporting basis includes pending items. */
export function basisIncludesPending(data) {
  return data.settings?.basis === 'pending';
}

/** Contribution of one account at `date` (inclusive). */
export function accountContribution(index, accountId, date, includePending = false) {
  const acct = index.accountsById.get(accountId);
  if (!acct) return 0;
  let total = date >= acct.openingDate ? acct.openingCents : 0;
  for (const t of index.txByAccount.get(accountId) || []) {
    if (t.date > date) break;
    if (isEligible(t, includePending)) total += t.amountCents;
  }
  return total;
}

/**
 * Detailed position of one account at `date`:
 *  posted      - opening + posted effects
 *  pending     - sum of pending effects (not in posted)
 *  available   - posted + pending (what is spendable / owed including holds)
 *  future      - effects dated after `date` (not included anywhere above)
 */
export function accountPosition(index, accountId, date) {
  const acct = index.accountsById.get(accountId);
  if (!acct) return { openingCents: 0, postedCents: 0, pendingCents: 0, availableCents: 0, futureCents: 0, postedCount: 0, pendingCount: 0, futureCount: 0 };
  const opening = date >= acct.openingDate ? acct.openingCents : 0;
  let posted = opening;
  let pending = 0;
  let future = 0;
  let postedCount = 0;
  let pendingCount = 0;
  let futureCount = 0;
  for (const t of index.txByAccount.get(accountId) || []) {
    if (t.date > date) {
      future += t.amountCents;
      futureCount += 1;
    } else if (t.status === 'posted') {
      posted += t.amountCents;
      postedCount += 1;
    } else {
      pending += t.amountCents;
      pendingCount += 1;
    }
  }
  return { openingCents: opening, postedCents: posted, pendingCents: pending, availableCents: posted + pending, futureCents: future, postedCount, pendingCount, futureCount };
}

/** Map accountId -> contribution at `date`. */
export function balancesAt(index, date, includePending = false) {
  const out = new Map();
  for (const a of index.data.accounts) out.set(a.id, accountContribution(index, a.id, date, includePending));
  return out;
}

/**
 * Contribution of every account at each of `dates` (ascending). One pass per
 * account, so a 13-month history over 2,000 transactions is cheap.
 * @returns {Map<string, number[]>}
 */
export function balanceSeries(index, dates, includePending = false) {
  const out = new Map();
  for (const a of index.data.accounts) {
    const series = [];
    const list = index.txByAccount.get(a.id) || [];
    let p = 0;
    let running = 0;
    for (const d of dates) {
      while (p < list.length && list[p].date <= d) {
        if (isEligible(list[p], includePending)) running += list[p].amountCents;
        p += 1;
      }
      series.push((d >= a.openingDate ? a.openingCents : 0) + running);
    }
    out.set(a.id, series);
  }
  return out;
}

/**
 * Net worth snapshot from a contribution map.
 * assets = sum of asset-account contributions; liabilities = amount owed (positive);
 * netWorth = assets - liabilities = sum of all contributions.
 */
export function netWorthFromBalances(index, balances) {
  let assets = 0;
  let liabilities = 0;
  const byType = {};
  for (const a of index.data.accounts) {
    const v = balances.get(a.id) || 0;
    if (isLiabilityType(a.type)) liabilities += -v;
    else assets += v;
    byType[a.type] = (byType[a.type] || 0) + v;
  }
  return { assets, liabilities, netWorth: assets - liabilities, byType };
}

/** Net worth at one date. */
export function netWorthAt(index, date, includePending = false) {
  return netWorthFromBalances(index, balancesAt(index, date, includePending));
}

/** Net worth snapshots for several dates. */
export function netWorthSeries(index, dates, includePending = false) {
  const series = balanceSeries(index, dates, includePending);
  return dates.map((date, i) => {
    const balances = new Map();
    for (const [id, arr] of series) balances.set(id, arr[i]);
    return { date, ...netWorthFromBalances(index, balances), balances };
  });
}

/**
 * Chronological running ledger for an account. Each row carries the posted-only
 * running balance and the pending-inclusive running balance so both views can be
 * shown side by side without mixing them up.
 * @returns {Array<{tx:object, effect:number, postedBalance:number, inclusiveBalance:number}>}
 */
export function runningLedger(index, accountId) {
  const acct = index.accountsById.get(accountId);
  if (!acct) return [];
  const rows = [];
  let posted = acct.openingCents;
  let inclusive = acct.openingCents;
  for (const t of index.txByAccount.get(accountId) || []) {
    inclusive += t.amountCents;
    if (t.status === 'posted') posted += t.amountCents;
    rows.push({ tx: t, effect: t.amountCents, postedBalance: posted, inclusiveBalance: inclusive });
  }
  return rows;
}

/** Independent re-aggregation used by the verifier: no index, no sorting, no early exits. */
export function naiveContribution(data, accountId, date, includePending) {
  const acct = data.accounts.find((a) => a.id === accountId);
  if (!acct) return 0;
  let total = date >= acct.openingDate ? acct.openingCents : 0;
  for (const t of data.transactions) {
    if (t.accountId !== accountId || t.date > date) continue;
    if (t.status === 'posted' || (includePending && t.status === 'pending')) total += t.amountCents;
  }
  return total;
}

/** Category parts of a transaction: its splits, or one part for the whole amount. */
export function categoryParts(tx) {
  if (Array.isArray(tx.splits) && tx.splits.length > 0) return tx.splits.map((s) => ({ categoryId: s.categoryId ?? null, amountCents: s.amountCents }));
  return [{ categoryId: tx.categoryId ?? null, amountCents: tx.amountCents }];
}

/** Display merchant: explicit merchant, else the description. */
export function merchantOf(tx) {
  const m = typeof tx.merchant === 'string' ? tx.merchant.trim() : '';
  return m || (typeof tx.description === 'string' ? tx.description.trim() : '');
}

/** The legs of a transfer (live transactions), or [] for a non-transfer. */
export function transferLegs(index, tx) {
  if (!tx.transferId) return [];
  return index.legsByTransfer.get(tx.transferId) || [];
}

/** The other leg of an internal transfer, if present. */
export function counterpartLeg(index, tx) {
  return transferLegs(index, tx).find((l) => l.id !== tx.id) || null;
}

/** Credit utilisation (0-100) for a credit-card account position, or null without a limit. */
export function utilization(acct, contributionCents) {
  if (!acct.creditLimitCents) return null;
  return Math.max(0, Math.round((-contributionCents / acct.creditLimitCents) * 1000) / 10);
}
