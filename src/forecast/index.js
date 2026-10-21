/**
 * Convenience wrappers: a baseline plus scenarios sharing one window, and scenario-vs-baseline comparison.
 */
import { runProjection } from './engine.js';
import { compareProjections } from './compare.js';

/** Baseline projection (no changes). */
export function projectBaseline(data, opts = {}) {
  return runProjection(data, null, opts);
}

/** Run a scenario with the SAME window as the given options (so comparisons line up). */
export function projectScenario(data, scenario, opts = {}) {
  return runProjection(data, scenario, opts);
}

/** Baseline vs scenario comparison (both share asOf/horizon from opts or the scenario). */
export function compareToBaseline(data, scenario, opts = {}) {
  const window = { asOfDate: opts.asOfDate || scenario.asOfDate || data.settings.asOfDate, horizonMonths: opts.horizonMonths || scenario.horizonMonths || 12 };
  const base = runProjection(data, null, window);
  const scen = runProjection(data, scenario, window);
  return { baseline: base, scenario: scen, comparison: compareProjections(base, scen) };
}

export { runProjection, compareProjections };
