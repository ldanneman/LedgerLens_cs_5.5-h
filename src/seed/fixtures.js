/**
 * Small independent acceptance fixtures (spec section 20, cases A-E). They are used by the automated
 * tests AND by the Test Lab "Reference cases" panel, which evaluates them live with the real engine.
 */
import { DatasetBuilder, usd } from './builder.js';

const cats = (b) => {
  b.category('cat-salary', 'Salary', 'income', 'Income');
  b.category('cat-rent', 'Rent', 'expense', 'Housing');
  b.category('cat-groceries', 'Groceries', 'expense', 'Food');
  b.category('cat-household', 'Household Goods', 'expense', 'Housing');
};

/** Case A - net worth, card payments and refunds. */
export function caseA() {
  const b = new DatasetBuilder({ name: 'Case A - net worth, card payments, refunds', kind: 'fixture', presetId: 'case-a', asOfDate: '2026-01-31' });
  cats(b);
  b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-01-01' });
  b.account('sav', { name: 'Savings', type: 'savings', opening: 0, openingDate: '2026-01-01' });
  b.account('card', { name: 'Credit card', type: 'credit_card', opening: -usd('200.00'), openingDate: '2026-01-01', limit: usd('5000.00'), aprBps: 1999 });
  b.tx({ id: 'a1', account: 'chk', date: '2026-01-02', desc: 'Payroll', amount: usd('600.00'), kind: 'income', category: 'cat-salary' });
  b.tx({ id: 'a2', account: 'chk', date: '2026-01-03', desc: 'Rent', amount: -usd('120.00'), kind: 'expense', category: 'cat-rent' });
  b.tx({ id: 'a3', account: 'card', date: '2026-01-04', desc: 'Groceries', amount: -usd('40.00'), kind: 'expense', category: 'cat-groceries' });
  b.transfer({ id: 'xa4', legIds: ['a4a', 'a4b'], from: 'chk', to: 'card', amount: usd('50.00'), date: '2026-01-05', desc: 'Card payment' });
  b.tx({ id: 'a5', account: 'card', date: '2026-01-06', desc: 'Grocery refund', amount: usd('10.00'), kind: 'expense', category: 'cat-groceries' });
  b.transfer({ id: 'xa6', legIds: ['a6a', 'a6b'], from: 'chk', to: 'sav', amount: usd('30.00'), date: '2026-01-07', desc: 'Move to savings' });
  return b.build();
}
export const CASE_A_EXPECTED = { chk: 140000, sav: 3000, card: -18000, netWorth: 125000, startNetWorth: 80000, income: 60000, netExpense: 15000 };

/** Case B - split accounting. */
export function caseB() {
  const b = new DatasetBuilder({ name: 'Case B - split accounting', kind: 'fixture', presetId: 'case-b', asOfDate: '2026-01-31' });
  cats(b);
  b.account('chk', { name: 'Checking', type: 'checking', opening: usd('500.00'), openingDate: '2026-01-01' });
  b.tx({ id: 'b1', account: 'chk', date: '2026-01-10', desc: 'Fresh Fields', merchant: 'Fresh Fields', amount: -usd('47.35'), kind: 'expense', splits: [['cat-groceries', -usd('12.50')], ['cat-household', -usd('34.85')]] });
  return b.build();
}

/** Case D - reconciliation. Cleared: +1200.00, -300.00, -75.25; uncleared posted: -20.00. */
export function caseD() {
  const b = new DatasetBuilder({ name: 'Case D - reconciliation', kind: 'fixture', presetId: 'case-d', asOfDate: '2026-01-31' });
  cats(b);
  b.account('chk', { name: 'Checking', type: 'checking', opening: usd('500.00'), openingDate: '2026-01-01' });
  b.tx({ id: 'd1', account: 'chk', date: '2026-01-03', desc: 'Payroll', amount: usd('1200.00'), kind: 'income', category: 'cat-salary' });
  b.tx({ id: 'd2', account: 'chk', date: '2026-01-08', desc: 'Rent', amount: -usd('300.00'), kind: 'expense', category: 'cat-rent' });
  b.tx({ id: 'd3', account: 'chk', date: '2026-01-15', desc: 'Groceries', amount: -usd('75.25'), kind: 'expense', category: 'cat-groceries' });
  b.tx({ id: 'd4', account: 'chk', date: '2026-01-20', desc: 'Corner shop (not on statement)', amount: -usd('20.00'), kind: 'expense', category: 'cat-groceries' });
  return b.build();
}

/** Case E - rollover budget: $200/month base. Jan spend 150, Feb spend 280, March spend 0. Starts in December to test the year boundary. */
export function caseE({ janSpend = '150.00', febSpend = '280.00' } = {}) {
  const b = new DatasetBuilder({ name: 'Case E - rollover budgets', kind: 'fixture', presetId: 'case-e', asOfDate: '2026-03-31' });
  cats(b);
  b.account('chk', { name: 'Checking', type: 'checking', opening: usd('5000.00'), openingDate: '2025-11-01' });
  b.tx({ id: 'e1', account: 'chk', date: '2026-01-12', desc: 'Groceries January', amount: -usd(janSpend), kind: 'expense', category: 'cat-groceries' });
  b.tx({ id: 'e2', account: 'chk', date: '2026-02-12', desc: 'Groceries February', amount: -usd(febSpend), kind: 'expense', category: 'cat-groceries' });
  b.budget({ id: 'bud-g', category: 'cat-groceries', base: usd('200.00'), rollover: true, startMonth: '2026-01' });
  return b.build();
}

/** Case E2 - rollover crossing December into January. */
export function caseEYear() {
  const b = new DatasetBuilder({ name: 'Case E (year boundary)', kind: 'fixture', presetId: 'case-e-year', asOfDate: '2026-02-28' });
  cats(b);
  b.account('chk', { name: 'Checking', type: 'checking', opening: usd('5000.00'), openingDate: '2025-11-01' });
  b.tx({ id: 'ey1', account: 'chk', date: '2025-12-31', desc: 'Groceries Dec 31', amount: -usd('150.00'), kind: 'expense', category: 'cat-groceries' });
  b.tx({ id: 'ey2', account: 'chk', date: '2026-01-01', desc: 'Groceries Jan 1', amount: -usd('280.00'), kind: 'expense', category: 'cat-groceries' });
  b.budget({ id: 'bud-g', category: 'cat-groceries', base: usd('200.00'), rollover: true, startMonth: '2025-12' });
  return b.build();
}
