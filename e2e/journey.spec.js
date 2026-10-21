import { test, expect } from '@playwright/test';
import { DatasetBuilder, usd } from '../src/seed/builder.js';
import { exportDatasetJson } from '../src/persistence/serialize.js';

const MAIN_KEY = 'ledgerlens:v1:workspace:main';
/** Pre-load a small, controlled workspace (only when none exists yet, so later reloads keep the user's edits). */
async function seedWorkspace(page, dataset, raw = null) {
  const value = raw ?? JSON.stringify({ format: 'ledgerlens-state', version: 1, savedAt: '2026-10-01T00:00:00.000Z', workspace: 'main', data: dataset });
  await page.addInitScript(([k, v]) => { if (!window.localStorage.getItem(k)) window.localStorage.setItem(k, v); }, [MAIN_KEY, value]);
}
const stored = (page) => page.evaluate((k) => window.localStorage.getItem(k), MAIN_KEY);
const storedData = async (page) => JSON.parse(await stored(page)).data;
/** Posted net worth at the as-of date, recomputed from the raw stored records (independent of the app's own code). */
const postedNetWorth = (d) => d.accounts.reduce((sum, a) => sum + (a.openingDate <= d.settings.asOfDate ? a.openingCents : 0), 0) + d.transactions.filter((t) => t.status === 'posted' && t.date <= d.settings.asOfDate).reduce((s, t) => s + t.amountCents, 0);

const go = (page, hash) => page.goto(`/#/${hash}`);
const dismissToasts = async (page) => {
  for (const b of await page.getByRole('button', { name: 'Dismiss notification' }).all()) await b.click().catch(() => {});
};
const money = (t) => Number(t.replace(/[^0-9.-]/g, '')) * (/^-|−/.test(t.trim()) ? 1 : 1);

test.describe('seeded demo and everyday workflows', () => {
  test('dashboard shows the seeded world, with chart numbers available as text', async ({ page }) => {
    await go(page, '');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByText('Riley Chen - demo household (fictional)').first()).toBeVisible();
    await expect(page.getByText('Net worth', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Spending by category/).first()).toBeVisible();
    await page.getByText('Show the numbers').first().click();
    await expect(page.getByRole('table').first()).toBeVisible();
  });

  test('filter, open a purchase, change its category', async ({ page }) => {
    await go(page, 'transactions');
    await page.getByLabel('Search').fill('Corner Bean');
    // the filter narrows the ledger: a non-empty subset is counted, and every listed row is a match
    const summary = page.getByText(/transactions · money in/);
    await expect(summary).toBeVisible();
    const counts = async () => {
      const m = (await summary.innerText()).match(/^([\d,]+) of ([\d,]+) transactions/);
      return { shown: Number(m[1].replace(/,/g, '')), total: Number(m[2].replace(/,/g, '')) };
    };
    await expect.poll(async () => (await counts()).shown).toBeLessThan((await counts()).total); // the search is applied (it is debounced)
    expect((await counts()).shown).toBeGreaterThan(0);
    const bodyRows = page.locator('tbody tr');
    await expect(bodyRows.first()).toContainText('Corner Bean');
    expect(await bodyRows.count()).toBe(await bodyRows.filter({ hasText: 'Corner Bean' }).count());
    const first = page.getByRole('button', { name: /^Edit Corner Bean Coffee$/ }).first();
    await first.click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('Category').selectOption({ label: 'Dining Out (Food)' });
    await dlg.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Transaction updated')).toBeVisible();
    await expect(page.getByRole('row', { name: /Corner Bean Coffee/ }).first()).toContainText('Dining Out');
  });

  test('create a split expense, a refund and a card payment without double counting', async ({ page }) => {
    await go(page, 'transactions');
    await page.getByRole('button', { name: 'Add split expense' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Account').selectOption({ label: 'Harbor Everyday Checking' });
    await dlg.getByLabel('Description').fill('E2E hardware store');
    await dlg.getByLabel('Amount', { exact: true }).fill('47.35');
    await dlg.getByLabel('Split 1 category').selectOption({ label: 'Groceries (Food)' });
    await dlg.getByLabel('Split 1 amount').fill('12.50');
    await dlg.getByLabel('Split 2 category').selectOption({ label: 'Household Goods (Housing)' });
    await dlg.getByLabel('Split 2 amount').fill('34.84');
    await expect(dlg.getByText(/left to allocate/)).toContainText('$0.01');
    await dlg.getByRole('button', { name: 'Add transaction' }).click();
    await expect(dlg.getByRole('alert').first()).toContainText(/exactly/i);
    await dlg.getByLabel('Split 2 amount').fill('34.85');
    await expect(dlg.getByText(/matches exactly/)).toBeVisible();
    await dlg.getByRole('button', { name: 'Add transaction' }).click();
    await expect(page.getByText('Transaction added')).toBeVisible();
    await dismissToasts(page);

    // refund on the travel card
    await page.getByRole('button', { name: 'Add transaction', exact: true }).click();
    const r = page.getByRole('dialog');
    await r.getByLabel('Type').selectOption('refund');
    await r.getByLabel('Account').selectOption({ label: 'Summit Travel Mastercard' });
    await r.getByLabel('Description').fill('E2E store refund');
    await r.getByLabel('Amount').fill('20.00');
    await r.getByLabel('Category').selectOption({ label: 'Shopping (Lifestyle)' });
    await r.getByRole('button', { name: 'Add transaction' }).click();
    await expect(page.getByText('Transaction added')).toBeVisible();
    await dismissToasts(page);

    // net worth must be unchanged by a card payment
    await go(page, '');
    const before = await page.locator('.stat', { hasText: 'Net worth' }).first().locator('.value').innerText();
    await go(page, 'transactions');
    await page.getByRole('button', { name: 'Transfer funds' }).click();
    const t = page.getByRole('dialog');
    await t.getByLabel('From account').selectOption({ label: 'Harbor Everyday Checking' });
    await t.getByLabel('To account').selectOption({ label: 'Meridian Rewards Visa' });
    await t.getByLabel('Amount').fill('100.00');
    await t.getByRole('button', { name: 'Record transfer' }).click();
    await expect(page.getByText('Transfer recorded')).toBeVisible();
    await go(page, '');
    const after = await page.locator('.stat', { hasText: 'Net worth' }).first().locator('.value').innerText();
    expect(after).toBe(before);
  });

  test('import a CSV, review duplicates, commit, then undo the batch', async ({ page }) => {
    await go(page, 'import');
    await page.getByLabel('Destination account').selectOption({ label: 'Harbor Everyday Checking' });
    await page.getByLabel('...or paste CSV text').fill('Date,Description,Amount,Reference\n2026-09-20,E2E Coffee,-4.75,E2E-1\n2026-09-20,E2E Coffee,-4.75,E2E-2\n2026-09-21,"E2E Shop, Main St",-12.00,E2E-3\n2026-02-30,Bad date,-1.00,E2E-4\n');
    await expect(page.getByText(/rows read/)).toBeVisible();
    await expect(page.getByText('1 rejected')).toBeVisible();
    await expect(page.getByText('3 to import')).toBeVisible();
    await page.getByRole('button', { name: /Commit import/ }).click();
    await expect(page.getByText('Import committed.')).toBeVisible();
    await dismissToasts(page);
    // reimport the same text: everything already imported
    await page.getByLabel('...or paste CSV text').fill('Date,Description,Amount,Reference\n2026-09-20,E2E Coffee,-4.75,E2E-1\n2026-09-20,E2E Coffee,-4.75,E2E-2\n');
    await expect(page.getByText('2 already imported')).toBeVisible();
    await expect(page.getByRole('button', { name: /Commit import/ })).toBeDisabled();
    // undo from history
    await go(page, 'import/history');
    await page.getByRole('row', { name: /pasted\.csv/ }).getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Undo batch' }).click();
    await expect(page.getByText('Import undone')).toBeVisible();
    await go(page, 'transactions');
    await page.getByLabel('Search').fill('E2E Coffee');
    await expect(page.getByText(/^0 of/)).toBeVisible();
  });

  test('reconcile: a deliberate mismatch blocks completion, fixing it allows it', async ({ page }) => {
    await go(page, 'import/reconcile?acct=acct-chk-side');
    const closing = page.getByLabel('Closing balance');
    const original = await closing.inputValue();
    await closing.fill((Number(original.replace(/,/g, '')) + 5).toFixed(2));
    await page.getByRole('button', { name: 'Clear all in period' }).click();
    await expect(page.getByTestId('discrepancy')).toContainText('+$5.00');
    await expect(page.getByRole('button', { name: 'Complete reconciliation' })).toBeDisabled();
    await expect(page.getByText('Finding the difference')).toBeVisible();
    await closing.fill(original);
    await expect(page.getByTestId('discrepancy')).toContainText('$0.00');
    await page.getByRole('button', { name: 'Complete reconciliation' }).click();
    await expect(page.getByText('Reconciliation completed')).toBeVisible();
    await expect(page.getByText(/Every cleared item still matches the ledger/)).toBeVisible();
  });

  test('budgets: editing a month recalculates the rollover chain', async ({ page }) => {
    await go(page, 'budgets/cat-groceries?month=2026-09');
    await expect(page.getByRole('heading', { name: 'Groceries budget' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Groceries by month' })).toBeVisible();
    await go(page, 'budgets?month=2026-09');
    const row = page.getByRole('row', { name: /Groceries/ }).first();
    const before = await row.innerText();
    await row.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('dialog').getByLabel('Monthly amount').fill('900.00');
    await page.getByRole('dialog').getByRole('button', { name: 'Save budget' }).click();
    await expect(page.getByText('Budget saved')).toBeVisible();
    expect(await page.getByRole('row', { name: /Groceries/ }).first().innerText()).not.toBe(before);
  });

  test('recurring: add a bill and mark an occurrence paid', async ({ page }) => {
    await go(page, 'recurring');
    await page.getByRole('button', { name: 'Add recurring item' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Title').fill('E2E Gym Plus');
    await d.getByLabel('Amount each time').fill('25.00');
    await d.getByLabel('First date').fill('2026-10-05');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Recurring item saved')).toBeVisible();
    await dismissToasts(page);
    const row = page.getByRole('row', { name: /E2E Gym Plus/ }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /Mark paid/ }).click();
    await expect(page.getByText('E2E Gym Plus recorded')).toBeVisible();
  });

  test('scenario planner: an extra loan payment is compared with the baseline, a duplicate shows no differences', async ({ page }) => {
    await go(page, 'planner/scn-auto-extra');
    await expect(page.getByText(/Differences begin in/)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Debt outcomes' })).toContainText('sooner');
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await expect(page.getByText('Scenario duplicated')).toBeVisible();
    await page.getByLabel('Compare this scenario with').selectOption({ label: 'Saved scenario: Pay the auto loan down faster' });
    await expect(page.getByText('No differences.')).toBeVisible();
  });

  test('test lab: load a preset, verify, and reject an invalid JSON edit', async ({ page }) => {
    await go(page, 'lab/presets');
    await page.getByRole('button', { name: /Load into sandbox/ }).first().click();
    await go(page, 'lab/verify');
    await expect(page.getByText('No errors.')).toBeVisible();
    await go(page, 'lab/edit');
    const ta = page.getByLabel('Dataset JSON');
    const json = JSON.parse(await ta.inputValue());
    json.transactions[0].date = '2026-02-30';
    await ta.fill(JSON.stringify(json));
    await page.getByRole('button', { name: 'Validate and apply' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /blocking problem/ }).first()).toBeVisible();
    await expect(page.getByText('not a valid calendar date').first()).toBeVisible();
    await go(page, 'lab/verify');
    await expect(page.getByText('No errors.')).toBeVisible(); // sandbox kept its last valid state
  });

  test('edits survive a reload and sandbox data never leaks into My finances', async ({ page }) => {
    await go(page, 'transactions');
    await page.getByRole('button', { name: 'Add transaction', exact: true }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Description').fill('E2E persisted purchase');
    await d.getByLabel('Amount').fill('9.99');
    await d.getByRole('button', { name: 'Add transaction' }).click();
    await expect(page.getByText('Transaction added')).toBeVisible();
    await page.reload();
    await go(page, 'transactions');
    await page.getByLabel('Search').fill('E2E persisted');
    await expect(page.getByText('E2E persisted purchase').first()).toBeVisible();
    await go(page, 'lab/presets');
    await page.getByRole('button', { name: /Load into sandbox/ }).first().click();
    await go(page, 'transactions');
    await page.getByLabel('Search').fill('E2E persisted');
    await expect(page.getByText('E2E persisted purchase').first()).toBeVisible();
  });

  test('keyboard: skip link, Escape closes dialogs, focus returns', async ({ page }) => {
    await go(page, 'transactions');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    const add = page.getByRole('button', { name: 'Add transaction', exact: true });
    await add.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(add).toBeFocused();
  });
});

test.describe('review remediation: controlled ledgers, saved and reloaded', () => {
  const small = () => {
    const b = new DatasetBuilder({ name: 'Controlled ledger', asOfDate: '2026-01-31' });
    b.category('cat-food', 'Food', 'expense');
    b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-01-01' });
    b.tx({ id: 'c1', account: 'chk', date: '2026-01-05', desc: 'Corner Bean Coffee', amount: -475, kind: 'expense', category: 'cat-food' });
    b.tx({ id: 'c2', account: 'chk', date: '2026-01-06', desc: 'Corner Bean Coffee', amount: -525, kind: 'expense', category: 'cat-food' });
    b.tx({ id: 'g1', account: 'chk', date: '2026-01-07', desc: 'Green Basket Market', amount: -5420, kind: 'expense', category: 'cat-food' });
    b.tx({ id: 'p1', account: 'chk', date: '2026-01-08', desc: 'Payroll deposit', amount: 268412, kind: 'income' });
    return b.build();
  };
  const pendingPayment = () => {
    const b = new DatasetBuilder({ name: 'Pending card payment', asOfDate: '2026-01-31' });
    b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-01-01' });
    b.account('card', { name: 'Card', type: 'credit_card', opening: 0, openingDate: '2026-01-01' });
    b.transfer({ id: 'xr1', legIds: ['r1a', 'r1b'], from: 'chk', to: 'card', amount: usd('50.00'), date: '2026-01-10', status: 'pending', desc: 'Card payment' });
    return b.build();
  };

  test('search filters a small ledger: matches shown, a known non-match absent, count and money-in/out reflect only the matches', async ({ page }) => {
    await seedWorkspace(page, small());
    await go(page, 'transactions');
    await expect(page.getByText(/^4 of 4 transactions/)).toBeVisible();
    await page.getByLabel('Search').fill('Corner Bean');
    await expect(page.getByText(/^2 of 4 transactions/)).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.getByRole('row', { name: /Corner Bean Coffee/ })).toHaveCount(2);
    await expect(page.getByRole('row', { name: /Green Basket Market/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Payroll deposit/ })).toHaveCount(0);
    await expect(page.getByText(/money out/)).toContainText('-$10.00'); // 4.75 + 5.25, nothing from the unmatched rows
    await expect(page.getByText(/money in/)).toContainText('$0.00');
  });

  test('R1: marking ONE leg of a pending card payment posted posts both, keeps posted net worth at $1,000.00, and survives reload', async ({ page }) => {
    await seedWorkspace(page, pendingPayment());
    await go(page, 'transactions');
    await page.getByLabel('Select row r1a').check();
    await page.getByRole('button', { name: 'Mark posted' }).click();
    await expect(page.getByText(/other side/i).first()).toBeVisible();
    await page.reload();
    const d = await storedData(page);
    expect(d.transactions.map((t) => [t.id, t.status])).toEqual([['r1a', 'posted'], ['r1b', 'posted']]);
    expect(postedNetWorth(d)).toBe(100000);
    await go(page, '');
    await expect(page.locator('.stat', { hasText: 'Net worth' }).first().locator('.value')).toContainText('$1,000.00');
  });

  test('R2: a posted row with a different reference stays a separate purchase through commit and reload; reimport adds nothing', async ({ page }) => {
    const b = new DatasetBuilder({ name: 'R2', asOfDate: '2026-09-30' });
    b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-09-01' });
    b.tx({ id: 'p1', account: 'chk', date: '2026-09-15', desc: 'Review Coffee', merchant: 'Review Coffee', amount: -475, kind: 'expense', status: 'pending', source: { type: 'import', batchId: null, externalId: 'P1', importedAt: null, rawDescription: null } });
    await seedWorkspace(page, b.build());
    const csv = 'Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P2\n';
    await go(page, 'import');
    await page.getByLabel('Destination account').selectOption({ label: 'Checking' });
    await page.getByLabel('...or paste CSV text').fill(csv);
    await expect(page.getByText('1 to import')).toBeVisible();
    await expect(page.getByText('0 settle pending')).toBeVisible();
    await page.getByRole('button', { name: /Commit import/ }).click();
    await expect(page.getByText('Import committed.')).toBeVisible();
    await page.reload();
    const d = await storedData(page);
    expect(d.transactions.map((t) => [t.status, t.amountCents, t.source.externalId])).toEqual([['pending', -475, 'P1'], ['posted', -475, 'P2']]);
    await go(page, 'import');
    await page.getByLabel('Destination account').selectOption({ label: 'Checking' });
    await page.getByLabel('...or paste CSV text').fill(csv);
    await expect(page.getByText('1 already imported')).toBeVisible();
    await expect(page.getByRole('button', { name: /Commit import/ })).toBeDisabled();
    expect((await storedData(page)).transactions).toHaveLength(2);
  });

  test('R3/R4: tampered JSON uploads are refused with a reason and leave the saved workspace byte-for-byte unchanged', async ({ page }) => {
    await seedWorkspace(page, small());
    await go(page, 'settings');
    const before = await stored(page);
    const badSnapshot = JSON.parse(JSON.stringify(small()));
    badSnapshot.reconciliations.push({ id: 'bad-snapshot', accountId: 'chk', startDate: '2026-01-01', endDate: '2026-01-31', openingCents: 100000, closingCents: 100000, status: 'completed', discrepancyCents: 0, clearedTxIds: [], snapshots: [null] });
    await page.getByLabel('Choose a LedgerLens export file').setInputFiles({ name: 'bad-snapshot.json', mimeType: 'application/json', buffer: Buffer.from(exportDatasetJson(badSnapshot)) });
    await expect(page.getByText(/Not importable/)).toBeVisible();
    await expect(page.getByText(/snapshot #1 must be an object/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replace My finances with this file' })).toHaveCount(0);
    const badBatch = JSON.parse(JSON.stringify(small()));
    badBatch.importBatches.push({ id: 'batch-1', accountId: 'chk', status: 'committed', createdTxIds: ['c1'], settled: [] });
    await page.getByLabel('Choose a LedgerLens export file').setInputFiles({ name: 'bad-batch.json', mimeType: 'application/json', buffer: Buffer.from(exportDatasetJson(badBatch)) });
    await expect(page.getByText(/Undoing the batch would delete an unrelated record/)).toBeVisible();
    expect(await stored(page)).toBe(before);
    await page.reload();
    expect(await stored(page)).toBe(before);
  });

  test('R3: saved data with a malformed snapshot opens Recovery (no crash), keeps the raw text, and offers a backup-first restart', async ({ page }) => {
    const bad = JSON.parse(JSON.stringify(small()));
    bad.reconciliations.push({ id: 'bad-snapshot', accountId: 'chk', startDate: '2026-01-01', endDate: '2026-01-31', openingCents: 100000, closingCents: 100000, status: 'completed', discrepancyCents: 0, clearedTxIds: [], snapshots: [null] });
    const raw = JSON.stringify({ format: 'ledgerlens-state', version: 1, savedAt: 'x', workspace: 'main', data: bad });
    await seedWorkspace(page, null, raw);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await go(page, 'import/reconcile?acct=chk');
    await expect(page.getByRole('heading', { name: /could not read your saved data/i })).toBeVisible();
    expect(await stored(page)).toBe(raw);
    await page.getByRole('button', { name: 'Start with demo data' }).click();
    await expect(page.getByRole('heading', { name: 'Reconcile a statement' })).toBeVisible(); // the page we asked for, now loading demo data
    const backups = await page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.includes('corrupt-backup')).map((k) => window.localStorage.getItem(k)));
    expect(backups).toContain(raw);
    expect(errors).toEqual([]);
  });
});

test.describe('responsive layouts', () => {
  for (const [w, h] of [[390, 800], [320, 700]]) {
    test(`no horizontal page scroll and usable navigation at ${w}px`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      for (const route of ['', 'accounts', 'transactions', 'budgets', 'recurring', 'reports/cashflow', 'planner/scn-auto-extra', 'lab/verify', 'settings']) {
        await go(page, route);
        const o = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
        expect(o[0], `${route} at ${w}px`).toBeLessThanOrEqual(o[1] + 1);
      }
      await go(page, '');
      await page.getByRole('button', { name: 'Open navigation menu' }).click();
      await page.getByRole('link', { name: 'Transactions', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Transactions', level: 1 })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add transaction' })).toBeVisible();
      await ctx.close();
    });
  }
});

void money;
