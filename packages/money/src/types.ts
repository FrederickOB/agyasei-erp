import { MoneyError } from './errors.js';

/**
 * A monetary amount in the currency's minor unit (Ghana: pesewas), as a `bigint`.
 *
 * ADR-0004: money is `bigint` in Postgres AND TypeScript. `number` is float64 and
 * must never hold a monetary magnitude. This alias is documentation, not a brand —
 * the runtime guard is {@link assertMinorUnits}, which every function in this
 * package applies to every monetary parameter, so a `number` smuggled through an
 * `any` fails loudly instead of drifting.
 */
export type MinorUnits = bigint;

/**
 * A rate or unit price in e4 scaled-integer representation: minor units × 10⁴.
 * `10000n` is 1.0 (identity). §4.2.1 `app.rate_e4`.
 */
export type RateE4 = bigint;

/**
 * Basis points: 1 bp = 1/10000. `1500n` is 15%. §7.2.4 `rate_bp`.
 * Numerically both RateE4 and BasisPoints divide by 10⁴; they are kept as
 * separate names because they mean different things — a rate_e4 is a scaled
 * PRICE, a bp is a scaled PERCENTAGE — and confusing them is a 10⁴× error.
 */
export type BasisPoints = bigint;

/**
 * Explicit rounding modes. Every rounding site in the platform names one —
 * rounding is never implicit (ADR-0004, §4.13).
 *
 * - `'half-even'` — banker's rounding; ties go to the even neighbour. The
 *   platform default (see {@link DEFAULT_ROUNDING}), still always passed explicitly.
 * - `'half-up'`   — ties round away from zero (0.5 → 1, -0.5 → -1). The mode
 *   §4.13 names for extended line amounts and WAC.
 * - `'down'`      — toward zero (truncate).
 * - `'up'`        — away from zero.
 */
export type RoundingMode = 'half-even' | 'half-up' | 'down' | 'up';

/**
 * The platform's default rounding mode. Exported so callers can PASS it
 * explicitly — no function in this package defaults a mode parameter, because a
 * defaulted mode is an implicit rounding decision.
 */
export const DEFAULT_ROUNDING: RoundingMode = 'half-even';

/**
 * A currency as the jurisdiction pack defines it. `scale` is the number of
 * minor-unit digits per major unit — a JURISDICTION-PACK VALUE (ADR-0007).
 * It is 2 for GHS, 0 or 3 or 4 elsewhere. Nothing in this package assumes 100
 * minor units to the major unit, and there is deliberately no built-in currency
 * registry: the pack supplies the spec.
 */
export interface CurrencySpec {
  /** ISO 4217-style code, e.g. 'GHS'. */
  readonly code: string;
  /** Display symbol, e.g. 'GH₵'. Presentation only — never parsed. */
  readonly symbol: string;
  /** Minor-unit digits, 0–4. Never assumed; always from the jurisdiction pack. */
  readonly scale: 0 | 1 | 2 | 3 | 4;
}

/** Runtime guard: throws MoneyError unless `value` is a bigint. Applied to every
 * monetary parameter in this package so `number` (float64) can never carry a
 * monetary magnitude — which also makes NaN/Infinity paths impossible. */
export function assertMinorUnits(value: unknown, label: string): asserts value is bigint {
  if (typeof value !== 'bigint') {
    throw new MoneyError(
      `${label} must be a bigint, got ${typeof value} — ` +
        `monetary magnitudes never pass through number (ADR-0004)`,
    );
  }
}

const VALID_MODES: readonly RoundingMode[] = ['half-even', 'half-up', 'down', 'up'];

/** Runtime guard for RoundingMode, so an `any`-typed caller cannot smuggle in an
 * unknown mode and get silently-truncating behaviour. */
export function assertRoundingMode(mode: unknown, label = 'mode'): asserts mode is RoundingMode {
  if (typeof mode !== 'string' || !VALID_MODES.includes(mode as RoundingMode)) {
    throw new MoneyError(`${label} must be one of ${VALID_MODES.join(', ')}; got ${String(mode)}`);
  }
}

/** Runtime guard for CurrencySpec. `scale` here is a digit COUNT, not a monetary
 * magnitude, so `number` is correct for it. */
export function assertCurrencySpec(spec: CurrencySpec): void {
  if (typeof spec !== 'object' || spec === null) {
    throw new MoneyError('currency spec must be an object');
  }
  if (typeof spec.code !== 'string' || spec.code.length === 0) {
    throw new MoneyError('currency spec: code must be a non-empty string');
  }
  if (typeof spec.symbol !== 'string') {
    throw new MoneyError('currency spec: symbol must be a string');
  }
  if (typeof spec.scale !== 'number' || !Number.isInteger(spec.scale) || spec.scale < 0 || spec.scale > 4) {
    throw new MoneyError(
      `currency spec: scale must be an integer 0–4 from the jurisdiction pack; got ${String(spec.scale)}`,
    );
  }
}
