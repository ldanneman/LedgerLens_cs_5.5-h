import { describe, it, expect } from 'vitest';
import { caseA, CASE_A_EXPECTED, caseB, caseD, caseE, caseEYear } from '../../src/seed/fixtures.js';
import { bal, nw, period, must } from '../helpers.js';
import { buildIndex, runningLedger } from '../../src/domain/ledger.js';
import { monthlyInterest } from '../../src/domain/money.js';
import { addTransaction, updateTransaction, addTransfer } from '../../src/domain/ops/transactions.js';
import { reconcileMath } from '../../src/domain/reconciliation.js';
import { completeReconciliation, saveReconciliationDraft } from '../../src/domain/ops/reconcile.js';
import { budgetMonth, computeBudgetChain, spendByCategoryMonth } from '../../src/domain/budgets.js';
import { occurrencesBetween } from '../../src/domain/recurring.js';
import { runProjection } from '../../src/forecast/engine.js';
import { compareProjections } from '../../src/forecast/compare.js';
import { saveScenario, duplicateScenario } from '../../src/domain/ops/catalog.js';
import { usd } from '../../src/seed/builder.js';
import { validateStructure } from '../../src/domain/validate.js';

describe('Case A - net worth, card payments, refunds', () => {
  const d = caseA();
  it('has the required final contributions and net worth', () => {
    expect(bal(d, 'chk')).toBe(CASE_A_EXPECTED.chk); // +$1,400.00
    expect(bal(d, 'sav')).toBe(CASE_A_EXPECTED.sav); // +$30.00
    expect(bal(d, 'card')).toBe(CASE_A_EXPECTED.card); // -$180.00
    expect(nw(d)).toBe(CASE_A_EXPECTED.netWorth); // +$1,250.00
  });
  it('started at $800.00 and rose by $450.00', () => {
    expect(nw(d, '2026-01-01')).toBe(CASE_A_EXPECTED.startNetWorth);
    expect(nw(d) - nw(d, '2026-01-01')).toBe(45000);
  });
  it('reports $600 income and $150 net expense; transfers are neither', () => {
    const p = period(d);
    expect(p.incomeCents).toBe(60000);
    expect(p.grossExpenseCents).toBe(16000); // rent 120 + groceries 40
    expect(p.refundCents).toBe(1000);
    expect(p.netExpenseCents).toBe(CASE_A_EXPECTED.netExpense);
    expect(p.netCashFlowCents).toBe(45000);
    expect(p.internalNetCents).toBe(0);
    expect(p.transferInCents).toBe(8000); // $50 + $30 moved, shown separately
    expect(p.netWorthChangeCents).toBe(45000);
  });
  it('credit-card purchases count once at purchase time; payments are not spending', () => {
    const groceries = period(d, { categoryIds: ['cat-groceries'] });
    expect(groceries.netExpenseCents).toBe(3000); // 40 purchase - 10 refund
    const before = period(d, { end: '2026-01-04' });
    expect(before.netExpenseCents).toBe(16000);
  });
  it('transfers sum to zero across accounts', () => {
    const idx = buildIndex(d);
    for (const legs of idx.legsByTransfer.values()) expect(legs.reduce((s, l) => s + l.amountCents, 0)).toBe(0);
  });
  it('running ledger explains the balance', () => {
    const rows = runningLedger(buildIndex(d), 'chk');
    expect(rows[rows.length - 1].postedBalance).toBe(140000);
    expect(rows.map((r) => r.postedBalance)).toEqual([160000, 148000, 143000, 140000]);
  });
});

describe('Case B - split accounting', () => {
  it('debits the account once and splits the categories exactly', () => {
    const d = caseB();
    expect(bal(d, 'chk')).toBe(50000 - 4735);
    const p = period(d);
    expect(p.netExpenseCents).toBe(4735);
    expect(p.byCategory.get('cat-groceries').expenseCents).toBe(1250);
    expect(p.byCategory.get('cat-household').expenseCents).toBe(3485);
  });
  it('rejects a split total of -$47.34 before anything is saved', () => {
    const d = caseB();
    const res = addTransaction(d, { accountId: 'chk', date: '2026-01-12', description: 'Bad split', amountCents: -4735, kind: 'expense', splits: [{ categoryId: 'cat-groceries', amountCents: -1250 }, { categoryId: 'cat-household', amountCents: -3484 }] });
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toMatch(/exactly/i);
    expect(d.transactions).toHaveLength(1);
  });
  it('editing the amount of a split transaction demands matching splits', () => {
    const d = caseB();
    const res = updateTransaction(d, 'b1', { amountCents: -5000 });
    expect(res.ok).toBe(false);
    const ok = must(updateTransaction(d, 'b1', { amountCents: -5000, splits: [{ categoryId: 'cat-groceries', amountCents: -2000 }, { categoryId: 'cat-household', amountCents: -3000 }] }));
    expect(bal(ok.data, 'chk')).toBe(45000);
  });
  it('rejects splits with a sign opposite to the parent or an income category on an expense', () => {
    const d = caseB();
    expect(addTransaction(d, { accountId: 'chk', date: '2026-01-12', description: 'x', amountCents: -1000, kind: 'expense', splits: [{ categoryId: 'cat-groceries', amountCents: -2000 }, { categoryId: 'cat-household', amountCents: 1000 }] }).ok).toBe(false);
    expect(addTransaction(d, { accountId: 'chk', date: '2026-01-12', description: 'x', amountCents: -1000, kind: 'expense', splits: [{ categoryId: 'cat-salary', amountCents: -500 }, { categoryId: 'cat-household', amountCents: -500 }] }).ok).toBe(false);
  });
});

describe('Case D - reconciliation', () => {
  it('computes the statement maths', () => {
    expect(reconcileMath(50000, 132475, [120000, -30000, -7525])).toEqual({ clearedSum: 82475, calculated: 132475, discrepancy: 0 });
    expect(reconcileMath(50000, 131975, [120000, -30000, -7525]).discrepancy).toBe(-500);
  });
  const base = () => ({ id: 'r1', accountId: 'chk', startDate: '2026-01-01', endDate: '2026-01-31', openingCents: 50000, clearedTxIds: ['d1', 'd2', 'd3'], note: '' });
  it('completes at exactly zero discrepancy, ignoring the uncleared -$20 item', () => {
    const d = caseD();
    const res = must(completeReconciliation(d, { ...base(), id: undefined, closingCents: 132475 }, { now: '2026-02-01T00:00:00Z' }));
    const rec = res.data.reconciliations[0];
    expect(rec.status).toBe('completed');
    expect(rec.calculatedCents).toBe(132475);
    expect(rec.discrepancyCents).toBe(0);
    expect(rec.clearedTxIds).toEqual(['d1', 'd2', 'd3']);
    expect(rec.snapshots).toHaveLength(3);
  });
  it('blocks completion with a -$5.00 discrepancy and explains it', () => {
    const d = caseD();
    const res = completeReconciliation(d, { ...base(), id: undefined, closingCents: 131975 }, {});
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toMatch(/-\$5\.00/);
    const draft = must(saveReconciliationDraft(d, { ...base(), id: undefined, closingCents: 131975 }));
    expect(draft.data.reconciliations[0].discrepancyCents).toBe(-500);
    expect(draft.data.reconciliations[0].status).toBe('in_progress');
  });
  it('refuses to clear pending or foreign transactions', () => {
    const d = caseD();
    expect(completeReconciliation(d, { ...base(), id: undefined, clearedTxIds: ['nope'], closingCents: 0 }).ok).toBe(false);
  });
});

describe('Case E - rollover budgets', () => {
  it('chains Jan/Feb/Mar: 200 -> 50 -> 250 -> -30 -> 170', () => {
    const d = caseE();
    const spend = spendByCategoryMonth(d).get('cat-groceries');
    const chain = computeBudgetChain(d.budgets[0], spend, '2026-03');
    expect(chain.map((r) => [r.month, r.availableCents, r.spentCents, r.remainingCents])).toEqual([
      ['2026-01', 20000, 15000, 5000],
      ['2026-02', 25000, 28000, -3000],
      ['2026-03', 17000, 0, 17000],
    ]);
    expect(budgetMonth(d.budgets[0], spend, '2026-03').rolloverInCents).toBe(-3000);
  });
  it('recomputes downstream months when January spending is edited', () => {
    const d = caseE();
    const edited = must(updateTransaction(d, 'e1', { amountCents: -usd('100.00') }));
    const chain = computeBudgetChain(edited.data.budgets[0], spendByCategoryMonth(edited.data).get('cat-groceries'), '2026-03');
    expect(chain[0].remainingCents).toBe(10000);
    expect(chain[1].availableCents).toBe(30000);
    expect(chain[2].availableCents).toBe(22000);
  });
  it('rolls over from December into January', () => {
    const d = caseEYear();
    const chain = computeBudgetChain(d.budgets[0], spendByCategoryMonth(d).get('cat-groceries'), '2026-02');
    expect(chain.map((r) => r.availableCents)).toEqual([20000, 25000, 17000]);
    expect(chain[0].spentCents).toBe(15000); // Dec 31 counted in December
    expect(chain[1].spentCents).toBe(28000); // Jan 1 counted in January
  });
  it('a refund reduces net spending for rollover', () => {
    const d = caseE();
    const res = must(addTransaction(d, { accountId: 'chk', date: '2026-01-20', description: 'Return', amountCents: usd('20.00'), kind: 'expense', categoryId: 'cat-groceries' }));
    const chain = computeBudgetChain(res.data.budgets[0], spendByCategoryMonth(res.data).get('cat-groceries'), '2026-01');
    expect(chain[0].spentCents).toBe(13000);
  });
});

describe('Case G - time and precision boundaries', () => {
  const rule = { id: 'r', startDate: '2026-01-31', interval: 'monthly', endDate: null, businessDay: 'none' };
  it('Jan 31 monthly recurrence never emits an invalid date', () => {
    const dates = occurrencesBetween(rule, '2026-01-01', '2026-06-30').map((o) => o.scheduled);
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    const leap = occurrencesBetween({ ...rule, startDate: '2024-01-31' }, '2024-01-01', '2024-03-31').map((o) => o.scheduled);
    expect(leap).toEqual(['2024-01-31', '2024-02-29', '2024-03-31']);
  });
  it('$0.10 + $0.20 - $0.30 leaves no phantom cent through ledger and reports', () => {
    const d = caseB();
    let cur = d;
    for (const [i, a] of [10, 20].entries()) cur = must(addTransaction(cur, { accountId: 'chk', date: '2026-01-1' + (i + 3), description: `in ${a}`, amountCents: a, kind: 'income', categoryId: 'cat-salary' })).data;
    cur = must(addTransaction(cur, { accountId: 'chk', date: '2026-01-20', description: 'out', amountCents: -30, kind: 'expense', categoryId: 'cat-groceries' })).data;
    expect(bal(cur, 'chk')).toBe(bal(d, 'chk'));
    expect(validateStructure(cur).filter((f) => f.blocking)).toEqual([]);
  });
  it('repeating the same edits is stable at the cent', () => {
    let cur = caseA();
    for (let i = 0; i < 5; i += 1) {
      cur = must(updateTransaction(cur, 'a3', { amountCents: -4001 })).data;
      cur = must(updateTransaction(cur, 'a3', { amountCents: -4000 })).data;
    }
    expect(nw(cur)).toBe(CASE_A_EXPECTED.netWorth);
  });
  it('interest rounding is reproducible', () => {
    expect(Array.from({ length: 5 }, () => monthlyInterest(123457, 1999))).toEqual(Array(5).fill(monthlyInterest(123457, 1999)));
  });
});

describe('Case F - identical scenarios', () => {
  const withScenario = () => {
    const d = caseA();
    const s = must(saveScenario(d, { name: 'Raise', horizonMonths: 12, changes: [{ type: 'one_time', date: '2026-03-15', title: 'Bonus', amountCents: 100000, accountId: 'chk' }] }));
    const dup = must(duplicateScenario(s.data, s.id));
    return { data: dup.data, a: s.id, b: dup.id };
  };
  it('a scenario compared with an exact duplicate shows zero differences', () => {
    const { data, a, b } = withScenario();
    const sa = data.scenarios.find((s) => s.id === a);
    const sb = data.scenarios.find((s) => s.id === b);
    const cmp = compareProjections(runProjection(data, sa), runProjection(data, sb));
    expect(cmp.identical).toBe(true);
    expect(cmp.affectedAccounts).toEqual([]);
    expect(cmp.affectedGoals).toEqual([]);
    expect(cmp.debts.every((x) => !x.payoffChanged && x.interest.diff === 0)).toBe(true);
    expect(Object.values(cmp.totals).every((t) => t.diff === 0)).toBe(true);
  });
  it('the baseline compared with itself is identical, an actual change is not', () => {
    const { data, a } = withScenario();
    const base = runProjection(data, null);
    expect(compareProjections(base, runProjection(data, null)).identical).toBe(true);
    const cmp = compareProjections(base, runProjection(data, data.scenarios.find((s) => s.id === a)));
    expect(cmp.identical).toBe(false);
    expect(cmp.totals.endNetWorthCents.diff).toBe(100000);
    expect(cmp.firstDivergence).toBe('2026-03');
  });
  it('an unchanged negative cash state is not evidence of a change', () => {
    const d = caseA();
    const s = must(saveScenario(d, { name: 'Noop', horizonMonths: 6, changes: [] }));
    const win = { horizonMonths: 6 };
    const cmp = compareProjections(runProjection(s.data, null, win), runProjection(s.data, s.data.scenarios[0], win));
    expect(cmp.identical).toBe(true);
  });
});

describe('transfer example from the spec', () => {
  it('a $50 checking-to-card payment moves both contributions and nets to zero', () => {
    const d = caseA();
    const res = must(addTransfer(d, { fromAccountId: 'chk', toAccountId: 'card', amountCents: 5000, date: '2026-01-20', description: 'Extra' }));
    expect(bal(res.data, 'chk') - bal(d, 'chk')).toBe(-5000);
    expect(bal(res.data, 'card') - bal(d, 'card')).toBe(5000);
    expect(nw(res.data)).toBe(nw(d));
  });
});
