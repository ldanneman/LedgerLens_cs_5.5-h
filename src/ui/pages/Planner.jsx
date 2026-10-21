import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useData, useRun } from '../../state/hooks.jsx';
import { runProjection } from '../../forecast/engine.js';
import { compareProjections } from '../../forecast/compare.js';
import { validateChange, CHANGE_TYPES, CHANGE_TYPE_IDS } from '../../forecast/changes.js';
import { describeChange } from '../../forecast/describe.js';
import { saveScenario, duplicateScenario, deleteScenario } from '../../domain/ops/catalog.js';
import { isLiabilityType } from '../../domain/ledger.js';
import { formatMoney, parseMoney, parsePercentToBps, centsToDecimalString } from '../../domain/money.js';
import { formatDate, formatMonth, formatMonthShort } from '../../domain/dates.js';
import { INTERVALS } from '../../domain/schema.js';
import { PageHead, Card, Stat, Badge, Callout, Explain, Boundary } from '../components/Common.jsx';
import { Money } from '../components/Money.jsx';
import DataTable from '../components/DataTable.jsx';
import { Modal, useConfirm } from '../components/Modal.jsx';
import { CheckField, ErrorSummary, MoneyField, SelectField, TextField, TextAreaField } from '../components/Form.jsx';
import { LineChart } from '../charts/Charts.jsx';

let draftSeq = 0;
const newDraft = () => ({ id: null, name: 'New scenario', description: '', horizonMonths: 12, asOfDate: null, assumptions: { investmentGrowthBps: null, variableSpending: 'trailing', variableSpendingCents: null, includeSavingsInterest: true }, changes: [] });
const clone = (o) => JSON.parse(JSON.stringify(o));

export default function Planner() {
  const data = useData();
  const nav = useNavigate();
  const { scenarioId } = useParams();
  const run = useRun();
  const confirm = useConfirm();
  const saved = data.scenarios.find((s) => s.id === scenarioId) || null;
  const [draft, setDraft] = useState(() => (saved ? clone(saved) : newDraft()));
  const [compareTo, setCompareTo] = useState('baseline');
  const [changeEditor, setChangeEditor] = useState(null);
  const [month, setMonth] = useState('');
  const [errors, setErrors] = useState([]);

  useEffect(() => {
    setDraft(saved ? clone(saved) : newDraft());
    setErrors([]);
    setMonth('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId, saved ? undefined : 0]);

  const dirty = saved ? JSON.stringify(saved) !== JSON.stringify(draft) : draft.changes.length > 0 || draft.name !== 'New scenario';
  const asOf = data.settings.asOfDate;
  const refs = useMemo(() => ({ accounts: new Map(data.accounts.map((a) => [a.id, a])), recurring: new Map(data.recurring.map((r) => [r.id, r])) }), [data]);
  const changeErrors = useMemo(() => draft.changes.flatMap((c, i) => validateChange(c, refs).map((m) => `Change ${i + 1}: ${m}`)), [draft.changes, refs]);
  const window = { asOfDate: asOf, horizonMonths: draft.horizonMonths };
  const other = compareTo === 'baseline' ? null : data.scenarios.find((s) => s.id === compareTo) || null;

  const result = useMemo(() => {
    if (changeErrors.length) return null;
    try {
      const a = other ? runProjection(data, other, window) : runProjection(data, null, window);
      const b = runProjection(data, { ...draft, id: draft.id || 'draft' }, window);
      return { a, b, cmp: compareProjections(a, b) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [data, draft, other, changeErrors.length, asOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const setD = (p) => setDraft((d) => ({ ...d, ...p }));
  const setAssume = (p) => setDraft((d) => ({ ...d, assumptions: { ...d.assumptions, ...p } }));

  const save = () => {
    const r = run((d) => saveScenario(d, { ...draft }), { label: `save scenario ${draft.name}`, success: 'Scenario saved', failTitle: 'Scenario not saved', undo: true });
    if (r.ok) {
      setErrors([]);
      if (!draft.id) nav(`/planner/${encodeURIComponent(r.id)}`);
    } else setErrors(r.errors);
  };

  const growthText = draft.assumptions.investmentGrowthBps === null ? '' : String(draft.assumptions.investmentGrowthBps / 100);

  return (
    <>
      <PageHead title="Scenario planner" actions={<button type="button" className="btn primary" onClick={() => nav('/planner')}>New scenario</button>}>
        Try financial decisions on a copy of the future. Your ledger and balances are never changed by a scenario.
      </PageHead>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', alignItems: 'start' }}>
        <div className="stack">
          <Card title="Saved scenarios">
            {data.scenarios.length === 0 ? <p className="muted small">None yet. Build one on the right and save it.</p> : (
              <ul className="list-plain">
                {data.scenarios.map((s) => (
                  <li key={s.id}>
                    <button type="button" className="btn ghost small" style={{ padding: '2px 4px', minHeight: 0, textAlign: 'left', fontWeight: s.id === scenarioId ? 700 : 500 }} aria-current={s.id === scenarioId ? 'true' : undefined} onClick={() => nav(`/planner/${encodeURIComponent(s.id)}`)}>{s.name}</button>
                    <span className="small muted">{s.changes.length} change{s.changes.length === 1 ? '' : 's'} · {s.horizonMonths} mo</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="small muted">The <strong>baseline</strong> is your current data with recurring items and scheduled debt payments, and no changes.</p>
          </Card>
          <Card title="Scenario details" actions={dirty ? <Badge tone="warn">Unsaved changes</Badge> : saved ? <Badge tone="pos">Saved</Badge> : null}>
            <ErrorSummary errors={errors} />
            <div className="form-grid">
              <TextField label="Name" value={draft.name} onChange={(v) => setD({ name: v })} className="wide" />
              <TextAreaField label="Description" value={draft.description} onChange={(v) => setD({ description: v })} rows={2} className="wide" />
              <SelectField label="Projection length" value={String(draft.horizonMonths)} onChange={(v) => setD({ horizonMonths: Number(v) })} options={[12, 18, 24, 36, 48, 60, 120].map((n) => ({ value: String(n), label: `${n} months` }))} />
              <TextField label="Assumed investment growth (% per year)" value={growthText} onChange={(v) => { if (v.trim() === '') return setAssume({ investmentGrowthBps: null }); const r = parsePercentToBps(v.replace('-', '')); const neg = v.trim().startsWith('-'); return r.ok ? setAssume({ investmentGrowthBps: neg ? -r.bps : r.bps }) : undefined; }} hint="Empty = use the dataset default (0%). Not a prediction." />
              <SelectField label="Everyday spending" value={draft.assumptions.variableSpending} onChange={(v) => setAssume({ variableSpending: v })} options={[{ value: 'trailing', label: 'Average of recent months' }, { value: 'custom', label: 'A fixed monthly amount' }, { value: 'none', label: 'Do not project' }]} />
              {draft.assumptions.variableSpending === 'custom' && (
                <MoneyField label="Monthly everyday spending" value={draft.assumptions.variableSpendingCents === null ? '' : centsToDecimalString(draft.assumptions.variableSpendingCents)} onChange={(v) => { const r = parseMoney(v || '0', { allowNegative: false }); if (r.ok) setAssume({ variableSpendingCents: r.cents }); }} />
              )}
              <CheckField label="Include interest earned on savings" checked={draft.assumptions.includeSavingsInterest} onChange={(v) => setAssume({ includeSavingsInterest: v })} />
            </div>
            <p className="small muted">Forecast starts from {formatDate(asOf)}. Change the as-of date in the top bar to move it.</p>
            <div className="actions">
              <button type="button" className="btn primary" onClick={save} disabled={changeErrors.length > 0}>Save scenario</button>
              {saved && <button type="button" className="btn" onClick={() => setDraft(clone(saved))} disabled={!dirty}>Revert edits</button>}
              {saved && <button type="button" className="btn" onClick={() => { const r = run((d) => duplicateScenario(d, saved.id), { label: 'duplicate scenario', success: 'Scenario duplicated', undo: true }); if (r.ok) nav(`/planner/${encodeURIComponent(r.id)}`); }}>Duplicate</button>}
              {saved && <button type="button" className="btn danger" onClick={async () => { if (await confirm({ title: `Delete "${saved.name}"?`, danger: true, confirmLabel: 'Delete scenario', message: 'Only the saved what-if is removed. Your ledger is untouched.' })) { const r = run((d) => deleteScenario(d, saved.id), { label: 'delete scenario', success: 'Scenario deleted', undo: true }); if (r.ok) nav('/planner'); } }}>Delete</button>}
            </div>
          </Card>
          <Card title={`Changes (${draft.changes.length})`} actions={<button type="button" className="btn small primary" onClick={() => setChangeEditor({ type: 'one_time' })}>Add change</button>}>
            {draft.changes.length === 0 ? <p className="muted small">No changes: this scenario equals the baseline. Add a raise, a new bill, a one-time expense, extra loan payments and more.</p> : (
              <ul className="list-plain">
                {draft.changes.map((c, i) => (
                  <li key={c.id || i} style={{ display: 'block' }}>
                    <div className="row between">
                      <span style={{ opacity: c.enabled === false ? 0.55 : 1 }}><strong>{CHANGE_TYPES[c.type]?.label || c.type}</strong><br /><span className="small">{describeChange(c, data)}</span></span>
                      <span className="row">
                        <CheckField label="On" checked={c.enabled !== false} onChange={(v) => setD({ changes: draft.changes.map((x, j) => (j === i ? { ...x, enabled: v } : x)) })} />
                        <button type="button" className="btn small" onClick={() => setChangeEditor({ ...c, _index: i })}>Edit</button>
                        <button type="button" className="btn small danger" onClick={() => setD({ changes: draft.changes.filter((_, j) => j !== i) })} aria-label={`Remove change ${i + 1}`}>Remove</button>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {changeErrors.length > 0 && <Callout tone="error"><ul style={{ margin: 0, paddingLeft: 18 }}>{changeErrors.map((m, i) => <li key={i}>{m}</li>)}</ul></Callout>}
          </Card>
        </div>

        <div className="stack" style={{ gridColumn: 'span 2', minWidth: 0 }}>
          <Card>
            <SelectField label="Compare this scenario with" value={compareTo} onChange={setCompareTo} options={[{ value: 'baseline', label: 'Baseline (no changes)' }, ...data.scenarios.filter((s) => s.id !== draft.id).map((s) => ({ value: s.id, label: `Saved scenario: ${s.name}` }))]} />
          </Card>
          {!result ? (
            <Callout tone="error">Fix the change errors on the left to see the projection.</Callout>
          ) : result.error ? (
            <Callout tone="error">The projection could not be calculated: {result.error}</Callout>
          ) : (
            <Results data={data} result={result} draft={draft} otherName={other ? other.name : 'Baseline'} month={month} setMonth={setMonth} />
          )}
        </div>
      </div>
      {changeEditor && <ChangeModal initial={changeEditor} onClose={() => setChangeEditor(null)} onSave={(c) => { const idx = changeEditor._index; setD({ changes: idx === undefined ? [...draft.changes, { ...c, id: `chg-draft-${(draftSeq += 1)}` }] : draft.changes.map((x, j) => (j === idx ? { ...c, id: x.id } : x)) }); setChangeEditor(null); }} />}
    </>
  );
}

function payoffText(date, status) {
  if (status === 'paid_off') return formatDate(date);
  if (status === 'cleared_then_recharged') return `${formatDate(date)} (new charges since)`;
  if (status === 'no_balance') return 'Nothing owed';
  if (status === 'payment_below_interest') return 'Never (payment below interest)';
  return 'Not within horizon';
}

function Delta({ d, goodWhen = 'up', money = true }) {
  if (d.diff === 0) return <span className="muted">no difference</span>;
  const good = goodWhen === 'up' ? d.diff > 0 : d.diff < 0;
  return (
    <span className={`amt ${good ? 'pos' : 'neg'}`}>
      {money ? formatMoney(d.diff, { signed: true }) : d.diff}
      {d.pct !== null && ` (${d.pct > 0 ? '+' : ''}${d.pct}%)`}
    </span>
  );
}

function Results({ data, result, draft, otherName, month, setMonth }) {
  const { a, b, cmp } = result;
  const t = cmp.totals;
  const labels = ['Start', ...b.months.map(formatMonthShort)];
  const sel = month || b.months[0];
  const evB = b.events.filter((e) => e.month === sel);
  const evA = a.events.filter((e) => e.month === sel);
  const mi = b.months.indexOf(sel);
  const accountName = (id) => data.accounts.find((x) => x.id === id)?.name || id;
  const changeLabel = (id) => (id ? draft.changes.find((c) => c.id === id)?.title || draft.changes.find((c) => c.id === id)?.label || 'scenario change' : null);
  return (
    <>
      {cmp.identical ? <Callout tone="success" role="status"><strong>No differences.</strong> This scenario and {otherName} produce identical projections: same balances every month, same totals, same debt payoff dates and goals.</Callout> : <Callout tone="info">Differences begin in <strong>{cmp.firstDivergence ? formatMonth(cmp.firstDivergence) : 'the first month'}</strong>. Green is better for you, red is worse.</Callout>}
      <div className="grid cols-3">
        <Card><Stat label="Net worth at the end" value={<Money cents={b.totals.endNetWorthCents} />} sub={<>vs {otherName}: <Money cents={a.totals.endNetWorthCents} tone="none" /> · <Delta d={t.endNetWorthCents} /></>} info="Assets minus amounts owed at the end of the horizon, from the projected balance of every account." /></Card>
        <Card><Stat label="Cash & savings at the end" value={<Money cents={b.totals.endLiquidCents} />} sub={<>vs <Money cents={a.totals.endLiquidCents} tone="none" /> · <Delta d={t.endLiquidCents} /></>} /></Card>
        <Card><Stat label="Debt remaining at the end" value={<Money cents={b.totals.endDebtCents} tone="none" />} sub={<>vs <Money cents={a.totals.endDebtCents} tone="none" /> · <Delta d={t.endDebtCents} goodWhen="down" /></>} /></Card>
        <Card><Stat label="Total income" value={<Money cents={b.totals.incomeCents} tone="none" />} sub={<>vs <Money cents={a.totals.incomeCents} tone="none" /> · <Delta d={t.incomeCents} /></>} /></Card>
        <Card><Stat label="Total expenses" value={<Money cents={b.totals.expensesCents} tone="none" />} sub={<>vs <Money cents={a.totals.expensesCents} tone="none" /> · <Delta d={t.expensesCents} goodWhen="down" /></>} /></Card>
        <Card><Stat label="Interest paid on debts" value={<Money cents={b.totals.interestPaidCents} tone="none" />} sub={<>vs <Money cents={a.totals.interestPaidCents} tone="none" /> · <Delta d={t.interestPaidCents} goodWhen="down" /></>} /></Card>
      </div>
      <Boundary name="Net worth projection">
        <Card title="Projected net worth">
          <LineChart title="" labels={labels} series={[{ name: otherName, values: [a.start.netWorthCents, ...a.monthly.map((m) => m.netWorthCents)] }, { name: draft.name || 'Scenario', values: [b.start.netWorthCents, ...b.monthly.map((m) => m.netWorthCents)] }]} />
          <p className="small muted">Projection, not a promise: it assumes the recurring items, estimated everyday spending and debt payments shown below. Investments are held flat unless you set a growth assumption.</p>
        </Card>
      </Boundary>
      {(b.warnings.length > 0 || a.warnings.length > 0) && (
        <Callout tone="warn">
          <strong>Heads up:</strong>
          <ul>{[...new Map([...a.warnings.map((w) => [`a${w.accountId}`, `${otherName}: ${w.message}`]), ...b.warnings.map((w) => [`b${w.accountId}`, `This scenario: ${w.message}`])]).values()].map((m, i) => <li key={i}>{m}</li>)}</ul>
          Negative cash is allowed in a projection (it behaves like an overdraft) so you can see the problem.
        </Callout>
      )}
      <Card title="When and why the projections diverge">
        {cmp.identical ? <p className="muted small">They never diverge.</p> : (
          <DataTable
            caption="Divergence timeline"
            rows={cmp.timeline.filter((r) => r.changeInDiffCents !== 0 || r.causes.length)}
            rowKey={(r) => r.month}
            columns={[
              { key: 'm', header: 'Month', main: true, render: (r) => <button type="button" className="btn ghost small" style={{ padding: 0, minHeight: 0 }} onClick={() => setMonth(r.month)}>{formatMonth(r.month)}</button> },
              { key: 'd', header: 'Net worth difference', className: 'num', render: (r) => <Money cents={r.netWorthDiffCents} signed /> },
              { key: 'c', header: 'Change this month', className: 'num', render: (r) => <Money cents={r.changeInDiffCents} signed /> },
              { key: 'w', header: 'Why', render: (r) => (r.causes.length ? r.causes.map((c) => `${c.label}${c.count > 1 ? ` ×${c.count}` : ''} (${formatMoney(c.amountCents, { signed: true })})`).join('; ') : r.knockOn ? <span className="muted">Knock-on effect of earlier changes (interest, balances)</span> : '-') },
            ]}
          />
        )}
      </Card>
      <Card title="Debts: payoff and interest">
        <DataTable
          caption="Debt outcomes"
          rows={cmp.debts}
          rowKey={(d) => d.accountId}
          columns={[
            { key: 'n', header: 'Debt', main: true, render: (d) => d.name },
            { key: 'a', header: otherName, render: (d) => payoffText(d.aPayoffDate, d.aStatus) },
            { key: 'b', header: 'This scenario', render: (d) => payoffText(d.bPayoffDate, d.bStatus) },
            { key: 'e', header: 'Payoff timing', render: (d) => (d.monthsEarlier === null ? (d.payoffChanged ? 'Changed' : 'No difference') : d.monthsEarlier === 0 ? 'No difference' : `${Math.abs(d.monthsEarlier)} month${Math.abs(d.monthsEarlier) === 1 ? '' : 's'} ${d.monthsEarlier > 0 ? 'sooner' : 'later'}`) },
            { key: 'i', header: 'Interest in horizon', className: 'num', render: (d) => (<>{formatMoney(d.interest.other)} <span className="small"><Delta d={d.interest} goodWhen="down" /></span></>) },
            { key: 'o', header: 'Owed at the end', className: 'num', render: (d) => (<>{formatMoney(d.endOwed.other)} <span className="small"><Delta d={d.endOwed} goodWhen="down" /></span></>) },
          ]}
        />
        <p className="small muted">Payoff dates are model projections, not lender quotes. "Not within horizon" means the balance remains at the end of the projection length you chose.</p>
      </Card>
      {cmp.goals.length > 0 && (
        <Card title="Savings goals">
          <DataTable caption="Goal outcomes" rows={cmp.goals} rowKey={(g) => g.goalId} columns={[
            { key: 'n', header: 'Goal', main: true, render: (g) => g.name },
            { key: 'a', header: otherName, className: 'num', render: (g) => `${formatMoney(g.end.base)}${g.aReached ? ` · reached ${formatMonth(g.aReached)}` : ''}` },
            { key: 'b', header: 'This scenario', className: 'num', render: (g) => `${formatMoney(g.end.other)}${g.bReached ? ` · reached ${formatMonth(g.bReached)}` : ''}` },
            { key: 'd', header: 'Difference', className: 'num', render: (g) => <Delta d={g.end} /> },
          ]} />
        </Card>
      )}
      <Card title="Month-by-month values">
        <DataTable
          caption="Projected month-by-month values for this scenario"
          rows={b.monthly}
          rowKey={(m) => m.month}
          columns={[
            { key: 'm', header: 'Month', main: true, render: (m) => <button type="button" className="btn ghost small" style={{ padding: 0, minHeight: 0 }} onClick={() => setMonth(m.month)} aria-pressed={m.month === sel}>{formatMonth(m.month)}</button> },
            { key: 'i', header: 'Income', className: 'num', render: (m) => formatMoney(m.incomeCents + m.interestEarnedCents) },
            { key: 'e', header: 'Expenses', className: 'num', render: (m) => formatMoney(m.expensesCents) },
            { key: 'int', header: 'Debt interest', className: 'num', render: (m) => formatMoney(m.interestPaidCents) },
            { key: 'g', header: 'Market growth', className: 'num', render: (m) => formatMoney(m.growthCents) },
            { key: 'n', header: 'Net worth', className: 'num', render: (m) => <Money cents={m.netWorthCents} tone="none" /> },
            { key: 'l', header: 'Cash & savings', className: 'num', render: (m) => <Money cents={m.liquidCents} /> },
            { key: 'd', header: 'Debt', className: 'num', render: (m) => formatMoney(m.debtCents) },
            { key: 'df', header: `vs ${otherName}`, className: 'num', render: (m) => <Money cents={m.netWorthCents - a.monthly[b.monthly.indexOf(m)].netWorthCents} signed /> },
          ]}
        />
        {sel && mi >= 0 && (
          <div style={{ marginTop: 12 }}>
            <h3>What happens in {formatMonth(sel)}</h3>
            <div className="kv small" style={{ marginBottom: 8 }}>
              {data.accounts.map((acc) => <><span key={`n${acc.id}`}>{acc.name} (end of month)</span><Money key={`v${acc.id}`} cents={b.monthly[mi].balances.get(acc.id) || 0} tone="none" /></>)}
            </div>
            <DataTable
              caption={`Projected events in ${formatMonth(sel)}`}
              rows={evB.map((e, i) => ({ ...e, _i: i }))}
              rowKey={(e) => `${e.date}-${e._i}`}
              columns={[
                { key: 'd', header: 'Date', render: (e) => formatDate(e.date) },
                { key: 'l', header: 'Event', main: true, render: (e) => <span>{e.label} {e.changeId && <Badge tone="info">{changeLabel(e.changeId) || 'scenario'}</Badge>} {e.type === 'estimate' && <Badge>Estimate</Badge>}{e.type === 'debt_due' || e.kind === 'interest_paid' ? <Badge>Debt</Badge> : null}</span> },
                { key: 'w', header: 'Accounts', render: (e) => e.legs.map((l) => `${accountName(l.accountId)} ${formatMoney(l.cents, { signed: true })}`).join(' · ') },
                { key: 'n', header: 'Net worth effect', className: 'num', render: (e) => <Money cents={e.nwEffectCents} signed /> },
              ]}
              empty={<span className="muted">No events this month.</span>}
            />
            <p className="small muted">{evA.length} events in the same month for {otherName}. Order on a single day: income, then expenses, then transfers, then debt interest and payments, then month-end interest and growth.</p>
          </div>
        )}
      </Card>
      <Explain summary="Assumptions and limitations">
        <ul>
          {b.notes.map((n, i) => <li key={i}>{n}</li>)}
          <li>The projection starts from each account's balance including pending items on {formatDate(b.asOfDate)}; future-dated ledger entries are included as events.</li>
          <li>Recurring items already matched to a transaction are not counted twice. Paused items and skipped occurrences are ignored. Business-day adjustments follow each rule.</li>
          <li>Debt interest is charged on each due date as balance × APR ÷ 12 (rounded to the cent) before that month's payment; payments never exceed what is owed. Interest is charged to cards and loans and shows as an expense.</li>
          <li>Credit cards are paid from their pay-from account (or the primary checking) according to their payment mode. New card purchases other than recurring items are modeled as everyday spending from checking.</li>
          <li>Scenarios cannot post transactions. To act on a plan, record real transactions or recurring items yourself - committing a scenario to the ledger is not supported.</li>
        </ul>
      </Explain>
    </>
  );
}

function ChangeModal({ initial, onClose, onSave }) {
  const data = useData();
  const [f, setF] = useState(() => ({
    type: initial.type || 'one_time',
    title: initial.title || initial.label || '',
    effectiveDate: initial.effectiveDate || data.settings.asOfDate,
    endDate: initial.endDate || '',
    date: initial.date || data.settings.asOfDate,
    mode: initial.mode || (initial.type === 'debt_payment' ? 'extra' : 'amount'),
    amount: initial.amountCents !== null && initial.amountCents !== undefined ? centsToDecimalString(Math.abs(initial.amountCents)) : '',
    sign: initial.amountCents < 0 ? 'minus' : 'plus',
    percent: initial.percentBps ? String(initial.percentBps / 100) : '',
    accountId: initial.accountId || data.accounts.find((a) => a.type === 'checking' && a.status === 'active')?.id || '',
    fromAccountId: initial.fromAccountId || data.accounts.find((a) => a.type === 'checking' && a.status === 'active')?.id || '',
    toAccountId: initial.toAccountId || data.accounts.find((a) => a.type === 'savings' && a.status === 'active')?.id || '',
    recurringId: initial.recurringId || '',
    kind: initial.kind || 'expense',
    interval: initial.interval || 'monthly',
    day: initial.day ? String(initial.day) : '',
  }));
  const [errors, setErrors] = useState([]);
  const set = (p) => setF((s) => ({ ...s, ...p }));
  const active = data.accounts.filter((a) => a.status === 'active');
  const accts = active.map((a) => ({ value: a.id, label: a.name }));
  const debts = active.filter((a) => isLiabilityType(a.type)).map((a) => ({ value: a.id, label: a.name }));
  const incomeRules = data.recurring.filter((r) => r.kind === 'income').map((r) => ({ value: r.id, label: r.title }));
  const anyRules = data.recurring.map((r) => ({ value: r.id, label: `${r.title} (${r.kind})` }));

  const submit = (e) => {
    e.preventDefault();
    const errs = [];
    const amt = f.amount ? parseMoney(f.amount, { allowNegative: false }) : { ok: true, cents: null };
    if (!amt.ok) errs.push(amt.error);
    let c = { enabled: initial.enabled !== false, type: f.type, label: '', title: f.title };
    if (f.type === 'income_change') {
      c = { ...c, effectiveDate: f.effectiveDate, mode: f.mode, recurringId: f.recurringId || null, label: 'Income change' };
      if (f.mode === 'percent') {
        const neg = f.percent.trim().startsWith('-');
        const p = parsePercentToBps(f.percent.replace('-', ''));
        if (!p.ok) errs.push(p.error);
        else c.percentBps = neg ? -p.bps : p.bps;
      } else c.amountCents = amt.cents === null ? null : (f.sign === 'minus' ? -amt.cents : amt.cents);
    } else if (f.type === 'recurring_add') c = { ...c, effectiveDate: f.effectiveDate, endDate: f.endDate || null, kind: f.kind, amountCents: amt.cents, accountId: f.accountId, interval: f.interval, label: f.title };
    else if (f.type === 'recurring_remove') c = { ...c, effectiveDate: f.effectiveDate, recurringId: f.recurringId || null, label: 'Stop recurring item' };
    else if (f.type === 'one_time') c = { ...c, date: f.date, accountId: f.accountId, amountCents: amt.cents === null ? null : f.sign === 'minus' ? -amt.cents : amt.cents, label: f.title };
    else if (f.type === 'savings_change') c = { ...c, effectiveDate: f.effectiveDate, fromAccountId: f.fromAccountId, toAccountId: f.toAccountId, amountCents: amt.cents === null ? null : f.sign === 'minus' ? -amt.cents : amt.cents, day: f.day ? Number(f.day) : null, label: f.title || 'Savings change' };
    else if (f.type === 'debt_payment') c = { ...c, effectiveDate: f.effectiveDate, endDate: f.endDate || null, mode: f.mode === 'set' ? 'set' : 'extra', accountId: f.accountId, amountCents: amt.cents, label: f.title || 'Debt payment change' };
    else if (f.type === 'debt_lump') c = { ...c, date: f.date, accountId: f.accountId, amountCents: amt.cents, label: f.title || 'Lump-sum payment' };
    if (!c.title) c.title = c.label;
    if (errs.length) return setErrors(errs.map((m) => ({ message: m })));
    const refs = { accounts: new Map(data.accounts.map((a) => [a.id, a])), recurring: new Map(data.recurring.map((r) => [r.id, r])) };
    const probs = validateChange({ id: 'tmp', ...c }, refs);
    if (probs.length) return setErrors(probs.map((m) => ({ message: m })));
    onSave(c);
    return undefined;
  };

  return (
    <Modal wide title={initial._index === undefined ? 'Add a change' : 'Edit change'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form="chg-form" className="btn primary">Save change</button></>}>
      <form id="chg-form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />
        <SelectField label="What kind of change?" value={f.type} onChange={(v) => set({ type: v, mode: v === 'debt_payment' ? 'extra' : 'amount' })} options={CHANGE_TYPE_IDS.map((t) => ({ value: t, label: CHANGE_TYPES[t].label }))} hint={CHANGE_TYPES[f.type]?.hint} />
        <div className="form-grid" style={{ marginTop: 12 }}>
          {f.type === 'income_change' && (<>
            <SelectField label="Which income" value={f.recurringId} onChange={(v) => set({ recurringId: v })} options={incomeRules} placeholder="All recurring income" />
            <TextField label="Effective date" type="date" value={f.effectiveDate} onChange={(v) => set({ effectiveDate: v })} />
            <SelectField label="Change by" value={f.mode} onChange={(v) => set({ mode: v })} options={[{ value: 'amount', label: 'A fixed amount per payment' }, { value: 'percent', label: 'A percentage of each payment' }]} />
            {f.mode === 'amount' ? (<><SelectField label="Direction" value={f.sign} onChange={(v) => set({ sign: v })} options={[{ value: 'plus', label: 'Raise' }, { value: 'minus', label: 'Cut' }]} /><MoneyField label="Amount per payment" value={f.amount} onChange={(v) => set({ amount: v })} /></>) : <TextField label="Percent (negative for a cut)" value={f.percent} onChange={(v) => set({ percent: v })} />}
          </>)}
          {f.type === 'recurring_add' && (<>
            <TextField label="Name" value={f.title} onChange={(v) => set({ title: v })} className="wide" />
            <SelectField label="Type" value={f.kind} onChange={(v) => set({ kind: v })} options={[{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }]} />
            <MoneyField label="Amount each time" value={f.amount} onChange={(v) => set({ amount: v })} />
            <SelectField label="Account" value={f.accountId} onChange={(v) => set({ accountId: v })} options={accts} />
            <SelectField label="Repeats" value={f.interval} onChange={(v) => set({ interval: v })} options={INTERVALS.map((i) => ({ value: i, label: i }))} />
            <TextField label="Starts" type="date" value={f.effectiveDate} onChange={(v) => set({ effectiveDate: v })} />
            <TextField label="Ends (optional)" type="date" value={f.endDate} onChange={(v) => set({ endDate: v })} />
          </>)}
          {f.type === 'recurring_remove' && (<>
            <SelectField label="Recurring item to stop" value={f.recurringId} onChange={(v) => set({ recurringId: v })} options={anyRules} placeholder="Choose" />
            <TextField label="Stops from" type="date" value={f.effectiveDate} onChange={(v) => set({ effectiveDate: v })} />
          </>)}
          {f.type === 'one_time' && (<>
            <TextField label="Name" value={f.title} onChange={(v) => set({ title: v })} className="wide" />
            <SelectField label="What is it" value={f.sign} onChange={(v) => set({ sign: v })} options={[{ value: 'minus', label: 'Expense (money out)' }, { value: 'plus', label: 'Windfall (money in)' }]} />
            <MoneyField label="Amount" value={f.amount} onChange={(v) => set({ amount: v })} />
            <TextField label="Date" type="date" value={f.date} onChange={(v) => set({ date: v })} />
            <SelectField label="Account" value={f.accountId} onChange={(v) => set({ accountId: v })} options={accts} />
          </>)}
          {f.type === 'savings_change' && (<>
            <TextField label="Name (optional)" value={f.title} onChange={(v) => set({ title: v })} className="wide" />
            <SelectField label="Move money from" value={f.fromAccountId} onChange={(v) => set({ fromAccountId: v })} options={accts} />
            <SelectField label="To" value={f.toAccountId} onChange={(v) => set({ toAccountId: v })} options={accts} />
            <SelectField label="Direction" value={f.sign} onChange={(v) => set({ sign: v })} options={[{ value: 'plus', label: 'Save more each month' }, { value: 'minus', label: 'Save less each month (reduces your existing transfer)' }]} />
            <MoneyField label="Amount per month" value={f.amount} onChange={(v) => set({ amount: v })} />
            <TextField label="Starting" type="date" value={f.effectiveDate} onChange={(v) => set({ effectiveDate: v })} />
            <TextField label="Day of month (optional)" type="number" min="1" max="31" value={f.day} onChange={(v) => set({ day: v })} />
          </>)}
          {f.type === 'debt_payment' && (<>
            <SelectField label="Loan or card" value={f.accountId} onChange={(v) => set({ accountId: v })} options={debts} placeholder="Choose" />
            <SelectField label="How" value={f.mode} onChange={(v) => set({ mode: v })} options={[{ value: 'extra', label: 'Pay an extra amount each month' }, { value: 'set', label: 'Set the regular monthly payment to' }]} />
            <MoneyField label="Amount per month" value={f.amount} onChange={(v) => set({ amount: v })} />
            <TextField label="Starting" type="date" value={f.effectiveDate} onChange={(v) => set({ effectiveDate: v })} />
            <TextField label="Until (optional)" type="date" value={f.endDate} onChange={(v) => set({ endDate: v })} />
          </>)}
          {f.type === 'debt_lump' && (<>
            <SelectField label="Loan or card" value={f.accountId} onChange={(v) => set({ accountId: v })} options={debts} placeholder="Choose" />
            <MoneyField label="Lump-sum amount" value={f.amount} onChange={(v) => set({ amount: v })} />
            <TextField label="Date" type="date" value={f.date} onChange={(v) => set({ date: v })} />
          </>)}
        </div>
      </form>
    </Modal>
  );
}
