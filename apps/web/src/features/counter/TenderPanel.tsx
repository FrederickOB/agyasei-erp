/**
 * Cash tender. The amount received is parsed EXACTLY through @erp/money
 * parse() against the configured CurrencySpec — no float ever touches it —
 * and change is bigint subtraction rendered through the Money boundary.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { compare, format, parse, sub } from '@erp/money';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Money } from '../../money/Money';

export function TenderPanel({
  totalMinor,
  onComplete,
  onBack,
}: {
  readonly totalMinor: bigint;
  readonly onComplete: (tenderedMinor: bigint) => void;
  readonly onBack: () => void;
}): ReactNode {
  const spec = useCurrencySpec();
  const [text, setText] = useState('');

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

  return (
    <section className="tender-panel" aria-label="Cash payment">
      <div className="tender-total-row">
        <span>Amount due</span>
        <Money amount={totalMinor} className="money tender-total" />
      </div>
      <label className="tender-label" htmlFor="tender-input">
        Cash received
      </label>
      <input
        id="tender-input"
        className="tender-input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder={format(0n, spec)}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        type="button"
        className="tender-exact"
        onClick={() => setText(format(totalMinor, spec))}
      >
        Exact amount
      </button>
      <div className="tender-change-row">
        <span>Change</span>
        {change !== null ? (
          <Money amount={change} className="money tender-change" />
        ) : (
          <span className="tender-change-placeholder">—</span>
        )}
      </div>
      <div className="tender-actions">
        <button type="button" className="secondary-action" onClick={onBack}>
          Back to cart
        </button>
        <button
          type="button"
          className="primary-action"
          disabled={change === null}
          onClick={() => {
            if (tendered !== null) onComplete(tendered);
          }}
        >
          Complete sale
        </button>
      </div>
    </section>
  );
}
