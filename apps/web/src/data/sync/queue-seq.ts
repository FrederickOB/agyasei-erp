/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OUTBOX'S QUEUE ORDER — TOTAL, DETERMINISTIC, AND THE ORDER OF ENQUEUE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG
 * ---------------------------------------------------------------------------
 * The drain used to read `ORDER BY created_at ASC, id ASC`. That IS a total
 * order — `id` is unique — but it is not the order the ops were QUEUED in,
 * and the difference is a real defect that was observed live:
 *
 *   · `created_at` is an ISO instant at MILLISECOND resolution. Two writes
 *     made in the same millisecond tie.
 *   · The tie-break is `id`, a `uuidv7`. Inside one millisecond a v7 uuid is
 *     10 bytes of CSPRNG output with no counter, so the tie is broken at
 *     RANDOM. Two ops queued in the same millisecond upload in a coin-flip
 *     order.
 *
 * D11 caught it as `PLANNED -> DELIVERED is not a legal delivery transition`:
 * PLANNED→DISPATCHED and DISPATCHED→DELIVERED, queued in the same millisecond,
 * arrived in the wrong order. That case self-heals — the out-of-order op is
 * refused with a retryable CONFLICT and lands on the next drain — but
 * self-healing was luck, not design.
 *
 * ---------------------------------------------------------------------------
 * WHY A MONOTONIC uuidv7 WOULD NOT HAVE FIXED IT
 * ---------------------------------------------------------------------------
 * The obvious fix is RFC 9562's monotonic v7: burn part of `rand_a` as an
 * intra-millisecond counter so ids sort in generation order. It is a real
 * improvement and it is NOT sufficient here, because **an op's id is minted
 * when its work begins, not when it is queued**:
 *
 *   · a sale's id is the CART's id, minted when the cart was opened, possibly
 *     many minutes before checkout enqueues it;
 *   · the sequence block report's id is minted at `enqueueBlockReport`, i.e.
 *     at enqueue.
 *
 * So for the very ordering the upload path documents — "a report queued before
 * a batch of sales reaches the server before them" (`data/sequence.ts`) — a
 * monotonic uuid makes it WORSE, deterministically: the report's id is minted
 * now, the sale's id was minted when its cart opened, so on a `created_at` tie
 * the older cart id sorts first and the report goes second, every time.
 * The property the code claims is about ENQUEUE order, so the key has to be an
 * enqueue-time fact.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * `outbox.queue_seq` — a strictly increasing integer stamped inside the same
 * local write transaction that inserts the row. SQLite serialises writers, so
 * `max + 1` read and written under one transaction cannot collide; the outbox
 * is APPEND-ONLY (nothing anywhere deletes from it — acked rows keep
 * `server_ack_at` and the sales list still reads them), so the counter never
 * regresses and a reused value is unrepresentable.
 *
 * It is a COUNT, not a magnitude: a JS `number` is correct for it in a way it
 * would never be for money (ADR-0004). It is read back through `CAST … AS
 * TEXT` all the same, so the one discipline holds everywhere and nothing here
 * depends on how the local store happens to type a column.
 *
 * ---------------------------------------------------------------------------
 * ROWS FROM BEFORE THIS COLUMN EXISTED
 * ---------------------------------------------------------------------------
 * A device that updates with ops already pending has rows whose `queue_seq` is
 * NULL. They were queued before every row that has one, so they sort FIRST
 * (`COALESCE(queue_seq, -1)`), among themselves by the old key. That keeps the
 * order total, keeps it deterministic, and keeps an in-flight queue draining in
 * the order it was written rather than being reshuffled by an upgrade.
 */
import type { DbExecutor } from '../db';

/**
 * The ONE ordering expression for the queue. Exported as SQL because it has to
 * be identical in the drain and in every reader that asks "what did this
 * device queue, and in what order" — two spellings of a queue order are two
 * queue orders.
 */
export const OUTBOX_QUEUE_ORDER = 'COALESCE(queue_seq, -1) ASC, created_at ASC, id ASC';

/** The same order, newest first, for the screens that show recent work. */
export const OUTBOX_QUEUE_ORDER_DESC = 'COALESCE(queue_seq, -1) DESC, created_at DESC, id DESC';

/**
 * The next queue position. MUST be called inside the same `writeTransaction`
 * as the INSERT that uses it — outside one, two concurrent enqueues can read
 * the same maximum.
 */
export async function nextQueueSeq(tx: DbExecutor): Promise<number> {
  const rows = await tx.getAll(
    'SELECT CAST(COALESCE(MAX(queue_seq), 0) AS TEXT) AS max_seq FROM outbox',
  );
  const raw = rows[0]?.['max_seq'];
  const highest = raw === null || raw === undefined ? 0 : Number(raw);
  if (!Number.isSafeInteger(highest) || highest < 0) {
    throw new Error(`outbox queue_seq is not a whole number: ${String(raw)}`);
  }
  return highest + 1;
}
