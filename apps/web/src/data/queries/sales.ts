/**
 * Recorded sales (the outbox view of them) with per-record sync state (§8.5).
 * "Recent sales" is one tap from the counter, always — the answer to "did that
 * go through?" must never require the network or a manager.
 */
import { deriveRecordSyncState, type RecordSyncState } from '../../lib/badges';
import type { DbRow, LocalDb } from '../db';
import { OUTBOX_QUEUE_ORDER_DESC } from '../sync/queue-seq';

export interface RecordedSale {
  readonly id: string;
  readonly createdAt: string;
  /** The device-allocated number printed on the customer's copy (03 §3.7.5). */
  readonly receiptNo: string | null;
  readonly totalMinor: bigint;
  /** Cash tendered and change — DEVICE-LOCAL, never on the wire (see checkout.ts). */
  readonly tenderedMinor: bigint | null;
  readonly changeMinor: bigint | null;
  readonly syncState: RecordSyncState;
}

function optionalBig(value: unknown): bigint | null {
  return value === null || value === undefined ? null : BigInt(String(value));
}

function mapSale(row: DbRow): RecordedSale {
  return {
    id: String(row['id']),
    createdAt: String(row['created_at']),
    receiptNo: row['receipt_no'] === null ? null : String(row['receipt_no']),
    totalMinor: BigInt(String(row['total_minor'])), // CAST AS TEXT -> bigint, once, here
    tenderedMinor: optionalBig(row['tendered_minor']),
    changeMinor: optionalBig(row['change_minor']),
    syncState: deriveRecordSyncState({
      server_ack_at: row['server_ack_at'] === null ? null : String(row['server_ack_at']),
      rejected_at: row['rejected_at'] === null ? null : String(row['rejected_at']),
    }),
  };
}

export async function recentSales(db: LocalDb, limit = 20): Promise<RecordedSale[]> {
  const rows = await db.getAll(
    `SELECT id, created_at, server_ack_at, rejected_at, receipt_no,
            CAST(total_minor AS TEXT) AS total_minor,
            CAST(tendered_minor AS TEXT) AS tendered_minor,
            CAST(change_minor AS TEXT) AS change_minor
       FROM outbox
      WHERE kind = 'sale'
      ORDER BY ${OUTBOX_QUEUE_ORDER_DESC}
      LIMIT ?`,
    [limit],
  );
  return rows.map(mapSale);
}

export async function getRecordedSale(db: LocalDb, saleId: string): Promise<RecordedSale | null> {
  const rows = await db.getAll(
    `SELECT id, created_at, server_ack_at, rejected_at, receipt_no,
            CAST(total_minor AS TEXT) AS total_minor,
            CAST(tendered_minor AS TEXT) AS tendered_minor,
            CAST(change_minor AS TEXT) AS change_minor
       FROM outbox
      WHERE kind = 'sale' AND id = ?
      LIMIT 1`,
    [saleId],
  );
  const row = rows[0];
  return row === undefined ? null : mapSale(row);
}

export interface OutboxQueueSnapshot {
  readonly pendingCount: number;
  readonly oldestQueuedAtMs: number | null;
}

/** Feed for the status bar's four-state indicator (§8.4). */
export async function readOutboxQueue(db: LocalDb): Promise<OutboxQueueSnapshot> {
  const rows = await db.getAll(
    `SELECT COUNT(*) AS n, MIN(created_at) AS oldest
       FROM outbox
      WHERE server_ack_at IS NULL AND rejected_at IS NULL`,
  );
  const row = rows[0];
  const pendingCount = Number(row?.['n'] ?? 0);
  const oldestRaw = row?.['oldest'];
  const oldestQueuedAtMs =
    pendingCount > 0 && typeof oldestRaw === 'string' ? Date.parse(oldestRaw) : null;
  return { pendingCount, oldestQueuedAtMs };
}
