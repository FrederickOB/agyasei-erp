/**
 * Pricing a RETURN from the sale it reverses — the one rule the server and the
 * counter both run, so a refund computed with the radio off is the figure the
 * server will compute when it lands.
 *
 * THE RULE: CUMULATIVE PRO-RATA, ROUNDED HALF-UP, PER FIGURE.
 *
 * A line sold `whole` units for N (net), D (discount), T_c (each tax
 * component) and S (stocking units). Returning `take` units when `before`
 * units of that line have already come back reverses, for every figure F,
 *
 *     F × (before + take) / whole   −   F × before / whole
 *
 * each product rounded half-up ONCE. Not `F × take / whole`, which rounds
 * each slice independently: a GH₵1.01 line returned one-third at a time would
 * refund 0.34 three times — 1.02, a pesewa more than the customer paid. The
 * cumulative form telescopes, so however many pieces a line comes back in,
 * Σ slices = F exactly, to the minor unit (property-tested). A full return in
 * one go is the identity: every figure, exactly the original's.
 *
 * WHY THE ORIGINAL'S TAX AMOUNTS AND NOT A FRESH COMPUTATION: the return
 * reverses the tax the sale CHARGED, at the rate row it was charged at
 * (ADR-0002; 05 §5.14 #23). Re-deriving tax from a pro-rated base would drift
 * from what was charged by a rounding each time, and a fully returned sale
 * would not reverse its own tax. Pro-rating the charged amount keeps the ratio
 * of the snapshotted rate and sums back exactly.
 *
 * Pure bigint. No rates, no tax logic, no domain vocabulary beyond "a line".
 */
import { MoneyError } from './errors.js';
import { assertMinorUnits, type MinorUnits } from './types.js';
import { mulDiv } from './arith.js';

/** `figure × (before + take) / whole − figure × before / whole`, each half-up. */
export function cumulativeSlice(figure: bigint, before: bigint, take: bigint, whole: bigint): bigint {
  assertMinorUnits(figure, 'figure');
  assertMinorUnits(before, 'before');
  assertMinorUnits(take, 'take');
  assertMinorUnits(whole, 'whole');
  if (whole <= 0n) throw new MoneyError('cumulativeSlice: the whole must be positive');
  if (figure < 0n) throw new MoneyError('cumulativeSlice: a reversed figure is a magnitude, never negative');
  if (before < 0n || take <= 0n) throw new MoneyError('cumulativeSlice: before ≥ 0 and take > 0');
  if (before + take > whole) {
    throw new MoneyError(`cumulativeSlice: ${before + take} of ${whole} — more than was sold`);
  }
  return mulDiv(figure, before + take, whole, 'half-up') - mulDiv(figure, before, whole, 'half-up');
}

export interface SoldLineFigures {
  /** Units sold, in the selling unit's scale. */
  readonly qtySold: bigint;
  readonly netMinor: MinorUnits;
  readonly discountMinor: MinorUnits;
  /** Stocking units that left the yard for this line. */
  readonly qtyStock: bigint;
  /** Each tax component's base and amount, in the original's order. */
  readonly taxes: readonly { readonly baseMinor: MinorUnits; readonly taxMinor: MinorUnits }[];
}

export interface ReturnSlice {
  readonly netMinor: MinorUnits;
  readonly discountMinor: MinorUnits;
  readonly qtyStock: bigint;
  readonly taxes: readonly { readonly baseMinor: MinorUnits; readonly taxMinor: MinorUnits }[];
  readonly taxMinor: MinorUnits;
  /** net − discount + tax: what goes back to the customer for this line. */
  readonly totalMinor: MinorUnits;
}

/**
 * What returning `take` units of `line` reverses, given `before` units of it
 * have already come back.
 */
export function returnSlice(line: SoldLineFigures, before: bigint, take: bigint): ReturnSlice {
  const slice = (f: bigint): bigint => cumulativeSlice(f, before, take, line.qtySold);
  const taxes = line.taxes.map((t) => ({ baseMinor: slice(t.baseMinor), taxMinor: slice(t.taxMinor) }));
  const netMinor = slice(line.netMinor);
  const discountMinor = slice(line.discountMinor);
  const taxMinor = taxes.reduce((a, t) => a + t.taxMinor, 0n);
  return {
    netMinor,
    discountMinor,
    qtyStock: slice(line.qtyStock),
    taxes,
    taxMinor,
    totalMinor: netMinor - discountMinor + taxMinor,
  };
}
