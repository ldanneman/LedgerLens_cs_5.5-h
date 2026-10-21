import { describe, it, expect } from 'vitest';
import { suggestStatement } from '../../src/domain/reconciliation.js';
import { completeReconciliation } from '../../src/domain/ops/reconcile.js';
import { filterTransactions, sortTransactions, filtersFromParams } from '../../src/ui/txFilter.js';
import { caseA, caseD } from '../../src/seed/fixtures.js';
import { buildDemoDataset } from '../../src/seed/demo.js';
import { must } from '../helpers.js';

const F = (o = {}) => ({ ...filtersFromParams(new URLSearchParams()), ...o });

describe('statement suggestions', () => {
  it('uses the posted balance the day before when nothing was reconciled', () => {
    expect(suggestStatement(caseD(), 'chk', '2026-01-10', '2026-01-31')).toEqual({ openingCents: 140000, closingCents: 130475 });
  });
  it('chains from the previous completed reconciliation closing', () => {
    const d = must(completeReconciliation(caseD(), { accountId: 'chk', startDate: '2026-01-01', endDate: '2026-01-31', openingCents: 50000, closingCents: 132475, clearedTxIds: ['d1', 'd2', 'd3'] })).data;
    expect(suggestStatement(d, 'chk', '2026-02-01', '2026-02-28').openingCents).toBe(132475);
  });
});

describe('transaction filtering and sorting', () => {
  const d = buildDemoDataset();
  it('filters by text, category, kind, status and amount range', () => {
    expect(filterTransactions(d, F({ q: 'rent - landmark' })).every((t) => /landmark/i.test(t.description))).toBe(true);
    expect(filterTransactions(d, F({ status: 'pending' })).every((t) => t.status === 'pending')).toBe(true);
    expect(filterTransactions(d, F({ kind: 'refund' })).every((t) => t.kind === 'expense' && t.amountCents > 0)).toBe(true);
    expect(filterTransactions(d, F({ cat: '__none__' })).length).toBeGreaterThanOrEqual(8);
    const split = filterTransactions(d, F({ cat: 'cat-household' })).some((t) => t.splits.length > 0);
    expect(split).toBe(true);
    expect(filterTransactions(d, F({ min: '1000', max: '2000' })).every((t) => Math.abs(t.amountCents) >= 100000 && Math.abs(t.amountCents) <= 200000)).toBe(true);
  });
  it('date range bounds are inclusive and sorting is stable', () => {
    const a = caseA();
    expect(filterTransactions(a, F({ from: '2026-01-02', to: '2026-01-03' }))).toHaveLength(2);
    const s = sortTransactions(a, filterTransactions(a, F()), { key: 'amount', dir: 'asc' });
    expect(s[0].amountCents).toBeLessThanOrEqual(s[1].amountCents);
  });
});
