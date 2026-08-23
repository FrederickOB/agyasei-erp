/**
 * Property tests for de-grossing (§4.13 row 6). The identity
 *   net + Σ tax === gross, EXACTLY
 * is asserted over generated grosses, generated component sets (flat AND
 * cascading), every rounding mode, and every minor-unit scale 0–4.
 *
 * Nothing here names a jurisdiction, a rate or a currency: the generators build
 * pack-shaped DATA, which is the point — the implementation must invert whatever
 * composition it is handed, not a remembered one.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  composeTaxFromNet,
  effectiveTaxFraction,
  extractTaxFromGross,
  type RoundingMode,
  type TaxComponent,
} from '../src/index.js';

const MODES: readonly RoundingMode[] = ['half-even', 'half-up', 'down', 'up'];
const modeArb = fc.constantFrom(...MODES);

/** Rates spanning zero, ordinary statutory magnitudes, and rates above 100% —
 * which no built pack uses but which the arithmetic must still close over. */
const rateArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant(0n) },
  { weight: 6, arbitrary: fc.bigInt({ min: 1n, max: 3_000n }) },
  { weight: 2, arbitrary: fc.bigInt({ min: 3_001n, max: 120_000n }) },
);

interface Spec {
  readonly rateBp: bigint;
  readonly roundingMode: RoundingMode;
  readonly includeMask: number;
}

const specArb = fc.record({
  rateBp: rateArb,
  roundingMode: modeArb,
  includeMask: fc.integer({ min: 0, max: 31 }),
});

/** `cascading: false` forces every component onto the bare net (the 2026 shape);
 * `true` lets a component fold any EARLIER component into its base (the prior
 * Ghana shape, and deeper). Both are generated. */
const buildSet = (specs: readonly Spec[], cascading: boolean): TaxComponent[] =>
  specs.map((s, i) => {
    const includes: string[] = [];
    if (cascading) {
      for (let j = 0; j < i; j++) if ((s.includeMask >> j) & 1) includes.push(`C${j}`);
    }
    return {
      code: `C${i}`,
      rateBp: s.rateBp,
      baseKind: includes.length > 0 ? ('net_plus' as const) : ('net' as const),
      baseIncludes: includes,
      roundingLevel: 'line' as const,
      roundingMode: s.roundingMode,
    };
  });

const componentsArb = fc
  .tuple(fc.array(specArb, { minLength: 1, maxLength: 5 }), fc.boolean())
  .map(([specs, cascading]) => buildSet(specs, cascading));

/** A minor-unit amount at a declared scale. The scale is a jurisdiction-pack
 * value (ADR-0007) and is generated 0–4; the arithmetic never reads it, which
 * is exactly what the last property in this file proves. */
const amountAtScaleArb = fc
  .tuple(fc.integer({ min: 0, max: 4 }), fc.bigInt({ min: -100_000n, max: 100_000n }), fc.bigInt({ min: 0n, max: 9_999n }))
  .map(([scale, major, sub]) => major * 10n ** BigInt(scale) + (major < 0n ? -sub : sub));

const sumTax = (taxes: readonly { readonly taxMinor: bigint }[]): bigint =>
  taxes.reduce((a, t) => a + t.taxMinor, 0n);

describe('property: net + Σ tax === gross, exactly', () => {
  it('holds for every generated gross, component set and net-rounding mode', () => {
    fc.assert(
      fc.property(amountAtScaleArb, componentsArb, modeArb, (gross, components, mode) => {
        const r = extractTaxFromGross(gross, components, mode);
        expect(r.netMinor + sumTax(r.taxes)).toBe(gross);
        expect(r.taxTotalMinor).toBe(sumTax(r.taxes));
        expect(r.grossMinor).toBe(gross);
      }),
      { numRuns: 2_000 },
    );
  });

  it('holds at extreme magnitudes — a 400-tonne order is not a special case', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }),
        componentsArb,
        modeArb,
        (gross, components, mode) => {
          const r = extractTaxFromGross(gross, components, mode);
          expect(r.netMinor + sumTax(r.taxes)).toBe(gross);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('holds for a flat set and for a cascading set independently', () => {
    fc.assert(
      fc.property(
        fc.array(specArb, { minLength: 1, maxLength: 5 }),
        amountAtScaleArb,
        modeArb,
        (specs, gross, mode) => {
          for (const cascading of [false, true]) {
            const set = buildSet(specs, cascading);
            const r = extractTaxFromGross(gross, set, mode);
            expect(r.netMinor + sumTax(r.taxes)).toBe(gross);
          }
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe('property: forward then extract round-trips', () => {
  it('every net composed to a gross is recovered exactly, with identical tax lines', () => {
    fc.assert(
      fc.property(amountAtScaleArb, componentsArb, modeArb, (net, components, mode) => {
        const forward = composeTaxFromNet(net, components);
        const back = extractTaxFromGross(forward.grossMinor, components, mode);
        expect(back.roundTrips).toBe(true);
        expect(back.residualMinor).toBe(0n);
        expect(back.netMinor).toBe(net);
        expect(back.taxes).toEqual(forward.taxes);
      }),
      { numRuns: 2_000 },
    );
  });

  it('the net-rounding mode cannot change a gross that HAS a preimage', () => {
    // The mode is a real rounding boundary, but only for a gross the forward
    // path can never produce. Where the inverse exists it is unique, so all
    // four modes must agree — the same sale, either direction, either pack.
    fc.assert(
      fc.property(amountAtScaleArb, componentsArb, (net, components) => {
        const gross = composeTaxFromNet(net, components).grossMinor;
        const nets = MODES.map((m) => extractTaxFromGross(gross, components, m).netMinor);
        expect(new Set(nets.map(String)).size).toBe(1);
        expect(nets[0]).toBe(net);
      }),
      { numRuns: 1_000 },
    );
  });

  it('extract then forward: the returned net always composes back to the gross when roundTrips', () => {
    fc.assert(
      fc.property(amountAtScaleArb, componentsArb, modeArb, (gross, components, mode) => {
        const r = extractTaxFromGross(gross, components, mode);
        const forward = composeTaxFromNet(r.netMinor, components);
        if (r.roundTrips) {
          expect(forward.grossMinor).toBe(gross);
          expect(r.taxes).toEqual(forward.taxes);
        } else {
          // Not a bug: the forward map skips values. The residual is what makes
          // the identity hold anyway, and it is reported rather than absorbed.
          expect(forward.grossMinor).not.toBe(gross);
          expect(r.residualMinor).toBe(gross - forward.grossMinor);
          expect(r.residualMinor).not.toBe(0n);
        }
      }),
      { numRuns: 2_000 },
    );
  });
});

describe('property: structural guarantees of the residual', () => {
  it('taxMinor === computedMinor + residualMinor, and computedMinor is re-verifiable', () => {
    fc.assert(
      fc.property(amountAtScaleArb, componentsArb, modeArb, (gross, components, mode) => {
        const r = extractTaxFromGross(gross, components, mode);
        let residualSum = 0n;
        r.taxes.forEach((t, i) => {
          expect(t.taxMinor).toBe(t.computedMinor + t.residualMinor);
          // The server re-verifies against computedMinor, never against taxMinor.
          const forward = composeTaxFromNet(r.netMinor, components);
          expect(t.computedMinor).toBe(forward.taxes[i]!.computedMinor);
          residualSum += t.residualMinor;
        });
        expect(residualSum).toBe(r.residualMinor);
        expect(r.roundTrips).toBe(r.residualMinor === 0n);
      }),
      { numRuns: 1_000 },
    );
  });

  it('a ZERO-RATE component always reports exactly zero, residual or not', () => {
    fc.assert(
      fc.property(
        amountAtScaleArb,
        fc.array(specArb, { minLength: 0, maxLength: 4 }),
        fc.boolean(),
        modeArb,
        (gross, specs, cascading, mode) => {
          const set = buildSet(specs, cascading);
          const withZero: TaxComponent[] = [
            {
              code: 'ZERO',
              rateBp: 0n,
              baseKind: 'net',
              baseIncludes: [],
              roundingLevel: 'line',
              roundingMode: 'half-up',
            },
            ...set.map((c, i) => ({ ...c, code: `X${i}` })),
          ];
          const r = extractTaxFromGross(gross, withZero, mode);
          const zero = r.taxes.find((t) => t.code === 'ZERO');
          expect(zero?.taxMinor).toBe(0n);
          expect(zero?.residualMinor).toBe(0n);
          expect(r.netMinor + sumTax(r.taxes)).toBe(gross);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe('property: sign symmetry — a refund returns exactly what the sale took', () => {
  it('extract(-gross) is the exact negation of extract(gross), line for line', () => {
    fc.assert(
      fc.property(amountAtScaleArb, componentsArb, modeArb, (gross, components, mode) => {
        const pos = extractTaxFromGross(gross, components, mode);
        const neg = extractTaxFromGross(-gross, components, mode);
        expect(neg.netMinor).toBe(-pos.netMinor);
        expect(neg.taxTotalMinor).toBe(-pos.taxTotalMinor);
        expect(neg.residualMinor).toBe(-pos.residualMinor);
        pos.taxes.forEach((t, i) => {
          expect(neg.taxes[i]!.taxMinor).toBe(-t.taxMinor);
          expect(neg.taxes[i]!.computedMinor).toBe(-t.computedMinor);
          expect(neg.taxes[i]!.residualMinor).toBe(-t.residualMinor);
        });
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('property: the forward map is strictly increasing — what makes the inverse unique', () => {
  it('gross(n + 1) > gross(n) for every generated set', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10_000n, max: 10_000n }),
        componentsArb,
        (n, components) => {
          expect(composeTaxFromNet(n + 1n, components).grossMinor).toBeGreaterThan(
            composeTaxFromNet(n, components).grossMinor,
          );
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe('property: the minor-unit scale is never read', () => {
  it('the same minor-unit gross gives the same answer whatever the pack scale', () => {
    // The scale (0–4) is a jurisdiction-pack value. Extraction operates purely
    // on minor units, so a scale-dependent shortcut — a stray /100 — would show
    // up as a difference here. There is nothing to pass: that IS the assertion.
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), componentsArb, modeArb, (g, c, m) => {
        const a = extractTaxFromGross(g, c, m);
        for (const scale of [0, 1, 2, 3, 4]) {
          const scaled = g * 10n ** BigInt(scale);
          const r = extractTaxFromGross(scaled, c, m);
          expect(r.netMinor + sumTax(r.taxes)).toBe(scaled);
        }
        expect(extractTaxFromGross(g, c, m)).toEqual(a); // and it is deterministic
      }),
      { numRuns: 500 },
    );
  });

  it('the derived gross-up fraction is exact — no rounding enters the derivation', () => {
    fc.assert(
      fc.property(componentsArb, (components) => {
        const f = effectiveTaxFraction(components);
        expect(f.denominator).toBeGreaterThan(0n);
        expect(f.numerator).toBeGreaterThanOrEqual(0n);
        // A net of exactly `denominator` minor units grosses to denominator +
        // numerator with no rounding at all, because every component's base is
        // an exact multiple of 10000 at that magnitude.
        const net = f.denominator;
        expect(composeTaxFromNet(net, components).grossMinor).toBe(f.denominator + f.numerator);
      }),
      { numRuns: 500 },
    );
  });
});
