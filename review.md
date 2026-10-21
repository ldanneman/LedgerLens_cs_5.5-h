# Code review and remediation brief — LedgerLens_cs_5.5-h

Prepared October 21, 2026 for the model making the next implementation changes.

**Target project:** `/Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h`

**Objective:** Correct the financial and integrity defects below, add meaningful regression coverage, and update documentation to describe the resulting behavior. Use this project's `spec.md` as the product contract. This document concerns only the Sonnet implementation.

## Instructions for the implementing model

Read the relevant code and reproduce each issue before changing it. Work through the prioritized findings, using focused changes that preserve the existing application and supported workflows. Fix financial invariants at the domain/persistence boundary as well as in the UI. Do not make a failing test pass by weakening validation, excluding troublesome records from totals, resetting user data, changing the seed to conceal the problem, or replacing an exact assertion with a presence check.

Keep integer-cent arithmetic, deterministic dates, existing reference-case results, scenario isolation, and historical records intact. Handle older saved data explicitly if new validation rejects a previously accepted state; provide a recoverable explanation instead of silently discarding or silently “repairing” financial history. Document any schema migration or changed assumption.

For each finding, report the changed files, the regression test, the observed result, and any remaining limitation. Some implementation approaches below are recommendations, not mandatory architecture. The observable acceptance criteria are what matter.

## Review baseline

This brief is based on the completed independent review. All 100 tracked source/configuration/test files in its manifest were rechecked on October 21 and match the reviewed snapshot. Line numbers refer to that snapshot and may move during implementation.

The baseline is a substantial working application, with useful separation between domain operations, forecasting, persistence, state, and React presentation. Preserve these demonstrated strengths:

- All specification reference cases A–G pass independently.
- The delivered suite passes: **218 unit/component tests**, **13 browser tests**, lint, and production build.
- Independent verification passes **41 of 49 named checks**. The eight failed assertions include two manifestations of the same transfer defect; they are not eight distinct bugs. An additional impact probe exposes the debt-policy discrepancy below.
- Ordinary balances, refunds, exact splits, fixed-payment amortization, budget rollover, recurring date boundaries, shared-goal allocation, known future transactions, and ordinary import undo work in the tested cases.
- Real form edits survive reload. Common invalid JSON inputs are rejected. Corrupt or incompatible stored data is preserved and receives a recovery interface.

The review ran against isolated copies. **No application fixes have been applied by this review.** The full test suites were not rerun merely to write this handoff; the source hash check establishes that the previously tested code remains the same.

## Priority list

| ID | Priority | Improvement | Completion outcome |
|---|---|---|---|
| R1 | P1 | Make every transfer status mutation atomic | An internal transfer cannot change posted net worth through a one-leg edit. |
| R2 | P1 | Respect conflicting external IDs during pending matching | Two identified purchases cannot be collapsed by the fallback heuristic. |
| R3 | P2 | Validate nested reconciliation snapshots | Malformed imported metadata cannot be accepted and later crash reconciliation. |
| R4 | P2 | Validate import-batch ownership before undo | A batch cannot delete an unrelated manual transaction. |
| R5 | P2 | Resolve changed split amounts during settlement | A valid pending-to-posted workflow can complete with exact, deliberate allocations. |
| R6 | P2 | Advance older savings changes into the forecast window | A continuing monthly change does not disappear because its effective date is old. |
| R7 | P2 | Include dated account openings in projections | Future opening contributions enter once, on the correct date. |
| R8 | P2 | Align or clearly distinguish debt payment assumptions | A minimum-policy payoff projection agrees with the main forecast under identical assumptions. |
| Q1 | Quality | Replace weak assertions and test interactions | Tests verify financial consequences and persisted state. |
| Q2 | Quality | Expand function/component documentation | Contracts, invariants, failure behavior and examples match the delivered code. |

P1 findings affect ordinary financial workflows and should be fixed first. P2 findings are confirmed edge-case correctness, integrity or workflow problems. R8 includes a product-labeling/assumption distinction: the fixed-payment arithmetic itself is not wrong.

## R1 — P1: one-sided transfer posting changes posted net worth

**Specification:** §§3.3, 8.2, 9 and 19 require balanced transfer mutations and consistent financial state.

**Source:** [src/domain/ops/transactions.js:165](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/ops/transactions.js:165>) (`updateTransaction`), [src/domain/ops/transactions.js:328](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/ops/transactions.js:328>) (bulk updates), [src/domain/validate.js:225](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/validate.js:225>) (transfer validation).

**Reproduction**

1. Use checking opening at $1,000 and a card opening at $0, with no other posted effects.
2. Create a pending $50 internal payment: checking `amountCents: -5000`, card `amountCents: 5000`, sharing a transfer identity.
3. In Transactions select only the outgoing leg and click **Mark posted**.
4. Reload and inspect both legs and posted net worth. The same issue can be reproduced through `updateTransaction(data, outgoingId, { status: 'posted' })`.

**Expected:** Both legs post together, or the one-leg mutation rejects with a useful instruction. Posted net worth remains $1,000.

**Observed:** Only the outgoing leg posts. Posted net worth becomes $950. The inconsistent state persists across reload. This is confirmed through both independent domain calls and the actual browser bulk action.

**Cause:** The generic transfer-leg allow-list includes `status`, despite its comment saying paired changes belong in `updateTransfer`. Bulk mutation updates only selected IDs. Structural validation checks the two amounts sum to zero but does not enforce compatible status.

**Requested changes and acceptance criteria**

- Route transfer status edits through the paired operation, or expand selected IDs to the complete internal transfer before a single atomic commit. Selecting both legs must not process the transfer twice.
- Validate the invariant independently of the UI. A JSON-imported mixed-status internal pair must not become accepted normal state without an explicit recovery policy.
- Notify or invalidate affected reconciliation history consistently, including statements involving the counterpart leg.
- Test posting and unposting from either leg; single edit and bulk edit; selecting one or both legs; save/reload; and a completed reconciliation affected by the operation.
- Assert both account balances and posted net worth. Checking the sum of stored amounts alone misses this bug.
- Preserve intentional single-sided external-transfer behavior. Do not apply a two-leg requirement to records explicitly modeled as external transfers.

## R2 — P1: pending matching can merge distinct external references

**Specification:** §10.2 makes stable external references preferable to fallback matching and requires legitimate repeated purchases to survive.

**Source:** [src/imports/matching.js:73](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/imports/matching.js:73>) (pending heuristic), [src/domain/ops/importing.js:48](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/ops/importing.js:48>) (settlement and metadata replacement).

**Reproduction**

Create a pending checking expense dated 2026-09-15, description/merchant `Review Coffee`, `amountCents: -475`, and `source.externalId: 'P1'`. Import this posted CSV row to that account:

```csv
Date,Description,Amount,Reference
2026-09-16,Review Coffee,-4.75,P2
```

Accept the default preview action, commit and reload.

**Expected:** P1 and P2 remain distinct purchases. A conflicting identifier must prevent automatic replacement by a similarity heuristic.

**Observed:** The preview chooses settlement. Committing consumes P1 and overwrites its source reference with P2; only one purchase remains. The preview does show the settlement choice, so the defect is an unsafe default match, not a hidden background operation. Independently reproduced in the domain and browser.

**Requested changes and acceptance criteria**

- Exclude candidates where both external IDs are nonempty and differ. Apply the rule to every fallback path, not only the existing fingerprint branch.
- Preserve the already-working same-ID transition: incoming posted P1 should settle pending P1 exactly once.
- When references are absent, retain an explicit, defensible ambiguity review path. Equal amount/date/merchant alone is not proof of identity.
- Test conflicting IDs, equal IDs, one missing ID, both missing IDs, in-file legitimate duplicates, reimport, and two competing pending candidates.
- Verify after commit and reload that P1/P2 both remain and their amount/status/source metadata are correct. Reimporting the same incoming P2 must not create another P2.
- Undo must restore the appropriate pre-import state without removing the unrelated purchase.

## R3 — P2: malformed reconciliation snapshots pass the JSON boundary

**Specification:** §§18–19 require validation of nested records, safe replacement and failure containment.

**Source:** [src/domain/schema.js:283](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/schema.js:283>) (`normalizeReconciliation`), [src/domain/validate.js:316](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/validate.js:316>), [src/domain/reconciliation.js:52](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/reconciliation.js:52>).

**Reproduction**

Start with an otherwise valid dataset containing account `checking`, and place this record in its `reconciliations` collection:

```json
{
  "id": "bad-snapshot",
  "accountId": "checking",
  "startDate": "2026-09-01",
  "endDate": "2026-09-30",
  "openingCents": 100000,
  "closingCents": 100000,
  "status": "completed",
  "discrepancyCents": 0,
  "clearedTxIds": [],
  "snapshots": [null]
}
```

Import through Settings and open Reconcile.

**Expected:** Validation rejects the null nested record before replacing current data.

**Observed:** Import succeeds. Reconciliation then displays `Cannot read properties of null (reading 'txId')`. The error persists on reload. Navigation remains available; a completely blank app was not observed.

**Cause:** Normalization retains null entries. Validation filters them out for lookup and treats them as zero in the closing sum, while the consumer assumes every entry is an object.

**Requested changes and acceptance criteria**

- Validate snapshot object shape, IDs, date, money, status, account relationship and duplicate/missing membership according to the documented completed-statement model.
- Do not silently filter invalid entries or substitute zero amounts. Return a precise field/index error.
- Guard diagnostic/health consumers so malformed data produces a useful finding rather than an uncaught property access. Consumer guards supplement boundary rejection; they do not replace it.
- Preserve legitimate stale history. A valid historical snapshot can outlive a transaction that was later edited or deleted; do not reject every mismatch with the current ledger as malformed structure.
- Test nulls, scalars, missing IDs, duplicate snapshot IDs, fractional/unsafe amounts, invalid dates and a valid stale statement.
- Through the actual JSON upload flow, assert invalid import leaves the last valid workspace untouched. For invalid saved storage, assert recovery preserves raw data and does not silently reset it.

## R4 — P2: import-batch metadata can authorize deletion of an unrelated record

**Specification:** §§10.2, 18 and 19 require undo to preserve unrelated records and validate conflicting metadata.

**Source:** [src/domain/validate.js:335](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/validate.js:335>), [src/domain/schema.js:308](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/schema.js:308>), [src/domain/ops/importing.js:110](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/ops/importing.js:110>).

**Reproduction**

1. Start with one manual transaction, ID `manual-1`, whose source is not owned by an import batch.
2. Add this batch to an otherwise valid JSON dataset:

```json
{
  "id": "batch-1",
  "accountId": "checking",
  "status": "committed",
  "createdTxIds": ["manual-1"],
  "settled": []
}
```

3. Import it and invoke `undoImportBatch(data, 'batch-1')`.

**Expected:** Reject the conflicting ownership, or refuse the undo before any mutation.

**Observed:** The parser accepts it and undo removes the manual transaction: count 1 → 0. This requires inconsistent imported metadata; ordinary application-generated batch undo passed independent tests.

**Requested changes and acceptance criteria**

- Define and enforce ownership consistency between batch creation lists and the transaction's source/batch metadata. Validate element types and duplicates, not merely that `createdTxIds` is an array.
- Recheck ownership at undo time so a stale or malformed batch cannot delete unrelated live records.
- Validate settlement restoration metadata (`settled[].txId` and `before`) and distinguish created records from preexisting settled records. Retain a policy for later edits, removed records and already-undone batches rather than imposing assumptions that break valid history.
- Reject conflicting manual ownership atomically. Preserve ordinary undo, exact restoration of settled pending records, protection of linked transfer counterparts and meaningful reconciliation history.
- Test a manual record claimed by a batch, a record claimed by the wrong batch, malformed restoration data, and a valid application-generated batch. Confirm rejected undo does not partially alter any collection.

## R5 — P2: a changed posted amount leaves an existing split unresolved

**Specification:** §§3.3, 8.2 and 10.2 require exact split totals and support for pending transactions whose amount changes when posted.

**Source:** [src/domain/ops/importing.js:48](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/ops/importing.js:48>).

**Reproduction:** A pending −$10 purchase has −$6 and −$4 category splits. Import its matching posted version at −$11 and commit the proposed settlement.

**Expected:** A deliberate correction workflow can produce a posted −$11 transaction with splits totaling exactly −$11.

**Observed:** Settlement changes the parent amount but leaves the splits at −$10. The domain correctly rejects the mutation with a `split-sum` error. No invalid ledger is saved, but the import flow cannot complete the proposed settlement directly.

**Requested changes and acceptance criteria**

- Preserve the rejection of invalid splits. Improve the workflow before commit.
- Either allow explicit split editing in import preview, or offer a documented allocation policy that the user can review. Proportional rescaling is one option, not a mandatory financial assumption.
- Under proportional allocation, this example becomes −$6.60/−$4.40. An explicit manual allocation may differ but must sum to −$11.00 and preserve deliberate categories.
- Test one-cent remainder allocation, unchanged amount, refund-direction constraints, cancelled adjustment and batch undo. Undo should restore original amount, splits, status and source metadata.
- Surface the exact reason and correction action in the preview; avoid accepting an import plan that can only fail later without a correction path.

## R6 — P2: older savings-change effective dates erase future contributions

**Specification:** §16 requires deterministic date-aware scenario changes and useful month-by-month projections.

**Source:** [src/forecast/engine.js:176](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/forecast/engine.js:176>).

**Reproduction:** Forecast 12 months as of 2026-10-01 with zero savings, no other cash flows or interest, and this monthly savings change:

```js
{
  id: 'save-10',
  type: 'savings_change',
  effectiveDate: '2024-01-15',
  amountCents: 1000,
  fromAccountId: 'checking',
  toAccountId: 'savings'
}
```

**Expected:** Twelve future transfers: savings +$120, checking −$120, net-worth change $0.

**Observed:** Zero transfers. The loop examines only `horizonMonths + 2` months starting at the old effective month, and all those dates can fall before the forecast.

**Requested changes and acceptance criteria**

- Advance to the first applicable occurrence after the as-of date, then enumerate through the actual forecast end date. Do not solve this with an arbitrary larger iteration cap.
- Preserve day-of-month anchoring, short-month behavior and the engine's existing inclusion/exclusion convention for the as-of date.
- Test effective dates years earlier, a few months earlier, within the horizon and after it; include month-end anchors and year boundaries.
- Assert per-month events, both account balances and unchanged net worth, not only the final savings number. Duplicate scenarios must still compare identically and leave actual transactions unchanged.

## R7 — P2: future opening contributions never enter the forecast

**Specification:** §§3.4 and 16 require date-aware balances and a baseline consistent with the canonical account model.

**Source:** [src/forecast/engine.js:97](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/forecast/engine.js:97>) (initial balances), [src/forecast/engine.js:146](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/forecast/engine.js:146>) (future ledger events).

**Reproduction:** Savings has `openingDate: '2026-11-01'`, `openingCents: 50000`. Forecast from 2026-10-01 for 12 months with no transactions or interest.

**Expected:** Savings contributes $0 before November 1 and $500 on/after opening, exactly once.

**Observed:** Historical balance calculations correctly respect the opening date, but the forecast stays at $0 because it initializes before opening and emits no opening event.

**Requested changes and acceptance criteria**

- Include dated opening contributions within the forecast horizon, or use an equivalent model that preserves their timing.
- Do not count an opening already included in the initial as-of balance again. Do not classify an opening contribution as ordinary salary or spending.
- Keep known future transactions and matched recurrences correct; those already passed independent checks.
- Test opening before/on/after as-of, within/outside the horizon, and positive assets/negative liabilities. Confirm same-day opening/transaction ordering is deterministic.
- Inspect future accounts' recurring, interest and debt events so they cannot accrue against a balance before it exists. This is requested regression coverage, not an additional confirmed bug.
- Verify month-by-month account balances, net worth and headline income/expense classification.

## R8 — P2: minimum-payment payoff and forecast use different assumptions

**Specification:** §§14.2 and 16 require coherent payment assumptions, interest calculations and payoff projections.

**Source:** [src/domain/debt.js:29](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/debt.js:29>) (minimum formula), [src/domain/debt.js:157](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/domain/debt.js:157>) (debt overview), [src/forecast/engine.js:278](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/forecast/engine.js:278>), [src/ui/pages/GoalsDebt.jsx:204](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/src/ui/pages/GoalsDebt.jsx:204>).

**Reproduction:** Configure a $1,000 card balance, APR 24%, minimum-payment mode, a 2% principal component plus monthly interest, $25 floor, and a funded checking account for payments. Compare the debt overview/payoff schedule with the main forecast, with no new purchases or extra payments.

| Period | Under the configured minimum policy | Current debt overview schedule | Current forecast |
|---|---:|---:|---:|
| 1 | $40.00 | $40.00 | $40.00 |
| 2 | $39.20 | $40.00 | $39.20 |

The first payment comprises $20 interest and $20 principal, leaving $980. The next minimum is $19.60 interest plus $19.60 principal.

**Cause:** `debtOverview` computes one initial `regularPayment` and passes that scalar into a constant-payment schedule. The forecast recalculates the account policy each period.

**Nuance:** The fixed-$40 schedule is mathematically valid, and the debt page refers to the “scheduled payment.” The defect is presenting a current-plan payoff that can differ from following the selected minimum policy without making that change of assumption clear. Do not change correct fixed-payment amortization merely to force identical numbers for genuinely different plans.

**Requested changes and acceptance criteria**

- Prefer a shared policy calculation and interest/payment timing across the policy-based debt view and main forecast.
- Keep a fixed-payment what-if calculator if useful, but label it explicitly and compare matching assumptions. The configured minimum-policy projection must be available and agree with the forecast.
- Test minimum, fixed and pay-in-full modes, floor binding, zero APR, insufficient payments, extra principal and final-payment capping.
- For an isolated debt with identical timing and no other activity, compare every period's interest, payment and ending debt across the two views. Verify payoff status/timing and total interest as well.

## Q1 — Strengthen verification of financial interactions

At [e2e/journey.spec.js:24](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/e2e/journey.spec.js:24>), this assertion always asks whether text contains the empty string:

```js
toContainText('Corner Bean'.length ? '' : '')
```

Replace it with observable filtering assertions: matching rows are shown, a known nonmatching row is absent, and displayed count or summary reflects the filtered dataset. Avoid coupling assertions to the 946-record seed where a small controlled fixture expresses the behavior better.

Add targeted regression coverage to the existing suites rather than a parallel framework:

| Area | Existing test file to extend | What must be asserted |
|---|---|---|
| Transfers | [tests/domain/ledger-ops.test.js:1](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/tests/domain/ledger-ops.test.js:1>) | Pair status, both balances, net worth, reconciliation consequences. |
| Pending settlement and undo | [tests/domain/import.test.js:1](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/tests/domain/import.test.js:1>) | Stable identities, exact splits, source ownership, complete atomic rejection/restoration. |
| JSON and saved storage | [tests/domain/persistence.test.js:1](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/tests/domain/persistence.test.js:1>) | Nested malformed records reject without replacing valid data; recovery preserves raw input. |
| Forecast/debt | [tests/domain/debt-forecast.test.js:1](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/tests/domain/debt-forecast.test.js:1>) | Dated events, per-period expected cents, payment-policy consistency. |
| UI lifecycle | [tests/ui/workflows.test.jsx:1](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/tests/ui/workflows.test.jsx:1>) and [e2e/journey.spec.js:1](</Users/levdanneman/Documents/Code Projects/LedgerLens_cs_5.5-h/e2e/journey.spec.js:1>) | Public controls → commit → reload → exact resulting records and displayed totals. |

Use independent expected values. A test that compares two wrappers around the same erroneous helper does not establish correctness. For each fix, demonstrate that the targeted test fails on the reviewed behavior and passes with the change. Keep at least one browser regression for R1 and R2 and a public JSON rejection/recovery check for R3/R4.

Broader checks still worth performing: a full 2,000-record Test Lab interaction, moderate CSV import responsiveness, a 768px layout sweep, and representative screen-reader/keyboard and Safari/Firefox workflows. These were not comprehensively verified in the independent review; they are verification gaps, not confirmed failures. Clearly state anything that remains untested.

## Q2 — Improve documentation without overstating guarantees

Update the repository README and the Sonnet Obsidian collection at `/Users/levdanneman/Documents/code_projects/LedgerLens Finance Platform CS-5.5-h`. Keep changes specific to this project.

The collection has useful structure and links, but its function reference mainly lists names and several component notes are too brief for the requested component/function-level documentation. Prioritize explanations that help a maintainer safely change financial behavior:

- Input/output contracts, cents/sign/date conventions, side effects and rejection behavior for mutation/import/forecast functions.
- A user-action → validation → atomic commit → persistence → recalculated view example.
- Transfer status guarantees; pending identity rules; split-settlement policy; batch ownership and undo policy.
- Snapshot structure and the distinction between malformed imports and valid but stale reconciliation history.
- Forecast window boundaries, account opening events and minimum versus fixed debt payment assumptions.
- Small worked examples with expected cents and links to the regression tests that enforce them.

Correct the transfer-edit comment and ensure README's “different reference = different purchase” claim becomes true in every import path. Record the chosen R5 and R8 behavior explicitly. Do not claim browser or accessibility verification that was not actually run.

## Regression values that must remain correct

Run every original §20 reference case after the fixes. These values are independent acceptance targets:

| Case | Required outcome |
|---|---|
| A | Checking $1,400; savings $30; card −$180; net worth $1,250; income $600; net expense $150. Transfers do not add income/spending. |
| B | −$47.35 debited once, split −$12.50/−$34.85; a total of −$47.34 rejects. |
| C | Two same-day $4.75 coffees with different references remain two; reimport does not make four; missing-reference ambiguity is reviewable. |
| D | Statement close $1,324.75; entered close $1,319.75 gives −$5 discrepancy and cannot complete; uncleared $20 stays excluded. |
| E | February available $250; March $170; changing January spending from $150 to $100 changes March to $220; December/January works. |
| F | Identical scenarios produce zero monetary changes and no affected accounts/goals, including unchanged negative cash and unpaid debt. |
| G | Exact $0.10 + $0.20 = $0.30; valid leap day; invalid February 30; Jan 31 → Feb 28 → Mar 31 → Apr 30; repeated export/import preserves identity and cents. |

Fixed-payment regression: $1,000 principal at 12% APR with $100 monthly payments pays off in 11 periods, with **$58.98 total interest** and a **$58.98 final payment** under the existing monthly rounding convention. Keep final-payment capping and truthful non-payoff states.

## Completion checklist and handback

- [ ] R1 and R2 are fixed at the domain boundary and confirmed through browser save/reload workflows.
- [ ] R3 and R4 reject invalid metadata atomically and preserve valid/stale historical data according to an explicit policy.
- [ ] R5 offers an exact-cent settlement correction path; cancellation and undo behave correctly.
- [ ] R6 and R7 produce the expected dated forecast events and account balances without double-counting.
- [ ] R8 gives consistent results under the same policy and explicitly labels any alternative fixed-payment assumption.
- [ ] New regression tests assert outcomes and fail on the prior faulty behavior; the empty-string assertion is replaced.
- [ ] All reference cases and existing supported workflows remain correct.
- [ ] Run `yarn test`, `yarn lint`, `yarn build`, and `yarn e2e`; report actual pass/fail/skip counts and unresolved failures. Do not hide failures with new skips.
- [ ] Verify representative views at 1440, 768, 390 and 320px after UI changes; check keyboard access to any new controls.
- [ ] README and Sonnet Obsidian notes describe the final behavior, migrations, assumptions and remaining limits.
- [ ] Return a concise change summary mapped to R1–R8/Q1–Q2, with exact validation results and anything still incomplete.

Do not mark an item complete solely because its UI is present, a helper returns successfully, or the overall build passes. Demonstrate the financial and persisted-state outcome.
