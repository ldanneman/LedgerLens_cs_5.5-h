import Icon from './Icon.jsx';

/**
 * Accessible data table. On narrow screens rows become labelled cards (CSS `.cards`), so nothing is
 * clipped or hidden behind horizontal scrolling. The wrapper is keyboard-focusable for wide tables.
 *
 * columns: [{ key, header, render(row), className, sortable, main, label }]
 */
export default function DataTable({ caption, columns, rows, rowKey, sort, onSort, selectable, selected, onSelect, onSelectAll, rowClass, footer, empty, dense }) {
  const allSelected = selectable && rows.length > 0 && rows.every((r) => selected?.has(rowKey(r)));
  return (
    <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className={`data cards${dense ? ' dense' : ''}`}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {selectable && (
              <th style={{ width: 36 }}>
                <input type="checkbox" aria-label="Select all rows on this page" checked={Boolean(allSelected)} onChange={(e) => onSelectAll?.(e.target.checked)} />
              </th>
            )}
            {columns.map((c) => {
              const active = sort && sort.key === c.key;
              return (
                <th key={c.key} className={c.className} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined} scope="col">
                  {c.sortable && onSort ? (
                    <button type="button" className="sort" onClick={() => onSort(c.key)}>
                      {c.header}
                      {active ? <Icon name={sort.dir === 'asc' ? 'up' : 'down'} size={14} /> : <span aria-hidden="true" style={{ width: 14 }} />}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + (selectable ? 1 : 0)} className="cell-main">
                {empty || <span className="muted">Nothing to show.</span>}
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const key = rowKey(r);
            const isSel = selectable && selected?.has(key);
            return (
              <tr key={key} className={`${isSel ? 'selected' : ''} ${rowClass ? rowClass(r) : ''}`.trim()}>
                {selectable && (
                  <td className="no-label">
                    <input type="checkbox" aria-label={`Select row ${key}`} checked={Boolean(isSel)} onChange={(e) => onSelect?.(key, e.target.checked)} />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.key} className={`${c.className || ''}${c.main ? ' cell-main' : ''}`.trim()} data-label={c.label || c.header}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        {footer}
      </table>
    </div>
  );
}
