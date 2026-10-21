/**
 * Commit and undo CSV import batches. Both are atomic: either every change applies or none.
 * Identity and ownership rules are re-checked here, not only in the preview, so a stale or hand-made plan or a
 * tampered batch record cannot merge distinct purchases or delete unrelated records.
 */
import { mutate, fail, err } from './common.js';
import { allocId } from '../schema.js';
import { buildIndex } from '../ledger.js';
import { findRule } from '../rules.js';
import { reconciledTxIds } from '../reconciliation.js';
import { settlersOf, ownership, describeOwner } from '../batches.js';
import { rescaleSplits, formatMoney, isValidCents } from '../money.js';
import { refsConflict } from '../../imports/matching.js';

/**
 * Commit a reviewed import plan.
 * @param {object} data
 * @param {{accountId:string, fileName:string, rows:Array}} plan rows carry `match` (from matchRows) and optionally:
 *   - `decision`: import | settle | skip (default match.action). Rejected rows are never imported.
 *   - `settleTxId`: settle this pending item instead of match.existingTxId (e.g. one of match.alternatives).
 *   - `splits`: an explicit category allocation [{categoryId, amountCents, note?}] for a settled item; it must add up
 *     exactly to the posted amount. Without it, a changed amount rescales the item's splits in proportion (the
 *     `match.splitPlan` shown in the preview).
 * A settlement is refused when the pending item is gone, in another account, no longer pending, a transfer leg,
 * already settled by another row, or carries a DIFFERENT reference than the row; and an imported or settled
 * reference may not already belong to another transaction in the account.
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
  const splitsFor = new Map(); // pending id -> exact splits to store when it settles
  const refOwner = new Map(); // reference -> id of the transaction (or file row) that carries it in this account
  for (const t of index.txByAccount.get(plan.accountId) || []) if (t.source?.externalId) refOwner.set(t.source.externalId, t.id);
  for (const r of toSettle) {
    const ex = index.txById.get(r.settleTxId || r.match.existingTxId);
    if (!ex) {
      errs.push(err(`Line ${r.line}: the pending transaction to settle no longer exists.`));
      continue;
    }
    if (ex.accountId !== plan.accountId) errs.push(err(`Line ${r.line}: "${ex.description}" is in a different account.`));
    else if (ex.kind === 'transfer') errs.push(err(`Line ${r.line}: "${ex.description}" is one side of a transfer and cannot be settled by an import row; mark the transfer posted instead.`));
    else if (ex.status !== 'pending') errs.push(err(`Line ${r.line}: "${ex.description}" is no longer pending.`));
    else if (claimed.has(ex.id)) errs.push(err(`Line ${r.line}: that pending item is already settled by another row.`));
    else if (refsConflict(ex.source?.externalId, r.externalId)) errs.push(err(`Line ${r.line}: reference ${r.externalId} differs from reference ${ex.source.externalId} on pending "${ex.description}". Different references are different purchases; import the row as new instead.`));
    else if (r.externalId && refOwner.has(r.externalId) && refOwner.get(r.externalId) !== ex.id) errs.push(err(`Line ${r.line}: reference ${r.externalId} already belongs to another transaction in this account.`));
    claimed.add(ex.id);
    if (r.externalId) refOwner.set(r.externalId, ex.id);
    if (r.splits !== undefined) {
      const ok = Array.isArray(r.splits) && r.splits.length > 0 && r.splits.every((x) => x && isValidCents(x.amountCents));
      const sum = ok ? r.splits.reduce((s, x) => s + x.amountCents, 0) : NaN;
      if (!ok) errs.push(err(`Line ${r.line}: the split allocation must list whole-cent amounts.`, 'splits'));
      else if (sum !== r.amountCents) errs.push(err(`Line ${r.line}: the splits add up to ${formatMoney(sum)} but the posted amount is ${formatMoney(r.amountCents)}. They must match exactly.`, 'splits'));
      else splitsFor.set(ex.id, r.splits.map((x) => ({ categoryId: x.categoryId || null, amountCents: x.amountCents, note: typeof x.note === 'string' ? x.note : '' })));
    } else if (ex.splits.length && r.amountCents !== ex.amountCents) {
      splitsFor.set(ex.id, rescaleSplits(ex.splits, r.amountCents).splits);
    }
  }
  for (const r of toImport) {
    if (r.externalId && refOwner.has(r.externalId)) errs.push(err(`Line ${r.line}: reference ${r.externalId} already exists in this account, so importing it would create a duplicate.`));
    if (r.externalId) refOwner.set(r.externalId, `line ${r.line}`);
    if (r.date < acct.openingDate) errs.push(err(`Line ${r.line}: ${r.date} is before "${acct.name}" was opened (${acct.openingDate}).`));
  }
  if (errs.length) return fail(errs.slice(0, 6));
  return mutate(data, (d) => {
    const batchId = allocId(d, 'batch', 'importBatches');
    const taken = new Set(data.transactions.map((t) => t.id)); // one scan, not one per new id
    const live = new Map(d.transactions.map((t) => [t.id, t]));
    const created = [];
    const settled = [];
    const catByName = new Map(data.categories.map((c) => [`${c.kind}:${c.name.toLowerCase()}`, c]));
    for (const r of toSettle) {
      const t = live.get(r.settleTxId || r.match.existingTxId);
      settled.push({ txId: t.id, before: JSON.parse(JSON.stringify(t)) });
      t.status = 'posted';
      t.date = r.date;
      t.amountCents = r.amountCents;
      t.description = r.description;
      if (r.merchant) t.merchant = r.merchant;
      if (splitsFor.has(t.id)) {
        t.splits = splitsFor.get(t.id);
        if (t.splits.length) t.categoryId = null;
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
        // the same `data` object every time, so its memoized index is reused (a copy would rebuild it per row)
        const rule = findRule(data, tx);
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
 * Undo a committed batch: delete the transactions it created and put back the pending transactions it settled
 * (their exact `before` record: amount, splits, status, source).
 * Ownership is re-checked against the live ledger first, and the undo is refused - changing nothing - when a row
 * the batch names is not its own (a manual or foreign record), was settled later by another import, is now part of
 * a transfer, has been reversed by another entry, or is in a valid completed reconciliation.
 * Later edits (category, notes, tags) of created rows do not block: those rows are still removed. Rows the user
 * already deleted are skipped; settled items that no longer exist are reported in `warnings`.
 * @returns {Result & {removed:number, restored:number}}
 */
export function undoImportBatch(data, batchId, ctx = {}) {
  const batch = data.importBatches.find((b) => b.id === batchId);
  if (!batch) return fail('That import batch no longer exists.');
  if (batch.status !== 'committed') return fail('That import batch was already undone.');
  if (!Array.isArray(batch.createdTxIds) || !Array.isArray(batch.settled)) return fail(`Import batch "${batchId}" is malformed, so it cannot be undone safely.`);
  const index = buildIndex(data);
  const settlers = settlersOf(data.importBatches);
  const created = new Set(batch.createdTxIds);
  const reconciled = reconciledTxIds(data);
  const reversedBy = new Map();
  for (const t of data.transactions) if (t.reversalOf) reversedBy.set(t.reversalOf, t);
  const problems = [];
  let locked = 0;
  const check = (id) => {
    const t = index.txById.get(id);
    if (!t) return;
    const own = ownership(batchId, t, settlers);
    if (own === 'foreign') problems.push(`"${t.description}" (${id}) was not created by this import: it is ${describeOwner(t)}. Undoing would change an unrelated record.`);
    else if (own === 'settled_later') problems.push(`"${t.description}" (${id}) was settled later by import "${t.source.batchId}". Undo that import first.`);
    if (t.transferId) problems.push(`"${t.description}" (${id}) is now one side of a transfer. Delete or unlink the transfer first so its other side is not left behind.`);
    const rev = reversedBy.get(id);
    if (rev && !created.has(rev.id)) problems.push(`"${t.description}" (${id}) was reversed by "${rev.description}" (${rev.id}). Delete the reversal first.`);
    if (reconciled.has(id)) locked += 1;
  };
  for (const id of batch.createdTxIds) check(id);
  for (const s of batch.settled) if (s && typeof s.txId === 'string' && !created.has(s.txId)) check(s.txId);
  if (locked) problems.unshift(`${locked} transaction(s) from this import are part of a completed reconciliation. Reopen that reconciliation before undoing this import.`);
  if (problems.length) return fail(problems.slice(0, 6));
  return mutate(data, (d) => {
    const before = d.transactions.length;
    d.transactions = d.transactions.filter((t) => !created.has(t.id));
    const removed = before - d.transactions.length;
    const position = new Map(d.transactions.map((t, i) => [t.id, i]));
    let restored = 0;
    let missing = 0;
    for (const s of batch.settled) {
      const i = position.get(s.txId);
      if (i === undefined) missing += 1;
      else {
        d.transactions[i] = JSON.parse(JSON.stringify(s.before));
        restored += 1;
      }
    }
    const b = d.importBatches.find((x) => x.id === batchId);
    b.status = 'undone';
    b.undoneAt = ctx.now || null;
    const warnings = missing ? [`${missing} settled pending item${missing === 1 ? '' : 's'} no longer exist${missing === 1 ? 's' : ''} and could not be restored.`] : [];
    return { removed, restored, warnings };
  });
}
