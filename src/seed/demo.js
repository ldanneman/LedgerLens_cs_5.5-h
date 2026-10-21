/**
 * The deterministic demo world: a fictional person ("Riley Chen") with ten accounts and ~13 months of
 * activity ending at the demo as-of date 2026-10-01. Everything is derived from a fixed PRNG seed and
 * fixed calendar rules, so reload/reset always produces the identical dataset.
 *
 * Derived items (loan interest/payments, card payments, card interest, savings interest, investment
 * valuation) are computed from the running ledger with the same rounding functions the app uses, so
 * loan balances follow a genuine amortization and card payments really equal the statement balance.
 */
import { DatasetBuilder, usd } from './builder.js';
import { monthlyInterest, applyBps } from '../domain/money.js';
import { addMonths, addDays, monthRange, monthEnd, daysInMonth, parseDate, makeDate } from '../domain/dates.js';
import { occurrencesBetween } from '../domain/recurring.js';
import { loanPayment } from '../domain/debt.js';
import { buildIndex, accountContribution } from '../domain/ledger.js';

export const DEMO_AS_OF = '2026-10-01';
export const DEMO_START = '2025-09-01';

/** mulberry32: tiny deterministic PRNG. */
function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  };
}

const CATEGORIES = [
  ['cat-rent', 'Rent', 'expense', 'Housing', '#6366f1'],
  ['cat-utilities', 'Utilities', 'expense', 'Housing', '#0ea5e9'],
  ['cat-household', 'Household Goods', 'expense', 'Housing', '#8b5cf6'],
  ['cat-insurance', 'Insurance', 'expense', 'Financial', '#64748b'],
  ['cat-interest', 'Interest & Fees', 'expense', 'Financial', '#ef4444'],
  ['cat-groceries', 'Groceries', 'expense', 'Food', '#16a34a'],
  ['cat-dining', 'Dining Out', 'expense', 'Food', '#f97316'],
  ['cat-coffee', 'Coffee & Cafes', 'expense', 'Food', '#a16207'],
  ['cat-fuel', 'Fuel', 'expense', 'Transport', '#eab308'],
  ['cat-transport', 'Rideshare & Transit', 'expense', 'Transport', '#14b8a6'],
  ['cat-auto', 'Auto Maintenance', 'expense', 'Transport', '#78716c'],
  ['cat-shopping', 'Shopping', 'expense', 'Lifestyle', '#ec4899'],
  ['cat-entertainment', 'Entertainment', 'expense', 'Lifestyle', '#d946ef'],
  ['cat-subscriptions', 'Subscriptions', 'expense', 'Lifestyle', '#06b6d4'],
  ['cat-fitness', 'Fitness', 'expense', 'Lifestyle', '#22c55e'],
  ['cat-medical', 'Medical', 'expense', 'Health', '#f43f5e'],
  ['cat-travel', 'Travel', 'expense', 'Travel', '#3b82f6'],
  ['cat-gifts', 'Gifts & Donations', 'expense', 'Personal', '#f59e0b'],
  ['cat-education', 'Education', 'expense', 'Personal', '#84cc16'],
  ['cat-salary', 'Salary', 'income', 'Income', '#15803d'],
  ['cat-freelance', 'Freelance', 'income', 'Income', '#0f766e'],
  ['cat-interest-income', 'Interest Income', 'income', 'Income', '#0891b2'],
  ['cat-other-income', 'Other Income', 'income', 'Income', '#65a30d'],
];

const A = {
  chk: 'acct-chk-main',
  side: 'acct-chk-side',
  sav: 'acct-sav-gen',
  emg: 'acct-sav-emg',
  rewards: 'acct-cc-rewards',
  travel: 'acct-cc-travel',
  inv: 'acct-inv',
  auto: 'acct-loan-auto',
  student: 'acct-loan-student',
  old: 'acct-sav-old',
};

/** Simulate a fixed-payment loan from its first payment up to (not including) `until`; returns the owed balance. */
function owedAtOpening(principal, aprBps, payment, firstPaymentDate, until) {
  let owed = principal;
  const day = parseDate(firstPaymentDate).d;
  for (let i = 0; i < 1000; i += 1) {
    const date = addMonths(firstPaymentDate, i, day);
    if (date >= until) break;
    const interest = monthlyInterest(owed, aprBps);
    owed = owed + interest - Math.min(payment, owed + interest);
  }
  return owed;
}

/** Build the full demo dataset. */
export function buildDemoDataset() {
  const rng = makeRng(0x1ed9e12);
  const b = new DatasetBuilder({
    name: 'Riley Chen - demo household (fictional)',
    kind: 'demo',
    presetId: 'demo',
    description: 'Deterministic fictional demo data: 10 accounts, 13 months of activity, as of 2026-10-01.',
    asOfDate: DEMO_AS_OF,
  });
  for (const c of CATEGORIES) b.category(...c);

  // ---- loans: payments derived from the standard annuity formula, opening owed from real amortization
  const autoTerms = { principal: usd('26500.00'), apr: 549, term: 60, start: '2024-03-15' };
  const autoPay = loanPayment(autoTerms.principal, autoTerms.apr, autoTerms.term);
  const autoOwed = owedAtOpening(autoTerms.principal, autoTerms.apr, autoPay, addMonths(autoTerms.start, 1), DEMO_START);
  const stuTerms = { principal: usd('18000.00'), apr: 499, term: 120, start: '2022-08-05' };
  const stuPay = loanPayment(stuTerms.principal, stuTerms.apr, stuTerms.term);
  const stuOwed = owedAtOpening(stuTerms.principal, stuTerms.apr, stuPay, addMonths(stuTerms.start, 1), DEMO_START);

  b.account(A.chk, { name: 'Harbor Everyday Checking', type: 'checking', institution: 'Harborview Credit Union', opening: usd('3850.00'), last4: '4821', color: '#0f766e' });
  b.account(A.side, { name: 'Side Hustle Checking', type: 'checking', institution: 'Northfield Bank', opening: usd('1120.00'), last4: '7730', color: '#0891b2' });
  b.account(A.sav, { name: 'Harbor High-Yield Savings', type: 'savings', institution: 'Harborview Credit Union', opening: usd('9200.00'), aprBps: 410, last4: '1144', color: '#16a34a' });
  b.account(A.emg, { name: 'Emergency Fund', type: 'savings', institution: 'Northfield Bank', opening: usd('11500.00'), aprBps: 385, last4: '9082', color: '#65a30d' });
  b.account(A.rewards, { name: 'Meridian Rewards Visa', type: 'credit_card', institution: 'Meridian Bank', opening: -usd('2640.00'), limit: usd('8000.00'), aprBps: 2299, payment: usd('600.00'), paymentMode: 'fixed', minPaymentBps: 100, minPaymentFloor: usd('35.00'), dueDay: 22, statementDay: 25, autopay: A.chk, last4: '3306', color: '#dc2626' });
  b.account(A.travel, { name: 'Summit Travel Mastercard', type: 'credit_card', institution: 'Summit Financial', opening: -usd('780.00'), limit: usd('15000.00'), aprBps: 1849, payment: 0, paymentMode: 'pay_in_full', minPaymentBps: 100, minPaymentFloor: usd('25.00'), dueDay: 14, statementDay: 11, autopay: A.chk, last4: '5519', color: '#7c3aed' });
  b.account(A.inv, { name: 'Lumen Brokerage', type: 'investment', institution: 'Lumen Investments', opening: usd('28400.00'), last4: '6620', color: '#2563eb' });
  b.account(A.auto, { name: 'Auto Loan - Corvane Sedan', type: 'auto_loan', institution: 'Corvane Financial', opening: -autoOwed, aprBps: autoTerms.apr, payment: autoPay, dueDay: 15, autopay: A.chk, loan: { originalPrincipalCents: autoTerms.principal, termMonths: autoTerms.term, startDate: autoTerms.start }, last4: '2208', color: '#b45309' });
  b.account(A.student, { name: 'Student Loan - Westbrook', type: 'student_loan', institution: 'Westbrook Servicing', opening: -stuOwed, aprBps: stuTerms.apr, payment: stuPay, dueDay: 5, autopay: A.chk, loan: { originalPrincipalCents: stuTerms.principal, termMonths: stuTerms.term, startDate: stuTerms.start }, last4: '8841', color: '#9a3412' });
  b.account(A.old, { name: 'Legacy Savings (closed)', type: 'savings', institution: 'First Prairie Bank', opening: usd('600.00'), status: 'archived', archivedDate: '2025-09-12', color: '#94a3b8', notes: 'Closed in September 2025; balance moved to checking.' });

  // ---- recurring rules ------------------------------------------------------------
  const _rules = {
    payroll: b.recurring({ id: 'rec-payroll', title: 'Nova Software payroll', kind: 'income', amount: usd('2684.12'), account: A.chk, category: 'cat-salary', merchant: 'Nova Software Payroll', start: '2025-09-05', interval: 'biweekly', group: 'income' }),
    freelance: b.recurring({ id: 'rec-freelance', title: 'Kestrel Design retainer', kind: 'income', amount: usd('850.00'), account: A.side, category: 'cat-freelance', merchant: 'Kestrel Design Co', start: '2025-09-20', interval: 'monthly', group: 'income', businessDay: 'prev' }),
    rent: b.recurring({ id: 'rec-rent', title: 'Rent - Landmark Properties', kind: 'expense', amount: usd('1725.00'), account: A.chk, category: 'cat-rent', merchant: 'Landmark Properties', start: '2025-09-01', interval: 'monthly', group: 'bill' }),
    carIns: b.recurring({ id: 'rec-carins', title: 'Shield Auto Insurance', kind: 'expense', amount: usd('142.60'), account: A.chk, category: 'cat-insurance', merchant: 'Shield Auto Insurance', start: '2025-09-08', interval: 'monthly', group: 'bill', businessDay: 'next' }),
    electric: b.recurring({ id: 'rec-electric', title: 'Cascade Electric', kind: 'expense', amount: usd('118.00'), account: A.chk, category: 'cat-utilities', merchant: 'Cascade Electric', start: '2025-09-12', interval: 'monthly', group: 'bill', businessDay: 'next', notes: 'Amount varies with usage; the rule holds a typical bill.' }),
    water: b.recurring({ id: 'rec-water', title: 'Clearwater Utilities', kind: 'expense', amount: usd('48.00'), account: A.chk, category: 'cat-utilities', merchant: 'Clearwater Utilities', start: '2025-09-25', interval: 'quarterly', group: 'bill' }),
    internet: b.recurring({ id: 'rec-internet', title: 'BrightNet Internet', kind: 'expense', amount: usd('79.99'), account: A.chk, category: 'cat-utilities', merchant: 'BrightNet Internet', start: '2025-09-17', interval: 'monthly', group: 'bill' }),
    mobile: b.recurring({ id: 'rec-mobile', title: 'Pulse Mobile', kind: 'expense', amount: usd('64.00'), account: A.rewards, category: 'cat-utilities', merchant: 'Pulse Mobile', start: '2025-09-21', interval: 'monthly', group: 'bill' }),
    stream: b.recurring({ id: 'rec-stream', title: 'StreamBox', kind: 'expense', amount: usd('15.49'), account: A.rewards, category: 'cat-subscriptions', merchant: 'StreamBox', start: '2025-09-03', interval: 'monthly', group: 'subscription' }),
    music: b.recurring({ id: 'rec-music', title: 'Tunewave Music', kind: 'expense', amount: usd('10.99'), account: A.rewards, category: 'cat-subscriptions', merchant: 'Tunewave Music', start: '2025-09-09', interval: 'monthly', group: 'subscription' }),
    gym: b.recurring({ id: 'rec-gym', title: 'FitPoint Gym', kind: 'expense', amount: usd('39.00'), account: A.chk, category: 'cat-fitness', merchant: 'FitPoint Gym', start: '2025-09-02', interval: 'monthly', group: 'subscription' }),
    books: b.recurring({ id: 'rec-books', title: 'Pagebound Books annual membership', kind: 'expense', amount: usd('59.00'), account: A.travel, category: 'cat-subscriptions', merchant: 'Pagebound Books', start: '2025-03-14', interval: 'yearly', group: 'subscription' }),
    forge: b.recurring({ id: 'rec-forge', title: 'Pixelforge design tools', kind: 'expense', amount: usd('19.99'), account: A.side, category: 'cat-subscriptions', merchant: 'Pixelforge Tools', start: '2025-09-14', interval: 'monthly', group: 'subscription' }),
    saveGen: b.recurring({ id: 'rec-save-gen', title: 'Auto-save to High-Yield Savings', kind: 'transfer', amount: usd('600.00'), account: A.chk, to: A.sav, start: '2025-09-06', interval: 'monthly', group: 'transfer' }),
    saveEmg: b.recurring({ id: 'rec-save-emg', title: 'Auto-save to Emergency Fund', kind: 'transfer', amount: usd('300.00'), account: A.chk, to: A.emg, start: '2025-09-06', interval: 'monthly', group: 'transfer' }),
    invest: b.recurring({ id: 'rec-invest', title: 'Brokerage contribution', kind: 'transfer', amount: usd('500.00'), account: A.chk, to: A.inv, start: '2025-09-07', interval: 'monthly', group: 'transfer', businessDay: 'next' }),
    sideSweep: b.recurring({ id: 'rec-sweep', title: 'Sweep side income to checking', kind: 'transfer', amount: usd('500.00'), account: A.side, to: A.chk, start: '2025-09-22', interval: 'monthly', group: 'transfer', businessDay: 'next' }),
  };
  void _rules;

  // ---- draft collection (ids are assigned after sorting by date) -----------------------
  const drafts = [];
  const contrib = []; // {account, date, cents} for balance lookups during generation
  const open = new Map(b.d.accounts.map((a) => [a.id, a.openingCents]));
  const bal = (acct, date) => contrib.reduce((s, c) => (c.account === acct && c.date <= date ? s + c.cents : s), open.get(acct));
  let ord = 0;
  const pushTx = (spec, order = 2) => {
    drafts.push({ type: 'tx', date: spec.date, order, seq: (ord += 1), spec });
    contrib.push({ account: spec.account, date: spec.date, cents: spec.amount });
  };
  const pushXfer = (spec, order = 3) => {
    drafts.push({ type: 'xfer', date: spec.date, order, seq: (ord += 1), spec });
    contrib.push({ account: spec.from, date: spec.date, cents: -spec.amount }, { account: spec.to, date: spec.date, cents: spec.amount });
  };
  const exp = (account, date, merchant, amount, category, extra = {}) =>
    pushTx({ account, date, desc: merchant, merchant, amount: -amount, kind: 'expense', category, catSource: category ? 'rule' : null, ...extra });
  const inc = (account, date, merchant, amount, category, extra = {}) =>
    pushTx({ account, date, desc: merchant, merchant, amount, kind: 'income', category, catSource: 'rule', ...extra }, 1);

  const months = monthRange('2025-09', '2026-10');

  // ---- recurring-rule driven items
  const variableAmount = (id, occ) => {
    if (id === 'rec-electric') {
      const m = Number(occ.scheduled.slice(5, 7));
      const season = [6, 7, 8].includes(m) ? 3400 : [12, 1, 2].includes(m) ? 2600 : 0;
      return usd('96.00') + season + rng.int(0, 2400);
    }
    return null;
  };
  for (const rule of b.d.recurring) {
    for (const occ of occurrencesBetween({ ...rule, skipped: [] }, DEMO_START, DEMO_AS_OF)) {
      if (occ.date > DEMO_AS_OF) continue;
      const recurrence = { ruleId: rule.id, occurrence: occ.scheduled };
      const amount = variableAmount(rule.id, occ) ?? rule.amountCents;
      if (rule.kind === 'income') {
        inc(rule.accountId, occ.date, rule.merchant, amount, rule.categoryId, { recurrence, desc: rule.title });
      } else if (rule.kind === 'expense') {
        const late = rule.id === 'rec-electric' && rng.chance(0.25) ? 1 : 0; // some bills post a day late
        exp(rule.accountId, addDays(occ.date, late), rule.merchant, amount, rule.categoryId, { recurrence, desc: rule.title });
      } else {
        pushXfer({ from: rule.accountId, to: rule.toAccountId, amount, date: occ.date, desc: rule.title, recurrence });
      }
    }
  }

  // ---- everyday spending
  const inMonth = (m, day) => makeDate(+m.slice(0, 4), +m.slice(5, 7), Math.min(day, daysInMonth(+m.slice(0, 4), +m.slice(5, 7))));
  const dayIn = (m) => inMonth(m, rng.int(1, 28));
  const buy = (acct, m, merchant, lo, hi, cat, tags) => {
    const date = dayIn(m);
    if (date > DEMO_AS_OF) return;
    exp(acct, date, merchant, rng.int(lo, hi), cat, { tags: tags || [] });
  };
  for (const m of months) {
    for (let i = 0; i < rng.int(7, 9); i += 1) buy(rng.chance(0.3) ? A.rewards : A.chk, m, rng.pick(['Green Basket Market', 'Fresh Fields Grocery']), 3400, 11800, 'cat-groceries');
    for (let i = 0; i < rng.int(6, 8); i += 1) buy(rng.chance(0.6) ? A.travel : A.chk, m, rng.pick(['Ember & Oak Bistro', 'Taqueria Sol', 'Noodle House 88']), 1400, 9600, 'cat-dining');
    for (let i = 0; i < rng.int(7, 10); i += 1) buy(A.chk, m, rng.pick(['Corner Bean Coffee', 'Brewline Cafe']), 375, 780, 'cat-coffee');
    for (let i = 0; i < 3; i += 1) buy(A.rewards, m, rng.pick(['Volt Fuel', 'QuickFill Gas']), 4100, 6300, 'cat-fuel');
    for (let i = 0; i < 2; i += 1) buy(A.chk, m, rng.pick(['MetroGo Transit', 'Ride-Ez']), 1100, 2700, 'cat-transport');
    for (let i = 0; i < rng.int(2, 3); i += 1) buy(A.travel, m, rng.pick(['Urban Threads', 'Gadget Garden']), 3800, 14200, 'cat-shopping');
    buy(A.chk, m, 'HomeNest Supply', 2400, 11800, 'cat-household');
    for (let i = 0; i < rng.int(1, 2); i += 1) buy(A.rewards, m, 'Lumina Cinemas', 1300, 3800, 'cat-entertainment');
    if (rng.chance(0.7)) buy(A.chk, m, 'Maple Pharmacy', 1200, 5800, 'cat-medical');
    // side-hustle expenses (imported-style account)
    buy(A.side, m, 'Studio Supply Co', 1800, 7400, 'cat-shopping', ['business']);
  }

  // ---- notable one-offs (boundaries, splits, identical purchases, refunds, adjustments)
  // refunds are expenses with a positive effect (they REDUCE net spending of the category)
  const refund = (account, date, merchant, amount, category, desc) =>
    pushTx({ account, date, desc, merchant, amount, kind: 'expense', category, catSource: 'rule', tags: ['refund'] }, 2);
  inc(A.chk, '2025-12-31', 'Nova Software Payroll', usd('1200.00'), 'cat-salary', { desc: 'Year-end bonus', tags: ['bonus'] });
  exp(A.chk, '2026-01-01', 'FitPoint Gym', usd('25.00'), 'cat-fitness', { desc: 'New-year joiner fee' });
  exp(A.chk, '2026-02-28', 'Green Basket Market', usd('64.18'), 'cat-groceries');
  exp(A.chk, '2026-02-14', 'Ember & Oak Bistro', usd('118.40'), 'cat-dining', { desc: "Valentine's dinner" });
  exp(A.travel, '2025-12-14', 'Skylark Airlines', usd('612.40'), 'cat-travel', { desc: 'Skylark Airlines - holiday flights', tags: ['trip-2025-12'] });
  exp(A.travel, '2025-12-18', 'Wayfarer Hotels', usd('742.15'), 'cat-travel', { desc: 'Wayfarer Hotels - 4 nights', tags: ['trip-2025-12'] });
  refund(A.travel, '2026-01-08', 'Skylark Airlines', usd('48.00'), 'cat-travel', 'Skylark Airlines - baggage fee refund');
  exp(A.travel, '2026-07-19', 'Skylark Airlines', usd('388.60'), 'cat-travel', { desc: 'Skylark Airlines - summer trip', tags: ['trip-2026-07'] });
  exp(A.travel, '2026-07-21', 'Wayfarer Hotels', usd('514.30'), 'cat-travel', { desc: 'Wayfarer Hotels - 3 nights', tags: ['trip-2026-07'] });
  exp(A.rewards, '2025-12-10', 'Giftly', usd('86.20'), 'cat-gifts', { desc: 'Giftly - holiday gifts' });
  exp(A.rewards, '2025-12-12', 'Giftly', usd('54.95'), 'cat-gifts', { desc: 'Giftly - holiday gifts' });
  exp(A.travel, '2026-02-04', 'Brightway Learning', usd('199.00'), 'cat-education', { desc: 'Brightway Learning - data course' });
  exp(A.rewards, '2025-11-06', 'Corvane Service Center', usd('286.50'), 'cat-auto', { desc: 'Corvane Service Center - 30k service' });
  exp(A.travel, '2026-04-18', 'Corvane Service Center', usd('412.20'), 'cat-auto', { desc: 'Corvane Service Center - brakes' });
  exp(A.chk, '2026-09-12', 'Corvane Service Center', usd('119.99'), 'cat-auto', { desc: 'Corvane Service Center - tires rotate' });
  exp(A.chk, '2026-01-22', 'Riverside Medical', usd('85.00'), 'cat-medical', { desc: 'Riverside Medical - copay' });
  exp(A.chk, '2026-07-30', 'Riverside Medical', usd('140.00'), 'cat-medical', { desc: 'Riverside Medical - specialist visit', notes: 'Submit to insurance for reimbursement', tags: ['reimbursable'] });
  inc(A.chk, '2026-03-27', 'State Revenue Dept', usd('1134.00'), 'cat-other-income', { desc: 'State tax refund' });
  refund(A.travel, '2026-02-10', 'Urban Threads', usd('64.20'), 'cat-shopping', 'Urban Threads - return');
  refund(A.travel, '2026-04-22', 'Gadget Garden', usd('129.00'), 'cat-shopping', 'Gadget Garden - refund');
  refund(A.chk, '2026-05-19', 'Fresh Fields Grocery', usd('12.40'), 'cat-groceries', 'Fresh Fields Grocery - price adjustment refund');
  // splits
  const split = (account, date, merchant, parts, tags = []) => {
    const total = parts.reduce((s, p) => s + p[1], 0);
    pushTx({ account, date, desc: merchant, merchant, amount: -total, kind: 'expense', splits: parts.map(([c, v]) => [c, -v]), catSource: 'manual', tags }, 2);
  };
  split(A.chk, '2026-05-17', 'Fresh Fields Grocery', [['cat-groceries', usd('12.50')], ['cat-household', usd('34.85')]]);
  split(A.rewards, '2025-11-23', 'Green Basket Market', [['cat-groceries', usd('142.10')], ['cat-household', usd('41.37')]]);
  split(A.travel, '2026-03-08', 'HomeNest Supply', [['cat-household', usd('198.00')], ['cat-shopping', usd('74.84')], ['cat-fitness', usd('40.00')]]);
  split(A.chk, '2026-06-21', 'Maple Pharmacy', [['cat-medical', usd('41.80')], ['cat-household', usd('16.50')]]);
  split(A.travel, '2026-08-30', 'Gadget Garden', [['cat-shopping', usd('149.99')], ['cat-entertainment', usd('97.36')]]);
  // identical-looking but legitimately separate purchases
  exp(A.chk, '2026-04-04', 'Green Basket Market', usd('23.10'), 'cat-groceries', { desc: 'Green Basket Market' });
  exp(A.chk, '2026-04-04', 'Green Basket Market', usd('23.10'), 'cat-groceries', { desc: 'Green Basket Market' });
  exp(A.travel, '2026-08-14', 'Corner Bean Coffee', usd('4.75'), 'cat-coffee', { desc: 'Corner Bean Coffee', ext: 'TRV-20260814-0412' });
  exp(A.travel, '2026-08-14', 'Corner Bean Coffee', usd('4.75'), 'cat-coffee', { desc: 'Corner Bean Coffee', ext: 'TRV-20260814-0413' });
  // uncategorized oddities rules do not recognise
  for (const [date, desc, amt] of [['2025-10-09', 'SQ *MARKET STALL 4412', '18.50'], ['2025-11-30', 'POS DEBIT 0093 CHECKCARD', '42.00'], ['2026-01-17', 'ACH WITHDRAWAL 88213', '75.00'], ['2026-03-02', 'SQ *POPUP BAKERY', '12.25'], ['2026-05-26', 'PAYPAL *4029357733', '33.99'], ['2026-06-03', 'CHECKCARD 0612 SERVICES', '27.10'], ['2026-08-09', 'SQ *FARMERS MKT STAND', '21.00'], ['2026-09-21', 'AMZN MKTP PURCHASE', '56.42']]) {
    pushTx({ account: A.chk, date, desc, merchant: '', amount: -usd(amt), kind: 'expense', category: null, catSource: null }, 2);
  }
  // a rule-miscategorized purchase the user corrected by hand
  exp(A.rewards, '2026-06-09', 'Ride-Ez', usd('31.80'), 'cat-travel', { desc: 'Ride-Ez - airport', catSource: 'manual' });
  // adjustment (non-cash correction) and an external transfer
  pushTx({ account: A.side, date: '2026-08-02', desc: 'Bank fee correction', merchant: '', amount: -usd('2.00'), kind: 'adjustment', adjustmentKind: 'correction', category: null, catSource: null, notes: 'Matches bank statement correction notice.' }, 6);
  drafts.push({ type: 'ext', date: '2026-06-18', order: 3, seq: (ord += 1), spec: { account: A.chk, amount: -usd('150.00'), date: '2026-06-18', counterparty: "Sibling's account", desc: 'Gift to sibling (outside account)' } });
  contrib.push({ account: A.chk, date: '2026-06-18', cents: -usd('150.00') });
  // close the legacy account
  pushXfer({ from: A.old, to: A.chk, amount: usd('600.00'), date: '2025-09-12', desc: 'Close account - move balance', fromDesc: 'Closing transfer to Harbor Everyday Checking', toDesc: 'Closing transfer from Legacy Savings' }, 3);

  // ---- derived items computed against the running ledger ------------------------------
  for (const m of months) {
    const dueDate = (acct, day) => inMonth(m, day);
    // student loan (5th) and auto loan (15th): interest charge, then payment
    for (const [loanId, day, pay] of [[A.student, 5, stuPay], [A.auto, 15, autoPay]]) {
      const date = dueDate(loanId, day);
      if (date < '2025-09-05' || date > DEMO_AS_OF) continue;
      const owed = -bal(loanId, date);
      if (owed <= 0) continue;
      const acct = b.d.accounts.find((a) => a.id === loanId);
      const interest = monthlyInterest(owed, acct.aprBps);
      pushTx({ account: loanId, date, desc: 'Interest charge', merchant: acct.institution, amount: -interest, kind: 'expense', category: 'cat-interest', catSource: 'rule' }, 4);
      const payment = Math.min(pay, owed + interest);
      pushXfer({ from: A.chk, to: loanId, amount: payment, date, desc: `Loan payment - ${acct.name}`, fromDesc: `Loan payment to ${acct.name}`, toDesc: 'Payment received - thank you' }, 5);
    }
    // travel card: pay the statement balance (as of the 11th) in full on the 14th
    {
      const date = dueDate(A.travel, 14);
      if (date <= DEMO_AS_OF) {
        const owed = -bal(A.travel, dueDate(A.travel, 11));
        if (owed > 0) pushXfer({ from: A.chk, to: A.travel, amount: owed, date, desc: 'Card payment - statement balance', fromDesc: 'Payment to Summit Travel Mastercard', toDesc: 'Payment received - thank you' }, 5);
      }
    }
    // rewards card: fixed payment on the 22nd, interest on the 25th statement
    {
      const date = dueDate(A.rewards, 22);
      if (date <= DEMO_AS_OF) {
        const owed = -bal(A.rewards, date);
        if (owed > 0) pushXfer({ from: A.chk, to: A.rewards, amount: Math.min(usd('600.00'), owed), date, desc: 'Card payment', fromDesc: 'Payment to Meridian Rewards Visa', toDesc: 'Payment received - thank you' }, 5);
      }
      const stmt = dueDate(A.rewards, 25);
      if (stmt <= DEMO_AS_OF) {
        const owed = -bal(A.rewards, stmt);
        const interest = monthlyInterest(owed, 2299);
        if (interest > 0) pushTx({ account: A.rewards, date: stmt, desc: 'Purchase interest charge', merchant: 'Meridian Bank', amount: -interest, kind: 'expense', category: 'cat-interest', catSource: 'rule' }, 4);
      }
    }
    // month-end: savings interest income, investment valuation adjustment
    const eom = monthEnd(m);
    if (eom <= DEMO_AS_OF) {
      for (const [id, apr, name] of [[A.sav, 410, 'Harbor High-Yield Savings'], [A.emg, 385, 'Emergency Fund']]) {
        const interest = monthlyInterest(bal(id, eom), apr);
        if (interest > 0) pushTx({ account: id, date: eom, desc: 'Interest paid', merchant: name, amount: interest, kind: 'income', category: 'cat-interest-income', catSource: 'rule' }, 6);
      }
      const bps = rng.int(-240, 330);
      const val = applyBps(bal(A.inv, eom), bps);
      if (val !== 0) pushTx({ account: A.inv, date: eom, desc: 'Market value adjustment', merchant: '', amount: val, kind: 'adjustment', adjustmentKind: 'valuation', category: null, catSource: null }, 7);
    }
  }

  // ---- emit in date order so ids are chronological -------------------------------------
  drafts.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.order - y.order || x.seq - y.seq));
  const importedBatches = { [A.side]: [], [A.travel]: [] };
  let extSeq = 0;
  const importedAt = '2026-09-30T18:00:00.000Z';
  for (const dft of drafts) {
    const s = dft.spec;
    if (dft.type === 'xfer') {
      b.transfer({ from: s.from, to: s.to, amount: s.amount, date: s.date, desc: s.desc, fromDesc: s.fromDesc, toDesc: s.toDesc, recurrence: s.recurrence || null });
    } else if (dft.type === 'ext') {
      b.external({ account: s.account, amount: s.amount, date: s.date, counterparty: s.counterparty, desc: s.desc });
    } else {
      const isImportAcct = (s.account === A.side || s.account === A.travel) && (s.kind === 'income' || s.kind === 'expense') && s.date >= '2026-01-01';
      let source = { type: 'seed', batchId: null, externalId: null, importedAt: null, rawDescription: null };
      let catSource = s.catSource;
      if (isImportAcct) {
        extSeq += 1;
        source = { type: 'import', batchId: s.account === A.side ? 'batch-seed-side' : 'batch-seed-travel', externalId: s.ext || `${s.account === A.side ? 'NF' : 'TRV'}-${s.date.replace(/-/g, '')}-${String(extSeq).padStart(4, '0')}`, importedAt, rawDescription: String(s.desc).toUpperCase() };
        if (catSource === 'rule') catSource = 'import';
      }
      const id = b.tx({ ...s, catSource, source });
      if (isImportAcct) importedBatches[s.account].push(id);
    }
  }
  b.batch({ id: 'batch-seed-side', account: A.side, fileName: 'northfield-2026-ytd.csv', importedAt, created: importedBatches[A.side] });
  b.batch({ id: 'batch-seed-travel', account: A.travel, fileName: 'summit-travel-2026-ytd.csv', importedAt, created: importedBatches[A.travel] });

  // ---- pending: the last three days of ordinary card/debit activity has not posted yet
  for (const t of b.d.transactions) {
    if (t.date >= '2026-09-29' && t.date <= DEMO_AS_OF && (t.kind === 'expense') && t.categoryId !== 'cat-interest') t.status = 'pending';
  }

  // ---- rules ------------------------------------------------------------------------------
  const rules = [
    ['Groceries', ['Green Basket', 'Fresh Fields'], 'cat-groceries', 10],
    ['Coffee shops', ['Corner Bean', 'Brewline'], 'cat-coffee', 10],
    ['Dining', ['Ember & Oak', 'Taqueria Sol', 'Noodle House'], 'cat-dining', 10],
    ['Fuel', ['Volt Fuel', 'QuickFill'], 'cat-fuel', 10],
    ['Rideshare & transit', ['MetroGo', 'Ride-Ez'], 'cat-transport', 20],
    ['Streaming & music', ['StreamBox', 'Tunewave', 'Pagebound'], 'cat-subscriptions', 10],
    ['Pharmacy & medical', ['Maple Pharmacy', 'Riverside Medical'], 'cat-medical', 10],
    ['Airlines & hotels', ['Skylark', 'Wayfarer'], 'cat-travel', 10],
    ['Shopping', ['Urban Threads', 'Gadget Garden'], 'cat-shopping', 30],
    ['Cinema', ['Lumina Cinemas'], 'cat-entertainment', 10],
    ['Auto service', ['Corvane Service'], 'cat-auto', 10],
    ['Household', ['HomeNest'], 'cat-household', 30],
  ];
  for (const [name, pats, category, priority] of rules) for (const p of pats) b.rule({ name: `${name}: ${p}`, pattern: p, category, priority, field: 'any', match: 'contains' });
  b.rule({ name: 'Freelance client', pattern: 'Kestrel', category: 'cat-freelance', priority: 10, field: 'merchant' });
  b.rule({ name: 'Interest charges', pattern: 'interest charge', category: 'cat-interest', priority: 5, field: 'description' });

  // ---- budgets ---------------------------------------------------------------------------
  b.budget({ id: 'bud-groceries', category: 'cat-groceries', base: usd('640.00'), rollover: true, overrides: [['2025-12', usd('720.00')]] });
  b.budget({ id: 'bud-dining', category: 'cat-dining', base: usd('320.00'), overrides: [['2025-12', usd('420.00')]] });
  b.budget({ id: 'bud-coffee', category: 'cat-coffee', base: usd('55.00') });
  b.budget({ id: 'bud-shopping', category: 'cat-shopping', base: usd('260.00'), rollover: true });
  b.budget({ id: 'bud-fuel', category: 'cat-fuel', base: usd('170.00') });
  b.budget({ id: 'bud-entertainment', category: 'cat-entertainment', base: usd('90.00') });
  b.budget({ id: 'bud-transport', category: 'cat-transport', base: usd('45.00') });
  b.budget({ id: 'bud-travel', category: 'cat-travel', base: usd('150.00'), enabled: false });

  // ---- goals -----------------------------------------------------------------------------
  b.goal({ id: 'goal-emergency', name: 'Emergency fund (6 months)', target: usd('18000.00'), date: '2027-06-30', account: A.emg, allocation: { type: 'full', value: 0 }, priority: 1, note: 'Counts the Emergency Fund balance up to the target.' });
  b.goal({ id: 'goal-trip', name: 'Spring trip fund', target: usd('4500.00'), date: '2027-04-01', account: A.sav, allocation: { type: 'fixed', value: usd('2200.00') }, priority: 2, note: 'Earmarks $2,200 of the High-Yield Savings balance.' });
  b.goal({ id: 'goal-home', name: 'Home down payment', target: usd('40000.00'), date: '2029-12-31', account: A.sav, allocation: { type: 'percent', value: 2500 }, priority: 3, note: 'Earmarks 25% of the balance left after higher-priority goals.' });
  b.goal({ id: 'goal-laptop', name: 'New laptop', target: usd('2400.00'), date: '2027-02-01', allocation: { type: 'manual', value: 0 }, contributions: [{ date: '2026-07-01', amountCents: usd('300.00'), note: 'Side-gig bonus' }, { date: '2026-09-01', amountCents: usd('250.00'), note: 'Set aside' }], priority: 4, note: 'Tracked manually (simulated contributions, not tied to an account).' });

  // ---- scenarios -------------------------------------------------------------------------
  b.scenario({
    id: 'scn-auto-extra',
    name: 'Pay the auto loan down faster',
    description: 'Add $300/month to the auto loan from November 2026.',
    horizonMonths: 36,
    changes: [{ id: 'chg-auto-extra', type: 'debt_payment', label: 'Extra $300/mo on auto loan', effectiveDate: '2026-11-01', mode: 'extra', amountCents: usd('300.00'), accountId: A.auto, enabled: true }],
  });
  b.scenario({
    id: 'scn-raise-save',
    name: 'Raise + bigger savings',
    description: '4% raise per paycheck from January 2027 and an extra $250/month to savings.',
    horizonMonths: 24,
    changes: [
      { id: 'chg-raise', type: 'income_change', label: '4% raise', effectiveDate: '2027-01-01', mode: 'percent', percentBps: 400, recurringId: 'rec-payroll', enabled: true },
      { id: 'chg-save', type: 'savings_change', label: '+$250/mo to savings', effectiveDate: '2027-01-01', fromAccountId: A.chk, toAccountId: A.sav, amountCents: usd('250.00'), day: 6, enabled: true },
    ],
  });

  // ---- reconciliations (computed from the generated ledger) --------------------------------
  const built = b.build();
  const idx = buildIndex(built);
  const stmt = (acct, start, end) => {
    const opening = accountContribution(idx, acct, addDays(start, -1), false);
    const closing = accountContribution(idx, acct, end, false);
    const items = (idx.txByAccount.get(acct) || []).filter((t) => t.status === 'posted' && t.date >= start && t.date <= end);
    return { opening, closing, items };
  };
  const completed = (id, acct, start, end, at) => {
    const s = stmt(acct, start, end);
    return { id, account: acct, start, end, opening: s.opening, closing: s.closing, cleared: s.items.map((t) => t.id), status: 'completed', createdAt: at, completedAt: at, calculated: s.closing, discrepancy: 0, snapshots: s.items.map((t) => ({ txId: t.id, amountCents: t.amountCents, date: t.date, status: 'posted', accountId: acct })), note: '' };
  };
  const recs = [
    completed('recon-chk-2026-07', A.chk, '2026-07-01', '2026-07-31', '2026-08-03T10:00:00.000Z'),
    completed('recon-chk-2026-08', A.chk, '2026-08-01', '2026-08-31', '2026-09-02T10:00:00.000Z'),
    completed('recon-travel-2026-08', A.travel, '2026-08-01', '2026-08-31', '2026-09-02T10:20:00.000Z'),
  ];
  const sep = stmt(A.chk, '2026-09-01', '2026-09-30');
  const partial = sep.items.slice(0, Math.max(1, sep.items.length - 4));
  const partialSum = partial.reduce((s, t) => s + t.amountCents, 0);
  recs.push({ id: 'recon-chk-2026-09-draft', account: A.chk, start: '2026-09-01', end: '2026-09-30', opening: sep.opening, closing: sep.closing, cleared: partial.map((t) => t.id), status: 'in_progress', createdAt: '2026-10-01T08:00:00.000Z', completedAt: null, calculated: sep.opening + partialSum, discrepancy: sep.closing - (sep.opening + partialSum), snapshots: [], note: 'Draft: last statement items not cleared yet.' });
  built.reconciliations = recs.map((r) => ({
    id: r.id,
    accountId: r.account,
    startDate: r.start,
    endDate: r.end,
    openingCents: r.opening,
    closingCents: r.closing,
    clearedTxIds: r.cleared,
    status: r.status,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    calculatedCents: r.calculated,
    discrepancyCents: r.discrepancy,
    snapshots: r.snapshots,
    adjustmentTxId: null,
    note: r.note,
  }));
  return built;
}
