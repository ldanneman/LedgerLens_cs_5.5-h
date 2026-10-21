import { useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useData } from '../../state/hooks.jsx';
import { buildIndex, balanceSeries, netWorthFromBalances, basisIncludesPending, isLiabilityType } from '../../domain/ledger.js';
import { summarizePeriod, monthlySeries, categoryBreakdown, merchantBreakdown, transactionsForFilters } from '../../domain/reports.js';
import { spendByCategoryMonth, computeBudgetChain } from '../../domain/budgets.js';
import { monthKey, monthEnd, monthRange, addMonthKey, formatMonthShort, formatMonth, formatDate, addDays } from '../../domain/dates.js';
import { formatMoney } from '../../domain/money.js';
import { PageHead, Card, Stat, Callout, Explain, Boundary, EmptyState, Badge } from '../components/Common.jsx';
import { Money } from '../components/Money.jsx';
import DataTable from '../components/DataTable.jsx';
import { SelectField } from '../components/Form.jsx';
import { BarChart, LineChart, DonutChart, HBarList } from '../charts/Charts.jsx';
import PeriodPicker from '../PeriodPicker.jsx';
import { usePeriod } from '../period.js';
import { accountTypeLabel, pctLabel } from '../format.js';

const VIEWS = [
  { id: 'cashflow', label: 'Income & cash flow' },
  { id: 'categories', label: 'Spending breakdown' },
  { id: 'networth', label: 'Net worth' },
  { id: 'budget', label: 'Budget vs actual' },
  { id: 'accounts', label: 'Account balances' },
  { id: 'debt', label: 'Debt over time' },
  { id: 'transfers', label: 'Transfers' },
];
const MAX_MONTHS = 60;

export default function Reports() {
  const { view = 'cashflow' } = useParams();
  const data = useData();
  const asOf = data.settings.asOfDate;
  const includePending = basisIncludesPending(data);
  const [search] = useSearchParams();
  const [period, setPeriod, custom] = usePeriod(asOf, 'reports-period');
  const effective = search.has('p') ? period : { ...period, ...(period.preset === 'auto' ? { start: `${addMonthKey(monthKey(asOf), -11)}-01`, end: asOf, label: 'Last 12 months', preset: 'last_12' } : {}) };
  const index = useMemo(() => buildIndex(data), [data]);
  const [accountIds, setAccountIds] = useState([]);
  const [categoryIds, setCategoryIds] = useState([]);
  const earliest = effective.start < '1990-01-01' ? (index.sortedTx[0]?.date || effective.end) : effective.start;
  const startMonth = (() => {
    const s = monthKey(earliest);
    const lo = addMonthKey(monthKey(effective.end), -(MAX_MONTHS - 1));
    return s < lo ? lo : s;
  })();
  const endMonth = monthKey(effective.end);
  const clipped = monthKey(earliest) < startMonth;
  const filters = { start: effective.start < '1990-01-01' ? earliest : effective.start, end: effective.end, accountIds, categoryIds, includePending };
  const ctx = { data, index, period: effective, filters, startMonth, endMonth, includePending, accountIds, categoryIds, asOf };

  return (
    <>
      <PageHead title="Reports & analytics">Every chart is recalculated from your transactions and has a numeric table equivalent.</PageHead>
      <nav className="tabs" aria-label="Report types" style={{ overflowX: 'auto' }}>
        {VIEWS.map((v) => (<NavLink key={v.id} to={`/reports/${v.id}${search.toString() ? `?${search.toString()}` : ''}`}>{v.label}</NavLink>))}
      </nav>
      <Card style={{ marginBottom: 16 }}>
        <PeriodPicker period={effective} custom={custom} onChange={setPeriod} />
        <div className="filters" style={{ marginTop: 10 }}>
          <MultiSelect label="Accounts" options={data.accounts.map((a) => ({ value: a.id, label: a.name }))} value={accountIds} onChange={setAccountIds} />
          <MultiSelect label="Categories" options={data.categories.map((c) => ({ value: c.id, label: `${c.name} (${c.kind})` })).sort((a, b) => a.label.localeCompare(b.label)).concat([{ value: null, label: 'Uncategorized' }])} value={categoryIds} onChange={setCategoryIds} />
        </div>
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          <Badge tone={includePending ? 'warn' : 'info'}>{includePending ? 'Posted + pending' : 'Posted only'}</Badge> {effective.label}. {accountIds.length ? `${accountIds.length} account(s) selected. ` : 'All accounts. '}{categoryIds.length ? 'Category filter hides transfers and adjustments. ' : ''}{clipped ? `Showing the latest ${MAX_MONTHS} months of this range.` : ''}
        </p>
      </Card>
      <Boundary name="This report" resetKey={`${view}|${effective.start}|${effective.end}`}>
        {view === 'categories' ? <Categories {...ctx} /> : view === 'networth' ? <NetWorth {...ctx} /> : view === 'budget' ? <BudgetVsActual {...ctx} /> : view === 'accounts' ? <AccountsReport {...ctx} /> : view === 'debt' ? <DebtReport {...ctx} /> : view === 'transfers' ? <TransfersReport {...ctx} /> : <CashFlow {...ctx} />}
      </Boundary>
      <div style={{ marginTop: 16 }}>
        <Explain summary="Definitions used in every report">
          <ul>
            <li><strong>Gross income</strong>: income transactions (refunds are never income). Interest earned counts as income.</li>
            <li><strong>Net spending</strong>: purchases minus refunds, with split transactions divided among their categories. Card and loan payments are transfers, so they are not spending.</li>
            <li><strong>Net cash flow</strong> = income - net spending. Transfers are excluded.</li>
            <li><strong>Net worth</strong> = assets - amounts owed, summed from each account's contribution at a date.</li>
            <li><strong>Budget available</strong> = monthly amount + rollover from the previous month.</li>
            <li><strong>Debt obligations</strong> = scheduled payments on cards and loans; interest is shown as a separate expense.</li>
            <li>Period boundaries are inclusive: a transaction on the first or last day of the range is counted exactly once.</li>
          </ul>
        </Explain>
      </div>
    </>
  );
}

function MultiSelect({ label, options, value, onChange }) {
  return (
    <details className="field">
      <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.84rem', color: 'var(--muted)', minHeight: 32 }}>{label}: {value.length ? `${value.length} selected` : 'all'}</summary>
      <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6, background: 'var(--surface)' }}>
        <button type="button" className="btn small" onClick={() => onChange([])}>Select all (clear filter)</button>
        {options.map((o) => (
          <label key={String(o.value)} className="check" style={{ display: 'flex' }}>
            <input type="checkbox" checked={value.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

function txLink(ctx, extra = {}) {
  const p = new URLSearchParams({ from: ctx.filters.start, to: ctx.filters.end, ...extra });
  if (ctx.accountIds.length === 1) p.set('acct', ctx.accountIds[0]);
  return `/transactions?${p.toString()}`;
}

// ----------------------------------------------------------- cash flow view
function CashFlow(ctx) {
  const { data, filters, startMonth, endMonth } = ctx;
  const nav = useNavigate();
  const months = useMemo(() => monthlySeries(data, { ...filters, startMonth, endMonth }), [data, filters, startMonth, endMonth]);
  const total = useMemo(() => summarizePeriod(data, filters), [data, filters]);
  const labels = months.map((m) => formatMonthShort(m.month));
  return (
    <div className="stack">
      <div className="grid cols-4">
        <Card><Stat label="Gross income" value={<Money cents={total.incomeCents} tone="none" />} /></Card>
        <Card><Stat label="Net spending" value={<Money cents={total.netExpenseCents} tone="none" />} sub={`${formatMoney(total.grossExpenseCents)} purchases - ${formatMoney(total.refundCents)} refunds`} /></Card>
        <Card><Stat label="Net cash flow" value={<Money cents={total.netCashFlowCents} signed />} sub={`Savings rate ${pctLabel(total.savingsRatePct)}`} /></Card>
        <Card><Stat label="Transfers (not income or spending)" value={<Money cents={total.transferInCents} tone="none" />} sub={total.externalInCents || total.externalOutCents ? `Outside: +${formatMoney(total.externalInCents)} / -${formatMoney(total.externalOutCents)}` : 'Moved between your accounts'} /></Card>
      </div>
      <Card title="Income vs expense by month"><BarChart title="" labels={labels} series={[{ name: 'Income', values: months.map((m) => m.incomeCents) }, { name: 'Net spending', values: months.map((m) => m.netExpenseCents) }]} onBarClick={(i) => nav(txLink(ctx, { from: `${months[i].month}-01`, to: monthEnd(months[i].month) }))} /></Card>
      <Card title="Net cash flow by month"><BarChart title="" labels={labels} series={[{ name: 'Net cash flow', values: months.map((m) => m.netCashFlowCents) }]} onBarClick={(i) => nav(txLink(ctx, { from: `${months[i].month}-01`, to: monthEnd(months[i].month) }))} /></Card>
      <Card title="Month by month" actions={<Link className="btn small" to={txLink(ctx)}>View underlying transactions</Link>}>
        <DataTable
          caption="Monthly cash flow"
          rows={months}
          rowKey={(m) => m.month}
          footer={<tfoot><tr><td>Total</td><td className="num">{formatMoney(total.incomeCents)}</td><td className="num">{formatMoney(total.grossExpenseCents)}</td><td className="num">{formatMoney(total.refundCents)}</td><td className="num">{formatMoney(total.netExpenseCents)}</td><td className="num">{formatMoney(total.netCashFlowCents, { signed: true })}</td></tr></tfoot>}
          columns={[
            { key: 'm', header: 'Month', main: true, render: (m) => <Link to={txLink(ctx, { from: `${m.month}-01`, to: monthEnd(m.month) })}>{formatMonth(m.month)}</Link> },
            { key: 'i', header: 'Income', className: 'num', render: (m) => formatMoney(m.incomeCents) },
            { key: 'g', header: 'Purchases', className: 'num', render: (m) => formatMoney(m.grossExpenseCents) },
            { key: 'r', header: 'Refunds', className: 'num', render: (m) => formatMoney(m.refundCents) },
            { key: 'n', header: 'Net spending', className: 'num', render: (m) => formatMoney(m.netExpenseCents) },
            { key: 'c', header: 'Net cash flow', className: 'num', render: (m) => <Money cents={m.netCashFlowCents} signed /> },
          ]}
        />
      </Card>
    </div>
  );
}

// -------------------------------------------------------- category / merchant
function Categories(ctx) {
  const { data, filters } = ctx;
  const nav = useNavigate();
  const [group, setGroup] = useState('category');
  const s = useMemo(() => summarizePeriod(data, filters), [data, filters]);
  const cats = useMemo(() => categoryBreakdown(data, s, 'expense'), [data, s]);
  const merchants = useMemo(() => merchantBreakdown(s), [s]);
  const index = ctx.index;
  const accounts = useMemo(() => [...s.byAccount.entries()].map(([id, e]) => ({ id, name: index.accountsById.get(id)?.name || id, ...e })).filter((a) => a.expenseCents !== 0 || a.incomeCents !== 0).sort((a, b) => b.expenseCents - a.expenseCents), [s, index]);
  const income = useMemo(() => categoryBreakdown(data, s, 'income'), [data, s]);
  const totalSpend = cats.filter((c) => c.amountCents > 0).reduce((a, c) => a + c.amountCents, 0);
  return (
    <div className="stack">
      <Card>
        <SelectField label="Group spending by" value={group} onChange={setGroup} options={[{ value: 'category', label: 'Category' }, { value: 'merchant', label: 'Merchant' }, { value: 'account', label: 'Account' }]} />
        <p className="small muted" style={{ marginTop: 8 }}>Net spending after refunds: <strong>{formatMoney(s.netExpenseCents)}</strong> · {s.count} transactions in range.</p>
      </Card>
      {group === 'category' && (
        <div className="grid cols-2">
          <Card title="Spending by category"><DonutChart title="" slices={cats.slice(0, 10).concat(cats.length > 10 ? [{ name: 'Everything else', amountCents: cats.slice(10).reduce((a, c) => a + c.amountCents, 0), categoryId: '__other__' }] : []).map((c) => ({ label: c.name, value: c.amountCents, color: c.color || undefined, categoryId: c.categoryId }))} total={totalSpend} onSliceClick={(sl) => sl.categoryId !== '__other__' && nav(txLink(ctx, { cat: sl.categoryId === null ? '__none__' : sl.categoryId, kind: 'expense' }))} /></Card>
          <Card title="Category table" actions={<Link className="btn small" to={txLink(ctx, { kind: 'expense' })}>View transactions</Link>}>
            <DataTable caption="Spending by category" rows={cats} rowKey={(c) => String(c.categoryId)} footer={<tfoot><tr><td>Net spending</td><td className="num">{formatMoney(s.netExpenseCents)}</td><td /></tr></tfoot>} columns={[{ key: 'n', header: 'Category', main: true, render: (c) => <Link to={txLink(ctx, { cat: c.categoryId === null ? '__none__' : c.categoryId, kind: 'expense' })}>{c.name}</Link> }, { key: 'a', header: 'Net spending', className: 'num', render: (c) => <Money cents={c.amountCents} tone="none" /> }, { key: 'p', header: 'Share', className: 'num', render: (c) => (totalSpend ? `${((c.amountCents / totalSpend) * 100).toFixed(1)}%` : '-') }]} />
          </Card>
          {income.length > 0 && <Card title="Income by category"><HBarList items={income.map((c) => ({ label: c.name, value: c.amountCents }))} /></Card>}
        </div>
      )}
      {group === 'merchant' && (
        <Card title="Top merchants">
          {merchants.length === 0 ? <EmptyState title="No spending">Nothing to group in this period.</EmptyState> : <HBarList items={merchants.slice(0, 20).map((m) => ({ label: `${m.name} (${m.count})`, value: m.expenseCents }))} />}
          <DataTable caption="Spending by merchant" rows={merchants.slice(0, 50)} rowKey={(m) => m.name} columns={[{ key: 'n', header: 'Merchant', main: true, render: (m) => m.name }, { key: 'c', header: 'Transactions', className: 'num', render: (m) => m.count }, { key: 'a', header: 'Net spending', className: 'num', render: (m) => formatMoney(m.expenseCents) }]} />
        </Card>
      )}
      {group === 'account' && (
        <Card title="By account"><DataTable caption="Spending by account" rows={accounts} rowKey={(a) => a.id} columns={[{ key: 'n', header: 'Account', main: true, render: (a) => <Link to={`/accounts/${encodeURIComponent(a.id)}`}>{a.name}</Link> }, { key: 'i', header: 'Income', className: 'num', render: (a) => formatMoney(a.incomeCents) }, { key: 'e', header: 'Net spending', className: 'num', render: (a) => formatMoney(a.expenseCents) }]} /></Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- net worth
function NetWorth(ctx) {
  const { data, index, startMonth, endMonth, includePending, accountIds, asOf } = ctx;
  const months = monthRange(startMonth, endMonth);
  const dates = months.map((m) => (monthEnd(m) > asOf ? asOf : monthEnd(m)));
  const series = useMemo(() => balanceSeries(index, dates, includePending), [index, dates, includePending]);
  const pick = (a) => !accountIds.length || accountIds.includes(a.id);
  const points = dates.map((_, i) => {
    const balances = new Map();
    for (const a of data.accounts) if (pick(a)) balances.set(a.id, series.get(a.id)[i]);
    return netWorthFromBalances({ data: { accounts: data.accounts.filter(pick) } }, balances);
  });
  const types = ['checking', 'savings', 'investment', 'credit_card', 'auto_loan', 'student_loan', 'personal_loan'].filter((t) => data.accounts.some((a) => a.type === t && pick(a)));
  const labels = months.map(formatMonthShort);
  return (
    <div className="stack">
      <Card title="Net worth over time"><LineChart title="" labels={labels} series={[{ name: 'Net worth', values: points.map((p) => p.netWorth) }, { name: 'Assets', values: points.map((p) => p.assets) }, { name: 'Amount owed', values: points.map((p) => p.liabilities) }]} /></Card>
      <Card title="Asset and liability composition (month end)">
        <BarChart title="" stacked labels={labels} series={types.map((t) => ({ name: accountTypeLabel(t), values: points.map((p) => p.byType[t] || 0) }))} />
        <p className="small muted">Assets stack upward; liabilities (negative contributions) stack downward.</p>
      </Card>
    </div>
  );
}

// -------------------------------------------------------- budget vs actual
function BudgetVsActual(ctx) {
  const { data, index, startMonth, endMonth, includePending } = ctx;
  const spend = useMemo(() => spendByCategoryMonth(data, includePending), [data, includePending]);
  const months = monthRange(startMonth, endMonth).slice(-24);
  const budgets = data.budgets.filter((b) => b.enabled);
  const [catId, setCatId] = useState('');
  const chosen = catId ? budgets.filter((b) => b.categoryId === catId) : budgets;
  const rows = months.map((m) => {
    let avail = 0;
    let spent = 0;
    for (const b of chosen) {
      const chain = computeBudgetChain(b, spend.get(b.categoryId), m);
      const r = chain[chain.length - 1];
      if (r && r.month === m) {
        avail += r.availableCents;
        spent += r.spentCents;
      }
    }
    return { month: m, avail, spent, diff: avail - spent };
  });
  const last = months[months.length - 1];
  const perCat = budgets.map((b) => {
    const chain = computeBudgetChain(b, spend.get(b.categoryId), last);
    const r = chain[chain.length - 1];
    return { b, name: index.categoriesById.get(b.categoryId)?.name || b.categoryId, r };
  }).filter((x) => x.r);
  if (budgets.length === 0) return <Card><EmptyState title="No active budgets" action={<Link className="btn primary" to="/budgets">Create budgets</Link>}>Budget vs actual needs at least one budget.</EmptyState></Card>;
  return (
    <div className="stack">
      <Card><SelectField label="Budget" value={catId} onChange={setCatId} placeholder="All budgets combined" options={budgets.map((b) => ({ value: b.categoryId, label: index.categoriesById.get(b.categoryId)?.name || b.categoryId }))} /></Card>
      <Card title="Available vs spent by month"><BarChart title="" labels={rows.map((r) => formatMonthShort(r.month))} series={[{ name: 'Available (incl. rollover)', values: rows.map((r) => r.avail) }, { name: 'Spent', values: rows.map((r) => r.spent) }]} /></Card>
      <Card title={`Categories in ${formatMonth(last)}`}>
        <DataTable caption="Budget vs actual by category" rows={perCat} rowKey={(x) => x.b.id} columns={[{ key: 'n', header: 'Category', main: true, render: (x) => <Link to={`/budgets/${encodeURIComponent(x.b.categoryId)}?month=${last}`}>{x.name}</Link> }, { key: 'a', header: 'Available', className: 'num', render: (x) => formatMoney(x.r.availableCents) }, { key: 's', header: 'Spent', className: 'num', render: (x) => formatMoney(x.r.spentCents) }, { key: 'd', header: 'Variance', className: 'num', render: (x) => (x.r.remainingCents >= 0 ? `${formatMoney(x.r.remainingCents)} under` : <span className="amt neg">{formatMoney(-x.r.remainingCents)} over</span>) }]} />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------ account balances
function AccountsReport(ctx) {
  const { data, index, startMonth, endMonth, includePending, accountIds, asOf } = ctx;
  const months = monthRange(startMonth, endMonth);
  const dates = months.map((m) => (monthEnd(m) > asOf ? asOf : monthEnd(m)));
  const series = useMemo(() => balanceSeries(index, dates, includePending), [index, dates, includePending]);
  const accts = data.accounts.filter((a) => (!accountIds.length || accountIds.includes(a.id)) && (a.status === 'active' || (series.get(a.id) || []).some((v) => v !== 0)));
  const shownForChart = accts.slice(0, 6);
  const startBefore = balanceSeries(index, [addDays(`${startMonth}-01`, -1)], includePending);
  return (
    <div className="stack">
      <Card title="Balance history">
        <LineChart title="" labels={months.map(formatMonthShort)} series={shownForChart.map((a) => ({ name: a.name, values: series.get(a.id) }))} />
        {accts.length > 6 && <p className="small muted">The chart shows the first 6 accounts; pick accounts in the filter above to focus. All accounts are in the table below.</p>}
      </Card>
      <Card title="Change over the period">
        <DataTable caption="Account balance changes" rows={accts} rowKey={(a) => a.id} columns={[
          { key: 'n', header: 'Account', main: true, render: (a) => <Link to={`/accounts/${encodeURIComponent(a.id)}`}>{a.name}</Link> },
          { key: 't', header: 'Type', render: (a) => accountTypeLabel(a.type) },
          { key: 's', header: 'Start', className: 'num', render: (a) => formatMoney(startBefore.get(a.id)[0]) },
          { key: 'e', header: 'End', className: 'num', render: (a) => formatMoney(series.get(a.id).at(-1) ?? 0) },
          { key: 'c', header: 'Change', className: 'num', render: (a) => <Money cents={(series.get(a.id).at(-1) ?? 0) - startBefore.get(a.id)[0]} signed /> },
        ]} />
        <p className="small muted">Liabilities show their net-worth contribution: more negative means more owed.</p>
      </Card>
    </div>
  );
}

// ----------------------------------------------------------------- debt report
function DebtReport(ctx) {
  const { data, index, startMonth, endMonth, includePending, accountIds, asOf, filters } = ctx;
  const months = monthRange(startMonth, endMonth);
  const dates = months.map((m) => (monthEnd(m) > asOf ? asOf : monthEnd(m)));
  const series = useMemo(() => balanceSeries(index, dates, includePending), [index, dates, includePending]);
  const debts = data.accounts.filter((a) => isLiabilityType(a.type) && (!accountIds.length || accountIds.includes(a.id)));
  const interest = useMemo(() => {
    const interestCats = data.categories.filter((c) => /interest/i.test(c.name)).map((c) => c.id);
    if (!interestCats.length) return [];
    return monthlySeries(data, { ...filters, categoryIds: interestCats, accountIds: debts.map((d) => d.id), startMonth, endMonth });
  }, [data, filters, debts, startMonth, endMonth]);
  if (debts.length === 0) return <Card><EmptyState title="No debts">No credit cards or loans match the filter.</EmptyState></Card>;
  return (
    <div className="stack">
      <Card title="Amount owed over time"><LineChart title="" labels={months.map(formatMonthShort)} series={debts.slice(0, 6).map((d) => ({ name: d.name, values: series.get(d.id).map((v) => -v) }))} /></Card>
      {interest.length > 0 && <Card title="Interest charged by month"><BarChart title="" labels={interest.map((m) => formatMonthShort(m.month))} series={[{ name: 'Interest & fees on debts', values: interest.map((m) => m.netExpenseCents) }]} /><p className="small muted">Interest is an expense. Loan payments are transfers: only the interest portion is spending, so principal repayment is not double counted.</p></Card>}
      <Card title="Balances">
        <DataTable caption="Debt balances" rows={debts} rowKey={(d) => d.id} columns={[
          { key: 'n', header: 'Debt', main: true, render: (d) => <Link to={`/accounts/${encodeURIComponent(d.id)}`}>{d.name}</Link> },
          { key: 's', header: 'Start of range owed', className: 'num', render: (d) => formatMoney(-(series.get(d.id)[0] ?? 0)) },
          { key: 'e', header: 'End owed', className: 'num', render: (d) => formatMoney(-(series.get(d.id).at(-1) ?? 0)) },
          { key: 'c', header: 'Change', className: 'num', render: (d) => { const ch = -(series.get(d.id).at(-1) ?? 0) + (series.get(d.id)[0] ?? 0); return <span className={ch > 0 ? 'amt neg' : 'amt pos'}>{ch > 0 ? 'owed +' : 'paid down '}{formatMoney(Math.abs(ch))}</span>; } },
        ]} />
        <p className="small"><Link to="/goals/debt">Open payoff projections</Link></p>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------- transfers
function TransfersReport(ctx) {
  const { data, index, filters, startMonth, endMonth } = ctx;
  const months = useMemo(() => monthlySeries(data, { ...filters, categoryIds: [], startMonth, endMonth }), [data, filters, startMonth, endMonth]);
  const pairs = useMemo(() => {
    const map = new Map();
    const ext = [];
    for (const t of transactionsForFilters(data, { ...filters, categoryIds: [] })) {
      if (t.kind !== 'transfer' || t.amountCents >= 0) {
        if (t.kind === 'transfer' && index.transfersById.get(t.transferId)?.external) ext.push(t);
        continue;
      }
      const tr = index.transfersById.get(t.transferId);
      if (tr?.external) {
        ext.push(t);
        continue;
      }
      const other = (index.legsByTransfer.get(t.transferId) || []).find((l) => l.id !== t.id);
      const key = `${t.accountId}>${other?.accountId}`;
      const e = map.get(key) || { from: t.accountId, to: other?.accountId, count: 0, cents: 0 };
      e.count += 1;
      e.cents += -t.amountCents;
      map.set(key, e);
    }
    return { pairs: [...map.values()].sort((a, b) => b.cents - a.cents), ext };
  }, [data, filters, index]);
  const total = pairs.pairs.reduce((s, p) => s + p.cents, 0);
  return (
    <div className="stack">
      <Callout tone="info">Transfers move money between your own accounts, including card and loan payments. They are shown here <strong>separately</strong> and never counted as income or spending.</Callout>
      <Card title="Transfer volume by month"><BarChart title="" labels={months.map((m) => formatMonthShort(m.month))} series={[{ name: 'Moved between accounts', values: months.map((m) => m.transferInCents) }]} /></Card>
      <Card title={`Where the money moved (${formatMoney(total)})`}>
        <DataTable caption="Transfers by account pair" rows={pairs.pairs} rowKey={(p) => `${p.from}>${p.to}`} columns={[
          { key: 'f', header: 'From', main: true, render: (p) => index.accountsById.get(p.from)?.name },
          { key: 't', header: 'To', render: (p) => index.accountsById.get(p.to)?.name },
          { key: 'c', header: 'Transfers', className: 'num', render: (p) => p.count },
          { key: 'a', header: 'Total moved', className: 'num', render: (p) => formatMoney(p.cents) },
        ]} />
      </Card>
      {pairs.ext.length > 0 && (
        <Card title="Outside accounts (change net worth)">
          <DataTable caption="External transfers" rows={pairs.ext} rowKey={(t) => t.id} columns={[{ key: 'd', header: 'Date', render: (t) => formatDate(t.date) }, { key: 'n', header: 'With', main: true, render: (t) => index.transfersById.get(t.transferId)?.counterparty || t.description }, { key: 'a', header: 'Amount', className: 'num', render: (t) => <Money cents={t.amountCents} signed /> }]} />
        </Card>
      )}
    </div>
  );
}
