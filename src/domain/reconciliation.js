/**
 * Statement reconciliation maths and health (spec section 11).
 *
 *   calculated close = statement opening + sum(effect of cleared posted transactions)
 *   discrepancy      = statement closing - calculated close      (all in cents)
 *
 * Values use the same signed "net-worth contribution" convention for assets AND
 * liabilities, so a card statement showing $180.00 owed is entered as -$180.00.
 * A reconciliation can be completed only at discrepancy == 0. Because completed
 * reconciliations store a snapshot of every cleared transaction, later edits or
 * deletions are detected (reconciliationHealth) rather than silently ignored.
 */
import { buildIndex, accountContribution } from './ledger.js';
import { addDays } from './dates.js';

/** Core equation. */
export function reconcileMath(openingCents, closingCents, clearedEffects) {
  const clearedSum = clearedEffects.reduce((a, b) => a + b, 0);
  const calculated = openingCents + clearedSum;
  return { clearedSum, calculated, discrepancy: closingCents - calculated };
}

/**
 * Transactions that could be cleared for a statement on `accountId`:
 * posted items dated in [startDate, endDate] not already cleared in another VALID completed
 * reconciliation. With includeEarlier, older still-uncleared posted items are offered too
 * (items that appeared on this statement late).
 */
export function reconciliationCandidates(data, accountId, startDate, endDate, { includeEarlier = false, excludeReconId = null } = {}) {
  const index = buildIndex(data);
  const taken = new Set();
  for (const r of data.reconciliations) {
    if (r.id === excludeReconId || r.status !== 'completed' || r.accountId !== accountId) continue;
    if (reconciliationHealth(data, r).valid) for (const id of r.clearedTxIds) taken.add(id);
  }
  const list = index.txByAccount.get(accountId) || [];
  return list.filter((t) => {
    if (t.status !== 'posted' || taken.has(t.id)) return false;
    if (t.date > endDate) return false;
    return t.date >= startDate || includeEarlier;
  });
}

/**
 * Compare a completed reconciliation's stored snapshots with the live ledger.
 * @returns {{valid:boolean, problems:Array<{txId,type:'deleted'|'amount'|'date'|'status'|'account',message}>}}
 */
export function reconciliationHealth(data, rec) {
  if (rec.status !== 'completed') return { valid: true, problems: [] };
  const index = buildIndex(data);
  const problems = [];
  for (const s of rec.snapshots) {
    const tx = index.txById.get(s.txId);
    if (!tx) {
      problems.push({ txId: s.txId, type: 'deleted', message: `Transaction ${s.txId} was deleted after this reconciliation.` });
      continue;
    }
    if (tx.accountId !== rec.accountId) problems.push({ txId: tx.id, type: 'account', message: `"${tx.description}" was moved to a different account.` });
    if (tx.amountCents !== s.amountCents) problems.push({ txId: tx.id, type: 'amount', message: `"${tx.description}" changed from ${s.amountCents} to ${tx.amountCents} cents.` });
    if (tx.date !== s.date) problems.push({ txId: tx.id, type: 'date', message: `"${tx.description}" moved from ${s.date} to ${tx.date}.` });
    if (tx.status !== 'posted') problems.push({ txId: tx.id, type: 'status', message: `"${tx.description}" is no longer posted.` });
  }
  return { valid: problems.length === 0, problems };
}

/** Completed reconciliations that include a transaction. */
export function reconciliationsContaining(data, txId) {
  return data.reconciliations.filter((r) => r.status === 'completed' && r.clearedTxIds.includes(txId));
}

/** Ids of transactions cleared in any VALID completed reconciliation (their "reconciled" badge). */
export function reconciledTxIds(data) {
  const out = new Set();
  for (const r of data.reconciliations) {
    if (r.status === 'completed' && reconciliationHealth(data, r).valid) for (const id of r.clearedTxIds) out.add(id);
  }
  return out;
}

/** Latest completed, still-valid reconciliation for an account (by end date). */
export function lastReconciliation(data, accountId) {
  return (
    data.reconciliations
      .filter((r) => r.accountId === accountId && r.status === 'completed' && reconciliationHealth(data, r).valid)
      .sort((a, b) => (a.endDate < b.endDate ? 1 : -1))[0] || null
  );
}

/**
 * Suggest statement figures for a period. The opening is the previous completed (still valid)
 * reconciliation's closing when it ends exactly the day before `startDate`; otherwise it is the posted
 * contribution at the end of the previous day (assuming earlier activity is already settled). The closing
 * is the posted contribution at `endDate`. These are only defaults - real statements are typed in by the user.
 */
export function suggestStatement(data, accountId, startDate, endDate) {
  const index = buildIndex(data);
  const prior = addDays(startDate, -1);
  const last = lastReconciliation(data, accountId);
  const opening = last && last.endDate === prior ? last.closingCents : accountContribution(index, accountId, prior, false);
  return { openingCents: opening, closingCents: accountContribution(index, accountId, endDate, false) };
}

/**
 * Explain a non-zero discrepancy: look for a single ledger item whose effect equals the difference.
 * discrepancy = closing - calculated, so a missing cleared effect of exactly `discrepancy` would fix it.
 * @returns {Array<{type:'clear'|'unclear'|'redate'|'missing', message:string, txId?:string}>}
 */
export function diagnoseDiscrepancy(data, { accountId, startDate, endDate, clearedTxIds, discrepancyCents }) {
  if (!discrepancyCents) return [];
  const index = buildIndex(data);
  const cleared = new Set(clearedTxIds);
  const list = (index.txByAccount.get(accountId) || []).filter((t) => t.status === 'posted');
  const out = [];
  for (const t of list) {
    if (!cleared.has(t.id) && t.date >= startDate && t.date <= endDate && t.amountCents === discrepancyCents) {
      out.push({ type: 'clear', txId: t.id, message: `"${t.description}" (${t.date}) is posted in this period but not cleared, and its amount equals the difference. Clearing it may fix the discrepancy.` });
    }
    if (cleared.has(t.id) && t.amountCents === -discrepancyCents) {
      out.push({ type: 'unclear', txId: t.id, message: `"${t.description}" (${t.date}) is cleared and its amount equals the difference with the opposite sign. It may not be on the statement.` });
    }
    if (!cleared.has(t.id) && (t.date < startDate || t.date > endDate) && t.amountCents === discrepancyCents) {
      const days = Math.min(Math.abs((Date.parse(`${t.date}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000), Math.abs((Date.parse(`${t.date}T00:00:00Z`) - Date.parse(`${endDate}T00:00:00Z`)) / 86400000));
      if (days <= 7) out.push({ type: 'redate', txId: t.id, message: `"${t.description}" is dated ${t.date}, ${Math.round(days)} day(s) outside the statement period, and its amount equals the difference. Its date may be wrong, or it posted on the next statement.` });
    }
  }
  const seen = new Map();
  for (const t of list) {
    if (!cleared.has(t.id)) continue;
    const k = `${t.date}|${t.amountCents}|${t.description}`;
    if (seen.has(k) && t.amountCents === -discrepancyCents) out.push({ type: 'unclear', txId: t.id, message: `"${t.description}" appears twice on ${t.date} for the same amount; one may be a duplicate entry.` });
    seen.set(k, t.id);
  }
  if (!out.length) out.push({ type: 'missing', message: 'No single ledger item explains the difference. A transaction may be missing from your ledger (for example a bank fee or interest), or a cleared amount may be wrong.' });
  return out;
}
