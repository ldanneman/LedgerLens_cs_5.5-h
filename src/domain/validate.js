/**
 * Structural validation of a dataset (the "boundary" validator). It is used when:
 *  - loading persisted state,
 *  - importing JSON / loading a Test Lab dataset,
 *  - committing EVERY mutation (a mutation that would leave blocking errors is rejected).
 *
 * It never throws on malformed input: anything unexpected becomes a finding.
 * Findings: { severity:'error'|'warning'|'info', code, message, refs:[{type,id}], blocking }.
 * 'error' findings block calculation/commit; warnings and info are advisory.
 */
import {
  SCHEMA_VERSION,
  COLLECTIONS,
  COLLECTION_LABELS,
  FIELD_SPECS,
  BASES,
  LOAN_TYPES,
  GOAL_ALLOCATIONS,
  SOURCE_TYPES,
  checkField,
  isObj,
} from './schema.js';
import { isValidCents } from './money.js';
import { isValidDate, isValidMonth } from './dates.js';
import { validateChange } from '../forecast/changes.js';
import { settlersOf, ownership, describeOwner } from './batches.js';

const LIMITS_NOTES = 2000;

/** Create a finding. */
export function finding(severity, code, message, refs = []) {
  return { severity, code, message, refs, blocking: severity === 'error' };
}

/** @param {Array} findings @returns {boolean} true when any finding blocks calculation. */
export function hasBlocking(findings) {
  return findings.some((f) => f.blocking);
}

/**
 * Validate dataset structure, references and arithmetic invariants.
 * @param {*} data
 * @returns {Array<object>} findings
 */
export function validateStructure(data) {
  const out = [];
  try {
    run(data, out);
  } catch (e) {
    out.push(finding('error', 'unexpected-structure', `The dataset has an unexpected structure that could not be checked (${e instanceof Error ? e.message : String(e)}).`));
  }
  return out;
}

function run(data, out) {
  const err = (code, msg, refs) => out.push(finding('error', code, msg, refs));
  const warn = (code, msg, refs) => out.push(finding('warning', code, msg, refs));
  const info = (code, msg, refs) => out.push(finding('info', code, msg, refs));

  if (!isObj(data)) {
    err('not-an-object', 'The dataset must be an object.');
    return;
  }
  if (data.schemaVersion !== SCHEMA_VERSION) err('schema-version', `schemaVersion must be ${SCHEMA_VERSION} (found ${String(data.schemaVersion)}).`);
  if (!isObj(data.meta)) err('meta-missing', 'meta must be an object.');
  else {
    if (!Number.isSafeInteger(data.meta.seq) || data.meta.seq < 1) err('meta-seq', 'meta.seq must be a positive whole number.');
    // shown in the header and the Test Lab, so they must be text (an object here used to crash the page)
    for (const [field, spec] of [['name', { t: 'str', req: true, max: 200 }], ['kind', { t: 'str', max: 40 }], ['presetId', { t: 'id' }], ['description', { t: 'str', max: LIMITS_NOTES }]]) {
      const m = checkField(data.meta[field], spec, `meta.${field}`);
      if (m) err('meta-field', m);
    }
  }
  if (!isObj(data.settings)) err('settings-missing', 'settings must be an object.');
  else {
    const m1 = checkField(data.settings.asOfDate, { t: 'date', req: true }, 'settings.asOfDate');
    if (m1) err('settings-asof', m1);
    if (!BASES.includes(data.settings.basis)) err('settings-basis', `settings.basis must be one of: ${BASES.join(', ')}.`);
    const g = data.settings.investmentGrowthBps;
    if (!Number.isSafeInteger(g) || g < -5000 || g > 5000) err('settings-growth', 'settings.investmentGrowthBps must be a whole number between -5000 and 5000 (basis points).');
  }

  // --- collections: array-ness, object-ness, field specs, unique ids
  const ids = {};
  const broken = new Set();
  for (const name of COLLECTIONS) {
    const list = data[name];
    ids[name] = new Set();
    if (!Array.isArray(list)) {
      err('collection-not-array', `${name} must be an array (found ${list === undefined ? 'nothing' : list === null ? 'null' : typeof list}).`);
      broken.add(name);
      continue;
    }
    const spec = FIELD_SPECS[name] || {};
    list.forEach((e, i) => {
      if (!isObj(e)) {
        err('entity-not-object', `${COLLECTION_LABELS[name]} #${i + 1} is not an object.`);
        return;
      }
      const label = `${COLLECTION_LABELS[name]} ${typeof e.id === 'string' ? `"${e.id}"` : `#${i + 1}`}`;
      for (const [field, s] of Object.entries(spec)) {
        const m = checkField(e[field], s, `${label}: ${field}`);
        if (m) err(s.t === 'date' || s.t === 'month' ? 'bad-date' : s.t === 'cents' ? 'bad-money' : 'field-invalid', m, [{ type: name, id: typeof e.id === 'string' ? e.id : String(i) }]);
      }
      if (typeof e.id === 'string') {
        if (ids[name].has(e.id)) err('duplicate-id', `Duplicate ${COLLECTION_LABELS[name].toLowerCase()} id "${e.id}".`, [{ type: name, id: e.id }]);
        ids[name].add(e.id);
      }
    });
  }
  const ok = (name) => !broken.has(name);
  const accounts = ok('accounts') ? new Map(data.accounts.filter(isObj).map((a) => [a.id, a])) : new Map();
  const categories = ok('categories') ? new Map(data.categories.filter(isObj).map((c) => [c.id, c])) : new Map();
  const txs = ok('transactions') ? new Map(data.transactions.filter(isObj).map((t) => [t.id, t])) : new Map();
  const recurring = ok('recurring') ? new Map(data.recurring.filter(isObj).map((r) => [r.id, r])) : new Map();
  const transfers = ok('transfers') ? new Map(data.transfers.filter(isObj).map((t) => [t.id, t])) : new Map();
  const batches = ok('importBatches') ? new Map(data.importBatches.filter(isObj).map((b) => [b.id, b])) : new Map();

  // --- accounts
  if (ok('accounts')) {
    for (const a of data.accounts.filter(isObj)) {
      const ref = [{ type: 'accounts', id: a.id }];
      if (a.autopayAccountId && !accounts.has(a.autopayAccountId)) err('missing-ref', `Account "${a.name}" autopay account "${a.autopayAccountId}" does not exist.`, ref);
      if (a.loan) {
        if (!LOAN_TYPES.includes(a.type)) warn('loan-on-nonloan', `Account "${a.name}" has loan terms but is not a loan type.`, ref);
        if (!isObj(a.loan)) err('field-invalid', `Account "${a.name}": loan must be an object.`, ref);
        else {
          const m1 = checkField(a.loan.originalPrincipalCents, { t: 'cents', req: true, min: 1 }, `Account "${a.name}": loan.originalPrincipalCents`);
          const m2 = checkField(a.loan.termMonths, { t: 'int', min: 1, max: 600, req: true }, `Account "${a.name}": loan.termMonths`);
          const m3 = checkField(a.loan.startDate, { t: 'date', req: true }, `Account "${a.name}": loan.startDate`);
          [m1, m2, m3].filter(Boolean).forEach((m) => err('field-invalid', m, ref));
        }
      }
      if (a.status === 'archived' && a.archivedDate && !isValidDate(a.archivedDate)) err('field-invalid', `Account "${a.name}": archivedDate is not a valid date.`, ref);
    }
  }

  // --- transactions
  const crossOk = ok('transactions') && ok('accounts');
  if (ok('transactions')) {
    for (const t of data.transactions.filter(isObj)) {
      const ref = [{ type: 'transactions', id: t.id }];
      const nm = `Transaction "${typeof t.description === 'string' ? t.description : t.id}" (${t.id})`;
      const acct = accounts.get(t.accountId);
      if (ok('accounts') && typeof t.accountId === 'string' && !acct) err('missing-account', `${nm} references unknown account "${t.accountId}".`, ref);
      if (typeof t.amountCents === 'number' && isValidCents(t.amountCents) && t.amountCents === 0) err('zero-amount', `${nm} has a zero amount.`, ref);
      if (!Array.isArray(t.tags)) err('field-invalid', `${nm}: tags must be an array.`, ref);
      else if (t.tags.some((x) => typeof x !== 'string' || x.length > 30 || x.trim() === '')) err('field-invalid', `${nm}: tags must be non-empty text up to 30 characters.`, ref);
      if (!isObj(t.source)) err('field-invalid', `${nm}: source must be an object.`, ref);
      else {
        if (!SOURCE_TYPES.includes(t.source.type)) err('field-invalid', `${nm}: source.type "${String(t.source.type)}" is not valid.`, ref);
        for (const [field, spec] of [['externalId', { t: 'str', max: 120 }], ['batchId', { t: 'id' }], ['importedAt', { t: 'str', max: 40 }], ['rawDescription', { t: 'str', max: LIMITS_NOTES }]]) {
          const m = checkField(t.source[field], spec, `${nm}: source.${field}`);
          if (m) err('field-invalid', m, ref);
        }
        if (typeof t.source.batchId === 'string' && t.source.batchId && ok('importBatches') && !batches.has(t.source.batchId)) err('missing-ref', `${nm} references unknown import batch "${t.source.batchId}".`, ref);
      }
      if (t.recurrence) {
        if (!isObj(t.recurrence)) err('field-invalid', `${nm}: recurrence must be an object.`, ref);
        else {
          if (ok('recurring') && !recurring.has(t.recurrence.ruleId)) err('missing-ref', `${nm} is linked to unknown recurring rule "${String(t.recurrence.ruleId)}".`, ref);
          if (!isValidDate(t.recurrence.occurrence)) err('field-invalid', `${nm}: recurrence.occurrence is not a valid date.`, ref);
        }
      }
      // category rules per kind
      const cat = t.categoryId ? categories.get(t.categoryId) : null;
      if (t.categoryId && ok('categories') && !cat) err('missing-category', `${nm} references unknown category "${t.categoryId}".`, ref);
      if (t.kind === 'transfer' || t.kind === 'adjustment') {
        if (t.categoryId) err('category-on-noncash', `${nm} is a ${t.kind} and cannot have a category.`, ref);
        if (Array.isArray(t.splits) && t.splits.length) err('splits-on-noncash', `${nm} is a ${t.kind} and cannot be split.`, ref);
      } else if (cat && cat.kind !== t.kind) {
        err('category-kind-mismatch', `${nm} is ${t.kind} but uses the ${cat.kind} category "${cat.name}".`, ref);
      }
      if (t.kind === 'adjustment' && !t.adjustmentKind) err('adjustment-kind', `${nm} is an adjustment and needs an adjustment kind (valuation or correction).`, ref);
      if (t.kind !== 'adjustment' && t.adjustmentKind) warn('adjustment-kind', `${nm} has an adjustment kind but is not an adjustment.`, ref);
      // splits
      if (!Array.isArray(t.splits)) err('field-invalid', `${nm}: splits must be an array.`, ref);
      else if (t.splits.length) {
        if (t.splits.length > 25) err('too-many-splits', `${nm} has more than 25 splits.`, ref);
        let sum = 0;
        let sumValid = true;
        t.splits.forEach((s, i) => {
          if (!isObj(s)) {
            err('field-invalid', `${nm}: split #${i + 1} is not an object.`, ref);
            sumValid = false;
            return;
          }
          if (!isValidCents(s.amountCents) || s.amountCents === 0) {
            err('split-amount', `${nm}: split #${i + 1} amount must be a non-zero whole number of cents.`, ref);
            sumValid = false;
          } else {
            sum += s.amountCents;
            if (typeof t.amountCents === 'number' && Math.sign(s.amountCents) !== Math.sign(t.amountCents)) err('split-sign', `${nm}: split #${i + 1} has the opposite sign to the transaction.`, ref);
          }
          const noteMsg = checkField(s.note, { t: 'str', max: 200 }, `${nm}: split #${i + 1} note`);
          if (noteMsg) err('field-invalid', noteMsg, ref);
          const sc = categories.get(s.categoryId);
          if (!s.categoryId) err('split-category', `${nm}: split #${i + 1} needs a category.`, ref);
          else if (ok('categories') && !sc) err('missing-category', `${nm}: split #${i + 1} references unknown category "${s.categoryId}".`, ref);
          else if (sc && sc.kind !== t.kind) err('category-kind-mismatch', `${nm}: split #${i + 1} uses the ${sc.kind} category "${sc.name}" on a ${t.kind} transaction.`, ref);
        });
        if (sumValid && isValidCents(t.amountCents) && sum !== t.amountCents) {
          err('split-sum', `${nm}: splits add up to ${sum} cents but the transaction is ${t.amountCents} cents (difference ${t.amountCents - sum}).`, ref);
        }
        if (t.categoryId) warn('split-and-category', `${nm} has both splits and a category; the splits take precedence.`, ref);
      }
      // transfers linkage
      if (t.kind === 'transfer') {
        if (!t.transferId) err('transfer-unlinked', `${nm} is a transfer without a transfer id.`, ref);
        else if (ok('transfers') && !transfers.has(t.transferId)) err('transfer-missing', `${nm} references unknown transfer "${t.transferId}".`, ref);
      } else if (t.transferId) err('transfer-on-nontransfer', `${nm} has a transfer id but is not a transfer.`, ref);
      // dates vs account
      if (acct && isValidDate(t.date)) {
        if (isValidDate(acct.openingDate) && t.date < acct.openingDate) warn('before-opening', `${nm} is dated ${t.date}, before the opening date of "${acct.name}" (${acct.openingDate}).`, ref);
        if (acct.status === 'archived' && acct.archivedDate && isValidDate(acct.archivedDate) && t.date > acct.archivedDate) warn('after-archive', `${nm} is dated after "${acct.name}" was archived.`, ref);
      }
    }
  }

  // --- transfers
  if (ok('transfers') && crossOk) {
    for (const tr of data.transfers.filter(isObj)) {
      const ref = [{ type: 'transfers', id: tr.id }];
      if (!Array.isArray(tr.legIds)) {
        err('field-invalid', `Transfer "${tr.id}": legIds must be an array.`, ref);
        continue;
      }
      const legs = [];
      for (const lid of tr.legIds) {
        const leg = txs.get(lid);
        if (!leg) err('transfer-leg-missing', `Transfer "${tr.id}" refers to missing transaction "${String(lid)}".`, [...ref, { type: 'transactions', id: String(lid) }]);
        else {
          legs.push(leg);
          if (leg.kind !== 'transfer' || leg.transferId !== tr.id) err('transfer-leg-mismatch', `Transaction "${leg.id}" is listed as a leg of transfer "${tr.id}" but is not linked back to it.`, [...ref, { type: 'transactions', id: leg.id }]);
        }
      }
      if (tr.external) {
        if (tr.legIds.length !== 1) err('transfer-legs', `External transfer "${tr.id}" must have exactly one leg (has ${tr.legIds.length}).`, ref);
      } else {
        if (tr.legIds.length !== 2) err('transfer-legs', `Transfer "${tr.id}" must have exactly two legs (has ${tr.legIds.length}).`, ref);
        else if (legs.length === 2) {
          const [a, b] = legs;
          if (a.accountId === b.accountId) err('transfer-same-account', `Transfer "${tr.id}" has both legs in the same account.`, ref);
          if (isValidCents(a.amountCents) && isValidCents(b.amountCents) && a.amountCents + b.amountCents !== 0) {
            err('transfer-unbalanced', `Transfer "${tr.id}" does not balance: legs sum to ${a.amountCents + b.amountCents} cents instead of 0.`, [...ref, { type: 'transactions', id: a.id }, { type: 'transactions', id: b.id }]);
          }
          if (a.status !== b.status) {
            err('transfer-status-mismatch', `Transfer "${tr.id}" is ${String(a.status)} on one side ("${a.description}", ${a.id}) and ${String(b.status)} on the other ("${b.description}", ${b.id}). Both legs of an internal transfer must share one status; otherwise posted balances and net worth are wrong by the transfer amount.`, [...ref, { type: 'transactions', id: a.id }, { type: 'transactions', id: b.id }]);
          }
          if (a.date !== b.date) info('transfer-dates', `Transfer "${tr.id}" legs are dated differently (${a.date} / ${b.date}).`, ref);
        }
      }
    }
    for (const t of data.transactions.filter(isObj)) {
      if (t.kind === 'transfer' && t.transferId && transfers.has(t.transferId) && !transfers.get(t.transferId).legIds?.includes?.(t.id)) {
        err('transfer-not-listed', `Transaction "${t.id}" claims transfer "${t.transferId}" but the transfer does not list it as a leg.`, [{ type: 'transactions', id: t.id }]);
      }
    }
  }

  // --- rules / budgets / recurring / goals
  if (ok('rules')) {
    for (const r of data.rules.filter(isObj)) {
      const ref = [{ type: 'rules', id: r.id }];
      if (ok('categories') && r.categoryId && !categories.has(r.categoryId)) err('missing-category', `Rule "${r.name}" references unknown category "${r.categoryId}".`, ref);
      if (r.accountId && ok('accounts') && !accounts.has(r.accountId)) err('missing-account', `Rule "${r.name}" references unknown account "${r.accountId}".`, ref);
      if (isValidCents(r.minAmountCents) && isValidCents(r.maxAmountCents) && r.minAmountCents > r.maxAmountCents) err('rule-range', `Rule "${r.name}": minimum amount is above the maximum.`, ref);
    }
  }
  if (ok('budgets')) {
    const seen = new Set();
    for (const b of data.budgets.filter(isObj)) {
      const ref = [{ type: 'budgets', id: b.id }];
      const cat = categories.get(b.categoryId);
      if (ok('categories') && b.categoryId && !cat) err('missing-category', `Budget "${b.id}" references unknown category "${b.categoryId}".`, ref);
      else if (cat && cat.kind !== 'expense') err('budget-income-category', `Budget "${b.id}" is for the income category "${cat.name}"; budgets apply to expense categories.`, ref);
      if (seen.has(b.categoryId)) err('duplicate-budget', `More than one budget exists for category "${b.categoryId}".`, ref);
      seen.add(b.categoryId);
      if (!Array.isArray(b.overrides)) err('field-invalid', `Budget "${b.id}": overrides must be an array.`, ref);
      else {
        const months = new Set();
        for (const o of b.overrides) {
          if (!isObj(o) || !isValidMonth(o.month)) err('field-invalid', `Budget "${b.id}": an override has an invalid month.`, ref);
          else if (!isValidCents(o.amountCents) || o.amountCents < 0) err('field-invalid', `Budget "${b.id}": override for ${o.month} must be zero or more (whole cents).`, ref);
          else if (months.has(o.month)) err('field-invalid', `Budget "${b.id}": duplicate override for ${o.month}.`, ref);
          else months.add(o.month);
        }
      }
    }
  }
  if (ok('recurring')) {
    for (const r of data.recurring.filter(isObj)) {
      const ref = [{ type: 'recurring', id: r.id }];
      if (ok('accounts') && r.accountId && !accounts.has(r.accountId)) err('missing-account', `Recurring "${r.title}" references unknown account "${r.accountId}".`, ref);
      if (r.kind === 'transfer') {
        if (!r.toAccountId) err('field-invalid', `Recurring "${r.title}" is a transfer and needs a destination account.`, ref);
        else if (ok('accounts') && !accounts.has(r.toAccountId)) err('missing-account', `Recurring "${r.title}" references unknown destination account "${r.toAccountId}".`, ref);
        else if (r.toAccountId === r.accountId) err('field-invalid', `Recurring "${r.title}": source and destination must differ.`, ref);
      }
      const cat = r.categoryId ? categories.get(r.categoryId) : null;
      if (r.categoryId && ok('categories') && !cat) err('missing-category', `Recurring "${r.title}" references unknown category "${r.categoryId}".`, ref);
      else if (cat && r.kind !== 'transfer' && cat.kind !== r.kind) err('category-kind-mismatch', `Recurring "${r.title}" is ${r.kind} but uses the ${cat.kind} category "${cat.name}".`, ref);
      if (isValidDate(r.startDate) && isValidDate(r.endDate) && r.endDate < r.startDate) err('field-invalid', `Recurring "${r.title}": end date is before the start date.`, ref);
      if (!Array.isArray(r.skipped) || r.skipped.some((d) => !isValidDate(d))) err('field-invalid', `Recurring "${r.title}": skipped must be a list of valid dates.`, ref);
    }
  }
  if (ok('goals')) {
    for (const g of data.goals.filter(isObj)) {
      const ref = [{ type: 'goals', id: g.id }];
      if (g.accountId && ok('accounts') && !accounts.has(g.accountId)) err('missing-account', `Goal "${g.name}" references unknown account "${g.accountId}".`, ref);
      if (!isObj(g.allocation) || !GOAL_ALLOCATIONS.includes(g.allocation.type)) err('field-invalid', `Goal "${g.name}": allocation type must be one of ${GOAL_ALLOCATIONS.join(', ')}.`, ref);
      else {
        const v = g.allocation.value;
        if (g.allocation.type === 'fixed' && !(isValidCents(v) && v >= 0)) err('field-invalid', `Goal "${g.name}": fixed allocation must be a non-negative amount in cents.`, ref);
        if (g.allocation.type === 'percent' && !(Number.isSafeInteger(v) && v >= 0 && v <= 10000)) err('field-invalid', `Goal "${g.name}": percent allocation must be 0-10000 basis points.`, ref);
        if ((g.allocation.type === 'full' || g.allocation.type === 'manual') && v !== null && v !== undefined && !(Number.isSafeInteger(v) && v >= 0)) err('field-invalid', `Goal "${g.name}": allocation value must be a whole number (it is unused for a ${g.allocation.type} allocation; use 0).`, ref);
        if (g.allocation.type !== 'manual' && !g.accountId) err('field-invalid', `Goal "${g.name}" needs a linked account for a ${g.allocation.type} allocation.`, ref);
      }
      if (!Array.isArray(g.contributions)) err('field-invalid', `Goal "${g.name}": contributions must be an array.`, ref);
      else if (g.contributions.some((c) => !isObj(c) || !isValidDate(c.date) || !isValidCents(c.amountCents))) err('field-invalid', `Goal "${g.name}": a contribution has an invalid date or amount.`, ref);
      else if (g.contributions.some((c) => checkField(c.note, { t: 'str', max: 200 }, 'note'))) err('field-invalid', `Goal "${g.name}": a contribution note must be text.`, ref);
    }
  }

  // --- reconciliations
  // Completed-statement model: `clearedTxIds` and `snapshots` describe the SAME transactions (one snapshot per
  // cleared id, copied when the statement was completed), opening + sum(snapshot amounts) = closing, discrepancy 0.
  // Drafts carry no snapshots. Snapshots are history: a transaction edited, moved or deleted AFTER completion makes
  // the statement stale (a warning here; "out of date" in reconciliationHealth) - that is not malformed data.
  // A malformed snapshot is an error with its index; nothing is filtered out or counted as zero.
  if (ok('reconciliations') && ok('transactions')) {
    for (const r of data.reconciliations.filter(isObj)) {
      const ref = [{ type: 'reconciliations', id: r.id }];
      const rid = `Reconciliation "${r.id}"`;
      if (ok('accounts') && r.accountId && !accounts.has(r.accountId)) err('missing-account', `${rid} references unknown account "${r.accountId}".`, ref);
      if (isValidDate(r.startDate) && isValidDate(r.endDate) && r.endDate < r.startDate) err('field-invalid', `${rid}: end date is before the start date.`, ref);
      if (!Array.isArray(r.clearedTxIds) || r.clearedTxIds.some((x) => typeof x !== 'string' || x.trim() === '')) {
        err('field-invalid', `${rid}: clearedTxIds must be a list of transaction ids.`, ref);
        continue;
      }
      if (new Set(r.clearedTxIds).size !== r.clearedTxIds.length) err('field-invalid', `${rid} lists the same transaction more than once.`, ref);
      const snaps = new Map();
      let snapSum = 0;
      let snapsOk = Array.isArray(r.snapshots);
      if (!snapsOk) err('recon-snapshot', `${rid}: snapshots must be a list (found ${r.snapshots === null ? 'null' : typeof r.snapshots}).`, ref);
      else {
        if (r.status !== 'completed' && r.snapshots.length) err('recon-snapshot', `${rid} is a draft but carries ${r.snapshots.length} snapshot(s); only completed reconciliations have snapshots.`, ref);
        r.snapshots.forEach((x, i) => {
          const at = `${rid}, snapshot #${i + 1}`;
          if (!isObj(x)) {
            err('recon-snapshot', `${at} must be an object (found ${x === null ? 'null' : Array.isArray(x) ? 'a list' : typeof x}).`, ref);
            snapsOk = false;
            return;
          }
          const bad = [];
          if (typeof x.txId !== 'string' || x.txId.trim() === '') bad.push('txId must be a transaction id');
          if (!isValidCents(x.amountCents) || x.amountCents === 0) bad.push(`amountCents must be a non-zero whole number of cents (found ${x.amountCents === undefined ? 'nothing' : JSON.stringify(x.amountCents)})`);
          if (!isValidDate(x.date)) bad.push(x.date === undefined || x.date === null ? 'date is missing' : `date ${JSON.stringify(x.date)} is not a valid calendar date`);
          if (x.status !== 'posted') bad.push(`status must be "posted" (only posted transactions can be cleared)`);
          if (x.accountId !== null && x.accountId !== undefined && x.accountId !== r.accountId) bad.push(`accountId ${JSON.stringify(x.accountId)} is not the reconciliation's account`);
          if (bad.length) {
            err('recon-snapshot', `${at}: ${bad.join('; ')}.`, ref);
            snapsOk = false;
            return;
          }
          if (snaps.has(x.txId)) {
            err('recon-snapshot', `${at}: transaction "${x.txId}" already has a snapshot.`, [...ref, { type: 'transactions', id: x.txId }]);
            snapsOk = false;
            return;
          }
          snaps.set(x.txId, x);
          snapSum += x.amountCents;
        });
      }
      if (r.status === 'completed' && snapsOk) {
        const cleared = new Set(r.clearedTxIds);
        for (const tid of r.clearedTxIds) if (!snaps.has(tid)) err('recon-snapshot', `${rid} is completed but cleared transaction "${tid}" has no snapshot, so later edits to it could not be detected.`, [...ref, { type: 'transactions', id: tid }]);
        for (const tid of snaps.keys()) if (!cleared.has(tid)) err('recon-snapshot', `${rid} has a snapshot of "${tid}", which is not in its cleared list.`, [...ref, { type: 'transactions', id: tid }]);
      }
      for (const tid of r.clearedTxIds) {
        const t = txs.get(tid);
        const history = r.status === 'completed' && snaps.has(tid);
        if (!t) {
          if (history) warn('recon-missing-tx', `${rid} cleared transaction "${tid}", which no longer exists (it was deleted after reconciling).`, [...ref, { type: 'transactions', id: tid }]);
          else err('recon-missing-tx', `${rid} refers to unknown transaction "${tid}".`, [...ref, { type: 'transactions', id: tid }]);
        } else if (t.accountId !== r.accountId) {
          if (history) warn('recon-wrong-account', `${rid} cleared "${tid}", which was moved to another account after reconciling.`, [...ref, { type: 'transactions', id: tid }]);
          else err('recon-wrong-account', `${rid} clears "${tid}", which belongs to a different account.`, [...ref, { type: 'transactions', id: tid }]);
        }
      }
      if (r.status === 'completed') {
        if (r.discrepancyCents !== 0) err('recon-discrepancy', `${rid} is marked completed but its discrepancy is ${String(r.discrepancyCents)} cents.`, ref);
        if (snapsOk && isValidCents(r.openingCents) && isValidCents(r.closingCents)) {
          if (r.openingCents + snapSum !== r.closingCents) err('recon-math', `${rid}: opening ${r.openingCents} + cleared ${snapSum} does not equal closing ${r.closingCents}.`, ref);
          else if (r.calculatedCents !== null && r.calculatedCents !== undefined && r.calculatedCents !== r.closingCents) err('recon-math', `${rid}: calculated close ${String(r.calculatedCents)} does not equal the statement close ${r.closingCents}.`, ref);
        }
      }
    }
  }

  // --- import batches (ownership rules: batches.js)
  if (ok('importBatches') && ok('accounts')) {
    const settlers = settlersOf(data.importBatches);
    const claimedBy = new Map(); // txId -> committed batch that lists it as created
    for (const b of data.importBatches.filter(isObj)) {
      const ref = [{ type: 'importBatches', id: b.id }];
      const bid = `Import batch "${b.id}"`;
      if (b.accountId && !accounts.has(b.accountId)) err('missing-account', `${bid} references unknown account "${b.accountId}".`, ref);
      const listOk = Array.isArray(b.createdTxIds) && b.createdTxIds.every((x) => typeof x === 'string' && x.trim() !== '');
      if (!listOk) err('field-invalid', `${bid}: createdTxIds must be a list of transaction ids.`, ref);
      else if (new Set(b.createdTxIds).size !== b.createdTxIds.length) err('batch-ownership', `${bid} lists the same created transaction more than once.`, ref);
      const created = new Set(listOk ? b.createdTxIds : []);
      if (!Array.isArray(b.settled)) err('field-invalid', `${bid}: settled must be a list (found ${b.settled === null ? 'null' : typeof b.settled}).`, ref);
      else {
        const seen = new Set();
        b.settled.forEach((x, i) => {
          const at = `${bid}, settled #${i + 1}`;
          if (!isObj(x)) return err('batch-settled', `${at} must be an object.`, ref);
          if (typeof x.txId !== 'string' || x.txId.trim() === '') return err('batch-settled', `${at}: txId must be a transaction id.`, ref);
          if (seen.has(x.txId)) err('batch-settled', `${at}: "${x.txId}" is listed twice.`, ref);
          seen.add(x.txId);
          if (created.has(x.txId)) err('batch-ownership', `${bid} lists "${x.txId}" as both created and settled.`, ref);
          if (!isObj(x.before)) return err('batch-settled', `${at} ("${x.txId}"): before must be the pending transaction as it was before the import.`, ref);
          const bf = x.before;
          const bad = [];
          for (const [field, spec] of Object.entries(FIELD_SPECS.transactions)) {
            const m = checkField(bf[field], spec, field);
            if (m) bad.push(m);
          }
          if (bf.id !== x.txId) bad.push(`its id ${JSON.stringify(bf.id)} is not "${x.txId}"`);
          if (b.accountId && bf.accountId !== b.accountId) bad.push("it is not in the batch's account");
          if (bf.status !== 'pending') bad.push('only a pending transaction can have been settled');
          if (!Array.isArray(bf.splits) || bf.splits.some((y) => !isObj(y) || !isValidCents(y.amountCents))) bad.push('splits must be a list of whole-cent amounts');
          else if (bf.splits.length && bf.splits.reduce((sum, y) => sum + y.amountCents, 0) !== bf.amountCents) bad.push('its splits do not add up to its amount');
          if (!isObj(bf.source)) bad.push('source must be an object');
          if (bad.length) err('batch-settled', `${at} ("${x.txId}"): ${bad.slice(0, 3).join('; ')}.`, ref);
          const live = txs.get(x.txId);
          if (b.status === 'committed' && live && ownership(b.id, live, settlers) === 'foreign') err('batch-ownership', `${bid} says it settled "${x.txId}" ("${live.description}"), but that transaction is ${describeOwner(live)}; undoing the batch would overwrite it.`, [...ref, { type: 'transactions', id: x.txId }]);
          return undefined;
        });
      }
      if (listOk && b.status === 'committed' && ok('transactions')) {
        for (const id of b.createdTxIds) {
          const other = claimedBy.get(id);
          if (other && other !== b.id) err('batch-ownership', `Transaction "${id}" is listed as created by two import batches ("${other}" and "${b.id}").`, [...ref, { type: 'transactions', id }]);
          claimedBy.set(id, b.id);
          const live = txs.get(id);
          if (live && ownership(b.id, live, settlers) === 'foreign') err('batch-ownership', `${bid} lists "${id}" ("${live.description}") as created by the import, but that transaction is ${describeOwner(live)}. Undoing the batch would delete an unrelated record.`, [...ref, { type: 'transactions', id }]);
        }
      }
    }
  }

  // --- scenarios
  if (ok('scenarios')) {
    const refs = { accounts, recurring };
    for (const s of data.scenarios.filter(isObj)) {
      const ref = [{ type: 'scenarios', id: s.id }];
      if (!Array.isArray(s.changes)) {
        err('field-invalid', `Scenario "${s.name}": changes must be an array.`, ref);
        continue;
      }
      if (!isObj(s.assumptions)) err('field-invalid', `Scenario "${s.name}": assumptions must be an object.`, ref);
      else {
        const g = s.assumptions.investmentGrowthBps;
        if (g !== null && g !== undefined && !(Number.isSafeInteger(g) && g >= -5000 && g <= 5000)) err('field-invalid', `Scenario "${s.name}": investment growth must be between -50% and +50%.`, ref);
        const v = s.assumptions.variableSpending;
        if (!['trailing', 'none', 'custom'].includes(v)) err('field-invalid', `Scenario "${s.name}": variable spending mode must be trailing, none or custom.`, ref);
        if (v === 'custom' && !(isValidCents(s.assumptions.variableSpendingCents) && s.assumptions.variableSpendingCents >= 0)) err('field-invalid', `Scenario "${s.name}": custom variable spending needs a non-negative monthly amount.`, ref);
        else if (s.assumptions.variableSpendingCents !== null && s.assumptions.variableSpendingCents !== undefined && !isValidCents(s.assumptions.variableSpendingCents)) err('field-invalid', `Scenario "${s.name}": variable spending amount must be whole cents or empty.`, ref);
        if (typeof s.assumptions.includeSavingsInterest !== 'boolean') err('field-invalid', `Scenario "${s.name}": includeSavingsInterest must be true or false.`, ref);
      }
      const cids = new Set();
      s.changes.forEach((c, i) => {
        for (const m of validateChange(c, refs)) err('scenario-change', `Scenario "${s.name}", change #${i + 1}: ${m}`, ref);
        if (isObj(c) && typeof c.id === 'string') {
          if (cids.has(c.id)) err('duplicate-id', `Scenario "${s.name}" has two changes with id "${c.id}".`, ref);
          cids.add(c.id);
        }
      });
    }
  }

  // --- soft checks that help users
  if (ok('accounts') && ok('transactions')) {
    // identical-looking entries are legitimate; mention once so power users know they were noticed
    const seen = new Map();
    for (const t of data.transactions.filter(isObj)) {
      const k = `${t.accountId}|${t.date}|${t.amountCents}|${t.description}`;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const dupGroups = [...seen.values()].filter((n) => n > 1).length;
    if (dupGroups) info('identical-entries', `${dupGroups} group(s) of transactions share account, date, amount and description. They are kept as separate legitimate transactions.`);
  }
}

/**
 * Convenience: validate and return {errors, warnings, info, ok}.
 */
export function summarizeFindings(findings) {
  return {
    errors: findings.filter((f) => f.severity === 'error'),
    warnings: findings.filter((f) => f.severity === 'warning'),
    info: findings.filter((f) => f.severity === 'info'),
    ok: !hasBlocking(findings),
  };
}
