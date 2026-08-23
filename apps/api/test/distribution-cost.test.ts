/**
 * DISTRIBUTION COST AS A PERCENTAGE OF REVENUE — the figure ADR-0001 owes
 * `docs/open-questions.md` Q1, and the tests that make it worth quoting.
 *
 * ADR-0001 dropped the owned fleet and promised, in exchange, that haulage
 * spend would sit where distribution cost as a % of revenue becomes
 * MEASURABLE per outlet and per region. The financial model tracks that ratio
 * falling 5.0% → 2.5%; Q1 is open because the mechanism behind the target
 * left with the fleet. Until this suite existed the numerator sat one router
 * away from the report and the two had never been joined.
 *
 * Money code (CLAUDE.md §2.7 category 1) and a cross-tenant read path
 * (category 3), so nothing here is asserted without being demonstrated:
 *
 *  1. **The ratio computes, and it reconciles.** Σ(per-location cost) equals
 *     the network cost exactly, as bigint, and the percentage is recomputed
 *     independently by the test rather than compared to whatever the server
 *     said. The scale is stated: percent × 10⁴, so 5.0% is 50000.
 *  2. **A warehouse's inbound freight cannot escape the numerator.** A
 *     distribution centre has no till and still pays hauliers. Scope the
 *     report to selling locations and the network ratio silently improves.
 *  3. **The region rollup sums over the tenant's own closure**, using the
 *     same `resolveGroupRollup` the sales report uses — not a second rollup,
 *     and not a sum done on a client.
 *  4. **A device clock does not decide a period.** A delivery dispatched on a
 *     tablet whose clock says next month is attributed to the business date
 *     the human asserted, and one whose business date is next month stays out
 *     of this month however early its device says it moved (03 §3.4.2).
 *  5. **Zero is not null, and "no deliveries" is not "no basis."** A location
 *     that traded and moved nothing reports 0, not null; a location whose
 *     freight was never agreed reports a FLOOR and says so.
 *  6. **Two tenants.** Every changed read path refuses the other tenant's
 *     location id, and each refusal is paired with a positive control.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { createApiHarness, type ApiHarness } from './util.js';

type Caller = ReturnType<ApiHarness['callerFor']>;

let h: ApiHarness;
let tenantA: string;
let tenantB: string;

let root: string;
let regBono: string;
let out01: string; // Bono
let out03: string; // Bono
let out04: string; // another region entirely
let warehouse: string; // Bono, no till, pays hauliers
let productId: string;
let haulierId: string;

let owner: Caller;
let ownerB: Caller;
let bOutlet: string;
let bCarrierId: string;

/** The period every figure below is measured over. Both ends inclusive. */
const FROM = '2026-09-01';
const TO = '2026-09-30';
const TRADE_DAY = '2026-09-10';
/** Deliberately OUTSIDE [FROM, TO]. Used to prove the period key is real. */
const NEXT_MONTH = '2026-10-02';

/** 5 units at GH₵55.00 wholesale: net 27500 pesewas, ex-tax, after discount. */
const SALE_NET = 27_500n;

/**
 * Freight, chosen so the arithmetic is checkable by hand as well as by the
 * test: OUT-01 is exactly 5.0% of its own revenue and OUT-03 exactly 5.0% of
 * its own, which is the top of the model's own target curve.
 */
const FREIGHT_OUT01_A = 1_500n;
const FREIGHT_OUT01_B = 1_250n; // 2750 total against 55000 revenue = 5.0%
const FREIGHT_OUT03 = 1_375n; //  1375 against 27500 revenue = 5.0%
const FREIGHT_WAREHOUSE = 5_000n; // inbound to a location with NO revenue
const COST_OUT01 = FREIGHT_OUT01_A + FREIGHT_OUT01_B;

const PCT_SCALE = 1_000_000n; // 100 (fraction → percent) × 10 000 (the E4)

/** Half-up, the same rounding rule the server states at its one boundary. */
function pctE4(costMinor: bigint, revenueMinor: bigint): bigint {
  const n = costMinor * PCT_SCALE;
  const q = n / revenueMinor;
  const r = n % revenueMinor;
  return r * 2n >= revenueMinor ? q + 1n : q;
}

const sumBig = (xs: readonly string[]): bigint => xs.reduce((a, x) => a + BigInt(x), 0n);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A template supplier by provenance ref. Never by name (CLAUDE.md §2.9). */
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
 * A WAREHOUSE under the same grouping node as OUT-01.
 *
 * The template ships no warehouse, and this report has to span one: a
 * distribution centre holds stock, has no till, and pays hauliers to fill it.
 * The location trigger rebuilds `app.location_closure`, so the region rollup
 * picks it up with no help from the test.
 */
async function createWarehouse(tenantId: string, parentId: string): Promise<string> {
  return h.db.withTenant(tenantId, async (tx) => {
    const writeId = uuidv7();
    await tx.query(
      `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
       values ($1,$2,'SERVER',$3,'test.location',1,decode('00','hex'))`,
      [tenantId, writeId, h.deps.clock.next()],
    );
    const id = uuidv7();
    await tx.query(
      `insert into app.location
         (tenant_id, id, write_id, hlc, code, name, kind, parent_id, timezone)
       values ($1,$2,$3,$4,'WH-01','Distribution centre','WAREHOUSE',$5,'Africa/Accra')`,
      [tenantId, id, writeId, h.deps.clock.next(), parentId],
    );
    return id;
  });
}

/**
 * A purchase order, in DRAFT, delivering into one location.
 *
 * A delivery only needs its document to EXIST — `app.assert_delivery()`
 * checks the referent, not its status — so this stops at the fact the test
 * needs. The order state machine is `logistics.test.ts`'s subject, not this
 * file's.
 */
async function createPurchaseOrder(tenantId: string, locationId: string): Promise<string> {
  // Resolved BEFORE the transaction opens: the test harness runs on one
  // connection, so a nested withTenant inside this callback would deadlock.
  const supplierId = await supplierByRef(tenantId, 'GHACEM');
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
    const id = uuidv7();
    await tx.query(
      `insert into app.purchase_order
         (tenant_id, id, write_id, hlc, supplier_id, deliver_to_location_id, status,
          order_date, currency_code, money_scale)
       values ($1,$2,$3,$4,$5,$6,'DRAFT',$7::date,$8,$9)`,
      [
        tenantId,
        id,
        writeId,
        h.deps.clock.next(),
        supplierId,
        locationId,
        TRADE_DAY,
        pack.rows[0]!.currency_code,
        pack.rows[0]!.minor_units_per_major,
      ],
    );
    return id;
  });
}

/** Stock in, then a cash sale — the revenue denominator, one outlet at a time. */
async function sell(caller: Caller, locationId: string, receiptNo: string): Promise<string> {
  await caller.inventory.recordMovement({
    idempotencyKey: uuidv7(),
    locationId,
    productId,
    qtyDelta: '50',
    sourceKind: 'OPENING',
    reasonCode: 'OPENING',
    businessDate: FROM,
  });
  const sale = await caller.sales.createSale({
    idempotencyKey: uuidv7(),
    locationId,
    priceListCode: 'WHOLESALE',
    receiptNo,
    businessDate: TRADE_DAY,
    tender: 'CASH',
    lines: [{ productId, qty: '5' }],
  });
  return sale.saleId;
}

/** Plan one delivery against a purchase order, with an asserted trading day. */
async function haul(
  caller: Caller,
  locationId: string,
  opts: { freightCostMinor?: bigint; businessDate?: string; plannedFor?: string; tenantId?: string },
): Promise<string> {
  const sourceId = await createPurchaseOrder(opts.tenantId ?? tenantA, locationId);
  const res = await caller.logistics.planDelivery({
    idempotencyKey: uuidv7(),
    sourceKind: 'PURCHASE_ORDER',
    sourceId,
    carrierSupplierId: opts.tenantId === undefined ? haulierId : bCarrierId,
    ...(opts.businessDate === undefined ? {} : { businessDate: opts.businessDate }),
    ...(opts.plannedFor === undefined ? {} : { plannedFor: opts.plannedFor }),
    ...(opts.freightCostMinor === undefined
      ? {}
      : { freightCostMinor: opts.freightCostMinor.toString(10) }),
  });
  return res.deliveryId;
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('dist-a');
  tenantB = await h.provisionTenant('dist-b');
  await h.applyTemplate(tenantA);
  await h.applyTemplate(tenantB);

  root = await h.rootLocation(tenantA);
  regBono = await h.locationByCode(tenantA, 'REG-BONO');
  out01 = await h.locationByCode(tenantA, 'OUT-01');
  out03 = await h.locationByCode(tenantA, 'OUT-03');
  out04 = await h.locationByCode(tenantA, 'OUT-04');
  warehouse = await createWarehouse(tenantA, regBono);
  haulierId = await supplierByRef(tenantA, 'HAULIER-GENERAL');

  const product = await h.pickProduct(tenantA);
  productId = product.id;
  await h.seedWholesalePrice(tenantA, productId, 55_000_000n);

  owner = h.callerFor(
    await h.identityFor(tenantA, { locs: [root, regBono, out01, out03, out04, warehouse] }),
  );

  // ── The denominator: three outlets trade, the warehouse does not. ────────
  await sell(owner, out01, 'DC-A-1');
  await sell(owner, out01, 'DC-A-2');
  await sell(owner, out03, 'DC-C-1');
  await sell(owner, out04, 'DC-D-1');

  // ── The numerator. Every trading day is ASSERTED, never inferred. ────────
  await haul(owner, out01, { freightCostMinor: FREIGHT_OUT01_A, businessDate: TRADE_DAY });
  await haul(owner, out01, { freightCostMinor: FREIGHT_OUT01_B, businessDate: TRADE_DAY });
  await haul(owner, out03, { freightCostMinor: FREIGHT_OUT03, businessDate: TRADE_DAY });
  // A location with no till still pays hauliers.
  await haul(owner, warehouse, { freightCostMinor: FREIGHT_WAREHOUSE, businessDate: TRADE_DAY });
  // A delivery whose freight was never agreed: NULL, and never a zero.
  await haul(owner, out03, { businessDate: TRADE_DAY });
  // Booked inside the period on a device, but the trading day is next month.
  await haul(owner, out01, { freightCostMinor: 900_000n, businessDate: NEXT_MONTH });

  // ── Tenant B: its own outlet, sale, carrier and freight. ─────────────────
  bOutlet = (await h.firstOutlet(tenantB)).id;
  bCarrierId = await supplierByRef(tenantB, 'HAULIER-GENERAL');
  const bProduct = await h.pickProduct(tenantB);
  ownerB = h.callerFor(await h.identityFor(tenantB, { locs: [bOutlet] }));
  await h.seedWholesalePrice(tenantB, bProduct.id, 99_000_000n);
  await ownerB.inventory.recordMovement({
    idempotencyKey: uuidv7(),
    locationId: bOutlet,
    productId: bProduct.id,
    qtyDelta: '50',
    sourceKind: 'OPENING',
    reasonCode: 'OPENING',
    businessDate: FROM,
  });
  await ownerB.sales.createSale({
    idempotencyKey: uuidv7(),
    locationId: bOutlet,
    priceListCode: 'WHOLESALE',
    receiptNo: 'DC-B-1',
    businessDate: TRADE_DAY,
    tender: 'CASH',
    lines: [{ productId: bProduct.id, qty: '5' }],
  });
  await haul(ownerB, bOutlet, {
    tenantId: tenantB,
    freightCostMinor: 777_777n,
    businessDate: TRADE_DAY,
  });
});

// ---------------------------------------------------------------------------
// 1. The ratio itself — numerator, denominator, scale, and the identity
// ---------------------------------------------------------------------------

describe('distribution cost as a % of revenue is computable, and it adds up', () => {
  it('returns a real ratio per location, on the stated scale', async () => {
    const r = await owner.reports.distributionCostRatio({ from: FROM, to: TO });

    const at01 = r.locations.find((l) => l.locationId === out01)!;
    expect(at01.netRevenueMinor).toBe(String(2n * SALE_NET));
    // The next-month delivery is NOT here: 900000 would swamp this figure.
    expect(at01.distributionCostMinor).toBe(COST_OUT01.toString(10));
    // 2750 / 55000 = 5.0% exactly — the top of the model's target curve.
    expect(at01.distributionCostPctE4).toBe('50000');
    expect(at01.distributionCostPctE4).toBe(pctE4(COST_OUT01, 2n * SALE_NET).toString(10));

    const at03 = r.locations.find((l) => l.locationId === out03)!;
    expect(at03.distributionCostMinor).toBe(FREIGHT_OUT03.toString(10));
    expect(at03.distributionCostPctE4).toBe('50000');
  });

  it('Σ(per-location) reconciles to the network figure, exactly, as bigint', async () => {
    const r = await owner.reports.distributionCostRatio({ from: FROM, to: TO });

    const partsCost = sumBig(r.locations.map((l) => l.distributionCostMinor!));
    const partsRevenue = sumBig(r.locations.map((l) => l.netRevenueMinor));
    expect(partsCost.toString(10)).toBe(r.total.distributionCostMinor);
    expect(partsRevenue.toString(10)).toBe(r.total.netRevenueMinor);

    // …and the network figures are the ones a human would compute by hand.
    const networkCost = COST_OUT01 + FREIGHT_OUT03 + FREIGHT_WAREHOUSE;
    const networkRevenue = 4n * SALE_NET;
    expect(r.total.distributionCostMinor).toBe(networkCost.toString(10));
    expect(r.total.netRevenueMinor).toBe(networkRevenue.toString(10));
    expect(r.total.distributionCostPctE4).toBe(pctE4(networkCost, networkRevenue).toString(10));
    // 9125 / 110000 = 8.2954…% → 82955 at E4, half-up at the one boundary.
    expect(r.total.distributionCostPctE4).toBe('82955');
  });

  it('every figure crosses the wire as a decimal string, never a JS number', async () => {
    const r = await owner.reports.distributionCostRatio({ from: FROM, to: TO });
    expect(typeof r.total.distributionCostMinor).toBe('string');
    expect(typeof r.total.distributionCostPctE4).toBe('string');
    expect(typeof r.total.netRevenueMinor).toBe('string');
    expect(r.costBasis).toBe('AGREED_NOT_INVOICED');
  });

  /**
   * A DISTRIBUTION CENTRE HAS NO TILL AND STILL PAYS HAULIERS.
   *
   * If this report spanned only selling locations, the warehouse's inbound
   * freight would vanish from the numerator while every cedi of revenue
   * stayed in the denominator — 3.75% instead of 8.30%, and the ratio would
   * improve by being measured wrongly.
   */
  it('a warehouse’s inbound freight is in the network numerator', async () => {
    const r = await owner.reports.distributionCostRatio({ from: FROM, to: TO });
    const wh = r.locations.find((l) => l.locationId === warehouse)!;
    expect(wh.kind).toBe('WAREHOUSE');
    expect(wh.distributionCostMinor).toBe(FREIGHT_WAREHOUSE.toString(10));
    expect(wh.netRevenueMinor).toBe('0');
    // A percentage of nothing is undefined, not zero — and it says so, while
    // still reporting the cost it really bore.
    expect(wh.distributionCostPctE4).toBeNull();
    expect(wh.unavailable).toBe('NO_REVENUE_IN_PERIOD');

    const withoutWarehouse =
      BigInt(r.total.distributionCostMinor) - BigInt(wh.distributionCostMinor);
    expect(pctE4(withoutWarehouse, BigInt(r.total.netRevenueMinor)).toString(10)).toBe('37500');
  });
});

// ---------------------------------------------------------------------------
// 2. Per region — over the tenant's own closure, and only once
// ---------------------------------------------------------------------------

describe('the region rollup sums over the location closure', () => {
  it('a grouping node’s cost is the sum of its members’, and nests', async () => {
    const r = await owner.reports.distributionCostRatio({ from: FROM, to: TO });

    const bono = r.groups.find((g) => g.groupId === regBono)!;
    const members = new Set([out01, out03, warehouse]);
    const memberCost = sumBig(
      r.locations.filter((l) => members.has(l.locationId)).map((l) => l.distributionCostMinor!),
    );
    const memberRevenue = sumBig(
      r.locations.filter((l) => members.has(l.locationId)).map((l) => l.netRevenueMinor),
    );
    expect(bono.distributionCostMinor).toBe(memberCost.toString(10));
    expect(bono.netRevenueMinor).toBe(memberRevenue.toString(10));
    expect(bono.distributionCostPctE4).toBe(pctE4(memberCost, memberRevenue).toString(10));

    // The root node is a grouping node too, and it holds the whole network.
    const rootGroup = r.groups.find((g) => g.groupId === root)!;
    expect(rootGroup.distributionCostMinor).toBe(r.total.distributionCostMinor);
    expect(rootGroup.netRevenueMinor).toBe(r.total.netRevenueMinor);

    // These NEST — OUT-01 is under Bono AND under the root — so the group
    // rows deliberately do NOT sum to the network total.
    expect(r.groupsNest).toBe(true);
    expect(sumBig(r.groups.map((g) => g.distributionCostMinor!))).toBeGreaterThan(
      BigInt(r.total.distributionCostMinor),
    );
  });

  it('the spend report rolls up to the SAME regions, from the same rollup', async () => {
    const spend = await owner.logistics.haulageSpend({ from: FROM, to: TO });
    const ratio = await owner.reports.distributionCostRatio({ from: FROM, to: TO });

    const spendBono = spend.groups.find((g) => g.groupId === regBono)!;
    const ratioBono = ratio.groups.find((g) => g.groupId === regBono)!;
    // One numerator, published twice. If these ever disagree, two screens are
    // quoting different answers for the same month.
    expect(spendBono.haulageSpendMinor).toBe(ratioBono.distributionCostMinor);
    expect(spend.total.haulageSpendMinor).toBe(ratio.total.distributionCostMinor);
    // The same rollup, so the same membership — including the warehouse the
    // template does not ship, which only the closure knows about.
    expect(spendBono.locationCount).toBe(ratioBono.locationCount);
    expect(spendBono.locationCount).toBeGreaterThanOrEqual(3);
    expect(spend.groups.map((g) => g.groupId).sort()).toEqual(
      ratio.groups.map((g) => g.groupId).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. A device clock does not decide a period
// ---------------------------------------------------------------------------

describe('period attribution is the business date, never a device clock', () => {
  it('a delivery whose device clock disagrees lands on its business_date', async () => {
    // Booked with an asserted trading day inside the period, then DISPATCHED
    // with an `occurredAt` a month late — exactly the tablet whose clock is
    // wrong. `dispatched_at` moves; the money does not.
    const id = await haul(owner, out04, {
      freightCostMinor: 4_000n,
      businessDate: TRADE_DAY,
      plannedFor: NEXT_MONTH,
    });
    await owner.logistics.updateStatus({
      idempotencyKey: uuidv7(),
      deliveryId: id,
      toStatus: 'DISPATCHED',
      occurredAt: '2026-11-17T23:55:00.000Z',
    });

    const r = await owner.reports.distributionCostRatio({ from: FROM, to: TO });
    const at04 = r.locations.find((l) => l.locationId === out04)!;
    expect(at04.distributionCostMinor).toBe('4000');
    expect(at04.deliveryCount).toBe(1);

    // The device observation is still recorded — it is display and forensics,
    // and discarding it would be its own kind of dishonesty.
    const delivery = await owner.logistics.get({ deliveryId: id });
    expect(delivery.businessDate).toBe(TRADE_DAY);
    expect(delivery.dispatchedAt).toMatch(/^2026-11-17/);
    // `plannedFor` said next month and the asserted date beat it.
    expect(delivery.plannedFor).toBe(NEXT_MONTH);
    expect(delivery.businessDateDerivedFrom).toBeNull();
  });

  it('a delivery whose business date is next month stays out of this month', async () => {
    const r = await owner.reports.distributionCostRatio({ from: FROM, to: TO });
    // The 900000-pesewa delivery booked in the fixture with a NEXT_MONTH
    // trading day. If the period key were `dispatched_at` or `created_at` it
    // would be here, and OUT-01's 5.0% would read as 1640%.
    expect(BigInt(r.total.distributionCostMinor)).toBeLessThan(900_000n);

    const next = await owner.reports.distributionCostRatio({
      from: NEXT_MONTH,
      to: '2026-10-31',
    });
    expect(next.total.distributionCostMinor).toBe('900000');
  });

  it('says how every row in the answer got its trading day', async () => {
    const r = await owner.reports.distributionCostRatio({ from: FROM, to: TO });
    // Every delivery in this fixture asserted its own date, so none of them
    // leans on anything — least of all the untrusted device clock.
    expect(r.periodBasis.datedByDispatchClock).toBe(0);
    expect(r.periodBasis.datedByAssertion).toBe(r.total.deliveryCount);
    expect(r.periodBasis.note).toMatch(/business_date/);
  });

  it('a delivery with no asserted date falls back to plannedFor, and records it', async () => {
    const id = await haul(owner, out01, { freightCostMinor: 10n, plannedFor: TRADE_DAY });
    const delivery = await owner.logistics.get({ deliveryId: id });
    expect(delivery.businessDate).toBe(TRADE_DAY);
    expect(delivery.businessDateDerivedFrom).toBe('PLANNED_FOR');
    const r = await owner.logistics.haulageSpend({ from: FROM, to: TO });
    expect(r.periodBasis.datedByPlannedFor).toBe(1);
    expect(r.periodBasis.datedByDispatchClock).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Zero is a fact; a missing basis is a gap; the two are told apart
// ---------------------------------------------------------------------------

describe('zero is not null, and no deliveries is not no basis', () => {
  it('a delivery with no agreed freight makes the sum a FLOOR, and says so', async () => {
    const r = await owner.reports.distributionCostRatio({ from: FROM, to: TO });
    const at03 = r.locations.find((l) => l.locationId === out03)!;
    // Two deliveries; one of them never had its freight agreed. The reported
    // cost is what IS known, and the row refuses to be read as complete.
    expect(at03.deliveryCount).toBe(2);
    expect(at03.deliveriesWithNoAgreedFreight).toBe(1);
    expect(at03.unavailable).toBe('INCOMPLETE_FREIGHT_BASIS');
    // The unknown freight was NOT averaged, defaulted or guessed at zero.
    expect(at03.distributionCostMinor).toBe(FREIGHT_OUT03.toString(10));
    expect(r.total.unavailable).toBe('INCOMPLETE_FREIGHT_BASIS');
  });

  it('a period with revenue and no deliveries is 0.0%, not "unknown"', async () => {
    // A window in which OUT-01 traded nothing and nothing was carried.
    const quiet = await owner.reports.distributionCostRatio({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(quiet.total.distributionCostMinor).toBe('0');
    expect(quiet.total.deliveryCount).toBe(0);
    // No revenue either, so the percentage is undefined rather than zero —
    // and the reason names WHICH half is missing.
    expect(quiet.total.distributionCostPctE4).toBeNull();
    expect(quiet.total.unavailable).toBe('NO_REVENUE_IN_PERIOD');

    // …whereas a location that traded and moved nothing really is at zero.
    const traded = await owner.reports.distributionCostRatio({ from: FROM, to: TO });
    const at04 = traded.locations.find((l) => l.locationId === out04)!;
    expect(BigInt(at04.netRevenueMinor)).toBeGreaterThan(0n);
    expect(at04.distributionCostMinor).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. The permission model — the same one every other margin figure uses
// ---------------------------------------------------------------------------

describe('the ratio is guarded like every other cost figure', () => {
  it('counter staff are refused both routes; accounts are not', async () => {
    const counter = h.callerFor(
      await h.principal(tenantA, { roleRef: 'counter_staff', scopeLocationId: out01 }),
    );
    await expect(
      counter.reports.distributionCostRatio({ from: FROM, to: TO }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(counter.logistics.haulageSpend({ from: FROM, to: TO })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // Positive control: the refusals above are the capability, not a broken
    // route — the same principal can still look up its own outlet's stock.
    await expect(counter.inventory.lowStock({ locationIds: [out01] })).resolves.toBeDefined();

    const accounts = h.callerFor(
      await h.principal(tenantA, { roleRef: 'accounts', scopeLocationId: root }),
    );
    const r = await accounts.reports.distributionCostRatio({ from: FROM, to: TO });
    expect(r.scope.network).toBe(true);
  });

  it('a regional grant sees its own region and not the network', async () => {
    const regional = h.callerFor(
      await h.principal(tenantA, { roleRef: 'regional_manager', scopeLocationId: regBono }),
    );
    const r = await regional.reports.distributionCostRatio({ from: FROM, to: TO });
    expect(r.scope.network).toBe(false);
    expect(r.locations.some((l) => l.locationId === out04)).toBe(false);
    // Its total is its own region's, not the network's — a different figure,
    // and labelled as a narrower scope rather than passed off as the total.
    const wide = await owner.reports.distributionCostRatio({ from: FROM, to: TO });
    expect(BigInt(r.total.netRevenueMinor)).toBeLessThan(BigInt(wide.total.netRevenueMinor));
  });
});

// ---------------------------------------------------------------------------
// 6. Two tenants — every refusal with a positive control beside it
// ---------------------------------------------------------------------------

describe('two-tenant isolation on the new and changed read paths', () => {
  it('naming the other tenant’s location is refused on both routes', async () => {
    for (const probe of [
      () => owner.reports.distributionCostRatio({ from: FROM, to: TO, locationIds: [bOutlet] }),
      () => owner.logistics.haulageSpend({ from: FROM, to: TO, locationIds: [bOutlet] }),
      () => ownerB.reports.distributionCostRatio({ from: FROM, to: TO, locationIds: [out01] }),
      () => ownerB.logistics.haulageSpend({ from: FROM, to: TO, locationIds: [warehouse] }),
    ]) {
      await expect(probe()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // Positive control: the ids are REAL, and each tenant reads its own.
    await expect(
      owner.reports.distributionCostRatio({ from: FROM, to: TO, locationIds: [out01] }),
    ).resolves.toBeDefined();
    await expect(
      ownerB.reports.distributionCostRatio({ from: FROM, to: TO, locationIds: [bOutlet] }),
    ).resolves.toBeDefined();
  });

  it('neither tenant’s freight appears in the other’s network figure', async () => {
    const a = await owner.reports.distributionCostRatio({ from: FROM, to: TO });
    const b = await ownerB.reports.distributionCostRatio({ from: FROM, to: TO });

    // B's freight is 777777 — a figure that appears nowhere in A's answer.
    expect(b.total.distributionCostMinor).toBe('777777');
    expect(BigInt(a.total.distributionCostMinor)).toBeLessThan(777_777n);
    for (const l of a.locations) expect(l.distributionCostMinor).not.toBe('777777');

    const aIds = new Set(a.locations.map((l) => l.locationId));
    expect(aIds.has(bOutlet)).toBe(false);
    const bIds = new Set(b.locations.map((l) => l.locationId));
    for (const id of [out01, out03, out04, warehouse]) expect(bIds.has(id)).toBe(false);

    // …and the same holds on the spend route the numerator comes from.
    const spendA = await owner.logistics.haulageSpend({ from: FROM, to: TO });
    const spendB = await ownerB.logistics.haulageSpend({ from: FROM, to: TO });
    expect(spendA.total.haulageSpendMinor).toBe(a.total.distributionCostMinor);
    expect(spendB.total.haulageSpendMinor).toBe('777777');
    expect(spendA.carriers.map((c) => c.carrierSupplierId)).not.toContain(bCarrierId);
  });
});
