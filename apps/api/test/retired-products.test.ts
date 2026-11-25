/**
 * A PRODUCT TAKEN OFF AFTER A DEVICE USED IT (src/retired-product.ts), and
 * the switch that takes one off (`products.setSellable`).
 *
 * The case: a tablet rings up, adjusts or receives a product as ITS copy of
 * the catalogue had it; the office switches the product off or removes it;
 * the tablet's record reaches the server afterwards. Before this, the server
 * refused that record (NOT_FOUND / PRECONDITION_FAILED), the upload classifier
 * rightly kept it as retryable, and the outlet's outbox never drained.
 *
 * What must hold (CLAUDE.md §2.2, §2.7 — money and sync):
 *  - the record LANDS, exactly once, priced at what was in force when the
 *    product was taken off — never a price superseded before that;
 *  - a person is told, in the same transaction (one review per record);
 *  - a product this tenant never held is still refused — dropping the
 *    `deleted_at` predicate widens nothing across the tenant boundary;
 *  - through the real upload endpoint the op acks `applied`, not a refusal.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { signDevToken } from '../src/auth.js';
import type { VerifiedIdentity } from '../src/auth.js';
import { PRODUCT_RETIRED_CLASS } from '../src/retired-product.js';
import { buildServer } from '../src/server.js';
import type { UploadAck } from '../src/sync.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from './util.js';

let h: ApiHarness;
let app: FastifyInstance;
let tenantA: string;
let tenantB: string;
let root: string;
let out: string;
let bOutlet: string;
let owner: VerifiedIdentity;
type Caller = ReturnType<ApiHarness['callerFor']>;
let a: Caller;
let b: Caller;
let bearerA: string;
let supplierId: string;

/** Stocked, sellable, sold and bought in its stocking unit at scale 0. */
interface Picked {
  id: string;
  sku: string;
  uomId: string;
}
let pOff: Picked; // switched off and on
let pGone: Picked; // sold after removal
let pOld: Picked; // carries a price superseded BEFORE the removal
let pMove: Picked; // adjusted after removal
let pRecv: Picked; // received after removal
let pUpload: Picked; // sold through /sync/upload after removal
let bProduct: string;

const DAY = '2026-08-12';

async function q<T>(tenant: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return h.db.withTenant(tenant, async (tx) => (await tx.query<T>(sql, params)).rows);
}

let receiptSeq = 0;
async function salePayload(productId: string, qty = '2') {
  receiptSeq += 1;
  return h.legacySale({
    idempotencyKey: uuidv7(),
    locationId: out,
    priceListCode: 'WHOLESALE',
    receiptNo: `RET-${String(receiptSeq).padStart(4, '0')}`,
    businessDate: DAY,
    tender: 'CASH',
    lines: [{ productId, qty }],
  });
}

async function reviewsFor(entityId: string) {
  return q<{
    conflict_class: string;
    severity: number;
    entity_table: string;
    status: string;
    pending_state: string;
    proposals: unknown;
    location_id: string;
  }>(
    tenantA,
    `select r.conflict_class, r.severity, r.entity_table, r.status, r.pending_state, r.proposals, l.location_id
       from app.conflict_review r
       join app.conflict_review_location l on l.tenant_id = r.tenant_id and l.review_id = r.id
      where r.entity_id = $1`,
    [entityId],
  );
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('retired-a');
  tenantB = await h.provisionTenant('retired-b');
  await h.applyTemplate(tenantA);
  await h.applyTemplate(tenantB);
  root = await h.rootLocation(tenantA);
  out = (await h.firstOutlet(tenantA)).id;
  bOutlet = (await h.firstOutlet(tenantB)).id;
  owner = await h.identityFor(tenantA, { locs: [root, out] });
  a = h.callerFor(owner);
  b = h.callerFor(await h.identityFor(tenantB, { locs: [bOutlet] }));

  const picked = await q<{ id: string; sku_code: string; uom_id: string }>(
    tenantA,
    `select p.id, p.sku_code, pu.uom_id
       from app.product p
       join app.product_uom pu on pu.tenant_id = p.tenant_id and pu.product_id = p.id
        and pu.is_default_sell and pu.can_buy and pu.deleted_at is null and pu.uom_id = p.stocking_uom_id
        and pu.factor_num = 1 and pu.factor_den = 1
       join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
      where p.deleted_at is null and p.is_sellable and p.is_purchasable
        and p.stock_tracking = 'STOCKED' and u.qty_scale = 0
      order by p.sku_code limit 6`,
  );
  expect(picked).toHaveLength(6);
  [pOff, pGone, pOld, pMove, pRecv, pUpload] = picked.map((r) => ({ id: r.id, sku: r.sku_code, uomId: r.uom_id })) as [
    Picked, Picked, Picked, Picked, Picked, Picked,
  ];
  await h.seedWholesalePrice(tenantA, pOff.id, 20_000_000n); // 20.00, tax-exclusive
  await h.seedWholesalePrice(tenantA, pGone.id, 55_000_000n); // 55.00
  await h.seedWholesalePrice(tenantA, pUpload.id, 12_000_000n); // 12.00
  // pOld: 30.00, superseded (archived) a day before anything is removed, then 33.00.
  await h.seedWholesalePrice(tenantA, pOld.id, 30_000_000n);
  await h.db.withTenant(tenantA, (tx) =>
    tx.query(
      `update app.price_list_item set deleted_at = transaction_timestamp() - interval '1 day'
        where product_id = $1 and deleted_at is null`,
      [pOld.id],
    ),
  );
  await h.seedWholesalePrice(tenantA, pOld.id, 33_000_000n);

  supplierId = (await q<{ id: string }>(tenantA, `select id from app.supplier where deleted_at is null order by code limit 1`))[0]!.id;
  bProduct = (await h.pickProduct(tenantB)).id;
  await h.seedWholesalePrice(tenantB, bProduct, 77_000_000n);

  app = await buildServer({ deps: h.deps, jwtSecret: JWT_SECRET });
  const uploaderUid = uuidv7();
  await h.grantOwner(tenantA, uploaderUid);
  bearerA = await signDevToken(JWT_SECRET, { tid: tenantA, uid: uploaderUid, role: 'outlet-staff', locs: [out] });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe('products.setSellable — switching one product off, and on', () => {
  it('switches it off and back on; the product keeps its prices; a replay changes nothing', async () => {
    const key = uuidv7();
    const off = await a.products.setSellable({ idempotencyKey: key, productId: pOff.id, sellable: false });
    expect(off).toEqual({ productId: pOff.id, sellable: false, changed: true });
    const row = await q<{ is_sellable: boolean; deleted_at: string | null; write_id: string }>(
      tenantA,
      `select is_sellable, deleted_at, write_id from app.product where id = $1`,
      [pOff.id],
    );
    expect(row).toEqual([{ is_sellable: false, deleted_at: null, write_id: key }]);
    const listed = (await a.products.list()).products.find((p) => p.productId === pOff.id)!;
    expect(listed).toMatchObject({ sellable: false });
    expect(listed.prices.length).toBeGreaterThan(0);
    // The same press, replayed: the stored answer, no second write.
    expect(await a.products.setSellable({ idempotencyKey: key, productId: pOff.id, sellable: false })).toEqual(off);
    // Off again under a new key: already off, nothing changes.
    expect(await a.products.setSellable({ idempotencyKey: uuidv7(), productId: pOff.id, sellable: false })).toMatchObject({
      changed: false,
    });
  });

  it('is gated on catalogue.manage — Accounts and an outlet manager are refused, nothing moves', async () => {
    const accounts = h.callerFor(await h.principal(tenantA, { roleRef: 'accounts' }));
    const manager = h.callerFor(await h.principal(tenantA, { roleRef: 'outlet_manager', scopeLocationId: out }));
    for (const c of [accounts, manager]) {
      await expect(c.products.setSellable({ idempotencyKey: uuidv7(), productId: pOff.id, sellable: true })).rejects.toThrow(
        /catalogue\.manage/,
      );
    }
    expect((await q<{ s: boolean }>(tenantA, `select is_sellable s from app.product where id = $1`, [pOff.id]))[0]!.s).toBe(false);
  });

  it('[isolation] another tenant’s product is NOT_FOUND from here, and stays as it was', async () => {
    await expect(a.products.setSellable({ idempotencyKey: uuidv7(), productId: bProduct, sellable: false })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await q<{ s: boolean }>(tenantB, `select is_sellable s from app.product where id = $1`, [bProduct]))[0]!.s).toBe(true);
    // Positive control: B, switching its own.
    await expect(b.products.setSellable({ idempotencyKey: uuidv7(), productId: bProduct, sellable: true })).resolves.toMatchObject({
      changed: false,
    });
  });
});

describe('a sale rung before the product was SWITCHED OFF', () => {
  it('lands at its price, and one review names the product; the same sale replayed adds nothing', async () => {
    const input = await salePayload(pOff.id, '3');
    const sale = await a.sales.createSale(input);
    // 3 × 20.00, exclusive: the net is exact; tax is the pack's, not asserted here.
    expect(sale.subtotalNetMinor).toBe('6000');
    expect(sale.lines[0]).toMatchObject({ productId: pOff.id, unitPriceE4: '20000000' });
    const reviews = await reviewsFor(sale.saleId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      conflict_class: PRODUCT_RETIRED_CLASS,
      severity: 2,
      entity_table: 'app.sale',
      status: 'open',
      pending_state: 'first_applied',
      location_id: out,
    });
    expect(JSON.stringify(reviews[0]!.proposals)).toContain(pOff.sku);
    expect(JSON.stringify(reviews[0]!.proposals)).toContain('switched off');

    expect(await a.sales.createSale(input)).toEqual(sale);
    expect(await reviewsFor(sale.saleId)).toHaveLength(1);
    expect(await q(tenantA, `select 1 from app.sale where id = $1`, [sale.saleId])).toHaveLength(1);
  });

  it('positive control: switched back on, the same product sells with no review', async () => {
    await a.products.setSellable({ idempotencyKey: uuidv7(), productId: pOff.id, sellable: true });
    const sale = await a.sales.createSale(await salePayload(pOff.id));
    expect(await reviewsFor(sale.saleId)).toEqual([]);
  });

  it('a stock movement of a switched-off product is ordinary — switched off is about selling', async () => {
    await a.products.setSellable({ idempotencyKey: uuidv7(), productId: pOff.id, sellable: false });
    const m = await a.inventory.recordMovement({
      idempotencyKey: uuidv7(),
      locationId: out,
      productId: pOff.id,
      qtyDelta: '-1',
      sourceKind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      businessDate: DAY,
    });
    expect(await reviewsFor(m.movementId)).toEqual([]);
  });
});

describe('records made before the catalogue was REMOVED', () => {
  // Built while every product is live — what a tablet holds in its outbox.
  let gone: Awaited<ReturnType<typeof salePayload>>;
  let old: Awaited<ReturnType<typeof salePayload>>;
  let uploadKey: string;
  let uploadOp: Record<string, unknown>;

  beforeAll(async () => {
    gone = await salePayload(pGone.id, '4');
    old = await salePayload(pOld.id, '1');
    const till = await h.openTill(tenantA, out, DAY);
    const cash = (await h.tenderMethods(tenantA)).cash;
    uploadKey = uuidv7();
    uploadOp = {
      idempotency_key: uploadKey,
      claimed_hlc: h.deps.clock.next(),
      kind: 'sale.create',
      payload: {
        locationId: out,
        priceListCode: 'WHOLESALE',
        receiptNo: 'RET-UPLOAD-1',
        cashSessionId: till,
        tenders: [{ methodId: cash, settlement: 'IMMEDIATE' }],
        lines: [{ productId: pUpload.id, qty: '5' }],
      },
    };
    const live = Number((await q<{ n: string }>(tenantA, `select count(*)::text n from app.product where deleted_at is null`))[0]!.n);
    await a.products.removeAll({ idempotencyKey: uuidv7(), expectedCount: live });
    expect(await q(tenantA, `select 1 from app.product where deleted_at is null`)).toEqual([]);
  });

  it('a sale lands at the price in force when the product was removed, with a review', async () => {
    const sale = await a.sales.createSale(gone);
    // 4 × 55.00.
    expect(sale.subtotalNetMinor).toBe('22000');
    expect(sale.lines[0]).toMatchObject({ productId: pGone.id, unitPriceE4: '55000000', qty: '4' });
    const line = await q<{ unit_price_e4: string; qty_stock: string }>(
      tenantA,
      `select unit_price_e4::text, qty_stock::text from app.sale_line where sale_id = $1`,
      [sale.saleId],
    );
    expect(line).toEqual([{ unit_price_e4: '55000000', qty_stock: '4' }]);
    // The bags left the yard: the movement is recorded against the removed product.
    expect(
      await q<{ qty: string }>(
        tenantA,
        `select qty_delta::text qty from app.stock_movement where source_id = $1 and product_id = $2`,
        [sale.saleId, pGone.id],
      ),
    ).toEqual([{ qty: '-4' }]);
    const reviews = await reviewsFor(sale.saleId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ conflict_class: PRODUCT_RETIRED_CLASS, entity_table: 'app.sale', status: 'open' });
    expect(JSON.stringify(reviews[0]!.proposals)).toContain(pGone.sku);
    expect(JSON.stringify(reviews[0]!.proposals)).toContain('removed');

    // Replayed (the outbox retrying): the stored answer, one sale, one review.
    expect(await a.sales.createSale(gone)).toEqual(sale);
    expect(await q(tenantA, `select 1 from app.sale where id = $1`, [sale.saleId])).toHaveLength(1);
    expect(await reviewsFor(sale.saleId)).toHaveLength(1);
  });

  it('never at a price that had already been superseded before the removal', async () => {
    const sale = await a.sales.createSale(old);
    expect(sale.lines[0]).toMatchObject({ unitPriceE4: '33000000' });
    expect(sale.subtotalNetMinor).toBe('3300');
  });

  it('a stock adjustment lands, with a review on the movement', async () => {
    const m = await a.inventory.recordMovement({
      idempotencyKey: uuidv7(),
      locationId: out,
      productId: pMove.id,
      qtyDelta: '-2',
      sourceKind: 'WRITE_OFF',
      reasonCode: 'DAMAGE',
      businessDate: DAY,
    });
    expect(
      await q(tenantA, `select 1 from app.stock_movement where id = $1 and product_id = $2 and qty_delta = -2`, [m.movementId, pMove.id]),
    ).toHaveLength(1);
    const reviews = await reviewsFor(m.movementId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ conflict_class: PRODUCT_RETIRED_CLASS, entity_table: 'app.stock_movement' });
  });

  it('a goods receipt lands against the unit live at removal, with a review', async () => {
    const r = await a.receiving.recordReceipt({
      idempotencyKey: uuidv7(),
      supplierId,
      locationId: out,
      businessDate: DAY,
      lines: [{ lineNo: 1, productId: pRecv.id, uomId: pRecv.uomId, qtyReceived: '10', qtyStock: '10', unitCostE4: '250000' }],
    });
    expect(
      await q(tenantA, `select 1 from app.stock_movement where product_id = $1 and qty_delta = 10`, [pRecv.id]),
    ).toHaveLength(1);
    const reviews = await reviewsFor(r.goodsReceiptId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ conflict_class: PRODUCT_RETIRED_CLASS, entity_table: 'app.goods_receipt' });
  });

  it('through POST /sync/upload — the tablet’s real path — the op acks applied, not a refusal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/upload',
      headers: { authorization: `Bearer ${bearerA}` },
      payload: { ops: [uploadOp] },
    });
    expect(res.statusCode).toBe(200);
    const acks = res.json().acks as UploadAck[];
    expect(acks.map((x) => x.status)).toEqual(['applied']);
    const sale = await q<{ id: string; subtotal_net_minor: string }>(
      tenantA,
      `select id, subtotal_net_minor::text from app.sale where write_id = $1`,
      [uploadKey],
    );
    expect(sale).toEqual([{ id: expect.any(String), subtotal_net_minor: '6000' }]); // 5 × 12.00
    expect(await reviewsFor(sale[0]!.id)).toHaveLength(1);
  });

  it('a removed product cannot be switched back on — it is gone from the catalogue', async () => {
    await expect(a.products.setSellable({ idempotencyKey: uuidv7(), productId: pGone.id, sellable: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('the tenant boundary is where it was', () => {
  it('[isolation] a sale naming another tenant’s product is NOT_FOUND, and writes nothing in either tenant', async () => {
    const before = await q(tenantA, `select 1 from app.sale`);
    const bSalesBefore = await q(tenantB, `select 1 from app.sale`);
    await expect(a.sales.createSale(await salePayload(bProduct))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      a.inventory.recordMovement({
        idempotencyKey: uuidv7(),
        locationId: out,
        productId: bProduct,
        qtyDelta: '5',
        sourceKind: 'OPENING',
        reasonCode: 'OPENING',
        businessDate: DAY,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      a.receiving.recordReceipt({
        idempotencyKey: uuidv7(),
        supplierId,
        locationId: out,
        businessDate: DAY,
        lines: [{ lineNo: 1, productId: bProduct, uomId: pRecv.uomId, qtyReceived: '1', qtyStock: '1', unitCostE4: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await q(tenantA, `select 1 from app.sale`)).toHaveLength(before.length);
    expect(await q(tenantB, `select 1 from app.sale`)).toHaveLength(bSalesBefore.length);
    expect(await q(tenantB, `select 1 from app.stock_movement where product_id = $1`, [bProduct])).toEqual([]);
  });

  it('a product id nobody holds is still NOT_FOUND', async () => {
    await expect(a.sales.createSale(await salePayload(uuidv7()))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
