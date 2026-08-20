import { MoneyError } from './errors.js';
import { assertMinorUnits, assertRoundingMode, type RoundingMode } from './types.js';

/**
 * Exact integer division with an EXPLICIT rounding mode: rounds the true
 * rational value `numerator / denominator` to the nearest integer per `mode`.
 *
 * This is the single rounding site in the package — every multiply-and-round
 * helper delegates here, so rounding happens ONCE per computed amount, never
 * compounded (§4.13 row 3: "Once, on the extended amount. Never on the unit
 * price."). All arithmetic is bigint; intermediates cannot overflow and no
 * float ever appears (ADR-0004).
 *
 * Sign behaviour is defined for all inputs: the denominator's sign is
 * normalised away, `'down'` is toward zero, `'up'` away from zero, `'half-up'`
 * ties away from zero, `'half-even'` ties to the even quotient.
 */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  assertMinorUnits(numerator, 'numerator');
  assertMinorUnits(denominator, 'denominator');
  assertRoundingMode(mode);
  if (denominator === 0n) {
    throw new MoneyError('divRound: division by zero');
  }
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d; // bigint division truncates toward zero
  const r = n % d; // remainder carries the numerator's sign
  if (r === 0n) return q;

  const negative = n < 0n;
  const away = negative ? q - 1n : q + 1n;
  const twiceAbsR = (r < 0n ? -r : r) * 2n;

  switch (mode) {
    case 'down':
      return q;
    case 'up':
      return away;
    case 'half-up':
      return twiceAbsR >= d ? away : q;
    case 'half-even':
      if (twiceAbsR > d) return away;
      if (twiceAbsR < d) return q;
      return q % 2n === 0n ? q : away; // exact tie: even quotient wins
    /* c8 ignore next 2 -- assertRoundingMode makes this unreachable */
    default:
      throw new MoneyError(`divRound: unknown rounding mode ${String(mode satisfies never)}`);
  }
}

/**
 * Floor division toward negative infinity, with the fractional remainder
 * normalised to `[0, |denominator|)`. Used by `allocate`, where flooring every
 * share guarantees the leftover is a non-negative count of single minor units.
 */
export function floorDivRem(
  numerator: bigint,
  denominator: bigint,
): { readonly floor: bigint; readonly rem: bigint } {
  assertMinorUnits(numerator, 'numerator');
  assertMinorUnits(denominator, 'denominator');
  if (denominator === 0n) {
    throw new MoneyError('floorDivRem: division by zero');
  }
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let q = n / d;
  let r = n % d;
  if (r < 0n) {
    q -= 1n;
    r += d;
  }
  return { floor: q, rem: r };
}
