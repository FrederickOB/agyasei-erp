/**
 * A stat's meter: how far a figure has got, and where its target sits.
 *
 * Three rules from the back-office design (docs/design/back-office-dashboard):
 *
 * 1. **`null` is UNAVAILABLE, never zero.** A withheld ratio renders the word
 *    and the server's reason in the "wait" colour family. It never renders an
 *    empty bar, because an empty bar against a target reads as 0 against a
 *    target — the exact misreading `reports.ts` exists to prevent.
 * 2. **Colour never carries the meaning alone.** The tone is chosen by the
 *    caller from what the figure MEANS (behind plan → attention), and the
 *    same meaning is always in the words beside the meter.
 * 3. **The bar is a share, the label is the figure.** Widths come from
 *    `shareBp`; the figure a person reads is whatever the caller passed in as
 *    `children`, already formatted by `<Money>` or a quantity formatter.
 */
import type { ReactNode } from 'react';
import { bpToPercent, shareBp } from './scale';

export type MeterTone = 'brand' | 'ok' | 'wait' | 'attn';

export interface MeterProps {
  /** The figure, or null when the server withheld it. */
  readonly value: bigint | null;
  /** What full width means. The target mark sits at `target / max`. */
  readonly max: bigint;
  /** Where the target is, on the same scale. Omit for a plain share bar. */
  readonly target?: bigint;
  readonly tone?: MeterTone;
  /** The server's own words for why the figure is absent. Shown, always. */
  readonly unavailableReason?: string | null;
  /** Accessible name — what this meter measures. */
  readonly label: string;
}

export function Meter({
  value,
  max,
  target,
  tone = 'brand',
  unavailableReason = null,
  label,
}: MeterProps): ReactNode {
  if (value === null) {
    return (
      <div className="meter meter-unavailable" role="status" aria-label={`${label}: unavailable`}>
        <span className="meter-unavailable-word">Unavailable</span>
        {unavailableReason === null ? null : (
          <span className="meter-unavailable-why">{unavailableReason}</span>
        )}
      </div>
    );
  }
  const fill = shareBp(value, max);
  const mark = target === undefined ? null : shareBp(target, max);
  return (
    <div
      className={`meter meter-${tone}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={10_000}
      aria-valuenow={fill}
    >
      <i className="meter-fill" style={{ width: bpToPercent(fill) }} />
      {mark === null ? null : (
        <em className="meter-target" style={{ left: bpToPercent(mark) }} aria-hidden="true" />
      )}
    </div>
  );
}
