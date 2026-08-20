import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MoneyError, allocate } from '../src/index.js';

const sum = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

describe('allocate — golden remainder placement (§4.13 rows 4 and 7)', () => {
  it('3-way equal split: the leftover unit lands on the lowest index', () => {
    // 100 across [1,1,1]: exact 33.33..., equal fractions, equal weights -> index order
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
  });

  it('document discount across line values: leftover goes to the largest fractional remainder', () => {
    // 1000 across values [5000, 3000, 1999] (S = 9999):
    //   floors [500, 300, 199], fractions [500, 300, 9199] -> the single leftover
    //   unit goes to line 3, whose fractional remainder is largest.
    expect(allocate(1000n, [5000n, 3000n, 1999n])).toEqual([500n, 300n, 200n]);
  });

  it('tie on fraction: the higher-value line wins, then line order (§4.13 row 4)', () => {
    // 5 across [3000, 1000, 1000] (S = 5000): exact [3, 1, 1] — no leftover.
    // 7 across [2000, 2000, 1000] (S = 5000): exact [2.8, 2.8, 1.4],
    //   floors [2, 2, 1], fractions [4000, 4000, 2000], leftover 2 -> both go to
    //   the tied largest fractions, in index order.
    expect(allocate(7n, [2000n, 2000n, 1000n])).toEqual([3n, 3n, 1n]);
    // Fraction tie with UNEQUAL weights: 3 across [2, 2, 4] (S = 8):
    //   exact [0.75, 0.75, 1.5], floors [0,0,1], fractions [6,6,4]/8, leftover 2.
    //   Both leftover units go to the tied fraction 6/8 pair -> indexes 0,1.
    expect(allocate(3n, [2n, 2n, 4n])).toEqual([1n, 1n, 1n]);
    // Weight breaks a fraction tie: 1 across [1, 3] (S = 4): fractions [1/4, 3/4]
    //   -> larger fraction wins outright; and 2 across [3, 1]: exact [1.5, 0.5],
    //   fractions tie at 2/4 -> larger weight (index 0) takes the unit.
    expect(allocate(2n, [3n, 1n])).toEqual([2n, 0n]);
  });

  it('ageing-style split: buckets listed oldest-first put the remainder on the oldest (§4.13 row 7)', () => {
    // A 1001-pesewa facility fee across three equal 300.00 ageing buckets,
    // oldest first: exact 333.67 each, equal fractions -> the two leftover
    // units land on the two OLDEST buckets by the index tie-break.
    expect(allocate(1001n, [30_000n, 30_000n, 30_000n])).toEqual([334n, 334n, 333n]);
  });
});

describe('allocate — documented edge behaviour', () => {
  it('zero weights receive exactly 0n', () => {
    expect(allocate(100n, [1n, 0n, 1n])).toEqual([50n, 0n, 50n]);
    expect(allocate(101n, [1n, 0n, 1n])).toEqual([51n, 0n, 50n]);
  });

  it('negative totals allocate with the same tie-break, summing exactly', () => {
    expect(allocate(-5n, [1n, 1n, 1n])).toEqual([-1n, -2n, -2n]);
    expect(sum(allocate(-5n, [1n, 1n, 1n]))).toBe(-5n);
  });

  it('mixed-sign weights are proportional when the sum is non-zero', () => {
    // 10 across [5, -2] (S = 3): exact [16.67, -6.67] -> [17, -7], sums to 10.
    expect(allocate(10n, [5n, -2n])).toEqual([17n, -7n]);
  });

  it('single bucket takes the whole total', () => {
    expect(allocate(123n, [7n])).toEqual([123n]);
    expect(allocate(-123n, [7n])).toEqual([-123n]);
    expect(allocate(0n, [7n])).toEqual([0n]);
  });

  it('throws on empty weights, zero-sum weights, and non-bigint inputs', () => {
    expect(() => allocate(100n, [])).toThrow(MoneyError);
    expect(() => allocate(100n, [0n, 0n])).toThrow(MoneyError);
    expect(() => allocate(100n, [5n, -5n])).toThrow(MoneyError);
    const anyAllocate = allocate as unknown as (t: unknown, w: unknown) => bigint[];
    expect(() => anyAllocate(100, [1n])).toThrow(MoneyError);
    expect(() => anyAllocate(100n, [1n, 2])).toThrow(MoneyError);
  });
});

describe('allocate — properties', () => {
  // Amount magnitudes cover every jurisdiction scale 0-4: a scale is just how
  // many of these integer minor units make a major unit, so exercising wide
  // integer ranges exercises all scales. 10^15 minor units at scale 4 is a
  // hundred billion major units — beyond any realistic tenant amount.
  const total = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });
  const weights = fc
    .array(fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }), { minLength: 1, maxLength: 20 })
    .filter((ws) => sum(ws) !== 0n);

  it('shares sum EXACTLY to the total — no unit created, none lost', () => {
    fc.assert(
      fc.property(total, weights, (t, ws) => {
        expect(sum(allocate(t, ws))).toBe(t);
      }),
      { numRuns: 500 },
    );
  });

  it('non-negative weight vectors: every share is within 1 unit of the exact proportional share', () => {
    const posWeights = fc
      .array(fc.bigInt({ min: 0n, max: 10n ** 9n }), { minLength: 1, maxLength: 20 })
      .filter((ws) => sum(ws) > 0n);
    fc.assert(
      fc.property(total, posWeights, (t, ws) => {
        const s = sum(ws);
        const shares = allocate(t, ws);
        for (let i = 0; i < ws.length; i++) {
          // |share_i - t*w_i/S| < 1  <=>  |share_i*S - t*w_i| < S
          const dev = shares[i]! * s - t * ws[i]!;
          expect(dev < s && dev > -s).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('zero-weight buckets always receive exactly 0n', () => {
    const weightsWithZeros = fc
      .array(fc.oneof(fc.constant(0n), fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n })), {
        minLength: 1,
        maxLength: 20,
      })
      .filter((ws) => sum(ws) !== 0n);
    fc.assert(
      fc.property(total, weightsWithZeros, (t, ws) => {
        const shares = allocate(t, ws);
        for (let i = 0; i < ws.length; i++) {
          if (ws[i] === 0n) expect(shares[i]).toBe(0n);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('is deterministic: identical inputs give identical placements', () => {
    fc.assert(
      fc.property(total, weights, (t, ws) => {
        expect(allocate(t, ws)).toEqual(allocate(t, ws));
      }),
      { numRuns: 200 },
    );
  });

  it('exactly-divisible totals allocate with no remainder adjustment at all', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 6n }), { minLength: 1, maxLength: 10 }),
        (perUnit, ws) => {
          const s = sum(ws);
          const shares = allocate(perUnit * s, ws);
          for (let i = 0; i < ws.length; i++) {
            expect(shares[i]).toBe(perUnit * ws[i]!);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
