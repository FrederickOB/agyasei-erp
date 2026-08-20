/**
 * @erp/money — the platform's single money module.
 *
 * ADR-0004 in code: every monetary amount is a `bigint` in the currency's
 * minor unit; the minor-unit scale comes from the jurisdiction pack
 * (ADR-0007) and is NEVER assumed to be 100; rates and unit prices are e4
 * scaled integers; percentages are basis points; every rounding site names
 * its RoundingMode explicitly; allocations sum back exactly. No `number`
 * ever holds a monetary magnitude — runtime asserts enforce it on every
 * entry point, which also makes NaN/Infinity paths impossible.
 *
 * ── Q8 SEAM — Ghana e-VAT clearance (docs/open-questions.md Q8, §7.4.4) ──
 * This module computes tax AMOUNTS: `mulBps` against pack-supplied `rate_bp`
 * rows, with `base_kind`/`base_includes` composition driven by the caller
 * from `tax_rate` data (see the golden tests for the worked §7.2.4 shapes).
 * It deliberately contains NO invoice issuance or clearance surface — no
 * Certified Invoicing System fields, no SDC identifiers, no QR payloads,
 * no clearance status. Q8 is UNRESOLVED (`NEEDS-HUMAN`); when it resolves,
 * issuance belongs in the jurisdiction-pack / POS document layer, not here.
 * This package stays pure integer arithmetic.
 * ─────────────────────────────────────────────────────────────────────────
 */

export { MoneyError } from './errors.js';
export {
  DEFAULT_ROUNDING,
  assertCurrencySpec,
  assertMinorUnits,
  assertRoundingMode,
  type BasisPoints,
  type CurrencySpec,
  type MinorUnits,
  type RateE4,
  type RoundingMode,
} from './types.js';
export { divRound, floorDivRem } from './rounding.js';
export { abs, add, compare, lineNetMinor, mulBps, mulDiv, mulRateE4, negate, sub } from './arith.js';
export { allocate } from './allocate.js';
export { format, formatWithSymbol, parse } from './format.js';
export { deserializeMoney, serializeMoney } from './serialize.js';
