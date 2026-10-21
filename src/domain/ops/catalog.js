/**
 * Operations on categories, categorization rules, budgets, goals, settings and scenarios.
 */
import { mutate, fail, err, clean, abort } from './common.js';
import { allocId, normalizeScenario, CATEGORY_KINDS, RULE_FIELDS, RULE_MATCHES, GOAL_ALLOCATIONS } from '../schema.js';
import { buildIndex } from '../ledger.js';
import { previewRules } from '../rules.js';
import { isValidDate, isValidMonth } from '../dates.js';
import { isValidCents } from '../money.js';

// ---------------------------------------------------------------- categories
/** Add a category (names are unique per kind, case-insensitive). */
export function addCategory(data, input) {
  const name = clean(input.name);
  const errs = [];
  if (!name) errs.push(err('Enter a category name.', 'name'));
  else if (name.length > 80) errs.push(err('Name is longer than 80 characters.', 'name'));
  if (!CATEGORY_KINDS.includes(input.kind)) errs.push(err('Choose income or expense.', 'kind'));
  if (name && data.categories.some((c) => c.kind === input.kind && c.name.toLowerCase() === name.toLowerCase())) errs.push(err(`A ${input.kind} category named "${name}" already exists.`, 'name'));
  if (errs.length) return fail(errs);
  return mutate(data, (d) => {
    const id = allocId(d, 'cat', 'categories');
    d.categories.push({ id, name, kind: input.kind, group: clean(input.group) || '', color: input.color || '' });
    return { id };
  });
}

/** Rename/regroup a category. Its kind can only change while it is unused. */
export function updateCategory(data, id, patch) {
  const cur = buildIndex(data).categoriesById.get(id);
  if (!cur) return fail('That category no longer exists.');
  const errs = [];
  const name = patch.name !== undefined ? clean(patch.name) : cur.name;
  if (!name) errs.push(err('Enter a category name.', 'name'));
  if (patch.kind && patch.kind !== cur.kind) {
    const u = categoryUsage(data, id);
    if (u.transactions || u.budgets || u.rules || u.recurring) errs.push(err('This category is in use, so its type (income/expense) cannot change.', 'kind'));
  }
  const kind = patch.kind || cur.kind;
  if (name && data.categories.some((c) => c.id !== id && c.kind === kind && c.name.toLowerCase() === name.toLowerCase())) errs.push(err(`A ${kind} category named "${name}" already exists.`, 'name'));
  if (errs.length) return fail(errs);
  return mutate(data, (d) => {
    const c = d.categories.find((x) => x.id === id);
    c.name = name;
    if (patch.kind) c.kind = patch.kind;
    if (patch.group !== undefined) c.group = clean(patch.group) || '';
    if (patch.color !== undefined) c.color = patch.color;
    return { id };
  });
}

/** How much of the dataset refers to a category. */
export function categoryUsage(data, id) {
  let transactions = 0;
  for (const t of data.transactions) if (t.categoryId === id || t.splits.some((s) => s.categoryId === id)) transactions += 1;
  return {
    transactions,
    budgets: data.budgets.filter((b) => b.categoryId === id).length,
    rules: data.rules.filter((r) => r.categoryId === id).length,
    recurring: data.recurring.filter((r) => r.categoryId === id).length,
  };
}

/**
 * Delete a category. Transactions/splits/recurring items move to `reassignTo` (same kind) or
 * become uncategorized; its budget and rules are deleted. Check categoryUsage() first to explain it.
 */
export function deleteCategory(data, id, { reassignTo = null } = {}) {
  const index = buildIndex(data);
  const cur = index.categoriesById.get(id);
  if (!cur) return fail('That category no longer exists.');
  if (reassignTo) {
    const to = index.categoriesById.get(reassignTo);
    if (!to) return fail('The replacement category does not exist.');
    if (to.kind !== cur.kind) return fail(`The replacement must also be an ${cur.kind} category.`);
    if (to.id === id) return fail('Choose a different replacement category.');
  }
  return mutate(data, (d) => {
    for (const t of d.transactions) {
      if (t.categoryId === id) t.categoryId = reassignTo;
      if (t.splits.some((s) => s.categoryId === id)) {
        if (!reassignTo) abort(err('This category is used in split transactions. Choose a replacement category so the splits stay valid.'));
        for (const s of t.splits) {
          if (s.categoryId === id) s.categoryId = reassignTo;
        }
      }
    }
    d.budgets = d.budgets.filter((b) => b.categoryId !== id);
    d.rules = d.rules.filter((r) => r.categoryId !== id);
    for (const r of d.recurring) if (r.categoryId === id) r.categoryId = reassignTo;
    d.categories = d.categories.filter((c) => c.id !== id);
    return { warnings: [] };
  });
}

// --------------------------------------------------------------------- rules
function checkRule(data, r) {
  const index = buildIndex(data);
  const errs = [];
  if (!clean(r.name)) errs.push(err('Name the rule.', 'name'));
  if (!clean(r.pattern)) errs.push(err('Enter the text to match.', 'pattern'));
  if (!RULE_FIELDS.includes(r.field)) errs.push(err('Choose what to match against.', 'field'));
  if (!RULE_MATCHES.includes(r.match)) errs.push(err('Choose how to match.', 'match'));
  if (!index.categoriesById.has(r.categoryId)) errs.push(err('Choose a category.', 'categoryId'));
  if (r.accountId && !index.accountsById.has(r.accountId)) errs.push(err('That account does not exist.', 'accountId'));
  if (!Number.isSafeInteger(r.priority)) errs.push(err('Priority must be a whole number.', 'priority'));
  for (const f of ['minAmountCents', 'maxAmountCents']) if (r[f] !== null && r[f] !== undefined && !(isValidCents(r[f]) && r[f] >= 0)) errs.push(err('Amount limits must be zero or more.', f));
  if (r.minAmountCents != null && r.maxAmountCents != null && r.minAmountCents > r.maxAmountCents) errs.push(err('The minimum amount is above the maximum.', 'minAmountCents'));
  return errs;
}

/** Create or replace a categorization rule (matched by id when given). */
export function saveRule(data, input) {
  const rule = {
    name: clean(input.name),
    enabled: input.enabled !== false,
    priority: input.priority ?? 100,
    field: input.field || 'any',
    match: input.match || 'contains',
    pattern: clean(input.pattern),
    categoryId: input.categoryId,
    accountId: input.accountId || null,
    minAmountCents: input.minAmountCents ?? null,
    maxAmountCents: input.maxAmountCents ?? null,
  };
  const errs = checkRule(data, rule);
  if (input.id && !data.rules.some((r) => r.id === input.id)) errs.push(err('That rule no longer exists.'));
  if (errs.length) return fail(errs);
  return mutate(data, (d) => {
    if (input.id) {
      const i = d.rules.findIndex((r) => r.id === input.id);
      d.rules[i] = { id: input.id, ...rule };
      return { id: input.id };
    }
    const id = allocId(d, 'rule', 'rules');
    d.rules.push({ id, ...rule });
    return { id };
  });
}

/** Delete a rule. Already-categorized transactions keep their categories. */
export function deleteRule(data, id) {
  if (!data.rules.some((r) => r.id === id)) return fail('That rule no longer exists.');
  return mutate(data, (d) => {
    d.rules = d.rules.filter((r) => r.id !== id);
  });
}

/**
 * Apply rules to existing transactions (after previewing). Manually categorized items are never touched.
 * @param {{ruleIds?:string[], scope?:'uncategorized'|'non_manual', txIds?:string[]}} opts txIds limits to a reviewed subset
 */
export function applyRules(data, opts = {}) {
  const changes = previewRules(data, opts).filter((c) => !opts.txIds || opts.txIds.includes(c.txId));
  if (!changes.length) return fail('No transactions would change.');
  return mutate(data, (d) => {
    const by = new Map(changes.map((c) => [c.txId, c]));
    for (const t of d.transactions) {
      const c = by.get(t.id);
      if (c) {
        t.categoryId = c.toCategoryId;
        t.categorySource = 'rule';
      }
    }
    return { appliedCount: changes.length };
  });
}

// ------------------------------------------------------------------- budgets
/** Create or update the budget for an expense category. */
export function saveBudget(data, input) {
  const index = buildIndex(data);
  const errs = [];
  const cat = index.categoriesById.get(input.categoryId);
  if (!cat) errs.push(err('Choose a category.', 'categoryId'));
  else if (cat.kind !== 'expense') errs.push(err('Budgets apply to expense categories.', 'categoryId'));
  if (!isValidCents(input.baseCents) || input.baseCents < 0) errs.push(err('Enter a monthly amount of $0.00 or more.', 'baseCents'));
  if (!isValidMonth(input.startMonth)) errs.push(err('Choose a valid start month.', 'startMonth'));
  const dup = data.budgets.find((b) => b.categoryId === input.categoryId && b.id !== input.id);
  if (dup) errs.push(err('That category already has a budget. Edit the existing one.', 'categoryId'));
  if (input.id && !data.budgets.some((b) => b.id === input.id)) errs.push(err('That budget no longer exists.'));
  if (errs.length) return fail(errs);
  return mutate(data, (d) => {
    if (input.id) {
      const b = d.budgets.find((x) => x.id === input.id);
      b.categoryId = input.categoryId;
      b.baseCents = input.baseCents;
      b.startMonth = input.startMonth;
      b.rollover = Boolean(input.rollover);
      b.enabled = input.enabled !== false;
      return { id: b.id };
    }
    const id = allocId(d, 'bud', 'budgets');
    d.budgets.push({ id, categoryId: input.categoryId, enabled: input.enabled !== false, rollover: Boolean(input.rollover), baseCents: input.baseCents, startMonth: input.startMonth, overrides: [] });
    return { id };
  });
}

/** Delete a budget. */
export function deleteBudget(data, id) {
  if (!data.budgets.some((b) => b.id === id)) return fail('That budget no longer exists.');
  return mutate(data, (d) => {
    d.budgets = d.budgets.filter((b) => b.id !== id);
  });
}

/** Toggle a budget on/off without deleting it. */
export function setBudgetEnabled(data, id, enabled) {
  if (!data.budgets.some((b) => b.id === id)) return fail('That budget no longer exists.');
  return mutate(data, (d) => {
    d.budgets.find((b) => b.id === id).enabled = Boolean(enabled);
  });
}

/** Set (or clear with null) the amount for one month. */
export function setBudgetOverride(data, id, month, amountCents) {
  const b = data.budgets.find((x) => x.id === id);
  if (!b) return fail('That budget no longer exists.');
  if (!isValidMonth(month)) return fail('Choose a valid month.');
  if (amountCents !== null && !(isValidCents(amountCents) && amountCents >= 0)) return fail('Enter an amount of $0.00 or more.');
  return mutate(data, (d) => {
    const x = d.budgets.find((q) => q.id === id);
    x.overrides = x.overrides.filter((o) => o.month !== month);
    if (amountCents !== null) x.overrides.push({ month, amountCents });
    x.overrides.sort((p, q) => (p.month < q.month ? -1 : 1));
  });
}

// --------------------------------------------------------------------- goals
function checkGoal(data, g) {
  const index = buildIndex(data);
  const errs = [];
  if (!clean(g.name)) errs.push(err('Name the goal.', 'name'));
  if (!isValidCents(g.targetCents) || g.targetCents <= 0) errs.push(err('Target must be a positive amount.', 'targetCents'));
  if (!isValidDate(g.targetDate)) errs.push(err('Choose a valid target date.', 'targetDate'));
  if (!GOAL_ALLOCATIONS.includes(g.allocation?.type)) errs.push(err('Choose how progress is measured.', 'allocation'));
  else if (g.allocation.type !== 'manual') {
    const a = index.accountsById.get(g.accountId);
    if (!a) errs.push(err('Choose the account that holds this goal\'s money.', 'accountId'));
    else if (a.type !== 'savings' && a.type !== 'checking' && a.type !== 'investment') errs.push(err('A goal can be linked to a savings, checking or investment account.', 'accountId'));
    if (g.allocation.type === 'fixed' && !(isValidCents(g.allocation.value) && g.allocation.value >= 0)) errs.push(err('Enter the earmarked amount.', 'allocation'));
    if (g.allocation.type === 'percent' && !(Number.isInteger(g.allocation.value) && g.allocation.value >= 0 && g.allocation.value <= 10000)) errs.push(err('Percentage must be between 0% and 100%.', 'allocation'));
  }
  return errs;
}

/** Create or update a savings goal. */
export function saveGoal(data, input) {
  const g = {
    name: clean(input.name),
    targetCents: input.targetCents,
    targetDate: input.targetDate,
    accountId: input.allocation?.type === 'manual' ? null : input.accountId || null,
    allocation: { type: input.allocation?.type, value: input.allocation?.value ?? 0 },
    contributions: input.contributions || [],
    priority: input.priority ?? 100,
    note: clean(input.note) || '',
  };
  const errs = checkGoal(data, g);
  if (input.id && !data.goals.some((x) => x.id === input.id)) errs.push(err('That goal no longer exists.'));
  if (errs.length) return fail(errs);
  return mutate(data, (d) => {
    if (input.id) {
      const i = d.goals.findIndex((x) => x.id === input.id);
      d.goals[i] = { id: input.id, ...g, contributions: input.contributions ?? d.goals[i].contributions };
      return { id: input.id };
    }
    const id = allocId(d, 'goal', 'goals');
    d.goals.push({ id, ...g });
    return { id };
  });
}

/** Delete a goal. */
export function deleteGoal(data, id) {
  if (!data.goals.some((g) => g.id === id)) return fail('That goal no longer exists.');
  return mutate(data, (d) => {
    d.goals = d.goals.filter((g) => g.id !== id);
  });
}

/** Record a simulated contribution on a manual-tracked goal. */
export function addGoalContribution(data, goalId, { date, amountCents, note }) {
  const g = data.goals.find((x) => x.id === goalId);
  if (!g) return fail('That goal no longer exists.');
  if (g.allocation.type !== 'manual') return fail('Contributions can only be recorded on goals tracked manually. This goal follows an account balance.');
  if (!isValidDate(date)) return fail('Enter a valid date.');
  if (!isValidCents(amountCents) || amountCents === 0) return fail('Enter a non-zero amount.');
  return mutate(data, (d) => {
    d.goals.find((x) => x.id === goalId).contributions.push({ date, amountCents, note: clean(note) || '' });
  });
}

// ------------------------------------------------------------------ settings
/** Update dataset-level settings (as-of date, basis, investment growth). */
export function updateSettings(data, patch) {
  const errs = [];
  if (patch.asOfDate !== undefined && !isValidDate(patch.asOfDate)) errs.push(err('Enter a valid as-of date (YYYY-MM-DD).', 'asOfDate'));
  if (patch.basis !== undefined && !['posted', 'pending'].includes(patch.basis)) errs.push(err('Basis must be posted or pending.', 'basis'));
  if (patch.investmentGrowthBps !== undefined && !(Number.isSafeInteger(patch.investmentGrowthBps) && patch.investmentGrowthBps >= -5000 && patch.investmentGrowthBps <= 5000)) errs.push(err('Investment growth must be between -50% and +50%.', 'investmentGrowthBps'));
  if (errs.length) return fail(errs);
  return mutate(data, (d) => {
    Object.assign(d.settings, patch);
  });
}

/** Rename the dataset. */
export function renameDataset(data, name) {
  const n = clean(name);
  if (!n) return fail('Enter a name.');
  return mutate(data, (d) => {
    d.meta.name = n.slice(0, 80);
  });
}

// ----------------------------------------------------------------- scenarios
const DEFAULT_ASSUMPTIONS = { investmentGrowthBps: null, variableSpending: 'trailing', variableSpendingCents: null, includeSavingsInterest: true };

/** Create or update a scenario (full replace of name/description/horizon/assumptions/changes). */
export function saveScenario(data, input) {
  const sc = {
    name: clean(input.name),
    description: clean(input.description) || '',
    horizonMonths: input.horizonMonths ?? 12,
    asOfDate: input.asOfDate || null,
    assumptions: { ...DEFAULT_ASSUMPTIONS, ...(input.assumptions || {}) },
    changes: (input.changes || []).map((c) => ({ ...c })),
  };
  const errs = [];
  if (!sc.name) errs.push(err('Name the scenario.', 'name'));
  if (input.id && !data.scenarios.some((s) => s.id === input.id)) errs.push(err('That scenario no longer exists.'));
  if (errs.length) return fail(errs);
  return mutate(data, (d) => {
    const changes = sc.changes.map((c) => ({ ...c, id: c.id && !String(c.id).startsWith('chg-draft-') ? c.id : allocId(d, 'chg', 'scenarios') }));
    if (input.id) {
      const i = d.scenarios.findIndex((s) => s.id === input.id);
      d.scenarios[i] = normalizeScenario({ id: input.id, ...sc, changes });
      return { id: input.id };
    }
    const id = allocId(d, 'scn', 'scenarios');
    d.scenarios.push(normalizeScenario({ id, ...sc, changes }));
    return { id };
  });
}

/** Duplicate a scenario (deep copy, new id and change ids, name gets "(copy)"). */
export function duplicateScenario(data, id) {
  const s = data.scenarios.find((x) => x.id === id);
  if (!s) return fail('That scenario no longer exists.');
  return mutate(data, (d) => {
    const newId = allocId(d, 'scn', 'scenarios');
    const copy = JSON.parse(JSON.stringify(s));
    copy.id = newId;
    copy.name = `${s.name} (copy)`.slice(0, 80);
    copy.changes = copy.changes.map((c) => ({ ...c, id: `${newId}-${c.id}` }));
    d.scenarios.push(copy);
    return { id: newId };
  });
}

/** Delete a scenario. Nothing else references scenarios, and the ledger is untouched. */
export function deleteScenario(data, id) {
  if (!data.scenarios.some((s) => s.id === id)) return fail('That scenario no longer exists.');
  return mutate(data, (d) => {
    d.scenarios = d.scenarios.filter((s) => s.id !== id);
  });
}
