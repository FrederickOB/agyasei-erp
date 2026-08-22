/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STOCK ADJUSTMENT — the second thing this device may write, and the first
 * one that is not a sale
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ---------------------------------------------------------------------------
 * THIS IS A WRITE, SO IT GOES THROUGH THE OUTBOX. IT IS NOT AN `apiMutate`.
 * ---------------------------------------------------------------------------
 * `data/api/client.ts` draws the line and it is worth restating from this
 * side: a reorder THRESHOLD is configuration on a row that is in no sync
 * bucket, so it is refused offline out loud and nothing is queued. A stock
 * MOVEMENT is trade. Twenty bags broke in the yard whether or not the tower
 * is up, and a screen that refused to record that until the radio came back
 * would teach a yard hand to keep the count in his head — which is precisely
 * the ledger this product exists to replace.
 *
 * So this is `checkout()`'s shape, deliberately, down to the details:
 *
 *   · ONE local write transaction; nothing in it awaits a socket.
 *   · A client-generated UUIDv7 that IS the idempotency key IS the row id —
 *     minted when the FORM OPENS, not when Save is tapped, so a double-tap, a
 *     retry after a timeout and a resumed form are all the same write (§8.2).
 *   · The payload is typed as `RecordMovementInput` from `@erp/contracts` —
 *     the same declaration `apps/api` parses — and is then round-tripped
 *     through JSON and re-parsed, because the BYTES are what the server
 *     receives.
 *   · Completion is the server's ack and nothing else (`data/sync/upload.ts`).
 *     Rejections become the visible attention state; they are never dropped.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR REFUSALS THAT HAPPEN HERE, AND WHY EVERY ONE OF THEM IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 * `classifyRejection` (data/sync/upload.ts) treats an unrecognised rejection
 * as RETRYABLE, on purpose: wrongly dead-lettering a write is the loss path,
 * wrongly retrying one is merely loud. The consequence for THIS op is sharp.
 * Four perfectly permanent server refusals arrive with prefixes that are not
 * on the definitive list —
 *
 *   `PRECONDITION_FAILED: product is not stock-tracked`
 *   `PRECONDITION_FAILED: unknown movement reason …`
 *   `NOT_FOUND: location not found`
 *   `INTERNAL_SERVER_ERROR: … violates check constraint "sm_sign"`
 *
 * — so each of them would sit at the head of an ORDERED queue being retried
 * for ever, and every sale queued behind it would stop draining. The till
 * would look merely "stuck". None of those four can be produced by this
 * builder: the product comes from the device's own STOCKED catalogue, the
 * reason from the tenant's own synced rows, the location from provisioning,
 * and the sign is checked against the same rule the database CHECK states.
 * A refusal here happens with the person still standing at the shelf.
 *
 * Quantities are SIGNED scaled integers in the product's STOCKING unit
 * (04 §4.4.3, ADR-0004) — a decimal string on the wire, `bigint` in here,
 * never a JS number, and never converted from a selling unit.
 */
import {
  recordMovementInput,
  type DirectMovementKind,
  type RecordMovementInput,
} from '@erp/contracts';
import { businessDateFor } from '../../lib/business-date';
import type { ClaimedHlcClock } from '../../lib/hlc';
import type { DbExecutor, LocalDb } from '../db';
import { readDeviceLocation } from '../queries/session';
import { nextQueueSeq } from '../sync/queue-seq';

/** The outbox `kind` for this op. `data/sync/transport.ts` maps it to the wire. */
export const ADJUSTMENT_OUTBOX_KIND = 'stock_movement';

// ---------------------------------------------------------------------------
// Which movements this screen may record
// ---------------------------------------------------------------------------

/**
 * The movements that `stock.adjust` guards — a correction to what is
 * physically there, and nothing else.
 *
 * The server derives the required capability from `sourceKind` through a map
 * that is TypeScript-total over the contract's union
 * (apps/api/src/routers/inventory.ts). This is the subset of that map whose
 * value is `stock.adjust`, restated on the client so the screen offers exactly
 * what one capability covers. `RECEIPT`, `TRANSFER_OUT`, `TRANSFER_IN` and
 * `COUNT_ADJUST` are deliberately absent: each needs a DIFFERENT capability,
 * and offering them behind this one would put a person in front of a form
 * whose write is refused after they filled it in.
 *
 * Typed as `DirectMovementKind`, so a kind this client offers that the shared
 * contract does not carry is a compile error.
 */
export const ADJUSTMENT_KINDS = [
  'CORRECTION',
  'WRITE_OFF',
  'RETURN_TO_SUPPLIER',
  'OPENING',
] as const satisfies readonly DirectMovementKind[];

export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

export function isAdjustmentKind(value: string): value is AdjustmentKind {
  return (ADJUSTMENT_KINDS as readonly string[]).includes(value);
}

/**
 * THE SIGN RULE, mirrored from the database's own `sm_sign` CHECK
 * (`packages/db/migrations/0004_app_trade.sql`):
 *
 *   outflow  (WRITE_OFF, RETURN_TO_SUPPLIER, SALE, TRANSFER_OUT) → qty < 0
 *   inflow   (OPENING, RECEIPT, SALE_RETURN, TRANSFER_IN)        → qty > 0
 *   either   (CORRECTION, COUNT_ADJUST)                          → non-zero
 *
 * Duplicated on purpose, and the duplication is the point: a violation
 * surfaces from Postgres as an `INTERNAL_SERVER_ERROR`, which is RETRYABLE,
 * so it would wedge the queue rather than dead-letter. `Record<AdjustmentKind,
 * …>` is total, so adding a kind above without deciding its direction does not
 * compile.
 */
export type MovementDirection = 'in' | 'out' | 'either';

export const MOVEMENT_DIRECTION: Record<AdjustmentKind, MovementDirection> = {
  CORRECTION: 'either',
  WRITE_OFF: 'out',
  RETURN_TO_SUPPLIER: 'out',
  OPENING: 'in',
};

/** Does this signed quantity satisfy the ledger's sign rule for this kind? */
export function signPermitted(kind: AdjustmentKind, qtyDelta: bigint): boolean {
  if (qtyDelta === 0n) return false;
  switch (MOVEMENT_DIRECTION[kind]) {
    case 'in':
      return qtyDelta > 0n;
    case 'out':
      return qtyDelta < 0n;
    case 'either':
      return true;
  }
}

// ---------------------------------------------------------------------------
// The named refusals
// ---------------------------------------------------------------------------

/** The device cannot name where it stands, so it cannot move that place's stock. */
export class AdjustmentContextIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdjustmentContextIncompleteError';
  }
}

/**
 * No reason code. `CLAUDE.md` §3 lists "adjustments with reason codes" as one
 * thing, not two: an unexplained change to a count is indistinguishable from
 * shrinkage being covered up, and it is the first question an auditor asks.
 */
export class ReasonCodeRequiredError extends Error {
  constructor() {
    super('An adjustment needs a reason. Pick one before saving.');
    this.name = 'ReasonCodeRequiredError';
  }
}

/** Zero moves nothing, and the contract refuses it too. */
export class ZeroQuantityError extends Error {
  constructor() {
    super('An adjustment has to change the count by something.');
    this.name = 'ZeroQuantityError';
  }
}

/** A direction the stock ledger's own CHECK would refuse. See MOVEMENT_DIRECTION. */
export class MovementDirectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MovementDirectionError';
  }
}

/** Already queued under this key. Never a second row; never a silent success. */
export class DuplicateAdjustmentError extends Error {
  constructor(readonly movementId: string) {
    super(`adjustment ${movementId} is already recorded on this device`);
    this.name = 'DuplicateAdjustmentError';
  }
}

/**
 * The payload does not satisfy the shared contract. Thrown BEFORE the outbox
 * insert, so a malformed movement is caught at the shelf rather than rejected
 * hours later at sync — the same discipline `buildSalePayload` applies.
 */
export class MovementPayloadInvalidError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`movement payload does not match the wire contract: ${issues.join('; ')}`);
    this.name = 'MovementPayloadInvalidError';
  }
}

// ---------------------------------------------------------------------------
// Building the payload
// ---------------------------------------------------------------------------

export interface MovementPayloadInput {
  /** The idempotency key, minted when the form opened (§8.2). */
  readonly movementId: string;
  readonly locationId: string;
  readonly productId: string;
  /** SIGNED scaled integer in the product's STOCKING unit. */
  readonly qtyDelta: bigint;
  readonly kind: AdjustmentKind;
  /** A code read from the tenant's own `movement_reason` rows. */
  readonly reasonCode: string;
  readonly businessDate: string;
  readonly claimedHlc?: string | undefined;
  readonly createdAt: string;
}

export interface BuiltMovementPayload {
  /** The exact bytes the outbox stores and the transport ships. */
  readonly payloadJson: string;
  readonly payload: RecordMovementInput;
}

export function buildMovementPayload(input: MovementPayloadInput): BuiltMovementPayload {
  if (input.reasonCode.trim().length === 0) throw new ReasonCodeRequiredError();
  if (input.qtyDelta === 0n) throw new ZeroQuantityError();
  if (!signPermitted(input.kind, input.qtyDelta)) {
    throw new MovementDirectionError(
      MOVEMENT_DIRECTION[input.kind] === 'out'
        ? 'This kind of adjustment only ever takes stock out. Record it as a correction if the count went up.'
        : 'This kind of adjustment only ever puts stock in. Record it as a correction if the count went down.',
    );
  }

  // TYPED AS THE CONTRACT. Add a key the API does not accept, or drop one it
  // requires, and this stops compiling. Do not widen it.
  const payload: RecordMovementInput = {
    idempotencyKey: input.movementId,
    ...(input.claimedHlc !== undefined ? { claimedHlc: input.claimedHlc } : {}),
    clientWallAt: input.createdAt,
    locationId: input.locationId,
    productId: input.productId,
    // A decimal STRING of scaled units — a JSON number is a float64 in every
    // consumer (ADR-0004).
    qtyDelta: input.qtyDelta.toString(),
    sourceKind: input.kind,
    reasonCode: input.reasonCode,
    businessDate: input.businessDate,
    occurredAt: input.createdAt,
  };

  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload);
  } catch (err) {
    throw new MovementPayloadInvalidError([
      `payload is not serialisable: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  const parsed = recordMovementInput.safeParse(JSON.parse(payloadJson));
  if (!parsed.success) {
    throw new MovementPayloadInvalidError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return { payloadJson, payload };
}

// ---------------------------------------------------------------------------
// Recording it
// ---------------------------------------------------------------------------

export interface RecordAdjustmentInput {
  /** Minted when the form opened; stable across every retry of THIS edit. */
  readonly movementId: string;
  readonly productId: string;
  /** SIGNED scaled integer in the product's stocking unit. */
  readonly qtyDelta: bigint;
  readonly kind: AdjustmentKind;
  readonly reasonCode: string;
  readonly hlc: ClaimedHlcClock;
  readonly nowIso?: string;
  /** An asserted trading day; derived from the location's timezone otherwise. */
  readonly businessDate?: string;
}

export interface RecordAdjustmentResult {
  readonly movementId: string;
  readonly locationId: string;
  readonly qtyDelta: bigint;
  readonly businessDate: string;
}

/**
 * Queue one adjustment. Local, atomic, and complete in single-digit
 * milliseconds whether or not there is a network.
 *
 * The row is `pending` from the moment it commits and becomes `Saved` only
 * when the server acks it by key. Nothing here marks it done, and nothing here
 * asks the server anything.
 */
export async function recordAdjustment(
  db: LocalDb,
  input: RecordAdjustmentInput,
): Promise<RecordAdjustmentResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const claimedHlc = input.hlc.next();

  const result = await db.writeTransaction(async (tx: DbExecutor) => {
    const location = await readDeviceLocation(tx);
    if (location === null) {
      throw new AdjustmentContextIncompleteError(
        'This device has no location assigned, so it cannot say whose stock this is.',
      );
    }

    // Defence in depth against a double-tap; the authoritative guard is the
    // per-tenant primary key of app.write_log at ingest.
    const duplicate = await tx.getAll('SELECT 1 AS hit FROM outbox WHERE idempotency_key = ?', [
      input.movementId,
    ]);
    if (duplicate.length > 0) throw new DuplicateAdjustmentError(input.movementId);

    const businessDate =
      input.businessDate ?? businessDateFor(nowIso, location.timeZone);

    const built = buildMovementPayload({
      movementId: input.movementId,
      locationId: location.id,
      productId: input.productId,
      qtyDelta: input.qtyDelta,
      kind: input.kind,
      reasonCode: input.reasonCode,
      businessDate,
      claimedHlc,
      createdAt: nowIso,
    });

    // The queue position, taken inside this transaction (data/sync/queue-seq.ts).
    const queueSeq = await nextQueueSeq(tx);

    await tx.execute(
      `INSERT INTO outbox
         (id, idempotency_key, claimed_hlc, kind, payload, created_at, queue_seq,
          server_ack_at, rejected_at, reject_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [
        input.movementId,
        input.movementId,
        claimedHlc,
        ADJUSTMENT_OUTBOX_KIND,
        built.payloadJson,
        nowIso,
        queueSeq,
      ],
    );

    return {
      movementId: input.movementId,
      locationId: location.id,
      qtyDelta: input.qtyDelta,
      businessDate,
    };
  });

  db.changes.notify();
  return result;
}
