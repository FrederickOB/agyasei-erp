/**
 * The outbox drain — the client shore of the ONE write path (03-offline-sync
 * §3.3; sync_rules.yaml header). The PowerSync service is DOWNLOAD-ONLY:
 * every device write goes to the API's idempotent pipeline over
 * `app.write_log` via `POST /sync/upload`, never to the sync service.
 *
 * The rules, each load-bearing:
 *
 * - **Strictly in order.** The outbox is an ordered queue; ops are sent in
 *   ENQUEUE order — `outbox.queue_seq`, a strictly increasing integer stamped
 *   inside the same local transaction as the insert — exactly the order the
 *   server applies them in. It used to be `(created_at, id)`, which is total
 *   but is not the enqueue order: `created_at` is millisecond-resolution and a
 *   `uuidv7` carries no intra-millisecond counter, so a tie was broken at
 *   random. `data/sync/queue-seq.ts` has the full argument, including why a
 *   monotonic uuidv7 would not have been enough.
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
 * - **And a retried op keeps the sentence.** "Loud" used to mean the stuck
 *   state could say a queue had stopped draining and nothing anywhere could
 *   say WHY: `ack.reason` was read, classified, and dropped. A write refused
 *   every 30 seconds for sixteen hours told its counter only "tell your
 *   manager", and told the manager nothing. `last_refusal_reason` keeps it.
 *   This changes no settlement: the op stays pending and is retried exactly as
 *   before, because widening what leaves the queue is the loss path (below).
 *
 * No `@powersync/web` import: plain logic over the LocalDb seam, unit-tested
 * with a mocked transport (no live service).
 */
import { MAX_UPLOAD_BATCH, type UploadAck, type UploadAckStatus } from '@erp/contracts';
import type { DbExecutor, LocalDb } from '../db';
import { refreshClaimedHlc } from '../../lib/hlc';
import { OUTBOX_QUEUE_ORDER } from './queue-seq';

/**
 * The ack shape and the batch cap are the SERVER'S declarations, imported —
 * not restated. Both used to be hand-copied here (`MAX_UPLOAD_BATCH = 500`
 * written out twice, once on each side of the wire), which is the same
 * failure that made every sale payload a BAD_REQUEST, one layer out.
 */
export { MAX_UPLOAD_BATCH, type UploadAck, type UploadAckStatus };
/** Retained spelling for existing callers; the contract's name is UploadAckStatus. */
export type AckStatus = UploadAckStatus;

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
 *
 * THIS SET IS DELIBERATELY NOT WIDENED FOR RECEIPT-NUMBER COLLISIONS, and the
 * reason is worth stating because it looks like an easy fix. A duplicate
 * `sale_receipt_uq` used to surface here as `INTERNAL_SERVER_ERROR: duplicate
 * key value violates unique constraint`, which lands in the retryable bucket —
 * so the op retried forever and the outlet's outbox never drained. Adding that
 * prefix, or mapping the violation to BAD_REQUEST server-side, would dead-letter
 * a real sale with the cash already in the till: exactly the loss §3.3.4 exists
 * to prevent. The fix belongs upstream and is there now — the server allocates
 * blocks, detects the `consumed_upto` regression on reconnect and burns the
 * block (03 §3.7.5), and a collision that still arrives LANDS under the
 * emergency form with a severity-1 review (api/src/routers/sales.ts). Nothing
 * on this path needed to become more willing to discard a write.
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

/**
 * The exact marker `pipeline.ts` puts in its message (03 §3.4.1: beyond ±24h
 * of skew the server refuses `CLOCK_RESYNC_REQUIRED` and expects the client
 * to resynchronise and retry). Matched by SUBSTRING, not prefix:
 * `classifyRejection`'s prefix on this reason is `CONFLICT`, shared with
 * every other retryable conflict, so the prefix alone cannot tell this one
 * apart from an ordinary "try again" — only this string can.
 */
const CLOCK_RESYNC_MARKER = 'CLOCK_RESYNC_REQUIRED';

/**
 * True for the one retryable reason that means "this op's clock assertion,
 * not the op itself, is why the server refused it" — the case
 * `refreshClaimedHlc` exists to answer. Never true for a definitive
 * rejection or an ordinary retryable one: nothing here should touch a
 * device's clock claim over a conflict that has nothing to do with clocks.
 */
export function needsClockResync(reason: string | undefined): boolean {
  return reason !== undefined && reason.includes(CLOCK_RESYNC_MARKER);
}

export interface DrainProgress {
  readonly sentCount: number;
  readonly batchSize: number;
}

export interface DrainOptions {
  readonly batchLimit?: number;
  readonly nowIso?: () => string;
  /** Feed for the status bar's "Sending · x of y" (§8.4); ends with null. */
  readonly onProgress?: (progress: DrainProgress | null) => void;
  /**
   * Called for each acked op whose ack carried a `result` (see UploadAck).
   * Runs AFTER the settle transaction commits, so a throw here cannot undo an
   * ack — an op the server applied stays applied. The sequence runtime uses
   * this to adopt the block the server issued (data/sequence.ts adoptBlock).
   */
  readonly onResult?: (op: PendingOp, result: unknown) => void | Promise<void>;
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
  /**
   * What the server said about each op it REFUSED but that stays queued. The
   * pure module records the sentence; the callsite decides how to say it out
   * loud (powersync.ts logs it), so nothing here has to import `console`.
   *
   * Empty when the batch never reached the server — an undelivered batch is
   * not a refusal and has no sentence to report.
   */
  readonly deferredReasons: readonly DeferredReason[];
  /** False when the batch could not be delivered or answered at all. */
  readonly transportOk: boolean;
}

/** One op the server refused, with the refusal left intact. */
export interface DeferredReason {
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly reason: string;
}

/**
 * What is recorded when the server answers the batch but says nothing at all
 * about one key. It is not a rejection — there is no reason to quote — but it
 * is the one settlement outcome that would otherwise stay mute, and a key the
 * server keeps ignoring is exactly as stuck as one it keeps refusing.
 */
export const NO_ACK_REASON = 'NO_ACK: the server did not answer for this write';

/**
 * Pending ops, strictly in queue order, capped at the server's batch limit.
 *
 * The order is TOTAL and DETERMINISTIC: `queue_seq` is unique, so no two rows
 * can tie. Rows written before that column existed carry NULL and sort first —
 * they were queued before every row that has one — with the old key breaking
 * ties among themselves, so an in-flight queue is not reshuffled by an upgrade.
 */
export async function readPendingOps(
  db: LocalDb,
  limit: number = MAX_UPLOAD_BATCH,
): Promise<PendingOp[]> {
  const rows = await db.getAll(
    `SELECT id, idempotency_key, claimed_hlc, kind, payload, created_at
       FROM outbox
      WHERE server_ack_at IS NULL AND rejected_at IS NULL
      ORDER BY ${OUTBOX_QUEUE_ORDER}
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
  const results: { op: PendingOp; result: unknown }[] = [];

  const ops = await readPendingOps(db, options.batchLimit ?? MAX_UPLOAD_BATCH);
  if (ops.length === 0) {
    return {
      batchSize: 0,
      completed: 0,
      rejected: 0,
      deferred: 0,
      deferredReasons: [],
      transportOk: true,
    };
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
    //
    // AND NOTHING IS WRITTEN TO `last_refusal_reason` HERE, deliberately. An
    // undelivered batch is not a refusal; stamping "the network was down" over
    // a sentence the server gave earlier would erase the diagnosis of a wedged
    // write on the device's next outage — which, offline-first, is guaranteed.
    onProgress(null);
    return {
      batchSize: ops.length,
      completed: 0,
      rejected: 0,
      deferred: ops.length,
      deferredReasons: [],
      transportOk: false,
    };
  }

  const ackByKey = new Map<string, UploadAck>();
  for (const ack of result.acks) ackByKey.set(ack.key, ack);

  let completed = 0;
  let rejected = 0;
  let deferred = 0;
  const deferredReasons: DeferredReason[] = [];
  const stamp = nowIso();

  /**
   * Keep the refusal on the row without settling it. `server_ack_at` and
   * `rejected_at` are untouched, so the op is still pending, still returned by
   * `readPendingOps`, still retried on the next pass — the queue behaves
   * exactly as it did before these columns existed.
   */
  const recordRefusal = async (tx: DbExecutor, op: PendingOp, reason: string): Promise<void> => {
    deferred += 1;
    deferredReasons.push({ kind: op.kind, idempotencyKey: op.idempotencyKey, reason });
    await tx.execute(
      `UPDATE outbox SET last_refusal_reason = ?, last_refusal_at = ?
        WHERE id = ? AND server_ack_at IS NULL AND rejected_at IS NULL`,
      [reason, stamp, op.id],
    );
  };

  await db.writeTransaction(async (tx) => {
    for (const op of ops) {
      const ack = ackByKey.get(op.idempotencyKey);
      if (ack === undefined) {
        // The server did not answer for this key. Without an ack it is NOT
        // complete — it stays pending and is re-sent (idempotent by key).
        await recordRefusal(tx, op, NO_ACK_REASON);
        continue;
      }
      if (ack.status === 'applied' || ack.status === 'duplicate') {
        await tx.execute(
          `UPDATE outbox SET server_ack_at = ?
            WHERE id = ? AND server_ack_at IS NULL AND rejected_at IS NULL`,
          [stamp, op.id],
        );
        if (ack.result !== undefined) results.push({ op, result: ack.result });
        completed += 1;
      } else if (classifyRejection(ack.reason) === 'definitive') {
        await tx.execute(
          `UPDATE outbox SET rejected_at = ?, reject_reason = ?
            WHERE id = ? AND server_ack_at IS NULL AND rejected_at IS NULL`,
          [stamp, ack.reason ?? 'rejected', op.id],
        );
        rejected += 1;
      } else {
        await recordRefusal(tx, op, ack.reason ?? 'refused, with no reason given');
        // `op.claimedHlc` is null only for a write that never carried a claim
        // to begin with — nothing to refresh, and nothing this server-side
        // reason could ever apply to (the skew clamp reads meta.claimedHlc
        // and does not fire when it is undefined; see pipeline.ts).
        if (needsClockResync(ack.reason) && op.claimedHlc !== null) {
          // The op itself was fine; the assertion attached to it had simply
          // aged past the server's ±24h tolerance while queued (03 §3.4.1) —
          // exactly what a device offline for "hours or days" (CLAUDE.md
          // §2.2) will do to anything left waiting long enough. Refreshing it
          // here, in the SAME transaction as the refusal record, is the
          // client half of the resync the architecture document already
          // specifies: the next drain pass reads this new value and resends
          // the identical mutation under it.
          await tx.execute(
            `UPDATE outbox SET claimed_hlc = ?
              WHERE id = ? AND server_ack_at IS NULL AND rejected_at IS NULL`,
            [refreshClaimedHlc(op.claimedHlc), op.id],
          );
        }
      }
      onProgress({ sentCount: completed + rejected, batchSize: ops.length });
    }
  });

  // Results are applied AFTER the settle transaction: the acks are already
  // durable, so a failure here costs the device an adoption it will redo on the
  // next reconnect — never an ack it needs to keep.
  if (options.onResult !== undefined) {
    for (const { op, result } of results) await options.onResult(op, result);
  }

  // A refusal changes what the recent-sales list must show, so it rings the
  // change bus too — otherwise the sentence lands in the database and the row
  // on screen goes on saying nothing until something unrelated re-renders it.
  if (completed > 0 || rejected > 0 || deferredReasons.length > 0) db.changes.notify();
  onProgress(null);

  return { batchSize: ops.length, completed, rejected, deferred, deferredReasons, transportOk: true };
}
