/**
 * "Invalid candidates": deliberate corruptions of a valid dataset, used by the Test Lab to show that
 * every kind of bad data is rejected with a specific message (and by the automated tests).
 * Each `apply` receives a deep clone and returns the corrupted dataset.
 */
const firstOf = (d, kind) => d.transactions.find((t) => t.kind === kind && !t.splits.length && !t.transferId);

export const INVALID_CASES = [
  { id: 'dup-account-id', label: 'Two accounts share an id', expect: /Duplicate account id/, apply: (d) => { d.accounts[1].id = d.accounts[0].id; return d; } },
  { id: 'dup-tx-id', label: 'Two transactions share an id', expect: /Duplicate transaction id/, apply: (d) => { d.transactions[1].id = d.transactions[0].id; return d; } },
  { id: 'missing-account', label: 'Transaction points to a missing account', expect: /unknown account/, apply: (d) => { d.transactions[0].accountId = 'acct-ghost'; return d; } },
  { id: 'missing-category', label: 'Transaction points to a missing category', expect: /unknown category/, apply: (d) => { firstOf(d, 'expense').categoryId = 'cat-ghost'; return d; } },
  { id: 'feb-30', label: 'Impossible date (2026-02-30)', expect: /not a valid calendar date/, apply: (d) => { d.transactions[0].date = '2026-02-30'; return d; } },
  { id: 'fractional-cents', label: 'Fractional cents (12.5)', expect: /whole number of cents/, apply: (d) => { d.transactions[0].amountCents = 12.5; return d; } },
  { id: 'nan-amount', label: 'Non-numeric amount ("12.00")', expect: /whole number of cents/, apply: (d) => { d.transactions[0].amountCents = '12.00'; return d; } },
  { id: 'unsafe-int', label: 'Unsafe / absurdly large integer', expect: /whole number of cents/, apply: (d) => { d.transactions[0].amountCents = Number.MAX_SAFE_INTEGER + 2; return d; } },
  { id: 'zero-amount', label: 'Zero-amount transaction', expect: /zero amount/, apply: (d) => { d.transactions[0].amountCents = 0; return d; } },
  { id: 'split-mismatch', label: 'Splits that do not add up to the parent', expect: /splits add up/, apply: (d) => { const t = d.transactions.find((x) => x.splits.length); t.splits[0].amountCents -= 1; return d; } },
  { id: 'unbalanced-transfer', label: 'Transfer whose legs do not balance', expect: /does not balance/, apply: (d) => { d.transactions.find((t) => t.kind === 'transfer' && t.amountCents > 0 && !d.transfers.find((x) => x.id === t.transferId).external).amountCents += 1; return d; } },
  { id: 'mixed-status-transfer', label: 'Transfer posted on one side and pending on the other', expect: /must share one status/, apply: (d) => { d.transactions.find((t) => t.kind === 'transfer' && t.status === 'posted' && !d.transfers.find((x) => x.id === t.transferId).external).status = 'pending'; return d; } },
  { id: 'orphan-transfer-leg', label: 'Transfer lists a leg that does not exist', expect: /missing transaction/, apply: (d) => { d.transfers[0].legIds[1] = 'tx-nope'; return d; } },
  { id: 'recon-missing-tx', label: 'Reconciliation clears a transaction that never existed', expect: /unknown transaction/, apply: (d) => { const r = d.reconciliations.find((x) => x.status === 'completed'); r.clearedTxIds.push('tx-never'); return d; } },
  { id: 'recon-discrepancy', label: 'Completed reconciliation with a non-zero discrepancy', expect: /marked completed/, apply: (d) => { d.reconciliations.find((x) => x.status === 'completed').discrepancyCents = 500; return d; } },
  { id: 'recon-null-snapshot', label: 'Completed reconciliation with a null snapshot', expect: /snapshot #1 must be an object/, apply: (d) => { d.reconciliations.find((x) => x.status === 'completed').snapshots[0] = null; return d; } },
  { id: 'batch-claims-manual', label: 'Import batch claiming a manually entered transaction', expect: /would delete an unrelated record/, apply: (d) => { d.importBatches[0].createdTxIds.push(d.transactions.find((t) => t.source.type !== 'import').id); return d; } },
  { id: 'meta-name-object', label: 'Dataset name that is not text', expect: /meta.name must be text/, apply: (d) => { d.meta.name = { hacked: true }; return d; } },
  { id: 'income-category-on-expense', label: 'Expense using an income category', expect: /income category/, apply: (d) => { firstOf(d, 'expense').categoryId = 'cat-salary'; return d; } },
  { id: 'arrays-malformed', label: 'transactions is not an array', expect: /must be an array/, apply: (d) => { d.transactions = { oops: true }; return d; } },
  { id: 'text-not-string', label: 'Description is a number', expect: /must be text/, apply: (d) => { d.transactions[0].description = 12345; return d; } },
  { id: 'bad-budget-month', label: 'Budget with an invalid start month', expect: /valid month/, apply: (d) => { d.budgets[0].startMonth = '2026-13'; return d; } },
  { id: 'negative-budget', label: 'Negative budget limit', expect: /at least 0/, apply: (d) => { d.budgets[0].baseCents = -100; return d; } },
  { id: 'bad-rate', label: 'Nonsensical interest rate (500%)', expect: /at most 10000/, apply: (d) => { d.accounts.find((a) => a.type === 'credit_card').aprBps = 50000; return d; } },
  { id: 'bad-asof', label: 'Invalid as-of date', expect: /asOfDate/, apply: (d) => { d.settings.asOfDate = '2026-00-10'; return d; } },
  { id: 'scenario-bad-change', label: 'Scenario change with a bad date', expect: /Scenario/, apply: (d) => { d.scenarios[0].changes[0].effectiveDate = '2026-02-31'; return d; } },
  { id: 'wrong-schema', label: 'Newer schema version', expect: /newer|schemaVersion/, apply: (d) => { d.schemaVersion = 99; return d; } },
];
