/**
 * Wire primitives. Money and quantities cross the API as DECIMAL STRINGS of
 * scaled integer units (@erp/money serialize.ts is the contract): zod
 * validates the shape and transforms to bigint, so no monetary magnitude is
 * ever a JS `number` on either side of the boundary (ADR-0004).
 *
 * Every input object schema in this package is `.strict()`: unknown keys are
 * REJECTED, not stripped. `tenant_id` in a payload is an attack, not an
 * input (CLAUDE.md §2.1) — a forged payload fails loudly at the zod gate,
 * and even if a variant slipped through, nothing ever reads it: the tenant
 * id used for every statement comes from the verified token.
 */
import { z } from 'zod';
import { HLC_RE } from '@erp/db';

const INT_RE = /^-?\d+$/;
const NONNEG_INT_RE = /^\d+$/;

/** Signed scaled-integer magnitude (money minor units, qty, rate_e4). */
export const zScaledInt = z
  .string()
  .regex(INT_RE, 'expected a decimal string of scaled integer units')
  .transform((s) => BigInt(s));

/** Non-negative scaled-integer magnitude. */
export const zScaledIntNonNeg = z
  .string()
  .regex(NONNEG_INT_RE, 'expected a non-negative decimal string of scaled integer units')
  .transform((s) => BigInt(s));

/** Strictly positive scaled-integer magnitude. */
export const zScaledIntPos = zScaledIntNonNeg.refine((v) => v > 0n, 'must be > 0');

export const zUuid = z.string().uuid();

/** Business date — 'YYYY-MM-DD'. Human-asserted trading day (03 §3.4.2). */
export const zBusinessDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'not a calendar date');

/** A device-asserted HLC — stored as claimed_hlc, UNTRUSTED (03 §3.4.1). */
export const zClaimedHlc = z.string().regex(HLC_RE, 'malformed hlc');

/**
 * The idempotent-mutation envelope every write carries (CLAUDE.md §2.2):
 * a client-generated UUIDv7 idempotency key, the device's own clock
 * assertion (untrusted), and its wall-clock claim (display/forensics only).
 */
export const mutationEnvelope = {
  idempotencyKey: zUuid,
  claimedHlc: zClaimedHlc.optional(),
  clientWallAt: z.string().datetime({ offset: true }).optional(),
};

/** Serialize a bigint magnitude for a response DTO. */
export function wire(v: bigint): string {
  return v.toString(10);
}

/** Add calendar days to a YYYY-MM-DD date, returning YYYY-MM-DD. */
export function addCalendarDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole calendar days from a to b (b - a). */
export function calendarDaysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
