import { Component, useEffect, useId, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import Icon from './Icon.jsx';

export function PageHead({ title, children, actions }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = '', as: Tag = 'section', ...rest }) {
  return (
    <Tag className={`card ${className}`.trim()} {...rest}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}

export function Stat({ label, value, sub, info }) {
  return (
    <div className="stat">
      <span className="label">
        {label}
        {info && <InfoTip>{info}</InfoTip>}
      </span>
      <span className="value">{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

export function Badge({ tone = '', children, title }) {
  return (
    <span className={`badge ${tone}`.trim()} title={title}>
      {children}
    </span>
  );
}

export function Callout({ tone = 'info', children, ...rest }) {
  return (
    <div className={`callout ${tone}`} role={tone === 'error' ? 'alert' : undefined} {...rest}>
      {children}
    </div>
  );
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ProgressBar({ pct, tone = '', label }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div className={`progress ${tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)} aria-label={label}>
      <span style={{ width: `${clamped}%` }} />
    </div>
  );
}

/** "How is this calculated?" disclosure. */
export function InfoTip({ children, label = 'How this is calculated' }) {
  const id = useId();
  return (
    <details className="explain infotip" style={{ display: 'inline-block' }}>
      <summary aria-label={label} aria-controls={id} style={{ listStyle: 'none', cursor: 'pointer' }}>
        <Icon name="info" size={15} />
      </summary>
      <div id={id} role="note" style={{ position: 'absolute', zIndex: 15, maxWidth: 320, boxShadow: 'var(--shadow)', border: '1px solid var(--border)' }}>
        {children}
      </div>
    </details>
  );
}

/** Inline explanation block ("How this is calculated"). */
export function Explain({ summary = 'How is this calculated?', children }) {
  return (
    <details className="explain">
      <summary>{summary}</summary>
      <div>{children}</div>
    </details>
  );
}

/** Button-driven tab list (client state). */
export function Tabs({ tabs, value, onChange, label }) {
  const refs = useRef([]);
  const onKey = (e, i) => {
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    if (n !== null) {
      e.preventDefault();
      onChange(tabs[n].id);
      refs.current[n]?.focus();
    }
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button key={t.id} ref={(el) => (refs.current[i] = el)} type="button" role="tab" id={`tab-${t.id}`} aria-selected={value === t.id} aria-controls={`panel-${t.id}`} tabIndex={value === t.id ? 0 : -1} onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}>
          {t.label}
          {t.badge !== undefined && t.badge !== null && <span className="badge" style={{ marginLeft: 6 }}>{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, value, children }) {
  if (id !== value) return null;
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`}>
      {children}
    </div>
  );
}

/** Route-based sub navigation (links). */
export function LinkTabs({ items, label }) {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.end}>
          {i.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Small popup action menu. */
export function Menu({ label = 'More actions', items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <span className="menu" ref={ref} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button type="button" className="btn small ghost icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? 'danger-item' : ''}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Error boundary so a failure in one panel never blanks the whole app. */
export class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('LedgerLens panel error:', error, info?.componentStack);
  }
  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary" role="alert">
          <strong>{this.props.name ? `${this.props.name} hit a problem.` : 'Something went wrong in this section.'}</strong>
          <p className="small" style={{ margin: '4px 0 8px' }}>
            Your data is safe. {this.state.error.message || String(this.state.error)}
          </p>
          <button type="button" className="btn small" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function Pager({ page, pageCount, total, size, onPage, onSize, sizes = [25, 50, 100, 200] }) {
  const from = total === 0 ? 0 : page * size + 1;
  const to = Math.min(total, (page + 1) * size);
  return (
    <div className="pager">
      <span className="small muted" aria-live="polite">
        {total === 0 ? 'No rows' : `Showing ${from.toLocaleString('en-US')}-${to.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`}
      </span>
      <span className="row">
        {onSize && (
          <label className="small row">
            Rows
            <select value={size} onChange={(e) => onSize(Number(e.target.value))} style={{ width: 'auto', minHeight: 32 }}>
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="btn small" disabled={page <= 0} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span className="small">
          Page {Math.min(page + 1, Math.max(pageCount, 1))} of {Math.max(pageCount, 1)}
        </span>
        <button type="button" className="btn small" disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </span>
    </div>
  );
}
