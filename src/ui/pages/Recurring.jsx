import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useData, useRun } from '../../state/hooks.jsx';
import { buildIndex } from '../../domain/ledger.js';
import { upcomingOccurrences, occurrencesBetween, monthlyEquivalent, annualEquivalent, subscriptionSummary, suggestMatches, linkedOccurrences, ruleEffect } from '../../domain/recurring.js';
import { liquidityOutlook, upcomingObligations } from '../../domain/obligations.js';
import { saveRecurring, setRecurringActive, deleteRecurring, skipOccurrence, markOccurrencePaid, linkOccurrence } from '../../domain/ops/recurring.js';
import { formatDate, addDays, formatDateShort } from '../../domain/dates.js';
import { formatMoney, parseMoney, centsToDecimalString } from '../../domain/money.js';
import { INTERVALS, RECURRING_GROUPS, BUSINESS_DAY_MODES } from '../../domain/schema.js';
import { PageHead, Card, Stat, Badge, Callout, Explain, EmptyState, Tabs, TabPanel, Boundary } from '../components/Common.jsx';
import { Money } from '../components/Money.jsx';
import DataTable from '../components/DataTable.jsx';
import { Modal, useConfirm } from '../components/Modal.jsx';
import { CheckField, ErrorSummary, MoneyField, SelectField, TextField, TextAreaField, fieldErrors } from '../components/Form.jsx';
import { BarChart } from '../charts/Charts.jsx';

const INTERVAL_LABELS = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };
const GROUP_LABELS = { income: 'Income', bill: 'Bill', subscription: 'Subscription', transfer: 'Planned transfer', other: 'Other' };
const BD_LABELS = { none: 'Keep the scheduled date', next: 'Move weekend dates to the next business day', prev: 'Move weekend dates to the previous business day' };

export default function Recurring() {
  const data = useData();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'upcoming';
  const setTab = (t) => setParams({ tab: t }, { replace: true });
  const asOf = data.settings.asOfDate;
  const index = useMemo(() => buildIndex(data), [data]);
  const [editing, setEditing] = useState(null);
  const [linking, setLinking] = useState(null);
  const run = useRun();
  const confirm = useConfirm();
  const days = Number(params.get('days')) || 90;
  const upcoming = useMemo(() => upcomingOccurrences(data, asOf, days), [data, asOf, days]);
  const obligations = useMemo(() => upcomingObligations(data, asOf, days), [data, asOf, days]);
  const outlook = useMemo(() => liquidityOutlook(data, asOf, days), [data, asOf, days]);
  const subs = useMemo(() => subscriptionSummary(data), [data]);
  const links = useMemo(() => linkedOccurrences(data), [data]);
  const sorted = useMemo(() => [...data.recurring].sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title)), [data.recurring]);
  const byMonth = useMemo(() => {
    const m = new Map();
    for (const r of obligations) {
      const k = r.date.slice(0, 7);
      const e = m.get(k) || { out: 0, in: 0 };
      if (r.effectCents < 0) e.out += -r.effectCents;
      else e.in += r.effectCents;
      m.set(k, e);
    }
    return [...m.entries()].sort();
  }, [obligations]);

  return (
    <>
      <PageHead title="Recurring & bills" actions={<button type="button" className="btn primary" onClick={() => setEditing({})}>Add recurring item</button>}>
        Expected income, bills, subscriptions and planned transfers. A scheduled occurrence is never counted as spending until it is matched to (or recorded as) a real transaction.
      </PageHead>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Card><Stat label={`Cash outlook, next ${days} days (projected)`} value={<Money cents={outlook.endCents} />} sub={`from ${formatMoney(outlook.startCents)} today`} info="Spendable cash (checking + savings, pending included) after scheduled recurring items and loan/card payments. Everyday spending is not included." /></Card>
        <Card><Stat label="Lowest point" value={<Money cents={outlook.lowCents} />} sub={`on ${formatDate(outlook.lowDate)}`} /></Card>
        <Card><Stat label="Subscriptions per month" value={<Money cents={subs.monthlyCents} tone="none" />} sub={`${formatMoney(subs.annualCents)} per year across ${subs.items.length}`} /></Card>
        <Card><Stat label="Scheduled in the window" value={obligations.length} sub={`${formatMoney(-outlook.outflowCents)} out · ${formatMoney(outlook.inflowCents)} in (cash accounts)`} /></Card>
      </div>
      <Tabs label="Recurring sections" value={tab} onChange={setTab} tabs={[{ id: 'upcoming', label: 'Upcoming', badge: upcoming.length }, { id: 'rules', label: 'All rules', badge: data.recurring.length }, { id: 'subs', label: 'Subscriptions', badge: subs.items.length }]} />
      <TabPanel id="upcoming" value={tab}>
        <Boundary name="Upcoming">
          <Card title={`Next ${days} days`} actions={<SelectField label="Window" value={String(days)} onChange={(v) => setParams({ tab: 'upcoming', days: v }, { replace: true })} options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '180', label: '180 days' }, { value: '365', label: '12 months' }]} />}>
            {obligations.length === 0 ? (
              <EmptyState title="Nothing scheduled">Add recurring items to see upcoming obligations.</EmptyState>
            ) : (
              <DataTable
                caption="Upcoming obligations"
                rows={obligations}
                rowKey={(r) => `${r.kind}|${r.label}|${r.date}`}
                columns={[
                  { key: 'date', header: 'Due', className: 'nowrap', render: (r) => (<>{formatDate(r.date)}{r.date !== r.scheduled && <div className="tiny muted">scheduled {formatDateShort(r.scheduled)}</div>}</>) },
                  { key: 'what', header: 'Item', main: true, render: (r) => (<div className="desc-cell"><div className="title">{r.label}</div><div className="sub">{r.kind === 'debt' ? 'Loan / card payment (estimate)' : `${GROUP_LABELS[r.rule.group]} · ${INTERVAL_LABELS[r.rule.interval]} · ${index.accountsById.get(r.accountId)?.name}`}</div>{r.status === 'overdue' && <Badge tone="neg">Overdue - not matched yet</Badge>}{r.status === 'due_today' && <Badge tone="warn">Due today</Badge>}</div>) },
                  { key: 'amt', header: 'Amount', className: 'num', render: (r) => <Money cents={r.effectCents} signed /> },
                  { key: 'cum', header: 'Cash after', className: 'num', render: (r) => <Money cents={outlook.startCents + r.cumulativeCashCents} tone="none" /> },
                  { key: 'act', header: 'Actions', render: (r) => (r.kind === 'debt' ? <Link className="btn small" to="/goals/debt">Debt plan</Link> : (<span className="row"><button type="button" className="btn small primary" onClick={() => run((d) => markOccurrencePaid(d, r.rule.id, r.scheduled), { label: `mark ${r.rule.title} paid`, success: `${r.rule.title} recorded`, undo: true })}>Mark {r.rule.kind === 'income' ? 'received' : 'paid'}</button><button type="button" className="btn small" onClick={() => setLinking({ rule: r.rule, occurrence: r })}>Link existing</button><button type="button" className="btn small" onClick={() => run((d) => skipOccurrence(d, r.rule.id, r.scheduled), { label: 'skip occurrence', success: 'Occurrence skipped', undo: true })}>Skip</button></span>)) },
                ]}
              />
            )}
            <p className="small muted" style={{ marginTop: 8 }}>Marking an item paid creates the real transaction and links it, so the occurrence leaves this list and is counted once. "Cash after" is a running estimate over cash accounts only.</p>
          </Card>
          {byMonth.length > 1 && (
            <Card title="Scheduled cash by month" className="" style={{ marginTop: 16 }}>
              <BarChart title="" labels={byMonth.map(([m]) => m)} series={[{ name: 'Scheduled out', values: byMonth.map(([, v]) => v.out) }, { name: 'Scheduled in', values: byMonth.map(([, v]) => v.in) }]} />
            </Card>
          )}
        </Boundary>
      </TabPanel>
      <TabPanel id="rules" value={tab}>
        <Card title="All recurring rules">
          {sorted.length === 0 ? <EmptyState title="No recurring items" action={<button type="button" className="btn primary" onClick={() => setEditing({})}>Add one</button>}>Bills, paychecks and subscriptions go here.</EmptyState> : (
            <DataTable
              caption="Recurring rules"
              rows={sorted}
              rowKey={(r) => r.id}
              rowClass={(r) => (r.active ? '' : 'muted')}
              columns={[
                { key: 'title', header: 'Item', main: true, render: (r) => (<div className="desc-cell"><div className="title">{r.title}</div><div className="sub">{GROUP_LABELS[r.group]} · {INTERVAL_LABELS[r.interval]} from {formatDate(r.startDate)}{r.endDate ? ` to ${formatDate(r.endDate)}` : ''} · {index.accountsById.get(r.accountId)?.name}{r.kind === 'transfer' ? ` → ${index.accountsById.get(r.toAccountId)?.name}` : ''}</div>{!r.active && <Badge>Paused</Badge>}</div>) },
                { key: 'amt', header: 'Amount', className: 'num', render: (r) => <Money cents={r.kind === 'transfer' ? r.amountCents : ruleEffect(r)} signed={r.kind !== 'transfer'} /> },
                { key: 'mon', header: 'Per month', className: 'num', render: (r) => formatMoney(monthlyEquivalent(r)) },
                { key: 'next', header: 'Next due', render: (r) => { const n = occurrencesBetween(r, asOf, addDays(asOf, 800)).find((o) => !r.skipped.includes(o.scheduled) && !links.get(r.id)?.has(o.scheduled)); return n ? formatDate(n.date) : <span className="muted">none</span>; } },
                { key: 'act', header: 'Actions', render: (r) => (<span className="row"><button type="button" className="btn small" onClick={() => setEditing(r)}>Edit</button><button type="button" className="btn small" onClick={() => run((d) => setRecurringActive(d, r.id, !r.active), { label: r.active ? 'pause recurring' : 'resume recurring', success: r.active ? 'Paused' : 'Resumed', undo: true })}>{r.active ? 'Pause' : 'Resume'}</button><button type="button" className="btn small danger" onClick={async () => { if (await confirm({ title: `Delete "${r.title}"?`, danger: true, confirmLabel: 'Delete', message: 'Past transactions that were matched to it keep their amounts but lose the link. You can undo right after.' })) run((d) => deleteRecurring(d, r.id), { label: 'delete recurring', success: 'Deleted', undo: true }); }}>Delete</button></span>) },
              ]}
            />
          )}
        </Card>
        <div style={{ marginTop: 16 }}>
          <Explain summary="How dates work (month ends and weekends)">
            <p>A monthly item keeps its <strong>start day</strong> and uses the last day of shorter months: an item starting January 31 falls on Feb 28 (29 in a leap year), then Mar 31, Apr 30, May 31... Yearly items starting Feb 29 use Feb 28 in other years. Quarterly items move three months at a time the same way. Optionally, weekend due dates can move to the next or previous business day (Mon-Fri; there is no holiday calendar). The original scheduled date stays the item's identity, so matching a transaction never double counts.</p>
          </Explain>
        </div>
      </TabPanel>
      <TabPanel id="subs" value={tab}>
        <Card title="Subscriptions">
          <p className="small muted">Active recurring items in the "Subscription" group. Equivalents are exact: weekly × 52, every 2 weeks × 26, monthly × 12, quarterly × 4, yearly × 1, then ÷ 12 for the monthly figure.</p>
          {subs.items.length === 0 ? <EmptyState title="No subscriptions">Set an item's group to Subscription.</EmptyState> : (
            <DataTable
              caption="Subscriptions"
              rows={subs.items}
              rowKey={(r) => r.id}
              footer={<tfoot><tr><td colSpan={2}>Total</td><td className="num">{formatMoney(subs.monthlyCents)}/mo</td><td className="num">{formatMoney(subs.annualCents)}/yr</td></tr></tfoot>}
              columns={[
                { key: 't', header: 'Subscription', main: true, render: (r) => r.title },
                { key: 'i', header: 'Billed', render: (r) => `${formatMoney(r.amountCents)} ${INTERVAL_LABELS[r.interval].toLowerCase()}` },
                { key: 'm', header: 'Monthly equivalent', className: 'num', render: (r) => formatMoney(monthlyEquivalent(r)) },
                { key: 'a', header: 'Annual equivalent', className: 'num', render: (r) => formatMoney(annualEquivalent(r)) },
              ]}
            />
          )}
        </Card>
      </TabPanel>
      {editing && <RuleModal rule={editing} onClose={() => setEditing(null)} />}
      {linking && <LinkModal state={linking} onClose={() => setLinking(null)} />}
      {void Callout}
    </>
  );
}

function RuleModal({ rule, onClose }) {
  const data = useData();
  const run = useRun();
  const [f, setF] = useState({
    title: rule.title || '',
    kind: rule.kind || 'expense',
    amount: rule.amountCents ? centsToDecimalString(rule.amountCents) : '',
    accountId: rule.accountId || data.accounts.find((a) => a.status === 'active')?.id || '',
    toAccountId: rule.toAccountId || '',
    categoryId: rule.categoryId || '',
    merchant: rule.merchant || '',
    startDate: rule.startDate || data.settings.asOfDate,
    endDate: rule.endDate || '',
    interval: rule.interval || 'monthly',
    group: rule.group || 'bill',
    businessDay: rule.businessDay || 'none',
    active: rule.active !== false,
    notes: rule.notes || '',
  });
  const [errors, setErrors] = useState([]);
  const fe = fieldErrors(errors);
  const set = (p) => setF((s) => ({ ...s, ...p }));
  const cats = data.categories.filter((c) => c.kind === (f.kind === 'income' ? 'income' : 'expense')).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: c.name }));
  const accts = data.accounts.filter((a) => a.status === 'active').map((a) => ({ value: a.id, label: a.name }));
  const preview = useMemo(() => {
    const a = parseMoney(f.amount || '0', { allowNegative: false });
    if (!f.startDate || !a.ok) return [];
    try {
      return occurrencesBetween({ id: 'x', startDate: f.startDate, interval: f.interval, endDate: f.endDate || null, businessDay: f.businessDay }, f.startDate, addDays(f.startDate, 730)).slice(0, 6);
    } catch {
      return [];
    }
  }, [f.amount, f.startDate, f.interval, f.endDate, f.businessDay]);
  const submit = (e) => {
    e.preventDefault();
    const a = parseMoney(f.amount, { allowNegative: false });
    if (!a.ok) return setErrors([{ field: 'amountCents', message: a.error }]);
    const r = run((d) => saveRecurring(d, { id: rule.id, ...f, amountCents: a.cents, categoryId: f.categoryId || null, endDate: f.endDate || null }), { label: rule.id ? 'edit recurring' : 'add recurring', success: 'Recurring item saved', failTitle: 'Not saved', undo: true });
    if (r.ok) onClose();
    else setErrors(r.errors);
    return undefined;
  };
  return (
    <Modal wide title={rule.id ? 'Edit recurring item' : 'Add recurring item'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form="rec-form" className="btn primary">Save</button></>}>
      <form id="rec-form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />
        <div className="form-grid">
          <TextField label="Title" value={f.title} onChange={(v) => set({ title: v })} error={fe.title} className="wide" />
          <SelectField label="Type" value={f.kind} onChange={(v) => set({ kind: v, categoryId: '', group: v === 'income' ? 'income' : v === 'transfer' ? 'transfer' : f.group === 'income' || f.group === 'transfer' ? 'bill' : f.group })} options={[{ value: 'expense', label: 'Expense (bill / subscription)' }, { value: 'income', label: 'Income' }, { value: 'transfer', label: 'Transfer between accounts' }]} />
          <MoneyField label="Amount each time" value={f.amount} onChange={(v) => set({ amount: v })} error={fe.amountCents} />
          <SelectField label={f.kind === 'transfer' ? 'From account' : 'Account'} value={f.accountId} onChange={(v) => set({ accountId: v })} options={accts} error={fe.accountId} />
          {f.kind === 'transfer' && <SelectField label="To account" value={f.toAccountId} onChange={(v) => set({ toAccountId: v })} options={accts} placeholder="Choose" error={fe.toAccountId} />}
          {f.kind !== 'transfer' && <SelectField label="Category" value={f.categoryId} onChange={(v) => set({ categoryId: v })} options={cats} placeholder="Uncategorized" error={fe.categoryId} />}
          {f.kind !== 'transfer' && <TextField label="Merchant (optional)" value={f.merchant} onChange={(v) => set({ merchant: v })} />}
          <SelectField label="Repeats" value={f.interval} onChange={(v) => set({ interval: v })} options={INTERVALS.map((i) => ({ value: i, label: INTERVAL_LABELS[i] }))} error={fe.interval} />
          <TextField label="First date" type="date" value={f.startDate} onChange={(v) => set({ startDate: v })} error={fe.startDate} />
          <TextField label="End date (optional)" type="date" value={f.endDate} onChange={(v) => set({ endDate: v })} error={fe.endDate} />
          <SelectField label="Group" value={f.group} onChange={(v) => set({ group: v })} options={RECURRING_GROUPS.map((g) => ({ value: g, label: GROUP_LABELS[g] }))} />
          <SelectField label="Weekend due dates" value={f.businessDay} onChange={(v) => set({ businessDay: v })} options={BUSINESS_DAY_MODES.map((b) => ({ value: b, label: BD_LABELS[b] }))} />
          <CheckField label="Active (uncheck to pause)" checked={f.active} onChange={(v) => set({ active: v })} />
          <TextAreaField label="Notes" value={f.notes} onChange={(v) => set({ notes: v })} rows={2} className="wide" />
        </div>
        {preview.length > 0 && <p className="small" aria-live="polite"><strong>Next dates:</strong> {preview.map((p) => formatDate(p.date)).join(' · ')}</p>}
      </form>
    </Modal>
  );
}

function LinkModal({ state, onClose }) {
  const data = useData();
  const run = useRun();
  const { rule, occurrence } = state;
  const matches = suggestMatches(data, rule, occurrence).slice(0, 8);
  return (
    <Modal title={`Link a transaction to ${rule.title}`} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <p>Occurrence due {formatDate(occurrence.date)} for {formatMoney(rule.amountCents)}. Linking an existing transaction does not create new money - the occurrence is simply counted as paid.</p>
      {matches.length === 0 ? <Callout tone="info">No unlinked transactions look like a match (same account and direction, within a few days, similar amount). Use "Mark paid" to create it.</Callout> : (
        <ul className="list-plain">
          {matches.map((m) => (
            <li key={m.tx.id}>
              <span>{formatDate(m.tx.date)} · {m.tx.description} · <Money cents={m.tx.amountCents} signed /></span>
              <button type="button" className="btn small primary" onClick={() => { const r = run((d) => linkOccurrence(d, m.tx.id, rule.id, occurrence.scheduled), { label: 'link occurrence', success: 'Linked', undo: true }); if (r.ok) onClose(); }}>Link</button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
