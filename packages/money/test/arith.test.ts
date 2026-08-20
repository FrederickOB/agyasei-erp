import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUNDING,
  MoneyError,
  abs,
  add,
  compare,
  divRound,
  mulBps,
  mulDiv,
  mulRateE4,
  negate,
  sub,
  type RoundingMode,
} from '../src/index.js';

const MODES: readonly RoundingMode[] = ['half-even', 'half-up', 'down', 'up'];
const BIG = 10n ** 18n;

describe('basic arithmetic', () => {
  it('adds, subtracts, negates exactly', () => {
    expect(add(1n, 2n)).toBe(3n);
    expect(sub(1n, 2n)).toBe(-1n);
    expect(negate(5n)).toBe(-5n);
    expect(negate(0n)).toBe(0n);
    expect(abs(-7n)).toBe(7n);
  });

  it('compare returns -1/0/1', () => {
    expect(compare(1n, 2n)).toBe(-1);
    expect(compare(2n, 2n)).toBe(0);
    expect(compare(3n, 2n)).toBe(1);
  });

  it('property: add/sub round-trip and stay exact at any magnitude', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -BIG, max: BIG }), fc.bigInt({ min: -BIG, max: BIG }), (a, b) => {
        expect(sub(add(a, b), b)).toBe(a);
        expect(add(a, negate(a))).toBe(0n);
      }),
    );
  });
});

describe('runtime type discipline (ADR-0004)', () => {
  it('rejects number for any monetary parameter', () => {
    const anyAdd = add as unknown as (a: unknown, b: unknown) => bigint;
    expect(() => anyAdd(1, 2n)).toThrow(MoneyError);
    expect(() => anyAdd(2n, 1.5)).toThrow(MoneyError);
    const anyMul = mulRateE4 as unknown as (a: unknown, r: unknown, m: unknown) => bigint;
    expect(() => anyMul(100, 10000n, 'half-even')).toThrow(MoneyError);
    expect(() => anyMul(100n, 10000, 'half-even')).toThrow(MoneyError);
  });

  it('float NaN/Infinity cannot enter: numbers are rejected before arithmetic', () => {
    const anyMul = mulBps as unknown as (a: unknown, r: unknown, m: unknown) => bigint;
    expect(() => anyMul(Number.NaN, 1500n, 'half-up')).toThrow(MoneyError);
    expect(() => anyMul(Number.POSITIVE_INFINITY, 1500n, 'half-up')).toThrow(MoneyError);
  });

  it('rejects an unknown rounding mode instead of guessing', () => {
    const anyDiv = divRound as unknown as (n: unknown, d: unknown, m: unknown) => bigint;
    expect(() => anyDiv(1n, 2n, 'floor')).toThrow(MoneyError);
    expect(() => anyDiv(1n, 2n, undefined)).toThrow(MoneyError);
  });

  it('DEFAULT_ROUNDING is half-even and still must be passed explicitly', () => {
    expect(DEFAULT_ROUNDING).toBe('half-even');
  });
});

describe('divRound mode semantics', () => {
  it('half-even: ties go to the even neighbour', () => {
    expect(divRound(25n, 10n, 'half-even')).toBe(2n); // 2.5 -> 2
    expect(divRound(35n, 10n, 'half-even')).toBe(4n); // 3.5 -> 4
    expect(divRound(-25n, 10n, 'half-even')).toBe(-2n);
    expect(divRound(-35n, 10n, 'half-even')).toBe(-4n);
    expect(divRound(26n, 10n, 'half-even')).toBe(3n); // 2.6 -> 3, not a tie
  });

  it('half-up: ties away from zero', () => {
    expect(divRound(25n, 10n, 'half-up')).toBe(3n);
    expect(divRound(-25n, 10n, 'half-up')).toBe(-3n);
    expect(divRound(24n, 10n, 'half-up')).toBe(2n);
  });

  it('down: toward zero; up: away from zero', () => {
    expect(divRound(29n, 10n, 'down')).toBe(2n);
    expect(divRound(-29n, 10n, 'down')).toBe(-2n);
    expect(divRound(21n, 10n, 'up')).toBe(3n);
    expect(divRound(-21n, 10n, 'up')).toBe(-3n);
  });

  it('negative denominator is normalised, division by zero throws', () => {
    expect(divRound(25n, -10n, 'half-up')).toBe(-3n);
    expect(() => divRound(1n, 0n, 'half-up')).toThrow(MoneyError);
    expect(() => mulDiv(1n, 1n, 0n, 'half-up')).toThrow(MoneyError);
  });

  it('property: result is within 1 of the exact rational, exact when divisible', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -BIG, max: BIG }),
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.constantFrom(...MODES),
        (n, d, mode) => {
          const q = divRound(n, d, mode);
          const err = n - q * d;
          expect(err < d && err > -d).toBe(true); // |error| < 1 unit
          if (n % d === 0n) expect(q * d).toBe(n);
        },
      ),
    );
  });
});

describe('mulRateE4', () => {
  it('property: rate 10000 (1.0) is the identity under every mode', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -BIG, max: BIG }), fc.constantFrom(...MODES), (a, mode) => {
        expect(mulRateE4(a, 10_000n, mode)).toBe(a);
      }),
    );
  });

  it('property: monotone in amount for non-negative rates', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -BIG, max: BIG }),
        fc.bigInt({ min: -BIG, max: BIG }),
        fc.bigInt({ min: 0n, max: 10n ** 8n }),
        fc.constantFrom(...MODES),
        (a1, a2, rate, mode) => {
          const [lo, hi] = a1 <= a2 ? [a1, a2] : [a2, a1];
          expect(mulRateE4(lo, rate, mode) <= mulRateE4(hi, rate, mode)).toBe(true);
        },
      ),
    );
  });

  it('property: zero rate yields zero; scaling by 2.0 doubles exactly', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -BIG, max: BIG }), fc.constantFrom(...MODES), (a, mode) => {
        expect(mulRateE4(a, 0n, mode)).toBe(0n);
        expect(mulRateE4(a, 20_000n, mode)).toBe(a * 2n);
      }),
    );
  });

  it('rounds once at the stated mode', () => {
    // 33 x 1.5000 = 49.5 -> tie between 49 and 50; half-even picks the even 50
    expect(mulRateE4(33n, 15_000n, 'half-even')).toBe(50n);
    expect(mulRateE4(33n, 15_000n, 'half-up')).toBe(50n);
    expect(mulRateE4(33n, 15_000n, 'down')).toBe(49n);
    // 31 x 1.5 = 46.5 -> half-even 46 (tie, 46 is even), half-up 47
    expect(mulRateE4(31n, 15_000n, 'half-even')).toBe(46n);
    expect(mulRateE4(31n, 15_000n, 'half-up')).toBe(47n);
  });
});

describe('mulBps', () => {
  it('15% of GH1.00 (scale 2) is 15 pesewas; 10000 bp is 100%', () => {
    expect(mulBps(100n, 1_500n, 'half-up')).toBe(15n);
    expect(mulBps(12_345n, 10_000n, 'half-even')).toBe(12_345n);
  });

  it('exposes the half-up / half-even difference exactly at a tie', () => {
    // 20 minor units x 250 bp = 0.5 exactly
    expect(mulBps(20n, 250n, 'half-up')).toBe(1n);
    expect(mulBps(20n, 250n, 'half-even')).toBe(0n);
    expect(mulBps(20n, 250n, 'down')).toBe(0n);
    expect(mulBps(20n, 250n, 'up')).toBe(1n);
  });

  it('property: mulBps(a, bps) + mulBps(a, 10000-bps) differs from a by at most one unit', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: BIG }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.constantFrom(...MODES),
        (a, bps, mode) => {
          const together = mulBps(a, bps, mode) + mulBps(a, 10_000n - bps, mode);
          const diff = together - a;
          expect(diff >= -1n && diff <= 1n).toBe(true);
        },
      ),
    );
  });
});
