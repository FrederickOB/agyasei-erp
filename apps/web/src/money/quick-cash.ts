/**
 * Cash shortcuts at the counter: the notes someone actually hands over.
 *
 * Typing an exact amount into a till while a queue waits is the slowest part
 * of a cash sale, and the amounts people tender are not arbitrary — they are
 * round numbers at or above the total. This offers the next few, so the common
 * case is one tap instead of five.
 *
 * IT IS ARITHMETIC, NOT A DENOMINATION TABLE. What notes a jurisdiction prints
 * is pack data this client does not have and must not guess (ADR-0007), so
 * nothing here names a note. It rounds UP to the next multiple of 5, 10, 20,
 * 50 and 100 MAJOR units, derived from the pack's own `scale` — never an
 * assumed 100 minor units to the major (CLAUDE.md §2.3).
 *
 * Every value is bigint minor units end to end. No float touches money, here
 * or anywhere (ADR-0004).
 */

/** Round up to the next whole multiple of `majorUnits`, or return it as-is. */
export function roundUpToMajor(totalMinor: bigint, majorUnits: bigint, scale: number): bigint {
  if (majorUnits <= 0n || scale < 0) return totalMinor;
  const step = majorUnits * 10n ** BigInt(scale);
  const remainder = totalMinor % step;
  return remainder === 0n ? totalMinor : totalMinor + (step - remainder);
}

/** The ladder of round numbers a counter is handed, smallest first. */
const STEPS: readonly bigint[] = [5n, 10n, 20n, 50n, 100n];

/**
 * Up to `limit` tenders STRICTLY ABOVE the total, ascending and distinct.
 *
 * Strictly above on purpose: the exact amount is its own control, and
 * offering it twice under two different labels is how someone taps the wrong
 * one. An empty result is correct and common — a total that is already a round
 * 100 has nothing above it worth suggesting.
 */
export function suggestedTenders(
  totalMinor: bigint,
  scale: number,
  limit = 3,
): readonly bigint[] {
  if (totalMinor <= 0n) return [];
  const out: bigint[] = [];
  for (const step of STEPS) {
    const candidate = roundUpToMajor(totalMinor, step, scale);
    if (candidate > totalMinor && !out.includes(candidate)) out.push(candidate);
    if (out.length === limit) break;
  }
  return out;
}
