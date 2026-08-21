/**
 * CLAUDE.md §2.7 category 2: the outbox drain is sync logic. Mocked transport
 * — no live service. What must hold:
 *
 *  - an op completes ONLY on its own server ack (applied/duplicate),
 *  - a definitive rejection becomes the VISIBLE attention state, never a
 *    silent drop; a retryable one stays pending,
 *  - ops go out strictly in queue order,
 *  - a failed or unanswered transport completes nothing.
 */
import { describe, expect, it } from 'vitest';
import type { LocalDb } from '../src/data/db';
import {
  classifyRejection,
  drainOutbox,
  readPendingOps,
  type DrainProgress,
  type PendingOp,
  type UploadAck,
  type UploadResult,
  type UploadTransport,
} from '../src/data/sync/upload';
import { readOutboxQueue, recentSales } from '../src/data/queries/sales';
import { fixedHlc } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';
import { uuidv7 } from '../src/lib/uuidv7';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const hlc = fixedHlc();

async function enqueue(
  db: LocalDb,
  opts: { readonly createdAt: string; readonly key?: string; readonly kind?: string },
): Promise<string> {
  const key = opts.key ?? uuidv7();
  await db.execute(
    `INSERT INTO outbox
       (id, idempotency_key, claimed_hlc, kind, payload, total_minor,
        created_at, server_ack_at, rejected_at, reject_reason)
     VALUES (?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, NULL, NULL, NULL)`,
    [
      key,
      key,
      hlc.next(),
      opts.kind ?? 'sale',
      JSON.stringify({ kind: 'sale', sale_id: key, total_minor: '100' }),
      '100',
      opts.createdAt,
    ],
  );
  return key;
}

interface RowMarks {
  readonly server_ack_at: string | null;
  readonly rejected_at: string | null;
  readonly reject_reason: string | null;
}

async function marksOf(db: LocalDb, id: string): Promise<RowMarks> {
  const rows = await db.getAll(
    'SELECT server_ack_at, rejected_at, reject_reason FROM outbox WHERE id = ?',
    [id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no outbox row ${id}`);
  return {
    server_ack_at: row['server_ack_at'] === null ? null : String(row['server_ack_at']),
    rejected_at: row['rejected_at'] === null ? null : String(row['rejected_at']),
    reject_reason: row['reject_reason'] === null ? null : String(row['reject_reason']),
  };
}

class MockTransport implements UploadTransport {
  readonly batches: PendingOp[][] = [];
  private readonly scripted: (UploadResult | Error)[] = [];

  script(next: UploadResult | Error): this {
    this.scripted.push(next);
    return this;
  }

  /** Default when nothing is scripted: ack everything as applied. */
  async send(ops: readonly PendingOp[]): Promise<UploadResult> {
    this.batches.push([...ops]);
    const next = this.scripted.shift();
    if (next === undefined) {
      return {
        ok: true,
        status: 200,
        acks: ops.map((op): UploadAck => ({ key: op.idempotencyKey, status: 'applied' })),
      };
    }
    if (next instanceof Error) throw next;
    return next;
  }
}

const T1 = '2026-08-21T09:00:00.000Z';
const T2 = '2026-08-21T09:01:00.000Z';
const T3 = '2026-08-21T09:02:00.000Z';

// ---------------------------------------------------------------------------
// ack handling
// ---------------------------------------------------------------------------

describe('ack handling', () => {
  it('an applied ack marks the op acked and the badge becomes Saved', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const transport = new MockTransport();

    const report = await drainOutbox(db, transport);

    expect(report).toEqual({
      batchSize: 1,
      completed: 1,
      rejected: 0,
      deferred: 0,
      transportOk: true,
    });
    const marks = await marksOf(db, key);
    expect(marks.server_ack_at).not.toBeNull();
    expect(marks.rejected_at).toBeNull();
    const [sale] = await recentSales(db);
    expect(sale?.syncState).toBe('synced');
    expect((await readOutboxQueue(db)).pendingCount).toBe(0);
  });

  it('a duplicate ack completes exactly like applied — the intent was carried out', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const transport = new MockTransport().script({
      ok: true,
      status: 200,
      acks: [{ key, status: 'duplicate' }],
    });

    const report = await drainOutbox(db, transport);

    expect(report.completed).toBe(1);
    expect((await marksOf(db, key)).server_ack_at).not.toBeNull();
    expect((await readOutboxQueue(db)).pendingCount).toBe(0);
  });

  it('a definitive rejection becomes the visible attention state, never a silent drop', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const reason = 'BAD_REQUEST: lines[0].qty must be positive';
    const transport = new MockTransport().script({
      ok: true,
      status: 200,
      acks: [{ key, status: 'rejected', reason }],
    });

    const report = await drainOutbox(db, transport);

    expect(report.rejected).toBe(1);
    const marks = await marksOf(db, key);
    expect(marks.server_ack_at).toBeNull();
    expect(marks.rejected_at).not.toBeNull();
    expect(marks.reject_reason).toBe(reason);
    // Visible per record: the sale is still on the device, flagged for a human.
    const [sale] = await recentSales(db);
    expect(sale?.syncState).toBe('attention');
    // Out of the pending queue (it will not be retried)…
    expect((await readOutboxQueue(db)).pendingCount).toBe(0);
    // …and genuinely not re-sent.
    await drainOutbox(db, transport);
    expect(transport.batches).toHaveLength(1);
  });

  it('a retryable rejection stays pending and is re-sent on the next pass', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const transport = new MockTransport().script({
      ok: true,
      status: 200,
      acks: [{ key, status: 'rejected', reason: 'CONFLICT: RETRY_LATER — first writer committing' }],
    });

    const report = await drainOutbox(db, transport);

    expect(report).toMatchObject({ completed: 0, rejected: 0, deferred: 1 });
    const marks = await marksOf(db, key);
    expect(marks.server_ack_at).toBeNull();
    expect(marks.rejected_at).toBeNull();
    expect((await readOutboxQueue(db)).pendingCount).toBe(1);

    // Next pass re-sends the same key (idempotent server-side).
    await drainOutbox(db, transport);
    expect(transport.batches).toHaveLength(2);
    expect(transport.batches[1]?.[0]?.idempotencyKey).toBe(key);
    expect((await marksOf(db, key)).server_ack_at).not.toBeNull();
  });

  it('a mixed batch settles per op — one rejection never blocks the acks around it', async () => {
    const db = openTestDb();
    const k1 = await enqueue(db, { createdAt: T1 });
    const k2 = await enqueue(db, { createdAt: T2 });
    const k3 = await enqueue(db, { createdAt: T3 });
    const transport = new MockTransport().script({
      ok: true,
      status: 200,
      acks: [
        { key: k1, status: 'applied' },
        { key: k2, status: 'rejected', reason: 'UNKNOWN_KIND: not uploadable' },
        { key: k3, status: 'applied' },
      ],
    });

    const report = await drainOutbox(db, transport);

    expect(report).toMatchObject({ batchSize: 3, completed: 2, rejected: 1, deferred: 0 });
    expect((await marksOf(db, k1)).server_ack_at).not.toBeNull();
    expect((await marksOf(db, k2)).rejected_at).not.toBeNull();
    expect((await marksOf(db, k3)).server_ack_at).not.toBeNull();
  });
});

describe('rejection taxonomy (§3.3.4)', () => {
  it('only the enumerated definitive prefixes dead-letter; the unknown case retries', () => {
    expect(classifyRejection('BAD_REQUEST: malformed')).toBe('definitive');
    expect(classifyRejection('UNPROCESSABLE_CONTENT: invariant')).toBe('definitive');
    expect(classifyRejection('UNKNOWN_KIND: nope')).toBe('definitive');
    expect(classifyRejection('CONFLICT: RETRY_LATER')).toBe('retryable');
    expect(classifyRejection('FORBIDDEN: stale permission snapshot')).toBe('retryable');
    expect(classifyRejection('INTERNAL_SERVER_ERROR: boom')).toBe('retryable');
    expect(classifyRejection('SOMETHING_NEW: never seen')).toBe('retryable');
    expect(classifyRejection(undefined)).toBe('retryable');
  });
});

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

describe('ordering', () => {
  it('ops are sent strictly in queue order regardless of insertion order', async () => {
    const db = openTestDb();
    // Insert newest first to prove the ORDER BY, not the insertion, decides.
    const k3 = await enqueue(db, { createdAt: T3 });
    const k1 = await enqueue(db, { createdAt: T1 });
    const k2 = await enqueue(db, { createdAt: T2 });

    const pending = await readPendingOps(db);
    expect(pending.map((op) => op.idempotencyKey)).toEqual([k1, k2, k3]);

    const transport = new MockTransport();
    await drainOutbox(db, transport);
    expect(transport.batches[0]?.map((op) => op.idempotencyKey)).toEqual([k1, k2, k3]);
  });

  it('the batch limit sends the OLDEST ops first and leaves the rest pending', async () => {
    const db = openTestDb();
    const k1 = await enqueue(db, { createdAt: T1 });
    const k2 = await enqueue(db, { createdAt: T2 });
    const k3 = await enqueue(db, { createdAt: T3 });

    const transport = new MockTransport();
    const report = await drainOutbox(db, transport, { batchLimit: 2 });

    expect(report.batchSize).toBe(2);
    expect(transport.batches[0]?.map((op) => op.idempotencyKey)).toEqual([k1, k2]);
    expect((await marksOf(db, k3)).server_ack_at).toBeNull();
    expect((await readOutboxQueue(db)).pendingCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// no completion without an ack
// ---------------------------------------------------------------------------

describe('no completion without an ack', () => {
  it('a transport failure completes nothing', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const transport = new MockTransport().script(new Error('network down'));

    const report = await drainOutbox(db, transport);

    expect(report).toMatchObject({ completed: 0, rejected: 0, deferred: 1, transportOk: false });
    const marks = await marksOf(db, key);
    expect(marks.server_ack_at).toBeNull();
    expect(marks.rejected_at).toBeNull();
    expect((await readOutboxQueue(db)).pendingCount).toBe(1);
  });

  it('a non-200 answer completes nothing', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const transport = new MockTransport().script({ ok: false, status: 503, acks: [] });

    const report = await drainOutbox(db, transport);

    expect(report).toMatchObject({ completed: 0, deferred: 1, transportOk: false });
    expect((await marksOf(db, key)).server_ack_at).toBeNull();
  });

  it('an op whose ack is missing from a 200 stays pending', async () => {
    const db = openTestDb();
    const k1 = await enqueue(db, { createdAt: T1 });
    const k2 = await enqueue(db, { createdAt: T2 });
    const transport = new MockTransport().script({
      ok: true,
      status: 200,
      acks: [{ key: k1, status: 'applied' }], // nothing for k2
    });

    const report = await drainOutbox(db, transport);

    expect(report).toMatchObject({ completed: 1, deferred: 1, transportOk: true });
    expect((await marksOf(db, k1)).server_ack_at).not.toBeNull();
    expect((await marksOf(db, k2)).server_ack_at).toBeNull();
    expect((await readOutboxQueue(db)).pendingCount).toBe(1);
  });

  it('an empty queue transmits nothing', async () => {
    const db = openTestDb();
    const transport = new MockTransport();
    const report = await drainOutbox(db, transport);
    expect(report.batchSize).toBe(0);
    expect(transport.batches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// progress feed (§8.4 "Sending · x of y")
// ---------------------------------------------------------------------------

describe('progress', () => {
  it('reports 0..settled over the batch and ends with null', async () => {
    const db = openTestDb();
    await enqueue(db, { createdAt: T1 });
    await enqueue(db, { createdAt: T2 });
    const seen: (DrainProgress | null)[] = [];

    await drainOutbox(db, new MockTransport(), { onProgress: (p) => seen.push(p) });

    expect(seen[0]).toEqual({ sentCount: 0, batchSize: 2 });
    expect(seen[seen.length - 1]).toBeNull();
    const counts = seen
      .filter((p): p is DrainProgress => p !== null)
      .map((p) => p.sentCount);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts); // monotonic
    expect(counts[counts.length - 1]).toBe(2);
  });
});
