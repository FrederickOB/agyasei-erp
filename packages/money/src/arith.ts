import { MoneyError } from './errors.js';
import { divRound } from './rounding.js';
import {
  assertMinorUnits,
  type BasisPoints,
  type MinorUnits,
  type RateE4,
  type RoundingMode,
} from './types.js';

/** Exact addition. bigint arithmetic cannot overflow or drift. */
export function add(a: MinorUnits, b: MinorUnits): MinorUnits {
  assertMinorUnits(a, 'a');
  assertMinorUnits(b, 'b');
  return a + b;
}

/** Exact subtraction: `a - b`. */
export function sub(a: MinorUnits, b: MinorUnits): MinorUnits {
  assertMinorUnits(a, 'a');
  assertMinorUnits(b, 'b');
  return a - b;
}

/** Exact negation. */
export function negate(a: MinorUnits): MinorUnits {
  assertMinorUnits(a, 'a');
  return -a;
}

/** Absolute value. */
export function abs(a: MinorUnits): MinorUnits {
  assertMinorUnits(a, 'a');
  return a < 0n ? -a : a;
}

/** Three-way comparison: -1 if a < b, 0 if equal, 1 if a > b. */
export function compare(a: MinorUnits, b: MinorUnits): -1 | 0 | 1 {
  assertMinorUnits(a, 'a');
  assertMinorUnits(b, 'b');
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * `amount × num / den`, computed exactly in bigint and rounded ONCE under an
 * explicit mode. The general rational multiply — quantity-unit conversions with
 * `factor_num / factor_den` snapshots (§4.4.4) and extended line amounts
 * compose through this so no value is rounded twice.
 *
 * §4.13: intermediates may exceed 10¹⁷ (a 400-tonne cement order); bigint is
 * arbitrary-precision, so the SQL helper's `numeric` cast has no TS analogue —
 * the multiply is simply exact.
 */
export function mulDiv(amount: MinorUnits, num: bigint, den: bigint, mode: RoundingMode): MinorUnits {
  assertMinorUnits(amount, 'amount');
  assertMinorUnits(num, 'num');
  assertMinorUnits(den, 'den');
  if (den === 0n) {
    throw new MoneyError('mulDiv: zero denominator');
  }
  return divRound(amount * num, den, mode);
}

const E4 = 10_000n;

/**
 * Multiply an amount by an e4 scaled rate (`10000n` = 1.0): unit prices, unit
 * costs, WAC. `mulRateE4(amount, 10000n, mode)` is the identity for every mode.
 * Rounds once, explicitly.
 */
export function mulRateE4(amount: MinorUnits, rateE4: RateE4, mode: RoundingMode): MinorUnits {
  assertMinorUnits(amount, 'amount');
  assertMinorUnits(rateE4, 'rateE4');
  return divRound(amount * rateE4, E4, mode);
}

/**
 * Multiply an amount by basis points (`1500n` = 15%): tax components
 * (§7.2.4 `rate_bp`), the facility fee (§4.13 row 11), margins. Rounds once,
 * explicitly, at the component's declared mode.
 */
export function mulBps(amount: MinorUnits, bps: BasisPoints, mode: RoundingMode): MinorUnits {
  assertMinorUnits(amount, 'amount');
  assertMinorUnits(bps, 'bps');
  return divRound(amount * bps, E4, mode);
}

/**
 * §4.13 row 3, verbatim: the extended line amount
 * `line_net = ROUND(qty_scaled × unit_price_e4 / (10^qty_scale × 10⁴))`,
 * rounded ONCE on the extended amount — never on the unit price.
 *
 * `qtyScaled` is the quantity as a scaled integer (2.500 t at scale 3 is
 * `2500n`); `qtyScale` is its digit count (an exponent, not a monetary
 * magnitude, hence `number`). §4.13 names half-up here; the mode is still a
 * parameter because this package never rounds implicitly.
 */
export function lineNetMinor(
  qtyScaled: bigint,
  qtyScale: number,
  unitPriceE4: RateE4,
  mode: RoundingMode,
): MinorUnits {
  assertMinorUnits(qtyScaled, 'qtyScaled');
  assertMinorUnits(unitPriceE4, 'unitPriceE4');
  if (!Number.isInteger(qtyScale) || qtyScale < 0 || qtyScale > 9) {
    throw new MoneyError(`lineNetMinor: qtyScale must be an integer 0–9; got ${String(qtyScale)}`);
  }
  return divRound(qtyScaled * unitPriceE4, 10n ** BigInt(qtyScale + 4), mode);
}
