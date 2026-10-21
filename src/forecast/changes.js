/**
 * Scenario change types and their validation. A scenario never touches the ledger:
 * it is a list of what-if modifications that the projection engine applies to a
 * private copy of the starting state.
 */
import { checkField } from '../domain/schema.js';
import { isValidDate } from '../domain/dates.js';
import { isValidCents } from '../domain/money.js';

export const CHANGE_TYPES = {
  income_change: { label: 'Income raise / cut', hint: 'Raise or cut recurring income from a date (fixed monthly amount or percent).' },
  recurring_add: { label: 'New recurring item', hint: 'Add a new recurring expense or income starting on a date.' },
  recurring_remove: { label: 'Remove recurring item', hint: 'Stop an existing recurring rule from a date (cancel a subscription, end a bill).' },
  one_time: { label: 'One-time expense / windfall', hint: 'A single future expense (negative) or windfall (positive).' },
  savings_change: { label: 'Monthly savings change', hint: 'Move more (or less) money each month between two accounts.' },
  debt_payment: { label: 'Debt payment change', hint: 'Change the regular payment on a loan or credit card, or add an extra amount each month.' },
  debt_lump: { label: 'Lump-sum debt payment', hint: 'One extra principal payment on a future date.' },
};

export const CHANGE_TYPE_IDS = Object.keys(CHANGE_TYPES);

const COMMON_FIELDS = [
  ['label', { t: 'str', max: 120 }],
  ['title', { t: 'str', max: 120 }],
  ['effectiveDate', { t: 'date' }],
  ['endDate', { t: 'date' }],
  ['date', { t: 'date' }],
  ['mode', { t: 'str', max: 20 }],
  ['kind', { t: 'str', max: 20 }],
  ['interval', { t: 'str', max: 20 }],
  ['amountCents', { t: 'cents' }],
  ['percentBps', { t: 'int', min: -10000, max: 100000 }],
  ['day', { t: 'int', min: 1, max: 31 }],
  ['accountId', { t: 'id' }],
  ['fromAccountId', { t: 'id' }],
  ['toAccountId', { t: 'id' }],
  ['recurringId', { t: 'id' }],
  ['categoryId', { t: 'id' }],
];
const FIELD_LABELS = { effectiveDate: 'Effective date', endDate: 'End date', date: 'Date', amountCents: 'Amount', percentBps: 'Percent change', day: 'Day of month' };

/**
 * Validate one change; returns an array of messages (empty when valid).
 * @param {object} c change @param {{accounts:Map,recurring:Map}} refs
 */
export function validateChange(c, refs) {
  const errs = [];
  const need = (field, spec, label) => {
    const m = checkField(c[field], { ...spec, req: true }, label);
    if (m) errs.push(m);
  };
  if (!c || typeof c !== 'object') return ['Change must be an object.'];
  const m0 = checkField(c.id, { t: 'id', req: true }, 'Change id');
  if (m0) errs.push(m0);
  if (!CHANGE_TYPE_IDS.includes(c.type)) {
    errs.push(`Change type "${String(c.type)}" is not supported.`);
    return errs;
  }
  // Every field must have its documented type even when this change type does not use it: labels are rendered
  // and ids/dates are compared, so an object or number in an unused slot is malformed data, not "unused".
  for (const [field, spec] of COMMON_FIELDS) {
    const m = checkField(c[field], spec, FIELD_LABELS[field] || field);
    if (m) errs.push(m);
  }
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') errs.push('Enabled must be true or false.');
  const acct = (field, label) => {
    if (c[field] && !refs.accounts.has(c[field])) errs.push(`${label} "${c[field]}" does not exist.`);
  };
  switch (c.type) {
    case 'income_change':
      need('effectiveDate', { t: 'date' }, 'Effective date');
      if (c.mode !== 'amount' && c.mode !== 'percent') errs.push('Mode must be "amount" or "percent".');
      if (c.mode === 'amount' && !isValidCents(c.amountCents)) errs.push('Monthly change must be a whole number of cents.');
      if (c.mode === 'percent' && !(Number.isSafeInteger(c.percentBps) && c.percentBps >= -10000 && c.percentBps <= 100000)) errs.push('Percent change must be between -100% and +1000%.');
      if (c.recurringId) {
        const r = refs.recurring.get(c.recurringId);
        if (!r) errs.push(`Recurring item "${c.recurringId}" does not exist.`);
        else if (r.kind !== 'income') errs.push(`Recurring item "${r.title}" is not income.`);
      }
      break;
    case 'recurring_add':
      need('title', { t: 'str', max: 80 }, 'Title');
      need('effectiveDate', { t: 'date' }, 'Start date');
      if (c.endDate && !isValidDate(c.endDate)) errs.push('End date is not a valid date.');
      if (c.endDate && c.effectiveDate && c.endDate < c.effectiveDate) errs.push('End date is before the start date.');
      if (c.kind !== 'income' && c.kind !== 'expense') errs.push('Kind must be income or expense.');
      if (!isValidCents(c.amountCents) || c.amountCents <= 0) errs.push('Amount must be a positive whole number of cents.');
      if (!['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'].includes(c.interval)) errs.push('Interval must be weekly, biweekly, monthly, quarterly or yearly.');
      if (!c.accountId) errs.push('Account is required.');
      acct('accountId', 'Account');
      break;
    case 'recurring_remove':
      need('effectiveDate', { t: 'date' }, 'Effective date');
      if (!c.recurringId) errs.push('Choose the recurring item to remove.');
      else if (!refs.recurring.has(c.recurringId)) errs.push(`Recurring item "${c.recurringId}" does not exist.`);
      break;
    case 'one_time':
      need('date', { t: 'date' }, 'Date');
      need('title', { t: 'str', max: 80 }, 'Title');
      if (!isValidCents(c.amountCents) || c.amountCents === 0) errs.push('Amount must be a non-zero whole number of cents.');
      if (!c.accountId) errs.push('Account is required.');
      acct('accountId', 'Account');
      break;
    case 'savings_change':
      need('effectiveDate', { t: 'date' }, 'Effective date');
      if (!isValidCents(c.amountCents) || c.amountCents === 0) errs.push('Monthly amount must be a non-zero whole number of cents.');
      if (!c.fromAccountId || !c.toAccountId) errs.push('Choose both the source and destination account.');
      else if (c.fromAccountId === c.toAccountId) errs.push('Source and destination must be different accounts.');
      acct('fromAccountId', 'Source account');
      acct('toAccountId', 'Destination account');
      if (c.day !== null && c.day !== undefined && !(Number.isInteger(c.day) && c.day >= 1 && c.day <= 31)) errs.push('Day of month must be 1-31.');
      break;
    case 'debt_payment':
      need('effectiveDate', { t: 'date' }, 'Effective date');
      if (c.endDate && !isValidDate(c.endDate)) errs.push('End date is not a valid date.');
      if (c.mode !== 'set' && c.mode !== 'extra') errs.push('Mode must be "set" (new regular payment) or "extra" (additional amount).');
      if (!isValidCents(c.amountCents) || c.amountCents < 0) errs.push('Amount must be zero or more (whole cents).');
      if (!c.accountId) errs.push('Choose the loan or card.');
      acct('accountId', 'Debt account');
      break;
    case 'debt_lump':
      need('date', { t: 'date' }, 'Date');
      if (!isValidCents(c.amountCents) || c.amountCents <= 0) errs.push('Amount must be a positive whole number of cents.');
      if (!c.accountId) errs.push('Choose the loan or card.');
      acct('accountId', 'Debt account');
      break;
    default:
  }
  return errs;
}
