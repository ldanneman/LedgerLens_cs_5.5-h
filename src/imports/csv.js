/**
 * RFC-4180-style CSV parser (state machine). Handles a UTF-8 BOM, quoted fields, doubled quotes,
 * embedded delimiters and embedded newlines inside quotes, CRLF/LF/CR line endings and blank lines.
 * It never evaluates anything and never throws on malformed input: problems are returned as errors.
 */

export const IMPORT_LIMITS = Object.freeze({
  maxChars: 5 * 1024 * 1024,
  maxRows: 20000,
  maxColumns: 60,
  maxFieldChars: 5000,
});

/** Guess the delimiter from the first non-empty line (comma, semicolon or tab). */
export function detectDelimiter(text) {
  const line = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).find((l) => l.trim() !== '') || '';
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    let inQ = false;
    let count = 0;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === d && !inQ) count += 1;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Parse CSV text.
 * @param {string} text @param {{delimiter?:string}} [opts]
 * @returns {{ok:boolean, rows:string[][], lines:number[], warnings:Array<{line:number,message:string}>, error?:string}}
 *   `lines[i]` is the 1-based source line where record i starts (for row-level feedback).
 */
export function parseCsv(text, opts = {}) {
  const warnings = [];
  if (typeof text !== 'string') return { ok: false, rows: [], lines: [], warnings, error: 'The file could not be read as text.' };
  if (text.length > IMPORT_LIMITS.maxChars) {
    return { ok: false, rows: [], lines: [], warnings, error: `The file is too large (${Math.round(text.length / 1024)} KB). The limit is ${IMPORT_LIMITS.maxChars / 1024 / 1024} MB.` };
  }
  const delim = opts.delimiter || ',';
  if (delim.length !== 1) return { ok: false, rows: [], lines: [], warnings, error: 'The delimiter must be a single character.' };
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  const lines = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let wasQuoted = false;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;
  const endField = () => {
    if (field.length > IMPORT_LIMITS.maxFieldChars) {
      warnings.push({ line: recordLine, message: `A field is longer than ${IMPORT_LIMITS.maxFieldChars} characters and was truncated.` });
      field = field.slice(0, IMPORT_LIMITS.maxFieldChars);
    }
    row.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endField();
    const blank = row.length === 1 && row[0].trim() === '';
    if (!blank) {
      rows.push(row);
      lines.push(recordLine);
    }
    row = [];
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field === '' && !wasQuoted) {
        inQuotes = true;
        wasQuoted = true;
        quoteLine = line;
      } else {
        field += '"'; // stray quote inside an unquoted field: keep it literally
        warnings.push({ line, message: 'A quote character appears inside an unquoted field; it was kept as text.' });
      }
    } else if (ch === delim) {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
      recordLine = line;
      if (rows.length > IMPORT_LIMITS.maxRows + 1) {
        return { ok: false, rows: [], lines: [], warnings, error: `The file has more than ${IMPORT_LIMITS.maxRows.toLocaleString('en-US')} rows, which is the import limit. Split it into smaller files.` };
      }
    } else {
      field += ch;
    }
    if (row.length > IMPORT_LIMITS.maxColumns) {
      return { ok: false, rows: [], lines: [], warnings, error: `Line ${recordLine} has more than ${IMPORT_LIMITS.maxColumns} columns. Check the delimiter setting.` };
    }
  }
  if (inQuotes) {
    return { ok: false, rows: [], lines: [], warnings, error: `A quoted field that starts on line ${quoteLine} is never closed (missing closing quote). Nothing was imported.` };
  }
  if (field !== '' || row.length > 0 || wasQuoted) endRow();
  if (rows.length - 1 > IMPORT_LIMITS.maxRows) {
    return { ok: false, rows: [], lines: [], warnings, error: `The file has more than ${IMPORT_LIMITS.maxRows.toLocaleString('en-US')} rows, which is the import limit. Split it into smaller files.` };
  }
  return { ok: true, rows, lines, warnings };
}

/** Serialize rows to CSV text (quotes any field containing a delimiter, quote or newline). */
export function toCsv(rows, delimiter = ',') {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    // neutralise spreadsheet formula injection when the file is later opened in a spreadsheet
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /["\n\r]/.test(safe) || safe.includes(delimiter) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(esc).join(delimiter)).join('\r\n') + '\r\n';
}
