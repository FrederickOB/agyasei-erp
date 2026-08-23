/**
 * Boundaries for de-grossing. Money bugs live at zero, at one minor unit, where
 * the division is inexact, and where a remainder has to land somewhere.
 */
import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  composeTaxFromNet,
  extractTaxFromGross,
  type RoundingMode,
  type TaxComponent,
} from '../src/index.js';
import { DEEP_CASCADE, GH_2026, SINGLE_HALF_EVEN, WITH_ZERO_RATE, sumTax } from './fixtures/tax-packs.js';

const MODES: readonly RoundingMode[] = ['half-even', 'half-up', 'down', 'up'];

const flat = (code: string, rateBp: bigint, mode: RoundingMode = 'half-up'): TaxComponent => ({
  code,
  rateBp,
  baseKind: 'net',
  baseIncludes: [],
  roundingLevel: 'line',
  roundingMode: mode,
});

describe('boundary: zero and one minor unit', () => {
  it('a zero gross de-grosses to zero net and zero tax, in every mode', () => {
    for (const m of MODES) {
      const r = extractTaxFromGross(0n, GH_2026, m);
      expect(r.netMinor).toBe(0n);
      expect(r.taxes.every((t) => t.taxMinor === 0n)).toBe(true);
      expect(r.roundTrips).toBe(true);
    }
  });

  it('ONE minor unit is all net: no component can claim a fraction of a pesewa', () => {
    // f(1) = 1 — every component rounds its sub-pesewa share to zero — so 1 has
    // an exact preimage and the answer does not depend on the net mode at all,
    // not even on 'down', which would have truncated the candidate to zero.
    for (const m of MODES) {
      const r = extractTaxFromGross(1n, GH_2026, m);
      expect(r.netMinor).toBe(1n);
      expect(r.taxTotalMinor).toBe(0n);
      expect(r.roundTrips).toBe(true);
    }
  });

  it('minus one minor unit is the exact mirror', () => {
    for (const m of MODES) {
      const r = extractTaxFromGross(-1n, GH_2026, m);
      expect(r.netMinor).toBe(-1n);
      expect(r.taxTotalMinor).toBe(0n);
    }
  });

  it('the smallest gross that carries any tax at all under this set is 4', () => {
    // f(3) = 3, f(4) = 5: 4 is the first gross whose net cannot be the whole of
    // it, and it is also the first gross with no preimage.
    expect(extractTaxFromGross(3n, GH_2026, 'half-even').taxTotalMinor).toBe(0n);
    expect(extractTaxFromGross(4n, GH_2026, 'half-even').taxTotalMinor).toBe(1n);
  });
});

describe('boundary: the division is inexact', () => {
  it('single component at 17.5%: GH-agnostic, 10.00 inclusive is 8.51 + 1.49', () => {
    // 851 x 1750bp = 148.925 -> half-even 149; 851 + 149 = 1000 exactly.
    const r = extractTaxFromGross(1_000n, SINGLE_HALF_EVEN, 'half-even');
    expect(r.netMinor).toBe(851n);
    expect(r.taxes[0]?.taxMinor).toBe(149n);
    expect(r.roundTrips).toBe(true);
  });

  it('every gross in a contiguous run closes the identity and is monotone in net', () => {
    let previous = -1n;
    for (let g = 0n; g <= 400n; g++) {
      const r = extractTaxFromGross(g, GH_2026, 'half-even');
      expect(r.netMinor + sumTax(r.taxes)).toBe(g);
      expect(r.netMinor).toBeGreaterThanOrEqual(previous); // a higher shelf price never means a lower net
      previous = r.netMinor;
    }
  });

  it('a deep cascade whose multiplier is not a whole basis point still closes', () => {
    for (let g = 0n; g <= 300n; g++) {
      const r = extractTaxFromGross(g, DEEP_CASCADE, 'half-up');
      expect(r.netMinor + sumTax(r.taxes)).toBe(g);
    }
  });
});

describe('boundary: component-set shapes', () => {
  it('a set of ONLY zero-rate components makes de-grossing the identity', () => {
    const zeroOnly = [flat('Z1', 0n), flat('Z2', 0n)];
    const r = extractTaxFromGross(123_456n, zeroOnly, 'half-even');
    expect(r.netMinor).toBe(123_456n);
    expect(r.taxTotalMinor).toBe(0n);
    expect(r.residualMinor).toBe(0n);
    expect(r.roundTrips).toBe(true);
  });

  it('a zero-rate component beside a standard one stays at zero when a residual lands', () => {
    const r = extractTaxFromGross(4n, WITH_ZERO_RATE, 'half-even');
    expect(r.roundTrips).toBe(false);
    expect(r.netMinor).toBe(3n);
    expect(r.taxes.find((t) => t.code === 'ZERO')?.taxMinor).toBe(0n);
    expect(r.taxes.find((t) => t.code === 'STD')?.taxMinor).toBe(1n);
    expect(r.netMinor + sumTax(r.taxes)).toBe(4n);
  });

  it('a single component and a twelve-component set behave identically in kind', () => {
    const many = Array.from({ length: 12 }, (_, i) => flat(`C${i}`, BigInt(50 * (i + 1))));
    for (const set of [SINGLE_HALF_EVEN, many]) {
      for (const g of [1n, 7n, 999n, 100_000n, 10n ** 18n]) {
        const r = extractTaxFromGross(g, set, 'half-even');
        expect(r.netMinor + sumTax(r.taxes)).toBe(g);
      }
      // and each is the exact inverse of its own forward path
      const forward = composeTaxFromNet(987_654n, set);
      const back = extractTaxFromGross(forward.grossMinor, set, 'half-even');
      expect(back.netMinor).toBe(987_654n);
      expect(back.taxes).toEqual(forward.taxes);
    }
  });

  it('a rate above 100% on a sub-unit gross: the whole price is tax, and it says so', () => {
    // The zero-base fallback. Candidate net = ROUND(4 / 11) = 0, so every base
    // is zero and the claim weights fall back to the rate itself. Net 0, tax 4
    // is the correct rounding of net 0.36 / tax 3.64 — not net 4, tax 0.
    const thousandPercent = [flat('X', 100_000n)];
    const r = extractTaxFromGross(4n, thousandPercent, 'half-even');
    expect(r.netMinor).toBe(0n);
    expect(r.taxes[0]?.taxMinor).toBe(4n);
    expect(r.taxes[0]?.residualMinor).toBe(4n);
    expect(r.roundTrips).toBe(false);
  });
});

describe('boundary: where the remainder lands', () => {
  const twoEqual = [flat('A', 1_500n), flat('B', 1_500n)];

  it('equal claims tie-break to PACK ORDER, exactly as allocate documents', () => {
    // f(3) = 3, f(4) = 6 — a gross of 5 has no preimage. Candidate net is 4,
    // whose components compute to 1 and 1, so the residual is MINUS one. The
    // magnitude is allocated first (tie -> equal weight -> lower index -> A),
    // then the sign is applied, so A is the component that gives one back.
    const r = extractTaxFromGross(5n, twoEqual, 'half-even');
    expect(r.netMinor).toBe(4n);
    expect(r.residualMinor).toBe(-1n);
    expect(r.taxes[0]?.computedMinor).toBe(1n);
    expect(r.taxes[0]?.residualMinor).toBe(-1n);
    expect(r.taxes[0]?.taxMinor).toBe(0n);
    expect(r.taxes[1]?.taxMinor).toBe(1n);
    expect(r.netMinor + sumTax(r.taxes)).toBe(5n);
  });

  it('the mirror refund removes the unit from the SAME component', () => {
    const r = extractTaxFromGross(-5n, twoEqual, 'half-even');
    expect(r.netMinor).toBe(-4n);
    expect(r.taxes[0]?.taxMinor).toBe(0n);
    expect(r.taxes[1]?.taxMinor).toBe(-1n);
    expect(r.netMinor + sumTax(r.taxes)).toBe(-5n);
  });

  it('the largest claim takes the unit — the highest-rate component, not the first', () => {
    const r = extractTaxFromGross(4n, GH_2026, 'half-even');
    expect(r.taxes.map((t) => t.residualMinor)).toEqual([0n, 0n, 1n]); // NHIL, GETFund, VAT
  });

  it('HOW OFTEN this happens, measured: 1 shelf price in 6 under the flat 20% set', () => {
    // Stated rather than left as a vague "occasionally". The forward map advances
    // 6 grosses per 5 nets, so exactly one gross in six has no exact net. The
    // residual is ALWAYS ±1 minor unit and ALWAYS lands on VAT — the largest
    // claim — so the worst case a customer or an auditor can ever see is one
    // pesewa of tax moved between the printed lines, never a broken total.
    let skipped = 0;
    for (let g = 0n; g < 6_000n; g++) {
      const r = extractTaxFromGross(g, GH_2026, 'half-even');
      expect(r.netMinor + sumTax(r.taxes)).toBe(g);
      if (r.roundTrips) continue;
      skipped++;
      expect([1n, -1n]).toContain(r.residualMinor);
      expect(r.taxes.filter((t) => t.residualMinor !== 0n).map((t) => t.code)).toEqual(['GH.VAT.STD']);
    }
    expect(skipped).toBe(1_000); // 16.67%
  });

  it('the residual never re-enters a cascade base', () => {
    // A residual placed on an early component must not shift a later
    // component's base; if it did, the identity would reopen.
    for (let g = 0n; g <= 200n; g++) {
      const r = extractTaxFromGross(g, DEEP_CASCADE, 'half-up');
      const forward = composeTaxFromNet(r.netMinor, DEEP_CASCADE);
      r.taxes.forEach((t, i) => {
        expect(t.baseMinor).toBe(forward.taxes[i]!.baseMinor);
        expect(t.computedMinor).toBe(forward.taxes[i]!.computedMinor);
      });
    }
  });
});

describe('boundary: type discipline at the entry point', () => {
  it('refuses a number gross', () => {
    expect(() => extractTaxFromGross(1_000 as unknown as bigint, GH_2026, 'half-even')).toThrow(MoneyError);
  });

  it('refuses an unnamed or unknown net rounding mode — nothing here defaults', () => {
    expect(() => extractTaxFromGross(1_000n, GH_2026, undefined as unknown as RoundingMode)).toThrow(
      /netRoundingMode/,
    );
    expect(() => extractTaxFromGross(1_000n, GH_2026, 'nearest' as never)).toThrow(/netRoundingMode/);
  });

  it('refuses an empty component set rather than pricing at zero tax', () => {
    expect(() => extractTaxFromGross(1_000n, [], 'half-even')).toThrow(/at least one component/);
  });
});
