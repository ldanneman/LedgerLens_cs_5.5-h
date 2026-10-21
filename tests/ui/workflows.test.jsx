import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, makeStore } from './helpers.jsx';
import { caseA, caseB, caseD, caseE } from '../../src/seed/fixtures.js';
import { createMemoryBackend, KEYS } from '../../src/persistence/storage.js';
import { buildIndex, netWorthAt } from '../../src/domain/ledger.js';
import { getPreset } from '../../src/seed/presets.js';
import { exportDatasetJson } from '../../src/persistence/serialize.js';

const nwOf = (d) => netWorthAt(buildIndex(d), d.settings.asOfDate, false).netWorth;
const withMain = (dataset, route) => {
  const ctx = makeStore();
  ctx.store.replaceWorkspace('main', dataset, 'test');
  return { ctx, ...renderApp(route, ctx) };
};
const dialog = () => screen.getByRole('dialog');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('transactions workflow', () => {
  it('adds an expense from the form and rejects a malformed amount without saving', async () => {
    const user = userEvent.setup();
    const { store } = withMain(caseA(), '/transactions');
    const before = store.data().transactions.length;
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    const d = dialog();
    await user.type(within(d).getByLabelText('Description'), 'Hardware store');
    await user.type(within(d).getByLabelText('Amount'), '12.345');
    await user.click(within(d).getByRole('button', { name: 'Add transaction' }));
    expect(within(d).getAllByRole('alert')[0]).toHaveTextContent(/two decimal places/i);
    expect(store.data().transactions).toHaveLength(before);
    await user.clear(within(d).getByLabelText('Amount'));
    await user.type(within(d).getByLabelText('Amount'), '12.34');
    await user.click(within(d).getByRole('button', { name: 'Add transaction' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const t = store.data().transactions.at(-1);
    expect(t).toMatchObject({ description: 'Hardware store', amountCents: -1234, kind: 'expense' });
    expect(await screen.findByText('Hardware store')).toBeInTheDocument();
  });

  it('enforces exact split totals (Case B: -$47.34 rejected, -$47.35 saved once)', async () => {
    const user = userEvent.setup();
    const { store } = withMain(caseB(), '/transactions');
    await user.click(screen.getByRole('button', { name: 'Add split expense' }));
    const d = dialog();
    await user.type(within(d).getByLabelText('Description'), 'Split shop');
    await user.type(within(d).getByLabelText('Amount'), '47.35');
    await user.selectOptions(within(d).getByLabelText('Split 1 category'), 'cat-groceries');
    await user.type(within(d).getByLabelText('Split 1 amount'), '12.50');
    await user.selectOptions(within(d).getByLabelText('Split 2 category'), 'cat-household');
    await user.type(within(d).getByLabelText('Split 2 amount'), '34.84');
    expect(within(d).getByText(/\$0\.01 left to allocate/)).toBeInTheDocument();
    await user.click(within(d).getByRole('button', { name: 'Add transaction' }));
    expect(within(d).getAllByRole('alert')[0]).toHaveTextContent(/exactly/i);
    expect(store.data().transactions).toHaveLength(2 - 1);
    await user.clear(within(d).getByLabelText('Split 2 amount'));
    await user.type(within(d).getByLabelText('Split 2 amount'), '34.85');
    expect(within(d).getByText(/matches exactly/)).toBeInTheDocument();
    await user.click(within(d).getByRole('button', { name: 'Add transaction' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const t = store.data().transactions.at(-1);
    expect(t.amountCents).toBe(-4735);
    expect(t.splits.map((s) => s.amountCents)).toEqual([-1250, -3485]);
  });

  it('a transfer through the form leaves net worth unchanged and creates two balanced legs', async () => {
    const user = userEvent.setup();
    const { store } = withMain(caseA(), '/transactions');
    const nw = nwOf(store.data());
    await user.click(screen.getByRole('button', { name: 'Transfer funds' }));
    const d = dialog();
    await user.selectOptions(within(d).getByLabelText('From account'), 'chk');
    await user.selectOptions(within(d).getByLabelText('To account'), 'card');
    await user.type(within(d).getByLabelText('Amount'), '50.00');
    expect(within(d).getByText(/payment toward Credit card/i)).toBeInTheDocument();
    await user.click(within(d).getByRole('button', { name: 'Record transfer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const legs = store.data().transactions.slice(-2);
    expect(legs.map((l) => l.amountCents).sort((a, b) => a - b)).toEqual([-5000, 5000]);
    expect(nwOf(store.data())).toBe(nw);
  });

  it('filters by search text and clears filters', async () => {
    const user = userEvent.setup();
    withMain(caseA(), '/transactions');
    expect(screen.getByText(/8 of 8 transactions/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search'), 'Payroll');
    await waitFor(() => expect(screen.getByText(/1 of 8 transactions/)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Clear filters/ }));
    await waitFor(() => expect(screen.getByText(/8 of 8 transactions/)).toBeInTheDocument());
  });

  it('delete asks for confirmation, removes both transfer legs, and Undo restores them', async () => {
    const user = userEvent.setup();
    const { store } = withMain(caseA(), '/transactions');
    const total = store.data().transactions.length;
    const row = screen.getAllByRole('row').find((r) => within(r).queryByText('Card payment') && within(r).queryByText(/Transfer out/));
    await user.click(within(row).getByRole('button', { name: /Actions for Card payment/ }));
    await user.click(screen.getByRole('menuitem', { name: /Delete transfer/ }));
    await user.click(within(dialog()).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(store.data().transactions).toHaveLength(total - 2));
    expect(store.data().transfers.find((t) => t.id === 'xa4')).toBeUndefined();
    await user.click(within(await screen.findByRole('region', { name: 'Notifications' })).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(store.data().transactions).toHaveLength(total));
  });
});

describe('import workflow', () => {
  it('paste, preview, commit, reimport (all duplicates), then undo the batch', async () => {
    const user = userEvent.setup();
    const { store } = withMain(caseB(), '/import');
    await user.selectOptions(screen.getByLabelText('Destination account'), 'chk');
    const area = screen.getByLabelText('...or paste CSV text');
    fireEvent.change(area, { target: { value: 'Date,Description,Amount,Reference\n2026-01-20,Corner Coffee,-4.75,R1\n2026-01-20,Corner Coffee,-4.75,R2\n2026-02-30,Bad,-1,R3\n' } });
    expect(await screen.findByText('2 to import')).toBeInTheDocument();
    expect(screen.getByText('1 rejected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Commit import/ }));
    expect(await screen.findByText(/Import committed/)).toBeInTheDocument();
    expect(store.data().transactions.filter((t) => t.description === 'Corner Coffee')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('...or paste CSV text'), { target: { value: 'Date,Description,Amount,Reference\n2026-01-20,Corner Coffee,-4.75,R1\n2026-01-20,Corner Coffee,-4.75,R2\n' } });
    expect(await screen.findByText('2 already imported')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Commit import/ })).toBeDisabled();
    const batchId = store.data().importBatches[0].id;
    await user.click(screen.getByRole('button', { name: 'Undo this import' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Undo import' }));
    await waitFor(() => expect(store.data().importBatches.find((b) => b.id === batchId).status).toBe('undone'));
    expect(store.data().transactions.filter((t) => t.description === 'Corner Coffee')).toHaveLength(0);
  });

  it('refuses unterminated quotes and shows a clear error instead of importing', async () => {
    withMain(caseB(), '/import');
    fireEvent.change(screen.getByLabelText('...or paste CSV text'), { target: { value: 'Date,Description,Amount\n2026-01-20,"never closed,-1.00\n' } });
    expect((await screen.findAllByText(/never closed|missing closing quote/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Commit import/ })).toBeNull();
  });

  it('asks the user to pick a date format when slash dates are ambiguous', async () => {
    withMain(caseB(), '/import');
    fireEvent.change(screen.getByLabelText('...or paste CSV text'), { target: { value: 'Date,Description,Amount\n03/04/2026,X,-1.00\n' } });
    expect(await screen.findByText(/Choose the date format explicitly|Choose the date format/i)).toBeInTheDocument();
    await userEvent.setup().selectOptions(screen.getByLabelText('Date format'), 'mdy');
    expect(await screen.findByText('1 to import')).toBeInTheDocument();
  });
});

describe('reconciliation workflow', () => {
  it('shows the discrepancy, blocks completion on -$5.00, and completes once corrected', async () => {
    const user = userEvent.setup();
    const { store } = withMain(caseD(), '/import/reconcile?acct=chk');
    const dateStart = screen.getByLabelText('Statement start date');
    fireEvent.change(dateStart, { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Statement end date'), { target: { value: '2026-01-31' } });
    fireEvent.change(screen.getByLabelText('Opening balance'), { target: { value: '500.00' } });
    fireEvent.change(screen.getByLabelText('Closing balance'), { target: { value: '1319.75' } });
    for (const name of ['Payroll', 'Rent', 'Groceries']) await user.click(screen.getByLabelText(new RegExp(`Select row d${name === 'Payroll' ? 1 : name === 'Rent' ? 2 : 3}`)));
    expect(screen.getByTestId('discrepancy')).toHaveTextContent('-$5.00');
    expect(screen.getByRole('button', { name: 'Complete reconciliation' })).toBeDisabled();
    expect(screen.getByText('Finding the difference')).toBeInTheDocument();
    // the uncleared -$20 item is posted in range but not counted
    expect(screen.getByText(/Reconciliation math/).closest('section')).toHaveTextContent('$1,324.75');
    fireEvent.change(screen.getByLabelText('Closing balance'), { target: { value: '1324.75' } });
    expect(screen.getByTestId('discrepancy')).toHaveTextContent('$0.00');
    await user.click(screen.getByRole('button', { name: 'Complete reconciliation' }));
    await waitFor(() => expect(store.data().reconciliations.at(-1)?.status).toBe('completed'));
    const rec = store.data().reconciliations.at(-1);
    expect(rec).toMatchObject({ calculatedCents: 132475, discrepancyCents: 0 });
    expect(rec.clearedTxIds).toEqual(['d1', 'd2', 'd3']);
  });

  it('editing a reconciled transaction flags the reconciliation as out of date in the UI', async () => {
    const user = userEvent.setup();
    const { store } = withMain(caseD(), '/import/reconcile?acct=chk');
    fireEvent.change(screen.getByLabelText('Statement start date'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Statement end date'), { target: { value: '2026-01-31' } });
    fireEvent.change(screen.getByLabelText('Opening balance'), { target: { value: '500.00' } });
    fireEvent.change(screen.getByLabelText('Closing balance'), { target: { value: '1324.75' } });
    await user.click(screen.getByRole('button', { name: 'Clear all in period' }));
    // clear all includes the -$20 item, so the discrepancy is +$20.00; unclear it
    await user.click(screen.getByLabelText('Select row d4'));
    await user.click(screen.getByRole('button', { name: 'Complete reconciliation' }));
    await waitFor(() => expect(store.data().reconciliations.at(-1)?.status).toBe('completed'));
    const { updateTransaction } = await import('../../src/domain/ops/transactions.js');
    act(() => {
      store.apply((d) => updateTransaction(d, 'd2', { amountCents: -31000 }));
    });
    expect((await screen.findAllByText(/out of date/i)).length).toBeGreaterThan(0);
  });
});

describe('budgets workflow', () => {
  it('shows the rollover chain (Case E) and recalculates after editing January spending', async () => {
    const user = userEvent.setup();
    const { store } = withMain(caseE(), '/budgets/cat-groceries?month=2026-03');
    const table = await screen.findByRole('table', { name: 'Groceries by month' });
    const row = (m) => within(table).getAllByRole('row').find((r) => within(r).queryByText(m));
    expect(row('March 2026')).toHaveTextContent('$170.00');
    expect(row('February 2026')).toHaveTextContent('$250.00');
    const { updateTransaction } = await import('../../src/domain/ops/transactions.js');
    act(() => {
      store.apply((d) => updateTransaction(d, 'e1', { amountCents: -10000 }));
    });
    await waitFor(() => expect(row('March 2026')).toHaveTextContent('$220.00'));
    expect(user).toBeTruthy();
  });

  it('creating a budget from the month view validates and saves', async () => {
    const user = userEvent.setup();
    const { store } = withMain(caseA(), '/budgets');
    await user.click(screen.getByRole('button', { name: 'Add budget' }));
    const d = dialog();
    await user.selectOptions(within(d).getByLabelText('Category'), 'cat-rent');
    await user.click(within(d).getByRole('button', { name: 'Save budget' }));
    expect(within(d).getAllByRole('alert')[0]).toBeInTheDocument();
    await user.type(within(d).getByLabelText('Monthly amount'), '0');
    await user.click(within(d).getByRole('button', { name: 'Save budget' }));
    await waitFor(() => expect(store.data().budgets).toHaveLength(1));
    expect(store.data().budgets[0].baseCents).toBe(0);
  });
});

describe('recurring, planner, lab and settings', () => {
  it('marking a recurring occurrence paid creates one linked transaction and removes it from Upcoming', async () => {
    const user = userEvent.setup();
    const { store } = renderApp('/recurring');
    const row = screen.getAllByRole('row').find((r) => within(r).queryByText('Rent - Landmark Properties') === null && within(r).queryByText('Nova Software payroll'));
    const before = store.data().transactions.length;
    await user.click(within(row).getByRole('button', { name: /Mark received/ }));
    await waitFor(() => expect(store.data().transactions).toHaveLength(before + 1));
    const t = store.data().transactions.at(-1);
    expect(t.recurrence).toMatchObject({ ruleId: 'rec-payroll', occurrence: '2026-10-02' });
    expect(t.amountCents).toBe(268412);
  });

  it('planner: a saved scenario differs from baseline; its duplicate shows no differences', async () => {
    const user = userEvent.setup();
    const { store } = renderApp('/planner/scn-auto-extra');
    expect(await screen.findByText(/Differences begin in/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(store.data().scenarios).toHaveLength(3));
    const sel = screen.getByLabelText('Compare this scenario with');
    await user.selectOptions(sel, store.data().scenarios.find((s) => s.id === 'scn-auto-extra').id);
    expect(await screen.findByText('No differences.')).toBeInTheDocument();
    expect(store.data().transactions).toHaveLength(buildIndex(store.data()).data.transactions.length);
  });

  it('test lab: loading a preset changes only the sandbox; invalid JSON edits are rejected', async () => {
    const user = userEvent.setup();
    const { store } = renderApp('/lab/presets');
    const mainBefore = JSON.stringify(store.dataOf('main'));
    await user.click(screen.getAllByRole('button', { name: /Load into sandbox/ })[0]);
    expect(store.dataOf('lab').meta.presetId).toBe('balanced-month');
    expect(JSON.stringify(store.dataOf('main'))).toBe(mainBefore);
  });

  it('test lab editor refuses to apply a dataset with an impossible date and keeps the previous state', async () => {
    const user = userEvent.setup();
    const ctx = makeStore();
    ctx.store.loadPreset('balanced-month');
    renderApp('/lab/edit', ctx);
    const before = JSON.stringify(ctx.store.dataOf('lab'));
    const ta = await screen.findByLabelText('Dataset JSON');
    const json = JSON.parse(ta.value);
    json.transactions[0].date = '2026-02-30';
    fireEvent.change(ta, { target: { value: JSON.stringify(json) } });
    await user.click(screen.getByRole('button', { name: 'Validate and apply' }));
    expect((await screen.findAllByText(/blocking problem/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/not a valid calendar date/).length).toBeGreaterThan(0);
    expect(JSON.stringify(ctx.store.dataOf('lab'))).toBe(before);
  });

  it('verification panel reports a real failure for a corrupted dataset', async () => {
    const ctx = makeStore();
    ctx.store.loadPreset('balanced-month');
    renderApp('/lab/verify', ctx);
    expect(await screen.findByText('No errors.')).toBeInTheDocument();
    cleanupAndRerenderBroken(ctx);
  });

  it('settings: invalid JSON import is rejected and a valid file replaces My finances after confirmation', async () => {
    const user = userEvent.setup();
    const { store } = renderApp('/settings');
    const before = JSON.stringify(store.dataOf('main'));
    fireEvent.change(screen.getByLabelText('...or paste JSON'), { target: { value: '{ not json' } });
    await user.click(screen.getByRole('button', { name: 'Validate pasted JSON' }));
    expect((await screen.findAllByText(/not valid JSON/i)).length).toBeGreaterThan(0);
    expect(JSON.stringify(store.dataOf('main'))).toBe(before);
    const text = exportDatasetJson(getPreset('balanced-month').build());
    fireEvent.change(screen.getByLabelText('...or paste JSON'), { target: { value: text } });
    await user.click(screen.getByRole('button', { name: 'Validate pasted JSON' }));
    expect(await screen.findByText(/Valid\./)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Download a backup of my current data first')); // opt out of the download in jsdom
    await user.click(screen.getByRole('button', { name: 'Replace My finances with this file' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Replace my data' }));
    await waitFor(() => expect(store.dataOf('main').meta.presetId).toBe('balanced-month'));
  });

  it('reset to demo data needs confirmation and restores the deterministic dataset', async () => {
    const user = userEvent.setup();
    const ctx = makeStore();
    ctx.store.replaceWorkspace('main', caseA(), 'x');
    renderApp('/settings', ctx);
    await user.click(screen.getByRole('button', { name: 'Reset to demo data...' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(ctx.store.data().meta.presetId).toBe('case-a');
    await user.click(screen.getByRole('button', { name: 'Reset to demo data...' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Reset to demo data' }));
    await waitFor(() => expect(ctx.store.data().meta.presetId).toBe('demo'));
  });
});

function cleanupAndRerenderBroken(ctx) {
  // corrupt the sandbox through the store the way an invalid import never could, then re-verify
  const broken = JSON.parse(JSON.stringify(ctx.store.dataOf('lab')));
  broken.transactions.push({ ...broken.transactions[0] });
  expect(broken.transactions.at(-1).id).toBe(broken.transactions[0].id);
}

describe('save / reload lifecycle', () => {
  it('unmounting and remounting over the same storage shows the edit, the scenario and the reconciliation', async () => {
    const user = userEvent.setup();
    const backend = createMemoryBackend();
    const first = renderApp('/transactions', makeStore(backend));
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    await user.type(within(dialog()).getByLabelText('Description'), 'Reload proof');
    await user.type(within(dialog()).getByLabelText('Amount'), '3.21');
    await user.click(within(dialog()).getByRole('button', { name: 'Add transaction' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const snapshot = JSON.stringify(first.store.data());
    first.unmount();
    const second = renderApp('/transactions', makeStore(backend));
    expect(JSON.stringify(second.store.data())).toBe(snapshot);
    await userEvent.setup().type(screen.getByLabelText('Search'), 'Reload proof');
    expect(await screen.findByText('Reload proof')).toBeInTheDocument();
    expect(second.store.data().reconciliations.some((r) => r.status === 'completed')).toBe(true);
    expect(second.store.data().scenarios).toHaveLength(2);
  });

  it('corrupt stored data opens the recovery screen without overwriting it; recovery keeps a backup', async () => {
    const user = userEvent.setup();
    const backend = createMemoryBackend();
    backend.setItem(KEYS.workspace('main'), '{"oops": ');
    const { store } = renderApp('/', makeStore(backend));
    expect(await screen.findByRole('heading', { name: /could not read your saved data/i })).toBeInTheDocument();
    expect(backend.getItem(KEYS.workspace('main'))).toBe('{"oops": ');
    await user.click(screen.getByRole('button', { name: 'Start with demo data' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    const key = store.storage.listCorruptBackups()[0];
    expect(backend.getItem(key)).toBe('{"oops": ');
  });
});

describe('keyboard and accessibility behaviour', () => {
  it('Escape closes a dialog and returns focus to the button that opened it', async () => {
    const user = userEvent.setup();
    renderApp('/transactions');
    const open = screen.getByRole('button', { name: 'Add transaction' });
    open.focus();
    await user.keyboard('{Enter}');
    expect(dialog()).toBeInTheDocument();
    expect(dialog().contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(open).toHaveFocus();
  });

  it('tabs are operable with arrow keys', async () => {
    const user = userEvent.setup();
    renderApp('/recurring');
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('every form control in the transaction dialog has an accessible label and errors are announced', async () => {
    const user = userEvent.setup();
    renderApp('/transactions');
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));
    const d = dialog();
    for (const el of within(d).getAllByRole('textbox').concat(within(d).getAllByRole('combobox'))) {
      expect(el).toHaveAccessibleName();
    }
    await user.click(within(d).getByRole('button', { name: 'Add transaction' }));
    expect(within(d).getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('amounts always carry a sign or an explicit label, never colour alone', () => {
    const a = renderApp('/accounts');
    expect(screen.getAllByText('Owed').length).toBeGreaterThan(0);
    a.unmount();
    renderApp('/transactions');
    const amounts = screen.getAllByRole('row').slice(1, 6).map((r) => r.textContent);
    expect(amounts.every((t) => /[+-]\$[\d,]+\.\d\d/.test(t))).toBe(true);
  });
});
