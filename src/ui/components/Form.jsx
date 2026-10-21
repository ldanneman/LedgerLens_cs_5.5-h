import { useId } from 'react';

function Wrap({ id, label, hint, error, className = '', children }) {
  return (
    <div className={`field${error ? ' invalid' : ''} ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error && <span className="hint" id={`${id}-hint`}>{hint}</span>}
      {error && (
        <span className="error-text" id={`${id}-err`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

const aria = (id, error, hint) => ({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-err` : hint ? `${id}-hint` : undefined });

export function TextField({ label, value, onChange, error, hint, className, type = 'text', ...rest }) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error} className={className}>
      <input type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...aria(id, error, hint)} {...rest} />
    </Wrap>
  );
}

/** Money text input: holds the raw string; callers parse it with parseMoney on submit. */
export function MoneyField({ label, value, onChange, error, hint, className, ...rest }) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error} className={className}>
      <input type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...aria(id, error, hint)} {...rest} />
    </Wrap>
  );
}

export function SelectField({ label, value, onChange, options, error, hint, className, placeholder, ...rest }) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error} className={className}>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...aria(id, error, hint)} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </Wrap>
  );
}

export function TextAreaField({ label, value, onChange, error, hint, className, ...rest }) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error} className={className}>
      <textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...aria(id, error, hint)} {...rest} />
    </Wrap>
  );
}

export function CheckField({ label, checked, onChange, hint, ...rest }) {
  const id = useId();
  return (
    <div className="field">
      <label className="check" htmlFor={id}>
        <input id={id} type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} {...rest} />
        <span>{label}</span>
      </label>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** Summary of errors at the top of a form. */
export function ErrorSummary({ errors }) {
  if (!errors || !errors.length) return null;
  return (
    <div className="callout error" role="alert" style={{ marginBottom: 12 }}>
      <strong>{errors.length === 1 ? 'Not saved: ' : 'Not saved. Please fix:'}</strong>
      {errors.length === 1 ? ` ${errors[0].message}` : (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {errors.map((e, i) => (
            <li key={i}>{e.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Group domain errors by field: {field: message}. */
export function fieldErrors(errors) {
  const out = {};
  for (const e of errors || []) if (e.field && !out[e.field]) out[e.field] = e.message;
  return out;
}
