import { buildIndex, accountContribution, netWorthAt } from './ledger.js';
import { summarizePeriod } from './reports.js';
import { formatMoney } from './money.js';

/** Readable Markdown diagnostics of a dataset and its verification result (for the Test Lab export). */
export function buildDiagnostics(data, verification, now = '') {
  const idx = buildIndex(data);
  const asOf = data.settings.asOfDate;
  const s = summarizePeriod(data, { start: '1970-01-01', end: asOf });
  const L = [];
  L.push(`# LedgerLens diagnostics - ${data.meta.name}`);
  if (now) L.push(`Generated: ${now}`);
  L.push(`As of: ${asOf} | basis: ${data.settings.basis} | schema ${data.schemaVersion}`);
  L.push('', '## Counts');
  for (const k of ['accounts', 'categories', 'transactions', 'transfers', 'rules', 'budgets', 'recurring', 'goals', 'reconciliations', 'importBatches', 'scenarios']) L.push(`- ${k}: ${data[k].length}`);
  L.push('', '## Account contributions (cents and dollars)', '| Account | Type | Posted | With pending |', '|---|---|---:|---:|');
  for (const a of data.accounts) {
    const p = accountContribution(idx, a.id, asOf, false);
    const q = accountContribution(idx, a.id, asOf, true);
    L.push(`| ${a.name} | ${a.type} | ${p} (${formatMoney(p)}) | ${q} (${formatMoney(q)}) |`);
  }
  const nw = netWorthAt(idx, asOf, false);
  L.push('', `Net worth (posted): ${nw.netWorth} (${formatMoney(nw.netWorth)}); assets ${formatMoney(nw.assets)}; owed ${formatMoney(nw.liabilities)}`);
  L.push('', '## All-time totals (posted)', `- Income: ${formatMoney(s.incomeCents)}`, `- Purchases: ${formatMoney(s.grossExpenseCents)}`, `- Refunds: ${formatMoney(s.refundCents)}`, `- Net spending: ${formatMoney(s.netExpenseCents)}`, `- Transfers moved (not income/expense): ${formatMoney(s.transferInCents)}`, `- External transfers net: ${formatMoney(s.externalNetCents)}`, `- Valuation adjustments: ${formatMoney(s.valuationCents)}`, `- Corrections: ${formatMoney(s.correctionCents)}`);
  if (verification) {
    L.push('', '## Verification', `Errors ${verification.summary.errorCount}, warnings ${verification.summary.warningCount}, info ${verification.summary.infoCount}${verification.summary.blocked ? ' (calculation blocked)' : ''}`);
    for (const c of verification.checks) {
      L.push(`- [${c.status.toUpperCase()}] ${c.title}`);
      for (const f of c.findings.slice(0, 20)) L.push(`    - (${f.severity}${f.blocking ? ', blocking' : ''}) ${f.message}${f.refs.length ? ` [${f.refs.map((r) => `${r.type}:${r.id}`).join(', ')}]` : ''}`);
    }
  }
  return L.join('\n');
}
