/**
 * Debt maths: payment policy, amortization schedules and payoff comparisons.
 *
 * Assumptions (documented in the README):
 *  - Payment policy per account: fixed (scheduledPaymentCents), minimum (max(floor, interest + x% of the balance),
 *    RECALCULATED every period) or pay in full. debtPeriod() applies it for one period; the forecast engine and the
 *    policy-based schedule both use it, so the Debt page and the Scenario Planner cannot disagree.
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
 * One period of debt service - the single rule shared by the forecast engine, the policy schedule and the
 * upcoming-payments list:
 *   interest = round(owed * APR / 12), charged first;
 *   payment  = the account's regular payment for this balance (or `setPaymentCents` when a what-if replaces it)
 *              plus `extraCents`, but never more than owed + interest (the final payment cannot overshoot).
 * @param {object} acct account (aprBps, paymentMode, scheduledPaymentCents, minPaymentBps, minPaymentFloorCents)
 * @param {number} owedCents amount owed at the start of the period; <= 0 means nothing is owed
 * @param {{setPaymentCents?:number|null, extraCents?:number}} [opt]
 * @returns {{interestCents:number, paymentCents:number, principalCents:number, endOwedCents:number}}
 */
export function debtPeriod(acct, owedCents, { setPaymentCents = null, extraCents = 0 } = {}) {
  if (!(owedCents > 0)) return { interestCents: 0, paymentCents: 0, principalCents: 0, endOwedCents: 0 };
  const interestCents = monthlyInterest(owedCents, acct.aprBps);
  const due = owedCents + interestCents;
  const base = setPaymentCents === null || setPaymentCents === undefined ? regularPayment(acct, owedCents) : Math.min(setPaymentCents, due);
  const paymentCents = Math.min(base + extraCents, due);
  return { interestCents, paymentCents, principalCents: paymentCents - interestCents, endOwedCents: due - paymentCents };
}

/**
 * Amortization-style schedule under one of two explicit assumptions (returned as `assumption`):
 *  - 'account_policy' (pass `account`): every period re-applies that account's payment policy via debtPeriod -
 *    exactly what the forecast does. `setPaymentCents` replaces the regular payment (a what-if), `extraCents` adds
 *    to it, and `aprBps` may override the account's rate (a what-if).
 *  - 'fixed_payment' (pass `paymentCents`): the same payment (+ extra) every period, e.g. "keep paying this month's
 *    minimum". Correct arithmetic for a genuinely fixed plan; it is NOT the minimum policy.
 * @param {{balanceCents:number, aprBps:number, account?:object, paymentCents?:number, setPaymentCents?:number|null,
 *          extraCents?:number, firstPaymentDate:string, lumpSums?:Array<{period:number, amountCents:number}>, maxPeriods?:number}} p
 * @returns {{rows:Array, status:string, payoffDate:string|null, periods:number, totalInterestCents:number, totalPaidCents:number,
 *          message:string, assumption:'account_policy'|'fixed_payment', paymentMode:string}}
 */
export function amortizationSchedule(p) {
  const maxPeriods = p.maxPeriods ?? 600;
  const rows = [];
  let bal = p.balanceCents;
  let totalInterest = 0;
  let totalPaid = 0;
  const policy = p.account ? { ...p.account, aprBps: p.aprBps ?? p.account.aprBps } : null;
  const extra = p.extraCents || 0;
  const fixed = (p.paymentCents || 0) + extra;
  const meta = { assumption: policy ? 'account_policy' : 'fixed_payment', paymentMode: policy ? policy.paymentMode || 'fixed' : 'fixed' };
  const lumps = new Map();
  for (const l of p.lumpSums || []) lumps.set(l.period, (lumps.get(l.period) || 0) + l.amountCents);
  /** interest and capped payment for a period that starts at `owed`, with an optional one-off `lump` */
  const step = (owed, lump = 0) => {
    if (policy) return debtPeriod(policy, owed, { setPaymentCents: p.setPaymentCents ?? null, extraCents: extra + lump });
    const interestCents = monthlyInterest(owed, p.aprBps);
    const paymentCents = Math.min(fixed + lump, owed + interestCents);
    return { interestCents, paymentCents, principalCents: paymentCents - interestCents, endOwedCents: owed + interestCents - paymentCents };
  };
  const done = (status, message, payoffDate = null) => ({ rows, status, payoffDate, periods: rows.length, totalInterestCents: totalInterest, totalPaidCents: totalPaid, message, ...meta });
  if (bal <= 0) return done('no_balance', 'Nothing is owed.');
  if (step(bal).paymentCents <= 0 && !lumps.size) return done('zero_payment', 'No payment is scheduled, so the balance is never reduced.');
  const anchorDay = parseDate(p.firstPaymentDate).d;
  const record = (i, r) => {
    rows.push({ period: i + 1, date: addMonths(p.firstPaymentDate, i, anchorDay), startCents: bal, interestCents: r.interestCents, paymentCents: r.paymentCents, principalCents: r.principalCents, endCents: r.endOwedCents });
    totalInterest += r.interestCents;
    totalPaid += r.paymentCents;
    bal = r.endOwedCents;
  };
  for (let i = 0; i < maxPeriods && bal > 0; i += 1) {
    const r = step(bal, lumps.get(i + 1) || 0);
    record(i, r);
    if (i === 0 && r.paymentCents <= r.interestCents && p.aprBps > 0 && !lumps.size) {
      // the payment does not even cover the interest: show a few periods, then stop honestly
      const message = `The payment (${r.paymentCents} cents) does not cover the monthly interest (${r.interestCents} cents), so the balance grows and is never paid off.`;
      for (let j = 1; j < Math.min(maxPeriods, 12) && bal > 0; j += 1) record(j, step(bal));
      return done('payment_below_interest', message);
    }
  }
  if (bal === 0) return done('paid_off', `Paid off after ${rows.length} payment${rows.length === 1 ? '' : 's'}.`, rows[rows.length - 1].date);
  return done('not_paid_off_in_horizon', `Not paid off within ${maxPeriods} payments.`);
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
    // `schedule` follows the account's payment policy every period (the same rule as the forecast). For a
    // minimum-payment account `fixedSchedule` is the separate what-if "keep paying this month's amount"; for fixed
    // and pay-in-full accounts the two coincide.
    const terms = { balanceCents: Math.max(0, owed), aprBps: a.aprBps, firstPaymentDate: first, maxPeriods: 600 };
    const schedule = amortizationSchedule({ ...terms, account: a });
    const fixedSchedule = a.paymentMode === 'minimum' ? amortizationSchedule({ ...terms, paymentCents: regular }) : schedule;
    rows.push({
      account: a,
      owedCents: owed,
      aprBps: a.aprBps,
      regularPaymentCents: regular,
      nextDueDate: first,
      monthlyInterestCents: monthlyInterest(Math.max(0, owed), a.aprBps),
      schedule,
      fixedSchedule,
      limitCents: a.creditLimitCents || null,
      utilizationPct: a.creditLimitCents && owed > 0 ? Math.round((owed / a.creditLimitCents) * 1000) / 10 : a.creditLimitCents ? 0 : null,
    });
  }
  return rows;
}

export { addMonths };
