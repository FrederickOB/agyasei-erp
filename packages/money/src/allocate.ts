import { MoneyError } from './errors.js';
import { floorDivRem } from './rounding.js';
import { assertMinorUnits, type MinorUnits } from './types.js';

/**
 * Split `total` across `weights` proportionally by largest-remainder, returning
 * shares that sum EXACTLY to `total` — no minor unit created, none lost
 * (ADR-0004; §4.13 rows 4 and 7). Used for document discounts across lines,
 * the facility fee across ageing buckets, and any pro-rata split of money.
 *
 * THE DETERMINISTIC RULE (normative — golden tests pin it):
 *
 * 1. Let `S = Σ weights` (must be non-zero). Bucket i's exact share is the
 *    rational `total × wᵢ / S`.
 * 2. Every bucket first receives `floor(exact share)` — floor toward negative
 *    infinity, so the leftover is always a NON-NEGATIVE count of single minor
 *    units `r`, with `0 ≤ r < weights.length`, for any sign of total or weights.
 * 3. The `r` leftover units are handed out ONE each, to buckets ordered by:
 *      (a) largest fractional remainder first,
 *      (b) tie → larger weight first (the "highest-value line" of §4.13 row 4),
 *      (c) tie → lower index first (document order — line_no, or oldest ageing
 *          bucket when the caller lists buckets oldest-first, per row 7).
 *
 * Documented consequences:
 * - A ZERO weight receives exactly 0n, always: its floor share and fractional
 *   remainder are both zero, so it can never attract a leftover unit.
 * - A NEGATIVE total works unchanged: flooring makes every base share round
 *   down (more negative), and the leftover units are +1 corrections, so ties
 *   land on the earliest bucket exactly as with positive totals.
 * - MIXED-SIGN weights are permitted so long as `S ≠ 0`; a negative weight
 *   yields a share of opposite sign to the total, as proportionality demands.
 * - `S = 0` (including an all-zero weight vector) throws: proportional
 *   allocation against nothing is an upstream logic error, never guessed at.
 * - An empty weight vector throws: there is no bucket to hold the total.
 */
export function allocate(total: MinorUnits, weights: readonly bigint[]): MinorUnits[] {
  assertMinorUnits(total, 'total');
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new MoneyError('allocate: at least one weight is required');
  }
  let sum = 0n;
  for (let i = 0; i < weights.length; i++) {
    assertMinorUnits(weights[i], `weights[${i}]`);
    sum += weights[i]!;
  }
  if (sum === 0n) {
    throw new MoneyError('allocate: weights sum to zero — proportional allocation is undefined');
  }

  const count = weights.length;
  const shares: bigint[] = new Array<bigint>(count);
  const fracs: bigint[] = new Array<bigint>(count);
  let allocated = 0n;
  for (let i = 0; i < count; i++) {
    const { floor, rem } = floorDivRem(total * weights[i]!, sum);
    shares[i] = floor;
    fracs[i] = rem;
    allocated += floor;
  }

  let leftover = total - allocated; // invariant: 0n <= leftover < count
  if (leftover < 0n || leftover >= BigInt(count)) {
    /* c8 ignore next 2 -- unreachable by construction; guards a future edit */
    throw new MoneyError(`allocate: internal invariant broken (leftover ${leftover})`);
  }
  if (leftover === 0n) return shares;

  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => {
    const fa = fracs[a]!;
    const fb = fracs[b]!;
    if (fa !== fb) return fa > fb ? -1 : 1; // (a) largest fractional remainder
    const wa = weights[a]!;
    const wb = weights[b]!;
    if (wa !== wb) return wa > wb ? -1 : 1; // (b) larger weight
    return a - b; // (c) lower index
  });

  for (let k = 0; leftover > 0n; k++) {
    shares[order[k]!] = shares[order[k]!]! + 1n;
    leftover -= 1n;
  }
  return shares;
}
