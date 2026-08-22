/**
 * The stock-adjustment WRITE path — CLAUDE.md §2.7 category 2 (sync logic)
 * and, because a movement is a scaled-integer magnitude, category 1 as well.
 *
 * What these tests are actually about:
 *
 *  1. **It works with no network, and it completes only on the server's ack.**
 *     That is the whole reason an adjustment goes through the outbox rather
 *     than the tRPC mutation path the reorder threshold uses. Twenty bags
 *     broke in the yard whether or not the tower is up.
 *  2. **A rejected adjustment is visible work, never a silent drop.** The
 *     stock moved in the yard and the ledger does not know; the row stays on
 *     the device, named, with the server's own sentence on it.
 *  3. **Four permanent server refusals would WEDGE the queue rather than
 *     dead-letter**, because `classifyRejection` treats anything it does not
 *     recognise as retryable — deliberately, since wrongly discarding a write
 *     is the loss path. So this builder must make all four unreachable, and
 *     each one has a test here.
 *  4. **The bytes are the ones the server parses.** Proved against
 *     `contractFor(kind)` — the registry both sides import — rather than
 *     against a payload shaped by this test, which is precisely how every sale
 *     this PWA uploaded came to be a BAD_REQUEST that no green suite noticed.
 */
import { describe, expect, it } from 'vitest';
import { contractFor, type DeviceOpKind } from '@erp/contracts';
import type { LocalDb } from '../src/data/db';
import {
  ADJUSTMENT_OUTBOX_KIND,
  buildMovementPayload,
  DuplicateAdjustmentError,
  MovementDirectionError,
  MOVEMENT_DIRECTION,
  recordAdjustment,
  ReasonCodeRequiredError,
  signPermitted,
  ZeroQuantityError,
  AdjustmentContextIncompleteError,
  ADJUSTMENT_KINDS,
} from '../src/data/mutations/adjustStock';
import { recentAdjustments } from '../src/data/queries/adjustments';
import { loadStockedProducts } from '../src/data/queries/products';
import { loadMovementReasons } from '../src/data/queries/movement-reasons';
import { readOutboxQueue } from '../src/data/queries/sales';
import { drainOutbox, type PendingOp, type UploadResult, type UploadTransport } from '../src/data/sync/upload';
import { wireKind } from '../src/data/sync/transport';
import { fixedHlc, provisionDevice, seedMovementReason, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';
import { uuidv7 } from '../src/lib/uuidv7';

const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const hlc = fixedHlc();

interface Yard {
  readonly db: LocalDb;
  readonly productId: string;
}

async function yard(options: { readonly qtyScale?: number } = {}): Promise<Yard> {
  const db = openTestDb();
  const device = await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
  const product = await seedProduct(db, {
    code: 'SKU-1',
    name: 'Cement 50kg',
    uomLabel: 'bag',
    ...(options.qtyScale === undefined ? {} : { qtyScale: options.qtyScale }),
    unitPriceE4: 620_000_000n,
    priceListId: device.priceListId,
  });
  await seedMovementReason(db, { code: 'DAMAGE', name: 'Damaged goods' });
  return { db, productId: product.id };
}

/** Scripted transport: no live service, exactly as the drain's own tests do. */
class MockTransport implements UploadTransport {
  readonly batches: PendingOp[][] = [];
  constructor(private readonly answer: (ops: readonly PendingOp[]) => UploadResult) {}
  send(ops: readonly PendingOp[]): Promise<UploadResult> {
    this.batches.push([...ops]);
    return Promise.resolve(this.answer(ops));
  }
}

function acks(status: 'applied' | 'duplicate' | 'rejected', reason?: string) {
  return (ops: readonly PendingOp[]): UploadResult => ({
    ok: true,
    status: 200,
    acks: ops.map((op) => ({
      key: op.idempotencyKey,
      status,
      ...(reason === undefined ? {} : { reason }),
    })),
  });
}

async function outboxRow(db: LocalDb, id: string): Promise<Record<string, unknown>> {
  const rows = await db.getAll('SELECT * FROM outbox WHERE id = ?', [id]);
  const row = rows[0];
  if (row === undefined) throw new Error(`no outbox row ${id}`);
  return row as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('an adjustment is recorded with the radio off', () => {
  it('queues locally, is pending, and nothing was sent', async () => {
    const { db, productId } = await yard();
    const id = uuidv7();

    const result = await recordAdjustment(db, {
      movementId: id,
      productId,
      qtyDelta: -20n,
      kind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      hlc,
      nowIso: '2026-08-22T09:12:00.000Z',
    });

    expect(result.locationId).toBe(LOC);
    expect(result.businessDate).toBe('2026-08-22');

    const row = await outboxRow(db, id);
    expect(row['kind']).toBe(ADJUSTMENT_OUTBOX_KIND);
    expect(row['server_ack_at']).toBeNull();
    expect(row['rejected_at']).toBeNull();

    const listed = await recentAdjustments(db);
    expect(listed.length).toBe(1);
    expect(listed[0]?.syncState).toBe('pending');
    expect(listed[0]?.qtyDelta).toBe(-20n);

    // And it is in the queue the status bar counts, beside any sales.
    expect((await readOutboxQueue(db)).pendingCount).toBe(1);
  });

  it('sends the bytes the server parses, under the registry’s own schema', async () => {
    const { db, productId } = await yard();
    const id = uuidv7();
    await recordAdjustment(db, {
      movementId: id,
      productId,
      qtyDelta: -20n,
      kind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      hlc,
      nowIso: '2026-08-22T09:12:00.000Z',
    });

    const row = await outboxRow(db, id);
    const kind = wireKind(String(row['kind']));
    expect(kind).toBe('stock.record_movement');

    // The SAME declaration apps/api parses with, reached through the registry
    // rather than named again here.
    const parsed = contractFor(kind as DeviceOpKind).safeParse(JSON.parse(String(row['payload'])));
    expect(parsed.success).toBe(true);

    const payload = JSON.parse(String(row['payload'])) as Record<string, unknown>;
    // A magnitude is a decimal STRING, never a JSON number (ADR-0004).
    expect(payload['qtyDelta']).toBe('-20');
    expect(typeof payload['qtyDelta']).toBe('string');
    // tenant_id comes from the verified token, server-side, in every spelling.
    expect(payload).not.toHaveProperty('tenantId');
    expect(payload).not.toHaveProperty('tenant_id');
  });

  it('refuses to record at all when the device cannot say where it is', async () => {
    const db = openTestDb();
    const product = await seedProduct(db, {
      code: 'SKU-1',
      name: 'Cement 50kg',
      uomLabel: 'bag',
      unitPriceE4: 1n,
    });
    await expect(
      recordAdjustment(db, {
        movementId: uuidv7(),
        productId: product.id,
        qtyDelta: -1n,
        kind: 'WRITE_OFF',
        reasonCode: 'DAMAGE',
        hlc,
      }),
    ).rejects.toBeInstanceOf(AdjustmentContextIncompleteError);
    expect((await readOutboxQueue(db)).pendingCount).toBe(0);
  });
});

describe('it completes only on the server’s own ack', () => {
  it('is Saved after an applied ack, and only then', async () => {
    const { db, productId } = await yard();
    const id = uuidv7();
    await recordAdjustment(db, {
      movementId: id,
      productId,
      qtyDelta: -20n,
      kind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      hlc,
    });
    expect((await recentAdjustments(db))[0]?.syncState).toBe('pending');

    const report = await drainOutbox(db, new MockTransport(acks('applied')));
    expect(report.completed).toBe(1);
    expect((await recentAdjustments(db))[0]?.syncState).toBe('synced');
  });

  it('stays pending when the transport never answers — never lost, never faked', async () => {
    const { db, productId } = await yard();
    await recordAdjustment(db, {
      movementId: uuidv7(),
      productId,
      qtyDelta: -20n,
      kind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      hlc,
    });

    const dead = new MockTransport(() => ({ ok: false, status: 0, acks: [] }));
    const report = await drainOutbox(db, dead);
    expect(report.completed).toBe(0);
    expect(report.deferred).toBe(1);
    expect((await recentAdjustments(db))[0]?.syncState).toBe('pending');

    // …and it drains on reconnect, without anyone re-entering it.
    await drainOutbox(db, new MockTransport(acks('applied')));
    expect((await recentAdjustments(db))[0]?.syncState).toBe('synced');
    expect((await readOutboxQueue(db)).pendingCount).toBe(0);
  });

  it('drains oldest-first, so a sale queued before an adjustment goes first', async () => {
    const { db, productId } = await yard();
    const saleId = uuidv7();
    await db.execute(
      `INSERT INTO outbox (id, idempotency_key, claimed_hlc, kind, payload, total_minor,
                           created_at, server_ack_at, rejected_at, reject_reason)
       VALUES (?, ?, ?, 'sale', '{}', CAST(? AS INTEGER), ?, NULL, NULL, NULL)`,
      [saleId, saleId, hlc.next(), '100', '2026-08-22T08:00:00.000Z'],
    );
    const adjustId = uuidv7();
    await recordAdjustment(db, {
      movementId: adjustId,
      productId,
      qtyDelta: -20n,
      kind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      hlc,
      nowIso: '2026-08-22T09:00:00.000Z',
    });

    const transport = new MockTransport(acks('applied'));
    await drainOutbox(db, transport);
    expect(transport.batches[0]?.map((op) => op.id)).toEqual([saleId, adjustId]);
  });
});

describe('a refused adjustment is work, not silence', () => {
  it('keeps the row, marks it for attention and preserves the server’s words', async () => {
    const { db, productId } = await yard();
    const id = uuidv7();
    await recordAdjustment(db, {
      movementId: id,
      productId,
      qtyDelta: -20n,
      kind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      hlc,
    });

    await drainOutbox(
      db,
      new MockTransport(acks('rejected', 'BAD_REQUEST: qty_delta must be non-zero')),
    );

    const listed = await recentAdjustments(db);
    expect(listed.length).toBe(1); // still here — a rejection never drops a write
    expect(listed[0]?.syncState).toBe('attention');
    expect(listed[0]?.rejectReason).toContain('BAD_REQUEST');
    // It has left the pending queue, so it is not retried for ever behind the
    // sales — it is in front of a human instead.
    expect((await readOutboxQueue(db)).pendingCount).toBe(0);
  });

  it('keeps retrying a rejection it cannot classify, rather than discarding a real movement', async () => {
    const { db, productId } = await yard();
    await recordAdjustment(db, {
      movementId: uuidv7(),
      productId,
      qtyDelta: -20n,
      kind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      hlc,
    });
    await drainOutbox(db, new MockTransport(acks('rejected', 'INTERNAL_SERVER_ERROR: boom')));
    expect((await recentAdjustments(db))[0]?.syncState).toBe('pending');
  });
});

describe('a reason is required — §3 lists it as part of the adjustment', () => {
  it('refuses to build a payload without one', () => {
    expect(() =>
      buildMovementPayload({
        movementId: uuidv7(),
        locationId: LOC,
        productId: uuidv7(),
        qtyDelta: -1n,
        kind: 'WRITE_OFF',
        reasonCode: '   ',
        businessDate: '2026-08-22',
        createdAt: '2026-08-22T09:00:00.000Z',
      }),
    ).toThrow(ReasonCodeRequiredError);
  });

  it('queues nothing when the reason is missing', async () => {
    const { db, productId } = await yard();
    await expect(
      recordAdjustment(db, {
        movementId: uuidv7(),
        productId,
        qtyDelta: -1n,
        kind: 'WRITE_OFF',
        reasonCode: '',
        hlc,
      }),
    ).rejects.toBeInstanceOf(ReasonCodeRequiredError);
    expect((await readOutboxQueue(db)).pendingCount).toBe(0);
  });

  it('offers only the tenant’s own reasons, from the tenant’s own rows', async () => {
    const { db } = await yard();
    await seedMovementReason(db, { code: 'THEFT', name: 'Theft / shrinkage' });
    const reasons = await loadMovementReasons(db);
    expect(reasons.map((r) => r.code).sort()).toEqual(['DAMAGE', 'THEFT']);
    // Rendered from the tenant's words, which the client never compares to a
    // literal — a tenant renaming this gets the new word with no deploy.
    expect(reasons.find((r) => r.code === 'DAMAGE')?.name).toBe('Damaged goods');
  });
});

describe('the sign rule, mirrored from the ledger’s own CHECK', () => {
  it('agrees with sm_sign for every kind this screen offers', () => {
    // Total over the offered union: a kind added without a direction does not
    // compile, and this asserts the directions are the ones the database has.
    expect(ADJUSTMENT_KINDS.map((k) => [k, MOVEMENT_DIRECTION[k]])).toEqual([
      ['CORRECTION', 'either'],
      ['WRITE_OFF', 'out'],
      ['RETURN_TO_SUPPLIER', 'out'],
      ['OPENING', 'in'],
    ]);
  });

  it('refuses an inflow on an outflow-only kind, before anything is queued', async () => {
    const { db, productId } = await yard();
    await expect(
      recordAdjustment(db, {
        movementId: uuidv7(),
        productId,
        qtyDelta: 20n, // a POSITIVE write-off — the CHECK would reject this
        kind: 'WRITE_OFF',
        reasonCode: 'DAMAGE',
        hlc,
      }),
    ).rejects.toBeInstanceOf(MovementDirectionError);
    // The point of catching it here: Postgres would answer INTERNAL_SERVER_ERROR,
    // which the drain classes RETRYABLE, so this op would sit at the head of an
    // ordered queue for ever and stop every sale behind it from draining.
    expect((await readOutboxQueue(db)).pendingCount).toBe(0);
  });

  it('refuses an outflow on an inflow-only kind', () => {
    expect(signPermitted('OPENING', -1n)).toBe(false);
    expect(signPermitted('OPENING', 1n)).toBe(true);
  });

  it('lets a correction go either way, because the ledger does', () => {
    expect(signPermitted('CORRECTION', -5n)).toBe(true);
    expect(signPermitted('CORRECTION', 5n)).toBe(true);
  });

  it('refuses zero in every direction', async () => {
    const { db, productId } = await yard();
    expect(signPermitted('CORRECTION', 0n)).toBe(false);
    await expect(
      recordAdjustment(db, {
        movementId: uuidv7(),
        productId,
        qtyDelta: 0n,
        kind: 'CORRECTION',
        reasonCode: 'DAMAGE',
        hlc,
      }),
    ).rejects.toBeInstanceOf(ZeroQuantityError);
  });
});

describe('the key is the movement, so a double-tap is one movement', () => {
  it('refuses the second write under the same key and leaves one row', async () => {
    const { db, productId } = await yard();
    const id = uuidv7();
    const once = {
      movementId: id,
      productId,
      qtyDelta: -20n,
      kind: 'WRITE_OFF' as const,
      reasonCode: 'DAMAGE',
      hlc,
    };
    await recordAdjustment(db, once);
    await expect(recordAdjustment(db, once)).rejects.toBeInstanceOf(DuplicateAdjustmentError);
    expect((await recentAdjustments(db)).length).toBe(1);
  });

  it('is a duplicate ack, not a second movement, if the server sees it twice', async () => {
    const { db, productId } = await yard();
    await recordAdjustment(db, {
      movementId: uuidv7(),
      productId,
      qtyDelta: -20n,
      kind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      hlc,
    });
    const report = await drainOutbox(db, new MockTransport(acks('duplicate')));
    expect(report.completed).toBe(1);
    expect((await recentAdjustments(db))[0]?.syncState).toBe('synced');
  });
});

describe('quantities are scaled integers in the STOCKING unit', () => {
  it('carries the exact scaled magnitude, with no float anywhere near it', async () => {
    const { db, productId } = await yard({ qtyScale: 3 });
    const id = uuidv7();
    // 2.500 tonnes at scale 3, going out.
    await recordAdjustment(db, {
      movementId: id,
      productId,
      qtyDelta: -2500n,
      kind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      hlc,
    });
    const payload = JSON.parse(String((await outboxRow(db, id))['payload'])) as Record<string, unknown>;
    expect(payload['qtyDelta']).toBe('-2500');
    expect((await recentAdjustments(db))[0]?.qtyDelta).toBe(-2500n);
  });

  it('offers only stock-tracked products, in their stocking unit', async () => {
    const { db } = await yard();
    await seedProduct(db, {
      code: 'SVC-1',
      name: 'Delivery service',
      uomLabel: 'each',
      unitPriceE4: 1n,
      stockTracking: 'NON_STOCKED',
    });
    const products = await loadStockedProducts(db);
    // The server answers PRECONDITION_FAILED for a non-stocked product, and
    // that refusal is RETRYABLE — so it must never be offered.
    expect(products.map((p) => p.code)).toEqual(['SKU-1']);
    expect(products[0]?.uomLabel).toBe('bag');
  });
});
