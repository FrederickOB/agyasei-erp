/**
 * The API's view of the wire contract.
 *
 * The primitives themselves NO LONGER LIVE HERE. They moved to
 * `@erp/contracts`, which depends on zod alone and is imported by both this
 * package and `apps/web`, so a client that builds the wrong payload shape
 * fails at `tsc` instead of at the zod gate with a BAD_REQUEST from a till.
 * That was the bug: two packages, two invented shapes, no shared definition.
 *
 * This module re-exports them so every router keeps importing `../wire.js`,
 * and adds the pieces that are legitimately server-only.
 *
 * The discipline the contract carries, restated because it is the reason the
 * package exists: money and quantities cross the API as DECIMAL STRINGS of
 * scaled integer units and become `bigint` at the boundary (ADR-0004); every
 * input object is `.strict()`, so a forged `tenant_id` fails loudly and a
 * client cannot assert a price the server is the authority for (CLAUDE.md
 * §2.1, §2.3, §2.5).
 */
import { HLC_RE } from '@erp/db';
import { HLC_WIRE_RE } from '@erp/contracts';

export {
  HLC_WIRE_RE,
  mutationEnvelope,
  mutationEnvelopeSchema,
  wire,
  zBusinessDate,
  zClaimedHlc,
  zScaledInt,
  zScaledIntNonNeg,
  zScaledIntPos,
  zUuid,
  type MutationEnvelope,
} from '@erp/contracts';

/**
 * Drift guard, checked at module load.
 *
 * `@erp/db` generates the server's authoritative HLC; `@erp/contracts` states
 * the format that crosses JSON. They are one format with two implementations,
 * and `@erp/contracts` cannot import `@erp/db` (it is bundled for the
 * browser). If they ever diverge, every device write is rejected as a
 * malformed HLC — a silent, total outage of the write path. Better that the
 * server refuses to boot.
 */
if (HLC_RE.source !== HLC_WIRE_RE.source) {
  throw new Error(
    `HLC format drift: @erp/db ${HLC_RE.source} !== @erp/contracts ${HLC_WIRE_RE.source}. ` +
      'These are one wire format; reconcile packages/db/src/hlc.ts with packages/contracts/src/wire.ts.',
  );
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
