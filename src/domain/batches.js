/**
 * Import-batch ownership: the one place that decides which live transactions an import batch may delete or
 * restore when it is undone. Used by validateStructure (so a bad batch can never enter the dataset) and by
 * undoImportBatch (so a stale or tampered batch cannot delete an unrelated record even if one slipped in).
 *
 * A committed batch B relates to transactions in two ways:
 *  - createdTxIds : rows B inserted. Undo deletes them. Each must still carry source {type:'import', batchId:B}.
 *  - settled      : [{txId, before}] pending items B turned into posted ones. Undo restores `before`.
 *                   Each live one must still carry source.batchId === B.
 * Valid history includes a created row that a LATER committed batch settled (its source now names that later
 * batch, which lists the row in its own `settled`): that is "settled_later", accepted when validating but not
 * undoable until the later batch is undone first.
 */
import { isObj } from './schema.js';

/** Map<txId, Set<batchId>> of committed batches that settled the transaction. */
export function settlersOf(batches) {
  const out = new Map();
  if (!Array.isArray(batches)) return out;
  for (const b of batches) {
    if (!isObj(b) || b.status !== 'committed' || !Array.isArray(b.settled)) continue;
    for (const s of b.settled) {
      if (!isObj(s) || typeof s.txId !== 'string') continue;
      if (!out.has(s.txId)) out.set(s.txId, new Set());
      out.get(s.txId).add(b.id);
    }
  }
  return out;
}

/**
 * How a live transaction relates to a batch that claims it.
 * @returns {'own'|'settled_later'|'foreign'}
 */
export function ownership(batchId, tx, settlers) {
  const src = tx.source;
  if (!isObj(src) || src.type !== 'import') return 'foreign';
  if (src.batchId === batchId) return 'own';
  if (src.batchId && settlers.get(tx.id)?.has(src.batchId)) return 'settled_later';
  return 'foreign';
}

/** Human description of who really owns a transaction, for messages. */
export function describeOwner(tx) {
  const src = tx.source;
  if (!isObj(src) || src.type !== 'import') return `a ${isObj(src) && typeof src.type === 'string' ? src.type : 'manual'} record, not an imported one`;
  return src.batchId ? `owned by import batch "${src.batchId}"` : 'an imported record without a batch';
}
