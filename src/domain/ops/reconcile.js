/**
 * Reconciliation operations: save a draft, complete (only at a zero discrepancy), reopen, delete,
 * and the explicit "documented adjustment" alternative to a hidden balancing entry.
 */
import { mutate, fail, err, clean } from './common.js';
import { allocId } from '../schema.js';
import { buildIndex } from '../ledger.js';
import { isValidDate } from '../dates.js';
import { isValidCents, formatMoney } from '../money.js';
import { reconcileMath, reconciliationHealth } from '../reconciliation.js';

function validatePayload(data, input, excludeId) {
  const index = buildIndex(data);
  const errs = [];
  const acct = index.accountsById.get(input.accountId);
  if (!acct) errs.push(err('Choose an account.', 'accountId'));
  if (!isValidDate(input.startDate)) errs.push(err('Enter a valid statement start date.', 'startDate'));
  if (!isValidDate(input.endDate)) errs.push(err('Enter a valid statement end date.', 'endDate'));
  if (isValidDate(input.startDate) && isValidDate(input.endDate) && input.endDate < input.startDate) errs.push(err('The statement ends before it starts.', 'endDate'));
  if (!isValidCents(input.openingCents)) errs.push(err('Enter the statement opening balance (valid amount).', 'openingCents'));
  if (!isValidCents(input.closingCents)) errs.push(err('Enter the statement closing balance (valid amount).', 'closingCents'));
  const ids = input.clearedTxIds || [];
  if (new Set(ids).size !== ids.length) errs.push(err('A transaction is listed twice.', 'clearedTxIds'));
  const taken = new Map();
  for (const r of data.reconciliations) {
    if (r.id === excludeId || r.status !== 'completed' || r.accountId !== input.accountId) continue;
    if (reconciliationHealth(data, r).valid) for (const t of r.clearedTxIds) taken.set(t, r);
  }
  for (const id of ids) {
    const tx = index.txById.get(id);
    if (!tx) errs.push(err(`Transaction ${id} no longer exists.`, 'clearedTxIds'));
    else if (tx.accountId !== input.accountId) errs.push(err(`"${tx.description}" belongs to a different account.`, 'clearedTxIds'));
    else if (tx.status !== 'posted') errs.push(err(`"${tx.description}" is still pending; only posted transactions can be cleared.`, 'clearedTxIds'));
    else if (taken.has(id)) errs.push(err(`"${tx.description}" was already cleared in the reconciliation ending ${taken.get(id).endDate}.`, 'clearedTxIds'));
  }
  return errs;
}

function computeFields(data, input) {
  const index = buildIndex(data);
  const effects = (input.clearedTxIds || []).map((id) => index.txById.get(id)?.amountCents ?? 0);
  const m = reconcileMath(input.openingCents, input.closingCents, effects);
  return { calculatedCents: m.calculated, discrepancyCents: m.discrepancy };
}

/** Save (create/update) an in-progress reconciliation without completing it. */
export function saveReconciliationDraft(data, input, ctx = {}) {
  const errs = validatePayload(data, input, input.id);
  const existing = input.id ? data.reconciliations.find((r) => r.id === input.id) : null;
  if (input.id && !existing) errs.push(err('That reconciliation no longer exists.'));
  if (existing && existing.status === 'completed') errs.push(err('That reconciliation is completed. Reopen it to change it.'));
  if (errs.length) return fail(errs);
  const f = computeFields(data, input);
  return mutate(data, (d) => {
    const rec = {
      accountId: input.accountId,
      startDate: input.startDate,
      endDate: input.endDate,
      openingCents: input.openingCents,
      closingCents: input.closingCents,
      clearedTxIds: [...(input.clearedTxIds || [])],
      status: 'in_progress',
      createdAt: existing?.createdAt || ctx.now || null,
      completedAt: null,
      ...f,
      snapshots: [],
      adjustmentTxId: existing?.adjustmentTxId || null,
      note: clean(input.note) || '',
    };
    if (existing) {
      const i = d.reconciliations.findIndex((r) => r.id === existing.id);
      d.reconciliations[i] = { id: existing.id, ...rec };
      return { id: existing.id };
    }
    const id = allocId(d, 'rec', 'reconciliations');
    d.reconciliations.push({ id, ...rec });
    return { id };
  });
}

/** Complete a reconciliation. Refused unless the discrepancy is exactly zero cents. */
export function completeReconciliation(data, input, ctx = {}) {
  const errs = validatePayload(data, input, input.id);
  const existing = input.id ? data.reconciliations.find((r) => r.id === input.id) : null;
  if (existing && existing.status === 'completed') errs.push(err('That reconciliation is already completed.'));
  const f = computeFields(data, input);
  if (!errs.length && f.discrepancyCents !== 0) {
    errs.push(err(`The discrepancy is ${formatMoney(f.discrepancyCents, { signed: true })}, not $0.00. Clear the missing items, correct a date or amount, or record a documented adjustment before completing.`, 'discrepancyCents'));
  }
  if (errs.length) return fail(errs);
  const index = buildIndex(data);
  return mutate(data, (d) => {
    const snapshots = (input.clearedTxIds || []).map((id) => {
      const t = index.txById.get(id);
      return { txId: id, amountCents: t.amountCents, date: t.date, status: t.status, accountId: t.accountId };
    });
    const rec = {
      accountId: input.accountId,
      startDate: input.startDate,
      endDate: input.endDate,
      openingCents: input.openingCents,
      closingCents: input.closingCents,
      clearedTxIds: [...(input.clearedTxIds || [])],
      status: 'completed',
      createdAt: existing?.createdAt || ctx.now || null,
      completedAt: ctx.now || null,
      ...f,
      snapshots,
      adjustmentTxId: existing?.adjustmentTxId || null,
      note: clean(input.note) || '',
    };
    if (existing) {
      d.reconciliations[d.reconciliations.findIndex((r) => r.id === existing.id)] = { id: existing.id, ...rec };
      return { id: existing.id };
    }
    const id = allocId(d, 'rec', 'reconciliations');
    d.reconciliations.push({ id, ...rec });
    return { id };
  });
}

/** Reopen a completed reconciliation for correction (snapshots are discarded, items stay cleared). */
export function reopenReconciliation(data, id) {
  const r = data.reconciliations.find((x) => x.id === id);
  if (!r) return fail('That reconciliation no longer exists.');
  if (r.status !== 'completed') return fail('That reconciliation is not completed.');
  return mutate(data, (d) => {
    const x = d.reconciliations.find((q) => q.id === id);
    x.status = 'in_progress';
    x.completedAt = null;
    x.snapshots = [];
    // items that were deleted or are no longer postable cannot stay cleared
    const index = buildIndex(data);
    x.clearedTxIds = x.clearedTxIds.filter((tid) => {
      const t = index.txById.get(tid);
      return t && t.accountId === x.accountId && t.status === 'posted';
    });
    const eff = x.clearedTxIds.map((tid) => index.txById.get(tid).amountCents);
    const m = reconcileMath(x.openingCents, x.closingCents, eff);
    x.calculatedCents = m.calculated;
    x.discrepancyCents = m.discrepancy;
    return { id };
  });
}

/** Delete a reconciliation record (transactions are untouched). */
export function deleteReconciliation(data, id) {
  if (!data.reconciliations.some((r) => r.id === id)) return fail('That reconciliation no longer exists.');
  return mutate(data, (d) => {
    d.reconciliations = d.reconciliations.filter((r) => r.id !== id);
  });
}

/**
 * Documented-adjustment policy: instead of hiding a difference, create a VISIBLE adjustment
 * transaction (kind 'adjustment', correction) equal to the discrepancy, dated on the statement end
 * date with a mandatory explanation, and clear it in the draft. The user then completes normally.
 */
export function addReconciliationAdjustment(data, input, ctx = {}) {
  const reason = clean(input.reason);
  if (!reason || reason.length < 5) return fail(err('Explain the adjustment (at least 5 characters) so it stays understandable later.', 'reason'));
  const errs = validatePayload(data, input, input.id);
  if (errs.length) return fail(errs);
  const f = computeFields(data, input);
  if (f.discrepancyCents === 0) return fail('There is no discrepancy to adjust.');
  return mutate(data, (d) => {
    const txId = allocId(d, 'tx', 'transactions');
    d.transactions.push({
      id: txId,
      accountId: input.accountId,
      date: input.endDate,
      description: `Reconciliation adjustment: ${reason}`.slice(0, 200),
      merchant: '',
      amountCents: f.discrepancyCents,
      kind: 'adjustment',
      status: 'posted',
      adjustmentKind: 'correction',
      categoryId: null,
      categorySource: null,
      splits: [],
      notes: `Documented adjustment to reconcile statement ending ${input.endDate}. Reason: ${reason}`,
      tags: ['reconciliation-adjustment'],
      transferId: null,
      reversalOf: null,
      recurrence: null,
      source: { type: 'manual', batchId: null, externalId: null, importedAt: ctx.now || null, rawDescription: null },
    });
    const cleared = [...(input.clearedTxIds || []), txId];
    const eff = cleared.map((tid) => (tid === txId ? f.discrepancyCents : buildIndex(data).txById.get(tid).amountCents));
    const m = reconcileMath(input.openingCents, input.closingCents, eff);
    const existing = input.id ? d.reconciliations.find((r) => r.id === input.id) : null;
    const rec = {
      accountId: input.accountId,
      startDate: input.startDate,
      endDate: input.endDate,
      openingCents: input.openingCents,
      closingCents: input.closingCents,
      clearedTxIds: cleared,
      status: 'in_progress',
      createdAt: existing?.createdAt || ctx.now || null,
      completedAt: null,
      calculatedCents: m.calculated,
      discrepancyCents: m.discrepancy,
      snapshots: [],
      adjustmentTxId: txId,
      note: clean(input.note) || '',
    };
    let id;
    if (existing) {
      id = existing.id;
      d.reconciliations[d.reconciliations.findIndex((r) => r.id === id)] = { id, ...rec };
    } else {
      id = allocId(d, 'rec', 'reconciliations');
      d.reconciliations.push({ id, ...rec });
    }
    return { id, adjustmentTxId: txId, warnings: [`Created a visible adjustment of ${formatMoney(f.discrepancyCents, { signed: true })} on ${input.endDate}.`] };
  });
}
