/**
 * Recurring income / bills / subscriptions / planned transfers.
 *
 * A recurring RULE describes expected future activity. It is NOT a ledger entry: only a
 * transaction linked via tx.recurrence = {ruleId, occurrence} counts as actual, so an
 * occurrence is never counted twice (once scheduled and once posted).
 *
 * Occurrence dates:
 *  - weekly / biweekly add 7 / 14 days to the start date;
 *  - monthly / quarterly / yearly keep the ANCHOR day of the start date and clamp to the last day
 *    of shorter months, re-computed from the start date each time (never cumulatively), so a rule
 *    starting Jan 31 gives Feb 28 (29 in leap years), Mar 31, Apr 30, May 31 ...; a yearly rule
 *    starting Feb 29 gives Feb 28 in non-leap years and Feb 29 in leap years;
 *  - optional business-day adjustment moves a weekend due date to the next/previous weekday
 *    (no holiday calendar). The `scheduled` date stays the stable key of the occurrence.
 */
import { buildIndex } from './ledger.js';
import { addDays, addMonths, adjustBusinessDay, isValidDate } from './dates.js';
import { mulDiv } from './money.js';
import { CASH_TYPES } from './schema.js';

const MONTH_STEP = { monthly: 1, quarterly: 3, yearly: 12 };
const DAY_STEP = { weekly: 7, biweekly: 14 };

/** Scheduled (unadjusted) date of the n-th occurrence (n >= 0). */
export function nthOccurrence(rule, n) {
  if (DAY_STEP[rule.interval]) return addDays(rule.startDate, DAY_STEP[rule.interval] * n);
  return addMonths(rule.startDate, MONTH_STEP[rule.interval] * n);
}

/**
 * All occurrences whose SCHEDULED date lies in [from, to] and on/before the rule's end date.
 * @returns {Array<{ruleId:string, scheduled:string, date:string}>} date = after business-day adjustment
 */
export function occurrencesBetween(rule, from, to) {
  const out = [];
  if (!isValidDate(rule.startDate) || !MONTH_STEP[rule.interval] && !DAY_STEP[rule.interval]) return out;
  const last = rule.endDate && rule.endDate < to ? rule.endDate : to;
  for (let n = 0; n < 5000; n += 1) {
    const scheduled = nthOccurrence(rule, n);
    if (scheduled > last) break;
    if (scheduled < from) continue;
    out.push({ ruleId: rule.id, scheduled, date: adjustBusinessDay(scheduled, rule.businessDay) });
  }
  return out;
}

/** Signed effect of a rule occurrence on its own account (income +, expense -, transfer out -). */
export function ruleEffect(rule) {
  return rule.kind === 'income' ? rule.amountCents : -rule.amountCents;
}

/** Per-year multiplier for each interval. */
const PER_YEAR = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, yearly: 1 };

/** Annual equivalent amount in cents (exact integer). */
export function annualEquivalent(rule) {
  return rule.amountCents * PER_YEAR[rule.interval];
}

/** Monthly equivalent in cents (annual / 12, rounded half away from zero). */
export function monthlyEquivalent(rule) {
  return mulDiv(rule.amountCents, PER_YEAR[rule.interval], 12);
}

/** Map<ruleId, Map<scheduledDate, tx[]>> of actual transactions linked to occurrences. */
export function linkedOccurrences(data) {
  const out = new Map();
  for (const tx of data.transactions) {
    if (!tx.recurrence) continue;
    let byRule = out.get(tx.recurrence.ruleId);
    if (!byRule) {
      byRule = new Map();
      out.set(tx.recurrence.ruleId, byRule);
    }
    const list = byRule.get(tx.recurrence.occurrence) || [];
    list.push(tx);
    byRule.set(tx.recurrence.occurrence, list);
  }
  return out;
}

/** Whether a rule's occurrence moves cash (checking/savings) and by how much. */
function cashEffect(rule, accountsById) {
  const from = accountsById.get(rule.accountId);
  const isCash = (a) => a && CASH_TYPES.includes(a.type);
  if (rule.kind === 'transfer') {
    const to = accountsById.get(rule.toAccountId);
    return (isCash(to) ? rule.amountCents : 0) - (isCash(from) ? rule.amountCents : 0);
  }
  return isCash(from) ? ruleEffect(rule) : 0;
}

/**
 * Upcoming obligations from `from` (inclusive) for `days` days, plus unmatched occurrences that are
 * overdue (due in the previous `overdueDays`). Each row: status 'upcoming' | 'due_today' | 'overdue'.
 * Skipped and already-matched occurrences are excluded. Rows are sorted by due date and carry a
 * running estimated cash balance impact (only cash-account effects).
 */
export function upcomingOccurrences(data, from, days = 90, { overdueDays = 45, onlyActive = true } = {}) {
  const index = buildIndex(data);
  const links = linkedOccurrences(data);
  const to = addDays(from, days);
  const lookback = addDays(from, -overdueDays);
  const rows = [];
  for (const rule of data.recurring) {
    if (onlyActive && !rule.active) continue;
    const byRule = links.get(rule.id);
    for (const occ of occurrencesBetween(rule, lookback, to)) {
      if (rule.skipped.includes(occ.scheduled)) continue;
      if (byRule?.has(occ.scheduled)) continue;
      const status = occ.date < from ? 'overdue' : occ.date === from ? 'due_today' : 'upcoming';
      if (occ.date > to) continue;
      rows.push({ ...occ, rule, status, effectCents: ruleEffect(rule), cashEffectCents: cashEffect(rule, index.accountsById) });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rule.id < b.rule.id ? -1 : 1));
  let running = 0;
  for (const r of rows) {
    running += r.cashEffectCents;
    r.cumulativeCashEffectCents = running;
  }
  return rows;
}

/** Status of one scheduled occurrence: matched | skipped | open. */
export function occurrenceStatus(data, rule, scheduled) {
  if (rule.skipped.includes(scheduled)) return 'skipped';
  const matched = data.transactions.some((t) => t.recurrence && t.recurrence.ruleId === rule.id && t.recurrence.occurrence === scheduled);
  return matched ? 'matched' : 'open';
}

/**
 * Candidate transactions for an occurrence: unlinked, same account (either leg for transfers), same
 * direction, dated within 3 days before to 7 days after the due date and within 10% (min $1) of the
 * expected amount. Sorted by closeness.
 */
export function suggestMatches(data, rule, occurrence) {
  const out = [];
  const tol = Math.max(100, Math.round(rule.amountCents * 0.1));
  for (const tx of data.transactions) {
    if (tx.recurrence) continue;
    if (tx.kind !== rule.kind) continue;
    if (tx.accountId !== rule.accountId) continue;
    const dd = (Date.parse(`${tx.date}T00:00:00Z`) - Date.parse(`${occurrence.date}T00:00:00Z`)) / 86400000;
    if (dd < -3 || dd > 7) continue;
    if (Math.abs(Math.abs(tx.amountCents) - rule.amountCents) > tol) continue;
    out.push({ tx, dayOffset: dd, amountDiff: Math.abs(tx.amountCents) - rule.amountCents });
  }
  out.sort((a, b) => Math.abs(a.dayOffset) - Math.abs(b.dayOffset) || Math.abs(a.amountDiff) - Math.abs(b.amountDiff));
  return out;
}

/** Subscription roll-up: groups 'subscription' rules with monthly and annual totals. */
export function subscriptionSummary(data) {
  const subs = data.recurring.filter((r) => r.group === 'subscription' && r.kind === 'expense' && r.active);
  return {
    items: subs,
    monthlyCents: subs.reduce((s, r) => s + monthlyEquivalent(r), 0),
    annualCents: subs.reduce((s, r) => s + annualEquivalent(r), 0),
  };
}
