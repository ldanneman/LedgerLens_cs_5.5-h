/**
 * Debt maths: payment policy, amortization schedules and payoff comparisons.
 *
 * Assumptions (documented in the README):
 *  - Interest accrues monthly: interest = round(balance * APR / 12) (half away from zero), computed
 *    on the balance at each payment/due date. This is a planning model, NOT a lender payoff quote.
 *  - Each period: balance += interest; payment = min(payment, balance); balance -= payment.
 *    The last payment can never overshoot the remaining debt.
 *  - Zero APR is exact (no interest). A payment that does not exceed the monthly interest never
 *    pays the debt off; the schedule reports that honestly instead of inventing a payoff date.
 */
import { monthlyInterest, applyBps } from './money.js';
import { addMonths, addDays, daysInMonth, parseDate, makeDate } from './dates.js';
import { buildIndex, accountContribution, isLiabilityType } from './ledger.js';

/**
 * Standard level-payment (annuity) loan payment, rounded to the cent. This only PROPOSES a payment
 * from loan terms (used to seed data and pre-fill forms); the stored scheduled payment is what the
 * app actually uses, and every schedule built from it uses exact integer-cent rounding.
 */
export function loanPayment(principalCents, aprBps, termMonths) {
  if (!(termMonths > 0)) return principalCents;
  if (!aprBps) return Math.ceil(principalCents / termMonths);
  const r = aprBps / 120000;
  return Math.round((principalCents * r) / (1 - Math.pow(1 + r, -termMonths)));
}

/** Minimum payment for a card/loan given its current owed balance. */
export function minimumPayment(acct, owedCents) {
  if (owedCents <= 0) return 0;
  const interest = monthlyInterest(owedCents, acct.aprBps);
  const pctPart = applyBps(owedCents, acct.minPaymentBps || 0);
  return Math.min(owedCents + interest, Math.max(acct.minPaymentFloorCents || 0, interest + pctPart));
}

/**
 * The regular monthly payment under the account's payment mode, before extras.
 *  fixed        - scheduledPaymentCents
 *  minimum      - max(floor, interest + minPaymentBps% of balance)
 *  pay_in_full  - everything owed (statement paid in full)
 * Always capped at what is owed (balance + this month's interest).
 */
export function regularPayment(acct, owedCents) {
  if (owedCents <= 0) return 0;
  const interest = monthlyInterest(owedCents, acct.aprBps);
  const cap = owedCents + interest;
  if (acct.paymentMode === 'pay_in_full') return cap;
  if (acct.paymentMode === 'minimum') return minimumPayment(acct, owedCents);
  return Math.min(acct.scheduledPaymentCents || 0, cap);
}

/** Due-day-of-month of a debt: explicit dueDay, else the loan's start day, else the 1st. */
export function dueDayOf(acct) {
  if (acct.dueDay) return acct.dueDay;
  if (acct.loan?.startDate) return parseDate(acct.loan.startDate).d;
  return 1;
}

/** First due date STRICTLY after `date` for a due day (clamped to short months). */
export function nextDueDate(date, dueDay) {
  const { y, m } = parseDate(date);
  for (let k = 0; k < 3; k += 1) {
    const idx = y * 12 + (m - 1) + k;
    const yy = Math.floor(idx / 12);
    const mm = (idx % 12) + 1;
    const cand = makeDate(yy, mm, Math.min(dueDay, daysInMonth(yy, mm)));
    if (cand > date) return cand;
  }
  return addDays(date, 30);
}

/**
 * Amortization-style schedule.
 * @param {{balanceCents:number, aprBps:number, paymentCents:number, extraCents?:number,
 *          firstPaymentDate:string, lumpSums?:Array<{period:number, amountCents:number}>, maxPeriods?:number}} p
 * @returns {{rows:Array, status:string, payoffDate:string|null, periods:number, totalInterestCents:number, totalPaidCents:number, message:string}}
 */
export function amortizationSchedule(p) {
  const maxPeriods = p.maxPeriods ?? 600;
  const rows = [];
  let bal = p.balanceCents;
  let totalInterest = 0;
  let totalPaid = 0;
  const payment = (p.paymentCents || 0) + (p.extraCents || 0);
  const lumps = new Map();
  for (const l of p.lumpSums || []) lumps.set(l.period, (lumps.get(l.period) || 0) + l.amountCents);
  let status = 'in_progress';
  let message = '';
  if (bal <= 0) {
    return { rows, status: 'no_balance', payoffDate: null, periods: 0, totalInterestCents: 0, totalPaidCents: 0, message: 'Nothing is owed.' };
  }
  if (payment <= 0 && !lumps.size) {
    return { rows, status: 'zero_payment', payoffDate: null, periods: 0, totalInterestCents: 0, totalPaidCents: 0, message: 'No payment is scheduled, so the balance is never reduced.' };
  }
  const firstInterest = monthlyInterest(bal, p.aprBps);
  const anchorDay = parseDate(p.firstPaymentDate).d;
  for (let i = 0; i < maxPeriods && bal > 0; i += 1) {
    const interest = monthlyInterest(bal, p.aprBps);
    const due = bal + interest;
    const pay = Math.min(payment + (lumps.get(i + 1) || 0), due);
    const principal = pay - interest;
    const end = due - pay;
    rows.push({
      period: i + 1,
      date: addMonths(p.firstPaymentDate, i, anchorDay),
      startCents: bal,
      interestCents: interest,
      paymentCents: pay,
      principalCents: principal,
      endCents: end,
    });
    totalInterest += interest;
    totalPaid += pay;
    bal = end;
    if (i === 0 && payment <= firstInterest && p.aprBps > 0 && !lumps.size) {
      // payment does not even cover interest: show a few periods then stop, honestly.
      status = 'payment_below_interest';
      message = `The payment (${payment} cents) does not cover the monthly interest (${firstInterest} cents), so the balance grows and is never paid off.`;
      for (let j = 1; j < Math.min(maxPeriods, 12) && bal > 0; j += 1) {
        const itr = monthlyInterest(bal, p.aprBps);
        const due2 = bal + itr;
        const pay2 = Math.min(payment, due2);
        rows.push({ period: j + 1, date: addMonths(p.firstPaymentDate, j, anchorDay), startCents: bal, interestCents: itr, paymentCents: pay2, principalCents: pay2 - itr, endCents: due2 - pay2 });
        totalInterest += itr;
        totalPaid += pay2;
        bal = due2 - pay2;
      }
      return { rows, status, payoffDate: null, periods: rows.length, totalInterestCents: totalInterest, totalPaidCents: totalPaid, message };
    }
  }
  if (bal === 0) {
    status = 'paid_off';
    message = `Paid off after ${rows.length} payment${rows.length === 1 ? '' : 's'}.`;
  } else {
    status = 'not_paid_off_in_horizon';
    message = `Not paid off within ${maxPeriods} payments.`;
  }
  return { rows, status, payoffDate: status === 'paid_off' ? rows[rows.length - 1].date : null, periods: rows.length, totalInterestCents: totalInterest, totalPaidCents: totalPaid, message };
}

/**
 * Compare a baseline schedule with an accelerated one. Savings are only reported when both are paid off
 * (otherwise "not calculable" - never a fabricated number).
 */
export function compareSchedules(base, fast) {
  const comparable = base.status === 'paid_off' && fast.status === 'paid_off';
  return {
    comparable,
    monthsSaved: comparable ? base.periods - fast.periods : null,
    interestSavedCents: comparable ? base.totalInterestCents - fast.totalInterestCents : null,
    baseStatus: base.status,
    fastStatus: fast.status,
  };
}

/** Debt overview rows (cards and loans) at a date. */
export function debtOverview(data, date, includePending = true) {
  const index = buildIndex(data);
  const rows = [];
  for (const a of data.accounts) {
    if (!isLiabilityType(a.type) || a.status === 'archived') continue;
    const owed = -accountContribution(index, a.id, date, includePending);
    const regular = regularPayment(a, Math.max(0, owed));
    const first = nextDueDate(date, dueDayOf(a));
    const schedule = amortizationSchedule({ balanceCents: Math.max(0, owed), aprBps: a.aprBps, paymentCents: regular, firstPaymentDate: first, maxPeriods: 600 });
    rows.push({
      account: a,
      owedCents: owed,
      aprBps: a.aprBps,
      regularPaymentCents: regular,
      nextDueDate: first,
      monthlyInterestCents: monthlyInterest(Math.max(0, owed), a.aprBps),
      schedule,
      limitCents: a.creditLimitCents || null,
      utilizationPct: a.creditLimitCents && owed > 0 ? Math.round((owed / a.creditLimitCents) * 1000) / 10 : a.creditLimitCents ? 0 : null,
    });
  }
  return rows;
}

export { addMonths };
