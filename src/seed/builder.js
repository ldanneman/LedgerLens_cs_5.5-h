/**
 * DatasetBuilder: a compact way to construct valid datasets for the demo world, Test Lab presets and
 * tests. It writes canonical records directly (no randomness, no clock) and finishes with build(),
 * which assigns the dataset-wide id counter and returns a normalized dataset.
 */
import { emptyDataset, normalizeDataset } from '../domain/schema.js';
import { parseMoney } from '../domain/money.js';

/** Dollar string -> integer cents, e.g. usd('-47.35') === -4735. Throws on bad input (builder misuse). */
export function usd(s) {
  const r = parseMoney(s);
  if (!r.ok) throw new Error(`Bad amount in builder: ${s} (${r.error})`);
  return r.cents;
}

const MANUAL = { type: 'manual', batchId: null, externalId: null, importedAt: null, rawDescription: null };

export class DatasetBuilder {
  constructor({ name, kind = 'preset', presetId = null, description = '', asOfDate = '2026-10-01', basis = 'posted' } = {}) {
    this.d = emptyDataset({ meta: { name, kind, presetId, description, seq: 1 }, settings: { asOfDate, basis, investmentGrowthBps: 0 } });
    this.n = 1;
  }

  /** Next sequential id with a prefix. */
  id(prefix) {
    const id = `${prefix}-${String(this.n).padStart(6, '0')}`;
    this.n += 1;
    return id;
  }

  category(id, name, kind, group = '', color = '') {
    this.d.categories.push({ id, name, kind, group, color });
    return id;
  }

  account(id, a) {
    this.d.accounts.push({
      id,
      name: a.name,
      type: a.type,
      institution: a.institution || '',
      openingCents: a.opening ?? 0,
      openingDate: a.openingDate || '2025-09-01',
      status: a.status || 'active',
      archivedDate: a.archivedDate || null,
      last4: a.last4 || '',
      aprBps: a.aprBps ?? 0,
      creditLimitCents: a.limit ?? null,
      scheduledPaymentCents: a.payment ?? null,
      paymentMode: a.paymentMode || 'fixed',
      minPaymentBps: a.minPaymentBps ?? 0,
      minPaymentFloorCents: a.minPaymentFloor ?? 0,
      dueDay: a.dueDay ?? null,
      statementDay: a.statementDay ?? null,
      autopayAccountId: a.autopay || null,
      loan: a.loan || null,
      notes: a.notes || '',
      color: a.color || '',
    });
    return id;
  }

  /**
   * Add a transaction. amount is signed cents (the effect on the account's contribution).
   * @param {object} t {account,date,desc,amount,kind,status,category,splits,tags,merchant,notes,source,recurrence,id,catSource,adjustmentKind}
   */
  tx(t) {
    const id = t.id || this.id('tx');
    const splits = (t.splits || []).map((s) => ({ categoryId: s[0], amountCents: s[1], note: s[2] || '' }));
    this.d.transactions.push({
      id,
      accountId: t.account,
      date: t.date,
      description: t.desc,
      merchant: t.merchant ?? '',
      amountCents: t.amount,
      kind: t.kind,
      status: t.status || 'posted',
      adjustmentKind: t.adjustmentKind || (t.kind === 'adjustment' ? 'correction' : null),
      categoryId: splits.length ? null : t.category ?? null,
      categorySource: t.catSource === undefined ? (t.category || splits.length ? 'seed' : null) : t.catSource,
      splits,
      notes: t.notes || '',
      tags: t.tags || [],
      transferId: t.transferId || null,
      reversalOf: t.reversalOf || null,
      recurrence: t.recurrence || null,
      source: t.source || { ...MANUAL },
    });
    return id;
  }

  /** Internal transfer: from loses `amount`, to gains it. Returns {transferId, legIds}. */
  transfer({ from, to, amount, date, desc, status = 'posted', recurrence = null, id, legIds, memo = '', fromDesc, toDesc }) {
    const transferId = id || this.id('xfr');
    const a = legIds?.[0] || this.id('tx');
    const b = legIds?.[1] || this.id('tx');
    const base = { date, kind: 'transfer', status, transferId, recurrence, catSource: null };
    const fromName = this.d.accounts.find((x) => x.id === to)?.name;
    const toName = this.d.accounts.find((x) => x.id === from)?.name;
    this.tx({ id: a, account: from, desc: fromDesc || desc || `Transfer to ${fromName}`, amount: -amount, ...base });
    this.tx({ id: b, account: to, desc: toDesc || desc || `Transfer from ${toName}`, amount, ...base });
    this.d.transfers.push({ id: transferId, legIds: [a, b], external: false, counterparty: '', memo });
    return { transferId, legIds: [a, b] };
  }

  /** One-legged transfer to/from an untracked account. */
  external({ account, amount, date, counterparty, desc, status = 'posted' }) {
    const transferId = this.id('xfr');
    const leg = this.id('tx');
    this.tx({ id: leg, account, date, desc: desc || `Transfer ${amount < 0 ? 'to' : 'from'} ${counterparty}`, amount, kind: 'transfer', status, transferId, catSource: null });
    this.d.transfers.push({ id: transferId, legIds: [leg], external: true, counterparty, memo: '' });
    return { transferId, legIds: [leg] };
  }

  rule(r) {
    this.d.rules.push({ id: r.id || this.id('rule'), name: r.name, enabled: r.enabled !== false, priority: r.priority ?? 100, field: r.field || 'any', match: r.match || 'contains', pattern: r.pattern, categoryId: r.category, accountId: r.account || null, minAmountCents: r.min ?? null, maxAmountCents: r.max ?? null });
  }

  budget(b) {
    this.d.budgets.push({ id: b.id || this.id('bud'), categoryId: b.category, enabled: b.enabled !== false, rollover: Boolean(b.rollover), baseCents: b.base, startMonth: b.startMonth || '2025-09', overrides: (b.overrides || []).map(([month, amountCents]) => ({ month, amountCents })) });
  }

  recurring(r) {
    this.d.recurring.push({
      id: r.id || this.id('rec'),
      title: r.title,
      kind: r.kind,
      amountCents: r.amount,
      accountId: r.account,
      toAccountId: r.to || null,
      categoryId: r.category || null,
      merchant: r.merchant || '',
      startDate: r.start,
      endDate: r.end || null,
      interval: r.interval,
      active: r.active !== false,
      group: r.group || (r.kind === 'income' ? 'income' : r.kind === 'transfer' ? 'transfer' : 'bill'),
      businessDay: r.businessDay || 'none',
      skipped: r.skipped || [],
      notes: r.notes || '',
    });
    return this.d.recurring[this.d.recurring.length - 1].id;
  }

  goal(g) {
    this.d.goals.push({ id: g.id || this.id('goal'), name: g.name, targetCents: g.target, targetDate: g.date, accountId: g.account || null, allocation: g.allocation || { type: 'full', value: 0 }, contributions: g.contributions || [], priority: g.priority ?? 100, note: g.note || '' });
  }

  reconciliation(r) {
    this.d.reconciliations.push({
      id: r.id || this.id('rec'),
      accountId: r.account,
      startDate: r.start,
      endDate: r.end,
      openingCents: r.opening,
      closingCents: r.closing,
      clearedTxIds: r.cleared || [],
      status: r.status || 'in_progress',
      createdAt: r.createdAt || null,
      completedAt: r.completedAt || null,
      calculatedCents: r.calculated ?? null,
      discrepancyCents: r.discrepancy ?? null,
      snapshots: r.snapshots || [],
      adjustmentTxId: r.adjustmentTxId || null,
      note: r.note || '',
    });
  }

  batch(b) {
    this.d.importBatches.push({ id: b.id, accountId: b.account, fileName: b.fileName || '', importedAt: b.importedAt || null, status: b.status || 'committed', createdTxIds: b.created || [], settled: [], rowCount: b.rowCount ?? (b.created || []).length, skippedCount: b.skipped ?? 0, rejectedCount: b.rejected ?? 0, undoneAt: null });
  }

  scenario(s) {
    this.d.scenarios.push({ id: s.id || this.id('scn'), name: s.name, description: s.description || '', horizonMonths: s.horizonMonths ?? 12, asOfDate: s.asOfDate || null, assumptions: { investmentGrowthBps: null, variableSpending: 'trailing', variableSpendingCents: null, includeSavingsInterest: true, ...(s.assumptions || {}) }, changes: s.changes || [] });
  }

  /** Finish: set the id counter above every sequential id used, then normalize. */
  build() {
    let max = 0;
    const scan = (list) => {
      for (const e of list) {
        const m = /-(\d+)$/.exec(e.id);
        if (m) max = Math.max(max, Number(m[1]));
      }
    };
    for (const k of ['accounts', 'categories', 'transactions', 'transfers', 'rules', 'budgets', 'recurring', 'goals', 'reconciliations', 'importBatches', 'scenarios']) scan(this.d[k]);
    this.d.meta.seq = Math.max(this.n, max + 1);
    return normalizeDataset(JSON.parse(JSON.stringify(this.d)));
  }
}

/**
 * Append a COMPLETED reconciliation to a built dataset, computing statement figures from its own
 * posted ledger (opening = posted contribution the day before start; closing = at end; every posted
 * transaction in range cleared). Used by presets so their reconciliations are internally consistent.
 */
export function addCompletedReconciliation(dataset, { id, accountId, start, end, at = '2026-10-01T09:00:00.000Z', skipIds = [] }) {
  const acct = dataset.accounts.find((a) => a.id === accountId);
  const prior = dayBefore(start);
  const eff = (date) => (date >= acct.openingDate ? acct.openingCents : 0) + dataset.transactions.filter((t) => t.accountId === accountId && t.date <= date && t.status === 'posted').reduce((s, t) => s + t.amountCents, 0);
  const items = dataset.transactions.filter((t) => t.accountId === accountId && t.status === 'posted' && t.date >= start && t.date <= end && !skipIds.includes(t.id));
  const opening = eff(prior);
  const closing = opening + items.reduce((s, t) => s + t.amountCents, 0);
  dataset.reconciliations.push({
    id,
    accountId,
    startDate: start,
    endDate: end,
    openingCents: opening,
    closingCents: closing,
    clearedTxIds: items.map((t) => t.id),
    status: 'completed',
    createdAt: at,
    completedAt: at,
    calculatedCents: closing,
    discrepancyCents: 0,
    snapshots: items.map((t) => ({ txId: t.id, amountCents: t.amountCents, date: t.date, status: 'posted', accountId })),
    adjustmentTxId: null,
    note: '',
  });
  return dataset;
}

function dayBefore(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) - 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}
