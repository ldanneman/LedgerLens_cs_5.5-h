import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useParams, useSearchParams } from 'react-router-dom';
import { useData, useRun } from '../../state/hooks.jsx';
import { buildIndex } from '../../domain/ledger.js';
import { reconciledTxIds } from '../../domain/reconciliation.js';
import { deleteTransactions, reverseTransaction, bulkUpdateTransactions, linkAsTransfer } from '../../domain/ops/transactions.js';
import { formatDate } from '../../domain/dates.js';
import { formatMoney, centsToDecimalString } from '../../domain/money.js';
import { toCsv } from '../../imports/csv.js';
import { PageHead, Card, Callout, Pager, Menu, Boundary, Badge } from '../components/Common.jsx';
import { Money } from '../components/Money.jsx';
import DataTable from '../components/DataTable.jsx';
import { SelectField, TextField } from '../components/Form.jsx';
import { TxBadges, categoryLabel } from '../TxParts.jsx';
import { useEditors } from '../modals/Editors.jsx';
import { useConfirm } from '../components/Modal.jsx';
import { filtersFromParams, filterTransactions, sortTransactions, FILTER_KEYS, activeFilterCount } from '../txFilter.js';
import { recall, remember } from '../period.js';
import { downloadText, txTypeLabel } from '../format.js';
import RulesPage from './Rules.jsx';

const SIZES = [25, 50, 100, 200];

export default function Transactions() {
  const { view } = useParams();
  return (
    <>
      <nav className="tabs" aria-label="Transaction sections">
        <NavLink to="/transactions" end>All transactions</NavLink>
        <NavLink to="/transactions/rules">Rules & categories</NavLink>
      </nav>
      {view === 'rules' ? <RulesPage /> : <Ledger />}
    </>
  );
}

function Ledger() {
  const data = useData();
  const run = useRun();
  const confirm = useConfirm();
  const editors = useEditors();
  const [params, setParams] = useSearchParams();
  const hasUrlFilters = FILTER_KEYS.some((k) => params.has(k));
  const effective = useMemo(() => {
    if (hasUrlFilters || params.has('sort') || params.has('page')) return params;
    const stored = recall('tx-filters', '');
    return new URLSearchParams(stored);
  }, [params, hasUrlFilters]);
  const f = filtersFromParams(effective);
  const sort = { key: effective.get('sort') || 'date', dir: effective.get('dir') === 'asc' ? 'asc' : 'desc' };
  const size = SIZES.includes(Number(effective.get('size'))) ? Number(effective.get('size')) : 50;
  const page = Math.max(0, Number(effective.get('page')) || 0);
  const [selected, setSelected] = useState(() => new Set());
  const [searchText, setSearchText] = useState(f.q);
  const [bulkCat, setBulkCat] = useState('');
  const [bulkTag, setBulkTag] = useState('');
  const [showFilters, setShowFilters] = useState(() => typeof window === 'undefined' || !window.matchMedia || window.matchMedia('(min-width: 721px)').matches || FILTER_KEYS.some((k) => params.has(k) && k !== 'q'));

  const index = useMemo(() => buildIndex(data), [data]);
  const reconciled = useMemo(() => reconciledTxIds(data), [data]);
  const recurringById = useMemo(() => new Map(data.recurring.map((r) => [r.id, r])), [data.recurring]);

  const update = (patch, resetPage = true) => {
    const n = new URLSearchParams(effective);
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v === null || v === undefined) n.delete(k);
      else n.set(k, String(v));
    }
    if (resetPage && !('page' in patch)) n.delete('page');
    remember('tx-filters', n.toString());
    setParams(n, { replace: true });
  };

  // debounce the free-text search so typing stays responsive with thousands of rows
  useEffect(() => {
    if (searchText === f.q) return undefined;
    const t = setTimeout(() => update({ q: searchText }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);
  useEffect(() => setSearchText(f.q), [f.q]);

  const filtered = useMemo(() => filterTransactions(data, f), [data, f.q, f.acct, f.cat, f.kind, f.status, f.src, f.from, f.to, f.min, f.max, f.tag]); // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = useMemo(() => sortTransactions(data, filtered, sort), [data, filtered, sort.key, sort.dir]); // eslint-disable-line react-hooks/exhaustive-deps
  const pageCount = Math.max(1, Math.ceil(sorted.length / size));
  const safePage = Math.min(page, pageCount - 1);
  const shown = sorted.slice(safePage * size, safePage * size + size);
  const totals = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    for (const t of filtered) (t.amountCents >= 0 ? (inflow += t.amountCents) : (outflow += t.amountCents));
    return { inflow, outflow };
  }, [filtered]);
  const nFilters = activeFilterCount(f);
  const selectedList = [...selected].filter((id) => index.txById.has(id));

  const accountOptions = data.accounts.map((a) => ({ value: a.id, label: a.name + (a.status === 'archived' ? ' (archived)' : '') }));
  const categoryOptions = [{ value: '__none__', label: 'Uncategorized' }, ...data.categories.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: `${c.name} (${c.kind})` }))];

  const onSort = (key) => update({ sort: key, dir: sort.key === key ? (sort.dir === 'asc' ? 'desc' : 'asc') : key === 'description' || key === 'account' || key === 'category' ? 'asc' : 'desc' }, true);
  const toggle = (id, on) => setSelected((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });
  const togglePage = (on) => setSelected((s) => { const n = new Set(s); for (const t of shown) on ? n.add(t.id) : n.delete(t.id); return n; });
  const edit = (t) => (t.kind === 'transfer' ? editors.openTransfer({ transferId: t.transferId }) : editors.openTransaction({ id: t.id }));

  const exportCsv = () => {
    const rows = [['Date', 'Description', 'Merchant', 'Account', 'Amount', 'Status', 'Type', 'Category', 'Tags', 'Reference', 'Notes']];
    for (const t of sorted) rows.push([t.date, t.description, t.merchant, index.accountsById.get(t.accountId)?.name || '', centsToDecimalString(t.amountCents), t.status, txTypeLabel(t), categoryLabel(t, index), t.tags.join(';'), t.source?.externalId || '', t.notes]);
    downloadText(`ledgerlens-transactions-${data.settings.asOfDate}.csv`, toCsv(rows), 'text/csv');
  };

  const doDelete = async () => {
    const hasTransfer = selectedList.some((id) => index.txById.get(id).kind === 'transfer');
    const ok = await confirm({ title: `Delete ${selectedList.length} transaction${selectedList.length === 1 ? '' : 's'}?`, danger: true, confirmLabel: 'Delete', message: hasTransfer ? 'Your selection includes transfers: both sides of each transfer are deleted together so balances stay consistent. You can undo right after.' : 'You can undo right after.' });
    if (!ok) return;
    const r = run((d) => deleteTransactions(d, selectedList), { label: `delete ${selectedList.length} transactions`, success: 'Deleted', undo: true });
    if (r.ok) setSelected(new Set());
  };

  return (
    <>
      <PageHead
        title="Transactions"
        actions={
          <>
            <button type="button" className="btn primary" onClick={() => editors.openTransaction({})}>Add transaction</button>
            <button type="button" className="btn" onClick={() => editors.openTransfer({})}>Transfer funds</button>
            <button type="button" className="btn" onClick={() => editors.openTransaction({ defaults: { split: true } })}>Add split expense</button>
            <button type="button" className="btn" onClick={exportCsv} disabled={!sorted.length}>Export CSV</button>
          </>
        }
      >
        Search, filter and edit every transaction. Corrections can be made by editing or by adding a visible reversal.
      </PageHead>

      <Card>
        <div className="filters">
          <TextField label="Search" type="search" value={searchText} onChange={setSearchText} placeholder="Description, merchant, note, reference" />
          <div className="field">
            <span className="label">&nbsp;</span>
            <span className="row">
              <button type="button" className="btn" aria-expanded={showFilters} aria-controls="more-filters" onClick={() => setShowFilters((v) => !v)}>
                {showFilters ? 'Hide filters' : 'More filters'}
              </button>
              <button type="button" className="btn" onClick={() => { remember('tx-filters', ''); setParams(new URLSearchParams(), { replace: true }); setSearchText(''); }} disabled={nFilters === 0}>
                Clear filters {nFilters > 0 && <Badge>{nFilters}</Badge>}
              </button>
            </span>
          </div>
        </div>
        {showFilters && (
          <div className="filters" id="more-filters" style={{ marginTop: 10 }}>
            <SelectField label="Account" value={f.acct} onChange={(v) => update({ acct: v })} options={accountOptions} placeholder="All accounts" />
            <SelectField label="Category" value={f.cat} onChange={(v) => update({ cat: v })} options={categoryOptions} placeholder="All categories" />
            <SelectField label="Type" value={f.kind} onChange={(v) => update({ kind: v })} placeholder="All types" options={[{ value: 'income', label: 'Income' }, { value: 'expense', label: 'Expense (incl. refunds)' }, { value: 'refund', label: 'Refunds only' }, { value: 'transfer', label: 'Transfers' }, { value: 'adjustment', label: 'Adjustments' }]} />
            <SelectField label="Status" value={f.status} onChange={(v) => update({ status: v })} placeholder="Posted and pending" options={[{ value: 'posted', label: 'Posted' }, { value: 'pending', label: 'Pending' }]} />
            <SelectField label="Source" value={f.src} onChange={(v) => update({ src: v })} placeholder="Any source" options={[{ value: 'manual', label: 'Entered manually' }, { value: 'imported', label: 'Imported' }, { value: 'recurring', label: 'From recurring' }, { value: 'seed', label: 'Demo data' }, { value: 'reversal', label: 'Reversals' }]} />
            <TextField label="From date" type="date" value={f.from} onChange={(v) => update({ from: v })} />
            <TextField label="To date" type="date" value={f.to} onChange={(v) => update({ to: v })} />
            <TextField label="Min amount" value={f.min} onChange={(v) => update({ min: v })} placeholder="0.00" inputMode="decimal" />
            <TextField label="Max amount" value={f.max} onChange={(v) => update({ max: v })} placeholder="0.00" inputMode="decimal" />
            <TextField label="Tag" value={f.tag} onChange={(v) => update({ tag: v })} />
          </div>
        )}
        <p className="small muted" style={{ margin: '10px 0 0' }} aria-live="polite">
          {filtered.length.toLocaleString('en-US')} of {data.transactions.length.toLocaleString('en-US')} transactions · money in <Money cents={totals.inflow} signed /> · money out <Money cents={totals.outflow} signed /> (transfers appear on both sides)
        </p>
      </Card>

      {selectedList.length > 0 && (
        <Card className="" style={{ marginTop: 12, borderColor: 'var(--brand)' }} role="region" aria-label="Bulk actions">
          <div className="row between">
            <strong>{selectedList.length} selected</strong>
            <button type="button" className="btn small ghost" onClick={() => setSelected(new Set())}>Clear selection</button>
          </div>
          <div className="filters" style={{ marginTop: 8 }}>
            <SelectField label="Set category" value={bulkCat} onChange={setBulkCat} options={data.categories.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: `${c.name} (${c.kind})` }))} placeholder="Choose category" />
            <button type="button" className="btn" disabled={!bulkCat} onClick={() => run((d) => bulkUpdateTransactions(d, selectedList, { categoryId: bulkCat }), { label: 'bulk category', success: 'Category updated', undo: true })}>Apply category</button>
            <TextField label="Tag" value={bulkTag} onChange={setBulkTag} />
            <div className="row">
              <button type="button" className="btn" disabled={!bulkTag.trim()} onClick={() => run((d) => bulkUpdateTransactions(d, selectedList, { addTags: [bulkTag.trim()] }), { label: 'bulk add tag', success: 'Tag added', undo: true })}>Add tag</button>
              <button type="button" className="btn" disabled={!bulkTag.trim()} onClick={() => run((d) => bulkUpdateTransactions(d, selectedList, { removeTags: [bulkTag.trim()] }), { label: 'bulk remove tag', success: 'Tag removed', undo: true })}>Remove tag</button>
            </div>
            <div className="row">
              <button type="button" className="btn" onClick={() => run((d) => bulkUpdateTransactions(d, selectedList, { status: 'posted' }), { label: 'mark posted', success: 'Marked posted', undo: true })}>Mark posted</button>
              <button type="button" className="btn" onClick={() => run((d) => bulkUpdateTransactions(d, selectedList, { status: 'pending' }), { label: 'mark pending', success: 'Marked pending', undo: true })}>Mark pending</button>
            </div>
            <div className="row">
              <button type="button" className="btn" disabled={selectedList.length !== 2} title="Select exactly two opposite entries in different accounts" onClick={() => run((d) => linkAsTransfer(d, selectedList[0], selectedList[1]), { label: 'link as transfer', success: 'Linked as a transfer', undo: true })}>Link as transfer</button>
              <button type="button" className="btn danger" onClick={doDelete}>Delete selected</button>
            </div>
          </div>
        </Card>
      )}

      <div style={{ marginTop: 12 }}>
        <Boundary name="The transaction table" resetKey={sorted.length}>
          <DataTable
            caption="Transactions"
            rows={shown}
            rowKey={(t) => t.id}
            sort={sort}
            onSort={onSort}
            selectable
            selected={selected}
            onSelect={toggle}
            onSelectAll={togglePage}
            empty={
              <span className="muted">
                {data.transactions.length === 0 ? 'No transactions yet. Add one or import a CSV.' : 'No transactions match these filters.'}{' '}
                {nFilters > 0 && <button type="button" className="btn small" onClick={() => { remember('tx-filters', ''); setParams(new URLSearchParams(), { replace: true }); }}>Clear filters</button>}
              </span>
            }
            columns={[
              { key: 'date', header: 'Date', sortable: true, className: 'nowrap', render: (t) => formatDate(t.date) },
              {
                key: 'description',
                header: 'Description',
                sortable: true,
                main: true,
                render: (t) => (
                  <div className="desc-cell">
                    <button type="button" className="btn ghost small title" style={{ padding: 0, minHeight: 0, textAlign: 'left' }} onClick={() => edit(t)} aria-label={`Edit ${t.description}`}>{t.description}</button>
                    <div className="sub">{txTypeLabel(t)}{t.merchant && t.merchant !== t.description ? ` · ${t.merchant}` : ''}</div>
                    <TxBadges tx={t} index={index} reconciledIds={reconciled} recurringById={recurringById} />
                  </div>
                ),
              },
              { key: 'account', header: 'Account', sortable: true, render: (t) => <Link to={`/accounts/${encodeURIComponent(t.accountId)}`}>{index.accountsById.get(t.accountId)?.name || t.accountId}</Link> },
              { key: 'category', header: 'Category', sortable: true, render: (t) => categoryLabel(t, index) },
              { key: 'amount', header: 'Amount', sortable: true, className: 'num', render: (t) => <Money cents={t.amountCents} signed /> },
              {
                key: 'act',
                header: 'Actions',
                render: (t) => (
                  <Menu
                    label={`Actions for ${t.description}`}
                    items={[
                      { label: 'Edit', onClick: () => edit(t) },
                      { label: 'Reverse (add offsetting entry)', onClick: () => run((d) => reverseTransaction(d, t.id), { label: 'reverse entry', success: 'Reversal added', undo: true }) },
                      {
                        label: t.kind === 'transfer' ? 'Delete transfer (both sides)' : 'Delete',
                        danger: true,
                        onClick: async () => {
                          const ok = await confirm({ title: 'Delete transaction?', danger: true, confirmLabel: 'Delete', message: t.kind === 'transfer' ? 'This deletes both sides of the transfer so balances stay consistent.' : `"${t.description}" will be removed. You can undo right after.` });
                          if (ok) run((d) => deleteTransactions(d, [t.id]), { label: 'delete transaction', success: 'Deleted', undo: true });
                        },
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        </Boundary>
        <Pager page={safePage} pageCount={pageCount} total={sorted.length} size={size} onPage={(p) => update({ page: p }, false)} onSize={(s) => update({ size: s })} sizes={SIZES} />
      </div>
      {sorted.length > size && selectedList.length > 0 && selectedList.length === shown.length && (
        <Callout tone="info" style={{ marginTop: 12 }}>
          Only the {shown.length} rows on this page are selected.{' '}
          <button type="button" className="btn small" onClick={() => setSelected(new Set(sorted.map((t) => t.id)))}>Select all {sorted.length.toLocaleString('en-US')} matching</button>
        </Callout>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>
        Amounts: <strong>+</strong> increases the account's net-worth contribution, <strong>-</strong> decreases it. For credit cards a purchase is negative (you owe more) and a payment is positive. {formatMoney(0)} entries are not allowed.
      </p>
    </>
  );
}
