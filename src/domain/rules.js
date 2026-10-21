/**
 * Categorization rules.
 *
 * Precedence (documented in the UI and README):
 *  1. A transaction whose category was set MANUALLY is never changed by a rule.
 *  2. Rules are evaluated in ascending `priority` (lower number = higher priority);
 *     ties break on id. The FIRST enabled matching rule wins.
 *  3. A rule only applies to transactions of the same kind as its category
 *     (an expense category never classifies income) and never to transfers/adjustments.
 *  4. New and imported transactions are auto-categorized only when they have no
 *     category. "Re-apply" can additionally re-evaluate rule/import/seed-assigned ones.
 */
import { buildIndex, merchantOf } from './ledger.js';

/** Sorted copy of rules by priority then id. */
export function sortedRules(rules) {
  return [...rules].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Does a single rule match a transaction-like object? */
export function ruleMatches(rule, tx, categoriesById) {
  if (!rule.enabled) return false;
  if (tx.kind !== 'income' && tx.kind !== 'expense') return false;
  const cat = categoriesById.get(rule.categoryId);
  if (!cat || cat.kind !== tx.kind) return false;
  if (rule.accountId && rule.accountId !== tx.accountId) return false;
  const abs = Math.abs(tx.amountCents);
  if (rule.minAmountCents !== null && rule.minAmountCents !== undefined && abs < rule.minAmountCents) return false;
  if (rule.maxAmountCents !== null && rule.maxAmountCents !== undefined && abs > rule.maxAmountCents) return false;
  const pat = rule.pattern.trim().toLowerCase();
  if (!pat) return false;
  const merchant = merchantOf(tx).toLowerCase();
  const desc = String(tx.description || '').toLowerCase();
  const fields = rule.field === 'merchant' ? [merchant] : rule.field === 'description' ? [desc] : [merchant, desc];
  return fields.some((f) => (rule.match === 'equals' ? f === pat : rule.match === 'starts_with' ? f.startsWith(pat) : f.includes(pat)));
}

/** First matching rule for a transaction, or null. */
export function findRule(data, tx) {
  const index = buildIndex(data);
  return sortedRules(data.rules).find((r) => ruleMatches(r, tx, index.categoriesById)) || null;
}

/**
 * Preview which transactions a rule set would (re)categorize.
 * @param {object} data
 * @param {{ruleIds?: string[]|null, scope?: 'uncategorized'|'non_manual'}} [opts]
 *   scope 'uncategorized' (default): only transactions with no category/splits.
 *   scope 'non_manual': also transactions whose category came from a rule, import or seed.
 * @returns {Array<{txId,description,date,fromCategoryId,toCategoryId,ruleId,ruleName}>}
 */
export function previewRules(data, opts = {}) {
  const index = buildIndex(data);
  const ids = opts.ruleIds ? new Set(opts.ruleIds) : null;
  const rules = sortedRules(data.rules).filter((r) => !ids || ids.has(r.id));
  const scope = opts.scope || 'uncategorized';
  const changes = [];
  for (const tx of data.transactions) {
    if (tx.kind !== 'income' && tx.kind !== 'expense') continue;
    if (tx.splits.length > 0) continue;
    if (tx.categorySource === 'manual') continue;
    if (scope === 'uncategorized' && tx.categoryId) continue;
    const rule = rules.find((r) => ruleMatches(r, tx, index.categoriesById));
    if (!rule || rule.categoryId === tx.categoryId) continue;
    changes.push({
      txId: tx.id,
      description: tx.description,
      date: tx.date,
      fromCategoryId: tx.categoryId,
      toCategoryId: rule.categoryId,
      ruleId: rule.id,
      ruleName: rule.name,
    });
  }
  return changes;
}
