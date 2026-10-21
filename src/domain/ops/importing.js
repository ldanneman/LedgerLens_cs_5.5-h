/**
 * Commit and undo CSV import batches. Both are atomic: either every change applies or none.
 */
import { mutate, fail, err } from './common.js';
import { allocId } from '../schema.js';
import { buildIndex } from '../ledger.js';
import { findRule } from '../rules.js';
import { reconciledTxIds } from '../reconciliation.js';

/**
 * Commit a reviewed import plan.
 * @param {object} data
 * @param {{accountId:string, fileName:string, rows:Array}} plan rows carry `match` and optional `decision`
 *   (import | settle | skip). Rejected rows are never imported.
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
  for (const r of toSettle) {
    const ex = r.match.existingTxId && index.txById.get(r.match.existingTxId);
    if (!ex) errs.push(err(`Line ${r.line}: the pending transaction to settle no longer exists.`));
    else if (ex.status !== 'pending') errs.push(err(`Line ${r.line}: "${ex.description}" is no longer pending.`));
    else if (claimed.has(ex.id)) errs.push(err(`Line ${r.line}: that pending item is already settled by another row.`));
    claimed.add(ex?.id);
  }
  const extSeen = new Set(data.transactions.filter((t) => t.accountId === plan.accountId && t.source?.externalId).map((t) => t.source.externalId));
  for (const r of toImport) {
    if (r.externalId && extSeen.has(r.externalId)) errs.push(err(`Line ${r.line}: reference ${r.externalId} already exists in this account, so importing it would create a duplicate.`));
    if (r.externalId) extSeen.add(r.externalId);
    if (r.date < acct.openingDate) errs.push(err(`Line ${r.line}: ${r.date} is before "${acct.name}" was opened (${acct.openingDate}).`));
  }
  if (errs.length) return fail(errs.slice(0, 6));
  return mutate(data, (d) => {
    const batchId = allocId(d, 'batch', 'importBatches');
    const created = [];
    const settled = [];
    const catByName = new Map(data.categories.map((c) => [`${c.kind}:${c.name.toLowerCase()}`, c]));
    for (const r of toSettle) {
      const t = d.transactions.find((x) => x.id === r.match.existingTxId);
      settled.push({ txId: t.id, before: JSON.parse(JSON.stringify(t)) });
      t.status = 'posted';
      t.date = r.date;
      t.amountCents = r.amountCents;
      t.description = r.description;
      if (r.merchant) t.merchant = r.merchant;
      t.source = { type: 'import', batchId, externalId: r.externalId || t.source?.externalId || null, importedAt: ctx.now || null, rawDescription: r.description };
    }
    for (const r of toImport) {
      const id = allocId(d, 'tx', 'transactions');
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
        const rule = findRule({ ...data, transactions: data.transactions }, tx);
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
 * Undo a committed batch: remove only the transactions it created and restore the pending
 * transactions it settled. Refused if any created transaction is part of a valid completed
 * reconciliation (reopen that reconciliation first), so reconciled history is never corrupted.
 */
export function undoImportBatch(data, batchId, ctx = {}) {
  const batch = data.importBatches.find((b) => b.id === batchId);
  if (!batch) return fail('That import batch no longer exists.');
  if (batch.status !== 'committed') return fail('That import batch was already undone.');
  const reconciled = reconciledTxIds(data);
  const index = buildIndex(data);
  const locked = batch.createdTxIds.filter((id) => reconciled.has(id) && index.txById.has(id));
  if (locked.length) return fail(`${locked.length} imported transaction(s) are part of a completed reconciliation. Reopen that reconciliation before undoing this import.`);
  return mutate(data, (d) => {
    const gone = new Set(batch.createdTxIds);
    const before = d.transactions.length;
    d.transactions = d.transactions.filter((t) => !gone.has(t.id));
    const removed = before - d.transactions.length;
    let restored = 0;
    for (const s of batch.settled) {
      const i = d.transactions.findIndex((t) => t.id === s.txId);
      if (i >= 0) {
        d.transactions[i] = s.before;
        restored += 1;
      }
    }
    const b = d.importBatches.find((x) => x.id === batchId);
    b.status = 'undone';
    b.undoneAt = ctx.now || null;
    return { removed, restored, warnings: [] };
  });
}
