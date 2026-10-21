/**
 * Recurring rule operations and occurrence matching.
 */
import { mutate, fail, err, clean } from './common.js';
import { allocId, INTERVALS, RECURRING_KINDS, RECURRING_GROUPS, BUSINESS_DAY_MODES } from '../schema.js';
import { buildIndex } from '../ledger.js';
import { isValidDate } from '../dates.js';
import { isValidCents } from '../money.js';
import { occurrencesBetween, occurrenceStatus, ruleEffect } from '../recurring.js';
import { addTransaction, addTransfer } from './transactions.js';

function checkRule(data, r) {
  const index = buildIndex(data);
  const errs = [];
  if (!r.title) errs.push(err('Enter a title.', 'title'));
  if (!RECURRING_KINDS.includes(r.kind)) errs.push(err('Choose income, expense or transfer.', 'kind'));
  if (!isValidCents(r.amountCents) || r.amountCents <= 0) errs.push(err('Enter a positive amount.', 'amountCents'));
  if (!index.accountsById.has(r.accountId)) errs.push(err('Choose an account.', 'accountId'));
  if (r.kind === 'transfer') {
    if (!index.accountsById.has(r.toAccountId)) errs.push(err('Choose the destination account.', 'toAccountId'));
    else if (r.toAccountId === r.accountId) errs.push(err('Source and destination must differ.', 'toAccountId'));
  }
  if (!INTERVALS.includes(r.interval)) errs.push(err('Choose how often it repeats.', 'interval'));
  if (!isValidDate(r.startDate)) errs.push(err('Enter a valid start date (YYYY-MM-DD).', 'startDate'));
  if (r.endDate && !isValidDate(r.endDate)) errs.push(err('Enter a valid end date or leave it empty.', 'endDate'));
  else if (r.endDate && isValidDate(r.startDate) && r.endDate < r.startDate) errs.push(err('The end date is before the start date.', 'endDate'));
  if (!RECURRING_GROUPS.includes(r.group)) errs.push(err('Choose a group.', 'group'));
  if (!BUSINESS_DAY_MODES.includes(r.businessDay)) errs.push(err('Choose a business-day option.', 'businessDay'));
  const cat = r.categoryId ? index.categoriesById.get(r.categoryId) : null;
  if (r.categoryId && !cat) errs.push(err('That category does not exist.', 'categoryId'));
  else if (cat && r.kind !== 'transfer' && cat.kind !== r.kind) errs.push(err(`"${cat.name}" is an ${cat.kind} category.`, 'categoryId'));
  return errs;
}

/** Create or update a recurring rule (matched by id when given). */
export function saveRecurring(data, input) {
  const r = {
    title: clean(input.title),
    kind: input.kind,
    amountCents: input.amountCents,
    accountId: input.accountId,
    toAccountId: input.kind === 'transfer' ? input.toAccountId || null : null,
    categoryId: input.kind === 'transfer' ? null : input.categoryId || null,
    merchant: clean(input.merchant) || '',
    startDate: input.startDate,
    endDate: input.endDate || null,
    interval: input.interval,
    active: input.active !== false,
    group: input.group || (input.kind === 'income' ? 'income' : input.kind === 'transfer' ? 'transfer' : 'bill'),
    businessDay: input.businessDay || 'none',
    notes: clean(input.notes) || '',
  };
  const errs = checkRule(data, r);
  if (input.id && !data.recurring.some((x) => x.id === input.id)) errs.push(err('That recurring item no longer exists.'));
  if (errs.length) return fail(errs);
  return mutate(data, (d) => {
    if (input.id) {
      const i = d.recurring.findIndex((x) => x.id === input.id);
      d.recurring[i] = { id: input.id, ...r, skipped: d.recurring[i].skipped };
      return { id: input.id };
    }
    const id = allocId(d, 'rec', 'recurring');
    d.recurring.push({ id, ...r, skipped: [] });
    return { id };
  });
}

/** Pause / resume. */
export function setRecurringActive(data, id, active) {
  if (!data.recurring.some((r) => r.id === id)) return fail('That recurring item no longer exists.');
  return mutate(data, (d) => {
    d.recurring.find((r) => r.id === id).active = Boolean(active);
  });
}

/** Delete a rule. Transactions that were linked to it keep their data but lose the link. */
export function deleteRecurring(data, id) {
  if (!data.recurring.some((r) => r.id === id)) return fail('That recurring item no longer exists.');
  return mutate(data, (d) => {
    d.recurring = d.recurring.filter((r) => r.id !== id);
    let unlinked = 0;
    for (const t of d.transactions) {
      if (t.recurrence?.ruleId === id) {
        t.recurrence = null;
        unlinked += 1;
      }
    }
    return { warnings: unlinked ? [`${unlinked} transaction(s) were unlinked from the deleted rule (their amounts are unchanged).`] : [] };
  });
}

function findOccurrence(rule, scheduled) {
  return occurrencesBetween(rule, scheduled, scheduled).find((o) => o.scheduled === scheduled) || null;
}

/** Skip one occurrence (e.g. a month you do not pay). */
export function skipOccurrence(data, ruleId, scheduled, skip = true) {
  const rule = data.recurring.find((r) => r.id === ruleId);
  if (!rule) return fail('That recurring item no longer exists.');
  if (!findOccurrence(rule, scheduled)) return fail(`${scheduled} is not an occurrence of "${rule.title}".`);
  if (skip && occurrenceStatus(data, rule, scheduled) === 'matched') return fail('That occurrence is already matched to a transaction.');
  return mutate(data, (d) => {
    const r = d.recurring.find((x) => x.id === ruleId);
    r.skipped = r.skipped.filter((s) => s !== scheduled);
    if (skip) r.skipped.push(scheduled);
    r.skipped.sort();
  });
}

/**
 * "Mark paid": create the real transaction for an occurrence AND link it, so the occurrence stops
 * being "upcoming" and is counted once (as the posted transaction).
 */
export function markOccurrencePaid(data, ruleId, scheduled, { date, amountCents, status = 'posted' } = {}) {
  const rule = data.recurring.find((r) => r.id === ruleId);
  if (!rule) return fail('That recurring item no longer exists.');
  const occ = findOccurrence(rule, scheduled);
  if (!occ) return fail(`${scheduled} is not an occurrence of "${rule.title}".`);
  const st = occurrenceStatus(data, rule, scheduled);
  if (st === 'matched') return fail('That occurrence is already matched to a transaction, so marking it paid again would duplicate the charge.');
  const when = date || occ.date;
  const amount = amountCents ?? rule.amountCents;
  const recurrence = { ruleId, occurrence: scheduled };
  const source = { type: 'recurring', batchId: null, externalId: null, importedAt: null, rawDescription: null };
  let res;
  if (rule.kind === 'transfer') {
    res = addTransfer(data, { fromAccountId: rule.accountId, toAccountId: rule.toAccountId, amountCents: amount, date: when, status, description: rule.title, recurrence, source });
  } else {
    res = addTransaction(data, {
      accountId: rule.accountId,
      date: when,
      description: rule.title,
      merchant: rule.merchant || rule.title,
      amountCents: rule.kind === 'income' ? Math.abs(amount) : -Math.abs(amount),
      kind: rule.kind,
      status,
      categoryId: rule.categoryId,
      categorySource: rule.categoryId ? 'rule' : null,
      recurrence,
      source,
    });
  }
  if (!res.ok) return res;
  // un-skip if it had been skipped
  if (rule.skipped.includes(scheduled)) return mutate(res.data, (d) => {
    const r = d.recurring.find((x) => x.id === ruleId);
    r.skipped = r.skipped.filter((s) => s !== scheduled);
    return { id: res.id, warnings: res.warnings };
  });
  return res;
}

/** Link an existing transaction to an occurrence (no new money is created). */
export function linkOccurrence(data, txId, ruleId, scheduled) {
  const index = buildIndex(data);
  const tx = index.txById.get(txId);
  const rule = data.recurring.find((r) => r.id === ruleId);
  if (!tx) return fail('That transaction no longer exists.');
  if (!rule) return fail('That recurring item no longer exists.');
  if (tx.recurrence) return fail('That transaction is already linked to a recurring occurrence.');
  if (!findOccurrence(rule, scheduled)) return fail(`${scheduled} is not an occurrence of "${rule.title}".`);
  if (occurrenceStatus(data, rule, scheduled) === 'matched') return fail('That occurrence already has a matching transaction.');
  if (tx.kind !== rule.kind) return fail(`A ${tx.kind} transaction cannot match a recurring ${rule.kind}.`);
  return mutate(data, (d) => {
    d.transactions.find((t) => t.id === txId).recurrence = { ruleId, occurrence: scheduled };
    const r = d.recurring.find((x) => x.id === ruleId);
    r.skipped = r.skipped.filter((s) => s !== scheduled);
  });
}

/** Remove the link between a transaction and its occurrence. */
export function unlinkOccurrence(data, txId) {
  const tx = buildIndex(data).txById.get(txId);
  if (!tx || !tx.recurrence) return fail('That transaction is not linked to a recurring occurrence.');
  return mutate(data, (d) => {
    const links = d.transactions.filter((t) => t.recurrence && t.recurrence.ruleId === tx.recurrence.ruleId && t.recurrence.occurrence === tx.recurrence.occurrence);
    for (const t of links) t.recurrence = null;
  });
}

export { ruleEffect };
