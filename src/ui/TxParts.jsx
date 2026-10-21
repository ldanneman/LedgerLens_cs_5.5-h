import { Link } from 'react-router-dom';
import { Badge } from './components/Common.jsx';
import { counterpartLeg } from '../domain/ledger.js';

/** Category label for a transaction row. */
export function categoryLabel(tx, index) {
  if (tx.kind === 'transfer') return '-';
  if (tx.kind === 'adjustment') return tx.adjustmentKind === 'valuation' ? 'Valuation' : 'Adjustment';
  if (tx.splits.length) return `Split (${tx.splits.length})`;
  if (!tx.categoryId) return 'Uncategorized';
  return index.categoriesById.get(tx.categoryId)?.name || '(missing category)';
}

/** Status/flag badges: pending, split, transfer link, recurring, reconciled, imported. */
export function TxBadges({ tx, index, reconciledIds, recurringById }) {
  const chips = [];
  if (tx.status === 'pending') chips.push(<Badge key="p" tone="warn" title="Pending: counts toward available balance, not the posted balance">Pending</Badge>);
  if (tx.splits.length) chips.push(<Badge key="s" tone="info" title="Divided across categories">Split</Badge>);
  if (tx.kind === 'transfer') {
    const tr = index.transfersById.get(tx.transferId);
    if (tr?.external) chips.push(<Badge key="x" title="Money to or from an account outside LedgerLens">External: {tr.counterparty}</Badge>);
    else {
      const other = counterpartLeg(index, tx);
      const name = other ? index.accountsById.get(other.accountId)?.name : null;
      chips.push(<Badge key="t" tone="info" title="Linked transfer: both sides are recorded together">{tx.amountCents < 0 ? 'to' : 'from'} {name || 'linked account'}</Badge>);
    }
  }
  if (tx.recurrence) chips.push(<Badge key="r" title="Matched to a recurring item">{recurringById?.get(tx.recurrence.ruleId)?.title ? `Recurring: ${recurringById.get(tx.recurrence.ruleId).title}` : 'Recurring'}</Badge>);
  if (tx.kind === 'expense' && tx.amountCents > 0) chips.push(<Badge key="f" tone="info" title="Reduces spending">Refund</Badge>);
  if (tx.reversalOf) chips.push(<Badge key="v" title={`Reverses ${tx.reversalOf}`}>Reversal</Badge>);
  if (reconciledIds?.has(tx.id)) chips.push(<Badge key="c" tone="pos" title="Cleared in a completed reconciliation">Reconciled</Badge>);
  if (tx.source?.type === 'import') chips.push(<Badge key="i" title={tx.source.externalId ? `Imported, reference ${tx.source.externalId}` : 'Imported'}>Imported</Badge>);
  for (const t of tx.tags) chips.push(<Badge key={`tag-${t}`}>#{t}</Badge>);
  return chips.length ? <div className="chips">{chips}</div> : null;
}

/** Link to an account page. */
export function AccountLink({ account }) {
  if (!account) return <span className="muted">(removed)</span>;
  return <Link to={`/accounts/${encodeURIComponent(account.id)}`}>{account.name}</Link>;
}
