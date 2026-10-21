# LedgerLens — Personal Finance, Reconciliation & Scenario Planning Platform

## 1. Project overview

Build **LedgerLens**, a polished, self-contained personal-finance application for an individual who wants to understand their finances, review and reconcile transactions, manage budgets, track debts and savings, and explore potential financial decisions. It should feel like a credible small financial product, not a static dashboard or a collection of isolated demos.

The application is a **local-first financial simulator and management workspace**, using realistic **fictional** financial information. No real bank connections, credential collection, paid APIs, external financial services, or production financial advice are needed.

The core challenge is maintaining **financial correctness, data integrity, and predictable state transitions** while presenting a useful interactive interface. The app must remain internally consistent when the user edits, imports, deletes, categorizes, splits, transfers, reconciles, or models records.

A user should be able to start with realistic seeded data; complete ordinary finance tasks; create and inspect their own test scenarios; reload the application without losing work; and export their data. Changes should propagate to balances, budgets, reports, and forecasts without stale or contradictory results.

### Primary goals

1. Model financial accounts, transactions, transfers, splits, budgets, recurring obligations, debts, goals, and scenarios coherently.
2. Produce mathematically correct balances, cash-flow reports, net worth, reconciliations, and forward-looking projections.
3. Support actual user workflows, not merely display seed data behind controls that do nothing.
4. Validate data at every entry point and recover gracefully from mistakes, invalid imports, and exceptional states.
5. Provide a responsive, accessible interface with clear explanations of financial values and calculations.
6. Document the implementation at component/function level and verify it using meaningful automated tests.

## 2. Technology, execution, and delivery

- Use **React**, **Vite**, **JavaScript** (not TypeScript), and **Yarn**.
- Implement in the **current working directory**. Deliver all necessary source, assets, configuration, tests, and documentation.
- The normal development path must work with `yarn install`, `yarn dev`, `yarn test`, and `yarn build`. Other helpful commands may be added and documented.
- Use appropriate open-source packages when genuinely useful, but avoid building essential behavior around services unavailable offline. Prefer a readily reproducible local setup.
- The app must run locally without API keys, live banking accounts, subscriptions, or internet access after package installation. All displayed financial information should be generated or seeded locally.
- Persist edits across browser refreshes and application restarts in the same local environment. Clearly explain where data is stored, whether it is browser-specific, and how a user can back it up or restore it.
- Use a clear folder structure separating financial domain logic from UI, state management, imports, projections, and persistence.
- Configure reliable linting and automated testing. The production build must succeed.
- A browser-facing runtime error must not silently replace the interface with a blank screen.
- Keep the application usable on desktop and mobile (including approximately 390px and 320px viewports).
- Use a stable application name and coherent product identity. No placeholder Vite landing pages, dead routes, or generic starter README.
- Prefer reproducible, deterministic behavior over randomness that changes results between runs.

**Implementation discretion:** Choose a reasonable local persistence mechanism, charting library, router, state-management pattern, styling approach, and component organization. Those choices are part of the implementation. Explain significant choices and their tradeoffs in the README.

## 3. Financial domain conventions

These conventions are foundational and must be reflected consistently across the entire application.

### 3.1 Currency and numeric precision

- The initial dataset is entirely in **USD**. Show monetary values as dollars and cents, with appropriate signs, separators, and currency symbols.
- Store and calculate monetary values in **integer cents**, or use an equally exact decimal-money representation throughout the financial engine. Do not use ordinary binary floating-point arithmetic as the source of truth for currency amounts.
- Validate that transaction amounts and stored monetary values are finite, integral in the internal money unit, and within a reasonable supported range.
- Apply a consistent, documented rounding convention to derived interest, percentage calculations, monthly payments, and allocations. Repeated calculations from the same inputs must produce identical results.
- Dates must be interpreted consistently. Ordinary transaction dates are **calendar dates**, not device-dependent timestamps that can unexpectedly shift by a day because of time zones.
- Use an explicit, reproducible **demo as-of date of 2026-10-01** for the initial dataset, default reporting period, recurring schedules, and projections. The user may change the reporting or simulation date where appropriate.

### 3.2 Account values and liability display

Support at least checking, savings, credit card, investment, and installment-loan accounts. An account has a persistent ID, name, type, opening value, optional institution name, and other relevant metadata.

For calculations, represent each account's **net-worth contribution** consistently:

- Cash and investment assets contribute positive value.
- Credit-card and loan liabilities contribute negative value.
- A transaction's signed monetary effect on its account changes that account's net-worth contribution by the stated amount.
- A credit-card purchase generally makes that card's contribution **more negative**. Paying the card makes its contribution **less negative**.
- The user-facing account page may show liabilities as positive **amount owed**, provided the sign convention is clear and calculations remain correct.
- Total net worth is the sum of account contributions (including applicable investment valuation adjustments).

A more elaborate ledger architecture is welcome if it preserves these externally observable properties.

### 3.3 Transaction semantics

- Every transaction has a stable ID, account association, effective calendar date, description, signed amount, status, classification, and optional merchant, category, notes, tags, source/import metadata, and recurrence linkage.
- Distinguish **income**, **expense**, **transfer**, and non-cash **balance/valuation adjustment** semantics.
- Expenses reduce net worth; income increases net worth. Ordinary transfers between tracked accounts do **not** change total net worth or count as income/expenses.
- Credit-card payments and loan principal payments must not be double-counted as spending when the underlying purchase or spending has already been recognized.
- Refunds/reimbursements and reversals must have intentional treatment in spending and category reports; avoid displaying refunds as unexplained new salary/income.
- Pending and posted transactions must be distinguishable; show how pending items affect available balances versus posted/statement balances. Be consistent across reports and reconciliation.
- Transactions may be divided into category **splits**, with amounts that sum exactly to the parent transaction. Splits affect category reporting without causing the underlying account debit/credit to occur multiple times.
- A paired transfer must create or maintain balanced effects across its participating accounts. For a $50 checking-to-credit-card payment, the checking contribution falls by $50 and the credit-card contribution rises by $50. Internal transfer effects sum to zero.
- Investment contributions/transfers should be distinguishable from a genuine change in investment market value.
- All calculations must derive from canonical records rather than independently edited dashboard totals.

### 3.4 Account history and net-worth equations

For each account and selected date:

`Account contribution = opening contribution + sum of eligible posted transaction effects through that date + eligible valuation effects through that date`

`Net worth = sum of account contributions`

The app should also explain differences between transaction-date balances, posted/cleared statement balances, and any optional pending or forecast balances. Do not silently treat these as interchangeable.

## 4. Seeded demo world

The app must begin in a useful, realistic, deterministic state. Create an explicit seed-generation or fixture module; do not rely on a new unseeded random dataset every time the app loads.

### 4.1 Accounts and data volume

Seed **at least 9 accounts**, comprising:

- Two checking accounts (primary and secondary).
- Two savings accounts (general savings and emergency fund).
- Two credit cards with different balances and limits.
- One investment account.
- One auto loan.
- One student or personal installment loan.

Include meaningful opening balances, institution labels, interest rates where relevant, credit limits or loan terms, and the information needed to display net worth and liability obligations. All names, institutions, users, and numbers must be fictitious.

Seed **at least 500 transactions** over **at least 12 consecutive months** leading into the demo as-of date. Use varied merchants, recurring bills, payroll, shopping, dining, transport, fuel, travel, medical expenses, subscriptions, interest, refunds, payments, account transfers, and other plausible activity.

The dataset must intentionally include:

- At least 15 categories and 20 recognizable merchants.
- Several category splits, with nontrivial allocations.
- At least 12 paired transfers across different account types, including credit-card payments.
- At least six recurring bill/subscription patterns and two income patterns.
- Pending transactions, posted transactions, refunds, an adjustment, and transactions around month/year boundaries.
- Identical-value/date transactions that are nevertheless separate legitimate transactions.
- Imported-looking records carrying external reference IDs.
- A set of records suitable for demonstrating partial and complete reconciliation.
- At least three savings goals and at least four budget categories, including one rollover budget.
- Two loan/debt schedules that support scenario analysis.

Do not hard-code dashboard outputs that only happen to match the seed. Reports must recalculate correctly when data changes.

### 4.2 First-launch behavior and sample presets

Provide a clearly labeled **Reset to demo data** action with confirmation. Reset must restore the deterministic original demo, not a new random one.

Also provide a **Test Lab** with selectable, deterministic sample data/presets that exercise different financial situations. Include at minimum:

1. **Balanced month:** ordinary income, expenses, a transfer, and reconciled balances.
2. **Credit-card cycle:** purchases, refund, statement payment, interest, and competing possible categorizations.
3. **Duplicate-looking imports:** multiple legitimate matching-amount transactions plus a true reimport.
4. **Reconciliation mismatch:** uncleared items, a missing charge, and a known discrepancy.
5. **Year-end rollover:** spending and budget carryover across December/January.
6. **Debt acceleration:** alternative loan payments and an early payoff projection.
7. **Edge-case ledger:** zero-amount or invalid candidate records, boundary dates, splits, and special identifiers where applicable.

Presets should be understandable and useful in the interface, not inaccessible test-only objects. Switching or resetting datasets should not silently destroy unsaved real user work.

## 5. Navigation and overall UI

Provide a coherent application shell with easy navigation between these functional areas:

1. **Dashboard**
2. **Accounts**
3. **Transactions**
4. **Import & Reconcile**
5. **Budgets**
6. **Recurring & Bills**
7. **Goals & Debt**
8. **Reports & Analytics**
9. **Scenario Planner**
10. **Test Lab**
11. **Settings / Data Management**

A few closely related areas may be grouped under a common tab if their functionality remains discoverable and genuinely accessible. Direct links/bookmarks to important detail views are desirable.

Across all areas:

- Provide strong visual hierarchy, clear financial labeling, empty states, loading/error states when relevant, and feedback for successful and failed operations.
- Maintain selected filters and context sensibly when users navigate between areas.
- Use functional tables, charts, status indicators, controls, and edit forms, not static mockups.
- Provide keyboard-accessible navigation, labeled form controls, visible focus states, and reasonable contrast.
- Treat negative amounts, amounts owed, unfavorable variances, and positive financial values distinctly without relying exclusively on color.
- Handle long merchant names, many rows, and small displays without clipping important information or hiding it behind inaccessible overflow.

## 6. Dashboard

The dashboard summarizes the dataset at the selected as-of date and reporting period.

Required sections:

- Net worth with aggregate assets and liabilities.
- Posted cash/checking/savings balances and outstanding credit-card and loan amounts.
- Current-period income, spending, and net cash flow (with transfers excluded).
- Spending by category (visual chart with accessible numeric equivalent).
- Recent transaction activity and pending-item summary.
- Monthly budget status and categories at risk of overspending.
- Upcoming bills or recurring obligations and their estimated effect on liquidity.
- Savings-goal progress and debt-paydown snapshot.
- At least one historical trend chart for cash flow or net worth.
- Clear indication of date range and whether displayed values are historical, posted, pending-inclusive, or projected.

All dashboard modules must update after relevant changes elsewhere. Clicking meaningful summary elements should take the user to an appropriately filtered/detail view where practical.

## 7. Accounts

### 7.1 List and details

Display every account with type, institution, balance/amount owed, status, and relevant rate/limit information. Offer aggregate summaries by asset/liability type.

Each account detail view must show:

- Current and opening contribution/balance, with clearly explained signs.
- Running-balance transaction history, sortable and filterable.
- Optional pending amounts and statement/cleared distinctions.
- Useful account metadata and editable display settings.
- An account-specific balance trend.
- Related transfers, payments, and reconciliation history.

### 7.2 Editing and lifecycle

Users can create, edit, archive, and where safe delete accounts. Support renaming, updating metadata and relevant rates/limits, and choosing an opening balance for a new account.

Keep relationships coherent when an account has transactions, transfers, budget/report references, reconciliation records, or scenario references. The UI must explain the effect of destructive operations. Archived account history must remain available for historical reporting.

Do not allow a user to accidentally create duplicate IDs, orphan records, or silently discard balances when editing an account.

## 8. Transactions and ledger editing

### 8.1 Browsing

Provide a responsive table or equivalent data view supporting:

- Searching by description, merchant, note, or relevant identifier.
- Filters for account, date range, amount range, category, type, pending/posted, tags, and imported/manual source.
- Sorting by date, amount, merchant, and other useful columns.
- Pagination or efficient virtualization for hundreds/thousands of rows.
- Multi-select and meaningful bulk category/tag/status operations where safe.
- Display of category splits, transfer linkage, and reconciliation/cleared status.

### 8.2 Creation and editing

Users can add and edit income, expenses, transfers, adjustments, and appropriate refund transactions. Allow category, merchant, notes, tags, transaction date, status, and split allocations to be edited.

- Changes must correctly affect account balances, reports, budgets, recurring matching, and reconciliation state where relevant.
- Reject impossible allocations, invalid dates, missing required references, and malformed amounts with actionable error messages.
- Split rows must sum exactly to the transaction amount in cents. Do not lose or create pennies.
- Editing a transfer must preserve balanced paired legs and prevent one-sided changes that would distort net worth.
- Deletion must account for associated splits, paired transfers, recurring relationships, and any statement in which a transaction was reconciled.
- A user should be able to reverse an entry or correct a mistake without producing misleading history. Choose a consistent, discoverable approach.
- Provide confirmation or recovery for high-impact deletion and bulk operations.

### 8.3 Categorization rules

Provide configurable rules for assigning categories based on merchant names or descriptions. Show a rule list and allow creating/editing/deleting rules and setting priorities when needed.

Rules should work on newly imported or created transactions without unexpectedly overwriting deliberate manual classifications. Explain any conflicts or precedence choices. Include an option to preview how a rule would affect existing data before applying it in bulk.

## 9. Transfers, card payments, and refunds

These are explicit product workflows, not incidental categories.

- Provide an easy **Transfer funds** workflow between two tracked accounts.
- A single user action should create linked, balanced account effects with a shared transfer identity.
- Transfers between asset accounts, asset-to-liability payments, and liability-to-liability transfers must have financially consistent accounting when supported.
- Exclude internal transfers from income, expense, and spending totals, while still showing them in individual account activity.
- A credit-card purchase should count as spending at purchase time; paying the card should not count again.
- Refunds should reduce the appropriate net expense/category, including on credit cards, and update account contribution appropriately.
- Editing, deleting, reversing, importing, and reconciling linked transfer entries must not strand an inconsistent half-transfer.
- A transfer involving an account outside the tracked set may need special treatment; choose and clearly communicate an appropriate accounting approach.

## 10. CSV import and transaction matching

Provide a working importer, not a cosmetic file-upload element.

### 10.1 Import formats and preview

- Import a user-provided **CSV** file of transactions from at least one common bank-export layout and support column mapping for other reasonable CSV files.
- Handle a header row, quoting, embedded commas, quoted multiline fields, blank lines, optional external IDs, alternate date formats, and debit/credit versus signed-amount columns.
- Allow users to select a destination account, map fields, inspect parsing errors, and preview normalized transactions **before committing**.
- Show how many rows will be imported, skipped as duplicates, rejected, or need attention.
- Use explicit mappings and deterministic parsing; do not silently guess incorrectly when a format is ambiguous.
- A failed or canceled import must not partially alter stored records.

### 10.2 Duplicate detection

- Avoid importing the same external transaction twice when the same file is reimported.
- Prefer stable external references when supplied; use a documented fallback matching strategy if references are unavailable.
- Do **not** assume identical amount/date/merchant means two entries are always duplicates. Legitimate separate purchases can share all three fields.
- Provide a way to review suspected duplicates and deliberately keep a legitimate repeated transaction.
- Account for the possibility that a pending transaction later becomes posted with a slightly changed description/date/amount.
- Show an import summary and preserve source metadata needed to explain or reverse a batch.
- Include the ability to undo a recent import batch without deleting unrelated records or corrupting linked records.

### 10.3 Import robustness

Invalid rows should receive understandable row-level feedback. The app should not freeze, corrupt stored data, or go blank because of malformed quoting, dates, numbers, IDs, headers, or unexpectedly large inputs. Define sensible size limits and surface them to users.

## 11. Statement reconciliation

Allow users to reconcile account activity against a fictional bank/credit-card statement.

### 11.1 Reconciliation workflow

For a selected account, the user must be able to:

1. Enter a statement start and end date, opening statement balance, and closing statement balance.
2. Review posted candidate transactions in that statement period.
3. Mark transactions **cleared** or **uncleared** for the statement.
4. See the cleared sum, calculated statement closing balance, and **discrepancy** updating immediately.
5. Identify missing, extra, duplicate, or incorrectly dated transactions.
6. Complete reconciliation only when the discrepancy is exactly zero (in cents), or follow a clearly explained alternative policy for documented adjustments.
7. Save a reconciliation record containing account, period, relevant balances, cleared transaction IDs, completion status, and completion date.
8. Revisit reconciliation history and understand the effect of later edits to reconciled transactions.

### 11.2 Reconciliation invariants

Use a consistent signed-value convention for liabilities as well as assets. At minimum:

`Calculated statement close = statement opening contribution + sum(cleared posted transaction effects for the statement)`

`Discrepancy = statement closing contribution - calculated statement close`

A completed reconciliation must remain meaningful after reloading. Editing or deleting cleared or reconciled records must not silently leave a false **reconciled** status; the user should see a warning, an invalidated reconciliation, a revision trail, or another coherent treatment.

Reconciliation must handle credit-card payments, refunds, transfers, splits, statement boundary dates, zero cleared items, and previously reconciled periods. Avoid a hidden balancing entry invented solely to make the discrepancy disappear.

## 12. Budgets

Provide an interactive monthly category-budget system.

- Users can create, edit, delete, and enable/disable budgets for expense categories.
- Support different amounts by month and an option to carry unused or overspent amounts into later months.
- Show budgeted amount, actual net spending, remaining/overage, rollover contribution, and progress percentage.
- A spending summary should distinguish expenses from internal transfers and exclude income from spend totals.
- Split purchases must allocate spending to the correct categories. Refunds should adjust net spending appropriately.
- Account edits, imported transactions, date changes, and classification changes must immediately update the relevant budget months.
- Provide at least one year-at-a-glance view and one category detail view with historical spending.
- Show overspending and unusual changes clearly.

**Rollover behavior:** A rollover-enabled category's opening available amount for a month is its base allocation plus the preceding month's unused balance (which may be negative). Recalculate the chain when an earlier month's spending or budget changes. Handle a change in year without resetting the math incorrectly.

A few design choices—for example, the treatment of explicitly excluded transactions or a category intentionally budgeted at zero—are left to the implementation, but they must be consistent and explained.

## 13. Recurring income, bills, and subscriptions

Users must be able to manage expected future activity independently of posted transactions.

- Create recurring rules for income and expenses with title, amount, account, category, start date, recurrence interval (at least weekly, monthly, and yearly), and optional end date.
- List the next occurrences for at least 90 days and show the expected cash impact.
- Support editing, pausing, resuming, and deleting a recurrence.
- Distinguish a scheduled occurrence from an actual posted transaction; do not count both as historical spending.
- Provide a way to mark/pay or associate an occurrence with an actual transaction without duplicating the charge.
- Explain how monthly rules behave for start dates such as January 31 and how due dates behave on non-business days if adjustments are implemented.
- Allow subscriptions to be grouped or viewed separately, including estimated monthly and annual equivalent costs.
- Use recurring obligations in the forecast without altering the ledger merely because a future date passes in a projection.

## 14. Goals and debt planning

### 14.1 Savings goals

Create and edit savings goals with name, target amount, target date, linked account(s) or allocation rules, and current progress. Show remaining amount and estimated required contribution per period.

- Offer a simple progress visualization and milestone indicator.
- A goal may be funded from a shared savings account; avoid automatically double-counting allocated funds as additional assets.
- Explain whether goal progress is an account balance, an earmarked portion of an account, or simulated contributions.
- Keep goal progress coherent after account balance changes and transfers.

### 14.2 Debt details and payoff

For credit cards and installment loans, provide a debt overview with outstanding principal/amount owed, APR, minimum or scheduled payment, and projected payoff.

- Model at least a basic monthly interest accrual and payment sequence in the **forecast**, with documented assumptions.
- Support changing a regular payment or adding extra principal payments in a scenario.
- Distinguish interest expense from loan principal reduction.
- Show an amortization-style schedule for installment debt (period, starting balance, interest, principal, payment, ending balance).
- Do not allow the final payment to overshoot the remaining debt in the projection.
- Handle zero APR, zero or insufficient payments, payoff before the requested horizon, and payments less than accrued interest without inventing success.
- Present savings from accelerated repayment in terms of time and interest, if calculable from the chosen assumptions.

Do not make unsupported claims that a projection is an actual lender payoff quote.

## 15. Reports and analytics

Include real, recalculated charts/tables for:

- Income versus expense over time.
- Net cash flow by month.
- Spending by category and merchant.
- Net worth and asset/liability composition over time.
- Budget versus actual by month/category.
- Account balance history and changes.
- Credit-card and debt balances over time.
- Transfers separately from income and spending.

### Reporting controls

- Date range (preset and custom), account selection, category selection, and suitable grouping (month, category, merchant, account).
- Charts should show labels, meaningful units, and tooltips or accessible numeric detail.
- Permit viewing the underlying transactions from a summary where practical.
- Clearly explain how a metric was calculated, especially net cash flow, gross income, net spending after refunds, net worth, budget availability, and debt obligations.
- A period with no transactions should show an accurate zero/empty state, not `NaN`, undefined, a fabricated balance, or a crash.
- Period boundaries must be consistent for transactions on the first/last day of a month or year.

## 16. Scenario Planner and forecast comparisons

Provide an interactive sandbox for analyzing prospective financial changes while keeping the actual ledger unchanged.

### 16.1 Baseline projection

Generate a deterministic forward projection from the selected as-of date for **at least 12 months**. Include starting account balances, recurring incomes and expenses, debt obligations, and other data reasonably necessary for a useful baseline. Explain assumptions and avoid portraying unknown market returns as guaranteed.

### 16.2 User-defined changes

Users can create, name, edit, save, duplicate, and delete scenarios. Allow combinations of at least:

- Income increase or reduction with effective date.
- New or removed recurring expense.
- One-time expense or windfall on a future date.
- Increased or reduced monthly savings contribution.
- Extra or changed installment-loan payment.
- Credit-card payment changes.
- An optional investment growth-rate assumption.

Changes must apply to the forecast only unless the user explicitly chooses a supported mechanism for committing actual transactions.

### 16.3 Comparison output

For a baseline and one or more scenarios, show:

- Projected net worth over time.
- Ending checking/cash or liquid asset position.
- Total income, expenses, and debt interest over the horizon.
- Debt remaining/payoff milestones.
- Savings-goal progress, where supported.
- Absolute and percentage differences where mathematically meaningful.
- A timeline highlighting when and why projections diverge.

A scenario compared against an identical copy of itself must show **zero differences**. Creating, deleting, or editing a scenario must not mutate baseline transactions or another scenario. A save/reload cycle should preserve scenario inputs and yield identical projections.

Provide a way to inspect the month-by-month underlying projected values, not just a headline percentage.

### 16.4 Forecast limitations

Handle negative checking balances, debts with insufficient payments, large windfalls, payoff mid-horizon, and overlapping changes in a coherent manner. Document assumptions for order of operations, interest accrual, and recurring-due-date interpretation.

The engine must produce the same projection for the same data, date, and assumptions, regardless of which pages were visited previously.

## 17. Interactive Test Lab

Build an accessible **Test Lab** intended for power users, debugging, and financial-rule exploration. It should be a real app feature and a convenient place to verify domain logic.

Required capabilities:

1. Select and reset the deterministic presets from Section 4.
2. Inspect and edit a smaller custom dataset of accounts, transactions, categories, transfers, and relevant forecast inputs.
3. Load a custom scenario from **JSON**, and export the current Test Lab dataset as JSON.
4. Validate the dataset before applying it and provide actionable feedback for invalid references, duplicate IDs, missing properties, bad dates, invalid monetary amounts, and malformed arrays/objects.
5. Inspect computed account balances, net worth, total income/expenses/transfers, and categorized spending.
6. Inspect individual transaction effects and a running ledger to understand why balances changed.
7. Run reconciliation examples and display exact expected-versus-calculated values.
8. Compare a baseline with an edited or imported variant, showing which accounts, totals, reconciliations, or budgets change.
9. Offer a **consistency/verification panel** that checks important invariants and reports actual findings rather than always displaying success.
10. Export useful diagnostic results in a readable format.

Users should be able to reach a state with a zero discrepancy, and also deliberately produce a mismatch to see the discrepancy explained. Editing a dataset must be safe: reject invalid inputs without overwriting the previous valid state.

### 17.1 Verification panel checks

At minimum, check for:

- Unresolved account/category/transaction references.
- Duplicate internal entity IDs.
- Malformed dates and nonintegral money values.
- Splits whose sum differs from their parent.
- Linked transfers whose effects do not balance.
- Reconciliation records referring to missing or incompatible transactions.
- Inconsistent ledger totals versus independently aggregated transaction effects.
- Scenario or report calculations that fail basic internal consistency.

The panel should display which records are involved and whether a problem blocks calculation or is a warning.

## 18. JSON persistence, import/export, and recovery

Provide a coherent data-management page.

- Export the complete application dataset in a human-inspectable **versioned JSON format**, including accounts, transactions, splits, transfers, categories, rules, budgets, recurring rules, goals, reconciliations, scenarios, settings, and other information needed to restore equivalent behavior.
- Import a previously exported JSON file and restore equivalent balances, reports, and user-created structures.
- Include a schema/version indicator and an approach for unsupported or older versions.
- Offer a validation preview or summary before replacing data.
- Invalid JSON, incorrect structures, unknown required references, duplicate IDs, malformed metadata, and incompatible data must not blank the screen or destroy the last valid dataset.
- Resetting, importing, switching presets, or clearing local data should involve understandable confirmation, with an opportunity to back up user work when appropriate.
- Prevent partial imports and unintended merges. If merge behavior is supported, make the rules explicit.
- If stored data becomes corrupt or incompatible, provide a recovery path rather than silently resetting everything without disclosure.
- Export/import should preserve semantic identity, not just numeric totals. Reconciliation status and transfer links must survive a round trip.
- Any IDs used for object lookup must behave correctly as ordinary user data, without colliding with special programming-language property names.

## 19. Validation and failure handling

Apply validation consistently across initial data, forms, CSV, JSON, account edits, transaction updates, recurrence rules, and persisted state.

### 19.1 Examples of invalid data

- Duplicate IDs within an entity collection.
- Missing accounts or categories referenced by transactions.
- Non-string text fields where strings are required.
- Missing or malformed arrays and nested records.
- Invalid calendar dates such as February 30.
- NaN, infinity, unsafe integers, fractional cent values, or absurdly large monetary inputs.
- Incompatible transaction classifications and transfer/split relationships.
- Invalid budget months, negative or malformed required limits, invalid forecast date ranges, or nonsensical interest rates.
- A record that becomes invalid only after another record is edited or deleted.
- Names and IDs that are syntactically unusual but permitted by the application's public schema.

Do not assume that data is valid merely because it passed through a UI control. Validate at the domain/persistence boundary as well.

### 19.2 Failure policies

- Reject invalid mutations **before** committing state, or provide a clearly explained recoverable correction workflow.
- Display specific useful error messages; do not use generic browser alerts for every validation problem.
- Never represent an unsuccessful edit as saved.
- Never silently drop a valid transaction from aggregate reports while still letting it affect balances or forecasts.
- Never silently discard the entire dataset on reload because a previously accepted edit becomes invalid.
- An error in one table, chart, imported row, or scenario should not take down the entire app.
- Avoid unsafe evaluation, untrusted HTML insertion, executable content from CSV/JSON, or outbound transmission of private financial content.

## 20. Deterministic reference cases

The following small cases are **independent acceptance fixtures**, not substitutes for the full seeded dataset. Implementations may represent them using their own schema, but observable financial results must agree.

### Case A — net worth, card payments, and refunds

Starting contributions:

| Account | Opening contribution |
|---|---:|
| Checking | +$1,000.00 |
| Savings | $0.00 |
| Credit card | -$200.00 |

Apply these posted records in chronological order:

1. Payroll to checking: **+$600.00** (income).
2. Rent from checking: **-$120.00** (expense).
3. Groceries charged to credit card: **-$40.00** (expense).
4. Payment from checking to credit card: checking **-$50.00**, card **+$50.00** (linked internal transfer).
5. Grocery refund on credit card: **+$10.00** (expense reversal/refund).
6. Transfer from checking to savings: checking **-$30.00**, savings **+$30.00**.

Required final contributions:

| Account | Final contribution |
|---|---:|
| Checking | **+$1,400.00** |
| Savings | **+$30.00** |
| Credit card | **-$180.00** |
| **Net worth** | **+$1,250.00** |

Net worth started at **$800.00** and increased by **$450.00**. Income is **$600.00**; net expense is **$150.00** ($120 rent + $40 groceries - $10 refund). Neither transfer contributes to income or expense.

### Case B — split accounting

A posted **-$47.35** transaction from checking is split into **-$12.50** groceries and **-$34.85** household goods. The account balance changes by **-$47.35 exactly once**. Both category totals receive their respective allocations. An attempted split totaling **-$47.34** is rejected before data is saved.

### Case C — identical legitimate transactions and reimport

Two separate coffee purchases on the same account and date, each for **-$4.75** at the same merchant, are legitimate distinct transactions with separate external references. Both must remain if they appear in one valid import. Reimporting the same two records should not create four total purchases. If an external reference is unavailable, suspected matches require a defensible review/matching strategy rather than unavoidable silent deletion of one legitimate purchase.

### Case D — reconciliation

For checking, a statement starts at **+$500.00**. Cleared posted effects are **+$1,200.00**, **-$300.00**, and **-$75.25**. Therefore:

- Calculated statement close: **+$1,324.75**.
- If the entered statement closing contribution is **+$1,324.75**, discrepancy is **$0.00** and reconciliation can complete.
- If the entered statement closing contribution is **+$1,319.75**, discrepancy is **-$5.00** and completion must be blocked or explicitly handled according to the documented adjustment policy.
- An uncleared **-$20.00** transaction must not be counted in the cleared sum merely because it is posted in the same date range.

### Case E — rollover budgets

A rollover-enabled category has a base allocation of **$200.00 per month**:

- January net spending: **$150.00** → $50.00 rolls into February.
- February available: **$250.00**; net spending: **$280.00** → -$30.00 rolls into March.
- March available: **$170.00** before March spending.

If January spending is edited, downstream available balances must recalculate. The same mechanism must work across December into January.

### Case F — identical scenarios

A scenario compared with an exact duplicate, using the same as-of date and forecast assumptions, must report **zero** monetary differences, **zero** difference in debt payoff timing, and no affected accounts or goals. An unchanged negative-balance or unpaid-debt state is not itself evidence that a scenario changed anything.

### Case G — time and precision boundaries

- January 31 monthly recurrence must behave consistently when February has no 31st, without emitting invalid dates.
- A leap-year February 29 is valid; February 30 is not.
- Amounts such as `$0.10`, `$0.20`, and `$0.30` must not generate phantom one-cent differences.
- Repeated edits, import/export cycles, and rerunning identical projections must preserve cent-level results.

## 21. Performance and scalability

- Seeded 500+ transactions and charts should load without noticeable lockups under ordinary local development conditions.
- Test Lab should remain usable with at least **2,000 transactions**, 20 accounts, 50 categories, and a full year of monthly reporting.
- Avoid excessive recalculation on every keystroke where it would make the interface sluggish.
- Importing a moderately large CSV should provide responsive feedback.
- Financial aggregation and scenario calculations should be deterministic; adding a chart or changing navigation should not alter the computed results.

## 22. Automated verification requirements

Write a substantive automated suite using appropriate tools (e.g., Vitest and React Testing Library); browser-level testing is encouraged where feasible. The goal is **independent verification of domain behavior and the application lifecycle**, not merely test-count inflation.

Tests should cover:

- Account balance and net worth aggregation across asset/liability types.
- Income, expenses, transfers, refunds, pending records, adjustments, and splits.
- Repeated credit-card purchases/payments and categorization/report exclusions.
- Exact-cent arithmetic and rounding where it is required.
- Editing/deleting transactions and their downstream effects.
- Atomic transfer mutations and removal of linked records.
- CSV parsing, column mapping, duplicate/reimport behavior, and bad input.
- Reconciliation mathematics, cleared status, saved history, and later edits.
- Budget monthly spending and multimonth rollover propagation.
- Recurrences, month/year boundaries, and occurrence matching.
- Debt interest/payment calculations and payoff edge cases.
- Scenario isolation, duplicate scenarios, comparison identity, and persistence.
- Data schema validation and safe handling of malformed user-provided input.
- Import/export round-trip invariants and recovery from corrupt stored state.
- Component-level interaction tests for major workflows.
- A real save/reload or unmount/remount workflow—not just isolated storage helper calls.
- Selected responsive/keyboard behaviors when suitable tooling is available.
- Every result in the deterministic reference cases above.

Run the complete suite, lint checks, and a production build before completion. Fix failures rather than documenting avoidable broken behavior. Tests should verify numerical outputs and state consequences, not simply that an element or function exists.

## 23. Documentation and knowledge base

### 23.1 Repository documentation

Provide a useful README containing:

- What LedgerLens does and which functionality is implemented.
- Install/run/test/build instructions and relevant package versions or constraints.
- Project organization and the financial data model.
- Where persistence lives and backup/reset/import instructions.
- Sample workflows for importing transactions, reconciling, budgeting, and scenario comparison.
- Important calculation conventions, rounding choices, forecasting assumptions, and known limitations.
- Testing approach and any unverified behavior.

### 23.2 Obsidian vault documentation

Create a meaningful linked documentation collection in my Obsidian vault code_projects under a dedicated folder named **`LedgerLens Finance Platform CS-5.5-h`**.

Document the system at **component and function level**, with:

- An architecture overview and component tree.
- Domain entities, field meanings, key invariants, and persistence schema.
- Ledger/balance, transfer, split, reconciliation, budgeting, forecasting, and import engines.
- UI component responsibilities and interactions.
- Data flow from a user action to persistent state and recalculated charts.
- Nontrivial algorithms with examples and appropriate diagrams (Mermaid is welcome).
- Tests and strategies for diagnosing inconsistent totals.
- Meaningful internal links between notes, rather than a flat dump of shallow one-line files.

Accuracy and usefulness matter more than sheer note count. Documentation must agree with the delivered code.

## 24. Completion and quality bar

A finished app must demonstrate the following end-to-end journey without manual source edits:

1. Start LedgerLens with the seeded data and inspect current net worth, cash flow, and debt.
2. Filter transactions, open a purchase, change its category, and see the correct reports and budgets update.
3. Create a split expense, a refund, and an internal credit-card payment without double-counting money.
4. Import a CSV, review suspected duplicates, commit it, inspect the effects, and undo the import batch.
5. Reconcile an account statement, inspect a deliberate discrepancy, correct it, and save a completed reconciliation.
6. Modify a budget and observe rollover changes into a subsequent month.
7. Create/modify a recurring bill and view its effect on upcoming obligations and projections.
8. Create a debt-acceleration scenario and compare it against baseline without modifying actual balances.
9. Open the Test Lab, run a small custom ledger, inspect verifier results, and export/import the data.
10. Save, reload, and confirm that accounts, transactions, reconciliation history, budgets, rules, goals, and scenarios remain coherent.
11. Use major pages at desktop and mobile widths without lost actions, inaccessible tables, or critical clipping.
12. Run automated tests and production build successfully.

The application should clearly identify genuinely unsupported activities instead of presenting inert UI controls that imply they work.

## 25. Implementation judgment

The specification deliberately does not dictate every implementation decision. Some areas—including component design, reconciliation repair UX, CSV matching heuristics, pending-to-posted matching, external transfers, archive/delete workflows, goal allocation, forecast assumptions, and visual presentation—require thoughtful engineering judgment. Choose solutions that are consistent with the financial invariants and product goals, and make those decisions clear to the user.

Do **not** reduce the scope by replacing functional requirements with screenshots, descriptive placeholders, static totals, or hard-coded expected answers. Do **not** interpret the presence of a passing build as sufficient evidence that the financial workflows are correct.

Deliver an application that is functional, internally consistent, understandable, and testable. Where constraints conflict or requirements admit multiple reasonable interpretations, choose a defensible implementation, document the interpretation, and preserve the underlying financial correctness.
