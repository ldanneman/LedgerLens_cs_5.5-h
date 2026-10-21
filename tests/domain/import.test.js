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

// ------------------------------------------------------------------------------------------------
// R2 / R4 / R5 (review) and X3 / X5 (found while fixing)
// ------------------------------------------------------------------------------------------------
import { DatasetBuilder, usd } from '../../src/seed/builder.js';
import { addTransaction, updateTransaction, deleteTransactions, linkAsTransfer, reverseTransaction } from '../../src/domain/ops/transactions.js';
import { parseImportText, exportDatasetJson } from '../../src/persistence/serialize.js';
import { reconciliationHealth } from '../../src/domain/reconciliation.js';
import { buildDemoDataset } from '../../src/seed/demo.js';

const importSource = (externalId, batchId = null) => ({ type: 'import', batchId, externalId, importedAt: null, rawDescription: null });
/** Checking (opened 2026-09-01, $1,000.00) holding the given pending items. */
function ledgerWith(pendings, { savings = false } = {}) {
  const b = new DatasetBuilder({ name: 'import review', asOfDate: '2026-09-30' });
  b.category('cat-coffee', 'Coffee', 'expense');
  b.category('cat-groceries', 'Groceries', 'expense');
  b.category('cat-household', 'Household', 'expense');
  b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-09-01' });
  if (savings) b.account('sav', { name: 'Savings', type: 'savings', opening: 0, openingDate: '2026-09-01' });
  for (const p of pendings) b.tx({ id: p.id, account: 'chk', date: p.date, desc: p.desc, merchant: p.desc, amount: p.cents, kind: 'expense', status: 'pending', category: p.splits ? undefined : p.category, splits: p.splits, source: p.ext === undefined ? undefined : importSource(p.ext) });
  return b.build();
}
const coffee = (id, ext, date = '2026-09-15') => ({ id, date, desc: 'Review Coffee', cents: -475, ext });
const one = (date, desc, amount, ref) => (ref === undefined ? `Date,Description,Amount\n${date},${desc},${amount}\n` : `Date,Description,Amount,Reference\n${date},${desc},${amount},${ref}\n`);
const types = (r) => r.rows.map((x) => x.match.type);
const commit = (d, r, extra = {}) => commitImport(d, { accountId: 'chk', fileName: 'f.csv', rows: r.rows, ...extra }, { now: '2026-10-01T00:00:00.000Z' });

describe('R2: distinct references are never merged', () => {
  it('pending P1 + posted P2 (the review reproduction) stay two purchases through commit, reimport and undo', () => {
    const d0 = ledgerWith([coffee('p1', 'P1')]);
    const r = run(d0, 'chk', one('2026-09-16', 'Review Coffee', '-4.75', 'P2'));
    expect(r.rows[0].match).toMatchObject({ type: 'new', action: 'import' });
    const c = must(commit(d0, r));
    expect([c.imported, c.settled]).toEqual([1, 0]);
    expect(c.data.transactions.map((t) => [t.status, t.amountCents, t.source.externalId])).toEqual([['pending', -475, 'P1'], ['posted', -475, 'P2']]);
    const again = run(c.data, 'chk', one('2026-09-16', 'Review Coffee', '-4.75', 'P2'));
    expect(types(again)).toEqual(['duplicate']);
    expect(commit(c.data, again).ok).toBe(false);
    const u = must(undoImportBatch(c.data, c.batchId));
    expect(u.data.transactions).toEqual(d0.transactions);
  });
  it('the same reference settles its pending item exactly once', () => {
    const d0 = ledgerWith([coffee('p1', 'P1')]);
    const r = run(d0, 'chk', one('2026-09-16', 'Review Coffee', '-4.75', 'P1'));
    expect(r.rows[0].match).toMatchObject({ type: 'settles_pending', basis: 'reference', existingTxId: 'p1' });
    const c = must(commit(d0, r));
    expect(c.data.transactions).toHaveLength(1);
    expect(c.data.transactions[0]).toMatchObject({ id: 'p1', status: 'posted', date: '2026-09-16', source: { externalId: 'P1', batchId: c.batchId } });
    expect(types(run(c.data, 'chk', one('2026-09-16', 'Review Coffee', '-4.75', 'P1')))).toEqual(['duplicate']);
  });
  it('a reference missing on one side may still settle (similarity), keeping whichever reference exists', () => {
    const a = ledgerWith([coffee('p1', undefined)]);
    const ra = run(a, 'chk', one('2026-09-16', 'Review Coffee', '-4.75', 'P2'));
    expect(ra.rows[0].match).toMatchObject({ type: 'settles_pending', basis: 'heuristic' });
    expect(must(commit(a, ra)).data.transactions[0].source.externalId).toBe('P2');
    const b = ledgerWith([coffee('p1', 'P1')]);
    const rb = run(b, 'chk', one('2026-09-16', 'Review Coffee', '-4.75'));
    expect(types(rb)).toEqual(['settles_pending']);
    expect(must(commit(b, rb)).data.transactions[0].source.externalId).toBe('P1');
  });
  it('with no references at all the similarity match is labelled for review, and Import as new keeps the pending item', () => {
    const d0 = ledgerWith([coffee('p1', undefined)]);
    const r = run(d0, 'chk', one('2026-09-16', 'Review Coffee', '-4.75'));
    expect(r.rows[0].match).toMatchObject({ type: 'settles_pending', basis: 'heuristic', ambiguous: false, alternatives: [] });
    expect(r.rows[0].match.reason).toMatch(/not by a shared reference/);
    expect(summarizePlan(r.rows).attention).toBe(1);
    const c = must(commitImport(d0, { accountId: 'chk', fileName: 'x', rows: r.rows.map((x) => ({ ...x, decision: 'import' })) }));
    expect(c.data.transactions.map((t) => [t.id === 'p1', t.status])).toEqual([[true, 'pending'], [false, 'posted']]);
  });
  it('the same-date fingerprint path also respects a conflicting reference', () => {
    expect(types(run(ledgerWith([coffee('p1', 'P1')]), 'chk', one('2026-09-15', 'Review Coffee', '-4.75', 'P2')))).toEqual(['new']);
  });
  it('in-file duplicates: two different references are two purchases; a repeated reference is skipped', () => {
    const d0 = ledgerWith([coffee('p1', 'P1')]);
    const two = run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P2\n2026-09-16,Review Coffee,-4.75,P3\n');
    expect(types(two)).toEqual(['new', 'new']);
    expect(must(commit(d0, two)).data.transactions.map((t) => t.source.externalId)).toEqual(['P1', 'P2', 'P3']);
    expect(types(run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P2\n2026-09-16,Review Coffee,-4.75,P2\n'))).toEqual(['new', 'in_file_duplicate']);
  });
  it('two competing pending items: references decide; an unknown reference settles neither', () => {
    const d0 = ledgerWith([coffee('p1', 'P1'), coffee('p2', 'P2')]);
    const r = run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P2\n2026-09-16,Review Coffee,-4.75,P1\n');
    expect(r.rows.map((x) => x.match.existingTxId)).toEqual(['p2', 'p1']);
    const stranger = run(d0, 'chk', one('2026-09-16', 'Review Coffee', '-4.75', 'P3'));
    expect(types(stranger)).toEqual(['new']);
    expect(must(commit(d0, stranger)).data.transactions.filter((t) => t.status === 'pending')).toHaveLength(2);
  });
  it('two competing pending items without references: deterministic best match, flagged ambiguous, user may pick the other', () => {
    const d0 = ledgerWith([coffee('p1', undefined, '2026-09-14'), coffee('p2', undefined, '2026-09-15')]);
    const r = run(d0, 'chk', one('2026-09-15', 'Review Coffee', '-4.75'));
    expect(r.rows[0].match).toMatchObject({ existingTxId: 'p2', ambiguous: true, alternatives: ['p1'] });
    expect(summarizePlan(r.rows).attention).toBe(1);
    const picked = must(commitImport(d0, { accountId: 'chk', fileName: 'x', rows: r.rows.map((x) => ({ ...x, settleTxId: 'p1' })) }));
    expect(statusById(picked.data)).toEqual({ p1: 'posted', p2: 'pending' });
    const twoRows = run(d0, 'chk', 'Date,Description,Amount\n2026-09-15,Review Coffee,-4.75\n2026-09-15,Review Coffee,-4.75\n2026-09-15,Review Coffee,-4.75\n');
    expect(twoRows.rows.map((x) => x.match.existingTxId ?? null)).toEqual(['p2', 'p1', null]);
    expect(types(twoRows)).toEqual(['settles_pending', 'settles_pending', 'new']);
  });
  it('commitImport re-checks identity, so a forged or stale plan cannot overwrite a different purchase', () => {
    // p9 is an already-POSTED record that carries reference DUP
    const d0 = must(updateTransaction(ledgerWith([coffee('p1', 'P1'), coffee('p3', undefined), { id: 'p9', date: '2026-09-01', desc: 'Other', cents: -100, ext: 'DUP' }]), 'p9', { status: 'posted' })).data;
    const r = run(d0, 'chk', one('2026-09-16', 'Review Coffee', '-4.75', 'P2'));
    const forged = (x) => ({ ...x, match: { ...x.match, type: 'settles_pending', existingTxId: 'p1', action: 'settle' } });
    const res = commitImport(d0, { accountId: 'chk', fileName: 'x', rows: r.rows.map(forged) });
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toMatch(/reference P2 differs from reference P1.*different purchases/);
    expect(commitImport(d0, { accountId: 'chk', fileName: 'x', rows: r.rows.map((x) => ({ ...x, decision: 'settle', settleTxId: 'p1' })) }).ok).toBe(false);
    const dupRef = run(d0, 'chk', one('2026-09-16', 'Review Coffee', '-4.75', 'DUP'));
    expect(types(dupRef)).toEqual(['duplicate']);
    // settling the reference-less p3 with DUP would give DUP to a second record
    const res2 = commitImport(d0, { accountId: 'chk', fileName: 'x', rows: dupRef.rows.map((x) => ({ ...x, match: { ...x.match, type: 'settles_pending', existingTxId: 'p3', action: 'settle' } })) });
    expect(res2.errors[0].message).toMatch(/already belongs to another transaction/);
    expect(d0.transactions.find((t) => t.id === 'p1').source.externalId).toBe('P1');
  });
});
const statusById = (d) => Object.fromEntries(d.transactions.map((t) => [t.id, t.status]));

describe('X3: an import never posts one side of a transfer', () => {
  function linkedPendingPayment() {
    const b = new DatasetBuilder({ name: 'x3', asOfDate: '2026-01-31' });
    b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-01-01' });
    b.account('card', { name: 'Card', type: 'credit_card', opening: 0, openingDate: '2026-01-01' });
    b.tx({ id: 'o', account: 'chk', date: '2026-01-10', desc: 'Card payment', amount: -5000, kind: 'expense', status: 'pending', source: importSource('PAY-1') });
    b.tx({ id: 'i', account: 'card', date: '2026-01-10', desc: 'Payment thank you', amount: 5000, kind: 'income', status: 'pending' });
    return must(linkAsTransfer(b.build(), 'o', 'i')).data;
  }
  it('a posted row with the reference of a pending transfer leg is "already imported", with a pointer to post the transfer', () => {
    const d = linkedPendingPayment();
    const r = run(d, 'chk', one('2026-01-11', 'Card payment', '-50.00', 'PAY-1'));
    expect(r.rows[0].match).toMatchObject({ type: 'duplicate', action: 'skip', existingTxId: 'o' });
    expect(r.rows[0].match.reason).toMatch(/one side of a transfer.*mark the transfer posted/);
  });
  it('a forged plan that tries to settle the leg is refused and both legs stay pending', () => {
    const d = linkedPendingPayment();
    const r = run(d, 'chk', one('2026-01-11', 'Card payment', '-50.00', 'PAY-1'));
    const res = commitImport(d, { accountId: 'chk', fileName: 'x', rows: r.rows.map((x) => ({ ...x, decision: 'settle' })) });
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toMatch(/one side of a transfer/);
    expect(d.transactions.map((t) => t.status)).toEqual(['pending', 'pending']);
  });
});

describe('R5: settling a changed amount keeps the splits exact', () => {
  const withSplits = (cents, parts, ext) => ledgerWith([{ id: 'sp', date: '2026-09-15', desc: 'Fresh Fields', cents, ext, splits: parts }]);
  const csv = (amount, ref) => one('2026-09-16', 'Fresh Fields', amount, ref);
  const splitCents = (d) => d.transactions.find((t) => t.id === 'sp').splits.map((x) => x.amountCents);
  it('-$6.00/-$4.00 settled at -$11.00 becomes -$6.60/-$4.40 (shown in the preview), and undo restores the original exactly', () => {
    const d0 = withSplits(-1000, [['cat-groceries', -600], ['cat-household', -400]]);
    const r = run(d0, 'chk', csv('-11.00'));
    expect(r.rows[0].match.splitPlan).toEqual({ policy: 'proportional', before: [{ categoryId: 'cat-groceries', amountCents: -600 }, { categoryId: 'cat-household', amountCents: -400 }], after: [{ categoryId: 'cat-groceries', amountCents: -660 }, { categoryId: 'cat-household', amountCents: -440 }], dropped: [] });
    expect(r.rows[0].match.reason).toMatch(/rescaled in proportion/);
    const c = must(commit(d0, r));
    expect(c.data.transactions[0]).toMatchObject({ status: 'posted', amountCents: -1100 });
    expect(splitCents(c.data)).toEqual([-660, -440]);
    expect(bal(c.data, 'chk')).toBe(100000 - 1100);
    expect(must(undoImportBatch(c.data, c.batchId)).data.transactions).toEqual(d0.transactions);
  });
  it('a one-cent remainder goes to the largest remainder, deterministically, and no cent is lost', () => {
    const d0 = withSplits(-1000, [['cat-groceries', -333], ['cat-household', -333], ['cat-coffee', -334]]);
    const r = run(d0, 'chk', csv('-10.01'));
    expect(r.rows[0].match.splitPlan.after.map((x) => x.amountCents)).toEqual([-333, -333, -335]);
    expect(splitCents(must(commit(d0, r)).data)).toEqual([-333, -333, -335]);
  });
  it('a split whose share rounds to $0.00 is dropped and reported, the rest still sums exactly', () => {
    // -$999.99/-$0.01 re-allocated to -$5.00: shares 499.995 and 0.005 cents -> 500 and 0; the zero piece is dropped
    const d0 = withSplits(-100000, [['cat-groceries', -99999], ['cat-household', -1]], 'S9');
    const r = run(d0, 'chk', csv('-5.00', 'S9'));
    expect(r.rows[0].match.splitPlan).toMatchObject({ after: [{ categoryId: 'cat-groceries', amountCents: -500 }], dropped: [{ categoryId: 'cat-household', amountCents: 0 }] });
    expect(splitCents(must(commit(d0, r)).data)).toEqual([-500]);
  });
  it('an unchanged amount keeps the user splits; a single category just takes the new amount', () => {
    const d0 = withSplits(-1000, [['cat-groceries', -600], ['cat-household', -400]]);
    const r = run(d0, 'chk', csv('-10.00'));
    expect(r.rows[0].match.splitPlan).toBeUndefined();
    expect(splitCents(must(commit(d0, r)).data)).toEqual([-600, -400]);
    const single = ledgerWith([{ id: 'sp', date: '2026-09-15', desc: 'Fresh Fields', cents: -1000, category: 'cat-groceries' }]);
    expect(must(commit(single, run(single, 'chk', csv('-11.00')))).data.transactions[0]).toMatchObject({ amountCents: -1100, categoryId: 'cat-groceries', splits: [] });
  });
  it('an explicit allocation is honoured when exact, refused (naming both totals) when not', () => {
    const d0 = withSplits(-1000, [['cat-groceries', -600], ['cat-household', -400]]);
    const r = run(d0, 'chk', csv('-11.00'));
    const withAlloc = (parts) => commitImport(d0, { accountId: 'chk', fileName: 'x', rows: r.rows.map((x) => ({ ...x, splits: parts })) });
    expect(splitCents(must(withAlloc([{ categoryId: 'cat-groceries', amountCents: -1000 }, { categoryId: 'cat-household', amountCents: -100 }])).data)).toEqual([-1000, -100]);
    const bad = withAlloc([{ categoryId: 'cat-groceries', amountCents: -1000 }, { categoryId: 'cat-household', amountCents: -99 }]);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toMatch(/-\$10\.99 but the posted amount is -\$11\.00/);
  });
  it('choosing Import as new or Skip cancels the adjustment and leaves the pending item untouched', () => {
    const d0 = withSplits(-1000, [['cat-groceries', -600], ['cat-household', -400]]);
    const r = run(d0, 'chk', csv('-11.00'));
    expect(commitImport(d0, { accountId: 'chk', fileName: 'x', rows: r.rows.map((x) => ({ ...x, decision: 'skip' })) }).ok).toBe(false);
    const asNew = must(commitImport(d0, { accountId: 'chk', fileName: 'x', rows: r.rows.map((x) => ({ ...x, decision: 'import' })) }));
    expect(asNew.data.transactions[0]).toEqual(d0.transactions[0]);
    expect(asNew.data.transactions).toHaveLength(2);
  });
  it('a same-reference row of opposite sign (the pending purchase became a refund) keeps valid, same-signed splits', () => {
    const d0 = withSplits(-1000, [['cat-groceries', -600], ['cat-household', -400]], 'S1');
    const c = must(commit(d0, run(d0, 'chk', csv('11.00', 'S1'))));
    expect(c.data.transactions[0].amountCents).toBe(1100);
    expect(splitCents(c.data)).toEqual([660, 440]);
    expect(validateStructure(c.data).filter((f) => f.blocking)).toEqual([]);
  });
});

describe('R4: import-batch ownership is validated at the boundary and re-checked at undo', () => {
  function withForgedBatch(edit = (b) => b) {
    const d = JSON.parse(JSON.stringify(must(addTransaction(ledgerWith([]), { accountId: 'chk', date: '2026-09-10', description: 'Manual rent', amountCents: -50000, kind: 'expense', categoryId: 'cat-household' })).data));
    const manualId = d.transactions[0].id;
    d.importBatches.push(edit({ id: 'batch-1', accountId: 'chk', fileName: 'x.csv', importedAt: null, status: 'committed', createdTxIds: [manualId], settled: [], rowCount: 1, skippedCount: 0, rejectedCount: 0, undoneAt: null }));
    return { d, manualId };
  }
  it('the review reproduction is rejected by the JSON boundary with the batch and record named', () => {
    const res = parseImportText(exportDatasetJson(withForgedBatch().d));
    expect(res.ok).toBe(false);
    const f = res.findings.find((x) => x.code === 'batch-ownership');
    expect(f.blocking).toBe(true);
    expect(f.message).toMatch(/batch-1.*Manual rent.*manual record.*would delete an unrelated record/);
  });
  it('undo of such a batch already in memory is refused before anything changes', () => {
    const { d, manualId } = withForgedBatch();
    const res = undoImportBatch(d, 'batch-1');
    expect(res.ok).toBe(false);
    expect(res.errors[0].message).toMatch(/was not created by this import/);
    expect(d.transactions.map((t) => t.id)).toEqual([manualId]);
    expect(d.importBatches[0].status).toBe('committed');
  });
  it('rejects a record claimed by the wrong batch or by two batches, and malformed id lists', () => {
    const { d, manualId } = withForgedBatch();
    d.transactions[0].source = importSource('X', 'batch-2');
    d.importBatches.push({ id: 'batch-2', accountId: 'chk', fileName: '', importedAt: null, status: 'committed', createdTxIds: [manualId], settled: [], rowCount: 1, skippedCount: 0, rejectedCount: 0, undoneAt: null });
    const msgs = parseImportText(exportDatasetJson(d)).findings.filter((x) => x.code === 'batch-ownership').map((x) => x.message).join(' | ');
    expect(msgs).toMatch(/batch-1.*owned by import batch "batch-2"/);
    expect(msgs).toMatch(/listed as created by two import batches/);
    for (const ids of [(id) => [id, id], () => [42], () => [''], () => 'tx-1', () => null]) {
      const { d: e, manualId: m } = withForgedBatch();
      e.transactions[0].source = importSource('Q', 'batch-1');
      e.importBatches[0].createdTxIds = ids(m);
      expect(parseImportText(exportDatasetJson(e)).ok, JSON.stringify(ids(m))).toBe(false);
    }
  });
  it('rejects malformed settlement-restoration data (settled[] and its `before` records)', () => {
    const d0 = ledgerWith([coffee('p1', 'P1')], { savings: true });
    const c = must(commit(d0, run(d0, 'chk', one('2026-09-16', 'Review Coffee', '-4.75', 'P1'))));
    const before = JSON.parse(JSON.stringify(d0.transactions[0]));
    const cases = {
      'settled is not a list': 42,
      'entry not an object': ['oops'],
      'missing txId': [{ before }],
      'before is a number': [{ txId: 'p1', before: 5 }],
      'before has another id': [{ txId: 'p1', before: { ...before, id: 'other' } }],
      'before in another account': [{ txId: 'p1', before: { ...before, accountId: 'sav' } }],
      'before has fractional cents': [{ txId: 'p1', before: { ...before, amountCents: -4.5 } }],
      'before was not pending': [{ txId: 'p1', before: { ...before, status: 'posted' } }],
      'listed twice': [{ txId: 'p1', before }, { txId: 'p1', before }],
    };
    for (const [label, settled] of Object.entries(cases)) {
      const e = JSON.parse(JSON.stringify(c.data));
      e.importBatches[0].settled = settled;
      expect(parseImportText(exportDatasetJson(e)).ok, label).toBe(false);
    }
  });
  it('a genuine batch validates, survives an export/import round trip, and undoes to the exact original', () => {
    const d0 = ledgerWith([coffee('p1', 'P1')]);
    const c = must(commit(d0, run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P1\n2026-09-17,Hardware,-20.00,H1\n')));
    const rt = parseImportText(exportDatasetJson(c.data));
    expect(rt.ok).toBe(true);
    expect(must(undoImportBatch(rt.dataset, c.batchId)).data.transactions).toEqual(d0.transactions);
  });
  it('a pending row imported by one batch and settled by a later one is valid history; undo order is enforced', () => {
    const d0 = ledgerWith([]);
    const first = must(commit(d0, run(d0, 'chk', 'Date,Description,Amount,Reference,Status\n2026-09-14,Fresh Fields,-10.00,F1,pending\n'), {}));
    const later = must(commit(first.data, run(first.data, 'chk', one('2026-09-16', 'Fresh Fields', '-10.00', 'F1'))));
    expect(later.settled).toBe(1);
    expect(parseImportText(exportDatasetJson(later.data)).ok).toBe(true);
    const early = undoImportBatch(later.data, first.batchId);
    expect(early.ok).toBe(false);
    expect(early.errors[0].message).toMatch(/settled later by import .* Undo that import first/);
    const u2 = must(undoImportBatch(later.data, later.batchId));
    const u1 = must(undoImportBatch(u2.data, first.batchId));
    expect(u1.data.transactions).toEqual([]);
  });
  it('later edits do not block undo; rows the user already deleted are skipped and deleted settled items reported', () => {
    const d0 = ledgerWith([coffee('p1', 'P1')]);
    const c = must(commit(d0, run(d0, 'chk', 'Date,Description,Amount,Reference\n2026-09-16,Review Coffee,-4.75,P1\n2026-09-17,Hardware,-20.00,H1\n2026-09-18,Paint,-30.00,H2\n')));
    const [hardware, paint] = c.data.importBatches[0].createdTxIds;
    let d = must(updateTransaction(c.data, hardware, { categoryId: 'cat-household', notes: 'edited later' })).data;
    d = must(deleteTransactions(d, [paint, 'p1'])).data;
    const u = must(undoImportBatch(d, c.batchId));
    expect([u.removed, u.restored]).toEqual([1, 0]);
    expect(u.warnings.join(' ')).toMatch(/1 settled pending item no longer exists/);
    expect(u.data.transactions).toEqual([]);
    expect(undoImportBatch(u.data, c.batchId).ok).toBe(false);
  });
  it('refuses (changing nothing) when a created row became half of a transfer, was reversed, or a settled row is reconciled', () => {
    const base = ledgerWith([], { savings: true });
    const c = must(commit(base, run(base, 'chk', one('2026-09-16', 'Move to savings', '-100.00', 'T1'))));
    let linked = must(addTransaction(c.data, { accountId: 'sav', date: '2026-09-16', description: 'From checking', amountCents: 10000, kind: 'income' })).data;
    linked = must(linkAsTransfer(linked, linked.transactions[0].id, linked.transactions[1].id)).data;
    const t = undoImportBatch(linked, c.batchId);
    expect(t.ok).toBe(false);
    expect(t.errors[0].message).toMatch(/one side of a transfer/);
    const reversed = must(reverseTransaction(c.data, c.data.transactions[0].id)).data;
    expect(undoImportBatch(reversed, c.batchId).errors[0].message).toMatch(/was reversed by/);
    const d0 = ledgerWith([coffee('p1', 'P1')]);
    const s = must(commit(d0, run(d0, 'chk', one('2026-09-16', 'Review Coffee', '-4.75', 'P1'))));
    const rec = must(completeReconciliation(s.data, { accountId: 'chk', startDate: '2026-09-01', endDate: '2026-09-30', openingCents: 100000, closingCents: 99525, clearedTxIds: ['p1'] }));
    expect(reconciliationHealth(rec.data, rec.data.reconciliations[0]).valid).toBe(true);
    expect(undoImportBatch(rec.data, s.batchId).errors[0].message).toMatch(/completed reconciliation/);
  });
});

describe('X5: large imports stay responsive (spec 21)', () => {
  const bulk = (n, tag) => ['Date,Description,Amount,Reference', ...Array.from({ length: n }, (_, i) => `2026-09-${String((i % 28) + 1).padStart(2, '0')},Vendor ${i % 97} purchase,-${((i % 900) + 1) / 100},${tag}-${i}`)].join('\n');
  it('5,000 then 15,000 rows on top of the demo ledger: unique ids, exact totals, fast commit and undo', () => {
    const d0 = buildDemoDataset();
    const acct = d0.accounts[0].id;
    let d = d0;
    const batches = [];
    for (const [n, tag] of [[5000, 'A'], [15000, 'B']]) {
      const r = run(d, acct, bulk(n, tag));
      const t0 = performance.now();
      const c = must(commitImport(d, { accountId: acct, fileName: `${tag}.csv`, rows: r.rows }));
      const ms = performance.now() - t0;
      expect(c.imported).toBe(n);
      expect(new Set(c.data.transactions.map((t) => t.id)).size).toBe(c.data.transactions.length);
      expect(bal(c.data, acct, '2026-12-31') - bal(d, acct, '2026-12-31')).toBe(r.rows.reduce((s, x) => s + x.amountCents, 0));
      // quadratic code (an id scan per row; the ledger index rebuilt per row) needed 4-25 SECONDS here
      expect(ms, `${n} rows`).toBeLessThan(3000);
      batches.push(c.batchId);
      d = c.data;
    }
    const t1 = performance.now();
    const u = must(undoImportBatch(must(undoImportBatch(d, batches[1])).data, batches[0]));
    expect(performance.now() - t1).toBeLessThan(2000);
    expect(u.data.transactions).toEqual(d0.transactions);
  }, 60000);
});

describe('legacy history: a batch written by the old X3 path (it settled one transfer leg) stays loadable', () => {
  it('after the explicit status repair the dataset validates, and undoing that batch is refused without changes', async () => {
    const { applyTransferStatusRepairs } = await import('../../src/domain/repairs.js');
    const b = new DatasetBuilder({ name: 'legacy x3', asOfDate: '2026-01-31' });
    b.account('chk', { name: 'Checking', type: 'checking', opening: usd('1000.00'), openingDate: '2026-01-01' });
    b.account('card', { name: 'Card', type: 'credit_card', opening: 0, openingDate: '2026-01-01' });
    b.transfer({ id: 'x1', legIds: ['o', 'i'], from: 'chk', to: 'card', amount: 5000, date: '2026-01-10', status: 'pending' });
    const d = JSON.parse(JSON.stringify(b.build()));
    // what the original commitImport produced for a reference hit on the pending leg "o"
    const before = JSON.parse(JSON.stringify(d.transactions[0]));
    Object.assign(d.transactions[0], { status: 'posted', date: '2026-01-11', source: importSource('PAY-1', 'batch-old') });
    d.importBatches.push({ id: 'batch-old', accountId: 'chk', fileName: 'old.csv', importedAt: null, status: 'committed', createdTxIds: [], settled: [{ txId: 'o', before }], rowCount: 1, skippedCount: 0, rejectedCount: 0, undoneAt: null });
    const raw = parseImportText(exportDatasetJson(d));
    expect(raw.ok).toBe(false);
    expect(raw.findings.filter((f) => f.blocking).map((f) => f.code)).toEqual(['transfer-status-mismatch']);
    const repaired = applyTransferStatusRepairs(raw.candidate, { x1: 'posted' }).data;
    expect(validateStructure(repaired).filter((f) => f.blocking)).toEqual([]);
    const u = undoImportBatch(repaired, 'batch-old');
    expect(u.ok).toBe(false);
    expect(u.errors[0].message).toMatch(/one side of a transfer/);
  });
});
