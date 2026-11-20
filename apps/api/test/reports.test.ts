/**
 * CROSS-LOCATION HQ REPORTING — the tests that make the numbers trustworthy.
 *
 * Money code, so it is tested (CLAUDE.md §2.7 category 1), and every read
 * path is proved invisible to a second tenant (category 3). Four classes of
 * assertion, and each one exists because of a specific way a report lies:
 *
 *  1. **The aggregation identity.** Σ(per-location) must equal the total
 *     EXACTLY, as bigint, at every scope. This is the bug class that
 *     misstates a book without showing a wrong-looking row: a predicate added
 *     to one query and not the other, and every figure still looks plausible.
 *     The router computes the two with independent aggregates and refuses to
 *     answer if they disagree; these tests assert the identity from the
 *     outside as well, so a future "optimisation" that sums the rows in
 *     TypeScript (making the identity vacuously true) fails here.
 *
 *  2. **Transfers are not revenue.** Moving stock between two of the tenant's
 *     own locations must not create a cedi of network revenue or a pesewa of
 *     cost of sales. Asserted by measuring before and after a real transfer.
 *
 *  3. **The permission matrix**, with a positive control beside every
 *     refusal: an outlet manager sees their outlet and NOT the network; a
 *     regional manager sees their region's outlets and not the neighbouring
 *     region's; Accounts sees the network; counter staff see nothing. Not one
 *     assertion names a role — principals are built from template provenance
 *     (`origin_ref`), because `app.role.name` is the tenant's word for the
 *     tenant's job (CLAUDE.md §2.9).
 *
 *  4. **Two-tenant isolation on every new read path.** A report that leaks
 *     another tenant's totals leaks margins, takings and stock positions
 *     without ever showing a row that looks out of place — the failure is
 *     invisible precisely because it is an aggregate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantA: string;
let tenantB: string;

let root: string;
let regionBono: string;
let out01: string; // Bono
let out03: string; // Bono
let out04: string; // Northern — deliberately in ANOTHER region
let out05: string; // Bono — the location with no cost basis
let productId: string;
let uncostedProductId: string;

let bOutlet: string;
let bProduct: string;

type Caller = ReturnType<ApiHarness['callerFor']>;
let owner: Caller;
let ownerB: Caller;

/** 5 units at GH₵55.00 on the from-2026 regime: net 27500, tax 5501. */
const SALE_NET = 27_500n;
const SALE_TOTAL = 33_001n;
/** Every costed receipt lands at GH₵40.00/unit: 4000 pesewas × 10⁴. */
const UNIT_COST_E4 = '40000000';

const FROM = '2026-08-01';
const TO = '2026-08-31';
const DAYS = 31n;

async function receive(
  caller: Caller,
  locationId: string,
  product: string,
  qty: string,
  withCost: boolean,
): Promise<void> {
  await caller.inventory.recordMovement({
    idempotencyKey: uuidv7(),
    locationId,
    productId: product,
    qtyDelta: qty,
    sourceKind: withCost ? 'RECEIPT' : 'OPENING',
    reasonCode: withCost ? 'OPENING' : 'OPENING',
    businessDate: FROM,
    ...(withCost ? { unitCostE4: UNIT_COST_E4 } : {}),
  });
}

async function sell(
  caller: Caller,
  locationId: string,
  receiptNo: string,
  opts: { customerId?: string; product?: string } = {},
): Promise<void> {
  await caller.sales.createSale(await h.legacySale({
    idempotencyKey: uuidv7(),
    locationId,
    priceListCode: 'WHOLESALE',
    receiptNo,
    businessDate: '2026-08-05',
    tender: opts.customerId === undefined ? 'CASH' : 'CREDIT',
    ...(opts.customerId === undefined ? {} : { customerId: opts.customerId }),
    lines: [{ productId: opts.product ?? productId, qty: '5' }],
  }));
}

/** Move stock between two of the tenant's own locations. Never a sale. */
async function transfer(
  caller: Caller,
  fromLocation: string,
  toLocation: string,
  qty: string,
): Promise<void> {
  await caller.inventory.recordMovement({
    idempotencyKey: uuidv7(),
    locationId: fromLocation,
    productId,
    qtyDelta: `-${qty}`,
    sourceKind: 'TRANSFER_OUT',
    reasonCode: 'TRANSFER',
    businessDate: '2026-08-10',
  });
  await caller.inventory.recordMovement({
    idempotencyKey: uuidv7(),
    locationId: toLocation,
    productId,
    qtyDelta: qty,
    sourceKind: 'TRANSFER_IN',
    reasonCode: 'TRANSFER',
    businessDate: '2026-08-10',
  });
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('reports-a');
  tenantB = await h.provisionTenant('reports-b');
  await h.applyTemplate(tenantA);
  await h.applyTemplate(tenantB);

  root = await h.rootLocation(tenantA);
  regionBono = await h.locationByCode(tenantA, 'REG-BONO');
  out01 = await h.locationByCode(tenantA, 'OUT-01');
  out03 = await h.locationByCode(tenantA, 'OUT-03');
  out04 = await h.locationByCode(tenantA, 'OUT-04');
  out05 = await h.locationByCode(tenantA, 'OUT-05');

  const products = await h.db.withTenant(tenantA, async (tx) => {
    const res = await tx.query<{ id: string }>(
      `select p.id
         from app.product p
         join app.product_uom pu on pu.tenant_id = p.tenant_id and pu.product_id = p.id
          and pu.is_default_sell and pu.deleted_at is null
         join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = pu.uom_id
        where p.deleted_at is null and p.is_sellable and p.stock_tracking = 'STOCKED'
          and u.qty_scale = 0
        order by p.sku_code limit 2`,
    );
    return res.rows.map((r) => r.id);
  });
  productId = products[0]!;
  uncostedProductId = products[1]!;
  await h.seedWholesalePrice(tenantA, productId, 55_000_000n);

  owner = h.callerFor(
    await h.identityFor(tenantA, { locs: [root, regionBono, out01, out03, out04, out05] }),
  );

  // Costed receipts: the ONLY source of a cost basis in Phase 1.
  await receive(owner, out01, productId, '100', true);
  await receive(owner, out03, productId, '60', true);
  await receive(owner, out04, productId, '50', true);
  // …and one location whose stock arrived with no cost attached at all.
  await receive(owner, out05, uncostedProductId, '30', false);

  // A credit customer, so the cash-position report has both tenders to split.
  const account = await owner.credit.openAccount({
    idempotencyKey: uuidv7(),
    newCustomer: { code: 'CUST-REPORTS', name: 'Reporting contractor' },
    termsDays: 30,
    feeRateBpPerMonth: 250,
    creditLimitMinor: '5000000',
  });

  await sell(owner, out01, 'RPT-A-1');
  await sell(owner, out01, 'RPT-A-2');
  await sell(owner, out03, 'RPT-C-1', { customerId: account.customerId });
  await sell(owner, out04, 'RPT-D-1');

  // A payment against the account — receipts that no location can claim.
  await owner.credit.recordEntry({
    idempotencyKey: uuidv7(),
    accountId: account.accountId,
    kind: 'PAYMENT',
    amountMinor: '-10000',
    businessDate: '2026-08-20',
  });

  // One transfer inside the setup, so every arithmetic assertion below is
  // already made against a network that has moved stock between its own
  // locations.
  await transfer(owner, out01, out03, '10');

  // Tenant B: its own trade, at its own outlet, with its own product.
  bOutlet = (await h.firstOutlet(tenantB)).id;
  bProduct = (await h.pickProduct(tenantB)).id;
  await h.seedWholesalePrice(tenantB, bProduct, 99_000_000n);
  ownerB = h.callerFor(await h.identityFor(tenantB, { locs: [bOutlet] }));
  await ownerB.inventory.recordMovement({
    idempotencyKey: uuidv7(),
    locationId: bOutlet,
    productId: bProduct,
    qtyDelta: '500',
    sourceKind: 'RECEIPT',
    reasonCode: 'OPENING',
    businessDate: FROM,
    unitCostE4: '90000000',
  });
  await ownerB.sales.createSale(await h.legacySale({
    idempotencyKey: uuidv7(),
    locationId: bOutlet,
    priceListCode: 'WHOLESALE',
    receiptNo: 'RPT-B-1',
    businessDate: '2026-08-05',
    tender: 'CASH',
    lines: [{ productId: bProduct, qty: '5' }],
  }));
}, 300_000);

afterAll(async () => {
  await h.close();
});

/** A principal holding exactly one template role at exactly one node. */
async function principalAt(roleRef: string, scopeLocationId: string): Promise<Caller> {
  return h.callerFor(
    await h.principal(tenantA, {
      roleRef,
      scopeLocationId,
      // Deliberately WIDER than the grant: the token could name every outlet,
      // so a refusal below is the DATABASE-resolved grant refusing, never the
      // token's `locs`. A test whose refusing control was the token would
      // prove nothing about permissions.
      locs: [root, regionBono, out01, out03, out04, out05],
    }),
  );
}

function sumBig(values: string[]): bigint {
  return values.reduce((a, v) => a + BigInt(v), 0n);
}

describe('sales by location: the aggregation identity', () => {
  it('Σ(per-location) equals the total EXACTLY, at network scope', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.salesByLocation({ from: FROM, to: TO });

    expect(r.scope.network).toBe(true);
    expect(sumBig(r.locations.map((l) => l.totalMinor))).toBe(BigInt(r.total.totalMinor));
    expect(sumBig(r.locations.map((l) => l.netRevenueMinor))).toBe(BigInt(r.total.netRevenueMinor));
    expect(sumBig(r.locations.map((l) => l.taxTotalMinor))).toBe(BigInt(r.total.taxTotalMinor));
    expect(sumBig(r.locations.map((l) => l.saleCount))).toBe(BigInt(r.total.saleCount));

    // …and the total is the arithmetic one, not merely self-consistent.
    expect(r.total.saleCount).toBe('4');
    expect(r.total.totalMinor).toBe(String(4n * SALE_TOTAL));
    expect(r.total.netRevenueMinor).toBe(String(4n * SALE_NET));
  });

  it('the identity holds at a NARROWED scope too, with a different total', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.salesByLocation({
      from: FROM,
      to: TO,
      locationIds: [out01, out03],
    });
    expect(r.scope.network).toBe(false); // narrowed: not a network figure
    expect(sumBig(r.locations.map((l) => l.totalMinor))).toBe(BigInt(r.total.totalMinor));
    expect(r.total.totalMinor).toBe(String(3n * SALE_TOTAL));
  });

  it('a location with no trade is a ZERO row, not a missing one', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.salesByLocation({ from: FROM, to: TO });
    const quiet = r.locations.find((l) => l.locationId === out05);
    // An outlet that took nothing must appear saying so. Omitting it turns
    // "this outlet is dark" into "this outlet does not exist".
    expect(quiet).toBeDefined();
    expect(quiet!.totalMinor).toBe('0');
    expect(quiet!.saleCount).toBe('0');
  });

  it('a date range outside the trading days totals to zero and still balances', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.salesByLocation({ from: '2026-09-01', to: '2026-09-30' });
    expect(r.total.totalMinor).toBe('0');
    expect(sumBig(r.locations.map((l) => l.totalMinor))).toBe(0n);
  });

  it('refuses a reversed date range rather than silently normalising it', async () => {
    const accounts = await principalAt('accounts', root);
    await expect(
      accounts.reports.salesByLocation({ from: TO, to: FROM }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('sales by day: the aggregation identity, over time', () => {
  it('Σ(days) equals the total EXACTLY, and every day in the range is a row', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.salesByDay({ from: FROM, to: TO });
    expect(r.scope.network).toBe(true);
    expect(r.series.length).toBe(31);
    expect(r.series[0]!.date).toBe(FROM);
    expect(r.series[30]!.date).toBe(TO);
    expect(sumBig(r.series.map((d) => d.totalMinor))).toBe(BigInt(r.total.totalMinor));
    expect(sumBig(r.series.map((d) => d.netRevenueMinor))).toBe(BigInt(r.total.netRevenueMinor));
    expect(sumBig(r.series.map((d) => d.saleCount))).toBe(BigInt(r.total.saleCount));
    // …and agrees with the by-location report over the same range.
    const byLoc = await accounts.reports.salesByLocation({ from: FROM, to: TO });
    expect(r.total.totalMinor).toBe(byLoc.total.totalMinor);
  });

  it('a day with no trade is a ZERO row — a dark day, not a missing one', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.salesByDay({ from: FROM, to: TO });
    const traded = r.series.find((d) => d.date === '2026-08-05');
    const quiet = r.series.find((d) => d.date === '2026-08-06');
    expect(traded!.saleCount).toBe('4');
    expect(traded!.totalMinor).toBe(String(4n * SALE_TOTAL));
    expect(quiet).toBeDefined();
    expect(quiet!.saleCount).toBe('0');
    expect(quiet!.totalMinor).toBe('0');
  });

  it('narrows with the scope, and refuses a range over 400 days', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.salesByDay({ from: FROM, to: TO, locationIds: [out01, out03] });
    expect(r.scope.network).toBe(false);
    expect(r.total.totalMinor).toBe(String(3n * SALE_TOTAL));
    await expect(
      accounts.reports.salesByDay({ from: '2026-01-01', to: '2027-12-31' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('inter-location transfers are not revenue', () => {
  it('a transfer moves stock between locations and creates no network revenue', async () => {
    const accounts = await principalAt('accounts', root);
    const before = await accounts.reports.salesByLocation({ from: FROM, to: TO });
    const stockBefore = await accounts.reports.stockOnHand({ productIds: [productId] });
    const netBefore = stockBefore.networkByProduct.find((p) => p.productId === productId)!;

    await transfer(owner, out01, out04, '7');

    const after = await accounts.reports.salesByLocation({ from: FROM, to: TO });
    const stockAfter = await accounts.reports.stockOnHand({ productIds: [productId] });
    const netAfter = stockAfter.networkByProduct.find((p) => p.productId === productId)!;

    // Revenue: byte-identical. A transfer produces no app.sale row at all.
    expect(after.total.totalMinor).toBe(before.total.totalMinor);
    expect(after.total.netRevenueMinor).toBe(before.total.netRevenueMinor);
    expect(after.total.saleCount).toBe(before.total.saleCount);

    // Stock: the network quantity is conserved, and it MOVED.
    expect(netAfter.qtyOnHand).toBe(netBefore.qtyOnHand);
    const at = (r: typeof stockAfter, loc: string): bigint => {
      const l = r.locations.find((x) => x.locationId === loc)!;
      const line = l.lines.find((x) => x.productId === productId);
      return line ? BigInt(line.qtyOnHand) : 0n;
    };
    expect(at(stockAfter, out01)).toBe(at(stockBefore, out01) - 7n);
    expect(at(stockAfter, out04)).toBe(at(stockBefore, out04) + 7n);
  });
});

describe('stock on hand is derived from the ledger', () => {
  it('per location and SKU, in the STOCKING unit, summing to the network figure', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.stockOnHand({ productIds: [productId] });

    const perLocation = r.locations.flatMap((l) =>
      l.lines.filter((x) => x.productId === productId).map((x) => BigInt(x.qtyOnHand)),
    );
    const network = BigInt(
      r.networkByProduct.find((p) => p.productId === productId)!.qtyOnHand,
    );
    expect(perLocation.reduce((a, b) => a + b, 0n)).toBe(network);

    // 210 received, 20 sold. Transfers move it around; they do not change it.
    expect(network).toBe(190n);
  });

  it('agrees with inventory.onHand, which reads the same ledger', async () => {
    const accounts = await principalAt('accounts', root);
    const report = await accounts.reports.stockOnHand({
      locationIds: [out01],
      productIds: [productId],
    });
    const single = await owner.inventory.onHand({ locationId: out01, productId });
    const line = report.locations[0]!.lines.find((x) => x.productId === productId)!;
    expect(line.qtyOnHand).toBe(single.qtyOnHand);
    expect(line.uomCode).toBe(single.uomCode);
    expect(line.qtyScale).toBe(single.qtyScale);
  });
});

describe('cash position by location, by tender', () => {
  it('splits immediate from credit settlement and balances against the sales report', async () => {
    const accounts = await principalAt('accounts', root);
    const cash = await accounts.reports.cashPosition({ from: FROM, to: TO });
    const sales = await accounts.reports.salesByLocation({ from: FROM, to: TO });

    // Three cash sales, one on account.
    expect(cash.total.immediateTenderMinor).toBe(String(3n * SALE_TOTAL));
    expect(cash.total.creditTenderMinor).toBe(String(SALE_TOTAL));
    // The two reports are independent queries over the same documents; if
    // they disagree, one of them is wrong.
    expect(cash.total.billedTotalMinor).toBe(sales.total.totalMinor);

    expect(sumBig(cash.locations.map((l) => l.immediateTenderMinor))).toBe(
      BigInt(cash.total.immediateTenderMinor),
    );
    expect(sumBig(cash.locations.map((l) => l.creditTenderMinor))).toBe(
      BigInt(cash.total.creditTenderMinor),
    );

    const credited = cash.locations.find((l) => l.locationId === out03)!;
    expect(credited.creditTenderMinor).toBe(String(SALE_TOTAL));
    expect(credited.immediateTenderMinor).toBe('0');
  });

  it('reports credit receipts ONCE, tenant-wide, never apportioned to a till', async () => {
    const accounts = await principalAt('accounts', root);
    const cash = await accounts.reports.cashPosition({ from: FROM, to: TO });
    expect(cash.unattributed.creditReceiptsMinor).toBe('10000');
    expect(cash.unattributed.reason).toMatch(/no location_id/);
    // The caveats are part of the answer: settlement is RECORDED per tender
    // now, and the drawer figures are the cash applied, not the note handed over.
    expect(cash.caveats.some((c) => /recorded per tender/.test(c))).toBe(true);
    expect(cash.caveats.some((c) => /cash applied/.test(c))).toBe(true);
  });
});

describe('inventory days and gross margin (brief §7)', () => {
  it('computes exact figures where a cost basis exists', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.inventoryDays({
      from: FROM,
      to: TO,
      locationIds: [out01, out03, out04],
    });
    expect(r.days).toBe(Number(DAYS));

    const byId = new Map(r.locations.map((l) => [l.locationId, l]));
    const a = byId.get(out01)!;
    // Received 100 @ GH₵40.00, sold 10, transferred out 17 (10 + 7 above).
    // 73 on hand × 4000 pesewas = 292,000. COGS is the 10 SOLD only —
    // the 17 transferred are still the tenant's goods.
    expect(a.stockAtCostMinor).toBe('292000');
    expect(a.cogsMinor).toBe('40000');
    expect(a.inventoryDaysE4).toBe(
      String((292_000n * DAYS * 10_000n) / 40_000n),
    );
    expect(a.unavailable).toBeNull();
    expect(a.productsMissingCostBasis).toBe(0);

    // Gross margin on this location: net revenue 2 × 27500 = 55000, COGS
    // 40000 → 15000/55000 = 27.2727…%, as percent × 10⁴ rounded half-up.
    // 15_000 × 10⁶ / 55_000 = 272_727.27… → 272727. Written out rather than
    // recomputed with the router's own expression, so a change to the
    // rounding mode fails here instead of agreeing with itself.
    expect(a.grossMarginPctE4).toBe('272727');
  });

  it('COGS counts SALE outflow only — a transfer creates no cost of sales', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.inventoryDays({
      from: FROM,
      to: TO,
      locationIds: [out01, out03, out04],
    });
    const byId = new Map(r.locations.map((l) => [l.locationId, l]));
    // OUT-01 shipped 17 units away and sold 10. If transfers counted, its
    // COGS would be 27 units × 4000 = 108,000 instead of 40,000 — and the
    // receiving outlets' COGS would be understated by the same goods.
    expect(byId.get(out01)!.cogsMinor).toBe('40000');
    expect(byId.get(out03)!.cogsMinor).toBe('20000'); // 5 sold
    expect(byId.get(out04)!.cogsMinor).toBe('20000'); // 5 sold
    expect(BigInt(r.total.cogsMinor!)).toBe(80_000n);
  });

  it('withholds the ratio — null, never zero — where the cost basis is incomplete', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.inventoryDays({ from: FROM, to: TO, locationIds: [out05] });
    const l = r.locations.find((x) => x.locationId === out05)!;

    expect(l.productsMissingCostBasis).toBe(1);
    expect(l.unavailable).toBe('INCOMPLETE_COST_BASIS');
    // The distinction this whole route exists for: absent, not zero. A zero
    // here reads as "no stock and no cost", which is a statement about the
    // business rather than about the data.
    expect(l.inventoryDaysE4).toBeNull();
    expect(l.grossMarginPctE4).toBeNull();
    expect(l.stockAtCostMinor).toBeNull();
    expect(l.cogsMinor).toBeNull();
  });

  it('withholds the NETWORK ratio when any location in scope lacks a cost basis', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.inventoryDays({ from: FROM, to: TO });
    expect(r.scope.network).toBe(true);
    expect(r.total.unavailable).toBe('INCOMPLETE_COST_BASIS');
    expect(r.total.inventoryDaysE4).toBeNull();
    expect(r.total.cogsMinor).toBeNull();
    // Revenue is still exact — it never needed a cost.
    expect(r.total.netRevenueMinor).toBe(String(4n * SALE_NET));
  });
});

describe('distribution cost as a percentage of revenue (brief §7)', () => {
  /**
   * A PERIOD WITH REVENUE AND NO HAULAGE IS ZERO, AND ZERO IS NOT "NO DATA".
   *
   * This fixture books no deliveries at all, so the numerator is genuinely
   * nothing. The route used to answer `null` here because no table recorded
   * haulage; now one does, and answering `null` would be the opposite lie —
   * "we cannot tell you" about a month in which nothing moved. The two cases
   * are separated by `deliveryCount`, not by a null: zero deliveries is a
   * fact, and deliveries whose freight was never agreed is a gap that says
   * INCOMPLETE_FREIGHT_BASIS out loud.
   */
  it('answers ZERO — not null — for a period with revenue and no deliveries', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.distributionCostRatio({ from: FROM, to: TO });

    expect(r.total.netRevenueMinor).toBe(String(4n * SALE_NET));
    expect(r.total.distributionCostMinor).toBe('0');
    expect(r.total.distributionCostPctE4).toBe('0');
    // Distinguishable from "no data": nothing was carried, and it says so.
    expect(r.total.deliveryCount).toBe(0);
    expect(r.total.deliveriesWithNoAgreedFreight).toBe(0);
    expect(r.total.unavailable).toBeNull();
    for (const l of r.locations) {
      expect(l.distributionCostMinor).toBe('0');
      expect(l.deliveryCount).toBe(0);
    }
    // The numerator is the AGREED freight, and the response says so rather
    // than letting an operational figure be read as an accounting one.
    expect(r.costBasis).toBe('AGREED_NOT_INVOICED');
    expect(r.unavailableReason).toMatch(/agreed freight/i);
  });

  it('rolls revenue up to grouping nodes, and says that they nest', async () => {
    const accounts = await principalAt('accounts', root);
    const r = await accounts.reports.distributionCostRatio({ from: FROM, to: TO });

    const bono = r.groups.find((g) => g.groupId === regionBono)!;
    // Two Bono outlets traded: OUT-01 (×2) and OUT-03 (×1).
    expect(bono.netRevenueMinor).toBe(String(3n * SALE_NET));

    const rootGroup = r.groups.find((g) => g.groupId === root)!;
    expect(rootGroup.netRevenueMinor).toBe(String(4n * SALE_NET));

    // Nested by construction: the root subtree contains the Bono subtree, so
    // the group rows deliberately do NOT sum to the network total.
    expect(r.groupsNest).toBe(true);
    expect(sumBig(r.groups.map((g) => g.netRevenueMinor))).toBeGreaterThan(
      BigInt(r.total.netRevenueMinor),
    );
  });
});

describe('the permission matrix — every refusal has a positive control', () => {
  it('counter staff hold no reporting capability and are refused every report', async () => {
    const counter = await principalAt('counter_staff', out01);
    for (const call of [
      () => counter.reports.salesByLocation({ from: FROM, to: TO }),
      () => counter.reports.stockOnHand({}),
      () => counter.reports.cashPosition({ from: FROM, to: TO }),
      () => counter.reports.inventoryDays({ from: FROM, to: TO }),
      () => counter.reports.distributionCostRatio({ from: FROM, to: TO }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // Positive control: the same principal CAN read its own outlet's stock,
    // so the refusals above are the reporting capability and not a broken
    // route or an empty fixture.
    const onHand = await counter.inventory.onHand({ locationId: out01, productId });
    expect(BigInt(onHand.qtyOnHand)).toBeGreaterThan(0n);
  });

  it('an outlet manager sees THEIR outlet, and their "total" is not the network', async () => {
    const manager = await principalAt('outlet_manager', out01);
    const r = await manager.reports.salesByLocation({ from: FROM, to: TO });

    expect(r.locations.map((l) => l.locationId)).toEqual([out01]);
    expect(r.scope.network).toBe(false);
    expect(r.total.totalMinor).toBe(String(2n * SALE_TOTAL));
    expect(sumBig(r.locations.map((l) => l.totalMinor))).toBe(BigInt(r.total.totalMinor));

    // The network total is a strictly larger number, and this principal is
    // not being shown it.
    const accounts = await principalAt('accounts', root);
    const network = await accounts.reports.salesByLocation({ from: FROM, to: TO });
    expect(BigInt(network.total.totalMinor)).toBeGreaterThan(BigInt(r.total.totalMinor));
  });

  it('an outlet manager naming another outlet is REFUSED, not quietly ignored', async () => {
    const manager = await principalAt('outlet_manager', out01);
    await expect(
      manager.reports.salesByLocation({ from: FROM, to: TO, locationIds: [out04] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Mixed: one permitted, one not. Refused as a whole — a report that
    // silently dropped the second location would answer a question nobody
    // asked with a number that looks like the answer to the one they did.
    await expect(
      manager.reports.salesByLocation({ from: FROM, to: TO, locationIds: [out01, out04] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Positive control, same route, same shape.
    const ok = await manager.reports.salesByLocation({
      from: FROM,
      to: TO,
      locationIds: [out01],
    });
    expect(ok.total.saleCount).toBe('2');
  });

  it('a grant at a REGION node expands down the closure, and stops there', async () => {
    const regional = await principalAt('regional_manager', regionBono);
    const r = await regional.reports.salesByLocation({ from: FROM, to: TO });

    const ids = r.locations.map((l) => l.locationId);
    expect(ids).toContain(out01);
    expect(ids).toContain(out03);
    expect(ids).not.toContain(out04); // Northern region
    expect(r.total.totalMinor).toBe(String(3n * SALE_TOTAL));
    expect(sumBig(r.locations.map((l) => l.totalMinor))).toBe(BigInt(r.total.totalMinor));

    // Asking for the region NODE itself resolves to its subtree.
    const byNode = await regional.reports.salesByLocation({
      from: FROM,
      to: TO,
      locationIds: [regionBono],
    });
    expect(byNode.total.totalMinor).toBe(r.total.totalMinor);

    await expect(
      regional.reports.salesByLocation({ from: FROM, to: TO, locationIds: [out04] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('cost and margin sit behind report.view.margin, which an outlet manager lacks', async () => {
    const manager = await principalAt('outlet_manager', out01);
    await expect(
      manager.reports.inventoryDays({ from: FROM, to: TO, locationIds: [out01] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      manager.reports.distributionCostRatio({ from: FROM, to: TO, locationIds: [out01] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Positive control: the same principal reads the same location's TAKINGS
    // perfectly well. The refusal is the cost, not the location.
    const takings = await manager.reports.salesByLocation({
      from: FROM,
      to: TO,
      locationIds: [out01],
    });
    expect(takings.total.totalMinor).toBe(String(2n * SALE_TOTAL));

    // …and a regional manager, who DOES hold report.view.margin, gets it.
    const regional = await principalAt('regional_manager', regionBono);
    const margin = await regional.reports.inventoryDays({
      from: FROM,
      to: TO,
      locationIds: [out01],
    });
    expect(margin.locations[0]!.cogsMinor).toBe('40000');
  });

  it('revoking the capability refuses the SAME unexpired token on the next call', async () => {
    const identity = await h.principal(tenantA, {
      roleRef: 'outlet_manager',
      scopeLocationId: out01,
      locs: [out01],
    });
    const caller = h.callerFor(identity);
    const before = await caller.reports.salesByLocation({ from: FROM, to: TO });
    expect(before.total.saleCount).toBe('2');

    await h.revokeAssignments(tenantA, identity.userId);

    // Same identity object, same signed token, no re-issue: the decision is a
    // database read per request, never a token claim.
    await expect(
      caller.reports.salesByLocation({ from: FROM, to: TO }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('report.view.tenant is a WIDENER, not a substitute — documented, and asserted', async () => {
    // Composition rule from the router header: the network report is the
    // location report widened, so the wide right presupposes the narrow one.
    // Proved by taking the narrow code away from a role that holds both.
    await h.revokePermissionFromRole(tenantB, 'accounts', 'report.view.location');
    const tenantOnly = h.callerFor(
      await h.principal(tenantB, { roleRef: 'accounts', scopeLocationId: await h.rootLocation(tenantB) }),
    );
    await expect(
      tenantOnly.reports.salesByLocation({ from: FROM, to: TO }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('two-tenant isolation on every new read path', () => {
  it('a network report contains only the caller’s own tenant', async () => {
    const accountsA = await principalAt('accounts', root);
    const a = await accountsA.reports.salesByLocation({ from: FROM, to: TO });
    // Tenant B sold 5 × GH₵99.00 — a total that appears nowhere in A's.
    expect(a.total.totalMinor).toBe(String(4n * SALE_TOTAL));
    const aIds = new Set(a.locations.map((l) => l.locationId));
    expect(aIds.has(bOutlet)).toBe(false);

    const b = await ownerB.reports.salesByLocation({ from: FROM, to: TO });
    expect(b.total.saleCount).toBe('1');
    expect(BigInt(b.total.totalMinor)).not.toBe(BigInt(a.total.totalMinor));

    // The by-day series is an aggregate too, and aggregates leak quietly.
    const aDays = await accountsA.reports.salesByDay({ from: FROM, to: TO });
    expect(aDays.total.totalMinor).toBe(String(4n * SALE_TOTAL));
    const bDays = await ownerB.reports.salesByDay({ from: FROM, to: TO });
    expect(bDays.total.saleCount).toBe('1');
    expect(sumBig(bDays.series.map((d) => d.totalMinor))).toBe(BigInt(b.total.totalMinor));
  });

  it('naming the other tenant’s location is refused on EVERY new read path', async () => {
    const accountsA = await principalAt('accounts', root);
    const probes: (() => Promise<unknown>)[] = [
      () => accountsA.reports.salesByLocation({ from: FROM, to: TO, locationIds: [bOutlet] }),
      () => accountsA.reports.salesByDay({ from: FROM, to: TO, locationIds: [bOutlet] }),
      () => accountsA.reports.stockOnHand({ locationIds: [bOutlet] }),
      () => accountsA.reports.cashPosition({ from: FROM, to: TO, locationIds: [bOutlet] }),
      () => accountsA.reports.inventoryDays({ from: FROM, to: TO, locationIds: [bOutlet] }),
      () =>
        accountsA.reports.distributionCostRatio({ from: FROM, to: TO, locationIds: [bOutlet] }),
      () => owner.inventory.lowStock({ locationIds: [bOutlet] }),
      () => owner.inventory.reorderPoints({ locationId: bOutlet }),
    ];
    for (const probe of probes) {
      await expect(probe()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // An id that exists nowhere is refused identically — a foreign location
    // and a nonexistent one must be indistinguishable, or the refusal itself
    // becomes a membership oracle for another tenant's network.
    await expect(
      accountsA.reports.salesByLocation({ from: FROM, to: TO, locationIds: [uuidv7()] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('stock and cost aggregates exclude the other tenant entirely', async () => {
    const accountsA = await principalAt('accounts', root);
    const stockA = await accountsA.reports.stockOnHand({});
    // Non-vacuity (Phase 2 gate §4.4.2): without these two lines an EMPTY
    // report passed both loops below. The exhaustive two-tenant probe for
    // this route is `[isolation:reports.stockOnHand]` in isolation-read-paths.
    expect(stockA.locations.flatMap((l) => l.lines).length).toBeGreaterThan(0);
    expect(stockA.networkByProduct.some((p) => p.productId === productId)).toBe(true);
    for (const l of stockA.locations) expect(l.locationId).not.toBe(bOutlet);
    for (const p of stockA.networkByProduct) expect(p.productId).not.toBe(bProduct);

    const cashB = await ownerB.reports.cashPosition({ from: FROM, to: TO });
    // B's own figure, on B's own price: 5 × GH₵99.00 net 49500 + tax.
    expect(BigInt(cashB.total.immediateTenderMinor)).toBeGreaterThan(0n);
    expect(cashB.total.immediateTenderMinor).not.toBe(String(3n * SALE_TOTAL));
  });
});
