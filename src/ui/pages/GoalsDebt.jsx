import { useMemo, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { useData, useRun } from '../../state/hooks.jsx';
import { buildIndex, basisIncludesPending } from '../../domain/ledger.js';
import { goalProgress, accountAllocations } from '../../domain/goals.js';
import { debtOverview, amortizationSchedule, compareSchedules, regularPayment, nextDueDate, dueDayOf } from '../../domain/debt.js';
import { saveGoal, deleteGoal, addGoalContribution } from '../../domain/ops/catalog.js';
import { formatDate, formatMonthShort, monthKey } from '../../domain/dates.js';
import { formatMoney, parseMoney, centsToDecimalString, formatBps, parsePercentToBps } from '../../domain/money.js';
import { PageHead, Card, Stat, Badge, Callout, Explain, EmptyState, ProgressBar, Boundary } from '../components/Common.jsx';
import { Money, Owed } from '../components/Money.jsx';
import DataTable from '../components/DataTable.jsx';
import { Modal, useConfirm } from '../components/Modal.jsx';
import { ErrorSummary, MoneyField, SelectField, TextField, TextAreaField, fieldErrors } from '../components/Form.jsx';
import { BarChart, LineChart } from '../charts/Charts.jsx';
import { pctLabel } from '../format.js';

export default function GoalsDebt() {
  const { tab = 'goals' } = useParams();
  return (
    <>
      <nav className="tabs" aria-label="Goals and debt sections">
        <NavLink to="/goals" end>Savings goals</NavLink>
        <NavLink to="/goals/debt">Debt & payoff</NavLink>
      </nav>
      {tab === 'debt' ? <Debt /> : <Goals />}
    </>
  );
}

const ALLOC_LABELS = { full: 'Counts the account balance up to the target', fixed: 'Earmarks a fixed amount of the account', percent: 'Earmarks a percentage of the account balance', manual: 'Tracked manually (simulated contributions)' };

function Goals() {
  const data = useData();
  const run = useRun();
  const confirm = useConfirm();
  const includePending = basisIncludesPending(data);
  const index = useMemo(() => buildIndex(data), [data]);
  const asOf = data.settings.asOfDate;
  const progress = useMemo(() => goalProgress(data, asOf, includePending), [data, asOf, includePending]);
  const allocs = useMemo(() => accountAllocations(data, asOf, includePending), [data, asOf, includePending]);
  const [editing, setEditing] = useState(null);
  const [contrib, setContrib] = useState(null);
  return (
    <>
      <PageHead title="Savings goals" actions={<button type="button" className="btn primary" onClick={() => setEditing({})}>Add goal</button>}>
        Goals are earmarks of money you already hold - they never add to your net worth.
      </PageHead>
      <Callout tone="info">
        <strong>How progress is measured.</strong> A goal either counts part of a linked account's balance (the whole balance up to the target, a fixed amount, or a percentage) or tracks contributions you record by hand. Several goals can share one account: they are served in priority order and can never earmark more than the account actually holds, so nothing is counted twice. Progress follows the account automatically when balances or transfers change.
      </Callout>
      <div className="stack" style={{ marginTop: 16 }}>
        {progress.length === 0 && <Card><EmptyState title="No goals yet" action={<button type="button" className="btn primary" onClick={() => setEditing({})}>Create a goal</button>}>Track an emergency fund, a trip or a down payment.</EmptyState></Card>}
        <div className="grid auto">
          {progress.map((p) => (
            <Boundary key={p.goal.id} name={p.goal.name}>
              <Card>
                <div className="row between"><h3 style={{ margin: 0 }}>{p.goal.name}</h3>{p.status === 'complete' ? <Badge tone="pos">Complete</Badge> : p.status === 'overdue' ? <Badge tone="neg">Past target date</Badge> : <Badge tone="info">In progress</Badge>}</div>
                <p className="small muted">{ALLOC_LABELS[p.goal.allocation.type]}{p.goal.accountId ? ` · ${index.accountsById.get(p.goal.accountId)?.name}` : ''}</p>
                <div className="row between"><strong className="amt">{formatMoney(p.allocatedCents)}</strong><span className="small muted">of {formatMoney(p.goal.targetCents)} · {pctLabel(p.pct)}</span></div>
                <ProgressBar pct={p.pct} label={`${p.goal.name} progress`} />
                <div className="row" style={{ marginTop: 6 }} aria-label="Milestones">
                  {p.milestones.map((m) => (<Badge key={m.pct} tone={m.reached ? 'pos' : ''}>{m.reached ? '✓' : '○'} {m.pct}%</Badge>))}
                </div>
                <div className="kv small" style={{ marginTop: 10 }}>
                  <span>Remaining</span><span>{formatMoney(p.remainingCents)}</span>
                  <span>Target date</span><span>{formatDate(p.goal.targetDate)}</span>
                  <span>Needed per month</span><span>{p.status === 'complete' ? '-' : formatMoney(p.perMonthCents)}</span>
                  <span>Needed per week</span><span>{p.status === 'complete' ? '-' : formatMoney(p.perWeekCents)}</span>
                </div>
                <div className="actions" style={{ marginTop: 10 }}>
                  <button type="button" className="btn small" onClick={() => setEditing(p.goal)}>Edit</button>
                  {p.goal.allocation.type === 'manual' && <button type="button" className="btn small" onClick={() => setContrib(p.goal)}>Add contribution</button>}
                  <button type="button" className="btn small danger" onClick={async () => { if (await confirm({ title: `Delete "${p.goal.name}"?`, danger: true, confirmLabel: 'Delete goal', message: 'Your accounts are not changed. You can undo right after.' })) run((d) => deleteGoal(d, p.goal.id), { label: 'delete goal', success: 'Goal deleted', undo: true }); }}>Delete</button>
                </div>
              </Card>
            </Boundary>
          ))}
        </div>
        {allocs.length > 0 && (
          <Card title="Money set aside per account">
            <DataTable
              caption="Earmarked versus unallocated"
              rows={allocs}
              rowKey={(a) => a.accountId}
              columns={[
                { key: 'a', header: 'Account', main: true, render: (a) => index.accountsById.get(a.accountId)?.name },
                { key: 'b', header: 'Balance', className: 'num', render: (a) => <Money cents={a.balanceCents} tone="none" /> },
                { key: 'e', header: 'Earmarked for goals', className: 'num', render: (a) => <Money cents={a.earmarkedCents} tone="none" /> },
                { key: 'u', header: 'Not earmarked', className: 'num', render: (a) => <Money cents={a.unallocatedCents} tone="none" /> },
              ]}
            />
          </Card>
        )}
      </div>
      {editing && <GoalModal goal={editing} onClose={() => setEditing(null)} />}
      {contrib && <ContributionModal goal={contrib} onClose={() => setContrib(null)} />}
    </>
  );
}

function GoalModal({ goal, onClose }) {
  const data = useData();
  const run = useRun();
  const a = goal.allocation || { type: 'full', value: 0 };
  const [f, setF] = useState({
    name: goal.name || '',
    target: goal.targetCents ? centsToDecimalString(goal.targetCents) : '',
    targetDate: goal.targetDate || '',
    type: a.type,
    accountId: goal.accountId || data.accounts.find((x) => x.type === 'savings' && x.status === 'active')?.id || '',
    value: a.type === 'fixed' ? centsToDecimalString(a.value) : a.type === 'percent' ? String(a.value / 100) : '',
    priority: String(goal.priority ?? 100),
    note: goal.note || '',
  });
  const [errors, setErrors] = useState([]);
  const fe = fieldErrors(errors);
  const set = (p) => setF((s) => ({ ...s, ...p }));
  const submit = (e) => {
    e.preventDefault();
    const t = parseMoney(f.target, { allowNegative: false });
    const errs = [];
    if (!t.ok) errs.push({ field: 'targetCents', message: t.error });
    let value = 0;
    if (f.type === 'fixed') {
      const v = parseMoney(f.value, { allowNegative: false });
      if (!v.ok) errs.push({ field: 'allocation', message: v.error });
      else value = v.cents;
    } else if (f.type === 'percent') {
      const v = parsePercentToBps(f.value);
      if (!v.ok) errs.push({ field: 'allocation', message: v.error });
      else value = v.bps;
    }
    if (!/^-?\d+$/.test(f.priority.trim())) errs.push({ field: 'priority', message: 'Priority must be a whole number.' });
    if (errs.length) return setErrors(errs);
    const r = run((d) => saveGoal(d, { id: goal.id, name: f.name, targetCents: t.cents, targetDate: f.targetDate, accountId: f.type === 'manual' ? null : f.accountId, allocation: { type: f.type, value }, priority: Number(f.priority), note: f.note }), { label: goal.id ? 'edit goal' : 'add goal', success: 'Goal saved', failTitle: 'Goal not saved', undo: true });
    if (r.ok) onClose();
    else setErrors(r.errors);
    return undefined;
  };
  return (
    <Modal title={goal.id ? 'Edit goal' : 'Add goal'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form="goal-form" className="btn primary">Save goal</button></>}>
      <form id="goal-form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />
        <div className="form-grid">
          <TextField label="Goal name" value={f.name} onChange={(v) => set({ name: v })} error={fe.name} className="wide" />
          <MoneyField label="Target amount" value={f.target} onChange={(v) => set({ target: v })} error={fe.targetCents} />
          <TextField label="Target date" type="date" value={f.targetDate} onChange={(v) => set({ targetDate: v })} error={fe.targetDate} />
          <SelectField label="Progress is measured as" value={f.type} onChange={(v) => set({ type: v })} options={Object.entries(ALLOC_LABELS).map(([value, label]) => ({ value, label }))} error={fe.allocation} className="wide" />
          {f.type !== 'manual' && <SelectField label="Linked account" value={f.accountId} onChange={(v) => set({ accountId: v })} options={data.accounts.filter((x) => x.status === 'active' && ['savings', 'checking', 'investment'].includes(x.type)).map((x) => ({ value: x.id, label: x.name }))} placeholder="Choose" error={fe.accountId} />}
          {f.type === 'fixed' && <MoneyField label="Amount earmarked" value={f.value} onChange={(v) => set({ value: v })} error={fe.allocation} />}
          {f.type === 'percent' && <TextField label="Percent of the balance" value={f.value} onChange={(v) => set({ value: v })} error={fe.allocation} />}
          <TextField label="Priority (lower is served first)" value={f.priority} onChange={(v) => set({ priority: v })} error={fe.priority} />
          <TextAreaField label="Note" value={f.note} onChange={(v) => set({ note: v })} rows={2} className="wide" />
        </div>
      </form>
    </Modal>
  );
}

function ContributionModal({ goal, onClose }) {
  const data = useData();
  const run = useRun();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(data.settings.asOfDate);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState([]);
  const submit = (e) => {
    e.preventDefault();
    const a = parseMoney(amount);
    if (!a.ok) return setErrors([{ message: a.error }]);
    const r = run((d) => addGoalContribution(d, goal.id, { date, amountCents: a.cents, note }), { label: 'goal contribution', success: 'Contribution recorded', undo: true });
    if (r.ok) onClose();
    else setErrors(r.errors);
    return undefined;
  };
  return (
    <Modal title={`Add a contribution to ${goal.name}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form="contrib-form" className="btn primary">Add</button></>}>
      <form id="contrib-form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />
        <p className="small muted">These are simulated contributions you track by hand. They do not move money between accounts.</p>
        <div className="form-grid">
          <MoneyField label="Amount (negative to withdraw)" value={amount} onChange={setAmount} />
          <TextField label="Date" type="date" value={date} onChange={setDate} />
          <TextField label="Note" value={note} onChange={setNote} className="wide" />
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------- debt
function Debt() {
  const data = useData();
  const asOf = data.settings.asOfDate;
  const rows = useMemo(() => debtOverview(data, asOf, true), [data, asOf]);
  const [sel, setSel] = useState(rows[0]?.account.id || '');
  const row = rows.find((r) => r.account.id === sel) || rows[0];
  const totalOwed = rows.reduce((s, r) => s + Math.max(0, r.owedCents), 0);
  const totalMin = rows.reduce((s, r) => s + r.regularPaymentCents, 0);
  const interestMonthly = rows.reduce((s, r) => s + r.monthlyInterestCents, 0);
  return (
    <>
      <PageHead title="Debt & payoff">Cards and loans, with projected payoff under the scheduled payment and a what-if calculator for extra payments.</PageHead>
      <Callout tone="warn"><strong>Projections only.</strong> Payoff dates use a simple monthly model (interest = balance × APR ÷ 12 each due date, rounded to the cent). They are planning estimates, not lender payoff quotes; real interest depends on daily balances, fees and payment timing.</Callout>
      <div className="grid cols-3" style={{ margin: '16px 0' }}>
        <Card><Stat label="Total owed" value={<Money cents={totalOwed} tone="none" />} sub="Cards and loans, including pending" /></Card>
        <Card><Stat label="Monthly payments scheduled" value={<Money cents={totalMin} tone="none" />} /></Card>
        <Card><Stat label="Interest accruing per month" value={<Money cents={interestMonthly} tone="none" />} sub="At current balances" /></Card>
      </div>
      {rows.length === 0 ? <Card><EmptyState title="No debts">Add a credit card or loan account.</EmptyState></Card> : (
        <div className="stack">
          <Boundary name="Debt overview">
            <Card title="Debt overview">
              <DataTable
                caption="Debts"
                rows={rows}
                rowKey={(r) => r.account.id}
                columns={[
                  { key: 'n', header: 'Debt', main: true, render: (r) => <button type="button" className="btn ghost small title" style={{ padding: 0, minHeight: 0, fontWeight: 650 }} onClick={() => setSel(r.account.id)} aria-pressed={r.account.id === row?.account.id}>{r.account.name}</button> },
                  { key: 'o', header: 'Owed', className: 'num', render: (r) => <Owed contributionCents={-r.owedCents} /> },
                  { key: 'a', header: 'APR', className: 'num', render: (r) => formatBps(r.aprBps) },
                  { key: 'p', header: 'Regular payment', className: 'num', render: (r) => (r.account.paymentMode === 'pay_in_full' ? 'Pay in full' : formatMoney(r.regularPaymentCents)) },
                  { key: 'i', header: 'Interest / month', className: 'num', render: (r) => formatMoney(r.monthlyInterestCents) },
                  { key: 'd', header: 'Next due', render: (r) => formatDate(r.nextDueDate) },
                  { key: 'u', header: 'Used', className: 'num', render: (r) => (r.utilizationPct === null ? '-' : `${r.utilizationPct}%`) },
                  { key: 's', header: 'Projected payoff', render: (r) => (r.owedCents <= 0 ? <Badge tone="pos">Nothing owed</Badge> : r.schedule.status === 'paid_off' ? `${formatDate(r.schedule.payoffDate)} (${r.schedule.periods} payments)` : <Badge tone="neg">{r.schedule.status === 'payment_below_interest' ? 'Payment below interest' : r.schedule.status === 'zero_payment' ? 'No payment scheduled' : 'Not within horizon'}</Badge>) },
                ]}
              />
            </Card>
          </Boundary>
          {row && <Calculator key={row.account.id} row={row} asOf={asOf} />}
        </div>
      )}
    </>
  );
}

function Calculator({ row, asOf }) {
  const a = row.account;
  const owed = Math.max(0, row.owedCents);
  const [extra, setExtra] = useState('0');
  const [lump, setLump] = useState('0');
  const [lumpPeriod, setLumpPeriod] = useState('1');
  const [override, setOverride] = useState('');
  const [aprText, setAprText] = useState(String(row.aprBps / 100));
  const [showAll, setShowAll] = useState(false);
  const ex = useMemo(() => parseMoney(extra || '0', { allowNegative: false }), [extra]);
  const lu = useMemo(() => parseMoney(lump || '0', { allowNegative: false }), [lump]);
  const ov = useMemo(() => (override ? parseMoney(override, { allowNegative: false }) : { ok: true, cents: null }), [override]);
  const apr = useMemo(() => parsePercentToBps(aprText || '0'), [aprText]);
  const basePayment = regularPayment(a, owed);
  const valid = ex.ok && lu.ok && ov.ok && apr.ok;
  const first = nextDueDate(asOf, dueDayOf(a));
  const baseline = useMemo(() => amortizationSchedule({ balanceCents: owed, aprBps: a.aprBps, paymentCents: basePayment, firstPaymentDate: first, maxPeriods: 600 }), [owed, a.aprBps, basePayment, first]);
  const scenario = useMemo(() => (valid ? amortizationSchedule({ balanceCents: owed, aprBps: apr.bps, paymentCents: ov.cents ?? basePayment, extraCents: ex.cents, lumpSums: lu.cents ? [{ period: Math.max(1, Number(lumpPeriod) || 1), amountCents: lu.cents }] : [], firstPaymentDate: first, maxPeriods: 600 }) : null), [valid, owed, apr, ov, basePayment, ex, lu, lumpPeriod, first]);
  const cmp = scenario ? compareSchedules(baseline, scenario) : null;
  const sched = scenario || baseline;
  const rowsShown = showAll ? sched.rows : sched.rows.slice(0, 24);
  const changed = (ex.ok && ex.cents > 0) || (lu.ok && lu.cents > 0) || (ov.ok && ov.cents !== null) || (apr.ok && apr.bps !== a.aprBps);
  return (
    <Card title={`${a.name}: payoff calculator`}>
      <p className="small muted">What-if only - nothing here changes your accounts. To save a scenario and compare it across your whole plan, use the Scenario Planner.</p>
      <div className="form-grid">
        <MoneyField label="Extra payment every month" value={extra} onChange={setExtra} error={!ex.ok ? ex.error : undefined} />
        <MoneyField label="One-time extra payment" value={lump} onChange={setLump} error={!lu.ok ? lu.error : undefined} />
        <TextField label="...made with payment number" type="number" min="1" value={lumpPeriod} onChange={setLumpPeriod} />
        <MoneyField label={`Regular payment (now ${basePayment ? formatMoney(basePayment) : '$0.00'})`} value={override} onChange={setOverride} error={!ov.ok ? ov.error : undefined} hint="Leave empty to use the scheduled payment." />
        <TextField label="APR % (what-if)" value={aprText} onChange={setAprText} error={!apr.ok ? apr.error : undefined} />
      </div>
      <div className="grid cols-3" style={{ margin: '14px 0' }}>
        <Stat label="Payoff date" value={sched.status === 'paid_off' ? formatDate(sched.payoffDate) : 'Not paid off'} sub={sched.message} />
        <Stat label="Total interest" value={<Money cents={sched.totalInterestCents} tone="none" />} sub={`Total paid ${formatMoney(sched.totalPaidCents)}`} />
        <Stat label="Compared with the current plan" value={cmp?.comparable && changed ? `${cmp.monthsSaved} month${cmp.monthsSaved === 1 ? '' : 's'} sooner` : changed ? 'Not comparable' : 'No change yet'} sub={cmp?.comparable && changed ? `Saves ${formatMoney(cmp.interestSavedCents)} in interest` : changed ? 'One of the plans never pays off, so savings cannot be calculated.' : 'Enter an extra payment above.'} />
      </div>
      {sched.status === 'payment_below_interest' && <Callout tone="error">The payment ({formatMoney(ov.cents ?? basePayment)}) does not cover this month's interest ({formatMoney(row.monthlyInterestCents)}). The balance grows and the debt is never paid off. Increase the payment.</Callout>}
      {sched.status === 'zero_payment' && <Callout tone="warn">No payment is scheduled for this account. Set a scheduled payment in the account details or enter one above.</Callout>}
      {sched.rows.length > 0 && (
        <>
          <BarChart title="Where each payment goes (first 36 payments)" stacked labels={sched.rows.slice(0, 36).map((r) => formatMonthShort(monthKey(r.date)))} series={[{ name: 'Principal', values: sched.rows.slice(0, 36).map((r) => r.principalCents) }, { name: 'Interest', values: sched.rows.slice(0, 36).map((r) => r.interestCents) }]} />
          <LineChart title="Remaining balance" labels={sched.rows.filter((_, i) => i % Math.max(1, Math.ceil(sched.rows.length / 36)) === 0).map((r) => formatMonthShort(monthKey(r.date)))} series={[{ name: 'Owed after payment', values: sched.rows.filter((_, i) => i % Math.max(1, Math.ceil(sched.rows.length / 36)) === 0).map((r) => r.endCents) }]} />
          <h3 style={{ marginTop: 14 }}>Payment schedule</h3>
          <DataTable
            caption={`Payment schedule for ${a.name}`}
            rows={rowsShown}
            rowKey={(r) => r.period}
            columns={[
              { key: 'p', header: 'Payment #', className: 'num', render: (r) => r.period },
              { key: 'd', header: 'Date', render: (r) => formatDate(r.date) },
              { key: 's', header: 'Starting balance', className: 'num', render: (r) => formatMoney(r.startCents) },
              { key: 'i', header: 'Interest', className: 'num', render: (r) => formatMoney(r.interestCents) },
              { key: 'pr', header: 'Principal', className: 'num', render: (r) => formatMoney(r.principalCents) },
              { key: 'pay', header: 'Payment', className: 'num', render: (r) => formatMoney(r.paymentCents) },
              { key: 'e', header: 'Ending balance', className: 'num', render: (r) => formatMoney(r.endCents) },
            ]}
          />
          {sched.rows.length > 24 && <button type="button" className="btn small" style={{ marginTop: 8 }} onClick={() => setShowAll((s) => !s)}>{showAll ? 'Show first 24 only' : `Show all ${sched.rows.length} payments`}</button>}
        </>
      )}
      <Explain summary="Assumptions"><p>Payments happen on the due day each month starting {formatDate(first)}. Each period adds one month of interest (balance × APR ÷ 12, rounded half away from zero to the cent) and then subtracts the payment; the last payment is capped so it never exceeds what is owed. New purchases on a card are not modeled here.</p></Explain>
    </Card>
  );
}
