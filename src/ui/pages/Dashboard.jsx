import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useData } from '../../state/hooks.jsx';
import { buildIndex, balancesAt, netWorthFromBalances, netWorthSeries, basisIncludesPending } from '../../domain/ledger.js';
import { summarizePeriod, categoryBreakdown, monthlySeries, monthEndDates } from '../../domain/reports.js';
import { budgetOverview } from '../../domain/budgets.js';
import { goalProgress } from '../../domain/goals.js';
import { debtOverview } from '../../domain/debt.js';
import { liquidityOutlook } from '../../domain/obligations.js';
import { reconciledTxIds } from '../../domain/reconciliation.js';
import { addMonthKey, monthKey, formatDate, formatDateShort, formatMonthShort, formatMonth } from '../../domain/dates.js';
import { formatMoney } from '../../domain/money.js';
import { PageHead, Card, Stat, Badge, Callout, ProgressBar, Boundary, EmptyState } from '../components/Common.jsx';
import { Money, Owed } from '../components/Money.jsx';
import { DonutChart, LineChart, BarChart, Sparkline } from '../charts/Charts.jsx';
import PeriodPicker from '../PeriodPicker.jsx';
import { usePeriod } from '../period.js';
import { TxBadges, categoryLabel } from '../TxParts.jsx';
import { useEditors } from '../modals/Editors.jsx';
import { pctLabel } from '../format.js';

const CARD_TYPES = ['credit_card'];
const LOAN_TYPES = ['auto_loan', 'student_loan', 'personal_loan'];

export default function Dashboard() {
  const data = useData();
  const asOf = data.settings.asOfDate;
  const includePending = basisIncludesPending(data);
  const [period, setPeriod, custom] = usePeriod(asOf);
  const nav = useNavigate();
  const editors = useEditors();
  const index = useMemo(() => buildIndex(data), [data]);

  const balances = useMemo(() => balancesAt(index, asOf, includePending), [index, asOf, includePending]);
  const nw = useMemo(() => netWorthFromBalances(index, balances), [index, balances]);
  const summary = useMemo(() => summarizePeriod(data, { start: period.start, end: period.end, includePending }), [data, period.start, period.end, includePending]);
  const cats = useMemo(() => categoryBreakdown(data, summary, 'expense'), [data, summary]);
  const endMonth = monthKey(asOf);
  const trendDates = useMemo(() => monthEndDates(endMonth, 13).map((d) => (d > asOf ? asOf : d)), [endMonth, asOf]);
  const nwSeries = useMemo(() => netWorthSeries(index, trendDates, includePending), [index, trendDates, includePending]);
  const months = useMemo(() => monthlySeries(data, { startMonth: addMonthKey(endMonth, -11), endMonth, includePending }), [data, endMonth, includePending]);

  const typeSum = (types) => data.accounts.filter((a) => types.includes(a.type)).reduce((s, a) => s + (balances.get(a.id) || 0), 0);
  const cash = typeSum(['checking', 'savings']);
  const invest = typeSum(['investment']);
  const cards = typeSum(CARD_TYPES);
  const loans = typeSum(LOAN_TYPES);
  const pend = data.transactions.filter((t) => t.status === 'pending' && t.date <= asOf);
  const pendTotal = pend.reduce((s, t) => s + t.amountCents, 0);
  const recent = useMemo(() => [...index.sortedTx].filter((t) => t.date <= asOf).reverse().slice(0, 8), [index, asOf]);
  const reconciled = useMemo(() => reconciledTxIds(data), [data]);
  const recurringById = useMemo(() => new Map(data.recurring.map((r) => [r.id, r])), [data.recurring]);
  const budgetMonthKey = period.end > asOf ? endMonth : monthKey(period.end);
  const budgets = useMemo(() => budgetOverview(data, budgetMonthKey, { includePending, asOfDate: asOf }), [data, budgetMonthKey, includePending, asOf]);
  const atRisk = budgets.filter((b) => b.risk === 'over' || b.risk === 'at_risk' || b.unusual);
  const outlook = useMemo(() => liquidityOutlook(data, asOf, 30), [data, asOf]);
  const goals = useMemo(() => goalProgress(data, asOf, includePending), [data, asOf, includePending]);
  const debts = useMemo(() => debtOverview(data, asOf, true), [data, asOf]);
  const totalOwed = debts.reduce((s, d) => s + Math.max(0, d.owedCents), 0);
  const debtFree = debts.filter((d) => d.owedCents > 0).map((d) => d.schedule);
  const lastPayoff = debtFree.every((s) => s.status === 'paid_off') && debtFree.length ? debtFree.map((s) => s.payoffDate).sort().pop() : null;
  const start = nwSeries[0];
  const nwChange = nw.netWorth - (start?.netWorth ?? nw.netWorth);

  const toTransactions = (extra) => {
    const p = new URLSearchParams({ from: period.start, to: period.end, ...extra });
    nav(`/transactions?${p.toString()}`);
  };

  return (
    <>
      <PageHead
        title="Dashboard"
        actions={
          <>
            <button type="button" className="btn primary" onClick={() => editors.openTransaction({})}>Add transaction</button>
            <button type="button" className="btn" onClick={() => editors.openTransfer({})}>Transfer funds</button>
          </>
        }
      >
        Where your money stands as of {formatDate(asOf)}.
      </PageHead>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between">
          <PeriodPicker period={period} custom={custom} onChange={setPeriod} />
          <div className="small muted" style={{ maxWidth: 520 }}>
            <Badge tone={includePending ? 'warn' : 'info'}>{includePending ? 'Posted + pending' : 'Posted only'}</Badge>{' '}
            Balances and net worth are <strong>historical as of {formatDate(asOf)}</strong>; flows cover <strong>{period.label}</strong>. Sections marked <em>projected</em> are estimates. Transfers are excluded from income and spending.
          </div>
        </div>
        {period.preset === 'auto' && <p className="small muted" style={{ margin: '8px 0 0' }}>Showing {period.label}{!period.label.includes('to') && period.end < asOf ? ` because only ${Number(asOf.slice(8, 10))} day(s) of ${formatMonth(endMonth)} have elapsed` : ''}. Change the period above any time.</p>}
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Boundary name="Net worth">
          <Card>
            <Stat label="Net worth" info={<>Net worth = everything you hold (cash, savings, investments) minus everything you owe (cards and loans). It is the sum of every account's contribution on {formatDate(asOf)} ({includePending ? 'posted and pending' : 'posted only'}).</>} value={<Money cents={nw.netWorth} />} sub={<>Assets <Money cents={nw.assets} tone="none" /> - Owed <Money cents={nw.liabilities} tone="none" /></>} />
            <div className="row between" style={{ marginTop: 8 }}>
              <span className="small">
                12-month change <Money cents={nwChange} signed />
              </span>
              <Sparkline values={nwSeries.map((s) => s.netWorth)} label={`Net worth over 12 months, from ${formatMoney(nwSeries[0]?.netWorth ?? 0)} to ${formatMoney(nw.netWorth)}`} />
            </div>
          </Card>
        </Boundary>
        <Boundary name="Balances">
          <Card>
            <Stat label="Cash (checking + savings)" value={<Money cents={cash} />} sub={`${includePending ? 'Includes' : 'Excludes'} pending: ${formatMoney(pendTotal, { signed: true })}`} />
            <div className="kv small" style={{ marginTop: 8 }}>
              <span>Investments</span>
              <Money cents={invest} />
              <span>Credit cards</span>
              <Owed contributionCents={cards} />
              <span>Loans</span>
              <Owed contributionCents={loans} />
            </div>
          </Card>
        </Boundary>
        <Boundary name="Cash flow">
          <Card>
            <Stat label={`Net cash flow, ${period.label}`} info={<>Net cash flow = income - net spending. Net spending is purchases minus refunds. Transfers (including card and loan payments) are excluded, so paying a card never counts as spending twice.</>} value={<Money cents={summary.netCashFlowCents} signed />} sub={summary.savingsRatePct === null ? 'No income in this period' : `Savings rate ${pctLabel(summary.savingsRatePct)}`} />
            <div className="kv small" style={{ marginTop: 8 }}>
              <span>Income</span>
              <Money cents={summary.incomeCents} />
              <span>Spending (net of refunds)</span>
              <button type="button" className="btn ghost small" style={{ justifySelf: 'end', padding: 0, minHeight: 0 }} onClick={() => toTransactions({ kind: 'expense' })}>
                <Money cents={summary.netExpenseCents} />
              </button>
              <span>Transfers moved (not spending)</span>
              <Money cents={summary.transferInCents} />
            </div>
          </Card>
        </Boundary>
        <Boundary name="Liquidity">
          <Card>
            <Stat label="Next 30 days (projected)" info={<>Starts from spendable cash today (checking + savings, pending included) and applies scheduled bills, income and loan/card payments due in the next 30 days. It is an estimate: everyday spending is not included.</>} value={<Money cents={outlook.endCents} />} sub={`from ${formatMoney(outlook.startCents)} today`} />
            <div className="small" style={{ marginTop: 8 }}>
              Obligations out <Money cents={outlook.outflowCents} /> / in <Money cents={outlook.inflowCents} tone="none" />
              <br />
              Lowest point <Money cents={outlook.lowCents} /> on {formatDateShort(outlook.lowDate)}
            </div>
          </Card>
        </Boundary>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <Boundary name="Spending by category">
          <Card title={`Spending by category, ${period.label}`} actions={<Link to={`/reports/categories?p=${period.preset}${period.preset === 'custom' ? `&from=${period.start}&to=${period.end}` : ''}`} className="small">Details</Link>}>
            <DonutChart
              title=""
              slices={cats.slice(0, 8).concat(cats.length > 8 ? [{ label: 'Everything else', value: cats.slice(8).reduce((s, c) => s + c.amountCents, 0), color: 'var(--muted)', categoryId: '__other__' }] : []).map((c) => ({ label: c.name, value: c.amountCents, color: c.color || undefined, categoryId: c.categoryId }))}
              total={cats.filter((c) => c.amountCents > 0).reduce((s, c) => s + c.amountCents, 0)}
              onSliceClick={(s) => s.categoryId !== '__other__' && toTransactions({ cat: s.categoryId === null ? '__none__' : s.categoryId, kind: 'expense' })}
            />
          </Card>
        </Boundary>
        <Boundary name="Trends">
          <Card title="Net worth, last 12 months">
            <LineChart title="" labels={nwSeries.map((s) => formatMonthShort(monthKey(s.date)))} series={[{ name: 'Net worth', values: nwSeries.map((s) => s.netWorth) }, { name: 'Assets', values: nwSeries.map((s) => s.assets) }, { name: 'Owed', values: nwSeries.map((s) => s.liabilities) }]} />
          </Card>
        </Boundary>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <Boundary name="Income and spending trend">
          <Card title="Income vs spending by month">
            <BarChart title="" labels={months.map((m) => formatMonthShort(m.month))} series={[{ name: 'Income', values: months.map((m) => m.incomeCents) }, { name: 'Spending', values: months.map((m) => m.netExpenseCents) }]} />
          </Card>
        </Boundary>
        <Boundary name="Budgets">
          <Card title={`Budget status, ${formatMonth(budgetMonthKey)}`} actions={<Link to={`/budgets?month=${budgetMonthKey}`} className="small">All budgets</Link>}>
            {budgets.length === 0 ? (
              <EmptyState title="No budgets yet">Create a monthly budget to see progress here.</EmptyState>
            ) : (
              <ul className="list-plain">
                {(atRisk.length ? atRisk : budgets.slice(0, 5)).slice(0, 6).map((b) => (
                  <li key={b.budget.id} style={{ display: 'block' }}>
                    <div className="row between">
                      <span>
                        <Link to={`/budgets/${encodeURIComponent(b.budget.categoryId)}?month=${budgetMonthKey}`}>{b.categoryName}</Link>{' '}
                        {b.risk === 'over' && <Badge tone="neg">Over by {formatMoney(-b.row.remainingCents)}</Badge>}
                        {b.risk === 'at_risk' && <Badge tone="warn">At risk</Badge>}
                        {b.unusual && <Badge tone="info" title={`Prior 3-month average ${formatMoney(b.avgPriorCents)}`}>Unusually high</Badge>}
                      </span>
                      <span className="small amt">
                        {formatMoney(b.row.spentCents)} of {formatMoney(b.row.availableCents)}
                      </span>
                    </div>
                    <ProgressBar pct={b.row.availableCents > 0 ? (b.row.spentCents / b.row.availableCents) * 100 : b.row.spentCents > 0 ? 100 : 0} tone={b.risk === 'over' ? 'over' : b.risk === 'at_risk' ? 'risk' : ''} label={`${b.categoryName} budget used`} />
                  </li>
                ))}
              </ul>
            )}
            {budgets.length > 0 && atRisk.length === 0 && <p className="small muted" style={{ marginTop: 8 }}>No category is over or close to its limit.</p>}
          </Card>
        </Boundary>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <Boundary name="Recent activity">
          <Card title="Recent activity" actions={<Link to="/transactions" className="small">All transactions</Link>}>
            {recent.length === 0 ? (
              <EmptyState title="No transactions yet">Add one with the button above, or import a CSV.</EmptyState>
            ) : (
              <ul className="list-plain">
                {recent.map((t) => (
                  <li key={t.id}>
                    <span style={{ minWidth: 0, flex: '1 1 200px' }}>
                      <button type="button" className="btn ghost small" style={{ padding: 0, minHeight: 0, textAlign: 'left', fontWeight: 600 }} onClick={() => editors.openTransaction({ id: t.id })}>
                        {t.description}
                      </button>
                      <div className="small muted">
                        {formatDate(t.date)} · {index.accountsById.get(t.accountId)?.name} · {categoryLabel(t, index)}
                      </div>
                      <TxBadges tx={t} index={index} reconciledIds={reconciled} recurringById={recurringById} />
                    </span>
                    <Money cents={t.amountCents} signed />
                  </li>
                ))}
              </ul>
            )}
            <hr className="divider" />
            <div className="row between">
              <span>
                <strong>{pend.length}</strong> pending item{pend.length === 1 ? '' : 's'}
              </span>
              <span>
                <Money cents={pendTotal} signed /> {pend.length > 0 && <Link to="/transactions?status=pending" className="small">Review</Link>}
              </span>
            </div>
            <p className="small muted" style={{ margin: '4px 0 0' }}>Pending items {includePending ? 'are included in' : 'are not yet in'} the figures above. Switch the Basis control in the top bar to change this.</p>
          </Card>
        </Boundary>
        <Boundary name="Upcoming bills">
          <Card title="Upcoming bills and obligations (next 30 days, projected)" actions={<Link to="/recurring" className="small">Recurring & bills</Link>}>
            {outlook.rows.length === 0 ? (
              <EmptyState title="Nothing scheduled">Add recurring bills and income on the Recurring page.</EmptyState>
            ) : (
              <ul className="list-plain">
                {outlook.rows.slice(0, 9).map((r, i) => (
                  <li key={`${r.label}-${r.date}-${i}`}>
                    <span>
                      {formatDateShort(r.date)} · {r.label} {r.status === 'overdue' && <Badge tone="neg">Overdue</Badge>} {r.kind === 'debt' && <Badge>Debt payment</Badge>}
                    </span>
                    <Money cents={r.effectCents} signed />
                  </li>
                ))}
              </ul>
            )}
            {outlook.rows.length > 9 && <p className="small muted">+{outlook.rows.length - 9} more on the Recurring page.</p>}
          </Card>
        </Boundary>
      </div>

      <div className="grid cols-2">
        <Boundary name="Goals">
          <Card title="Savings goals" actions={<Link to="/goals" className="small">Goals & debt</Link>}>
            {goals.length === 0 ? (
              <EmptyState title="No goals yet">Create a savings goal to track progress.</EmptyState>
            ) : (
              <ul className="list-plain">
                {goals.map((g) => (
                  <li key={g.goal.id} style={{ display: 'block' }}>
                    <div className="row between">
                      <span>{g.goal.name}</span>
                      <span className="small amt">
                        {formatMoney(g.allocatedCents)} of {formatMoney(g.goal.targetCents)} ({pctLabel(g.pct)})
                      </span>
                    </div>
                    <ProgressBar pct={g.pct} label={`${g.goal.name} progress`} />
                    {g.status !== 'complete' && <div className="small muted">Needs {formatMoney(g.perMonthCents)}/month to reach it by {formatDate(g.goal.targetDate)}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </Boundary>
        <Boundary name="Debt">
          <Card title="Debt snapshot" actions={<Link to="/goals/debt" className="small">Debt details</Link>}>
            <div className="grid cols-2">
              <Stat label="Total owed" value={<Money cents={totalOwed} />} />
              <Stat label="Projected debt-free (at current payments)" value={lastPayoff ? formatDate(lastPayoff) : debts.some((d) => d.owedCents > 0) ? 'Not within 50 years' : 'Debt free'} />
            </div>
            <ul className="list-plain" style={{ marginTop: 10 }}>
              {debts.map((d) => (
                <li key={d.account.id}>
                  <Link to={`/accounts/${encodeURIComponent(d.account.id)}`}>{d.account.name}</Link>
                  <span className="small amt">
                    {formatMoney(d.owedCents)} @ {(d.aprBps / 100).toFixed(2)}% · {d.schedule.payoffDate ? `paid off ${formatDate(d.schedule.payoffDate)}` : d.owedCents <= 0 ? 'no balance' : d.schedule.status === 'payment_below_interest' ? 'payment below interest' : 'payoff beyond horizon'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="small muted">Payoff dates are planning projections under each account's payment policy (the same rule as the Scenario Planner), not lender quotes. Interest is estimated monthly.</p>
          </Card>
        </Boundary>
      </div>
      {data.accounts.length === 0 && <Callout tone="info">No accounts yet. Add one from the Accounts page to begin.</Callout>}
    </>
  );
}
