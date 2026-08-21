/**
 * Human-facing document numbers, allocated offline (03-offline-sync §3.7.5)
 * and the detection of conflict class #14.
 *
 * ONE endpoint, `sequence.syncBlock`, because reporting and allocating are the
 * same conversation: the device says how far it got, and the server says which
 * numbers it may use next. §3.7.5 — "on every reconnect the device reports
 * `consumed_upto`; the server rejects any regression, burns the remainder of
 * that block, issues a fresh one, and sends the overlap range to review at
 * severity 1."
 *
 * WHY A REGRESSION IS THE SHARP EDGE. `consumed_upto` lives on the device. If
 * OPFS is evicted, or the PWA is reinstalled on the same enrolled device, the
 * local cursor resets while the server still shows the block live — and the
 * device starts reissuing numbers it has already printed, on a document type
 * that may be a statutory VAT invoice. The number is already in a customer's
 * hand; there is no undo. So the only honest response is to make the divergence
 * impossible to miss and impossible to continue.
 *
 * THE TWO CHEAP ANSWERS, AND WHY NEITHER IS TAKEN:
 *   - Refusing the colliding sale (mapping the unique violation to a definitive
 *     rejection) DEAD-LETTERS A REAL SALE. §3.3.4 exists to prevent exactly
 *     that: wrongly dead-lettering is the loss path, wrongly retrying is merely
 *     loud. The cash is in the till either way.
 *   - Renumbering silently hands the next customer a number another customer
 *     already holds, and nobody ever learns. See sales.ts for the landing path:
 *     the sale is recorded under §3.7.5's emergency form, the PRINTED number is
 *     preserved in `receipt_no_claimed`, and a human is told.
 *
 * Nothing here reads a jurisdiction or a tenant. The format, the prefix and the
 * block size are values on `app.sequence_counter` (ADR-0007, CLAUDE.md §2.9);
 * a location with no counter row is refused rather than defaulted.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { deterministicUuid } from '@erp/db';
import { blockEnd, nextNumber, remaining } from '@erp/sequence';
import type { Queryable } from '../db.js';
import { runIdempotent, type JsonValue } from '../pipeline.js';
import { assertLocationInScope, router, tenantProcedure } from '../trpc.js';
import { mutationEnvelope, zUuid } from '../wire.js';

/** Conflict class #14 (03 §3.6, §3.7.5). */
export const RECEIPT_REGRESSION_CLASS = 'SEQUENCE_CONSUMED_UPTO_REGRESSION';
/** Severity 1: blocking. Never auto-resolves (§3.6.2 `escalate_only`). */
export const SEVERITY_BLOCKING = 1;
/** Routing is by PERMISSION, never by named individual (§3.6.2). */
export const SEQUENCE_REVIEW_PERMISSION = 'sequence.review';
/** §3.6.2 escalate_only step 1 — the tenant-configured chain lands with the
 *  conflict_classes registry; until then the first step is 24h. */
const FIRST_ESCALATION_HOURS = 24;

/** A non-negative decimal string of a sequence number. Never a JSON number:
 *  float64 stops being exact at 2^53 and a document number must not drift. */
const zSeqNumber = z
  .string()
  .regex(/^\d+$/, 'expected a decimal string')
  .transform((s) => BigInt(s));

const blockReport = z
  .object({
    blockStart: zSeqNumber,
    /** Highest number the device has ISSUED from this block; null = none. */
    consumedUpto: zSeqNumber.nullable(),
  })
  .strict();

const syncBlockInput = z
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

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export type RegressionKind =
  /** The canonical case: same block, cursor moved BACKWARDS. */
  | 'CONSUMED_UPTO_REGRESSION'
  /** The device forgot a live block entirely — a wipe or a reinstall. */
  | 'LOST_CURSOR'
  /** The device is on a block this server never issued to it. */
  | 'UNKNOWN_BLOCK';

export interface LiveBlock {
  id: string;
  blockStart: bigint;
  blockSize: number;
  consumedUpto: bigint | null;
}

export interface Regression {
  kind: RegressionKind;
  /** Inclusive range that may now be held by two customers. */
  overlapFrom: bigint;
  overlapTo: bigint;
  /** What the device claimed, for the review's provenance. */
  reportedConsumedUpto: bigint | null;
  reportedBlockStart: bigint | null;
}

/**
 * Compare what the device says against what the server recorded.
 *
 * The overlap range is the honest statement of exposure, not a guess: it is the
 * span the device believes is free but the server has already seen issued. A
 * device that lost its cursor entirely has the whole issued span at risk,
 * because it will restart from `block_start`.
 */
export function detectRegression(
  live: LiveBlock | null,
  report: { blockStart: bigint; consumedUpto: bigint | null } | null,
  knownClosedBlockStarts: readonly bigint[],
): Regression | null {
  // A device that keeps reporting a block we already closed is telling us
  // about a conflict we have already opened. §3.6.2 deduplicates reviews per
  // (entity, field_path) for exactly this reason: a long partition produces a
  // BURST of stale reports, and the first design put a severity-1 notification
  // on each one. Stale is not new.
  const alreadyClosed = (start: bigint): boolean =>
    knownClosedBlockStarts.some((s) => s === start);

  if (live === null) {
    if (report === null) return null; // fresh device, nothing to reconcile
    if (alreadyClosed(report.blockStart)) return null;
    return {
      kind: 'UNKNOWN_BLOCK',
      overlapFrom: report.blockStart,
      overlapTo: report.consumedUpto ?? report.blockStart,
      reportedConsumedUpto: report.consumedUpto,
      reportedBlockStart: report.blockStart,
    };
  }

  if (report === null) {
    // The server holds a live block for this device and the device has no idea
    // it exists. Everything from block_start to the last number the server
    // knows was issued is at risk, because the device restarts at block_start.
    return {
      kind: 'LOST_CURSOR',
      overlapFrom: live.blockStart,
      overlapTo: live.consumedUpto ?? live.blockStart,
      reportedConsumedUpto: null,
      reportedBlockStart: null,
    };
  }

  if (report.blockStart !== live.blockStart) {
    // Already burned, and the device has since been given the live block it is
    // now holding: this is the stale tail of a handled conflict, not a new one.
    if (alreadyClosed(report.blockStart)) return null;
    return {
      kind: 'UNKNOWN_BLOCK',
      overlapFrom: report.blockStart,
      overlapTo: report.consumedUpto ?? report.blockStart,
      reportedConsumedUpto: report.consumedUpto,
      reportedBlockStart: report.blockStart,
    };
  }

  // A cursor outside the block's own range means the device issued numbers it
  // was never given. Left alone this would hit the sequence_block_consumed_in_
  // range CHECK as a raw constraint error — INTERNAL_SERVER_ERROR, retryable,
  // outbox stalled: the exact failure this whole mechanism exists to remove.
  // It is a conflict, so it goes down the conflict path.
  const lastInBlock = blockEnd(live);
  if (
    report.consumedUpto !== null &&
    (report.consumedUpto < live.blockStart || report.consumedUpto > lastInBlock)
  ) {
    return {
      kind: 'UNKNOWN_BLOCK',
      overlapFrom: report.consumedUpto < live.blockStart ? report.consumedUpto : lastInBlock + 1n,
      overlapTo: report.consumedUpto < live.blockStart ? live.blockStart : report.consumedUpto,
      reportedConsumedUpto: report.consumedUpto,
      reportedBlockStart: report.blockStart,
    };
  }

  const recorded = live.consumedUpto;
  if (recorded === null) return null; // server has no high-water mark to beat
  if (report.consumedUpto !== null && report.consumedUpto >= recorded) return null;

  // Same block, cursor rewound. The numbers between where the device now
  // thinks it is and where the server last saw it are the ones at risk.
  const from = report.consumedUpto === null ? live.blockStart : report.consumedUpto + 1n;
  return {
    kind: 'CONSUMED_UPTO_REGRESSION',
    overlapFrom: from,
    overlapTo: recorded,
    reportedConsumedUpto: report.consumedUpto,
    reportedBlockStart: report.blockStart,
  };
}

// ---------------------------------------------------------------------------
// Review opening — shared with the sales collision path
// ---------------------------------------------------------------------------

export interface OpenReviewInput {
  tenantId: string;
  writeId: string;
  hlc: string;
  reviewId: string;
  conflictClass: string;
  severity: number;
  entityTable: string;
  entityId: string;
  fieldPath?: string | null;
  proposals: JsonValue;
  pendingState: 'ancestor' | 'safe_default' | 'first_applied';
  pendingValue: JsonValue;
  requiredPermission: string;
  locationIds: readonly string[];
}

/**
 * Open one review and scope it to the locations whose reviewers may see it.
 *
 * Scope is NORMALISED into conflict_review_location rather than left as an
 * unused array (§3.6.2's own correction): a severity-1 item must not broadcast
 * to every eligible holder at all 25 outlets.
 */
export async function openConflictReview(tx: Queryable, input: OpenReviewInput): Promise<void> {
  await tx.query(
    `insert into app.conflict_review
       (tenant_id, id, write_id, hlc, conflict_class, severity, entity_table, entity_id,
        field_path, proposals, pending_state, pending_value, required_permission,
        status, escalate_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13,
             'open', transaction_timestamp() + ($14 || ' hours')::interval)
     on conflict (tenant_id, id) do nothing`,
    [
      input.tenantId,
      input.reviewId,
      input.writeId,
      input.hlc,
      input.conflictClass,
      input.severity,
      input.entityTable,
      input.entityId,
      input.fieldPath ?? null,
      JSON.stringify(input.proposals),
      input.pendingState,
      JSON.stringify(input.pendingValue),
      input.requiredPermission,
      String(FIRST_ESCALATION_HOURS),
    ],
  );
  for (const locationId of input.locationIds) {
    await tx.query(
      `insert into app.conflict_review_location
         (tenant_id, id, write_id, hlc, review_id, location_id)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (tenant_id, id) do nothing`,
      [
        input.tenantId,
        deterministicUuid(input.reviewId, 'review_location', locationId),
        input.writeId,
        input.hlc,
        input.reviewId,
        locationId,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

interface CounterRow {
  id: string;
  next_start: string;
  block_size: number;
  number_format: string;
  number_prefix: string;
  location_code: string;
}

interface BlockRow {
  id: string;
  block_start: string;
  block_size: number;
  consumed_upto: string | null;
}

export const sequenceRouter = router({
  /**
   * Report this device's cursor and (optionally) take a block.
   *
   * Called on every reconnect. Goes through the ONE idempotent pipeline like
   * every other write, so a retried report is a no-op that replays its stored
   * answer rather than burning a second block.
   */
  syncBlock: tenantProcedure.input(syncBlockInput).mutation(async ({ ctx, input }) => {
    assertLocationInScope(ctx.identity, input.locationId);
    const tenantId = ctx.identity.tenantId;
    const deviceId = ctx.identity.deviceId;

    const result = await runIdempotent(
      { runner: ctx.deps.runner, clock: ctx.deps.clock },
      ctx.identity,
      {
        op: 'sequence.sync_block',
        idempotencyKey: input.idempotencyKey,
        claimedHlc: input.claimedHlc,
        clientWallAt: input.clientWallAt,
        locationId: input.locationId,
      },
      input,
      async (tx) => {
        // The row lock §3.7.5 requires: allocation is serialised per
        // (tenant, location, sequence_key), so two devices reconnecting at once
        // cannot be handed the same range.
        const counterRes = await tx.query<CounterRow>(
          `select c.id, c.next_start::text, c.block_size, c.number_format, c.number_prefix,
                  l.code as location_code
             from app.sequence_counter c
             join app.location l on l.tenant_id = c.tenant_id and l.id = c.location_id
            where c.sequence_key = $1 and c.location_id = $2 and c.deleted_at is null
            for update of c`,
          [input.sequenceKey, input.locationId],
        );
        const counter = counterRes.rows[0];
        if (!counter) {
          // Fail closed. The numbering format is tenant data; the platform
          // never invents one, in any jurisdiction (ADR-0007, §2.9).
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              `no ${input.sequenceKey} sequence counter configured for this location — ` +
              `numbering format is tenant configuration and has no platform default (03 §3.7.5)`,
          });
        }

        const liveRes = await tx.query<BlockRow>(
          `select id, block_start::text, block_size, consumed_upto::text
             from app.sequence_block
            where sequence_key = $1 and location_id = $2 and device_id = $3
              and exhausted_at is null
            for update`,
          [input.sequenceKey, input.locationId, deviceId],
        );
        const liveRow = liveRes.rows[0];
        const live: LiveBlock | null = liveRow
          ? {
              id: liveRow.id,
              blockStart: BigInt(liveRow.block_start),
              blockSize: liveRow.block_size,
              consumedUpto: liveRow.consumed_upto === null ? null : BigInt(liveRow.consumed_upto),
            }
          : null;

        // Blocks we already closed for this device: a device that keeps
        // reporting a burned block must not reopen the same review each time.
        const closedRes = await tx.query<{ block_start: string }>(
          `select block_start::text from app.sequence_block
            where sequence_key = $1 and location_id = $2 and device_id = $3
              and exhausted_at is not null`,
          [input.sequenceKey, input.locationId, deviceId],
        );
        const closedStarts = closedRes.rows.map((r) => BigInt(r.block_start));

        const regression = detectRegression(live, input.report, closedStarts);

        // ---- decide what happens to the incumbent block -------------------
        let closeLive: { reason: string; burnedFrom: bigint; burnedTo: bigint } | null = null;
        let recordConsumed: bigint | null = null;

        if (live !== null) {
          if (regression !== null) {
            // Burn the remainder. A block is never reused, never returned and
            // never reissued to a device that has been reset (§3.7.5).
            closeLive = {
              reason: 'REGRESSION_BURN',
              burnedFrom: live.consumedUpto === null ? live.blockStart : live.consumedUpto + 1n,
              burnedTo: blockEnd(live),
            };
          } else if (input.report !== null && input.report.blockStart === live.blockStart) {
            // Normal reporting: the high-water mark only ever rises.
            const reported = input.report.consumedUpto;
            if (reported !== null && (live.consumedUpto === null || reported > live.consumedUpto)) {
              recordConsumed = reported;
            }
            const effective = recordConsumed ?? live.consumedUpto;
            if (nextNumber(live, effective) === null) {
              closeLive = {
                reason: 'EXHAUSTED',
                burnedFrom: blockEnd(live) + 1n,
                burnedTo: blockEnd(live),
              };
            }
          }
        }

        const liveSurvives = live !== null && closeLive === null;

        // A replacement is issued only when the incumbent is gone. One live
        // block per device is enforced by sequence_block_live_uq, so this is a
        // structural invariant, not a convention.
        const issueNew = (input.wantBlock || regression !== null) && !liveSurvives;
        const newStart = BigInt(counter.next_start);
        const newSize = counter.block_size;
        const newBlockId = issueNew ? deterministicUuid(input.idempotencyKey, 'sequence_block') : null;
        const reviewId = regression !== null ? deterministicUuid(input.idempotencyKey, 'conflict_review') : null;

        const effectiveBlock = issueNew
          ? { blockStart: newStart, blockSize: newSize, consumedUpto: null as bigint | null }
          : liveSurvives && live !== null
            ? {
                blockStart: live.blockStart,
                blockSize: live.blockSize,
                consumedUpto: recordConsumed ?? live.consumedUpto,
              }
            : null;

        const response = {
          status: regression === null ? 'ok' : 'regression',
          sequenceKey: input.sequenceKey,
          block:
            effectiveBlock === null
              ? null
              : {
                  blockStart: effectiveBlock.blockStart.toString(10),
                  blockSize: effectiveBlock.blockSize,
                  blockEnd: blockEnd(effectiveBlock).toString(10),
                  nextNumber:
                    nextNumber(effectiveBlock, effectiveBlock.consumedUpto)?.toString(10) ?? null,
                  remaining: remaining(effectiveBlock, effectiveBlock.consumedUpto).toString(10),
                },
          format:
            effectiveBlock === null
              ? null
              : {
                  format: counter.number_format,
                  prefix: counter.number_prefix,
                  locationCode: counter.location_code,
                },
          burned:
            closeLive === null || live === null
              ? null
              : {
                  blockStart: live.blockStart.toString(10),
                  blockEnd: blockEnd(live).toString(10),
                  consumedUpto: live.consumedUpto?.toString(10) ?? null,
                  burnedFrom: closeLive.burnedFrom.toString(10),
                  burnedTo: closeLive.burnedTo.toString(10),
                  reason: closeLive.reason,
                },
          review:
            regression === null || reviewId === null
              ? null
              : {
                  id: reviewId,
                  conflictClass: RECEIPT_REGRESSION_CLASS,
                  severity: SEVERITY_BLOCKING,
                  kind: regression.kind,
                  overlapFrom: regression.overlapFrom.toString(10),
                  overlapTo: regression.overlapTo.toString(10),
                },
        } satisfies JsonValue & Record<string, unknown>;

        return {
          response,
          apply: async (atx: Queryable): Promise<void> => {
            const hlc = ctx.deps.clock.next();

            if (recordConsumed !== null && live !== null) {
              await atx.query(
                `update app.sequence_block
                    set consumed_upto = $1, reported_at = transaction_timestamp(),
                        updated_at = transaction_timestamp()
                  where id = $2`,
                [recordConsumed.toString(10), live.id],
              );
            }
            if (closeLive !== null && live !== null) {
              await atx.query(
                `update app.sequence_block
                    set exhausted_at = transaction_timestamp(), closed_reason = $1,
                        updated_at = transaction_timestamp()
                  where id = $2`,
                [closeLive.reason, live.id],
              );
            }
            if (issueNew && newBlockId !== null) {
              await atx.query(
                `insert into app.sequence_block
                   (tenant_id, id, write_id, hlc, sequence_key, location_id, device_id,
                    block_start, block_size)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                  tenantId,
                  newBlockId,
                  input.idempotencyKey,
                  hlc,
                  input.sequenceKey,
                  input.locationId,
                  deviceId,
                  newStart.toString(10),
                  newSize,
                ],
              );
              await atx.query(
                `update app.sequence_counter
                    set next_start = $1, updated_at = transaction_timestamp()
                  where id = $2`,
                [(newStart + BigInt(newSize)).toString(10), counter.id],
              );
            }
            if (regression !== null && reviewId !== null) {
              await openConflictReview(atx, {
                tenantId,
                writeId: input.idempotencyKey,
                hlc,
                reviewId,
                conflictClass: RECEIPT_REGRESSION_CLASS,
                severity: SEVERITY_BLOCKING,
                entityTable: 'app.sequence_block',
                entityId: live?.id ?? newBlockId!,
                fieldPath: 'consumed_upto',
                proposals: [
                  {
                    party: 'server',
                    detail: 'last consumption this server recorded for the block',
                    sequenceKey: input.sequenceKey,
                    blockStart: live?.blockStart.toString(10) ?? null,
                    consumedUpto: live?.consumedUpto?.toString(10) ?? null,
                  },
                  {
                    party: 'device',
                    detail: 'what the device reported on reconnect',
                    deviceId,
                    userId: ctx.identity.userId,
                    locationId: input.locationId,
                    claimedHlc: input.claimedHlc ?? null,
                    blockStart: regression.reportedBlockStart?.toString(10) ?? null,
                    consumedUpto: regression.reportedConsumedUpto?.toString(10) ?? null,
                  },
                ],
                pendingState: 'safe_default',
                pendingValue: {
                  kind: regression.kind,
                  // The numbers a human must chase: these may be printed twice.
                  overlapFrom: regression.overlapFrom.toString(10),
                  overlapTo: regression.overlapTo.toString(10),
                  burnedBlockStart: live?.blockStart.toString(10) ?? null,
                  replacementBlockStart: issueNew ? newStart.toString(10) : null,
                  note:
                    'The block was burned and a fresh one issued. Every receipt in the ' +
                    'overlap range may exist twice — reconcile the printed copies before closing.',
                },
                requiredPermission: SEQUENCE_REVIEW_PERMISSION,
                locationIds: [input.locationId],
              });
            }
          },
        };
      },
    );

    return result.response;
  }),
});
