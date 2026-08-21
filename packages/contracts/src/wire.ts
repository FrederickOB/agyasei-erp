/**
 * Wire primitives — the shared vocabulary of every client↔server payload.
 *
 * These lived in `apps/api/src/wire.ts` and existed nowhere on the client, so
 * the PWA invented its own shape and every sale it uploaded was rejected at
 * the zod gate. They live here now, in a package with exactly one dependency
 * (zod), so BOTH sides import the same definitions and a disagreement is a
 * compile error rather than a BAD_REQUEST from a till in Techiman.
 *
 * Money and quantities cross the API as DECIMAL STRINGS of scaled integer
 * units (`@erp/money` serialize.ts is the contract): zod validates the shape
 * and transforms to `bigint`, so no monetary magnitude is ever a JS `number`
 * on either side of the boundary (CLAUDE.md §2.3, ADR-0004). A JSON number is
 * a float64 in every consumer; it never carries money or quantity.
 *
 * Every input object schema built from these is `.strict()`: unknown keys are
 * REJECTED, not stripped. `tenant_id` in a payload is an attack, not an input
 * (CLAUDE.md §2.1) — a forged payload fails loudly here, and even if a variant
 * spelling slipped through, nothing ever reads it: the tenant id used for
 * every statement comes from the verified token, server-side.
 *
 * NOTHING IN THIS PACKAGE MAY IMPORT A NODE-ONLY MODULE. It is bundled into
 * the browser build of the PWA. No `pg`, no `fastify`, no `node:*`, no
 * `@erp/db` (which carries drizzle and the migration runner).
 */
import { z } from 'zod';

const INT_RE = /^-?\d+$/;
const NONNEG_INT_RE = /^\d+$/;

/**
 * The HLC wire projection: 13-digit wall milliseconds, 5-digit counter,
 * 32-hex node id — so lexicographic byte order is causal order for
 * well-behaved clocks (04-data-model §4.2.1).
 *
 * This is the FORMAT. The generator that produces values in this format lives
 * in `packages/db/src/hlc.ts` (server clock) and `apps/web/src/lib/hlc.ts`
 * (device claimed clock); both must project into exactly this pattern.
 * `apps/api/src/wire.ts` asserts at module load that the db generator's
 * pattern is byte-identical to this one, so a divergence stops the server
 * booting instead of silently rejecting every device write.
 */
export const HLC_WIRE_RE = /^[0-9]{13}-[0-9]{5}-[0-9a-f]{32}$/;

/** Signed scaled-integer magnitude (money minor units, qty delta, rate_e4). */
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

/**
 * Business date — 'YYYY-MM-DD'. Human-asserted trading day (03 §3.4.2), and
 * the date every price list and tax rate is looked up as-of (CLAUDE.md §2.5).
 *
 * The round-trip check is not decoration. `Date.parse('2026-02-30T00:00:00Z')`
 * succeeds in V8 and rolls over to 2 March, so the previous `!isNaN` guard
 * let 30 February through with a message that claimed otherwise. It then
 * reached Postgres as `$1::date`, which raises — surfacing as
 * INTERNAL_SERVER_ERROR, which the client's §3.3.4 taxonomy classes as
 * RETRYABLE, so a definitively malformed op would be retried forever instead
 * of dead-lettering into the visible attention state. Refusing it here makes
 * it the BAD_REQUEST it always was.
 */
export const zBusinessDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
  }, 'not a calendar date');

/** A device-asserted HLC — stored as claimed_hlc, UNTRUSTED (03 §3.4.1). */
export const zClaimedHlc = z.string().regex(HLC_WIRE_RE, 'malformed hlc');

/**
 * The idempotent-mutation envelope every write carries (CLAUDE.md §2.2):
 * a client-generated UUIDv7 idempotency key, the device's own clock
 * assertion (untrusted), and its wall-clock claim (display/forensics only).
 *
 * Spread into each mutation's `z.object({ ... })` so omitting it is
 * structurally awkward rather than merely discouraged.
 */
export const mutationEnvelope = {
  idempotencyKey: zUuid,
  claimedHlc: zClaimedHlc.optional(),
  clientWallAt: z.string().datetime({ offset: true }).optional(),
};

/** The envelope as its own schema, for clients assembling one directly. */
export const mutationEnvelopeSchema = z.object(mutationEnvelope).strict();
export type MutationEnvelope = z.infer<typeof mutationEnvelopeSchema>;

/**
 * Serialize a bigint magnitude for the wire. The inverse of `zScaledInt*`.
 * Shared so the client and the server stringify money the same way — base 10,
 * no separators, no exponent, no locale.
 */
export function wire(v: bigint): string {
  return v.toString(10);
}
