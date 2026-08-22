/**
 * Quantities are scaled integers (ADR-0004; §8.3): a qty of 2500n at scale 3
 * is 2.500 units. The scale comes from the product's unit definition, never
 * assumed. No float ever holds a quantity.
 */
import { MoneyError } from '@erp/money';

export function assertQtyScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) {
    throw new MoneyError(`qty scale must be an integer 0-6, got ${String(scale)}`);
  }
}

/** One whole selling unit at the given scale: 1n at scale 0, 1000n at scale 3. */
export function oneWholeUnit(scale: number): bigint {
  assertQtyScale(scale);
  return 10n ** BigInt(scale);
}

/**
 * Exact decimal display of a scaled quantity, trailing zeros trimmed
 * (2.500 -> "2.5"; §8.3: trimming is a DISPLAY rule that never feeds back
 * into arithmetic).
 */
export function formatQtyScaled(qtyScaled: bigint, scale: number): string {
  if (typeof qtyScaled !== 'bigint') {
    throw new MoneyError('formatQtyScaled: qtyScaled must be a bigint (ADR-0004)');
  }
  assertQtyScale(scale);
  const negative = qtyScaled < 0n;
  const digits = (negative ? -qtyScaled : qtyScaled).toString();
  if (scale === 0) return (negative ? '-' : '') + digits;
  const padded = digits.padStart(scale + 1, '0');
  const split = padded.length - scale;
  const frac = padded.slice(split).replace(/0+$/, '');
  const whole = padded.slice(0, split);
  return `${negative ? '-' : ''}${whole}${frac.length > 0 ? '.' + frac : ''}`;
}

/** Thrown when a typed quantity cannot be turned into an exact scaled integer. */
export class QuantityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuantityInputError';
  }
}

/**
 * A typed NON-NEGATIVE quantity, as an exact scaled integer.
 *
 * The inverse of `formatQtyScaled`, and the only way a keyboard produces a
 * quantity in this client. Two things it deliberately refuses rather than
 * absorbs:
 *
 *  · **more decimal places than the unit has.** `2.555` in a unit that counts
 *    to three decimals is exact; in a unit that counts whole bags it is a
 *    number somebody meant differently, and rounding it silently is how a
 *    threshold ends up one bag off in the direction nobody checked.
 *  · **anything a float would have accepted** — `1e3`, `0x10`, `1,5`, a bare
 *    `.` — because `Number()` accepts all of them and every one of them is a
 *    typo with a plausible reading (ADR-0004: no float ever holds a quantity).
 */
export function parseQtyScaled(text: string, scale: number): bigint {
  assertQtyScale(scale);
  const trimmed = text.trim();
  const match = /^(\d+)(?:\.(\d*))?$|^\.(\d+)$/.exec(trimmed);
  if (match === null) {
    throw new QuantityInputError('Enter a quantity using digits, and a dot for any decimals.');
  }
  const whole = match[1] ?? '0';
  const frac = match[2] ?? match[3] ?? '';
  if (frac.length > scale) {
    throw new QuantityInputError(
      scale === 0
        ? 'This unit is counted in whole numbers.'
        : `This unit goes to ${String(scale)} decimal place${scale === 1 ? '' : 's'}.`,
    );
  }
  return BigInt(whole + frac.padEnd(scale, '0'));
}
