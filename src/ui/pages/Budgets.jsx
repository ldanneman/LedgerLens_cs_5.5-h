import { useMemo, useState } from 'react';
import { Link, NavLink, useParams, useSearchParams } from 'react-router-dom';
import { useData, useRun } from '../../state/hooks.jsx';
import { buildIndex, basisIncludesPending } from '../../domain/ledger.js';
import { budgetOverview, budgetYear, computeBudgetChain, spendByCategoryMonth, baseForMonth } from '../../domain/budgets.js';
import { saveBudget, deleteBudget, setBudgetEnabled, setBudgetOverride } from '../../domain/ops/catalog.js';
import { addMonthKey, formatMonth, formatMonthShort, monthRange, isValidMonth } from '../../domain/dates.js';
import { formatMoney, parseMoney, centsToDecimalString } from '../../domain/money.js';
import { PageHead, Card, Stat, Badge, Callout, Explain, ProgressBar, EmptyState, Boundary, Tabs, TabPanel, Menu } from '../components/Common.jsx';
import { Money } from '../components/Money.jsx';
import DataTable from '../components/DataTable.jsx';
import { Modal, useConfirm } from '../components/Modal.jsx';
import { CheckField, ErrorSummary, MoneyField, SelectField, TextField, fieldErrors } from '../components/Form.jsx';
import { BarChart } from '../charts/Charts.jsx';
import { defaultPeriod } from '../../domain/reports.js';

export default function Budgets() {
  const { categoryId } = useParams();
  return categoryId ? <CategoryDetail categoryId={decodeURIComponent(categoryId)} /> : <Overview />;
}

function useMonth(data) {
  const [params, setParams] = useSearchParams();
  const fallback = defaultPeriod(data.settings.asOfDate).month;
  const q = params.get('month');
  const month = q && isValidMonth(q) ? q : fallback;
  const setMonth = (m) => setParams((p) => { const n = new URLSearchParams(p); n.set('month', m); return n; }, { replace: true });
  return [month, setMonth, params, setParams];
}

function MonthNav({ month, setMonth }) {
  return (
    <div className="row" role="group" aria-label="Choose month">
      <button type="button" className="btn" onClick={() => setMonth(addMonthKey(month, -1))}><span aria-hidden="true">‹</span> Previous month</button>
      <strong style={{ minWidth: 130, textAlign: 'center' }} aria-live="polite">{formatMonth(month)}</strong>
      <button type="button" className="btn" onClick={() => setMonth(addMonthKey(month, 1))}>Next month <span aria-hidden="true">›</span></button>
      <input type="month" aria-label="Jump to month" value={month} onChange={(e) => isValidMonth(e.target.value) && setMonth(e.target.value)} style={{ width: 'auto' }} />
    </div>
  );
}

const RISK_BADGE = {
  over: <Badge tone="neg">Over budget</Badge>,
  at_risk: <Badge tone="warn">At risk</Badge>,
  ok: <Badge tone="pos">On track</Badge>,
  not_started: <Badge>Not started</Badge>,
};

function Overview() {
  const data = useData();
  const run = useRun();
  const confirm = useConfirm();
  const [month, setMonth, params, setParams] = useMonth(data);
  const view = params.get('view') || 'month';
  const includePending = basisIncludesPending(data);
  const index = useMemo(() => buildIndex(data), [data]);
  const overview = useMemo(() => budgetOverview(data, month, { includePending, asOfDate: data.settings.asOfDate }), [data, month, includePending]);
  const spend = useMemo(() => spendByCategoryMonth(data, includePending), [data, includePending]);
  const [editing, setEditing] = useState(null);
  const [override, setOverride] = useState(null);
  const totals = overview.reduce((a, b) => ({ available: a.available + b.row.availableCents, spent: a.spent + b.row.spentCents, over: a.over + (b.risk === 'over' ? 1 : 0) }), { available: 0, spent: 0, over: 0 });
  const budgeted = new Set(data.budgets.map((b) => b.categoryId));
  const unbudgeted = [...spend.entries()].filter(([cid, m]) => cid !== null && !budgeted.has(cid) && (m.get(month) || 0) !== 0).map(([cid, m]) => ({ cid, name: index.categoriesById.get(cid)?.name || cid, cents: m.get(month) || 0 })).sort((a, b) => b.cents - a.cents);
  const uncategorized = spend.get(null)?.get(month) || 0;
  const disabled = data.budgets.filter((b) => !b.enabled);
  const year = Number(month.slice(0, 4));
  const yearRows = useMemo(() => budgetYear(data, year, { includePending }).filter((r) => r.budget.enabled), [data, year, includePending]);
  const setView = (v) => setParams((p) => { const n = new URLSearchParams(p); n.set('view', v); return n; }, { replace: true });

  return (
    <>
      <PageHead title="Budgets" actions={<button type="button" className="btn primary" onClick={() => setEditing({})}>Add budget</button>}>
        Monthly limits per expense category, with optional rollover of unused (or overspent) amounts.
      </PageHead>
      <Tabs label="Budget views" value={view} onChange={setView} tabs={[{ id: 'month', label: 'Month' }, { id: 'year', label: 'Year at a glance' }]} />
      <div className="row between" style={{ marginBottom: 12 }}>
        <MonthNav month={month} setMonth={setMonth} />
        <span className="small muted"><Badge tone={includePending ? 'warn' : 'info'}>{includePending ? 'Posted + pending' : 'Posted only'}</Badge> Spending is net of refunds; transfers and income are excluded.</span>
      </div>
      <TabPanel id="month" value={view}>
        <div className="grid cols-4" style={{ marginBottom: 16 }}>
          <Card><Stat label="Available this month" value={<Money cents={totals.available} tone="none" />} sub="Base amounts plus rollover" /></Card>
          <Card><Stat label="Spent" value={<Money cents={totals.spent} tone="none" />} sub="Net spending in budgeted categories" /></Card>
          <Card><Stat label={totals.available - totals.spent >= 0 ? 'Left to spend' : 'Over by'} value={<Money cents={Math.abs(totals.available - totals.spent)} tone="none" />} sub={totals.available - totals.spent >= 0 ? 'Across all budgets' : 'Combined overspend'} /></Card>
          <Card><Stat label="Categories over budget" value={totals.over} sub={`of ${overview.length} active budgets`} /></Card>
        </div>
        <Boundary name="Budget table">
          <Card title={`Budgets for ${formatMonth(month)}`}>
            {overview.length === 0 ? (
              <EmptyState title="No active budgets" action={<button type="button" className="btn primary" onClick={() => setEditing({})}>Create a budget</button>}>Budgets show how much you can spend per category each month.</EmptyState>
            ) : (
              <DataTable
                caption={`Budgets for ${formatMonth(month)}`}
                rows={overview}
                rowKey={(b) => b.budget.id}
                columns={[
                  { key: 'cat', header: 'Category', main: true, render: (b) => (<div className="desc-cell"><Link className="title" to={`/budgets/${encodeURIComponent(b.budget.categoryId)}?month=${month}`}>{b.categoryName}</Link><div className="sub">{b.budget.rollover ? 'Rollover on' : 'No rollover'}{b.row.hasOverride ? ' · custom amount this month' : ''}</div></div>) },
                  { key: 'base', header: 'Budget', className: 'num', render: (b) => <Money cents={b.row.baseCents} tone="none" /> },
                  { key: 'roll', header: 'Rollover in', className: 'num', render: (b) => (b.budget.rollover ? <Money cents={b.row.rolloverInCents} signed /> : <span className="muted">-</span>) },
                  { key: 'avail', header: 'Available', className: 'num', render: (b) => <Money cents={b.row.availableCents} tone="none" /> },
                  { key: 'spent', header: 'Spent', className: 'num', render: (b) => <Link to={`/transactions?cat=${encodeURIComponent(b.budget.categoryId)}&from=${month}-01&to=${month}-31&kind=expense`}><Money cents={b.row.spentCents} tone="none" /></Link> },
                  { key: 'left', header: 'Left / over', className: 'num', render: (b) => (b.row.remainingCents >= 0 ? <span className="amt">{formatMoney(b.row.remainingCents)} left</span> : <span className="amt neg">{formatMoney(-b.row.remainingCents)} over</span>) },
                  { key: 'prog', header: 'Progress', render: (b) => (<div style={{ minWidth: 110 }}><ProgressBar pct={b.row.availableCents > 0 ? (b.row.spentCents / b.row.availableCents) * 100 : b.row.spentCents > 0 ? 100 : 0} tone={b.risk === 'over' ? 'over' : b.risk === 'at_risk' ? 'risk' : ''} label={`${b.categoryName} used`} /><span className="tiny muted">{b.row.pct === null ? (b.row.spentCents > 0 ? 'no budget available' : '0%') : `${b.row.pct}%`}</span></div>) },
                  { key: 'status', header: 'Status', render: (b) => (<>{RISK_BADGE[b.risk]} {b.unusual && <Badge tone="info" title={`Prior 3-month average ${formatMoney(b.avgPriorCents)}`}>Unusual jump</Badge>}</>) },
                  { key: 'act', header: 'Actions', render: (b) => (
                    <span className="row" style={{ flexWrap: 'nowrap' }}>
                      <button type="button" className="btn small" onClick={() => setEditing(b.budget)}>Edit</button>
                      <Menu label={`More actions for the ${b.categoryName} budget`} items={[
                        { label: 'Amount for this month...', onClick: () => setOverride({ budget: b.budget, month }) },
                        { label: 'Turn off', onClick: () => run((d) => setBudgetEnabled(d, b.budget.id, false), { label: 'disable budget', success: 'Budget turned off', undo: true }) },
                        { label: 'Delete budget', danger: true, onClick: async () => { if (await confirm({ title: `Delete the ${b.categoryName} budget?`, danger: true, confirmLabel: 'Delete budget', message: 'Spending history is unaffected. You can undo right after.' })) run((d) => deleteBudget(d, b.budget.id), { label: 'delete budget', success: 'Budget deleted', undo: true }); } },
                      ]} />
                    </span>
                  ) },
                ]}
              />
            )}
          </Card>
        </Boundary>
        <div className="grid cols-2" style={{ marginTop: 16 }}>
          <Card title="Spending without a budget">
            {unbudgeted.length === 0 && uncategorized === 0 ? <p className="muted small">Every category with spending this month has a budget.</p> : (
              <ul className="list-plain">
                {unbudgeted.map((u) => (<li key={u.cid}><span>{u.name}</span><span className="row"><Money cents={u.cents} tone="none" /><button type="button" className="btn small" onClick={() => setEditing({ categoryId: u.cid, baseCents: Math.max(0, u.cents) })}>Create budget</button></span></li>))}
                {uncategorized !== 0 && <li><span>Uncategorized</span><span className="row"><Money cents={uncategorized} tone="none" /><Link className="btn small" to={`/transactions?cat=__none__&from=${month}-01&to=${month}-31`}>Categorize</Link></span></li>}
              </ul>
            )}
          </Card>
          <Card title="Turned-off budgets">
            {disabled.length === 0 ? <p className="muted small">None. Turned-off budgets are kept but not counted.</p> : (
              <ul className="list-plain">{disabled.map((b) => (<li key={b.id}><span>{index.categoriesById.get(b.categoryId)?.name}</span><button type="button" className="btn small" onClick={() => run((d) => setBudgetEnabled(d, b.id, true), { label: 'enable budget', success: 'Budget turned on' })}>Turn on</button></li>))}</ul>
            )}
          </Card>
        </div>
        <div style={{ marginTop: 16 }}>
          <Explain summary="How budget availability and rollover work">
            <p><strong>Available</strong> for a month = that month's budget amount + rollover from the previous month. With rollover on, last month's <em>unused</em> amount is added (an overspend is subtracted), and the chain continues across December into January from the budget's start month. Editing any earlier month's spending or amount recalculates every later month. <strong>Spent</strong> counts expense transactions net of refunds, split by category; income and transfers are excluded. A $0 budget is allowed: any spending is then an overage. Pending items are included only when the Basis control is set to "Include pending".</p>
          </Explain>
        </div>
      </TabPanel>
      <TabPanel id="year" value={view}>
        <Card title={`${year} at a glance`} actions={<span className="row"><button type="button" className="btn small" onClick={() => setMonth(`${year - 1}-${month.slice(5)}`)}>‹ {year - 1}</button><button type="button" className="btn small" onClick={() => setMonth(`${year + 1}-${month.slice(5)}`)}>{year + 1} ›</button></span>}>
          {yearRows.length === 0 ? <EmptyState title="No budgets">Create a budget to see the year.</EmptyState> : (
            <div className="table-wrap" role="region" aria-label="Year at a glance" tabIndex={0}>
              <table className="data">
                <caption className="sr-only">Spent versus available per budget and month in {year}</caption>
                <thead><tr><th scope="col">Category</th>{monthRange(`${year}-01`, `${year}-12`).map((m) => (<th key={m} scope="col" className="num">{formatMonthShort(m).slice(0, 3)}</th>))}</tr></thead>
                <tbody>
                  {yearRows.map((r) => (
                    <tr key={r.budget.id}>
                      <th scope="row"><Link to={`/budgets/${encodeURIComponent(r.budget.categoryId)}`}>{r.categoryName}</Link></th>
                      {r.months.map((m) => (
                        <td key={m.month} className="num" style={{ whiteSpace: 'nowrap' }}>
                          {m.notStarted ? <span className="muted">-</span> : (
                            <button type="button" className="btn ghost small" style={{ padding: '0 2px', minHeight: 0, flexDirection: 'column', gap: 0 }} onClick={() => { setMonth(m.month); setView('month'); }}>
                              <span className="sr-only">{r.categoryName} {formatMonth(m.month)}: </span>
                              <span className={m.overspent ? 'amt neg' : 'amt'}>{formatMoney(m.spentCents).replace('.00', '')}</span>
                              <span className="tiny muted">of {formatMoney(m.availableCents).replace('.00', '')}{m.overspent ? ' ⚠ over' : ''}</span>
                            </button>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted" style={{ marginTop: 8 }}>Each cell shows spent, and "of" the available amount including rollover. A ⚠ marks an overspent month. Select a cell to open that month.</p>
        </Card>
      </TabPanel>
      {editing && <BudgetModal budget={editing} month={month} onClose={() => setEditing(null)} />}
      {override && <OverrideModal budget={override.budget} month={override.month} onClose={() => setOverride(null)} />}
    </>
  );
}

function BudgetModal({ budget, month, onClose }) {
  const data = useData();
  const run = useRun();
  const index = useMemo(() => buildIndex(data), [data]);
  const existing = budget.id ? data.budgets.find((b) => b.id === budget.id) : null;
  const taken = new Set(data.budgets.filter((b) => b.id !== budget.id).map((b) => b.categoryId));
  const options = data.categories.filter((c) => c.kind === 'expense' && !taken.has(c.id)).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: c.name }));
  const [f, setF] = useState({ categoryId: budget.categoryId || '', base: budget.baseCents !== undefined ? centsToDecimalString(budget.baseCents) : '', rollover: Boolean(budget.rollover), startMonth: budget.startMonth || addMonthKey(month, -11), enabled: budget.enabled !== false });
  const [errors, setErrors] = useState([]);
  const fe = fieldErrors(errors);
  const set = (p) => setF((s) => ({ ...s, ...p }));
  const submit = (e) => {
    e.preventDefault();
    const a = parseMoney(f.base || '', { allowNegative: false });
    if (!a.ok) return setErrors([{ field: 'baseCents', message: a.error }]);
    const r = run((d) => saveBudget(d, { id: existing?.id, categoryId: f.categoryId, baseCents: a.cents, rollover: f.rollover, startMonth: f.startMonth, enabled: f.enabled }), { label: existing ? 'edit budget' : 'add budget', success: 'Budget saved', failTitle: 'Budget not saved', undo: true });
    if (r.ok) onClose();
    else setErrors(r.errors);
    return undefined;
  };
  return (
    <Modal title={existing ? `Edit ${index.categoriesById.get(existing.categoryId)?.name} budget` : 'Add budget'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form="bud-form" className="btn primary">Save budget</button></>}>
      <form id="bud-form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />
        <div className="form-grid">
          <SelectField label="Category" value={f.categoryId} onChange={(v) => set({ categoryId: v })} options={existing ? [...options, { value: existing.categoryId, label: index.categoriesById.get(existing.categoryId)?.name || existing.categoryId }] : options} placeholder="Choose an expense category" error={fe.categoryId} disabled={Boolean(existing)} />
          <MoneyField label="Monthly amount" value={f.base} onChange={(v) => set({ base: v })} error={fe.baseCents} hint="$0.00 is allowed - any spending then counts as an overage." />
          <TextField label="Starts in month" type="month" value={f.startMonth} onChange={(v) => set({ startMonth: v })} error={fe.startMonth} hint="Rollover chains begin here with nothing carried in." />
          <CheckField label="Carry unused (or overspent) amounts into the next month" checked={f.rollover} onChange={(v) => set({ rollover: v })} />
          <CheckField label="Budget is active" checked={f.enabled} onChange={(v) => set({ enabled: v })} />
        </div>
      </form>
    </Modal>
  );
}

function OverrideModal({ budget, month, onClose }) {
  const run = useRun();
  const existing = budget.overrides.find((o) => o.month === month);
  const [amount, setAmount] = useState(centsToDecimalString(existing ? existing.amountCents : budget.baseCents));
  const [errors, setErrors] = useState([]);
  const save = (remove) => {
    let cents = null;
    if (!remove) {
      const a = parseMoney(amount, { allowNegative: false });
      if (!a.ok) return setErrors([{ message: a.error }]);
      cents = a.cents;
    }
    const r = run((d) => setBudgetOverride(d, budget.id, month, cents), { label: 'budget month amount', success: remove ? 'Back to the regular amount' : 'Amount for this month saved', undo: true });
    if (r.ok) onClose();
    else setErrors(r.errors);
    return undefined;
  };
  return (
    <Modal title={`Amount for ${formatMonth(month)}`} onClose={onClose} footer={<>{existing && <button type="button" className="btn" onClick={() => save(true)}>Use regular amount ({formatMoney(budget.baseCents)})</button>}<button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={() => save(false)}>Save</button></>}>
      <ErrorSummary errors={errors} />
      <p className="small muted">Changes only {formatMonth(month)}. With rollover on, later months recalculate automatically.</p>
      <MoneyField label="Budget for this month" value={amount} onChange={setAmount} />
    </Modal>
  );
}

function CategoryDetail({ categoryId }) {
  const data = useData();
  const includePending = basisIncludesPending(data);
  const index = useMemo(() => buildIndex(data), [data]);
  const [month] = useMonth(data);
  const cat = index.categoriesById.get(categoryId);
  const budget = data.budgets.find((b) => b.categoryId === categoryId);
  const spend = useMemo(() => spendByCategoryMonth(data, includePending).get(categoryId), [data, includePending, categoryId]);
  const [editing, setEditing] = useState(null);
  if (!cat) return (<><PageHead title="Category not found">That category does not exist.</PageHead><Link className="btn" to="/budgets">Back to budgets</Link></>);
  const endMonth = month;
  const startMonth = budget ? (budget.startMonth < addMonthKey(endMonth, -11) ? budget.startMonth : addMonthKey(endMonth, -11)) : addMonthKey(endMonth, -11);
  const months = monthRange(startMonth, endMonth);
  const chain = budget ? computeBudgetChain(budget, spend, endMonth) : [];
  const chainBy = new Map(chain.map((r) => [r.month, r]));
  const rows = months.map((m) => {
    const c = chainBy.get(m);
    const spent = spend?.get(m) || 0;
    return { month: m, spent, base: c ? c.baseCents : null, rolloverIn: c ? c.rolloverInCents : null, available: c ? c.availableCents : null, remaining: c ? c.remainingCents : null, over: c?.overspent, override: c?.hasOverride };
  });
  const last12 = rows.slice(-12);
  return (
    <>
      <PageHead title={`${cat.name} budget`} actions={<><NavLink className="btn" to="/budgets">All budgets</NavLink><button type="button" className="btn primary" onClick={() => setEditing(budget || { categoryId })}>{budget ? 'Edit budget' : 'Create budget'}</button></>}>
        Spending history{budget ? ' and the rollover chain' : ''} for {cat.name}, ending {formatMonth(endMonth)}.
      </PageHead>
      {!budget && <Callout tone="info">There is no budget for this category yet. History below shows net spending (purchases minus refunds, including split shares).</Callout>}
      <div className="stack" style={{ marginTop: 12 }}>
        <Boundary name="History chart">
          <Card title="Last 12 months"><BarChart title="" labels={last12.map((r) => formatMonthShort(r.month))} series={[{ name: 'Spent', values: last12.map((r) => r.spent) }, ...(budget ? [{ name: 'Available (incl. rollover)', values: last12.map((r) => r.available ?? 0) }] : [])]} /></Card>
        </Boundary>
        <Card title="Month by month">
          <DataTable
            caption={`${cat.name} by month`}
            rows={[...rows].reverse()}
            rowKey={(r) => r.month}
            columns={[
              { key: 'm', header: 'Month', main: true, render: (r) => <Link to={`/transactions?cat=${encodeURIComponent(categoryId)}&from=${r.month}-01&to=${r.month}-31`}>{formatMonth(r.month)}</Link> },
              { key: 'base', header: 'Budget', className: 'num', render: (r) => (r.base === null ? '-' : <>{formatMoney(r.base)}{r.override ? ' *' : ''}</>) },
              { key: 'roll', header: 'Rollover in', className: 'num', render: (r) => (r.rolloverIn === null || !budget?.rollover ? '-' : <Money cents={r.rolloverIn} signed />) },
              { key: 'avail', header: 'Available', className: 'num', render: (r) => (r.available === null ? '-' : formatMoney(r.available)) },
              { key: 'spent', header: 'Spent (net)', className: 'num', render: (r) => formatMoney(r.spent) },
              { key: 'rem', header: 'Left / over', className: 'num', render: (r) => (r.remaining === null ? '-' : r.remaining >= 0 ? `${formatMoney(r.remaining)} left` : <span className="amt neg">{formatMoney(-r.remaining)} over</span>) },
            ]}
          />
          {budget && <p className="small muted">* a custom amount applies to that month. {baseForMonth(budget, endMonth) !== budget.baseCents ? '' : ''}</p>}
        </Card>
      </div>
      {editing && <BudgetModal budget={editing} month={month} onClose={() => setEditing(null)} />}
    </>
  );
}
