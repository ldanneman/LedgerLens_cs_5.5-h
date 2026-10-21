# LedgerLens

A local-first personal-finance workspace: accounts, transactions, transfers, splits, CSV import, statement reconciliation, budgets with rollover, recurring bills, goals, debt payoff, reports, a scenario planner and a Test Lab. All data is fictional and stays in your browser. No bank connections, keys or network access are needed after `yarn install`.

## Run it
```
yarn install
yarn dev        # development server
yarn test       # Vitest + React Testing Library (218 tests)
yarn lint       # ESLint
yarn build      # production build into dist/
yarn e2e        # optional Playwright browser tests (first: yarn playwright install chromium)
```
Node 20+ and Yarn 4. ESLint is pinned to v9 because `eslint-plugin-react` does not yet support v10.

## Where data lives
Browser `localStorage`, keys `ledgerlens:v1:workspace:main` (My finances) and `...:lab` (Test Lab sandbox). It is browser/profile specific. Back up with **Settings / Data > Export JSON** (versioned, human-readable); restore with **Import JSON** (validated preview, replaces rather than merges, offers a backup first). Unreadable stored data is never overwritten: a recovery screen offers download, restore from file, or demo data (with a verbatim backup kept).

## Architecture
- `src/domain` pure financial logic: money (integer cents, half-away-from-zero rounding), calendar dates, ledger/balances/net worth, reports, budgets, reconciliation, recurring, goals, debt, validation (`validate.js`), independent verifier (`verify.js`), and `ops/*` (atomic mutations: Immer draft -> structural validation -> commit or reject).
- `src/forecast` deterministic event-based projection, scenario changes, comparison.
- `src/imports` CSV parser, column mapping, duplicate matching. `src/persistence` storage + versioned JSON. `src/state` store (workspaces, undo, persistence) and React hooks. `src/seed` demo world, Test Lab presets, reference fixtures, invalid-candidate library, stress generator. `src/ui` pages/components/charts.
- Conventions: every transaction amount is its signed effect on the account's net-worth contribution (liabilities negative). Transfers are two linked legs summing to zero and are never income/spending; refunds are positive expense entries; splits sum exactly to the parent; pending vs posted is a global "basis" setting.
- Workspaces: "My finances" is separate from the Test Lab sandbox, so presets never destroy real work.

## Key behaviours and assumptions
- Duplicate import detection: external reference is authoritative (different reference = different purchase); without references, identical rows are matched by count and flagged for review (default skip, "Keep" available); a posted row can settle a similar pending item.
- Reconciliation: calculated close = opening + cleared posted effects; discrepancy = closing - calculated; completion only at exactly 0, or via an explicit, visible, documented adjustment. Completed records snapshot cleared items, so later edits mark them "out of date".
- Budgets: available = base + rollover; chain recomputed from the start month across years.
- Forecast: starts from pending-inclusive balances at the as-of date; recurring items, estimated everyday spending (trailing average of non-recurring, non-interest spending), debt interest (balance x APR / 12 per due date) then payments (never overshooting), month-end savings interest, optional investment growth (default 0%). Scenarios never touch the ledger; committing a scenario to the ledger is unsupported.
- Not lender quotes; no holiday calendar for business-day adjustments; external transfers are single-sided.

## Testing
Vitest covers money/dates, reference cases A-G, ledger ops, import, debt/forecast, recurring/goals, persistence/validation/verifier and UI workflows (including unmount/remount and corrupt-storage recovery). Playwright (`e2e/`) drives real Chromium (workflows, keyboard, 390px/320px layouts). An axe-core sweep of all pages in light/dark is clean.

## Documentation
Linked component/function-level notes live in the Obsidian vault `code_projects` under `LedgerLens Finance Platform CS-5.5-h` (start at `00 Index`).

## Known limitations
- Scenarios cannot be committed to the ledger; business-day adjustment has no holiday calendar; external transfers are single-sided; projections are planning estimates, not lender quotes.
- Layout/accessibility were verified with Playwright and axe-core in Chromium only (no Safari/Firefox runs).
- The main bundle is ~780 KB (single chunk); no code-splitting.
