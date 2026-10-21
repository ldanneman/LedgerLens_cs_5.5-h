/**
 * Application store (framework-agnostic; React binds to it with useSyncExternalStore).
 *
 * State shape:
 *   status       'ready' | 'recovery'      (recovery = saved main data is unreadable; nothing is overwritten)
 *   active       'main' | 'lab'            which workspace the pages display
 *   workspaces   { main: dataset, lab: dataset|null }
 *   history      undo stack of { workspace, before, label }
 *
 * Mutations go through apply(op): the op returns a Result; only a successful, validated result replaces
 * the dataset, and it is persisted synchronously. A failed op leaves state and storage untouched.
 *
 * Two workspaces keep real work safe: "main" is My finances (persisted separately); "lab" is the Test
 * Lab sandbox that presets load into. Switching never destroys either.
 */
import { buildDemoDataset } from '../seed/demo.js';
import { getPreset } from '../seed/presets.js';
import { KEYS } from '../persistence/storage.js';

const HISTORY_LIMIT = 25;

/** @param {{storage: ReturnType<typeof createStorage>, now?: () => string, persistent?: boolean, persistWarning?: string}} opts */
export function createStore({ storage, now = () => new Date().toISOString(), persistent = true, persistWarning = '' }) {
  let listeners = new Set();
  let state;

  const emit = () => {
    for (const l of listeners) l();
  };
  const set = (next) => {
    state = next;
    emit();
  };

  function persist(ws, data) {
    const r = storage.saveWorkspace(ws, data, now());
    if (!r.ok) {
      set({ ...state, saveError: r.error });
      return r;
    }
    if (state.saveError) set({ ...state, saveError: null });
    return r;
  }

  // ---- boot
  const boot = () => {
    const meta = storage.getJson(KEYS.meta, {});
    const prefs = storage.getJson(KEYS.prefs, { theme: 'system' });
    const base = { status: 'ready', recovery: null, active: 'main', workspaces: { main: null, lab: null }, history: [], saveError: null, persistent, persistWarning, prefs, notices: [] };
    const main = storage.loadWorkspace('main');
    let workspaces = { main: null, lab: null };
    let status = 'ready';
    let recovery = null;
    const notices = [];
    if (main.status === 'ok') workspaces.main = main.data;
    else if (main.status === 'empty') {
      workspaces.main = buildDemoDataset();
      storage.saveWorkspace('main', workspaces.main, now());
    } else if (main.status === 'corrupt') {
      status = 'recovery';
      recovery = { workspace: 'main', raw: main.raw, reason: main.reason, findings: main.findings, candidate: main.candidate || null };
      workspaces.main = null;
    } else {
      // storage unreadable: continue in memory with demo data and tell the user
      workspaces.main = buildDemoDataset();
      notices.push(`Saved data could not be read (${main.reason}). Running with demo data in memory only.`);
    }
    const lab = storage.loadWorkspace('lab');
    if (lab.status === 'ok') workspaces.lab = lab.data;
    else if (lab.status === 'corrupt') {
      storage.backupCorrupt(lab.raw, now());
      storage.removeWorkspace('lab');
      notices.push('The Test Lab sandbox data was unreadable and was moved to a backup key; the sandbox was reset.');
    }
    const active = meta.active === 'lab' && workspaces.lab ? 'lab' : 'main';
    state = { ...base, status, recovery, workspaces, active: status === 'recovery' ? 'main' : active, notices };
  };
  boot();

  const store = {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The dataset the pages currently display. */
    data: () => state.workspaces[state.active],
    dataOf: (ws) => state.workspaces[ws],

    /**
     * Apply an operation to a workspace (default: the active one).
     * @param {(data:object)=>object} op @param {{label?:string, workspace?:string}} [meta]
     * @returns Result (ok:false leaves everything unchanged)
     */
    apply(op, meta = {}) {
      const ws = meta.workspace || state.active;
      const cur = state.workspaces[ws];
      if (!cur) return { ok: false, errors: [{ message: 'That workspace is not loaded.' }] };
      let res;
      try {
        res = op(cur);
      } catch (e) {
        return { ok: false, errors: [{ message: `Unexpected error: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.` }] };
      }
      if (!res || !res.ok) return res || { ok: false, errors: [{ message: 'The operation did not return a result.' }] };
      if (res.data && res.data !== cur) {
        const history = [...state.history, { workspace: ws, before: cur, label: meta.label || 'change' }].slice(-HISTORY_LIMIT);
        set({ ...state, workspaces: { ...state.workspaces, [ws]: res.data }, history });
        persist(ws, res.data);
      }
      return res;
    },

    /** Undo the most recent change in the active workspace. */
    undo() {
      for (let i = state.history.length - 1; i >= 0; i -= 1) {
        const h = state.history[i];
        if (h.workspace !== state.active) continue;
        const history = state.history.filter((_, j) => j !== i);
        set({ ...state, workspaces: { ...state.workspaces, [h.workspace]: h.before }, history });
        persist(h.workspace, h.before);
        return { ok: true, label: h.label };
      }
      return { ok: false, errors: [{ message: 'Nothing to undo.' }] };
    },
    canUndo: () => state.history.some((h) => h.workspace === state.active),
    lastUndoLabel: () => [...state.history].reverse().find((h) => h.workspace === state.active)?.label || null,

    /** Replace a whole workspace (import, reset, preset). The previous dataset goes on the undo stack. */
    replaceWorkspace(ws, dataset, label = 'replace data') {
      const cur = state.workspaces[ws];
      const history = cur ? [...state.history, { workspace: ws, before: cur, label }].slice(-HISTORY_LIMIT) : state.history;
      set({ ...state, workspaces: { ...state.workspaces, [ws]: dataset }, history, status: ws === 'main' ? 'ready' : state.status, recovery: ws === 'main' ? null : state.recovery });
      return persist(ws, dataset);
    },

    switchWorkspace(ws) {
      if (!state.workspaces[ws]) return { ok: false, errors: [{ message: 'That workspace has no data yet. Load a preset first.' }] };
      set({ ...state, active: ws });
      storage.setJson(KEYS.meta, { active: ws });
      return { ok: true };
    },

    /** Restore the deterministic demo into My finances. */
    resetDemo() {
      return store.replaceWorkspace('main', buildDemoDataset(), 'reset to demo data');
    },

    /** Load a Test Lab preset into the sandbox (never touches My finances). */
    loadPreset(id) {
      const p = getPreset(id);
      if (!p) return { ok: false, errors: [{ message: `Unknown preset "${id}".` }] };
      const r = store.replaceWorkspace('lab', p.build(), `load preset ${p.title}`);
      return { ok: r.ok !== false, preset: p };
    },

    /**
     * Resolve a corrupt-data recovery: keep a verbatim backup, then continue with demo data ('demo'), an imported
     * dataset ('import') or the user's own saved data after explicit repairs ('repair'; see repairs.js).
     */
    resolveRecovery(action, dataset = null, note = '') {
      const rec = state.recovery;
      if (!rec) return { ok: false, errors: [{ message: 'Nothing to recover.' }] };
      const backup = storage.backupCorrupt(rec.raw, now());
      const next = (action === 'import' || action === 'repair') && dataset ? dataset : buildDemoDataset();
      const notices = action === 'repair' && note ? [...state.notices, `${note} The original data is kept as a backup (${backup.key || 'see Settings / Data'}).`] : state.notices;
      set({ ...state, status: 'ready', recovery: null, active: 'main', workspaces: { ...state.workspaces, main: next }, history: [], notices });
      persist('main', next);
      return { ok: true, backupKey: backup.key };
    },

    /** Persist the active workspace again (used after a failed save). */
    retrySave() {
      const ws = state.active;
      return persist(ws, state.workspaces[ws]);
    },

    setPrefs(patch) {
      const prefs = { ...state.prefs, ...patch };
      set({ ...state, prefs });
      storage.setJson(KEYS.prefs, prefs);
    },

    dismissNotice(i) {
      set({ ...state, notices: state.notices.filter((_, j) => j !== i) });
    },

    /** Delete a workspace's saved data (used by "clear local data"). */
    clearLocalData() {
      storage.removeWorkspace('main');
      storage.removeWorkspace('lab');
      storage.removeKey(KEYS.meta);
      boot();
      emit();
    },
    storage,
  };
  return store;
}
