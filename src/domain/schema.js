/**
 * Dataset schema: enumerations, defaults, normalization, and field-level
 * validation. A *dataset* is the complete, serialisable state of one workspace:
 *
 *   { schemaVersion, meta, settings, accounts, categories, transactions, transfers,
 *     rules, budgets, recurring, goals, reconciliations, importBatches, scenarios }
 *
 * Normalization copies only KNOWN fields (unknown keys - including "__proto__" -
 * are dropped) and fills absent optional fields with defaults. It never coerces a
 * wrongly-typed required value; that is left for validation to report, so bad data
 * is surfaced instead of silently "fixed".
 */
import { isValidCents } from './money.js';
import { isValidDate, isValidMonth } from './dates.js';

export const SCHEMA_VERSION = 1;
export const APP_NAME = 'LedgerLens';

export const ACCOUNT_TYPES = ['checking', 'savings', 'credit_card', 'investment', 'auto_loan', 'student_loan', 'personal_loan'];
export const ASSET_TYPES = ['checking', 'savings', 'investment'];
export const LIABILITY_TYPES = ['credit_card', 'auto_loan', 'student_loan', 'personal_loan'];
export const LOAN_TYPES = ['auto_loan', 'student_loan', 'personal_loan'];
export const CASH_TYPES = ['checking', 'savings'];
export const ACCOUNT_TYPE_LABELS = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit card',
  investment: 'Investment',
  auto_loan: 'Auto loan',
  student_loan: 'Student loan',
  personal_loan: 'Personal loan',
};
export const TX_KINDS = ['income', 'expense', 'transfer', 'adjustment'];
export const TX_STATUSES = ['pending', 'posted'];
export const ADJUSTMENT_KINDS = ['valuation', 'correction'];
export const CATEGORY_KINDS = ['income', 'expense'];
export const CATEGORY_SOURCES = ['manual', 'rule', 'import', 'seed'];
export const SOURCE_TYPES = ['manual', 'import', 'seed', 'recurring', 'reversal'];
export const INTERVALS = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
export const RECURRING_KINDS = ['income', 'expense', 'transfer'];
export const RECURRING_GROUPS = ['income', 'bill', 'subscription', 'transfer', 'other'];
export const BUSINESS_DAY_MODES = ['none', 'next', 'prev'];
export const PAYMENT_MODES = ['fixed', 'minimum', 'pay_in_full'];
export const RULE_FIELDS = ['merchant', 'description', 'any'];
export const RULE_MATCHES = ['contains', 'equals', 'starts_with'];
export const GOAL_ALLOCATIONS = ['full', 'fixed', 'percent', 'manual'];
export const BASES = ['posted', 'pending'];

export const LIMITS = {
  name: 80,
  description: 200,
  merchant: 120,
  notes: 1000,
  tag: 30,
  tags: 12,
  splits: 25,
  maxAprBps: 10000,
  maxTermMonths: 600,
};

/** Create a fresh, empty (but valid) dataset. */
export function emptyDataset(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: { name: 'Untitled dataset', kind: 'custom', presetId: null, description: '', seq: 1 },
    settings: { asOfDate: '2026-10-01', basis: 'posted', investmentGrowthBps: 0 },
    accounts: [],
    categories: [],
    transactions: [],
    transfers: [],
    rules: [],
    budgets: [],
    recurring: [],
    goals: [],
    reconciliations: [],
    importBatches: [],
    scenarios: [],
    ...overrides,
  };
}

export const COLLECTIONS = [
  'accounts',
  'categories',
  'transactions',
  'transfers',
  'rules',
  'budgets',
  'recurring',
  'goals',
  'reconciliations',
  'importBatches',
  'scenarios',
];

export const COLLECTION_LABELS = {
  accounts: 'Account',
  categories: 'Category',
  transactions: 'Transaction',
  transfers: 'Transfer',
  rules: 'Rule',
  budgets: 'Budget',
  recurring: 'Recurring rule',
  goals: 'Goal',
  reconciliations: 'Reconciliation',
  importBatches: 'Import batch',
  scenarios: 'Scenario',
};

// ---------------------------------------------------------------- normalizers
const has = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const pick = (o, k, dflt) => (has(o, k) && o[k] !== undefined ? o[k] : dflt);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const mapArr = (v, fn) => (Array.isArray(v) ? v.map(fn) : v);

export function normalizeAccount(a) {
  if (!isObj(a)) return a;
  const loan = pick(a, 'loan', null);
  return {
    id: pick(a, 'id'),
    name: pick(a, 'name'),
    type: pick(a, 'type'),
    institution: pick(a, 'institution', ''),
    openingCents: pick(a, 'openingCents'),
    openingDate: pick(a, 'openingDate'),
    status: pick(a, 'status', 'active'),
    archivedDate: pick(a, 'archivedDate', null),
    last4: pick(a, 'last4', ''),
    aprBps: pick(a, 'aprBps', 0),
    creditLimitCents: pick(a, 'creditLimitCents', null),
    scheduledPaymentCents: pick(a, 'scheduledPaymentCents', null),
    paymentMode: pick(a, 'paymentMode', 'fixed'),
    minPaymentBps: pick(a, 'minPaymentBps', 0),
    minPaymentFloorCents: pick(a, 'minPaymentFloorCents', 0),
    dueDay: pick(a, 'dueDay', null),
    statementDay: pick(a, 'statementDay', null),
    autopayAccountId: pick(a, 'autopayAccountId', null),
    loan: isObj(loan)
      ? {
          originalPrincipalCents: pick(loan, 'originalPrincipalCents'),
          termMonths: pick(loan, 'termMonths'),
          startDate: pick(loan, 'startDate'),
        }
      : loan,
    notes: pick(a, 'notes', ''),
    color: pick(a, 'color', ''),
  };
}

export function normalizeCategory(c) {
  if (!isObj(c)) return c;
  return {
    id: pick(c, 'id'),
    name: pick(c, 'name'),
    kind: pick(c, 'kind'),
    group: pick(c, 'group', ''),
    color: pick(c, 'color', ''),
  };
}

function normalizeSplit(s) {
  if (!isObj(s)) return s;
  return { categoryId: pick(s, 'categoryId', null), amountCents: pick(s, 'amountCents'), note: pick(s, 'note', '') };
}

function normalizeSource(s) {
  if (!isObj(s)) return s;
  return {
    type: pick(s, 'type', 'manual'),
    batchId: pick(s, 'batchId', null),
    externalId: pick(s, 'externalId', null),
    importedAt: pick(s, 'importedAt', null),
    rawDescription: pick(s, 'rawDescription', null),
  };
}

export function normalizeTransaction(t) {
  if (!isObj(t)) return t;
  const rec = pick(t, 'recurrence', null);
  return {
    id: pick(t, 'id'),
    accountId: pick(t, 'accountId'),
    date: pick(t, 'date'),
    description: pick(t, 'description'),
    merchant: pick(t, 'merchant', ''),
    amountCents: pick(t, 'amountCents'),
    kind: pick(t, 'kind'),
    status: pick(t, 'status', 'posted'),
    adjustmentKind: pick(t, 'adjustmentKind', null),
    categoryId: pick(t, 'categoryId', null),
    categorySource: pick(t, 'categorySource', null),
    splits: mapArr(pick(t, 'splits', []), normalizeSplit),
    notes: pick(t, 'notes', ''),
    tags: pick(t, 'tags', []),
    transferId: pick(t, 'transferId', null),
    reversalOf: pick(t, 'reversalOf', null),
    recurrence: isObj(rec) ? { ruleId: pick(rec, 'ruleId'), occurrence: pick(rec, 'occurrence') } : rec,
    source: normalizeSource(pick(t, 'source', { type: 'manual', batchId: null, externalId: null, importedAt: null, rawDescription: null })),
  };
}

export function normalizeTransfer(t) {
  if (!isObj(t)) return t;
  return {
    id: pick(t, 'id'),
    legIds: pick(t, 'legIds'),
    external: pick(t, 'external', false),
    counterparty: pick(t, 'counterparty', ''),
    memo: pick(t, 'memo', ''),
  };
}

export function normalizeRule(r) {
  if (!isObj(r)) return r;
  return {
    id: pick(r, 'id'),
    name: pick(r, 'name'),
    enabled: pick(r, 'enabled', true),
    priority: pick(r, 'priority', 100),
    field: pick(r, 'field', 'any'),
    match: pick(r, 'match', 'contains'),
    pattern: pick(r, 'pattern'),
    categoryId: pick(r, 'categoryId'),
    accountId: pick(r, 'accountId', null),
    minAmountCents: pick(r, 'minAmountCents', null),
    maxAmountCents: pick(r, 'maxAmountCents', null),
  };
}

export function normalizeBudget(b) {
  if (!isObj(b)) return b;
  return {
    id: pick(b, 'id'),
    categoryId: pick(b, 'categoryId'),
    enabled: pick(b, 'enabled', true),
    rollover: pick(b, 'rollover', false),
    baseCents: pick(b, 'baseCents'),
    startMonth: pick(b, 'startMonth'),
    overrides: mapArr(pick(b, 'overrides', []), (o) => (isObj(o) ? { month: pick(o, 'month'), amountCents: pick(o, 'amountCents') } : o)),
  };
}

export function normalizeRecurring(r) {
  if (!isObj(r)) return r;
  return {
    id: pick(r, 'id'),
    title: pick(r, 'title'),
    kind: pick(r, 'kind'),
    amountCents: pick(r, 'amountCents'),
    accountId: pick(r, 'accountId'),
    toAccountId: pick(r, 'toAccountId', null),
    categoryId: pick(r, 'categoryId', null),
    merchant: pick(r, 'merchant', ''),
    startDate: pick(r, 'startDate'),
    endDate: pick(r, 'endDate', null),
    interval: pick(r, 'interval'),
    active: pick(r, 'active', true),
    group: pick(r, 'group', 'other'),
    businessDay: pick(r, 'businessDay', 'none'),
    skipped: pick(r, 'skipped', []),
    notes: pick(r, 'notes', ''),
  };
}

export function normalizeGoal(g) {
  if (!isObj(g)) return g;
  const alloc = pick(g, 'allocation', { type: 'full', value: 0 });
  return {
    id: pick(g, 'id'),
    name: pick(g, 'name'),
    targetCents: pick(g, 'targetCents'),
    targetDate: pick(g, 'targetDate'),
    accountId: pick(g, 'accountId', null),
    allocation: isObj(alloc) ? { type: pick(alloc, 'type'), value: pick(alloc, 'value', 0) } : alloc,
    contributions: mapArr(pick(g, 'contributions', []), (c) =>
      isObj(c) ? { date: pick(c, 'date'), amountCents: pick(c, 'amountCents'), note: pick(c, 'note', '') } : c,
    ),
    priority: pick(g, 'priority', 100),
    note: pick(g, 'note', ''),
  };
}

export function normalizeReconciliation(r) {
  if (!isObj(r)) return r;
  return {
    id: pick(r, 'id'),
    accountId: pick(r, 'accountId'),
    startDate: pick(r, 'startDate'),
    endDate: pick(r, 'endDate'),
    openingCents: pick(r, 'openingCents'),
    closingCents: pick(r, 'closingCents'),
    clearedTxIds: pick(r, 'clearedTxIds', []),
    status: pick(r, 'status', 'in_progress'),
    createdAt: pick(r, 'createdAt', null),
    completedAt: pick(r, 'completedAt', null),
    calculatedCents: pick(r, 'calculatedCents', null),
    discrepancyCents: pick(r, 'discrepancyCents', null),
    snapshots: mapArr(pick(r, 'snapshots', []), (s) =>
      isObj(s)
        ? { txId: pick(s, 'txId'), amountCents: pick(s, 'amountCents'), date: pick(s, 'date'), status: pick(s, 'status', 'posted'), accountId: pick(s, 'accountId', null) }
        : s,
    ),
    adjustmentTxId: pick(r, 'adjustmentTxId', null),
    note: pick(r, 'note', ''),
  };
}

export function normalizeImportBatch(b) {
  if (!isObj(b)) return b;
  return {
    id: pick(b, 'id'),
    accountId: pick(b, 'accountId'),
    fileName: pick(b, 'fileName', ''),
    importedAt: pick(b, 'importedAt', null),
    status: pick(b, 'status', 'committed'),
    createdTxIds: pick(b, 'createdTxIds', []),
    settled: mapArr(pick(b, 'settled', []), (s) =>
      isObj(s) ? { txId: pick(s, 'txId'), before: isObj(pick(s, 'before')) ? normalizeTransaction(s.before) : pick(s, 'before') } : s,
    ),
    rowCount: pick(b, 'rowCount', 0),
    skippedCount: pick(b, 'skippedCount', 0),
    rejectedCount: pick(b, 'rejectedCount', 0),
    undoneAt: pick(b, 'undoneAt', null),
  };
}

function normalizeChange(c) {
  if (!isObj(c)) return c;
  return {
    id: pick(c, 'id'),
    type: pick(c, 'type'),
    label: pick(c, 'label', ''),
    effectiveDate: pick(c, 'effectiveDate', null),
    endDate: pick(c, 'endDate', null),
    date: pick(c, 'date', null),
    mode: pick(c, 'mode', null),
    amountCents: pick(c, 'amountCents', null),
    percentBps: pick(c, 'percentBps', null),
    accountId: pick(c, 'accountId', null),
    fromAccountId: pick(c, 'fromAccountId', null),
    toAccountId: pick(c, 'toAccountId', null),
    recurringId: pick(c, 'recurringId', null),
    categoryId: pick(c, 'categoryId', null),
    interval: pick(c, 'interval', null),
    kind: pick(c, 'kind', null),
    title: pick(c, 'title', ''),
    day: pick(c, 'day', null),
    enabled: pick(c, 'enabled', true),
  };
}

export function normalizeScenario(s) {
  if (!isObj(s)) return s;
  const a = pick(s, 'assumptions', {});
  return {
    id: pick(s, 'id'),
    name: pick(s, 'name'),
    description: pick(s, 'description', ''),
    horizonMonths: pick(s, 'horizonMonths', 12),
    asOfDate: pick(s, 'asOfDate', null),
    assumptions: isObj(a)
      ? {
          investmentGrowthBps: pick(a, 'investmentGrowthBps', null),
          variableSpending: pick(a, 'variableSpending', 'trailing'),
          variableSpendingCents: pick(a, 'variableSpendingCents', null),
          includeSavingsInterest: pick(a, 'includeSavingsInterest', true),
        }
      : a,
    changes: mapArr(pick(s, 'changes', []), normalizeChange),
  };
}

/**
 * Normalize an arbitrary parsed-JSON value into dataset shape. Non-object input is
 * returned unchanged so validation can reject it.
 */
export function normalizeDataset(raw) {
  if (!isObj(raw)) return raw;
  const meta = pick(raw, 'meta', {});
  const settings = pick(raw, 'settings', {});
  const out = {
    schemaVersion: pick(raw, 'schemaVersion'),
    meta: isObj(meta)
      ? {
          name: pick(meta, 'name', 'Imported dataset'),
          kind: pick(meta, 'kind', 'custom'),
          presetId: pick(meta, 'presetId', null),
          description: pick(meta, 'description', ''),
          seq: pick(meta, 'seq', 1),
        }
      : meta,
    settings: isObj(settings)
      ? {
          asOfDate: pick(settings, 'asOfDate'),
          basis: pick(settings, 'basis', 'posted'),
          investmentGrowthBps: pick(settings, 'investmentGrowthBps', 0),
        }
      : settings,
    accounts: mapArr(pick(raw, 'accounts'), normalizeAccount),
    categories: mapArr(pick(raw, 'categories'), normalizeCategory),
    transactions: mapArr(pick(raw, 'transactions'), normalizeTransaction),
    transfers: mapArr(pick(raw, 'transfers', []), normalizeTransfer),
    rules: mapArr(pick(raw, 'rules', []), normalizeRule),
    budgets: mapArr(pick(raw, 'budgets', []), normalizeBudget),
    recurring: mapArr(pick(raw, 'recurring', []), normalizeRecurring),
    goals: mapArr(pick(raw, 'goals', []), normalizeGoal),
    reconciliations: mapArr(pick(raw, 'reconciliations', []), normalizeReconciliation),
    importBatches: mapArr(pick(raw, 'importBatches', []), normalizeImportBatch),
    scenarios: mapArr(pick(raw, 'scenarios', []), normalizeScenario),
  };
  return out;
}

// ----------------------------------------------------------- field validation
/**
 * Declarative field specs. t: id | str | date | month | cents | int | bool | enum | tags | ids
 * required fields must be present and valid; optional ones may be null/undefined/''.
 */
const S = {
  id: { t: 'id', req: true },
  name: (max = LIMITS.name) => ({ t: 'str', req: true, max }),
  str: (max = LIMITS.notes) => ({ t: 'str', max }),
  date: { t: 'date', req: true },
  odate: { t: 'date' },
  month: { t: 'month', req: true },
  cents: { t: 'cents', req: true },
  ocents: { t: 'cents' },
  int: (min, max, req = false) => ({ t: 'int', min, max, req }),
  bool: { t: 'bool', req: true },
  enum: (values, req = true) => ({ t: 'enum', values, req }),
  oid: { t: 'id' },
};

export const FIELD_SPECS = {
  accounts: {
    id: S.id,
    name: S.name(),
    type: S.enum(ACCOUNT_TYPES),
    institution: S.str(LIMITS.name),
    openingCents: S.cents,
    openingDate: S.date,
    status: S.enum(['active', 'archived']),
    archivedDate: S.odate,
    last4: S.str(8),
    aprBps: S.int(0, LIMITS.maxAprBps),
    creditLimitCents: S.ocents,
    scheduledPaymentCents: S.ocents,
    paymentMode: S.enum(PAYMENT_MODES),
    minPaymentBps: S.int(0, 10000),
    minPaymentFloorCents: S.int(0, 100_000_000),
    dueDay: S.int(1, 31),
    statementDay: S.int(1, 31),
    autopayAccountId: S.oid,
    notes: S.str(),
    color: S.str(20),
  },
  categories: {
    id: S.id,
    name: S.name(),
    kind: S.enum(CATEGORY_KINDS),
    group: S.str(LIMITS.name),
    color: S.str(20),
  },
  transactions: {
    id: S.id,
    accountId: S.id,
    date: S.date,
    description: S.name(LIMITS.description),
    merchant: S.str(LIMITS.merchant),
    amountCents: S.cents,
    kind: S.enum(TX_KINDS),
    status: S.enum(TX_STATUSES),
    adjustmentKind: { t: 'enum', values: ADJUSTMENT_KINDS },
    categoryId: S.oid,
    categorySource: { t: 'enum', values: CATEGORY_SOURCES },
    notes: S.str(),
    transferId: S.oid,
    reversalOf: S.oid,
  },
  transfers: { id: S.id, counterparty: S.str(LIMITS.name), memo: S.str(), external: S.bool },
  rules: {
    id: S.id,
    name: S.name(),
    enabled: S.bool,
    priority: S.int(-100000, 100000, true),
    field: S.enum(RULE_FIELDS),
    match: S.enum(RULE_MATCHES),
    pattern: S.name(LIMITS.name),
    categoryId: S.id,
    accountId: S.oid,
    minAmountCents: S.ocents,
    maxAmountCents: S.ocents,
  },
  budgets: {
    id: S.id,
    categoryId: S.id,
    enabled: S.bool,
    rollover: S.bool,
    baseCents: { t: 'cents', req: true, min: 0 },
    startMonth: S.month,
  },
  recurring: {
    id: S.id,
    title: S.name(),
    kind: S.enum(RECURRING_KINDS),
    amountCents: { t: 'cents', req: true, min: 1 },
    accountId: S.id,
    toAccountId: S.oid,
    categoryId: S.oid,
    merchant: S.str(LIMITS.merchant),
    startDate: S.date,
    endDate: S.odate,
    interval: S.enum(INTERVALS),
    active: S.bool,
    group: S.enum(RECURRING_GROUPS),
    businessDay: S.enum(BUSINESS_DAY_MODES),
    notes: S.str(),
  },
  goals: {
    id: S.id,
    name: S.name(),
    targetCents: { t: 'cents', req: true, min: 1 },
    targetDate: S.date,
    accountId: S.oid,
    priority: S.int(-100000, 100000, true),
    note: S.str(),
  },
  reconciliations: {
    id: S.id,
    accountId: S.id,
    startDate: S.date,
    endDate: S.date,
    openingCents: S.cents,
    closingCents: S.cents,
    status: S.enum(['in_progress', 'completed']),
    calculatedCents: S.ocents,
    discrepancyCents: S.ocents,
    adjustmentTxId: S.oid,
    note: S.str(),
  },
  importBatches: {
    id: S.id,
    accountId: S.id,
    fileName: S.str(200),
    status: S.enum(['committed', 'undone']),
    rowCount: S.int(0, 10_000_000),
    skippedCount: S.int(0, 10_000_000),
    rejectedCount: S.int(0, 10_000_000),
  },
  scenarios: {
    id: S.id,
    name: S.name(),
    description: S.str(),
    horizonMonths: S.int(1, 120, true),
    asOfDate: S.odate,
  },
};

/** Describe a value's type for error messages. */
function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Validate one field against a spec; returns an error message or null.
 * @param {*} v @param {{t:string, req?:boolean}} spec @param {string} label
 */
export function checkField(v, spec, label) {
  const missing = v === undefined || v === null || (spec.t !== 'str' && v === '');
  if (missing) return spec.req ? `${label} is required.` : null;
  switch (spec.t) {
    case 'id':
      if (typeof v !== 'string' || v.trim() === '') return `${label} must be a non-empty string (got ${typeName(v)}).`;
      if (v.length > 120) return `${label} is longer than 120 characters.`;
      return null;
    case 'str':
      if (typeof v !== 'string') return `${label} must be text (got ${typeName(v)}).`;
      if (spec.req && v.trim() === '') return `${label} is required.`;
      if (spec.max && v.length > spec.max) return `${label} is longer than ${spec.max} characters.`;
      return null;
    case 'date':
      return isValidDate(v) ? null : `${label} "${String(v)}" is not a valid calendar date (YYYY-MM-DD).`;
    case 'month':
      return isValidMonth(v) ? null : `${label} "${String(v)}" is not a valid month (YYYY-MM).`;
    case 'cents':
      if (!isValidCents(v)) return `${label} must be a whole number of cents within +/- 100,000,000,000 (got ${typeof v === 'number' ? v : typeName(v)}).`;
      if (spec.min !== undefined && v < spec.min) return `${label} must be at least ${spec.min} cents.`;
      return null;
    case 'int':
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return `${label} must be a whole number (got ${typeof v === 'number' ? v : typeName(v)}).`;
      if (spec.min !== undefined && v < spec.min) return `${label} must be at least ${spec.min}.`;
      if (spec.max !== undefined && v > spec.max) return `${label} must be at most ${spec.max}.`;
      return null;
    case 'bool':
      return typeof v === 'boolean' ? null : `${label} must be true or false (got ${typeName(v)}).`;
    case 'enum':
      return spec.values.includes(v) ? null : `${label} "${String(v)}" must be one of: ${spec.values.join(', ')}.`;
    default:
      return null;
  }
}

/** Helper used across the app: generate an ID that cannot collide with existing ones. */
export function collectIds(list) {
  const ids = new Set();
  if (Array.isArray(list)) for (const e of list) if (isObj(e) && typeof e.id === 'string') ids.add(e.id);
  return ids;
}

/**
 * Allocate the next ID for a collection inside an Immer draft (or plain object).
 * IDs look like "tx-000123"; the dataset-wide counter guarantees determinism and
 * the existence check guarantees uniqueness even for imported datasets.
 */
export function allocId(data, prefix, collection) {
  const ids = collectIds(data[collection]);
  let n = data.meta.seq;
  let id;
  do {
    id = `${prefix}-${String(n).padStart(6, '0')}`;
    n += 1;
  } while (ids.has(id));
  data.meta.seq = n;
  return id;
}

export { isObj };
