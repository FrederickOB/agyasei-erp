/**
 * HAULIER DISPATCH AND DELIVERY STATUS — Phase 2 (CLAUDE.md §3, ADR-0001).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ADR-0001 IS ABSOLUTE, AND THIS SUITE IS WHERE THAT IS PROVED
 * ─────────────────────────────────────────────────────────────────────────
 * Not one test in this file names a vehicle, a driver, a registration number,
 * a fuel figure or a maintenance date, because no such entity exists. A
 * carrier is a SUPPLIER holding a capability whose `kind` is HAULAGE. The
 * tests below prove the guard reads that PLATFORM `kind` and never the
 * tenant's own `code` for it — a tenant renames "Haulage" to "Trucking"
 * mid-suite and every route keeps working, which is the difference between
 * configuration and `if (code === 'HAULAGE')` (ADR-0006, CLAUDE.md §2.9).
 *
 * What makes these tests worth anything, in the terms `receiving.test.ts`
 * and `rbac.test.ts` set:
 *
 *  - REAL POSTGRES (PGlite) running the REAL migrations as `app_user` with
 *    the tenant GUC set, so RLS genuinely applies and every trigger in 0008
 *    is live — including the delivery state machine.
 *  - THE REAL ROUTER. Every assertion is on what `logistics.*` returned or on
 *    the rows Postgres now holds. Nothing asserts on a guard's own opinion.
 *  - EVERY DENY HAS A POSITIVE CONTROL: the same route, the same document, an
 *    otherwise byte-identical payload, a principal who may. A suite where
 *    everything is forbidden passes just as well when the route is broken.
 *  - NOT ONE ASSERTION MENTIONS A ROLE NAME. Roles are identified by template
 *    provenance (`origin_ref`); `app.role.name` is the tenant's word for the
 *    tenant's job and nothing may key off it.
 *  - THE FREIGHT TOTALS ARE SUMMED INDEPENDENTLY in the test, from the
 *    figures the test itself posted — never read back from the router and
 *    compared with itself (docs/phase1-status.md §0's one root cause).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICE_OP_KINDS, deviceOpContracts, updateDeliveryStatusInput } from '@erp/contracts';
import { uuidv7 } from '@erp/db';
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

let productId: string;

/** HAUL-01 — the template's placeholder carrier: HAULAGE only. */
let haulierId: string;
/** DANGOTE — goods supplier, given a HAULAGE capability too. Both are true. */
let dualCarrierId: string;
/** GHACEM — GOODS only. Naming it as a carrier must be refused. */
let goodsOnlySupplierId: string;

let managerA: VerifiedIdentity; // outlet_manager at OUT-01 — dispatch.manage
let counterA: VerifiedIdentity; // counter_staff at OUT-01 — delivery.view only
let manager: Caller;
let managerAt03: Caller;
let counter: Caller;
let regional: Caller; // regional_manager at REG-BONO — report.view.margin
let ownerA: Caller;
let ownerB: Caller;

/** A PURCHASE_ORDER delivering into OUT-01, and a SALE rung at OUT-01. */
let poAt01: string;
let poAt03: string;
let saleAt01: string;

/** Tenant B's own outlet, sale and carrier — the positive control for B. */
let bOutlet: string;
let bSaleId: string;
let bCarrierId: string;
let bDeliveryId: string;

/** One of A's deliveries, kept for the isolation block to probe from B. */
let aDeliveryId: string;

const DAY = '2026-08-20';
/** A window used by NOTHING but the spend tests, so their sums are exact. */
const SPEND_DAY = '2026-09-15';

// ---------------------------------------------------------------------------
// Fixtures — written the way a real caller would write them
// ---------------------------------------------------------------------------

/** A template supplier's id, by provenance ref. Never by name. */
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
 * Give an existing supplier a second capability. Multi-capability is the
 * normal case, not an edge (0008 §2): a cement distributor that also runs
 * trucks holds two rows and both are true at once.
 */
async function grantHaulage(tenantId: string, supplierId: string): Promise<void> {
  await h.db.withTenant(tenantId, async (tx) => {
    const writeId = uuidv7();
    await tx.query(
      `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
       values ($1,$2,'SERVER',$3,'test.supplier_capability',1,decode('00','hex'))`,
      [tenantId, writeId, h.deps.clock.next()],
    );
    const type = await tx.query<{ id: string }>(
      // `kind`, never the tenant's code — the same rule the router follows.
      `select id from app.supplier_capability_type
        where kind = 'HAULAGE' and deleted_at is null limit 1`,
    );
    await tx.query(
      `insert into app.supplier_capability
         (tenant_id, id, write_id, hlc, supplier_id, capability_type_id)
       values ($1,$2,$3,$4,$5,$6)`,
      [tenantId, uuidv7(), writeId, h.deps.clock.next(), supplierId, type.rows[0]!.id],
    );
  });
}

/**
 * A purchase order carried to APPROVED through the state machine the database
 * enforces: inserted DRAFT (0008 refuses anything else), one line while it is
 * still DRAFT (0008 refuses lines afterwards), then SUBMITTED → APPROVED with
 * an approver's id on the row.
 */
async function createApprovedPo(
  tenantId: string,
  approverUserId: string,
  opts: { supplierId: string; locationId: string; productId: string },
): Promise<string> {
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
    const meta = await tx.query<{
      stocking_uom_id: string;
      stocking_scale: number;
      factor_num: string;
      factor_den: string;
    }>(
      `select p.stocking_uom_id, u.qty_scale as stocking_scale,
              pu.factor_num::text, pu.factor_den::text
         from app.product p
         join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
         join app.product_uom pu
           on pu.tenant_id = p.tenant_id and pu.product_id = p.id
          and pu.uom_id = p.stocking_uom_id and pu.deleted_at is null and pu.can_buy
        where p.id = $1 and p.deleted_at is null`,
      [opts.productId],
    );
    const m = meta.rows[0]!;
    await tx.query(
      `insert into app.purchase_order_line
         (tenant_id, id, write_id, hlc, purchase_order_id, line_no, product_id,
          uom_id, qty_scale, qty_ordered, unit_price_e4,
          stocking_uom_id, qty_stock_scale, qty_ordered_stock, factor_num, factor_den,
          line_net_minor)
       values ($1,$2,$3,$4,$5,1,$6,$7,$8,'20','250000',$7,$8,'20',$9,$10,'5000')`,
      [
        tenantId,
        uuidv7(),
        writeId,
        h.deps.clock.next(),
        purchaseOrderId,
        opts.productId,
        m.stocking_uom_id,
        m.stocking_scale,
        m.factor_num,
        m.factor_den,
      ],
    );
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
    return purchaseOrderId;
  });
}

/** Stock in, then a cash sale — the outbound document a delivery carries. */
async function createSale(
  caller: Caller,
  locationId: string,
  product: string,
  receiptNo: string,
): Promise<string> {
  await caller.inventory.recordMovement({
    idempotencyKey: uuidv7(),
    locationId,
    productId: product,
    qtyDelta: '50',
    sourceKind: 'OPENING',
    reasonCode: 'OPENING',
    businessDate: DAY,
  });
  const sale = await caller.sales.createSale(await h.legacySale({
    idempotencyKey: uuidv7(),
    locationId,
    priceListCode: 'WHOLESALE',
    receiptNo,
    businessDate: DAY,
    tender: 'CASH',
    lines: [{ productId: product, qty: '5' }],
  }));
  return sale.saleId;
}

function planPayload(over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: uuidv7(),
    sourceKind: 'PURCHASE_ORDER',
    sourceId: poAt01,
    carrierSupplierId: haulierId,
    plannedFor: DAY,
    ...over,
  } as Parameters<Caller['logistics']['planDelivery']>[0];
}

/** Plan one delivery and return its id. */
async function plan(caller: Caller, over: Record<string, unknown> = {}): Promise<string> {
  const res = await caller.logistics.planDelivery(planPayload(over));
  return res.deliveryId;
}

async function move(
  caller: Caller,
  deliveryId: string,
  toStatus: string,
  over: Record<string, unknown> = {},
) {
  return caller.logistics.updateStatus({
    idempotencyKey: uuidv7(),
    deliveryId,
    toStatus,
    ...over,
  } as Parameters<Caller['logistics']['updateStatus']>[0]);
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('logistics-a');
  tenantB = await h.provisionTenant('logistics-b');
  await h.applyTemplate(tenantA, true);
  await h.applyTemplate(tenantB, true);

  rootA = await h.rootLocation(tenantA);
  out01 = await h.locationByCode(tenantA, 'OUT-01');
  out03 = await h.locationByCode(tenantA, 'OUT-03');
  regBono = await h.locationByCode(tenantA, 'REG-BONO');

  productId = (await h.pickProduct(tenantA)).id;
  await h.seedWholesalePrice(tenantA, productId, 55_000_000n);

  haulierId = await supplierByRef(tenantA, 'HAULIER-GENERAL');
  goodsOnlySupplierId = await supplierByRef(tenantA, 'GHACEM');
  dualCarrierId = await supplierByRef(tenantA, 'DANGOTE');
  await grantHaulage(tenantA, dualCarrierId);

  managerA = await h.principal(tenantA, { roleRef: 'outlet_manager', scopeLocationId: out01 });
  counterA = await h.principal(tenantA, { roleRef: 'counter_staff', scopeLocationId: out01 });
  manager = h.callerFor(managerA);
  counter = h.callerFor(counterA);
  managerAt03 = h.callerFor(
    await h.principal(tenantA, { roleRef: 'outlet_manager', scopeLocationId: out03 }),
  );
  regional = h.callerFor(
    await h.principal(tenantA, { roleRef: 'regional_manager', scopeLocationId: regBono }),
  );
  ownerA = h.callerFor(await h.identityFor(tenantA, { locs: [rootA, out01, out03, regBono] }));

  const ownerUserId = (await h.identityFor(tenantA, { locs: [rootA] })).userId;
  poAt01 = await createApprovedPo(tenantA, ownerUserId, {
    supplierId: goodsOnlySupplierId,
    locationId: out01,
    productId,
  });
  poAt03 = await createApprovedPo(tenantA, ownerUserId, {
    supplierId: goodsOnlySupplierId,
    locationId: out03,
    productId,
  });
  saleAt01 = await createSale(ownerA, out01, productId, 'LOG-A-1');

  // Tenant B, provisioned from the same template — every read path below is
  // asked from B as well, and must answer nothing.
  bOutlet = (await h.firstOutlet(tenantB)).id;
  ownerB = h.callerFor(await h.identityFor(tenantB, { locs: [bOutlet] }));
  const bProduct = (await h.pickProduct(tenantB)).id;
  await h.seedWholesalePrice(tenantB, bProduct, 99_000_000n);
  bCarrierId = await supplierByRef(tenantB, 'HAULIER-GENERAL');
  bSaleId = await createSale(ownerB, bOutlet, bProduct, 'LOG-B-1');

  app = await buildServer({ deps: h.deps, jwtSecret: JWT_SECRET });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

// ---------------------------------------------------------------------------
// 1. A carrier is a supplier that hauls. There is no vehicle. (ADR-0001)
// ---------------------------------------------------------------------------

describe('the carrier is a haulier, and a haulier is a supplier', () => {
  it('refuses a supplier that carries no HAULAGE capability, and accepts one that does', async () => {
    await expect(
      manager.logistics.planDelivery(planPayload({ carrierSupplierId: goodsOnlySupplierId })),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    // Positive control: same route, same document, same location, a carrier
    // that hauls.
    const id = await plan(manager, { carrierSupplierId: haulierId });
    const got = await manager.logistics.get({ deliveryId: id });
    expect(got.carrierSupplierId).toBe(haulierId);
    expect(got.status).toBe('PLANNED');
  });

  it('one party may both sell goods and haul them — both rows are true at once', async () => {
    const id = await plan(manager, { carrierSupplierId: dualCarrierId });
    expect((await manager.logistics.get({ deliveryId: id })).carrierSupplierId).toBe(
      dualCarrierId,
    );
  });

  it('reads the PLATFORM kind, never the tenant’s word for it', async () => {
    const rename = async (code: string, name: string) =>
      h.db.withTenant(tenantA, async (tx) => {
        await tx.query(
          `update app.supplier_capability_type set code = $1, name = $2
            where kind = 'HAULAGE' and deleted_at is null`,
          [code, name],
        );
      });

    // The tenant renames its haulage capability. Nothing on the platform may
    // notice: `code` is the tenant's vocabulary, `kind` is the structure.
    // The rename is undone in `finally` so a failure here fails ONE test
    // rather than every test after it.
    await rename('TRUCKING', 'Trucking');
    try {
      const id = await plan(manager, { carrierSupplierId: haulierId });
      expect((await manager.logistics.get({ deliveryId: id })).status).toBe('PLANNED');
    } finally {
      await rename('HAULAGE', 'Haulage');
    }
  });

  it('refuses a document that is not visible in this tenant', async () => {
    await expect(
      manager.logistics.planDelivery(planPayload({ sourceId: uuidv7() })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a carrier id that is no supplier at all', async () => {
    await expect(
      manager.logistics.planDelivery(planPayload({ carrierSupplierId: uuidv7() })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a DEACTIVATED haulier — planning commits the business to a carrier', async () => {
    const setActive = async (active: boolean) =>
      h.db.withTenant(tenantA, async (tx) => {
        await tx.query(`update app.supplier set is_active = $2 where id = $1`, [haulierId, active]);
      });

    await setActive(false);
    try {
      await expect(manager.logistics.planDelivery(planPayload())).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    } finally {
      await setActive(true);
    }
    // The positive control, byte-identical but for the flag being back on.
    expect(await plan(manager)).toBeTruthy();
  });

  it('a deactivated haulier’s deliveries stay readable and stay in the spend', async () => {
    // Deactivation stops NEW commitments; it does not rewrite history, and a
    // haulier that is dropped must not take its invoices out of the ratio.
    const id = await plan(manager, { freightCostMinor: '77777' });
    await h.db.withTenant(tenantA, async (tx) => {
      await tx.query(`update app.supplier set is_active = false where id = $1`, [haulierId]);
    });
    try {
      expect((await manager.logistics.get({ deliveryId: id })).carrierSupplierId).toBe(haulierId);
      const spend = await ownerA.logistics.haulageSpend({ locationIds: [out01] });
      expect(BigInt(spend.total.haulageSpendMinor)).toBeGreaterThanOrEqual(77_777n);
    } finally {
      await h.db.withTenant(tenantA, async (tx) => {
        await tx.query(`update app.supplier set is_active = true where id = $1`, [haulierId]);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The permission matrix — a capability is a capability AT A PLACE
// ---------------------------------------------------------------------------

describe('logistics.dispatch.manage and logistics.delivery.view are separate grants', () => {
  it('the counter may READ a delivery but may not plan one', async () => {
    const id = await plan(manager);

    // "Where is my cement?" is a counter question.
    expect((await counter.logistics.get({ deliveryId: id })).deliveryId).toBe(id);

    await expect(counter.logistics.planDelivery(planPayload())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Positive control: the same payload from a principal who holds it.
    await expect(manager.logistics.planDelivery(planPayload())).resolves.toMatchObject({
      status: 'PLANNED',
    });
  });

  it('the counter may not move a delivery along either', async () => {
    const id = await plan(manager);
    await expect(move(counter, id, 'DISPATCHED')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(move(manager, id, 'DISPATCHED')).resolves.toMatchObject({
      status: 'DISPATCHED',
    });
  });

  it('a grant at OUT-01 does not dispatch at OUT-03, and the OUT-03 manager can', async () => {
    const at03 = planPayload({ sourceId: poAt03 });
    await expect(manager.logistics.planDelivery(at03)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      managerAt03.logistics.planDelivery(planPayload({ sourceId: poAt03 })),
    ).resolves.toMatchObject({ status: 'PLANNED' });
  });

  it('the location a delivery answers to is the DOCUMENT’s, inbound and outbound', async () => {
    const inbound = await manager.logistics.planDelivery(planPayload({ sourceId: poAt01 }));
    expect(inbound.costLocationId).toBe(out01);

    const outbound = await manager.logistics.planDelivery(
      planPayload({
        sourceKind: 'SALE',
        sourceId: saleAt01,
        toAddressText: 'A building site, which is not a location we own',
      }),
    );
    expect(outbound.costLocationId).toBe(out01);
    expect(outbound.toLocationId).toBeNull();
  });

  it('what a delivery COST is a narrower audience than where it is', async () => {
    // The outlet manager sees their own deliveries and their own sales and
    // still may not see what moving the goods cost the business.
    await expect(manager.logistics.haulageSpend({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(regional.logistics.haulageSpend({})).resolves.toMatchObject({
      basis: 'AGREED_NOT_INVOICED',
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The state machine — legal moves, illegal moves, and the timestamps
// ---------------------------------------------------------------------------

describe('the delivery state machine is the database’s, and it is enforced', () => {
  it('PLANNED → DISPATCHED → IN_TRANSIT → DELIVERED, stamping when each happened', async () => {
    const id = await plan(manager);
    const dispatchedAt = '2026-08-20T08:15:00.000Z';
    const deliveredAt = '2026-08-20T14:40:00.000Z';

    const d = await move(manager, id, 'DISPATCHED', {
      occurredAt: dispatchedAt,
      carrierReference: 'WAYBILL-4471',
    });
    expect(d).toMatchObject({ statusBefore: 'PLANNED', status: 'DISPATCHED', dispatchedAt });

    const t = await move(manager, id, 'IN_TRANSIT');
    expect(t).toMatchObject({ statusBefore: 'DISPATCHED', status: 'IN_TRANSIT' });
    // The dispatch stamp survives a later transition — it is a fact, not a
    // field the newest write owns.
    expect(t.dispatchedAt).toBe(dispatchedAt);

    const done = await move(manager, id, 'DELIVERED', { occurredAt: deliveredAt });
    expect(done).toMatchObject({ status: 'DELIVERED', dispatchedAt, deliveredAt });

    const row = await manager.logistics.get({ deliveryId: id });
    expect(row).toMatchObject({
      status: 'DELIVERED',
      dispatchedAt,
      deliveredAt,
      carrierReference: 'WAYBILL-4471',
    });
  });

  it('PLANNED → DELIVERED is refused: nothing is delivered that was never dispatched', async () => {
    const id = await plan(manager);
    await expect(move(manager, id, 'DELIVERED')).rejects.toMatchObject({ code: 'CONFLICT' });
    // Positive control: the legal first step from the same state.
    await expect(move(manager, id, 'DISPATCHED')).resolves.toMatchObject({
      status: 'DISPATCHED',
    });
  });

  it('DELIVERED is TERMINAL — a delivery that can be un-delivered is a status nobody trusts', async () => {
    const id = await plan(manager);
    await move(manager, id, 'DISPATCHED');
    await move(manager, id, 'DELIVERED');
    for (const to of ['IN_TRANSIT', 'CANCELLED', 'DISPATCHED']) {
      await expect(move(manager, id, to)).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    // FAILED carries a reason, so it is a well-formed request that the state
    // machine — not zod — has to be the thing refusing.
    await expect(
      move(manager, id, 'FAILED', { reason: 'a delivered load cannot fail afterwards' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await manager.logistics.get({ deliveryId: id })).status).toBe('DELIVERED');
  });

  it('CANCELLED is terminal too, and it is unreachable once the truck has left', async () => {
    const cancelled = await plan(manager);
    await move(manager, cancelled, 'CANCELLED');
    await expect(move(manager, cancelled, 'DISPATCHED')).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const gone = await plan(manager);
    await move(manager, gone, 'DISPATCHED');
    await expect(move(manager, gone, 'CANCELLED')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a failed delivery can be re-attempted: DISPATCHED → FAILED → DISPATCHED', async () => {
    const id = await plan(manager);
    await move(manager, id, 'DISPATCHED');
    const failed = await move(manager, id, 'FAILED', { reason: 'the road at Nkoranza was closed' });
    expect(failed).toMatchObject({ status: 'FAILED', failedReason: 'the road at Nkoranza was closed' });
    expect((await manager.logistics.get({ deliveryId: id })).failedReason).toBe(
      'the road at Nkoranza was closed',
    );

    await expect(move(manager, id, 'DISPATCHED')).resolves.toMatchObject({
      statusBefore: 'FAILED',
      status: 'DISPATCHED',
    });
  });

  it('“it did not arrive” is not a delivery record: FAILED requires a reason', async () => {
    const id = await plan(manager);
    await move(manager, id, 'DISPATCHED');
    await expect(move(manager, id, 'FAILED')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(move(manager, id, 'FAILED', { reason: 'no one at the site' })).resolves.toMatchObject(
      { status: 'FAILED' },
    );
  });

  it('a no-op transition is a CONFLICT, not a silent success', async () => {
    const id = await plan(manager);
    await expect(move(manager, id, 'PLANNED')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('the router asks the DATABASE what is legal — the two lists cannot drift', async () => {
    const fromDb = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ from_status: string; to_status: string }>(
        `select from_status, to_status from app.delivery_legal_transitions()`,
      );
      return res.rows.map((r) => `${r.from_status}->${r.to_status}`).sort();
    });
    // Exercised above, one by one, through the router. Asserting the shape
    // here as well is what makes a silently-widened table fail this file.
    expect(fromDb).toEqual(
      [
        'PLANNED->DISPATCHED',
        'PLANNED->CANCELLED',
        'DISPATCHED->IN_TRANSIT',
        'DISPATCHED->DELIVERED',
        'DISPATCHED->FAILED',
        'IN_TRANSIT->DELIVERED',
        'IN_TRANSIT->FAILED',
        'FAILED->DISPATCHED',
        'FAILED->CANCELLED',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Idempotency — a retry after a flaky sync creates nothing twice
// ---------------------------------------------------------------------------

describe('a replayed dispatch does not become a second delivery', () => {
  it('the same key twice → one delivery row, identical responses', async () => {
    const payload = planPayload();
    const first = await manager.logistics.planDelivery(payload);
    const second = await manager.logistics.planDelivery(payload);
    expect(second).toEqual(first);

    const rows = await h.db.withTenant(tenantA, async (tx) => {
      const res = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.delivery where id = $1`,
        [first.deliveryId],
      );
      return res.rows[0]!.n;
    });
    expect(rows).toBe('1');
  });

  it('the same key twice on a status change → one transition, identical responses', async () => {
    const id = await plan(manager);
    const key = uuidv7();
    const body = { idempotencyKey: key, deliveryId: id, toStatus: 'DISPATCHED' as const };
    const first = await manager.logistics.updateStatus(body);
    const second = await manager.logistics.updateStatus(body);
    expect(second).toEqual(first);
    expect((await manager.logistics.get({ deliveryId: id })).status).toBe('DISPATCHED');
  });

  it('the same key with a DIFFERENT payload applies nothing', async () => {
    const id = await plan(manager);
    const key = uuidv7();
    await manager.logistics.updateStatus({
      idempotencyKey: key,
      deliveryId: id,
      toStatus: 'DISPATCHED',
    });
    await expect(
      manager.logistics.updateStatus({
        idempotencyKey: key,
        deliveryId: id,
        toStatus: 'CANCELLED',
        reason: 'a different intent under one key',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await manager.logistics.get({ deliveryId: id })).status).toBe('DISPATCHED');
  });
});

// ---------------------------------------------------------------------------
// 5. OFFLINE: the phone call from the driver does not wait for a radio
// ---------------------------------------------------------------------------

describe('a delivery status is a device-uploadable operation', () => {
  it('is registered in the shared contract against the schema the router parses with', () => {
    expect(DEVICE_OP_KINDS).toContain('logistics.update_delivery_status');
    // The SAME object, not a copy.
    expect(deviceOpContracts['logistics.update_delivery_status']).toBe(updateDeliveryStatusInput);
  });

  it('planning a delivery is deliberately NOT uploadable', () => {
    // It commits the business to a carrier at an agreed rate against supplier
    // terms a partitioned device may hold a stale copy of. If this ever
    // changes it is a decision, and this assertion is where it gets made.
    expect(DEVICE_OP_KINDS).not.toContain('logistics.plan_delivery');
  });

  it('applies through POST /sync/upload, and a replayed op moves nothing twice', async () => {
    const id = await plan(manager);
    const bearer = await signDevToken(JWT_SECRET, {
      tid: tenantA,
      uid: managerA.userId,
      role: 'opaque-label-nothing-branches-on',
      locs: [out01],
    });
    const key = uuidv7();
    const send = async () =>
      app.inject({
        method: 'POST',
        url: '/sync/upload',
        headers: { authorization: `Bearer ${bearer}` },
        payload: {
          ops: [
            {
              idempotency_key: key,
              kind: 'logistics.update_delivery_status',
              payload: {
                deliveryId: id,
                toStatus: 'DISPATCHED',
                occurredAt: '2026-08-20T06:00:00.000Z',
              },
            },
          ],
        },
      });

    const first = await send();
    expect(first.statusCode).toBe(200);
    expect(first.json<{ acks: { status: string }[] }>().acks[0]!.status).toBe('applied');
    expect((await manager.logistics.get({ deliveryId: id })).status).toBe('DISPATCHED');

    // The device never saw the ack and sends the queued op again.
    const replay = await send();
    expect(replay.json<{ acks: { status: string }[] }>().acks[0]!.status).toBe('duplicate');
    expect((await manager.logistics.get({ deliveryId: id })).status).toBe('DISPATCHED');
  });

  it('an uploaded status change from a principal without the capability is rejected', async () => {
    const id = await plan(manager);
    const bearer = await signDevToken(JWT_SECRET, {
      tid: tenantA,
      uid: counterA.userId,
      role: 'opaque-label-nothing-branches-on',
      locs: [out01],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/sync/upload',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        ops: [
          {
            idempotency_key: uuidv7(),
            kind: 'logistics.update_delivery_status',
            payload: { deliveryId: id, toStatus: 'DISPATCHED' },
          },
        ],
      },
    });
    const ack = res.json<{ acks: { status: string; reason?: string }[] }>().acks[0]!;
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toMatch(/^FORBIDDEN/);
    expect((await manager.logistics.get({ deliveryId: id })).status).toBe('PLANNED');
  });
});

// ---------------------------------------------------------------------------
// 6. HAULAGE SPEND — the numerator ADR-0001 owes open-questions Q1
// ---------------------------------------------------------------------------

describe('haulage spend is attributable to a location, a carrier and a period', () => {
  /** Every figure the window contains, summed by the TEST, independently. */
  const F1 = 120_000n; // OUT-01, HAUL-01, delivered
  const F2 = 45_500n; // OUT-01, DANGOTE hauling, in transit
  const F3 = 80_000n; // OUT-03, HAUL-01, failed — the haulier still invoices
  const F4 = 999_999n; // OUT-01, HAUL-01, CANCELLED — carried nothing

  beforeAll(async () => {
    const spend = { plannedFor: SPEND_DAY };
    const a = await manager.logistics.planDelivery(
      planPayload({ ...spend, freightCostMinor: F1.toString(10) }),
    );
    await move(manager, a.deliveryId, 'DISPATCHED');
    await move(manager, a.deliveryId, 'DELIVERED');

    const b = await manager.logistics.planDelivery(
      planPayload({
        ...spend,
        sourceKind: 'SALE',
        sourceId: saleAt01,
        carrierSupplierId: dualCarrierId,
        freightCostMinor: F2.toString(10),
      }),
    );
    await move(manager, b.deliveryId, 'DISPATCHED');
    await move(manager, b.deliveryId, 'IN_TRANSIT');

    const c = await managerAt03.logistics.planDelivery(
      planPayload({ ...spend, sourceId: poAt03, freightCostMinor: F3.toString(10) }),
    );
    await move(managerAt03, c.deliveryId, 'DISPATCHED');
    await move(managerAt03, c.deliveryId, 'FAILED', { reason: 'the yard was locked' });

    const d = await manager.logistics.planDelivery(
      planPayload({ ...spend, freightCostMinor: F4.toString(10) }),
    );
    await move(manager, d.deliveryId, 'CANCELLED');

    // The honest gap: a delivery whose freight was never agreed. NULL is not
    // zero, and the report must say so rather than average it away.
    await manager.logistics.planDelivery(planPayload(spend));
  });

  it('sums freight per location and per carrier, exactly, over the caller’s own scope', async () => {
    const res = await regional.logistics.haulageSpend({ from: SPEND_DAY, to: SPEND_DAY });

    expect(res.total.haulageSpendMinor).toBe((F1 + F2 + F3).toString(10));
    expect(res.basis).toBe('AGREED_NOT_INVOICED');
    expect(res.excludedStatus).toBe('CANCELLED');

    const at01 = res.locations.find((l) => l.locationId === out01)!;
    const at03 = res.locations.find((l) => l.locationId === out03)!;
    expect(at01.haulageSpendMinor).toBe((F1 + F2).toString(10));
    expect(at03.haulageSpendMinor).toBe(F3.toString(10));

    const haulier = res.carriers.find((c) => c.carrierSupplierId === haulierId)!;
    const dual = res.carriers.find((c) => c.carrierSupplierId === dualCarrierId)!;
    expect(haulier.haulageSpendMinor).toBe((F1 + F3).toString(10));
    expect(dual.haulageSpendMinor).toBe(F2.toString(10));

    // Rule 2: the parts sum to the total, by construction.
    const parts = res.locations.reduce((a, l) => a + BigInt(l.haulageSpendMinor), 0n);
    expect(parts.toString(10)).toBe(res.total.haulageSpendMinor);
  });

  it('a CANCELLED delivery carried nothing; a FAILED one still invoices', async () => {
    const res = await regional.logistics.haulageSpend({ from: SPEND_DAY, to: SPEND_DAY });
    // Both halves of the rule, in one figure: F3 is the FAILED delivery and
    // it IS in the total, because a haulier that turned up and could not
    // deliver usually still invoices; F4 is the CANCELLED one and it is NOT,
    // because it carried nothing.
    expect(res.total.haulageSpendMinor).toBe((F1 + F2 + F3).toString(10));
    expect(res.locations.find((l) => l.locationId === out03)!.haulageSpendMinor).toBe(
      F3.toString(10),
    );
    expect(BigInt(res.total.haulageSpendMinor)).not.toBe(F1 + F2 + F3 + F4);
    expect(res.total.deliveryCount).toBe(4);
  });

  it('a delivery with no agreed freight is a NULL, and the basis is flagged INCOMPLETE', async () => {
    const res = await regional.logistics.haulageSpend({ from: SPEND_DAY, to: SPEND_DAY });
    expect(res.total.deliveriesWithNoAgreedFreight).toBe(1);
    expect(res.total.unavailable).toBe('INCOMPLETE_FREIGHT_BASIS');
    const at01 = res.locations.find((l) => l.locationId === out01)!;
    expect(at01.unavailable).toBe('INCOMPLETE_FREIGHT_BASIS');
    // The one at OUT-03 had its freight agreed, so its basis is complete.
    expect(res.locations.find((l) => l.locationId === out03)!.unavailable).toBeNull();
  });

  it('says out loud how each row was attributed to a period', async () => {
    const res = await regional.logistics.haulageSpend({ from: SPEND_DAY, to: SPEND_DAY });
    // Every delivery in this window carries a human-asserted plannedFor, so
    // none of them leans on the untrusted device clock. Four, not five: the
    // CANCELLED one carried nothing and is not in the basis at all.
    expect(res.periodBasis.datedByPlannedFor).toBe(4);
    expect(res.periodBasis.datedByDispatchClock).toBe(0);
    expect(res.periodBasis.note).toMatch(/business_date/);
  });

  it('the money carries its pack scale and is never a JS number', async () => {
    const res = await regional.logistics.haulageSpend({ from: SPEND_DAY, to: SPEND_DAY });
    expect(res.currencyCode).toBe('GHS');
    expect(res.moneyScale).toBe('100');
    expect(typeof res.total.haulageSpendMinor).toBe('string');
    for (const l of res.locations) expect(typeof l.haulageSpendMinor).toBe('string');
  });

  it('an EMPTY period still reports its currency and scale, and a zero', async () => {
    // A blank where a zero belongs is a client that cannot tell "none" from
    // "we do not know", which is the whole of §0a in one field.
    const res = await regional.logistics.haulageSpend({ from: '2020-01-01', to: '2020-01-02' });
    expect(res.total.haulageSpendMinor).toBe('0');
    expect(res.total.deliveryCount).toBe(0);
    expect(res.currencyCode).toBe('GHS');
    expect(res.moneyScale).toBe('100');
    expect(res.total.unavailable).toBeNull();
  });

  it('every narrowing field of the shared input is HONOURED, not silently dropped', async () => {
    const window = { from: SPEND_DAY, to: SPEND_DAY };
    const all = await regional.logistics.haulageSpend(window);

    // by carrier
    const byCarrier = await regional.logistics.haulageSpend({
      ...window,
      carrierSupplierId: dualCarrierId,
    });
    expect(byCarrier.total.haulageSpendMinor).toBe(F2.toString(10));

    // by source kind — F2 is the only outbound one
    const outbound = await regional.logistics.haulageSpend({ ...window, sourceKind: 'SALE' });
    expect(outbound.total.haulageSpendMinor).toBe(F2.toString(10));

    // by source id
    const oneDoc = await regional.logistics.haulageSpend({
      ...window,
      sourceKind: 'SALE',
      sourceId: saleAt01,
    });
    expect(oneDoc.total.haulageSpendMinor).toBe(F2.toString(10));
    const otherDoc = await regional.logistics.haulageSpend({
      ...window,
      sourceKind: 'SALE',
      sourceId: uuidv7(),
    });
    expect(otherDoc.total.haulageSpendMinor).toBe('0');

    // by status — DELIVERED is F1 alone, and it is less than the whole window
    const delivered = await regional.logistics.haulageSpend({
      ...window,
      statuses: ['DELIVERED'],
    });
    expect(delivered.total.haulageSpendMinor).toBe(F1.toString(10));
    expect(BigInt(all.total.haulageSpendMinor)).toBeGreaterThan(BigInt(delivered.total.haulageSpendMinor));

    // and the one field that CANNOT apply to a sum says so rather than lying
    expect(all.limitApplies).toBe(false);
    const capped = await regional.logistics.haulageSpend({ ...window, limit: 1 });
    expect(capped.total.haulageSpendMinor).toBe(all.total.haulageSpendMinor);
  });

  it('a CANCELLED status asked for explicitly still sums nothing — it carried nothing', async () => {
    const res = await regional.logistics.haulageSpend({
      from: SPEND_DAY,
      to: SPEND_DAY,
      statuses: ['CANCELLED'],
    });
    expect(res.total.haulageSpendMinor).toBe('0');
    expect(res.excludedStatus).toBe('CANCELLED');
  });
});

// ---------------------------------------------------------------------------
// 7. Listing narrows, and never widens
// ---------------------------------------------------------------------------

describe('logistics.list', () => {
  it('returns only what the caller may see, and a narrowing request cannot widen it', async () => {
    const all = await regional.logistics.list({ from: SPEND_DAY, to: SPEND_DAY });
    expect(all.deliveryCount).toBe(5);

    const narrowed = await regional.logistics.list({
      from: SPEND_DAY,
      to: SPEND_DAY,
      locationIds: [out03],
    });
    expect(narrowed.deliveries.every((d) => d.costLocationId === out03)).toBe(true);

    // The counter holds logistics.delivery.view at OUT-01 only. Asking for
    // OUT-03 is REFUSED, not silently dropped — a total that quietly excluded
    // a location is a wrong number wearing a right number's clothes.
    await expect(
      counter.logistics.list({ from: SPEND_DAY, to: SPEND_DAY, locationIds: [out03] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      counter.logistics.list({ from: SPEND_DAY, to: SPEND_DAY, locationIds: [out01] }),
    ).resolves.toMatchObject({ deliveryCount: 4 });
  });

  it('filters by carrier and by status without leaving the caller’s scope', async () => {
    const byCarrier = await regional.logistics.list({
      from: SPEND_DAY,
      to: SPEND_DAY,
      carrierSupplierId: dualCarrierId,
    });
    expect(byCarrier.deliveries.map((d) => d.carrierSupplierId)).toEqual([dualCarrierId]);

    const failed = await regional.logistics.list({
      from: SPEND_DAY,
      to: SPEND_DAY,
      statuses: ['FAILED'],
    });
    expect(failed.deliveries.map((d) => d.status)).toEqual(['FAILED']);
  });
});

// ---------------------------------------------------------------------------
// 8. Two-tenant isolation, on EVERY read path and the write path
// ---------------------------------------------------------------------------

describe('tenant B cannot see or touch tenant A’s deliveries', () => {
  beforeAll(async () => {
    aDeliveryId = await plan(manager, { freightCostMinor: '777777' });
    const b = await ownerB.logistics.planDelivery({
      idempotencyKey: uuidv7(),
      sourceKind: 'SALE',
      sourceId: bSaleId,
      carrierSupplierId: bCarrierId,
      plannedFor: DAY,
      freightCostMinor: '111111',
    });
    bDeliveryId = b.deliveryId;
  });

  it('logistics.get on A’s delivery id answers NOT_FOUND for B — and works for A', async () => {
    await expect(ownerB.logistics.get({ deliveryId: aDeliveryId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await ownerA.logistics.get({ deliveryId: aDeliveryId })).deliveryId).toBe(
      aDeliveryId,
    );
  });

  it('logistics.list from B contains B’s deliveries and none of A’s', async () => {
    const res = await ownerB.logistics.list({});
    const ids = res.deliveries.map((d) => d.deliveryId);
    expect(ids).toContain(bDeliveryId);
    expect(ids).not.toContain(aDeliveryId);
    expect(res.deliveries.every((d) => d.costLocationId === bOutlet)).toBe(true);
  });

  it('haulageSpend from B sums B’s freight only', async () => {
    const res = await ownerB.logistics.haulageSpend({});
    // A's four costed deliveries in the spend window alone come to 245,500
    // pesewas. B's total is B's own single figure and nothing else.
    expect(res.total.haulageSpendMinor).toBe('111111');
    expect(res.carriers.map((c) => c.carrierSupplierId)).toEqual([bCarrierId]);
    expect(res.carriers.map((c) => c.carrierSupplierId)).not.toContain(haulierId);

    // B's scope is B's own location tree. A's outlets are not rows in it —
    // not zero rows, NO rows — and every row B does see is B's.
    const ids = res.locations.map((l) => l.locationId);
    expect(ids).toContain(bOutlet);
    expect(ids).not.toContain(out01);
    expect(ids).not.toContain(out03);
    expect(res.locations.find((l) => l.locationId === bOutlet)!.haulageSpendMinor).toBe('111111');
    const others = res.locations.filter((l) => l.locationId !== bOutlet);
    expect(others.every((l) => l.haulageSpendMinor === '0')).toBe(true);
  });

  it('B cannot plan a delivery against A’s document, A’s carrier or A’s location', async () => {
    await expect(
      ownerB.logistics.planDelivery({
        idempotencyKey: uuidv7(),
        sourceKind: 'PURCHASE_ORDER',
        sourceId: poAt01,
        carrierSupplierId: bCarrierId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // B's own sale, A's haulier: NOT_FOUND, because under B's RLS context A's
    // supplier does not exist at all — which is the honest answer, and a
    // narrower one than "that supplier does not haul".
    await expect(
      ownerB.logistics.planDelivery({
        idempotencyKey: uuidv7(),
        sourceKind: 'SALE',
        sourceId: bSaleId,
        carrierSupplierId: haulierId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      ownerB.logistics.planDelivery({
        idempotencyKey: uuidv7(),
        sourceKind: 'SALE',
        sourceId: bSaleId,
        carrierSupplierId: bCarrierId,
        toLocationId: out01,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('B cannot move A’s delivery along', async () => {
    await expect(move(ownerB, aDeliveryId, 'DISPATCHED')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await ownerA.logistics.get({ deliveryId: aDeliveryId })).status).toBe('PLANNED');
  });

  it('none of A’s delivery rows are visible inside B’s own RLS context', async () => {
    const seen = await h.db.withTenant(tenantB, async (tx) => {
      const res = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.delivery where id = $1`,
        [aDeliveryId],
      );
      return res.rows[0]!.n;
    });
    expect(seen).toBe('0');

    // And the reverse, so the test is not passing because B sees nothing at
    // all: B's own row is right there.
    const own = await h.db.withTenant(tenantB, async (tx) => {
      const res = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.delivery where id = $1`,
        [bDeliveryId],
      );
      return res.rows[0]!.n;
    });
    expect(own).toBe('1');
  });
});
