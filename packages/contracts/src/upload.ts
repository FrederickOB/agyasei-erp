/**
 * The outer wire of the device write path: `POST /sync/upload`.
 *
 * The PowerSync service is DOWNLOAD-ONLY — every device write lands here and
 * is dispatched to the tRPC mutation for its kind, so it flows through the
 * one idempotent pipeline over `app.write_log` (03 §3.3).
 *
 * This envelope was defined twice: `apps/api/src/sync.ts` had the zod schema,
 * `apps/web/src/data/sync/transport.ts` + `upload.ts` hand-rolled the same
 * JSON and independently hard-coded the 500-op batch cap. Same failure mode as
 * the sale payload, one layer out. It lives here now.
 *
 * Note the envelope carries NO tenant identity in any spelling. `tenant_id`
 * comes from the verified token, server-side, on every write (CLAUDE.md §2.1);
 * any tenant key smuggled into an op payload is stripped and ignored at the
 * boundary.
 */
import { z } from 'zod';
import { zClaimedHlc, zUuid } from './wire.js';

/**
 * The uploadable operation vocabulary — `write_log.op` discriminators. The
 * server maps each to an existing tRPC mutation; the client tags each outbox
 * row with one. A kind outside this set is answered `UNKNOWN_KIND`, which
 * dead-letters the op into the visible attention state rather than silently
 * wedging the queue (03 §3.3.4).
 */
export const DEVICE_OP_KINDS = [
  'sale.create',
  'stock.record_movement',
  'credit.open_account',
  'credit.record_entry',
  // The reconnect conversation for human-facing document numbers (03 §3.7.5).
  // It is an upload op, not a side channel, precisely so it rides the ORDERED
  // outbox: a cursor report queued before a batch of sales must reach the
  // server before those sales do.
  'sequence.sync_block',
  // ── Phase 2 (see PROCUREMENT_UPLOADABLE_OPS in ./procurement.ts) ────────
  // Goods arrive in a yard that is offline for days. The stock is physically
  // there; refusing to record it teaches staff to write it on paper, and
  // paper never reaches the ledger. Dispatched by apps/api/src/sync.ts to
  // receiving.recordReceipt.
  'goods.record_receipt',
  // A delivery status is updated by whoever hears from the driver, wherever
  // they are. Dispatched to logistics.updateStatus.
  'logistics.update_delivery_status',
] as const;
export type DeviceOpKind = (typeof DEVICE_OP_KINDS)[number];

/** The server's batch cap. The client must not exceed it. */
export const MAX_UPLOAD_BATCH = 500;

export const uploadOpSchema = z
  .object({
    /** Client-generated UUIDv7 — THE idempotency key (write_log.id). */
    idempotency_key: zUuid,
    /** Device HLC assertion. Stored as claimed_hlc, UNTRUSTED (03 §3.4.1). */
    claimed_hlc: zClaimedHlc.optional(),
    /** Device wall clock. Display/forensics only. */
    client_wall_at: z.string().datetime({ offset: true }).optional(),
    /**
     * write_log.op discriminator. Deliberately a free string rather than an
     * enum: an unrecognised kind must produce a per-op `UNKNOWN_KIND` ack,
     * not a whole-batch envelope rejection that applies nothing.
     */
    kind: z.string().min(1),
    /** The mutation input minus the envelope; validated by the mutation's own strict schema. */
    payload: z.record(z.unknown()),
  })
  .strict();

export const uploadBodySchema = z
  .object({ ops: z.array(uploadOpSchema).min(1).max(MAX_UPLOAD_BATCH) })
  .strict();

export type UploadOp = z.infer<typeof uploadOpSchema>;
export type UploadBody = z.infer<typeof uploadBodySchema>;

export type UploadAckStatus = 'applied' | 'duplicate' | 'rejected';

export interface UploadAck {
  key: string;
  status: UploadAckStatus;
  /**
   * The mutation's stored response, for the few ops where the DEVICE cannot
   * know the answer on its own. A sale needs nothing back — the device already
   * holds every value it sent. A sequence-block report does: the server decides
   * which numbers this device may use next, and after a regression that is a
   * DIFFERENT block from the one the device asked about (03 §3.7.5).
   *
   * Deliberately not returned for every op: echoing a full sale DTO for each of
   * up to 500 ops would bloat the batch response for nothing. Replays carry it
   * too — the pipeline replays `write_log.response_body` verbatim, so a device
   * that lost the answer to a network failure still learns its block on retry.
   */
  result?: unknown;
  /**
   * Only on `rejected`. Prefixed with the TRPC error code so the client
   * connector can apply the 03 §3.3.4 retry taxonomy (a `CONFLICT:
   * RETRY_LATER…` or `INTERNAL_SERVER_ERROR…` is retryable; `BAD_REQUEST` /
   * `UNKNOWN_KIND` are definitive → dead-letter).
   */
  reason?: string;
}

export interface UploadResponseBody {
  acks: UploadAck[];
}
