import { MoneyError } from './errors.js';
import { assertCurrencySpec, assertMinorUnits, type CurrencySpec, type MinorUnits } from './types.js';

/**
 * Render minor units as the canonical decimal string for the currency's scale:
 * exactly `spec.scale` fraction digits, `-` prefix for negatives, no grouping,
 * no symbol. This is the ONE place an amount becomes a decimal string
 * (ADR-0004: "conversion to a decimal string happens once, at the presentation
 * boundary"), and it round-trips exactly through {@link parse}.
 *
 *   format(123456n, GHS)          === '1234.56'   (GHS scale 2)
 *   format(-5n,     GHS)          === '-0.05'
 *   format(1234n,   scale0Spec)   === '1234'
 */
export function format(amount: MinorUnits, spec: CurrencySpec): string {
  assertMinorUnits(amount, 'amount');
  assertCurrencySpec(spec);
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString();
  if (spec.scale === 0) {
    return (negative ? '-' : '') + digits;
  }
  const padded = digits.padStart(spec.scale + 1, '0');
  const split = padded.length - spec.scale;
  return `${negative ? '-' : ''}${padded.slice(0, split)}.${padded.slice(split)}`;
}

/**
 * Display-only convenience: symbol after the sign, e.g. `-GH₵0.05`.
 * NOT parseable and never sent over a wire — use {@link serializeMoney} for that.
 */
export function formatWithSymbol(amount: MinorUnits, spec: CurrencySpec): string {
  const canonical = format(amount, spec);
  return canonical.startsWith('-') ? `-${spec.symbol}${canonical.slice(1)}` : `${spec.symbol}${canonical}`;
}

/** Canonical decimal amount: optional sign, integer digits, optional fraction.
 * ASCII digits only. No exponent, no grouping, no leading/trailing space, no
 * symbol, no lone dot or trailing dot. */
const PARSE_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a canonical decimal string into minor units, exactly. Strict by design
 * — this is a money boundary, and anything ambiguous is rejected with
 * MoneyError rather than guessed at:
 *
 * - REJECTS non-strings (there is no float input path — a `number` cannot
 *   reach this function's happy path, so NaN/Infinity are impossible).
 * - REJECTS exponents (`1e2`), hex (`0x10`), `NaN`, `Infinity`.
 * - REJECTS grouping separators, spaces, currency symbols, `+` signs.
 * - REJECTS precision beyond the currency's scale — `parse('1.005', scale 2)`
 *   throws, and so does `'1.500'` even though its value is representable:
 *   extra digits at a money boundary signal a scale mismatch, never noise.
 * - ACCEPTS fewer fraction digits than the scale (`'1.5'` at scale 2 → 150n)
 *   and a bare integer (`'12'` at scale 2 → 1200n): both are exact.
 *
 * Round-trip guarantee: `parse(format(a, spec), spec) === a` for every bigint.
 */
export function parse(text: string, spec: CurrencySpec): MinorUnits {
  if (typeof text !== 'string') {
    throw new MoneyError(`parse: input must be a string, got ${typeof text}`);
  }
  assertCurrencySpec(spec);
  const match = PARSE_RE.exec(text);
  if (match === null) {
    throw new MoneyError(
      `parse: '${text}' is not a canonical decimal amount ` +
        `(digits with optional sign and fraction; no exponents, separators, or symbols)`,
    );
  }
  const whole = match[2]!;
  const frac = match[3] ?? '';
  if (frac.length > spec.scale) {
    throw new MoneyError(
      `parse: '${text}' has ${frac.length} fraction digit(s); ${spec.code} scale is ${spec.scale}`,
    );
  }
  const scaleFactor = 10n ** BigInt(spec.scale);
  const fracMinor = frac.length === 0 ? 0n : BigInt(frac.padEnd(spec.scale, '0'));
  const minor = BigInt(whole) * scaleFactor + fracMinor;
  return match[1] === '-' ? -minor : minor;
}
