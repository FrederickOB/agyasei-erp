/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GOODS RECEIPT — the third thing this device may write, and the one the
 * whole of Phase 2's offline story rests on
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The truck is in the yard. The bags are on the ground. Whether the tower is
 * up has nothing to do with either fact, and a screen that refused to record
 * them until the radio came back would teach a yard hand to write it on paper
 * — and paper never reaches the ledger. `goods.record_receipt` is registered
 * in `DEVICE_OP_KINDS` against `recordGoodsReceiptInput` and dispatched by
 * `apps/api/src/sync.ts` to `receiving.recordReceipt` for exactly that reason,
 * so a queued receipt rides the same ordered outbox, the same client
 * idempotency key and the same `runIdempotent` pipeline as a sale.
 *
 * This is `checkout()`'s and `recordAdjustment()`'s shape, down to the details:
 *
 *   · ONE local write transaction; nothing in it awaits a socket.
 *   · A client-generated UUIDv7 that IS the idempotency key IS the row id —
 *     minted when the FORM OPENS, not when Save is tapped, so a double-tap, a
 *     retry after a timeout and a resumed form are all the same write (§8.2).
 *   · The payload is typed as `RecordGoodsReceiptInput` from `@erp/contracts`
 *     — the same declaration `apps/api` parses — and is then round-tripped
 *     through JSON and re-parsed, because the BYTES are what the server gets.
 *   · Completion is the server's ack and nothing else (`data/sync/upload.ts`).
 *     Rejections become the visible attention state; they are never dropped.
 *
 * ---------------------------------------------------------------------------
 * TWO QUANTITIES, AND NEITHER IS DERIVED FROM THE OTHER
 * ---------------------------------------------------------------------------
 * `qtyReceived` is what the supplier invoiced, in THEIR unit. `qtyStock` is
 * what was counted off the truck, in the product's STOCKING unit, and is the
 * only figure the movement ledger will ever see. Ten tonnes ordered, nine and
 * a half invoiced and 190 bags counted are THREE FACTS. A client that computed
 * one of them from another would be hiding the loss, so both cross the wire.
 *
 * The server computes what the snapshotted conversion says `qtyStock` should
 * have been. Where the two differ the line needs `confirmConversion` — somebody
 * looked at the pile and signed for the difference — and the server records
 * who. `buildReceiptPayload` sets that flag from the SAME expression the
 * server uses (`toStockQty`, `data/queries/purchase-units.ts`), so a yard hand
 * who accepts the computed figure never sees a confirmation prompt and one who
 * overrides it always does.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REFUSED HERE, AND WHY EVERY REFUSAL IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 * `classifyRejection` (data/sync/upload.ts) treats an unrecognised rejection
 * as RETRYABLE on purpose: wrongly dead-lettering a write is the loss path,
 * wrongly retrying one is merely loud. The consequence is that a PERMANENT
 * server refusal arriving with a prefix off the definitive list sits in the
 * queue being retried and shows up only as the §8.4 "stuck" state. Four such
 * refusals are reachable for a receipt —
 *
 *   `PRECONDITION_FAILED: product … is not purchasable`
 *   `PRECONDITION_FAILED: unit … is not a buyable unit of product …`
 *   `PRECONDITION_FAILED: line n: … was counted but the conversion … gives …`
 *   `BAD_REQUEST: receipt line numbers must be distinct`
 *
 * — and none of them can be produced by this builder. The product comes from
 * the device's own PURCHASABLE catalogue, the unit from that product's own
 * `can_buy` rows, the confirmation flag from the server's own conversion
 * expression, and the line numbers are assigned here rather than typed. A
 * refusal happens with the person still standing at the gate.
 *
 * The ONE thing a partitioned device cannot know is whether the order is still
 * APPROVED. That is checked by the database when the write lands, days later,
 * and it is the reason a rejected receipt has to be visible work rather than a
 * toast (`features/receiving/Receiving.tsx`).
 */
import {
  recordGoodsReceiptInput,
  type GoodsReceiptLineInput,
  type RecordGoodsReceiptInput,
} from '@erp/contracts';
import { businessDateFor } from '../../lib/business-date';
import type { ClaimedHlcClock } from '../../lib/hlc';
import type { DbExecutor, LocalDb } from '../db';
import { readDeviceLocation } from '../queries/session';
import { nextQueueSeq } from '../sync/queue-seq';
import { toStockQty, type PurchaseUnit } from '../queries/purchase-units';

/** The outbox `kind` for this op. `data/sync/transport.ts` maps it to the wire. */
export const RECEIPT_OUTBOX_KIND = 'goods_receipt';

// ---------------------------------------------------------------------------
// How a line stands against what was ordered
// ---------------------------------------------------------------------------

/**
 * SHORT AND OVER ARE NORMAL TRADE, NOT ERRORS. This is computed so the screen
 * can SHOW the variance while it is being typed; the server computes its own
 * from the derived order view and is the authority. Nothing here refuses a
 * line for being short or over — refusing is how a yard learns to keep its
 * own book.
 */
export type ReceiptVariance = 'MATCHED' | 'SHORT' | 'OVER' | 'NO_ORDER';

export function varianceOf(qtyReceived: bigint, qtyExpected: bigint | null): ReceiptVariance {
  if (qtyExpected === null) return 'NO_ORDER';
  if (qtyReceived === qtyExpected) return 'MATCHED';
  return qtyReceived < qtyExpected ? 'SHORT' : 'OVER';
}

// ---------------------------------------------------------------------------
// The named refusals
// ---------------------------------------------------------------------------

/** The device cannot name where it stands, so it cannot say whose yard this is. */
export class ReceiptContextIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptContextIncompleteError';
  }
}

/** A receipt of nothing is not a receipt. The contract refuses it too. */
export class EmptyReceiptError extends Error {
  constructor() {
    super('Add at least one line before signing for this delivery.');
    this.name = 'EmptyReceiptError';
  }
}

/** Already queued under this key. Never a second row; never a silent success. */
export class DuplicateReceiptError extends Error {
  constructor(readonly goodsReceiptId: string) {
    super(`this delivery is already recorded on this device`);
    this.name = 'DuplicateReceiptError';
  }
}

/**
 * The payload does not satisfy the shared contract. Thrown BEFORE the outbox
 * insert, so a malformed receipt is caught at the gate rather than rejected
 * days later at sync.
 */
export class ReceiptPayloadInvalidError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`receipt payload does not match the wire contract: ${issues.join('; ')}`);
    this.name = 'ReceiptPayloadInvalidError';
  }
}

// ---------------------------------------------------------------------------
// Building the payload
// ---------------------------------------------------------------------------

/** One line as the yard typed it, before it becomes wire bytes. */
export interface ReceiptLineDraft {
  /** The order line this matches, when there is one. Omit for an extra. */
  readonly purchaseOrderLineId?: string | undefined;
  readonly productId: string;
  /** The supplier's unit, from the product's OWN `can_buy` rows. */
  readonly unit: PurchaseUnit;
  /** What was invoiced, in the supplier's unit. */
  readonly qtyReceived: bigint;
  /**
   * What was COUNTED, in the stocking unit. Omit to accept the conversion —
   * which is what a yard that did not recount does, and which then needs no
   * signature.
   */
  readonly qtyStock?: bigint | undefined;
  /** Cost as invoiced, per ONE purchase unit, ×10⁴ minor units. */
  readonly unitCostE4: bigint;
  readonly notes?: string | undefined;
}

export interface ReceiptPayloadInput {
  /** The idempotency key, minted when the form opened (§8.2). */
  readonly goodsReceiptId: string;
  readonly locationId: string;
  readonly supplierId: string;
  readonly purchaseOrderId?: string | undefined;
  readonly businessDate: string;
  readonly supplierDeliveryNoteRef?: string | undefined;
  readonly supplierInvoiceRef?: string | undefined;
  readonly notes?: string | undefined;
  readonly lines: readonly ReceiptLineDraft[];
  readonly claimedHlc?: string | undefined;
  readonly createdAt: string;
}

export interface BuiltReceiptPayload {
  /** The exact bytes the outbox stores and the transport ships. */
  readonly payloadJson: string;
  readonly payload: RecordGoodsReceiptInput;
  /** Lines whose counted figure differs from the conversion, so somebody signed. */
  readonly confirmedLineNos: readonly number[];
}

export function buildReceiptPayload(input: ReceiptPayloadInput): BuiltReceiptPayload {
  if (input.lines.length === 0) throw new EmptyReceiptError();

  const confirmedLineNos: number[] = [];
  // LINE NUMBERS ARE ASSIGNED, NEVER TYPED. Two lines carrying one number is a
  // BAD_REQUEST the server raises and a line the yard cannot point at; there is
  // no reason to let a person produce either.
  const lines: GoodsReceiptLineInput[] = input.lines.map((line, index) => {
    const lineNo = index + 1;
    const computed = toStockQty(line.qtyReceived, line.unit);
    const qtyStock = line.qtyStock ?? computed;
    // The server's own rule, mirrored: a counted figure that differs from the
    // conversion needs a signature, and one that agrees needs none. Sending
    // the flag unconditionally would make every line look signed for.
    const confirm = qtyStock !== computed;
    if (confirm) confirmedLineNos.push(lineNo);
    return {
      lineNo,
      ...(line.purchaseOrderLineId === undefined
        ? {}
        : { purchaseOrderLineId: line.purchaseOrderLineId }),
      productId: line.productId,
      uomId: line.unit.uomId,
      // Decimal STRINGS of scaled units — a JSON number is a float64 in every
      // consumer (ADR-0004).
      qtyReceived: line.qtyReceived.toString(),
      qtyStock: qtyStock.toString(),
      unitCostE4: line.unitCostE4.toString(),
      ...(confirm ? { confirmConversion: true } : {}),
      ...(line.notes === undefined || line.notes.length === 0 ? {} : { notes: line.notes }),
    };
  });

  // TYPED AS THE CONTRACT. Add a key the API does not accept, or drop one it
  // requires, and this stops compiling. Do not widen it.
  const payload: RecordGoodsReceiptInput = {
    idempotencyKey: input.goodsReceiptId,
    ...(input.claimedHlc === undefined ? {} : { claimedHlc: input.claimedHlc }),
    clientWallAt: input.createdAt,
    ...(input.purchaseOrderId === undefined ? {} : { purchaseOrderId: input.purchaseOrderId }),
    supplierId: input.supplierId,
    locationId: input.locationId,
    businessDate: input.businessDate,
    receivedAt: input.createdAt,
    ...(input.supplierDeliveryNoteRef === undefined || input.supplierDeliveryNoteRef.length === 0
      ? {}
      : { supplierDeliveryNoteRef: input.supplierDeliveryNoteRef }),
    ...(input.supplierInvoiceRef === undefined || input.supplierInvoiceRef.length === 0
      ? {}
      : { supplierInvoiceRef: input.supplierInvoiceRef }),
    ...(input.notes === undefined || input.notes.length === 0 ? {} : { notes: input.notes }),
    lines,
  };

  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload);
  } catch (err) {
    throw new ReceiptPayloadInvalidError([
      `payload is not serialisable: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  const parsed = recordGoodsReceiptInput.safeParse(JSON.parse(payloadJson));
  if (!parsed.success) {
    throw new ReceiptPayloadInvalidError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return { payloadJson, payload, confirmedLineNos };
}

// ---------------------------------------------------------------------------
// Recording it
// ---------------------------------------------------------------------------

export interface RecordReceiptInput {
  /** Minted when the form opened; stable across every retry of THIS receipt. */
  readonly goodsReceiptId: string;
  readonly supplierId: string;
  readonly purchaseOrderId?: string | undefined;
  readonly supplierDeliveryNoteRef?: string | undefined;
  readonly supplierInvoiceRef?: string | undefined;
  readonly notes?: string | undefined;
  readonly lines: readonly ReceiptLineDraft[];
  readonly hlc: ClaimedHlcClock;
  readonly nowIso?: string;
  /** An asserted trading day; derived from the location's timezone otherwise. */
  readonly businessDate?: string;
}

export interface RecordReceiptResult {
  readonly goodsReceiptId: string;
  readonly locationId: string;
  readonly lineCount: number;
  readonly confirmedLineNos: readonly number[];
  readonly businessDate: string;
}

/**
 * Queue one goods receipt. Local, atomic, and complete in single-digit
 * milliseconds whether or not there is a network.
 *
 * The row is `pending` from the moment it commits and becomes `Saved` only
 * when the server acks it by key. Nothing here marks it done, and nothing here
 * asks the server anything.
 */
export async function recordGoodsReceipt(
  db: LocalDb,
  input: RecordReceiptInput,
): Promise<RecordReceiptResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const claimedHlc = input.hlc.next();

  const result = await db.writeTransaction(async (tx: DbExecutor) => {
    const location = await readDeviceLocation(tx);
    if (location === null) {
      throw new ReceiptContextIncompleteError(
        'This device has no location assigned, so it cannot say whose yard these goods landed in.',
      );
    }

    // Defence in depth against a double-tap; the authoritative guard is the
    // per-tenant primary key of app.write_log at ingest.
    const duplicate = await tx.getAll('SELECT 1 AS hit FROM outbox WHERE idempotency_key = ?', [
      input.goodsReceiptId,
    ]);
    if (duplicate.length > 0) throw new DuplicateReceiptError(input.goodsReceiptId);

    const businessDate = input.businessDate ?? businessDateFor(nowIso, location.timeZone);

    const built = buildReceiptPayload({
      goodsReceiptId: input.goodsReceiptId,
      locationId: location.id,
      supplierId: input.supplierId,
      purchaseOrderId: input.purchaseOrderId,
      businessDate,
      supplierDeliveryNoteRef: input.supplierDeliveryNoteRef,
      supplierInvoiceRef: input.supplierInvoiceRef,
      notes: input.notes,
      lines: input.lines,
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
        input.goodsReceiptId,
        input.goodsReceiptId,
        claimedHlc,
        RECEIPT_OUTBOX_KIND,
        built.payloadJson,
        nowIso,
        queueSeq,
      ],
    );

    return {
      goodsReceiptId: input.goodsReceiptId,
      locationId: location.id,
      lineCount: built.payload.lines.length,
      confirmedLineNos: built.confirmedLineNos,
      businessDate,
    };
  });

  db.changes.notify();
  return result;
}
