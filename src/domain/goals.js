/**
 * Savings goals.
 *
 * Progress semantics (stated in the UI): a goal is an EARMARK, not extra money.
 *  - account goals count part of a linked account's balance: 'full' (up to the target), 'fixed'
 *    (a set amount) or 'percent' of the balance. Goals sharing an account are served in `priority`
 *    order and can never earmark more than the account actually holds, so funds are never double counted.
 *  - 'manual' goals track simulated contributions that are not tied to any account.
 * Net worth is never increased by a goal.
 */
import { buildIndex, accountContribution } from './ledger.js';
import { diffDays, monthKey, monthsBetween, addMonths } from './dates.js';
import { mulDiv } from './money.js';

const ceilDiv = (a, b) => Math.floor((a + b - 1) / b);

/** Calendar months from `from` to `to`, rounded UP to whole months (at least 1 when `to` is later). */
function wholeMonthsUntil(from, to) {
  let m = monthsBetween(monthKey(from), monthKey(to));
  while (m > 0 && addMonths(from, m) > to) m -= 1;
  if (addMonths(from, m) < to) m += 1;
  return Math.max(1, m);
}

/** Allocate account balances to goals given a map accountId -> available cents. */
export function allocateGoals(goals, balanceOf) {
  const remaining = new Map();
  const out = new Map();
  const ordered = [...goals].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
  for (const g of ordered) {
    let allocated = 0;
    if (g.allocation.type === 'manual') {
      allocated = 0; // filled by caller
    } else {
      if (!remaining.has(g.accountId)) remaining.set(g.accountId, Math.max(0, balanceOf(g.accountId)));
      const left = remaining.get(g.accountId);
      const bal = Math.max(0, balanceOf(g.accountId));
      let want;
      if (g.allocation.type === 'full') want = g.targetCents;
      else if (g.allocation.type === 'fixed') want = g.allocation.value;
      else want = mulDiv(bal, g.allocation.value, 10000);
      allocated = Math.min(want, left);
      remaining.set(g.accountId, left - allocated);
    }
    out.set(g.id, allocated);
  }
  return out;
}

/**
 * Progress for every goal at `asOfDate`.
 * @returns {Array<{goal, allocatedCents, remainingCents, pct, monthsLeft, perMonthCents, perWeekCents, status, milestones}>}
 */
export function goalProgress(data, asOfDate, includePending = false) {
  const index = buildIndex(data);
  const balanceOf = (id) => accountContribution(index, id, asOfDate, includePending);
  const alloc = allocateGoals(data.goals, balanceOf);
  return [...data.goals]
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1))
    .map((goal) => {
      let allocated = alloc.get(goal.id) || 0;
      if (goal.allocation.type === 'manual') allocated = goal.contributions.filter((c) => c.date <= asOfDate).reduce((s, c) => s + c.amountCents, 0);
      allocated = Math.max(0, allocated);
      const remaining = Math.max(0, goal.targetCents - allocated);
      const days = diffDays(asOfDate, goal.targetDate);
      const monthsLeft = days <= 0 ? 0 : wholeMonthsUntil(asOfDate, goal.targetDate);
      const weeksLeft = days <= 0 ? 0 : Math.max(1, Math.ceil(days / 7));
      const pct = Math.min(100, Math.round((allocated / goal.targetCents) * 1000) / 10);
      let status = 'on_track';
      if (remaining === 0) status = 'complete';
      else if (days <= 0) status = 'overdue';
      return {
        goal,
        allocatedCents: allocated,
        remainingCents: remaining,
        pct,
        monthsLeft,
        perMonthCents: remaining === 0 ? 0 : monthsLeft ? ceilDiv(remaining, monthsLeft) : remaining,
        perWeekCents: remaining === 0 ? 0 : weeksLeft ? ceilDiv(remaining, weeksLeft) : remaining,
        status,
        milestones: [25, 50, 75, 100].map((m) => ({ pct: m, reached: pct >= m })),
        accountBalanceCents: goal.accountId ? balanceOf(goal.accountId) : null,
      };
    });
}

/** Per account: balance, total earmarked by goals, and what remains unallocated. */
export function accountAllocations(data, asOfDate, includePending = false) {
  const index = buildIndex(data);
  const progress = goalProgress(data, asOfDate, includePending).filter((p) => p.goal.accountId);
  const byAcct = new Map();
  for (const p of progress) {
    const e = byAcct.get(p.goal.accountId) || { accountId: p.goal.accountId, balanceCents: accountContribution(index, p.goal.accountId, asOfDate, includePending), earmarkedCents: 0 };
    e.earmarkedCents += p.allocatedCents;
    byAcct.set(p.goal.accountId, e);
  }
  return [...byAcct.values()].map((e) => ({ ...e, unallocatedCents: e.balanceCents - e.earmarkedCents }));
}

export { monthKey };
