/**
 * Versioned JSON export/import.
 *
 * Export file:
 *   { "format": "ledgerlens-export", "formatVersion": 1, "app": "LedgerLens", "exportedAt": ISO, "dataset": {...} }
 * The dataset carries its own schemaVersion. Import never touches stored data: it parses, migrates,
 * normalizes and validates into a PREVIEW; the caller applies it only after the user confirms.
 */
import { SCHEMA_VERSION, normalizeDataset, isObj, COLLECTIONS, COLLECTION_LABELS } from '../domain/schema.js';
import { validateStructure, summarizeFindings } from '../domain/validate.js';
import { buildIndex, netWorthAt } from '../domain/ledger.js';

export const EXPORT_FORMAT = 'ledgerlens-export';
export const EXPORT_VERSION = 1;
export const MAX_IMPORT_CHARS = 40 * 1024 * 1024;

/**
 * Migrations upgrade a raw dataset one version at a time. Key = version being upgraded FROM.
 * v0 (unversioned/early exports): no schemaVersion, optional collections may be missing.
 */
const MIGRATIONS = {
  0: (raw) => ({ ...raw, schemaVersion: 1 }),
};

/** Serialize a dataset to export JSON text (pretty-printed, human-inspectable). */
export function exportDatasetJson(data, now = new Date().toISOString()) {
  return JSON.stringify({ format: EXPORT_FORMAT, formatVersion: EXPORT_VERSION, app: 'LedgerLens', exportedAt: now, dataset: data }, null, 2);
}

/** Suggested file name for an export. */
export function exportFileName(data) {
  const slug = String(data.meta?.name || 'ledgerlens').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ledgerlens';
  return `ledgerlens-${slug}-${data.settings?.asOfDate || 'data'}.json`;
}

/** Run migrations from `from` up to the current schema version. */
export function migrateDataset(raw, from) {
  let cur = raw;
  const notes = [];
  for (let v = from; v < SCHEMA_VERSION; v += 1) {
    const fn = MIGRATIONS[v];
    if (!fn) return { ok: false, error: `No migration path from schema version ${v}.`, notes };
    cur = fn(cur);
    notes.push(`Upgraded from schema version ${v} to ${v + 1}.`);
  }
  return { ok: true, raw: cur, notes };
}

/** Counts per collection plus headline numbers - shown in the import preview. */
export function summarizeDataset(data) {
  const counts = {};
  for (const c of COLLECTIONS) counts[c] = Array.isArray(data?.[c]) ? data[c].length : 0;
  let range = null;
  if (Array.isArray(data?.transactions) && data.transactions.length) {
    const dates = data.transactions.map((t) => t.date).filter((d) => typeof d === 'string').sort();
    range = { from: dates[0], to: dates[dates.length - 1] };
  }
  let netWorthCents = null;
  try {
    if (!validateStructure(data).some((f) => f.blocking)) netWorthCents = netWorthAt(buildIndex(data), data.settings.asOfDate, false).netWorth;
  } catch {
    netWorthCents = null;
  }
  return { counts, range, netWorthCents, name: data?.meta?.name || '', asOfDate: data?.settings?.asOfDate || '' };
}

/**
 * Parse export text into a validated preview.
 * @returns {{ok:boolean, dataset?:object, error?:string, findings:Array, notes:string[], summary?:object, versionInfo:object}}
 */
export function parseImportText(text) {
  const notes = [];
  const versionInfo = { formatVersion: null, schemaVersion: null };
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'The file is empty.', findings: [], notes, versionInfo };
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, error: `The file is too large (limit ${MAX_IMPORT_CHARS / 1024 / 1024} MB).`, findings: [], notes, versionInfo };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `This is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, findings: [], notes, versionInfo };
  }
  if (!isObj(parsed)) return { ok: false, error: 'The JSON must be an object (a LedgerLens export file).', findings: [], notes, versionInfo };
  let rawDataset;
  if (parsed.format === EXPORT_FORMAT) {
    versionInfo.formatVersion = parsed.formatVersion;
    if (!Number.isInteger(parsed.formatVersion) || parsed.formatVersion < 1) return { ok: false, error: 'The export file has no valid formatVersion.', findings: [], notes, versionInfo };
    if (parsed.formatVersion > EXPORT_VERSION) return { ok: false, error: `This file was written by a newer LedgerLens (format version ${parsed.formatVersion}); this app understands up to ${EXPORT_VERSION}. Update LedgerLens to open it.`, findings: [], notes, versionInfo };
    if (!isObj(parsed.dataset)) return { ok: false, error: 'The export file has no dataset object.', findings: [], notes, versionInfo };
    rawDataset = parsed.dataset;
  } else if (Array.isArray(parsed.accounts) && Array.isArray(parsed.transactions)) {
    rawDataset = parsed;
    notes.push('This looks like a bare dataset without the export wrapper; it was read as an early (version 0) file.');
  } else {
    return { ok: false, error: 'This does not look like a LedgerLens export (missing "format": "ledgerlens-export").', findings: [], notes, versionInfo };
  }
  const sv = rawDataset.schemaVersion === undefined ? 0 : rawDataset.schemaVersion;
  versionInfo.schemaVersion = sv;
  if (!Number.isInteger(sv) || sv < 0) return { ok: false, error: `The dataset's schemaVersion (${String(sv)}) is not valid.`, findings: [], notes, versionInfo };
  if (sv > SCHEMA_VERSION) return { ok: false, error: `The dataset uses schema version ${sv}, newer than this app supports (${SCHEMA_VERSION}).`, findings: [], notes, versionInfo };
  const mig = migrateDataset(rawDataset, sv);
  if (!mig.ok) return { ok: false, error: mig.error, findings: [], notes, versionInfo };
  notes.push(...mig.notes);
  return previewDataset(normalizeDataset(mig.raw), notes, versionInfo);
}

/**
 * Validate a normalized dataset into an import preview. On failure `dataset` is undefined (nothing can be
 * applied) but `candidate` carries the normalized data so the UI can offer explicit repairs (see repairs.js).
 */
export function previewDataset(dataset, notes = [], versionInfo = { formatVersion: null, schemaVersion: null }) {
  const findings = validateStructure(dataset);
  const sum = summarizeFindings(findings);
  if (!sum.ok) {
    return { ok: false, error: `The dataset has ${sum.errors.length} blocking problem${sum.errors.length === 1 ? '' : 's'}; nothing was changed.`, dataset: undefined, candidate: dataset, findings, notes, versionInfo, summary: summarizeDataset(dataset) };
  }
  return { ok: true, dataset, findings, notes, versionInfo, summary: summarizeDataset(dataset) };
}

/** Compare two datasets collection by collection (for import preview "what would change"). */
export function diffCounts(current, incoming) {
  return COLLECTIONS.map((c) => ({ collection: c, label: COLLECTION_LABELS[c], current: current[c]?.length ?? 0, incoming: incoming[c]?.length ?? 0 }));
}
