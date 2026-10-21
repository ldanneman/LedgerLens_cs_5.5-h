import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useData, useRun, useStore } from '../../state/hooks.jsx';
import { buildIndex, isLiabilityType } from '../../domain/ledger.js';
import { parseCsv, detectDelimiter, IMPORT_LIMITS } from '../../imports/csv.js';
import { FORMAT_PRESETS, DATE_FORMATS, defaultMapping, suggestMapping, normalizeRows, signHint } from '../../imports/mapping.js';
import { matchRows, summarizePlan, settlementSplitPlan } from '../../imports/matching.js';
import { commitImport, undoImportBatch } from '../../domain/ops/importing.js';
import { suggestTransferPairs, linkAsTransfer } from '../../domain/ops/transactions.js';
import { reconciliationCandidates, reconcileMath, suggestStatement, reconciliationHealth, diagnoseDiscrepancy, reconciledTxIds, safeSnapshots } from '../../domain/reconciliation.js';
import { saveReconciliationDraft, completeReconciliation, reopenReconciliation, deleteReconciliation, addReconciliationAdjustment } from '../../domain/ops/reconcile.js';
import { formatDate, monthEnd, monthStart, monthKey, addMonthKey } from '../../domain/dates.js';
import { formatMoney, parseMoney, centsToDecimalString } from '../../domain/money.js';
import { PageHead, Card, Badge, Callout, Explain, EmptyState, Pager, Boundary } from '../components/Common.jsx';
import { Money } from '../components/Money.jsx';
import DataTable from '../components/DataTable.jsx';
import { SelectField, TextField, TextAreaField, CheckField, MoneyField, ErrorSummary } from '../components/Form.jsx';
import { Modal, useConfirm } from '../components/Modal.jsx';
import { TxBadges } from '../TxParts.jsx';
import { useEditors } from '../modals/Editors.jsx';
import { readFileText, downloadText } from '../format.js';
import { remember, recall } from '../period.js';

export default function ImportReconcile() {
  const { tab = 'csv' } = useParams();
  return (
    <>
      <nav className="tabs" aria-label="Import and reconcile sections">
        <NavLink to="/import" end>Import CSV</NavLink>
        <NavLink to="/import/reconcile">Reconcile a statement</NavLink>
        <NavLink to="/import/history">Import & reconciliation history</NavLink>
      </nav>
      {tab === 'reconcile' ? <Reconcile /> : tab === 'history' ? <History /> : <CsvImport />}
    </>
  );
}

// ---------------------------------------------------------------- CSV import
const SAMPLE_CSV = `Date,Description,Amount,Reference
2026-09-28,Green Basket Market,-54.20,SAMPLE-0001
2026-09-28,Corner Bean Coffee,-4.75,SAMPLE-0002
2026-09-28,Corner Bean Coffee,-4.75,SAMPLE-0003
2026-09-29,"Pharmacy, Maple Street",-18.40,SAMPLE-0004
2026-09-30,Payroll deposit,2684.12,SAMPLE-0005
`;

const MATCH_BADGE = {
  new: { tone: 'pos', label: 'New' },
  settles_pending: { tone: 'info', label: 'Settles pending' },
  duplicate: { tone: '', label: 'Already imported' },
  in_file_duplicate: { tone: 'warn', label: 'Repeated in file' },
  suspected: { tone: 'warn', label: 'Possible duplicate' },
  rejected: { tone: 'neg', label: 'Rejected' },
};

function CsvImport() {
  const data = useData();
  const run = useRun();
  const confirm = useConfirm();
  const store = useStore();
  const [params] = useSearchParams();
  const accounts = data.accounts.filter((a) => a.status === 'active');
  const [accountId, setAccountId] = useState(params.get('acct') || recall('import-acct', accounts[0]?.id || ''));
  const [text, setText] = useState(() => recall('import-text', ''));
  const [fileName, setFileName] = useState(() => recall('import-name', 'pasted.csv'));
  const [delimiter, setDelimiter] = useState(',');
  const [presetId, setPresetId] = useState('generic');
  const [mapping, setMapping] = useState(defaultMapping());
  const [decisions, setDecisions] = useState({});
  const [targets, setTargets] = useState({}); // line -> pending item the user chose to settle (instead of the proposed one)
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [result, setResult] = useState(null);
  const [readError, setReadError] = useState('');
  const deferred = useDeferredValue(text);
  const acct = accounts.find((a) => a.id === accountId);

  // take a sample handed over from the Test Lab
  useEffect(() => {
    const incoming = recall('import-incoming', null);
    if (incoming) {
      setText(incoming.text);
      setFileName(incoming.name);
      if (incoming.account) setAccountId(incoming.account);
      remember('import-incoming', null);
    }
  }, []);

  const parsed = useMemo(() => (deferred.trim() ? parseCsv(deferred, { delimiter }) : null), [deferred, delimiter]);
  const headers = parsed?.ok ? parsed.rows[0] || [] : [];

  // re-suggest the mapping whenever a new file shape arrives
  useEffect(() => {
    if (!parsed?.ok || !parsed.rows.length) return;
    const preset = FORMAT_PRESETS.find((p) => p.id === presetId);
    const sug = suggestMapping(parsed.rows[0]);
    setMapping((m) => ({ ...defaultMapping(), ...sug, dateFormat: m.dateFormat, decimal: m.decimal, hasHeader: m.hasHeader, amountMode: preset?.id === 'debit-credit' ? 'debit_credit' : sug.amountMode, invertSign: preset ? preset.invertSign : false }));
    setDecisions({});
    setTargets({});
    setPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed?.rows?.[0]?.join('|'), presetId]);

  const norm = useMemo(() => (parsed?.ok ? normalizeRows(parsed.rows, parsed.lines, mapping, { asOfDate: data.settings.asOfDate }) : null), [parsed, mapping, data.settings.asOfDate]);
  const matched = useMemo(() => (norm && !norm.blocking && accountId ? matchRows(data, accountId, norm.rows) : []), [norm, data, accountId]);
  const rows = useMemo(() => matched.map((r) => ({ ...r, decision: decisions[r.line], settleTxId: targets[r.line] })), [matched, decisions, targets]);
  const summary = useMemo(() => summarizePlan(rows), [rows]);
  const hint = acct && norm && !norm.blocking ? signHint(acct.type, norm.summary, mapping.invertSign) : null;
  const visible = rows.filter((r) => (filter === 'all' ? true : filter === 'attention' ? r.match.type === 'suspected' || r.match.type === 'in_file_duplicate' || r.warnings?.length || r.match.type === 'settles_pending' : filter === 'rejected' ? r.match.type === 'rejected' : r.match.type === filter));
  const size = 100;
  const pageCount = Math.max(1, Math.ceil(visible.length / size));
  const safePage = Math.min(page, pageCount - 1);
  const shown = visible.slice(safePage * size, safePage * size + size);
  const effectiveAction = (r) => r.decision || r.match.action;

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const t = await readFileText(f, IMPORT_LIMITS.maxChars);
      setReadError('');
      setText(t);
      setFileName(f.name);
      setDelimiter(detectDelimiter(t));
      remember('import-text', t);
      remember('import-name', f.name);
    } catch (err) {
      setReadError(err.message);
    }
    e.target.value = '';
  };
  const setMap = (p) => setMapping((m) => ({ ...m, ...p }));
  const colOptions = headers.map((h, i) => ({ value: String(i), label: `${i + 1}. ${h || '(blank)'}` }));
  const colSel = (key, label, required) => (
    <SelectField label={`${label}${required ? '' : ' (optional)'}`} value={mapping[key] >= 0 ? String(mapping[key]) : ''} onChange={(v) => setMap({ [key]: v === '' ? -1 : Number(v) })} options={colOptions} placeholder={required ? 'Choose a column' : 'Not used'} />
  );

  const commit = async () => {
    const attention = summary.suspected;
    if (attention > 0 && rows.some((r) => r.match.type === 'suspected' && effectiveAction(r) === 'import')) {
      const ok = await confirm({ title: 'Keep possible duplicates?', message: `${rows.filter((r) => r.match.type === 'suspected' && effectiveAction(r) === 'import').length} row(s) that look like existing entries are set to Keep. Import them as separate transactions?`, confirmLabel: 'Import them' });
      if (!ok) return;
    }
    const res = run((d) => commitImport(d, { accountId, fileName, rows }, { now: new Date().toISOString() }), { label: `import ${fileName}`, failTitle: 'Import not applied', success: 'Import complete', undo: false });
    if (res.ok) {
      setResult(res);
      remember('import-text', '');
      setText('');
      setDecisions({});
      setTargets({});
    }
  };
  const pairs = result ? suggestTransferPairs(store.data()).filter((p) => store.data().importBatches.find((b) => b.id === result.batchId)?.createdTxIds.some((id) => id === p.outflow.id || id === p.inflow.id)) : [];

  return (
    <>
      <PageHead title="Import CSV transactions">
        Nothing is saved until you review the preview and commit. Every import can be undone as a batch.
      </PageHead>
      <div className="stack">
        {result && (
          <Callout tone="success" role="status">
            <strong>Import committed.</strong> {result.imported} new, {result.settled} pending settled, {result.skipped} skipped, {result.rejected} rejected.{' '}
            <button type="button" className="btn small" onClick={async () => { if (await confirm({ title: 'Undo this import?', danger: true, confirmLabel: 'Undo import', message: `Removes the ${result.imported} transaction(s) it created and restores ${result.settled} settled pending item(s). Nothing else is touched.` })) { const r = run((d) => undoImportBatch(d, result.batchId, { now: new Date().toISOString() }), { label: 'undo import', success: 'Import undone', failTitle: 'Cannot undo' }); if (r.ok) setResult(null); } }}>Undo this import</button>{' '}
            <Link to="/transactions?src=imported">View imported transactions</Link>
            {pairs.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <strong>Possible card/loan payments:</strong> these entries look like the two sides of one transfer. Link them so the payment is not counted as spending.
                <ul>
                  {pairs.map((p) => (
                    <li key={p.outflow.id}>
                      {p.outflow.description} ({formatMoney(p.outflow.amountCents)}) ↔ {p.inflow.description}{' '}
                      <button type="button" className="btn small" onClick={() => run((d) => linkAsTransfer(d, p.outflow.id, p.inflow.id), { label: 'link as transfer', success: 'Linked as a transfer', undo: true })}>Link as transfer</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Callout>
        )}

        <Card title="1. Choose the account and file" className="step">
          <div className="form-grid">
            <SelectField label="Destination account" value={accountId} onChange={(v) => { setAccountId(v); remember('import-acct', v); setDecisions({}); setTargets({}); }} options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
            <SelectField label="File layout" value={presetId} onChange={setPresetId} options={FORMAT_PRESETS.map((p) => ({ value: p.id, label: p.label }))} hint={FORMAT_PRESETS.find((p) => p.id === presetId)?.hint} />
            <label className="field">
              <span>CSV file (max {IMPORT_LIMITS.maxChars / 1024 / 1024} MB, {IMPORT_LIMITS.maxRows.toLocaleString('en-US')} rows)</span>
              <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} />
            </label>
            <SelectField label="Delimiter" value={delimiter} onChange={setDelimiter} options={[{ value: ',', label: 'Comma' }, { value: ';', label: 'Semicolon' }, { value: '\t', label: 'Tab' }]} />
          </div>
          {readError && <p className="error-text" role="alert">{readError}</p>}
          <TextAreaField label="...or paste CSV text" value={text} onChange={(v) => { setText(v); remember('import-text', v); setFileName('pasted.csv'); }} className="code" rows={5} placeholder="Date,Description,Amount" />
          <div className="actions">
            <button type="button" className="btn small" onClick={() => { setText(SAMPLE_CSV); setFileName('sample.csv'); }}>Use a small example</button>
            <button type="button" className="btn small" onClick={() => downloadText('ledgerlens-example.csv', SAMPLE_CSV, 'text/csv')}>Download the example file</button>
            {text && <button type="button" className="btn small" onClick={() => { setText(''); remember('import-text', ''); setResult(null); }}>Clear</button>}
          </div>
        </Card>

        {parsed && !parsed.ok && <Callout tone="error"><strong>The file could not be read.</strong> {parsed.error} Nothing was imported.</Callout>}
        {parsed?.ok && parsed.warnings.length > 0 && <Callout tone="warn">{parsed.warnings.length} formatting warning(s), for example line {parsed.warnings[0].line}: {parsed.warnings[0].message}</Callout>}

        {parsed?.ok && (
          <Card title="2. Map the columns" className="step">
            <div className="form-grid">
              <CheckField label="First row contains headers" checked={mapping.hasHeader} onChange={(v) => setMap({ hasHeader: v })} />
              {colSel('dateCol', 'Date column', true)}
              {colSel('descriptionCol', 'Description column', true)}
              <SelectField label="Amounts are in" value={mapping.amountMode} onChange={(v) => setMap({ amountMode: v })} options={[{ value: 'signed', label: 'One signed Amount column' }, { value: 'debit_credit', label: 'Separate Debit and Credit columns' }]} />
              {mapping.amountMode === 'signed' ? colSel('amountCol', 'Amount column', true) : (<>{colSel('debitCol', 'Debit (money out) column', true)}{colSel('creditCol', 'Credit (money in) column', true)}</>)}
              {colSel('externalIdCol', 'Reference / ID column')}
              {colSel('merchantCol', 'Merchant column')}
              {colSel('statusCol', 'Status column')}
              {colSel('categoryCol', 'Category column')}
              {colSel('notesCol', 'Notes column')}
              <SelectField label="Date format" value={mapping.dateFormat} onChange={(v) => setMap({ dateFormat: v })} options={DATE_FORMATS.map((d) => ({ value: d.id, label: d.label }))} />
              <SelectField label="Decimal separator" value={mapping.decimal} onChange={(v) => setMap({ decimal: v })} options={[{ value: '.', label: 'Period (1,234.56)' }, { value: ',', label: 'Comma (1.234,56)' }]} />
              <CheckField label="Flip signs" checked={mapping.invertSign} onChange={(v) => setMap({ invertSign: v })} hint="Use when the file shows purchases as positive numbers." />
            </div>
            {norm?.blocking && <Callout tone="warn" style={{ marginTop: 10 }}>{norm.blocking}</Callout>}
            {hint && <Callout tone="warn" style={{ marginTop: 10 }}>{hint}</Callout>}
          </Card>
        )}

        {norm && !norm.blocking && (
          <Card title="3. Review the preview" className="step" actions={<span className="small muted">{rows.length.toLocaleString('en-US')} rows read · format {DATE_FORMATS.find((d) => d.id === norm.dateFormat)?.label}</span>}>
            <div className="row" style={{ marginBottom: 10 }} aria-live="polite">
              <Badge tone="pos">{summary.import} to import</Badge>
              <Badge tone="info">{summary.settle} settle pending</Badge>
              <Badge>{summary.duplicates} already imported</Badge>
              <Badge tone="warn">{summary.suspected} possible duplicates</Badge>
              <Badge tone="neg">{summary.rejected} rejected</Badge>
              <Badge>{summary.skipped} skipped</Badge>
              {summary.attention > 0 && <Badge tone="warn">{summary.attention} to review</Badge>}
            </div>
            <Explain summary="How duplicates are detected">
              <p>A row with the same <strong>reference</strong> as an existing transaction in this account is the same bank record and is skipped. A different reference means a different purchase, even if date, amount and merchant match (two coffees are both kept). Without references, identical rows are matched by count, and anything that looks like an existing entry is flagged "Possible duplicate" and skipped by default; choose <em>Keep</em> to import it anyway. A posted row that resembles a pending item <em>settles</em> it instead of duplicating it, but only if their references do not conflict: when both carry a reference and the two differ, they are different purchases and the row is imported as new. Matches made by similarity (no shared reference) are marked "similarity" and should be checked; if several pending items look alike you can pick which one to settle. When a settled amount changes, the item's category splits are rescaled in proportion and still add up to the cent.</p>
            </Explain>
            <div className="row" style={{ margin: '10px 0' }}>
              <SelectField label="Show" value={filter} onChange={(v) => { setFilter(v); setPage(0); }} options={[{ value: 'all', label: 'All rows' }, { value: 'attention', label: 'Needs attention' }, { value: 'new', label: 'New' }, { value: 'duplicate', label: 'Already imported' }, { value: 'suspected', label: 'Possible duplicates' }, { value: 'settles_pending', label: 'Settles pending' }, { value: 'rejected', label: 'Rejected' }]} />
            </div>
            <DataTable
              caption="Import preview"
              rows={shown}
              rowKey={(r) => `${r.line}`}
              rowClass={(r) => (r.match.type === 'rejected' ? 'rejected' : '')}
              columns={[
                { key: 'line', header: 'Line', className: 'num', render: (r) => r.line },
                { key: 'date', header: 'Date', className: 'nowrap', render: (r) => (r.date ? formatDate(r.date) : <span className="error-text">{r.raw[mapping.dateCol] || '-'}</span>) },
                { key: 'desc', header: 'Description', main: true, render: (r) => (<div className="desc-cell"><div className="title">{r.description || <span className="muted">(empty)</span>}</div>{r.externalId && <div className="sub">Ref {r.externalId}</div>}{r.status === 'pending' && <Badge tone="warn">Pending</Badge>}{r.warnings?.map((w) => <div key={w} className="sub">Warning: {w}</div>)}</div>) },
                { key: 'amt', header: 'Amount', className: 'num', render: (r) => (r.amountCents === null ? <span className="error-text">-</span> : <Money cents={r.amountCents} signed />) },
                { key: 'result', header: 'Result', render: (r) => <ResultCell r={r} data={data} /> },
                {
                  key: 'decision',
                  header: 'Action',
                  render: (r) => {
                    if (r.match.type === 'rejected') return <span className="muted">Skipped</span>;
                    if (r.match.type === 'duplicate' || r.match.type === 'in_file_duplicate') return <span className="muted">Skip</span>;
                    const opts = r.match.type === 'settles_pending' ? [{ value: 'settle', label: 'Settle the pending item' }, { value: 'import', label: 'Import as new' }, { value: 'skip', label: 'Skip' }] : r.match.type === 'suspected' ? [{ value: 'skip', label: 'Skip (duplicate)' }, { value: 'import', label: 'Keep (separate purchase)' }] : [{ value: 'import', label: 'Import' }, { value: 'skip', label: 'Skip' }];
                    const choices = r.match.type === 'settles_pending' && r.match.alternatives?.length ? [r.match.existingTxId, ...r.match.alternatives] : null;
                    if (choices) {
                      return (
                        <div className="stack" style={{ gap: 4 }}>
                          <select aria-label={`Action for line ${r.line}`} value={effectiveAction(r)} onChange={(e) => setDecisions((d) => ({ ...d, [r.line]: e.target.value }))} style={{ minHeight: 32, minWidth: 190 }}>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                          {effectiveAction(r) === 'settle' && (
                            <select aria-label={`Pending item to settle for line ${r.line}`} value={targets[r.line] || r.match.existingTxId} onChange={(e) => setTargets((t) => ({ ...t, [r.line]: e.target.value }))} style={{ minHeight: 32, minWidth: 190 }}>
                              {choices.map((id) => { const t = data.transactions.find((x) => x.id === id); return <option key={id} value={id}>{t ? `${t.description} (${formatDate(t.date)}, ${formatMoney(t.amountCents)})` : id}</option>; })}
                            </select>
                          )}
                        </div>
                      );
                    }
                    return <select aria-label={`Action for line ${r.line}`} value={effectiveAction(r)} onChange={(e) => setDecisions((d) => ({ ...d, [r.line]: e.target.value }))} style={{ minHeight: 32, minWidth: 190 }}>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
                  },
                },
              ]}
            />
            <Pager page={safePage} pageCount={pageCount} total={visible.length} size={size} onPage={setPage} />
            <div className="actions" style={{ marginTop: 12 }}>
              <button type="button" className="btn primary" onClick={commit} disabled={summary.import + summary.settle === 0}>
                Commit import ({summary.import} new{summary.settle ? `, ${summary.settle} settled` : ''})
              </button>
              <span className="small muted">{summary.skipped + summary.rejected} row(s) will not be imported. A failed commit changes nothing.</span>
            </div>
          </Card>
        )}
        {!text.trim() && !result && <Card><EmptyState title="Choose a CSV file or paste text to begin">Supports quoted fields, commas and line breaks inside quotes, debit/credit columns, and several date formats.</EmptyState></Card>}
      </div>
    </>
  );
}

/** The "Result" cell of the preview: badge, reason, and the exact split re-allocation for a changed amount. */
function ResultCell({ r, data }) {
  const m = r.match;
  const pending = m.type === 'settles_pending' ? data.transactions.find((t) => t.id === (r.settleTxId || m.existingTxId)) : null;
  // when another pending item was picked, show the plan for THAT item
  const plan = pending && r.settleTxId && r.settleTxId !== m.existingTxId ? settlementSplitPlan(pending, r.amountCents) : m.splitPlan;
  const catName = (id) => data.categories.find((c) => c.id === id)?.name || id;
  return (
    <div>
      <Badge tone={MATCH_BADGE[m.type].tone}>{MATCH_BADGE[m.type].label}</Badge>
      {m.type === 'settles_pending' && m.basis === 'heuristic' && <Badge tone="warn" title="Matched by date, amount and description, not by a shared reference">similarity</Badge>}
      {m.ambiguous && <Badge tone="warn">{m.alternatives.length + 1} candidates</Badge>}
      {m.reason && <div className="small muted">{m.reason}</div>}
      {plan && (
        <div className="small" data-testid={`split-plan-${r.line}`}>
          <strong>Splits after settling:</strong>{' '}
          {plan.after.map((x, i) => <span key={i}>{i ? ' · ' : ''}{catName(x.categoryId)} {formatMoney(x.amountCents, { signed: true })}</span>)}
          {plan.dropped.length > 0 && <span className="muted"> (dropped, rounds to $0.00: {plan.dropped.map((x) => catName(x.categoryId)).join(', ')})</span>}
          <span className="muted"> - was {plan.before.map((x) => formatMoney(x.amountCents, { signed: true })).join(' · ')}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- reconcile
function monthBounds(asOf) {
  const prev = addMonthKey(monthKey(asOf), -1);
  return { start: monthStart(prev), end: monthEnd(prev) };
}

function Reconcile() {
  const data = useData();
  const [params, setParams] = useSearchParams();
  const accounts = data.accounts.filter((a) => a.status === 'active');
  // a bookmarked or remembered account that no longer exists (or is archived) falls back to the first active account
  const wanted = params.get('acct') || recall('recon-acct', '');
  const acctId = accounts.some((a) => a.id === wanted) ? wanted : accounts[0]?.id || '';
  const recId = params.get('rec') || '';
  const setAcct = (v) => { remember('recon-acct', v); setParams({ acct: v }, { replace: true }); };
  const rec = recId ? data.reconciliations.find((r) => r.id === recId && r.accountId === acctId) || null : null;
  return (
    <>
      <PageHead title="Reconcile a statement">Compare your ledger to a bank or card statement, clear what matches, and finish only when the difference is exactly $0.00.</PageHead>
      <Card style={{ marginBottom: 16 }}>
        <SelectField label="Account" value={acctId} onChange={setAcct} options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
      </Card>
      {acctId ? <ReconcileForm key={`${acctId}|${recId}`} acctId={acctId} rec={rec} onOpen={(id) => setParams({ acct: acctId, ...(id ? { rec: id } : {}) }, { replace: true })} /> : <EmptyState title="No account">Add an account first.</EmptyState>}
    </>
  );
}

function ReconcileForm({ acctId, rec, onOpen }) {
  const data = useData();
  const run = useRun();
  const confirm = useConfirm();
  const editors = useEditors();
  const index = useMemo(() => buildIndex(data), [data]);
  const acct = index.accountsById.get(acctId);
  const liability = isLiabilityType(acct.type);
  const asOf = data.settings.asOfDate;
  const completed = rec?.status === 'completed';
  const health = rec ? reconciliationHealth(data, rec) : { valid: true, problems: [] };
  const sug = useMemo(() => {
    const b = monthBounds(asOf);
    const s = suggestStatement(data, acctId, b.start, b.end);
    return { ...b, ...s };
  }, [data, acctId, asOf]);
  const toField = (cents) => centsToDecimalString(liability ? -cents : cents);
  const [start, setStart] = useState(rec?.startDate || sug.start);
  const [end, setEnd] = useState(rec?.endDate || sug.end);
  const [opening, setOpening] = useState(rec ? toField(rec.openingCents) : toField(sug.openingCents));
  const [closing, setClosing] = useState(rec ? toField(rec.closingCents) : toField(sug.closingCents));
  const [cleared, setCleared] = useState(() => new Set(rec?.clearedTxIds || []));
  const [earlier, setEarlier] = useState(false);
  const [note, setNote] = useState(rec?.note || '');
  const [errors, setErrors] = useState([]);
  const [adj, setAdj] = useState(null);
  const op = parseMoney(opening || '0');
  const cl = parseMoney(closing || '0');
  const sign = liability ? -1 : 1;
  const openingCents = op.ok ? sign * op.cents : null;
  const closingCents = cl.ok ? sign * cl.cents : null;
  const candidates = useMemo(() => (completed ? [] : reconciliationCandidates(data, acctId, start, end, { includeEarlier: earlier, excludeReconId: rec?.id })), [data, acctId, start, end, earlier, completed, rec]);
  const validCleared = [...cleared].map((id) => index.txById.get(id)).filter((t) => t && t.accountId === acctId && t.status === 'posted');
  const snaps = completed ? safeSnapshots(rec) : [];
  const clearedList = completed ? (Array.isArray(rec.clearedTxIds) ? rec.clearedTxIds : []).map((id) => index.txById.get(id)).filter(Boolean) : validCleared;
  const tableRows = completed ? clearedList : [...validCleared.filter((t) => !candidates.some((c) => c.id === t.id)), ...candidates].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const pendingInRange = (index.txByAccount.get(acctId) || []).filter((t) => t.status === 'pending' && t.date >= start && t.date <= end);
  const math = openingCents !== null && closingCents !== null ? reconcileMath(openingCents, closingCents, completed ? snaps.map((s) => s.amountCents) : clearedList.map((t) => t.amountCents)) : null;
  const reconciled = useMemo(() => reconciledTxIds(data), [data]);
  const recurringById = useMemo(() => new Map(data.recurring.map((r) => [r.id, r])), [data.recurring]);
  const hints = math && !completed && math.discrepancy !== 0 ? diagnoseDiscrepancy(data, { accountId: acctId, startDate: start, endDate: end, clearedTxIds: [...cleared], discrepancyCents: math.discrepancy }) : [];
  const history = data.reconciliations.filter((r) => r.accountId === acctId).sort((a, b) => (a.endDate < b.endDate ? 1 : -1));

  const payload = () => ({ id: rec?.id, accountId: acctId, startDate: start, endDate: end, openingCents, closingCents, clearedTxIds: validCleared.map((t) => t.id), note });
  const validate = () => {
    const errs = [];
    if (!op.ok) errs.push({ message: `Opening balance: ${op.error}` });
    if (!cl.ok) errs.push({ message: `Closing balance: ${cl.error}` });
    setErrors(errs);
    return errs.length === 0;
  };
  const save = () => {
    if (!validate()) return;
    const r = run((d) => saveReconciliationDraft(d, payload(), { now: new Date().toISOString() }), { label: 'save reconciliation draft', success: 'Draft saved', failTitle: 'Draft not saved' });
    if (r.ok) onOpen(r.id);
    else setErrors(r.errors);
  };
  const complete = () => {
    if (!validate()) return;
    const r = run((d) => completeReconciliation(d, payload(), { now: new Date().toISOString() }), { label: 'complete reconciliation', success: 'Reconciliation completed', failTitle: 'Cannot complete yet', undo: true });
    if (r.ok) onOpen(r.id);
    else setErrors(r.errors);
  };
  const toggle = (id, on) => setCleared((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });

  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', alignItems: 'start' }}>
      <div className="stack" style={{ gridColumn: 'span 1' }}>
        <Card title={completed ? `Completed statement ${formatDate(rec.startDate)} to ${formatDate(rec.endDate)}` : 'Statement details'}>
          <ErrorSummary errors={errors} />
          {completed && !health.valid && (
            <Callout tone="error">
              <strong>This reconciliation is out of date.</strong> Records changed after it was completed:
              <ul>{health.problems.map((p, i) => <li key={i}>{p.message}</li>)}</ul>
              Reopen it to re-check and clear the affected items again.
            </Callout>
          )}
          {completed && health.valid && <Callout tone="success">Completed {rec.completedAt ? formatDate(rec.completedAt.slice(0, 10)) : ''}. Every cleared item still matches the ledger.</Callout>}
          <div className="form-grid" style={{ marginTop: 10 }}>
            <TextField label="Statement start date" type="date" value={start} onChange={setStart} disabled={completed} />
            <TextField label="Statement end date" type="date" value={end} onChange={setEnd} disabled={completed} />
            <MoneyField label={liability ? 'Opening balance (amount owed)' : 'Opening balance'} value={opening} onChange={setOpening} disabled={completed} error={opening && !op.ok ? op.error : undefined} />
            <MoneyField label={liability ? 'Closing balance (amount owed)' : 'Closing balance'} value={closing} onChange={setClosing} disabled={completed} error={closing && !cl.ok ? cl.error : undefined} />
          </div>
          {!completed && (
            <p className="small muted">
              Prefilled from your ledger as a suggestion. <strong>Replace the closing balance with the figure printed on your statement</strong> - that is what makes the comparison meaningful.{liability && ' Cards and loans: enter the amount owed as a positive number (it is stored as a negative net-worth contribution).'}
            </p>
          )}
          {!completed && (
            <div className="actions">
              <button type="button" className="btn" onClick={() => { setOpening(toField(sug.openingCents)); setClosing(toField(sug.closingCents)); setStart(sug.start); setEnd(sug.end); }}>Reset suggestions</button>
              <button type="button" className="btn" onClick={() => { const s = suggestStatement(data, acctId, start, end); setOpening(toField(s.openingCents)); setClosing(toField(s.closingCents)); }}>Fill closing from ledger</button>
            </div>
          )}
          <TextField label="Note (optional)" value={note} onChange={setNote} disabled={completed} />
        </Card>

        <Card title={completed ? `Cleared items (${snaps.length})` : `Posted transactions to clear (${tableRows.length})`}>
          {!completed && (
            <div className="row" style={{ marginBottom: 8 }}>
              <button type="button" className="btn small" onClick={() => setCleared(new Set([...cleared, ...candidates.filter((c) => c.date >= start).map((c) => c.id)]))}>Clear all in period</button>
              <button type="button" className="btn small" onClick={() => setCleared(new Set())}>Unclear all</button>
              <CheckField label="Also show older uncleared items" checked={earlier} onChange={setEarlier} />
            </div>
          )}
          <DataTable
            caption="Statement candidates"
            rows={tableRows}
            rowKey={(t) => t.id}
            selectable={!completed}
            selected={cleared}
            onSelect={toggle}
            onSelectAll={(on) => setCleared(on ? new Set(candidates.map((c) => c.id)) : new Set())}
            empty={<span className="muted">{completed ? 'No cleared items.' : 'No posted transactions in this period. A statement with zero cleared items needs opening = closing.'}</span>}
            columns={[
              { key: 'date', header: 'Date', className: 'nowrap', render: (t) => <>{formatDate(t.date)}{t.date < start && <Badge tone="warn" title="Dated before this statement but not yet reconciled">Earlier</Badge>}</> },
              { key: 'desc', header: 'Description', main: true, render: (t) => <div className="desc-cell"><div className="title">{t.description}</div><TxBadges tx={t} index={index} reconciledIds={reconciled} recurringById={recurringById} /></div> },
              { key: 'amt', header: 'Effect on balance', className: 'num', render: (t) => <Money cents={t.amountCents} signed /> },
            ]}
          />
          {pendingInRange.length > 0 && <p className="small muted" style={{ marginTop: 8 }}>{pendingInRange.length} pending item(s) in this period ({formatMoney(pendingInRange.reduce((s, t) => s + t.amountCents, 0), { signed: true })}) are not on the statement yet and cannot be cleared.</p>}
        </Card>
      </div>

      <div className="stack">
        <Card title="Reconciliation math" role="region" aria-label="Reconciliation math">
          <div className="kv" aria-live="polite">
            <span>Opening statement balance</span><span>{openingCents === null ? '-' : <Money cents={openingCents} tone="none" />}</span>
            <span>+ Cleared transactions ({completed ? snaps.length : clearedList.length})</span><span>{math ? <Money cents={math.clearedSum} signed tone="none" /> : '-'}</span>
            <span><strong>= Calculated closing</strong></span><span>{math ? <strong><Money cents={math.calculated} tone="none" /></strong> : '-'}</span>
            <span>Statement closing balance</span><span>{closingCents === null ? '-' : <Money cents={closingCents} tone="none" />}</span>
            <span><strong>Discrepancy</strong></span>
            <span data-testid="discrepancy">{math ? <strong className={math.discrepancy === 0 ? 'amt pos' : 'amt neg'}>{formatMoney(math.discrepancy, { signed: true })}{math.discrepancy === 0 ? ' - balanced' : ''}</strong> : '-'}</span>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Discrepancy = statement closing - calculated closing. It must be exactly $0.00 to complete.</p>
          {!completed ? (
            <div className="actions">
              <button type="button" className="btn" onClick={save}>Save draft</button>
              <button type="button" className="btn primary" onClick={complete} disabled={!math || math.discrepancy !== 0}>Complete reconciliation</button>
              <button type="button" className="btn" onClick={() => setAdj({ reason: '' })} disabled={!math || math.discrepancy === 0}>Record documented adjustment...</button>
            </div>
          ) : (
            <div className="actions">
              <button type="button" className="btn" onClick={async () => { if (await confirm({ title: 'Reopen this reconciliation?', message: 'It becomes a draft again so you can change cleared items. Records already changed are removed from the cleared list.', confirmLabel: 'Reopen' })) run((d) => reopenReconciliation(d, rec.id), { label: 'reopen reconciliation', success: 'Reopened for editing', undo: true }); }}>Reopen</button>
              <button type="button" className="btn danger" onClick={async () => { if (await confirm({ title: 'Delete this reconciliation record?', danger: true, confirmLabel: 'Delete record', message: 'Your transactions are not changed; they simply stop showing as reconciled.' })) { const r = run((d) => deleteReconciliation(d, rec.id), { label: 'delete reconciliation', success: 'Reconciliation record deleted', undo: true }); if (r.ok) onOpen(''); } }}>Delete record</button>
            </div>
          )}
          {rec && !completed && <div className="actions"><button type="button" className="btn small danger" onClick={() => { const r = run((d) => deleteReconciliation(d, rec.id), { label: 'discard draft', success: 'Draft discarded', undo: true }); if (r.ok) onOpen(''); }}>Discard draft</button></div>}
        </Card>

        {hints.length > 0 && (
          <Card title="Finding the difference">
            <ul className="list-plain">
              {hints.map((h, i) => (
                <li key={i} style={{ display: 'block' }}>
                  <div>{h.message}</div>
                  <div className="actions" style={{ marginTop: 4 }}>
                    {h.type === 'clear' && <button type="button" className="btn small" onClick={() => toggle(h.txId, true)}>Clear it</button>}
                    {h.type === 'unclear' && <button type="button" className="btn small" onClick={() => toggle(h.txId, false)}>Unclear it</button>}
                    {(h.type === 'redate' || h.type === 'unclear') && <button type="button" className="btn small" onClick={() => editors.openTransaction({ id: h.txId })}>Edit transaction</button>}
                    {h.type === 'missing' && math && (
                      <button type="button" className="btn small" onClick={() => editors.openTransaction({ defaults: { accountId: acctId, date: end, amount: centsToDecimalString(Math.abs(math.discrepancy)), uiType: math.discrepancy < 0 ? 'expense' : 'income', description: math.discrepancy < 0 ? 'Bank fee (missing from ledger)' : 'Interest or deposit (missing from ledger)' } })}>Add the missing transaction</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title="Reconciliation history for this account">
          {history.length === 0 ? <p className="muted small">No reconciliations yet.</p> : (
            <ul className="list-plain">
              {history.map((r) => {
                const h = reconciliationHealth(data, r);
                return (
                  <li key={r.id}>
                    <button type="button" className="btn ghost small" onClick={() => onOpen(r.id)} aria-current={rec?.id === r.id}>{formatDate(r.startDate)} - {formatDate(r.endDate)}</button>
                    {r.status !== 'completed' ? <Badge tone="warn">Draft ({formatMoney(r.discrepancyCents ?? 0, { signed: true })})</Badge> : h.valid ? <Badge tone="pos">Completed</Badge> : <Badge tone="neg">Out of date</Badge>}
                  </li>
                );
              })}
            </ul>
          )}
          {rec && <button type="button" className="btn small" onClick={() => onOpen('')}>Start a new reconciliation</button>}
        </Card>
        <Explain summary="Why a discrepancy is never hidden">
          <p>LedgerLens will not invent a balancing entry. To finish with a known difference you must record a <strong>documented adjustment</strong>: a visible transaction on the statement end date with your explanation, which is then cleared like any other item.</p>
        </Explain>
      </div>
      {adj && math && (
        <Modal title="Record a documented adjustment" onClose={() => setAdj(null)} footer={<><button type="button" className="btn" onClick={() => setAdj(null)}>Cancel</button><button type="button" className="btn primary" onClick={() => { const r = run((d) => addReconciliationAdjustment(d, { ...payload(), reason: adj.reason }, { now: new Date().toISOString() }), { label: 'documented adjustment', success: 'Adjustment recorded', failTitle: 'Adjustment not recorded', undo: true }); if (r.ok) { setAdj(null); onOpen(r.id); } else setAdj({ ...adj, errors: r.errors }); }}>Create adjustment</button></>}>
          <p>This creates a visible adjustment of <strong>{formatMoney(math.discrepancy, { signed: true })}</strong> on {formatDate(end)} so the statement balances. Use it only for differences you cannot trace (for example a rounding correction by the bank).</p>
          <ErrorSummary errors={adj.errors} />
          <TextField label="Reason (required)" value={adj.reason} onChange={(v) => setAdj({ ...adj, reason: v })} />
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- history
function History() {
  const data = useData();
  const run = useRun();
  const confirm = useConfirm();
  const nav = useNavigate();
  const index = useMemo(() => buildIndex(data), [data]);
  const batches = [...data.importBatches].reverse();
  const recs = [...data.reconciliations].sort((a, b) => (a.endDate < b.endDate ? 1 : -1));
  return (
    <>
      <PageHead title="Import & reconciliation history">Review past imports (and undo a whole batch) and every statement you have reconciled.</PageHead>
      <div className="stack">
        <Boundary name="Import batches">
          <Card title="Import batches">
            {batches.length === 0 ? <EmptyState title="No imports yet">Imported files appear here with their results.</EmptyState> : (
              <DataTable
                caption="Import batches"
                rows={batches}
                rowKey={(b) => b.id}
                columns={[
                  { key: 'file', header: 'File', main: true, render: (b) => <div className="desc-cell"><div className="title">{b.fileName || '(unnamed)'}</div><div className="sub">{b.importedAt ? formatDate(b.importedAt.slice(0, 10)) : 'date unknown'} · {index.accountsById.get(b.accountId)?.name}</div></div> },
                  { key: 'rows', header: 'Result', render: (b) => `${b.createdTxIds.length} added${b.settled.length ? `, ${b.settled.length} settled` : ''}, ${b.skippedCount} skipped, ${b.rejectedCount} rejected` },
                  { key: 'st', header: 'Status', render: (b) => (b.status === 'undone' ? <Badge>Undone {b.undoneAt ? formatDate(b.undoneAt.slice(0, 10)) : ''}</Badge> : <Badge tone="pos">Committed</Badge>) },
                  { key: 'act', header: 'Actions', render: (b) => (<span className="row"><button type="button" className="btn small" onClick={() => nav(`/transactions?src=imported&acct=${encodeURIComponent(b.accountId)}`)}>View</button>{b.status === 'committed' && <button type="button" className="btn small danger" onClick={async () => { if (await confirm({ title: 'Undo this import batch?', danger: true, confirmLabel: 'Undo batch', message: `Removes the ${b.createdTxIds.filter((id) => index.txById.has(id)).length} transaction(s) it created that still exist and restores settled pending items. Unrelated records are not touched.` })) run((d) => undoImportBatch(d, b.id, { now: new Date().toISOString() }), { label: 'undo import', success: 'Import undone', failTitle: 'Cannot undo' }); }}>Undo</button>}</span>) },
                ]}
              />
            )}
          </Card>
        </Boundary>
        <Boundary name="Reconciliations">
          <Card title="Reconciliations">
            {recs.length === 0 ? <EmptyState title="No reconciliations yet" action={<Link className="btn primary" to="/import/reconcile">Start one</Link>}>Reconcile an account against a statement.</EmptyState> : (
              <DataTable
                caption="Reconciliations"
                rows={recs}
                rowKey={(r) => r.id}
                columns={[
                  { key: 'acct', header: 'Account', main: true, render: (r) => <Link to={`/import/reconcile?acct=${encodeURIComponent(r.accountId)}&rec=${encodeURIComponent(r.id)}`}>{index.accountsById.get(r.accountId)?.name || r.accountId}</Link> },
                  { key: 'period', header: 'Statement period', render: (r) => `${formatDate(r.startDate)} to ${formatDate(r.endDate)}` },
                  { key: 'close', header: 'Closing', className: 'num', render: (r) => <Money cents={r.closingCents} tone="none" /> },
                  { key: 'items', header: 'Cleared', className: 'num', render: (r) => r.clearedTxIds.length },
                  { key: 'disc', header: 'Discrepancy', className: 'num', render: (r) => <Money cents={r.discrepancyCents ?? 0} signed /> },
                  { key: 'st', header: 'Status', render: (r) => { if (r.status !== 'completed') return <Badge tone="warn">Draft</Badge>; const h = reconciliationHealth(data, r); return h.valid ? <Badge tone="pos">Completed</Badge> : <Badge tone="neg" title={h.problems.map((p) => p.message).join(' ')}>Out of date</Badge>; } },
                ]}
              />
            )}
          </Card>
        </Boundary>
        <p className="small muted">Editing or deleting a cleared transaction marks its reconciliation as out of date instead of leaving a false "reconciled" label.</p>
      </div>
    </>
  );
}

