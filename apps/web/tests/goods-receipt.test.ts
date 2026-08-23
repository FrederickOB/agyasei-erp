/**
 * The yard's write path: a goods receipt recorded with the radio off, drained
 * when it comes back, and refused visibly when the office says no.
 *
 * This is the same test shape `stock-adjust.test.ts` uses, for the same
 * reason: recording is the whole point, and every rule below is one somebody
 * could quietly break while the suite stayed green.
 *
 *  · **Nothing awaits a socket.** The write completes locally with no
 *    transport in sight, because the truck is at the gate whether or not the
 *    tower is up.
 *  · **The key is the caller's.** Minted when the form opens, so a double-tap
 *    is one receipt. A second write under the same key is refused here and,
 *    authoritatively, by `app.write_log` at ingest.
 *  · **Completion is the server's ack.** The row is `pending` until the server
 *    answers for ITS key, and a definitive rejection becomes visible work.
 *  · **Two quantities, one signature.** `confirmConversion` is set when — and
 *    only when — the counted figure differs from what the conversion says,
 *    computed with the SAME expression the server runs. Sending it always
 *    would make every line look signed for; never sending it would make the
 *    server refuse the honest ones.
 *  · **Short and over are recorded, not refused.** Neither produces an error
 *    anywhere on this path.
 */
import { describe, expect, it } from 'vitest';
import { recordGoodsReceiptInput } from '@erp/contracts';
import {
  DuplicateReceiptError,
  EmptyReceiptError,
  RECEIPT_OUTBOX_KIND,
  buildReceiptPayload,
  recordGoodsReceipt,
  varianceOf,
} from '../src/data/mutations/recordGoodsReceipt';
import { recentReceipts } from '../src/data/queries/procurement-outbox';
import {
  loadPurchasableProducts,
  loadPurchaseUnits,
  toStockQty,
  withinTolerance,
} from '../src/data/queries/purchase-units';
import { drainOutbox, readPendingOps, type UploadTransport } from '../src/data/sync/upload';
import { WIRE_KINDS } from '../src/data/sync/transport';
import type { LocalDb } from '../src/data/db';
import { fixedHlc, provisionDevice, seedProduct, seedPurchaseUnit } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const PRODUCT = '018f3a1e-0000-7000-8000-0000000000c1';
const SUPPLIER = '018f3a1e-0000-7000-8000-0000000000d1';
const RECEIPT = '018f3a1e-0000-7000-8000-0000000000e1';
const NOW = '2026-08-22T09:00:00.000Z';

/**
 * A yard that stocks a product in sacks and buys it by the tonne — the
 * conversion problem 04 §4.10 names, in the buying direction. Twenty sacks to
 * the tonne, and the tonne is priced to three decimals.
 */
async function yard(): Promise<{ db: LocalDb; tonneUomId: string }> {
  const db = openTestDb();
  const device = await provisionDevice(db, { locationId: LOC, locationCode: 'OUT-01' });
  await seedProduct(db, {
    id: PRODUCT,
    code: 'SKU-1',
    name: 'Binder 50kg',
    uomLabel: 'SACK',
    qtyScale: 0,
    unitPriceE4: 620_000_000n,
    priceListId: device.priceListId,
  });
  const tonneUomId = await seedPurchaseUnit(db, {
    productId: PRODUCT,
    code: 'TONNE',
    qtyScale: 3,
    factorNum: 20n,
    factorDen: 1n,
    // One sack of slack on a twenty-sack tonne.
    toleranceBp: 500n,
  });
  return { db, tonneUomId };
}

async function unitFor(db: LocalDb, uomId: string) {
  const units = await loadPurchaseUnits(db, PRODUCT);
  const unit = units.find((u) => u.uomId === uomId);
  if (unit === undefined) throw new Error('the device does not hold that buying unit');
  return unit;
}

function acking(status: 'applied' | 'rejected', reason?: string): UploadTransport {
  return {
    send: (ops) =>
      Promise.resolve({
        ok: true,
        status: 200,
        acks: ops.map((op) => ({
          key: op.idempotencyKey,
          status,
          ...(reason === undefined ? {} : { reason }),
        })),
      }),
  };
}

const DEAD: UploadTransport = {
  send: () => Promise.reject(new Error('network unreachable')),
};

// ---------------------------------------------------------------------------

describe('the buying unit comes from the device’s own rows', () => {
  it('reads the conversion, the scales and the tolerance out of product_uom', async () => {
    const { db, tonneUomId } = await yard();
    const units = await loadPurchaseUnits(db, PRODUCT);
    const tonne = units.find((u) => u.uomId === tonneUomId)!;
    expect(tonne.factorNum).toBe(20n);
    expect(tonne.factorDen).toBe(1n);
    expect(tonne.buyScale).toBe(3);
    expect(tonne.stockScale).toBe(0);
    expect(tonne.stockingUomCode).toBe('SACK');
    expect(tonne.toleranceBp).toBe(500n);
  });

  it('offers only products that can actually be bought', async () => {
    const { db } = await yard();
    const products = await loadPurchasableProducts(db);
    expect(products.map((p) => p.id)).toContain(PRODUCT);
  });

  it('converts with the same expression the server runs', async () => {
    const { db, tonneUomId } = await yard();
    const tonne = await unitFor(db, tonneUomId);
    // 2.5 tonnes at scale 3 is 2500; twenty sacks to the tonne is 50 sacks.
    expect(toStockQty(2500n, tonne)).toBe(50n);
    // 0.125 tonnes is two and a half sacks, which rounds half-up to 3 — once,
    // at the stocking scale, exactly as 04 §4.13 row 1 says.
    expect(toStockQty(125n, tonne)).toBe(3n);
  });

  it('measures tolerance by cross-multiplication, never by dividing first', async () => {
    const { db, tonneUomId } = await yard();
    const tonne = await unitFor(db, tonneUomId);
    // 500bp of 20 sacks is exactly one sack: 21 is inside, 22 is not.
    expect(withinTolerance(21n, 20n, tonne.toleranceBp)).toBe(true);
    expect(withinTolerance(22n, 20n, tonne.toleranceBp)).toBe(false);
  });
});

describe('the payload the yard queues satisfies the shared contract', () => {
  it('parses against the same declaration the API parses with', async () => {
    const { db, tonneUomId } = await yard();
    const unit = await unitFor(db, tonneUomId);
    const built = buildReceiptPayload({
      goodsReceiptId: RECEIPT,
      locationId: LOC,
      supplierId: SUPPLIER,
      businessDate: '2026-08-22',
      lines: [{ productId: PRODUCT, unit, qtyReceived: 2500n, unitCostE4: 9_000_000_000n }],
      createdAt: NOW,
    });
    // The BYTES, not the object: what the transport ships is what the server
    // parses.
    const parsed = recordGoodsReceiptInput.safeParse(JSON.parse(built.payloadJson));
    expect(parsed.success).toBe(true);
    // Money and quantities cross as decimal STRINGS of scaled units.
    expect(built.payload.lines[0]!.qtyReceived).toBe('2500');
    expect(built.payload.lines[0]!.qtyStock).toBe('50');
    expect(built.payload.lines[0]!.unitCostE4).toBe('9000000000');
  });

  it('numbers the lines itself, so two lines can never share a number', async () => {
    const { db, tonneUomId } = await yard();
    const unit = await unitFor(db, tonneUomId);
    const built = buildReceiptPayload({
      goodsReceiptId: RECEIPT,
      locationId: LOC,
      supplierId: SUPPLIER,
      businessDate: '2026-08-22',
      lines: [
        { productId: PRODUCT, unit, qtyReceived: 1000n, unitCostE4: 1n },
        { productId: PRODUCT, unit, qtyReceived: 2000n, unitCostE4: 1n },
      ],
      createdAt: NOW,
    });
    expect(built.payload.lines.map((l) => l.lineNo)).toEqual([1, 2]);
  });

  it('refuses a receipt for nothing', async () => {
    expect(() =>
      buildReceiptPayload({
        goodsReceiptId: RECEIPT,
        locationId: LOC,
        supplierId: SUPPLIER,
        businessDate: '2026-08-22',
        lines: [],
        createdAt: NOW,
      }),
    ).toThrow(EmptyReceiptError);
  });
});

describe('two quantities, and a signature only where they disagree', () => {
  it('sends no confirmation when the yard accepts the conversion', async () => {
    const { db, tonneUomId } = await yard();
    const unit = await unitFor(db, tonneUomId);
    const built = buildReceiptPayload({
      goodsReceiptId: RECEIPT,
      locationId: LOC,
      supplierId: SUPPLIER,
      businessDate: '2026-08-22',
      // Counted exactly what the conversion says.
      lines: [{ productId: PRODUCT, unit, qtyReceived: 2500n, qtyStock: 50n, unitCostE4: 1n }],
      createdAt: NOW,
    });
    expect(built.payload.lines[0]!.confirmConversion).toBeUndefined();
    expect(built.confirmedLineNos).toEqual([]);
  });

  it('sends one when the count differs — the server refuses the line otherwise', async () => {
    const { db, tonneUomId } = await yard();
    const unit = await unitFor(db, tonneUomId);
    const built = buildReceiptPayload({
      goodsReceiptId: RECEIPT,
      locationId: LOC,
      supplierId: SUPPLIER,
      businessDate: '2026-08-22',
      // The note says 2.5 tonnes; 48 sacks came off the truck.
      lines: [{ productId: PRODUCT, unit, qtyReceived: 2500n, qtyStock: 48n, unitCostE4: 1n }],
      createdAt: NOW,
    });
    expect(built.payload.lines[0]!.confirmConversion).toBe(true);
    expect(built.confirmedLineNos).toEqual([1]);
    // BOTH figures are on the wire. Neither is derived from the other, because
    // what was invoiced and what entered the yard are two facts.
    expect(built.payload.lines[0]!.qtyReceived).toBe('2500');
    expect(built.payload.lines[0]!.qtyStock).toBe('48');
  });
});

describe('short and over are recorded, never refused', () => {
  it('names the variance without turning it into an error', () => {
    expect(varianceOf(3000n, 3000n)).toBe('MATCHED');
    expect(varianceOf(2500n, 3000n)).toBe('SHORT');
    expect(varianceOf(3500n, 3000n)).toBe('OVER');
    expect(varianceOf(3000n, null)).toBe('NO_ORDER');
  });

  it('queues a short delivery with no complaint at all', async () => {
    const { db, tonneUomId } = await yard();
    const unit = await unitFor(db, tonneUomId);
    const result = await recordGoodsReceipt(db, {
      goodsReceiptId: RECEIPT,
      supplierId: SUPPLIER,
      purchaseOrderId: '018f3a1e-0000-7000-8000-0000000000f1',
      lines: [
        {
          purchaseOrderLineId: '018f3a1e-0000-7000-8000-0000000000f2',
          productId: PRODUCT,
          unit,
          // Half a tonne short of the three that were outstanding.
          qtyReceived: 2500n,
          unitCostE4: 9_000_000_000n,
        },
      ],
      hlc: fixedHlc(),
      nowIso: NOW,
    });
    expect(result.lineCount).toBe(1);
    const queued = await recentReceipts(db);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.syncState).toBe('pending');
    expect(queued[0]!.lines[0]!.qtyReceived).toBe(2500n);
    expect(queued[0]!.lines[0]!.qtyStock).toBe(50n);
  });
});

describe('with the radio off', () => {
  it('records locally with nothing awaiting a socket, then drains on reconnect', async () => {
    const { db, tonneUomId } = await yard();
    const unit = await unitFor(db, tonneUomId);

    await recordGoodsReceipt(db, {
      goodsReceiptId: RECEIPT,
      supplierId: SUPPLIER,
      lines: [{ productId: PRODUCT, unit, qtyReceived: 2500n, unitCostE4: 1n }],
      hlc: fixedHlc(),
      nowIso: NOW,
    });

    // It is in the queue under its own kind, and that kind maps to the wire
    // discriminator the server dispatches.
    const pending = await readPendingOps(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe(RECEIPT_OUTBOX_KIND);
    expect(WIRE_KINDS[RECEIPT_OUTBOX_KIND]).toBe('goods.record_receipt');
    expect(pending[0]!.idempotencyKey).toBe(RECEIPT);

    // A drain with the radio genuinely dead completes NOTHING and loses
    // nothing: a dead link is not a refusal.
    const partitioned = await drainOutbox(db, DEAD);
    expect(partitioned.completed).toBe(0);
    expect(partitioned.rejected).toBe(0);
    expect(partitioned.deferred).toBe(1);
    expect((await recentReceipts(db))[0]!.syncState).toBe('pending');

    // Reconnected, it drains and becomes Saved — on the server's ack for its
    // own key, and on nothing else.
    const drained = await drainOutbox(db, acking('applied'));
    expect(drained.completed).toBe(1);
    expect((await recentReceipts(db))[0]!.syncState).toBe('synced');
    expect(await readPendingOps(db)).toHaveLength(0);
  });

  it('refuses a second receipt under the same key rather than queueing two', async () => {
    const { db, tonneUomId } = await yard();
    const unit = await unitFor(db, tonneUomId);
    const line = { productId: PRODUCT, unit, qtyReceived: 1000n, unitCostE4: 1n };
    await recordGoodsReceipt(db, {
      goodsReceiptId: RECEIPT,
      supplierId: SUPPLIER,
      lines: [line],
      hlc: fixedHlc(),
      nowIso: NOW,
    });
    await expect(
      recordGoodsReceipt(db, {
        goodsReceiptId: RECEIPT,
        supplierId: SUPPLIER,
        lines: [line],
        hlc: fixedHlc(),
        nowIso: NOW,
      }),
    ).rejects.toBeInstanceOf(DuplicateReceiptError);
    expect(await recentReceipts(db)).toHaveLength(1);
  });
});

describe('a refused receipt is visible work', () => {
  it('keeps the row, marks it for attention and carries the server’s own words', async () => {
    const { db, tonneUomId } = await yard();
    const unit = await unitFor(db, tonneUomId);
    await recordGoodsReceipt(db, {
      goodsReceiptId: RECEIPT,
      supplierId: SUPPLIER,
      lines: [{ productId: PRODUCT, unit, qtyReceived: 1000n, unitCostE4: 1n }],
      hlc: fixedHlc(),
      nowIso: NOW,
    });

    const report = await drainOutbox(
      db,
      acking('rejected', 'BAD_REQUEST: receipt line numbers must be distinct'),
    );
    expect(report.rejected).toBe(1);

    const queued = await recentReceipts(db);
    // The goods are in the yard and the office does not know. The row stays,
    // named, with the reason on it — never a toast that disappears.
    expect(queued).toHaveLength(1);
    expect(queued[0]!.syncState).toBe('attention');
    expect(queued[0]!.rejectReason).toMatch(/BAD_REQUEST/);
  });

  it('leaves a retryable refusal pending rather than discarding a real delivery', async () => {
    const { db, tonneUomId } = await yard();
    const unit = await unitFor(db, tonneUomId);
    await recordGoodsReceipt(db, {
      goodsReceiptId: RECEIPT,
      supplierId: SUPPLIER,
      lines: [{ productId: PRODUCT, unit, qtyReceived: 1000n, unitCostE4: 1n }],
      hlc: fixedHlc(),
      nowIso: NOW,
    });
    // The order was cancelled behind the yard's back while it was offline.
    // Wrongly dead-lettering this would discard a delivery that physically
    // happened; wrongly retrying it is merely loud (§3.3.4).
    const report = await drainOutbox(
      db,
      acking('rejected', 'PRECONDITION_FAILED: purchase order is CANCELLED'),
    );
    expect(report.rejected).toBe(0);
    expect(report.deferred).toBe(1);
    expect((await recentReceipts(db))[0]!.syncState).toBe('pending');
  });
});
