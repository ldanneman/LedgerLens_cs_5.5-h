/**
 * Commit and undo CSV import batches. Both are atomic: either every change applies or none.
 */
import { mutate, fail, err } from './common.js';
import { allocId } from '../schema.js';
import { buildIndex } from '../ledger.js';
import { findRule } from '../rules.js';
import { reconciledTxIds } from '../reconciliation.js';
import { settlersOf, ownership, describeOwner } from '../batches.js';
import { refsConflict } from '../../imports/matching.js';
import { rescaleSplits, formatMoney } from '../money.js';

/**
 * Commit a reviewed import plan.
 * @param {object} data
 * @param {{accountId:string, fileName:string, rows:Array}} plan rows carry `match` and optional overrides:
 *   - `decision`  import | settle | skip (default: match.action). Rejected rows are never imported.
 *   - `settleTxId` settle THIS pending item instead of match.existingTxId (e.g. one of match.alternatives).
 *   - `splits`    explicit category allocation [{categoryId, amountCents, note?}] for a settled item; it must add up
 *                 exactly to the posted amount. Without it, a changed amount rescales existing splits proportionally
 *                 (the `match.splitPlan` shown in the preview), so the settlement cannot fail later on a split sum.
 * Every identity rule is re-checked here (not only in the preview): a settlement is refused when the row and the
 * pending item carry different references, when the pending item is gone, claimed twice, in another account or
 * no longer pending, or when the posted reference already belongs to a different transaction.
 * @param {{now?:string}} [ctx]
 * @returns {Result & {batchId:string, imported:number, settled:number, skipped:number, rejected:number}}
 */
export function commitImport(data, plan, ctx = {}) {
  const index = buildIndex(data);
  const acct = index.accountsById.get(plan.accountId);
  if (!acct) return fail('Choose a destination account.');
  if (acct.status === 'archived') return fail(`"${acct.name}" is archived.`);
  const actionOf = (r) => r.decision || r.match.action;
  const toImport = plan.rows.filter((r) => r.match.type !== 'rejected' && actionOf(r) === 'import');
  const toSettle = plan.rows.filter((r) => r.match.type !== 'rejected' && actionOf(r) === 'settle');
  if (!toImport.length && !toSettle.length) return fail('Nothing to import: every row is skipped or rejected.');
  const errs = [];
  const claimed = new Set();
  const splitsFor = new Map(); // pending id -> the exact splits to store when it is settled
  const owner = new Map(); // reference -> id of the live transaction in this account that carries it
  for (const t of data.transactions) if (t.accountId === plan.accountId && t.source?.externalId) owner.set(t.source.externalId, t.id);
  for (const r of toSettle) {
    const exId = r.settleTxId || r.match.existingTxId;
    const ex = exId && index.txById.get(exId);
    if (!ex) {
      errs.push(err(`Line ${r.line}: the pending transaction to settle no longer exists.`));
      continue;
    }
    if (ex.accountId !== plan.accountId) errs.push(err(`Line ${r.line}: "${ex.description}" belongs to a different account.`));
    else if (ex.kind === 'transfer') errs.push(err(`Line ${r.line}: "${ex.description}" is part of a transfer and cannot be settled by an import row.`));
    else if (ex.status !== 'pending') errs.push(err(`Line ${r.line}: "${ex.description}" is no longer pending.`));
    else if (claimed.has(ex.id)) errs.push(err(`Line ${r.line}: that pending item is already settled by another row.`));
    else if (refsConflict(ex.source?.externalId, r.externalId)) errs.push(err(`Line ${r.line}: reference ${r.externalId} differs from reference ${ex.source.externalId} on pending "${ex.description}". Different references are different purchases, so it cannot settle that item; import the row as new instead.`));
    else if (r.externalId && owner.has(r.externalId) && owner.get(r.externalId) !== ex.id) errs.push(err(`Line ${r.line}: reference ${r.externalId} already belongs to another transaction in this account.`));
    claimed.add(ex.id);
    if (r.externalId) owner.set(r.externalId, ex.id);
    // exact splits for the new amount
    if (ex.splits.length || r.splits) {
      if (r.splits) {
        const sum = r.splits.reduce((s, x) => s + (Number.isSafeInteger(x?.amountCents) ? x.amountCents : NaN), 0);
        if (!Array.isArray(r.splits) || !r.splits.length) errs.push(err(`Line ${r.line}: the split allocation is empty.`));
        else if (sum !== r.amountCents) errs.push(err(`Line ${r.line}: the split allocation adds up to ${formatMoney(sum)} but the posted amount is ${formatMoney(r.amountCents)}. Adjust the splits so they match exactly.`, 'splits'));
        else splitsFor.set(ex.id, r.splits.map((x) => ({ categoryId: x.categoryId || null, amountCents: x.amountCents, note: x.note || '' })));
      } else if (r.amountCents !== ex.amountCents) {
        const { splits } = rescaleSplits(ex.splits, r.amountCents);
        splitsFor.set(ex.id, splits);
      }
    }
  }
  for (const r of toImport) {
    if (r.externalId && owner.has(r.externalId)) errs.push(err(`Line ${r.line}: reference ${r.externalId} already exists in this account, so importing it would create a duplicate.`));
    if (r.externalId) owner.set(r.externalId, `row-${r.line}`);
    if (r.date < acct.openingDate) errs.push(err(`Line ${r.line}: ${r.date} is before "${acct.name}" was opened (${acct.openingDate}).`));
  }
  if (errs.length) return fail(errs.slice(0, 6));
  return mutate(data, (d) => {
    const batchId = allocId(d, 'batch', 'importBatches');
    const taken = new Set(data.transactions.map((t) => t.id)); // built once from the plain input: allocating n ids stays O(n)
    const liveById = new Map(d.transactions.map((t) => [t.id, t])); // draft handles for the pending items being settled
    const created = [];
    const settled = [];
    const catByName = new Map(data.categories.map((c) => [`${c.kind}:${c.name.toLowerCase()}`, c]));
    for (const r of toSettle) {
      const t = liveById.get(r.settleTxId || r.match.existingTxId);
      settled.push({ txId: t.id, before: JSON.parse(JSON.stringify(t)) });
      t.status = 'posted';
      t.date = r.date;
      t.amountCents = r.amountCents;
      t.description = r.description;
      if (r.merchant) t.merchant = r.merchant;
      if (splitsFor.has(t.id)) {
        t.splits = splitsFor.get(t.id);
        if (t.splits.length) t.categoryId = null; // splits carry the categories
      }
      t.source = { type: 'import', batchId, externalId: r.externalId || t.source?.externalId || null, importedAt: ctx.now || null, rawDescription: r.description };
    }
    for (const r of toImport) {
      const id = allocId(d, 'tx', 'transactions', taken);
      // Assets: positive = income, negative = expense. Cards/loans: every row is an expense entry, so a
      // positive amount is stored as a refund (expense reversal). Card payments should be linked to their
      // checking-side entry afterwards (see suggestTransferPairs) so they are not counted as spending.
      const isAsset = ['checking', 'savings', 'investment'].includes(acct.type);
      const kind = isAsset && r.amountCents > 0 ? 'income' : 'expense';
      const tx = {
        id,
        accountId: plan.accountId,
        date: r.date,
        description: r.description,
        merchant: r.merchant || '',
        amountCents: r.amountCents,
        kind,
        status: r.status || 'posted',
        adjustmentKind: null,
        categoryId: null,
        categorySource: null,
        splits: [],
        notes: r.notes || '',
        tags: [],
        transferId: null,
        reversalOf: null,
        recurrence: null,
        source: { type: 'import', batchId, externalId: r.externalId || null, importedAt: ctx.now || null, rawDescription: r.description },
      };
      const named = r.categoryName && catByName.get(`${tx.kind}:${r.categoryName.toLowerCase()}`);
      if (named) {
        tx.categoryId = named.id;
        tx.categorySource = 'import';
      } else {
        const rule = findRule(data, tx); // same object every call, so the ledger index is built once (a fresh copy per row would rebuild it per row)
        if (rule) {
          tx.categoryId = rule.categoryId;
          tx.categorySource = 'rule';
        }
      }
      d.transactions.push(tx);
      created.push(id);
    }
    const skipped = plan.rows.filter((r) => r.match.type !== 'rejected' && actionOf(r) === 'skip').length;
    const rejected = plan.rows.filter((r) => r.match.type === 'rejected').length;
    d.importBatches.push({ id: batchId, accountId: plan.accountId, fileName: plan.fileName || '', importedAt: ctx.now || null, status: 'committed', createdTxIds: created, settled, rowCount: plan.rows.length, skippedCount: skipped, rejectedCount: rejected, undoneAt: null });
    return { batchId, imported: created.length, settled: settled.length, skipped, rejected, warnings: [] };
  });
}

/**
 * Undo a committed batch: remove only the transactions it created and restore the pending transactions it settled
 * (amount, splits, status, source: the exact `before` record).
 *
 * Nothing is changed unless EVERY check passes; a refusal explains what to do first:
 *  - ownership: each live created row must still be an import record of THIS batch, and each live settled item must
 *    still be owned by it (a batch whose lists name a manual or foreign record cannot delete it);
 *  - a created row that a later import settled, or that is now half of a transfer, or that was reversed by a later
 *    entry, or that sits in a completed reconciliation, blocks the undo (undo the later import / delete or unlink /
 *    reopen the reconciliation first);
 *  - later edits (category, notes, tags) of created rows do not block: they are part of what is removed. Created
 *    rows or settled items the user already deleted are skipped and reported in `warnings`.
 * @returns {Result & {removed:number, restored:number}}
 */
export function undoImportBatch(data, batchId, ctx = {}) {
  const batch = data.importBatches.find((b) => b.id === batchId);
  if (!batch) return fail('That import batch no longer exists.');
  if (batch.status !== 'committed') return fail('That import batch was already undone.');
  if (!Array.isArray(batch.createdTxIds) || !Array.isArray(batch.settled)) return fail(`Import batch "${batchId}" is malformed (its record lists are not lists), so it cannot be undone safely.`);
  const index = buildIndex(data);
  const settlers = settlersOf(data.importBatches);
  const created = new Set(batch.createdTxIds);
  const settledIds = new Set(batch.settled.map((s) => s?.txId));
  const reconciled = reconciledTxIds(data);
  const reversals = new Map(); // original id -> the entry that reverses it (one pass, not one scan per row)
  for (const x of data.transactions) if (x.reversalOf) reversals.set(x.reversalOf, x);
  const problems = [];
  const lockedByRecon = [];
  const check = (id, role) => {
    const t = index.txById.get(id);
    if (!t) return;
    const own = ownership(batchId, t, settlers);
    if (own === 'foreign') problems.push(`"${t.description}" (${id}) was not created by this import: it is ${describeOwner(t)}. Undoing would touch an unrelated record, so nothing was changed.`);
    else if (own === 'settled_later') problems.push(`"${t.description}" (${id}) was later settled by import "${t.source.batchId}". Undo that import first.`);
    if (t.transferId) problems.push(`"${t.description}" (${id}) is now part of a transfer. Delete or unlink the transfer first so its other side is not left behind.`);
    const reversal = reversals.get(id);
    if (reversal && !created.has(reversal.id)) problems.push(`"${t.description}" (${id}) has been reversed by "${reversal.description}" (${reversal.id}). Delete that reversal first.`);
    if (reconciled.has(id)) lockedByRecon.push(id);
    return role;
  };
  for (const id of batch.createdTxIds) check(id, 'created');
  for (const id of settledIds) if (typeof id === 'string' && !created.has(id)) check(id, 'settled');
  if (lockedByRecon.length) problems.unshift(`${lockedByRecon.length} imported or settled transaction(s) are part of a completed reconciliation. Reopen that reconciliation before undoing this import.`);
  if (problems.length) return fail(problems.slice(0, 6));
  return mutate(data, (d) => {
    const gone = new Set(batch.createdTxIds);
    const before = d.transactions.length;
    d.transactions = d.transactions.filter((t) => !gone.has(t.id));
    const removed = before - d.transactions.length;
    let restored = 0;
    let missing = 0;
    for (const s of batch.settled) {
      const i = d.transactions.findIndex((t) => t.id === s.txId);
      if (i >= 0) {
        d.transactions[i] = JSON.parse(JSON.stringify(s.before));
        restored += 1;
      } else missing += 1;
    }
    const b = d.importBatches.find((x) => x.id === batchId);
    b.status = 'undone';
    b.undoneAt = ctx.now || null;
    const warnings = [];
    if (missing) warnings.push(`${missing} settled pending item${missing === 1 ? '' : 's'} no longer exist${missing === 1 ? 's' : ''} and could not be restored.`);
    return { removed, restored, warnings };
  });
}
