/**
 * What this device has queued for the yard and the road, with its per-record
 * sync state.
 *
 * §8.5: *"Badges appear on stock adjustments, transfers, credit payments and
 * cash-session closes too, not only sales. A transfer a manager believes was
 * recorded and was not is the same class of error."* A goods receipt is the
 * sharpest case of all: the stock is physically on the ground, and if the
 * office never hears about it the yard's book and the ledger diverge silently
 * until somebody counts.
 *
 * This is a LOCAL read for the same reason "recent sales" is: the answer to
 * "did that go through?" must never require the network. Everything except the
 * sync columns is read back out of the PAYLOAD the device queued, because that
 * payload is the only record of the receipt that exists until the server acks
 * it — there is no local `goods_receipt` row, and inventing one would be a
 * second copy of the truth that could disagree with the queued bytes.
 *
 * Quantities come off the payload as decimal STRINGS and become `bigint` here,
 * exactly once (ADR-0004). A row whose payload cannot be read is LEFT OUT
 * rather than rendered with holes in it: the queue's own stuck state is what
 * surfaces it, and guessing at a quantity would be worse than silence.
 */
import { deriveRecordSyncState, type RecordSyncState } from '../../lib/badges';
import { RECEIPT_OUTBOX_KIND } from '../mutations/recordGoodsReceipt';
import { DELIVERY_STATUS_OUTBOX_KIND } from '../mutations/updateDeliveryStatus';
import type { DbRow, LocalDb } from '../db';
import { OUTBOX_QUEUE_ORDER, OUTBOX_QUEUE_ORDER_DESC } from '../sync/queue-seq';

export interface QueuedReceiptLine {
  readonly lineNo: number;
  readonly productId: string;
  readonly purchaseOrderLineId: string | null;
  /** In the SUPPLIER's unit — what was invoiced. */
  readonly qtyReceived: bigint;
  /** In the STOCKING unit — what was counted off the truck. */
  readonly qtyStock: bigint;
  /** True when the count differed from the conversion and somebody signed. */
  readonly conversionConfirmed: boolean;
}

export interface QueuedReceipt {
  readonly id: string;
  readonly createdAt: string;
  readonly supplierId: string;
  readonly purchaseOrderId: string | null;
  readonly businessDate: string;
  readonly supplierDeliveryNoteRef: string | null;
  readonly lines: readonly QueuedReceiptLine[];
  readonly syncState: RecordSyncState;
  /** The server's own sentence, when it definitively refused this write. */
  readonly rejectReason: string | null;
}

export interface QueuedDeliveryUpdate {
  readonly id: string;
  readonly createdAt: string;
  readonly deliveryId: string;
  readonly toStatus: string;
  readonly reason: string | null;
  readonly syncState: RecordSyncState;
  readonly rejectReason: string | null;
}

function syncStateOf(row: DbRow): RecordSyncState {
  return deriveRecordSyncState({
    server_ack_at: row['server_ack_at'] === null ? null : String(row['server_ack_at']),
    rejected_at: row['rejected_at'] === null ? null : String(row['rejected_at']),
  });
}

function payloadOf(row: DbRow): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(String(row['payload']));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function scaled(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function mapReceipt(row: DbRow): QueuedReceipt | null {
  const payload = payloadOf(row);
  if (payload === null) return null;
  const rawLines = payload['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0) return null;

  const lines: QueuedReceiptLine[] = [];
  for (const raw of rawLines) {
    if (typeof raw !== 'object' || raw === null) return null;
    const line = raw as Record<string, unknown>;
    const qtyReceived = scaled(line['qtyReceived']);
    const qtyStock = scaled(line['qtyStock']);
    const lineNo = line['lineNo'];
    const productId = line['productId'];
    if (qtyReceived === null || qtyStock === null) return null;
    if (typeof lineNo !== 'number' || typeof productId !== 'string') return null;
    lines.push({
      lineNo,
      productId,
      purchaseOrderLineId: optionalText(line['purchaseOrderLineId']),
      qtyReceived,
      qtyStock,
      conversionConfirmed: line['confirmConversion'] === true,
    });
  }

  const supplierId = payload['supplierId'];
  if (typeof supplierId !== 'string') return null;

  return {
    id: String(row['id']),
    createdAt: String(row['created_at']),
    supplierId,
    purchaseOrderId: optionalText(payload['purchaseOrderId']),
    businessDate: typeof payload['businessDate'] === 'string' ? payload['businessDate'] : '',
    supplierDeliveryNoteRef: optionalText(payload['supplierDeliveryNoteRef']),
    lines,
    syncState: syncStateOf(row),
    rejectReason: row['reject_reason'] === null ? null : String(row['reject_reason']),
  };
}

function mapDeliveryUpdate(row: DbRow): QueuedDeliveryUpdate | null {
  const payload = payloadOf(row);
  if (payload === null) return null;
  const deliveryId = payload['deliveryId'];
  const toStatus = payload['toStatus'];
  if (typeof deliveryId !== 'string' || typeof toStatus !== 'string') return null;
  return {
    id: String(row['id']),
    createdAt: String(row['created_at']),
    deliveryId,
    toStatus,
    reason: optionalText(payload['reason']),
    syncState: syncStateOf(row),
    rejectReason: row['reject_reason'] === null ? null : String(row['reject_reason']),
  };
}

/**
 * Newest first, in the SAME order the drain uses, reversed — so "the last
 * thing this device queued" is the same row the server will apply last. Two
 * spellings of the queue order are two queue orders (`data/sync/queue-seq.ts`).
 */
async function recentOfKind(db: LocalDb, kind: string, limit: number): Promise<DbRow[]> {
  return db.getAll(
    `SELECT id, created_at, server_ack_at, rejected_at, reject_reason, payload
       FROM outbox
      WHERE kind = ?
      ORDER BY ${OUTBOX_QUEUE_ORDER_DESC}
      LIMIT ?`,
    [kind, limit],
  );
}

export async function recentReceipts(db: LocalDb, limit = 20): Promise<QueuedReceipt[]> {
  const rows = await recentOfKind(db, RECEIPT_OUTBOX_KIND, limit);
  return rows.map(mapReceipt).filter((r): r is QueuedReceipt => r !== null);
}

export async function recentDeliveryUpdates(
  db: LocalDb,
  limit = 20,
): Promise<QueuedDeliveryUpdate[]> {
  const rows = await recentOfKind(db, DELIVERY_STATUS_OUTBOX_KIND, limit);
  return rows.map(mapDeliveryUpdate).filter((r): r is QueuedDeliveryUpdate => r !== null);
}

/**
 * The status this device has QUEUED for a delivery, if any is still in flight.
 *
 * A screen reading a delivery from the server while an unacked move sits in
 * the outbox would show the OLD status as though it were current, which is the
 * one thing §8.5 exists to prevent — the person who recorded it would record
 * it again. So the deliveries screen asks this and labels the row instead.
 */
export async function pendingDeliveryStatuses(
  db: LocalDb,
): Promise<ReadonlyMap<string, QueuedDeliveryUpdate>> {
  const rows = await db.getAll(
    `SELECT id, created_at, server_ack_at, rejected_at, reject_reason, payload
       FROM outbox
      WHERE kind = ? AND server_ack_at IS NULL
      ORDER BY ${OUTBOX_QUEUE_ORDER}`,
    [DELIVERY_STATUS_OUTBOX_KIND],
  );
  const byDelivery = new Map<string, QueuedDeliveryUpdate>();
  for (const row of rows) {
    const update = mapDeliveryUpdate(row);
    // Last one queued wins: the outbox applies in order, so the final queued
    // move is the one the server will end on. That is only true if "in order"
    // is the ENQUEUE order — two moves queued in the same millisecond used to
    // resolve at random here as well, which is the same defect that made
    // PLANNED -> DELIVERED reach the server (`data/sync/queue-seq.ts`).
    if (update !== null) byDelivery.set(update.deliveryId, update);
  }
  return byDelivery;
}
