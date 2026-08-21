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
