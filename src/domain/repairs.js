/**
 * Explicit, user-confirmed repairs for known legacy problems.
 *
 * LedgerLens never "fixes" financial history on its own. When saved or imported data fails validation for a
 * reason that has an unambiguous set of safe resolutions, the Recovery screen and the JSON import preview list
 * the problem, ask the user to pick a resolution, apply ONLY that choice, and re-validate the whole dataset.
 * The original text is always kept as a verbatim backup (see store.resolveRecovery).
 *
 * Currently repairable: an internal transfer whose two legs have different statuses (created by an earlier
 * version that let one leg be posted alone). Choices: post both legs, or make both legs pending.
 */
import { produce } from 'immer';
import { isObj } from './schema.js';

/** Statuses a user may pick for both legs. */
export const TRANSFER_REPAIR_STATUSES = ['posted', 'pending'];

/**
 * Internal transfers whose legs disagree on status. Works on normalized-but-possibly-invalid data, so every
 * access is defensive.
 * @param {*} dataset
 * @returns {Array<{kind:'transfer-status', transferId:string, legs:Array<{id:string, accountId:string, accountName:string, description:string, date:string, amountCents:number, status:string}>}>}
 */
export function listRepairs(dataset) {
  if (!isObj(dataset) || !Array.isArray(dataset.transfers) || !Array.isArray(dataset.transactions)) return [];
  const txById = new Map();
  for (const t of dataset.transactions) if (isObj(t) && typeof t.id === 'string') txById.set(t.id, t);
  const accountName = new Map();
  if (Array.isArray(dataset.accounts)) for (const a of dataset.accounts) if (isObj(a)) accountName.set(a.id, a.name);
  const out = [];
  for (const tr of dataset.transfers) {
    if (!isObj(tr) || tr.external || !Array.isArray(tr.legIds) || tr.legIds.length !== 2) continue;
    const legs = tr.legIds.map((id) => txById.get(id));
    if (legs.some((l) => !l)) continue;
    const [a, b] = legs;
    if (!TRANSFER_REPAIR_STATUSES.includes(a.status) || !TRANSFER_REPAIR_STATUSES.includes(b.status) || a.status === b.status) continue;
    out.push({
      kind: 'transfer-status',
      transferId: tr.id,
      legs: legs.map((l) => ({ id: l.id, accountId: l.accountId, accountName: accountName.get(l.accountId) || l.accountId, description: l.description, date: l.date, amountCents: l.amountCents, status: l.status })),
    });
  }
  return out;
}

/**
 * Apply the user's choices.
 * @param {object} dataset
 * @param {Record<string,'posted'|'pending'>} choices transferId -> status for BOTH legs
 * @returns {{data:object, applied:Array<{transferId:string,status:string,legIds:string[]}>}}
 *   `data` is NOT validated here: the caller re-runs validateStructure so any remaining problem is shown.
 */
export function applyTransferStatusRepairs(dataset, choices) {
  const applied = [];
  const data = produce(dataset, (d) => {
    const txById = new Map(d.transactions.map((t) => [t.id, t]));
    for (const tr of d.transfers) {
      const status = choices[tr.id];
      if (!TRANSFER_REPAIR_STATUSES.includes(status) || tr.external) continue;
      const legs = tr.legIds.map((id) => txById.get(id)).filter(Boolean);
      if (legs.length !== 2 || legs[0].status === legs[1].status) continue;
      for (const l of legs) l.status = status;
      applied.push({ transferId: tr.id, status, legIds: legs.map((l) => l.id) });
    }
  });
  return { data, applied };
}
