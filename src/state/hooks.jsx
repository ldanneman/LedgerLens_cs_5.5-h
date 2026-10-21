import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from 'react';

/** React bindings for the store, plus the toast system. */
const StoreContext = createContext(null);
const ToastContext = createContext(null);

export function StoreProvider({ store, children }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** Raw store (for imperative calls). */
export function useStore() {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useStore must be used inside <StoreProvider>');
  return s;
}

/** Subscribe to the whole app state. */
export function useAppState() {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** The dataset of the active workspace (always non-null while status is "ready"). */
export function useData() {
  const st = useAppState();
  return st.workspaces[st.active];
}

/** Memoize a derived value from the dataset (recomputed only when the dataset object changes). */
export function useDerived(fn, extraDeps = []) {
  const data = useData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => fn(data), [data, ...extraDeps]);
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((toast) => {
    idRef.current += 1;
    const id = idRef.current;
    setToasts((t) => [...t.slice(-3), { id, kind: 'info', ...toast }]);
    if (!toast.sticky) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), toast.kind === 'error' ? 9000 : toast.action ? 8000 : 5000);
    return id;
  }, []);
  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToasts() {
  const t = useContext(ToastContext);
  if (!t) throw new Error('useToasts must be used inside <ToastProvider>');
  return t;
}

/**
 * Returns run(op, {label, success}) that applies a domain operation, shows a toast
 * (with Undo for destructive ops) and returns the Result.
 */
export function useRun() {
  const store = useStore();
  const { push } = useToasts();
  return useCallback(
    (op, meta = {}) => {
      const res = store.apply(op, { label: meta.label });
      if (!res.ok) {
        push({ kind: 'error', title: meta.failTitle || 'Not saved', message: res.errors.map((e) => e.message).join(' ') });
        return res;
      }
      const warnings = res.warnings || [];
      if (meta.success || warnings.length) {
        push({
          kind: warnings.length ? 'warning' : 'success',
          title: meta.success || 'Saved',
          message: warnings.join(' '),
          action: meta.undo ? { label: 'Undo', run: () => store.undo() } : undefined,
        });
      }
      return res;
    },
    [store, push],
  );
}
