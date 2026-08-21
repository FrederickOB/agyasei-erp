/**
 * Recorded sales (the outbox view of them) with per-record sync state (§8.5).
 * "Recent sales" is one tap from the counter, always — the answer to "did that
 * go through?" must never require the network or a manager.
 */
import { deriveRecordSyncState, type RecordSyncState } from '../../lib/badges';
import type { DbRow, LocalDb } from '../db';

export interface RecordedSale {
  readonly id: string;
  readonly createdAt: string;
  readonly totalMinor: bigint;
  readonly syncState: RecordSyncState;
}

function mapSale(row: DbRow): RecordedSale {
  return {
    id: String(row['id']),
    createdAt: String(row['created_at']),
    totalMinor: BigInt(String(row['total_minor'])), // CAST AS TEXT -> bigint, once, here
    syncState: deriveRecordSyncState({
      server_ack_at: row['server_ack_at'] === null ? null : String(row['server_ack_at']),
      rejected_at: row['rejected_at'] === null ? null : String(row['rejected_at']),
    }),
  };
}

export async function recentSales(db: LocalDb, limit = 20): Promise<RecordedSale[]> {
  const rows = await db.getAll(
    `SELECT id, created_at, server_ack_at, rejected_at,
            CAST(total_minor AS TEXT) AS total_minor
       FROM outbox
      WHERE kind = 'sale'
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map(mapSale);
}

export async function getRecordedSale(db: LocalDb, saleId: string): Promise<RecordedSale | null> {
  const rows = await db.getAll(
    `SELECT id, created_at, server_ack_at, rejected_at,
            CAST(total_minor AS TEXT) AS total_minor
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
