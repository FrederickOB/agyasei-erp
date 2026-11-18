/**
 * The per-sale print queue (`local_print_queue`, local-only, §8.8 / §8.11).
 *
 * THE RULE THIS FILE EXISTS TO KEEP: a print is a request made OF a completed
 * sale and never a part of it. This module reads and writes exactly one table.
 * It does not touch `outbox`, `cart`, `sequence_block` or any synced table, so
 * a failed, retried, duplicated or expired print has no way to alter, delay or
 * double a sale — which is what stops anybody re-ringing one because "it did
 * not print".
 *
 * Row lifecycle
 *   created      state 'pending', bytes cached once rendered
 *   attempt      attempts+1, last_* recorded; 'sent'/'shown' -> state 'sent',
 *                cached bytes dropped; anything else stays 'pending' (retryable)
 *   reprint      state back to 'pending', is_copy=1, a NEW request; bytes dropped
 *   expiry       the whole row goes 7 days after creation
 */
import type { LocalDb } from '../data/db';
import { uuidv7 } from '../lib/uuidv7';
import { deserializeDocument, serializeDocument, type ReceiptDocument } from './document';
import type { PrintAttempt } from './transports/types';

export const PRINT_QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type QueueState = 'pending' | 'sent';

export interface QueueEntry {
  readonly saleId: string;
  readonly receiptNo: string;
  readonly doc: ReceiptDocument | null;
  readonly bytesB64: string | null;
  readonly paperWidthMm: number | null;
  readonly state: QueueState;
  readonly isCopy: boolean;
  readonly attempts: number;
  readonly lastOutcome: string | null;
  readonly lastEvidence: string | null;
  readonly lastDetail: string | null;
  readonly lastTransport: string | null;
  readonly lastAttemptAt: string | null;
  readonly requestedAt: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

const COLUMNS =
  'sale_id, receipt_no, doc_json, bytes_b64, paper_width_mm, state, is_copy, attempts, last_outcome, last_evidence, last_detail, last_transport, last_attempt_at, requested_at, created_at, expires_at';

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function mapEntry(row: Readonly<Record<string, string | number | null>>): QueueEntry {
  const docJson = str(row['doc_json']);
  return {
    saleId: String(row['sale_id']),
    receiptNo: String(row['receipt_no']),
    doc: docJson === null ? null : deserializeDocument(docJson),
    bytesB64: str(row['bytes_b64']),
    paperWidthMm: row['paper_width_mm'] === null ? null : Number(row['paper_width_mm']),
    state: row['state'] === 'sent' ? 'sent' : 'pending',
    isCopy: Number(row['is_copy']) === 1,
    attempts: Number(row['attempts'] ?? 0),
    lastOutcome: str(row['last_outcome']),
    lastEvidence: str(row['last_evidence']),
    lastDetail: str(row['last_detail']),
    lastTransport: str(row['last_transport']),
    lastAttemptAt: str(row['last_attempt_at']),
    requestedAt: String(row['requested_at']),
    createdAt: String(row['created_at']),
    expiresAt: String(row['expires_at']),
  };
}

/** Put a receipt in the queue as a pending first print. Idempotent per sale: a second call changes nothing. */
export async function enqueueReceipt(db: LocalDb, doc: ReceiptDocument, nowIso: string): Promise<void> {
  await db.writeTransaction(async (tx) => {
    const existing = await tx.getAll('SELECT 1 AS hit FROM local_print_queue WHERE sale_id = ?', [doc.saleId]);
    if (existing.length > 0) return;
    const expires = new Date(Date.parse(nowIso) + PRINT_QUEUE_TTL_MS).toISOString();
    await tx.execute(
      `INSERT INTO local_print_queue
         (id, sale_id, receipt_no, doc_json, bytes_b64, paper_width_mm, state, is_copy, attempts,
          last_outcome, last_evidence, last_detail, last_transport, last_attempt_at,
          requested_at, created_at, expires_at)
       VALUES (?, ?, ?, ?, NULL, NULL, 'pending', 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      [uuidv7(), doc.saleId, doc.receiptNo, serializeDocument(doc), nowIso, nowIso, expires],
    );
  });
  db.changes.notify();
}

export async function getQueueEntry(db: LocalDb, saleId: string): Promise<QueueEntry | null> {
  const rows = await db.getAll(`SELECT ${COLUMNS} FROM local_print_queue WHERE sale_id = ? LIMIT 1`, [saleId]);
  const row = rows[0];
  return row === undefined ? null : mapEntry(row);
}

/** Outstanding prints, oldest request first — the order they should reach the printer. */
export async function listPending(db: LocalDb): Promise<QueueEntry[]> {
  const rows = await db.getAll(
    `SELECT ${COLUMNS} FROM local_print_queue WHERE state = 'pending' ORDER BY requested_at ASC, created_at ASC`,
  );
  return rows.map(mapEntry);
}

export async function cacheBytes(
  db: LocalDb,
  saleId: string,
  bytesB64: string,
  paperWidthMm: number,
): Promise<void> {
  await db.execute('UPDATE local_print_queue SET bytes_b64 = ?, paper_width_mm = ? WHERE sale_id = ?', [
    bytesB64,
    paperWidthMm,
    saleId,
  ]);
}

export function isSuccess(attempt: PrintAttempt): boolean {
  return attempt.outcome === 'sent' || attempt.outcome === 'shown';
}

export async function recordAttempt(
  db: LocalDb,
  saleId: string,
  attempt: PrintAttempt,
  nowIso: string,
): Promise<void> {
  const done = isSuccess(attempt);
  await db.execute(
    `UPDATE local_print_queue
        SET attempts = attempts + 1,
            state = ?,
            bytes_b64 = ${done ? 'NULL' : 'bytes_b64'},
            last_outcome = ?, last_evidence = ?, last_detail = ?, last_transport = ?, last_attempt_at = ?
      WHERE sale_id = ?`,
    [done ? 'sent' : 'pending', attempt.outcome, attempt.evidence, attempt.detail, attempt.transport, nowIso, saleId],
  );
  db.changes.notify();
}

/** A person asked for another copy. A NEW request against the same sale; the sale is untouched. */
export async function requestReprint(db: LocalDb, saleId: string, nowIso: string): Promise<boolean> {
  const entry = await getQueueEntry(db, saleId);
  if (entry === null) return false;
  await db.execute(
    `UPDATE local_print_queue
        SET state = 'pending', is_copy = 1, bytes_b64 = NULL, requested_at = ?
      WHERE sale_id = ?`,
    [nowIso, saleId],
  );
  db.changes.notify();
  return true;
}

/** Make sure a queue row exists for a document built later (a reprint of a sale with no row). */
export async function ensureEntry(db: LocalDb, doc: ReceiptDocument, nowIso: string): Promise<void> {
  await enqueueReceipt(db, doc, nowIso);
}

/** Drop rows past their 7 days. Returns how many went. */
export async function purgeExpired(db: LocalDb, nowIso: string): Promise<number> {
  const before = await db.getAll('SELECT COUNT(*) AS n FROM local_print_queue WHERE expires_at <= ?', [nowIso]);
  const n = Number(before[0]?.['n'] ?? 0);
  if (n > 0) {
    await db.execute('DELETE FROM local_print_queue WHERE expires_at <= ?', [nowIso]);
    db.changes.notify();
  }
  return n;
}
