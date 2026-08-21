/**
 * The sequence-block wire contract — `sequence.sync_block`.
 *
 * The reconnect conversation for human-facing document numbers (03-offline-sync
 * §3.7.5): the device says how far it got, the server says which numbers it may
 * use next. It is an UPLOADABLE op — it rides the same ordered outbox as sales
 * so a report queued before a batch of sales reaches the server before them —
 * which is exactly why its shape belongs here rather than privately inside
 * `apps/api/src/routers/sequence.ts`.
 *
 * It arrived with the schema declared inline in the router, the way the sale
 * schema used to be. That is the bug class `@erp/contracts` exists to close:
 * the client that builds this payload (`apps/web/src/data/sequence.ts`
 * `buildBlockReport`) and the server that parses it must be reading ONE
 * declaration, or the disagreement surfaces as a BAD_REQUEST from a till
 * nobody can reach.
 *
 * COUNTERS ARE DECIMAL STRINGS, transformed to `bigint` here — the same
 * discipline money gets, for the same reason. A document number is not money,
 * but it is a magnitude that must survive a JSON round-trip exactly, and
 * float64 stops being exact at 2^53 (ADR-0004's reasoning, applied to
 * counters). A receipt number that drifts is a receipt two customers hold.
 *
 * NOTHING HERE IS A JURISDICTION OR A TENANT BRANCH. `sequenceKey` is pack +
 * tenant vocabulary ('RECEIPT', 'INVOICE', …) validated only for SHAPE, never
 * against a platform enum; the number format, prefix and block size are values
 * on `app.sequence_counter` (ADR-0007, CLAUDE.md §2.5/§2.9).
 */
import { z } from 'zod';
import { mutationEnvelope, zUuid } from './wire.js';

/**
 * A non-negative decimal string of a sequence number. Never a JSON number.
 */
export const zSeqNumber = z
  .string()
  .regex(/^\d+$/, 'expected a decimal string')
  .transform((s) => BigInt(s));

/**
 * What the device believes about the block it holds.
 *
 * `consumedUpto: null` inside a report means "I hold this block and have
 * issued nothing from it". The device holding NO block at all is `report:
 * null` on the parent — a different statement, and the one a wipe produces.
 * The two must stay distinguishable on the wire: collapsing them would erase
 * the signal the whole mechanism is built to detect.
 */
export const blockReport = z
  .object({
    blockStart: zSeqNumber,
    /** Highest number the device has ISSUED from this block; null = none. */
    consumedUpto: zSeqNumber.nullable(),
  })
  .strict();

export const syncBlockInput = z
  .object({
    ...mutationEnvelope,
    locationId: zUuid,
    /** Pack + tenant vocabulary ('RECEIPT', …) — never a platform enum. */
    sequenceKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/),
    /**
     * The device's view of its current block, or null for "I hold no block".
     * A wiped device reports null while the server still shows a live block —
     * that mismatch IS the detection.
     */
    report: blockReport.nullable().default(null),
    /** Ask for a block now (fresh device, or the current one is spent). */
    wantBlock: z.boolean().default(true),
  })
  .strict();

export type BlockReport = z.input<typeof blockReport>;
export type SyncBlockInput = z.input<typeof syncBlockInput>;
export type SyncBlockParsed = z.output<typeof syncBlockInput>;
