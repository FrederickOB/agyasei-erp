/**
 * Cash tender. The amount received is parsed EXACTLY through @erp/money
 * parse() against the configured CurrencySpec — no float ever touches it —
 * and change is bigint subtraction rendered through the Money boundary.
 *
 * The layout answers the three questions in the order a cashier asks them:
 * what is owed, what was handed over, what goes back. Amount due is stated
 * once, prominently, and never has to be remembered; the shortcuts are the
 * round amounts people actually hand over (money/quick-cash.ts), because
 * typing an exact figure with a queue waiting is the slowest part of a cash
 * sale; and change appears the moment it can be computed, in the affirmative
 * colour, so the drawer opens on a number that is already on screen.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { compare, format, parse, sub } from '@erp/money';
import type { CartPricing } from '../../data/pricing/cart-pricing';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';
import { suggestedTenders } from '../../money/quick-cash';
import { Icon } from '../../ui/Icon';

export function TenderPanel({
  pricing,
  onComplete,
  onBack,
}: {
  /**
   * What the customer hands over, and the tax split when this device can state
   * one. The SAME object the cart footer rendered — the amount due is never
   * recomputed here, because a tender screen that disagreed with the cart
   * behind it is a disagreement nobody would notice until cash-up.
   */
  readonly pricing: CartPricing;
  readonly onComplete: (tenderedMinor: bigint) => void;
  readonly onBack: () => void;
}): ReactNode {
  const spec = useCurrencySpec();
  const [text, setText] = useState('');
  const totalMinor = pricing.grossMinor;
  const taxNoted =
    pricing.isTaxInclusive && pricing.breakdown !== null && pricing.breakdown.taxTotalMinor !== 0n
      ? pricing.breakdown.taxTotalMinor
      : null;

  const tendered = useMemo<bigint | null>(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    try {
      return parse(trimmed, spec);
    } catch {
      return null; // not a canonical amount yet — keep the button disabled
    }
  }, [text, spec]);

  const change =
    tendered !== null && compare(tendered, totalMinor) >= 0 ? sub(tendered, totalMinor) : null;
  const short = tendered !== null && change === null;
  const quick = useMemo(() => suggestedTenders(totalMinor, spec.scale), [totalMinor, spec.scale]);

  return (
    <section className="tender-panel" aria-label="Cash payment">
      <div className="tender-due">
        <span className="total-label">Amount due</span>
        <Money amount={totalMinor} className="money total-value tender-total" />
        {/* On an inclusive list the shelf price IS the amount due; saying so
            here is what lets a cashier answer "is tax on top of that?". */}
        {taxNoted !== null ? (
          <p className="total-note">
            Includes tax <Money amount={taxNoted} className="money tender-tax" />
          </p>
        ) : null}
      </div>

      <label className="tender-label" htmlFor="tender-input">
        Cash received
      </label>
      <input
        id="tender-input"
        className="tender-input money"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder={format(0n, spec)}
        aria-describedby="tender-hint"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p id="tender-hint" className="tender-hint">
        {/* Helper text that persists, rather than a placeholder that vanishes
            the moment it is needed (§ input-helper-text). */}
        {short
          ? 'That is less than the amount due. Add more, or go back and change the cart.'
          : 'Tap an amount below, or type what the customer handed over.'}
      </p>

      <div className="tender-quick" role="group" aria-label="Quick amounts">
        <button
          type="button"
          className="chip pressable"
          onClick={() => setText(format(totalMinor, spec))}
        >
          Exact
        </button>
        {quick.map((amount) => (
          <button
            key={amount.toString()}
            type="button"
            className="chip pressable money"
            onClick={() => setText(format(amount, spec))}
          >
            {format(amount, spec)}
          </button>
        ))}
      </div>

      <div className={`tender-change${change !== null ? ' ready' : ''}`}>
        <span className="total-label">Change</span>
        {change !== null ? (
          <Money amount={change} className="money total-value tender-change-value" />
        ) : (
          <span className="total-value tender-change-placeholder" aria-label="No change yet">
            —
          </span>
        )}
      </div>

      <div className="tender-actions">
        <button type="button" className="secondary-action pressable" onClick={onBack}>
          <Icon name="back" size={20} />
          Back to cart
        </button>
        <button
          type="button"
          className="primary-action pressable"
          disabled={change === null}
          onClick={() => {
            if (tendered !== null) onComplete(tendered);
          }}
        >
          <Icon name="check" size={20} />
          Complete sale
        </button>
      </div>
    </section>
  );
}
