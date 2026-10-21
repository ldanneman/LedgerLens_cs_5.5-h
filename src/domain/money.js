/**
 * Money primitives. All monetary values in LedgerLens are INTEGER CENTS.
 * Binary floating point is never used as the source of truth: parsing is done
 * on strings, and derived amounts (interest, percentages, allocations) are
 * rounded with a single documented convention - round half away from zero.
 */

/** Largest absolute amount accepted anywhere (one billion dollars, in cents). */
export const MAX_CENTS = 100_000_000_000;

/** @param {unknown} n @returns {boolean} true when n is a finite safe integer within +/-MAX_CENTS. */
export function isValidCents(n) {
  return typeof n === 'number' && Number.isSafeInteger(n) && Math.abs(n) <= MAX_CENTS;
}

/**
 * Integer division rounded half away from zero. Works for any safe integers,
 * using BigInt only when the numerator is not a safe integer.
 * @param {number|bigint} num @param {number|bigint} den (non-zero)
 * @returns {number}
 */
export function roundDiv(num, den) {
  const n = BigInt(num);
  let d = BigInt(den);
  if (d === 0n) throw new RangeError('Division by zero');
  let nn = n;
  if (d < 0n) {
    d = -d;
    nn = -nn;
  }
  const neg = nn < 0n;
  const abs = neg ? -nn : nn;
  const q = (2n * abs + d) / (2n * d); // floor((2a + d) / 2d) == round half up on the magnitude
  return Number(neg ? -q : q);
}

/** round(a * b / c) computed exactly (BigInt) and rounded half away from zero. */
export function mulDiv(a, b, c) {
  return roundDiv(BigInt(a) * BigInt(b), BigInt(c));
}

/** Apply a rate in basis points (1 bp = 0.01%) to an amount of cents. */
export function applyBps(cents, bps) {
  return mulDiv(cents, bps, 10000);
}

/**
 * Monthly interest for an annual rate (basis points): balance * APR / 12,
 * rounded half away from zero to the cent. Zero APR yields exactly 0.
 */
export function monthlyInterest(balanceCents, aprBps) {
  if (!aprBps || !balanceCents) return 0;
  return mulDiv(balanceCents, aprBps, 120000);
}

/**
 * Split `total` cents across `weights` using the largest-remainder method so the
 * parts always sum EXACTLY to `total`. Ties are broken by lowest index.
 * @param {number} total @param {number[]} weights non-negative weights
 * @returns {number[]}
 */
export function allocateCents(total, weights) {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) return [];
  if (sumW <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = weights.map((w) => Number((BigInt(abs) * BigInt(w)) / BigInt(sumW)));
  const rem = weights.map((w, i) => ({ i, r: Number((BigInt(abs) * BigInt(w)) % BigInt(sumW)) }));
  let left = abs - base.reduce((a, b) => a + b, 0);
  rem.sort((x, y) => y.r - x.r || x.i - y.i);
  for (let k = 0; left > 0 && k < rem.length; k += 1, left -= 1) base[rem[k].i] += 1;
  return base.map((v) => v * sign);
}

/** Sum an array of integer cents. */
export function sumCents(list) {
  let t = 0;
  for (const v of list) t += v;
  return t;
}

const CURRENCY_STRIP = /[$\u20AC\u00A3\u00A5\s\u00A0]/g;

/**
 * Parse a user-entered money string into integer cents WITHOUT floating point.
 * Accepts "$1,234.56", "-12.5", "(45.00)" (accounting negative), "45.00-",
 * "1.234,56" when decimal=',' and plain integers ("12" => 1200 cents).
 * @param {string|number} input
 * @param {{decimal?: '.'|',', allowNegative?: boolean}} [opts]
 * @returns {{ok:true, cents:number}|{ok:false, error:string}}
 */
export function parseMoney(input, opts = {}) {
  const decimal = opts.decimal === ',' ? ',' : '.';
  const thousands = decimal === '.' ? ',' : '.';
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, error: 'Amount must be a finite number.' };
    input = String(input);
    if (/e/i.test(input)) return { ok: false, error: 'Amount is too large or too small to read exactly.' };
  }
  if (typeof input !== 'string') return { ok: false, error: 'Amount is missing.' };
  let s = input.replace(CURRENCY_STRIP, '');
  if (s === '') return { ok: false, error: 'Amount is empty.' };
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (s === '') return { ok: false, error: `"${input}" is not a valid amount.` };
  // strip grouping separators, only when they look like real grouping
  const groupRe = new RegExp(`^\\d{1,3}(\\${thousands}\\d{3})+(\\${decimal}\\d*)?$`);
  if (groupRe.test(s)) s = s.split(thousands).join('');
  const valid = new RegExp(`^\\d*(\\${decimal}\\d*)?$`);
  if (!valid.test(s) || !/\d/.test(s)) return { ok: false, error: `"${input}" is not a valid amount.` };
  const [whole = '', frac = ''] = s.split(decimal);
  if (frac.length > 2) {
    // Anything beyond cents must be zeros; otherwise we would silently round user input.
    if (!/^0+$/.test(frac.slice(2))) return { ok: false, error: `"${input}" has more than two decimal places.` };
  }
  const centsStr = (frac + '00').slice(0, 2);
  const wholeDigits = whole.replace(/^0+(?=\d)/, '') || '0';
  if (wholeDigits.length > 12) return { ok: false, error: `"${input}" is larger than the supported maximum.` };
  let cents = Number(wholeDigits) * 100 + Number(centsStr);
  if (negative) cents = -cents;
  if (opts.allowNegative === false && cents < 0) return { ok: false, error: 'Amount cannot be negative.' };
  if (!isValidCents(cents)) return { ok: false, error: 'Amount exceeds the supported range of +/- $1,000,000,000.00.' };
  return { ok: true, cents: cents === 0 ? 0 : cents };
}

/**
 * Parse a percentage string such as "19.99" or "5%" into basis points (1999).
 * @returns {{ok:true,bps:number}|{ok:false,error:string}}
 */
export function parsePercentToBps(input) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return { ok: false, error: 'Rate is missing.' };
  const s = input.replace(/[%\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return { ok: false, error: `"${input}" is not a valid percentage (use up to two decimals).` };
  const [w, f = ''] = s.split('.');
  const bps = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return { ok: true, bps };
}

/** Format basis points as a percentage string, e.g. 1999 -> "19.99%". */
export function formatBps(bps) {
  if (!Number.isFinite(bps)) return '-';
  return `${(bps / 100).toFixed(2)}%`;
}

function groupDigits(str) {
  return str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format cents as dollars: "$1,234.56" / "-$12.00". Never produces NaN.
 * @param {number} cents
 * @param {{signed?: boolean, plain?: boolean, parens?: boolean}} [opts] signed: always show +/-, plain: no currency symbol
 */
export function formatMoney(cents, opts = {}) {
  if (!Number.isFinite(cents)) return opts.plain ? '0.00' : '$0.00';
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const body = `${groupDigits(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, '0')}`;
  const sym = opts.plain ? '' : '$';
  if (neg) return opts.parens ? `(${sym}${body})` : `-${sym}${body}`;
  return opts.signed && abs !== 0 ? `+${sym}${body}` : `${sym}${body}`;
}

/** Plain decimal string for CSV/JSON/inputs: -1234 -> "-12.34". */
export function centsToDecimalString(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Percentage of part/whole as an integer-rounded-to-1-decimal number; 0 when whole is 0. */
export function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
