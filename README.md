# LedgerLens

A local-first personal-finance workspace: accounts, transactions, transfers, splits, CSV import, statement reconciliation, budgets with rollover, recurring bills, goals, debt payoff, reports, a scenario planner and a Test Lab. All data is fictional and stays in your browser. No bank connections, keys or network access are needed after `yarn install`.

## Run it
```
yarn install
yarn dev        # development server
yarn test       # Vitest + React Testing Library (320 tests)
yarn lint       # ESLint
yarn build      # production build into dist/
yarn e2e        # optional Playwright browser tests, 18 (first: yarn playwright install chromium)
```
Node 20+ and Yarn 4. ESLint is pinned to v9 because `eslint-plugin-react` does not yet support v10.

## Where data lives
Browser `localStorage`, keys `ledgerlens:v1:workspace:main` (My finances) and `...:lab` (Test Lab sandbox). It is browser/profile specific. Back up with **Settings / Data > Export JSON** (versioned, human-readable); restore with **Import JSON** (validated preview, replaces rather than merges, offers a backup first). Unreadable stored data is never overwritten: a recovery screen offers download, restore from file, an explicit repair for a known legacy problem (below), or demo data (with a verbatim backup kept). `localStorage` holds roughly 5-10 MB per origin (on the order of ten thousand transactions); a write that exceeds it is reported in a banner, so export JSON before very large imports.

## Architecture
- `src/domain` pure financial logic: money (integer cents, half-away-from-zero rounding), calendar dates, ledger/balances/net worth, reports, budgets, reconciliation, recurring, goals, debt, validation (`validate.js`), independent verifier (`verify.js`), and `ops/*` (atomic mutations: Immer draft -> structural validation -> commit or reject).
- `src/forecast` deterministic event-based projection, scenario changes, comparison.
- `src/imports` CSV parser, column mapping, duplicate matching. `src/persistence` storage + versioned JSON. `src/state` store (workspaces, undo, persistence) and React hooks. `src/seed` demo world, Test Lab presets, reference fixtures, invalid-candidate library, stress generator. `src/ui` pages/components/charts.
- Conventions: every transaction amount is its signed effect on the account's net-worth contribution (liabilities negative). Transfers are two linked legs summing to zero and are never income/spending; refunds are positive expense entries; splits sum exactly to the parent; pending vs posted is a global "basis" setting.
- Workspaces: "My finances" is separate from the Test Lab sandbox, so presets never destroy real work.

## Key behaviours and assumptions
- **Transfers**: two legs summing to zero, never income/spending, and **both legs always share one status** (pending/posted). Marking either leg posted/pending - singly or in bulk - changes both in one atomic commit (the UI says so), so posted net worth cannot move by a half transfer. Single-leg *external* transfers are exempt. Editing through either leg flags a completed reconciliation that involved the other.
- **Import identity**: an external reference is authoritative. Same reference = the same bank record (already imported, or the posted version of a pending item); **different references are different purchases on every path** (the similarity heuristic never bridges two references; `commitImport` re-checks). Without references, identical rows are matched by count and flagged "Possible duplicate" (default skip, Keep available); similarity matches against a pending item are labelled "similarity", flagged for review, and offer a picker when several pending items qualify. "Import as new" is always available.
- **Settling a changed amount with splits**: the preview shows the splits rescaled **proportionally** (largest remainder; e.g. -$6/-$4 at -$11 becomes -$6.60/-$4.40, exact to the cent). An explicit allocation is accepted by the domain when it sums exactly; "Import as new"/"Skip" cancels the adjustment; undo restores the original amount, splits, status and source.
- **Import batches** only list what they own; the validator rejects a batch that names a manual or foreign transaction, and undo re-checks ownership. Undo is refused (changing nothing) if a created row is now half a transfer, was reversed, was settled by a later import, or is in a completed reconciliation.
- **Reconciliation**: calculated close = opening + cleared posted effects; discrepancy = closing - calculated; completion only at exactly 0, or via an explicit, visible, documented adjustment. A completed record holds one validated snapshot per cleared item; malformed snapshots are rejected at the JSON/storage boundary, while *valid but stale* snapshots (the transaction was edited, moved or deleted later) are kept and shown as "Out of date".
- **Budgets**: available = base + rollover; chain recomputed from the start month across years.
- **Forecast**: starts from pending-inclusive balances at the as-of date and covers the calendar months from as-of + 1 day; events on or before the as-of date are history. Recurring items, estimated everyday spending (trailing average of non-recurring, non-interest spending), debt interest (balance x APR / 12 per due date) then payments (never overshooting), month-end savings interest, optional investment growth (default 0%). **Accounts that open inside the window enter once, on their opening date** (not as income); scheduled items dated before an account opens are skipped with a note. Savings changes recur monthly from their effective date however old it is. Scenarios never touch the ledger; committing a scenario to the ledger is unsupported.
- **Debt payments**: the Debt page, Dashboard and forecast use one rule (`debtPeriod`): interest first, then the account's payment policy - *fixed*, *minimum* (the larger of the floor and interest + x% of the balance, **recalculated each month**) or *pay in full* - never exceeding what is owed. The calculator's typed "Regular payment" is a separate, labelled fixed-payment what-if, and for minimum-payment accounts a callout compares "keep paying this month's amount".
- Not lender quotes; no holiday calendar for business-day adjustments; external transfers are single-sided.

## Validation changes and older saved data
The schema version is unchanged (1), but validation is stricter: transfer status pairing, snapshot structure and batch ownership are now enforced (see `validate.js`). The only rule a file written by an earlier version of this app could break is the **mixed-status transfer** (created by the old one-leg "Mark posted"). Such data is not silently "fixed": the Recovery screen (saved data) or the "Not importable" panel (JSON import) names the transfer and both legs and asks you to choose, per transfer, whether both sides are posted or pending; the whole dataset is then re-validated, and Recovery keeps a verbatim backup of the original text.

## Testing
Vitest (320 tests in 10 files) covers money/dates, reference cases A-G, ledger ops, import, debt/forecast, recurring/goals, persistence/validation/verifier and UI workflows (including unmount/remount, corrupt-storage recovery, real JSON file uploads and stale links). The review remediation added regression tests for every finding (R1-R8) at the domain, UI and browser level; 79 of the tests written for R1-R8 failed when run against the previously reviewed code (follow-up tests added later were not re-run against it). Playwright (`e2e/`, 18 tests) drives real Chromium: workflows, keyboard, 390px/320px layouts, and controlled fixtures seeded into `localStorage` that are saved and reloaded (transfer status, import identity, tampered JSON uploads, corrupt storage).
Also checked by hand with scripts (not part of `yarn test`): axe-core, horizontal overflow and console errors on all pages in light/dark (earlier) and on the views changed by the remediation at 1440/768/390/320 px; a 2,122-transaction / 20-account / 50-category Test Lab dataset (all pages load in well under a second); CSV imports of 1,000 / 5,000 / 15,000 rows (preview 40-200 ms, commit 66-211 ms in Chromium).
Unverified: Safari and Firefox; screen readers (only automated axe-core and keyboard tests); 768px layouts of pages the remediation did not touch; behaviour after a `localStorage` quota overflow beyond the banner.

## Documentation
Linked component/function-level notes live in the Obsidian vault `code_projects` under `LedgerLens Finance Platform CS-5.5-h` (start at `00 Index`; `13 Review Remediation (R1-R8)` explains what changed and why, with worked examples and the tests that enforce them).

## Known limitations
- Scenarios cannot be committed to the ledger; business-day adjustment has no holiday calendar; external transfers are single-sided; projections are planning estimates, not lender quotes.
- Layout/accessibility were verified with Playwright and axe-core in Chromium only (no Safari/Firefox runs, no screen-reader testing).
- A custom split-allocation editor in the import preview is not built: the preview offers the proportional rescale, import-as-new, or skip (the domain accepts an explicit allocation).
- Very large ledgers are bounded by browser `localStorage` capacity (roughly 5-10 MB).
- The main bundle is ~780 KB (single chunk); no code-splitting.
