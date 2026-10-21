import { useMemo, useState } from 'react';
import { useAppState, useStore, useToasts } from '../../state/hooks.jsx';
import { exportDatasetJson, exportFileName, parseImportText, diffCounts, MAX_IMPORT_CHARS } from '../../persistence/serialize.js';
import { KEYS, STORAGE_PREFIX } from '../../persistence/storage.js';
import { updateSettings, renameDataset } from '../../domain/ops/catalog.js';
import { buildDemoDataset } from '../../seed/demo.js';
import { toCsv } from '../../imports/csv.js';
import { buildIndex } from '../../domain/ledger.js';
import { categoryLabel } from '../TxParts.jsx';
import { formatMoney, centsToDecimalString, parsePercentToBps } from '../../domain/money.js';
import { formatDate } from '../../domain/dates.js';
import { PageHead, Card, Callout, Explain, Badge } from '../components/Common.jsx';
import { CheckField, SelectField, TextAreaField, TextField } from '../components/Form.jsx';
import DataTable from '../components/DataTable.jsx';
import { useConfirm } from '../components/Modal.jsx';
import { downloadText, readFileText, txTypeLabel } from '../format.js';

export default function Settings() {
  const st = useAppState();
  const store = useStore();
  const { push } = useToasts();
  const confirm = useConfirm();
  const main = st.workspaces.main;
  const active = st.workspaces[st.active];
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState(null);
  const [backupFirst, setBackupFirst] = useState(true);
  const [backups, setBackups] = useState(() => store.storage.listCorruptBackups());
  const usage = store.storage.usage();
  const growthText = String((active.settings.investmentGrowthBps || 0) / 100);
  const [growth, setGrowth] = useState(growthText);
  const [name, setName] = useState(main?.meta.name || '');
  const counts = useMemo(() => (main ? diffCounts(main, preview?.dataset || main) : []), [main, preview]);

  const downloadMain = () => {
    const ok = downloadText(exportFileName(main), exportDatasetJson(main));
    push(ok ? { kind: 'success', title: 'Export downloaded', message: 'Keep this file somewhere safe: it is the only way to restore on another browser.' } : { kind: 'error', title: 'Download blocked', message: 'Copy the JSON text instead using the preview below.' });
    return ok;
  };
  const downloadCsv = () => {
    const idx = buildIndex(main);
    const rows = [['Date', 'Description', 'Merchant', 'Account', 'Amount', 'Status', 'Type', 'Category', 'Tags', 'Reference', 'Notes']];
    for (const t of idx.sortedTx) rows.push([t.date, t.description, t.merchant, idx.accountsById.get(t.accountId)?.name || '', centsToDecimalString(t.amountCents), t.status, txTypeLabel(t), categoryLabel(t, idx), t.tags.join(';'), t.source?.externalId || '', t.notes]);
    downloadText(`ledgerlens-transactions-${main.settings.asOfDate}.csv`, toCsv(rows), 'text/csv');
  };
  const readImport = async (text) => {
    const r = parseImportText(text);
    setPreview(r);
    if (!r.ok) push({ kind: 'error', title: 'Cannot import this file', message: r.error });
  };
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = await readFileText(f, MAX_IMPORT_CHARS);
      setPaste('');
      await readImport(text);
    } catch (err) {
      setPreview({ ok: false, error: err.message, findings: [], notes: [] });
    }
    e.target.value = '';
  };
  const applyImport = async () => {
    if (!preview?.ok) return;
    const ok = await confirm({ title: 'Replace My finances with this file?', danger: true, confirmLabel: 'Replace my data', message: (<div><p>This <strong>replaces</strong> everything in My finances ({main.transactions.length} transactions, {main.accounts.length} accounts) with the file ({preview.dataset.transactions.length} transactions, {preview.dataset.accounts.length} accounts). Merging is not supported.</p><p>{backupFirst ? 'A backup of your current data will be downloaded first, and you can undo right after.' : 'You chose not to download a backup first. You can still undo right after.'}</p></div>) });
    if (!ok) return;
    if (backupFirst) downloadMain();
    const r = store.replaceWorkspace('main', preview.dataset, 'import JSON');
    if (r.ok !== false) {
      push({ kind: 'success', title: 'Data imported', message: `${preview.dataset.meta.name} is now loaded.`, action: { label: 'Undo', run: () => store.undo() } });
      setPreview(null);
      setPaste('');
    }
  };
  const reset = async () => {
    const ok = await confirm({ title: 'Reset to the demo data?', danger: true, confirmLabel: 'Reset to demo data', message: (<div><p>This replaces <strong>My finances</strong> with the original deterministic demo ({buildDemoDataset().transactions.length} fictional transactions). Your current edits are removed from view; you can undo straight afterwards.</p><p>Download a backup first if the current data matters.</p></div>), extraAction: { label: 'Download a backup first', run: downloadMain } });
    if (!ok) return;
    store.resetDemo();
    push({ kind: 'success', title: 'Demo data restored', action: { label: 'Undo', run: () => store.undo() } });
  };
  const clearAll = async () => {
    const ok = await confirm({ title: 'Clear all local data?', danger: true, confirmLabel: 'Erase everything', requireText: 'DELETE', message: <p>This erases My finances, the Test Lab sandbox and the undo history from this browser, then starts again with the demo data. It cannot be undone. Export a backup first.</p>, extraAction: { label: 'Download a backup first', run: downloadMain } });
    if (!ok) return;
    store.clearLocalData();
    setBackups(store.storage.listCorruptBackups());
    push({ kind: 'success', title: 'Local data cleared', message: 'Started again with demo data.' });
  };

  const changeSetting = (patch) => {
    const r = store.apply((d) => updateSettings(d, patch), { label: 'change settings' });
    if (!r.ok) push({ kind: 'error', title: 'Not saved', message: r.errors.map((e) => e.message).join(' ') });
  };

  return (
    <>
      <PageHead title="Settings & data management">Where your data lives, how to back it up, restore it, and start over safely.</PageHead>
      {st.active === 'lab' && <Callout tone="info">You are viewing the Test Lab sandbox. Export, import, reset and clear below act on <strong>My finances</strong>, never on the sandbox. Preferences affect the dataset on screen.</Callout>}
      <div className="stack" style={{ marginTop: 12 }}>
        <Card title="Where your data is stored">
          <p>LedgerLens keeps everything <strong>in this browser</strong>, in localStorage, under keys starting with <code>{STORAGE_PREFIX}</code> (<code>{KEYS.workspace('main')}</code> for My finances, <code>{KEYS.workspace('lab')}</code> for the Test Lab sandbox). Nothing is sent anywhere - there are no accounts, servers or analytics.</p>
          <ul>
            <li><strong>Browser-specific:</strong> a different browser, profile, or private window starts with its own empty copy. Clearing site data erases it.</li>
            <li><strong>Survives:</strong> page reloads and restarting the browser or the dev server on the same browser profile and address.</li>
            <li><strong>Backups:</strong> use <em>Export JSON</em> below. Restore it with <em>Import JSON</em> on any browser.</li>
          </ul>
          <p className="small muted">Storage used by LedgerLens: about {(usage / 1024).toFixed(0)} KB. Persistence is {st.persistent ? <Badge tone="pos">active</Badge> : <Badge tone="warn">unavailable - changes are kept in memory only</Badge>}. Last change {main ? '' : ''}</p>
        </Card>

        <Card title="Export (backup)">
          <p>Download everything in <strong>My finances</strong> as a human-readable, versioned JSON file (accounts, transactions, splits, transfers, categories, rules, budgets, recurring items, goals, reconciliations, import batches, scenarios, settings). Transfer links, reconciliation status and ids are preserved exactly.</p>
          <div className="actions">
            <button type="button" className="btn primary" onClick={downloadMain}>Export JSON backup</button>
            <button type="button" className="btn" onClick={downloadCsv}>Export transactions as CSV</button>
          </div>
        </Card>

        <Card title="Import a JSON backup">
          <p className="small">Importing <strong>replaces</strong> My finances (there is no merging, so nothing is silently combined). The file is fully validated first; if anything is wrong, nothing changes.</p>
          <div className="form-grid">
            <label className="field"><span>Choose a LedgerLens export file</span><input type="file" accept="application/json,.json" onChange={onFile} /></label>
            <TextAreaField className="wide code" label="...or paste JSON" value={paste} onChange={setPaste} rows={4} />
          </div>
          <div className="actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn" disabled={!paste.trim()} onClick={() => readImport(paste)}>Validate pasted JSON</button>
          </div>
          {preview && (
            <div style={{ marginTop: 12 }} aria-live="polite">
              {!preview.ok ? (
                <Callout tone="error">
                  <strong>Not importable.</strong> {preview.error}
                  {preview.findings?.length > 0 && <ul>{preview.findings.filter((f) => f.blocking).slice(0, 8).map((f, i) => <li key={i}>{f.message}</li>)}</ul>}
                  <p className="small">Your current data was not touched.</p>
                </Callout>
              ) : (
                <>
                  <Callout tone="success"><strong>Valid.</strong> "{preview.dataset.meta.name}", as of {formatDate(preview.dataset.settings.asOfDate)}, net worth {formatMoney(preview.summary.netWorthCents ?? 0)}. {preview.notes.join(' ')}</Callout>
                  <DataTable caption="What would change" rows={counts} rowKey={(c) => c.collection} columns={[{ key: 'l', header: 'Record type', main: true, render: (c) => c.label }, { key: 'c', header: 'Now', className: 'num', render: (c) => c.current }, { key: 'i', header: 'After import', className: 'num', render: (c) => c.incoming }]} />
                  {preview.findings.filter((f) => !f.blocking).length > 0 && <Callout tone="warn" style={{ marginTop: 8 }}>{preview.findings.filter((f) => !f.blocking).length} advisory finding(s), for example: {preview.findings.filter((f) => !f.blocking)[0].message}</Callout>}
                  <div style={{ marginTop: 8 }}><CheckField label="Download a backup of my current data first" checked={backupFirst} onChange={setBackupFirst} /></div>
                  <div className="actions" style={{ marginTop: 8 }}>
                    <button type="button" className="btn danger" onClick={applyImport}>Replace My finances with this file</button>
                    <button type="button" className="btn" onClick={() => setPreview(null)}>Cancel</button>
                  </div>
                </>
              )}
            </div>
          )}
        </Card>

        <Card title="Reset or clear">
          <div className="grid cols-2">
            <div>
              <h3>Reset to demo data</h3>
              <p className="small">Restores the original deterministic demo. Always identical, never random. Asks first and can be undone.</p>
              <button type="button" className="btn" onClick={reset}>Reset to demo data...</button>
            </div>
            <div>
              <h3>Clear all local data</h3>
              <p className="small">Erases everything LedgerLens stored in this browser, including the sandbox. Requires typing DELETE.</p>
              <button type="button" className="btn danger" onClick={clearAll}>Clear local data...</button>
            </div>
          </div>
        </Card>

        {backups.length > 0 && (
          <Card title="Recovered (unreadable) data kept as backups">
            <p className="small">When saved data could not be read, a verbatim copy was kept here so nothing is lost.</p>
            <ul className="list-plain">
              {backups.map((k) => (
                <li key={k}>
                  <code>{k.replace(STORAGE_PREFIX, '')}</code>
                  <span className="row">
                    <button type="button" className="btn small" onClick={() => downloadText(`${k.replace(/[^a-z0-9]+/gi, '-')}.json`, store.storage.readRaw(k) || '')}>Download</button>
                    <button type="button" className="btn small danger" onClick={() => { store.storage.removeKey(k); setBackups(store.storage.listCorruptBackups()); }}>Delete</button>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title="Preferences">
          <div className="form-grid">
            <SelectField label="Theme" value={st.prefs?.theme || 'system'} onChange={(v) => store.setPrefs({ theme: v })} options={[{ value: 'system', label: 'Match my device' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
            <TextField label="As-of date (reporting and forecast date)" type="date" value={active.settings.asOfDate} onChange={(v) => v && changeSetting({ asOfDate: v })} hint="The demo uses 2026-10-01. Balances, reports and forecasts are calculated as of this date." />
            <SelectField label="Balance basis" value={active.settings.basis} onChange={(v) => changeSetting({ basis: v })} options={[{ value: 'posted', label: 'Posted only (statement view)' }, { value: 'pending', label: 'Include pending items' }]} hint="Applies everywhere: dashboard, budgets, reports." />
            <TextField label="Default assumed investment growth (% per year)" value={growth} onChange={setGrowth} hint="Forecast only. 0 means investments are held flat." onBlur={() => { const neg = growth.trim().startsWith('-'); const r = parsePercentToBps(growth.replace('-', '') || '0'); if (r.ok) changeSetting({ investmentGrowthBps: neg ? -r.bps : r.bps }); else push({ kind: 'error', title: 'Not saved', message: r.error }); }} />
            <TextField label="Dataset name" value={name} onChange={setName} hint="Press Tab to save." onBlur={() => name !== main.meta.name && store.apply((d) => renameDataset(d, name), { workspace: 'main', label: 'rename dataset' })} />
          </div>
        </Card>

        <Explain summary="Accounting conventions and limitations">
          <ul>
            <li>Money is stored as integer cents; interest and percentages are rounded half away from zero to the cent.</li>
            <li>Dates are calendar dates (YYYY-MM-DD) without time zones.</li>
            <li>External transfers (to accounts outside LedgerLens) are single-sided and change net worth but are not income or spending.</li>
            <li>There is no bank connection, no live market data, and nothing here is financial advice. Projections are planning estimates.</li>
            <li>Data is only as safe as your browser profile: export regularly.</li>
          </ul>
        </Explain>
      </div>
    </>
  );
}
