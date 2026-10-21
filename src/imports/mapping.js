/**
 * Column mapping and row normalization for CSV imports.
 *
 * Parsing is explicit: dates use a chosen format (or an unambiguous auto-detection - if a file is
 * ambiguous, e.g. 03/04/2026, the user must pick MDY or DMY), amounts are parsed from strings to
 * integer cents, and every row that cannot be understood is reported with its line number instead
 * of being guessed at.
 */
import { parseMoney, isValidCents } from '../domain/money.js';
import { isValidDate, makeDate, MIN_YEAR } from '../domain/dates.js';

export const DATE_FORMATS = [
  { id: 'auto', label: 'Auto-detect (asks if ambiguous)' },
  { id: 'iso', label: 'YYYY-MM-DD' },
  { id: 'mdy', label: 'MM/DD/YYYY (US)' },
  { id: 'dmy', label: 'DD/MM/YYYY' },
  { id: 'dmon', label: 'DD-Mon-YYYY (05-Mar-2026)' },
  { id: 'mondy', label: 'Mon D, YYYY (Mar 5, 2026)' },
];

/** Named layouts the user can start from. Column names are matched case-insensitively. */
export const FORMAT_PRESETS = [
  { id: 'generic', label: 'Generic bank: Date, Description, Amount', amountMode: 'signed', invertSign: false, hint: 'Negative amounts are money leaving the account.' },
  { id: 'debit-credit', label: 'Bank with Debit and Credit columns', amountMode: 'debit_credit', invertSign: false, hint: 'Debit = money out, Credit = money in.' },
  { id: 'card', label: 'Credit-card export (charges are positive)', amountMode: 'signed', invertSign: true, hint: 'Many card exports show purchases as positive numbers; signs are flipped so purchases reduce what you have.' },
  { id: 'ledgerlens', label: 'LedgerLens CSV export', amountMode: 'signed', invertSign: false, hint: 'The format produced by LedgerLens (Date, Description, Merchant, Amount, Status, Reference...).' },
  { id: 'custom', label: 'Custom (map columns yourself)', amountMode: 'signed', invertSign: false, hint: 'Choose each column below.' },
];

const HEADER_HINTS = {
  date: /^(transaction[ _-]?date|posting[ _-]?date|post[ _-]?date|date|posted)$/i,
  description: /^(description|details|memo|narrative|payee|name|transaction[ _-]?description)$/i,
  amount: /^(amount|transaction[ _-]?amount|value)$/i,
  debit: /^(debit|withdrawal|withdrawals|money[ _-]?out|paid[ _-]?out)$/i,
  credit: /^(credit|deposit|deposits|money[ _-]?in|paid[ _-]?in)$/i,
  externalId: /^(reference|ref|reference[ _-]?(id|number|no)|transaction[ _-]?id|id|fitid|external[ _-]?id)$/i,
  merchant: /^(merchant|vendor|payee)$/i,
  status: /^(status|state)$/i,
  category: /^(category)$/i,
  notes: /^(notes?|comment|remarks?)$/i,
};

/** Suggest a mapping from header names. Returns column indexes or -1. */
export function suggestMapping(headers) {
  const find = (re) => headers.findIndex((h) => re.test(String(h).trim()));
  const m = {
    dateCol: find(HEADER_HINTS.date),
    descriptionCol: find(HEADER_HINTS.description),
    amountCol: find(HEADER_HINTS.amount),
    debitCol: find(HEADER_HINTS.debit),
    creditCol: find(HEADER_HINTS.credit),
    externalIdCol: find(HEADER_HINTS.externalId),
    merchantCol: find(HEADER_HINTS.merchant),
    statusCol: find(HEADER_HINTS.status),
    categoryCol: find(HEADER_HINTS.category),
    notesCol: find(HEADER_HINTS.notes),
  };
  if (m.merchantCol === m.descriptionCol) m.merchantCol = -1;
  m.amountMode = m.amountCol < 0 && m.debitCol >= 0 && m.creditCol >= 0 ? 'debit_credit' : 'signed';
  return m;
}

/** Default mapping object. */
export function defaultMapping() {
  return { hasHeader: true, dateCol: -1, descriptionCol: -1, amountCol: -1, debitCol: -1, creditCol: -1, externalIdCol: -1, merchantCol: -1, statusCol: -1, categoryCol: -1, notesCol: -1, amountMode: 'signed', invertSign: false, dateFormat: 'auto', decimal: '.' };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function fixYear(y) {
  if (y >= 100) return y;
  return y >= 70 ? 1900 + y : 2000 + y; // two-digit years: 70-99 => 19xx, 00-69 => 20xx
}

/** Parse one date string with a specific format. Returns an ISO date or null. */
export function parseDateWithFormat(raw, fmt) {
  const s = String(raw ?? '').trim();
  let m;
  let y;
  let mo;
  let d;
  switch (fmt) {
    case 'iso': {
      m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
      if (!m) return null;
      [y, mo, d] = [+m[1], +m[2], +m[3]];
      break;
    }
    case 'mdy':
    case 'dmy': {
      m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
      if (!m) return null;
      if (fmt === 'mdy') [mo, d] = [+m[1], +m[2]];
      else [d, mo] = [+m[1], +m[2]];
      y = fixYear(+m[3]);
      break;
    }
    case 'dmon': {
      m = /^(\d{1,2})[ \-/]([A-Za-z]{3,9})\.?[ \-/,]+(\d{2}|\d{4})$/.exec(s);
      if (!m) return null;
      mo = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
      d = +m[1];
      y = fixYear(+m[3]);
      break;
    }
    case 'mondy': {
      m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/.exec(s);
      if (!m) return null;
      mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
      d = +m[2];
      y = fixYear(+m[3]);
      break;
    }
    default:
      return null;
  }
  if (!mo) return null;
  const iso = makeDate(y, mo, d);
  return isValidDate(iso) ? iso : null;
}

/**
 * Detect the date format from sample values.
 * @returns {{format:string|null, ambiguous:boolean, message:string}}
 */
export function detectDateFormat(values) {
  const vals = values.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!vals.length) return { format: null, ambiguous: false, message: 'No dates to inspect.' };
  // Decide by the SHAPE of the values (most rows must look the same); individual impossible dates such as
  // 2026-02-30 are then reported row by row instead of making the whole file undetectable.
  const shapes = {
    iso: /^\d{4}-\d{1,2}-\d{1,2}(?:[T ].*)?$/,
    dmon: /^\d{1,2}[ \-/][A-Za-z]{3,9}\.?[ \-/,]+(\d{2}|\d{4})$/,
    mondy: /^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+(\d{2}|\d{4})$/,
  };
  for (const [f, re] of Object.entries(shapes)) if (vals.filter((v) => re.test(v)).length >= Math.ceil(vals.length * 0.8)) return { format: f, ambiguous: false, message: '' };
  const slashRe = /^\d{1,2}[/.-]\d{1,2}[/.-](\d{2}|\d{4})$/;
  const slash = vals.filter((v) => slashRe.test(v));
  if (slash.length >= Math.ceil(vals.length * 0.8)) {
    const mdyOnly = slash.some((v) => parseDateWithFormat(v, 'mdy') && !parseDateWithFormat(v, 'dmy'));
    const dmyOnly = slash.some((v) => parseDateWithFormat(v, 'dmy') && !parseDateWithFormat(v, 'mdy'));
    if (mdyOnly && !dmyOnly) return { format: 'mdy', ambiguous: false, message: '' };
    if (dmyOnly && !mdyOnly) return { format: 'dmy', ambiguous: false, message: '' };
    if (!mdyOnly && !dmyOnly) return { format: null, ambiguous: true, message: 'Every date could be read as month/day or day/month (for example 03/04/2026). Choose the date format explicitly so no date is silently misread.' };
    return { format: null, ambiguous: true, message: 'The dates mix month/day and day/month readings. Choose the date format explicitly.' };
  }
  return { format: null, ambiguous: false, message: 'The dates do not match a supported format. Choose a format manually and check the rows flagged below.' };
}

/** Parse a status cell. */
function parseStatus(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'posted';
  if (/^(pending|authorized|auth|hold|processing)/.test(s)) return 'pending';
  return 'posted';
}

/**
 * Normalize CSV records to import rows.
 * @param {string[][]} records parsed rows (including header when mapping.hasHeader)
 * @param {number[]} lines source line numbers
 * @param {object} mapping
 * @param {{asOfDate?:string, accountType?:string}} [ctx]
 * @returns {{rows:Array, dateFormat:string|null, dateMessage:string, blocking:string|null, summary:object}}
 */
export function normalizeRows(records, lines, mapping, ctx = {}) {
  const start = mapping.hasHeader ? 1 : 0;
  const body = records.slice(start);
  const bodyLines = lines.slice(start);
  const colCount = records[0]?.length ?? 0;
  const out = [];
  let blocking = null;
  const need = (idx, label) => {
    if (!(idx >= 0 && idx < colCount)) blocking = blocking || `Choose the ${label} column.`;
  };
  need(mapping.dateCol, 'date');
  need(mapping.descriptionCol, 'description');
  if (mapping.amountMode === 'signed') need(mapping.amountCol, 'amount');
  else {
    need(mapping.debitCol, 'debit');
    need(mapping.creditCol, 'credit');
  }
  let fmt = mapping.dateFormat;
  let dateMessage = '';
  if (!blocking && fmt === 'auto') {
    const det = detectDateFormat(body.map((r) => r[mapping.dateCol]));
    if (det.format) fmt = det.format;
    else {
      blocking = det.message || 'Choose a date format.';
      dateMessage = det.message;
      fmt = null;
    }
  }
  if (blocking) return { rows: [], dateFormat: fmt, dateMessage, blocking, summary: { total: body.length } };

  const decimal = mapping.decimal === ',' ? ',' : '.';
  body.forEach((rec, i) => {
    const line = bodyLines[i];
    const errors = [];
    const warnings = [];
    if (rec.length !== colCount) errors.push(`Expected ${colCount} columns but found ${rec.length}.`);
    const get = (idx) => (idx >= 0 && idx < rec.length ? String(rec[idx] ?? '').trim() : '');
    const date = parseDateWithFormat(get(mapping.dateCol), fmt);
    if (!date) errors.push(`"${get(mapping.dateCol)}" is not a valid ${DATE_FORMATS.find((f) => f.id === fmt)?.label || ''} date.`);
    else {
      const y = +date.slice(0, 4);
      if (y < MIN_YEAR + 20) warnings.push(`The year ${y} looks unusual.`);
      if (ctx.asOfDate && date > ctx.asOfDate) warnings.push('The date is after the as-of date.');
    }
    let description = get(mapping.descriptionCol);
    if (!description) errors.push('The description is empty.');
    if (description.length > 200) {
      warnings.push('The description was shortened to 200 characters.');
      description = description.slice(0, 200);
    }
    let cents = null;
    if (mapping.amountMode === 'signed') {
      const raw = get(mapping.amountCol);
      const r = parseMoney(raw, { decimal });
      if (!r.ok) errors.push(r.error);
      else cents = r.cents;
    } else {
      const dRaw = get(mapping.debitCol);
      const cRaw = get(mapping.creditCol);
      const dr = dRaw ? parseMoney(dRaw, { decimal }) : { ok: true, cents: 0 };
      const cr = cRaw ? parseMoney(cRaw, { decimal }) : { ok: true, cents: 0 };
      if (!dr.ok) errors.push(`Debit: ${dr.error}`);
      else if (!cr.ok) errors.push(`Credit: ${cr.error}`);
      else if (dr.cents !== 0 && cr.cents !== 0) errors.push('Both Debit and Credit have a value.');
      else cents = Math.abs(cr.cents) - Math.abs(dr.cents);
    }
    if (cents !== null) {
      if (mapping.invertSign) cents = -cents;
      if (cents === 0) errors.push('The amount is zero.');
      else if (!isValidCents(cents)) errors.push('The amount is outside the supported range.');
    }
    let externalId = get(mapping.externalIdCol) || null;
    if (externalId && externalId.length > 120) {
      errors.push('The reference id is longer than 120 characters.');
      externalId = null;
    }
    out.push({
      line,
      raw: rec,
      ok: errors.length === 0,
      errors,
      warnings,
      date,
      description,
      merchant: get(mapping.merchantCol).slice(0, 120),
      amountCents: cents,
      externalId,
      status: parseStatus(get(mapping.statusCol)),
      categoryName: get(mapping.categoryCol),
      notes: get(mapping.notesCol).slice(0, 1000),
    });
  });
  const ok = out.filter((r) => r.ok);
  const positives = ok.filter((r) => r.amountCents > 0).length;
  return {
    rows: out,
    dateFormat: fmt,
    dateMessage,
    blocking: null,
    summary: { total: out.length, valid: ok.length, rejected: out.length - ok.length, positiveShare: ok.length ? positives / ok.length : 0 },
  };
}

/** Hint when signs look inverted for the destination account type. */
export function signHint(accountType, summary, invertSign) {
  if (!summary || !summary.valid) return null;
  const isLiability = ['credit_card', 'auto_loan', 'student_loan', 'personal_loan'].includes(accountType);
  if (isLiability && !invertSign && summary.positiveShare > 0.7) {
    return 'Most amounts are positive on a liability account. Card/loan exports usually list charges as positive; if these are purchases, turn on "Flip signs" so they reduce your balance.';
  }
  if (!isLiability && invertSign && summary.positiveShare < 0.3) {
    return 'Most amounts are negative after flipping on an asset account. Bank exports usually list withdrawals as negative; consider turning "Flip signs" off.';
  }
  return null;
}
