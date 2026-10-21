import { useMemo, useState } from 'react';
import { listRepairs, applyTransferStatusRepairs } from '../../domain/repairs.js';
import { validateStructure } from '../../domain/validate.js';
import { formatMoney } from '../../domain/money.js';
import { formatDate } from '../../domain/dates.js';
import { Callout } from './Common.jsx';

/**
 * Lists known, repairable problems in a dataset that failed validation and lets the user choose a resolution for
 * each. Nothing is changed until "Apply repairs" is pressed, the whole dataset is re-validated afterwards, and
 * the caller decides how to adopt the result (Recovery keeps a verbatim backup of the unreadable original).
 * Renders nothing when there is nothing repairable.
 *
 * @param {{candidate:object|null, onRepaired:(dataset:object, summary:string)=>void}} props
 */
export default function RepairPanel({ candidate, onRepaired }) {
  const repairs = useMemo(() => listRepairs(candidate), [candidate]);
  const [choices, setChoices] = useState({});
  const [remaining, setRemaining] = useState([]);
  if (!repairs.length) return null;
  const chosen = repairs.filter((r) => choices[r.transferId]).length;
  const apply = () => {
    const { data, applied } = applyTransferStatusRepairs(candidate, choices);
    const blocking = validateStructure(data).filter((f) => f.blocking);
    if (blocking.length) {
      setRemaining(blocking.slice(0, 6));
      return;
    }
    setRemaining([]);
    onRepaired(data, `Repaired ${applied.length} transfer${applied.length === 1 ? '' : 's'} whose two sides had different statuses.`);
  };
  return (
    <section className="card" aria-labelledby="repair-title">
      <h2 id="repair-title">Repair transfers with mismatched status</h2>
      <p>
        {repairs.length} transfer{repairs.length === 1 ? ' is' : 's are'} pending on one side and posted on the other, which makes posted net worth wrong. An earlier version of LedgerLens allowed this. Nothing is changed until you choose, for each transfer, whether <strong>both</strong> sides are posted or pending.
      </p>
      <ul className="list-plain">
        {repairs.map((r) => (
          <li key={r.transferId} style={{ display: 'block' }}>
            <div>
              {r.legs.map((l) => (
                <div key={l.id} className="small">
                  {l.accountName}: {l.description} ({formatDate(l.date)}) {formatMoney(l.amountCents, { signed: true })}: <strong>{l.status}</strong>
                </div>
              ))}
            </div>
            <label className="field">
              <span>Both sides of transfer {r.transferId} should be</span>
              <select value={choices[r.transferId] || ''} onChange={(e) => setChoices((c) => ({ ...c, [r.transferId]: e.target.value }))}>
                <option value="">Choose...</option>
                <option value="posted">Posted (the money has moved)</option>
                <option value="pending">Pending (not settled yet)</option>
              </select>
            </label>
          </li>
        ))}
      </ul>
      {remaining.length > 0 && (
        <Callout tone="error" role="alert">
          The data still has problems that cannot be repaired automatically, so it was not loaded:
          <ul>{remaining.map((f, i) => <li key={i}>{f.message}</li>)}</ul>
        </Callout>
      )}
      <div className="actions">
        <button type="button" className="btn primary" disabled={chosen !== repairs.length} onClick={apply}>
          Apply repairs ({chosen}/{repairs.length} chosen)
        </button>
      </div>
    </section>
  );
}
