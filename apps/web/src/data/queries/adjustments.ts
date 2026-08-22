/**
 * The adjustments this device has recorded, with their per-record sync state.
 *
 * §8.5: *"Badges appear on stock adjustments, transfers, credit payments and
 * cash-session closes too, not only sales. A transfer a manager believes was
 * recorded and was not is the same class of error."* This is that list for
 * adjustments, and it is a LOCAL read for the same reason "recent sales" is:
 * the answer to "did that go through?" must never require the network.
 *
 * The row's own columns carry the sync state; everything else is read back out
 * of the payload the device queued, because that payload is the only record of
 * the movement that exists until the server acks it — there is no local
 * `stock_movement` row for it, and inventing one would be a second copy of the
 * truth that could disagree with the queued bytes.
 *
 * `qtyDelta` comes off the payload as a decimal STRING and becomes `bigint`
 * here, exactly once (ADR-0004). It is not a SQLite `INTEGER` column, so the
 * `CAST(col AS TEXT)` discipline does not apply to it — but the reason for
 * that discipline does: it never becomes a JS `number` on the way.
 */
import { deriveRecordSyncState, type RecordSyncState } from '../../lib/badges';
import { ADJUSTMENT_OUTBOX_KIND, isAdjustmentKind, type AdjustmentKind } from '../mutations/adjustStock';
import type { DbRow, LocalDb } from '../db';

export interface RecordedAdjustment {
  readonly id: string;
  readonly createdAt: string;
  readonly productId: string;
  /** SIGNED scaled integer in the product's stocking unit. */
  readonly qtyDelta: bigint;
  readonly kind: AdjustmentKind | null;
  /** The tenant's code. Rendered through its own row's name; never compared. */
  readonly reasonCode: string;
  readonly businessDate: string;
  readonly syncState: RecordSyncState;
  /** The server's own sentence, when it definitively refused this write. */
  readonly rejectReason: string | null;
}

interface MovementPayloadShape {
  readonly productId?: unknown;
  readonly qtyDelta?: unknown;
  readonly sourceKind?: unknown;
  readonly reasonCode?: unknown;
  readonly businessDate?: unknown;
}

function mapAdjustment(row: DbRow): RecordedAdjustment | null {
  let payload: MovementPayloadShape;
  try {
    const parsed: unknown = JSON.parse(String(row['payload']));
    if (typeof parsed !== 'object' || parsed === null) return null;
    payload = parsed as MovementPayloadShape;
  } catch {
    // A locally corrupt payload is not rendered as a movement with missing
    // fields — it is left out of the list, and the queue's own stuck state is
    // what surfaces it. Guessing at the quantity would be worse than silence.
    return null;
  }
  const qtyRaw = payload.qtyDelta;
  if (typeof qtyRaw !== 'string') return null;
  let qtyDelta: bigint;
  try {
    qtyDelta = BigInt(qtyRaw);
  } catch {
    return null;
  }
  const kindRaw = payload.sourceKind;
  return {
    id: String(row['id']),
    createdAt: String(row['created_at']),
    productId: typeof payload.productId === 'string' ? payload.productId : '',
    qtyDelta,
    kind: typeof kindRaw === 'string' && isAdjustmentKind(kindRaw) ? kindRaw : null,
    reasonCode: typeof payload.reasonCode === 'string' ? payload.reasonCode : '',
    businessDate: typeof payload.businessDate === 'string' ? payload.businessDate : '',
    syncState: deriveRecordSyncState({
      server_ack_at: row['server_ack_at'] === null ? null : String(row['server_ack_at']),
      rejected_at: row['rejected_at'] === null ? null : String(row['rejected_at']),
    }),
    rejectReason: row['reject_reason'] === null ? null : String(row['reject_reason']),
  };
}

export async function recentAdjustments(db: LocalDb, limit = 20): Promise<RecordedAdjustment[]> {
  const rows = await db.getAll(
    `SELECT id, created_at, server_ack_at, rejected_at, reject_reason, payload
       FROM outbox
      WHERE kind = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [ADJUSTMENT_OUTBOX_KIND, limit],
  );
  return rows.map(mapAdjustment).filter((a): a is RecordedAdjustment => a !== null);
}
