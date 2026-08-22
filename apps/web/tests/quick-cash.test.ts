/**
 * Cash shortcuts (§2.7 category 1 — it puts an amount in the tender box, and
 * whatever is in that box is what the drawer is reconciled against).
 */
import { describe, expect, it } from 'vitest';
import { roundUpToMajor, suggestedTenders } from '../src/money/quick-cash';

describe('rounding a total up to a round number of major units', () => {
  it('rounds up to the next multiple, in minor units', () => {
    // 1 234 minor units at scale 2 is 12.34 major; the next multiple of 5 is 15.
    expect(roundUpToMajor(1_234n, 5n, 2)).toBe(1_500n);
    expect(roundUpToMajor(1_234n, 20n, 2)).toBe(2_000n);
  });

  it('leaves an amount that is already a multiple alone', () => {
    expect(roundUpToMajor(2_000n, 20n, 2)).toBe(2_000n);
  });

  it('reads the pack’s scale rather than assuming 100 to the major unit', () => {
    // scale 3: 1 000 minor units = 1 major unit. The next multiple of 5 is 5.
    expect(roundUpToMajor(1_234n, 5n, 3)).toBe(5_000n);
    // scale 0: a currency with no minor unit at all.
    expect(roundUpToMajor(1_234n, 5n, 0)).toBe(1_235n);
  });

  it('refuses to do anything clever with a nonsense step', () => {
    expect(roundUpToMajor(1_234n, 0n, 2)).toBe(1_234n);
    expect(roundUpToMajor(1_234n, -5n, 2)).toBe(1_234n);
  });

  it('stays exact past where a float would drift', () => {
    const huge = 9_007_199_254_740_993n; // > Number.MAX_SAFE_INTEGER
    expect(roundUpToMajor(huge, 100n, 2)).toBe(9_007_199_254_750_000n);
  });
});

describe('the tenders offered at the counter', () => {
  it('offers round amounts above the total, ascending and distinct', () => {
    expect(suggestedTenders(1_234n, 2)).toEqual([1_500n, 2_000n, 5_000n]);
  });

  it('never offers the exact total — that is its own control', () => {
    const suggestions = suggestedTenders(2_000n, 2);
    expect(suggestions).not.toContain(2_000n);
    expect(suggestions.every((s) => s > 2_000n)).toBe(true);
  });

  it('offers nothing for an empty cart', () => {
    expect(suggestedTenders(0n, 2)).toEqual([]);
  });

  it('offers nothing above a total that is already the largest round number', () => {
    // 100 major units exactly: every step lands on it, and none is above it.
    expect(suggestedTenders(10_000n, 2)).toEqual([]);
  });

  it('honours the limit it is given', () => {
    expect(suggestedTenders(1_234n, 2, 2)).toEqual([1_500n, 2_000n]);
  });
});
