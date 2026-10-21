/**
 * Deterministic forward projection ("baseline" or "baseline + scenario changes").
 *
 * The projection NEVER writes to the ledger: it copies the starting balances and replays a sorted list
 * of dated events against that private copy. Same data + same assumptions => byte-identical output,
 * regardless of which pages were visited before (no Date.now, no randomness, no module state).
 *
 * Start state   : each account's pending-inclusive contribution at the as-of date. Future-dated ledger
 *                 entries (date > as-of) become events instead.
 * Window        : the `horizonMonths` calendar months beginning with the month of (as-of + 1 day).
 * Events        : (1) active recurring occurrences not already matched/skipped,
 *                 (2) future-dated ledger transactions, (3) estimated everyday spending,
 *                 (4) scenario changes, (5) debt interest + payments on each due date,
 *                 (6) month-end savings interest and assumed investment growth.
 * Order of ops on one date (lower runs first): income 10, ledger 15, expense/one-time 20,
 *                 transfers & savings 30, debt due (interest then payment) 40, lump sums 45,
 *                 month-end interest/growth 60. Ties break on a stable key.
 * Interest      : monthly = round(balance * APR / 12) on the balance at the due date, charged first
 *                 and then the payment is applied; the payment never exceeds what is owed.
 * Growth        : balance * annual% / 12 each month-end (a planning assumption, never a guarantee).
 * Cash may go negative (overdraft): the projection flags it instead of blocking or hiding it.
 */
import { buildIndex, accountContribution, isLiabilityType } from '../domain/ledger.js';
import { occurrencesBetween, linkedOccurrences } from '../domain/recurring.js';
import { regularPayment, dueDayOf } from '../domain/debt.js';
import { allocateGoals } from '../domain/goals.js';
import { monthlyInterest, mulDiv, roundDiv } from '../domain/money.js';
import { addDays, addMonths, addMonthKey, monthKey, monthEnd, monthStart, monthsBetween, daysInMonth, parseDate, makeDate } from '../domain/dates.js';
import { CASH_TYPES } from '../domain/schema.js';

const ORDER = { income: 10, ledger: 15, expense: 20, transfer: 30, debt: 40, lump: 45, monthEnd: 60 };
const INTEREST_NAME = /interest/i;

export const DEFAULT_ASSUMPTIONS = Object.freeze({ investmentGrowthBps: null, variableSpending: 'trailing', variableSpendingCents: null, includeSavingsInterest: true });

/** Primary spending account: the first active checking account (documented assumption). */
export function primaryAccount(data) {
  return data.accounts.find((a) => a.status === 'active' && a.type === 'checking') || data.accounts.find((a) => a.status === 'active' && !isLiabilityType(a.type)) || null;
}

/**
 * Average monthly everyday (non-recurring, non-interest) net spending over up to `months` complete
 * months before the as-of month. Transactions linked to a recurring rule are excluded because the
 * rule itself is projected, and categories with "interest" in the name are excluded because debt
 * interest is projected separately.
 */
export function trailingVariableSpend(data, asOfDate, months = 6) {
  const index = buildIndex(data);
  const endMonth = addMonthKey(monthKey(asOfDate), -1);
  let startMonth = addMonthKey(endMonth, -(months - 1));
  const earliest = index.sortedTx.length ? monthKey(index.sortedTx[0].date) : endMonth;
  if (startMonth < earliest) startMonth = earliest;
  const n = monthsBetween(startMonth, endMonth) + 1;
  if (n <= 0) return 0;
  const lo = monthStart(startMonth);
  const hi = monthEnd(endMonth);
  let total = 0;
  for (const t of index.sortedTx) {
    if (t.date < lo || t.date > hi) continue;
    if (t.kind !== 'expense' || t.status !== 'posted' || t.recurrence) continue;
    const parts = t.splits.length ? t.splits : [{ categoryId: t.categoryId, amountCents: t.amountCents }];
    for (const p of parts) {
      const cat = p.categoryId ? index.categoriesById.get(p.categoryId) : null;
      if (cat && INTEREST_NAME.test(cat.name)) continue;
      total += -p.amountCents;
    }
  }
  return roundDiv(total, n);
}

function activeAt(change, date) {
  if (change.enabled === false) return false;
  const from = change.effectiveDate;
  if (from && date < from) return false;
  if (change.endDate && date > change.endDate) return false;
  return true;
}

/**
 * Run a projection.
 * @param {object} data dataset (read only)
 * @param {object|null} scenario scenario or null for the baseline
 * @param {{asOfDate?:string, horizonMonths?:number}} [opts] overrides (used so baseline and scenarios share a window)
 */
export function runProjection(data, scenario = null, opts = {}) {
  const index = buildIndex(data);
  const asOfDate = opts.asOfDate || scenario?.asOfDate || data.settings.asOfDate;
  const horizonMonths = opts.horizonMonths || scenario?.horizonMonths || 12;
  const assumptions = { ...DEFAULT_ASSUMPTIONS, ...(scenario?.assumptions || {}) };
  const growthBps = assumptions.investmentGrowthBps ?? data.settings.investmentGrowthBps ?? 0;
  const changes = (scenario?.changes || []).filter((c) => c.enabled !== false);
  const firstMonth = monthKey(addDays(asOfDate, 1));
  const months = Array.from({ length: horizonMonths }, (_, i) => addMonthKey(firstMonth, i));
  const endDate = monthEnd(months[months.length - 1]);
  const notes = [];

  // ---- starting state
  const bal = new Map();
  for (const a of data.accounts) bal.set(a.id, accountContribution(index, a.id, asOfDate, true));
  const startBal = new Map(bal);
  const primary = primaryAccount(data);
  const accountName = (id) => index.accountsById.get(id)?.name || id;

  const events = [];
  let seq = 0;
  const push = (e) => events.push({ ...e, key: `${e.date}|${String(e.order).padStart(3, '0')}|${String(seq++).padStart(6, '0')}` });

  // ---- recurring rules (+ scenario modifications)
  const links = linkedOccurrences(data);
  const incomeChanges = changes.filter((c) => c.type === 'income_change');
  const removals = changes.filter((c) => c.type === 'recurring_remove');
  const addRule = (rule, changeId, label) => {
    const byRule = links.get(rule.id);
    for (const occ of occurrencesBetween(rule, addDays(asOfDate, -10), endDate)) {
      if (occ.date <= asOfDate || occ.date > endDate) continue;
      if (rule.skipped?.includes(occ.scheduled) || byRule?.has(occ.scheduled)) continue;
      let amount = rule.amountCents;
      let cid = changeId;
      let lbl = label || rule.title;
      const removal = removals.find((r) => r.recurringId === rule.id && occ.scheduled >= r.effectiveDate);
      if (removal) continue;
      if (rule.kind === 'income') {
        for (const c of incomeChanges) {
          if (occ.scheduled < c.effectiveDate) continue;
          if (c.recurringId && c.recurringId !== rule.id) continue;
          amount = c.mode === 'percent' ? mulDiv(amount, 10000 + c.percentBps, 10000) : amount + c.amountCents;
          amount = Math.max(0, amount);
          cid = c.id;
        }
        if (amount === 0) continue;
        push({ date: occ.date, order: ORDER.income, type: 'recurring', kind: 'income', label: lbl, legs: [{ accountId: rule.accountId, cents: amount }], changeId: cid, ruleId: rule.id });
      } else if (rule.kind === 'expense') {
        push({ date: occ.date, order: ORDER.expense, type: 'recurring', kind: 'expense', label: lbl, legs: [{ accountId: rule.accountId, cents: -amount }], changeId: cid, ruleId: rule.id });
      } else {
        push({ date: occ.date, order: ORDER.transfer, type: 'recurring', kind: 'transfer', label: lbl, legs: [{ accountId: rule.accountId, cents: -amount }, { accountId: rule.toAccountId, cents: amount }], changeId: cid, ruleId: rule.id });
      }
    }
  };
  for (const rule of data.recurring) if (rule.active) addRule(rule, null, null);
  for (const c of changes) {
    if (c.type === 'recurring_add') {
      addRule({ id: c.id, title: c.title, kind: c.kind, amountCents: c.amountCents, accountId: c.accountId, toAccountId: null, startDate: c.effectiveDate, endDate: c.endDate || null, interval: c.interval, businessDay: 'none', skipped: [] }, c.id, `${c.title} (new)`);
    }
  }

  // ---- future-dated ledger entries (known, already entered)
  for (const t of index.sortedTx) {
    if (t.date <= asOfDate || t.date > endDate) continue;
    if (t.recurrence) {
      // keep: it is a real ledger entry, and its occurrence was excluded above as matched
    }
    const kind = t.kind === 'income' ? 'income' : t.kind === 'expense' ? 'expense' : t.kind === 'transfer' ? 'transfer' : 'adjustment';
    push({ date: t.date, order: ORDER.ledger, type: 'ledger', kind, label: t.description, legs: [{ accountId: t.accountId, cents: t.amountCents }], changeId: null });
  }

  // ---- everyday spending estimate
  if (assumptions.variableSpending !== 'none' && primary) {
    const monthly = assumptions.variableSpending === 'custom' ? assumptions.variableSpendingCents || 0 : trailingVariableSpend(data, asOfDate);
    if (monthly !== 0) {
      for (const m of months) {
        const date = makeDate(+m.slice(0, 4), +m.slice(5, 7), Math.min(15, daysInMonth(+m.slice(0, 4), +m.slice(5, 7))));
        if (date <= asOfDate) continue;
        push({ date, order: ORDER.expense, type: 'estimate', kind: 'expense', label: 'Everyday spending (estimate)', legs: [{ accountId: primary.id, cents: -monthly }], changeId: null });
      }
      notes.push(`Everyday spending is estimated at ${monthly} cents per month (${assumptions.variableSpending === 'custom' ? 'custom amount' : 'average of up to 6 complete months of non-recurring spending'}) charged to ${primary.name} on the 15th.`);
    }
  } else if (assumptions.variableSpending !== 'none') {
    notes.push('No active checking account was found, so everyday spending is not projected.');
  }

  // ---- scenario one-offs and savings changes
  for (const c of changes) {
    if (c.type === 'one_time' && c.date > asOfDate && c.date <= endDate) {
      push({ date: c.date, order: c.amountCents > 0 ? ORDER.income : ORDER.expense, type: 'scenario', kind: c.amountCents > 0 ? 'windfall' : 'expense', label: c.title, legs: [{ accountId: c.accountId, cents: c.amountCents }], changeId: c.id });
    }
    if (c.type === 'savings_change') {
      const e = parseDate(c.effectiveDate);
      const day = c.day || e.d;
      for (let k = 0; k < horizonMonths + 2; k += 1) {
        const date = addMonths(makeDate(e.y, e.m, 1), k, day);
        if (date < c.effectiveDate || date <= asOfDate) continue;
        if (date > endDate) break;
        push({ date, order: ORDER.transfer, type: 'scenario', kind: 'transfer', label: c.title || 'Savings change', legs: [{ accountId: c.fromAccountId, cents: -c.amountCents }, { accountId: c.toAccountId, cents: c.amountCents }], changeId: c.id });
      }
    }
    if (c.type === 'debt_lump' && c.date > asOfDate && c.date <= endDate) {
      push({ date: c.date, order: ORDER.lump, type: 'lump', kind: 'debt_payment', label: `Extra payment to ${accountName(c.accountId)}`, accountId: c.accountId, amountCents: c.amountCents, changeId: c.id });
    }
  }

  // ---- debt due dates (dynamic: interest + payment are computed during the replay)
  const debtAccounts = data.accounts.filter((a) => a.status === 'active' && isLiabilityType(a.type));
  for (const a of debtAccounts) {
    const day = dueDayOf(a);
    for (const m of months) {
      const y = +m.slice(0, 4);
      const mo = +m.slice(5, 7);
      const date = makeDate(y, mo, Math.min(day, daysInMonth(y, mo)));
      if (date <= asOfDate) continue;
      push({ date, order: ORDER.debt, type: 'debt_due', kind: 'debt', label: `${a.name} due`, accountId: a.id, changeId: null });
    }
  }

  // ---- month ends: savings interest and investment growth
  for (const m of months) {
    const date = monthEnd(m);
    if (date <= asOfDate) continue;
    for (const a of data.accounts) {
      if (a.status !== 'active') continue;
      if (a.type === 'savings' && a.aprBps > 0 && assumptions.includeSavingsInterest) push({ date, order: ORDER.monthEnd, type: 'savings_interest', kind: 'interest_earned', label: `${a.name} interest`, accountId: a.id, changeId: null });
      if (a.type === 'investment' && growthBps !== 0) push({ date, order: ORDER.monthEnd, type: 'growth', kind: 'growth', label: `${a.name} assumed growth`, accountId: a.id, changeId: scenario && assumptions.investmentGrowthBps !== null ? 'assumption' : null });
    }
  }
  if (growthBps !== 0) notes.push(`Investment accounts are assumed to change by ${(growthBps / 100).toFixed(2)}% per year (applied monthly). This is a planning assumption, not a prediction or guarantee.`);
  else notes.push('Investment accounts are held flat (0% assumed growth) unless a growth rate is set; contributions are modeled, market returns are not.');

  events.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // ---- debt policy helpers
  const payerFor = (a) => {
    const p = a.autopayAccountId && index.accountsById.get(a.autopayAccountId);
    return p && p.status === 'active' ? p.id : primary?.id || null;
  };
  const debtStats = new Map(debtAccounts.map((a) => [a.id, { accountId: a.id, name: a.name, startOwedCents: Math.max(0, -startBal.get(a.id)), interestCents: 0, paidCents: 0, payoffDate: null, belowInterest: false, firstPaymentCents: null }]));

  // ---- replay
  const log = [];
  const monthly = [];
  const acc = new Map(months.map((m) => [m, { incomeCents: 0, expensesCents: 0, interestPaidCents: 0, interestEarnedCents: 0, growthCents: 0, externalCents: 0, adjustmentCents: 0, debtPaymentsCents: 0, savingsMovedCents: 0, nwChangeCents: 0 }]));
  const apply = (e, legs) => {
    let nw = 0;
    for (const l of legs) {
      bal.set(l.accountId, (bal.get(l.accountId) || 0) + l.cents);
      nw += l.cents;
    }
    const m = monthKey(e.date);
    const a = acc.get(m);
    if (a) {
      a.nwChangeCents += nw;
      const net = legs[0]?.cents ?? 0;
      if (e.kind === 'income' || e.kind === 'windfall') a.incomeCents += net;
      else if (e.kind === 'expense') a.expensesCents += -net;
      else if (e.kind === 'interest_paid') a.interestPaidCents += -net;
      else if (e.kind === 'interest_earned') a.interestEarnedCents += net;
      else if (e.kind === 'growth') a.growthCents += net;
      else if (e.kind === 'adjustment') a.adjustmentCents += net;
      else if (e.kind === 'debt_payment') a.debtPaymentsCents += legs[1]?.cents ?? 0;
      else if (e.kind === 'transfer') a.savingsMovedCents += legs.filter((l) => l.cents > 0 && CASH_TYPES.includes(index.accountsById.get(l.accountId)?.type)).reduce((s, l) => s + l.cents, 0);
    }
    log.push({ date: e.date, month: m, type: e.type, kind: e.kind, label: e.label, legs, nwEffectCents: nw, changeId: e.changeId || null });
  };

  const startNw = [...startBal.values()].reduce((a, b) => a + b, 0);
  const snapshot = (m, date) => {
    const balances = new Map(bal);
    let nw = 0;
    let liquid = 0;
    let debt = 0;
    let assets = 0;
    for (const a of data.accounts) {
      const v = bal.get(a.id) || 0;
      nw += v;
      if (CASH_TYPES.includes(a.type)) liquid += v;
      if (isLiabilityType(a.type)) debt += -v;
      else assets += v;
    }
    return { month: m, date, balances, netWorthCents: nw, liquidCents: liquid, debtCents: debt, assetsCents: assets };
  };

  let p = 0;
  const negativeCash = new Map();
  for (const m of months) {
    const mEnd = monthEnd(m);
    while (p < events.length && events[p].date <= mEnd) {
      const e = events[p];
      p += 1;
      if (e.type === 'debt_due') {
        const a = index.accountsById.get(e.accountId);
        const st = debtStats.get(a.id);
        const owed = -(bal.get(a.id) || 0);
        if (owed <= 0) continue;
        const interest = monthlyInterest(owed, a.aprBps);
        if (interest > 0) {
          apply({ ...e, kind: 'interest_paid', label: `${a.name} interest` }, [{ accountId: a.id, cents: -interest }]);
          st.interestCents += interest;
        }
        let pay = regularPayment(a, owed);
        let extra = 0;
        for (const c of changes) {
          if (c.type !== 'debt_payment' || c.accountId !== a.id || !activeAt(c, e.date)) continue;
          if (c.mode === 'set') pay = Math.min(c.amountCents, owed + interest);
          else extra += c.amountCents;
        }
        const total = Math.min(pay + extra, owed + interest);
        const payer = payerFor(a);
        const cid = changes.find((c) => c.type === 'debt_payment' && c.accountId === a.id && activeAt(c, e.date))?.id || null;
        if (total > 0 && payer) {
          apply({ ...e, kind: 'debt_payment', label: `Payment to ${a.name}`, changeId: cid }, [{ accountId: payer, cents: -total }, { accountId: a.id, cents: total }]);
          st.paidCents += total;
          if (st.firstPaymentCents === null) {
            st.firstPaymentCents = total;
            if (a.aprBps > 0 && total <= interest) st.belowInterest = true;
          }
        } else if (st.firstPaymentCents === null) {
          st.firstPaymentCents = 0;
          if (a.aprBps > 0 && interest > 0) st.belowInterest = true;
        }
        if ((bal.get(a.id) || 0) >= 0 && !st.payoffDate) st.payoffDate = e.date; // first date the debt reaches zero
        continue;
      }
      if (e.type === 'lump') {
        const a = index.accountsById.get(e.accountId);
        const owed = -(bal.get(a.id) || 0);
        const payer = payerFor(a);
        const amt = Math.min(e.amountCents, Math.max(0, owed));
        if (amt > 0 && payer) {
          apply({ ...e, label: e.label }, [{ accountId: payer, cents: -amt }, { accountId: a.id, cents: amt }]);
          debtStats.get(a.id).paidCents += amt;
          if ((bal.get(a.id) || 0) >= 0 && !debtStats.get(a.id).payoffDate) debtStats.get(a.id).payoffDate = e.date;
        }
        continue;
      }
      if (e.type === 'savings_interest') {
        const v = bal.get(e.accountId) || 0;
        const interest = v > 0 ? monthlyInterest(v, index.accountsById.get(e.accountId).aprBps) : 0;
        if (interest > 0) apply(e, [{ accountId: e.accountId, cents: interest }]);
        continue;
      }
      if (e.type === 'growth') {
        const v = bal.get(e.accountId) || 0;
        const g = mulDiv(v, growthBps, 120000);
        if (g !== 0) apply(e, [{ accountId: e.accountId, cents: g }]);
        continue;
      }
      apply(e, e.legs);
    }
    for (const a of data.accounts) {
      if (CASH_TYPES.includes(a.type) && a.status === 'active' && (bal.get(a.id) || 0) < 0 && !negativeCash.has(a.id)) negativeCash.set(a.id, { accountId: a.id, name: a.name, month: m, balanceCents: bal.get(a.id) });
    }
    const a = acc.get(m);
    monthly.push({ ...snapshot(m, mEnd), ...a, netCashFlowCents: a.incomeCents + a.interestEarnedCents - a.expensesCents - a.interestPaidCents });
  }

  // ---- debt outcomes
  const debts = [...debtStats.values()].map((s) => {
    const endOwed = Math.max(0, -(bal.get(s.accountId) || 0));
    const a = index.accountsById.get(s.accountId);
    let status;
    if (s.startOwedCents === 0 && s.paidCents === 0 && endOwed === 0) status = 'no_balance';
    else if (s.payoffDate && endOwed === 0) status = 'paid_off';
    else if (s.payoffDate) status = 'cleared_then_recharged'; // reached zero, then recurring charges added a new balance
    else status = s.belowInterest ? 'payment_below_interest' : 'not_paid_off_in_horizon';
    const payoffMonthIndex = s.payoffDate ? months.indexOf(monthKey(s.payoffDate)) + 1 : null;
    return { ...s, name: a?.name || s.name, endOwedCents: endOwed, status, payoffMonthIndex };
  });

  // ---- goals
  const goalSeries = data.goals.map((g) => ({ goalId: g.id, name: g.name, targetCents: g.targetCents, series: [], reachedMonth: null }));
  const goalsAt = (balances, date) => {
    const alloc = allocateGoals(data.goals, (id) => balances.get(id) || 0);
    return data.goals.map((g) => {
      if (g.allocation.type === 'manual') return g.contributions.filter((c) => c.date <= date).reduce((s, c) => s + c.amountCents, 0);
      return alloc.get(g.id) || 0;
    });
  };
  const startGoals = goalsAt(startBal, asOfDate);
  goalSeries.forEach((gs, i) => gs.series.push(startGoals[i]));
  for (const snap of monthly) {
    const vals = goalsAt(snap.balances, snap.date);
    goalSeries.forEach((gs, i) => {
      gs.series.push(vals[i]);
      if (gs.reachedMonth === null && vals[i] >= gs.targetCents) gs.reachedMonth = snap.month;
    });
  }
  const goals = goalSeries.map((gs, i) => ({ ...gs, startCents: startGoals[i], endCents: gs.series[gs.series.length - 1], startReached: startGoals[i] >= gs.targetCents }));

  const sum = (k) => monthly.reduce((s, m) => s + m[k], 0);
  const totals = {
    incomeCents: sum('incomeCents'),
    expensesCents: sum('expensesCents'),
    interestPaidCents: sum('interestPaidCents'),
    interestEarnedCents: sum('interestEarnedCents'),
    growthCents: sum('growthCents'),
    netCashFlowCents: sum('netCashFlowCents'),
    debtPaymentsCents: sum('debtPaymentsCents'),
    startNetWorthCents: startNw,
    endNetWorthCents: monthly.length ? monthly[monthly.length - 1].netWorthCents : startNw,
    endLiquidCents: monthly.length ? monthly[monthly.length - 1].liquidCents : 0,
    endDebtCents: monthly.length ? monthly[monthly.length - 1].debtCents : 0,
  };

  return {
    asOfDate,
    endDate,
    horizonMonths,
    months,
    scenarioId: scenario?.id || null,
    start: { ...snapshot(monthKey(asOfDate), asOfDate), balances: startBal, netWorthCents: startNw },
    monthly,
    events: log,
    totals,
    debts,
    goals,
    warnings: [...negativeCash.values()].map((n) => ({ type: 'negative_cash', ...n, message: `${n.name} is projected to go negative in ${n.month} (${n.balanceCents} cents).` })),
    notes,
    assumptions: { ...assumptions, investmentGrowthBps: growthBps },
  };
}
