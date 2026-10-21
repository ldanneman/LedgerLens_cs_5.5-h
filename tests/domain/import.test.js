import { describe, it, expect } from 'vitest';
import { parseCsv, toCsv, detectDelimiter, IMPORT_LIMITS } from '../../src/imports/csv.js';
import { normalizeRows, suggestMapping, defaultMapping, detectDateFormat, parseDateWithFormat, signHint } from '../../src/imports/mapping.js';
import { matchRows, summarizePlan } from '../../src/imports/matching.js';
import { commitImport, undoImportBatch } from '../../src/domain/ops/importing.js';
import { completeReconciliation } from '../../src/domain/ops/reconcile.js';
import { caseB } from '../../src/seed/fixtures.js';
import { buildDemoDataset } from '../../src/seed/demo.js';
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

// ---------------------------------------------------------------------------------------------
// R2 / R4 / R5 regression coverage (pending settlement identity, batch ownership, split settlement)
// ---------------------------------------------------------------------------------------------
import { DatasetBuilder, usd } from '../../src/seed/builder.js';
import { addTransaction, updateTransaction, deleteTransactions, linkAsTransfer } from '../../src/domain/ops/transactions.js';
import { parseImportText, exportDatasetJson } from '../../src/persistence/serialize.js';
import { reconciliationHealth } from '../../src/domain/reconciliation.js';

const importSrc = (externalId, batchId = null) => ({ type: 'import', batchId, externalId, importedAt: null, rawDescription: null });

/** Checking with pending items. `pendings` = [{id, date, desc, cents, ext, splits}] */
function pendingLedger(pendings, { second = false } = {}) {
  const b = new DatasetBuilder({ name: 'R2', asOfDate: '2026-09-30' });
  b.category('cat-coffee', 'Coffee', 'expense');
  b.category('cat-groceries', 'Groceries', 'expense');
  b.category('cat-household', 'Household', 'expense');
  b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-09-01' });
  if (second) b.account('sav', { name: 'Savings', type: 'savings', opening: 0, openingDate: '2026-09-01' });
  for (const p of pendings) {
    b.tx({ id: p.id, account: 'chk', date: p.date, desc: p.desc, merchant: p.desc, amount: p.cents, kind: 'expense', status: 'pending', category: p.splits ? undefined : p.category, splits: p.splits, source: p.ext === undefined ? undefined : importSrc(p.ext) });
  }
  return b.build();
}
const coffee = (id, ext, date = '2026-09-15') => ({ id, date, desc: 'Review Coffee', cents: -475, ext });
const csvOne = (date, desc, amount, ref) => `Date,Description,Amount${ref === undefined ? '' : ',Reference'}\n${date},${desc},${amount}${ref === undefined ? '' : `,${ref}`}\n`;
const types = (rows) => rows.map((r) => r.match.type);

describe('R2: a conflicting external reference is never merged by a similarity heuristic', () => {
  it('pending P1 and posted P2 stay two purchases through commit, reimport and undo', () => {
    const d0 = pendingLedger([coffee('p1', 'P1')]);
    const r = run(d0, 'chk', csvOne('2026-09-16', 'Review Coffee', '-4.75', 'P2'));
    expect(r.rows[0].match.type).toBe('new');
    expect(r.rows[0].match.action).toBe('import');
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'p2.csv', rows: r.rows }, { now: 't' }));
    expect(c.settled).toBe(0);
    expect(c.imported).toBe(1);
    const p1 = c.data.transactions.find((t) => t.id === 'p1');
    expect(p1).toMatchObject({ status: 'pending', amountCents: -475, source: { externalId: 'P1' } });
    const p2 = c.data.transactions.find((t) => t.source.externalId === 'P2');
    expect(p2).toMatchObject({ status: 'posted', amountCents: -475, date: '2026-09-16' });
    expect(c.data.transactions.filter((t) => t.description === 'Review Coffee')).toHaveLength(2);
    // reimporting the same file must not create another P2
    const again = run(c.data, 'chk', csvOne('2026-09-16', 'Review Coffee', '-4.75', 'P2'));
    expect(types(again.rows)).toEqual(['duplicate']);
    expect(commitImport(c.data, { accountId: 'chk', fileName: 'p2.csv', rows: again.rows }).ok).toBe(false);
    // undo removes only P2 and leaves P1 exactly as it was
    const u = must(undoImportBatch(c.data, c.batchId, { now: 'u' }));
    expect(u.data.transactions.map((t) => t.id)).toEqual(['p1']);
    expect(u.data.transactions[0]).toEqual(d0.transactions[0]);
  });
  it('the same reference still settles the pending item exactly once', () => {
    const d0 = pendingLedger([coffee('p1', 'P1')]);
    const r = run(d0, 'chk', csvOne('2026-09-16', 'Review Coffee', '-4.75', 'P1'));
    expect(types(r.rows)).toEqual(['settles_pending']);
    expect(r.rows[0].match.existingTxId).toBe('p1');
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'p1.csv', rows: r.rows }, { now: 't' }));
    expect(c.data.transactions).toHaveLength(1);
    expect(c.data.transactions[0]).toMatchObject({ id: 'p1', status: 'posted', date: '2026-09-16', source: { externalId: 'P1', batchId: c.batchId } });
    expect(types(run(c.data, 'chk', csvOne('2026-09-16', 'Review Coffee', '-4.75', 'P1')).rows)).toEqual(['duplicate']);
  });
  it('one missing reference may still settle (the bank adds a reference or the pending one never had one)', () => {
    const noRef = pendingLedger([coffee('p1', undefined)]);
    const a = run(noRef, 'chk', csvOne('2026-09-16', 'Review Coffee', '-4.75', 'P2'));
    expect(types(a.rows)).toEqual(['settles_pending']);
    const ca = must(commitImport(noRef, { accountId: 'chk', fileName: 'a.csv', rows: a.rows }));
    expect(ca.data.transactions).toHaveLength(1);
    expect(ca.data.transactions[0].source.externalId).toBe('P2');
    const withRef = pendingLedger([coffee('p1', 'P1')]);
    const b = run(withRef, 'chk', csvOne('2026-09-16', 'Review Coffee', '-4.75'));
    expect(types(b.rows)).toEqual(['settles_pending']);
    const cb = must(commitImport(withRef, { accountId: 'chk', fileName: 'b.csv', rows: b.rows }));
    expect(cb.data.transactions[0].source.externalId).toBe('P1');
  });
  it('with no references anywhere, the similarity match is offered as a reviewable heuristic, not as proof', () => {
    const d0 = pendingLedger([coffee('p1', undefined)]);
    const r = run(d0, 'chk', csvOne('2026-09-16', 'Review Coffee', '-4.75'));
    expect(r.rows[0].match).toMatchObject({ type: 'settles_pending', basis: 'heuristic', existingTxId: 'p1', ambiguous: false });
    expect(summarizePlan(r.rows).attention).toBe(1);
    // choosing "import as new" keeps the pending item untouched
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'x.csv', rows: r.rows.map((x) => ({ ...x, decision: 'import' })) }));
    expect(c.data.transactions.filter((t) => t.description === 'Review Coffee')).toHaveLength(2);
    expect(c.data.transactions.find((t) => t.id === 'p1').status).toBe('pending');
  });
  it('the same-date fingerprint path also respects a conflicting reference', () => {
    const d0 = pendingLedger([coffee('p1', 'P1')]);
    expect(types(run(d0, 'chk', csvOne('2026-09-15', 'Review Coffee', '-4.75', 'P2')).rows)).toEqual(['new']);
  });
  it('in-file duplicates: different references are both kept (and never merge with a pending item); a repeated reference is skipped', () => {
    const d0 = pendingLedger([coffee('p1', 'P1')]);
    const two = run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P2\n2026-09-16,Review Coffee,-4.75,P3\n');
    expect(types(two.rows)).toEqual(['new', 'new']);
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'two.csv', rows: two.rows }));
    expect(c.data.transactions.map((t) => [t.status, t.source.externalId])).toEqual([['pending', 'P1'], ['posted', 'P2'], ['posted', 'P3']]);
    const twice = run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P2\n2026-09-16,Review Coffee,-4.75,P2\n');
    expect(types(twice.rows)).toEqual(['new', 'in_file_duplicate']);
  });
  it('two competing pending candidates: references decide; unknown references match neither', () => {
    const d0 = pendingLedger([coffee('p1', 'P1'), coffee('p2', 'P2')]);
    const byRef = run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P2\n2026-09-16,Review Coffee,-4.75,P1\n');
    expect(byRef.rows.map((x) => x.match.existingTxId)).toEqual(['p2', 'p1']);
    const stranger = run(d0, 'chk', csvOne('2026-09-16', 'Review Coffee', '-4.75', 'P3'));
    expect(types(stranger.rows)).toEqual(['new']);
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 's.csv', rows: stranger.rows }));
    expect(c.data.transactions.filter((t) => t.status === 'pending')).toHaveLength(2);
    expect(c.data.transactions).toHaveLength(3);
  });
  it('two competing pending candidates without references are flagged ambiguous and settled one each, deterministically', () => {
    const d0 = pendingLedger([coffee('p1', undefined, '2026-09-14'), coffee('p2', undefined, '2026-09-15')]);
    const r = run(d0, 'chk', 'Date,Description,Amount\n2026-09-15,Review Coffee,-4.75\n2026-09-15,Review Coffee,-4.75\n');
    expect(r.rows[0].match).toMatchObject({ type: 'settles_pending', existingTxId: 'p2', ambiguous: true });
    expect(r.rows[0].match.alternatives).toEqual(['p1']);
    expect(r.rows[1].match).toMatchObject({ type: 'settles_pending', existingTxId: 'p1', ambiguous: false });
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'amb.csv', rows: r.rows }));
    expect(c.settled).toBe(2);
    expect(c.data.transactions.every((t) => t.status === 'posted')).toBe(true);
    // a third identical posted row has nothing left to settle
    const three = run(d0, 'chk', 'Date,Description,Amount\n2026-09-15,Review Coffee,-4.75\n2026-09-15,Review Coffee,-4.75\n2026-09-15,Review Coffee,-4.75\n');
    expect(types(three.rows)).toEqual(['settles_pending', 'settles_pending', 'new']);
  });
  it('the user may choose which of several pending items a row settles', () => {
    const d0 = pendingLedger([coffee('p1', undefined, '2026-09-14'), coffee('p2', undefined, '2026-09-15')]);
    const r = run(d0, 'chk', csvOne('2026-09-15', 'Review Coffee', '-4.75'));
    const chosen = r.rows.map((x) => ({ ...x, settleTxId: 'p1' }));
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'c.csv', rows: chosen }));
    expect(c.data.transactions.find((t) => t.id === 'p1').status).toBe('posted');
    expect(c.data.transactions.find((t) => t.id === 'p2').status).toBe('pending');
  });
  it('commitImport re-checks identity: a forged or stale plan cannot overwrite a different purchase', () => {
    const d0 = pendingLedger([coffee('p1', 'P1')]);
    const r = run(d0, 'chk', csvOne('2026-09-16', 'Review Coffee', '-4.75', 'P2'));
    const forged = r.rows.map((x) => ({ ...x, match: { ...x.match, type: 'settles_pending', existingTxId: 'p1', action: 'settle' } }));
    const res = commitImport(d0, { accountId: 'chk', fileName: 'f.csv', rows: forged });
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toMatch(/P1.*P2|different reference|different purchase/i);
    expect(d0.transactions[0].source.externalId).toBe('P1');
    const viaDecision = commitImport(d0, { accountId: 'chk', fileName: 'f.csv', rows: r.rows.map((x) => ({ ...x, decision: 'settle', settleTxId: 'p1' })) });
    expect(viaDecision.ok).toBe(false);
  });
  it('settling cannot create a second record that carries an existing reference', () => {
    const d0 = pendingLedger([{ id: 'p1', date: '2026-09-15', desc: 'Review Coffee', cents: -475 }, { id: 'p9', date: '2026-09-01', desc: 'Other', cents: -100, ext: 'DUP' }]);
    const r = run(d0, 'chk', csvOne('2026-09-16', 'Review Coffee', '-4.75', 'DUP'));
    // 'DUP' already exists on p9 => the row is that record's duplicate, never a settlement of p1
    expect(r.rows[0].match.type).not.toBe('new');
    const forged = r.rows.map((x) => ({ ...x, match: { ...x.match, type: 'settles_pending', existingTxId: 'p1', action: 'settle' } }));
    expect(commitImport(d0, { accountId: 'chk', fileName: 'f.csv', rows: forged }).ok).toBe(false);
  });
});

describe('R5: settling a pending item whose amount changed keeps its splits exact', () => {
  const splitPending = (cents, parts) => pendingLedger([{ id: 'sp', date: '2026-09-15', desc: 'Fresh Fields', cents, splits: parts }]);
  const csv = (amount) => csvOne('2026-09-16', 'Fresh Fields', amount);
  it('rescales -$6/-$4 to -$6.60/-$4.40 for a -$11 posted amount, shows the plan, and undo restores the original', () => {
    const d0 = splitPending(-1000, [['cat-groceries', -600], ['cat-household', -400]]);
    const r = run(d0, 'chk', csv('-11.00'));
    expect(r.rows[0].match.type).toBe('settles_pending');
    expect(r.rows[0].match.splitPlan).toMatchObject({ policy: 'proportional', after: [{ categoryId: 'cat-groceries', amountCents: -660 }, { categoryId: 'cat-household', amountCents: -440 }] });
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 's.csv', rows: r.rows }, { now: 't' }));
    const tx = c.data.transactions.find((t) => t.id === 'sp');
    expect(tx).toMatchObject({ status: 'posted', amountCents: -1100 });
    expect(tx.splits.map((s) => [s.categoryId, s.amountCents])).toEqual([['cat-groceries', -660], ['cat-household', -440]]);
    expect(tx.splits.reduce((s, x) => s + x.amountCents, 0)).toBe(tx.amountCents);
    // posted checking: opening $1,000.00 less the settled -$11.00, counted exactly once (the -$10.00 pending is gone)
    expect(bal(c.data, 'chk')).toBe(100000 - 1100);
    expect(bal(c.data, 'chk', '2026-09-30', true)).toBe(100000 - 1100);
    const u = must(undoImportBatch(c.data, c.batchId));
    expect(u.data.transactions.find((t) => t.id === 'sp')).toEqual(d0.transactions.find((t) => t.id === 'sp'));
  });
  it('distributes a leftover cent by largest remainder, deterministically, never losing a penny', () => {
    const d0 = splitPending(-1000, [['cat-groceries', -333], ['cat-household', -333], ['cat-coffee', -334]]);
    const r = run(d0, 'chk', csv('-10.01'));
    const after = r.rows[0].match.splitPlan.after.map((s) => s.amountCents);
    expect(after).toEqual([-333, -333, -335]);
    expect(after.reduce((a, b) => a + b, 0)).toBe(-1001);
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 's.csv', rows: r.rows }));
    expect(c.data.transactions.find((t) => t.id === 'sp').splits.map((s) => s.amountCents)).toEqual(after);
  });
  it('an unchanged amount leaves the splits exactly as the user set them', () => {
    const d0 = splitPending(-1000, [['cat-groceries', -600], ['cat-household', -400]]);
    const r = run(d0, 'chk', csv('-10.00'));
    expect(r.rows[0].match.splitPlan).toBeUndefined();
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 's.csv', rows: r.rows }));
    expect(c.data.transactions.find((t) => t.id === 'sp').splits.map((s) => s.amountCents)).toEqual([-600, -400]);
  });
  it('an explicit manual allocation is honoured when it sums exactly, and rejected when it does not', () => {
    const d0 = splitPending(-1000, [['cat-groceries', -600], ['cat-household', -400]]);
    const r = run(d0, 'chk', csv('-11.00'));
    const manual = (parts) => r.rows.map((x) => ({ ...x, splits: parts }));
    const ok = must(commitImport(d0, { accountId: 'chk', fileName: 's.csv', rows: manual([{ categoryId: 'cat-groceries', amountCents: -1000 }, { categoryId: 'cat-household', amountCents: -100 }]) }));
    expect(ok.data.transactions.find((t) => t.id === 'sp').splits.map((s) => s.amountCents)).toEqual([-1000, -100]);
    const bad = commitImport(d0, { accountId: 'chk', fileName: 's.csv', rows: manual([{ categoryId: 'cat-groceries', amountCents: -1000 }, { categoryId: 'cat-household', amountCents: -99 }]) });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toMatch(/\$10\.99|\$11\.00|splits/i);
    expect(d0.transactions.find((t) => t.id === 'sp').status).toBe('pending');
  });
  it('choosing "Import as new" or "Skip" cancels the adjustment and leaves the pending item and its splits untouched', () => {
    const d0 = splitPending(-1000, [['cat-groceries', -600], ['cat-household', -400]]);
    const r = run(d0, 'chk', csv('-11.00'));
    const skipped = commitImport(d0, { accountId: 'chk', fileName: 's.csv', rows: r.rows.map((x) => ({ ...x, decision: 'skip' })) });
    expect(skipped.ok).toBe(false);
    const asNew = must(commitImport(d0, { accountId: 'chk', fileName: 's.csv', rows: r.rows.map((x) => ({ ...x, decision: 'import' })) }));
    const sp = asNew.data.transactions.find((t) => t.id === 'sp');
    expect(sp).toEqual(d0.transactions.find((t) => t.id === 'sp'));
    expect(asNew.data.transactions).toHaveLength(2);
  });
  it('a same-reference row of opposite sign (pending purchase became a refund) keeps a valid, same-signed split set', () => {
    const d0 = pendingLedger([{ id: 'sp', date: '2026-09-15', desc: 'Fresh Fields', cents: -1000, ext: 'S1', splits: [['cat-groceries', -600], ['cat-household', -400]] }]);
    const r = run(d0, 'chk', csvOne('2026-09-16', 'Fresh Fields', '11.00', 'S1'));
    expect(r.rows[0].match.type).toBe('settles_pending');
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 's.csv', rows: r.rows }));
    const tx = c.data.transactions.find((t) => t.id === 'sp');
    expect(tx.amountCents).toBe(1100);
    expect(tx.splits.map((s) => s.amountCents)).toEqual([660, 440]);
    expect(validateStructure(c.data).filter((f) => f.blocking)).toEqual([]);
  });
  it('a pending item with a single category (no splits) just changes amount', () => {
    const d0 = pendingLedger([{ id: 'p1', date: '2026-09-15', desc: 'Fresh Fields', cents: -1000, category: 'cat-groceries' }]);
    const r = run(d0, 'chk', csv('-11.00'));
    expect(r.rows[0].match.splitPlan).toBeUndefined();
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 's.csv', rows: r.rows }));
    expect(c.data.transactions[0]).toMatchObject({ amountCents: -1100, categoryId: 'cat-groceries' });
  });
});

describe('R4: import-batch ownership is validated at the boundary and re-checked at undo', () => {
  /** A dataset with one manual transaction and a committed batch that illegitimately claims it. */
  function forged(mutateBatch = (b) => b) {
    const base = pendingLedger([]);
    const d = must(addTransaction(base, { accountId: 'chk', date: '2026-09-10', description: 'Manual rent', amountCents: -50000, kind: 'expense', categoryId: 'cat-household' })).data;
    const manualId = d.transactions[0].id;
    const out = JSON.parse(JSON.stringify(d));
    out.importBatches.push(mutateBatch({ id: 'batch-1', accountId: 'chk', fileName: 'x.csv', importedAt: null, status: 'committed', createdTxIds: [manualId], settled: [], rowCount: 1, skippedCount: 0, rejectedCount: 0, undoneAt: null }));
    return { data: out, manualId };
  }
  it('rejects a batch whose createdTxIds claims a manually entered transaction (JSON import)', () => {
    const { data } = forged();
    const res = parseImportText(exportDatasetJson(data));
    expect(res.ok).toBe(false);
    expect(res.findings.filter((f) => f.blocking).map((f) => f.code)).toContain('batch-ownership');
    expect(res.findings.find((f) => f.code === 'batch-ownership').message).toMatch(/batch-1/);
  });
  it('undoImportBatch refuses (before touching anything) even if such a batch is already in memory', () => {
    const { data, manualId } = forged();
    const res = undoImportBatch(data, 'batch-1');
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toMatch(/not created by this import|does not belong|not owned/i);
    expect(data.transactions.some((t) => t.id === manualId)).toBe(true);
    expect(data.importBatches[0].status).toBe('committed');
  });
  it('rejects a transaction claimed by the wrong batch, by two batches, and malformed id lists', () => {
    const wrong = forged();
    wrong.data.transactions.find((t) => t.id === wrong.manualId).source = importSrc('X', 'batch-2');
    wrong.data.importBatches.push({ id: 'batch-2', accountId: 'chk', fileName: '', importedAt: null, status: 'committed', createdTxIds: [wrong.manualId], settled: [], rowCount: 1, skippedCount: 0, rejectedCount: 0, undoneAt: null });
    const f = parseImportText(exportDatasetJson(wrong.data)).findings.filter((x) => x.code === 'batch-ownership');
    expect(f.length).toBeGreaterThanOrEqual(1);
    expect(f.some((x) => /batch-1/.test(x.message))).toBe(true);
    for (const [label, ids] of [['duplicate ids', (id) => [id, id]], ['a non-string id', () => [42]], ['an empty id', () => ['']], ['not an array', () => 'tx-1']]) {
      const { data, manualId } = forged();
      data.transactions.find((t) => t.id === manualId).source = importSrc('Q', 'batch-1');
      data.importBatches[0].createdTxIds = ids(manualId);
      const res = parseImportText(exportDatasetJson(data));
      expect(res.ok, label).toBe(false);
    }
  });
  it('rejects malformed settlement-restoration records', () => {
    const cases = {
      'not an object': () => 'oops',
      'missing txId': () => ({ before: {} }),
      'before is not a transaction': () => ({ txId: 'p1', before: 5 }),
      'before has a different id': (b) => ({ txId: 'p1', before: { ...b, id: 'other' } }),
      'before is in another account': (b) => ({ txId: 'p1', before: { ...b, accountId: 'sav' } }),
      'before has fractional cents': (b) => ({ txId: 'p1', before: { ...b, amountCents: -4.5 } }),
      'before is not pending': (b) => ({ txId: 'p1', before: { ...b, status: 'posted' } }),
    };
    for (const [label, make] of Object.entries(cases)) {
      const d0 = pendingLedger([coffee('p1', 'P1')], { second: true });
      const r = run(d0, 'chk', csvOne('2026-09-16', 'Review Coffee', '-4.75', 'P1'));
      const c = must(commitImport(d0, { accountId: 'chk', fileName: 'p1.csv', rows: r.rows }));
      const out = JSON.parse(JSON.stringify(c.data));
      out.importBatches[0].settled = [make(JSON.parse(JSON.stringify(d0.transactions[0])))];
      expect(parseImportText(exportDatasetJson(out)).ok, label).toBe(false);
    }
  });
  it('a genuine application-generated batch validates, round-trips and undoes', () => {
    const d0 = pendingLedger([coffee('p1', 'P1')]);
    const r = run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P1\n2026-09-17,Hardware,-20.00,H1\n');
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'ok.csv', rows: r.rows }, { now: 't' }));
    const rt = parseImportText(exportDatasetJson(c.data));
    expect(rt.ok).toBe(true);
    const u = must(undoImportBatch(rt.dataset, c.batchId, { now: 'u' }));
    expect(u.data.transactions).toEqual(d0.transactions);
  });
  it('later edits and removals are valid history: edited created rows are still undone, deleted ones are skipped, deleted settled items are reported', () => {
    const d0 = pendingLedger([coffee('p1', 'P1')]);
    const r = run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P1\n2026-09-17,Hardware,-20.00,H1\n2026-09-18,Paint,-30.00,H2\n');
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'ok.csv', rows: r.rows }, { now: 't' }));
    const [hw, paint] = c.data.importBatches[0].createdTxIds;
    let d = must(updateTransaction(c.data, hw, { categoryId: 'cat-household', notes: 'edited later' })).data;
    d = must(deleteTransactions(d, [paint])).data;
    d = must(deleteTransactions(d, ['p1'])).data;
    expect(validateStructure(d).filter((f) => f.blocking)).toEqual([]);
    const u = must(undoImportBatch(d, c.batchId, { now: 'u' }));
    expect(u.removed).toBe(1);
    expect(u.restored).toBe(0);
    expect(u.warnings.join(' ')).toMatch(/no longer exist/i);
    expect(u.data.transactions).toHaveLength(0);
    expect(undoImportBatch(u.data, c.batchId).ok).toBe(false);
  });
  it('refuses to undo when a created transaction has since become half of a transfer, and changes nothing', () => {
    let d = pendingLedger([], { second: true });
    const r = run(d, 'chk', 'Date,Description,Amount,Reference\n2026-09-16,Move to savings,-100.00,T1\n');
    const c = must(commitImport(d, { accountId: 'chk', fileName: 't.csv', rows: r.rows }));
    d = must(addTransaction(c.data, { accountId: 'sav', date: '2026-09-16', description: 'From checking', amountCents: 10000, kind: 'income' })).data;
    const ids = d.transactions.map((t) => t.id);
    d = must(linkAsTransfer(d, ids[0], ids[1])).data;
    const res = undoImportBatch(d, c.batchId);
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toMatch(/transfer/i);
    expect(d.transactions).toHaveLength(2);
    expect(d.importBatches[0].status).toBe('committed');
  });
  it('refuses to undo when a created transaction has since been reversed by another entry', () => {
    const d0 = pendingLedger([]);
    const r = run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-09-16,Hardware,-20.00,H1\n');
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'h.csv', rows: r.rows }));
    const created = c.data.transactions[0].id;
    const rev = must(reverseTransactionOp(c.data, created));
    const res = undoImportBatch(rev.data, c.batchId);
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toMatch(/revers/i);
  });
  it('refuses to undo when a settled item is now part of a completed reconciliation', () => {
    const d0 = pendingLedger([coffee('p1', 'P1')]);
    const r = run(d0, 'chk', csvOne('2026-09-16', 'Review Coffee', '-4.75', 'P1'));
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'p1.csv', rows: r.rows }));
    const rec = must(completeReconciliation(c.data, { accountId: 'chk', startDate: '2026-09-01', endDate: '2026-09-30', openingCents: 100000, closingCents: 99525, clearedTxIds: ['p1'] }));
    expect(reconciliationHealth(rec.data, rec.data.reconciliations[0]).valid).toBe(true);
    const res = undoImportBatch(rec.data, c.batchId);
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toMatch(/completed reconciliation/);
  });
});
import { reverseTransaction as reverseTransactionOp } from '../../src/domain/ops/transactions.js';

describe('large imports stay responsive (spec 21: a moderately large CSV)', () => {
  const bulkCsv = (n, tag) => {
    const lines = ['Date,Description,Amount,Reference'];
    for (let i = 0; i < n; i += 1) lines.push(`2026-09-${String((i % 28) + 1).padStart(2, '0')},Vendor ${i % 97} purchase,-${((i % 900) + 1) / 100},${tag}-${i}`);
    return lines.join('\n');
  };
  it('imports of 5,000 then 15,000 rows ON TOP of an existing ledger: unique ids, exact totals, near-linear commit, instant undo', () => {
    const d0 = buildDemoDataset();
    const acct = d0.accounts[0].id;
    let d = d0;
    const batches = [];
    for (const [n, tag] of [[5000, 'A'], [15000, 'B']]) {
      const r = run(d, acct, bulkCsv(n, tag));
      expect(r.norm.rows).toHaveLength(n);
      const t0 = performance.now();
      const c = must(commitImport(d, { accountId: acct, fileName: `${tag}.csv`, rows: r.rows }, { now: 't' }));
      const ms = performance.now() - t0;
      expect(c.imported).toBe(n);
      expect(new Set(c.data.transactions.map((t) => t.id)).size).toBe(c.data.transactions.length);
      expect(bal(c.data, acct, '2026-12-31') - bal(d, acct, '2026-12-31')).toBe(r.rows.reduce((s, x) => s + x.amountCents, 0));
      // quadratic implementations (per-id collection scans, a ledger index rebuilt per row) took 4-25 SECONDS here
      expect(ms, `${n} rows`).toBeLessThan(3000);
      batches.push(c.batchId);
      d = c.data;
    }
    const t1 = performance.now();
    const u2 = must(undoImportBatch(d, batches[1]));
    const u1 = must(undoImportBatch(u2.data, batches[0]));
    expect(performance.now() - t1).toBeLessThan(2000);
    expect(u2.removed).toBe(15000);
    expect(u1.data.transactions).toEqual(d0.transactions);
  }, 60000);
});
