import { buildIndex, merchantOf } from '../domain/ledger.js';
import { parseMoney } from '../domain/money.js';

export const FILTER_KEYS = ['q', 'acct', 'cat', 'kind', 'status', 'src', 'from', 'to', 'min', 'max', 'tag'];

/** Read filters from URL search params. */
export function filtersFromParams(params) {
  const f = {};
  for (const k of FILTER_KEYS) f[k] = params.get(k) || '';
  return f;
}

/** Number of active filters. */
export const activeFilterCount = (f) => FILTER_KEYS.filter((k) => f[k]).length;

/**
 * Filter transactions. Searching covers description, merchant, notes, tags and external references.
 * Amount limits apply to the absolute amount. 'cat' matches a transaction's category or any split; '__none__' = uncategorized.
 */
export function filterTransactions(data, f) {
  const index = buildIndex(data);
  const needle = f.q.trim().toLowerCase();
  const min = f.min ? parseMoney(f.min, { allowNegative: false }) : null;
  const max = f.max ? parseMoney(f.max, { allowNegative: false }) : null;
  const tag = f.tag.trim().toLowerCase();
  return index.sortedTx.filter((t) => {
    if (f.acct && t.accountId !== f.acct) return false;
    if (f.status && t.status !== f.status) return false;
    if (f.from && t.date < f.from) return false;
    if (f.to && t.date > f.to) return false;
    if (f.kind) {
      if (f.kind === 'refund') {
        if (!(t.kind === 'expense' && t.amountCents > 0)) return false;
      } else if (f.kind === 'expense') {
        if (t.kind !== 'expense') return false;
      } else if (t.kind !== f.kind) return false;
    }
    if (f.src) {
      const s = t.source?.type || 'manual';
      if (f.src === 'imported' ? s !== 'import' : f.src === 'manual' ? s !== 'manual' : s !== f.src) return false;
    }
    if (f.cat) {
      if (f.cat === '__none__') {
        if (!(t.kind === 'income' || t.kind === 'expense') || t.categoryId || t.splits.length) return false;
      } else if (t.categoryId !== f.cat && !t.splits.some((s) => s.categoryId === f.cat)) return false;
    }
    if (min?.ok && Math.abs(t.amountCents) < min.cents) return false;
    if (max?.ok && Math.abs(t.amountCents) > max.cents) return false;
    if (tag && !t.tags.some((x) => x.toLowerCase().includes(tag))) return false;
    if (needle) {
      const hay = `${t.description} ${merchantOf(t)} ${t.notes} ${t.tags.join(' ')} ${t.source?.externalId || ''} ${t.id}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/** Sort a filtered list. Keys: date, description, account, category, amount, merchant. */
export function sortTransactions(data, list, sort) {
  const index = buildIndex(data);
  const dir = sort.dir === 'asc' ? 1 : -1;
  const catName = (t) => (t.splits.length ? 'zz split' : t.categoryId ? index.categoriesById.get(t.categoryId)?.name || '' : 'zzz');
  const key = {
    date: (t) => t.date,
    description: (t) => t.description.toLowerCase(),
    merchant: (t) => merchantOf(t).toLowerCase(),
    account: (t) => index.accountsById.get(t.accountId)?.name.toLowerCase() || '',
    category: (t) => catName(t).toLowerCase(),
    amount: (t) => t.amountCents,
  }[sort.key] || ((t) => t.date);
  const order = index.orderOf;
  return [...list].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (order.get(a.id) - order.get(b.id)) * -1;
  });
}
