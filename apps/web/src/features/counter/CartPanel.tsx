/**
 * The sale ticket. Quantities are scaled integers stepped in whole selling
 * units; line and cart totals are bigint arithmetic rendered only through
 * the Money boundary. Removing a line is immediate with undo — confirmation
 * dialogs train people to tap through dialogs (§8.7).
 *
 * TWO SHAPES, ONE PANEL. On a wide screen it is the right-hand column of the
 * register, the full height of the screen, always in view — the layout every
 * serious counter app converges on. On a phone or a portrait tablet it is a
 * sheet raised from the checkout dock, because the catalogue is what the
 * hands are working in.
 *
 * The line list scrolls inside the panel; the total and the primary action
 * never do. What someone is about to charge should not be something they have
 * to go and find.
 */
import { useState, type ReactNode } from 'react';
import { lineNetMinor } from '@erp/money';
import type { CartLineRow } from '../../data/queries/cart';
import {
  lineTotalMinor,
  priceCart,
  type CartPricing,
} from '../../data/pricing/cart-pricing';
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
  pricing,
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
   * What the cart comes to, and its tax split when this device can state one
   * (data/pricing/cart-pricing.ts). Passed in rather than recomputed here so
   * the footer, the amount due and the recorded sale are one number.
   */
  readonly pricing?: CartPricing;
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
      {sheet ? <span className="sheet-grip" aria-hidden="true" /> : null}
      <div className="cart-head">
        <span className="cart-title">Current sale</span>
        <span className="cart-count tabular">{lines.length}</span>
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
        <div className="empty-state cart-empty">
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
        <CartTotals pricing={pricing ?? priceCart(lines)} />
        <button
          type="button"
          className="primary-action pay-action pressable"
          disabled={lines.length === 0 || !sellable}
          onClick={onTakePayment}
        >
          Take payment
          <Icon name="forward" size={22} />
        </button>
      </footer>
    </section>
  );
}

/**
 * The footer's money, in the order a customer asks for it.
 *
 * On a tax-EXCLUSIVE list the lines above are net, so the tax has to be shown
 * for the total to make sense — otherwise the arithmetic on screen does not
 * add up and a cashier is left defending a number they cannot derive. On a
 * tax-INCLUSIVE list the total IS the sum of the shelf prices, so it stands
 * alone and the tax is noted beneath it as the receipt has to state it.
 *
 * When this device cannot state the split, nothing is shown but the total.
 * A zero tax line would be a claim, not a blank.
 */
function CartTotals({ pricing }: { readonly pricing: CartPricing }): ReactNode {
  const breakdown = pricing.breakdown;
  const showsTax = breakdown !== null && breakdown.taxTotalMinor !== 0n;
  return (
    <div className="cart-totals">
      {showsTax && !pricing.isTaxInclusive ? (
        <>
          <div className="total-row subtotal-row">
            <span className="total-label">Subtotal</span>
            <Money amount={breakdown.netMinor} className="money cart-subtotal" />
          </div>
          <div className="total-row subtotal-row">
            <span className="total-label">Tax</span>
            <Money amount={breakdown.taxTotalMinor} className="money cart-tax" />
          </div>
        </>
      ) : null}
      <div className="total-row grand-row">
        <span className="total-label">Total</span>
        {/* Keyed by the amount: each change remounts the wrapper and replays
            a short tick, so a cashier sees the total MOVE as lines go in. */}
        <span className="total-tick" key={pricing.grossMinor.toString()}>
          <Money amount={pricing.grossMinor} className="money total-value cart-total" />
        </span>
      </div>
      {showsTax && pricing.isTaxInclusive ? (
        <p className="total-note">
          Includes tax <Money amount={breakdown.taxTotalMinor} className="money cart-tax" />
        </p>
      ) : null}
    </div>
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
  // The unit price as the shelf shows it — one whole selling unit, rounded once.
  const unitMinor = lineNetMinor(step, line.qtyScale, line.unitPriceE4, 'half-up');
  return (
    <li className={`cart-line${pendingRemove ? ' removing' : ''}`}>
      <div className="cart-line-main">
        <span className="cart-line-info">
          <span className="cart-line-name">{line.name}</span>
          <span className="cart-line-each">
            <Money amount={unitMinor} className="money" /> / {line.uomLabel}
          </span>
        </span>
        <Money amount={lineTotalMinor(line)} className="money cart-line-total" />
      </div>
      <div className="cart-line-controls">
        <div className="qty-stepper">
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
            <Icon name="minus" size={20} />
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
            <Icon name="plus" size={20} />
          </button>
        </div>
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
