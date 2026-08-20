import { MoneyError } from './errors.js';
import { assertMinorUnits, type MinorUnits } from './types.js';

/**
 * JSON boundary. `JSON.stringify(1234567890123456789n)` throws, and a JSON
 * number is a float64 in every JavaScript consumer — so money crosses JSON as a
 * DECIMAL STRING OF MINOR UNITS, e.g. `"123456"` for GH₵1,234.56. The scale
 * travels separately with the jurisdiction pack / CurrencySpec; the wire value
 * is scale-free integer minor units.
 */
export function serializeMoney(amount: MinorUnits): string {
  assertMinorUnits(amount, 'amount');
  return amount.toString(10);
}

/** Optional sign then ASCII digits. Nothing else — no exponent, no dot, no
 * spaces, no hex — so a float can never sneak back in through the wire. */
const WIRE_RE = /^-?\d+$/;

/**
 * Inverse of {@link serializeMoney}. Rejects anything that is not an integer
 * decimal string: `'1.5'`, `'1e2'`, `''`, `'NaN'`, `'0x10'` all throw.
 * `deserializeMoney(serializeMoney(a)) === a` for every bigint.
 */
export function deserializeMoney(text: string): MinorUnits {
  if (typeof text !== 'string' || !WIRE_RE.test(text)) {
    throw new MoneyError(
      `deserializeMoney: '${String(text)}' is not an integer minor-unit decimal string`,
    );
  }
  return BigInt(text);
}
