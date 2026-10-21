import { describe, it, expect } from 'vitest';
import { buildDemoDataset } from '../../src/seed/demo.js';
import { PRESETS } from '../../src/seed/presets.js';
import { caseA } from '../../src/seed/fixtures.js';
import { exportDatasetJson, parseImportText, migrateDataset, exportFileName } from '../../src/persistence/serialize.js';
import { createStorage, createMemoryBackend, KEYS, STATE_FORMAT } from '../../src/persistence/storage.js';
import { createStore } from '../../src/state/store.js';
import { validateStructure } from '../../src/domain/validate.js';
import { verifyDataset } from '../../src/domain/verify.js';
import { normalizeDataset } from '../../src/domain/schema.js';
import { addTransaction, updateTransaction, deleteTransactions } from '../../src/domain/ops/transactions.js';
import { completeReconciliation } from '../../src/domain/ops/reconcile.js';
import { saveScenario } from '../../src/domain/ops/catalog.js';
import { runProjection } from '../../src/forecast/engine.js';
import { must, nw } from '../helpers.js';
import { INVALID_CASES } from '../../src/seed/invalid.js';

const blocking = (d) => validateStructure(d).filter((f) => f.blocking);

describe('seed data meets the spec checklist', () => {
  const d = buildDemoDataset();
  it('is deterministic: two builds are identical', () => {
    expect(JSON.stringify(buildDemoDataset())).toBe(JSON.stringify(d));
  });
  it('has the required accounts, volume and variety', () => {
    expect(d.accounts.length).toBeGreaterThanOrEqual(9);
    const types = (t) => d.accounts.filter((a) => a.type === t && a.status === 'active').length;
    expect(types('checking')).toBe(2);
    expect(types('savings')).toBeGreaterThanOrEqual(2);
    expect(types('credit_card')).toBe(2);
    expect(types('investment')).toBe(1);
    expect(types('auto_loan')).toBe(1);
    expect(types('student_loan') + types('personal_loan')).toBe(1);
    expect(d.transactions.length).toBeGreaterThanOrEqual(500);
    const dates = d.transactions.map((t) => t.date).sort();
    const months = new Set(dates.map((x) => x.slice(0, 7)));
    expect(months.size).toBeGreaterThanOrEqual(12);
    expect(d.categories.length).toBeGreaterThanOrEqual(15);
    expect(new Set(d.transactions.map((t) => t.merchant).filter(Boolean)).size).toBeGreaterThanOrEqual(20);
    expect(d.transactions.filter((t) => t.splits.length >= 2).length).toBeGreaterThanOrEqual(3);
    expect(d.transfers.filter((t) => !t.external).length).toBeGreaterThanOrEqual(12);
    expect(d.recurring.filter((r) => r.kind === 'expense').length).toBeGreaterThanOrEqual(6);
    expect(d.recurring.filter((r) => r.kind === 'income').length).toBeGreaterThanOrEqual(2);
    expect(d.transactions.some((t) => t.status === 'pending')).toBe(true);
    expect(d.transactions.filter((t) => t.kind === 'expense' && t.amountCents > 0).length).toBeGreaterThanOrEqual(3); // refunds
    expect(d.transactions.some((t) => t.kind === 'adjustment')).toBe(true);
    expect(d.transactions.some((t) => t.source.externalId)).toBe(true);
    expect(d.goals.length).toBeGreaterThanOrEqual(3);
    expect(d.budgets.length).toBeGreaterThanOrEqual(4);
    expect(d.budgets.some((b) => b.rollover)).toBe(true);
    expect(d.reconciliations.some((r) => r.status === 'completed')).toBe(true);
    expect(d.reconciliations.some((r) => r.status === 'in_progress')).toBe(true);
    expect(d.settings.asOfDate).toBe('2026-10-01');
    // year/month boundaries and identical entries
    for (const dt of ['2025-12-31', '2026-01-01', '2026-02-28', '2026-09-30', '2026-10-01']) expect(dates.includes(dt), dt).toBe(true);
    const groups = new Map();
    for (const t of d.transactions) {
      const k = `${t.accountId}|${t.date}|${t.amountCents}|${t.description}`;
      groups.set(k, (groups.get(k) || 0) + 1);
    }
    expect([...groups.values()].some((n) => n > 1)).toBe(true);
  });
  it('validates cleanly and never overdraws the main checking account', () => {
    expect(blocking(d)).toEqual([]);
    let run = d.accounts.find((a) => a.id === 'acct-chk-main').openingCents;
    for (const t of [...d.transactions].filter((x) => x.accountId === 'acct-chk-main').sort((a, b) => (a.date < b.date ? -1 : 1))) {
      run += t.amountCents;
      expect(run).toBeGreaterThan(0);
    }
  });
  it('every preset validates and passes the full verification panel', () => {
    for (const p of PRESETS) {
      const data = p.build();
      expect(blocking(data), p.id).toEqual([]);
      const v = verifyDataset(data);
      expect(v.errors, p.id).toEqual([]);
    }
    const v = verifyDataset(d);
    expect(v.errors).toEqual([]);
    expect(v.checks.every((c) => c.status !== 'fail')).toBe(true);
  });
});

describe('JSON export and import', () => {
  it('round-trips: identical balances, ids, links, reconciliation state, scenarios', () => {
    const d = buildDemoDataset();
    const text = exportDatasetJson(d, '2026-10-01T00:00:00.000Z');
    const parsed = JSON.parse(text);
    expect(parsed.format).toBe('ledgerlens-export');
    expect(parsed.formatVersion).toBe(1);
    const r = parseImportText(text);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.dataset)).toBe(JSON.stringify(d));
    expect(nw(r.dataset)).toBe(nw(d));
    expect(r.dataset.reconciliations).toEqual(d.reconciliations);
    expect(r.dataset.transfers).toEqual(d.transfers);
    expect(r.dataset.scenarios).toEqual(d.scenarios);
    // projections are identical after a round trip
    expect(runProjection(r.dataset, r.dataset.scenarios[0]).totals).toEqual(runProjection(d, d.scenarios[0]).totals);
    // and a second cycle is stable
    expect(parseImportText(exportDatasetJson(r.dataset)).dataset).toEqual(r.dataset);
    expect(exportFileName(d)).toMatch(/^ledgerlens-.*2026-10-01\.json$/);
  });
  it('rejects bad JSON and wrong shapes without throwing', () => {
    for (const bad of ['', '   ', '{not json', '[]', '"x"', 'null', '{}', '{"format":"ledgerlens-export"}', '{"format":"ledgerlens-export","formatVersion":1,"dataset":5}', '{"format":"ledgerlens-export","formatVersion":99,"dataset":{}}']) {
      const r = parseImportText(bad);
      expect(r.ok, bad).toBe(false);
      expect(typeof r.error).toBe('string');
    }
    expect(parseImportText('{"format":"ledgerlens-export","formatVersion":99,"dataset":{}}').error).toMatch(/newer/);
  });
  it('accepts bare early datasets (version 0) and upgrades them', () => {
    const d = buildDemoDataset();
    const old = JSON.parse(JSON.stringify(d));
    delete old.schemaVersion;
    delete old.scenarios;
    const r = parseImportText(JSON.stringify(old));
    expect(r.ok).toBe(true);
    expect(r.notes.join(' ')).toMatch(/version 0/);
    expect(r.dataset.schemaVersion).toBe(1);
    expect(r.dataset.scenarios).toEqual([]);
  });
  it('refuses newer schema versions and unknown migration paths', () => {
    const d = JSON.parse(JSON.stringify(buildDemoDataset()));
    d.schemaVersion = 7;
    expect(parseImportText(JSON.stringify({ format: 'ledgerlens-export', formatVersion: 1, dataset: d })).error).toMatch(/newer/);
    expect(migrateDataset({}, -1).ok).toBe(false);
  });
  it('every invalid-candidate corruption is rejected with a specific message and nothing is applied', () => {
    const base = buildDemoDataset();
    expect(INVALID_CASES.length).toBeGreaterThanOrEqual(12);
    for (const c of INVALID_CASES) {
      const broken = c.apply(JSON.parse(JSON.stringify(base)));
      const r = parseImportText(JSON.stringify({ format: 'ledgerlens-export', formatVersion: 1, dataset: broken }));
      expect(r.ok, c.id).toBe(false);
      expect(r.dataset, c.id).toBeUndefined(); // nothing can be applied
      expect(r.findings.filter((f) => f.blocking).length + (r.findings.length ? 0 : 1), c.id).toBeGreaterThan(0); // a blocking finding (or a parse-level error) explains why
      if (c.expect) expect(r.findings.map((f) => f.message).concat(r.error).join(' | '), c.id).toMatch(c.expect);
    }
  });
  it('ids that look like JavaScript built-ins survive a round trip as ordinary data', () => {
    const edge = PRESETS.find((p) => p.id === 'edge-ledger').build();
    expect(edge.transactions.some((t) => t.id === 'hasOwnProperty')).toBe(true);
    const r = parseImportText(exportDatasetJson(edge));
    expect(r.ok).toBe(true);
    expect(r.dataset.categories.map((c) => c.id)).toEqual(expect.arrayContaining(['__proto__', 'constructor', 'toString']));
    expect(r.dataset.accounts.map((c) => c.id)).toContain('__proto__acct');
    expect(Object.getPrototypeOf(r.dataset.categories[0])).toBe(Object.prototype);
    expect({}.polluted).toBeUndefined();
  });
  it('a raw "__proto__" JSON key is dropped, not merged', () => {
    const d = JSON.parse(JSON.stringify(caseA()));
    const text = JSON.stringify({ format: 'ledgerlens-export', formatVersion: 1, dataset: d }).replace('"accounts"', '"__proto__":{"polluted":"yes"},"accounts"');
    const r = parseImportText(text);
    expect(r.ok).toBe(true);
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(r.dataset, 'polluted')).toBe(false);
  });
});

describe('validation catches corruption that appears after edits too', () => {
  it('non-string text, malformed nested records, huge and fractional money', () => {
    const d = JSON.parse(JSON.stringify(caseA()));
    d.transactions[0].description = 42;
    d.transactions[1].amountCents = 10.5;
    d.transactions[2].amountCents = Number.MAX_SAFE_INTEGER;
    d.transactions[3].date = '2026-02-30';
    d.accounts[0].name = null;
    d.budgets = 'nope';
    d.transactions[4].splits = [null];
    const msgs = validateStructure(normalizeDataset(d)).map((f) => f.message).join(' | ');
    expect(msgs).toMatch(/must be text/);
    expect(msgs).toMatch(/whole number of cents/);
    expect(msgs).toMatch(/not a valid calendar date/);
    expect(msgs).toMatch(/budgets must be an array/);
    expect(msgs).toMatch(/split #1 is not an object/);
  });
  it('rejects a mutation that would become invalid once another record changed (deleting a referenced account)', () => {
    const d = caseA();
    const broken = { ...d, accounts: d.accounts.filter((a) => a.id !== 'sav') };
    const f = validateStructure(broken);
    expect(f.some((x) => x.code === 'missing-account')).toBe(true);
  });
  it('verification panel reports real failures, not always success', () => {
    const d = JSON.parse(JSON.stringify(caseA()));
    d.transactions.find((t) => t.id === 'a4b').amountCents = 4000; // unbalances the transfer
    d.transactions.push({ ...d.transactions[0], id: 'a1' }); // duplicate id
    const v = verifyDataset(normalizeDataset(d));
    expect(v.errors.length).toBeGreaterThan(0);
    expect(v.checks.find((c) => c.id === 'transfers').status).toBe('fail');
    expect(v.checks.find((c) => c.id === 'ids').status).toBe('fail');
    expect(v.checks.find((c) => c.id === 'ledger').status).toBe('skipped');
    expect(v.errors.find((f) => f.code === 'transfer-unbalanced').refs.length).toBeGreaterThan(0);
    expect(v.summary.blocked).toBe(true);
  });
  it('verification flags a stale reconciliation as a warning, and a clean dataset as pass', () => {
    const rec = must(completeReconciliation(getCaseD(), { accountId: 'chk', startDate: '2026-01-01', endDate: '2026-01-31', openingCents: 50000, closingCents: 132475, clearedTxIds: ['d1', 'd2', 'd3'] }));
    expect(verifyDataset(rec.data).checks.find((c) => c.id === 'recon').status).toBe('pass');
    const edited = must(updateTransaction(rec.data, 'd1', { amountCents: 130000 }));
    const v = verifyDataset(edited.data);
    expect(v.checks.find((c) => c.id === 'recon').status).toBe('warn');
    expect(v.warnings.some((f) => f.code === 'recon-stale')).toBe(true);
    expect(v.errors).toEqual([]);
  });
  it('mutations keep every invariant: random-ish edit sequences stay valid', () => {
    let cur = buildDemoDataset();
    const ids = cur.transactions.filter((t) => t.kind === 'expense' && !t.splits.length).slice(0, 12).map((t) => t.id);
    ids.forEach((id, i) => {
      cur = must(updateTransaction(cur, id, { amountCents: -(1000 + i * 137), date: `2026-0${(i % 8) + 1}-15` })).data;
    });
    cur = must(deleteTransactions(cur, ids.slice(0, 3))).data;
    cur = must(addTransaction(cur, { accountId: 'acct-chk-main', date: '2026-09-15', description: 'Late add', amountCents: -777, kind: 'expense', categoryId: 'cat-dining' })).data;
    cur = must(saveScenario(cur, { name: 'S', horizonMonths: 12, changes: [] })).data;
    expect(blocking(cur)).toEqual([]);
    expect(verifyDataset(cur).errors).toEqual([]);
  });
});

function getCaseD() {
  return PRESETS.find((p) => p.id === 'reconciliation-mismatch').build();
}

describe('storage, corruption recovery and the real save/reload cycle', () => {
  const mk = (backend = createMemoryBackend()) => ({ backend, storage: createStorage(backend) });
  const boot = (storage, extra = {}) => createStore({ storage, now: () => '2026-10-01T12:00:00.000Z', ...extra });

  it('first launch seeds the demo, edits persist, and a fresh store (page reload) sees them', () => {
    const { backend, storage } = mk();
    const s1 = boot(storage);
    expect(s1.data().meta.presetId).toBe('demo');
    const added = s1.apply((d) => addTransaction(d, { accountId: 'acct-chk-main', date: '2026-09-20', description: 'Persisted coffee', amountCents: -450, kind: 'expense', categoryId: 'cat-coffee' }), { label: 'add' });
    expect(added.ok).toBe(true);
    const saved = s1.apply((d) => saveScenario(d, { name: 'Persisted scenario', horizonMonths: 12, changes: [{ type: 'one_time', date: '2027-01-10', title: 'x', amountCents: 5000, accountId: 'acct-chk-main' }] }));
    expect(saved.ok).toBe(true);
    const s2 = boot(createStorage(backend)); // brand-new store over the same storage == reload
    expect(s2.data().transactions.some((t) => t.description === 'Persisted coffee')).toBe(true);
    expect(JSON.stringify(s2.data())).toBe(JSON.stringify(s1.data()));
    const sc = s2.data().scenarios.find((s) => s.name === 'Persisted scenario');
    expect(runProjection(s2.data(), sc).totals).toEqual(runProjection(s1.data(), s1.data().scenarios.find((s) => s.name === 'Persisted scenario')).totals);
  });
  it('a rejected edit is not stored and does not change anything', () => {
    const { backend, storage } = mk();
    const s = boot(storage);
    const before = backend.getItem(KEYS.workspace('main'));
    const res = s.apply((d) => addTransaction(d, { accountId: 'acct-chk-main', date: '2026-02-30', description: 'bad', amountCents: -1, kind: 'expense' }));
    expect(res.ok).toBe(false);
    expect(backend.getItem(KEYS.workspace('main'))).toBe(before);
  });
  it('undo restores the previous dataset and the stored copy', () => {
    const { backend, storage } = mk();
    const s = boot(storage);
    const original = JSON.stringify(s.data());
    s.apply((d) => deleteTransactions(d, [d.transactions[0].id]), { label: 'delete' });
    expect(s.data().transactions).toHaveLength(JSON.parse(original).transactions.length - 1);
    expect(s.undo().ok).toBe(true);
    expect(JSON.stringify(s.data())).toBe(original);
    expect(JSON.parse(backend.getItem(KEYS.workspace('main'))).data.transactions).toHaveLength(JSON.parse(original).transactions.length);
  });
  it('corrupt stored JSON is never overwritten: recovery mode keeps a verbatim backup', () => {
    const { backend, storage } = mk();
    backend.setItem(KEYS.workspace('main'), '{"format":"ledgerlens-state","data":{ broken');
    const s = boot(storage);
    expect(s.getState().status).toBe('recovery');
    expect(s.getState().recovery.reason).toMatch(/not valid JSON/);
    expect(backend.getItem(KEYS.workspace('main'))).toBe('{"format":"ledgerlens-state","data":{ broken'); // untouched
    const r = s.resolveRecovery('demo');
    expect(r.ok).toBe(true);
    expect(s.getState().status).toBe('ready');
    expect(backend.getItem(r.backupKey)).toBe('{"format":"ledgerlens-state","data":{ broken');
    expect(s.data().meta.presetId).toBe('demo');
  });
  it('stored data that parses but fails validation is also quarantined, not silently reset', () => {
    const { backend, storage } = mk();
    const bad = JSON.parse(JSON.stringify(buildDemoDataset()));
    bad.transactions[0].accountId = 'ghost-account';
    backend.setItem(KEYS.workspace('main'), JSON.stringify({ format: STATE_FORMAT, version: 1, data: bad }));
    const s = boot(storage);
    expect(s.getState().status).toBe('recovery');
    expect(s.getState().recovery.reason).toMatch(/failed validation/);
    expect(s.getState().recovery.findings.some((f) => f.code === 'missing-account')).toBe(true);
  });
  it('workspaces are isolated: loading a preset never touches My finances', () => {
    const { storage } = mk();
    const s = boot(storage);
    const mainBefore = JSON.stringify(s.dataOf('main'));
    s.loadPreset('edge-ledger');
    expect(s.dataOf('lab').meta.presetId).toBe('edge-ledger');
    expect(JSON.stringify(s.dataOf('main'))).toBe(mainBefore);
    s.switchWorkspace('lab');
    s.apply((d) => addTransaction(d, { accountId: '__proto__acct', date: '2026-02-25', description: 'lab only', amountCents: -5, kind: 'expense' }));
    s.switchWorkspace('main');
    expect(JSON.stringify(s.dataOf('main'))).toBe(mainBefore);
    // reload keeps both
    const s2 = boot(createStorage(storage.backend));
    expect(s2.getState().active).toBe('lab' === s2.getState().active ? 'lab' : 'main');
    expect(s2.dataOf('lab').transactions.some((t) => t.description === 'lab only')).toBe(true);
    expect(JSON.stringify(s2.dataOf('main'))).toBe(mainBefore);
  });
  it('reset to demo restores the identical deterministic dataset and is undoable', () => {
    const { storage } = mk();
    const s = boot(storage);
    const original = JSON.stringify(s.data());
    s.apply((d) => deleteTransactions(d, d.transactions.slice(0, 5).map((t) => t.id)));
    expect(JSON.stringify(s.data())).not.toBe(original);
    s.resetDemo();
    expect(JSON.stringify(s.data())).toBe(original);
    s.undo();
    expect(s.data().transactions).toHaveLength(JSON.parse(original).transactions.length - 5);
  });
  it('a failing write is reported, not swallowed', () => {
    const backend = createMemoryBackend();
    const storage = createStorage(backend);
    const s = boot(storage);
    backend.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    s.apply((d) => addTransaction(d, { accountId: 'acct-chk-main', date: '2026-09-20', description: 'x', amountCents: -1, kind: 'expense' }));
    expect(s.getState().saveError).toMatch(/Could not save/);
  });
});

// ---------------------------------------------------------------------------------------------
// R3 / R1-recovery: nested reconciliation records and explicit repairs
// ---------------------------------------------------------------------------------------------
import { DatasetBuilder, usd } from '../../src/seed/builder.js';
import { reconciliationHealth, reconciledTxIds, diagnoseDiscrepancy } from '../../src/domain/reconciliation.js';
import { listRepairs, applyTransferStatusRepairs } from '../../src/domain/repairs.js';
import { deleteTransactions as deleteTx, updateTransaction as updateTx } from '../../src/domain/ops/transactions.js';

/** Checking with two posted transactions and a completed reconciliation of both. */
function reconciled() {
  const b = new DatasetBuilder({ name: 'R3', asOfDate: '2026-01-31' });
  b.category('cat-salary', 'Salary', 'income');
  b.category('cat-rent', 'Rent', 'expense');
  b.account('checking', { name: 'Checking', type: 'checking', opening: usd('500.00'), openingDate: '2026-01-01' });
  b.account('other', { name: 'Other', type: 'checking', opening: 0, openingDate: '2026-01-01' });
  b.tx({ id: 't1', account: 'checking', date: '2026-01-03', desc: 'Payroll', amount: usd('1200.00'), kind: 'income', category: 'cat-salary' });
  b.tx({ id: 't2', account: 'checking', date: '2026-01-08', desc: 'Rent', amount: -usd('300.00'), kind: 'expense', category: 'cat-rent' });
  const d = b.build();
  return must(completeReconciliation(d, { accountId: 'checking', startDate: '2026-01-01', endDate: '2026-01-31', openingCents: 50000, closingCents: 50000 + 120000 - 30000, clearedTxIds: ['t1', 't2'] })).data;
}
const clone = (d) => JSON.parse(JSON.stringify(d));
const rec = (d) => d.reconciliations[0];
const asFile = (d) => exportDatasetJson(d);

describe('R3: nested reconciliation snapshots are validated at the JSON boundary', () => {
  it('the review reproduction ([null] snapshot) is rejected with a precise message and nothing is imported', () => {
    const d = clone(reconciled());
    d.reconciliations = [{ id: 'bad-snapshot', accountId: 'checking', startDate: '2026-09-01', endDate: '2026-09-30', openingCents: 100000, closingCents: 100000, status: 'completed', discrepancyCents: 0, clearedTxIds: [], snapshots: [null] }];
    const res = parseImportText(asFile(d));
    expect(res.ok).toBe(false);
    expect(res.dataset).toBeUndefined();
    const f = res.findings.find((x) => x.code === 'recon-snapshot');
    expect(f.blocking).toBe(true);
    expect(f.message).toMatch(/bad-snapshot.*snapshot #1.*must be an object.*null/);
  });
  it.each([
    ['a scalar', (r) => { r.snapshots[0] = 5; }, /snapshot #1 must be an object/],
    ['a string', (r) => { r.snapshots[1] = 'x'; }, /snapshot #2 must be an object/],
    ['a nested list', (r) => { r.snapshots[0] = []; }, /snapshot #1 must be an object/],
    ['snapshots not a list', (r) => { r.snapshots = { 0: {} }; }, /snapshots must be a list/],
    ['a missing txId', (r) => { delete r.snapshots[0].txId; }, /txId must be a transaction id/],
    ['an empty txId', (r) => { r.snapshots[0].txId = ' '; }, /txId must be a transaction id/],
    ['a numeric txId', (r) => { r.snapshots[0].txId = 7; }, /txId must be a transaction id/],
    ['a fractional amount', (r) => { r.snapshots[0].amountCents = 12.5; }, /whole number of cents/],
    ['an unsafe amount', (r) => { r.snapshots[0].amountCents = Number.MAX_SAFE_INTEGER + 2; }, /whole number of cents/],
    ['a string amount', (r) => { r.snapshots[0].amountCents = '1200.00'; }, /whole number of cents/],
    ['a missing amount', (r) => { delete r.snapshots[0].amountCents; }, /whole number of cents/],
    ['an invalid date', (r) => { r.snapshots[0].date = '2026-02-30'; }, /not a valid calendar date/],
    ['a missing date', (r) => { delete r.snapshots[0].date; }, /not a valid calendar date/],
    ['a pending status', (r) => { r.snapshots[0].status = 'pending'; }, /status must be "posted"/],
    ['another account', (r) => { r.snapshots[0].accountId = 'other'; }, /differs from the reconciliation's account/],
    ['duplicate snapshot ids', (r) => { r.snapshots[1].txId = 't1'; }, /more than one snapshot/],
  ])('rejects %s', (_label, corrupt, re) => {
    const d = clone(reconciled());
    corrupt(rec(d));
    const res = parseImportText(asFile(d));
    expect(res.ok).toBe(false);
    expect(res.findings.filter((f) => f.blocking).map((f) => f.message).join(' | ')).toMatch(re);
  });
  it('rejects snapshot / cleared-list membership that disagree (missing and extra), and broken arithmetic', () => {
    const missing = clone(reconciled());
    rec(missing).snapshots.pop();
    expect(parseImportText(asFile(missing)).findings.filter((f) => f.blocking).map((f) => f.message).join(' ')).toMatch(/cleared transaction "t2" has no snapshot/);
    const extra = clone(reconciled());
    rec(extra).clearedTxIds.pop();
    expect(parseImportText(asFile(extra)).findings.filter((f) => f.blocking).map((f) => f.message).join(' ')).toMatch(/snapshot for "t2", which is not in its cleared list/);
    const math = clone(reconciled());
    rec(math).snapshots[0].amountCents += 100;
    expect(parseImportText(asFile(math)).findings.filter((f) => f.blocking).map((f) => f.code)).toContain('recon-math');
    const calc = clone(reconciled());
    rec(calc).calculatedCents += 1;
    expect(parseImportText(asFile(calc)).findings.filter((f) => f.blocking).map((f) => f.code)).toContain('recon-math');
  });
  it('malformed entries are NOT filtered out or counted as zero: a null among valid snapshots still fails', () => {
    const d = clone(reconciled());
    rec(d).snapshots.push(null);
    const res = parseImportText(asFile(d));
    expect(res.ok).toBe(false);
    expect(res.findings.filter((f) => f.blocking).some((f) => /snapshot #3 must be an object/.test(f.message))).toBe(true);
  });
  it('the consumers do not crash on malformed data that bypassed the boundary: they report a problem instead', () => {
    const d = clone(reconciled());
    rec(d).snapshots = [null, 5, { txId: 't1' }, ...rec(d).snapshots];
    expect(() => reconciliationHealth(d, rec(d))).not.toThrow();
    const h = reconciliationHealth(d, rec(d));
    expect(h.valid).toBe(false);
    expect(h.problems.filter((p) => p.type === 'malformed').length).toBe(2);
    expect(() => reconciledTxIds(d)).not.toThrow();
    expect(reconciledTxIds(d).size).toBe(0);
    rec(d).snapshots = 'oops';
    expect(reconciliationHealth(d, rec(d)).valid).toBe(false);
    expect(() => diagnoseDiscrepancy(d, { accountId: 'checking', startDate: '2026-01-01', endDate: '2026-01-31', clearedTxIds: ['t1'], discrepancyCents: 5 })).not.toThrow();
  });
  it('a valid but STALE statement is accepted: edits, moves and deletions after completion are history, not corruption', () => {
    const base = reconciled();
    // amount edit
    const edited = must(updateTx(base, 't2', { amountCents: -31000 }));
    expect(validateStructure(edited.data).filter((f) => f.blocking)).toEqual([]);
    expect(reconciliationHealth(edited.data, edited.data.reconciliations[0]).problems.map((p) => p.type)).toEqual(['amount']);
    // moved to another account
    const moved = must(updateTx(base, 't2', { accountId: 'other' }));
    expect(validateStructure(moved.data).filter((f) => f.blocking)).toEqual([]);
    expect(validateStructure(moved.data).some((f) => f.code === 'recon-wrong-account' && f.severity === 'warning')).toBe(true);
    expect(reconciliationHealth(moved.data, moved.data.reconciliations[0]).problems.map((p) => p.type)).toContain('account');
    // deleted
    const gone = must(deleteTx(base, ['t1']));
    expect(validateStructure(gone.data).filter((f) => f.blocking)).toEqual([]);
    expect(validateStructure(gone.data).some((f) => f.code === 'recon-missing-tx' && f.severity === 'warning')).toBe(true);
    expect(reconciliationHealth(gone.data, gone.data.reconciliations[0]).problems.map((p) => p.type)).toEqual(['deleted']);
    // and it survives an export/import round trip as stale, not as rejected
    const rt = parseImportText(exportDatasetJson(gone.data));
    expect(rt.ok).toBe(true);
    expect(reconciliationHealth(rt.dataset, rt.dataset.reconciliations[0]).valid).toBe(false);
  });
  it('an unknown cleared transaction with NO snapshot is still an error (a bad reference, not history)', () => {
    const d = clone(reconciled());
    rec(d).clearedTxIds.push('tx-never');
    rec(d).snapshots.push({ txId: 'tx-never2', amountCents: 5, date: '2026-01-05', status: 'posted', accountId: 'checking' });
    expect(parseImportText(asFile(d)).findings.filter((f) => f.blocking).map((f) => f.code)).toContain('recon-missing-tx');
  });
  it('every shipped preset and the demo still validate with the stricter rules', () => {
    for (const p of [{ build: buildDemoDataset }, ...PRESETS]) expect(blocking(p.build()), p.id || 'demo').toEqual([]);
  });
});

describe('R3: saved storage with a malformed snapshot is quarantined, not crashed on or silently reset', () => {
  it('boot enters recovery with the raw text intact; starting over keeps a verbatim backup', () => {
    const d = clone(reconciled());
    rec(d).snapshots = [null];
    const raw = JSON.stringify({ format: STATE_FORMAT, version: 1, savedAt: 'x', workspace: 'main', data: d });
    const backend = createMemoryBackend();
    backend.setItem(KEYS.workspace('main'), raw);
    const store = createStore({ storage: createStorage(backend), now: () => '2026-10-01T12:00:00.000Z' });
    expect(store.getState().status).toBe('recovery');
    expect(store.getState().recovery.raw).toBe(raw);
    expect(store.getState().recovery.findings.some((f) => f.code === 'recon-snapshot')).toBe(true);
    expect(backend.getItem(KEYS.workspace('main'))).toBe(raw); // nothing overwritten
    const out = store.resolveRecovery('demo');
    expect(out.ok).toBe(true);
    expect(backend.getItem(out.backupKey)).toBe(raw);
  });
});

describe('R1 recovery: mixed-status transfers from older saved data get an explicit repair, never a silent one', () => {
  function mixed() {
    const b = new DatasetBuilder({ name: 'legacy', asOfDate: '2026-01-31' });
    b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-01-01' });
    b.account('card', { name: 'Card', type: 'credit_card', opening: 0, openingDate: '2026-01-01' });
    b.transfer({ id: 'x1', legIds: ['a', 'b'], from: 'chk', to: 'card', amount: usd('50.00'), date: '2026-01-10', status: 'pending', desc: 'Card payment' });
    const d = clone(b.build());
    d.transactions[0].status = 'posted'; // what the old one-leg "Mark posted" produced
    return d;
  }
  it('is detected, listed, and repaired only with the user\'s choice; the result validates and balances', () => {
    const d = normalizeDataset(mixed());
    expect(blocking(d).map((f) => f.code)).toEqual(['transfer-status-mismatch']);
    const repairs = listRepairs(d);
    expect(repairs).toHaveLength(1);
    expect(repairs[0].legs.map((l) => [l.id, l.status])).toEqual([['a', 'posted'], ['b', 'pending']]);
    expect(applyTransferStatusRepairs(d, {}).applied).toEqual([]); // no choice, no change
    const posted = applyTransferStatusRepairs(d, { x1: 'posted' });
    expect(posted.applied).toEqual([{ transferId: 'x1', status: 'posted', legIds: ['a', 'b'] }]);
    expect(blocking(posted.data)).toEqual([]);
    expect(nw(posted.data, '2026-01-31', false)).toBe(100000);
    const pending = applyTransferStatusRepairs(d, { x1: 'pending' });
    expect(blocking(pending.data)).toEqual([]);
    expect(nw(pending.data, '2026-01-31', false)).toBe(100000);
    expect(d.transactions[0].status).toBe('posted'); // the original object is untouched
  });
  it('saved data with the mismatch opens the Recovery state with the candidate, and a repair keeps the original as a backup', () => {
    const raw = JSON.stringify({ format: STATE_FORMAT, version: 1, savedAt: 'x', workspace: 'main', data: mixed() });
    const backend = createMemoryBackend();
    backend.setItem(KEYS.workspace('main'), raw);
    const store = createStore({ storage: createStorage(backend), now: () => '2026-10-01T12:00:00.000Z' });
    expect(store.getState().status).toBe('recovery');
    const cand = store.getState().recovery.candidate;
    expect(listRepairs(cand)).toHaveLength(1);
    const { data } = applyTransferStatusRepairs(cand, { x1: 'pending' });
    const out = store.resolveRecovery('repair', data, 'Repaired 1 transfer.');
    expect(out.ok).toBe(true);
    expect(backend.getItem(out.backupKey)).toBe(raw);
    expect(store.getState().status).toBe('ready');
    expect(store.data().transactions.map((t) => t.status)).toEqual(['pending', 'pending']);
    expect(store.getState().notices.join(' ')).toMatch(/Repaired 1 transfer.*backup/);
    // a fresh store (reload) loads the repaired data
    const reload = createStore({ storage: createStorage(backend) });
    expect(reload.getState().status).toBe('ready');
    expect(reload.data().transactions.map((t) => t.status)).toEqual(['pending', 'pending']);
  });
});

describe('draft reconciliations stay consistent when their transactions change', () => {
  it('deleting or un-posting a cleared item removes it from the draft and recomputes the discrepancy', () => {
    const d = buildDemoDataset();
    const draft = d.reconciliations.find((r) => r.status === 'in_progress');
    const id = draft.clearedTxIds[0];
    const amount = d.transactions.find((t) => t.id === id).amountCents;
    const res = must(deleteTx(d, [id]));
    const after = res.data.reconciliations.find((r) => r.id === draft.id);
    expect(after.clearedTxIds).not.toContain(id);
    expect(after.calculatedCents).toBe(draft.calculatedCents - amount);
    expect(after.discrepancyCents).toBe(draft.discrepancyCents + amount);
    expect(res.warnings.join(' ')).toMatch(/draft reconciliation/);
    expect(validateStructure(res.data).filter((f) => f.blocking)).toEqual([]);
  });
});
