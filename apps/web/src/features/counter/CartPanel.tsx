/**
 * The draft cart. Quantities are scaled integers stepped in whole selling
 * units; line and cart totals are bigint arithmetic rendered only through
 * the Money boundary. Removing a line is immediate with undo — confirmation
 * dialogs train people to tap through dialogs (§8.7).
 *
 * TWO SHAPES, ONE PANEL. On a tablet it is a column docked beside the
 * catalogue and always in view. On a phone it is a sheet raised from the cart
 * bar, because a phone cannot show both and the catalogue is what the hands
 * are working in. The previous layout stacked the cart BELOW the whole
 * catalogue: on a phone the running total and the pay button were a full
 * scroll away from every tap that changed them, which is how a counter loses
 * track of what it has rung.
 *
 * The line list scrolls inside the panel; the total and the primary action
 * never do. What someone is about to charge should not be something they have
 * to go and find.
 */
import { useState, type ReactNode } from 'react';
import type { CartLineRow } from '../../data/queries/cart';
import { cartTotalMinor, lineTotalMinor } from '../../data/mutations/checkout';
import { formatQtyScaled, oneWholeUnit } from '../../lib/quantity';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';

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
  sellable = true,
  variant = 'dock',
  modal = false,
  onClose,
}: {
  readonly lines: readonly CartLineRow[];
  readonly onSetQty: (lineId: string, qtyScaled: bigint) => void;
  readonly onRemove: (line: CartLineRow) => void;
  readonly onUndoRemove: () => void;
  readonly removed: RemovedLine | null;
  readonly onTakePayment: () => void;
  /**
   * False when this cart's price list is not one the counter may sell from
   * (data/session/device-price-list.ts). The lines stay on screen — they are
   * what gets re-rung — but there is nothing to take payment for.
   */
  readonly sellable?: boolean;
  readonly variant?: 'dock' | 'sheet';
  /** True only when this really is a modal sheet — see ui/use-media-query.ts. */
  readonly modal?: boolean;
  readonly onClose?: () => void;
}): ReactNode {
  const sheet = variant === 'sheet';
  return (
    <section
      className={`cart-panel${sheet ? ' cart-sheet' : ''}`}
      aria-label="Cart"
      {...(modal ? { role: 'dialog' as const, 'aria-modal': true } : {})}
    >
      <div className="cart-head">
        <Icon name="cart" size={22} />
        <span>Cart</span>
        <span className="cart-count">{lines.length}</span>
        {onClose !== undefined ? (
          <button
            type="button"
            className="sheet-close pressable"
            aria-label="Close cart"
            onClick={onClose}
          >
            <Icon name="close" size={20} />
          </button>
        ) : null}
      </div>

      {lines.length === 0 ? (
        <div className="empty-state">
          <Icon name="cart" size={36} />
          <span className="empty-title">Cart is empty</span>
          <p className="empty-body">Tap a product to add it.</p>
        </div>
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
          <button type="button" className="undo-button pressable" onClick={onUndoRemove}>
            <Icon name="undo" size={18} />
            Undo
          </button>
        </div>
      ) : null}

      <footer className="cart-footer">
        <div className="total-row">
          <span className="total-label">Total</span>
          <Money amount={cartTotalMinor(lines)} className="money total-value cart-total" />
        </div>
        <button
          type="button"
          className="primary-action pressable"
          disabled={lines.length === 0 || !sellable}
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
          className="qty-button pressable"
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
          <Icon name="minus" size={22} />
        </button>
        <span className="qty-display tabular" aria-label="Quantity">
          {formatQtyScaled(line.qtyScaled, line.qtyScale)} {line.uomLabel}
        </span>
        <button
          type="button"
          className="qty-button pressable"
          aria-label={`One ${line.uomLabel} more`}
          onClick={() => onSetQty(line.id, line.qtyScaled + step)}
        >
          <Icon name="plus" size={22} />
        </button>
        <button
          type="button"
          className="line-remove pressable"
          aria-label={`Remove ${line.name}`}
          onClick={() => {
            setPendingRemove(true);
            onRemove(line);
          }}
        >
          <Icon name="trash" size={20} />
        </button>
      </div>
    </li>
  );
}
