/**
 * Upcoming obligations = scheduled recurring items + loan/card payments due, with an estimate of how
 * they change spendable cash. Pure estimation for display; nothing is written to the ledger.
 */
import { buildIndex, accountContribution, isLiabilityType } from './ledger.js';
import { upcomingOccurrences } from './recurring.js';
import { regularPayment, dueDayOf, nextDueDate } from './debt.js';
import { monthlyInterest } from './money.js';
import { addDays } from './dates.js';
import { CASH_TYPES } from './schema.js';
import { primaryAccount } from '../forecast/engine.js';

/** Debt payments due in the window, simulating balance changes from the payments themselves. */
export function upcomingDebtPayments(data, from, days = 90) {
  const index = buildIndex(data);
  const end = addDays(from, days);
  const rows = [];
  for (const a of data.accounts) {
    if (a.status !== 'active' || !isLiabilityType(a.type)) continue;
    let owed = -accountContribution(index, a.id, from, true);
    let date = nextDueDate(from, dueDayOf(a));
    let guard = 0;
    while (owed > 0 && date <= end && guard < 24) {
      const interest = monthlyInterest(owed, a.aprBps);
      const pay = Math.min(regularPayment(a, owed), owed + interest);
      if (pay > 0) {
        const payer = (a.autopayAccountId && index.accountsById.get(a.autopayAccountId)) || primaryAccount(data);
        rows.push({ kind: 'debt', date, scheduled: date, label: `${a.name} payment`, effectCents: -pay, accountId: a.id, payerId: payer?.id || null, cashEffectCents: payer && CASH_TYPES.includes(payer.type) ? -pay : 0, status: date === from ? 'due_today' : 'upcoming', debt: a, interestCents: interest });
      }
      owed = owed + interest - pay;
      date = nextDueDate(date, dueDayOf(a));
      guard += 1;
    }
  }
  return rows;
}

/** Combined, date-sorted obligations list with cumulative cash effect. */
export function upcomingObligations(data, from, days = 90) {
  const rec = upcomingOccurrences(data, from, days).map((r) => ({
    kind: 'recurring',
    date: r.date,
    scheduled: r.scheduled,
    label: r.rule.title,
    effectCents: r.effectCents,
    cashEffectCents: r.cashEffectCents,
    status: r.status,
    rule: r.rule,
    accountId: r.rule.accountId,
  }));
  const rows = [...rec, ...upcomingDebtPayments(data, from, days)].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.label < b.label ? -1 : 1));
  let running = 0;
  for (const r of rows) {
    running += r.cashEffectCents;
    r.cumulativeCashCents = running;
  }
  return rows;
}

/** Liquidity outlook over a window: starting spendable cash, lowest point, and ending cash after obligations. */
export function liquidityOutlook(data, from, days = 30) {
  const index = buildIndex(data);
  const start = data.accounts.filter((a) => a.status === 'active' && CASH_TYPES.includes(a.type)).reduce((s, a) => s + accountContribution(index, a.id, from, true), 0);
  const rows = upcomingObligations(data, from, days);
  let run = start;
  let low = start;
  let lowDate = from;
  for (const r of rows) {
    run += r.cashEffectCents;
    if (run < low) {
      low = run;
      lowDate = r.date;
    }
  }
  return { startCents: start, endCents: run, lowCents: low, lowDate, rows, outflowCents: rows.reduce((s, r) => s + Math.min(0, r.cashEffectCents), 0), inflowCents: rows.reduce((s, r) => s + Math.max(0, r.cashEffectCents), 0) };
}
