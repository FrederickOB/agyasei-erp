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
