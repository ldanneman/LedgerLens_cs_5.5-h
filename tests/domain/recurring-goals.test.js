import { describe, it, expect } from 'vitest';
import { occurrencesBetween, upcomingOccurrences, monthlyEquivalent, annualEquivalent, subscriptionSummary, suggestMatches, occurrenceStatus } from '../../src/domain/recurring.js';
import { saveRecurring, markOccurrencePaid, skipOccurrence, linkOccurrence, unlinkOccurrence, deleteRecurring, setRecurringActive } from '../../src/domain/ops/recurring.js';
import { goalProgress, allocateGoals, accountAllocations } from '../../src/domain/goals.js';
import { saveGoal, addGoalContribution } from '../../src/domain/ops/catalog.js';
import { addTransaction } from '../../src/domain/ops/transactions.js';
import { buildDemoDataset } from '../../src/seed/demo.js';
import { caseA } from '../../src/seed/fixtures.js';
import { must, period, bal } from '../helpers.js';
import { usd } from '../../src/seed/builder.js';

const rule = (o = {}) => ({ id: 'r', title: 'Rule', kind: 'expense', amountCents: 10000, accountId: 'chk', startDate: '2026-01-31', interval: 'monthly', endDate: null, businessDay: 'none', skipped: [], ...o });

describe('recurrence schedules', () => {
  it('supports weekly, biweekly, monthly, quarterly and yearly', () => {
    expect(occurrencesBetween(rule({ interval: 'weekly', startDate: '2026-01-05' }), '2026-01-01', '2026-01-31').map((o) => o.scheduled)).toEqual(['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
    expect(occurrencesBetween(rule({ interval: 'biweekly', startDate: '2026-01-05' }), '2026-01-01', '2026-02-28').map((o) => o.scheduled)).toEqual(['2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16']);
    expect(occurrencesBetween(rule({ interval: 'quarterly', startDate: '2026-01-31' }), '2026-01-01', '2026-12-31').map((o) => o.scheduled)).toEqual(['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31']);
    expect(occurrencesBetween(rule({ interval: 'yearly', startDate: '2024-02-29' }), '2024-01-01', '2028-12-31').map((o) => o.scheduled)).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  });
  it('respects end dates and filters to the requested window', () => {
    const r = rule({ startDate: '2026-01-15', endDate: '2026-03-15' });
    expect(occurrencesBetween(r, '2026-01-01', '2026-12-31').map((o) => o.scheduled)).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
    expect(occurrencesBetween(r, '2026-02-01', '2026-02-28').map((o) => o.scheduled)).toEqual(['2026-02-15']);
  });
  it('moves weekend due dates only when a business-day rule is chosen, keeping the scheduled key', () => {
    const r = rule({ startDate: '2026-10-03', businessDay: 'next' });
    const [o] = occurrencesBetween(r, '2026-10-01', '2026-10-31');
    expect(o).toMatchObject({ scheduled: '2026-10-03', date: '2026-10-05' });
    expect(occurrencesBetween(rule({ startDate: '2026-10-03' }), '2026-10-01', '2026-10-31')[0].date).toBe('2026-10-03');
  });
  it('computes monthly and annual equivalents exactly', () => {
    expect(annualEquivalent(rule({ interval: 'weekly', amountCents: 1000 }))).toBe(52000);
    expect(monthlyEquivalent(rule({ interval: 'weekly', amountCents: 1000 }))).toBe(4333);
    expect(monthlyEquivalent(rule({ interval: 'yearly', amountCents: 5900 }))).toBe(492);
    expect(annualEquivalent(rule({ interval: 'monthly', amountCents: 1549 }))).toBe(18588);
  });
});

describe('recurring workflows', () => {
  const demo = buildDemoDataset();
  it('lists 90 days of upcoming obligations with cash impact, excluding already-posted occurrences', () => {
    const rows = upcomingOccurrences(demo, '2026-10-01', 90);
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((r) => r.date <= '2026-12-30')).toBe(true);
    expect(rows.filter((r) => r.rule.id === 'rec-rent' && r.scheduled === '2026-10-01')).toHaveLength(0); // already posted (pending)
    expect(rows.find((r) => r.rule.id === 'rec-payroll').date).toBe('2026-10-02');
    expect(rows.some((r) => r.cashEffectCents < 0)).toBe(true);
    const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
    expect(rows.map((r) => r.date)).toEqual(sorted.map((r) => r.date));
  });
  it('a posted transaction replaces its scheduled occurrence, never double counting', () => {
    const d = caseA();
    let cur = must(saveRecurring(d, { title: 'Gym', kind: 'expense', amountCents: 4000, accountId: 'chk', startDate: '2026-02-05', interval: 'monthly', categoryId: 'cat-rent', group: 'subscription' })).data;
    const id = cur.recurring[0].id;
    expect(upcomingOccurrences(cur, '2026-01-31', 60).filter((r) => r.rule.id === id)).toHaveLength(2);
    const paid = must(markOccurrencePaid(cur, id, '2026-02-05'));
    cur = paid.data;
    const rows = upcomingOccurrences(cur, '2026-01-31', 60).filter((r) => r.rule.id === id);
    expect(rows.map((r) => r.scheduled)).toEqual(['2026-03-05']);
    expect(markOccurrencePaid(cur, id, '2026-02-05').errors[0].message).toMatch(/duplicate/);
    expect(period(cur, { start: '2026-02-01', end: '2026-02-28' }).netExpenseCents).toBe(4000);
    expect(occurrenceStatus(cur, cur.recurring[0], '2026-02-05')).toBe('matched');
  });
  it('can link an existing transaction instead of creating one, and unlink it again', () => {
    let cur = caseA();
    cur = must(saveRecurring(cur, { title: 'Rent', kind: 'expense', amountCents: 12000, accountId: 'chk', startDate: '2026-01-03', interval: 'monthly', categoryId: 'cat-rent' })).data;
    const id = cur.recurring[0].id;
    expect(suggestMatches(cur, cur.recurring[0], { date: '2026-01-03' }).map((m) => m.tx.id)).toContain('a2');
    const linked = must(linkOccurrence(cur, 'a2', id, '2026-01-03'));
    expect(occurrenceStatus(linked.data, linked.data.recurring[0], '2026-01-03')).toBe('matched');
    expect(linked.data.transactions).toHaveLength(cur.transactions.length);
    expect(linkOccurrence(linked.data, 'a2', id, '2026-02-03').ok).toBe(false); // already linked
    const un = must(unlinkOccurrence(linked.data, 'a2'));
    expect(occurrenceStatus(un.data, un.data.recurring[0], '2026-01-03')).toBe('open');
  });
  it('pause, resume, skip and delete behave', () => {
    let cur = must(saveRecurring(caseA(), { title: 'Sub', kind: 'expense', amountCents: 999, accountId: 'chk', startDate: '2026-02-01', interval: 'monthly', group: 'subscription' })).data;
    const id = cur.recurring[0].id;
    cur = must(setRecurringActive(cur, id, false)).data;
    expect(upcomingOccurrences(cur, '2026-01-31', 90)).toHaveLength(0);
    cur = must(setRecurringActive(cur, id, true)).data;
    cur = must(skipOccurrence(cur, id, '2026-02-01')).data;
    expect(upcomingOccurrences(cur, '2026-01-31', 50).map((r) => r.scheduled)).toEqual(['2026-03-01']);
    expect(skipOccurrence(cur, id, '2026-02-02').ok).toBe(false);
    cur = must(deleteRecurring(cur, id)).data;
    expect(cur.recurring).toHaveLength(0);
  });
  it('rejects invalid rules', () => {
    for (const bad of [{ amountCents: 0 }, { startDate: '2026-02-30' }, { interval: 'daily' }, { endDate: '2025-01-01' }, { accountId: 'ghost' }, { kind: 'transfer' }]) {
      expect(saveRecurring(caseA(), { title: 'x', kind: 'expense', amountCents: 100, accountId: 'chk', startDate: '2026-02-01', interval: 'monthly', ...bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it('summarizes subscriptions with monthly and annual equivalents', () => {
    const s = subscriptionSummary(demo);
    expect(s.items.map((r) => r.id).sort()).toEqual(['rec-books', 'rec-forge', 'rec-gym', 'rec-music', 'rec-stream']);
    expect(s.monthlyCents).toBe(1549 + 1099 + 3900 + 492 + 1999);
    expect(s.annualCents).toBe(1549 * 12 + 1099 * 12 + 3900 * 12 + 5900 + 1999 * 12);
  });
});

describe('savings goals', () => {
  const demo = buildDemoDataset();
  it('earmarks without double counting and never exceeds the account balance', () => {
    const prog = goalProgress(demo, '2026-10-01');
    const trip = prog.find((p) => p.goal.id === 'goal-trip');
    const home = prog.find((p) => p.goal.id === 'goal-home');
    expect(trip.allocatedCents).toBe(220000);
    const savBalance = bal(demo, 'acct-sav-gen');
    expect(home.allocatedCents).toBe(Math.round(((savBalance) * 2500) / 10000));
    const alloc = accountAllocations(demo, '2026-10-01').find((a) => a.accountId === 'acct-sav-gen');
    expect(alloc.earmarkedCents).toBe(trip.allocatedCents + home.allocatedCents);
    expect(alloc.unallocatedCents).toBe(savBalance - alloc.earmarkedCents);
    expect(alloc.unallocatedCents).toBeGreaterThanOrEqual(0);
  });
  it('caps a full-balance goal at its target and shares leftovers', () => {
    const goals = [
      { id: 'a', priority: 1, targetCents: 5000, accountId: 'x', allocation: { type: 'full', value: 0 } },
      { id: 'b', priority: 2, targetCents: 9000, accountId: 'x', allocation: { type: 'full', value: 0 } },
    ];
    const out = allocateGoals(goals, () => 8000);
    expect(out.get('a')).toBe(5000);
    expect(out.get('b')).toBe(3000);
  });
  it('computes remaining amount, required contribution per period and milestones', () => {
    const p = goalProgress(demo, '2026-10-01').find((x) => x.goal.id === 'goal-laptop');
    expect(p.allocatedCents).toBe(55000);
    expect(p.remainingCents).toBe(240000 - 55000);
    expect(p.monthsLeft).toBe(4);
    expect(p.perMonthCents).toBe(Math.ceil((240000 - 55000) / 4));
    expect(p.milestones.filter((m) => m.reached).map((m) => m.pct)).toEqual([]);
    expect(p.pct).toBeCloseTo(22.9, 1);
  });
  it('follows account balance changes and transfers', () => {
    const d = buildDemoDataset();
    const before = goalProgress(d, '2026-10-01').find((p) => p.goal.id === 'goal-emergency').allocatedCents;
    const after = goalProgress(must(addTransaction(d, { accountId: 'acct-sav-emg', date: '2026-09-30', description: 'Deposit', amountCents: 100000, kind: 'income', categoryId: 'cat-other-income' })).data, '2026-10-01').find((p) => p.goal.id === 'goal-emergency').allocatedCents;
    expect(after - before).toBe(100000);
  });
  it('manual goals take contributions; account goals refuse them', () => {
    const d = buildDemoDataset();
    const r = must(addGoalContribution(d, 'goal-laptop', { date: '2026-09-30', amountCents: 10000, note: 'x' }));
    expect(goalProgress(r.data, '2026-10-01').find((p) => p.goal.id === 'goal-laptop').allocatedCents).toBe(65000);
    expect(addGoalContribution(d, 'goal-trip', { date: '2026-09-30', amountCents: 10000 }).ok).toBe(false);
  });
  it('validates goals', () => {
    const d = buildDemoDataset();
    expect(saveGoal(d, { name: 'x', targetCents: 0, targetDate: '2027-01-01', accountId: 'acct-sav-gen', allocation: { type: 'full', value: 0 } }).ok).toBe(false);
    expect(saveGoal(d, { name: 'x', targetCents: 100, targetDate: '2027-02-30', accountId: 'acct-sav-gen', allocation: { type: 'full', value: 0 } }).ok).toBe(false);
    expect(saveGoal(d, { name: 'x', targetCents: 100, targetDate: '2027-01-01', accountId: 'ghost', allocation: { type: 'full', value: 0 } }).ok).toBe(false);
    expect(saveGoal(d, { name: 'x', targetCents: 100, targetDate: '2027-01-01', accountId: 'acct-sav-gen', allocation: { type: 'percent', value: 20000 } }).ok).toBe(false);
    const ok = must(saveGoal(d, { name: 'Fund', targetCents: usd('1000.00'), targetDate: '2027-01-01', accountId: 'acct-sav-gen', allocation: { type: 'fixed', value: usd('100.00') } }));
    expect(ok.data.goals).toHaveLength(5);
  });
});
