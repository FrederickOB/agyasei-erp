/**
 * THE BUYING SCREENS' OWN READ PATHS, AGAINST THE REAL ROUTERS.
 *
 * `docs/phase1-status.md` §0 states the root cause of every bug in its ledger
 * once: **both sides were only ever tested against a third thing that agreed
 * with neither of them** — a fixture, a harness default, or a hand-written
 * payload. `apps/web/tests/procurement-api.test.ts` is exactly such a third
 * thing: it feeds the client's mappers JSON somebody typed, and it would keep
 * passing the day a router renamed a field.
 *
 * So this file drives the CLIENT's own modules — `data/api/procurement.ts` and
 * `data/api/logistics.ts`, the ones `features/suppliers`, `features/purchasing`
 * and `features/deliveries` import — over a real fetch-shaped call, at the real
 * Fastify routes, on real Postgres with RLS on, and compares the figures they
 * produce to rows read straight out of the database.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THIS FILE IS REALLY ABOUT
 * ---------------------------------------------------------------------------
 * The supplier comparison. Two quotes for one product in two different units
 * are not comparable numbers, and the fixture below is built so THE LARGER
 * HEADLINE FIGURE IS THE CHEAPER SOURCE. A client that rendered or re-sorted on
 * the quote rather than on the per-stocking-unit figure would pick the wrong
 * supplier, and the test would still pass if the check were vacuous — so the
 * assertions are made non-vacuously in both directions: the cheapest by the
 * common unit is asserted to be the one with the HIGHER quote.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';

// ---- the server, from apps/api's own sources -------------------------------
import { signDevToken } from '../../../apps/api/src/auth.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from '../../../apps/api/test/util.js';

// ---- the client, from apps/web's own sources -------------------------------
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../../../apps/web/src/data/api/client';
import {
  HAULAGE,
  fetchPurchaseOrder,
  fetchPurchaseOrders,
  fetchReorderSuggestions,
  fetchSourcesForProduct,
  fetchSuppliers,
} from '../../../apps/web/src/data/api/procurement';
import { fetchDeliveries } from '../../../apps/web/src/data/api/logistics';

const PWA_ORIGIN = 'http://localhost:5173';

type Server = Awaited<ReturnType<typeof buildServer>>;

let h: ApiHarness;
let app: Server;
let tenantId: string;
let outlet: { id: string; code: string };
let bearer: string;
let options: ApiCallOptions;

let productId: string;
let stockingUomId: string;
/** TONNE, scale 3, 20 stocking units to one. */
let tonneUomId: string;
/** SACK, scale 0, one to one — the stocking unit itself. */
let sackUomId: string;

let cheapBySack: string; // quotes per TONNE, the LARGER headline figure
let dearBySack: string; // quotes per SACK, the smaller headline figure
let unpricedSupplier: string;
let carrierSupplierId: string;
let purchaseOrderId: string;
let deliveryId: string;

/** A browser-shaped fetch at the real server; `app.inject()` is the socket. */
const browserFetch: ApiFetch = async (url, init) => {
  const parsed = new URL(url, 'http://api.local');
  const res = await app.inject({
    method: init.method as 'GET' | 'POST',
    url: `${parsed.pathname}${parsed.search}`,
    headers: { ...init.headers, origin: PWA_ORIGIN },
    ...(init.body === undefined ? {} : { payload: init.body }),
  });
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    json: () => Promise.resolve(res.json<unknown>()),
  };
};

const DEAD: ApiFetch = () => Promise.reject(new Error('network unreachable'));

async function newWrite(op: string): Promise<string> {
  return h.db.withTenant(tenantId, async (tx) => {
    const id = uuidv7();
    await tx.query(
      `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
       values ($1,$2,'SERVER',$3,$4,1,decode('00','hex'))`,
      [tenantId, id, h.deps.clock.next(), op],
    );
    return id;
  });
}

/**
 * A product stocked in SACKs and buyable either by the SACK or by the TONNE,
 * at twenty sacks to the tonne.
 */
async function seedCatalogue(): Promise<void> {
  const writeId = await newWrite('test.catalogue');
  await h.db.withTenant(tenantId, async (tx) => {
    const categoryId = uuidv7();
    await tx.query(
      `insert into app.product_category (tenant_id, id, write_id, hlc, code, name)
       values ($1,$2,$3,$4,$5,$5)`,
      [tenantId, categoryId, writeId, h.deps.clock.next(), `CAT-${categoryId.slice(-6)}`],
    );
    stockingUomId = uuidv7();
    sackUomId = stockingUomId;
    tonneUomId = uuidv7();
    await tx.query(
      `insert into app.unit_of_measure (tenant_id, id, write_id, hlc, code, name, dimension, qty_scale)
       values ($1,$2,$3,$4,$5,$5,'COUNT',0)`,
      [tenantId, stockingUomId, writeId, h.deps.clock.next(), `SACK-${categoryId.slice(-4)}`],
    );
    await tx.query(
      `insert into app.unit_of_measure (tenant_id, id, write_id, hlc, code, name, dimension, qty_scale)
       values ($1,$2,$3,$4,$5,$5,'MASS',3)`,
      [tenantId, tonneUomId, writeId, h.deps.clock.next(), `TONNE-${categoryId.slice(-4)}`],
    );
    productId = uuidv7();
    await tx.query(
      `insert into app.product
         (tenant_id, id, write_id, hlc, sku_code, name, category_id, stocking_uom_id, tax_code)
       values ($1,$2,$3,$4,$5,'Binder 50kg',$6,$7,'GH.VAT.STD')`,
      [tenantId, productId, writeId, h.deps.clock.next(), `SKU-${productId.slice(-6)}`, categoryId, stockingUomId],
    );
    await tx.query(
      `insert into app.product_uom
         (tenant_id, id, write_id, hlc, product_id, uom_id, factor_num, factor_den,
          can_sell, can_buy, is_default_sell, tolerance_bp, sort_order)
       values ($1,$2,$3,$4,$5,$6,1,1,true,true,true,0,0)`,
      [tenantId, uuidv7(), writeId, h.deps.clock.next(), productId, stockingUomId],
    );
    await tx.query(
      `insert into app.product_uom
         (tenant_id, id, write_id, hlc, product_id, uom_id, factor_num, factor_den,
          can_sell, can_buy, is_default_sell, tolerance_bp, sort_order)
       values ($1,$2,$3,$4,$5,$6,20,1,false,true,false,500,1)`,
      [tenantId, uuidv7(), writeId, h.deps.clock.next(), productId, tonneUomId],
    );
  });
}

async function makeSupplier(code: string, kind: 'GOODS' | 'HAULAGE'): Promise<string> {
  const writeId = await newWrite('test.supplier');
  return h.db.withTenant(tenantId, async (tx) => {
    // The tenant's OWN word for the capability. The platform `kind` is the
    // only half anything may branch on (ADR-0006).
    const capTypeId = uuidv7();
    await tx.query(
      `insert into app.supplier_capability_type (tenant_id, id, write_id, hlc, code, name, kind)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        tenantId,
        capTypeId,
        writeId,
        h.deps.clock.next(),
        `${code}-CAP`,
        kind === 'GOODS' ? 'Sells things' : 'Trucking',
        kind,
      ],
    );
    const id = uuidv7();
    const pack = await tx.query<{ currency_code: string }>(
      `select j.currency_code from platform.tenant t
         join platform.jurisdiction j on j.code = t.jurisdiction_code
        where t.id = app.current_tenant()`,
    );
    await tx.query(
      `insert into app.supplier
         (tenant_id, id, write_id, hlc, code, name, payment_terms_days, currency_code)
       values ($1,$2,$3,$4,$5,$5,30,$6)`,
      [tenantId, id, writeId, h.deps.clock.next(), code, pack.rows[0]!.currency_code],
    );
    await tx.query(
      `insert into app.supplier_capability (tenant_id, id, write_id, hlc, supplier_id, capability_type_id)
       values ($1,$2,$3,$4,$5,$6)`,
      [tenantId, uuidv7(), writeId, h.deps.clock.next(), id, capTypeId],
    );
    return id;
  });
}

async function makeSource(
  supplierId: string,
  purchaseUomId: string,
  lastPriceE4: string | null,
): Promise<void> {
  const writeId = await newWrite('test.supplier_product');
  await h.db.withTenant(tenantId, async (tx) => {
    await tx.query(
      `insert into app.supplier_product
         (tenant_id, id, write_id, hlc, supplier_id, product_id, purchase_uom_id,
          lead_time_days, last_price_e4, last_price_on)
       values ($1,$2,$3,$4,$5,$6,$7,4,$8::numeric,$9::date)`,
      [
        tenantId,
        uuidv7(),
        writeId,
        h.deps.clock.next(),
        supplierId,
        productId,
        purchaseUomId,
        lastPriceE4,
        // Never a date without a price: an "as at" with nothing behind it is
        // a fact about nothing.
        lastPriceE4 === null ? null : '2026-08-01',
      ],
    );
  });
}

async function seedOrderAndDelivery(approverUserId: string): Promise<void> {
  const writeId = await newWrite('test.order_and_delivery');
  await h.db.withTenant(tenantId, async (tx) => {
    const pack = await tx.query<{ currency_code: string; minor_units_per_major: string }>(
      `select j.currency_code, j.minor_units_per_major::text
         from platform.tenant t
         join platform.jurisdiction j on j.code = t.jurisdiction_code
        where t.id = app.current_tenant()`,
    );
    purchaseOrderId = uuidv7();
    await tx.query(
      `insert into app.purchase_order
         (tenant_id, id, write_id, hlc, supplier_id, deliver_to_location_id, status,
          order_date, currency_code, money_scale)
       values ($1,$2,$3,$4,$5,$6,'DRAFT','2026-08-20',$7,$8)`,
      [
        tenantId,
        purchaseOrderId,
        writeId,
        h.deps.clock.next(),
        cheapBySack,
        outlet.id,
        pack.rows[0]!.currency_code,
        pack.rows[0]!.minor_units_per_major,
      ],
    );
    // 2.500 tonnes at 20 sacks per tonne = 50 sacks; 1000.00 per tonne.
    await tx.query(
      `insert into app.purchase_order_line
         (tenant_id, id, write_id, hlc, purchase_order_id, line_no, product_id,
          uom_id, qty_scale, qty_ordered, unit_price_e4,
          stocking_uom_id, qty_stock_scale, qty_ordered_stock, factor_num, factor_den,
          line_net_minor)
       values ($1,$2,$3,$4,$5,1,$6,$7,3,'2500','1000000000',$8,0,'50',20,1,'250000')`,
      [
        tenantId,
        uuidv7(),
        writeId,
        h.deps.clock.next(),
        purchaseOrderId,
        productId,
        tonneUomId,
        stockingUomId,
      ],
    );
    await tx.query(
      `update app.purchase_order set status='SUBMITTED', submitted_at=transaction_timestamp()
        where id=$1`,
      [purchaseOrderId],
    );
    await tx.query(
      `update app.purchase_order
          set status='APPROVED', approved_at=transaction_timestamp(), approved_by_user_id=$2
        where id=$1`,
      [purchaseOrderId, approverUserId],
    );

    // A delivery with NO agreed freight — the honesty case ADR-0001 turns on.
    deliveryId = uuidv7();
    await tx.query(
      `insert into app.delivery
         (tenant_id, id, write_id, hlc, source_kind, source_id, carrier_supplier_id,
          status, planned_for, business_date, currency_code, money_scale)
       values ($1,$2,$3,$4,'PURCHASE_ORDER',$5,$6,'PLANNED','2026-08-24','2026-08-24',$7,$8)`,
      [
        tenantId,
        deliveryId,
        writeId,
        h.deps.clock.next(),
        purchaseOrderId,
        carrierSupplierId,
        pack.rows[0]!.currency_code,
        pack.rows[0]!.minor_units_per_major,
      ],
    );
  });
}

/** A threshold above what the ledger holds, so the alert MUST fire. */
async function seedLowStock(): Promise<void> {
  const writeId = await newWrite('test.reorder_point');
  await h.db.withTenant(tenantId, async (tx) => {
    const reason = await tx.query<{ id: string }>(
      `select id from app.movement_reason where deleted_at is null order by code limit 1`,
    );
    await tx.query(
      `insert into app.stock_movement
         (tenant_id, id, write_id, hlc, location_id, product_id, qty_delta, qty_scale,
          uom_id, reason_id, source_kind, occurred_at, business_date)
       values ($1,$2,$3,$4,$5,$6,'10',0,$7,$8,'OPENING',now(),'2026-08-20')`,
      [
        tenantId,
        uuidv7(),
        writeId,
        h.deps.clock.next(),
        outlet.id,
        productId,
        stockingUomId,
        reason.rows[0]!.id,
      ],
    );
    await tx.query(
      `insert into app.reorder_point
         (tenant_id, id, write_id, hlc, location_id, product_id, uom_id, qty_scale,
          reorder_point_qty, reorder_up_to_qty, lead_time_days)
       values ($1,$2,$3,$4,$5,$6,$7,0,'40','120',4)`,
      [
        tenantId,
        uuidv7(),
        writeId,
        h.deps.clock.next(),
        outlet.id,
        productId,
        stockingUomId,
      ],
    );
  });
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('reads-co');
  await h.applyTemplate(tenantId, true);
  outlet = await h.firstOutlet(tenantId);
  await seedCatalogue();

  cheapBySack = await makeSupplier('BULK-1', 'GOODS');
  dearBySack = await makeSupplier('BAGGED-1', 'GOODS');
  unpricedSupplier = await makeSupplier('NEW-1', 'GOODS');
  carrierSupplierId = await makeSupplier('ROAD-1', 'HAULAGE');

  // THE POINT OF THE WHOLE COMPARISON, set up so it cannot pass vacuously:
  //   BULK-1   1000.00 per TONNE → 20 sacks → 50.00 a sack   ← cheaper
  //   BAGGED-1    55.00 per SACK → one to one → 55.00 a sack  ← dearer
  // The larger headline figure is the cheaper source.
  await makeSource(cheapBySack, tonneUomId, '1000000000');
  await makeSource(dearBySack, sackUomId, '55000000');
  await makeSource(unpricedSupplier, sackUomId, null);

  const uid = '018f3a1e-0000-7000-8000-0000000000f7';
  await h.grantOwner(tenantId, uid);
  await seedOrderAndDelivery(uid);
  await seedLowStock();

  bearer = await signDevToken(JWT_SECRET, {
    tid: tenantId,
    uid,
    role: 'outlet-manager',
    locs: [outlet.id],
  });
  app = await buildServer({
    deps: h.deps,
    jwtSecret: JWT_SECRET,
    sync: { powersyncUrl: 'http://localhost:8080' },
    corsOrigins: [PWA_ORIGIN],
  });
  const endpoint: ApiEndpoint = { url: 'http://api.local', bearer };
  options = { endpoint, fetchFn: browserFetch };
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

// ---------------------------------------------------------------------------

describe("the supplier screen's own read, against the real router", () => {
  it('lists what Postgres holds, and reads the PLATFORM capability kind', async () => {
    const result = await fetchSuppliers({}, options);
    if (!result.ok) throw new Error(`expected suppliers, got ${result.failure.detail ?? ''}`);

    const fromDb = await h.db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.supplier where deleted_at is null and is_active`,
      );
      return Number(res.rows[0]!.n);
    });
    expect(result.data.suppliers.length).toBe(fromDb);
    expect(fromDb).toBeGreaterThan(1);

    // Every capability the client mapped carries a PLATFORM kind, and the
    // tenant's own code is present but never the thing anything keys off.
    for (const s of result.data.suppliers) {
      for (const c of s.capabilities) expect(['GOODS', 'HAULAGE']).toContain(c.kind);
    }
  });

  it('narrows to the carriers by kind — the client sends HAULAGE, not a tenant code', async () => {
    const result = await fetchSuppliers({ kind: HAULAGE }, options);
    if (!result.ok) throw new Error('expected the carriers');

    // Compared to the DATABASE's own answer, not to a list written here: the
    // template seeds a carrier of its own, and a hard-coded expectation would
    // have been testing the template rather than the filter.
    const fromDb = await h.db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{ id: string }>(
        `select s.id from app.supplier s
          where s.deleted_at is null and s.is_active
            and exists (
              select 1 from app.supplier_capability sc
                join app.supplier_capability_type sct
                  on sct.tenant_id = sc.tenant_id and sct.id = sc.capability_type_id
               where sc.tenant_id = s.tenant_id and sc.supplier_id = s.id
                 and sc.deleted_at is null and sct.deleted_at is null
                 and sct.kind = 'HAULAGE')
          order by s.code`,
      );
      return res.rows.map((r) => r.id);
    });
    expect([...result.data.suppliers.map((x) => x.supplierId)].sort()).toEqual([...fromDb].sort());
    // Non-vacuous in both directions: the carrier this file made is in, and
    // the goods-only suppliers it made are out.
    expect(fromDb).toContain(carrierSupplierId);
    expect(result.data.suppliers.map((x) => x.supplierId)).not.toContain(cheapBySack);
    expect(result.data.suppliers.map((x) => x.supplierId)).not.toContain(dearBySack);
  });
});

describe('the comparison: cheapest IN A COMMON UNIT, non-vacuously', () => {
  it('names the source with the LARGER quote as the cheaper one', async () => {
    const result = await fetchSourcesForProduct(productId, options);
    if (!result.ok) throw new Error(`expected sources, got ${result.failure.detail ?? ''}`);

    expect(result.data.sourceCount).toBe(3);
    expect(result.data.pricedSourceCount).toBe(2);

    const bulk = result.data.sources.find((s) => s.supplierId === cheapBySack)!;
    const bagged = result.data.sources.find((s) => s.supplierId === dearBySack)!;

    // The headline quotes: bulk's is twenty times bagged's…
    expect(bulk.lastPriceE4).toBeGreaterThan(bagged.lastPriceE4!);
    // …and per stocking unit it is the CHEAPER of the two. A client that
    // ranked on the quote would have this backwards.
    expect(bulk.pricePerStockUnitE4).toBeLessThan(bagged.pricePerStockUnitE4!);
    expect(result.data.cheapestSupplierId).toBe(cheapBySack);
    // The server's own order, preserved by the client, cheapest first.
    expect(result.data.sources[0]!.supplierId).toBe(cheapBySack);

    // The conversion crosses as the exact pair it is, never as a decimal.
    expect(bulk.stockUnitsPerPurchaseUnitNum).toBe(20n);
    expect(bulk.stockUnitsPerPurchaseUnitDen).toBe(1n);

    // …and the client's figure is the SERVER's, to the unit: 1000.00 per
    // tonne over twenty sacks is 50.00 a sack, at rate_e4 precision.
    expect(bulk.pricePerStockUnitE4).toBe(1_000_000_000n / 20n);
  });

  it('keeps an unpriced source as an ABSENCE, listed last', async () => {
    const result = await fetchSourcesForProduct(productId, options);
    if (!result.ok) throw new Error('expected sources');
    const unpriced = result.data.sources.find((s) => s.supplierId === unpricedSupplier)!;
    expect(unpriced.lastPriceE4).toBeNull();
    expect(unpriced.pricePerStockUnitE4).toBeNull();
    expect(unpriced.priceComparable).toBe(false);
    // Never a zero, and never first: a supplier we have never bought from is
    // not the cheapest source in the business.
    expect(result.data.sources[result.data.sources.length - 1]!.supplierId).toBe(unpricedSupplier);
  });
});

describe("the buying screen's own reads", () => {
  it('Σ(the client’s order totals) equals Σ(line_net_minor) in Postgres, exactly', async () => {
    const result = await fetchPurchaseOrders({ locationIds: [outlet.id] }, options);
    if (!result.ok) throw new Error(`expected orders, got ${result.failure.detail ?? ''}`);
    expect(result.data.orderCount).toBeGreaterThan(0);

    const fromDb = await h.db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{ total: string | null }>(
        `select coalesce(sum(pol.line_net_minor),0)::text as total
           from app.purchase_order_line pol
           join app.purchase_order po
             on po.tenant_id = pol.tenant_id and po.id = pol.purchase_order_id
          where po.deliver_to_location_id = $1 and pol.deleted_at is null and po.deleted_at is null`,
        [outlet.id],
      );
      return BigInt(res.rows[0]!.total ?? '0');
    });
    // An exact bigint identity between the client's mapped figure and the
    // database's own sum — two implementations, one number.
    const clientSum = result.data.orders.reduce((a, o) => a + o.totalMinor, 0n);
    expect(clientSum).toBe(fromDb);
    expect(result.data.totalMinor).toBe(clientSum);
  });

  it('carries the legal next statuses the DATABASE named, and a signed outstanding', async () => {
    const result = await fetchPurchaseOrder(purchaseOrderId, options);
    if (!result.ok) throw new Error(`expected the order, got ${result.failure.detail ?? ''}`);

    const fromDb = await h.db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{ to_status: string }>(
        `select to_status from app.purchase_order_legal_transitions()
          where from_status = 'APPROVED' order by to_status`,
      );
      return res.rows.map((r) => r.to_status);
    });
    expect([...result.data.legalNextStatuses].sort()).toEqual([...fromDb].sort());
    expect(result.data.lines).toHaveLength(1);
    expect(result.data.lines[0]!.qtyOrdered).toBe(2500n);
    expect(result.data.lines[0]!.qtyOutstanding).toBe(2500n);
    expect(result.data.totalMinor).toBe(250_000n);
  });

  it('answers the reorder suggestion NON-VACUOUSLY, tied to the Phase 1 threshold', async () => {
    const result = await fetchReorderSuggestions({ locationIds: [outlet.id] }, options);
    if (!result.ok) throw new Error(`expected suggestions, got ${result.failure.detail ?? ''}`);

    // An empty list would pass a weaker assertion and is exactly what a broken
    // client returns, so the threshold was seeded ABOVE the ledger's on-hand.
    expect(result.data.state).toBe('SUGGESTIONS');
    expect(result.data.activeThresholdCount).toBeGreaterThan(0);
    expect(result.data.suggestions.length).toBeGreaterThan(0);

    const s = result.data.suggestions.find((x) => x.productId === productId)!;
    // The alert's OWN figures, in the stocking unit: 10 on hand against a
    // threshold of 40, ordering up to 120.
    expect(s.qtyOnHand).toBe(10n);
    expect(s.reorderPointQty).toBe(40n);
    expect(s.shortfallQty).toBe(110n);
    // Two priced sources and no preferred one, so the SERVER refuses to choose
    // and hands the alternatives to a human.
    expect(s.recommendation.basis).toBe('AMBIGUOUS');
    expect(s.recommendation.qtyToOrder).toBeNull();
    expect(s.recommendation.qtyUnavailableReason).toBe('NO_SINGLE_SOURCE_TO_PRICE_IT_IN');
    expect(s.recommendation.estimatedCostMinor).toBeNull();
    expect(s.alternatives.length).toBeGreaterThan(1);
  });
});

describe("the delivery screen's own read", () => {
  it('keeps an unagreed freight as null — never a zero', async () => {
    const result = await fetchDeliveries({ locationIds: [outlet.id] }, options);
    if (!result.ok) throw new Error(`expected deliveries, got ${result.failure.detail ?? ''}`);
    const d = result.data.deliveries.find((x) => x.deliveryId === deliveryId)!;
    expect(d.carrierSupplierId).toBe(carrierSupplierId);
    expect(d.status).toBe('PLANNED');
    // ADR-0001 and open-questions Q1 turn on this figure. A zero would read as
    // a free delivery and would flatter distribution cost as % of revenue.
    expect(d.freightCostMinor).toBeNull();
  });
});

describe('offline honesty, over the same modules', () => {
  it('answers offline for every buying and delivery read, with no data at all', async () => {
    const dead: ApiCallOptions = { endpoint: { url: 'http://api.local', bearer }, fetchFn: DEAD };
    const results = await Promise.all([
      fetchSuppliers({}, dead),
      fetchSourcesForProduct(productId, dead),
      fetchPurchaseOrders({ locationIds: [outlet.id] }, dead),
      fetchPurchaseOrder(purchaseOrderId, dead),
      fetchReorderSuggestions({ locationIds: [outlet.id] }, dead),
      fetchDeliveries({ locationIds: [outlet.id] }, dead),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.failure.kind).toBe('offline');
      expect('data' in r).toBe(false);
    }
  });

  it('a refusal carries a reason and NO figures', async () => {
    // A principal with no grants at all: the server refuses from the database
    // on every request, and the client's answer has nowhere to put a zero.
    const strangerBearer = await signDevToken(JWT_SECRET, {
      tid: tenantId,
      uid: '018f3a1e-0000-7000-8000-0000000000f8',
      role: 'outlet-manager',
      locs: [outlet.id],
    });
    const stranger: ApiCallOptions = {
      endpoint: { url: 'http://api.local', bearer: strangerBearer },
      fetchFn: browserFetch,
    };
    const result = await fetchSuppliers({}, stranger);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('forbidden');
    expect(result.failure.detail).toMatch(/supplier\.view/);
    expect('data' in result).toBe(false);
  });
});
