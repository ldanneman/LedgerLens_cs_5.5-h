import { formatMoney } from '../domain/money.js';
import { ACCOUNT_TYPE_LABELS } from '../domain/schema.js';

/** Compact money for chart axes: $1.2k, -$3.4M. */
export function compactMoney(cents) {
  const v = cents / 100;
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(a)}`;
}

export const accountTypeLabel = (t) => ACCOUNT_TYPE_LABELS[t] || t;

/** Human label for a transaction's UI "type". */
export function txTypeLabel(tx) {
  if (tx.kind === 'transfer') return tx.amountCents < 0 ? 'Transfer out' : 'Transfer in';
  if (tx.kind === 'adjustment') return tx.adjustmentKind === 'valuation' ? 'Valuation' : 'Adjustment';
  if (tx.kind === 'expense') return tx.amountCents > 0 ? 'Refund' : 'Expense';
  return tx.amountCents < 0 ? 'Income reversal' : 'Income';
}

/** Money string with explicit sign for flows. */
export const signedMoney = (c) => formatMoney(c, { signed: true });

/** Percent label that never shows NaN. */
export function pctLabel(p) {
  return p === null || p === undefined || !Number.isFinite(p) ? '-' : `${p.toFixed(1).replace(/\.0$/, '')}%`;
}

/** Trigger a browser download of text content. Returns false when downloads are unavailable. */
export function downloadText(filename, text, type = 'application/json') {
  try {
    const blob = new Blob([text], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

/** Read a File as text with a size guard. */
export function readFileText(file, maxBytes) {
  return new Promise((resolve, reject) => {
    if (maxBytes && file.size > maxBytes) {
      reject(new Error(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`));
      return;
    }
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(new Error('The file could not be read.'));
    r.readAsText(file);
  });
}
