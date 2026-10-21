import { useMemo, useState } from 'react';
import { useData, useRun } from '../../state/hooks.jsx';
import { buildIndex } from '../../domain/ledger.js';
import { sortedRules, ruleMatches, previewRules } from '../../domain/rules.js';
import { saveRule, deleteRule, applyRules, addCategory, updateCategory, deleteCategory, categoryUsage } from '../../domain/ops/catalog.js';
import { parseMoney, centsToDecimalString, formatMoney } from '../../domain/money.js';
import { formatDate } from '../../domain/dates.js';
import { PageHead, Card, Badge, Callout, Explain, EmptyState } from '../components/Common.jsx';
import DataTable from '../components/DataTable.jsx';
import { Modal, useConfirm } from '../components/Modal.jsx';
import { CheckField, ErrorSummary, MoneyField, SelectField, TextField, fieldErrors } from '../components/Form.jsx';

const FIELD_LABELS = { merchant: 'merchant', description: 'description', any: 'merchant or description' };
const MATCH_LABELS = { contains: 'contains', equals: 'equals', starts_with: 'starts with' };

export default function RulesPage() {
  const data = useData();
  const run = useRun();
  const confirm = useConfirm();
  const index = useMemo(() => buildIndex(data), [data]);
  const rules = useMemo(() => sortedRules(data.rules), [data.rules]);
  const [editing, setEditing] = useState(null);
  const [scope, setScope] = useState('uncategorized');
  const [preview, setPreview] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [catModal, setCatModal] = useState(null);

  const matchCount = (r) => data.transactions.filter((t) => ruleMatches({ ...r, enabled: true }, t, index.categoriesById)).length;
  const runPreview = () => {
    const p = previewRules(data, { scope });
    setPreview(p);
    setPicked(new Set(p.map((c) => c.txId)));
  };
  const apply = () => {
    const ids = [...picked];
    const r = run((d) => applyRules(d, { scope, txIds: ids }), { label: `apply rules to ${ids.length} transactions`, success: `Categorized ${ids.length} transactions`, undo: true });
    if (r.ok) setPreview(null);
  };
  const usage = (id) => categoryUsage(data, id);

  return (
    <>
      <PageHead title="Rules & categories" actions={<><button type="button" className="btn primary" onClick={() => setEditing({})}>Add rule</button><button type="button" className="btn" onClick={() => setCatModal({ mode: 'add' })}>Add category</button></>}>
        Rules assign categories to new and imported transactions automatically.
      </PageHead>
      <Callout tone="info">
        <strong>Precedence.</strong> Lower priority numbers run first and the first enabled matching rule wins. A rule never changes a category you set by hand, and never touches transfers or adjustments. New and imported transactions are only auto-categorized when they have no category; use the preview below to re-apply rules to existing data.
      </Callout>

      <div className="stack" style={{ marginTop: 16 }}>
        <Card title={`Rules (${rules.length})`}>
          {rules.length === 0 ? (
            <EmptyState title="No rules yet">Create a rule such as "merchant contains Green Basket → Groceries".</EmptyState>
          ) : (
            <DataTable
              caption="Categorization rules"
              rows={rules}
              rowKey={(r) => r.id}
              columns={[
                { key: 'priority', header: 'Priority', className: 'num', render: (r) => r.priority },
                { key: 'name', header: 'Rule', main: true, render: (r) => <div className="desc-cell"><div className="title">{r.name}</div><div className="sub">If {FIELD_LABELS[r.field]} {MATCH_LABELS[r.match]} "{r.pattern}"{r.accountId ? ` in ${index.accountsById.get(r.accountId)?.name}` : ''}{r.minAmountCents !== null || r.maxAmountCents !== null ? `, amount ${r.minAmountCents !== null ? `from ${formatMoney(r.minAmountCents)}` : ''} ${r.maxAmountCents !== null ? `to ${formatMoney(r.maxAmountCents)}` : ''}` : ''}</div></div> },
                { key: 'cat', header: 'Sets category', render: (r) => index.categoriesById.get(r.categoryId)?.name || '(missing)' },
                { key: 'matches', header: 'Matches now', className: 'num', render: (r) => matchCount(r) },
                { key: 'on', header: 'Enabled', render: (r) => <CheckField label={r.enabled ? 'On' : 'Off'} checked={r.enabled} onChange={(v) => run((d) => saveRule(d, { ...r, enabled: v, category: undefined, categoryId: r.categoryId }), { label: `${v ? 'enable' : 'disable'} rule`, success: v ? 'Rule enabled' : 'Rule disabled' })} /> },
                {
                  key: 'act',
                  header: 'Actions',
                  render: (r) => (
                    <span className="row">
                      <button type="button" className="btn small" onClick={() => setEditing(r)}>Edit</button>
                      <button type="button" className="btn small danger" onClick={async () => { if (await confirm({ title: `Delete rule "${r.name}"?`, danger: true, confirmLabel: 'Delete rule', message: 'Transactions it already categorized keep their categories.' })) run((d) => deleteRule(d, r.id), { label: 'delete rule', success: 'Rule deleted', undo: true }); }}>Delete</button>
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Card>

        <Card title="Preview and apply rules to existing transactions">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <SelectField label="Which transactions" value={scope} onChange={(v) => { setScope(v); setPreview(null); }} options={[{ value: 'uncategorized', label: 'Only uncategorized' }, { value: 'non_manual', label: 'Also ones categorized by a rule, import or demo data' }]} />
            <button type="button" className="btn" onClick={runPreview}>Preview changes</button>
          </div>
          <p className="small muted">Manually categorized transactions and split transactions are never included.</p>
          {preview && (
            preview.length === 0 ? (
              <Callout tone="success">No transactions would change.</Callout>
            ) : (
              <>
                <Callout tone="warn">{preview.length} transaction(s) would be recategorized. Untick any you want to leave alone, then apply.</Callout>
                <DataTable
                  caption="Preview of rule changes"
                  rows={preview}
                  rowKey={(c) => c.txId}
                  selectable
                  selected={picked}
                  onSelect={(id, on) => setPicked((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; })}
                  onSelectAll={(on) => setPicked(on ? new Set(preview.map((c) => c.txId)) : new Set())}
                  columns={[
                    { key: 'd', header: 'Date', render: (c) => formatDate(c.date) },
                    { key: 'desc', header: 'Transaction', main: true, render: (c) => c.description },
                    { key: 'from', header: 'From', render: (c) => (c.fromCategoryId ? index.categoriesById.get(c.fromCategoryId)?.name : 'Uncategorized') },
                    { key: 'to', header: 'To', render: (c) => <strong>{index.categoriesById.get(c.toCategoryId)?.name}</strong> },
                    { key: 'rule', header: 'Rule', render: (c) => c.ruleName },
                  ]}
                />
                <div className="actions" style={{ marginTop: 10 }}>
                  <button type="button" className="btn primary" disabled={picked.size === 0} onClick={apply}>Apply to {picked.size} transaction{picked.size === 1 ? '' : 's'}</button>
                  <button type="button" className="btn" onClick={() => setPreview(null)}>Cancel</button>
                </div>
              </>
            )
          )}
        </Card>

        <Card title={`Categories (${data.categories.length})`}>
          <DataTable
            caption="Categories"
            rows={data.categories.slice().sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))}
            rowKey={(c) => c.id}
            columns={[
              { key: 'name', header: 'Category', main: true, render: (c) => <span><span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: c.color || 'var(--muted)', marginRight: 6 }} />{c.name}{c.group ? <span className="muted small"> · {c.group}</span> : null}</span> },
              { key: 'kind', header: 'Type', render: (c) => <Badge tone={c.kind === 'income' ? 'pos' : ''}>{c.kind}</Badge> },
              { key: 'uses', header: 'Used by', render: (c) => { const u = usage(c.id); return `${u.transactions} tx · ${u.budgets} budget · ${u.rules} rules`; } },
              { key: 'act', header: 'Actions', render: (c) => <span className="row"><button type="button" className="btn small" onClick={() => setCatModal({ mode: 'edit', category: c })}>Rename</button><button type="button" className="btn small danger" onClick={() => setCatModal({ mode: 'delete', category: c })}>Delete</button></span> },
            ]}
          />
        </Card>
        <Explain summary="How category totals treat splits, refunds and transfers">
          <p>Reports add up each split to its own category, so the account is debited once while categories get their shares. A refund is a positive expense entry: it reduces the spending of its category. Transfers and adjustments have no category and are not spending.</p>
        </Explain>
      </div>
      {editing && <RuleModal rule={editing} onClose={() => setEditing(null)} />}
      {catModal && <CategoryModal state={catModal} onClose={() => setCatModal(null)} />}
    </>
  );
}

function RuleModal({ rule, onClose }) {
  const data = useData();
  const run = useRun();
  const index = useMemo(() => buildIndex(data), [data]);
  const [f, setF] = useState({
    name: rule.name || '',
    pattern: rule.pattern || '',
    field: rule.field || 'any',
    match: rule.match || 'contains',
    categoryId: rule.categoryId || '',
    accountId: rule.accountId || '',
    priority: String(rule.priority ?? 100),
    min: rule.minAmountCents !== null && rule.minAmountCents !== undefined ? centsToDecimalString(rule.minAmountCents) : '',
    max: rule.maxAmountCents !== null && rule.maxAmountCents !== undefined ? centsToDecimalString(rule.maxAmountCents) : '',
    enabled: rule.enabled !== false,
  });
  const [errors, setErrors] = useState([]);
  const fe = fieldErrors(errors);
  const set = (p) => setF((s) => ({ ...s, ...p }));
  const parsedMin = f.min ? parseMoney(f.min, { allowNegative: false }) : { ok: true, cents: null };
  const parsedMax = f.max ? parseMoney(f.max, { allowNegative: false }) : { ok: true, cents: null };
  const candidate = { id: rule.id, name: f.name, enabled: true, priority: Number(f.priority), field: f.field, match: f.match, pattern: f.pattern, categoryId: f.categoryId, accountId: f.accountId || null, minAmountCents: parsedMin.ok ? parsedMin.cents : null, maxAmountCents: parsedMax.ok ? parsedMax.cents : null };
  const matches = f.pattern.trim() && f.categoryId ? data.transactions.filter((t) => ruleMatches(candidate, t, index.categoriesById)) : [];
  const submit = (e) => {
    e.preventDefault();
    const errs = [];
    if (!parsedMin.ok) errs.push({ field: 'minAmountCents', message: parsedMin.error });
    if (!parsedMax.ok) errs.push({ field: 'maxAmountCents', message: parsedMax.error });
    if (!/^-?\d+$/.test(f.priority.trim())) errs.push({ field: 'priority', message: 'Priority must be a whole number.' });
    if (errs.length) return setErrors(errs);
    const r = run((d) => saveRule(d, { ...candidate, enabled: f.enabled, priority: Number(f.priority) }), { label: rule.id ? 'edit rule' : 'add rule', success: 'Rule saved', failTitle: 'Rule not saved', undo: true });
    if (r.ok) onClose();
    else setErrors(r.errors);
    return undefined;
  };
  return (
    <Modal title={rule.id ? 'Edit rule' : 'Add rule'} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form="rule-form" className="btn primary">Save rule</button></>}>
      <form id="rule-form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />
        <div className="form-grid">
          <TextField label="Rule name" value={f.name} onChange={(v) => set({ name: v })} error={fe.name} className="wide" />
          <SelectField label="Look at" value={f.field} onChange={(v) => set({ field: v })} options={[{ value: 'any', label: 'Merchant or description' }, { value: 'merchant', label: 'Merchant only' }, { value: 'description', label: 'Description only' }]} />
          <SelectField label="Match" value={f.match} onChange={(v) => set({ match: v })} options={[{ value: 'contains', label: 'contains' }, { value: 'starts_with', label: 'starts with' }, { value: 'equals', label: 'equals' }]} />
          <TextField label="Text" value={f.pattern} onChange={(v) => set({ pattern: v })} error={fe.pattern} hint="Case-insensitive plain text (no wildcards or code)." />
          <SelectField label="Set category" value={f.categoryId} onChange={(v) => set({ categoryId: v })} options={data.categories.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: `${c.name} (${c.kind})` }))} placeholder="Choose a category" error={fe.categoryId} />
          <SelectField label="Only in account (optional)" value={f.accountId} onChange={(v) => set({ accountId: v })} options={data.accounts.map((a) => ({ value: a.id, label: a.name }))} placeholder="Any account" />
          <TextField label="Priority (lower runs first)" value={f.priority} onChange={(v) => set({ priority: v })} error={fe.priority} inputMode="numeric" />
          <MoneyField label="Amount at least (optional)" value={f.min} onChange={(v) => set({ min: v })} error={fe.minAmountCents} />
          <MoneyField label="Amount at most (optional)" value={f.max} onChange={(v) => set({ max: v })} error={fe.maxAmountCents} />
          <CheckField label="Rule is enabled" checked={f.enabled} onChange={(v) => set({ enabled: v })} />
        </div>
        <p className="small" aria-live="polite">This rule would match <strong>{matches.length}</strong> existing transaction{matches.length === 1 ? '' : 's'} (of the same type as the category).</p>
      </form>
    </Modal>
  );
}

function CategoryModal({ state, onClose }) {
  const data = useData();
  const run = useRun();
  const cat = state.category;
  const [name, setName] = useState(cat?.name || '');
  const [kind, setKind] = useState(cat?.kind || 'expense');
  const [group, setGroup] = useState(cat?.group || '');
  const [reassign, setReassign] = useState('');
  const [errors, setErrors] = useState([]);
  const u = cat ? categoryUsage(data, cat.id) : null;
  const same = cat ? data.categories.filter((c) => c.kind === cat.kind && c.id !== cat.id) : [];
  const submit = (e) => {
    e.preventDefault();
    let r;
    if (state.mode === 'add') r = run((d) => addCategory(d, { name, kind, group }), { label: 'add category', success: 'Category added', undo: true });
    else if (state.mode === 'edit') r = run((d) => updateCategory(d, cat.id, { name, group }), { label: 'rename category', success: 'Category updated', undo: true });
    else r = run((d) => deleteCategory(d, cat.id, { reassignTo: reassign || null }), { label: 'delete category', success: 'Category deleted', undo: true });
    if (r.ok) onClose();
    else setErrors(r.errors);
  };
  return (
    <Modal title={state.mode === 'add' ? 'Add category' : state.mode === 'edit' ? 'Rename category' : `Delete "${cat.name}"`} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form="cat-form" className={`btn ${state.mode === 'delete' ? 'danger' : 'primary'}`}>{state.mode === 'delete' ? 'Delete category' : 'Save'}</button></>}>
      <form id="cat-form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />
        {state.mode === 'delete' ? (
          <>
            <Callout tone="warn">{u.transactions} transaction(s), {u.budgets} budget(s), {u.rules} rule(s) and {u.recurring} recurring item(s) use this category. Its budget and rules are deleted; transactions and recurring items move to the category below (or become uncategorized).</Callout>
            <SelectField label="Move them to" value={reassign} onChange={setReassign} options={same.map((c) => ({ value: c.id, label: c.name }))} placeholder="Uncategorized" />
          </>
        ) : (
          <div className="form-grid">
            <TextField label="Name" value={name} onChange={setName} />
            {state.mode === 'add' && <SelectField label="Type" value={kind} onChange={setKind} options={[{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }]} />}
            <TextField label="Group (optional)" value={group} onChange={setGroup} />
          </div>
        )}
      </form>
    </Modal>
  );
}
