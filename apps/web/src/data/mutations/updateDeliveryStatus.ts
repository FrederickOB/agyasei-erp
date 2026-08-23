/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DELIVERY STATUS — the fourth thing this device may write
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A delivery status is updated by whoever hears from the driver, wherever they
 * are — at a gate, at a roadside, in a district town with one bar of signal.
 * `logistics.update_delivery_status` is registered in `DEVICE_OP_KINDS` against
 * `updateDeliveryStatusInput` and dispatched by `apps/api/src/sync.ts` to
 * `logistics.updateStatus`, so it rides the same ordered outbox, the same
 * client idempotency key and the same idempotent pipeline as a sale.
 *
 * PLANNING a delivery is NOT here and must not come here: it commits the
 * business to a carrier, the server refuses one that holds no HAULAGE
 * capability or has been deactivated, and a partitioned device cannot know
 * either. That one goes over HTTP and is refused out loud (`data/api/logistics.ts`).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ADR-0001: THERE IS NO VEHICLE IN THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════
 * The only party this write names is the delivery it belongs to. There is no
 * driver, no registration, no odometer and no fuel figure — a carrier is a
 * SUPPLIER that hauls, and the delivery already names it.
 *
 * ---------------------------------------------------------------------------
 * THE TWO REFUSALS THAT WOULD SIT IN THE QUEUE, AND WHY NEITHER CAN HAPPEN
 * ---------------------------------------------------------------------------
 * `classifyRejection` classes a CONFLICT as retryable, and the server raises
 * one for a status that is already set and for an illegal transition. Both are
 * permanent for a given payload, so either would be retried forever and show
 * only as the §8.4 "stuck" state. `buildDeliveryStatusPayload` therefore
 * refuses a no-op transition here, and every screen offers only the legal next
 * steps the SERVER named on the delivery it read — never a list rebuilt in
 * TypeScript, which is a second copy of the database's transition table and a
 * second copy that drifts.
 *
 * A FAILED delivery needs a reason. That is not politeness: "it did not
 * arrive" with no explanation is a record nobody can act on when the customer
 * telephones, and the shared contract refuses it too.
 */
import {
  updateDeliveryStatusInput,
  type DeliveryStatus,
  type UpdateDeliveryStatusInput,
} from '@erp/contracts';
import type { ClaimedHlcClock } from '../../lib/hlc';
import type { DbExecutor, LocalDb } from '../db';
import { nextQueueSeq } from '../sync/queue-seq';

/** The outbox `kind` for this op. `data/sync/transport.ts` maps it to the wire. */
export const DELIVERY_STATUS_OUTBOX_KIND = 'delivery_status';

// ---------------------------------------------------------------------------
// The named refusals
// ---------------------------------------------------------------------------

/** A move to the status it is already in. A CONFLICT, and therefore retried forever. */
export class DeliveryStatusUnchangedError extends Error {
  constructor(status: string) {
    super(`This delivery is already ${status.toLowerCase()}. Nothing was recorded.`);
    this.name = 'DeliveryStatusUnchangedError';
  }
}

/** No explanation for a failure. Refused here, and by the shared contract. */
export class DeliveryReasonRequiredError extends Error {
  constructor() {
    super('Say what happened. A delivery that did not arrive needs a reason.');
    this.name = 'DeliveryReasonRequiredError';
  }
}

/** Already queued under this key. Never a second row; never a silent success. */
export class DuplicateDeliveryUpdateError extends Error {
  constructor(readonly updateId: string) {
    super('this update is already recorded on this device');
    this.name = 'DuplicateDeliveryUpdateError';
  }
}

export class DeliveryPayloadInvalidError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`delivery update does not match the wire contract: ${issues.join('; ')}`);
    this.name = 'DeliveryPayloadInvalidError';
  }
}

// ---------------------------------------------------------------------------
// Building the payload
// ---------------------------------------------------------------------------

export interface DeliveryStatusPayloadInput {
  /** The idempotency key, minted when the control was opened (§8.2). */
  readonly updateId: string;
  readonly deliveryId: string;
  /** What it is now, so a no-op is refused here rather than at the server. */
  readonly fromStatus: string;
  readonly toStatus: DeliveryStatus;
  readonly carrierReference?: string | undefined;
  readonly reason?: string | undefined;
  readonly notes?: string | undefined;
  readonly claimedHlc?: string | undefined;
  readonly createdAt: string;
}

export interface BuiltDeliveryStatusPayload {
  readonly payloadJson: string;
  readonly payload: UpdateDeliveryStatusInput;
}

export function buildDeliveryStatusPayload(
  input: DeliveryStatusPayloadInput,
): BuiltDeliveryStatusPayload {
  if (input.fromStatus === input.toStatus) {
    throw new DeliveryStatusUnchangedError(input.toStatus);
  }
  if (input.toStatus === 'FAILED' && (input.reason ?? '').trim().length === 0) {
    throw new DeliveryReasonRequiredError();
  }

  // TYPED AS THE CONTRACT. Add a key the API does not accept, or drop one it
  // requires, and this stops compiling. Do not widen it.
  const payload: UpdateDeliveryStatusInput = {
    idempotencyKey: input.updateId,
    ...(input.claimedHlc === undefined ? {} : { claimedHlc: input.claimedHlc }),
    clientWallAt: input.createdAt,
    deliveryId: input.deliveryId,
    toStatus: input.toStatus,
    // When it happened as observed by whoever recorded it. DISPLAY
    // information, never an ordering key — causal order is the server's HLC.
    occurredAt: input.createdAt,
    ...(input.carrierReference === undefined || input.carrierReference.length === 0
      ? {}
      : { carrierReference: input.carrierReference }),
    ...(input.reason === undefined || input.reason.length === 0 ? {} : { reason: input.reason }),
    ...(input.notes === undefined || input.notes.length === 0 ? {} : { notes: input.notes }),
  };

  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload);
  } catch (err) {
    throw new DeliveryPayloadInvalidError([
      `payload is not serialisable: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  const parsed = updateDeliveryStatusInput.safeParse(JSON.parse(payloadJson));
  if (!parsed.success) {
    throw new DeliveryPayloadInvalidError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return { payloadJson, payload };
}

// ---------------------------------------------------------------------------
// Recording it
// ---------------------------------------------------------------------------

export interface RecordDeliveryStatusInput {
  /** Minted when the control opened; stable across every retry of THIS move. */
  readonly updateId: string;
  readonly deliveryId: string;
  readonly fromStatus: string;
  readonly toStatus: DeliveryStatus;
  readonly carrierReference?: string | undefined;
  readonly reason?: string | undefined;
  readonly notes?: string | undefined;
  readonly hlc: ClaimedHlcClock;
  readonly nowIso?: string;
}

export interface RecordDeliveryStatusResult {
  readonly updateId: string;
  readonly deliveryId: string;
  readonly toStatus: DeliveryStatus;
}

/**
 * Queue one status move. Local, atomic, and complete whether or not there is a
 * network. It becomes `Saved` only when the server acks it by key.
 */
export async function recordDeliveryStatus(
  db: LocalDb,
  input: RecordDeliveryStatusInput,
): Promise<RecordDeliveryStatusResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const claimedHlc = input.hlc.next();

  const result = await db.writeTransaction(async (tx: DbExecutor) => {
    const duplicate = await tx.getAll('SELECT 1 AS hit FROM outbox WHERE idempotency_key = ?', [
      input.updateId,
    ]);
    if (duplicate.length > 0) throw new DuplicateDeliveryUpdateError(input.updateId);

    const built = buildDeliveryStatusPayload({
      updateId: input.updateId,
      deliveryId: input.deliveryId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      carrierReference: input.carrierReference,
      reason: input.reason,
      notes: input.notes,
      claimedHlc,
      createdAt: nowIso,
    });

    // The queue position, taken inside this transaction. THIS is the op that
    // found the bug: two status moves queued in the same millisecond uploaded
    // in a random order and the second was refused as an illegal transition
    // (data/sync/queue-seq.ts).
    const queueSeq = await nextQueueSeq(tx);

    await tx.execute(
      `INSERT INTO outbox
         (id, idempotency_key, claimed_hlc, kind, payload, created_at, queue_seq,
          server_ack_at, rejected_at, reject_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [
        input.updateId,
        input.updateId,
        claimedHlc,
        DELIVERY_STATUS_OUTBOX_KIND,
        built.payloadJson,
        nowIso,
        queueSeq,
      ],
    );

    return { updateId: input.updateId, deliveryId: input.deliveryId, toStatus: input.toStatus };
  });

  db.changes.notify();
  return result;
}
