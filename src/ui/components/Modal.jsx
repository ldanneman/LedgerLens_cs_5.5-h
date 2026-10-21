import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon.jsx';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Accessible modal dialog: focus trap, Escape to close, focus restored on close. */
export function Modal({ title, onClose, children, footer, wide = false, dismissible = true }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    const first = node?.querySelector('[data-autofocus]') || node?.querySelector(FOCUSABLE);
    (first || node)?.focus();
    return () => {
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, []);
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation();
      onClose?.();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...ref.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && dismissible && onClose?.()}>
      <div ref={ref} className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          {dismissible && (
            <button type="button" className="btn ghost icon-btn" onClick={onClose} aria-label="Close dialog">
              <Icon name="close" />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

const ConfirmContext = createContext(null);

/** Promise-based confirmation dialog: `const ok = await confirm({...})`. */
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const [typed, setTyped] = useState('');
  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setTyped('');
        setState({ ...opts, resolve });
      }),
    [],
  );
  const close = (result) => {
    state.resolve(result);
    setState(null);
  };
  const needsText = state?.requireText && typed !== state.requireText;
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <Modal
          title={state.title || 'Are you sure?'}
          onClose={() => close(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => close(false)} data-autofocus>
                {state.cancelLabel || 'Cancel'}
              </button>
              {state.extraAction && (
                <button type="button" className="btn" onClick={() => { state.extraAction.run(); }}>
                  {state.extraAction.label}
                </button>
              )}
              <button type="button" className={`btn ${state.danger ? 'danger' : 'primary'}`} disabled={needsText} onClick={() => close(true)}>
                {state.confirmLabel || 'Confirm'}
              </button>
            </>
          }
        >
          <div>{typeof state.message === 'string' ? <p>{state.message}</p> : state.message}</div>
          {state.requireText && (
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="confirm-text">Type <strong>{state.requireText}</strong> to continue</label>
              <input id="confirm-text" type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </div>
          )}
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const c = useContext(ConfirmContext);
  if (!c) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return c;
}
