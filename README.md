# LedgerLens

A local-first personal-finance workspace: accounts, transactions, transfers, splits, CSV import, statement reconciliation, budgets with rollover, recurring bills, goals, debt payoff, reports, a scenario planner and a Test Lab. All data is fictional and stays in your browser. No bank connections, keys or network access are needed after `yarn install`.

## Run it
```
yarn install
yarn dev        # development server
yarn test       # Vitest + React Testing Library (322 tests)
yarn lint       # ESLint
yarn build      # production build into dist/
yarn e2e        # optional Playwright browser tests, 22 (first: yarn playwright install chromium)
```
Node 20+ and Yarn 4. ESLint is pinned to v9 because `eslint-plugin-react` does not yet support v10.

## Where data lives
Browser `localStorage`, keys `ledgerlens:v1:workspace:main` (My finances) and `...:lab` (Test Lab sandbox). It is browser/profile specific. Back up with **Settings / Data > Export JSON** (versioned, human-readable); restore with **Import JSON** (validated preview, replaces rather than merges, offers a backup first). Unreadable stored data is never overwritten: a recovery screen offers download, restore from file, an explicit repair for one known legacy problem (see below), or demo data (with a verbatim backup kept). `localStorage` holds roughly 5-10 MB per origin (on the order of ten thousand transactions); a save that does not fit is reported in a banner, so export JSON before very large imports.

## Architecture
- `src/domain` pure financial logic: money (integer cents, half-away-from-zero rounding), calendar dates, ledger/balances/net worth, reports, budgets, reconciliation, recurring, goals, debt, validation (`validate.js`), import-batch ownership (`batches.js`), explicit legacy repairs (`repairs.js`), independent verifier (`verify.js`), and `ops/*` (atomic mutations: Immer draft -> draft-reconciliation tidy-up -> structural validation -> commit or reject).
- `src/forecast` deterministic event-based projection, scenario changes, comparison.
- `src/imports` CSV parser, column mapping, duplicate matching. `src/persistence` storage + versioned JSON. `src/state` store (workspaces, undo, persistence) and React hooks. `src/seed` demo world, Test Lab presets, reference fixtures, invalid-candidate library, stress generator. `src/ui` pages/components/charts.
- Conventions: every transaction amount is its signed effect on the account's net-worth contribution (liabilities negative). Transfers are two linked legs summing to zero and are never income/spending; refunds are positive expense entries; splits sum exactly to the parent; pending vs posted is a global "basis" setting.
- Workspaces: "My finances" is separate from the Test Lab sandbox, so presets never destroy real work.

## Key behaviours and assumptions
- **Transfers**: two legs summing to zero, never income or spending, and **both legs always share one status**. Marking either leg posted or pending - on its own or in a bulk selection - changes both in one atomic commit and the app says so, so posted net worth never moves by half a transfer. Single-leg *external* transfers are exempt. A completed reconciliation that cleared one leg is flagged out of date when the other leg changes. Two entries can only be linked as a transfer when they share a status, and an import never posts one side of a transfer.
- **Import identity**: an external reference is authoritative - the same reference is the same bank record (already imported, or the posted version of a pending item); **different references are always different purchases**, on every matching path and again at commit. Without references, identical rows are matched by count and flagged "Possible duplicate" (default skip, Keep available). A posted row may settle a similar pending item; such matches are marked "similarity" and counted under "to review", and when several pending items qualify the preview offers a picker. "Import as new" is always one choice away.
- **Changed amounts with splits**: when settling changes the amount of a pending item with category splits, the preview shows the splits **rescaled in proportion** (largest-remainder rounding; e.g. -$6/-$4 settled at -$11 becomes -$6.60/-$4.40) so they still add up exactly. "Import as new" or "Skip" cancels it, the domain also accepts an explicit allocation that sums exactly, and undo restores the original amount, splits, status and source.
- **Import batches** only list records they own; the validator rejects a batch naming a manual or foreign transaction, and undo re-checks ownership and refuses - changing nothing - when a created row is now half of a transfer, was reversed, was settled by a later import, or is in a completed reconciliation.
- **Reconciliation**: calculated close = opening + cleared posted effects; discrepancy = closing - calculated; completion only at exactly 0, or via an explicit, visible, documented adjustment. A completed record holds one validated snapshot per cleared transaction. Malformed snapshots are rejected at the JSON/storage boundary; *valid but stale* history (a cleared transaction edited, moved or deleted later) is kept and shown as "Out of date". Drafts drop items that are deleted, moved or un-posted and recompute their discrepancy.
- **Budgets**: available = base + rollover; chain recomputed from the start month across years.
- **Forecast**: starts from pending-inclusive balances at the as-of date and covers the calendar months after it; anything on or before the as-of date is history. Recurring items, estimated everyday spending (trailing average of non-recurring, non-interest spending), debt interest (balance x APR / 12 per due date) then payments (never overshooting), month-end savings interest, optional investment growth (default 0%). **An account that opens inside the window enters once, on its opening date** (not as income); scheduled items dated before an account opens are not applied to it. Savings changes recur monthly from their effective date however old it is. Scenarios never touch the ledger; committing a scenario to the ledger is unsupported.
- **Debt payments**: the Debt page, the Dashboard, the upcoming-payments list and the forecast share one rule (`debtPeriod`): interest first, then the account's payment policy - *fixed*, *minimum* (the larger of the floor and interest + x% of the balance, **recalculated every month**) or *pay in full* - never more than is owed. A typed "Regular payment" in the calculator is a separate, labelled fixed-payment what-if; for minimum-payment accounts a callout compares "keep paying this month's amount" with the plan.
- **Validation**: every field of every record, including nested ones (snapshots, batch restore data, split and contribution notes, timestamps, scenario changes, dataset name), must have its documented type; malformed files are refused with the record and field named, and the current data is untouched.
- Not lender quotes; no holiday calendar for business-day adjustments; external transfers are single-sided.

## Validation changes and older saved data
The schema version is unchanged (1); only validation is stricter. The one rule that data written by an earlier version of this app can break is the **mixed-status transfer** (the old one-leg "Mark posted", or an import that settled one leg). Such data is not silently "fixed": the Recovery screen (saved data) or the "Not importable" panel (JSON import) lists each transfer with both legs and asks, per transfer, whether both sides are posted or pending. Only that choice is applied, the whole dataset is validated again, and Recovery keeps a verbatim backup of the original text. Older import batches that settled a transfer leg remain valid history; undoing such a batch is refused with an explanation.

## Testing
Vitest (322 tests in 10 files) covers money/dates, reference cases A-G, ledger ops, import, debt/forecast, recurring/goals, persistence/validation/verifier and UI workflows (unmount/remount persistence, corrupt-storage recovery and repair, real JSON file uploads, stale links, keyboard use of the repair choices). A systematic type fuzz sets every scalar field of every record type to a wrong-kind value and requires each file to be rejected. Regression tests exist for every finding of the independent review (R1-R8) and for related defects found while fixing them; the ones written against the reviewed code were confirmed to fail there. Expected values are independent of the code under test (e.g. the debt tests re-implement the payment rule in plain integer arithmetic).
Playwright (`e2e/`, 22 tests) drives the production build in Chromium: everyday journeys, keyboard, layouts at 1440/768/390/320 px (including the widest grid, the budget year view), and small controlled ledgers seeded into `localStorage` that are changed, saved and reloaded (transfer status, import identity, tampered JSON uploads, corrupt storage, legacy repair).
Also checked with scripts outside `yarn test`: axe-core on all 31 routes in light and dark (no violations); all 31 routes at the four widths (no horizontal page scroll, console errors or error boundaries); the same 22 journeys in WebKit (Safari's engine) - 21 pass as written and the skip-link test passes with Safari's Option+Tab focus key; a 2,122-transaction / 20-account / 50-category Test Lab session (every page and action <= 0.4 s); CSV imports of 1,000 / 5,000 / 15,000 rows (preview <= 0.2 s, commit <= 0.25 s in Chromium).
Not verified: Firefox (Playwright's Firefox build would not start on this macOS version), screen readers, and keyboard *operation* of native drop-downs in headless Chromium on macOS (focus order is tested; the browser ignores arrow keys there).

## Documentation
Linked component/function-level notes live in the Obsidian vault `code_projects` under `LedgerLens Finance Platform CS-5.5-h` (start at `00 Index`; `13 Review Remediation` explains each review finding, its cause, the fix and the tests that enforce it).

## Known limitations
- Scenarios cannot be committed to the ledger; business-day adjustment has no holiday calendar; external transfers are single-sided; projections are planning estimates, not lender quotes.
- Layout and accessibility were checked with Playwright and axe-core in Chromium, plus the browser journeys in WebKit; Firefox and screen readers were not tested.
- The import preview offers a proportional split re-allocation, import-as-new or skip; there is no inline editor for a custom split allocation (the domain accepts one).
- Very large ledgers are bounded by browser `localStorage` capacity (roughly 5-10 MB per origin).
- The main bundle is ~780 KB (single chunk); no code-splitting.
