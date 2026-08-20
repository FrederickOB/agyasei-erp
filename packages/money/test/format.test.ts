import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  deserializeMoney,
  format,
  formatWithSymbol,
  parse,
  serializeMoney,
  type CurrencySpec,
} from '../src/index.js';

// Specs come from the jurisdiction pack in production; these stand in for
// packs at every legal scale. NOTHING here assumes scale 2.
const GHS: CurrencySpec = { code: 'GHS', symbol: 'GH₵', scale: 2 };
const S0: CurrencySpec = { code: 'XS0', symbol: 'S0', scale: 0 };
const S3: CurrencySpec = { code: 'XS3', symbol: 'S3', scale: 3 };
const S4: CurrencySpec = { code: 'XS4', symbol: 'S4', scale: 4 };
const ALL_SPECS = [S0, GHS, S3, S4] as const;

describe('format', () => {
  it('renders canonical decimal strings at the spec scale', () => {
    expect(format(123456n, GHS)).toBe('1234.56');
    expect(format(0n, GHS)).toBe('0.00');
    expect(format(-5n, GHS)).toBe('-0.05');
    expect(format(5n, S0)).toBe('5');
    expect(format(-5n, S0)).toBe('-5');
    expect(format(5n, S3)).toBe('0.005');
    expect(format(12_3456n, S4)).toBe('12.3456');
  });

  it('formatWithSymbol is display-only: symbol after the sign', () => {
    expect(formatWithSymbol(123456n, GHS)).toBe('GH₵1234.56');
    expect(formatWithSymbol(-5n, GHS)).toBe('-GH₵0.05');
    expect(() => parse(formatWithSymbol(5n, GHS), GHS)).toThrow(MoneyError);
  });

  it('rejects number amounts at runtime', () => {
    const anyFormat = format as unknown as (a: unknown, s: CurrencySpec) => string;
    expect(() => anyFormat(12.34, GHS)).toThrow(MoneyError);
  });
});

describe('format -> parse round-trip', () => {
  it('property: parse(format(a)) === a for scales 0, 2, 3, 4 at any magnitude', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }),
        fc.constantFrom(...ALL_SPECS),
        (amount, spec) => {
          expect(parse(format(amount, spec), spec)).toBe(amount);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('property: format output is canonical — sign, digits, exactly scale fraction digits', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }),
        fc.constantFrom(...ALL_SPECS),
        (amount, spec) => {
          const text = format(amount, spec);
          if (spec.scale === 0) {
            expect(text).toMatch(/^-?\d+$/);
          } else {
            expect(text).toMatch(new RegExp(`^-?\\d+\\.\\d{${spec.scale}}$`));
          }
        },
      ),
    );
  });
});

describe('parse — exactness and strictness', () => {
  it('accepts shorter-than-scale fractions and bare integers, exactly', () => {
    expect(parse('1.5', GHS)).toBe(150n);
    expect(parse('12', GHS)).toBe(1200n);
    expect(parse('0.005', S3)).toBe(5n);
    expect(parse('-0.05', GHS)).toBe(-5n);
    expect(parse('0', S0)).toBe(0n);
    expect(parse('-0', GHS)).toBe(0n);
  });

  it('REJECTS precision beyond the scale — including exact trailing zeros', () => {
    expect(() => parse('1.005', GHS)).toThrow(MoneyError); // the named negative case
    expect(() => parse('1.500', GHS)).toThrow(MoneyError); // representable, still rejected
    expect(() => parse('1.0', S0)).toThrow(MoneyError); // any fraction at scale 0
    expect(() => parse('1.00005', S4)).toThrow(MoneyError);
  });

  it('REJECTS exponents and float notation', () => {
    for (const bad of ['1e2', '1E2', '1.5e3', '-1e-2', '0x10', 'NaN', 'Infinity', '-Infinity']) {
      expect(() => parse(bad, GHS), bad).toThrow(MoneyError);
    }
  });

  it('REJECTS separators, spaces, signs in the wrong place, and malformed decimals', () => {
    for (const bad of [
      '',
      ' ',
      ' 1.00',
      '1.00 ',
      '1,000.00',
      '+1.00',
      '1.',
      '.5',
      '-',
      '--1',
      '1.2.3',
      '1_000',
      '١٢٣', // non-ASCII digits
      'GH₵1.00',
    ]) {
      expect(() => parse(bad, GHS), JSON.stringify(bad)).toThrow(MoneyError);
    }
  });

  it('REJECTS non-string input — no float path exists into parse', () => {
    const anyParse = parse as unknown as (t: unknown, s: CurrencySpec) => bigint;
    expect(() => anyParse(1.005, GHS)).toThrow(MoneyError);
    expect(() => anyParse(Number.NaN, GHS)).toThrow(MoneyError);
    expect(() => anyParse(100n, GHS)).toThrow(MoneyError);
    expect(() => anyParse(undefined, GHS)).toThrow(MoneyError);
  });

  it('rejects a malformed currency spec rather than assuming scale 2', () => {
    const bad = { code: 'GHS', symbol: 'GH₵', scale: 2.5 } as unknown as CurrencySpec;
    expect(() => parse('1.00', bad)).toThrow(MoneyError);
    const bad5 = { code: 'GHS', symbol: 'GH₵', scale: 5 } as unknown as CurrencySpec;
    expect(() => format(100n, bad5)).toThrow(MoneyError);
  });
});

describe('serializeMoney / deserializeMoney — the JSON boundary', () => {
  it('property: round-trips any bigint via a decimal string', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), (amount) => {
        const wire = serializeMoney(amount);
        expect(wire).toMatch(/^-?\d+$/);
        expect(deserializeMoney(wire)).toBe(amount);
        // and it survives an actual JSON document as a string
        const doc: unknown = JSON.parse(JSON.stringify({ amountMinor: wire }));
        expect(deserializeMoney((doc as { amountMinor: string }).amountMinor)).toBe(amount);
      }),
      { numRuns: 500 },
    );
  });

  it('rejects floats, exponents, and junk on the way back in', () => {
    for (const bad of ['1.5', '1e2', '', 'NaN', 'Infinity', '0x1', '1n', '+1', '1.0', ' 1', '--2']) {
      expect(() => deserializeMoney(bad), JSON.stringify(bad)).toThrow(MoneyError);
    }
    const anyDeser = deserializeMoney as unknown as (t: unknown) => bigint;
    expect(() => anyDeser(123)).toThrow(MoneyError); // a JSON number is a float64 — refused
    const anySer = serializeMoney as unknown as (a: unknown) => string;
    expect(() => anySer(123)).toThrow(MoneyError);
  });
});
