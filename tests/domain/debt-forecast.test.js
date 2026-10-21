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
