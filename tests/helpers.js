import { buildIndex, accountContribution, netWorthAt } from '../src/domain/ledger.js';
import { summarizePeriod } from '../src/domain/reports.js';

export const bal = (data, id, date = data.settings.asOfDate, pending = false) => accountContribution(buildIndex(data), id, date, pending);
export const nw = (data, date = data.settings.asOfDate, pending = false) => netWorthAt(buildIndex(data), date, pending).netWorth;
export const period = (data, filters = {}) => summarizePeriod(data, { start: '2000-01-01', end: '2100-01-01', ...filters });
/** Unwrap a Result or fail the test with its errors. */
export function must(res) {
  if (!res.ok) throw new Error(`Expected ok but got errors: ${res.errors.map((e) => e.message).join(' | ')}`);
  return res;
}
