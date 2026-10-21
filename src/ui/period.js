import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { addDays, addMonthKey, monthEnd, monthKey, monthStart, isValidDate, formatDate, formatMonth } from '../domain/dates.js';
import { defaultPeriod } from '../domain/reports.js';

/** Selections remembered while the tab is open, so navigating between pages keeps context. */
const remembered = new Map();
export const remember = (key, value) => remembered.set(key, value);
export const recall = (key, fallback) => (remembered.has(key) ? remembered.get(key) : fallback);
export const clearRemembered = () => remembered.clear();

export const PERIOD_PRESETS = [
  { id: 'auto', label: 'Auto (this month, or last month early in the month)' },
  { id: 'this_month', label: 'This month to date' },
  { id: 'last_month', label: 'Last month' },
  { id: 'last_30', label: 'Last 30 days' },
  { id: 'last_90', label: 'Last 90 days' },
  { id: 'ytd', label: 'Year to date' },
  { id: 'last_12', label: 'Last 12 months' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom range' },
];

/** Resolve a preset into concrete inclusive dates. */
export function resolvePeriod(asOf, preset, custom = {}) {
  const cur = monthKey(asOf);
  let start;
  let end;
  switch (preset) {
    case 'this_month':
      start = monthStart(cur);
      end = asOf;
      break;
    case 'last_month': {
      const p = addMonthKey(cur, -1);
      start = monthStart(p);
      end = monthEnd(p);
      break;
    }
    case 'last_30':
      start = addDays(asOf, -29);
      end = asOf;
      break;
    case 'last_90':
      start = addDays(asOf, -89);
      end = asOf;
      break;
    case 'ytd':
      start = `${asOf.slice(0, 4)}-01-01`;
      end = asOf;
      break;
    case 'last_12':
      start = monthStart(addMonthKey(cur, -11));
      end = asOf;
      break;
    case 'all':
      start = '1970-01-01';
      end = asOf;
      break;
    case 'custom':
      start = isValidDate(custom.from) ? custom.from : monthStart(cur);
      end = isValidDate(custom.to) ? custom.to : asOf;
      if (end < start) [start, end] = [end, start];
      break;
    default: {
      const d = defaultPeriod(asOf);
      start = d.start;
      end = d.end;
      preset = d.preset;
    }
  }
  const label = start === monthStart(monthKey(start)) && end === monthEnd(monthKey(start)) && monthKey(start) === monthKey(end) ? formatMonth(monthKey(start)) : preset === 'all' ? `Through ${formatDate(end)}` : `${formatDate(start)} to ${formatDate(end)}`;
  return { preset, start, end, label };
}

/** URL-backed reporting period (p, from, to) with a remembered fallback. */
export function usePeriod(asOf, key = 'period') {
  const [params, setParams] = useSearchParams();
  const urlHas = params.has('p');
  const stored = recall(key, null);
  const preset = urlHas ? params.get('p') : stored?.preset || 'auto';
  const custom = urlHas ? { from: params.get('from'), to: params.get('to') } : { from: stored?.from, to: stored?.to };
  const period = resolvePeriod(asOf, PERIOD_PRESETS.some((p) => p.id === preset) ? preset : 'auto', custom);
  const set = useCallback(
    (next) => {
      remember(key, next);
      setParams(
        (prev) => {
          const n = new URLSearchParams(prev);
          n.set('p', next.preset);
          if (next.preset === 'custom') {
            if (next.from) n.set('from', next.from);
            if (next.to) n.set('to', next.to);
          } else {
            n.delete('from');
            n.delete('to');
          }
          return n;
        },
        { replace: true },
      );
    },
    [key, setParams],
  );
  return [period, set, custom];
}
