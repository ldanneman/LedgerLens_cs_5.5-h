/**
 * Explicit, user-chosen repairs for a known problem in data written by earlier versions.
 *
 * LedgerLens never "fixes" financial history on its own. Earlier versions let one leg of an internal transfer be
 * marked posted while the other stayed pending; the validator now rejects that (transfer-status-mismatch). For
 * exactly this case the Recovery screen and the JSON import preview list each affected transfer and ask whether
 * BOTH legs are posted or pending. Only the chosen statuses change; the caller re-validates the whole dataset and
 * (for saved data) keeps the unreadable original as a verbatim backup.
 */
import { produce } from 'immer';
import { isObj } from './schema.js';

export const REPAIR_STATUSES = ['posted', 'pending'];

/**
 * Internal transfers whose two legs have different statuses. Defensive: works on data that failed validation.
 * @returns {Array<{transferId:string, legs:Array<{id:string, accountName:string, description:string, date:string, amountCents:number, status:string}>}>}
 */
export function listTransferStatusRepairs(dataset) {
  if (!isObj(dataset) || !Array.isArray(dataset.transfers) || !Array.isArray(dataset.transactions)) return [];
  const txById = new Map(dataset.transactions.filter(isObj).map((t) => [t.id, t]));
  const names = new Map((Array.isArray(dataset.accounts) ? dataset.accounts : []).filter(isObj).map((a) => [a.id, a.name]));
  const out = [];
  for (const tr of dataset.transfers) {
    if (!isObj(tr) || tr.external || !Array.isArray(tr.legIds) || tr.legIds.length !== 2) continue;
    const legs = tr.legIds.map((id) => txById.get(id));
    if (legs.some((l) => !l || !REPAIR_STATUSES.includes(l.status)) || legs[0].status === legs[1].status) continue;
    out.push({ transferId: tr.id, legs: legs.map((l) => ({ id: l.id, accountName: names.get(l.accountId) || String(l.accountId), description: String(l.description ?? ''), date: String(l.date ?? ''), amountCents: l.amountCents, status: l.status })) });
  }
  return out;
}

/**
 * Set both legs of each chosen transfer to the chosen status. Transfers without a valid choice are left alone.
 * The result is NOT validated here: callers must run validateStructure on it.
 * @param {object} dataset @param {Record<string,'posted'|'pending'>} choices transferId -> status for both legs
 * @returns {{data:object, applied:Array<{transferId:string, status:string}>}}
 */
export function applyTransferStatusRepairs(dataset, choices) {
  const wanted = new Map(listTransferStatusRepairs(dataset).filter((r) => REPAIR_STATUSES.includes(choices[r.transferId])).map((r) => [r.transferId, r]));
  const applied = [];
  const data = produce(dataset, (d) => {
    const txById = new Map(d.transactions.map((t) => [t.id, t]));
    for (const [transferId, r] of wanted) {
      for (const leg of r.legs) txById.get(leg.id).status = choices[transferId];
      applied.push({ transferId, status: choices[transferId] });
    }
  });
  return { data, applied };
}
