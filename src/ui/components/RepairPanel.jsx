import { useMemo, useState } from 'react';
import { listTransferStatusRepairs, applyTransferStatusRepairs } from '../../domain/repairs.js';
import { validateStructure } from '../../domain/validate.js';
import { formatMoney } from '../../domain/money.js';
import { formatDate } from '../../domain/dates.js';
import { Callout } from './Common.jsx';

/**
 * Explicit repair of transfers whose two sides disagree on status (written by an earlier version). Lists each one
 * with both legs, requires a choice per transfer (no default), applies only those choices, re-validates the whole
 * dataset and hands a valid result to `onRepaired(dataset, summary)`. Renders nothing when there is nothing to do.
 * Used by the Recovery screen and the Settings import preview.
 */
export default function RepairPanel({ candidate, onRepaired }) {
  const repairs = useMemo(() => listTransferStatusRepairs(candidate), [candidate]);
  const [choices, setChoices] = useState({});
  const [remaining, setRemaining] = useState([]);
  if (!repairs.length) return null;
  const chosen = repairs.filter((r) => choices[r.transferId]).length;
  const apply = () => {
    const { data, applied } = applyTransferStatusRepairs(candidate, choices);
    const blocking = validateStructure(data).filter((f) => f.blocking);
    setRemaining(blocking.slice(0, 6));
    if (!blocking.length) onRepaired(data, `Repaired ${applied.length} transfer${applied.length === 1 ? '' : 's'} whose two sides had different statuses (${applied.map((a) => `${a.transferId}: both ${a.status}`).join(', ')}).`);
  };
  return (
    <section className="card" aria-labelledby="repair-heading">
      <h2 id="repair-heading">Repair transfers with mismatched status</h2>
      <p>
        {repairs.length === 1 ? 'One transfer is' : `${repairs.length} transfers are`} pending on one side and posted on the other, so posted balances and net worth would be wrong by the transfer amount. An earlier version of LedgerLens allowed this. Choose for each transfer whether <strong>both</strong> sides are posted or pending; nothing changes until you apply.
      </p>
      {repairs.map((r) => (
        <fieldset key={r.transferId} className="stack" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <legend>Transfer {r.transferId}</legend>
          <ul className="list-plain small">
            {r.legs.map((l) => (
              <li key={l.id}>{l.accountName}: {l.description} ({formatDate(l.date)}) {formatMoney(l.amountCents, { signed: true })} - <strong>{l.status}</strong></li>
            ))}
          </ul>
          <div className="row">
            {['posted', 'pending'].map((st) => (
              <label key={st} className="check">
                <input type="radio" name={`repair-${r.transferId}`} value={st} checked={choices[r.transferId] === st} onChange={() => setChoices((c) => ({ ...c, [r.transferId]: st }))} />
                <span>Both {st}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      {remaining.length > 0 && (
        <Callout tone="error" role="alert">
          The data still has problems that cannot be repaired here, so it was not loaded:
          <ul>{remaining.map((f, i) => <li key={i}>{f.message}</li>)}</ul>
        </Callout>
      )}
      <div className="actions">
        <button type="button" className="btn primary" disabled={chosen !== repairs.length} onClick={apply}>
          Apply repairs ({chosen} of {repairs.length} chosen)
        </button>
      </div>
    </section>
  );
}
