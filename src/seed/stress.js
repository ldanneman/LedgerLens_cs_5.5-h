/**
 * Deterministic stress dataset for the Test Lab: 20 accounts, 50 categories and ~2,000 transactions over
 * a year (monthly reporting stays responsive). No randomness beyond a fixed-seed generator.
 */
import { DatasetBuilder, usd } from './builder.js';
import { addDays, daysInMonth, makeDate } from '../domain/dates.js';

export function buildStressDataset({ accounts = 20, categories = 50, transactions = 2000 } = {}) {
  let s = 987654321;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const b = new DatasetBuilder({ name: `Stress dataset (${transactions.toLocaleString('en-US')} transactions)`, kind: 'preset', presetId: 'stress', description: 'Generated, deterministic.', asOfDate: '2026-10-01' });
  const income = [];
  const expense = [];
  for (let i = 0; i < categories; i += 1) {
    const kind = i < 6 ? 'income' : 'expense';
    const id = `cat-${String(i).padStart(2, '0')}`;
    b.category(id, `${kind === 'income' ? 'Income' : 'Expense'} category ${i + 1}`, kind, `Group ${i % 6}`);
    (kind === 'income' ? income : expense).push(id);
  }
  const assetIds = [];
  const cardIds = [];
  for (let i = 0; i < accounts; i += 1) {
    const type = i % 5 === 4 ? 'credit_card' : i % 5 === 3 ? 'savings' : i % 5 === 2 ? 'investment' : 'checking';
    const id = `acct-${String(i).padStart(2, '0')}`;
    b.account(id, { name: `Account ${i + 1}`, type, institution: `Bank ${(i % 4) + 1}`, opening: type === 'credit_card' ? -usd('500.00') : usd(`${5000 + i * 250}.00`), openingDate: '2025-09-01', limit: type === 'credit_card' ? usd('10000.00') : null, aprBps: type === 'credit_card' ? 1999 : type === 'savings' ? 350 : 0, dueDay: 15, payment: type === 'credit_card' ? usd('200.00') : null });
    (type === 'credit_card' ? cardIds : assetIds).push(id);
  }
  const start = '2025-09-01';
  for (let i = 0; i < transactions; i += 1) {
    const dayOffset = int(0, 395);
    const date = addDays(start, dayOffset);
    const r = rnd();
    if (r < 0.08) {
      const inc = income[int(0, income.length - 1)];
      b.tx({ account: assetIds[int(0, assetIds.length - 1)], date, desc: `Deposit ${i}`, merchant: `Employer ${int(1, 8)}`, amount: usd(`${int(500, 3500)}.${String(int(0, 99)).padStart(2, '0')}`), kind: 'income', category: inc });
    } else if (r < 0.14 && assetIds.length > 1) {
      const from = assetIds[int(0, assetIds.length - 1)];
      let to = assetIds[int(0, assetIds.length - 1)];
      if (to === from) to = assetIds[(assetIds.indexOf(from) + 1) % assetIds.length];
      b.transfer({ from, to, amount: usd(`${int(20, 800)}.00`), date, desc: `Transfer ${i}` });
    } else {
      const acct = rnd() < 0.35 ? cardIds[int(0, cardIds.length - 1)] : assetIds[int(0, assetIds.length - 1)];
      const cat = expense[int(0, expense.length - 1)];
      b.tx({ account: acct, date, desc: `Purchase ${i}`, merchant: `Merchant ${int(1, 60)}`, amount: -usd(`${int(2, 240)}.${String(int(0, 99)).padStart(2, '0')}`), kind: 'expense', category: cat, status: dayOffset > 392 ? 'pending' : 'posted' });
    }
  }
  b.budget({ id: 'bud-stress-1', category: expense[0], base: usd('300.00'), rollover: true, startMonth: '2025-09' });
  b.budget({ id: 'bud-stress-2', category: expense[1], base: usd('200.00'), startMonth: '2025-09' });
  b.goal({ id: 'goal-stress', name: 'Stress goal', target: usd('50000.00'), date: '2027-12-31', account: assetIds[3], allocation: { type: 'percent', value: 5000 } });
  void daysInMonth;
  void makeDate;
  return b.build();
}
