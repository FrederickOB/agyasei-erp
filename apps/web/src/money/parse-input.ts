/**
 * Typed money → bigint minor units, or null while the text is not yet an
 * amount. ONE place, so every money field on the counter (the tender, the
 * float, the count) parses exactly the way the tender always has: through
 * `@erp/money` against the configured CurrencySpec, never through a float.
 */
import { parse, type CurrencySpec } from '@erp/money';

export function parseMoneyOrNull(text: string, spec: CurrencySpec): bigint | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return parse(trimmed, spec);
  } catch {
    return null; // not a canonical amount yet — the control stays disabled
  }
}
