/**
 * Calendar-date helpers. Dates are plain 'YYYY-MM-DD' strings (no time, no zone),
 * so they never shift because of the device time zone. All arithmetic goes through
 * UTC day numbers, which have no daylight-saving gaps.
 */

export const MIN_YEAR = 1970;
export const MAX_YEAR = 2200;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTH_ABBR = MONTH_NAMES.map((m) => m.slice(0, 3));

/** @returns {boolean} */
export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Number of days in month m (1-12) of year y. */
export function daysInMonth(y, m) {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** True for a real calendar date in ISO form (rejects 2026-02-30, 2026-13-01, etc). */
export function isValidDate(s) {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (y < MIN_YEAR || y > MAX_YEAR || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

/** True for a 'YYYY-MM' month key. */
export function isValidMonth(s) {
  if (typeof s !== 'string') return false;
  const m = MONTH_RE.exec(s);
  if (!m) return false;
  const y = +m[1];
  const mo = +m[2];
  return y >= MIN_YEAR && y <= MAX_YEAR && mo >= 1 && mo <= 12;
}

/** Parse a valid ISO date into {y,m,d}. Throws on invalid input. */
export function parseDate(s) {
  if (!isValidDate(s)) throw new RangeError(`Invalid date: ${s}`);
  return { y: +s.slice(0, 4), m: +s.slice(5, 7), d: +s.slice(8, 10) };
}

const p2 = (n) => String(n).padStart(2, '0');

/** Build an ISO date from parts (no validation). */
export function makeDate(y, m, d) {
  return `${String(y).padStart(4, '0')}-${p2(m)}-${p2(d)}`;
}

/** Days since 1970-01-01 for an ISO date. */
export function toDayNumber(s) {
  const { y, m, d } = parseDate(s);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Inverse of toDayNumber. */
export function fromDayNumber(n) {
  const dt = new Date(n * 86400000);
  return makeDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Add (possibly negative) days. */
export function addDays(s, n) {
  return fromDayNumber(toDayNumber(s) + n);
}

/** Whole days from a to b (b - a). */
export function diffDays(a, b) {
  return toDayNumber(b) - toDayNumber(a);
}

/** Day of week: 0 = Sunday ... 6 = Saturday. */
export function weekday(s) {
  return (toDayNumber(s) + 4) % 7; // 1970-01-01 was a Thursday
}

/**
 * Add months to a date keeping an anchor day-of-month, clamping to the last day of
 * shorter months. addMonths('2026-01-31', 1) -> '2026-02-28'; because the anchor
 * is re-applied from the original date, +2 months gives '2026-03-31' again.
 * @param {string} s start date @param {number} n months @param {number} [anchorDay] defaults to the day of `s`
 */
export function addMonths(s, n, anchorDay) {
  const { y, m, d } = parseDate(s);
  const anchor = anchorDay ?? d;
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return makeDate(ny, nm, Math.min(anchor, daysInMonth(ny, nm)));
}

/** 'YYYY-MM' of a date. */
export function monthKey(s) {
  return s.slice(0, 7);
}

/** First day of month key. */
export function monthStart(key) {
  return `${key}-01`;
}

/** Last day of month key. */
export function monthEnd(key) {
  const y = +key.slice(0, 4);
  const m = +key.slice(5, 7);
  return makeDate(y, m, daysInMonth(y, m));
}

/** Add n months to a 'YYYY-MM' key. */
export function addMonthKey(key, n) {
  const y = +key.slice(0, 4);
  const m = +key.slice(5, 7);
  const idx = y * 12 + (m - 1) + n;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${p2((idx % 12) + 1)}`;
}

/** Inclusive list of month keys from a to b ('YYYY-MM'). Empty when b < a. */
export function monthRange(a, b) {
  const out = [];
  let k = a;
  let guard = 0;
  while (k <= b && guard < 2400) {
    out.push(k);
    k = addMonthKey(k, 1);
    guard += 1;
  }
  return out;
}

/** Number of months from key a to key b (b - a). */
export function monthsBetween(a, b) {
  return (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
}

/** Previous/next business day (Mon-Fri; no holiday calendar). */
export function adjustBusinessDay(s, mode) {
  if (mode !== 'next' && mode !== 'prev') return s;
  let cur = s;
  let guard = 0;
  while ((weekday(cur) === 0 || weekday(cur) === 6) && guard < 7) {
    cur = addDays(cur, mode === 'next' ? 1 : -1);
    guard += 1;
  }
  return cur;
}

/** "Oct 1, 2026". */
export function formatDate(s) {
  if (!isValidDate(s)) return String(s ?? '');
  const { y, m, d } = parseDate(s);
  return `${MONTH_ABBR[m - 1]} ${d}, ${y}`;
}

/** "Oct 1". */
export function formatDateShort(s) {
  if (!isValidDate(s)) return String(s ?? '');
  const { m, d } = parseDate(s);
  return `${MONTH_ABBR[m - 1]} ${d}`;
}

/** "October 2026". */
export function formatMonth(key) {
  if (!isValidMonth(key)) return String(key ?? '');
  return `${MONTH_NAMES[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}`;
}

/** "Oct '26". */
export function formatMonthShort(key) {
  if (!isValidMonth(key)) return String(key ?? '');
  return `${MONTH_ABBR[+key.slice(5, 7) - 1]} '${key.slice(2, 4)}`;
}

/** Clamp a date between lo and hi (ISO strings compare lexicographically). */
export function clampDate(s, lo, hi) {
  if (lo && s < lo) return lo;
  if (hi && s > hi) return hi;
  return s;
}

/** Last day of the year of a date. */
export function yearEnd(s) {
  return `${s.slice(0, 4)}-12-31`;
}
