/**
 * The outbox drain — the client shore of the ONE write path (03-offline-sync
 * §3.3; sync_rules.yaml header). The PowerSync service is DOWNLOAD-ONLY:
 * every device write goes to the API's idempotent pipeline over
 * `app.write_log` via `POST /sync/upload`, never to the sync service.
 *
 * The rules, each load-bearing:
 *
 * - **Strictly in order.** The outbox is an ordered queue; ops are sent
 *   oldest-first (`created_at`, then id — both UUIDv7-time-ordered), exactly
 *   the order the server applies them in.
 * - **Complete ONLY on a server ack.** An op is marked done (`server_ack_at`)
 *   only when the server answered `applied` or `duplicate` for ITS key. No
 *   ack — a network failure, a non-200, a missing ack entry — leaves the op
 *   pending for retry. Completing without an ack would LOSE a sale.
 * - **A rejected op is visible work, never silence.** A definitive rejection
 *   sets `rejected_at`/`reject_reason`, which drives the per-record "Needs
 *   checking" badge (§8.5) — the sale stays on the device, in front of a
 *   human. A RETRYABLE rejection (server hiccup, conflict routing, stale
 *   permission) stays pending and is retried; per §3.3.4 the fail-safe
 *   default for an unknown reason is retryable, because wrongly dead-lettering
 *   is the loss path while wrongly retrying is merely loud (the §8.4 "stuck"
 *   state surfaces a queue that stops draining).
 *
 * No `@powersync/web` import: plain logic over the LocalDb seam, unit-tested
 * with a mocked transport (no live service).
 */
import type { LocalDb } from '../db';

export type AckStatus = 'applied' | 'duplicate' | 'rejected';

export interface UploadAck {
  readonly key: string;
  readonly status: AckStatus;
  /** Only on `rejected`; prefixed with the server error code (see api/src/sync.ts). */
  readonly reason?: string;
}

/** One pending outbox row, as read from the local queue. */
export interface PendingOp {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly claimedHlc: string | null;
  readonly kind: string;
  readonly payloadJson: string;
  readonly createdAt: string;
}

export interface UploadResult {
  /** True only for an HTTP 200 with a parseable ack list. */
  readonly ok: boolean;
  /** HTTP status; 0 for a network-level failure. */
  readonly status: number;
  readonly acks: readonly UploadAck[];
}

/** The wire seam — mocked in unit tests, HTTP in production (transport.ts). */
export interface UploadTransport {
  send(ops: readonly PendingOp[]): Promise<UploadResult>;
}

/**
 * Reason prefixes that are DEFINITIVE — the payload can never be applied, so
 * the op leaves the queue for the visible attention state. Everything else
 * (CONFLICT/RETRY_LATER, UNAUTHORIZED, FORBIDDEN, TIMEOUT, TOO_MANY_REQUESTS,
 * INTERNAL_SERVER_ERROR, …) is retryable — §3.3.4: definitive rejection is
 * the narrow case, and the unknown case defaults to retry, never to loss.
 */
const DEFINITIVE_PREFIXES: ReadonlySet<string> = new Set([
  'BAD_REQUEST',
  'UNPROCESSABLE_CONTENT',
  'UNKNOWN_KIND',
  'PARSE_ERROR',
]);

export type RejectionClass = 'definitive' | 'retryable';

export function classifyRejection(reason: string | undefined): RejectionClass {
  if (reason === undefined) return 'retryable';
  const prefix = reason.split(':', 1)[0]?.trim() ?? '';
  return DEFINITIVE_PREFIXES.has(prefix) ? 'definitive' : 'retryable';
}

/** The server's envelope cap (api/src/sync.ts uploadBodySchema). */
export const MAX_UPLOAD_BATCH = 500;

export interface DrainProgress {
  readonly sentCount: number;
  readonly batchSize: number;
}

export interface DrainOptions {
  readonly batchLimit?: number;
  readonly nowIso?: () => string;
  /** Feed for the status bar's "Sending · x of y" (§8.4); ends with null. */
  readonly onProgress?: (progress: DrainProgress | null) => void;
}

export interface DrainReport {
  /** Ops sent in this pass (0 = queue was empty; nothing was transmitted). */
  readonly batchSize: number;
  /** Acked `applied`/`duplicate` → marked `server_ack_at`. */
  readonly completed: number;
  /** Definitively rejected → marked `rejected_at` (visible attention state). */
  readonly rejected: number;
  /** Still pending: retryable rejections, missing acks, or a failed transport. */
  readonly deferred: number;
  /** False when the batch could not be delivered or answered at all. */
  readonly transportOk: boolean;
}

/** Pending ops, strictly in queue order, capped at the server's batch limit. */
export async function readPendingOps(
  db: LocalDb,
  limit: number = MAX_UPLOAD_BATCH,
): Promise<PendingOp[]> {
  const rows = await db.getAll(
    `SELECT id, idempotency_key, claimed_hlc, kind, payload, created_at
       FROM outbox
      WHERE server_ack_at IS NULL AND rejected_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
    [Math.min(limit, MAX_UPLOAD_BATCH)],
  );
  return rows.map((row) => ({
    id: String(row['id']),
    idempotencyKey: String(row['idempotency_key']),
    claimedHlc: row['claimed_hlc'] === null ? null : String(row['claimed_hlc']),
    kind: String(row['kind']),
    payloadJson: String(row['payload']),
    createdAt: String(row['created_at']),
  }));
}

/**
 * One drain pass: read the pending queue in order, send it as one batch, and
 * settle each op ONLY according to its own ack. Marking happens in one local
 * transaction — if it fails, every op simply stays pending and the retry gets
 * `duplicate` acks, which is the safe direction.
 */
export async function drainOutbox(
  db: LocalDb,
  transport: UploadTransport,
  options: DrainOptions = {},
): Promise<DrainReport> {
  const nowIso = options.nowIso ?? ((): string => new Date().toISOString());
  const onProgress = options.onProgress ?? ((): void => undefined);

  const ops = await readPendingOps(db, options.batchLimit ?? MAX_UPLOAD_BATCH);
  if (ops.length === 0) {
    return { batchSize: 0, completed: 0, rejected: 0, deferred: 0, transportOk: true };
  }

  onProgress({ sentCount: 0, batchSize: ops.length });

  let result: UploadResult;
  try {
    result = await transport.send(ops);
  } catch {
    result = { ok: false, status: 0, acks: [] };
  }

  if (!result.ok) {
    // No definitive answer for anything: nothing is completed, nothing is
    // rejected, everything stays pending. Loud (via the stuck state), not lost.
    onProgress(null);
    return {
      batchSize: ops.length,
      completed: 0,
      rejected: 0,
      deferred: ops.length,
      transportOk: false,
    };
  }

  const ackByKey = new Map<string, UploadAck>();
  for (const ack of result.acks) ackByKey.set(ack.key, ack);

  let completed = 0;
  let rejected = 0;
  let deferred = 0;
  const stamp = nowIso();

  await db.writeTransaction(async (tx) => {
    for (const op of ops) {
      const ack = ackByKey.get(op.idempotencyKey);
      if (ack === undefined) {
        // The server did not answer for this key. Without an ack it is NOT
        // complete — it stays pending and is re-sent (idempotent by key).
        deferred += 1;
        continue;
      }
      if (ack.status === 'applied' || ack.status === 'duplicate') {
        await tx.execute(
          `UPDATE outbox SET server_ack_at = ?
            WHERE id = ? AND server_ack_at IS NULL AND rejected_at IS NULL`,
          [stamp, op.id],
        );
        completed += 1;
      } else if (classifyRejection(ack.reason) === 'definitive') {
        await tx.execute(
          `UPDATE outbox SET rejected_at = ?, reject_reason = ?
            WHERE id = ? AND server_ack_at IS NULL AND rejected_at IS NULL`,
          [stamp, ack.reason ?? 'rejected', op.id],
        );
        rejected += 1;
      } else {
        deferred += 1;
      }
      onProgress({ sentCount: completed + rejected, batchSize: ops.length });
    }
  });

  if (completed > 0 || rejected > 0) db.changes.notify();
  onProgress(null);

  return { batchSize: ops.length, completed, rejected, deferred, transportOk: true };
}
