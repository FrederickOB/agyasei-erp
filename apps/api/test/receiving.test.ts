/**
 * GOODS-RECEIVED MATCHING — the heart of Phase 2 (CLAUDE.md §3).
 *
 * What makes these tests worth anything, in the same terms `rbac.test.ts` and
 * `sales-rbac.test.ts` set:
 *
 *  - REAL POSTGRES (PGlite) running the REAL migrations as `app_user` with the
 *    tenant GUC set, so RLS genuinely applies and every trigger in 0008 is
 *    live. Purchase orders are built through the tenant's own RLS context with
 *    ordinary SQL — not `asAdmin`, and not through a router that does not
 *    exist yet — so no fixture writes a row a real caller could not have.
 *  - THE REAL ROUTER. Nothing asserts on a guard; every assertion is on what
 *    `receiving.recordReceipt` did, or on the rows Postgres now holds.
 *  - EVERY DENY HAS A POSITIVE CONTROL: the same route, the same location, an
 *    otherwise byte-identical payload, a principal who may. A suite where
 *    everything is forbidden passes just as well when the route is broken.
 *  - NOT ONE ASSERTION MENTIONS A ROLE NAME. Roles are identified by template
 *    provenance (`origin_ref`); `app.role.name` is the tenant's word for the
 *    tenant's job and nothing may key off it (CLAUDE.md §2.9).
 *  - THE CONVERSION FIGURES ARE COMPUTED INDEPENDENTLY, from the factors the
 *    template seeded, with `@erp/money` — never read back from the router and
 *    compared with itself (docs/phase1-status.md §0's one root cause).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICE_OP_KINDS, deviceOpContracts, recordGoodsReceiptInput } from '@erp/contracts';
import { uuidv7 } from '@erp/db';
import { divRound, lineNetMinor, mulDiv } from '@erp/money';
import { signDevToken, type VerifiedIdentity } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from './util.js';

type Caller = ReturnType<ApiHarness['callerFor']>;

let h: ApiHarness;
let app: FastifyInstance;

let tenantA: string;
let tenantB: string;

let rootA: string;
let out01: string;
let out03: string;
let regBono: string;

/** A plain STOCKED product: stocking unit is the purchase unit, scale 0. */
let plainProductId: string;
let plainUomId: string;

/** The genuine dual-unit line: stocked in BAR_12M, invoiced by the TON. */
let rebarId: string;
let rebarStockUomId: string;
let rebarTonUomId: string;
let rebarFactorNum: bigint;
let rebarFactorDen: bigint;
/** The slack the template authored on that row (04 §4.4.4). Read, not stated. */
let rebarToleranceBp: bigint;

let goodsSupplierId: string;
let otherSupplierId: string;

let managerA: VerifiedIdentity; // outlet_manager at OUT-01 — holds goods.receive
let manager03: VerifiedIdentity; // outlet_manager at OUT-03
let counterA: VerifiedIdentity; // counter_staff at OUT-01 — no goods.receive
let accountsA: VerifiedIdentity; // accounts at the root — approves, never signs
let regionalA: VerifiedIdentity; // regional_manager at REG-BONO — approves, never signs

let manager: Caller;
let managerAt03: Caller;
let counter: Caller;
let accounts: Caller;
let regional: Caller;
let ownerA: Caller;
let ownerB: Caller;

let bReceiptId: string;
let bTenantOutlet: string;

const DAY = '2026-08-20';

// ---------------------------------------------------------------------------
// Fixtures — purchase orders, written the way a real caller would write them
// ---------------------------------------------------------------------------

interface PoLineSpec {
  productId: string;
  uomId: string;
  /** Scaled integer in `uomId`, as a bigint. */
  qtyOrdered: bigint;
  unitPriceE4: bigint;
}

interface PoFixture {
  purchaseOrderId: string;
  lineIds: string[];
}

/** The supplier id for one of the template's seeded suppliers, by provenance. */
async function supplierByRef(tenantId: string, ref: string): Promise<string> {
  return h.db.withTenant(tenantId, async (tx) => {
    const res = await tx.query<{ id: string }>(
      `select id from app.supplier where origin_ref = $1 and deleted_at is null`,
      [`supplier:${ref}`],
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error(`no template supplier ${ref}`);
    return id;
  });
}

/**
 * A purchase order carried all the way to APPROVED through the STATE MACHINE
 * the database enforces: inserted as DRAFT (0008 refuses anything else),
 * lines added while DRAFT (0008 refuses them afterwards), then
 * DRAFT → SUBMITTED → APPROVED with an approver's id on the row.
 */
async function createApprovedPo(
  tenantId: string,
  approverUserId: string,
  opts: { supplierId: string; locationId: string; lines: PoLineSpec[] },
): Promise<PoFixture> {
  return h.db.withTenant(tenantId, async (tx) => {
    const writeId = uuidv7();
    await tx.query(
      `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
       values ($1,$2,'SERVER',$3,'test.purchase_order',1,decode('00','hex'))`,
      [tenantId, writeId, h.deps.clock.next()],
    );
    const pack = await tx.query<{ currency_code: string; minor_units_per_major: string }>(
      `select j.currency_code, j.minor_units_per_major::text
         from platform.tenant t
         join platform.jurisdiction j on j.code = t.jurisdiction_code
        where t.id = app.current_tenant()`,
    );
    const purchaseOrderId = uuidv7();
    await tx.query(
      `insert into app.purchase_order
         (tenant_id, id, write_id, hlc, supplier_id, deliver_to_location_id, status,
          order_date, currency_code, money_scale)
       values ($1,$2,$3,$4,$5,$6,'DRAFT',$7::date,$8,$9)`,
      [
        tenantId,
        purchaseOrderId,
        writeId,
        h.deps.clock.next(),
        opts.supplierId,
        opts.locationId,
        DAY,
        pack.rows[0]!.currency_code,
        pack.rows[0]!.minor_units_per_major,
      ],
    );

    const lineIds: string[] = [];
    let lineNo = 0;
    for (const spec of opts.lines) {
      lineNo += 1;
      const meta = await tx.query<{
        stocking_uom_id: string;
        stocking_scale: number;
        purchase_scale: number;
        factor_num: string;
        factor_den: string;
      }>(
        `select p.stocking_uom_id, su.qty_scale as stocking_scale,
                bu.qty_scale as purchase_scale, pu.factor_num::text, pu.factor_den::text
           from app.product p
           join app.unit_of_measure su on su.tenant_id = p.tenant_id and su.id = p.stocking_uom_id
           join app.product_uom pu
             on pu.tenant_id = p.tenant_id and pu.product_id = p.id and pu.uom_id = $2
            and pu.deleted_at is null and pu.can_buy
           join app.unit_of_measure bu on bu.tenant_id = p.tenant_id and bu.id = pu.uom_id
          where p.id = $1 and p.deleted_at is null`,
        [spec.productId, spec.uomId],
      );
      const m = meta.rows[0];
      if (!m) throw new Error('the fixture asked for a unit the product cannot be bought in');
      const qtyStock = mulDiv(
        spec.qtyOrdered,
        BigInt(m.factor_num) * 10n ** BigInt(m.stocking_scale),
        BigInt(m.factor_den) * 10n ** BigInt(m.purchase_scale),
        'half-up',
      );
      const net = lineNetMinor(spec.qtyOrdered, m.purchase_scale, spec.unitPriceE4, 'half-up');
      const lineId = uuidv7();
      lineIds.push(lineId);
      await tx.query(
        `insert into app.purchase_order_line
           (tenant_id, id, write_id, hlc, purchase_order_id, line_no, product_id,
            uom_id, qty_scale, qty_ordered, unit_price_e4,
            stocking_uom_id, qty_stock_scale, qty_ordered_stock, factor_num, factor_den,
            line_net_minor)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          tenantId,
          lineId,
          writeId,
          h.deps.clock.next(),
          purchaseOrderId,
          lineNo,
          spec.productId,
          spec.uomId,
          m.purchase_scale,
          spec.qtyOrdered.toString(10),
          spec.unitPriceE4.toString(10),
          m.stocking_uom_id,
          m.stocking_scale,
          qtyStock.toString(10),
          m.factor_num,
          m.factor_den,
          net.toString(10),
        ],
      );
    }

    await tx.query(
      `update app.purchase_order set status = 'SUBMITTED', submitted_at = transaction_timestamp()
        where id = $1`,
      [purchaseOrderId],
    );
    await tx.query(
      `update app.purchase_order
          set status = 'APPROVED', approved_at = transaction_timestamp(), approved_by_user_id = $2
        where id = $1`,
      [purchaseOrderId, approverUserId],
    );
    return { purchaseOrderId, lineIds };
  });
}

async function onHand(caller: Caller, locationId: string, productId: string): Promise<bigint> {
  const res = await caller.inventory.onHand({ locationId, productId });
  return BigInt(res.qtyOnHand);
}

function receiptPayload(over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: uuidv7(),
    supplierId: goodsSupplierId,
    locationId: out01,
    businessDate: DAY,
    lines: [
      {
        lineNo: 1,
        productId: plainProductId,
        uomId: plainUomId,
        qtyReceived: '10',
        qtyStock: '10',
        unitCostE4: '250000',
      },
    ],
    ...over,
  } as Parameters<Caller['receiving']['recordReceipt']>[0];
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('receiving-a');
  tenantB = await h.provisionTenant('receiving-b');
  await h.applyTemplate(tenantA, true);
  await h.applyTemplate(tenantB, true);

  rootA = await h.rootLocation(tenantA);
  out01 = await h.locationByCode(tenantA, 'OUT-01');
  out03 = await h.locationByCode(tenantA, 'OUT-03');
  regBono = await h.locationByCode(tenantA, 'REG-BONO');

  const plain = await h.pickProduct(tenantA);
  plainProductId = plain.id;
  // The template gives every product's STOCKING unit a product_uom row with
  // can_buy, so the simple case needs no extra configuration.
  plainUomId = await h.db.withTenant(tenantA, async (tx) => {
    const res = await tx.query<{ uom_id: string }>(
      `select pu.uom_id from app.product_uom pu
        join app.product p on p.tenant_id = pu.tenant_id and p.id = pu.product_id
       where pu.product_id = $1 and pu.uom_id = p.stocking_uom_id
         and pu.deleted_at is null and pu.can_buy`,
      [plainProductId],
    );
    const id = res.rows[0]?.uom_id;
    if (!id) throw new Error('the template did not seed a buyable stocking unit');
    return id;
  });

  // The dual-unit case: rebar stocked in 12 m bars, invoiced by the tonne.
  // Making the tonne BUYABLE is ordinary tenant configuration — one row's
  // flag, exactly what §4.10 describes for cement bought by the tonne.
  const rebar = await h.db.withTenant(tenantA, async (tx) => {
    const res = await tx.query<{
      id: string;
      stocking_uom_id: string;
      ton_uom_id: string;
      factor_num: string;
      factor_den: string;
    }>(
      `select p.id, p.stocking_uom_id, pu.uom_id as ton_uom_id,
              pu.factor_num::text, pu.factor_den::text
         from app.product p
         join app.unit_of_measure su
           on su.tenant_id = p.tenant_id and su.id = p.stocking_uom_id and su.code = 'BAR_12M'
         join app.product_uom pu
           on pu.tenant_id = p.tenant_id and pu.product_id = p.id and pu.deleted_at is null
         join app.unit_of_measure tu
           on tu.tenant_id = p.tenant_id and tu.id = pu.uom_id and tu.code = 'TON'
        where p.deleted_at is null and pu.factor_num / pu.factor_den between 40 and 140
        order by p.sku_code limit 1`,
    );
    const row = res.rows[0];
    if (!row) throw new Error('the template seeded no dual-unit rebar line');
    await tx.query(
      `update app.product_uom set can_buy = true
        where product_id = $1 and uom_id = $2 and deleted_at is null`,
      [row.id, row.ton_uom_id],
    );
    return row;
  });
  rebarId = rebar.id;
  rebarStockUomId = rebar.stocking_uom_id;
  rebarTonUomId = rebar.ton_uom_id;
  rebarFactorNum = BigInt(rebar.factor_num);
  rebarFactorDen = BigInt(rebar.factor_den);
  // READ from the row the template authored — never a literal here. A test
  // that states its own tolerance is a test that agrees with itself.
  rebarToleranceBp = await h.db.withTenant(tenantA, async (tx) => {
    const res = await tx.query<{ tolerance_bp: string }>(
      `select tolerance_bp::text from app.product_uom
        where product_id = $1 and uom_id = $2 and deleted_at is null`,
      [rebarId, rebarTonUomId],
    );
    return BigInt(res.rows[0]!.tolerance_bp);
  });

  goodsSupplierId = await supplierByRef(tenantA, 'GHACEM');
  otherSupplierId = await supplierByRef(tenantA, 'DANGOTE');

  managerA = await h.principal(tenantA, { roleRef: 'outlet_manager', scopeLocationId: out01 });
  manager03 = await h.principal(tenantA, { roleRef: 'outlet_manager', scopeLocationId: out03 });
  counterA = await h.principal(tenantA, { roleRef: 'counter_staff', scopeLocationId: out01 });
  accountsA = await h.principal(tenantA, { roleRef: 'accounts', scopeLocationId: rootA });
  regionalA = await h.principal(tenantA, { roleRef: 'regional_manager', scopeLocationId: regBono });

  manager = h.callerFor(managerA);
  managerAt03 = h.callerFor(manager03);
  counter = h.callerFor(counterA);
  accounts = h.callerFor(accountsA);
  regional = h.callerFor(regionalA);
  ownerA = h.callerFor(await h.identityFor(tenantA, { locs: [rootA, out01, out03, regBono] }));

  bTenantOutlet = (await h.firstOutlet(tenantB)).id;
  ownerB = h.callerFor(await h.identityFor(tenantB, { locs: [bTenantOutlet] }));

  app = await buildServer({ deps: h.deps, jwtSecret: JWT_SECRET });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

// ---------------------------------------------------------------------------
// 1. The control: approving is not receiving
// ---------------------------------------------------------------------------

describe('goods.receive is a capability of its own, held at a place', () => {
  it('counter staff are refused, and the outlet manager is allowed the same payload', async () => {
    const base = receiptPayload();
    await expect(counter.receiving.recordReceipt({ ...base, idempotencyKey: uuidv7() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // The positive control: same route, same outlet, same lines.
    const ok = await manager.receiving.recordReceipt({ ...base, idempotencyKey: uuidv7() });
    expect(ok.goodsReceiptId).toBeTruthy();
    expect(ok.movementCount).toBe(1);
  });

  it('the roles that APPROVE spend cannot sign for the goods — accounts and the regional manager', async () => {
    const base = receiptPayload();
    await expect(accounts.receiving.recordReceipt({ ...base, idempotencyKey: uuidv7() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(regional.receiving.recordReceipt({ ...base, idempotencyKey: uuidv7() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // …and the refusal is the missing capability, not a broken route.
    await expect(manager.receiving.recordReceipt({ ...base, idempotencyKey: uuidv7() })).resolves.toBeTruthy();
  });

  it('a capability is a capability AT A PLACE: OUT-01’s manager cannot sign at OUT-03', async () => {
    const at03 = receiptPayload({ locationId: out03 });
    await expect(manager.receiving.recordReceipt({ ...at03, idempotencyKey: uuidv7() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      managerAt03.receiving.recordReceipt({ ...at03, idempotencyKey: uuidv7() }),
    ).resolves.toBeTruthy();
  });

  it('reading a receipt needs purchase.order.view, which the counter does not hold', async () => {
    const posted = await manager.receiving.recordReceipt(receiptPayload());
    await expect(counter.receiving.get({ goodsReceiptId: posted.goodsReceiptId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const read = await manager.receiving.get({ goodsReceiptId: posted.goodsReceiptId });
    expect(read.goodsReceiptId).toBe(posted.goodsReceiptId);
  });
});

// ---------------------------------------------------------------------------
// 2. A receipt APPENDS movements — the identity, exactly
// ---------------------------------------------------------------------------

describe('receipt → stock movement identity', () => {
  it('on-hand after = on-hand before + qtyStock, exactly, and it is an APPENDED row', async () => {
    const before = await onHand(ownerA, out01, plainProductId);
    const posted = await manager.receiving.recordReceipt(
      receiptPayload({
        lines: [
          {
            lineNo: 1,
            productId: plainProductId,
            uomId: plainUomId,
            qtyReceived: '250',
            qtyStock: '250',
            unitCostE4: '250000',
          },
        ],
      }),
    );
    const after = await onHand(ownerA, out01, plainProductId);
    expect(after).toBe(before + 250n);

    const rows = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{
        id: string;
        qty_delta: string;
        source_kind: string;
        source_id: string;
        unit_cost_e4: string | null;
        business_date: string;
      }>(
        `select id, qty_delta::text, source_kind, source_id, unit_cost_e4::text,
                business_date::text
           from app.stock_movement where source_id = $1`,
        [posted.goodsReceiptId],
      );
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qty_delta).toBe('250');
    expect(rows[0]!.source_kind).toBe('RECEIPT');
    expect(rows[0]!.source_id).toBe(posted.goodsReceiptId);
    // The cost the weighted-average replay reads, per ONE stocking unit.
    expect(rows[0]!.unit_cost_e4).toBe(posted.lines[0]!.stockUnitCostE4);
    expect(rows[0]!.business_date).toBe(DAY);
    expect(posted.lines[0]!.stockMovementId).toBe(rows[0]!.id);
  });

  it('no counter is ever set: on-hand is the SUM of the ledger', async () => {
    const before = await onHand(ownerA, out01, plainProductId);
    for (const qty of ['3', '7', '11']) {
      await manager.receiving.recordReceipt(
        receiptPayload({
          lines: [
            {
              lineNo: 1,
              productId: plainProductId,
              uomId: plainUomId,
              qtyReceived: qty,
              qtyStock: qty,
              unitCostE4: '250000',
            },
          ],
        }),
      );
    }
    expect(await onHand(ownerA, out01, plainProductId)).toBe(before + 21n);
  });
});

// ---------------------------------------------------------------------------
// 3. Units go through the SAME product_uom machinery as selling
// ---------------------------------------------------------------------------

describe('the dual-unit SKU: invoiced by the tonne, stocked by the bar', () => {
  it('converts once, half-up, from the SNAPSHOTTED factor — and stocks bars, not tonnes', async () => {
    const qtyTonnes = 2_000n; // 2.000 t at TON's scale of 3
    const unitCostE4 = 4_500_000_000n; // GH₵4,500 per tonne, in pesewas × 10⁴

    // Computed here, independently, from the factors the TEMPLATE seeded —
    // not read back from the router and compared with itself.
    const expectedBars = mulDiv(
      qtyTonnes,
      rebarFactorNum * 10n ** 0n, // BAR_12M scale 0
      rebarFactorDen * 10n ** 3n, // TON scale 3
      'half-up',
    );
    const expectedStockCostE4 = divRound(unitCostE4 * rebarFactorDen, rebarFactorNum, 'half-up');
    const expectedInvoiced = lineNetMinor(qtyTonnes, 3, unitCostE4, 'half-up');

    const before = await onHand(ownerA, out01, rebarId);
    const posted = await manager.receiving.recordReceipt(
      receiptPayload({
        lines: [
          {
            lineNo: 1,
            productId: rebarId,
            uomId: rebarTonUomId,
            qtyReceived: qtyTonnes.toString(10),
            qtyStock: expectedBars.toString(10),
            unitCostE4: unitCostE4.toString(10),
          },
        ],
      }),
    );

    const line = posted.lines[0]!;
    expect(line.qtyStockComputed).toBe(expectedBars.toString(10));
    expect(line.qtyStock).toBe(expectedBars.toString(10));
    expect(line.qtyReceivedScale).toBe(3);
    expect(line.qtyStockScale).toBe(0);
    expect(line.stockingUomCode).toBe('BAR_12M');
    expect(line.uomCode).toBe('TON');
    expect(line.factorNum).toBe(rebarFactorNum.toString(10));
    expect(line.stockUnitCostE4).toBe(expectedStockCostE4.toString(10));
    expect(line.lineNetMinor).toBe(expectedInvoiced.toString(10));
    expect(line.conversionConfirmed).toBe(false);

    // The LEDGER moved in bars — the unit the stocktaker counts in.
    expect(await onHand(ownerA, out01, rebarId)).toBe(before + expectedBars);
    const stocked = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ qty_scale: number; uom_id: string }>(
        `select qty_scale, uom_id from app.stock_movement where source_id = $1`,
        [posted.goodsReceiptId],
      );
      return res.rows[0]!;
    });
    expect(stocked.uom_id).toBe(rebarStockUomId);
    expect(stocked.qty_scale).toBe(0);
  });

  it('refuses a unit the product cannot be BOUGHT in — there would be no factor', async () => {
    // A unit belonging to a different product entirely.
    await expect(
      manager.receiving.recordReceipt(
        receiptPayload({
          lines: [
            {
              lineNo: 1,
              productId: plainProductId,
              uomId: rebarTonUomId,
              qtyReceived: '1000',
              qtyStock: '1',
              unitCostE4: '1',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('a count that disagrees with its own conversion needs a human’s signature', async () => {
    const qtyTonnes = 1_000n;
    const computed = mulDiv(qtyTonnes, rebarFactorNum, rebarFactorDen * 1000n, 'half-up');
    const counted = computed - 3n; // three bars short off the truck

    const unsigned = receiptPayload({
      lines: [
        {
          lineNo: 1,
          productId: rebarId,
          uomId: rebarTonUomId,
          qtyReceived: qtyTonnes.toString(10),
          qtyStock: counted.toString(10),
          unitCostE4: '4500000000',
        },
      ],
    });
    await expect(manager.receiving.recordReceipt(unsigned)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    const before = await onHand(ownerA, out01, rebarId);
    const signed = await manager.receiving.recordReceipt(
      receiptPayload({
        lines: [
          {
            lineNo: 1,
            productId: rebarId,
            uomId: rebarTonUomId,
            qtyReceived: qtyTonnes.toString(10),
            qtyStock: counted.toString(10),
            unitCostE4: '4500000000',
            confirmConversion: true,
          },
        ],
      }),
    );
    expect(signed.lines[0]!.conversionConfirmed).toBe(true);
    expect(signed.lines[0]!.qtyStockComputed).toBe(computed.toString(10));
    expect(signed.lines[0]!.qtyStock).toBe(counted.toString(10));
    // The LEDGER carries what was COUNTED, not what the maths expected.
    expect(await onHand(ownerA, out01, rebarId)).toBe(before + counted);

    const who = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ conversion_confirmed_by: string | null }>(
        `select conversion_confirmed_by from app.goods_receipt_line where goods_receipt_id = $1`,
        [signed.goodsReceiptId],
      );
      return res.rows[0]!.conversion_confirmed_by;
    });
    expect(who).toBe(managerA.userId);
  });
});

// ---------------------------------------------------------------------------
// 3a. A signature is not a blank cheque: product_uom.tolerance_bp
// ---------------------------------------------------------------------------

/** Every review row this receipt opened, straight out of Postgres. */
async function reviewsFor(tenantId: string, receiptId: string) {
  return h.db.withTenant(tenantId, async (tx) => {
    const res = await tx.query<{
      id: string;
      conflict_class: string;
      severity: number;
      entity_table: string;
      entity_id: string;
      field_path: string | null;
      required_permission: string;
      status: string;
      pending_value: { qtyStock?: unknown; qtyStockComputed?: unknown };
      proposals: unknown;
      locations: string[];
    }>(
      `select cr.id, cr.conflict_class, cr.severity, cr.entity_table, cr.entity_id,
              cr.field_path, cr.required_permission, cr.status, cr.pending_value, cr.proposals,
              array(select crl.location_id from app.conflict_review_location crl
                     where crl.review_id = cr.id) as locations
         from app.conflict_review cr
         join app.goods_receipt_line grl
           on grl.tenant_id = cr.tenant_id and grl.id = cr.entity_id
        where grl.goods_receipt_id = $1
        order by cr.opened_at`,
      [receiptId],
    );
    return res.rows;
  });
}

/**
 * A tonnage whose conversion lands on a whole number of bars, big enough that
 * the authored tolerance admits at least one bar of slack — so "inside" and
 * "outside" are both real cases rather than the same case twice.
 */
const TOLERANCE_TONNES = 40_000n;

describe('a confirmed count is bounded by the unit’s tolerance (04 §4.4.4)', () => {
  const computed = () =>
    mulDiv(TOLERANCE_TONNES, rebarFactorNum, rebarFactorDen * 1000n, 'half-up');
  /** The largest deviation still inside: diff * 10000 <= tolerance * computed. */
  const maxInside = () => (rebarToleranceBp * computed()) / 10000n;

  const line = (counted: bigint) => ({
    lineNo: 1,
    productId: rebarId,
    uomId: rebarTonUomId,
    qtyReceived: TOLERANCE_TONNES.toString(10),
    qtyStock: counted.toString(10),
    unitCostE4: '4500000000',
    confirmConversion: true,
  });

  it('the template authored enough slack for this to be two different cases', () => {
    expect(maxInside()).toBeGreaterThan(0n);
  });

  it('a signed difference INSIDE the tolerance is recorded and opens nothing', async () => {
    const counted = computed() - maxInside();
    const before = await onHand(ownerA, out01, rebarId);
    const posted = await manager.receiving.recordReceipt(receiptPayload({ lines: [line(counted)] }));

    expect(posted.lines[0]!.conversionConfirmed).toBe(true);
    expect(posted.lines[0]!.outOfTolerance).toBe(false);
    expect(posted.lines[0]!.conversionReviewId).toBeNull();
    expect(posted.totals.outOfToleranceLines).toBe(0);
    expect(await reviewsFor(tenantA, posted.goodsReceiptId)).toHaveLength(0);
    // and the stock is the counted figure, as always
    expect(await onHand(ownerA, out01, rebarId)).toBe(before + counted);
  });

  it('ONE MORE BAR is outside it — the boundary is exact, because nothing rounds', async () => {
    const counted = computed() - maxInside() - 1n;
    const posted = await manager.receiving.recordReceipt(receiptPayload({ lines: [line(counted)] }));
    expect(posted.lines[0]!.outOfTolerance).toBe(true);
    expect(posted.totals.outOfToleranceLines).toBe(1);
    expect(await reviewsFor(tenantA, posted.goodsReceiptId)).toHaveLength(1);
  });

  it('the excess is RECORDED, not refused — the goods are in the yard either way', async () => {
    const counted = computed() * 2n; // wildly beyond any tolerance
    const before = await onHand(ownerA, out01, rebarId);
    const posted = await manager.receiving.recordReceipt(receiptPayload({ lines: [line(counted)] }));

    expect(posted.lines[0]!.outOfTolerance).toBe(true);
    expect(posted.lines[0]!.qtyStock).toBe(counted.toString(10));
    // The movement landed, and it carries what was COUNTED.
    expect(await onHand(ownerA, out01, rebarId)).toBe(before + counted);

    const [review] = await reviewsFor(tenantA, posted.goodsReceiptId);
    expect(review).toMatchObject({
      conflict_class: 'CONVERSION_OUT_OF_TOLERANCE',
      severity: 2,
      entity_table: 'app.goods_receipt_line',
      entity_id: posted.lines[0]!.goodsReceiptLineId,
      field_path: 'qty_stock',
      status: 'open',
    });
    expect(review!.id).toBe(posted.lines[0]!.conversionReviewId);
    // Both figures are on the review, as STRINGS: a human reads them and
    // re-keys them, and JSON.parse of a bare number is a float64 (§3.6.2).
    expect(review!.pending_value.qtyStock).toBe(counted.toString(10));
    expect(review!.pending_value.qtyStockComputed).toBe(computed().toString(10));
    // Scoped to the yard that signed, not broadcast to all 25 outlets.
    expect(review!.locations).toEqual([out01]);
  });

  it('routes by a capability that EXISTS in the platform catalogue', async () => {
    const posted = await manager.receiving.recordReceipt(
      receiptPayload({ lines: [line(computed() * 3n)] }),
    );
    const [review] = await reviewsFor(tenantA, posted.goodsReceiptId);
    // phase1-status §0 row 7: a required_permission is plain text with no FK,
    // so the only thing that catches an invented code is asking the catalogue.
    const held = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ code: string }>(
        `select code from platform.permission where code = $1`,
        [review!.required_permission],
      );
      return res.rows.map((r) => r.code);
    });
    expect(held).toEqual([review!.required_permission]);
    // and a real role in the tenant's own template actually holds it
    const holders = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ n: string }>(
        `select count(*)::text n from app.role_permission where permission_code = $1`,
        [review!.required_permission],
      );
      return Number(res.rows[0]!.n);
    });
    expect(holders).toBeGreaterThan(0);
  });

  it('a replayed receipt does not open a second review', async () => {
    const key = uuidv7();
    const payload = receiptPayload({ idempotencyKey: key, lines: [line(computed() * 4n)] });
    const first = await manager.receiving.recordReceipt(payload);
    const again = await manager.receiving.recordReceipt(payload);
    expect(again).toEqual(first);
    expect(await reviewsFor(tenantA, first.goodsReceiptId)).toHaveLength(1);
  });

  it('an EXACT conversion never opens one, however large the receipt', async () => {
    const posted = await manager.receiving.recordReceipt(
      receiptPayload({ lines: [line(computed())] }),
    );
    expect(posted.lines[0]!.conversionConfirmed).toBe(false);
    expect(posted.lines[0]!.outOfTolerance).toBe(false);
    expect(posted.lines[0]!.deviationBp).toBe('0');
    expect(await reviewsFor(tenantA, posted.goodsReceiptId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Short, over and substitute deliveries are NORMAL TRADE
// ---------------------------------------------------------------------------

describe('matching against a purchase order', () => {
  it('a SHORT delivery is recorded, the variance is visible, and the order goes PARTIALLY_RECEIVED', async () => {
    const approver = accountsA.userId;
    const po = await createApprovedPo(tenantA, approver, {
      supplierId: goodsSupplierId,
      locationId: out01,
      lines: [
        { productId: plainProductId, uomId: plainUomId, qtyOrdered: 100n, unitPriceE4: 250_000n },
      ],
    });

    const posted = await manager.receiving.recordReceipt(
      receiptPayload({
        purchaseOrderId: po.purchaseOrderId,
        lines: [
          {
            lineNo: 1,
            purchaseOrderLineId: po.lineIds[0],
            productId: plainProductId,
            uomId: plainUomId,
            qtyReceived: '60',
            qtyStock: '60',
            unitCostE4: '250000',
          },
        ],
      }),
    );

    expect(posted.lines[0]!.variance).toBe('SHORT');
    expect(posted.lines[0]!.qtyOrdered).toBe('100');
    expect(posted.lines[0]!.qtyReceivedBefore).toBe('0');
    expect(posted.lines[0]!.qtyOutstandingAfter).toBe('40');
    expect(posted.totals.shortLines).toBe(1);
    expect(posted.order).toMatchObject({
      statusBefore: 'APPROVED',
      statusAfter: 'PARTIALLY_RECEIVED',
      changed: true,
    });

    const status = await manager.receiving.purchaseOrderReceiptStatus({
      purchaseOrderId: po.purchaseOrderId,
    });
    expect(status.status).toBe('PARTIALLY_RECEIVED');
    expect(status.lines[0]!.qtyReceived).toBe('60');
    expect(status.lines[0]!.qtyOutstanding).toBe('40');
    expect(status.isFullyReceived).toBe(false);

    // The rest of it turns up later, and the order completes.
    const rest = await manager.receiving.recordReceipt(
      receiptPayload({
        purchaseOrderId: po.purchaseOrderId,
        lines: [
          {
            lineNo: 1,
            purchaseOrderLineId: po.lineIds[0],
            productId: plainProductId,
            uomId: plainUomId,
            qtyReceived: '40',
            qtyStock: '40',
            unitCostE4: '250000',
          },
        ],
      }),
    );
    expect(rest.lines[0]!.variance).toBe('MATCHED');
    expect(rest.lines[0]!.qtyReceivedBefore).toBe('60');
    expect(rest.order).toMatchObject({ statusAfter: 'RECEIVED', changed: true });
  });

  it('an OVER delivery is recorded and the outstanding figure goes NEGATIVE, not clamped', async () => {
    const po = await createApprovedPo(tenantA, accountsA.userId, {
      supplierId: goodsSupplierId,
      locationId: out01,
      lines: [
        { productId: plainProductId, uomId: plainUomId, qtyOrdered: 100n, unitPriceE4: 250_000n },
      ],
    });
    const before = await onHand(ownerA, out01, plainProductId);
    const posted = await manager.receiving.recordReceipt(
      receiptPayload({
        purchaseOrderId: po.purchaseOrderId,
        lines: [
          {
            lineNo: 1,
            purchaseOrderLineId: po.lineIds[0],
            productId: plainProductId,
            uomId: plainUomId,
            qtyReceived: '112',
            qtyStock: '112',
            unitCostE4: '250000',
          },
        ],
      }),
    );
    expect(posted.lines[0]!.variance).toBe('OVER');
    expect(posted.lines[0]!.qtyOutstandingAfter).toBe('-12');
    expect(posted.totals.overLines).toBe(1);
    expect(posted.order).toMatchObject({ statusAfter: 'RECEIVED' });
    // All 112 entered the yard: the ledger records what arrived.
    expect(await onHand(ownerA, out01, plainProductId)).toBe(before + 112n);

    const status = await manager.receiving.purchaseOrderReceiptStatus({
      purchaseOrderId: po.purchaseOrderId,
    });
    expect(status.lines[0]!.qtyOutstanding).toBe('-12');
  });

  it('a SUBSTITUTE arrives as an unmatched line — recorded, flagged, and it still enters stock', async () => {
    const po = await createApprovedPo(tenantA, accountsA.userId, {
      supplierId: goodsSupplierId,
      locationId: out01,
      lines: [
        { productId: plainProductId, uomId: plainUomId, qtyOrdered: 50n, unitPriceE4: 250_000n },
      ],
    });
    const beforeRebar = await onHand(ownerA, out01, rebarId);
    const posted = await manager.receiving.recordReceipt(
      receiptPayload({
        purchaseOrderId: po.purchaseOrderId,
        lines: [
          {
            lineNo: 1,
            // No purchaseOrderLineId: nothing on the order matches this.
            productId: rebarId,
            uomId: rebarTonUomId,
            qtyReceived: '1000',
            qtyStock: mulDiv(1000n, rebarFactorNum, rebarFactorDen * 1000n, 'half-up').toString(10),
            unitCostE4: '4500000000',
          },
        ],
      }),
    );
    expect(posted.lines[0]!.variance).toBe('UNMATCHED_EXTRA');
    expect(posted.totals.unmatchedLines).toBe(1);
    // Nothing ON THE ORDER arrived, so the order does not claim otherwise.
    expect(posted.order).toMatchObject({ statusAfter: 'APPROVED', changed: false });
    expect(await onHand(ownerA, out01, rebarId)).toBeGreaterThan(beforeRebar);
  });

  it('records a receipt at a location the order did not name, and FLAGS it', async () => {
    const po = await createApprovedPo(tenantA, accountsA.userId, {
      supplierId: goodsSupplierId,
      locationId: out03,
      lines: [
        { productId: plainProductId, uomId: plainUomId, qtyOrdered: 10n, unitPriceE4: 250_000n },
      ],
    });
    const posted = await manager.receiving.recordReceipt(
      receiptPayload({
        purchaseOrderId: po.purchaseOrderId,
        locationId: out01,
        lines: [
          {
            lineNo: 1,
            purchaseOrderLineId: po.lineIds[0],
            productId: plainProductId,
            uomId: plainUomId,
            qtyReceived: '10',
            qtyStock: '10',
            unitCostE4: '250000',
          },
        ],
      }),
    );
    expect(posted.deliveredToOrderedLocation).toBe(false);
    expect(posted.locationId).toBe(out01);
  });
});

// ---------------------------------------------------------------------------
// 5. What IS refused — the things that would corrupt the ledger
// ---------------------------------------------------------------------------

describe('a receipt cannot precede its own authorisation', () => {
  it('refuses a receipt against an order that has not been approved', async () => {
    const draft = await h.db.withTenant(tenantA, async (tx) => {
      const writeId = uuidv7();
      await tx.query(
        `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
         values ($1,$2,'SERVER',$3,'test.draft_po',1,decode('00','hex'))`,
        [tenantA, writeId, h.deps.clock.next()],
      );
      const pack = await tx.query<{ c: string; m: string }>(
        `select j.currency_code as c, j.minor_units_per_major::text as m
           from platform.tenant t join platform.jurisdiction j on j.code = t.jurisdiction_code
          where t.id = app.current_tenant()`,
      );
      const id = uuidv7();
      await tx.query(
        `insert into app.purchase_order
           (tenant_id, id, write_id, hlc, supplier_id, deliver_to_location_id, status,
            order_date, currency_code, money_scale)
         values ($1,$2,$3,$4,$5,$6,'DRAFT',$7::date,$8,$9)`,
        [
          tenantA,
          id,
          writeId,
          h.deps.clock.next(),
          goodsSupplierId,
          out01,
          DAY,
          pack.rows[0]!.c,
          pack.rows[0]!.m,
        ],
      );
      return id;
    });

    await expect(
      manager.receiving.recordReceipt(receiptPayload({ purchaseOrderId: draft })),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses a receipt whose supplier is not the order’s supplier', async () => {
    const po = await createApprovedPo(tenantA, accountsA.userId, {
      supplierId: goodsSupplierId,
      locationId: out01,
      lines: [
        { productId: plainProductId, uomId: plainUomId, qtyOrdered: 10n, unitPriceE4: 250_000n },
      ],
    });
    await expect(
      manager.receiving.recordReceipt(
        receiptPayload({ purchaseOrderId: po.purchaseOrderId, supplierId: otherSupplierId }),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    // The positive control: the right supplier, same order, same lines.
    await expect(
      manager.receiving.recordReceipt(receiptPayload({ purchaseOrderId: po.purchaseOrderId })),
    ).resolves.toBeTruthy();
  });

  it('refuses two receipt lines sharing one line number', async () => {
    await expect(
      manager.receiving.recordReceipt(
        receiptPayload({
          lines: [
            {
              lineNo: 1,
              productId: plainProductId,
              uomId: plainUomId,
              qtyReceived: '1',
              qtyStock: '1',
              unitCostE4: '1',
            },
            {
              lineNo: 1,
              productId: plainProductId,
              uomId: plainUomId,
              qtyReceived: '1',
              qtyStock: '1',
              unitCostE4: '1',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// ---------------------------------------------------------------------------
// 6. Idempotency — THE double-count the constitution forbids
// ---------------------------------------------------------------------------

describe('a re-received receipt does not double-count stock', () => {
  it('the same key twice → one receipt, one movement, identical responses', async () => {
    const before = await onHand(ownerA, out01, plainProductId);
    const payload = receiptPayload({
      lines: [
        {
          lineNo: 1,
          productId: plainProductId,
          uomId: plainUomId,
          qtyReceived: '75',
          qtyStock: '75',
          unitCostE4: '250000',
        },
      ],
    });

    const first = await manager.receiving.recordReceipt(payload);
    const second = await manager.receiving.recordReceipt(payload);
    expect(second).toEqual(first); // the STORED response, replayed verbatim

    expect(await onHand(ownerA, out01, plainProductId)).toBe(before + 75n);

    const counts = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ receipts: string; lines: string; movements: string; markers: string }>(
        `select (select count(*) from app.goods_receipt where id = $1)::text as receipts,
                (select count(*) from app.goods_receipt_line where goods_receipt_id = $1)::text as lines,
                (select count(*) from app.stock_movement where source_id = $1)::text as movements,
                (select count(*) from app.write_log where id = $2)::text as markers`,
        [first.goodsReceiptId, payload.idempotencyKey],
      );
      return res.rows[0]!;
    });
    expect(counts).toEqual({ receipts: '1', lines: '1', movements: '1', markers: '1' });
  });

  it('concurrent twins of one queued receipt apply exactly once', async () => {
    const before = await onHand(ownerA, out01, plainProductId);
    const payload = receiptPayload({
      lines: [
        {
          lineNo: 1,
          productId: plainProductId,
          uomId: plainUomId,
          qtyReceived: '9',
          qtyStock: '9',
          unitCostE4: '250000',
        },
      ],
    });
    const [a, b] = await Promise.all([
      manager.receiving.recordReceipt(payload),
      manager.receiving.recordReceipt(payload),
    ]);
    expect(b).toEqual(a);
    expect(await onHand(ownerA, out01, plainProductId)).toBe(before + 9n);
  });

  it('the same key with a DIFFERENT payload applies nothing', async () => {
    const key = uuidv7();
    const before = await onHand(ownerA, out01, plainProductId);
    await manager.receiving.recordReceipt(
      receiptPayload({
        idempotencyKey: key,
        lines: [
          {
            lineNo: 1,
            productId: plainProductId,
            uomId: plainUomId,
            qtyReceived: '5',
            qtyStock: '5',
            unitCostE4: '250000',
          },
        ],
      }),
    );
    await expect(
      manager.receiving.recordReceipt(
        receiptPayload({
          idempotencyKey: key,
          lines: [
            {
              lineNo: 1,
              productId: plainProductId,
              uomId: plainUomId,
              qtyReceived: '500',
              qtyStock: '500',
              unitCostE4: '250000',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await onHand(ownerA, out01, plainProductId)).toBe(before + 5n);
  });
});

// ---------------------------------------------------------------------------
// 7. OFFLINE: the yard records it, the outbox carries it
// ---------------------------------------------------------------------------

describe('receiving is a device-uploadable operation', () => {
  it('is registered in the shared contract against the schema the router parses with', () => {
    expect(DEVICE_OP_KINDS).toContain('goods.record_receipt');
    // The SAME object, not a copy: a near-identical redeclaration is the one
    // bug class docs/phase1-status.md §0 is a ledger of.
    expect(deviceOpContracts['goods.record_receipt']).toBe(recordGoodsReceiptInput);
  });

  it('applies through POST /sync/upload, and a replayed op appends no second movement', async () => {
    const bearer = await signDevToken(JWT_SECRET, {
      tid: tenantA,
      uid: managerA.userId,
      role: 'opaque-label-nothing-branches-on',
      locs: [out01],
    });
    const key = uuidv7();
    const payload = {
      supplierId: goodsSupplierId,
      locationId: out01,
      businessDate: DAY,
      lines: [
        {
          lineNo: 1,
          productId: plainProductId,
          uomId: plainUomId,
          qtyReceived: '40',
          qtyStock: '40',
          unitCostE4: '250000',
        },
      ],
    };
    const before = await onHand(ownerA, out01, plainProductId);

    const send = async () =>
      app.inject({
        method: 'POST',
        url: '/sync/upload',
        headers: { authorization: `Bearer ${bearer}` },
        payload: { ops: [{ idempotency_key: key, kind: 'goods.record_receipt', payload }] },
      });

    const first = await send();
    expect(first.statusCode).toBe(200);
    expect(first.json<{ acks: { status: string; reason?: string }[] }>().acks[0]).toMatchObject({
      status: 'applied',
    });
    expect(await onHand(ownerA, out01, plainProductId)).toBe(before + 40n);

    // The device never saw the ack and sends the queued op again.
    const replay = await send();
    expect(replay.json<{ acks: { status: string }[] }>().acks[0]!.status).toBe('duplicate');
    expect(await onHand(ownerA, out01, plainProductId)).toBe(before + 40n);
  });

  it('an uploaded receipt from a principal without goods.receive is rejected, not applied', async () => {
    const bearer = await signDevToken(JWT_SECRET, {
      tid: tenantA,
      uid: counterA.userId,
      role: 'opaque-label-nothing-branches-on',
      locs: [out01],
    });
    const before = await onHand(ownerA, out01, plainProductId);
    const res = await app.inject({
      method: 'POST',
      url: '/sync/upload',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        ops: [
          {
            idempotency_key: uuidv7(),
            kind: 'goods.record_receipt',
            payload: {
              supplierId: goodsSupplierId,
              locationId: out01,
              businessDate: DAY,
              lines: [
                {
                  lineNo: 1,
                  productId: plainProductId,
                  uomId: plainUomId,
                  qtyReceived: '40',
                  qtyStock: '40',
                  unitCostE4: '250000',
                },
              ],
            },
          },
        ],
      },
    });
    const ack = res.json<{ acks: { status: string; reason?: string }[] }>().acks[0]!;
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toMatch(/^FORBIDDEN/);
    expect(await onHand(ownerA, out01, plainProductId)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 8. Two-tenant isolation, on every read path and the write path
// ---------------------------------------------------------------------------

describe('tenant B cannot see or touch tenant A’s receiving', () => {
  beforeAll(async () => {
    const posted = await manager.receiving.recordReceipt(receiptPayload());
    bReceiptId = posted.goodsReceiptId;
  });

  it('receiving.get on A’s receipt id answers NOT_FOUND for B', async () => {
    await expect(ownerB.receiving.get({ goodsReceiptId: bReceiptId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // The positive control: the same id, inside tenant A, resolves.
    await expect(ownerA.receiving.get({ goodsReceiptId: bReceiptId })).resolves.toBeTruthy();
  });

  it('purchaseOrderReceiptStatus on A’s order answers NOT_FOUND for B', async () => {
    const po = await createApprovedPo(tenantA, accountsA.userId, {
      supplierId: goodsSupplierId,
      locationId: out01,
      lines: [
        { productId: plainProductId, uomId: plainUomId, qtyOrdered: 10n, unitPriceE4: 250_000n },
      ],
    });
    await expect(
      ownerB.receiving.purchaseOrderReceiptStatus({ purchaseOrderId: po.purchaseOrderId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      ownerA.receiving.purchaseOrderReceiptStatus({ purchaseOrderId: po.purchaseOrderId }),
    ).resolves.toBeTruthy();
  });

  it('B cannot record a receipt against A’s supplier, order or location', async () => {
    await expect(
      ownerB.receiving.recordReceipt({
        idempotencyKey: uuidv7(),
        supplierId: goodsSupplierId,
        locationId: bTenantOutlet,
        businessDate: DAY,
        lines: [
          {
            lineNo: 1,
            productId: plainProductId,
            uomId: plainUomId,
            qtyReceived: '10',
            qtyStock: '10',
            unitCostE4: '250000',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('none of A’s receipt rows, lines or movements are visible inside B', async () => {
    const seen = await h.db.withTenant(tenantB, async (tx) => {
      const res = await tx.query<{ receipts: string; lines: string; movements: string }>(
        `select (select count(*) from app.goods_receipt)::text as receipts,
                (select count(*) from app.goods_receipt_line)::text as lines,
                (select count(*) from app.stock_movement where source_kind = 'RECEIPT')::text as movements`,
      );
      return res.rows[0]!;
    });
    expect(seen).toEqual({ receipts: '0', lines: '0', movements: '0' });
    // And A really does hold some, so the zeros above are isolation and not
    // an empty database.
    const held = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ n: string }>(`select count(*)::text as n from app.goods_receipt`);
      return Number(res.rows[0]!.n);
    });
    expect(held).toBeGreaterThan(0);
  });
});
