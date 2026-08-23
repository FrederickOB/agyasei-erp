/**
 * CLAUDE.md §2.7 category 2 — the outbox's QUEUE ORDER is sync logic.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TIE, PINNED ON PURPOSE
 * ═══════════════════════════════════════════════════════════════════════════
 * The drain used to order by `(created_at, id)`. `created_at` is an ISO
 * instant at MILLISECOND resolution and `id` is a `uuidv7`, which carries no
 * intra-millisecond counter — so two ops queued in the same millisecond tied
 * on the first key and were separated at RANDOM by the second. D11 saw it
 * live as `PLANNED -> DELIVERED is not a legal delivery transition`.
 *
 * Every test below PINS the instant so the tie happens on every run, and
 * chooses ids that sort in the WRONG direction, so a regression to the old
 * key fails here deterministically rather than one run in two. The first
 * assertion in each case is that the tie is real — same `created_at`, ids in
 * reverse order — because a test that silently stopped tying would go green
 * for the wrong reason.
 *
 * `queue_seq` (`src/data/sync/queue-seq.ts`) is the fix: a strictly increasing
 * integer stamped inside the same local transaction as the insert. Note the
 * second case, which is why a monotonic uuidv7 would NOT have been enough — a
 * sale's id is minted when its CART opened, long before it is queued.
 */
import { describe, expect, it } from 'vitest';
import type { LocalDb } from '../src/data/db';
import { addProductToCart, createCart } from '../src/data/mutations/cart';
import { checkout } from '../src/data/mutations/checkout';
import {
  DELIVERY_STATUS_OUTBOX_KIND,
  recordDeliveryStatus,
} from '../src/data/mutations/updateDeliveryStatus';
import { pendingDeliveryStatuses } from '../src/data/queries/procurement-outbox';
import { SEQUENCE_REPORT_OP_KIND, enqueueBlockReport } from '../src/data/sequence';
import { nextQueueSeq } from '../src/data/sync/queue-seq';
import { readPendingOps } from '../src/data/sync/upload';
import { fixedHlc, provisionDevice, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

/** One millisecond, shared by every op in a case. The tie itself. */
const SAME_MS = '2026-08-22T10:15:30.000Z';

const DELIVERY = '018f3a1e-0000-7000-8000-0000000000d1';

/**
 * Two valid v7 uuids in a KNOWN order. `LATER_ID` is lexically greater, so an
 * op given `LATER_ID` first and `EARLIER_ID` second is queued in the opposite
 * order to the one `(created_at, id)` would produce.
 */
const EARLIER_ID = '018f0000-0000-7000-8000-000000000001';
const LATER_ID = '01900000-0000-7000-8000-0000000000ff';

async function createdAtsOf(db: LocalDb): Promise<string[]> {
  const rows = await db.getAll('SELECT created_at FROM outbox ORDER BY queue_seq');
  return rows.map((r) => String(r['created_at']));
}

async function seqOf(db: LocalDb, id: string): Promise<number> {
  const rows = await db.getAll('SELECT CAST(queue_seq AS TEXT) AS q FROM outbox WHERE id = ?', [id]);
  const raw = rows[0]?.['q'];
  if (raw === null || raw === undefined) throw new Error(`no queue_seq for ${id}`);
  return Number(raw);
}

describe('two ops queued in the same millisecond drain in the order they were queued', () => {
  it('sends the earlier status move first even when its id sorts last', async () => {
    const db = openTestDb();
    const hlc = fixedHlc();

    // PLANNED -> DISPATCHED, then DISPATCHED -> DELIVERED. The second move is
    // only legal after the first, and it is queued second.
    await recordDeliveryStatus(db, {
      updateId: LATER_ID,
      deliveryId: DELIVERY,
      fromStatus: 'PLANNED',
      toStatus: 'DISPATCHED',
      hlc,
      nowIso: SAME_MS,
    });
    await recordDeliveryStatus(db, {
      updateId: EARLIER_ID,
      deliveryId: DELIVERY,
      fromStatus: 'DISPATCHED',
      toStatus: 'DELIVERED',
      hlc,
      nowIso: SAME_MS,
    });

    // THE TIE IS REAL: identical instants, and the ids run backwards.
    const stamps = await createdAtsOf(db);
    expect(stamps).toEqual([SAME_MS, SAME_MS]);
    expect(EARLIER_ID < LATER_ID).toBe(true);

    const ops = await readPendingOps(db);
    expect(ops.map((o) => o.id)).toEqual([LATER_ID, EARLIER_ID]);

    // Said the other way, because this is the failure that was observed: the
    // move OFF PLANNED reaches the server before the move onto DELIVERED.
    const statuses = ops.map((o) => (JSON.parse(o.payloadJson) as { toStatus: string }).toStatus);
    expect(statuses).toEqual(['DISPATCHED', 'DELIVERED']);
  });

  it('keeps the cursor report ahead of a sale whose id was minted before it', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // WHY A MONOTONIC uuidv7 WOULD NOT HAVE FIXED THIS ONE.
    // The sale's outbox id IS its cart id, minted when the cart was opened —
    // here, long before either op was queued. A counter inside the uuid orders
    // ids by MINT time, and mint time is not enqueue time, so the report would
    // still lose. `queue_seq` is stamped at enqueue, so it cannot.
    // ═══════════════════════════════════════════════════════════════════════
    const db = openTestDb();
    const device = await provisionDevice(db);
    const product = await seedProduct(db, {
      code: 'BAG-1',
      name: 'Bagged product',
      unitPriceE4: 620000000n,
      priceListId: device.priceListId,
    });

    // The cart is opened first — its id is the OLDER of the two.
    await createCart(db, { id: EARLIER_ID });
    await addProductToCart(db, EARLIER_ID, product);

    // The report is queued FIRST, at the same millisecond the sale is rung.
    await enqueueBlockReport(db, {
      locationId: device.locationId,
      claimedHlc: fixedHlc().next(),
      nowIso: SAME_MS,
      newId: () => LATER_ID,
    });
    await checkout(db, {
      cartId: EARLIER_ID,
      tenderedMinor: 10_000_000n,
      hlc: fixedHlc(),
      nowIso: SAME_MS,
    });

    const stamps = await createdAtsOf(db);
    expect(stamps).toEqual([SAME_MS, SAME_MS]);

    const ops = await readPendingOps(db);
    expect(ops.map((o) => o.kind)).toEqual([SEQUENCE_REPORT_OP_KIND, 'sale']);
    expect(ops.map((o) => o.id)).toEqual([LATER_ID, EARLIER_ID]);
  });

  it('resolves "the last move this device queued" by enqueue order, not by id', async () => {
    const db = openTestDb();
    const hlc = fixedHlc();
    await recordDeliveryStatus(db, {
      updateId: LATER_ID,
      deliveryId: DELIVERY,
      fromStatus: 'PLANNED',
      toStatus: 'DISPATCHED',
      hlc,
      nowIso: SAME_MS,
    });
    await recordDeliveryStatus(db, {
      updateId: EARLIER_ID,
      deliveryId: DELIVERY,
      fromStatus: 'DISPATCHED',
      toStatus: 'DELIVERED',
      hlc,
      nowIso: SAME_MS,
    });

    // The screen labels the row with the status the server will END on. On the
    // old key this was a coin flip between DISPATCHED and DELIVERED — and the
    // wrong one is how the same move gets recorded twice.
    const pending = await pendingDeliveryStatuses(db);
    expect(pending.get(DELIVERY)?.toStatus).toBe('DELIVERED');
    expect(pending.get(DELIVERY)?.id).toBe(EARLIER_ID);
  });
});

describe('the queue position itself', () => {
  it('is strictly increasing across kinds and never reused', async () => {
    const db = openTestDb();
    const hlc = fixedHlc();
    const ids = [
      '01900000-0000-7000-8000-00000000000a',
      '01900000-0000-7000-8000-00000000000b',
      '01900000-0000-7000-8000-00000000000c',
    ];
    let from = 'PLANNED';
    const moves = ['DISPATCHED', 'DELIVERED', 'FAILED'] as const;
    for (const [i, id] of ids.entries()) {
      await recordDeliveryStatus(db, {
        updateId: id,
        deliveryId: DELIVERY,
        fromStatus: from,
        toStatus: moves[i]!,
        reason: 'reason enough',
        hlc,
        nowIso: SAME_MS,
      });
      from = moves[i]!;
    }
    const seqs = await Promise.all(ids.map((id) => seqOf(db, id)));
    expect(seqs).toEqual([1, 2, 3]);

    // The next one continues from the top of the whole table, so a position is
    // never handed out twice — the outbox is append-only and nothing purges it.
    expect(await db.writeTransaction((tx) => nextQueueSeq(tx))).toBe(4);
  });

  it('refuses to hand the same position to two rows', async () => {
    const db = openTestDb();
    await db.execute(
      `INSERT INTO outbox (id, idempotency_key, kind, payload, created_at, queue_seq)
       VALUES ('a', 'a', 'sale', '{}', ?, 7)`,
      [SAME_MS],
    );
    await expect(
      db.execute(
        `INSERT INTO outbox (id, idempotency_key, kind, payload, created_at, queue_seq)
         VALUES ('b', 'b', 'sale', '{}', ?, 7)`,
        [SAME_MS],
      ),
    ).rejects.toThrow();
  });

  it('drains rows written before the column existed first, in the old order', async () => {
    // A device that updates with ops already pending. Those rows were queued
    // before every row that has a position, so they go first — an upgrade must
    // not reshuffle a queue that is mid-flight.
    const db = openTestDb();
    for (const [id, at] of [
      ['legacy-2', '2026-08-22T10:15:31.000Z'],
      ['legacy-1', '2026-08-22T10:15:30.000Z'],
    ] as const) {
      await db.execute(
        `INSERT INTO outbox (id, idempotency_key, kind, payload, created_at, queue_seq)
         VALUES (?, ?, ?, '{}', ?, NULL)`,
        [id, id, DELIVERY_STATUS_OUTBOX_KIND, at],
      );
    }
    await recordDeliveryStatus(db, {
      updateId: EARLIER_ID,
      deliveryId: DELIVERY,
      fromStatus: 'PLANNED',
      toStatus: 'DISPATCHED',
      hlc: fixedHlc(),
      nowIso: SAME_MS,
    });

    const ops = await readPendingOps(db);
    expect(ops.map((o) => o.id)).toEqual(['legacy-1', 'legacy-2', EARLIER_ID]);
    // And the first position handed out is 1: legacy rows hold none.
    expect(await seqOf(db, EARLIER_ID)).toBe(1);
  });
});
