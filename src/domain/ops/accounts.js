/**
 * Account lifecycle: create, edit, archive/unarchive, delete.
 *
 * Safety rules (spec 7.2):
 *  - an opening balance is chosen explicitly (liabilities are entered as amount owed in the UI and
 *    stored as a negative contribution);
 *  - the account CLASS (asset vs liability) cannot change once it has history, because every stored
 *    sign would silently flip meaning;
 *  - an account can only be archived at a zero balance and with no active recurring rules, so that no
 *    balance disappears; archived history stays in all historical reports;
 *  - an account can only be deleted when nothing references it. Otherwise archive it.
 */
import { mutate, fail, err, clean } from './common.js';
import { allocId, ACCOUNT_TYPES, PAYMENT_MODES, LOAN_TYPES } from '../schema.js';
import { buildIndex, isLiabilityType, accountContribution } from '../ledger.js';
import { isValidDate } from '../dates.js';
import { isValidCents, formatMoney } from '../money.js';

const EDITABLE = [
  'name', 'institution', 'last4', 'aprBps', 'creditLimitCents', 'scheduledPaymentCents', 'paymentMode', 'minPaymentBps',
  'minPaymentFloorCents', 'dueDay', 'statementDay', 'autopayAccountId', 'loan', 'notes', 'color', 'openingCents', 'openingDate', 'type',
];

function checkAccountFields(a) {
  const errs = [];
  if (typeof a.name !== 'string' || !a.name.trim()) errs.push(err('Enter an account name.', 'name'));
  else if (a.name.length > 80) errs.push(err('Account name is longer than 80 characters.', 'name'));
  if (!ACCOUNT_TYPES.includes(a.type)) errs.push(err('Choose an account type.', 'type'));
  if (!isValidCents(a.openingCents)) errs.push(err('Opening balance must be a valid amount within +/- $1,000,000,000.', 'openingCents'));
  if (!isValidDate(a.openingDate)) errs.push(err('Opening date must be a valid date (YYYY-MM-DD).', 'openingDate'));
  if (!(Number.isSafeInteger(a.aprBps) && a.aprBps >= 0 && a.aprBps <= 10000)) errs.push(err('Interest rate must be between 0% and 100%.', 'aprBps'));
  if (a.creditLimitCents !== null && a.creditLimitCents !== undefined && !(isValidCents(a.creditLimitCents) && a.creditLimitCents > 0)) errs.push(err('Credit limit must be a positive amount.', 'creditLimitCents'));
  if (a.scheduledPaymentCents !== null && a.scheduledPaymentCents !== undefined && !(isValidCents(a.scheduledPaymentCents) && a.scheduledPaymentCents >= 0)) errs.push(err('Scheduled payment must be zero or more.', 'scheduledPaymentCents'));
  if (!PAYMENT_MODES.includes(a.paymentMode)) errs.push(err('Choose a payment mode.', 'paymentMode'));
  for (const f of ['dueDay', 'statementDay']) {
    if (a[f] !== null && a[f] !== undefined && !(Number.isInteger(a[f]) && a[f] >= 1 && a[f] <= 31)) errs.push(err('Day of month must be 1-31.', f));
  }
  if (a.loan) {
    if (!isValidCents(a.loan.originalPrincipalCents) || a.loan.originalPrincipalCents <= 0) errs.push(err('Original loan principal must be a positive amount.', 'loan'));
    if (!(Number.isInteger(a.loan.termMonths) && a.loan.termMonths >= 1 && a.loan.termMonths <= 600)) errs.push(err('Loan term must be 1-600 months.', 'loan'));
    if (!isValidDate(a.loan.startDate)) errs.push(err('Loan start date must be a valid date.', 'loan'));
  }
  if (isLiabilityType(a.type) && a.openingCents > 0) errs.push(err('A liability opening balance should be zero or negative (a negative contribution = amount owed).', 'openingCents'));
  return errs;
}

/** Create an account. `input.openingCents` is the signed contribution (liabilities negative). */
export function addAccount(data, input) {
  const base = {
    name: clean(input.name),
    type: input.type,
    institution: clean(input.institution) || '',
    openingCents: input.openingCents ?? 0,
    openingDate: input.openingDate || data.settings.asOfDate,
    status: 'active',
    archivedDate: null,
    last4: clean(input.last4) || '',
    aprBps: input.aprBps ?? 0,
    creditLimitCents: input.creditLimitCents ?? null,
    scheduledPaymentCents: input.scheduledPaymentCents ?? null,
    paymentMode: input.paymentMode || 'fixed',
    minPaymentBps: input.minPaymentBps ?? 0,
    minPaymentFloorCents: input.minPaymentFloorCents ?? 0,
    dueDay: input.dueDay ?? null,
    statementDay: input.statementDay ?? null,
    autopayAccountId: input.autopayAccountId || null,
    loan: LOAN_TYPES.includes(input.type) ? input.loan || null : null,
    notes: clean(input.notes) || '',
    color: input.color || '',
  };
  const errs = checkAccountFields(base);
  if (data.accounts.some((a) => a.name.toLowerCase() === (base.name || '').toLowerCase() && a.status === 'active')) errs.push(err(`An active account named "${base.name}" already exists.`, 'name'));
  if (errs.length) return fail(errs);
  return mutate(data, (d) => {
    const id = allocId(d, 'acct', 'accounts');
    d.accounts.push({ id, ...base });
    return { id, warnings: [] };
  });
}

/** Edit account metadata. Changing opening balance/date is allowed but guarded. */
export function updateAccount(data, id, patch) {
  const index = buildIndex(data);
  const cur = index.accountsById.get(id);
  if (!cur) return fail('That account no longer exists.');
  const unknown = Object.keys(patch).filter((k) => !EDITABLE.includes(k));
  if (unknown.length) return fail(`These fields cannot be edited: ${unknown.join(', ')}.`);
  const next = { ...cur, ...patch };
  if (patch.name !== undefined) next.name = clean(patch.name);
  const errs = checkAccountFields(next);
  const txs = index.txByAccount.get(id) || [];
  if (patch.type && patch.type !== cur.type && isLiabilityType(patch.type) !== isLiabilityType(cur.type) && (txs.length > 0 || cur.openingCents !== 0)) {
    errs.push(err('You cannot switch between an asset and a liability account once it has a balance or history, because every amount would change meaning. Create a new account instead.', 'type'));
  }
  if (patch.openingDate && patch.openingDate !== cur.openingDate) {
    const early = txs.filter((t) => t.date < patch.openingDate);
    if (early.length) errs.push(err(`${early.length} transaction(s) are dated before ${patch.openingDate}. Move or delete them first, or choose an earlier opening date.`, 'openingDate'));
  }
  if (patch.name !== undefined && data.accounts.some((a) => a.id !== id && a.status === 'active' && a.name.toLowerCase() === next.name.toLowerCase())) errs.push(err(`An active account named "${next.name}" already exists.`, 'name'));
  if (patch.autopayAccountId && patch.autopayAccountId === id) errs.push(err('An account cannot pay itself.', 'autopayAccountId'));
  if (errs.length) return fail(errs);
  const warnings = [];
  if (patch.openingCents !== undefined && patch.openingCents !== cur.openingCents) {
    warnings.push(`Opening balance changed by ${formatMoney(patch.openingCents - cur.openingCents, { signed: true })}; every balance and net-worth figure from ${next.openingDate} onward moves by the same amount.`);
  }
  return mutate(data, (d) => {
    const a = d.accounts.find((x) => x.id === id);
    for (const k of Object.keys(patch)) a[k] = k === 'name' ? next.name : patch[k];
    if (patch.type && !LOAN_TYPES.includes(patch.type)) a.loan = null;
    return { id, warnings };
  });
}

/** Archive an account: allowed only at a zero total balance with no active recurring rules. */
export function archiveAccount(data, id) {
  const index = buildIndex(data);
  const a = index.accountsById.get(id);
  if (!a) return fail('That account no longer exists.');
  if (a.status === 'archived') return fail('That account is already archived.');
  const all = accountContribution(index, id, '9999-12-31', true);
  if (all !== 0) return fail(`"${a.name}" still holds ${formatMoney(all)} (including pending and future-dated items). Transfer or settle it to $0.00 before archiving, so no balance disappears from net worth.`);
  const rules = data.recurring.filter((r) => r.active && (r.accountId === id || r.toAccountId === id));
  if (rules.length) return fail(`Pause or delete these active recurring items first: ${rules.map((r) => r.title).join(', ')}.`);
  return mutate(data, (d) => {
    const x = d.accounts.find((q) => q.id === id);
    x.status = 'archived';
    x.archivedDate = data.settings.asOfDate;
    const goals = data.goals.filter((g) => g.accountId === id).map((g) => g.name);
    return { warnings: goals.length ? [`Goals still linked to this account: ${goals.join(', ')}.`] : [] };
  });
}

/** Restore an archived account. */
export function unarchiveAccount(data, id) {
  const a = buildIndex(data).accountsById.get(id);
  if (!a) return fail('That account no longer exists.');
  return mutate(data, (d) => {
    const x = d.accounts.find((q) => q.id === id);
    x.status = 'active';
    x.archivedDate = null;
  });
}

/** What would block deleting an account? Returns human-readable reasons. */
export function accountReferences(data, id) {
  const reasons = [];
  const nTx = data.transactions.filter((t) => t.accountId === id).length;
  if (nTx) reasons.push(`${nTx} transaction(s)`);
  const nRec = data.recurring.filter((r) => r.accountId === id || r.toAccountId === id).length;
  if (nRec) reasons.push(`${nRec} recurring item(s)`);
  const nRc = data.reconciliations.filter((r) => r.accountId === id).length;
  if (nRc) reasons.push(`${nRc} reconciliation(s)`);
  const nGoal = data.goals.filter((g) => g.accountId === id).length;
  if (nGoal) reasons.push(`${nGoal} goal(s)`);
  const nRule = data.rules.filter((r) => r.accountId === id).length;
  if (nRule) reasons.push(`${nRule} categorization rule(s)`);
  const nBatch = data.importBatches.filter((b) => b.accountId === id).length;
  if (nBatch) reasons.push(`${nBatch} import batch(es)`);
  const nScen = data.scenarios.filter((s) => s.changes.some((c) => [c.accountId, c.fromAccountId, c.toAccountId].includes(id))).length;
  if (nScen) reasons.push(`${nScen} scenario(s)`);
  const nPay = data.accounts.filter((a) => a.autopayAccountId === id).length;
  if (nPay) reasons.push(`${nPay} account(s) that autopay from it`);
  return reasons;
}

/** Delete an account that nothing references. Otherwise explain and suggest archiving. */
export function deleteAccount(data, id) {
  const a = buildIndex(data).accountsById.get(id);
  if (!a) return fail('That account no longer exists.');
  const reasons = accountReferences(data, id);
  if (reasons.length) return fail(`"${a.name}" cannot be deleted because it is used by ${reasons.join(', ')}. Archive it instead to keep its history in reports.`);
  return mutate(data, (d) => {
    d.accounts = d.accounts.filter((x) => x.id !== id);
  });
}
