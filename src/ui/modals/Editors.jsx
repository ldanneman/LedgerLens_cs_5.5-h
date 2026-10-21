import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Modal } from '../components/Modal.jsx';
import { CheckField, ErrorSummary, MoneyField, SelectField, TextAreaField, TextField, fieldErrors } from '../components/Form.jsx';
import { Callout } from '../components/Common.jsx';
import { useData, useRun, useStore } from '../../state/hooks.jsx';
import { addTransaction, updateTransaction, addTransfer, updateTransfer, addExternalTransfer } from '../../domain/ops/transactions.js';
import { addAccount, updateAccount } from '../../domain/ops/accounts.js';
import { buildIndex, isLiabilityType } from '../../domain/ledger.js';
import { reconciliationsContaining } from '../../domain/reconciliation.js';
import { parseMoney, parsePercentToBps, formatMoney, centsToDecimalString, formatBps } from '../../domain/money.js';
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, LOAN_TYPES, PAYMENT_MODES } from '../../domain/schema.js';
import { loanPayment } from '../../domain/debt.js';

const EditorsContext = createContext(null);

/** Lets any page open the shared editors: openTransaction({id?|defaults}), openTransfer({...}), openAccount({id?}). */
export function useEditors() {
  const c = useContext(EditorsContext);
  if (!c) throw new Error('useEditors must be used inside <EditorsProvider>');
  return c;
}

export function EditorsProvider({ children }) {
  const [tx, setTx] = useState(null);
  const [xfer, setXfer] = useState(null);
  const [acct, setAcct] = useState(null);
  const api = useMemo(
    () => ({
      openTransaction: (opts = {}) => setTx(opts),
      openTransfer: (opts = {}) => setXfer(opts),
      openAccount: (opts = {}) => setAcct(opts),
    }),
    [],
  );
  const dataTx = tx;
  return (
    <EditorsContext.Provider value={api}>
      {children}
      {dataTx && <TransactionModal opts={dataTx} onClose={() => setTx(null)} />}
      {xfer && <TransferModal opts={xfer} onClose={() => setXfer(null)} />}
      {acct && <AccountModal opts={acct} onClose={() => setAcct(null)} />}
    </EditorsContext.Provider>
  );
}

const UI_TYPES = [
  { value: 'expense', label: 'Expense (money spent)' },
  { value: 'refund', label: 'Refund / reimbursement (reduces spending)' },
  { value: 'income', label: 'Income' },
  { value: 'reversal', label: 'Income reversal' },
  { value: 'adjustment', label: 'Adjustment (non-cash)' },
];

function uiTypeOf(tx) {
  if (tx.kind === 'adjustment') return 'adjustment';
  if (tx.kind === 'income') return tx.amountCents < 0 ? 'reversal' : 'income';
  return tx.amountCents > 0 ? 'refund' : 'expense';
}

const activeAccountOptions = (data, keepId) =>
  data.accounts.filter((a) => a.status === 'active' || a.id === keepId).map((a) => ({ value: a.id, label: `${a.name}${a.status === 'archived' ? ' (archived)' : ''}` }));

function TransactionModal({ opts, onClose }) {
  const data = useData();
  const run = useRun();
  const store = useStore();
  const index = buildIndex(data);
  const existing = opts.id ? index.txById.get(opts.id) : null;
  const d = opts.defaults || {};
  const init = existing
    ? {
        uiType: uiTypeOf(existing),
        accountId: existing.accountId,
        date: existing.date,
        description: existing.description,
        merchant: existing.merchant,
        amount: centsToDecimalString(Math.abs(existing.amountCents)),
        status: existing.status,
        categoryId: existing.categoryId || '',
        split: existing.splits.length > 0,
        splits: existing.splits.length ? existing.splits.map((s) => ({ categoryId: s.categoryId, amount: centsToDecimalString(Math.abs(s.amountCents)), note: s.note })) : [],
        notes: existing.notes,
        tags: existing.tags.join(', '),
        adjustmentKind: existing.adjustmentKind || 'correction',
        adjDir: existing.amountCents < 0 ? 'decrease' : 'increase',
      }
    : {
        uiType: d.uiType || 'expense',
        accountId: d.accountId || data.accounts.find((a) => a.status === 'active')?.id || '',
        date: d.date || data.settings.asOfDate,
        description: d.description || '',
        merchant: '',
        amount: d.amount || '',
        status: 'posted',
        categoryId: d.categoryId || '',
        split: Boolean(d.split),
        splits: d.split ? [{ categoryId: '', amount: '', note: '' }, { categoryId: '', amount: '', note: '' }] : [],
        notes: '',
        tags: '',
        adjustmentKind: 'correction',
        adjDir: 'increase',
      };
  const [f, setF] = useState(init);
  const [errors, setErrors] = useState([]);
  const set = (patch) => setF((p) => ({ ...p, ...patch }));
  const fe = fieldErrors(errors);
  const isIncomeSide = f.uiType === 'income' || f.uiType === 'reversal';
  const isAdj = f.uiType === 'adjustment';
  const catKind = isIncomeSide ? 'income' : 'expense';
  const catOptions = data.categories
    .filter((c) => c.kind === catKind)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ value: c.id, label: c.group ? `${c.name} (${c.group})` : c.name }));
  const sign = f.uiType === 'expense' || f.uiType === 'reversal' ? -1 : f.uiType === 'adjustment' ? (f.adjDir === 'decrease' ? -1 : 1) : 1;
  const parsedAmount = parseMoney(f.amount, { allowNegative: false });
  const splitParsed = f.splits.map((s) => parseMoney(s.amount, { allowNegative: false }));
  const allocated = splitParsed.reduce((sum, p) => sum + (p.ok ? p.cents : 0), 0);
  const remaining = parsedAmount.ok ? parsedAmount.cents - allocated : null;
  const recs = existing ? reconciliationsContaining(data, existing.id) : [];
  const accountOptions = activeAccountOptions(data, existing?.accountId);

  const submit = (e) => {
    e.preventDefault();
    const errs = [];
    if (!parsedAmount.ok) errs.push({ field: 'amountCents', message: parsedAmount.error });
    const useSplits = f.split && !isAdj;
    const splits = [];
    if (useSplits) {
      f.splits.forEach((s, i) => {
        const p = splitParsed[i];
        if (!p.ok) errs.push({ field: 'splits', message: `Split ${i + 1}: ${p.error}` });
        else splits.push({ categoryId: s.categoryId || null, amountCents: sign * p.cents, note: s.note });
      });
    }
    if (errs.length) {
      setErrors(errs);
      return;
    }
    const kind = isAdj ? 'adjustment' : isIncomeSide ? 'income' : 'expense';
    const input = {
      accountId: f.accountId,
      date: f.date,
      description: f.description,
      merchant: f.merchant,
      amountCents: sign * parsedAmount.cents,
      kind,
      status: f.status,
      adjustmentKind: isAdj ? f.adjustmentKind : null,
      categoryId: isAdj || useSplits ? null : f.categoryId || null,
      splits: useSplits ? splits : [],
      notes: f.notes,
      tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
    };
    const res = run(
      (dd) => (existing ? updateTransaction(dd, existing.id, input) : addTransaction(dd, input, { now: new Date().toISOString() })),
      { label: existing ? `edit "${f.description}"` : `add "${f.description}"`, success: existing ? 'Transaction updated' : 'Transaction added', failTitle: 'Transaction not saved', undo: true },
    );
    if (res.ok) onClose();
    else setErrors(res.errors);
    void store;
  };

  const updateSplit = (i, patch) => set({ splits: f.splits.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const fillRemainder = (i) => {
    if (remaining === null) return;
    const cur = splitParsed[i].ok ? splitParsed[i].cents : 0;
    updateSplit(i, { amount: centsToDecimalString(Math.max(0, cur + remaining)) });
  };

  return (
    <Modal
      title={existing ? 'Edit transaction' : 'Add transaction'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="tx-form" className="btn primary">
            {existing ? 'Save changes' : 'Add transaction'}
          </button>
        </>
      }
    >
      <form id="tx-form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />
        {recs.length > 0 && <Callout tone="warn">This transaction was cleared in a completed reconciliation. Changing its amount, date, account or status marks that reconciliation as out of date.</Callout>}
        <div className="form-grid" style={{ marginTop: recs.length ? 12 : 0 }}>
          <SelectField label="Type" value={f.uiType} onChange={(v) => set({ uiType: v, categoryId: '', splits: f.splits.map((s) => ({ ...s, categoryId: '' })) })} options={UI_TYPES} className="wide" />
          <SelectField label="Account" value={f.accountId} onChange={(v) => set({ accountId: v })} options={accountOptions} error={fe.accountId} />
          <TextField label="Date" type="date" value={f.date} onChange={(v) => set({ date: v })} error={fe.date} />
          <MoneyField label={isAdj ? 'Amount of change' : 'Amount'} value={f.amount} onChange={(v) => set({ amount: v })} error={fe.amountCents} hint={isAdj ? undefined : sign < 0 ? 'Enter a positive number; it is recorded as money out.' : 'Enter a positive number; it is recorded as money in.'} />
          <SelectField label="Status" value={f.status} onChange={(v) => set({ status: v })} options={[{ value: 'posted', label: 'Posted' }, { value: 'pending', label: 'Pending' }]} error={fe.status} />
          <TextField label="Description" value={f.description} onChange={(v) => set({ description: v })} error={fe.description} className="wide" />
          <TextField label="Merchant (optional)" value={f.merchant} onChange={(v) => set({ merchant: v })} error={fe.merchant} />
          {isAdj ? (
            <>
              <SelectField label="Adjustment kind" value={f.adjustmentKind} onChange={(v) => set({ adjustmentKind: v })} options={[{ value: 'valuation', label: 'Market valuation change' }, { value: 'correction', label: 'Balance correction' }]} error={fe.adjustmentKind} />
              <SelectField label="Direction" value={f.adjDir} onChange={(v) => set({ adjDir: v })} options={[{ value: 'increase', label: 'Increases the balance' }, { value: 'decrease', label: 'Decreases the balance' }]} />
            </>
          ) : (
            <>
              {!f.split && <SelectField label="Category" value={f.categoryId} onChange={(v) => set({ categoryId: v })} options={catOptions} placeholder="Uncategorized (rules may fill this in)" error={fe.categoryId} />}
              <div className="field">
                <span className="label">Category splits</span>
                <CheckField label="Split across categories" checked={f.split} onChange={(v) => set({ split: v, splits: v && f.splits.length < 2 ? [{ categoryId: '', amount: '', note: '' }, { categoryId: '', amount: '', note: '' }] : f.splits })} />
              </div>
            </>
          )}
        </div>
        {f.split && !isAdj && (
          <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 12, padding: 12 }}>
            <legend className="small" style={{ fontWeight: 650 }}>Splits (must add up exactly to the amount)</legend>
            {f.splits.map((s, i) => (
              <div key={i} className="form-grid" style={{ marginBottom: 8, alignItems: 'end' }}>
                <SelectField label={`Split ${i + 1} category`} value={s.categoryId || ''} onChange={(v) => updateSplit(i, { categoryId: v })} options={catOptions} placeholder="Choose a category" />
                <MoneyField label={`Split ${i + 1} amount`} value={s.amount} onChange={(v) => updateSplit(i, { amount: v })} error={splitParsed[i] && !splitParsed[i].ok && s.amount ? splitParsed[i].error : undefined} />
                <div className="row">
                  <button type="button" className="btn small" onClick={() => fillRemainder(i)} disabled={remaining === null || remaining === 0}>
                    Use remainder
                  </button>
                  <button type="button" className="btn small" onClick={() => set({ splits: f.splits.filter((_, j) => j !== i) })} disabled={f.splits.length <= 2} aria-label={`Remove split ${i + 1}`}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <div className="row between">
              <button type="button" className="btn small" onClick={() => set({ splits: [...f.splits, { categoryId: '', amount: '', note: '' }] })} disabled={f.splits.length >= 25}>
                Add split row
              </button>
              <span aria-live="polite" className={remaining === 0 ? 'amt pos' : 'amt neg'}>
                {remaining === null ? 'Enter the total amount first' : remaining === 0 ? `Allocated ${formatMoney(allocated)} - matches exactly` : `Allocated ${formatMoney(allocated)}; ${formatMoney(Math.abs(remaining))} ${remaining > 0 ? 'left to allocate' : 'over-allocated'}`}
              </span>
            </div>
            {fe.splits && <p className="error-text" role="alert">{fe.splits}</p>}
          </fieldset>
        )}
        <div className="form-grid" style={{ marginTop: 12 }}>
          <TextField label="Tags (comma separated)" value={f.tags} onChange={(v) => set({ tags: v })} error={fe.tags} />
          <TextAreaField label="Notes" value={f.notes} onChange={(v) => set({ notes: v })} error={fe.notes} className="wide" rows={2} />
        </div>
      </form>
    </Modal>
  );
}

function TransferModal({ opts, onClose }) {
  const data = useData();
  const run = useRun();
  const index = buildIndex(data);
  const existing = opts.transferId ? index.transfersById.get(opts.transferId) : null;
  const legs = existing ? index.legsByTransfer.get(existing.id) || [] : [];
  const fromLeg = legs.find((l) => l.amountCents < 0);
  const toLeg = legs.find((l) => l.amountCents > 0);
  const activeAccounts = data.accounts.filter((a) => a.status === 'active' || [fromLeg?.accountId, toLeg?.accountId, legs[0]?.accountId].includes(a.id));
  const options = activeAccounts.map((a) => ({ value: a.id, label: a.name }));
  const d = opts.defaults || {};
  const external = existing ? existing.external : Boolean(d.external);
  const [f, setF] = useState({
    external,
    from: fromLeg?.accountId || d.from || activeAccounts[0]?.id || '',
    to: toLeg?.accountId || d.to || activeAccounts[1]?.id || '',
    amount: existing ? centsToDecimalString(Math.abs((fromLeg || toLeg || legs[0])?.amountCents || 0)) : d.amount || '',
    date: legs[0]?.date || d.date || data.settings.asOfDate,
    status: legs[0]?.status || 'posted',
    description: existing ? legs[0]?.description || '' : d.description || '',
    memo: existing?.memo || '',
    direction: legs[0] && legs[0].amountCents > 0 ? 'in' : 'out',
    counterparty: existing?.counterparty || '',
    extAccount: legs[0]?.accountId || d.from || activeAccounts[0]?.id || '',
  });
  const [errors, setErrors] = useState([]);
  const set = (p) => setF((s) => ({ ...s, ...p }));
  const fe = fieldErrors(errors);
  const a = parseMoney(f.amount, { allowNegative: false });
  const fromAcct = index.accountsById.get(f.from);
  const toAcct = index.accountsById.get(f.to);
  const isPayment = fromAcct && toAcct && !isLiabilityType(fromAcct.type) && isLiabilityType(toAcct.type);

  const submit = (e) => {
    e.preventDefault();
    if (!a.ok) {
      setErrors([{ field: 'amountCents', message: a.error }]);
      return;
    }
    let op;
    if (existing) {
      op = (dd) => updateTransfer(dd, existing.id, existing.external ? { amountCents: a.cents, date: f.date, status: f.status, description: f.description } : { fromAccountId: f.from, toAccountId: f.to, amountCents: a.cents, date: f.date, status: f.status, description: f.description || undefined, memo: f.memo });
    } else if (f.external) {
      op = (dd) => addExternalTransfer(dd, { accountId: f.extAccount, direction: f.direction, amountCents: a.cents, date: f.date, counterparty: f.counterparty, description: f.description, status: f.status });
    } else {
      op = (dd) => addTransfer(dd, { fromAccountId: f.from, toAccountId: f.to, amountCents: a.cents, date: f.date, status: f.status, description: f.description, memo: f.memo });
    }
    const res = run(op, { label: existing ? 'edit transfer' : 'transfer funds', success: existing ? 'Transfer updated' : 'Transfer recorded', failTitle: 'Transfer not saved', undo: true });
    if (res.ok) onClose();
    else setErrors(res.errors);
  };

  return (
    <Modal
      title={existing ? 'Edit transfer' : f.external ? 'Transfer to/from an outside account' : 'Transfer funds'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="xfer-form" className="btn primary">{existing ? 'Save changes' : 'Record transfer'}</button>
        </>
      }
    >
      <form id="xfer-form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />
        <p className="small muted">
          A transfer moves money between your accounts. Both sides are recorded together, net worth does not change, and it never counts as income or spending. Paying a credit card or loan is a transfer.
        </p>
        {!existing && <CheckField label="This money goes to / comes from an account outside LedgerLens" checked={f.external} onChange={(v) => set({ external: v })} hint="Recorded as a single leg that changes net worth but is shown on its own line, not as income or spending." />}
        <div className="form-grid" style={{ marginTop: 12 }}>
          {f.external ? (
            <>
              <SelectField label="Your account" value={f.extAccount} onChange={(v) => set({ extAccount: v })} options={options} error={fe.accountId} disabled={Boolean(existing)} />
              <SelectField label="Direction" value={f.direction} onChange={(v) => set({ direction: v })} options={[{ value: 'out', label: 'Money leaves (sent out)' }, { value: 'in', label: 'Money arrives (received)' }]} disabled={Boolean(existing)} />
              <TextField label="Outside account / person" value={f.counterparty} onChange={(v) => set({ counterparty: v })} error={fe.counterparty} disabled={Boolean(existing)} />
            </>
          ) : (
            <>
              <SelectField label="From account" value={f.from} onChange={(v) => set({ from: v })} options={options} error={fe.fromAccountId} />
              <SelectField label="To account" value={f.to} onChange={(v) => set({ to: v })} options={options} error={fe.toAccountId} />
            </>
          )}
          <MoneyField label="Amount" value={f.amount} onChange={(v) => set({ amount: v })} error={fe.amountCents} />
          <TextField label="Date" type="date" value={f.date} onChange={(v) => set({ date: v })} error={fe.date} />
          <SelectField label="Status" value={f.status} onChange={(v) => set({ status: v })} options={[{ value: 'posted', label: 'Posted' }, { value: 'pending', label: 'Pending' }]} />
          <TextField label="Description (optional)" value={f.description} onChange={(v) => set({ description: v })} error={fe.description} />
          {!f.external && <TextField label="Memo (optional)" value={f.memo} onChange={(v) => set({ memo: v })} className="wide" />}
        </div>
        {!f.external && isPayment && a.ok && (
          <Callout tone="info">
            This is a payment toward {toAcct.name}: {fromAcct.name} goes down by {formatMoney(a.cents)} and the amount owed on {toAcct.name} goes down by the same amount. The original purchases were already counted as spending.
          </Callout>
        )}
      </form>
    </Modal>
  );
}

const PAYMENT_MODE_LABELS = { fixed: 'Fixed payment', minimum: 'Minimum payment', pay_in_full: 'Pay in full each month' };

function AccountModal({ opts, onClose }) {
  const data = useData();
  const run = useRun();
  const existing = opts.id ? data.accounts.find((a) => a.id === opts.id) : null;
  const liabilityInit = existing ? isLiabilityType(existing.type) : false;
  const [f, setF] = useState(() => ({
    name: existing?.name || '',
    type: existing?.type || opts.type || 'checking',
    institution: existing?.institution || '',
    opening: existing ? centsToDecimalString(liabilityInit ? -existing.openingCents : existing.openingCents) : '0.00',
    openingDate: existing?.openingDate || data.settings.asOfDate,
    apr: existing ? String(existing.aprBps / 100) : '0',
    limit: existing?.creditLimitCents ? centsToDecimalString(existing.creditLimitCents) : '',
    payment: existing?.scheduledPaymentCents ? centsToDecimalString(existing.scheduledPaymentCents) : '',
    paymentMode: existing?.paymentMode || 'fixed',
    minPct: existing ? String(existing.minPaymentBps / 100) : '1',
    minFloor: existing?.minPaymentFloorCents ? centsToDecimalString(existing.minPaymentFloorCents) : '',
    dueDay: existing?.dueDay ?? '',
    statementDay: existing?.statementDay ?? '',
    autopay: existing?.autopayAccountId || '',
    principal: existing?.loan ? centsToDecimalString(existing.loan.originalPrincipalCents) : '',
    term: existing?.loan ? String(existing.loan.termMonths) : '',
    loanStart: existing?.loan?.startDate || '',
    notes: existing?.notes || '',
  }));
  const [errors, setErrors] = useState([]);
  const set = (p) => setF((s) => ({ ...s, ...p }));
  const fe = fieldErrors(errors);
  const liability = isLiabilityType(f.type);
  const isLoan = LOAN_TYPES.includes(f.type);
  const isCard = f.type === 'credit_card';
  const rateRelevant = liability || f.type === 'savings';

  const submit = (e) => {
    e.preventDefault();
    const errs = [];
    const opening = parseMoney(f.opening || '0');
    if (!opening.ok) errs.push({ field: 'openingCents', message: opening.error });
    const apr = f.apr === '' ? { ok: true, bps: 0 } : parsePercentToBps(f.apr);
    if (!apr.ok) errs.push({ field: 'aprBps', message: apr.error });
    const money = (v, field) => {
      if (v === '' || v === null) return null;
      const r = parseMoney(v, { allowNegative: false });
      if (!r.ok) {
        errs.push({ field, message: r.error });
        return null;
      }
      return r.cents;
    };
    const limit = money(f.limit, 'creditLimitCents');
    const payment = money(f.payment, 'scheduledPaymentCents');
    const floor = money(f.minFloor, 'minPaymentFloorCents');
    const principal = isLoan ? money(f.principal, 'loan') : null;
    const minPct = f.minPct === '' ? { ok: true, bps: 0 } : parsePercentToBps(f.minPct);
    if (!minPct.ok) errs.push({ field: 'minPaymentBps', message: minPct.error });
    if (errs.length) {
      setErrors(errs);
      return;
    }
    const dayOrNull = (v) => (v === '' || v === null ? null : Number(v));
    const input = {
      name: f.name,
      type: f.type,
      institution: f.institution,
      openingCents: liability ? -Math.abs(opening.cents) : opening.cents,
      openingDate: f.openingDate,
      aprBps: apr.bps,
      creditLimitCents: isCard ? limit : null,
      scheduledPaymentCents: liability ? payment : null,
      paymentMode: liability ? f.paymentMode : 'fixed',
      minPaymentBps: liability ? minPct.bps : 0,
      minPaymentFloorCents: liability ? floor || 0 : 0,
      dueDay: liability ? dayOrNull(f.dueDay) : null,
      statementDay: isCard ? dayOrNull(f.statementDay) : null,
      autopayAccountId: liability ? f.autopay || null : null,
      loan: isLoan && principal ? { originalPrincipalCents: principal, termMonths: Number(f.term), startDate: f.loanStart } : null,
      notes: f.notes,
    };
    const res = run((dd) => (existing ? updateAccount(dd, existing.id, existing.type === f.type ? withoutType(input) : input) : addAccount(dd, input)), {
      label: existing ? `edit account ${f.name}` : `add account ${f.name}`,
      success: existing ? 'Account updated' : 'Account created',
      failTitle: 'Account not saved',
      undo: true,
    });
    if (res.ok) onClose();
    else setErrors(res.errors);
  };

  const suggest = () => {
    const p = parseMoney(f.principal, { allowNegative: false });
    const r = parsePercentToBps(f.apr || '0');
    if (p.ok && r.ok && Number(f.term) > 0) set({ payment: centsToDecimalString(loanPayment(p.cents, r.bps, Number(f.term))) });
  };

  const payers = data.accounts.filter((a) => a.status === 'active' && !isLiabilityType(a.type) && a.id !== existing?.id).map((a) => ({ value: a.id, label: a.name }));

  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : 'Add account'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="acct-form" className="btn primary">{existing ? 'Save changes' : 'Create account'}</button>
        </>
      }
    >
      <form id="acct-form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />
        <div className="form-grid">
          <TextField label="Account name" value={f.name} onChange={(v) => set({ name: v })} error={fe.name} />
          <SelectField label="Type" value={f.type} onChange={(v) => set({ type: v })} options={ACCOUNT_TYPES.map((t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] }))} error={fe.type} hint={existing ? 'Asset and liability types cannot be swapped once there is history.' : undefined} />
          <TextField label="Institution (optional)" value={f.institution} onChange={(v) => set({ institution: v })} error={fe.institution} />
          <MoneyField label={liability ? 'Amount owed on opening date' : 'Opening balance'} value={f.opening} onChange={(v) => set({ opening: v })} error={fe.openingCents} hint={liability ? 'Enter what you owe as a positive number; it is stored as a negative net-worth contribution.' : 'Balance on the opening date; later transactions build on it.'} />
          <TextField label="Opening date" type="date" value={f.openingDate} onChange={(v) => set({ openingDate: v })} error={fe.openingDate} />
          {rateRelevant && <TextField label={f.type === 'savings' ? 'Interest rate earned (APR %)' : 'Interest rate (APR %)'} value={f.apr} onChange={(v) => set({ apr: v })} error={fe.aprBps} inputMode="decimal" />}
          {isCard && <MoneyField label="Credit limit" value={f.limit} onChange={(v) => set({ limit: v })} error={fe.creditLimitCents} />}
          {liability && (
            <>
              <SelectField label="Payment mode" value={f.paymentMode} onChange={(v) => set({ paymentMode: v })} options={PAYMENT_MODES.map((m) => ({ value: m, label: PAYMENT_MODE_LABELS[m] }))} error={fe.paymentMode} />
              {f.paymentMode === 'fixed' && <MoneyField label="Scheduled monthly payment" value={f.payment} onChange={(v) => set({ payment: v })} error={fe.scheduledPaymentCents} />}
              {f.paymentMode === 'minimum' && (
                <>
                  <TextField label="Minimum: % of balance (plus interest)" value={f.minPct} onChange={(v) => set({ minPct: v })} error={fe.minPaymentBps} />
                  <MoneyField label="Minimum payment floor" value={f.minFloor} onChange={(v) => set({ minFloor: v })} error={fe.minPaymentFloorCents} />
                </>
              )}
              <TextField label="Payment due day (1-31)" type="number" min="1" max="31" value={f.dueDay} onChange={(v) => set({ dueDay: v })} error={fe.dueDay} />
              {isCard && <TextField label="Statement day (1-31)" type="number" min="1" max="31" value={f.statementDay} onChange={(v) => set({ statementDay: v })} error={fe.statementDay} />}
              <SelectField label="Pay from (forecast)" value={f.autopay} onChange={(v) => set({ autopay: v })} options={payers} placeholder="Primary checking" error={fe.autopayAccountId} />
            </>
          )}
          {isLoan && (
            <>
              <MoneyField label="Original loan amount" value={f.principal} onChange={(v) => set({ principal: v })} error={fe.loan} />
              <TextField label="Term (months)" type="number" min="1" value={f.term} onChange={(v) => set({ term: v })} />
              <TextField label="First loan date" type="date" value={f.loanStart} onChange={(v) => set({ loanStart: v })} />
              <div className="field">
                <span className="label">Payment helper</span>
                <button type="button" className="btn small" onClick={suggest}>Calculate level payment from terms</button>
                <span className="hint">Fills the scheduled payment using the standard loan formula.</span>
              </div>
            </>
          )}
          <TextAreaField label="Notes" value={f.notes} onChange={(v) => set({ notes: v })} className="wide" rows={2} />
        </div>
        {existing && <p className="small muted">Current APR: {formatBps(existing.aprBps)}. Changing the opening balance or date shifts every balance from that date on.</p>}
      </form>
    </Modal>
  );
}

const withoutType = ({ type, ...rest }) => {
  void type;
  return rest;
};

export { useCallback };
