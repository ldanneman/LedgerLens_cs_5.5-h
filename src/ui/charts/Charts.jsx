/**
 * Dependency-free SVG charts. Every chart:
 *  - is a <figure> with a caption and an aria-label summary,
 *  - has focusable hit areas whose values appear in a live readout,
 *  - ships a numeric table equivalent ("Show the numbers"), so values never depend on color or hover,
 *  - distinguishes series by dash pattern / marker as well as color.
 */
import { useId, useState } from 'react';
import { formatMoney } from '../../domain/money.js';
import { compactMoney } from '../format.js';

const W = 640;
const M = { t: 14, r: 14, b: 34, l: 58 };
const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];
const DASHES = ['', '6 3', '2 3', '8 3 2 3', '1 4'];
const MARKERS = ['circle', 'square', 'diamond', 'triangle', 'cross'];

export const colorAt = (i) => PALETTE[i % PALETTE.length];

/** Round the axis range to friendly tick values. */
export function niceScale(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) {
    const pad = Math.max(Math.abs(max) * 0.1, 100);
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const rough = span / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { min: lo, max: hi, ticks };
}

function Marker({ kind, x, y, color }) {
  const s = 4;
  const style = { fill: color, stroke: 'var(--surface)', strokeWidth: 1 };
  if (kind === 'square') return <rect x={x - s} y={y - s} width={s * 2} height={s * 2} style={style} />;
  if (kind === 'diamond') return <path d={`M${x} ${y - s - 1}L${x + s + 1} ${y}L${x} ${y + s + 1}L${x - s - 1} ${y}Z`} style={style} />;
  if (kind === 'triangle') return <path d={`M${x} ${y - s - 1}L${x + s + 1} ${y + s}L${x - s - 1} ${y + s}Z`} style={style} />;
  if (kind === 'cross') return <path d={`M${x - s} ${y - s}L${x + s} ${y + s}M${x + s} ${y - s}L${x - s} ${y + s}`} style={{ stroke: color, strokeWidth: 2, fill: 'none' }} />;
  return <circle cx={x} cy={y} r={s} style={style} />;
}

function Legend({ items }) {
  return (
    <div className="legend" aria-hidden="false">
      {items.map((it, i) => (
        <span key={it.name}>
          <svg width="22" height="10" aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 4 }}>
            <line x1="1" y1="5" x2="21" y2="5" style={{ stroke: it.color || colorAt(i), strokeWidth: 3 }} strokeDasharray={it.bar ? '' : DASHES[i % DASHES.length]} />
          </svg>
          {it.name}
        </span>
      ))}
    </div>
  );
}

/** Numeric equivalent of a chart. */
export function ChartTable({ labels, series, format = (v) => formatMoney(v), caption, firstColumn = 'Period' }) {
  return (
    <details className="explain" style={{ marginTop: 6 }}>
      <summary>Show the numbers</summary>
      <div className="table-wrap" role="region" aria-label={`${caption} numbers`} tabIndex={0} style={{ marginTop: 6 }}>
        <table className="data">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">{firstColumn}</th>
              {series.map((s) => (
                <th key={s.name} scope="col" className="num">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((l, i) => (
              <tr key={`${l}-${i}`}>
                <th scope="row">{l}</th>
                {series.map((s) => (
                  <td key={s.name} className="num amt">
                    {s.values[i] === null || s.values[i] === undefined ? '-' : format(s.values[i])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function xTickIndexes(n, max = 8) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / max);
  const out = [];
  for (let i = 0; i < n; i += step) out.push(i);
  return out;
}

/**
 * Line chart. series: [{name, values:number[]}] aligned to labels. Null values break the line.
 */
export function LineChart({ title, labels, series, yFormat = compactMoney, valueFormat = (v) => formatMoney(v), height = 260, ariaLabel, emptyText = 'No data for this period.' }) {
  const uid = useId();
  const [active, setActive] = useState(null);
  const H = height;
  if (!labels.length || !series.length) return <div className="empty">{emptyText}</div>;
  const all = series.flatMap((s) => s.values).filter((v) => v !== null && v !== undefined);
  const sc = niceScale(all.length ? Math.min(...all) : 0, all.length ? Math.max(...all) : 1);
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;
  const x = (i) => M.l + (labels.length === 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const y = (v) => M.t + ih - ((v - sc.min) / (sc.max - sc.min || 1)) * ih;
  const step = labels.length === 1 ? iw : iw / (labels.length - 1);
  const summary = ariaLabel || `${title}. ${series.map((s) => `${s.name} from ${valueFormat(s.values.find((v) => v !== null) ?? 0)} to ${valueFormat([...s.values].reverse().find((v) => v !== null) ?? 0)}`).join('; ')}.`;
  return (
    <figure className="chart">
      {title && <figcaption>{title}</figcaption>}
      <Legend items={series.map((s, i) => ({ name: s.name, color: s.color || colorAt(i) }))} />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
        {sc.ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} />
            <text x={M.l - 8} y={y(t) + 4} textAnchor="end">
              {yFormat(t)}
            </text>
          </g>
        ))}
        {xTickIndexes(labels.length).map((i) => (
          <text key={i} x={x(i)} y={H - 10} textAnchor="middle">
            {labels[i]}
          </text>
        ))}
        {series.map((s, si) => {
          const color = s.color || colorAt(si);
          let d = '';
          let pen = false;
          s.values.forEach((v, i) => {
            if (v === null || v === undefined) {
              pen = false;
              return;
            }
            d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
            pen = true;
          });
          return (
            <g key={s.name}>
              <path d={d} fill="none" style={{ stroke: color, strokeWidth: 2.4 }} strokeDasharray={DASHES[si % DASHES.length]} strokeLinejoin="round" />
              {labels.length <= 24 && s.values.map((v, i) => (v === null || v === undefined ? null : <Marker key={i} kind={MARKERS[si % MARKERS.length]} x={x(i)} y={y(v)} color={color} />))}
            </g>
          );
        })}
        {active !== null && <line x1={x(active)} x2={x(active)} y1={M.t} y2={M.t + ih} style={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }} />}
        {labels.map((l, i) => (
          <rect
            key={`${uid}-${i}`}
            className="hit"
            x={x(i) - step / 2}
            y={M.t}
            width={step}
            height={ih}
            fill="transparent"
            tabIndex={0}
            role="img"
            aria-label={`${l}: ${series.map((s) => `${s.name} ${s.values[i] === null || s.values[i] === undefined ? 'no data' : valueFormat(s.values[i])}`).join(', ')}`}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onBlur={() => setActive(null)}
          />
        ))}
      </svg>
      <div className="chart-readout" aria-live="polite">
        {active !== null ? `${labels[active]}: ${series.map((s) => `${s.name} ${s.values[active] === null || s.values[active] === undefined ? '-' : valueFormat(s.values[active])}`).join(' | ')}` : ' '}
      </div>
      <ChartTable labels={labels} series={series} format={valueFormat} caption={title || 'Line chart'} />
    </figure>
  );
}

/**
 * Bar chart. Grouped by default; `stacked` stacks positives up and negatives down.
 */
export function BarChart({ title, labels, series, stacked = false, yFormat = compactMoney, valueFormat = (v) => formatMoney(v), height = 260, ariaLabel, emptyText = 'No data for this period.', onBarClick }) {
  const [active, setActive] = useState(null);
  const H = height;
  if (!labels.length || !series.length) return <div className="empty">{emptyText}</div>;
  let lo = 0;
  let hi = 0;
  labels.forEach((_, i) => {
    if (stacked) {
      let pos = 0;
      let neg = 0;
      for (const s of series) {
        const v = s.values[i] || 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      hi = Math.max(hi, pos);
      lo = Math.min(lo, neg);
    } else for (const s of series) {
      hi = Math.max(hi, s.values[i] || 0);
      lo = Math.min(lo, s.values[i] || 0);
    }
  });
  const sc = niceScale(lo, hi === 0 && lo === 0 ? 100 : hi);
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;
  const y = (v) => M.t + ih - ((v - sc.min) / (sc.max - sc.min || 1)) * ih;
  const band = iw / labels.length;
  const groupW = Math.min(band * 0.78, 64 * (stacked ? 1 : series.length));
  const barW = stacked ? groupW : groupW / series.length;
  const summary = ariaLabel || `${title}. ${labels.length} periods, ${series.map((s) => s.name).join(', ')}.`;
  return (
    <figure className="chart">
      {title && <figcaption>{title}</figcaption>}
      <Legend items={series.map((s, i) => ({ name: s.name, color: s.color || colorAt(i), bar: true }))} />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
        {sc.ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} />
            <text x={M.l - 8} y={y(t) + 4} textAnchor="end">
              {yFormat(t)}
            </text>
          </g>
        ))}
        <line className="axis-line" x1={M.l} x2={W - M.r} y1={y(0)} y2={y(0)} style={{ strokeWidth: 1.5 }} />
        {xTickIndexes(labels.length, 12).map((i) => (
          <text key={i} x={M.l + band * i + band / 2} y={H - 10} textAnchor="middle">
            {labels[i]}
          </text>
        ))}
        {labels.map((l, i) => {
          const cx = M.l + band * i + band / 2;
          let posBase = 0;
          let negBase = 0;
          return (
            <g key={`${l}-${i}`}>
              {series.map((s, si) => {
                const v = s.values[i] || 0;
                const color = s.color || colorAt(si);
                let y0;
                let y1;
                let xPos;
                if (stacked) {
                  xPos = cx - barW / 2;
                  if (v >= 0) {
                    y0 = y(posBase);
                    y1 = y(posBase + v);
                    posBase += v;
                  } else {
                    y0 = y(negBase);
                    y1 = y(negBase + v);
                    negBase += v;
                  }
                } else {
                  xPos = cx - groupW / 2 + si * barW;
                  y0 = y(0);
                  y1 = y(v);
                }
                const top = Math.min(y0, y1);
                const h = Math.max(Math.abs(y1 - y0), v === 0 ? 0 : 1);
                return <rect key={s.name} x={xPos + 1} y={top} width={Math.max(barW - 2, 1)} height={h} rx={2} style={{ fill: color }} opacity={active !== null && active !== i ? 0.55 : 1} />;
              })}
              <rect
                className="hit"
                x={M.l + band * i}
                y={M.t}
                width={band}
                height={ih}
                fill="transparent"
                tabIndex={0}
                role="img"
                aria-label={`${l}: ${series.map((s) => `${s.name} ${valueFormat(s.values[i] || 0)}`).join(', ')}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onBlur={() => setActive(null)}
                onClick={onBarClick ? () => onBarClick(i) : undefined}
                style={onBarClick ? { cursor: 'pointer' } : undefined}
              />
            </g>
          );
        })}
      </svg>
      <div className="chart-readout" aria-live="polite">
        {active !== null ? `${labels[active]}: ${series.map((s) => `${s.name} ${valueFormat(s.values[active] || 0)}`).join(' | ')}` : ' '}
      </div>
      <ChartTable labels={labels} series={series} format={valueFormat} caption={title || 'Bar chart'} />
    </figure>
  );
}

/** Donut with a labelled list (values and shares), so the percentages are always readable. */
export function DonutChart({ title, slices, total, format = (v) => formatMoney(v), onSliceClick, ariaLabel }) {
  const clean = slices.filter((s) => s.value > 0);
  const sum = total ?? clean.reduce((a, s) => a + s.value, 0);
  if (!clean.length || sum <= 0) return <div className="empty">No spending in this period.</div>;
  const R = 78;
  const r = 48;
  let angle = -Math.PI / 2;
  const arcs = clean.map((s, i) => {
    const frac = s.value / sum;
    const a0 = angle;
    const a1 = angle + frac * Math.PI * 2;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a, rad) => `${(100 + rad * Math.cos(a)).toFixed(2)} ${(100 + rad * Math.sin(a)).toFixed(2)}`;
    const d = frac >= 0.9999 ? `M100 ${100 - R}A${R} ${R} 0 1 1 99.99 ${100 - R}L99.99 ${100 - r}A${r} ${r} 0 1 0 100 ${100 - r}Z` : `M${p(a0, R)}A${R} ${R} 0 ${large} 1 ${p(a1, R)}L${p(a1, r)}A${r} ${r} 0 ${large} 0 ${p(a0, r)}Z`;
    return { ...s, d, frac, color: s.color || colorAt(i) };
  });
  return (
    <figure className="chart">
      {title && <figcaption>{title}</figcaption>}
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
        <svg className="donut" viewBox="0 0 200 200" width="190" height="190" role="img" aria-label={ariaLabel || `${title}: ${arcs.slice(0, 3).map((a) => `${a.label} ${(a.frac * 100).toFixed(0)}%`).join(', ')}${arcs.length > 3 ? ' and more' : ''}`} style={{ flex: 'none' }}>
          {arcs.map((a) => (
            <path key={a.label} d={a.d} style={{ fill: a.color, stroke: 'var(--surface)', strokeWidth: 1.5 }}>
              <title>{`${a.label}: ${format(a.value)} (${(a.frac * 100).toFixed(1)}%)`}</title>
            </path>
          ))}
          <text x="100" y="97" textAnchor="middle" style={{ fontSize: 11 }}>
            Total
          </text>
          <text x="100" y="114" textAnchor="middle" style={{ fontSize: 13, fontWeight: 700, fill: 'var(--text)' }}>
            {compactMoney(sum)}
          </text>
        </svg>
        <ul className="list-plain" style={{ flex: '1 1 220px', minWidth: 0 }}>
          {arcs.map((a) => (
            <li key={a.label}>
              <span>
                <span className="sw" style={{ background: a.color, display: 'inline-block', width: 12, height: 12, borderRadius: 3, marginRight: 6 }} aria-hidden="true" />
                {onSliceClick && a.href !== false ? (
                  <button type="button" className="btn ghost small" style={{ padding: '0 4px', minHeight: 24 }} onClick={() => onSliceClick(a)}>
                    {a.label}
                  </button>
                ) : (
                  a.label
                )}
              </span>
              <span className="amt">
                {format(a.value)} <span className="muted small">({(a.frac * 100).toFixed(1)}%)</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

/** Horizontal bars with labels and values (accessible list). */
export function HBarList({ items, format = (v) => formatMoney(v), max, onItemClick, tone }) {
  const peak = max ?? Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return (
    <ul className="hbar-list">
      {items.map((it, i) => (
        <li key={it.label}>
          <span>{onItemClick ? <button type="button" className="btn ghost small" style={{ padding: '0 4px', minHeight: 24, textAlign: 'left' }} onClick={() => onItemClick(it)}>{it.label}</button> : it.label}</span>
          <span className="bar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (Math.abs(it.value) / peak) * 100)}%`, background: it.color || tone || colorAt(i) }} />
          </span>
          <span className="amt">{format(it.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Tiny trend line for cards. */
export function Sparkline({ values, label, width = 120, height = 32 }) {
  if (!values || values.length < 2) return null;
  const sc = niceScale(Math.min(...values), Math.max(...values), 3);
  const x = (i) => 2 + (i / (values.length - 1)) * (width - 4);
  const y = (v) => 2 + (height - 4) - ((v - sc.min) / (sc.max - sc.min || 1)) * (height - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label || `Trend from ${formatMoney(values[0])} to ${formatMoney(values[values.length - 1])}`}>
      <path d={d} fill="none" style={{ stroke: 'var(--brand)', strokeWidth: 2 }} strokeLinejoin="round" />
    </svg>
  );
}
