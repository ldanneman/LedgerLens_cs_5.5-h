/**
 * Transaction, split, transfer and reversal operations.
 *
 * Key rules enforced here (and re-checked by the structural validator on commit):
 *  - amounts are non-zero integer cents; splits sum EXACTLY to the parent amount;
 *  - transfers are always created/edited/deleted as a unit, so net worth is never
 *    distorted by a half transfer;
 *  - editing a transaction that is part of a completed reconciliation is allowed but
 *    reported, and the reconciliation shows as out of date (see reconciliation.js);
 *  - corrections are done by editing OR by a visible reversal entry (never silently).
 */
import { mutate, abort, fail, err, clean, cleanTags } from './common.js';
import { allocId } from '../schema.js';
import { buildIndex } from '../ledger.js';
import { isValidDate } from '../dates.js';
import { isValidCents, formatMoney } from '../money.js';
import { findRule } from '../rules.js';
import { reconciliationsContaining } from '../reconciliation.js';

const EDITABLE_KINDS = ['income', 'expense', 'adjustment'];

/** Field-level validation with friendly messages. Returns [{field,message}]. */
export function checkTransactionInput(data, tx, { isNew }) {
  const index = buildIndex(data);
  const errs = [];
  const acct = index.accountsById.get(tx.accountId);
  if (!tx.accountId) errs.push(err('Choose an account.', 'accountId'));
  else if (!acct) errs.push(err(`Account "${tx.accountId}" does not exist.`, 'accountId'));
  else if (isNew && acct.status === 'archived') errs.push(err(`"${acct.name}" is archived and cannot receive new transactions.`, 'accountId'));
  if (!isValidDate(tx.date)) errs.push(err(`"${String(tx.date ?? '')}" is not a valid calendar date (use YYYY-MM-DD).`, 'date'));
  else if (acct && isNew && tx.date < acct.openingDate) errs.push(err(`The date is before "${acct.name}" was opened (${acct.openingDate}).`, 'date'));
  if (typeof tx.description !== 'string' || tx.description.trim() === '') errs.push(err('Enter a description.', 'description'));
  else if (tx.description.length > 200) errs.push(err('Description is longer than 200 characters.', 'description'));
  if (tx.merchant && (typeof tx.merchant !== 'string' || tx.merchant.length > 120)) errs.push(err('Merchant must be text up to 120 characters.', 'merchant'));
  if (!isValidCents(tx.amountCents)) errs.push(err('Amount must be a whole number of cents within +/- $1,000,000,000.', 'amountCents'));
  else if (tx.amountCents === 0) errs.push(err('Amount cannot be zero.', 'amountCents'));
  if (!EDITABLE_KINDS.includes(tx.kind)) errs.push(err('Type must be income, expense or adjustment. Use "Transfer funds" for transfers.', 'kind'));
  if (tx.status !== 'posted' && tx.status !== 'pending') errs.push(err('Status must be posted or pending.', 'status'));
  if (tx.kind === 'adjustment') {
    if (tx.adjustmentKind !== 'valuation' && tx.adjustmentKind !== 'correction') errs.push(err('Choose the adjustment kind (valuation or correction).', 'adjustmentKind'));
    if (tx.categoryId || tx.splits.length) errs.push(err('Adjustments cannot have a category or splits.', 'categoryId'));
  }
  if (Array.isArray(tx.tags)) {
    if (tx.tags.length > 12) errs.push(err('Use at most 12 tags.', 'tags'));
    if (tx.tags.some((t) => t.length > 30)) errs.push(err('Tags are limited to 30 characters.', 'tags'));
  }
  const cat = tx.categoryId ? index.categoriesById.get(tx.categoryId) : null;
  if (tx.categoryId && !cat) errs.push(err(`Category "${tx.categoryId}" does not exist.`, 'categoryId'));
  else if (cat && tx.kind !== 'adjustment' && cat.kind !== tx.kind) errs.push(err(`"${cat.name}" is an ${cat.kind} category, but this is ${tx.kind === 'income' ? 'income' : 'an expense'}.`, 'categoryId'));
  if (tx.splits.length) {
    if (tx.splits.length > 25) errs.push(err('A transaction can have at most 25 splits.', 'splits'));
    let sum = 0;
    let bad = false;
    tx.splits.forEach((s, i) => {
      if (!isValidCents(s.amountCents) || s.amountCents === 0) {
        errs.push(err(`Split ${i + 1}: enter a non-zero amount.`, 'splits'));
        bad = true;
        return;
      }
      sum += s.amountCents;
      if (isValidCents(tx.amountCents) && tx.amountCents !== 0 && Math.sign(s.amountCents) !== Math.sign(tx.amountCents)) {
        errs.push(err(`Split ${i + 1} must have the same sign as the transaction.`, 'splits'));
        bad = true;
      }
      const sc = s.categoryId ? index.categoriesById.get(s.categoryId) : null;
      if (!s.categoryId) errs.push(err(`Split ${i + 1}: choose a category.`, 'splits'));
      else if (!sc) errs.push(err(`Split ${i + 1}: category does not exist.`, 'splits'));
      else if (tx.kind !== 'adjustment' && sc.kind !== tx.kind) errs.push(err(`Split ${i + 1}: "${sc.name}" is not an ${tx.kind} category.`, 'splits'));
    });
    if (!bad && isValidCents(tx.amountCents) && sum !== tx.amountCents) {
      const diff = tx.amountCents - sum;
      errs.push(err(`Splits total ${formatMoney(sum)} but the transaction is ${formatMoney(tx.amountCents)} (${formatMoney(Math.abs(diff))} ${Math.abs(sum) < Math.abs(tx.amountCents) ? 'left unallocated' : 'over-allocated'}). Splits must match exactly.`, 'splits'));
    }
  }
  return errs;
}

/** Normalise raw form-ish input into a transaction-shaped object (no id yet). */
function shape(input, base = {}) {
  const v = (k, d) => (input[k] !== undefined ? input[k] : base[k] !== undefined ? base[k] : d);
  const splits = (input.splits !== undefined ? input.splits : base.splits || []).map((s) => ({ categoryId: s.categoryId || null, amountCents: s.amountCents, note: clean(s.note) || '' }));
  return {
    accountId: v('accountId'),
    date: v('date'),
    description: clean(v('description')),
    merchant: clean(v('merchant', '')) || '',
    amountCents: v('amountCents'),
    kind: v('kind'),
    status: v('status', 'posted'),
    adjustmentKind: v('adjustmentKind', null),
    categoryId: splits.length ? null : v('categoryId', null) || null,
    categorySource: v('categorySource', null),
    splits,
    notes: v('notes', ''),
    tags: cleanTags(v('tags', [])),
    recurrence: v('recurrence', null),
  };
}

function reconWarnings(data, txIds, verb) {
  const out = [];
  const index = buildIndex(data);
  const seen = new Set();
  for (const id of txIds) {
    for (const r of reconciliationsContaining(data, id)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const a = index.accountsById.get(r.accountId);
      out.push(`${verb} a transaction in the completed reconciliation of ${a ? a.name : r.accountId} (${r.startDate} to ${r.endDate}). That reconciliation is now flagged as out of date; reopen it to re-clear.`);
    }
  }
  return out;
}

/**
 * Add an income, expense or adjustment. Refunds are expenses with a positive amount.
 * New transactions without a category are auto-categorized by the first matching rule.
 * @param {object} data @param {object} input @param {{now?:string}} [ctx]
 */
export function addTransaction(data, input, ctx = {}) {
  const tx = shape(input);
  const errs = checkTransactionInput(data, tx, { isNew: true });
  if (errs.length) return fail(errs);
  return mutate(data, (d) => {
    const id = allocId(d, 'tx', 'transactions');
    let { categoryId, categorySource } = tx;
    if (tx.kind !== 'adjustment' && !categoryId && !tx.splits.length) {
      const rule = findRule(data, tx);
      if (rule) {
        categoryId = rule.categoryId;
        categorySource = 'rule';
      }
    } else if (categoryId || tx.splits.length) categorySource = categorySource || 'manual';
    // canonical key order (matches normalizeTransaction) so in-memory data equals what a reload produces
    d.transactions.push({
      id,
      accountId: tx.accountId,
      date: tx.date,
      description: tx.description,
      merchant: tx.merchant,
      amountCents: tx.amountCents,
      kind: tx.kind,
      status: tx.status,
      adjustmentKind: tx.kind === 'adjustment' ? tx.adjustmentKind : null,
      categoryId,
      categorySource,
      splits: tx.splits,
      notes: tx.notes,
      tags: tx.tags,
      transferId: null,
      reversalOf: input.reversalOf || null,
      recurrence: tx.recurrence,
      source: input.source || { type: 'manual', batchId: null, externalId: null, importedAt: ctx.now || null, rawDescription: null },
    });
    const warnings = [];
    if (tx.date > data.settings.asOfDate) warnings.push(`Dated after the as-of date (${data.settings.asOfDate}); it will appear in future activity but not in current balances.`);
    return { id, warnings };
  });
}

/**
 * Edit a transaction. Transfer legs only allow description/merchant/notes/tags here; use
 * updateTransfer for amount, date, accounts and status so both legs stay balanced.
 */
export function updateTransaction(data, id, patch) {
  const index = buildIndex(data);
  const cur = index.txById.get(id);
  if (!cur) return fail(`Transaction "${id}" no longer exists.`);
  if (cur.kind === 'transfer') {
    const allowed = new Set(['description', 'merchant', 'notes', 'tags', 'status']);
    const bad = Object.keys(patch).filter((k) => !allowed.has(k));
    if (bad.length) return fail(`This is part of a transfer. Edit the transfer as a whole to change ${bad.join(', ')} so both sides stay balanced.`);
    if (patch.status !== undefined && patch.status !== 'posted' && patch.status !== 'pending') return fail('Status must be posted or pending.');
  }
  const next = cur.kind === 'transfer' ? { ...shape({}, cur), ...patch } : shape(patch, cur);
  if (cur.kind !== 'transfer') {
    if (cur.splits.length && patch.amountCents !== undefined && patch.amountCents !== cur.amountCents && patch.splits === undefined) {
      return fail(err(`The amount changed to ${formatMoney(patch.amountCents)}, but the existing splits total ${formatMoney(cur.amountCents)}. Edit the split rows so they add up exactly.`, 'splits'));
    }
    const errs = checkTransactionInput(data, next, { isNew: false });
    if (errs.length) return fail(errs);
  }
  return mutate(data, (d) => {
    const t = d.transactions.find((x) => x.id === id);
    const warnings = [];
    if (cur.kind === 'transfer') {
      for (const k of ['description', 'merchant', 'notes', 'status']) if (patch[k] !== undefined) t[k] = patch[k];
      if (patch.tags !== undefined) t.tags = cleanTags(patch.tags);
    } else {
      const touchesReconciled = ['amountCents', 'date', 'status', 'accountId'].some((k) => patch[k] !== undefined && patch[k] !== cur[k]);
      Object.assign(t, {
        accountId: next.accountId,
        date: next.date,
        description: next.description,
        merchant: next.merchant,
        amountCents: next.amountCents,
        kind: next.kind,
        status: next.status,
        adjustmentKind: next.kind === 'adjustment' ? next.adjustmentKind : null,
        categoryId: next.categoryId,
        splits: next.splits,
        notes: next.notes,
        tags: next.tags,
      });
      if (patch.categoryId !== undefined || patch.splits !== undefined) t.categorySource = next.categoryId || next.splits.length ? 'manual' : null;
      if (touchesReconciled) warnings.push(...reconWarnings(data, [id], 'You changed'));
    }
    return { id, warnings };
  });
}

/**
 * Delete transactions. Deleting any leg of a transfer deletes the whole transfer.
 * @param {object} data @param {string[]} ids
 * @returns {Result & {deletedCount:number}}
 */
export function deleteTransactions(data, ids) {
  const index = buildIndex(data);
  const targets = new Set();
  for (const id of ids) {
    const tx = index.txById.get(id);
    if (!tx) continue;
    targets.add(id);
    if (tx.transferId) for (const leg of index.legsByTransfer.get(tx.transferId) || []) targets.add(leg.id);
  }
  if (!targets.size) return fail('Nothing to delete: those transactions no longer exist.');
  return mutate(data, (d) => {
    const warnings = reconWarnings(data, [...targets], 'You deleted');
    d.transactions = d.transactions.filter((t) => !targets.has(t.id));
    d.transfers = d.transfers.filter((tr) => !tr.legIds.some((l) => targets.has(l)));
    return { deletedCount: targets.size, warnings };
  });
}

/**
 * Reverse a transaction (or a whole transfer) with a visible, linked offsetting entry
 * instead of deleting history. The original stays; reports net to zero.
 */
export function reverseTransaction(data, id, { date } = {}) {
  const index = buildIndex(data);
  const orig = index.txById.get(id);
  if (!orig) return fail(`Transaction "${id}" no longer exists.`);
  const when = date || data.settings.asOfDate;
  if (!isValidDate(when)) return fail('Choose a valid date for the reversal.');
  const already = data.transactions.find((t) => t.reversalOf === id);
  if (already) return fail(`"${orig.description}" has already been reversed (${already.id}).`);
  const acct = index.accountsById.get(orig.accountId);
  if (acct && acct.status === 'archived') return fail(`"${acct.name}" is archived; unarchive it before reversing.`);
  return mutate(data, (d) => {
    const created = [];
    if (orig.kind === 'transfer') {
      const legs = index.legsByTransfer.get(orig.transferId) || [orig];
      const tr = index.transfersById.get(orig.transferId);
      const trId = allocId(d, 'xfr', 'transfers');
      const legIds = [];
      for (const leg of legs) {
        const lid = allocId(d, 'tx', 'transactions');
        legIds.push(lid);
        d.transactions.push({
          ...structuredCloneSafe(leg),
          id: lid,
          date: when,
          description: `Reversal: ${leg.description}`,
          amountCents: -leg.amountCents,
          status: 'posted',
          transferId: trId,
          reversalOf: leg.id,
          recurrence: null,
          source: { type: 'reversal', batchId: null, externalId: null, importedAt: null, rawDescription: null },
        });
        created.push(lid);
      }
      d.transfers.push({ id: trId, legIds, external: Boolean(tr?.external), counterparty: tr?.counterparty || '', memo: `Reversal of ${orig.transferId}` });
    } else {
      const lid = allocId(d, 'tx', 'transactions');
      d.transactions.push({
        ...structuredCloneSafe(orig),
        id: lid,
        date: when,
        description: `Reversal: ${orig.description}`,
        amountCents: -orig.amountCents,
        splits: orig.splits.map((s) => ({ ...s, amountCents: -s.amountCents })),
        status: 'posted',
        reversalOf: orig.id,
        recurrence: null,
        categorySource: orig.categorySource,
        source: { type: 'reversal', batchId: null, externalId: null, importedAt: null, rawDescription: null },
      });
      created.push(lid);
    }
    return { createdIds: created, warnings: [] };
  });
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}

/**
 * Bulk edit. patch: { categoryId?: string|null, addTags?: string[], removeTags?: string[], status?: 'posted'|'pending' }.
 * Incompatible transactions (e.g. a category of the wrong kind, or splitting transfers)
 * are skipped and reported in `warnings`; all compatible ones change together.
 */
export function bulkUpdateTransactions(data, ids, patch) {
  const index = buildIndex(data);
  const cat = patch.categoryId ? index.categoriesById.get(patch.categoryId) : null;
  if (patch.categoryId && !cat) return fail('That category does not exist.');
  if (patch.status && patch.status !== 'posted' && patch.status !== 'pending') return fail('Status must be posted or pending.');
  const skipped = [];
  const targets = [];
  for (const id of ids) {
    const tx = index.txById.get(id);
    if (!tx) continue;
    if (patch.categoryId !== undefined) {
      if (tx.kind === 'transfer' || tx.kind === 'adjustment') {
        skipped.push(`"${tx.description}" (${tx.kind}s have no category)`);
        continue;
      }
      if (cat && cat.kind !== tx.kind) {
        skipped.push(`"${tx.description}" (${tx.kind} cannot use the ${cat.kind} category "${cat.name}")`);
        continue;
      }
    }
    targets.push(tx.id);
  }
  if (!targets.length) return fail(skipped.length ? `Nothing was changed. Skipped: ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? '...' : ''}` : 'No transactions selected.');
  return mutate(data, (d) => {
    const set = new Set(targets);
    const warnings = [];
    let reconTouched = false;
    for (const t of d.transactions) {
      if (!set.has(t.id)) continue;
      if (patch.categoryId !== undefined && t.kind !== 'transfer' && t.kind !== 'adjustment') {
        t.categoryId = patch.categoryId;
        t.splits = [];
        t.categorySource = patch.categoryId ? 'manual' : null;
      }
      if (patch.addTags?.length) t.tags = cleanTags([...t.tags, ...patch.addTags]);
      if (patch.removeTags?.length) {
        const rm = new Set(patch.removeTags.map((x) => x.toLowerCase()));
        t.tags = t.tags.filter((x) => !rm.has(x.toLowerCase()));
      }
      if (patch.status && t.status !== patch.status) {
        t.status = patch.status;
        reconTouched = true;
      }
    }
    if (reconTouched) warnings.push(...reconWarnings(data, targets, 'You changed'));
    if (skipped.length) warnings.push(`Skipped ${skipped.length}: ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? '...' : ''}`);
    return { updatedCount: targets.length, warnings };
  });
}

// ------------------------------------------------------------------ transfers

function checkTransferInput(data, t, existingId = null) {
  const index = buildIndex(data);
  const errs = [];
  const from = index.accountsById.get(t.fromAccountId);
  const to = index.accountsById.get(t.toAccountId);
  if (!t.fromAccountId) errs.push(err('Choose the account the money comes from.', 'fromAccountId'));
  else if (!from) errs.push(err('The source account does not exist.', 'fromAccountId'));
  else if (!existingId && from.status === 'archived') errs.push(err(`"${from.name}" is archived.`, 'fromAccountId'));
  if (!t.toAccountId) errs.push(err('Choose the account the money goes to.', 'toAccountId'));
  else if (!to) errs.push(err('The destination account does not exist.', 'toAccountId'));
  else if (!existingId && to.status === 'archived') errs.push(err(`"${to.name}" is archived.`, 'toAccountId'));
  if (t.fromAccountId && t.fromAccountId === t.toAccountId) errs.push(err('Source and destination must be different accounts.', 'toAccountId'));
  if (!isValidCents(t.amountCents) || t.amountCents <= 0) errs.push(err('Enter a positive amount (whole cents).', 'amountCents'));
  if (!isValidDate(t.date)) errs.push(err(`"${String(t.date ?? '')}" is not a valid calendar date (use YYYY-MM-DD).`, 'date'));
  else {
    if (from && !existingId && t.date < from.openingDate) errs.push(err(`The date is before "${from.name}" was opened.`, 'date'));
    if (to && !existingId && t.date < to.openingDate) errs.push(err(`The date is before "${to.name}" was opened.`, 'date'));
  }
  if (t.status !== 'posted' && t.status !== 'pending') errs.push(err('Status must be posted or pending.', 'status'));
  if (t.description && t.description.length > 200) errs.push(err('Description is longer than 200 characters.', 'description'));
  return errs;
}

/**
 * Move money between two tracked accounts as ONE action: two linked legs sharing a
 * transfer id, always summing to zero.
 *   from leg: -amount on the source's contribution; to leg: +amount on the destination's.
 * This one formula is right for every pairing: asset->asset, asset->liability (a card or
 * loan payment lowers the amount owed), liability->asset (cash advance) and
 * liability->liability (balance transfer).
 */
export function addTransfer(data, input) {
  const t = {
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amountCents: input.amountCents,
    date: input.date,
    status: input.status || 'posted',
    description: clean(input.description) || '',
    memo: clean(input.memo) || '',
  };
  const errs = checkTransferInput(data, t);
  if (errs.length) return fail(errs);
  const index = buildIndex(data);
  const from = index.accountsById.get(t.fromAccountId);
  const to = index.accountsById.get(t.toAccountId);
  return mutate(data, (d) => {
    const trId = allocId(d, 'xfr', 'transfers');
    const a = allocId(d, 'tx', 'transactions');
    const b = allocId(d, 'tx', 'transactions');
    const base = { date: t.date, kind: 'transfer', status: t.status, adjustmentKind: null, categoryId: null, categorySource: null, splits: [], notes: t.memo, tags: [], transferId: trId, reversalOf: null, recurrence: input.recurrence || null, source: input.source || { type: 'manual', batchId: null, externalId: null, importedAt: null, rawDescription: null } };
    d.transactions.push({ id: a, accountId: from.id, description: t.description || `Transfer to ${to.name}`, merchant: '', amountCents: -t.amountCents, ...base });
    d.transactions.push({ id: b, accountId: to.id, description: t.description || `Transfer from ${from.name}`, merchant: '', amountCents: t.amountCents, ...base });
    d.transfers.push({ id: trId, legIds: [a, b], external: false, counterparty: '', memo: t.memo });
    return { id: trId, legIds: [a, b], warnings: [] };
  });
}

/**
 * Record money moving to/from an account OUTSIDE the tracked set. Accounting choice:
 * a single linked leg of kind "transfer" that changes net worth (money genuinely left or
 * entered the tracked world) but is reported as neither income nor spending, on its own
 * "External transfers" line.
 */
export function addExternalTransfer(data, input) {
  const amount = input.amountCents;
  const dir = input.direction === 'in' ? 'in' : 'out';
  const errs = [];
  const index = buildIndex(data);
  const acct = index.accountsById.get(input.accountId);
  if (!acct) errs.push(err('Choose a tracked account.', 'accountId'));
  else if (acct.status === 'archived') errs.push(err(`"${acct.name}" is archived.`, 'accountId'));
  if (!isValidCents(amount) || amount <= 0) errs.push(err('Enter a positive amount (whole cents).', 'amountCents'));
  if (!isValidDate(input.date)) errs.push(err('Enter a valid date (YYYY-MM-DD).', 'date'));
  if (!clean(input.counterparty)) errs.push(err('Name the outside account or person.', 'counterparty'));
  if (errs.length) return fail(errs);
  return mutate(data, (d) => {
    const trId = allocId(d, 'xfr', 'transfers');
    const id = allocId(d, 'tx', 'transactions');
    d.transactions.push({
      id,
      accountId: acct.id,
      date: input.date,
      description: clean(input.description) || (dir === 'out' ? `Transfer to ${clean(input.counterparty)}` : `Transfer from ${clean(input.counterparty)}`),
      merchant: '',
      amountCents: dir === 'out' ? -amount : amount,
      kind: 'transfer',
      status: input.status || 'posted',
      adjustmentKind: null,
      categoryId: null,
      categorySource: null,
      splits: [],
      notes: '',
      tags: [],
      transferId: trId,
      reversalOf: null,
      recurrence: null,
      source: { type: 'manual', batchId: null, externalId: null, importedAt: null, rawDescription: null },
    });
    d.transfers.push({ id: trId, legIds: [id], external: true, counterparty: clean(input.counterparty), memo: '' });
    return { id: trId, legIds: [id], warnings: ['External transfers change net worth but are not counted as income or spending.'] };
  });
}

/**
 * Edit an internal transfer as a whole. Both legs are rewritten together:
 * patch may contain fromAccountId, toAccountId, amountCents (positive), date, status, description, memo.
 */
export function updateTransfer(data, transferId, patch) {
  const index = buildIndex(data);
  const tr = index.transfersById.get(transferId);
  if (!tr) return fail(`Transfer "${transferId}" no longer exists.`);
  const legs = index.legsByTransfer.get(transferId) || [];
  if (tr.external) {
    const leg = legs[0];
    if (!leg) return fail('This external transfer has no leg to edit.');
    const amt = patch.amountCents !== undefined ? patch.amountCents : Math.abs(leg.amountCents);
    if (!isValidCents(amt) || amt <= 0) return fail(err('Enter a positive amount (whole cents).', 'amountCents'));
    if (patch.date !== undefined && !isValidDate(patch.date)) return fail(err('Enter a valid date (YYYY-MM-DD).', 'date'));
    return mutate(data, (d) => {
      const t = d.transactions.find((x) => x.id === leg.id);
      t.amountCents = leg.amountCents < 0 ? -amt : amt;
      if (patch.date !== undefined) t.date = patch.date;
      if (patch.status !== undefined) t.status = patch.status;
      if (patch.description !== undefined) t.description = clean(patch.description) || t.description;
      return { id: transferId, warnings: reconWarnings(data, [leg.id], 'You changed') };
    });
  }
  const fromLeg = legs.find((l) => l.amountCents < 0);
  const toLeg = legs.find((l) => l.amountCents > 0);
  if (legs.length !== 2 || !fromLeg || !toLeg) return fail('This transfer is malformed (it needs one outgoing and one incoming leg). Delete and recreate it.');
  const t = {
    fromAccountId: patch.fromAccountId ?? fromLeg.accountId,
    toAccountId: patch.toAccountId ?? toLeg.accountId,
    amountCents: patch.amountCents ?? toLeg.amountCents,
    date: patch.date ?? fromLeg.date,
    status: patch.status ?? fromLeg.status,
    description: patch.description,
  };
  const errs = checkTransferInput(data, t, transferId);
  if (errs.length) return fail(errs);
  return mutate(data, (d) => {
    const a = d.transactions.find((x) => x.id === fromLeg.id);
    const b = d.transactions.find((x) => x.id === toLeg.id);
    const changed = fromLeg.amountCents !== -t.amountCents || fromLeg.date !== t.date || fromLeg.accountId !== t.fromAccountId || toLeg.accountId !== t.toAccountId || fromLeg.status !== t.status;
    a.accountId = t.fromAccountId;
    b.accountId = t.toAccountId;
    a.amountCents = -t.amountCents;
    b.amountCents = t.amountCents;
    a.date = t.date;
    b.date = t.date;
    a.status = t.status;
    b.status = t.status;
    if (t.description !== undefined && clean(t.description)) {
      a.description = clean(t.description);
      b.description = clean(t.description);
    }
    if (patch.memo !== undefined) {
      const trd = d.transfers.find((x) => x.id === transferId);
      trd.memo = clean(patch.memo) || '';
    }
    return { id: transferId, warnings: changed ? reconWarnings(data, [fromLeg.id, toLeg.id], 'You changed') : [] };
  });
}

/**
 * Convert two existing, opposite-signed entries in different accounts into ONE linked transfer
 * (for example a card payment imported separately from each side). Their categories/splits are
 * cleared, they stop counting as income/spending, and they share a transfer id.
 */
export function linkAsTransfer(data, idA, idB) {
  const index = buildIndex(data);
  const a = index.txById.get(idA);
  const b = index.txById.get(idB);
  if (!a || !b) return fail('One of those transactions no longer exists.');
  if (a.id === b.id) return fail('Choose two different transactions.');
  if (a.kind === 'transfer' || b.kind === 'transfer') return fail('One of them is already part of a transfer.');
  if (a.kind === 'adjustment' || b.kind === 'adjustment') return fail('Adjustments cannot be turned into transfers.');
  if (a.accountId === b.accountId) return fail('The two entries must be in different accounts.');
  if (a.amountCents + b.amountCents !== 0) return fail(`The amounts must be equal and opposite (${a.amountCents} and ${b.amountCents} cents do not cancel).`);
  return mutate(data, (d) => {
    const trId = allocId(d, 'xfr', 'transfers');
    for (const id of [idA, idB]) {
      const t = d.transactions.find((x) => x.id === id);
      t.kind = 'transfer';
      t.transferId = trId;
      t.categoryId = null;
      t.categorySource = null;
      t.splits = [];
      t.adjustmentKind = null;
    }
    d.transfers.push({ id: trId, legIds: [idA, idB], external: false, counterparty: '', memo: 'Linked from two separate entries' });
    return { id: trId, warnings: reconWarnings(data, [idA, idB], 'You changed') };
  });
}

/**
 * Find likely transfer pairs among unlinked entries: opposite amounts, different accounts, dates within
 * 4 days, and at least one description mentioning payment/transfer. Used after imports so card and
 * loan payments are not double counted as spending.
 */
export function suggestTransferPairs(data) {
  const cands = data.transactions.filter((t) => (t.kind === 'income' || t.kind === 'expense') && !t.reversalOf);
  const byAmount = new Map();
  for (const t of cands) {
    if (!byAmount.has(t.amountCents)) byAmount.set(t.amountCents, []);
    byAmount.get(t.amountCents).push(t);
  }
  const used = new Set();
  const out = [];
  const looks = /pay(ment)?|transfer|xfer|autopay|thank you/i;
  for (const t of cands) {
    if (t.amountCents >= 0 || used.has(t.id)) continue;
    const partners = (byAmount.get(-t.amountCents) || []).filter((p) => !used.has(p.id) && p.accountId !== t.accountId && Math.abs((Date.parse(`${p.date}T00:00:00Z`) - Date.parse(`${t.date}T00:00:00Z`)) / 86400000) <= 4);
    const best = partners.filter((p) => looks.test(t.description) || looks.test(p.description))[0];
    if (best) {
      used.add(t.id);
      used.add(best.id);
      out.push({ outflow: t, inflow: best });
    }
  }
  return out;
}

export { abort };
