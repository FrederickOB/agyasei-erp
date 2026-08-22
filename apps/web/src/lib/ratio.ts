/**
 * Ratios at the presentation boundary.
 *
 * The reporting routes return ratios as scaled INTEGERS — a percentage × 10⁴
 * (19.325% is `193250`), days of cover × 10⁴ — for the same reason money is a
 * `bigint`: a float64 does not carry an exact magnitude and a ratio that has
 * drifted in the third decimal is a ratio somebody will reconcile against a
 * target and fail to explain (ADR-0004).
 *
 * So the rounding happens HERE, once, explicitly, in integer arithmetic, and
 * nothing downstream ever computes with the rounded value. `divRound` is
 * `@erp/money`'s single rounding site; `formatQtyScaled` is the exact decimal
 * renderer both quantities and these already share.
 *
 * `null` is not handled here on purpose. A withheld ratio is an ABSENCE with
 * a reason attached, and squeezing it through a formatter would produce a
 * dash that reads like a small number. The screens render the reason instead.
 */
import { divRound } from '@erp/money';
import { formatQtyScaled } from './quantity';

/** A percentage × 10⁴, shown to two decimal places. `193250` → `19.33`. */
export function formatPercentE4(valueE4: bigint): string {
  return formatQtyScaled(divRound(valueE4, 100n, 'half-up'), 2);
}

/** Days × 10⁴, shown to one decimal place. `421234` → `42.1`. */
export function formatDaysE4(valueE4: bigint): string {
  return formatQtyScaled(divRound(valueE4, 1000n, 'half-up'), 1);
}

/**
 * Basis points as a percentage, to one decimal place. `4200` → `42`.
 *
 * Used for the low-stock coverage ratio, which is an ORDERING KEY the server
 * computes by truncating division — it is shown so a person can see WHY one
 * row is above another, never as a figure anything is ordered from.
 */
export function formatBasisPointsAsPercent(bp: bigint): string {
  return formatQtyScaled(divRound(bp, 10n, 'half-up'), 1);
}
