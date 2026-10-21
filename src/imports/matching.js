/**
 * Duplicate / pending-settlement matching for imports.
 *
 * Principles (documented in the README):
 *  1. A stable EXTERNAL REFERENCE is authoritative. Same reference in the same account => the same
 *     bank record => already imported (skip). A different reference => a different record, even if
 *     amount, date and merchant are identical (two coffees on one day are both kept).
 *  2. WITHOUT a reference, identical rows are matched by COUNT: if the ledger already holds N entries
 *     with the same date/amount/description and the file has M, only the first N file rows are
 *     flagged "suspected duplicate"; the remaining M-N are treated as additional real purchases.
 *     No transaction is ever dropped silently: suspected rows default to Skip but can be kept.
 *  3. A PENDING ledger item can be settled by a posted row: same reference, or (heuristic) same
 *     account/sign, date within 5 days, amount within max($3, 25%) and similar description.
 *     The heuristic never bridges two DIFFERENT references (both present and unequal = two purchases), on any
 *     path. A reference missing on one side is allowed (banks add one when an item posts). Heuristic matches are
 *     marked basis:'heuristic' and, when several pending items qualify, ambiguous with `alternatives`, so the
 *     preview asks for review; equal amount/date/merchant is evidence, not proof.
 *  4. A pending TRANSFER leg is never settled by an import row (that would post one side of a transfer); a
 *     reference hit on one is reported as already imported, with a pointer to post the transfer itself.
 *  5. When a settlement changes the amount of an item with category splits, the match carries `splitPlan`: the
 *     splits rescaled proportionally to the new amount (rescaleSplits), so they still add up exactly.
 */
import { rescaleSplits } from '../domain/money.js';

/** Lowercase alphanumeric tokens of a description. */
export function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
}

/** Jaccard similarity of two descriptions' token sets (0-1). */
export function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

const norm = (s) => tokens(s).join(' ');
const refOf = (t) => (typeof t?.source?.externalId === 'string' ? t.source.externalId : '');

/** True when two references are both present and different: two separate bank records, never one purchase. */
export function refsConflict(a, b) {
  return Boolean(a) && Boolean(b) && a !== b;
}

/**
 * How the category splits of `pending` would be re-allocated if it settled at `newAmountCents`; undefined when there
 * is nothing to re-allocate (no splits, or the amount did not change).
 * @returns {{policy:'proportional', before:Array, after:Array, dropped:Array}|undefined}
 */
export function settlementSplitPlan(pending, newAmountCents) {
  if (!pending?.splits?.length || pending.amountCents === newAmountCents) return undefined;
  const { splits, dropped } = rescaleSplits(pending.splits, newAmountCents);
  const brief = (list) => list.map((x) => ({ categoryId: x.categoryId, amountCents: x.amountCents }));
  return { policy: 'proportional', before: brief(pending.splits), after: brief(splits), dropped: brief(dropped) };
}
const dayDiff = (a, b) => Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/**
 * Classify every valid normalized row against the ledger.
 * @param {object} data dataset @param {string} accountId destination account
 * @param {Array} rows normalized rows (from normalizeRows) @returns {Array} rows with `match`
 *   match = { type, existingTxId?, reason, action }  type: new | duplicate | suspected | settles_pending | in_file_duplicate
 *   action (default decision): import | skip | settle
 */
export function matchRows(data, accountId, rows) {
  const existing = data.transactions.filter((t) => t.accountId === accountId);
  const byExt = new Map();
  for (const t of existing) if (t.source?.externalId) byExt.set(t.source.externalId, t);
  const claimedPending = new Set();
  const seenExt = new Map();
  const fingerprintCounts = new Map(); // fingerprint -> remaining existing entries without a conflicting reference
  const fp = (date, cents, desc) => `${date}|${cents}|${norm(desc)}`;
  for (const t of existing) {
    if (t.kind === 'transfer' && t.recurrence) continue;
    const k = fp(t.date, t.amountCents, t.description);
    fingerprintCounts.set(k, (fingerprintCounts.get(k) || []).concat(t));
  }
  const used = new Map(); // fingerprint -> how many file rows already consumed
  const withPlan = (match, pending, row) => {
    const splitPlan = settlementSplitPlan(pending, row.amountCents);
    return splitPlan ? { ...match, splitPlan, reason: `${match.reason} The amount changed, so its category splits are rescaled in proportion and still add up exactly.` } : match;
  };
  const pendingList = existing.filter((t) => t.status === 'pending' && t.kind !== 'transfer');

  return rows.map((row) => {
    if (!row.ok) return { ...row, match: { type: 'rejected', reason: row.errors.join(' '), action: 'skip' } };
    if (row.externalId) {
      if (seenExt.has(row.externalId)) {
        return { ...row, match: { type: 'in_file_duplicate', reason: `Reference ${row.externalId} already appears on line ${seenExt.get(row.externalId)} of this file.`, action: 'skip' } };
      }
      seenExt.set(row.externalId, row.line);
      const hit = byExt.get(row.externalId);
      if (hit) {
        if (hit.kind === 'transfer') {
          return { ...row, match: { type: 'duplicate', existingTxId: hit.id, reason: `Reference ${row.externalId} belongs to "${hit.description}", one side of a transfer${hit.status === 'pending' ? ' that is still pending. To post it, mark the transfer posted in Transactions (both sides move together)' : ''}.`, action: 'skip' } };
        }
        if (hit.status === 'pending' && row.status === 'posted' && !claimedPending.has(hit.id)) {
          claimedPending.add(hit.id);
          return { ...row, match: withPlan({ type: 'settles_pending', basis: 'reference', ambiguous: false, alternatives: [], existingTxId: hit.id, reason: `Same reference as pending "${hit.description}"; it will be marked posted.`, action: 'settle' }, hit, row) };
        }
        return { ...row, match: { type: 'duplicate', existingTxId: hit.id, reason: `Reference ${row.externalId} was already imported ("${hit.description}", ${hit.date}).`, action: 'skip' } };
      }
    }
    // pending settlement by heuristic - never across two different references
    if (row.status === 'posted') {
      const tol = (base) => Math.max(300, Math.round(Math.abs(base) * 0.25));
      const cands = pendingList
        .filter((t) => !claimedPending.has(t.id) && !refsConflict(refOf(t), row.externalId))
        .filter((t) => Math.sign(t.amountCents) === Math.sign(row.amountCents))
        .filter((t) => dayDiff(t.date, row.date) <= 5 && Math.abs(t.amountCents - row.amountCents) <= tol(t.amountCents))
        .map((t, order) => ({ t, order, sim: similarity(t.description, row.description), gap: Math.abs(t.amountCents - row.amountCents), days: dayDiff(t.date, row.date) }))
        .filter((c) => c.sim >= 0.5)
        .sort((a, b) => b.sim - a.sim || a.gap - b.gap || a.days - b.days || a.order - b.order);
      if (cands.length) {
        const best = cands[0].t;
        const alternatives = cands.slice(1, 6).map((c) => c.t.id);
        claimedPending.add(best.id);
        const others = alternatives.length ? ` ${alternatives.length} other pending item${alternatives.length === 1 ? '' : 's'} also look${alternatives.length === 1 ? 's' : ''} similar; pick the right one.` : '';
        return { ...row, match: withPlan({ type: 'settles_pending', basis: 'heuristic', ambiguous: alternatives.length > 0, alternatives, existingTxId: best.id, reason: `Looks like the posted version of pending "${best.description}" (${best.date}, ${best.amountCents} cents), matched by date, amount and description - not by a shared reference.${others} Choose "Import as new" if it is a separate purchase.`, action: 'settle' }, best, row) };
      }
    }
    // count-based matching against existing entries that cannot be told apart by reference
    const k = fp(row.date, row.amountCents, row.description);
    const pool = (fingerprintCounts.get(k) || []).filter((t) => !claimedPending.has(t.id) && !(row.externalId && t.source?.externalId && t.source.externalId !== row.externalId));
    const already = used.get(k) || 0;
    if (already < pool.length) {
      used.set(k, already + 1);
      return { ...row, match: { type: 'suspected', existingTxId: pool[already].id, reason: `An identical entry already exists (${pool[already].date}, "${pool[already].description}"). This may be a re-import; choose Keep if it is a separate purchase.`, action: 'skip' } };
    }
    return { ...row, match: { type: 'new', reason: pool.length ? 'Another identical entry; the ledger holds fewer identical rows than this file, so this one is treated as new.' : '', action: 'import' } };
  });
}

/** Summarize decisions for the commit button. */
export function summarizePlan(rows) {
  const s = { total: rows.length, import: 0, settle: 0, skipped: 0, rejected: 0, duplicates: 0, suspected: 0, attention: 0 };
  for (const r of rows) {
    const type = r.match.type;
    const action = r.decision || r.match.action;
    if (type === 'rejected') s.rejected += 1;
    else if (action === 'import') s.import += 1;
    else if (action === 'settle') s.settle += 1;
    else s.skipped += 1;
    if (type === 'duplicate' || type === 'in_file_duplicate') s.duplicates += 1;
    if (type === 'suspected') s.suspected += 1;
    const review = r.match.ambiguous || (type === 'settles_pending' && r.match.basis === 'heuristic' && action === 'settle');
    if ((r.ok && r.warnings.length) || review) s.attention += 1;
  }
  return s;
}
