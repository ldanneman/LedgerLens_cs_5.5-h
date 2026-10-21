/**
 * Compare two projections (baseline vs scenario, or scenario vs scenario).
 * Two projections that came from identical inputs yield identical === true and every difference 0.
 */

/** diff and percent difference (null when the base is 0, where a percent is not meaningful). */
function delta(base, other) {
  const diff = other - base;
  return { base, other, diff, pct: base !== 0 ? Math.round((diff / Math.abs(base)) * 1000) / 10 : null };
}

/**
 * @param {object} a first projection (the reference) @param {object} b second projection
 * @returns {object} totals/debt/goal/month differences, affected accounts, and a divergence timeline
 */
export function compareProjections(a, b) {
  if (a.asOfDate !== b.asOfDate || a.horizonMonths !== b.horizonMonths) {
    return { comparable: false, reason: 'The projections use different as-of dates or horizons.', identical: false };
  }
  const totalKeys = ['incomeCents', 'expensesCents', 'interestPaidCents', 'interestEarnedCents', 'growthCents', 'netCashFlowCents', 'endNetWorthCents', 'endLiquidCents', 'endDebtCents'];
  const totals = {};
  for (const k of totalKeys) totals[k] = delta(a.totals[k], b.totals[k]);

  const accountIds = [...a.start.balances.keys()];
  const affectedAccounts = [];
  for (const id of accountIds) {
    const differs = a.monthly.some((m, i) => (m.balances.get(id) || 0) !== (b.monthly[i].balances.get(id) || 0));
    if (differs) {
      const last = a.monthly.length - 1;
      affectedAccounts.push({ accountId: id, endDiffCents: (b.monthly[last].balances.get(id) || 0) - (a.monthly[last].balances.get(id) || 0) });
    }
  }

  const monthly = a.monthly.map((m, i) => ({
    month: m.month,
    netWorth: delta(m.netWorthCents, b.monthly[i].netWorthCents),
    liquid: delta(m.liquidCents, b.monthly[i].liquidCents),
    debt: delta(m.debtCents, b.monthly[i].debtCents),
  }));

  const debts = a.debts.map((d) => {
    const o = b.debts.find((x) => x.accountId === d.accountId);
    const bothPaid = d.payoffMonthIndex !== null && o && o.payoffMonthIndex !== null;
    return {
      accountId: d.accountId,
      name: d.name,
      aPayoffDate: d.payoffDate,
      bPayoffDate: o?.payoffDate ?? null,
      aStatus: d.status,
      bStatus: o?.status,
      monthsEarlier: bothPaid ? d.payoffMonthIndex - o.payoffMonthIndex : null,
      payoffChanged: (d.payoffDate ?? null) !== (o?.payoffDate ?? null) || d.status !== o?.status,
      interest: delta(d.interestCents, o?.interestCents ?? 0),
      endOwed: delta(d.endOwedCents, o?.endOwedCents ?? 0),
    };
  });

  const goals = a.goals.map((g) => {
    const o = b.goals.find((x) => x.goalId === g.goalId);
    return {
      goalId: g.goalId,
      name: g.name,
      end: delta(g.endCents, o?.endCents ?? 0),
      aReached: g.reachedMonth,
      bReached: o?.reachedMonth ?? null,
      changed: g.endCents !== (o?.endCents ?? 0) || g.reachedMonth !== (o?.reachedMonth ?? null),
    };
  });
  const affectedGoals = goals.filter((g) => g.changed);

  // timeline: where and why the projections diverge
  const tagged = (p) => p.events.filter((e) => e.changeId);
  const tl = [];
  let prevDiff = 0;
  let firstDivergence = null;
  monthly.forEach((m, i) => {
    const causesMap = new Map();
    for (const e of [...tagged(a), ...tagged(b)].filter((x) => x.month === m.month)) {
      const c = causesMap.get(e.changeId) || { changeId: e.changeId, label: e.label, count: 0, amountCents: 0 };
      c.count += 1;
      c.amountCents += e.nwEffectCents;
      causesMap.set(e.changeId, c);
    }
    const diff = m.netWorth.diff;
    const change = diff - prevDiff;
    if (diff !== 0 && firstDivergence === null) firstDivergence = m.month;
    tl.push({
      month: m.month,
      netWorthDiffCents: diff,
      changeInDiffCents: change,
      causes: [...causesMap.values()],
      knockOn: change !== 0 && causesMap.size === 0,
    });
    prevDiff = diff;
    void i;
  });

  const identical =
    affectedAccounts.length === 0 &&
    monthly.every((m) => m.netWorth.diff === 0 && m.liquid.diff === 0 && m.debt.diff === 0) &&
    Object.values(totals).every((t) => t.diff === 0) &&
    debts.every((d) => !d.payoffChanged && d.interest.diff === 0 && d.endOwed.diff === 0) &&
    affectedGoals.length === 0;

  return { comparable: true, identical, totals, monthly, debts, goals, affectedAccounts, affectedGoals, timeline: tl, firstDivergence };
}
