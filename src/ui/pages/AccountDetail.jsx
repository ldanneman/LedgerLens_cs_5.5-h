import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useData, useRun } from '../../state/hooks.jsx';
import { buildIndex, accountPosition, runningLedger, balanceSeries, isLiabilityType, utilization, counterpartLeg } from '../../domain/ledger.js';
import { reconciliationHealth, reconciledTxIds, lastReconciliation } from '../../domain/reconciliation.js';
import { archiveAccount, unarchiveAccount, deleteAccount, accountReferences } from '../../domain/ops/accounts.js';
import { deleteTransactions, reverseTransaction } from '../../domain/ops/transactions.js';
import { monthEndDates } from '../../domain/reports.js';
import { monthKey, formatDate, formatMonthShort } from '../../domain/dates.js';
import { formatMoney, formatBps } from '../../domain/money.js';
import { PageHead, Card, Stat, Badge, Tabs, TabPanel, EmptyState, Pager, Menu, Explain } from '../components/Common.jsx';
import { Money, Owed } from '../components/Money.jsx';
import DataTable from '../components/DataTable.jsx';
import { SelectField, TextField } from '../components/Form.jsx';
import { LineChart } from '../charts/Charts.jsx';
import { TxBadges, categoryLabel, AccountLink } from '../TxParts.jsx';
import { useEditors } from '../modals/Editors.jsx';
import { useConfirm } from '../components/Modal.jsx';
import { accountTypeLabel, txTypeLabel } from '../format.js';

export default function AccountDetail() {
  const { accountId } = useParams();
  const data = useData();
  const index = useMemo(() => buildIndex(data), [data]);
  const acct = index.accountsById.get(accountId);
  if (!acct) {
    return (
      <>
        <PageHead title="Account not found">That account does not exist (it may have been deleted).</PageHead>
        <Link className="btn" to="/accounts">Back to accounts</Link>
      </>
    );
  }
  return <Detail acct={acct} data={data} index={index} />;
}

function Detail({ acct, data, index }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'activity';
  const setTab = (t) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', t); return n; }, { replace: true });
  const editors = useEditors();
  const run = useRun();
  const confirm = useConfirm();
  const nav = useNavigate();
  const asOf = data.settings.asOfDate;
  const liability = isLiabilityType(acct.type);
  const pos = accountPosition(index, acct.id, asOf);
  const last = lastReconciliation(data, acct.id);
  const reconciled = useMemo(() => reconciledTxIds(data), [data]);
  const recurringById = useMemo(() => new Map(data.recurring.map((r) => [r.id, r])), [data.recurring]);
  const dates = useMemo(() => monthEndDates(monthKey(asOf), 13).map((d) => (d > asOf ? asOf : d)), [asOf]);
  const series = useMemo(() => balanceSeries(index, dates, false).get(acct.id) || [], [index, dates, acct.id]);
  const inclSeries = useMemo(() => balanceSeries(index, dates, true).get(acct.id) || [], [index, dates, acct.id]);
  const refs = accountReferences(data, acct.id);
  const util = utilization(acct, pos.postedCents);
  const recs = data.reconciliations.filter((r) => r.accountId === acct.id).sort((a, b) => (a.endDate < b.endDate ? 1 : -1));
  const transfers = useMemo(() => {
    const out = [];
    for (const t of index.txByAccount.get(acct.id) || []) {
      if (t.kind !== 'transfer') continue;
      const other = counterpartLeg(index, t);
      out.push({ tx: t, other });
    }
    return out.reverse();
  }, [index, acct.id]);

  return (
    <>
      <PageHead
        title={acct.name}
        actions={
          <>
            <button type="button" className="btn primary" disabled={acct.status === 'archived'} onClick={() => editors.openTransaction({ defaults: { accountId: acct.id } })}>Add transaction</button>
            <button type="button" className="btn" disabled={acct.status === 'archived'} onClick={() => editors.openTransfer({ defaults: liability ? { to: acct.id } : { from: acct.id } })}>{liability ? 'Make a payment' : 'Transfer funds'}</button>
            <Link className="btn" to={`/import/reconcile?acct=${encodeURIComponent(acct.id)}`}>Reconcile</Link>
            <button type="button" className="btn" onClick={() => editors.openAccount({ id: acct.id })}>Edit account</button>
          </>
        }
      >
        {acct.institution || 'No institution'} · {accountTypeLabel(acct.type)}
        {acct.last4 ? ` · ...${acct.last4}` : ''} {acct.status === 'archived' && <Badge>Archived {acct.archivedDate ? formatDate(acct.archivedDate) : ''}</Badge>}
      </PageHead>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Card>
          <Stat label={liability ? 'Amount owed (posted)' : 'Balance (posted)'} value={liability ? <Owed contributionCents={pos.postedCents} /> : <Money cents={pos.postedCents} />} sub={`Net-worth contribution: ${formatMoney(pos.postedCents)}`} info={liability ? 'For a liability the contribution to net worth is negative: a purchase makes it more negative, a payment makes it less negative.' : 'The posted balance is opening balance plus every posted transaction through the as-of date.'} />
        </Card>
        <Card>
          <Stat label="With pending items" value={liability ? <Owed contributionCents={pos.availableCents} /> : <Money cents={pos.availableCents} />} sub={pos.pendingCount ? `${pos.pendingCount} pending: ${formatMoney(pos.pendingCents, { signed: true })}` : 'No pending items'} info="Available/pending-inclusive = posted balance plus pending transactions. Pending items are not part of the statement (posted) balance." />
        </Card>
        <Card>
          <Stat label="Opening" value={<Money cents={acct.openingCents} />} sub={`on ${formatDate(acct.openingDate)}`} />
        </Card>
        <Card>
          <Stat label={liability ? 'Terms' : 'Reconciliation'} value={liability ? (acct.aprBps ? `${formatBps(acct.aprBps)} APR` : '0% APR') : last ? formatDate(last.endDate) : 'Never'} sub={liability ? [acct.creditLimitCents ? `limit ${formatMoney(acct.creditLimitCents)}${util !== null ? ` (${util}% used)` : ''}` : null, acct.scheduledPaymentCents && acct.paymentMode === 'fixed' ? `payment ${formatMoney(acct.scheduledPaymentCents)}/mo` : acct.paymentMode === 'pay_in_full' ? 'pays in full' : null].filter(Boolean).join(' · ') : last ? 'last completed statement' : 'No completed statement yet'} />
        </Card>
      </div>

      <Card title="Balance trend (posted, month ends)" className="" style={{ marginBottom: 16 }}>
        <LineChart title="" labels={dates.map((d) => formatMonthShort(monthKey(d)))} series={[{ name: liability ? 'Net-worth contribution (negative = owed)' : 'Balance', values: series }, ...(pos.pendingCount ? [{ name: 'Including pending', values: inclSeries }] : [])]} />
      </Card>

      <Tabs
        label="Account sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'activity', label: 'Activity' },
          { id: 'transfers', label: 'Transfers & payments', badge: transfers.length },
          { id: 'reconciliation', label: 'Reconciliation', badge: recs.length },
          { id: 'details', label: 'Details & lifecycle' },
        ]}
      />
      <TabPanel id="activity" value={tab}>
        <Activity acct={acct} index={index} reconciled={reconciled} recurringById={recurringById} />
      </TabPanel>
      <TabPanel id="transfers" value={tab}>
        <Card title="Transfers, card payments and loan payments">
          {transfers.length === 0 ? (
            <EmptyState title="No transfers yet">Transfers and payments involving this account appear here.</EmptyState>
          ) : (
            <DataTable
              caption="Transfers involving this account"
              rows={transfers}
              rowKey={(r) => r.tx.id}
              columns={[
                { key: 'date', header: 'Date', render: (r) => formatDate(r.tx.date) },
                { key: 'dir', header: 'Direction', render: (r) => (r.tx.amountCents < 0 ? 'Out to' : 'In from') },
                { key: 'other', header: 'Other account', main: true, render: (r) => (r.other ? <AccountLink account={index.accountsById.get(r.other.accountId)} /> : <span>{index.transfersById.get(r.tx.transferId)?.counterparty || 'Outside account'} (outside)</span>) },
                { key: 'amt', header: 'Amount', className: 'num', render: (r) => <Money cents={r.tx.amountCents} signed /> },
                { key: 'st', header: 'Status', render: (r) => (r.tx.status === 'pending' ? <Badge tone="warn">Pending</Badge> : <Badge>Posted</Badge>) },
                { key: 'act', header: '', render: (r) => <button type="button" className="btn small" onClick={() => editors.openTransfer({ transferId: r.tx.transferId })}>Edit</button> },
              ]}
            />
          )}
        </Card>
      </TabPanel>
      <TabPanel id="reconciliation" value={tab}>
        <Card title="Reconciliation history" actions={<Link className="btn small primary" to={`/import/reconcile?acct=${encodeURIComponent(acct.id)}`}>Start / continue reconciling</Link>}>
          {recs.length === 0 ? (
            <EmptyState title="No reconciliations">Compare this account to a statement to confirm every transaction.</EmptyState>
          ) : (
            <DataTable
              caption="Reconciliations for this account"
              rows={recs}
              rowKey={(r) => r.id}
              columns={[
                { key: 'period', header: 'Statement', main: true, render: (r) => <Link to={`/import/reconcile?acct=${encodeURIComponent(acct.id)}&rec=${encodeURIComponent(r.id)}`}>{formatDate(r.startDate)} to {formatDate(r.endDate)}</Link> },
                { key: 'close', header: 'Closing', className: 'num', render: (r) => <Money cents={r.closingCents} /> },
                { key: 'disc', header: 'Discrepancy', className: 'num', render: (r) => <Money cents={r.discrepancyCents ?? 0} signed /> },
                {
                  key: 'status',
                  header: 'Status',
                  render: (r) => {
                    if (r.status !== 'completed') return <Badge tone="warn">In progress</Badge>;
                    const h = reconciliationHealth(data, r);
                    return h.valid ? <Badge tone="pos">Completed</Badge> : <Badge tone="neg" title={h.problems.map((p) => p.message).join(' ')}>Out of date ({h.problems.length} change{h.problems.length === 1 ? '' : 's'})</Badge>;
                  },
                },
              ]}
            />
          )}
        </Card>
      </TabPanel>
      <TabPanel id="details" value={tab}>
        <div className="grid cols-2">
          <Card title="Account details" actions={<button type="button" className="btn small" onClick={() => editors.openAccount({ id: acct.id })}>Edit</button>}>
            <div className="kv">
              <span>Type</span><span>{accountTypeLabel(acct.type)}</span>
              <span>Institution</span><span>{acct.institution || '-'}</span>
              <span>Opening balance</span><span><Money cents={acct.openingCents} /></span>
              <span>Opening date</span><span>{formatDate(acct.openingDate)}</span>
              <span>Interest rate</span><span>{acct.aprBps ? formatBps(acct.aprBps) : '-'}</span>
              {acct.creditLimitCents && (<><span>Credit limit</span><span>{formatMoney(acct.creditLimitCents)}</span></>)}
              {liability && (<><span>Payment mode</span><span>{acct.paymentMode === 'pay_in_full' ? 'Pay in full' : acct.paymentMode === 'minimum' ? 'Minimum' : `Fixed ${formatMoney(acct.scheduledPaymentCents || 0)}`}</span></>)}
              {liability && (<><span>Due day</span><span>{acct.dueDay || '-'}</span></>)}
              {acct.loan && (<><span>Original loan</span><span>{formatMoney(acct.loan.originalPrincipalCents)} over {acct.loan.termMonths} months</span></>)}
            </div>
            {acct.notes && <p className="small muted" style={{ marginTop: 8 }}>{acct.notes}</p>}
          </Card>
          <Card title="Archive or delete">
            <p className="small">
              <strong>Archive</strong> hides the account from daily lists but keeps all of its history in reports and net-worth trends. It requires a zero balance (including pending and future-dated items) so no money disappears.
            </p>
            <p className="small">
              <strong>Delete</strong> is only possible when nothing refers to the account{refs.length ? ` - right now it is used by ${refs.join(', ')}` : ' - it is currently unused'}.
            </p>
            <div className="actions">
              {acct.status === 'active' ? (
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    const ok = await confirm({ title: `Archive ${acct.name}?`, message: 'Its history stays in reports. You can restore it later from the Accounts page.', confirmLabel: 'Archive account' });
                    if (ok) run((d) => archiveAccount(d, acct.id), { label: `archive ${acct.name}`, success: 'Account archived', undo: true });
                  }}
                >
                  Archive account
                </button>
              ) : (
                <button type="button" className="btn" onClick={() => run((d) => unarchiveAccount(d, acct.id), { label: `restore ${acct.name}`, success: 'Account restored' })}>
                  Restore account
                </button>
              )}
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  const ok = await confirm({ title: `Delete ${acct.name}?`, danger: true, confirmLabel: 'Delete account', message: refs.length ? `This account is used by ${refs.join(', ')}, so deletion will be refused. Archive it instead.` : 'This permanently removes the unused account. You can undo right after.' });
                  if (!ok) return;
                  const r = run((d) => deleteAccount(d, acct.id), { label: `delete ${acct.name}`, success: 'Account deleted', failTitle: 'Cannot delete', undo: true });
                  if (r.ok) nav('/accounts');
                }}
              >
                Delete account
              </button>
            </div>
          </Card>
        </div>
      </TabPanel>
    </>
  );
}

function Activity({ acct, index, reconciled, recurringById }) {
  const editors = useEditors();
  const run = useRun();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' });
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(50);
  const ledger = useMemo(() => runningLedger(index, acct.id), [index, acct.id]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = ledger.filter((r) => {
      if (status && r.tx.status !== status) return false;
      if (from && r.tx.date < from) return false;
      if (to && r.tx.date > to) return false;
      if (needle && !`${r.tx.description} ${r.tx.merchant} ${r.tx.notes} ${r.tx.source?.externalId || ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    const pos = new Map(ledger.map((r, i) => [r.tx.id, i]));
    list = [...list].sort((a, b) => {
      let c = 0;
      if (sort.key === 'amount') c = a.effect - b.effect;
      else if (sort.key === 'description') c = a.tx.description.localeCompare(b.tx.description);
      else c = a.tx.date < b.tx.date ? -1 : a.tx.date > b.tx.date ? 1 : 0;
      return c !== 0 ? c * dir : (pos.get(a.tx.id) - pos.get(b.tx.id)) * dir;
    });
    return list;
  }, [ledger, q, status, from, to, sort]);
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const shown = rows.slice(Math.min(page, pageCount - 1) * size, Math.min(page, pageCount - 1) * size + size);
  const liability = isLiabilityType(acct.type);
  const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'description' ? 'asc' : 'desc' }));
  const edit = (t) => (t.kind === 'transfer' ? editors.openTransfer({ transferId: t.transferId }) : editors.openTransaction({ id: t.id }));

  return (
    <Card title="Activity with running balance">
      <div className="filters" style={{ marginBottom: 12 }}>
        <TextField label="Search" type="search" value={q} onChange={(v) => { setQ(v); setPage(0); }} placeholder="Description, merchant, reference" />
        <SelectField label="Status" value={status} onChange={(v) => { setStatus(v); setPage(0); }} options={[{ value: 'posted', label: 'Posted' }, { value: 'pending', label: 'Pending' }]} placeholder="All" />
        <TextField label="From" type="date" value={from} onChange={(v) => { setFrom(v); setPage(0); }} />
        <TextField label="To" type="date" value={to} onChange={(v) => { setTo(v); setPage(0); }} />
        <button type="button" className="btn" onClick={() => { setQ(''); setStatus(''); setFrom(''); setTo(''); setPage(0); }}>Clear filters</button>
      </div>
      <Explain summary="How the two balance columns work">
        <p>
          <strong>Posted balance</strong> counts only posted transactions (what your statement shows). <strong>With pending</strong> also counts pending ones. Both start from the opening balance of {formatMoney(acct.openingCents)}.{liability && ' For cards and loans a negative balance means you owe that amount.'}
        </p>
      </Explain>
      <DataTable
        caption={`Activity for ${acct.name}`}
        rows={shown}
        rowKey={(r) => r.tx.id}
        sort={sort}
        onSort={onSort}
        columns={[
          { key: 'date', header: 'Date', sortable: true, className: 'nowrap', render: (r) => formatDate(r.tx.date) },
          {
            key: 'description',
            header: 'Description',
            sortable: true,
            main: true,
            render: (r) => (
              <div className="desc-cell">
                <button type="button" className="btn ghost small title" style={{ padding: 0, minHeight: 0, textAlign: 'left' }} onClick={() => edit(r.tx)}>{r.tx.description}</button>
                <div className="sub">{txTypeLabel(r.tx)} · {categoryLabel(r.tx, index)}</div>
                <TxBadges tx={r.tx} index={index} reconciledIds={reconciled} recurringById={recurringById} />
              </div>
            ),
          },
          { key: 'amount', header: 'Amount', sortable: true, className: 'num', render: (r) => <Money cents={r.effect} signed /> },
          { key: 'posted', header: 'Posted balance', className: 'num', render: (r) => (r.tx.status === 'posted' ? <Money cents={r.postedBalance} tone="none" /> : <span className="muted">(pending)</span>) },
          { key: 'incl', header: 'With pending', className: 'num', render: (r) => <Money cents={r.inclusiveBalance} tone="none" /> },
          {
            key: 'act',
            header: 'Actions',
            render: (r) => (
              <Menu
                label={`Actions for ${r.tx.description}`}
                items={[
                  { label: 'Edit', onClick: () => edit(r.tx) },
                  { label: 'Reverse (add offsetting entry)', onClick: () => run((d) => reverseTransaction(d, r.tx.id), { label: 'reverse entry', success: 'Reversal added', undo: true }) },
                  {
                    label: r.tx.kind === 'transfer' ? 'Delete transfer (both sides)' : 'Delete',
                    danger: true,
                    onClick: async () => {
                      const ok = await confirm({ title: 'Delete transaction?', danger: true, confirmLabel: 'Delete', message: r.tx.kind === 'transfer' ? 'This deletes both sides of the transfer so balances stay consistent.' : `"${r.tx.description}" will be removed. You can undo right after.` });
                      if (ok) run((d) => deleteTransactions(d, [r.tx.id]), { label: 'delete transaction', success: 'Deleted', undo: true });
                    },
                  },
                ]}
              />
            ),
          },
        ]}
        empty={<span className="muted">No transactions match.</span>}
      />
      <Pager page={Math.min(page, pageCount - 1)} pageCount={pageCount} total={rows.length} size={size} onPage={setPage} onSize={(s) => { setSize(s); setPage(0); }} />
    </Card>
  );
}
