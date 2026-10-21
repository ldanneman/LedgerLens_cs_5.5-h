import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../../state/hooks.jsx';
import { buildIndex, accountPosition, isLiabilityType, utilization } from '../../domain/ledger.js';
import { lastReconciliation } from '../../domain/reconciliation.js';
import { formatMoney, formatBps } from '../../domain/money.js';
import { formatDate } from '../../domain/dates.js';
import { PageHead, Card, Stat, Badge, EmptyState, Boundary } from '../components/Common.jsx';
import { Money, Owed } from '../components/Money.jsx';
import DataTable from '../components/DataTable.jsx';
import { CheckField } from '../components/Form.jsx';
import { useEditors } from '../modals/Editors.jsx';
import { accountTypeLabel } from '../format.js';

const GROUPS = [
  { id: 'cash', title: 'Cash and savings', types: ['checking', 'savings'] },
  { id: 'invest', title: 'Investments', types: ['investment'] },
  { id: 'cards', title: 'Credit cards', types: ['credit_card'] },
  { id: 'loans', title: 'Loans', types: ['auto_loan', 'student_loan', 'personal_loan'] },
];

export default function Accounts() {
  const data = useData();
  const editors = useEditors();
  const index = useMemo(() => buildIndex(data), [data]);
  const asOf = data.settings.asOfDate;
  const [showArchived, setShowArchived] = useState(false);
  const rows = useMemo(
    () =>
      data.accounts.map((a) => ({
        account: a,
        pos: accountPosition(index, a.id, asOf),
        recon: lastReconciliation(data, a.id),
      })),
    [data, index, asOf],
  );
  const live = rows.filter((r) => r.account.status === 'active');
  const assets = live.filter((r) => !isLiabilityType(r.account.type)).reduce((s, r) => s + r.pos.postedCents, 0);
  const owed = live.filter((r) => isLiabilityType(r.account.type)).reduce((s, r) => s - r.pos.postedCents, 0);
  const archived = rows.filter((r) => r.account.status === 'archived');

  const columns = (liability) => [
    {
      key: 'name',
      header: 'Account',
      main: true,
      render: (r) => (
        <div className="desc-cell">
          <Link to={`/accounts/${encodeURIComponent(r.account.id)}`} className="title">
            {r.account.name}
          </Link>
          <div className="sub">
            {r.account.institution || 'No institution'}
            {r.account.last4 ? ` · ...${r.account.last4}` : ''} · {accountTypeLabel(r.account.type)}
          </div>
        </div>
      ),
    },
    {
      key: 'balance',
      header: liability ? 'Amount owed (posted)' : 'Balance (posted)',
      className: 'num',
      render: (r) => (liability ? <Owed contributionCents={r.pos.postedCents} /> : <Money cents={r.pos.postedCents} />),
    },
    {
      key: 'avail',
      header: 'With pending',
      className: 'num',
      render: (r) => (r.pos.pendingCount ? (liability ? <Owed contributionCents={r.pos.availableCents} /> : <Money cents={r.pos.availableCents} />) : <span className="muted">same</span>),
    },
    {
      key: 'terms',
      header: 'Rate / limit',
      render: (r) => {
        const a = r.account;
        const bits = [];
        if (a.aprBps) bits.push(`${formatBps(a.aprBps)} APR`);
        if (a.creditLimitCents) {
          bits.push(`limit ${formatMoney(a.creditLimitCents)}`);
          const u = utilization(a, r.pos.postedCents);
          if (u !== null) bits.push(`${u}% used`);
        }
        if (liability && a.scheduledPaymentCents && a.paymentMode === 'fixed') bits.push(`pays ${formatMoney(a.scheduledPaymentCents)}/mo`);
        if (liability && a.paymentMode === 'pay_in_full') bits.push('pay in full');
        return bits.length ? bits.join(' · ') : <span className="muted">-</span>;
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <>
          {r.account.status === 'archived' ? <Badge>Archived</Badge> : <Badge tone="pos">Active</Badge>}{' '}
          {r.recon ? <Badge tone="pos" title={`Statement ending ${r.recon.endDate}`}>Reconciled {formatDate(r.recon.endDate)}</Badge> : r.account.status === 'active' && !liability ? <Badge>Never reconciled</Badge> : null}
          {r.pos.pendingCount > 0 && <Badge tone="warn">{r.pos.pendingCount} pending</Badge>}
        </>
      ),
    },
  ];

  return (
    <>
      <PageHead title="Accounts" actions={<button type="button" className="btn primary" onClick={() => editors.openAccount({})}>Add account</button>}>
        Every account at {formatDate(asOf)}. Liabilities (cards and loans) are shown as amounts owed; in calculations they are negative contributions to net worth.
      </PageHead>
      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <Card><Stat label="Assets" value={<Money cents={assets} tone="none" />} sub="Cash, savings and investments (posted)" /></Card>
        <Card><Stat label="Amount owed" value={<Money cents={owed} tone="none" />} sub="Credit cards and loans (posted)" /></Card>
        <Card><Stat label="Net worth" value={<Money cents={assets - owed} />} sub="Assets minus amount owed" info="Net worth is the sum of every account's net-worth contribution: assets are positive, what you owe is negative." /></Card>
      </div>
      {live.length === 0 && (
        <Card><EmptyState title="No accounts yet" action={<button type="button" className="btn primary" onClick={() => editors.openAccount({})}>Add your first account</button>}>Accounts hold your balances and transactions.</EmptyState></Card>
      )}
      <div className="stack">
        {GROUPS.map((g) => {
          const list = live.filter((r) => g.types.includes(r.account.type));
          if (!list.length) return null;
          const liability = g.types.every((t) => isLiabilityType(t));
          const total = list.reduce((s, r) => s + r.pos.postedCents, 0);
          return (
            <Boundary key={g.id} name={g.title}>
              <Card title={g.title} actions={<span className="small muted">Total {liability ? 'owed ' : ''}<strong>{formatMoney(liability ? -total : total)}</strong></span>}>
                <DataTable caption={g.title} columns={columns(liability)} rows={list} rowKey={(r) => r.account.id} />
              </Card>
            </Boundary>
          );
        })}
        {archived.length > 0 && (
          <Card title="Archived accounts" actions={<CheckField label="Show" checked={showArchived} onChange={setShowArchived} />}>
            <p className="small muted">Archived accounts keep their full history in reports and net-worth trends. They hold a zero balance.</p>
            {showArchived && <DataTable caption="Archived accounts" columns={columns(false)} rows={archived} rowKey={(r) => r.account.id} />}
          </Card>
        )}
      </div>
    </>
  );
}
