/**
 * Consistency / verification panel engine (spec 17.1).
 *
 * Runs the structural validator and then INDEPENDENT recomputations of the headline numbers
 * (different code paths from the ones the UI uses) and reports real findings - it can and does fail.
 * Each check has a status: pass | warn | fail | skipped. Findings list the records involved and
 * whether they block calculation (severity 'error') or are advisory ('warning' / 'info').
 */
import { validateStructure, finding, summarizeFindings } from './validate.js';
import { buildIndex, balancesAt, netWorthFromBalances, naiveContribution, isLiabilityType } from './ledger.js';
import { summarizePeriod, monthlySeries, categoryBreakdown } from './reports.js';
import { spendByCategoryMonth, computeBudgetChain } from './budgets.js';
import { reconciliationHealth } from './reconciliation.js';
import { addDays, addMonthKey, monthEnd, monthKey, monthStart } from './dates.js';
import { runProjection } from '../forecast/engine.js';
import { compareProjections } from '../forecast/compare.js';
import { categoryParts } from './ledger.js';

const GROUPS = [
  { id: 'ids', title: 'Unique IDs', description: 'No two records in a collection share an id.', codes: ['duplicate-id'] },
  { id: 'refs', title: 'References resolve', description: 'Every account, category, transfer, recurring rule and batch a record points to exists.', codes: ['missing-account', 'missing-category', 'missing-ref', 'transfer-missing', 'transfer-leg-missing', 'transfer-not-listed', 'transfer-leg-mismatch', 'scenario-change', 'not-an-object', 'collection-not-array', 'entity-not-object', 'unexpected-structure', 'schema-version', 'meta-missing', 'meta-seq', 'settings-missing', 'settings-asof', 'settings-basis', 'settings-growth'] },
  { id: 'dates', title: 'Dates are valid calendar dates', description: 'No malformed dates such as 2026-02-30.', codes: ['bad-date'] },
  { id: 'money', title: 'Money is whole cents', description: 'All amounts are finite, integral cents within the supported range; no zero-amount transactions.', codes: ['bad-money', 'zero-amount', 'split-amount'] },
  { id: 'fields', title: 'Fields are well formed', description: 'Required properties exist with the right types.', codes: ['field-invalid', 'category-kind-mismatch', 'category-on-noncash', 'adjustment-kind', 'budget-income-category', 'duplicate-budget', 'transfer-on-nontransfer', 'transfer-unlinked', 'too-many-splits', 'split-category'] },
  { id: 'splits', title: 'Splits equal their parent', description: 'Split rows sum EXACTLY to the transaction amount and share its sign.', codes: ['split-sum', 'split-sign', 'splits-on-noncash', 'split-and-category'] },
  { id: 'transfers', title: 'Transfers balance', description: 'Each internal transfer has two legs in different accounts whose effects sum to zero and which share one status (both pending or both posted).', codes: ['transfer-unbalanced', 'transfer-legs', 'transfer-same-account', 'transfer-status-mismatch', 'transfer-dates'] },
  { id: 'recon', title: 'Reconciliations are coherent', description: 'Completed reconciliations have well-formed snapshots (one per cleared transaction), balance exactly, and still match the transactions of their account; later edits show as out of date.', codes: ['recon-missing-tx', 'recon-wrong-account', 'recon-discrepancy', 'recon-math', 'recon-snapshot', 'recon-stale'] },
  { id: 'batches', title: 'Import batches own what they claim', description: 'Every transaction a batch lists as created is an import record of that batch (undo can never delete a manual or foreign record), and settlement restore data is a valid pending transaction.', codes: ['batch-ownership', 'batch-settled'] },
];

/** Run all checks. `deep:false` skips the heavier independent recomputations. */
export function verifyDataset(data, { deep = true } = {}) {
  const structural = validateStructure(data);
  const blocked = structural.some((f) => f.blocking);
  const findings = [...structural];
  const checks = GROUPS.map((g) => ({ id: g.id, title: g.title, description: g.description, findings: structural.filter((f) => g.codes.includes(f.code)), status: 'pass' }));
  const known = new Set(GROUPS.flatMap((g) => g.codes));
  const other = structural.filter((f) => !known.has(f.code));

  const extra = (id, title, description) => {
    const c = { id, title, description, findings: [], status: 'pass' };
    checks.push(c);
    return c;
  };
  const add = (check, severity, code, message, refs = []) => {
    const f = finding(severity, code, message, refs);
    check.findings.push(f);
    findings.push(f);
  };

  // reconciliation health (stale completed reconciliations) - safe on valid data only
  const reconCheck = checks.find((c) => c.id === 'recon');
  if (!blocked) {
    for (const r of data.reconciliations) {
      const h = reconciliationHealth(data, r);
      if (!h.valid) {
        const f = finding('warning', 'recon-stale', `Completed reconciliation ${r.id} (${r.startDate} to ${r.endDate}) is out of date: ${h.problems.slice(0, 3).map((p) => p.message).join(' ')}${h.problems.length > 3 ? ` (+${h.problems.length - 3} more)` : ''}`, [{ type: 'reconciliations', id: r.id }]);
        reconCheck.findings.push(f);
        findings.push(f);
      }
    }
  }

  // advisory checks on valid data
  const advisory = extra('advisory', 'Advisory observations', 'Unusual but allowed states worth a look.');
  if (!blocked) {
    const index = buildIndex(data);
    const asOf = data.settings.asOfDate;
    for (const a of data.accounts) {
      const posted = naiveContribution(data, a.id, asOf, false);
      const all = naiveContribution(data, a.id, asOf, true);
      if ((a.type === 'checking' || a.type === 'savings') && all < 0) add(advisory, 'warning', 'negative-cash', `${a.name} is overdrawn (${all} cents including pending).`, [{ type: 'accounts', id: a.id }]);
      if (isLiabilityType(a.type) && posted > 0) add(advisory, 'info', 'overpaid-liability', `${a.name} has a credit balance (${posted} cents more than owed).`, [{ type: 'accounts', id: a.id }]);
      if (a.type === 'credit_card' && a.creditLimitCents && -all > a.creditLimitCents) add(advisory, 'warning', 'over-limit', `${a.name} is over its credit limit.`, [{ type: 'accounts', id: a.id }]);
      if (a.status === 'archived' && naiveContribution(data, a.id, '9999-12-31', true) !== 0) add(advisory, 'warning', 'archived-balance', `${a.name} is archived but still holds a balance.`, [{ type: 'accounts', id: a.id }]);
    }
    const stalePending = data.transactions.filter((t) => t.status === 'pending' && t.date < addDays(asOf, -14));
    if (stalePending.length) add(advisory, 'info', 'stale-pending', `${stalePending.length} transaction(s) have been pending for more than 14 days.`, stalePending.slice(0, 5).map((t) => ({ type: 'transactions', id: t.id })));
    void index;
  }

  if (deep && !blocked) {
    const index = buildIndex(data);
    const asOf = data.settings.asOfDate;

    // 1. ledger totals vs independent aggregation
    const ledger = extra('ledger', 'Ledger totals match an independent re-aggregation', 'Net worth and every account balance are recomputed with a separate, unsorted pass over the raw records.');
    for (const includePending of [false, true]) {
      const bal = balancesAt(index, asOf, includePending);
      let naiveTotal = 0;
      for (const a of data.accounts) {
        const naive = naiveContribution(data, a.id, asOf, includePending);
        naiveTotal += naive;
        if (naive !== bal.get(a.id)) add(ledger, 'error', 'ledger-mismatch', `${a.name}: engine says ${bal.get(a.id)} cents but the independent pass says ${naive} (${includePending ? 'pending-inclusive' : 'posted'}).`, [{ type: 'accounts', id: a.id }]);
      }
      const nw = netWorthFromBalances(index, bal).netWorth;
      if (nw !== naiveTotal) add(ledger, 'error', 'networth-mismatch', `Net worth ${nw} differs from the sum of account contributions ${naiveTotal} (${includePending ? 'pending-inclusive' : 'posted'}).`);
    }

    // 2. period identity: net worth change == income - spending + external + valuation + corrections (+ internal net)
    const flow = extra('flow', 'Cash-flow identity holds', 'For each of the last 12 months: change in net worth = income - net spending + external transfers + valuation + corrections. Transfers net to zero.');
    const endMonth = monthKey(asOf);
    for (const includePending of [false, true]) {
      for (let i = 0; i < 12; i += 1) {
        const m = addMonthKey(endMonth, -i);
        const start = monthStart(m);
        const end = monthEnd(m) > asOf ? asOf : monthEnd(m);
        if (end < start) continue;
        const s = summarizePeriod(data, { start, end, includePending });
        const before = netWorthFromBalances(index, balancesAt(index, addDays(start, -1), includePending)).netWorth;
        const after = netWorthFromBalances(index, balancesAt(index, end, includePending)).netWorth;
        const openingAdjust = data.accounts.reduce((sum, a) => sum + (a.openingDate >= start && a.openingDate <= end && a.openingDate > addDays(start, -1) ? a.openingCents : 0), 0);
        if (after - before - openingAdjust !== s.netWorthChangeCents) {
          add(flow, 'error', 'flow-identity', `${m} (${includePending ? 'pending-inclusive' : 'posted'}): net worth moved ${after - before - openingAdjust} cents but income/spending/transfers/adjustments explain ${s.netWorthChangeCents}.`);
        }
        if (s.internalNetCents !== 0) add(flow, 'error', 'transfer-net', `${m}: internal transfers do not net to zero (${s.internalNetCents} cents).`);
      }
    }

    // 3. report internal consistency
    const rep = extra('reports', 'Reports are internally consistent', 'Category, merchant and account breakdowns add up to the headline totals; monthly series add up to the period total.');
    {
      const start = addDays(monthStart(addMonthKey(endMonth, -11)), 0);
      const s = summarizePeriod(data, { start, end: asOf });
      const catSum = categoryBreakdown(data, s, 'expense').reduce((a, r) => a + r.amountCents, 0);
      if (catSum !== s.netExpenseCents) add(rep, 'error', 'category-sum', `Category spending totals ${catSum} cents but net spending is ${s.netExpenseCents}.`);
      const merchSum = [...s.byMerchant.values()].reduce((a, r) => a + r.expenseCents, 0);
      if (merchSum !== s.netExpenseCents) add(rep, 'error', 'merchant-sum', `Merchant spending totals ${merchSum} cents but net spending is ${s.netExpenseCents}.`);
      const incSum = [...s.byCategory.values()].reduce((a, r) => a + r.incomeCents, 0);
      if (incSum !== s.incomeCents) add(rep, 'error', 'income-sum', `Category income totals ${incSum} cents but income is ${s.incomeCents}.`);
      const series = monthlySeries(data, { startMonth: monthKey(start), endMonth, start, end: asOf });
      const seriesIncome = series.reduce((a, r) => a + r.incomeCents, 0);
      const seriesNet = series.reduce((a, r) => a + r.netExpenseCents, 0);
      if (seriesIncome !== s.incomeCents || seriesNet !== s.netExpenseCents) add(rep, 'error', 'series-sum', `Monthly series (${seriesIncome}/${seriesNet}) does not add up to the period totals (${s.incomeCents}/${s.netExpenseCents}).`);
      // every transaction accounted for exactly once: sum of parts == sum of effects for income/expense
      let parts = 0;
      let effects = 0;
      for (const t of data.transactions) {
        if (t.kind !== 'income' && t.kind !== 'expense') continue;
        if (t.status !== 'posted' || t.date < start || t.date > asOf) continue;
        parts += categoryParts(t).reduce((a, p) => a + p.amountCents, 0);
        effects += t.amountCents;
      }
      if (parts !== effects) add(rep, 'error', 'parts-sum', `Split/category parts total ${parts} cents but transaction effects total ${effects}.`);
    }

    // 4. budgets: rollover chain recomputed from raw transactions
    const bud = extra('budgets', 'Budget spending and rollover recompute correctly', 'Each budget month is rebuilt from raw transactions and the rollover chain is re-derived.');
    {
      const spend = spendByCategoryMonth(data, false);
      for (const b of data.budgets) {
        const naive = new Map();
        for (const t of data.transactions) {
          if (t.kind !== 'expense' || t.status !== 'posted') continue;
          for (const p of t.splits.length ? t.splits : [{ categoryId: t.categoryId, amountCents: t.amountCents }]) {
            if (p.categoryId !== b.categoryId) continue;
            const m = monthKey(t.date);
            naive.set(m, (naive.get(m) || 0) - p.amountCents);
          }
        }
        const chain = computeBudgetChain(b, spend.get(b.categoryId), endMonth);
        let carry = 0;
        for (const row of chain) {
          const expectedAvail = row.baseCents + (b.rollover ? carry : 0);
          if (row.availableCents !== expectedAvail) add(bud, 'error', 'rollover', `Budget ${b.id} ${row.month}: available ${row.availableCents} but expected ${expectedAvail}.`, [{ type: 'budgets', id: b.id }]);
          if (row.spentCents !== (naive.get(row.month) || 0)) add(bud, 'error', 'budget-spend', `Budget ${b.id} ${row.month}: spent ${row.spentCents} but raw transactions say ${naive.get(row.month) || 0}.`, [{ type: 'budgets', id: b.id }]);
          carry = b.rollover ? expectedAvail - (naive.get(row.month) || 0) : 0;
        }
      }
    }

    // 5. forecast / scenario self-consistency
    const fc = extra('forecast', 'Projections are deterministic and self-consistent', 'The baseline projection is run twice, checked month by month against its own event log, and compared with itself and with an exact duplicate of each scenario.');
    try {
      const snapshot = JSON.stringify(data);
      const a = runProjection(data, null);
      const b2 = runProjection(data, null);
      const cmp = compareProjections(a, b2);
      if (!cmp.identical) add(fc, 'error', 'projection-nondeterministic', 'Running the same baseline projection twice gave different results.');
      const startNw = netWorthFromBalances(index, balancesAt(index, a.asOfDate, true)).netWorth;
      if (a.start.netWorthCents !== startNw) add(fc, 'error', 'projection-start', `Projection starts at ${a.start.netWorthCents} cents but the pending-inclusive ledger net worth is ${startNw}.`);
      let prev = a.start.netWorthCents;
      for (const m of a.monthly) {
        const eventSum = a.events.filter((e) => e.month === m.month).reduce((s, e) => s + e.nwEffectCents, 0);
        if (m.netWorthCents - prev !== eventSum) add(fc, 'error', 'projection-identity', `Projection ${m.month}: net worth moved ${m.netWorthCents - prev} cents but its events sum to ${eventSum}.`);
        let acctSum = 0;
        for (const v of m.balances.values()) acctSum += v;
        if (acctSum !== m.netWorthCents) add(fc, 'error', 'projection-sum', `Projection ${m.month}: account balances sum to ${acctSum} but net worth is ${m.netWorthCents}.`);
        prev = m.netWorthCents;
      }
      for (const sc of data.scenarios) {
        const dupe = JSON.parse(JSON.stringify(sc));
        dupe.id = `${sc.id}-dup`;
        const cmpSc = compareProjections(runProjection(data, sc), runProjection(data, dupe));
        if (!cmpSc.identical) add(fc, 'error', 'scenario-duplicate', `Scenario "${sc.name}" differs from an exact duplicate of itself.`, [{ type: 'scenarios', id: sc.id }]);
      }
      if (JSON.stringify(data) !== snapshot) add(fc, 'error', 'projection-mutated', 'Running projections modified the dataset.');
      for (const w of a.warnings) add(fc, 'info', 'projection-warning', w.message);
    } catch (e) {
      add(fc, 'error', 'projection-failed', `The projection engine threw an error: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (deep && blocked) {
    for (const [id, title] of [['ledger', 'Ledger totals match an independent re-aggregation'], ['flow', 'Cash-flow identity holds'], ['reports', 'Reports are internally consistent'], ['budgets', 'Budget spending and rollover recompute correctly'], ['forecast', 'Projections are deterministic and self-consistent']]) {
      checks.push({ id, title, description: 'Skipped because the dataset has blocking structural errors that must be fixed first.', findings: [], status: 'skipped' });
    }
  }

  for (const c of checks) {
    if (c.status === 'skipped') continue;
    c.status = c.findings.some((f) => f.severity === 'error') ? 'fail' : c.findings.some((f) => f.severity === 'warning') ? 'warn' : 'pass';
  }
  if (other.length) {
    checks.push({ id: 'other', title: 'Other structural findings', description: 'Findings not covered by a specific check.', findings: other, status: other.some((f) => f.severity === 'error') ? 'fail' : 'warn' });
  }
  return { findings, checks, summary: { ...countBy(findings), blocked, passedChecks: checks.filter((c) => c.status === 'pass').length, totalChecks: checks.length }, ...summarizeFindings(findings) };
}

function countBy(findings) {
  return { errorCount: findings.filter((f) => f.severity === 'error').length, warningCount: findings.filter((f) => f.severity === 'warning').length, infoCount: findings.filter((f) => f.severity === 'info').length };
}
