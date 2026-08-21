/**
 * Per-record sync state (§8.5) — the anti-duplicate design. Derived from DATA,
 * not from a flag the client maintains: a row the server acknowledged cannot
 * lie, and ambiguity here is how a sale gets rung twice.
 *
 * The vocabulary is three phrases a busy person can read at a glance in
 * daylight — deliberately not "queued/committed/reconciled".
 */

export type RecordSyncState = 'pending' | 'synced' | 'attention';

export interface SyncStampedRow {
  /** Server acknowledgement timestamp; NULL until the write is acked. */
  readonly server_ack_at: string | null;
  /** Set when the upload was rejected or the record entered a review task. */
  readonly rejected_at: string | null;
}

export function deriveRecordSyncState(row: SyncStampedRow): RecordSyncState {
  if (row.rejected_at !== null) return 'attention';
  if (row.server_ack_at !== null) return 'synced';
  return 'pending';
}

export function recordBadgeLabel(state: RecordSyncState): string {
  switch (state) {
    case 'pending':
      return 'Waiting to send';
    case 'synced':
      return 'Saved';
    case 'attention':
      return 'Needs checking';
  }
}
