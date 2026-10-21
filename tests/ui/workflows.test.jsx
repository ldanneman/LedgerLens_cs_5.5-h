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
    // January spending fell from $150 to $100: $100 rolls into February (available $200 + $100 = $300); $280 spent
    // leaves $20, which carries into March: $200 + $20 = $220
    expect(row('February 2026')).toHaveTextContent('$300.00');
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

// ---------------------------------------------------------------------------------------------
// Review remediation (R1-R8): public controls -> commit -> reload -> exact records and totals
// ---------------------------------------------------------------------------------------------
import { DatasetBuilder, usd } from '../../src/seed/builder.js';
import { runProjection } from '../../src/forecast/engine.js';

/** Open `route` over a backend that already holds `dataset`, as a returning user would. */
function reopen(backend, route) {
  return renderApp(route, makeStore(backend));
}
function seeded(dataset) {
  const backend = createMemoryBackend();
  const first = makeStore(backend);
  first.store.replaceWorkspace('main', dataset, 'test');
  return backend;
}
const posted = (d, date = d.settings.asOfDate) => netWorthAt(buildIndex(d), date, false).netWorth;

describe('R1 in the UI: marking ONE leg of a pending transfer posted moves both and survives reload', () => {
  const pendingPayment = () => {
    const b = new DatasetBuilder({ name: 'R1 UI', asOfDate: '2026-01-31' });
    b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-01-01' });
    b.account('card', { name: 'Card', type: 'credit_card', opening: 0, openingDate: '2026-01-01' });
    b.transfer({ id: 'xr1', legIds: ['r1a', 'r1b'], from: 'chk', to: 'card', amount: usd('50.00'), date: '2026-01-10', status: 'pending', desc: 'Card payment' });
    return b.build();
  };
  it('selects only the outgoing leg, clicks Mark posted, then reloads: both legs posted, posted net worth still $1,000.00', async () => {
    const user = userEvent.setup();
    const backend = seeded(pendingPayment());
    const first = reopen(backend, '/transactions');
    expect(posted(first.store.data())).toBe(100000);
    await user.click(screen.getByLabelText('Select row r1a'));
    await user.click(screen.getByRole('button', { name: 'Mark posted' }));
    expect(await screen.findByText(/other side/i)).toBeInTheDocument();
    const d = first.store.data();
    expect(d.transactions.map((t) => [t.id, t.status])).toEqual([['r1a', 'posted'], ['r1b', 'posted']]);
    expect(posted(d)).toBe(100000);
    first.unmount();
    const second = reopen(backend, '/transactions');
    expect(second.store.data().transactions.map((t) => t.status)).toEqual(['posted', 'posted']);
    expect(posted(second.store.data())).toBe(100000);
    // and back again from the OTHER leg
    await user.click(screen.getByLabelText('Select row r1b'));
    await user.click(screen.getByRole('button', { name: 'Mark pending' }));
    await waitFor(() => expect(second.store.data().transactions.map((t) => t.status)).toEqual(['pending', 'pending']));
    expect(posted(second.store.data())).toBe(100000);
  });
  it('selecting both legs changes each transfer exactly once', async () => {
    const user = userEvent.setup();
    const { store } = withMain(pendingPayment(), '/transactions');
    await user.click(screen.getByLabelText('Select row r1a'));
    await user.click(screen.getByLabelText('Select row r1b'));
    await user.click(screen.getByRole('button', { name: 'Mark posted' }));
    await waitFor(() => expect(store.data().transactions.every((t) => t.status === 'posted')).toBe(true));
    expect(screen.queryByText(/other side/i)).toBeNull();
    expect(posted(store.data())).toBe(100000);
  });
});

describe('R1 recovery in the UI: a mixed-status pair from an older version is repaired only by explicit choice', () => {
  it('shows the transfer, waits for a choice, repairs, keeps a backup, and loads the repaired data after reload', async () => {
    const user = userEvent.setup();
    const b = new DatasetBuilder({ name: 'legacy', asOfDate: '2026-01-31' });
    b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-01-01' });
    b.account('card', { name: 'Card', type: 'credit_card', opening: 0, openingDate: '2026-01-01' });
    b.transfer({ id: 'x1', legIds: ['a', 'b'], from: 'chk', to: 'card', amount: usd('50.00'), date: '2026-01-10', status: 'pending', desc: 'Card payment' });
    const data = JSON.parse(JSON.stringify(b.build()));
    data.transactions[0].status = 'posted';
    const raw = JSON.stringify({ format: 'ledgerlens-state', version: 1, savedAt: 'x', workspace: 'main', data });
    const backend = createMemoryBackend();
    backend.setItem(KEYS.workspace('main'), raw);
    const first = reopen(backend, '/');
    expect(await screen.findByRole('heading', { name: /could not read your saved data/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /Repair transfers with mismatched status/ })).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: /Apply repairs/ });
    expect(apply).toBeDisabled(); // no silent default
    expect(backend.getItem(KEYS.workspace('main'))).toBe(raw);
    await user.selectOptions(screen.getByLabelText(/Both sides of transfer x1 should be/), 'posted');
    await user.click(apply);
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(first.store.data().transactions.map((t) => t.status)).toEqual(['posted', 'posted']);
    expect(first.store.storage.listCorruptBackups().map((k) => backend.getItem(k))).toContain(raw);
    first.unmount();
    const second = reopen(backend, '/transactions');
    expect(second.store.data().transactions.map((t) => t.status)).toEqual(['posted', 'posted']);
  });
});

describe('R2 / R5 in the UI: import identity and exact split settlement, through save and reload', () => {
  const pendingCoffee = (ext) => {
    const b = new DatasetBuilder({ name: 'R2 UI', asOfDate: '2026-09-30' });
    b.category('cat-coffee', 'Coffee', 'expense');
    b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-09-01' });
    b.tx({ id: 'p1', account: 'chk', date: '2026-09-15', desc: 'Review Coffee', merchant: 'Review Coffee', amount: -475, kind: 'expense', status: 'pending', source: { type: 'import', batchId: null, externalId: ext, importedAt: null, rawDescription: null } });
    return b.build();
  };
  const paste = (text) => fireEvent.change(screen.getByLabelText('...or paste CSV text'), { target: { value: text } });

  it('a different reference defaults to "New", commits as a second purchase, and a reimport adds nothing', async () => {
    const user = userEvent.setup();
    const backend = seeded(pendingCoffee('P1'));
    const first = reopen(backend, '/import');
    await user.selectOptions(screen.getByLabelText('Destination account'), 'chk');
    paste('Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P2\n');
    expect(await screen.findByText('1 to import')).toBeInTheDocument();
    expect(screen.getByText('0 settle pending')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Commit import/ }));
    expect(await screen.findByText(/Import committed/)).toBeInTheDocument();
    first.unmount();
    const second = reopen(backend, '/import');
    const txs = second.store.data().transactions;
    expect(txs.map((t) => [t.status, t.amountCents, t.source.externalId])).toEqual([['pending', -475, 'P1'], ['posted', -475, 'P2']]);
    await user.selectOptions(screen.getByLabelText('Destination account'), 'chk');
    paste('Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P2\n');
    expect(await screen.findByText('1 already imported')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Commit import/ })).toBeDisabled();
    expect(second.store.data().transactions).toHaveLength(2);
  });

  it('with no references, the similarity match is labelled for review, and "Import as new" keeps the pending item', async () => {
    const user = userEvent.setup();
    const { store } = withMain(pendingCoffee(null), '/import');
    await user.selectOptions(screen.getByLabelText('Destination account'), 'chk');
    paste('Date,Description,Amount\n2026-09-16,Review Coffee,-4.75\n');
    expect(await screen.findByText('1 settle pending')).toBeInTheDocument();
    expect(screen.getByText('similarity')).toBeInTheDocument();
    expect(screen.getByText('1 to review')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Action for line 2'), 'import');
    await user.click(screen.getByRole('button', { name: /Commit import/ }));
    await waitFor(() => expect(store.data().transactions).toHaveLength(2));
    expect(store.data().transactions.find((t) => t.id === 'p1').status).toBe('pending');
  });

  it('a changed amount shows the rescaled splits in the preview; commit, reload and undo keep them exact', async () => {
    const user = userEvent.setup();
    const b = new DatasetBuilder({ name: 'R5 UI', asOfDate: '2026-09-30' });
    b.category('cat-groceries', 'Groceries', 'expense');
    b.category('cat-household', 'Household', 'expense');
    b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-09-01' });
    b.tx({ id: 'sp', account: 'chk', date: '2026-09-15', desc: 'Fresh Fields', merchant: 'Fresh Fields', amount: -1000, kind: 'expense', status: 'pending', splits: [['cat-groceries', -600], ['cat-household', -400]] });
    const original = JSON.stringify(b.build().transactions);
    const backend = seeded(b.build());
    const first = reopen(backend, '/import');
    await user.selectOptions(screen.getByLabelText('Destination account'), 'chk');
    paste('Date,Description,Amount\n2026-09-16,Fresh Fields,-11.00\n');
    const plan = await screen.findByTestId('split-plan-2');
    expect(plan).toHaveTextContent(/Groceries -\$6\.60/);
    expect(plan).toHaveTextContent(/Household -\$4\.40/);
    await user.click(screen.getByRole('button', { name: /Commit import/ }));
    expect(await screen.findByText(/Import committed/)).toBeInTheDocument();
    first.unmount();
    const second = reopen(backend, '/transactions');
    const tx = second.store.data().transactions[0];
    expect([tx.status, tx.amountCents, tx.splits.map((s) => s.amountCents)]).toEqual(['posted', -1100, [-660, -440]]);
    expect(posted(second.store.data())).toBe(100000 - 1100);
    const { undoImportBatch } = await import('../../src/domain/ops/importing.js');
    const undone = second.store.apply((d) => undoImportBatch(d, d.importBatches[0].id), { label: 'undo' });
    expect(undone.ok).toBe(true);
    expect(JSON.stringify(second.store.data().transactions)).toBe(original);
  });
});

describe('R3 / R4 through the real JSON upload flow', () => {
  const uploadJson = async (user, dataset) => {
    const file = new File([exportDatasetJson(dataset)], 'tampered.json', { type: 'application/json' });
    await user.upload(screen.getByLabelText('Choose a LedgerLens export file'), file);
  };
  it('a null reconciliation snapshot is refused with a precise message; My finances is untouched and Reconcile still works', async () => {
    const user = userEvent.setup();
    const { store } = withMain(caseD(), '/settings');
    const before = JSON.stringify(store.dataOf('main'));
    const bad = JSON.parse(JSON.stringify(caseD()));
    bad.reconciliations.push({ id: 'bad-snapshot', accountId: 'chk', startDate: '2026-09-01', endDate: '2026-09-30', openingCents: 100000, closingCents: 100000, status: 'completed', discrepancyCents: 0, clearedTxIds: [], snapshots: [null] });
    await uploadJson(user, bad);
    expect(await screen.findByText(/Not importable/)).toBeInTheDocument();
    expect(screen.getByText(/snapshot #1 must be an object/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace My finances with this file' })).toBeNull();
    expect(JSON.stringify(store.dataOf('main'))).toBe(before);
  });
  it('a batch that claims a manual transaction is refused and the manual record survives', async () => {
    const user = userEvent.setup();
    const { store } = withMain(caseD(), '/settings');
    const before = JSON.stringify(store.dataOf('main'));
    const bad = JSON.parse(JSON.stringify(caseD()));
    bad.importBatches.push({ id: 'batch-1', accountId: 'chk', status: 'committed', createdTxIds: ['d1'], settled: [] });
    await uploadJson(user, bad);
    expect(await screen.findByText(/Not importable/)).toBeInTheDocument();
    expect(screen.getByText(/Undoing the batch would delete an unrelated record/)).toBeInTheDocument();
    expect(JSON.stringify(store.dataOf('main'))).toBe(before);
    expect(store.dataOf('main').transactions.some((t) => t.id === 'd1')).toBe(true);
  });
  it('a malformed snapshot in SAVED storage opens Recovery, keeps the raw text, and never crashes the reconcile page', async () => {
    const bad = JSON.parse(JSON.stringify(caseD()));
    bad.reconciliations.push({ id: 'bad-snapshot', accountId: 'chk', startDate: '2026-09-01', endDate: '2026-09-30', openingCents: 100000, closingCents: 100000, status: 'completed', discrepancyCents: 0, clearedTxIds: [], snapshots: [null] });
    const raw = JSON.stringify({ format: 'ledgerlens-state', version: 1, savedAt: 'x', workspace: 'main', data: bad });
    const backend = createMemoryBackend();
    backend.setItem(KEYS.workspace('main'), raw);
    reopen(backend, '/import/reconcile?acct=chk');
    expect(await screen.findByRole('heading', { name: /could not read your saved data/i })).toBeInTheDocument();
    expect(screen.queryByText(/Cannot read properties of null/)).toBeNull();
    expect(backend.getItem(KEYS.workspace('main'))).toBe(raw);
  });
});

describe('R8 in the UI: the Debt page and the Planner tell the same story', () => {
  it('shows the minimum policy, its recalculated payments ($40.00 then $39.20) and the separate fixed-payment what-if', async () => {
    const b = new DatasetBuilder({ name: 'R8 UI', asOfDate: '2026-10-01' });
    b.account('chk', { name: 'Checking', type: 'checking', opening: usd('50000.00'), openingDate: '2026-01-01' });
    b.account('card', { name: 'Card', type: 'credit_card', opening: -usd('1000.00'), openingDate: '2026-01-01', aprBps: 2400, paymentMode: 'minimum', minPaymentBps: 200, minPaymentFloor: usd('25.00'), dueDay: 15, autopay: 'chk' });
    const dataset = b.build();
    withMain(dataset, '/goals/debt');
    expect(await screen.findByTestId('payment-assumption')).toHaveTextContent(/Minimum payment, recalculated every month.*\$25\.00.*2%/);
    const table = screen.getByRole('table', { name: /Payment schedule for Card/ });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]).getAllByRole('cell').map((c) => c.textContent)).toEqual(expect.arrayContaining(['$40.00']));
    expect(within(rows[2]).getAllByRole('cell').map((c) => c.textContent)).toEqual(expect.arrayContaining(['$39.20']));
    expect(screen.getByTestId('fixed-whatif')).toHaveTextContent(/What-if, not your plan/);
    // the forecast agrees with what the page just displayed
    const p = runProjection(dataset, null, { horizonMonths: 12 });
    expect(p.events.filter((e) => e.kind === 'debt_payment').slice(0, 2).map((e) => e.legs[1].cents)).toEqual([4000, 3920]);
  });
});

describe('stale links do not crash pages', () => {
  it('Reconcile with an unknown or foreign account falls back to the first active account', async () => {
    withMain(caseD(), '/import/reconcile?acct=ghost&rec=also-ghost');
    expect(await screen.findByRole('heading', { name: 'Reconcile a statement' })).toBeInTheDocument();
    expect(screen.getByLabelText('Account')).toHaveValue('chk');
    expect(screen.queryByText(/This page hit a problem/)).toBeNull();
  });
});
