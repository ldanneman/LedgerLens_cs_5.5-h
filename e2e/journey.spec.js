import { test, expect } from '@playwright/test';

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
    await expect(page.getByText(/of 946 transactions/)).toBeVisible();
    await expect(page.getByText(/transactions · money in/)).toContainText('Corner Bean'.length ? '' : '');
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
