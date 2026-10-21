import { describe, it, expect } from 'vitest';
import { parseCsv, toCsv, detectDelimiter, IMPORT_LIMITS } from '../../src/imports/csv.js';
import { normalizeRows, suggestMapping, defaultMapping, detectDateFormat, parseDateWithFormat, signHint } from '../../src/imports/mapping.js';
import { matchRows, summarizePlan } from '../../src/imports/matching.js';
import { commitImport, undoImportBatch } from '../../src/domain/ops/importing.js';
import { completeReconciliation } from '../../src/domain/ops/reconcile.js';
import { caseB } from '../../src/seed/fixtures.js';
import { bal, must } from '../helpers.js';
import { getPreset } from '../../src/seed/presets.js';
import { validateStructure } from '../../src/domain/validate.js';

const run = (data, accountId, text, mappingPatch = {}, ctx = {}) => {
  const parsed = parseCsv(text);
  expect(parsed.ok).toBe(true);
  const mapping = { ...defaultMapping(), ...suggestMapping(parsed.rows[0]), ...mappingPatch };
  const norm = normalizeRows(parsed.rows, parsed.lines, mapping, ctx);
  expect(norm.blocking).toBeNull();
  const rows = matchRows(data, accountId, norm.rows);
  return { parsed, mapping, norm, rows };
};

describe('CSV parsing', () => {
  it('handles quotes, embedded commas, escaped quotes, multiline fields, blank lines and CRLF', () => {
    const text = '﻿Date,Description,Amount\r\n2026-01-02,"Coffee, large",-4.50\r\n\r\n2026-01-03,"He said ""hi""\nsecond line",-1.00\r\n2026-01-04,Plain,2.00';
    const r = parseCsv(text);
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([
      ['Date', 'Description', 'Amount'],
      ['2026-01-02', 'Coffee, large', '-4.50'],
      ['2026-01-03', 'He said "hi"\nsecond line', '-1.00'],
      ['2026-01-04', 'Plain', '2.00'],
    ]);
    expect(r.lines).toEqual([1, 2, 4, 6]);
  });
  it('reports an unterminated quote instead of importing garbage', () => {
    const r = parseCsv('a,b\n1,"never closed\n2,3');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/line 2.*never closed/i);
  });
  it('enforces size and row limits', () => {
    expect(parseCsv('x'.repeat(IMPORT_LIMITS.maxChars + 1)).ok).toBe(false);
    const many = 'a,b\n' + '1,2\n'.repeat(IMPORT_LIMITS.maxRows + 5);
    const r = parseCsv(many);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/limit/);
    expect(parseCsv(null).ok).toBe(false);
  });
  it('detects delimiters and round-trips through toCsv', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(detectDelimiter('a,b')).toBe(',');
    const rows = [['x', 'y,z', 'q"r'], ['=SUM(A1)', 'line\nbreak', '5']];
    const back = parseCsv(toCsv(rows));
    expect(back.rows[0]).toEqual(rows[0]);
    expect(back.rows[1][0]).toBe("'=SUM(A1)"); // formulas are neutralised on export
    expect(back.rows[1][1]).toBe('line\nbreak');
  });
});

describe('mapping and normalization', () => {
  it('suggests mappings from headers and parses debit/credit columns', () => {
    const m = suggestMapping(['Posting Date', 'Details', 'Debit', 'Credit', 'Reference']);
    expect(m).toMatchObject({ dateCol: 0, descriptionCol: 1, debitCol: 2, creditCol: 3, externalIdCol: 4, amountMode: 'debit_credit' });
    const parsed = parseCsv('Posting Date,Details,Debit,Credit,Reference\n2026-02-01,Grocer,45.10,,R1\n2026-02-02,Payroll,,1200.00,R2\n2026-02-03,Bad,10,5,R3\n');
    const norm = normalizeRows(parsed.rows, parsed.lines, { ...defaultMapping(), ...m }, {});
    expect(norm.rows.map((r) => r.amountCents)).toEqual([-4510, 120000, null]);
    expect(norm.rows[2].errors[0]).toMatch(/Both Debit and Credit/);
  });
  it('requires an explicit date format when slash dates are ambiguous', () => {
    expect(detectDateFormat(['03/04/2026', '05/06/2026']).ambiguous).toBe(true);
    expect(detectDateFormat(['13/04/2026', '05/06/2026']).format).toBe('dmy');
    expect(detectDateFormat(['03/14/2026']).format).toBe('mdy');
    expect(detectDateFormat(['2026-03-04']).format).toBe('iso');
    expect(detectDateFormat(['05-Mar-2026']).format).toBe('dmon');
    expect(detectDateFormat(['Mar 5, 2026']).format).toBe('mondy');
    const parsed = parseCsv('Date,Description,Amount\n03/04/2026,X,-1.00\n');
    const norm = normalizeRows(parsed.rows, parsed.lines, { ...defaultMapping(), dateCol: 0, descriptionCol: 1, amountCol: 2 }, {});
    expect(norm.blocking).toMatch(/Choose the date format/i);
    const ok = normalizeRows(parsed.rows, parsed.lines, { ...defaultMapping(), dateCol: 0, descriptionCol: 1, amountCol: 2, dateFormat: 'dmy' }, {});
    expect(ok.rows[0].date).toBe('2026-04-03');
    const us = normalizeRows(parsed.rows, parsed.lines, { ...defaultMapping(), dateCol: 0, descriptionCol: 1, amountCol: 2, dateFormat: 'mdy' }, {});
    expect(us.rows[0].date).toBe('2026-03-04');
  });
  it('rejects impossible dates and amounts row by row with line numbers', () => {
    const text = 'Date,Description,Amount\n2026-02-30,Bad date,-1.00\n2026-02-01,Fine,-2.00\n2026-02-02,,-3.00\n2026-02-03,Bad amount,abc\n2026-02-04,Zero,0.00\n2026-02-05,Huge,99999999999999\n2026-02-06,Short\n';
    const { norm } = run(caseB(), 'chk', text);
    expect(norm.rows.map((r) => r.ok)).toEqual([false, true, false, false, false, false, false]);
    expect(norm.rows[0].errors[0]).toMatch(/not a valid/);
    expect(norm.rows[1].line).toBe(3);
    expect(norm.rows[6].errors[0]).toMatch(/Expected 3 columns/);
    expect(norm.summary).toMatchObject({ total: 7, valid: 1, rejected: 6 });
  });
  it('parses unusual dates and European decimals', () => {
    expect(parseDateWithFormat('2024-02-29', 'iso')).toBe('2024-02-29');
    expect(parseDateWithFormat('2026-02-29', 'iso')).toBeNull();
    expect(parseDateWithFormat('1/2/26', 'mdy')).toBe('2026-01-02');
    expect(parseDateWithFormat('31 Dec 2025', 'dmon')).toBe('2025-12-31');
    const parsed = parseCsv('Datum;Text;Betrag\n2026-01-05;Miete;-1.234,56\n', { delimiter: ';' });
    const norm = normalizeRows(parsed.rows, parsed.lines, { ...defaultMapping(), dateCol: 0, descriptionCol: 1, amountCol: 2, decimal: ',' }, {});
    expect(norm.rows[0].amountCents).toBe(-123456);
  });
  it('hints when card exports need flipped signs', () => {
    expect(signHint('credit_card', { valid: 5, positiveShare: 0.9 }, false)).toMatch(/Flip signs/);
    expect(signHint('checking', { valid: 5, positiveShare: 0.9 }, false)).toBeNull();
  });
});

describe('Case C - identical purchases and reimport', () => {
  const text = 'Date,Description,Amount,Reference\n2026-01-20,Corner Coffee,-4.75,REF-1\n2026-01-20,Corner Coffee,-4.75,REF-2\n';
  it('keeps both identical coffees from one import and does not create four on reimport', () => {
    const d0 = caseB();
    const first = run(d0, 'chk', text);
    expect(first.rows.map((r) => r.match.type)).toEqual(['new', 'new']);
    const c1 = must(commitImport(d0, { accountId: 'chk', fileName: 'a.csv', rows: first.rows }, { now: 't1' }));
    expect(c1.imported).toBe(2);
    expect(bal(c1.data, 'chk')).toBe(bal(d0, 'chk') - 950);
    const again = run(c1.data, 'chk', text);
    expect(again.rows.map((r) => r.match.type)).toEqual(['duplicate', 'duplicate']);
    expect(commitImport(c1.data, { accountId: 'chk', fileName: 'a.csv', rows: again.rows }).ok).toBe(false);
    const purchases = c1.data.transactions.filter((t) => t.description === 'Corner Coffee');
    expect(purchases).toHaveLength(2);
    expect(summarizePlan(again.rows)).toMatchObject({ duplicates: 2, import: 0, skipped: 2 });
  });
  it('without references, matches by count and lets the user keep a legitimate repeat', () => {
    const noRef = 'Date,Description,Amount\n2026-01-20,Corner Coffee,-4.75\n2026-01-20,Corner Coffee,-4.75\n';
    const d0 = caseB();
    const first = run(d0, 'chk', noRef);
    expect(first.rows.map((r) => r.match.type)).toEqual(['new', 'new']);
    const c1 = must(commitImport(d0, { accountId: 'chk', fileName: 'a.csv', rows: first.rows }));
    const again = run(c1.data, 'chk', noRef);
    expect(again.rows.map((r) => r.match.type)).toEqual(['suspected', 'suspected']);
    expect(again.rows.every((r) => r.match.action === 'skip')).toBe(true);
    // a third identical purchase appears in a later export: only the extra one is new
    const three = noRef + '2026-01-20,Corner Coffee,-4.75\n';
    const later = run(c1.data, 'chk', three);
    expect(later.rows.map((r) => r.match.type)).toEqual(['suspected', 'suspected', 'new']);
    // deliberately keep a suspected row
    const decided = later.rows.map((r, i) => (i === 0 ? { ...r, decision: 'import' } : r));
    const c2 = must(commitImport(c1.data, { accountId: 'chk', fileName: 'b.csv', rows: decided }));
    expect(c2.imported).toBe(2);
    expect(c2.data.transactions.filter((t) => t.description === 'Corner Coffee')).toHaveLength(4);
  });
  it('a different reference means a different purchase even if everything else matches an existing manual entry', () => {
    const preset = getPreset('duplicate-imports').build();
    const csv = getPreset('duplicate-imports').csv.text;
    const r = run(preset, 'chk', csv);
    expect(r.rows.map((x) => x.match.type)).toEqual(['duplicate', 'duplicate', 'duplicate', 'settles_pending', 'new', 'new']);
  });
});

describe('pending items settle instead of duplicating', () => {
  it('matches a pending item to its posted version with a changed description and amount', () => {
    const d0 = getPreset('duplicate-imports').build();
    const csv = 'Date,Description,Amount\n2026-09-17,BREWLINE CAFE #12,-6.00\n';
    const r = run(d0, 'chk', csv);
    expect(r.rows[0].match.type).toBe('settles_pending');
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'p.csv', rows: r.rows }, { now: 't' }));
    expect(c.settled).toBe(1);
    expect(c.imported).toBe(0);
    const settled = c.data.transactions.find((t) => t.description === 'BREWLINE CAFE #12');
    expect(settled.status).toBe('posted');
    expect(settled.amountCents).toBe(-600);
    expect(c.data.transactions).toHaveLength(d0.transactions.length);
  });
});

describe('commit atomicity and undo', () => {
  it('rejects a whole import if any row would break an invariant (nothing partial)', () => {
    const d0 = caseB();
    const r = run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-02-01,Fine,-1.00,X1\n2025-01-01,Before opening,-1.00,X2\n');
    const res = commitImport(d0, { accountId: 'chk', fileName: 'x.csv', rows: r.rows });
    expect(res.ok).toBe(false);
    expect(d0.transactions).toHaveLength(1);
  });
  it('undo removes only the batch and restores settled pending items', () => {
    const d0 = getPreset('duplicate-imports').build();
    const r = run(d0, 'chk', getPreset('duplicate-imports').csv.text);
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'reimport.csv', rows: r.rows }, { now: 't' }));
    expect(c.imported).toBe(2);
    expect(c.settled).toBe(1);
    expect(c.skipped).toBe(3);
    const u = must(undoImportBatch(c.data, c.batchId, { now: 'u' }));
    expect(u.removed).toBe(2);
    expect(u.restored).toBe(1);
    const strip = (d) => JSON.stringify(d.transactions.map((t) => [t.id, t.amountCents, t.status, t.description]));
    expect(strip(u.data)).toBe(strip(d0));
    expect(u.data.importBatches.find((b) => b.id === c.batchId).status).toBe('undone');
    expect(undoImportBatch(u.data, c.batchId).ok).toBe(false);
    expect(validateStructure(u.data).filter((f) => f.blocking)).toEqual([]);
  });
  it('refuses to undo while imported transactions sit in a completed reconciliation', () => {
    const d0 = caseB();
    const r = run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-01-20,Imported,-10.00,Z1\n');
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'z.csv', rows: r.rows }));
    const id = c.data.transactions.find((t) => t.description === 'Imported').id;
    const rec = must(completeReconciliation(c.data, { accountId: 'chk', startDate: '2026-01-01', endDate: '2026-01-31', openingCents: 50000, closingCents: 50000 - 4735 - 1000, clearedTxIds: ['b1', id] }));
    expect(undoImportBatch(rec.data, c.batchId).errors[0].message).toMatch(/completed reconciliation/);
  });
  it('applies categorization rules to imported rows without overriding anything', () => {
    let d0 = caseB();
    d0 = must((await_import_rule(d0))).data;
    const r = run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-01-20,Fresh Fields Market,-10.00,Q1\n');
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'q.csv', rows: r.rows }));
    const tx = c.data.transactions.find((t) => t.description === 'Fresh Fields Market');
    expect(tx.categoryId).toBe('cat-groceries');
    expect(tx.categorySource).toBe('rule');
    expect(tx.source).toMatchObject({ type: 'import', externalId: 'Q1' });
  });
});

import { saveRule } from '../../src/domain/ops/catalog.js';
function await_import_rule(d) {
  return saveRule(d, { name: 'Fresh', pattern: 'fresh fields', categoryId: 'cat-groceries', priority: 5 });
}
