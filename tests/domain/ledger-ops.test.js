import { describe, it, expect } from 'vitest';
import { caseA, caseD } from '../../src/seed/fixtures.js';
import { buildDemoDataset } from '../../src/seed/demo.js';
import { bal, nw, period, must } from '../helpers.js';
import { addTransaction, updateTransaction, deleteTransactions, reverseTransaction, bulkUpdateTransactions, addTransfer, updateTransfer, addExternalTransfer, linkAsTransfer, suggestTransferPairs } from '../../src/domain/ops/transactions.js';
import { addAccount, updateAccount, archiveAccount, deleteAccount, unarchiveAccount } from '../../src/domain/ops/accounts.js';
import { addCategory, deleteCategory, saveRule, applyRules, categoryUsage, updateCategory } from '../../src/domain/ops/catalog.js';
import { completeReconciliation } from '../../src/domain/ops/reconcile.js';
import { reconciliationHealth } from '../../src/domain/reconciliation.js';
import { previewRules, findRule } from '../../src/domain/rules.js';
import { buildIndex, accountPosition } from '../../src/domain/ledger.js';
import { validateStructure } from '../../src/domain/validate.js';

const exp = (over = {}) => ({ accountId: 'chk', date: '2026-01-15', description: 'Test spend', amountCents: -2500, kind: 'expense', categoryId: 'cat-groceries', ...over });

describe('transactions: validation at the domain boundary', () => {
  const d = caseA();
  it('rejects impossible input with actionable messages and leaves data untouched', () => {
    const cases = [
      [{ date: '2026-02-30' }, /valid calendar date/],
      [{ amountCents: 0 }, /cannot be zero/],
      [{ amountCents: 12.5 }, /whole number of cents/],
      [{ amountCents: NaN }, /whole number/],
      [{ amountCents: Infinity }, /whole number/],
      [{ amountCents: 1e12 }, /whole number/],
      [{ accountId: 'ghost' }, /does not exist/],
      [{ categoryId: 'ghost' }, /does not exist/],
      [{ categoryId: 'cat-salary' }, /income category/],
      [{ description: '   ' }, /description/i],
      [{ status: 'maybe' }, /posted or pending/],
      [{ kind: 'transfer' }, /Transfer funds/],
      [{ date: '2025-12-01' }, /before .* was opened/],
    ];
    for (const [over, re] of cases) {
      const res = addTransaction(d, exp(over));
      expect(res.ok, JSON.stringify(over)).toBe(false);
      expect(res.errors.map((e) => e.message).join(' '), JSON.stringify(over)).toMatch(re);
    }
    expect(d.transactions).toHaveLength(6 + 2);
  });
  it('accepts a normal expense and an income, balance changes exactly once', () => {
    const r = must(addTransaction(d, exp()));
    expect(bal(r.data, 'chk')).toBe(bal(d, 'chk') - 2500);
    expect(r.data.transactions.filter((t) => t.id === r.id)).toHaveLength(1);
    const inc = must(addTransaction(r.data, exp({ amountCents: 9900, kind: 'income', categoryId: 'cat-salary', description: 'Bonus' })));
    expect(nw(inc.data)).toBe(nw(d) - 2500 + 9900);
  });
  it('rejects a new transaction on an archived account', () => {
    const arch = must(archiveAccount(must(addAccount(d, { name: 'Temp', type: 'checking', openingCents: 0, openingDate: '2026-01-01' })).data, 'acct-000001'));
    expect(addTransaction(arch.data, exp({ accountId: 'acct-000001' })).errors[0].message).toMatch(/archived/);
  });
});

describe('pending vs posted', () => {
  it('pending items change available but not posted balance', () => {
    const d = caseA();
    const r = must(addTransaction(d, exp({ status: 'pending', amountCents: -10000 })));
    const pos = accountPosition(buildIndex(r.data), 'chk', '2026-01-31');
    expect(pos.postedCents).toBe(140000);
    expect(pos.pendingCents).toBe(-10000);
    expect(pos.availableCents).toBe(130000);
    expect(bal(r.data, 'chk')).toBe(140000);
    expect(bal(r.data, 'chk', '2026-01-31', true)).toBe(130000);
    expect(period(r.data).netExpenseCents).toBe(15000); // posted basis
    expect(period(r.data, { includePending: true }).netExpenseCents).toBe(25000);
  });
  it('future-dated items are excluded from as-of balances', () => {
    const r = must(addTransaction(caseA(), exp({ date: '2026-03-01', amountCents: -777 })));
    expect(r.warnings.join(' ')).toMatch(/after the as-of/i);
    expect(bal(r.data, 'chk')).toBe(140000);
    expect(bal(r.data, 'chk', '2026-03-01')).toBe(140000 - 777);
  });
});

describe('adjustments and investment valuation', () => {
  it('a valuation adjustment changes net worth but is neither income nor spending', () => {
    const d = must(addAccount(caseA(), { name: 'Brokerage', type: 'investment', openingCents: 100000, openingDate: '2026-01-01' }));
    const id = d.id;
    const r = must(addTransaction(d.data, { accountId: id, date: '2026-01-20', description: 'Market gain', amountCents: 5000, kind: 'adjustment', adjustmentKind: 'valuation' }));
    expect(nw(r.data)).toBe(nw(d.data) + 5000);
    const p = period(r.data);
    expect(p.valuationCents).toBe(5000);
    expect(p.incomeCents).toBe(60000);
    expect(p.netWorthChangeCents).toBe(45000 + 5000);
  });
  it('an investment contribution is a transfer, distinct from market value', () => {
    const d = must(addAccount(caseA(), { name: 'Brokerage', type: 'investment', openingCents: 0, openingDate: '2026-01-01' }));
    const r = must(addTransfer(d.data, { fromAccountId: 'chk', toAccountId: d.id, amountCents: 20000, date: '2026-01-25' }));
    expect(period(r.data).valuationCents).toBe(0);
    expect(nw(r.data)).toBe(nw(d.data));
  });
  it('adjustments cannot carry a category', () => {
    expect(addTransaction(caseA(), { accountId: 'chk', date: '2026-01-10', description: 'x', amountCents: 5, kind: 'adjustment', adjustmentKind: 'correction', categoryId: 'cat-groceries' }).ok).toBe(false);
  });
});

describe('transfers: atomic, balanced, linked', () => {
  it('edits both legs together and keeps them balanced', () => {
    const d = caseA();
    const r = must(updateTransfer(d, 'xa4', { amountCents: 7500, date: '2026-01-06' }));
    const legs = r.data.transactions.filter((t) => t.transferId === 'xa4');
    expect(legs.map((l) => l.amountCents).sort((a, b) => a - b)).toEqual([-7500, 7500]);
    expect(legs.every((l) => l.date === '2026-01-06')).toBe(true);
    expect(nw(r.data)).toBe(nw(d));
    expect(bal(r.data, 'card')).toBe(-18000 + 2500);
  });
  it('refuses single-leg amount edits that would unbalance a transfer', () => {
    const res = updateTransaction(caseA(), 'a4a', { amountCents: -9999 });
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toMatch(/transfer as a whole/);
  });
  it('allows description/notes/tags on one leg', () => {
    const r = must(updateTransaction(caseA(), 'a4a', { description: 'Card pay (renamed)', tags: ['x'] }));
    expect(r.data.transactions.find((t) => t.id === 'a4a').description).toBe('Card pay (renamed)');
  });
  it('deleting either leg removes the whole transfer (no stranded half)', () => {
    const d = caseA();
    const r = must(deleteTransactions(d, ['a4b']));
    expect(r.deletedCount).toBe(2);
    expect(r.data.transfers.find((t) => t.id === 'xa4')).toBeUndefined();
    expect(r.data.transactions.some((t) => t.transferId === 'xa4')).toBe(false);
    expect(validateStructure(r.data).filter((f) => f.blocking)).toEqual([]);
  });
  it('rejects same-account, non-positive and archived transfers', () => {
    const d = caseA();
    expect(addTransfer(d, { fromAccountId: 'chk', toAccountId: 'chk', amountCents: 100, date: '2026-01-20' }).ok).toBe(false);
    expect(addTransfer(d, { fromAccountId: 'chk', toAccountId: 'sav', amountCents: 0, date: '2026-01-20' }).ok).toBe(false);
    expect(addTransfer(d, { fromAccountId: 'chk', toAccountId: 'sav', amountCents: -5, date: '2026-01-20' }).ok).toBe(false);
    expect(addTransfer(d, { fromAccountId: 'chk', toAccountId: 'ghost', amountCents: 5, date: '2026-01-20' }).ok).toBe(false);
  });
  it('liability-to-liability and liability-to-asset transfers keep net worth', () => {
    let d = must(addAccount(caseA(), { name: 'Card B', type: 'credit_card', openingCents: -10000, openingDate: '2026-01-01' })).data;
    const before = nw(d);
    d = must(addTransfer(d, { fromAccountId: 'card', toAccountId: 'acct-000001', amountCents: 3000, date: '2026-01-21', description: 'Balance transfer' })).data;
    expect(bal(d, 'card')).toBe(-18000 - 3000);
    expect(bal(d, 'acct-000001')).toBe(-10000 + 3000);
    expect(nw(d)).toBe(before);
    d = must(addTransfer(d, { fromAccountId: 'card', toAccountId: 'chk', amountCents: 1000, date: '2026-01-22', description: 'Cash advance' })).data;
    expect(nw(d)).toBe(before);
  });
  it('external transfers change net worth but not income or spending', () => {
    const d = caseA();
    const r = must(addExternalTransfer(d, { accountId: 'chk', direction: 'out', amountCents: 12000, date: '2026-01-25', counterparty: 'Landlord Venmo' }));
    expect(nw(r.data)).toBe(nw(d) - 12000);
    const p = period(r.data);
    expect(p.incomeCents).toBe(60000);
    expect(p.netExpenseCents).toBe(15000);
    expect(p.externalOutCents).toBe(12000);
    expect(p.netWorthChangeCents).toBe(45000 - 12000);
    expect(validateStructure(r.data).filter((f) => f.blocking)).toEqual([]);
  });
  it('links two imported halves into one transfer so a card payment is not double counted', () => {
    let d = caseA();
    d = must(addTransaction(d, { accountId: 'chk', date: '2026-01-26', description: 'CARD PAYMENT', amountCents: -4000, kind: 'expense' })).data;
    d = must(addTransaction(d, { accountId: 'card', date: '2026-01-26', description: 'PAYMENT THANK YOU', amountCents: 4000, kind: 'expense' })).data;
    expect(period(d).grossExpenseCents).toBe(20000); // both halves pollute gross spending and refunds until linked
    expect(period(d).refundCents).toBe(5000);
    const pairs = suggestTransferPairs(d);
    expect(pairs).toHaveLength(1);
    const ids = d.transactions.slice(-2).map((t) => t.id);
    const linked = must(linkAsTransfer(d, ids[0], ids[1]));
    expect(period(linked.data).netExpenseCents).toBe(15000);
    expect(period(linked.data).grossExpenseCents).toBe(16000);
    expect(period(linked.data).refundCents).toBe(1000);
    expect(nw(linked.data)).toBe(nw(d));
    expect(linkAsTransfer(d, ids[0], 'a1').ok).toBe(false);
  });
});

describe('edit, delete and reverse', () => {
  it('re-categorizing moves spending between categories without changing the balance', () => {
    const d = caseA();
    const r = must(updateTransaction(d, 'a3', { categoryId: 'cat-household' }));
    expect(period(r.data).byCategory.get('cat-household').expenseCents).toBe(4000);
    expect(period(r.data).byCategory.get('cat-groceries').expenseCents).toBe(-1000);
    expect(nw(r.data)).toBe(nw(d));
    expect(r.data.transactions.find((t) => t.id === 'a3').categorySource).toBe('manual');
  });
  it('changing a date moves it across a month boundary in reports', () => {
    const d = caseA();
    const r = must(updateTransaction(d, 'a2', { date: '2025-12-31' }));
    expect(period(r.data, { start: '2026-01-01', end: '2026-01-31' }).netExpenseCents).toBe(3000);
    expect(period(r.data, { start: '2025-12-01', end: '2025-12-31' }).netExpenseCents).toBe(12000);
  });
  it('a reversal offsets the original visibly and links back', () => {
    const d = caseA();
    const r = must(reverseTransaction(d, 'a2', { date: '2026-01-20' }));
    const rev = r.data.transactions.find((t) => t.reversalOf === 'a2');
    expect(rev.amountCents).toBe(12000);
    expect(period(r.data, { categoryIds: ['cat-rent'] }).netExpenseCents).toBe(0);
    expect(r.data.transactions).toHaveLength(d.transactions.length + 1);
    expect(reverseTransaction(r.data, 'a2').errors[0].message).toMatch(/already been reversed/);
  });
  it('reversing a transfer creates a reversed pair', () => {
    const d = caseA();
    const r = must(reverseTransaction(d, 'a4a', { date: '2026-01-22' }));
    expect(r.createdIds).toHaveLength(2);
    expect(bal(r.data, 'chk')).toBe(140000 + 5000);
    expect(bal(r.data, 'card')).toBe(-18000 - 5000);
    expect(nw(r.data)).toBe(nw(d));
  });
  it('bulk edit applies to compatible items and reports skipped ones', () => {
    const d = caseA();
    const r = must(bulkUpdateTransactions(d, ['a2', 'a3', 'a4a'], { categoryId: 'cat-household', addTags: ['Review'] }));
    expect(r.updatedCount).toBe(2);
    expect(r.warnings.join(' ')).toMatch(/Skipped 1/);
    expect(r.data.transactions.find((t) => t.id === 'a2').tags).toEqual(['Review']);
    expect(bulkUpdateTransactions(d, ['a4a'], { categoryId: 'cat-household' }).ok).toBe(false);
    expect(bulkUpdateTransactions(d, ['a1'], { categoryId: 'cat-household' }).ok).toBe(false); // income vs expense category
  });
  it('failed ops never change the original dataset object', () => {
    const d = caseA();
    const snapshot = JSON.stringify(d);
    addTransaction(d, exp({ amountCents: 0 }));
    updateTransaction(d, 'a2', { amountCents: 0.5 });
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});

describe('editing reconciled transactions', () => {
  const reconciled = () => must(completeReconciliation(caseD(), { accountId: 'chk', startDate: '2026-01-01', endDate: '2026-01-31', openingCents: 50000, closingCents: 132475, clearedTxIds: ['d1', 'd2', 'd3'] }, { now: 'x' })).data;
  it('warns and flags the reconciliation as out of date after an amount edit', () => {
    const d = reconciled();
    expect(reconciliationHealth(d, d.reconciliations[0]).valid).toBe(true);
    const r = must(updateTransaction(d, 'd2', { amountCents: -31000 }));
    expect(r.warnings.join(' ')).toMatch(/out of date/);
    const h = reconciliationHealth(r.data, r.data.reconciliations[0]);
    expect(h.valid).toBe(false);
    expect(h.problems[0].type).toBe('amount');
  });
  it('flags deletion and ignores category-only edits', () => {
    const d = reconciled();
    const del = must(deleteTransactions(d, ['d3']));
    expect(del.warnings.join(' ')).toMatch(/deleted/);
    expect(reconciliationHealth(del.data, del.data.reconciliations[0]).problems[0].type).toBe('deleted');
    const cat = must(updateTransaction(d, 'd3', { categoryId: 'cat-household' }));
    expect(cat.warnings).toEqual([]);
    expect(reconciliationHealth(cat.data, cat.data.reconciliations[0]).valid).toBe(true);
  });
  it('a transaction cleared in a completed reconciliation cannot be cleared again', () => {
    const d = reconciled();
    const again = completeReconciliation(d, { accountId: 'chk', startDate: '2026-01-01', endDate: '2026-02-28', openingCents: 0, closingCents: 0, clearedTxIds: ['d1'] });
    expect(again.ok).toBe(false);
    expect(again.errors[0].message).toMatch(/already cleared/);
  });
});

describe('account lifecycle', () => {
  it('creates, renames and refuses duplicates and unsafe changes', () => {
    let d = caseA();
    const a = must(addAccount(d, { name: 'Vacation Fund', type: 'savings', openingCents: 5000, openingDate: '2026-01-01', institution: 'Demo' }));
    expect(bal(a.data, a.id)).toBe(5000);
    expect(nw(a.data)).toBe(nw(d) + 5000);
    expect(addAccount(a.data, { name: 'vacation fund', type: 'savings', openingCents: 0, openingDate: '2026-01-01' }).ok).toBe(false);
    d = must(updateAccount(a.data, a.id, { name: 'Trip Fund', aprBps: 350 })).data;
    expect(d.accounts.find((x) => x.id === a.id).name).toBe('Trip Fund');
    expect(updateAccount(d, 'chk', { type: 'credit_card' }).errors.map((e) => e.message).join(' ')).toMatch(/asset and a liability/);
    expect(updateAccount(d, 'chk', { openingDate: '2026-01-02' }).ok).toBe(true);
    expect(updateAccount(d, 'chk', { openingDate: '2026-01-03' }).errors[0].message).toMatch(/dated before/);
    expect(updateAccount(d, 'chk', { id: 'other' }).ok).toBe(false);
  });
  it('explains the effect of changing an opening balance', () => {
    const r = must(updateAccount(caseA(), 'chk', { openingCents: 120000 }));
    expect(r.warnings[0]).toMatch(/moves by the same amount/);
    expect(nw(r.data)).toBe(125000 + 20000);
  });
  it('archives only at zero balance, keeps history, blocks deletion when referenced', () => {
    const d = caseA();
    expect(archiveAccount(d, 'chk').errors[0].message).toMatch(/still holds/);
    expect(deleteAccount(d, 'chk').errors[0].message).toMatch(/Archive it instead/);
    const empty = must(addAccount(d, { name: 'Scratch', type: 'checking', openingCents: 0, openingDate: '2026-01-01' }));
    const arch = must(archiveAccount(empty.data, empty.id));
    expect(arch.data.accounts.find((a) => a.id === empty.id).status).toBe('archived');
    expect(must(unarchiveAccount(arch.data, empty.id)).data.accounts.find((a) => a.id === empty.id).status).toBe('active');
    expect(must(deleteAccount(empty.data, empty.id)).data.accounts.find((a) => a.id === empty.id)).toBeUndefined();
  });
  it('archived accounts keep their history in historical reports', () => {
    const d = buildDemoDataset();
    const old = d.accounts.find((a) => a.id === 'acct-sav-old');
    expect(old.status).toBe('archived');
    expect(bal(d, 'acct-sav-old', '2025-09-10')).toBe(60000);
    expect(bal(d, 'acct-sav-old')).toBe(0);
    expect(bal(d, 'acct-sav-old', '2025-09-12')).toBe(0); // closed by a transfer on the 12th
  });
  it('rejects a liability opening balance that is positive', () => {
    expect(addAccount(caseA(), { name: 'Bad card', type: 'credit_card', openingCents: 5000, openingDate: '2026-01-01' }).ok).toBe(false);
  });
});

describe('categories and rules', () => {
  const rulesData = () => {
    let d = caseA();
    d = must(addCategory(d, { name: 'Coffee', kind: 'expense' })).data;
    return d;
  };
  it('applies the first matching rule by priority and never overwrites manual choices', () => {
    let d = rulesData();
    const coffee = d.categories.find((c) => c.name === 'Coffee').id;
    d = must(saveRule(d, { name: 'Cafe -> Coffee', pattern: 'cafe', categoryId: coffee, priority: 10 })).data;
    d = must(saveRule(d, { name: 'Anything -> Household', pattern: 'a', categoryId: 'cat-household', priority: 50 })).data;
    const probe = { kind: 'expense', accountId: 'chk', amountCents: -500, description: 'Blue Cafe', merchant: '' };
    expect(findRule(d, probe).categoryId).toBe(coffee);
    const added = must(addTransaction(d, exp({ description: 'Blue Cafe', categoryId: null })));
    expect(added.data.transactions.find((t) => t.id === added.id).categoryId).toBe(coffee);
    expect(added.data.transactions.find((t) => t.id === added.id).categorySource).toBe('rule');
    const manual = must(addTransaction(d, exp({ description: 'Blue Cafe', categoryId: 'cat-groceries' })));
    expect(manual.data.transactions.find((t) => t.id === manual.id).categoryId).toBe('cat-groceries');
    const prev = previewRules(manual.data, { scope: 'non_manual' });
    expect(prev.some((c) => c.txId === manual.id)).toBe(false);
  });
  it('previews before applying in bulk and only touches uncategorized items by default', () => {
    let d = rulesData();
    d = must(addTransaction(d, exp({ description: 'Mystery Mart', categoryId: null }))).data;
    d = must(saveRule(d, { name: 'Mart', pattern: 'mart', categoryId: 'cat-household', priority: 1 })).data;
    const prev = previewRules(d);
    expect(prev).toHaveLength(1);
    expect(prev[0].toCategoryId).toBe('cat-household');
    const applied = must(applyRules(d, {}));
    expect(applied.appliedCount).toBe(1);
    expect(applyRules(applied.data, {}).ok).toBe(false); // nothing left to change
  });
  it('rejects rules for missing categories and income categories on expenses', () => {
    expect(saveRule(caseA(), { name: 'x', pattern: 'x', categoryId: 'ghost' }).ok).toBe(false);
    expect(saveRule(caseA(), { name: '', pattern: 'x', categoryId: 'cat-rent' }).ok).toBe(false);
  });
  it('deleting a category reassigns or uncategorizes, never orphans', () => {
    const d = caseA();
    expect(categoryUsage(d, 'cat-groceries').transactions).toBe(2);
    const r = must(deleteCategory(d, 'cat-groceries', { reassignTo: 'cat-household' }));
    expect(r.data.transactions.filter((t) => t.categoryId === 'cat-household')).toHaveLength(2);
    expect(validateStructure(r.data).filter((f) => f.blocking)).toEqual([]);
    expect(updateCategory(d, 'cat-groceries', { kind: 'income' }).ok).toBe(false);
    expect(deleteCategory(d, 'cat-groceries', { reassignTo: 'cat-salary' }).ok).toBe(false);
  });
});
