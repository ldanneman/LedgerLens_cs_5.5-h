import { formatMoney } from '../domain/money.js';
import { formatDate } from '../domain/dates.js';
import { CHANGE_TYPES } from './changes.js';

const INTERVAL = { weekly: 'weekly', biweekly: 'every 2 weeks', monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly' };

/** One-line plain-language description of a scenario change. */
export function describeChange(c, data) {
  const acct = (id) => data.accounts.find((a) => a.id === id)?.name || id || '?';
  const rec = (id) => data.recurring.find((r) => r.id === id)?.title || id;
  switch (c.type) {
    case 'income_change':
      return `From ${formatDate(c.effectiveDate)}, ${c.recurringId ? rec(c.recurringId) : 'all income'} ${c.mode === 'percent' ? `changes by ${(c.percentBps / 100).toFixed(2)}% per payment` : `changes by ${formatMoney(c.amountCents, { signed: true })} per payment`}`;
    case 'recurring_add':
      return `From ${formatDate(c.effectiveDate)}: new ${c.kind} "${c.title}" of ${formatMoney(c.amountCents)} ${INTERVAL[c.interval]} on ${acct(c.accountId)}${c.endDate ? ` until ${formatDate(c.endDate)}` : ''}`;
    case 'recurring_remove':
      return `From ${formatDate(c.effectiveDate)}: stop "${rec(c.recurringId)}"`;
    case 'one_time':
      return `${formatDate(c.date)}: ${c.amountCents > 0 ? 'windfall' : 'one-time expense'} "${c.title}" ${formatMoney(c.amountCents, { signed: true })} on ${acct(c.accountId)}`;
    case 'savings_change':
      return `From ${formatDate(c.effectiveDate)}: ${c.amountCents > 0 ? 'move an extra' : 'move'} ${formatMoney(Math.abs(c.amountCents))}${c.amountCents < 0 ? ' less' : ''} per month from ${acct(c.fromAccountId)} to ${acct(c.toAccountId)}`;
    case 'debt_payment':
      return `From ${formatDate(c.effectiveDate)}${c.endDate ? ` to ${formatDate(c.endDate)}` : ''}: ${c.mode === 'set' ? `pay ${formatMoney(c.amountCents)} per month` : `pay an extra ${formatMoney(c.amountCents)} per month`} on ${acct(c.accountId)}`;
    case 'debt_lump':
      return `${formatDate(c.date)}: extra lump sum ${formatMoney(c.amountCents)} toward ${acct(c.accountId)}`;
    default:
      return CHANGE_TYPES[c.type]?.label || c.type;
  }
}
