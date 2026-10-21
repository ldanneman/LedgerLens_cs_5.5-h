/**
 * Local persistence. Each workspace (my finances, Test Lab sandbox) is stored as one JSON envelope in
 * the browser's localStorage under its own key. Data never leaves the device.
 *
 * Failure policy:
 *  - a write that fails (quota, private mode) is reported, never silently ignored;
 *  - stored data that no longer parses or validates is NEVER overwritten automatically: load() returns
 *    status 'corrupt' with the raw text so the UI can offer download/recovery, and a separate backup
 *    copy is kept under a different key when the user chooses to start over.
 */
import { normalizeDataset } from '../domain/schema.js';
import { validateStructure, summarizeFindings } from '../domain/validate.js';
import { migrateDataset } from './serialize.js';

export const STORAGE_PREFIX = 'ledgerlens:v1:';
export const STATE_FORMAT = 'ledgerlens-state';
export const KEYS = {
  workspace: (id) => `${STORAGE_PREFIX}workspace:${id}`,
  meta: `${STORAGE_PREFIX}meta`,
  prefs: `${STORAGE_PREFIX}prefs`,
  corrupt: (ts) => `${STORAGE_PREFIX}corrupt-backup:${ts}`,
};

/** In-memory backend with the localStorage surface; used when real storage is unavailable and in tests. */
export function createMemoryBackend() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    isMemory: true,
  };
}

/** Pick window.localStorage if it really works, else a memory backend (and say so). */
export function detectBackend() {
  try {
    const ls = typeof window !== 'undefined' ? window.localStorage : null;
    if (!ls) return { backend: createMemoryBackend(), persistent: false, reason: 'Browser storage is not available.' };
    const probe = `${STORAGE_PREFIX}probe`;
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return { backend: ls, persistent: true, reason: '' };
  } catch (e) {
    return { backend: createMemoryBackend(), persistent: false, reason: `Browser storage is blocked (${e instanceof Error ? e.message : 'unknown reason'}). Changes will be lost when you close this tab; use Export to keep a copy.` };
  }
}

/** Storage facade bound to a backend. */
export function createStorage(backend) {
  const read = (key) => {
    try {
      return { ok: true, value: backend.getItem(key) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    backend,
    /** Load and validate a workspace. Returns {status:'ok'|'empty'|'corrupt'|'error', data?, raw?, reason?, findings?, candidate?}. `candidate` is the normalized (but invalid) dataset, used only to offer explicit repairs. */
    loadWorkspace(id) {
      const r = read(KEYS.workspace(id));
      if (!r.ok) return { status: 'error', reason: r.error };
      if (r.value === null) return { status: 'empty' };
      let env;
      try {
        env = JSON.parse(r.value);
      } catch (e) {
        return { status: 'corrupt', raw: r.value, reason: `The saved data is not valid JSON (${e instanceof Error ? e.message : String(e)}).`, findings: [] };
      }
      if (!env || typeof env !== 'object' || env.format !== STATE_FORMAT || !env.data || typeof env.data !== 'object') {
        return { status: 'corrupt', raw: r.value, reason: 'The saved data is not in the expected LedgerLens format.', findings: [] };
      }
      const sv = env.data.schemaVersion === undefined ? 0 : env.data.schemaVersion;
      const mig = migrateDataset(env.data, Number.isInteger(sv) ? sv : -1);
      if (!mig.ok) return { status: 'corrupt', raw: r.value, reason: mig.error || 'The saved data uses an unsupported version.', findings: [] };
      const data = normalizeDataset(mig.raw);
      const findings = validateStructure(data);
      const sum = summarizeFindings(findings);
      if (!sum.ok) return { status: 'corrupt', raw: r.value, reason: `The saved data failed validation (${sum.errors.length} blocking problem${sum.errors.length === 1 ? '' : 's'}): ${sum.errors[0].message}`, findings, candidate: data };
      return { status: 'ok', data, savedAt: env.savedAt || null };
    },
    /** Save a workspace. Returns {ok:true} or {ok:false, error}. */
    saveWorkspace(id, data, now = new Date().toISOString()) {
      try {
        backend.setItem(KEYS.workspace(id), JSON.stringify({ format: STATE_FORMAT, version: 1, savedAt: now, workspace: id, data }));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `Could not save: ${e instanceof Error ? e.message : String(e)}. Export your data to keep a copy.` };
      }
    },
    removeWorkspace(id) {
      try {
        backend.removeItem(KEYS.workspace(id));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    /** Keep a verbatim copy of unreadable data under a separate key before anything replaces it. */
    backupCorrupt(raw, now = new Date().toISOString()) {
      const key = KEYS.corrupt(now.replace(/[^0-9]/g, '').slice(0, 14));
      try {
        backend.setItem(key, raw);
        return { ok: true, key };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    listCorruptBackups() {
      const out = [];
      try {
        for (let i = 0; i < backend.length; i += 1) {
          const k = backend.key(i);
          if (k && k.startsWith(`${STORAGE_PREFIX}corrupt-backup:`)) out.push(k);
        }
      } catch {
        /* ignore */
      }
      return out;
    },
    readRaw(key) {
      return read(key).value ?? null;
    },
    removeKey(key) {
      try {
        backend.removeItem(key);
      } catch {
        /* ignore */
      }
    },
    /** Small JSON values (active workspace, UI preferences). */
    getJson(key, fallback) {
      const r = read(key);
      if (!r.ok || r.value === null) return fallback;
      try {
        return JSON.parse(r.value);
      } catch {
        return fallback;
      }
    },
    setJson(key, value) {
      try {
        backend.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    /** Approximate bytes used by LedgerLens keys. */
    usage() {
      let bytes = 0;
      try {
        for (let i = 0; i < backend.length; i += 1) {
          const k = backend.key(i);
          if (k && k.startsWith(STORAGE_PREFIX)) bytes += k.length + (backend.getItem(k) || '').length;
        }
      } catch {
        /* ignore */
      }
      return bytes * 2;
    },
  };
}
