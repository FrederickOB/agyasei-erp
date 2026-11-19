/**
 * Category 1 (CLAUDE.md §2.7): the arithmetic every refund is priced by.
 *
 * The property that matters is TELESCOPING: however a line comes back — all
 * at once, one unit at a time, in uneven pieces — the slices sum to exactly
 * what the line charged, figure by figure. A per-slice rounding would refund
 * a pesewa too many on a third-at-a-time return; the negative control below
 * shows that it does, so the test is not vacuous.
 */
import { describe, expect, it } from 'vitest';
import { cumulativeSlice, mulDiv, returnSlice, type SoldLineFigures } from '../src/index.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const big = (r: () => number, max: number): bigint => BigInt(Math.floor(r() * max));

describe('cumulativeSlice', () => {
  it('a full return in one piece is the identity', () => {
    expect(cumulativeSlice(10_101n, 0n, 7n, 7n)).toBe(10_101n);
  });

  it('a third at a time sums to the figure; independent rounding would not', () => {
    const parts = [0n, 1n, 2n].map((before) => cumulativeSlice(101n, before, 1n, 3n));
    expect(parts).toEqual([34n, 33n, 34n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(101n);
    // Negative control: the naive per-slice form refunds 102 for 101 charged.
    const naive = 3n * mulDiv(101n, 1n, 3n, 'half-up');
    expect(naive).toBe(102n);
  });

  it('refuses more than was sold, a negative figure and a zero take', () => {
    expect(() => cumulativeSlice(100n, 2n, 2n, 3n)).toThrow(/more than was sold/);
    expect(() => cumulativeSlice(-1n, 0n, 1n, 3n)).toThrow(/magnitude/);
    expect(() => cumulativeSlice(100n, 0n, 0n, 3n)).toThrow();
    // positive control on the same inputs, in range
    expect(cumulativeSlice(100n, 1n, 2n, 3n)).toBe(67n);
  });

  it('PROPERTY: any partition of a line sums back exactly, and every slice is ≥ 0', () => {
    const r = rng(20261119);
    for (let i = 0; i < 2_000; i += 1) {
      const whole = 1n + big(r, 5_000);
      const figure = big(r, 10_000_000_000);
      let before = 0n;
      let sum = 0n;
      while (before < whole) {
        const room = whole - before;
        const take = 1n + (room > 1n ? big(r, Number(room)) % room : 0n);
        const s = cumulativeSlice(figure, before, take, whole);
        expect(s >= 0n).toBe(true);
        sum += s;
        before += take;
      }
      expect(sum).toBe(figure);
    }
  });
});

describe('returnSlice — a whole line, all figures together', () => {
  const line: SoldLineFigures = {
    qtySold: 3n,
    netMinor: 15_000n,
    discountMinor: 101n,
    qtyStock: 3000n,
    taxes: [
      { baseMinor: 14_899n, taxMinor: 2_235n },
      { baseMinor: 14_899n, taxMinor: 373n },
    ],
  };

  it('returning it in pieces reverses exactly what it charged, tax component by component', () => {
    const a = returnSlice(line, 0n, 1n);
    const b = returnSlice(line, 1n, 2n);
    expect(a.netMinor + b.netMinor).toBe(15_000n);
    expect(a.discountMinor + b.discountMinor).toBe(101n);
    expect(a.qtyStock + b.qtyStock).toBe(3000n);
    expect(a.taxes[0]!.taxMinor + b.taxes[0]!.taxMinor).toBe(2_235n);
    expect(a.taxes[1]!.taxMinor + b.taxes[1]!.taxMinor).toBe(373n);
    expect(a.totalMinor + b.totalMinor).toBe(15_000n - 101n + 2_235n + 373n);
    // each slice's own identity
    for (const s of [a, b]) {
      expect(s.totalMinor).toBe(s.netMinor - s.discountMinor + s.taxMinor);
      expect(s.taxMinor).toBe(s.taxes.reduce((x, t) => x + t.taxMinor, 0n));
    }
  });

  it('the full line in one go is the original, figure for figure', () => {
    const all = returnSlice(line, 0n, 3n);
    expect(all).toMatchObject({ netMinor: 15_000n, discountMinor: 101n, qtyStock: 3000n, taxMinor: 2_608n });
  });
});
