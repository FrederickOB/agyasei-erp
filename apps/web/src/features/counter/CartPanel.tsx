/**
 * The draft cart. Quantities are scaled integers stepped in whole selling
 * units; line and cart totals are bigint arithmetic rendered only through
 * the Money boundary. Removing a line is immediate with undo — confirmation
 * dialogs train people to tap through dialogs (§8.7).
 */
import { useState, type ReactNode } from 'react';
import type { CartLineRow } from '../../data/queries/cart';
import { cartTotalMinor, lineTotalMinor } from '../../data/mutations/checkout';
import { formatQtyScaled, oneWholeUnit } from '../../lib/quantity';
import { Money } from '../../money/Money';

export interface RemovedLine {
  readonly line: CartLineRow;
}

export function CartPanel({
  lines,
  onSetQty,
  onRemove,
  onUndoRemove,
  removed,
  onTakePayment,
}: {
  readonly lines: readonly CartLineRow[];
  readonly onSetQty: (lineId: string, qtyScaled: bigint) => void;
  readonly onRemove: (line: CartLineRow) => void;
  readonly onUndoRemove: () => void;
  readonly removed: RemovedLine | null;
  readonly onTakePayment: () => void;
}): ReactNode {
  return (
    <section className="cart-panel" aria-label="Cart">
      {lines.length === 0 ? (
        <p className="cart-empty">Cart is empty. Tap a product to add it.</p>
      ) : (
        <ul className="cart-lines">
          {lines.map((line) => (
            <CartLineItem key={line.id} line={line} onSetQty={onSetQty} onRemove={onRemove} />
          ))}
        </ul>
      )}
      {removed !== null ? (
        <div className="undo-bar" role="status">
          <span>Removed {removed.line.name}</span>
          <button type="button" className="undo-button" onClick={onUndoRemove}>
            Undo
          </button>
        </div>
      ) : null}
      <footer className="cart-footer">
        <div className="cart-total-row">
          <span>Total</span>
          <Money amount={cartTotalMinor(lines)} className="money cart-total" />
        </div>
        <button
          type="button"
          className="primary-action"
          disabled={lines.length === 0}
          onClick={onTakePayment}
        >
          Take payment
        </button>
      </footer>
    </section>
  );
}

function CartLineItem({
  line,
  onSetQty,
  onRemove,
}: {
  readonly line: CartLineRow;
  readonly onSetQty: (lineId: string, qtyScaled: bigint) => void;
  readonly onRemove: (line: CartLineRow) => void;
}): ReactNode {
  const [pendingRemove, setPendingRemove] = useState(false);
  const step = oneWholeUnit(line.qtyScale);
  return (
    <li className={`cart-line${pendingRemove ? ' removing' : ''}`}>
      <div className="cart-line-main">
        <span className="cart-line-name">{line.name}</span>
        <Money amount={lineTotalMinor(line)} className="money cart-line-total" />
      </div>
      <div className="cart-line-controls">
        <button
          type="button"
          className="qty-button"
          aria-label={`One ${line.uomLabel} less`}
          onClick={() => {
            const next = line.qtyScaled - step;
            if (next <= 0n) {
              setPendingRemove(true);
              onRemove(line);
            } else {
              onSetQty(line.id, next);
            }
          }}
        >
          −
        </button>
        <span className="qty-display" aria-label="Quantity">
          {formatQtyScaled(line.qtyScaled, line.qtyScale)} {line.uomLabel}
        </span>
        <button
          type="button"
          className="qty-button"
          aria-label={`One ${line.uomLabel} more`}
          onClick={() => onSetQty(line.id, line.qtyScaled + step)}
        >
          +
        </button>
        <button
          type="button"
          className="line-remove"
          aria-label={`Remove ${line.name}`}
          onClick={() => {
            setPendingRemove(true);
            onRemove(line);
          }}
        >
          Remove
        </button>
      </div>
    </li>
  );
}
