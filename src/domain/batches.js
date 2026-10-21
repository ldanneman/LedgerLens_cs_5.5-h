/**
 * Import-batch ownership: which live transactions an import batch may delete or restore when it is undone.
 * The structural validator (so a bad batch never enters the dataset) and undoImportBatch (so a stale or
 * tampered batch still cannot touch an unrelated record) both use these rules.
 *
 * A committed batch B relates to transactions in two ways:
 *  - createdTxIds: rows B inserted; undo deletes them. A live one must carry source {type:'import', batchId:B}.
 *  - settled[]:    {txId, before} for pending items B turned into posted ones; undo puts `before` back.
 *                  A live one must carry source.batchId === B.
 * Valid history also contains a row that a LATER committed batch settled (an imported pending row that a later
 * file posted): its source names the later batch, which lists it in its own `settled`. That is "settled_later":
 * accepted by validation, but B cannot be undone until the later batch is.
 */
import { isObj } from './schema.js';

/** Map<txId, Set<batchId>> of the committed batches that settled each transaction. */
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
 * How a live transaction relates to a batch that names it.
 * @param {string} batchId @param {object} tx @param {Map<string, Set<string>>} settlers from settlersOf
 * @returns {'own'|'settled_later'|'foreign'}
 */
export function ownership(batchId, tx, settlers) {
  const src = tx.source;
  if (!isObj(src) || src.type !== 'import') return 'foreign';
  if (src.batchId === batchId) return 'own';
  if (src.batchId && settlers.get(tx.id)?.has(src.batchId)) return 'settled_later';
  return 'foreign';
}

/** Plain-language owner of a transaction, for error messages. */
export function describeOwner(tx) {
  const src = tx.source;
  if (!isObj(src) || src.type !== 'import') return `a ${isObj(src) && typeof src.type === 'string' ? src.type : 'manual'} record, not one created by an import`;
  return src.batchId ? `owned by import batch "${src.batchId}"` : 'an imported record that belongs to no batch';
}
