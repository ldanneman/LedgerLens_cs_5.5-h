import { formatMoney } from '../../domain/money.js';

/**
 * Money display. The sign is always part of the text (never color alone):
 * negatives show "-$12.00"; `signed` also shows "+" on gains. Color is an extra cue.
 */
export function Money({ cents, signed = false, tone = 'auto', className = '' }) {
  const v = Number.isFinite(cents) ? cents : 0;
  let cls = '';
  if (tone === 'auto') cls = v < 0 ? 'neg' : signed && v > 0 ? 'pos' : v === 0 && signed ? 'zero' : '';
  else if (tone !== 'none') cls = tone;
  return <span className={`amt ${cls} ${className}`.trim()}>{formatMoney(v, { signed })}</span>;
}

/** Amount owed on a liability, shown as a positive number with an explicit "Owed" label. */
export function Owed({ contributionCents, className = '' }) {
  const owed = -contributionCents;
  if (owed < 0) {
    return (
      <span className={`amt ${className}`}>
        <span className="owed">Credit</span>
        {formatMoney(-owed)}
      </span>
    );
  }
  return (
    <span className={`amt ${className}`}>
      <span className="owed">Owed</span>
      {formatMoney(owed)}
    </span>
  );
}

/** Shows an account contribution in the right style for its class: owed for liabilities, plain otherwise. */
export function AccountAmount({ account, cents }) {
  const liability = ['credit_card', 'auto_loan', 'student_loan', 'personal_loan'].includes(account.type);
  return liability ? <Owed contributionCents={cents} /> : <Money cents={cents} />;
}
