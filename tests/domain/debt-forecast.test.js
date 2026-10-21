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

// ------------------------------------------------------------------------------------------------
// R6 / R7 / R8 (review): forecast windows, dated account openings, one debt-payment rule
// ------------------------------------------------------------------------------------------------
import { DatasetBuilder } from '../../src/seed/builder.js';
import { debtPeriod } from '../../src/domain/debt.js';
import { upcomingObligations } from '../../src/domain/obligations.js';

const QUIET = { investmentGrowthBps: null, variableSpending: 'none', variableSpendingCents: null, includeSavingsInterest: false };
const plan = (changes = [], over = {}) => ({ id: 'scn-t', name: 't', description: '', horizonMonths: 12, asOfDate: null, assumptions: { ...QUIET }, changes, ...over });
function world(edit) {
  const b = new DatasetBuilder({ name: 'forecast', asOfDate: '2026-10-01' });
  b.account('chk', { name: 'Checking', type: 'checking', opening: usd('5000.00'), openingDate: '2026-01-01' });
  b.account('sav', { name: 'Savings', type: 'savings', opening: 0, openingDate: '2026-01-01' });
  if (edit) edit(b);
  return b.build();
}
const setAcct = (b, id, patch) => Object.assign(b.d.accounts.find((a) => a.id === id), patch);
const saving = (over = {}) => ({ id: 'save-10', type: 'savings_change', effectiveDate: '2024-01-15', amountCents: 1000, fromAccountId: 'chk', toAccountId: 'sav', ...over });
const moveDates = (p) => p.events.filter((e) => e.type === 'scenario' && e.kind === 'transfer').map((e) => e.date);

describe('R6: a savings change whose effective date is long past contributes every month of the window', () => {
  it('the review scenario: 12 transfers, savings +$120.00, checking -$120.00, net worth change $0.00, month by month', () => {
    const p = runProjection(world(), plan([saving()]));
    expect(moveDates(p)).toEqual(['2026-10-15', '2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15', '2027-05-15', '2027-06-15', '2027-07-15', '2027-08-15', '2027-09-15']);
    expect(p.monthly.map((m) => m.balances.get('sav'))).toEqual([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000]);
    expect(p.monthly.map((m) => m.balances.get('chk'))).toEqual([499000, 498000, 497000, 496000, 495000, 494000, 493000, 492000, 491000, 490000, 489000, 488000]);
    expect(p.monthly.every((m) => m.nwChangeCents === 0)).toBe(true);
    expect(p.totals.endNetWorthCents - p.totals.startNetWorthCents).toBe(0);
  });
  it('enumerates exactly the window for any effective date: decades or months earlier, on/after the as-of date, after the window', () => {
    const d = world();
    const at = (effectiveDate, extra = {}) => moveDates(runProjection(d, plan([saving({ effectiveDate, ...extra })])));
    const monthEnds = ['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30', '2027-07-31', '2027-08-31', '2027-09-30'];
    expect(at('2026-07-31')).toEqual(monthEnds); // a few months earlier, month-end anchor (the old cap also lost the last month here)
    expect(at('2025-12-31')).toEqual(monthEnds); // across a year boundary
    expect(at('1999-03-31')).toEqual(monthEnds); // decades earlier: no iteration cap
    expect(at('2027-01-20')).toHaveLength(9);
    expect(at('2027-01-20')[0]).toBe('2027-01-20');
    expect(at('2026-10-01')[0]).toBe('2026-11-01'); // the as-of date itself is history, as for every engine event
    expect(at('2026-10-02')[0]).toBe('2026-10-02');
    expect(at('2027-09-30')).toEqual(['2027-09-30']);
    expect(at('2027-10-01')).toEqual([]); // after the window
    expect(at('2024-01-15', { day: 5 })[0]).toBe('2026-10-05');
  });
  it('keeps the 31st anchor through a leap-year February', () => {
    const p = runProjection(world(), plan([saving({ effectiveDate: '2023-01-31' })]), { asOfDate: '2027-10-01', horizonMonths: 6 });
    expect(moveDates(p)).toEqual(['2027-10-31', '2027-11-30', '2027-12-31', '2028-01-31', '2028-02-29', '2028-03-31']);
  });
  it('an exact duplicate still compares with zero differences and the ledger is untouched', () => {
    const d = world();
    const before = JSON.stringify(d);
    const cmp = compareProjections(runProjection(d, plan([saving()], { id: 'a' })), runProjection(d, plan([saving()], { id: 'b' })));
    expect(cmp.identical).toBe(true);
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe('R7: an account that opens inside the window enters once, on its opening date', () => {
  const opening = (openingDate, openingCents = 50000) => world((b) => setAcct(b, 'sav', { openingDate, openingCents }));
  const openings = (p) => p.events.filter((e) => e.kind === 'opening');
  it('the review scenario: $0.00 before 2026-11-01, $500.00 from then on, exactly once, not income', () => {
    const p = runProjection(opening('2026-11-01'), plan());
    expect(p.start.balances.get('sav')).toBe(0);
    expect(p.monthly.map((m) => m.balances.get('sav'))).toEqual([0, ...Array(11).fill(50000)]);
    expect(p.monthly.map((m) => m.nwChangeCents)).toEqual([0, 50000, ...Array(10).fill(0)]);
    expect(openings(p)).toEqual([expect.objectContaining({ date: '2026-11-01', legs: [{ accountId: 'sav', cents: 50000 }] })]);
    expect([p.totals.incomeCents, p.totals.expensesCents, p.totals.netCashFlowCents, p.totals.openingCents]).toEqual([0, 0, 0, 50000]);
    expect(p.monthly[1].openingCents).toBe(50000);
  });
  it('before, on and after the as-of date, at the window edge and beyond it: never counted twice, never lost', () => {
    const at = (date) => runProjection(opening(date), plan());
    for (const [date, inStart, events, end] of [['2026-09-30', 50000, 0, 50000], ['2026-10-01', 50000, 0, 50000], ['2026-10-02', 0, 1, 50000], ['2027-09-30', 0, 1, 50000], ['2027-10-01', 0, 0, 0]]) {
      const p = at(date);
      expect([p.start.balances.get('sav'), openings(p).length, p.monthly.at(-1).balances.get('sav')], date).toEqual([inStart, events, end]);
    }
  });
  it('a liability that opens later lowers net worth once, and accrues interest only after it exists', () => {
    const d = world((b) => b.account('card', { name: 'Card', type: 'credit_card', opening: -usd('300.00'), openingDate: '2026-12-01', aprBps: 2400, payment: usd('50.00'), dueDay: 20, autopay: 'chk' }));
    const p = runProjection(d, plan());
    expect(p.monthly.slice(0, 2).map((m) => m.balances.get('card'))).toEqual([0, 0]);
    const interest = p.events.filter((e) => e.kind === 'interest_paid');
    expect(interest[0]).toMatchObject({ date: '2026-12-20', legs: [{ accountId: 'card', cents: -600 }] });
    expect(p.monthly[2].nwChangeCents).toBe(-30000 - 600); // opening, then December interest; the payment is a transfer
  });
  it('same-day opening and ledger entry replay in a fixed order (opening first) and identical runs are identical', () => {
    const d = world((b) => {
      setAcct(b, 'sav', { openingDate: '2026-11-01', openingCents: 50000 });
      b.tx({ id: 'dep', account: 'sav', date: '2026-11-01', desc: 'Deposit', amount: 10000, kind: 'income' });
    });
    const p = runProjection(d, plan());
    expect(p.events.filter((e) => e.date === '2026-11-01').map((e) => e.kind)).toEqual(['opening', 'income']);
    expect(p.monthly[1].balances.get('sav')).toBe(60000);
    expect(JSON.stringify(runProjection(d, plan()))).toBe(JSON.stringify(p));
  });
  it('recurring items, interest and payments cannot act on an account before it exists', () => {
    const d = world((b) => {
      setAcct(b, 'sav', { openingDate: '2027-01-01', openingCents: 100000, aprBps: 1200 });
      b.recurring({ id: 'fee', title: 'Account fee', kind: 'expense', amount: usd('10.00'), account: 'sav', start: '2026-10-20', interval: 'monthly' });
    });
    const p = runProjection(d, plan([], { assumptions: { ...QUIET, includeSavingsInterest: true } }));
    expect(p.monthly.slice(0, 3).map((m) => m.balances.get('sav'))).toEqual([0, 0, 0]);
    expect(p.events.find((e) => e.label === 'Account fee').date).toBe('2027-01-20');
    expect(p.events.find((e) => e.kind === 'interest_earned').date).toBe('2027-01-31');
    expect(p.warnings).toEqual([]);
    expect(p.notes.join(' ')).toMatch(/3 scheduled events dated before Savings opens \(2027-01-01\) were not applied/);
  });
});

describe('R8: the Debt page, the upcoming-payments list and the forecast use one payment rule', () => {
  const cardWorld = (over = {}) => world((b) => {
    setAcct(b, 'chk', { openingCents: usd('50000.00') });
    b.account('card', { name: 'Card', type: 'credit_card', opening: -usd('1000.00'), openingDate: '2026-01-01', aprBps: 2400, paymentMode: 'minimum', minPaymentBps: 200, minPaymentFloor: usd('25.00'), dueDay: 15, autopay: 'chk', ...over });
  });
  /** Independent statement of the policy in integer arithmetic (half up, positive values). */
  function expected({ owed = 100000, aprBps = 2400, mode = 'minimum', bps = 200, floor = 2500, fixed = 0, extra = 0, set = null }) {
    const half = (n, d) => Math.floor((2 * n + d) / (2 * d));
    const rows = [];
    for (let bal = owed; bal > 0 && rows.length < 600;) {
      const interest = half(bal * aprBps, 120000);
      const due = bal + interest;
      let base = mode === 'pay_in_full' ? due : mode === 'minimum' ? Math.min(due, Math.max(floor, interest + half(bal * bps, 10000))) : Math.min(fixed, due);
      if (set !== null) base = Math.min(set, due);
      const payment = Math.min(base + extra, due);
      rows.push([interest, payment, due - payment]);
      bal = due - payment;
    }
    return rows;
  }
  const forecastRows = (p) => {
    const interest = p.events.filter((e) => e.kind === 'interest_paid' && e.legs[0].accountId === 'card').map((e) => -e.legs[0].cents);
    const pay = p.events.filter((e) => e.kind === 'debt_payment' && e.legs[1].accountId === 'card').map((e) => e.legs[1].cents);
    return { interest, pay };
  };
  it('the review table: $40.00 then $39.20 in the overview, the upcoming list and the forecast', () => {
    const d = cardWorld();
    const row = debtOverview(d, '2026-10-01').find((r) => r.account.id === 'card');
    expect(row.schedule.assumption).toBe('account_policy');
    expect(row.schedule.rows.slice(0, 3).map((r) => r.paymentCents)).toEqual([4000, 3920, 3842]);
    expect(row.schedule.rows[0]).toMatchObject({ date: '2026-10-15', interestCents: 2000, principalCents: 2000, endCents: 98000 });
    expect(upcomingObligations(d, '2026-10-01', 90).filter((o) => o.kind === 'debt').map((o) => -o.effectCents)).toEqual([4000, 3920, 3842]);
    expect(forecastRows(runProjection(d, plan())).pay.slice(0, 3)).toEqual([4000, 3920, 3842]);
  });
  it('every period of the whole payoff agrees with an independent calculation, in both views; so do payoff date, status and totals', () => {
    const d = cardWorld();
    const row = debtOverview(d, '2026-10-01').find((r) => r.account.id === 'card');
    const exp = expected({});
    const p = runProjection(d, plan(), { horizonMonths: 120 });
    expect(row.schedule.rows.map((r) => [r.interestCents, r.paymentCents, r.endCents])).toEqual(exp);
    const f = forecastRows(p);
    expect(f.interest).toEqual(exp.map((r) => r[0]));
    expect(f.pay).toEqual(exp.map((r) => r[1]));
    expect(p.monthly.slice(0, exp.length).map((m) => 0 - m.balances.get('card'))).toEqual(exp.map((r) => r[2]));
    const debt = p.debts.find((x) => x.accountId === 'card');
    expect([debt.status, debt.payoffDate, debt.payoffMonthIndex, debt.interestCents, debt.paidCents]).toEqual(['paid_off', row.schedule.payoffDate, row.schedule.periods, row.schedule.totalInterestCents, row.schedule.totalPaidCents]);
    expect(row.schedule.rows.filter((r, i) => i < exp.length - 1 && r.paymentCents === 2500).length).toBeGreaterThan(10); // the floor binds
    const last = row.schedule.rows.at(-1);
    expect([last.paymentCents, last.endCents]).toEqual([last.startCents + last.interestCents, 0]); // final payment capped
  });
  it('the fixed "keep paying this month\'s amount" schedule is a separate, labelled what-if', () => {
    const row = debtOverview(cardWorld(), '2026-10-01').find((r) => r.account.id === 'card');
    expect(row.fixedSchedule.assumption).toBe('fixed_payment');
    expect(row.fixedSchedule.rows.slice(0, 3).map((r) => r.paymentCents)).toEqual([4000, 4000, 4000]);
    expect(row.fixedSchedule.periods).toBeLessThan(row.schedule.periods);
    const fixedAcct = debtOverview(cardWorld({ paymentMode: 'fixed', payment: 5000 }), '2026-10-01').find((r) => r.account.id === 'card');
    expect(fixedAcct.fixedSchedule).toBe(fixedAcct.schedule);
  });
  it.each([
    ['fixed', { paymentMode: 'fixed', payment: 5000 }, { mode: 'fixed', fixed: 5000 }],
    ['pay in full', { paymentMode: 'pay_in_full' }, { mode: 'pay_in_full' }],
    ['zero APR minimum', { aprBps: 0 }, { aprBps: 0 }],
    ['zero APR fixed', { aprBps: 0, paymentMode: 'fixed', payment: 3000 }, { aprBps: 0, mode: 'fixed', fixed: 3000 }],
    ['final-payment capping', { aprBps: 1200, paymentMode: 'fixed', payment: 9700 }, { aprBps: 1200, mode: 'fixed', fixed: 9700 }],
  ])('%s: both views match the independent calculation period by period', (_n, acct, exp) => {
    const d = cardWorld(acct);
    const e = expected(exp);
    const row = debtOverview(d, '2026-10-01').find((r) => r.account.id === 'card');
    const p = runProjection(d, plan(), { horizonMonths: 120 });
    expect(row.schedule.rows.map((r) => [r.interestCents, r.paymentCents, r.endCents])).toEqual(e);
    expect(forecastRows(p).pay).toEqual(e.map((r) => r[1]));
    expect(forecastRows(p).interest).toEqual(e.map((r) => r[0]).filter((x) => x > 0));
    expect([p.debts.find((x) => x.accountId === 'card').status, p.debts.find((x) => x.accountId === 'card').interestCents]).toEqual([row.schedule.status, row.schedule.totalInterestCents]);
  });
  it('an insufficient payment is reported the same way by both: below interest, never paid off', () => {
    const d = cardWorld({ paymentMode: 'fixed', payment: 1000 });
    const row = debtOverview(d, '2026-10-01').find((r) => r.account.id === 'card');
    const debt = runProjection(d, plan(), { horizonMonths: 24 }).debts.find((x) => x.accountId === 'card');
    expect([row.schedule.status, row.schedule.payoffDate, debt.status, debt.payoffDate]).toEqual(['payment_below_interest', null, 'payment_below_interest', null]);
  });
  it('extra principal and a replaced payment follow the same rule in the calculator schedule and the scenario forecast', () => {
    const d = cardWorld();
    const card = d.accounts.find((a) => a.id === 'card');
    for (const [change, sched, exp] of [
      [{ mode: 'extra', amountCents: 5000 }, { extraCents: 5000 }, { extra: 5000 }],
      [{ mode: 'set', amountCents: 6000 }, { setPaymentCents: 6000 }, { set: 6000 }],
    ]) {
      const s = amortizationSchedule({ balanceCents: 100000, aprBps: 2400, account: card, firstPaymentDate: '2026-10-15', ...sched });
      const p = runProjection(d, plan([{ id: 'x', type: 'debt_payment', effectiveDate: '2026-01-01', endDate: null, accountId: 'card', ...change }]), { horizonMonths: 60 });
      expect(s.rows.map((r) => [r.interestCents, r.paymentCents, r.endCents])).toEqual(expected(exp));
      expect(forecastRows(p).pay).toEqual(s.rows.map((r) => r.paymentCents));
      expect(p.debts.find((x) => x.accountId === 'card').interestCents).toBe(s.totalInterestCents);
    }
  });
  it('debtPeriod is the single per-period rule', () => {
    const a = { aprBps: 2400, paymentMode: 'minimum', minPaymentBps: 200, minPaymentFloorCents: 2500, scheduledPaymentCents: null };
    expect(debtPeriod(a, 100000)).toEqual({ interestCents: 2000, paymentCents: 4000, principalCents: 2000, endOwedCents: 98000 });
    expect(debtPeriod(a, 1000)).toEqual({ interestCents: 20, paymentCents: 1020, principalCents: 1000, endOwedCents: 0 });
    expect(debtPeriod(a, 0)).toEqual({ interestCents: 0, paymentCents: 0, principalCents: 0, endOwedCents: 0 });
    expect(debtPeriod(a, 100000, { setPaymentCents: 500 }).paymentCents).toBe(500);
    expect(debtPeriod(a, 100000, { extraCents: 1000 }).paymentCents).toBe(5000);
  });
  it('the fixed-payment regression is unchanged: $1,000 at 12% with $100 payments = 11 payments, $58.98 interest, $58.98 final payment', () => {
    const s = amortizationSchedule({ balanceCents: 100000, aprBps: 1200, paymentCents: 10000, firstPaymentDate: '2026-11-01' });
    expect([s.status, s.periods, s.totalInterestCents, s.rows.at(-1).paymentCents, s.assumption]).toEqual(['paid_off', 11, 5898, 5898, 'fixed_payment']);
  });
});
