/**
 * The two arithmetic seams the reporting and stock screens added.
 *
 * Both are money-adjacent under CLAUDE.md §2.7: a gross margin percentage is
 * a figure somebody compares to a target and acts on, and a reorder threshold
 * is a quantity that decides whether a lorry is sent. Neither may pass
 * through a float, and both round exactly once, explicitly.
 */
import { describe, expect, it } from 'vitest';
import { formatBasisPointsAsPercent, formatDaysE4, formatPercentE4 } from '../src/lib/ratio';
import { parseQtyScaled, QuantityInputError } from '../src/lib/quantity';

describe('ratios rendered from scaled integers', () => {
  it('renders a percentage × 10⁴ to two places, rounding half away from zero', () => {
    expect(formatPercentE4(193_250n)).toBe('19.33'); // exact tie, rounds up
    expect(formatPercentE4(193_240n)).toBe('19.32');
    expect(formatPercentE4(200_000n)).toBe('20'); // trailing zeros trimmed
    expect(formatPercentE4(0n)).toBe('0');
  });

  it('keeps a negative margin negative rather than losing the sign', () => {
    expect(formatPercentE4(-50_000n)).toBe('-5');
    expect(formatPercentE4(-193_250n)).toBe('-19.33');
  });

  it('renders days of cover × 10⁴ to one place', () => {
    expect(formatDaysE4(421_234n)).toBe('42.1');
    expect(formatDaysE4(350_000n)).toBe('35');
    expect(formatDaysE4(455_000n)).toBe('45.5');
  });

  it('renders the low-stock coverage ordering key as a percentage', () => {
    expect(formatBasisPointsAsPercent(2_000n)).toBe('20');
    expect(formatBasisPointsAsPercent(0n)).toBe('0');
    expect(formatBasisPointsAsPercent(1_234n)).toBe('12.3');
  });

  it('takes bigints, so nothing upstream can hand it a float', () => {
    // @ts-expect-error a number is not a scaled integer (ADR-0004)
    expect(() => formatPercentE4(19.325)).toThrow();
  });
});

describe('a quantity typed at a counter', () => {
  it('is exact at the unit’s own scale', () => {
    expect(parseQtyScaled('20', 0)).toBe(20n);
    expect(parseQtyScaled('2.5', 3)).toBe(2500n);
    expect(parseQtyScaled('2.500', 3)).toBe(2500n);
    expect(parseQtyScaled('0', 2)).toBe(0n);
    expect(parseQtyScaled(' 12 ', 0)).toBe(12n);
    expect(parseQtyScaled('.5', 1)).toBe(5n);
  });

  it('refuses more precision than the unit has, instead of rounding it away', () => {
    expect(() => parseQtyScaled('20.5', 0)).toThrow(QuantityInputError);
    expect(() => parseQtyScaled('2.5555', 3)).toThrow(QuantityInputError);
    // And says which, so somebody can fix it without guessing.
    try {
      parseQtyScaled('20.5', 0);
    } catch (err) {
      expect((err as Error).message).toContain('whole numbers');
    }
  });

  it('refuses everything a float would have swallowed', () => {
    for (const bad of ['1e3', '0x10', '1,5', '.', '', '-1', 'NaN', 'Infinity', '1 2']) {
      expect(() => parseQtyScaled(bad, 2), bad).toThrow(QuantityInputError);
    }
  });

  it('round-trips against the renderer for every scale it accepts', () => {
    // The pairing that matters: what a threshold form shows is what the next
    // person typing over it produces.
    const cases: readonly [string, number][] = [
      ['20', 0],
      ['2.5', 1],
      ['0.125', 3],
      ['1000', 0],
    ];
    for (const [text, scale] of cases) {
      const scaled = parseQtyScaled(text, scale);
      expect(typeof scaled).toBe('bigint');
      expect(parseQtyScaled(text, scale)).toBe(scaled);
    }
  });
});
