import { describe, it, expect } from 'vitest';
import { amortizationSchedule, compareSchedules, loanPayment, regularPayment, minimumPayment, nextDueDate, debtOverview } from '../../src/domain/debt.js';
import { runProjection, trailingVariableSpend } from '../../src/forecast/engine.js';
import { compareProjections } from '../../src/forecast/compare.js';
import { compareToBaseline } from '../../src/forecast/index.js';
import { saveScenario, duplicateScenario, deleteScenario } from '../../src/domain/ops/catalog.js';
import { getPreset } from '../../src/seed/presets.js';
import { buildDemoDataset } from '../../src/seed/demo.js';
import { validateChange } from '../../src/forecast/changes.js';
import { validateStructure } from '../../src/domain/validate.js';
import { must } from '../helpers.js';
import { usd } from '../../src/seed/builder.js';
import { monthlyInterest } from '../../src/domain/money.js';

describe('amortization schedules', () => {
  it('pays down a loan with interest/principal split and never overshoots the final payment', () => {
    const s = amortizationSchedule({ balanceCents: 100000, aprBps: 1200, paymentCents: 30000, firstPaymentDate: '2026-11-15' });
    expect(s.status).toBe('paid_off');
    expect(s.rows[0]).toMatchObject({ period: 1, startCents: 100000, interestCents: 1000, paymentCents: 30000, principalCents: 29000, endCents: 71000, date: '2026-11-15' });
    const last = s.rows[s.rows.length - 1];
    expect(last.endCents).toBe(0);
    expect(last.paymentCents).toBeLessThanOrEqual(30000);
    expect(s.rows.every((r) => r.paymentCents === r.interestCents + r.principalCents)).toBe(true);
    expect(s.rows.every((r) => r.startCents + r.interestCents - r.paymentCents === r.endCents)).toBe(true);
    expect(s.totalPaidCents).toBe(100000 + s.totalInterestCents);
    expect(s.payoffDate).toBe(last.date);
  });
  it('handles zero APR exactly', () => {
    const s = amortizationSchedule({ balanceCents: 100000, aprBps: 0, paymentCents: 30000, firstPaymentDate: '2026-11-01' });
    expect(s.totalInterestCents).toBe(0);
    expect(s.periods).toBe(4);
    expect(s.rows[3].paymentCents).toBe(10000);
  });
  it('does not invent success for zero or insufficient payments', () => {
    expect(amortizationSchedule({ balanceCents: 100000, aprBps: 1200, paymentCents: 0, firstPaymentDate: '2026-11-01' }).status).toBe('zero_payment');
    const low = amortizationSchedule({ balanceCents: 100000, aprBps: 1200, paymentCents: 1000, firstPaymentDate: '2026-11-01' });
    expect(low.status).toBe('payment_below_interest');
    expect(low.payoffDate).toBeNull();
    expect(low.rows.length).toBeLessThanOrEqual(12);
    const lower = amortizationSchedule({ balanceCents: 100000, aprBps: 1200, paymentCents: 500, firstPaymentDate: '2026-11-01' });
    expect(lower.rows[lower.rows.length - 1].endCents).toBeGreaterThan(100000);
    expect(amortizationSchedule({ balanceCents: 0, aprBps: 1200, paymentCents: 100, firstPaymentDate: '2026-11-01' }).status).toBe('no_balance');
  });
  it('reports a horizon cut-off honestly', () => {
    const s = amortizationSchedule({ balanceCents: 1000000, aprBps: 600, paymentCents: 10000, firstPaymentDate: '2026-11-01', maxPeriods: 24 });
    expect(s.status).toBe('not_paid_off_in_horizon');
    expect(s.payoffDate).toBeNull();
  });
  it('extra payments save time and interest, and are reported only when both finish', () => {
    const base = amortizationSchedule({ balanceCents: 1500000, aprBps: 549, paymentCents: 30000, firstPaymentDate: '2026-11-15' });
    const fast = amortizationSchedule({ balanceCents: 1500000, aprBps: 549, paymentCents: 30000, extraCents: 20000, firstPaymentDate: '2026-11-15' });
    const cmp = compareSchedules(base, fast);
    expect(cmp.comparable).toBe(true);
    expect(cmp.monthsSaved).toBeGreaterThan(0);
    expect(cmp.interestSavedCents).toBeGreaterThan(0);
    const never = amortizationSchedule({ balanceCents: 1500000, aprBps: 549, paymentCents: 100, firstPaymentDate: '2026-11-15' });
    expect(compareSchedules(never, fast).comparable).toBe(false);
    expect(compareSchedules(never, fast).monthsSaved).toBeNull();
  });
  it('lump sums are applied in their period', () => {
    const s = amortizationSchedule({ balanceCents: 100000, aprBps: 0, paymentCents: 10000, lumpSums: [{ period: 2, amountCents: 50000 }], firstPaymentDate: '2026-11-01' });
    expect(s.rows[1].paymentCents).toBe(60000);
    expect(s.periods).toBe(5);
    expect(s.rows[4].endCents).toBe(0);
  });
  it('payment policies', () => {
    const card = { aprBps: 2000, paymentMode: 'minimum', minPaymentBps: 100, minPaymentFloorCents: 3500, scheduledPaymentCents: 0 };
    expect(minimumPayment(card, 100000)).toBe(Math.max(3500, monthlyInterest(100000, 2000) + 1000));
    expect(regularPayment({ ...card, paymentMode: 'pay_in_full' }, 100000)).toBe(100000 + monthlyInterest(100000, 2000));
    expect(regularPayment({ ...card, paymentMode: 'fixed', scheduledPaymentCents: 99999999 }, 100000)).toBe(100000 + monthlyInterest(100000, 2000));
    expect(regularPayment(card, 0)).toBe(0);
    expect(loanPayment(2650000, 549, 60)).toBeGreaterThan(50000);
    expect(loanPayment(120000, 0, 12)).toBe(10000);
    expect(nextDueDate('2026-10-01', 15)).toBe('2026-10-15');
    expect(nextDueDate('2026-10-15', 15)).toBe('2026-11-15');
    expect(nextDueDate('2026-01-31', 31)).toBe('2026-02-28');
  });
  it('debt overview lists every active card and loan with a payoff projection', () => {
    const rows = debtOverview(buildDemoDataset(), '2026-10-01');
    expect(rows.map((r) => r.account.id).sort()).toEqual(['acct-cc-rewards', 'acct-cc-travel', 'acct-loan-auto', 'acct-loan-student']);
    const auto = rows.find((r) => r.account.id === 'acct-loan-auto');
    expect(auto.schedule.status).toBe('paid_off');
    expect(auto.owedCents).toBeGreaterThan(0);
  });
});

describe('projection engine', () => {
  const demo = buildDemoDataset();
  it('is deterministic and independent of earlier runs', () => {
    const a = runProjection(demo, null);
    runProjection(demo, demo.scenarios[0]);
    const b = runProjection(demo, null);
    expect(JSON.stringify(a.monthly.map((m) => [m.month, m.netWorthCents, m.liquidCents, m.debtCents]))).toBe(JSON.stringify(b.monthly.map((m) => [m.month, m.netWorthCents, m.liquidCents, m.debtCents])));
    expect(a.events).toEqual(b.events);
  });
  it('covers at least 12 months from the as-of date, starting at ledger net worth', () => {
    const p = runProjection(demo, null);
    expect(p.months).toHaveLength(12);
    expect(p.months[0]).toBe('2026-10');
    expect(p.months[11]).toBe('2027-09');
    expect(p.start.netWorthCents).toBeGreaterThan(0);
  });
  it('every month balances: net worth change equals the sum of its events', () => {
    const p = runProjection(demo, demo.scenarios[1]);
    let prev = p.start.netWorthCents;
    for (const m of p.monthly) {
      const sum = p.events.filter((e) => e.month === m.month).reduce((s, e) => s + e.nwEffectCents, 0);
      expect(m.netWorthCents - prev).toBe(sum);
      expect([...m.balances.values()].reduce((a, b) => a + b, 0)).toBe(m.netWorthCents);
      prev = m.netWorthCents;
    }
  });
  it('does not mutate the dataset, and scenarios do not affect each other or the baseline', () => {
    const snap = JSON.stringify(demo);
    const base1 = runProjection(demo, null);
    for (const s of demo.scenarios) runProjection(demo, s);
    expect(JSON.stringify(demo)).toBe(snap);
    expect(runProjection(demo, null).totals).toEqual(base1.totals);
  });
  it('an extra loan payment pays off sooner, saves interest and leaves actual balances unchanged', () => {
    const { baseline, scenario, comparison } = compareToBaseline(demo, demo.scenarios[0], { horizonMonths: 60 });
    const auto = comparison.debts.find((d) => d.accountId === 'acct-loan-auto');
    expect(auto.monthsEarlier).toBeGreaterThan(0);
    expect(auto.interest.diff).toBeLessThan(0);
    expect(baseline.debts.find((d) => d.accountId === 'acct-loan-auto').status).toBe('paid_off');
    expect(scenario.debts.find((d) => d.accountId === 'acct-loan-auto').payoffDate < baseline.debts.find((d) => d.accountId === 'acct-loan-auto').payoffDate).toBe(true);
    expect(comparison.timeline.find((t) => t.causes.length)?.causes[0].label).toMatch(/Payment to|Extra/);
  });
  it('final payments never overshoot: balances never go positive on a loan', () => {
    const p = runProjection(demo, demo.scenarios[0], { horizonMonths: 72 });
    for (const m of p.monthly) {
      expect(m.balances.get('acct-loan-auto')).toBeLessThanOrEqual(0);
      expect(m.balances.get('acct-loan-student')).toBeLessThanOrEqual(0);
    }
  });
  it('flags a payment below the monthly interest as never paying off', () => {
    const d = getPreset('debt-acceleration').build();
    const under = d.scenarios.find((s) => s.id === 'scn-card-underpay');
    const p = runProjection(d, under, { horizonMonths: 60 });
    const card = p.debts.find((x) => x.accountId === 'card');
    expect(card.status).toBe('payment_below_interest');
    expect(card.payoffDate).toBeNull();
    expect(card.endOwedCents).toBeGreaterThan(0);
  });
  it('an income change, savings change and one-time windfall change the right things', () => {
    const d = getPreset('debt-acceleration').build();
    const base = runProjection(d, null, { horizonMonths: 12 });
    const s = must(saveScenario(d, { name: 'Mix', horizonMonths: 12, changes: [
      { type: 'income_change', effectiveDate: '2027-01-01', mode: 'amount', amountCents: 50000, recurringId: 'rec-pay' },
      { type: 'one_time', date: '2026-12-10', title: 'Windfall', amountCents: 200000, accountId: 'chk' },
      { type: 'recurring_add', title: 'Gym', kind: 'expense', amountCents: 5000, accountId: 'chk', effectiveDate: '2026-11-01', interval: 'monthly' },
      { type: 'recurring_remove', recurringId: 'rec-rent', effectiveDate: '2027-06-01' },
    ] }));
    const sc = s.data.scenarios.find((x) => x.name === 'Mix');
    const p = runProjection(s.data, sc, { horizonMonths: 12 });
    const cmp = compareProjections(base, p);
    expect(cmp.identical).toBe(false);
    // +500 x 9 paychecks (Jan-Sep) + 2000 windfall - 50 x 11 gym - rent removal from June (4 months x 1500)
    expect(cmp.totals.incomeCents.diff).toBe(50000 * 9 + 200000);
    expect(cmp.totals.expensesCents.diff).toBe(5000 * 11 - 150000 * 4);
    expect(p.events.filter((e) => e.changeId === sc.changes[2].id)).toHaveLength(11);
  });
  it('flags projected overdrafts instead of hiding them', () => {
    const d = getPreset('debt-acceleration').build();
    const s = must(saveScenario(d, { name: 'Big purchase', horizonMonths: 6, changes: [{ type: 'one_time', date: '2026-11-05', title: 'Car repair', amountCents: -usd('20000.00'), accountId: 'chk' }] }));
    const p = runProjection(s.data, s.data.scenarios.find((x) => x.name === 'Big purchase'), { horizonMonths: 6 });
    expect(p.warnings.some((w) => w.type === 'negative_cash')).toBe(true);
    expect(p.monthly[1].balances.get('chk')).toBeLessThan(0);
  });
  it('investment growth is an explicit assumption: off by default, applied monthly when set', () => {
    const d = buildDemoDataset();
    const flat = runProjection(d, null);
    const grow = must(saveScenario(d, { name: 'Grow', horizonMonths: 12, assumptions: { investmentGrowthBps: 600 }, changes: [] }));
    const p = runProjection(grow.data, grow.data.scenarios.find((s) => s.name === 'Grow'));
    expect(p.totals.growthCents).toBeGreaterThan(0);
    expect(flat.totals.growthCents).toBe(0);
    expect(p.notes.join(' ')).toMatch(/not a prediction or guarantee/);
  });
  it('save, delete and duplicate keep the baseline intact', () => {
    const d = buildDemoDataset();
    const base = runProjection(d, null).totals;
    const dup = must(duplicateScenario(d, 'scn-auto-extra'));
    expect(dup.data.scenarios).toHaveLength(d.scenarios.length + 1);
    const del = must(deleteScenario(dup.data, dup.id));
    expect(runProjection(del.data, null).totals).toEqual(base);
    expect(del.data.transactions).toBe(d.transactions);
  });
  it('validates scenario changes', () => {
    const d = buildDemoDataset();
    const refs = { accounts: new Map(d.accounts.map((a) => [a.id, a])), recurring: new Map(d.recurring.map((r) => [r.id, r])) };
    expect(validateChange({ id: 'x', type: 'one_time', date: '2026-02-30', title: 'x', amountCents: 5, accountId: 'acct-chk-main' }, refs).join(' ')).toMatch(/valid calendar date/);
    expect(validateChange({ id: 'x', type: 'debt_payment', effectiveDate: '2026-11-01', mode: 'set', amountCents: -5, accountId: 'acct-loan-auto' }, refs).length).toBeGreaterThan(0);
    expect(validateChange({ id: 'x', type: 'bogus' }, refs)[0]).toMatch(/not supported/);
    expect(validateChange({ id: 'x', type: 'savings_change', effectiveDate: '2026-11-01', amountCents: 100, fromAccountId: 'acct-chk-main', toAccountId: 'acct-chk-main' }, refs).join(' ')).toMatch(/different accounts/);
    const bad = saveScenario(d, { name: 'Bad', changes: [{ type: 'one_time', date: '2026-13-01', title: 'x', amountCents: 5, accountId: 'acct-chk-main' }] });
    expect(bad.ok).toBe(false);
  });
  it('estimates everyday spending from non-recurring, non-interest history', () => {
    const d = buildDemoDataset();
    const v = trailingVariableSpend(d, d.settings.asOfDate);
    expect(v).toBeGreaterThan(50000);
    expect(v).toBeLessThan(400000);
    expect(trailingVariableSpend({ ...d, transactions: [] }, d.settings.asOfDate)).toBe(0);
  });
  it('baseline of a validated dataset produces no NaN/undefined anywhere', () => {
    const p = runProjection(buildDemoDataset(), null);
    expect(JSON.stringify(p.totals)).not.toMatch(/null|NaN|undefined/);
    for (const m of p.monthly) for (const k of ['netWorthCents', 'liquidCents', 'debtCents', 'incomeCents', 'expensesCents']) expect(Number.isInteger(m[k])).toBe(true);
    expect(validateStructure(buildDemoDataset()).filter((f) => f.blocking)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// R6 / R7 / R8 regression coverage (forecast windows, dated openings, shared debt-payment policy)
// ---------------------------------------------------------------------------------------------
import { DatasetBuilder } from '../../src/seed/builder.js';
import { debtPeriod } from '../../src/domain/debt.js';

const QUIET = { investmentGrowthBps: null, variableSpending: 'none', variableSpendingCents: null, includeSavingsInterest: false };
const scn = (changes = [], over = {}) => ({ id: 'scn-test', name: 'test', description: '', horizonMonths: 12, asOfDate: null, assumptions: { ...QUIET }, changes, ...over });
const ledger = (build) => {
  const b = new DatasetBuilder({ name: 'forecast', asOfDate: '2026-10-01' });
  b.account('chk', { name: 'Checking', type: 'checking', opening: usd('5000.00'), openingDate: '2026-01-01' });
  b.account('sav', { name: 'Savings', type: 'savings', opening: 0, openingDate: '2026-01-01' });
  if (build) build(b);
  return b.build();
};
const saving = (over = {}) => ({ id: 'save-10', type: 'savings_change', effectiveDate: '2024-01-15', amountCents: 1000, fromAccountId: 'chk', toAccountId: 'sav', ...over });
const moves = (p) => p.events.filter((e) => e.type === 'scenario' && e.kind === 'transfer');

describe('R6: a savings change whose effective date is long past still contributes every month of the window', () => {
  it('Jan-15-2024 start, $10/month, 12-month window from 2026-10-01: twelve transfers, savings +$120, net worth unchanged', () => {
    const d = ledger();
    const p = runProjection(d, scn([saving()]));
    expect(moves(p).map((e) => e.date)).toEqual(['2026-10-15', '2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15', '2027-05-15', '2027-06-15', '2027-07-15', '2027-08-15', '2027-09-15']);
    expect(p.monthly.map((m) => m.balances.get('sav'))).toEqual([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000]);
    expect(p.monthly.map((m) => m.balances.get('chk'))).toEqual([499000, 498000, 497000, 496000, 495000, 494000, 493000, 492000, 491000, 490000, 489000, 488000]);
    expect(p.monthly.every((m) => m.nwChangeCents === 0)).toBe(true);
    expect(p.totals.endNetWorthCents).toBe(p.totals.startNetWorthCents);
  });
  it('matches the review scenario exactly (zero start, $0 net worth change, +$120/-$120)', () => {
    const b = new DatasetBuilder({ name: 'rv', asOfDate: '2026-10-01' });
    b.account('checking', { name: 'Checking', type: 'checking', opening: 0, openingDate: '2024-01-01' });
    b.account('savings', { name: 'Savings', type: 'savings', opening: 0, openingDate: '2024-01-01' });
    const p = runProjection(b.build(), scn([saving({ fromAccountId: 'checking', toAccountId: 'savings' })]));
    expect(moves(p)).toHaveLength(12);
    expect(p.monthly.at(-1).balances.get('savings')).toBe(12000);
    expect(p.monthly.at(-1).balances.get('checking')).toBe(-12000);
    expect(p.totals.endNetWorthCents - p.totals.startNetWorthCents).toBe(0);
  });
  it('enumerates exactly the occurrences inside the window for any effective date (earlier, inside, on the boundary, after)', () => {
    const d = ledger();
    const dates = (effectiveDate, extra = {}) => moves(runProjection(d, scn([saving({ effectiveDate, ...extra })]))).map((e) => e.date);
    expect(dates('2026-07-31')).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30', '2027-07-31', '2027-08-31', '2027-09-30']); // month-end anchored
    expect(dates('2025-12-31')).toEqual(dates('2026-07-31')); // year boundary, same anchor
    expect(dates('2027-01-20')).toEqual(['2027-01-20', '2027-02-20', '2027-03-20', '2027-04-20', '2027-05-20', '2027-06-20', '2027-07-20', '2027-08-20', '2027-09-20']);
    expect(dates('2026-10-01')[0]).toBe('2026-11-01'); // as-of itself is already history: its occurrence is excluded, like every other engine event
    expect(dates('2026-10-02')[0]).toBe('2026-10-02');
    expect(dates('2027-09-30')).toEqual(['2027-09-30']);
    expect(dates('2027-10-01')).toEqual([]); // starts after the window
    expect(dates('1999-03-05')).toHaveLength(12); // decades earlier: no arbitrary iteration cap
    expect(dates('2024-01-15', { day: 5 })[0]).toBe('2026-10-05');
    expect(dates('2000-01-31')[4]).toBe('2027-02-28');
  });
  it('a leap-year February keeps the 31st anchor (29th)', () => {
    const d = ledger();
    const p = runProjection(d, scn([saving({ effectiveDate: '2023-01-31' })], { asOfDate: '2027-10-01' }), { asOfDate: '2027-10-01', horizonMonths: 6 });
    expect(moves(p).map((e) => e.date)).toEqual(['2027-10-31', '2027-11-30', '2027-12-31', '2028-01-31', '2028-02-29', '2028-03-31']);
  });
  it('baseline vs identical duplicate scenario still compares with zero difference and never touches the ledger', () => {
    const d = ledger();
    const before = JSON.stringify(d.transactions);
    const a = scn([saving()], { id: 'a' });
    const b = { ...scn([saving()], { id: 'b' }) };
    const cmp = compareProjections(runProjection(d, a), runProjection(d, b));
    expect(cmp.totals.netWorthDiffCents ?? 0).toBe(0);
    expect(cmp.accounts?.length ?? 0).toBe(0);
    expect(JSON.stringify(d.transactions)).toBe(before);
  });
});

describe('R7: accounts that open inside the forecast window contribute their opening exactly once, on the right date', () => {
  const withSavings = (openingDate, openingCents = 50000) => ledger((b) => {
    b.d.accounts.find((a) => a.id === 'sav').openingDate = openingDate;
    b.d.accounts.find((a) => a.id === 'sav').openingCents = openingCents;
  });
  it('opening 2026-11-01 / $500: $0 through October, $500 from November, never again', () => {
    const p = runProjection(withSavings('2026-11-01'), scn());
    expect(p.start.balances.get('sav')).toBe(0);
    expect(p.monthly.map((m) => m.balances.get('sav'))).toEqual(Array(12).fill(0).map((_, i) => (i === 0 ? 0 : 50000)));
    expect(p.monthly.map((m) => m.nwChangeCents)).toEqual([0, 50000, ...Array(10).fill(0)]);
    const ev = p.events.filter((e) => e.kind === 'opening');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ date: '2026-11-01', legs: [{ accountId: 'sav', cents: 50000 }] });
  });
  it('is not classified as income or spending, and does not distort headline totals', () => {
    const p = runProjection(withSavings('2026-11-01'), scn());
    expect(p.totals.incomeCents).toBe(0);
    expect(p.totals.expensesCents).toBe(0);
    expect(p.totals.netCashFlowCents).toBe(0);
    expect(p.monthly[1].openingCents).toBe(50000);
    expect(p.totals.openingCents).toBe(50000);
    expect(p.totals.endNetWorthCents - p.totals.startNetWorthCents).toBe(50000);
  });
  it('before / on / after the as-of date and beyond the horizon', () => {
    const open = (date) => runProjection(withSavings(date), scn());
    expect(open('2026-09-30').events.filter((e) => e.kind === 'opening')).toHaveLength(0);
    expect(open('2026-09-30').start.balances.get('sav')).toBe(50000);
    expect(open('2026-10-01').events.filter((e) => e.kind === 'opening')).toHaveLength(0); // already in the starting balance
    expect(open('2026-10-01').start.balances.get('sav')).toBe(50000);
    expect(open('2026-10-02').events.filter((e) => e.kind === 'opening')).toHaveLength(1); // first day after the as-of date
    expect(open('2026-10-02').start.balances.get('sav')).toBe(0);
    expect(open('2027-09-30').events.filter((e) => e.kind === 'opening')).toHaveLength(1); // last day of the window
    expect(open('2027-10-01').events.filter((e) => e.kind === 'opening')).toHaveLength(0); // after the window
    expect(open('2027-10-01').monthly.at(-1).balances.get('sav')).toBe(0);
    // whichever way it enters (starting balance or event), the account ends the window with its opening exactly once
    for (const date of ['2026-09-30', '2026-10-01', '2026-10-02', '2027-09-30']) expect(open(date).monthly.at(-1).balances.get('sav')).toBe(50000);
  });
  it('a liability opening later (negative contribution) lowers net worth once and accrues interest only afterwards', () => {
    const d = ledger((b) => b.account('card', { name: 'Card', type: 'credit_card', opening: -usd('300.00'), openingDate: '2026-12-01', aprBps: 2400, payment: usd('50.00'), dueDay: 20, autopay: 'chk' }));
    const p = runProjection(d, scn());
    expect(p.start.balances.get('card')).toBe(0);
    const card = p.monthly.map((m) => m.balances.get('card'));
    expect(card.slice(0, 2)).toEqual([0, 0]); // October, November: nothing owed, no interest accrued
    expect(p.events.filter((e) => e.kind === 'opening')).toHaveLength(1);
    const interest = p.events.filter((e) => e.kind === 'interest_paid');
    expect(interest[0].date).toBe('2026-12-20'); // first accrual after it exists
    expect(interest[0].legs[0].cents).toBe(-600); // 300.00 * 24% / 12
    expect(p.monthly[2].nwChangeCents).toBe(-30000 - 600);
  });
  it('same-day opening and ledger entry: opening is replayed first, deterministically', () => {
    const d = ledger((b) => {
      b.d.accounts.find((a) => a.id === 'sav').openingDate = '2026-11-01';
      b.d.accounts.find((a) => a.id === 'sav').openingCents = 50000;
      b.tx({ id: 'dep', account: 'sav', date: '2026-11-01', desc: 'Deposit', amount: 10000, kind: 'income' });
    });
    const p = runProjection(d, scn());
    const order = p.events.filter((e) => e.date === '2026-11-01').map((e) => e.kind);
    expect(order.indexOf('opening')).toBeLessThan(order.indexOf('income'));
    expect(p.monthly[1].balances.get('sav')).toBe(60000);
    expect(JSON.stringify(runProjection(d, scn()))).toBe(JSON.stringify(p));
  });
  it('recurring, interest and payment events dated before an account exists are not applied to a balance that is not there', () => {
    const d = ledger((b) => {
      b.d.accounts.find((a) => a.id === 'sav').openingDate = '2027-01-01';
      b.d.accounts.find((a) => a.id === 'sav').openingCents = 100000;
      b.d.accounts.find((a) => a.id === 'sav').aprBps = 1200;
      b.recurring({ id: 'fee', title: 'Account fee', kind: 'expense', amount: usd('10.00'), account: 'sav', start: '2026-10-20', interval: 'monthly' });
    });
    const p = runProjection(d, scn([], { assumptions: { ...QUIET, includeSavingsInterest: true } }), {});
    expect(p.monthly.slice(0, 3).map((m) => m.balances.get('sav'))).toEqual([0, 0, 0]);
    expect(p.warnings.filter((w) => w.type === 'negative_cash')).toEqual([]);
    expect(p.events.filter((e) => e.label === 'Account fee').map((e) => e.date)[0]).toBe('2027-01-20');
    expect(p.notes.join(' ')).toMatch(/before .*opens|not yet open/i);
    // interest: only from January month-end, on a positive balance
    const interest = p.events.filter((e) => e.kind === 'interest_earned').map((e) => e.date);
    expect(interest[0]).toBe('2027-01-31');
  });
});

describe('R8: the debt overview and the forecast use one payment policy', () => {
  const card = (over = {}) => ledger((b) => {
    b.d.accounts.find((a) => a.id === 'chk').openingCents = usd('50000.00');
    b.account('card', { name: 'Card', type: 'credit_card', opening: -usd('1000.00'), openingDate: '2026-01-01', aprBps: 2400, paymentMode: 'minimum', minPaymentBps: 200, minPaymentFloor: usd('25.00'), dueDay: 15, autopay: 'chk', ...over });
  });
  /** Independent re-implementation of the policy in plain integer arithmetic (half-up on positive values). */
  function expected({ owed, aprBps, mode = 'minimum', bps = 200, floor = 2500, fixed = 0, extra = 0, set = null, periods = 400 }) {
    const half = (num, den) => Math.floor((2 * num + den) / (2 * den));
    const rows = [];
    let bal = owed;
    while (bal > 0 && rows.length < periods) {
      const interest = half(bal * aprBps, 120000);
      const cap = bal + interest;
      let base;
      if (mode === 'pay_in_full') base = cap;
      else if (mode === 'minimum') base = Math.min(cap, Math.max(floor, interest + half(bal * bps, 10000)));
      else base = Math.min(fixed, cap);
      if (set !== null) base = Math.min(set, cap);
      const payment = Math.min(base + extra, cap);
      rows.push({ interest, payment, end: cap - payment });
      bal = cap - payment;
    }
    return rows;
  }
  const fromForecast = (p, accountId = 'card') => {
    const interest = p.events.filter((e) => e.kind === 'interest_paid' && e.legs[0].accountId === accountId).map((e) => -e.legs[0].cents);
    const pay = p.events.filter((e) => e.kind === 'debt_payment' && e.legs[1].accountId === accountId).map((e) => e.legs[1].cents);
    return { interest, pay };
  };

  it('the review table: $40.00 then $39.20 under the minimum policy, in the overview AND the forecast', () => {
    const d = card();
    const row = debtOverview(d, '2026-10-01').find((r) => r.account.id === 'card');
    expect(row.schedule.rows.slice(0, 3).map((r) => r.paymentCents)).toEqual([4000, 3920, 3842]);
    expect(row.schedule.rows[0]).toMatchObject({ interestCents: 2000, principalCents: 2000, endCents: 98000, date: '2026-10-15' });
    expect(row.schedule.assumption).toBe('account_policy');
    const p = runProjection(d, scn(), { horizonMonths: 12 });
    expect(fromForecast(p).pay.slice(0, 3)).toEqual([4000, 3920, 3842]);
    expect(row.regularPaymentCents).toBe(4000);
  });
  it('every period of the whole payoff agrees: interest, payment and ending debt; plus payoff date, status and total interest', () => {
    const d = card();
    const row = debtOverview(d, '2026-10-01').find((r) => r.account.id === 'card');
    const exp = expected({ owed: 100000, aprBps: 2400 });
    const p = runProjection(d, scn(), { horizonMonths: 120 });
    const f = fromForecast(p);
    expect(row.schedule.status).toBe('paid_off');
    expect(row.schedule.rows).toHaveLength(exp.length);
    expect(row.schedule.rows.map((r) => [r.interestCents, r.paymentCents, r.endCents])).toEqual(exp.map((r) => [r.interest, r.payment, r.end]));
    expect(f.interest).toEqual(exp.map((r) => r.interest));
    expect(f.pay).toEqual(exp.map((r) => r.payment));
    expect(p.monthly.slice(0, exp.length).map((m) => 0 - m.balances.get('card'))).toEqual(exp.map((r) => r.end));
    const debt = p.debts.find((x) => x.accountId === 'card');
    expect(debt.status).toBe('paid_off');
    expect(debt.payoffDate).toBe(row.schedule.payoffDate);
    expect(debt.payoffMonthIndex).toBe(row.schedule.periods);
    expect(debt.interestCents).toBe(row.schedule.totalInterestCents);
    expect(debt.paidCents).toBe(row.schedule.totalPaidCents);
    expect(row.schedule.rows.at(-1).paymentCents).toBeLessThanOrEqual(row.schedule.rows.at(-1).startCents + row.schedule.rows.at(-1).interestCents); // final payment is capped
    expect(row.schedule.rows.at(-1).endCents).toBe(0);
  });
  it('the floor binds once interest + 2% falls below $25.00', () => {
    const row = debtOverview(card(), '2026-10-01').find((r) => r.account.id === 'card');
    const floorPeriods = row.schedule.rows.filter((r, i) => i < row.schedule.rows.length - 1 && r.paymentCents === 2500);
    expect(floorPeriods.length).toBeGreaterThan(10);
    expect(row.schedule.rows.every((r) => r.paymentCents >= Math.min(2500, r.startCents + r.interestCents))).toBe(true);
  });
  it('a held-constant first payment is a separate, labelled what-if and gives a different (sooner) payoff', () => {
    const row = debtOverview(card(), '2026-10-01').find((r) => r.account.id === 'card');
    expect(row.fixedSchedule.assumption).toBe('fixed_payment');
    expect(row.fixedSchedule.rows[1].paymentCents).toBe(4000);
    expect(row.fixedSchedule.rows[0].paymentCents).toBe(row.schedule.rows[0].paymentCents);
    expect(row.fixedSchedule.periods).toBeLessThan(row.schedule.periods);
    expect(row.fixedSchedule.totalInterestCents).toBeLessThan(row.schedule.totalInterestCents);
  });
  it.each([
    ['fixed', { paymentMode: 'fixed', payment: 5000 }, { mode: 'fixed', fixed: 5000 }],
    ['pay in full', { paymentMode: 'pay_in_full' }, { mode: 'pay_in_full' }],
    ['zero APR minimum', { aprBps: 0 }, { aprBps: 0 }],
    ['zero APR fixed', { aprBps: 0, paymentMode: 'fixed', payment: 3000 }, { aprBps: 0, mode: 'fixed', fixed: 3000 }],
    ['final payment capping (fixed 97.00 on 1000.00 at 12%)', { aprBps: 1200, paymentMode: 'fixed', payment: 9700 }, { aprBps: 1200, mode: 'fixed', fixed: 9700 }],
  ])('%s: overview and forecast agree period by period', (_label, acct, exp) => {
    const d = card(acct);
    const row = debtOverview(d, '2026-10-01').find((r) => r.account.id === 'card');
    const e = expected({ owed: 100000, aprBps: acct.aprBps ?? 2400, ...exp });
    const p = runProjection(d, scn(), { horizonMonths: 120 });
    const f = fromForecast(p);
    expect(row.schedule.rows.map((r) => [r.interestCents, r.paymentCents, r.endCents])).toEqual(e.map((r) => [r.interest, r.payment, r.end]));
    expect(f.pay).toEqual(e.map((r) => r.payment));
    expect(f.interest).toEqual(e.map((r) => r.interest).filter((x) => x > 0));
    expect(p.debts.find((x) => x.accountId === 'card').status).toBe(row.schedule.status);
    expect(p.debts.find((x) => x.accountId === 'card').interestCents).toBe(row.schedule.totalInterestCents);
  });
  it('an insufficient payment is reported identically: below interest, never paid off', () => {
    const d = card({ paymentMode: 'fixed', payment: 1000 });
    const row = debtOverview(d, '2026-10-01').find((r) => r.account.id === 'card');
    const p = runProjection(d, scn(), { horizonMonths: 24 });
    expect(row.schedule.status).toBe('payment_below_interest');
    expect(p.debts.find((x) => x.accountId === 'card').status).toBe('payment_below_interest');
    expect(row.schedule.payoffDate).toBeNull();
    expect(p.debts.find((x) => x.accountId === 'card').payoffDate).toBeNull();
    expect(fromForecast(p).pay.slice(0, 3)).toEqual(row.schedule.rows.slice(0, 3).map((r) => r.paymentCents));
  });
  it('extra principal and a replaced regular payment follow the same policy in both views', () => {
    const d = card();
    const extra = amortizationSchedule({ balanceCents: 100000, aprBps: 2400, account: d.accounts.find((a) => a.id === 'card'), extraCents: 5000, firstPaymentDate: '2026-10-15' });
    const pe = runProjection(d, scn([{ id: 'x', type: 'debt_payment', effectiveDate: '2026-01-01', endDate: null, mode: 'extra', amountCents: 5000, accountId: 'card' }]), { horizonMonths: 60 });
    expect(fromForecast(pe).pay).toEqual(extra.rows.map((r) => r.paymentCents));
    expect(pe.debts.find((x) => x.accountId === 'card').interestCents).toBe(extra.totalInterestCents);
    const set = amortizationSchedule({ balanceCents: 100000, aprBps: 2400, account: d.accounts.find((a) => a.id === 'card'), setPaymentCents: 6000, firstPaymentDate: '2026-10-15' });
    const ps = runProjection(d, scn([{ id: 'y', type: 'debt_payment', effectiveDate: '2026-01-01', endDate: null, mode: 'set', amountCents: 6000, accountId: 'card' }]), { horizonMonths: 60 });
    expect(fromForecast(ps).pay).toEqual(set.rows.map((r) => r.paymentCents));
    expect(set.rows[0].paymentCents).toBe(6000);
  });
  it('debtPeriod is the single per-period rule', () => {
    const a = { aprBps: 2400, paymentMode: 'minimum', minPaymentBps: 200, minPaymentFloorCents: 2500, scheduledPaymentCents: null };
    expect(debtPeriod(a, 100000)).toMatchObject({ interestCents: 2000, paymentCents: 4000, principalCents: 2000, endOwedCents: 98000 });
    expect(debtPeriod(a, 1000)).toMatchObject({ interestCents: 20, paymentCents: 1020, endOwedCents: 0 }); // capped at what is owed
    expect(debtPeriod(a, 0)).toMatchObject({ interestCents: 0, paymentCents: 0, endOwedCents: 0 });
    expect(debtPeriod(a, 100000, { setPaymentCents: 500 }).paymentCents).toBe(500);
    expect(debtPeriod(a, 100000, { extraCents: 1000 }).paymentCents).toBe(5000);
  });
  it('the fixed-payment regression stays exact: $1,000 at 12% with $100 payments is 11 payments, $58.98 interest, $58.98 final payment', () => {
    const s = amortizationSchedule({ balanceCents: 100000, aprBps: 1200, paymentCents: 10000, firstPaymentDate: '2026-11-01' });
    expect(s.periods).toBe(11);
    expect(s.totalInterestCents).toBe(5898);
    expect(s.rows.at(-1).paymentCents).toBe(5898);
    expect(s.assumption).toBe('fixed_payment');
  });
});
