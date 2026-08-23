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
  NO_ACK_REASON,
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
import { CLAIMED_HLC_RE, deviceNodeFromClaimedHlc } from '../src/lib/hlc';

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
  readonly last_refusal_reason: string | null;
  readonly last_refusal_at: string | null;
}

async function marksOf(db: LocalDb, id: string): Promise<RowMarks> {
  const rows = await db.getAll(
    `SELECT server_ack_at, rejected_at, reject_reason, last_refusal_reason, last_refusal_at
       FROM outbox WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no outbox row ${id}`);
  const text = (key: string): string | null => (row[key] === null ? null : String(row[key]));
  return {
    server_ack_at: text('server_ack_at'),
    rejected_at: text('rejected_at'),
    reject_reason: text('reject_reason'),
    last_refusal_reason: text('last_refusal_reason'),
    last_refusal_at: text('last_refusal_at'),
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
      deferredReasons: [],
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

// ---------------------------------------------------------------------------
// what the server said — the sentence that used to be thrown away
// ---------------------------------------------------------------------------

/**
 * A retryable refusal is the correct settlement (§3.3.4: dead-lettering a real
 * sale is the loss path) and it used to be a MUTE one. `ack.reason` was read,
 * classified, and dropped on the floor — so a write the server refused every
 * 30 seconds for sixteen hours told its counter "tell your manager" and told
 * the manager nothing.
 *
 * Every test here holds the settlement constant and asserts only that the
 * sentence survives. If one of them ever starts passing because the op left
 * the queue, the fix has become the bug.
 */
describe('a refusal that stays queued', () => {
  const REASON = 'PRECONDITION_FAILED: no price list DEFAULT in force on 2026-08-21';

  function refuses(key: string, reason: string): UploadResult {
    return { ok: true, status: 200, acks: [{ key, status: 'rejected', reason }] };
  }

  it('keeps the server’s sentence AND leaves the op pending', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const transport = new MockTransport().script(refuses(key, REASON));

    const report = await drainOutbox(db, transport);

    const marks = await marksOf(db, key);
    expect(marks.last_refusal_reason).toBe(REASON);
    expect(marks.last_refusal_at).not.toBeNull();
    // THE SETTLEMENT IS UNCHANGED: not acked, not dead-lettered, still queued,
    // still going out on the next pass.
    expect(marks.server_ack_at).toBeNull();
    expect(marks.rejected_at).toBeNull();
    expect(report.deferred).toBe(1);
    expect(report.rejected).toBe(0);
    expect((await readPendingOps(db)).map((o) => o.id)).toEqual([key]);
    expect((await readOutboxQueue(db)).pendingCount).toBe(1);
  });

  it('reports it to the caller, which is what makes it loggable', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1, kind: 'sale' });
    const transport = new MockTransport().script(refuses(key, REASON));

    const report = await drainOutbox(db, transport);

    expect(report.deferredReasons).toEqual([
      { kind: 'sale', idempotencyKey: key, reason: REASON },
    ]);
  });

  it('shows it on the record, which still reads as waiting rather than failed', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });

    await drainOutbox(db, new MockTransport().script(refuses(key, REASON)));

    const [sale] = await recentSales(db);
    expect(sale?.lastRefusalReason).toBe(REASON);
    expect(sale?.rejectReason).toBeNull();
    expect(sale?.syncState).toBe('pending');
  });

  it('rings the change bus, or the sentence lands in the database and nowhere else', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    let notified = 0;
    db.changes.subscribe(() => {
      notified += 1;
    });

    await drainOutbox(db, new MockTransport().script(refuses(key, REASON)));

    expect(notified).toBeGreaterThan(0);
  });

  it('records the newest refusal, not the first — a reason can change', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const second = 'CONFLICT: this location is being re-scoped';
    const transport = new MockTransport()
      .script(refuses(key, REASON))
      .script(refuses(key, second));

    await drainOutbox(db, transport);
    await drainOutbox(db, transport);

    expect((await marksOf(db, key)).last_refusal_reason).toBe(second);
  });

  it('names the silence when the server answers the batch but not this key', async () => {
    // The one settlement that has no sentence to quote, and would otherwise be
    // the single case left mute. A key the server keeps ignoring is exactly as
    // stuck as one it keeps refusing.
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const transport = new MockTransport().script({ ok: true, status: 200, acks: [] });

    const report = await drainOutbox(db, transport);

    expect((await marksOf(db, key)).last_refusal_reason).toBe(NO_ACK_REASON);
    expect(report.deferred).toBe(1);
    expect((await readPendingOps(db))).toHaveLength(1);
  });

  it('does NOT overwrite a real reason when the next batch never arrives', async () => {
    // THE REGRESSION THIS GUARDS. An undelivered batch is not a refusal, and
    // offline is the expected condition for hours at a time — stamping "the
    // network was down" over the server's diagnosis would erase it on the
    // device's very next outage, which is guaranteed to come.
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const transport = new MockTransport()
      .script(refuses(key, REASON))
      .script({ ok: false, status: 0, acks: [] });

    await drainOutbox(db, transport);
    const afterRefusal = await marksOf(db, key);
    const report = await drainOutbox(db, transport);

    expect((await marksOf(db, key)).last_refusal_reason).toBe(REASON);
    expect((await marksOf(db, key)).last_refusal_at).toBe(afterRefusal.last_refusal_at);
    expect(report.transportOk).toBe(false);
    expect(report.deferredReasons).toEqual([]);
  });

  it('a definitive rejection still dead-letters, and is not confused with this', async () => {
    // The two states have to stay distinguishable: one has stopped, one has
    // not, and the badge is derived from which columns are set.
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const fatal = 'BAD_REQUEST: lines must not be empty';

    await drainOutbox(db, new MockTransport().script(refuses(key, fatal)));

    const marks = await marksOf(db, key);
    expect(marks.rejected_at).not.toBeNull();
    expect(marks.reject_reason).toBe(fatal);
    expect(marks.last_refusal_reason).toBeNull();
    const [sale] = await recentSales(db);
    expect(sale?.syncState).toBe('attention');
    expect(sale?.rejectReason).toBe(fatal);
  });

  it('a refusal that later succeeds completes normally', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const transport = new MockTransport().script(refuses(key, REASON));

    await drainOutbox(db, transport);
    await drainOutbox(db, transport); // default script: applied

    const marks = await marksOf(db, key);
    expect(marks.server_ack_at).not.toBeNull();
    expect((await readOutboxQueue(db)).pendingCount).toBe(0);
    expect((await recentSales(db))[0]?.syncState).toBe('synced');
  });
});

// ---------------------------------------------------------------------------
// the clock resync 03 §3.4.1 promises
// ---------------------------------------------------------------------------

/**
 * `claimed_hlc` is stamped once, at enqueue, and never touched again — so a
 * write that sits queued long enough (offline for "hours or days", CLAUDE.md
 * §2.2) will inevitably age past the server's ±24h skew tolerance no matter
 * how correct the device's clock is when it finally gets a signal. The
 * server refuses it `CONFLICT: CLOCK_RESYNC_REQUIRED` and expects the client
 * to resynchronise and retry the identical mutation (03 §3.4.1) — this is
 * the client half of that sentence.
 */
describe('a clock-resync refusal', () => {
  const SKEW_REASON =
    'CONFLICT: CLOCK_RESYNC_REQUIRED: device clock skew exceeds ±24h — resync and retry (03 §3.4.1)';

  function claimedHlcOf(db: LocalDb, id: string): Promise<string | null> {
    return db
      .getAll('SELECT claimed_hlc FROM outbox WHERE id = ?', [id])
      .then((rows) => (rows[0]?.['claimed_hlc'] === null ? null : String(rows[0]?.['claimed_hlc'])));
  }

  function refuses(key: string, reason: string): UploadResult {
    return { ok: true, status: 200, acks: [{ key, status: 'rejected', reason }] };
  }

  it('refreshes the claim, keeping the same device node under a different value', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const original = await claimedHlcOf(db, key);
    const transport = new MockTransport().script(refuses(key, SKEW_REASON));

    await drainOutbox(db, transport);

    const refreshed = await claimedHlcOf(db, key);
    expect(refreshed).not.toBeNull();
    expect(refreshed).not.toBe(original);
    expect(CLAIMED_HLC_RE.test(refreshed ?? '')).toBe(true);
    expect(deviceNodeFromClaimedHlc(refreshed ?? '')).toBe(deviceNodeFromClaimedHlc(original ?? ''));
  });

  it('settles identically to any other retryable refusal — still pending, still queued', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const transport = new MockTransport().script(refuses(key, SKEW_REASON));

    const report = await drainOutbox(db, transport);

    expect(report).toMatchObject({ completed: 0, rejected: 0, deferred: 1 });
    const marks = await marksOf(db, key);
    expect(marks.server_ack_at).toBeNull();
    expect(marks.rejected_at).toBeNull();
    expect(marks.last_refusal_reason).toBe(SKEW_REASON);
    expect((await readPendingOps(db)).map((o) => o.id)).toEqual([key]);
  });

  it('resends the REFRESHED value on the next drain pass', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const original = await claimedHlcOf(db, key);
    const transport = new MockTransport().script(refuses(key, SKEW_REASON));

    await drainOutbox(db, transport); // refused, refreshed
    await drainOutbox(db, transport); // default script: applied

    expect(transport.batches).toHaveLength(2);
    const sentSecondTime = transport.batches[1]?.[0]?.claimedHlc;
    expect(sentSecondTime).not.toBe(original);
    expect((await marksOf(db, key)).server_ack_at).not.toBeNull();
  });

  it('does NOT touch the claim for an unrelated retryable conflict', async () => {
    // The marker match must be exact to this one reason — nothing here should
    // go rewriting a device's clock claim over an ordinary "try again".
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const original = await claimedHlcOf(db, key);
    const transport = new MockTransport().script(
      refuses(key, 'CONFLICT: RETRY_LATER — first writer committing'),
    );

    await drainOutbox(db, transport);

    expect(await claimedHlcOf(db, key)).toBe(original);
  });

  it('does NOT touch the claim for a definitive rejection — it is dead-lettered, not retried', async () => {
    const db = openTestDb();
    const key = await enqueue(db, { createdAt: T1 });
    const original = await claimedHlcOf(db, key);
    const transport = new MockTransport().script(refuses(key, 'BAD_REQUEST: lines must not be empty'));

    await drainOutbox(db, transport);

    expect(await claimedHlcOf(db, key)).toBe(original);
    expect((await marksOf(db, key)).rejected_at).not.toBeNull();
  });
});
