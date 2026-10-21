import { useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useAppState, useStore, useToasts } from '../../state/hooks.jsx';
import { PRESETS } from '../../seed/presets.js';
import { INVALID_CASES } from '../../seed/invalid.js';
import { buildStressDataset } from '../../seed/stress.js';
import { runReferenceCases } from '../../domain/referenceCases.js';
import { compareDatasets } from '../../domain/compareDatasets.js';
import { buildDiagnostics } from '../../domain/diagnostics.js';
import { verifyDataset } from '../../domain/verify.js';
import { validateStructure } from '../../domain/validate.js';
import { buildIndex, accountPosition, runningLedger, isLiabilityType, netWorthAt, categoryParts } from '../../domain/ledger.js';
import { summarizePeriod, categoryBreakdown } from '../../domain/reports.js';
import { reconcileMath } from '../../domain/reconciliation.js';
import { addAccount } from '../../domain/ops/accounts.js';
import { addCategory, saveScenario } from '../../domain/ops/catalog.js';
import { addTransaction, addTransfer, deleteTransactions } from '../../domain/ops/transactions.js';
import { exportDatasetJson, exportFileName, parseImportText } from '../../persistence/serialize.js';
import { normalizeDataset, ACCOUNT_TYPES } from '../../domain/schema.js';
import { parseMoney, formatMoney, centsToDecimalString } from '../../domain/money.js';
import { formatDate } from '../../domain/dates.js';
import { PageHead, Card, Badge, Callout, Explain, EmptyState, Boundary, Stat } from '../components/Common.jsx';
import { Money } from '../components/Money.jsx';
import DataTable from '../components/DataTable.jsx';
import { useConfirm } from '../components/Modal.jsx';
import { SelectField, TextField, TextAreaField, MoneyField, ErrorSummary } from '../components/Form.jsx';
import { downloadText } from '../format.js';
import { remember } from '../period.js';
import { accountTypeLabel, txTypeLabel } from '../format.js';

const TABS = [
  { id: 'presets', label: 'Presets & sandbox' },
  { id: 'inspect', label: 'Inspector' },
  { id: 'edit', label: 'Dataset editor' },
  { id: 'reference', label: 'Reference cases' },
  { id: 'compare', label: 'Compare variants' },
  { id: 'verify', label: 'Verification' },
];

export default function TestLab() {
  const { tab = 'presets' } = useParams();
  const st = useAppState();
  const lab = st.workspaces.lab;
  return (
    <>
      <PageHead title="Test Lab">
        A safe sandbox for exploring financial rules. Everything here happens in a separate workspace - <strong>your real data in My finances is never changed</strong> unless you explicitly copy the sandbox over it.
      </PageHead>
      <nav className="tabs" aria-label="Test Lab sections" style={{ overflowX: 'auto' }}>
        {TABS.map((t) => (<NavLink key={t.id} to={`/lab/${t.id}`}>{t.label}</NavLink>))}
      </nav>
      <Boundary name="This Test Lab panel" resetKey={tab}>
        {tab === 'presets' ? <Presets /> : tab === 'inspect' ? <NeedsLab lab={lab}><Inspect data={lab} /></NeedsLab> : tab === 'edit' ? <NeedsLab lab={lab}><Editor data={lab} /></NeedsLab> : tab === 'reference' ? <Reference /> : tab === 'compare' ? <NeedsLab lab={lab}><Compare data={lab} /></NeedsLab> : tab === 'verify' ? <Verify /> : <Presets />}
      </Boundary>
    </>
  );
}

function NeedsLab({ lab, children }) {
  if (lab) return children;
  return <Card><EmptyState title="The sandbox is empty" action={<NavLink className="btn primary" to="/lab/presets">Load a preset</NavLink>}>Pick one of the deterministic presets first.</EmptyState></Card>;
}

// ---------------------------------------------------------------- presets
function Presets() {
  const st = useAppState();
  const store = useStore();
  const nav = useNavigate();
  const confirm = useConfirm();
  const { push } = useToasts();
  const lab = st.workspaces.lab;
  const [stress, setStress] = useState(null);

  const load = (p) => {
    store.loadPreset(p.id);
    push({ kind: 'success', title: `Loaded "${p.title}" into the sandbox`, message: 'My finances is untouched.', action: { label: 'Undo', run: () => { store.switchWorkspace(st.active); store.undo(); } } });
  };
  const open = () => {
    store.switchWorkspace('lab');
    nav('/');
  };
  const copyToMain = async () => {
    const ok = await confirm({ title: 'Replace My finances with the sandbox?', danger: true, confirmLabel: 'Replace My finances', message: <p>This replaces your real data ({st.workspaces.main.transactions.length} transactions) with the sandbox dataset "{lab.meta.name}". You can undo right afterwards, and you can download a backup first from Settings.</p> });
    if (!ok) return;
    store.replaceWorkspace('main', JSON.parse(JSON.stringify(lab)), 'copy sandbox to My finances');
    push({ kind: 'warning', title: 'My finances now holds the sandbox data', action: { label: 'Undo', run: () => { store.switchWorkspace('main'); store.undo(); } } });
  };
  const runStress = () => {
    const t0 = performance.now();
    const ds = buildStressDataset();
    const t1 = performance.now();
    store.replaceWorkspace('lab', ds, 'load stress dataset');
    const t2 = performance.now();
    const v = verifyDataset(ds);
    const t3 = performance.now();
    const rep = summarizePeriod(ds, { start: '2025-09-01', end: '2026-10-01' });
    const t4 = performance.now();
    setStress({ txs: ds.transactions.length, accounts: ds.accounts.length, categories: ds.categories.length, build: t1 - t0, save: t2 - t1, verify: t3 - t2, report: t4 - t3, errors: v.errors.length, spend: rep.netExpenseCents });
  };

  return (
    <div className="stack">
      <Card title="Current sandbox" actions={lab && <Badge tone="info">{lab.meta.presetId || 'custom'}</Badge>}>
        {lab ? (
          <>
            <p><strong>{lab.meta.name}</strong> - {lab.accounts.length} accounts, {lab.transactions.length} transactions, as of {formatDate(lab.settings.asOfDate)}. {lab.meta.description}</p>
            <div className="actions">
              <button type="button" className="btn primary" onClick={open}>Open the sandbox in the app</button>
              <button type="button" className="btn" onClick={() => { const p = PRESETS.find((x) => x.id === lab.meta.presetId); if (p) load(p); else push({ kind: 'info', title: 'This sandbox was not loaded from a preset' }); }}>Reset this preset</button>
              <button type="button" className="btn" onClick={() => downloadText(exportFileName(lab), exportDatasetJson(lab))}>Export sandbox JSON</button>
              <button type="button" className="btn danger" onClick={copyToMain}>Copy sandbox into My finances...</button>
            </div>
          </>
        ) : <p className="muted">Empty. Load one of the presets below.</p>}
      </Card>
      <div className="grid auto">
        {PRESETS.map((p) => (
          <Card key={p.id} title={p.title}>
            <p className="small">{p.summary}</p>
            <h3 className="small" style={{ marginBottom: 2 }}>What to look for</h3>
            <ul className="small" style={{ marginTop: 0, paddingLeft: 18 }}>{p.lookFor.map((l) => <li key={l}>{l}</li>)}</ul>
            <div className="actions">
              <button type="button" className="btn primary small" onClick={() => load(p)}>{lab?.meta.presetId === p.id ? 'Reload' : 'Load'} into sandbox</button>
              {p.csv && <button type="button" className="btn small" onClick={() => { load(p); store.switchWorkspace('lab'); remember('import-incoming', { text: p.csv.text, name: p.csv.name, account: 'chk' }); nav('/import'); }}>Load + open the sample CSV in the importer</button>}
            </div>
          </Card>
        ))}
        <Card title="Large dataset (performance)">
          <p className="small">Generates 20 accounts, 50 categories and 2,000 transactions over a year, deterministically, and times loading, verification and a full-range report.</p>
          <button type="button" className="btn small primary" onClick={runStress}>Generate and load</button>
          {stress && <div className="kv small" style={{ marginTop: 8 }} aria-live="polite"><span>Size</span><span>{stress.txs} tx, {stress.accounts} accounts, {stress.categories} categories</span><span>Build</span><span>{stress.build.toFixed(0)} ms</span><span>Save to storage</span><span>{stress.save.toFixed(0)} ms</span><span>Full verification</span><span>{stress.verify.toFixed(0)} ms ({stress.errors} errors)</span><span>12-month report</span><span>{stress.report.toFixed(0)} ms</span></div>}
        </Card>
      </div>
      <Explain summary="How the sandbox keeps your data safe">
        <p>The Test Lab works on its own workspace stored under a separate key. Loading a preset replaces only the sandbox (and can be undone). "Open the sandbox in the app" switches every page to it with a banner so you always know which data you are looking at; "Return to My finances" switches back. Copying the sandbox into My finances needs explicit confirmation and is undoable.</p>
      </Explain>
    </div>
  );
}

// -------------------------------------------------------------- inspector
function Inspect({ data }) {
  const idx = useMemo(() => buildIndex(data), [data]);
  const asOf = data.settings.asOfDate;
  const [acct, setAcct] = useState(data.accounts[0]?.id || '');
  const rows = data.accounts.map((a) => ({ a, pos: accountPosition(idx, a.id, asOf) }));
  const nwPosted = netWorthAt(idx, asOf, false);
  const nwAll = netWorthAt(idx, asOf, true);
  const all = useMemo(() => summarizePeriod(data, { start: '1970-01-01', end: asOf }), [data, asOf]);
  const cats = useMemo(() => categoryBreakdown(data, all, 'expense'), [data, all]);
  const ledger = useMemo(() => runningLedger(idx, acct), [idx, acct]);
  const explain = (t) => {
    if (t.kind === 'transfer') return idx.transfersById.get(t.transferId)?.external ? 'External transfer: changes net worth, not income or spending' : 'Internal transfer: moves money, excluded from income and spending';
    if (t.kind === 'adjustment') return t.adjustmentKind === 'valuation' ? 'Valuation change: changes the balance, not income or spending' : 'Correction: changes the balance, not income or spending';
    const parts = categoryParts(t).map((p) => `${idx.categoriesById.get(p.categoryId)?.name || 'Uncategorized'} ${formatMoney(Math.abs(p.amountCents))}`).join(' + ');
    if (t.kind === 'income') return `Income (${parts})`;
    return t.amountCents > 0 ? `Refund: reduces spending (${parts})` : `Spending (${parts})`;
  };
  return (
    <div className="stack">
      <div className="grid cols-4">
        <Card><Stat label="Net worth (posted)" value={<Money cents={nwPosted.netWorth} />} sub={`with pending ${formatMoney(nwAll.netWorth)}`} /></Card>
        <Card><Stat label="Total income" value={<Money cents={all.incomeCents} tone="none" />} /></Card>
        <Card><Stat label="Net spending" value={<Money cents={all.netExpenseCents} tone="none" />} sub={`${formatMoney(all.grossExpenseCents)} - ${formatMoney(all.refundCents)} refunds`} /></Card>
        <Card><Stat label="Transfers moved" value={<Money cents={all.transferInCents} tone="none" />} sub="Not income or spending" /></Card>
      </div>
      <Card title="Computed account balances">
        <DataTable caption="Account balances" rows={rows} rowKey={(r) => r.a.id} columns={[
          { key: 'n', header: 'Account', main: true, render: (r) => <div className="desc-cell"><div className="title">{r.a.name}</div><div className="sub">{r.a.id} · {accountTypeLabel(r.a.type)}</div></div> },
          { key: 'o', header: 'Opening', className: 'num', render: (r) => formatMoney(r.pos.openingCents) },
          { key: 'p', header: 'Posted', className: 'num', render: (r) => formatMoney(r.pos.postedCents) },
          { key: 'q', header: 'Pending', className: 'num', render: (r) => formatMoney(r.pos.pendingCents) },
          { key: 'a', header: 'Available', className: 'num', render: (r) => formatMoney(r.pos.availableCents) },
          { key: 'f', header: 'Future-dated', className: 'num', render: (r) => formatMoney(r.pos.futureCents) },
          { key: 'k', header: 'Counts as', render: (r) => (isLiabilityType(r.a.type) ? 'Liability (owed)' : 'Asset') },
        ]} />
      </Card>
      <Card title="Categorized spending">
        {cats.length === 0 ? <p className="muted small">No spending.</p> : <DataTable caption="Spending by category" rows={cats} rowKey={(c) => String(c.categoryId)} columns={[{ key: 'n', header: 'Category', main: true, render: (c) => c.name }, { key: 'a', header: 'Net spending', className: 'num', render: (c) => formatMoney(c.amountCents) }]} />}
      </Card>
      <Card title="Why did the balance change? Running ledger">
        <SelectField label="Account" value={acct} onChange={setAcct} options={data.accounts.map((a) => ({ value: a.id, label: a.name }))} />
        <DataTable caption="Running ledger" rows={ledger} rowKey={(r) => r.tx.id} columns={[
          { key: 'd', header: 'Date', className: 'nowrap', render: (r) => r.tx.date },
          { key: 'x', header: 'Transaction', main: true, render: (r) => <div className="desc-cell"><div className="title">{r.tx.description}</div><div className="sub">{r.tx.id} · {txTypeLabel(r.tx)} · {r.tx.status}</div><div className="sub">{explain(r.tx)}</div></div> },
          { key: 'e', header: 'Effect', className: 'num', render: (r) => <Money cents={r.effect} signed /> },
          { key: 'pb', header: 'Posted balance', className: 'num', render: (r) => (r.tx.status === 'posted' ? formatMoney(r.postedBalance) : '(pending)') },
          { key: 'ib', header: 'With pending', className: 'num', render: (r) => formatMoney(r.inclusiveBalance) },
        ]} />
      </Card>
    </div>
  );
}

// ----------------------------------------------------------------- editor
function Editor({ data }) {
  const store = useStore();
  const { push } = useToasts();
  const [json, setJson] = useState(() => JSON.stringify(data, null, 2));
  const [findings, setFindings] = useState(null);
  const [errors, setErrors] = useState([]);
  const [scJson, setScJson] = useState('');
  const [invalid, setInvalid] = useState(null);
  const lab = (op, label) => {
    const r = store.apply(op, { workspace: 'lab', label });
    if (!r.ok) {
      setErrors(r.errors);
      push({ kind: 'error', title: 'Rejected - sandbox unchanged', message: r.errors.map((e) => e.message).join(' ') });
    } else {
      setErrors([]);
      setJson(JSON.stringify(store.dataOf('lab'), null, 2));
      push({ kind: 'success', title: 'Applied to the sandbox' });
    }
    return r;
  };
  const [acc, setAcc] = useState({ name: '', type: 'checking', opening: '0.00' });
  const [cat, setCat] = useState({ name: '', kind: 'expense' });
  const [tx, setTx] = useState({ account: data.accounts[0]?.id || '', date: data.settings.asOfDate, desc: '', amount: '', kind: 'expense', category: '', status: 'posted' });
  const [xf, setXf] = useState({ from: data.accounts[0]?.id || '', to: data.accounts[1]?.id || '', amount: '', date: data.settings.asOfDate });

  const validate = () => {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      setFindings({ parseError: e.message, list: [] });
      return null;
    }
    const ds = normalizeDataset(parsed);
    const list = validateStructure(ds);
    setFindings({ list, ds });
    return { ds, list };
  };
  const apply = () => {
    const v = validate();
    if (!v || v.list.some((f) => f.blocking)) return push({ kind: 'error', title: 'Not applied', message: 'Fix the blocking problems first. The sandbox still holds its previous valid data.' });
    store.replaceWorkspace('lab', v.ds, 'edit sandbox JSON');
    return push({ kind: 'success', title: 'Dataset applied to the sandbox', action: { label: 'Undo', run: () => { store.undo(); } } });
  };
  const loadScenarios = () => {
    let parsed;
    try {
      parsed = JSON.parse(scJson);
    } catch (e) {
      return setErrors([{ message: `Scenario JSON is not valid: ${e.message}` }]);
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    let cur = store.dataOf('lab');
    for (const [i, s] of list.entries()) {
      if (!s || typeof s !== 'object') return setErrors([{ message: `Scenario ${i + 1} is not an object.` }]);
      const r = saveScenario(cur, { name: s.name || `Imported scenario ${i + 1}`, description: s.description, horizonMonths: s.horizonMonths ?? 12, assumptions: s.assumptions, changes: Array.isArray(s.changes) ? s.changes : [] });
      if (!r.ok) return setErrors([{ message: `Scenario ${i + 1} rejected: ${r.errors.map((e) => e.message).join(' ')}` }]);
      cur = r.data;
    }
    store.replaceWorkspace('lab', cur, 'load scenario JSON');
    setErrors([]);
    setJson(JSON.stringify(cur, null, 2));
    return push({ kind: 'success', title: `${list.length} scenario(s) loaded`, message: 'Open the Scenario Planner with the sandbox active to see them.' });
  };
  const tryInvalid = (c) => {
    const broken = c.apply(JSON.parse(JSON.stringify(store.dataOf('lab'))));
    const r = parseImportText(JSON.stringify({ format: 'ledgerlens-export', formatVersion: 1, dataset: broken }));
    setInvalid({ label: c.label, result: r, applied: false });
  };
  const sample = { scenario: JSON.stringify({ name: 'Raise from March', horizonMonths: 12, changes: [{ type: 'one_time', date: '2026-12-01', title: 'Bonus', amountCents: 150000, accountId: data.accounts[0]?.id }] }, null, 2) };

  return (
    <div className="stack">
      <ErrorSummary errors={errors} />
      <Card title="Quick edits (each is validated; invalid input is rejected)">
        <div className="grid cols-2">
          <form onSubmit={(e) => { e.preventDefault(); const m = parseMoney(acc.opening); if (!m.ok) return setErrors([{ message: m.error }]); return lab((d) => addAccount(d, { name: acc.name, type: acc.type, openingCents: isLiabilityType(acc.type) ? -Math.abs(m.cents) : m.cents, openingDate: d.settings.asOfDate }), 'add account'); }}>
            <h3>Add account</h3>
            <div className="form-grid"><TextField label="Name" value={acc.name} onChange={(v) => setAcc({ ...acc, name: v })} /><SelectField label="Type" value={acc.type} onChange={(v) => setAcc({ ...acc, type: v })} options={ACCOUNT_TYPES.map((t) => ({ value: t, label: accountTypeLabel(t) }))} /><MoneyField label="Opening (owed, for liabilities)" value={acc.opening} onChange={(v) => setAcc({ ...acc, opening: v })} /></div>
            <button type="submit" className="btn small" style={{ marginTop: 8 }}>Add</button>
          </form>
          <form onSubmit={(e) => { e.preventDefault(); lab((d) => addCategory(d, cat), 'add category'); }}>
            <h3>Add category</h3>
            <div className="form-grid"><TextField label="Name" value={cat.name} onChange={(v) => setCat({ ...cat, name: v })} /><SelectField label="Type" value={cat.kind} onChange={(v) => setCat({ ...cat, kind: v })} options={[{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }]} /></div>
            <button type="submit" className="btn small" style={{ marginTop: 8 }}>Add</button>
          </form>
          <form onSubmit={(e) => { e.preventDefault(); const m = parseMoney(tx.amount, { allowNegative: false }); if (!m.ok) return setErrors([{ message: m.error }]); return lab((d) => addTransaction(d, { accountId: tx.account, date: tx.date, description: tx.desc, amountCents: tx.kind === 'expense' ? -m.cents : m.cents, kind: tx.kind, categoryId: tx.category || null, status: tx.status }), 'add transaction'); }}>
            <h3>Add transaction</h3>
            <div className="form-grid">
              <SelectField label="Account" value={tx.account} onChange={(v) => setTx({ ...tx, account: v })} options={data.accounts.map((a) => ({ value: a.id, label: a.name }))} />
              <TextField label="Date" type="date" value={tx.date} onChange={(v) => setTx({ ...tx, date: v })} />
              <TextField label="Description" value={tx.desc} onChange={(v) => setTx({ ...tx, desc: v })} />
              <MoneyField label="Amount" value={tx.amount} onChange={(v) => setTx({ ...tx, amount: v })} />
              <SelectField label="Type" value={tx.kind} onChange={(v) => setTx({ ...tx, kind: v, category: '' })} options={[{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }]} />
              <SelectField label="Category" value={tx.category} onChange={(v) => setTx({ ...tx, category: v })} options={data.categories.filter((c) => c.kind === tx.kind).map((c) => ({ value: c.id, label: c.name }))} placeholder="None" />
              <SelectField label="Status" value={tx.status} onChange={(v) => setTx({ ...tx, status: v })} options={[{ value: 'posted', label: 'Posted' }, { value: 'pending', label: 'Pending' }]} />
            </div>
            <button type="submit" className="btn small" style={{ marginTop: 8 }}>Add</button>
          </form>
          <form onSubmit={(e) => { e.preventDefault(); const m = parseMoney(xf.amount, { allowNegative: false }); if (!m.ok) return setErrors([{ message: m.error }]); return lab((d) => addTransfer(d, { fromAccountId: xf.from, toAccountId: xf.to, amountCents: m.cents, date: xf.date }), 'add transfer'); }}>
            <h3>Add transfer</h3>
            <div className="form-grid"><SelectField label="From" value={xf.from} onChange={(v) => setXf({ ...xf, from: v })} options={data.accounts.map((a) => ({ value: a.id, label: a.name }))} /><SelectField label="To" value={xf.to} onChange={(v) => setXf({ ...xf, to: v })} options={data.accounts.map((a) => ({ value: a.id, label: a.name }))} /><MoneyField label="Amount" value={xf.amount} onChange={(v) => setXf({ ...xf, amount: v })} /><TextField label="Date" type="date" value={xf.date} onChange={(v) => setXf({ ...xf, date: v })} /></div>
            <button type="submit" className="btn small" style={{ marginTop: 8 }}>Add</button>
          </form>
        </div>
        <h3 style={{ marginTop: 16 }}>Transactions ({data.transactions.length})</h3>
        <DataTable caption="Sandbox transactions (latest 25)" rows={data.transactions.slice(-25).reverse()} rowKey={(t) => t.id} columns={[
          { key: 'id', header: 'Id', render: (t) => <code>{t.id}</code> },
          { key: 'd', header: 'Date', render: (t) => t.date },
          { key: 'n', header: 'Description', main: true, render: (t) => t.description },
          { key: 'a', header: 'Effect', className: 'num', render: (t) => <Money cents={t.amountCents} signed /> },
          { key: 'x', header: '', render: (t) => <button type="button" className="btn small danger" onClick={() => lab((d) => deleteTransactions(d, [t.id]), 'delete transaction')}>Delete</button> },
        ]} />
      </Card>

      <Card title="Edit the whole dataset as JSON">
        <p className="small">Edit, then <strong>Validate</strong>. <strong>Apply</strong> is refused while any blocking problem exists, and the sandbox keeps its last valid state. Use this to try custom ids, duplicate ids, bad dates, fractional cents and so on.</p>
        <TextAreaField className="code" label="Dataset JSON" value={json} onChange={(v) => { setJson(v); setFindings(null); }} rows={14} spellCheck={false} />
        <div className="actions" style={{ marginTop: 8 }}>
          <button type="button" className="btn" onClick={validate}>Validate</button>
          <button type="button" className="btn primary" onClick={apply}>Validate and apply</button>
          <button type="button" className="btn" onClick={() => { setJson(JSON.stringify(data, null, 2)); setFindings(null); }}>Reset text to the sandbox</button>
          <button type="button" className="btn" onClick={() => downloadText(exportFileName(data), exportDatasetJson(data))}>Export JSON</button>
        </div>
        {findings && <FindingList findings={findings} />}
      </Card>

      <Card title="Load a scenario from JSON">
        <p className="small">Paste one scenario object or an array. Each is validated like a saved scenario (bad dates, unknown accounts and so on are rejected).</p>
        <TextAreaField className="code" label="Scenario JSON" value={scJson} onChange={setScJson} rows={6} spellCheck={false} />
        <div className="actions"><button type="button" className="btn" onClick={() => setScJson(sample.scenario)}>Insert an example</button><button type="button" className="btn primary" onClick={loadScenarios} disabled={!scJson.trim()}>Validate and load</button></div>
      </Card>

      <Card title="Invalid candidates library">
        <p className="small">Each button corrupts a copy of the sandbox data in one specific way and tries to import it. Every one must be rejected with a specific message - and the sandbox is never touched.</p>
        <div className="actions">{INVALID_CASES.map((c) => (<button key={c.id} type="button" className="btn small" onClick={() => tryInvalid(c)}>{c.label}</button>))}</div>
        {invalid && (
          <Callout tone={invalid.result.ok ? 'error' : 'success'} role="status" style={{ marginTop: 10 }}>
            <strong>{invalid.label}:</strong> {invalid.result.ok ? 'UNEXPECTEDLY ACCEPTED' : 'rejected, as it should be.'} {invalid.result.error}
            <ul>{(invalid.result.findings || []).filter((f) => f.blocking).slice(0, 4).map((f, i) => <li key={i}>{f.message}</li>)}</ul>
          </Callout>
        )}
      </Card>
    </div>
  );
}

function FindingList({ findings }) {
  if (findings.parseError) return <Callout tone="error" style={{ marginTop: 10 }}><strong>Not valid JSON:</strong> {findings.parseError}</Callout>;
  const blocking = findings.list.filter((f) => f.blocking);
  const rest = findings.list.filter((f) => !f.blocking);
  return (
    <div style={{ marginTop: 10 }} aria-live="polite">
      <Callout tone={blocking.length ? 'error' : 'success'}>{blocking.length ? `${blocking.length} blocking problem(s) - cannot be applied.` : 'No blocking problems.'} {rest.length} advisory finding(s).</Callout>
      <ul className="list-plain" style={{ marginTop: 8 }}>
        {findings.list.slice(0, 40).map((f, i) => (
          <li key={i} style={{ display: 'block' }}>
            <Badge tone={f.blocking ? 'neg' : f.severity === 'warning' ? 'warn' : 'info'}>{f.blocking ? 'Blocks calculation' : f.severity}</Badge> {f.message}
            {f.refs.length > 0 && <div className="tiny muted">Records: {f.refs.map((r) => `${r.type}:${r.id}`).join(', ')}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// -------------------------------------------------------------- reference
function Reference() {
  const cases = useMemo(() => runReferenceCases(), []);
  const [open, setOpen] = useState('50000');
  const [cleared, setCleared] = useState('1200.00, -300.00, -75.25');
  const [close, setClose] = useState('1324.75');
  const parsedCleared = cleared.split(',').map((s) => parseMoney(s.trim()));
  const o = parseMoney(open);
  const c = parseMoney(close);
  const ok = o.ok && c.ok && parsedCleared.every((p) => p.ok);
  const math = ok ? reconcileMath(o.cents, c.cents, parsedCleared.map((p) => p.cents)) : null;
  const allPass = cases.every((k) => k.checks.every((x) => x.pass));
  return (
    <div className="stack">
      <Callout tone={allPass ? 'success' : 'error'} role="status"><strong>{allPass ? 'All reference cases pass.' : 'Some reference checks FAIL.'}</strong> These are the specification's acceptance fixtures, evaluated live with the real engine - not hard-coded answers.</Callout>
      {cases.map((k) => (
        <Card key={k.id} title={k.title} actions={k.checks.every((x) => x.pass) ? <Badge tone="pos">Pass</Badge> : <Badge tone="neg">Fail</Badge>}>
          <p className="small muted">{k.summary}</p>
          <DataTable caption={k.title} rows={k.checks} rowKey={(x) => x.label} columns={[
            { key: 'l', header: 'Check', main: true, render: (x) => x.label },
            { key: 'e', header: 'Expected', className: 'num', render: (x) => x.expected },
            { key: 'a', header: 'Calculated', className: 'num', render: (x) => x.actual },
            { key: 'p', header: 'Result', render: (x) => (x.pass ? <Badge tone="pos">✓ match</Badge> : <Badge tone="neg">✗ differs</Badge>) },
          ]} />
        </Card>
      ))}
      <Card title="Reconciliation calculator">
        <p className="small">Try your own numbers. Amounts are net-worth contributions in cents or dollars as typed (e.g. 500.00).</p>
        <div className="form-grid"><MoneyField label="Statement opening" value={open === '50000' ? '500.00' : open} onChange={setOpen} /><TextField label="Cleared effects (comma separated)" value={cleared} onChange={setCleared} className="wide" /><MoneyField label="Statement closing" value={close} onChange={setClose} /></div>
        {math ? (
          <div className="kv" style={{ marginTop: 8 }} aria-live="polite">
            <span>Cleared sum</span><span>{formatMoney(math.clearedSum)}</span>
            <span>Calculated closing (expected)</span><span>{formatMoney(math.calculated)}</span>
            <span>Statement closing (entered)</span><span>{formatMoney(c.cents)}</span>
            <span><strong>Discrepancy</strong></span><span><strong className={math.discrepancy === 0 ? 'amt pos' : 'amt neg'}>{formatMoney(math.discrepancy, { signed: true })}</strong> {math.discrepancy === 0 ? '- can complete' : '- completion blocked'}</span>
          </div>
        ) : <p className="error-text">Enter valid amounts.</p>}
        <p className="small muted">{centsToDecimalString(0) && 'Tip: closing $1,319.75 gives -$5.00 (blocked); closing $1,324.75 gives $0.00.'}</p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- compare
function Compare({ data }) {
  const [baseline, setBaseline] = useState(() => data);
  const [variantText, setVariantText] = useState('');
  const [variant, setVariant] = useState(null);
  const [error, setError] = useState('');
  const target = variant || data;
  const cmp = useMemo(() => compareDatasets(baseline, target), [baseline, target]);
  const loadVariant = () => {
    const r = parseImportText(variantText);
    if (!r.ok) {
      setError(r.error);
      setVariant(null);
    } else {
      setError('');
      setVariant(r.dataset);
    }
  };
  return (
    <div className="stack">
      <Card title="Baseline and variant">
        <p className="small">The <strong>baseline</strong> is a snapshot ({baseline.meta.name}, {baseline.transactions.length} transactions). The <strong>variant</strong> is the live sandbox (edit it on the Dataset editor tab) or pasted JSON. Differences are listed below.</p>
        <div className="actions">
          <button type="button" className="btn" onClick={() => setBaseline(data)}>Snapshot the current sandbox as the baseline</button>
          {variant && <button type="button" className="btn" onClick={() => setVariant(null)}>Use the live sandbox as the variant</button>}
        </div>
        <TextAreaField className="code" label="...or paste a variant (LedgerLens export JSON)" value={variantText} onChange={setVariantText} rows={3} />
        <button type="button" className="btn small" onClick={loadVariant} disabled={!variantText.trim()}>Compare against this JSON</button>
        {error && <p className="error-text" role="alert">{error}</p>}
      </Card>
      {!cmp.anyChange ? <Callout tone="success" role="status"><strong>No differences.</strong> Baseline and variant produce identical balances, totals, budgets and reconciliation status.</Callout> : <Callout tone="warn" role="status">Differences found - see below.</Callout>}
      <Card title="Totals">
        <DataTable caption="Total differences" rows={Object.entries(cmp.totals).map(([k, v]) => ({ k, ...v }))} rowKey={(r) => r.k} columns={[
          { key: 'k', header: 'Measure', main: true, render: (r) => ({ netWorth: 'Net worth', income: 'Income', netExpense: 'Net spending', netCashFlow: 'Net cash flow', transfersMoved: 'Transfers moved', transactions: 'Transaction count' }[r.k]) },
          { key: 'b', header: 'Baseline', className: 'num', render: (r) => (r.k === 'transactions' ? r.before : formatMoney(r.before)) },
          { key: 'a', header: 'Variant', className: 'num', render: (r) => (r.k === 'transactions' ? r.after : formatMoney(r.after)) },
          { key: 'd', header: 'Change', className: 'num', render: (r) => (r.changed ? (r.k === 'transactions' ? r.diff : <Money cents={r.diff} signed />) : <span className="muted">same</span>) },
        ]} />
      </Card>
      <Card title="Accounts">
        <DataTable caption="Account differences" rows={cmp.accounts} rowKey={(a) => a.id} columns={[
          { key: 'n', header: 'Account', main: true, render: (a) => <span>{a.name} {a.status !== 'kept' && <Badge tone="warn">{a.status}</Badge>}</span> },
          { key: 'b', header: 'Baseline posted', className: 'num', render: (a) => formatMoney(a.posted.before) },
          { key: 'a', header: 'Variant posted', className: 'num', render: (a) => formatMoney(a.posted.after) },
          { key: 'd', header: 'Change', className: 'num', render: (a) => (a.posted.changed ? <Money cents={a.posted.diff} signed /> : <span className="muted">same</span>) },
        ]} />
      </Card>
      {cmp.budgets.length > 0 && (
        <Card title="Budgets (latest month)">
          <DataTable caption="Budget differences" rows={cmp.budgets} rowKey={(b) => b.id} columns={[{ key: 'n', header: 'Budget', main: true, render: (b) => b.name }, { key: 's', header: 'Spent (before → after)', className: 'num', render: (b) => `${formatMoney(b.spent.before)} → ${formatMoney(b.spent.after)}` }, { key: 'v', header: 'Available (before → after)', className: 'num', render: (b) => `${formatMoney(b.available.before)} → ${formatMoney(b.available.after)}` }, { key: 'c', header: 'Changed', render: (b) => (b.spent.changed || b.available.changed ? <Badge tone="warn">changed</Badge> : <span className="muted">same</span>) }]} />
        </Card>
      )}
      {cmp.recs.length > 0 && (
        <Card title="Reconciliations"><DataTable caption="Reconciliation differences" rows={cmp.recs} rowKey={(r) => r.id} columns={[{ key: 'i', header: 'Reconciliation', main: true, render: (r) => r.id }, { key: 'b', header: 'Before', render: (r) => r.before }, { key: 'a', header: 'After', render: (r) => r.after }, { key: 'c', header: 'Changed', render: (r) => (r.changed ? <Badge tone="warn">changed</Badge> : <span className="muted">same</span>) }]} /></Card>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- verify
function Verify() {
  const st = useAppState();
  const [which, setWhich] = useState(st.workspaces.lab ? 'lab' : 'main');
  const data = st.workspaces[which] || st.workspaces.main;
  const result = useMemo(() => verifyDataset(data), [data]);
  const exportDiag = () => downloadText(`ledgerlens-diagnostics-${data.settings.asOfDate}.md`, buildDiagnostics(data, result, new Date().toISOString()), 'text/markdown');
  const exportJson = () => downloadText(`ledgerlens-verification-${data.settings.asOfDate}.json`, JSON.stringify({ dataset: data.meta.name, summary: result.summary, checks: result.checks.map((c) => ({ id: c.id, title: c.title, status: c.status, findings: c.findings })) }, null, 2));
  return (
    <div className="stack">
      <Card>
        <div className="row between">
          <SelectField label="Verify" value={which} onChange={setWhich} options={[{ value: 'lab', label: 'Test Lab sandbox', disabled: !st.workspaces.lab }, { value: 'main', label: 'My finances' }]} />
          <div className="actions"><button type="button" className="btn" onClick={exportDiag}>Export diagnostics (Markdown)</button><button type="button" className="btn" onClick={exportJson}>Export findings (JSON)</button></div>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>"{data.meta.name}": {data.transactions.length} transactions. Checks recompute totals through independent code paths, so a bug in one place shows up as a difference here.</p>
      </Card>
      <Callout tone={result.summary.errorCount ? 'error' : result.summary.warningCount ? 'warn' : 'success'} role="status">
        <strong>{result.summary.errorCount ? `${result.summary.errorCount} error(s)${result.summary.blocked ? ' - calculation is blocked until fixed' : ''}` : 'No errors.'}</strong> {result.summary.warningCount} warning(s), {result.summary.infoCount} note(s). {result.summary.passedChecks} of {result.summary.totalChecks} checks pass.
      </Callout>
      {result.checks.map((c) => (
        <Card key={c.id} title={c.title} actions={<Badge tone={c.status === 'pass' ? 'pos' : c.status === 'fail' ? 'neg' : c.status === 'warn' ? 'warn' : ''}>{c.status === 'pass' ? '✓ pass' : c.status === 'fail' ? '✗ fail' : c.status === 'warn' ? '! warning' : 'skipped'}</Badge>}>
          <p className="small muted">{c.description}</p>
          {c.findings.length > 0 && (
            <ul className="list-plain">
              {c.findings.slice(0, 25).map((f, i) => (
                <li key={i} style={{ display: 'block' }}>
                  <Badge tone={f.blocking ? 'neg' : f.severity === 'warning' ? 'warn' : 'info'}>{f.blocking ? 'Blocks calculation' : f.severity === 'warning' ? 'Warning' : 'Note'}</Badge> {f.message}
                  {f.refs.length > 0 && <div className="tiny muted">Records: {f.refs.map((r) => `${r.type}:${r.id}`).join(', ')}</div>}
                </li>
              ))}
              {c.findings.length > 25 && <li className="muted small">+{c.findings.length - 25} more in the export.</li>}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}
