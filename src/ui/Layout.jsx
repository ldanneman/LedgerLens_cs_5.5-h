import { useEffect, useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import Icon from './components/Icon.jsx';
import { useAppState, useStore, useToasts } from '../state/hooks.jsx';
import { formatDate } from '../domain/dates.js';
import { Boundary } from './components/Common.jsx';
import { updateSettings } from '../domain/ops/catalog.js';
import { isValidDate } from '../domain/dates.js';

export const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/accounts', label: 'Accounts', icon: 'accounts' },
  { to: '/transactions', label: 'Transactions', icon: 'transactions' },
  { to: '/import', label: 'Import & Reconcile', icon: 'import' },
  { to: '/budgets', label: 'Budgets', icon: 'budgets' },
  { to: '/recurring', label: 'Recurring & Bills', icon: 'recurring' },
  { to: '/goals', label: 'Goals & Debt', icon: 'goals' },
  { to: '/reports', label: 'Reports & Analytics', icon: 'reports' },
  { to: '/planner', label: 'Scenario Planner', icon: 'planner' },
  { to: '/lab', label: 'Test Lab', icon: 'lab' },
  { to: '/settings', label: 'Settings / Data', icon: 'settings' },
];

function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" aria-live="polite" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <div className="body">
            <div className="title">{t.title}</div>
            {t.message && <div className="small">{t.message}</div>}
            {t.action && (
              <button
                type="button"
                className="btn small"
                style={{ marginTop: 6 }}
                onClick={() => {
                  t.action.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button type="button" className="btn ghost small icon-btn" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Application chrome: sidebar navigation, top bar with context controls, banners, toasts. */
export default function Layout({ children }) {
  const st = useAppState();
  const store = useStore();
  const { push } = useToasts();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const data = st.workspaces[st.active];
  useEffect(() => setOpen(false), [loc.pathname]);

  const undo = () => {
    const label = store.lastUndoLabel();
    const r = store.undo();
    push(r.ok ? { kind: 'success', title: 'Undone', message: label ? `Reverted: ${label}.` : '' } : { kind: 'info', title: 'Nothing to undo' });
  };
  const setAsOf = (v) => {
    if (!isValidDate(v)) return;
    const r = store.apply((d) => updateSettings(d, { asOfDate: v }), { label: 'change as-of date' });
    if (!r.ok) push({ kind: 'error', title: 'Not changed', message: r.errors.map((e) => e.message).join(' ') });
  };
  const setBasis = (v) => store.apply((d) => updateSettings(d, { basis: v }), { label: 'change basis' });

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      {open && <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Primary">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <Icon name="search" size={18} />
          </span>
          LedgerLens
        </Link>
        <nav className="nav" aria-label="Main navigation">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              <Icon name={n.icon} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div>Local-first. Fictional demo data.</div>
          <div>Data stays in this browser.</div>
        </div>
      </aside>
      <div className="main">
        {st.persistWarning && !st.persistent && (
          <div className="banner warn" role="status">
            <strong>Changes won't be remembered.</strong> {st.persistWarning}
          </div>
        )}
        {st.saveError && (
          <div className="banner error" role="alert">
            <strong>Not saved.</strong> {st.saveError}
            <button type="button" className="btn small" onClick={() => store.retrySave()}>
              Retry save
            </button>
            <Link className="btn small" to="/settings">
              Export a backup
            </Link>
          </div>
        )}
        {st.notices.map((n, i) => (
          <div key={i} className="banner warn" role="status">
            <span>{n}</span>
            <button type="button" className="btn small" onClick={() => store.dismissNotice(i)}>
              Dismiss
            </button>
          </div>
        ))}
        {st.active === 'lab' && (
          <div className="banner info" role="status">
            <span>
              <strong>Test Lab sandbox:</strong> you are viewing "{data?.meta?.name}". Your real data in <em>My finances</em> is untouched.
            </span>
            <button type="button" className="btn small" onClick={() => store.switchWorkspace('main')}>
              Return to My finances
            </button>
          </div>
        )}
        <header className="topbar">
          <button type="button" className="btn menu-btn icon-btn" aria-label="Open navigation menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Icon name="menu" />
          </button>
          <div className="grow">
            <strong>{data?.meta?.name}</strong>
            <span className="muted small" style={{ marginLeft: 8 }}>
              as of {data ? formatDate(data.settings.asOfDate) : ''}
            </span>
          </div>
          {data && (
            <>
              <label className="small row" style={{ gap: 6 }}>
                <span className="muted">As-of date</span>
                <input type="date" value={data.settings.asOfDate} onChange={(e) => setAsOf(e.target.value)} style={{ width: 'auto', minHeight: 34 }} aria-label="As-of date" />
              </label>
              <label className="small row" style={{ gap: 6 }}>
                <span className="muted">Basis</span>
                <select value={data.settings.basis} onChange={(e) => setBasis(e.target.value)} style={{ width: 'auto', minHeight: 34 }} aria-label="Balance basis">
                  <option value="posted">Posted only</option>
                  <option value="pending">Include pending</option>
                </select>
              </label>
            </>
          )}
          <button type="button" className="btn small" onClick={undo} disabled={!store.canUndo()} title={store.canUndo() ? `Undo: ${store.lastUndoLabel()}` : 'Nothing to undo'}>
            <Icon name="undo" size={15} /> Undo
          </button>
        </header>
        <main id="main-content" className="content" tabIndex={-1}>
          <Boundary name="This page" resetKey={loc.pathname}>
            {children}
          </Boundary>
        </main>
      </div>
      <Toasts />
    </div>
  );
}
