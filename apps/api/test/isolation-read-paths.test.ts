/**
 * EVERY QUERY PROCEDURE, TWO TENANTS — Phase 1 acceptance criterion 5,
 * demonstrated rather than asserted (CLAUDE.md §2.7 category 3).
 *
 * Each `[isolation:<procedure>]` test below is the registered two-tenant test
 * for that procedure (see `isolation-sweep.test.ts`, which fails the suite if
 * any query procedure mounted on `appRouter` has none). Every probe makes the
 * same three claims, and each claim is made in a form that CAN fail:
 *
 *  1. NON-VACUITY. Tenant B really holds the rows this procedure reads — read
 *     as the operator, with an explicit `tenant_id = B` predicate, so RLS is
 *     not the thing producing the count. And tenant A's own answer is
 *     non-empty: a probe whose caller sees nothing at all proves nothing.
 *  2. ABSENCE, EXACTLY. Nothing of tenant B's — no id from any of B's tables,
 *     no B marker string — appears anywhere in A's answer; and every
 *     aggregate equals A's figure computed independently (operator SQL,
 *     explicit tenant predicate), which B's conspicuous amounts would skew.
 *  3. NO EXISTENCE ORACLE. Naming one of B's ids answers EXACTLY as an id that
 *     exists nowhere: same code, same message, same body, with the probed id
 *     itself scrubbed (echoing the caller's own input back is not a leak).
 *
 * Isolation failures are thrown as `IsolationBreach` (isolation-world.ts).
 * The final describe block removes the RLS backstop — plus, for paths that
 * carry a second control, the second failure they need — and shows every
 * probe goes red WITH an IsolationBreach, not an incidental error. A control
 * is not a control until something has been shown to depend on it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHarness, type ApiHarness } from './util.js';
import {
  FROM,
  IsolationBreach,
  SPEC_A,
  SPEC_B,
  TO,
  assertSameAsNonexistent,
  breachUnless,
  buildTenantWorld,
  idUniverse,
  leakDetector,
  type LeakDetector,
  type TenantWorld,
} from './isolation-world.js';

let h: ApiHarness;
let A: TenantWorld;
let B: TenantWorld;
let clean: LeakDetector;

beforeAll(async () => {
  h = await createApiHarness();
  A = await buildTenantWorld(h, SPEC_A);
  B = await buildTenantWorld(h, SPEC_B);
  const aIds = await idUniverse(h, A.tenantId);
  const bIds = await idUniverse(h, B.tenantId);
  // The detector is only as good as the disjointness of the two universes.
  const shared = [...bIds].filter((id) => aIds.has(id));
  if (shared.length > 0) throw new Error(`fixture: the tenants share ids: ${shared.slice(0, 3).join(', ')}`);
  if (bIds.size < 500) throw new Error(`fixture: tenant B owns only ${bIds.size} ids — not a real world`);
  clean = leakDetector(bIds, [SPEC_B.marker, `${SPEC_B.marker} Holdings Ltd`]);
}, 600_000);

afterAll(async () => {
  await h?.close();
});

// ---------------------------------------------------------------------------
// Operator-side truth: explicit tenant predicates, RLS not involved.
// ---------------------------------------------------------------------------

async function admin(sql: string, params: unknown[]): Promise<string> {
  const res = await h.db.asAdmin((tx) => tx.query<{ v: string }>(sql, params));
  return res.rows[0]!.v;
}

async function adminIds(sql: string, params: unknown[]): Promise<string[]> {
  const res = await h.db.asAdmin((tx) => tx.query<{ id: string }>(sql, params));
  return res.rows.map((r) => r.id).sort();
}

/** Tenant B really has rows here, or the probe below would be vacuous. */
async function bHolds(label: string, sql: string, params: unknown[] = []): Promise<void> {
  const n = BigInt(await admin(sql, [B.tenantId, ...params]));
  if (n <= 0n) throw new Error(`non-vacuity: tenant B holds nothing for ${label} — the probe would prove nothing`);
}

const salesTotal = (t: string) =>
  admin(
    `select coalesce(sum(total_minor), 0)::text as v from app.sale
      where tenant_id = $1 and business_date between $2::date and $3::date`,
    [t, FROM, TO],
  );
const netRevenue = (t: string) =>
  admin(
    `select coalesce(sum(subtotal_net_minor - discount_minor), 0)::text as v from app.sale
      where tenant_id = $1 and business_date between $2::date and $3::date`,
    [t, FROM, TO],
  );
const saleCount = (t: string) =>
  admin(
    `select count(*)::text as v from app.sale
      where tenant_id = $1 and business_date between $2::date and $3::date`,
    [t, FROM, TO],
  );

function exactly(label: string, actual: string | number | bigint, expected: string | number | bigint): void {
  breachUnless(
    String(actual) === String(expected),
    `${label}: tenant A's figure is ${String(actual)}, A's own data says ${String(expected)}`,
  );
}

// ---------------------------------------------------------------------------
// The probes — one per query procedure, keyed by its router path.
// ---------------------------------------------------------------------------

const probes: Record<string, () => Promise<void>> = {
  // ── catalogue ────────────────────────────────────────────────────────────
  'catalogue.list': async () => {
    await bHolds('products', `select count(*)::text as v from app.product where tenant_id = $1`);
    const seen: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await A.owner.catalogue.list({ limit: 200, offset });
      clean.assertClean('catalogue.list', page);
      seen.push(...page.products.map((p) => p.productId));
      if (page.products.length < 200) break;
    }
    const own = await adminIds(
      `select id::text as id from app.product where tenant_id = $1 and deleted_at is null`,
      [A.tenantId],
    );
    exactly('catalogue.list product count', seen.length, own.length);
    expect(seen.sort()).toEqual(own);
  },

  'catalogue.search': async () => {
    await bHolds('B marker product', `select count(*)::text as v from app.product where tenant_id = $1 and id = $2`, [
      B.markerProductId,
    ]);
    const own = await A.owner.catalogue.search({ q: SPEC_A.marker });
    expect(own.products.map((p) => p.productId)).toEqual([A.markerProductId]);
    const foreign = await A.owner.catalogue.search({ q: SPEC_B.marker });
    breachUnless(foreign.products.length === 0, `catalogue.search: tenant B's product found by tenant A`);
    // A wide search — every term matches across both catalogues.
    const wide = await A.owner.catalogue.search({ q: 'a', limit: 200 });
    expect(wide.products.length).toBeGreaterThan(0);
    clean.assertClean('catalogue.search', wide);
  },

  'catalogue.detail': async () => {
    // POSITIVE CONTROL — the line the Phase 2 gate found missing. Without it,
    // a stub that always threw NOT_FOUND passed this probe.
    const own = await A.owner.catalogue.detail({ productId: A.markerProductId });
    expect(own.productId).toBe(A.markerProductId);
    expect(own.name).toBe(`${SPEC_A.marker} Coupling`);
    const priced = await A.owner.catalogue.detail({ productId: A.productId, onDate: '2026-08-05' });
    expect(priced.prices.length).toBeGreaterThan(0);
    clean.assertClean('catalogue.detail', [own, priced]);

    await bHolds('B product', `select count(*)::text as v from app.product where tenant_id = $1 and id = $2`, [
      B.productId,
    ]);
    for (const foreign of [B.productId, B.markerProductId]) {
      const answer = await assertSameAsNonexistent('catalogue.detail', clean, foreign, (id) =>
        A.owner.catalogue.detail({ productId: id }),
      );
      expect(answer).toBe('refused NOT_FOUND: product not found');
    }
  },

  // ── credit ───────────────────────────────────────────────────────────────
  'credit.accountForCustomer': async () => {
    const own = await A.owner.credit.accountForCustomer({ customerId: A.customerId });
    expect(own.accountId).toBe(A.accountId);
    await bHolds('B account', `select count(*)::text as v from app.customer_account where tenant_id = $1 and customer_id = $2`, [
      B.customerId,
    ]);
    await assertSameAsNonexistent('credit.accountForCustomer', clean, B.customerId, (id) =>
      A.owner.credit.accountForCustomer({ customerId: id }),
    );
  },

  'credit.exposure': async () => {
    const own = await A.owner.credit.exposure({ accountId: A.accountId });
    const expected = await admin(
      `select coalesce(sum(amount_minor), 0)::text as v from app.credit_entry where tenant_id = $1 and account_id = $2`,
      [A.tenantId, A.accountId],
    );
    exactly('credit.exposure', own.exposureMinor, expected);
    clean.assertClean('credit.exposure', own);
    await bHolds('B credit entries', `select count(*)::text as v from app.credit_entry where tenant_id = $1`);
    await assertSameAsNonexistent('credit.exposure', clean, B.accountId, (id) =>
      A.owner.credit.exposure({ accountId: id }),
    );
  },

  'credit.ageing': async () => {
    const own = await A.owner.credit.ageing({ accountId: A.accountId, asOf: TO });
    clean.assertClean('credit.ageing', own);
    expect(JSON.stringify(own)).toContain(A.accountId);
    await assertSameAsNonexistent('credit.ageing', clean, B.accountId, (id) =>
      A.owner.credit.ageing({ accountId: id, asOf: TO }),
    );
  },

  'credit.previewFacilityFee': async () => {
    const own = await A.owner.credit.previewFacilityFee({ accountId: A.accountId, asOf: TO });
    expect(own.accountId).toBe(A.accountId);
    clean.assertClean('credit.previewFacilityFee', own);
    await assertSameAsNonexistent('credit.previewFacilityFee', clean, B.accountId, (id) =>
      A.owner.credit.previewFacilityFee({ accountId: id, asOf: TO }),
    );
  },

  // ── inventory ────────────────────────────────────────────────────────────
  'inventory.onHand': async () => {
    const own = await A.owner.inventory.onHand({ locationId: A.outletId, productId: A.productId });
    const expected = await admin(
      `select coalesce(sum(qty_delta), 0)::text as v from app.stock_movement
        where tenant_id = $1 and location_id = $2 and product_id = $3`,
      [A.tenantId, A.outletId, A.productId],
    );
    exactly('inventory.onHand', own.qtyOnHand, expected);
    await bHolds('B stock', `select count(*)::text as v from app.stock_movement where tenant_id = $1`);
    // B's product, asked at A's OWN outlet — where A is unquestionably
    // permitted, so only the tenant boundary can refuse it.
    await assertSameAsNonexistent('inventory.onHand (B product)', clean, B.productId, (id) =>
      A.owner.inventory.onHand({ locationId: A.outletId, productId: id }),
    );
    await assertSameAsNonexistent('inventory.onHand (B location)', clean, B.outletId, (id) =>
      A.owner.inventory.onHand({ locationId: id, productId: A.productId }),
    );
  },

  'inventory.reorderPoints': async () => {
    const own = await A.owner.inventory.reorderPoints({ locationId: A.outletId });
    expect(own.points.some((p) => p.productId === A.productId)).toBe(true);
    clean.assertClean('inventory.reorderPoints', own);
    await bHolds('B reorder points', `select count(*)::text as v from app.reorder_point where tenant_id = $1`);
    await assertSameAsNonexistent('inventory.reorderPoints', clean, B.outletId, (id) =>
      A.owner.inventory.reorderPoints({ locationId: id }),
    );
  },

  'inventory.lowStock': async () => {
    const own = await A.owner.inventory.lowStock({});
    expect(own.alerts.some((a) => a.productId === A.productId)).toBe(true);
    clean.assertClean('inventory.lowStock', own);
    await assertSameAsNonexistent('inventory.lowStock', clean, B.outletId, (id) =>
      A.owner.inventory.lowStock({ locationIds: [id] }),
    );
  },

  // ── ledger ───────────────────────────────────────────────────────────────
  'ledger.trialBalance': async () => {
    await bHolds('B journal', `select count(*)::text as v from app.journal_line where tenant_id = $1`);
    const tb = await A.owner.ledger.trialBalance({ byLocation: true });
    const expected = await admin(
      `select coalesce(sum(jl.debit_minor), 0)::text as v
         from app.journal_line jl
         join app.journal_entry je on je.tenant_id = jl.tenant_id and je.id = jl.journal_entry_id
        where jl.tenant_id = $1 and je.status = 'posted'`,
      [A.tenantId],
    );
    expect(BigInt(expected)).toBeGreaterThan(0n);
    exactly('ledger.trialBalance debit', tb.debitMinor, expected);
    clean.assertClean('ledger.trialBalance', tb);
    await assertSameAsNonexistent('ledger.trialBalance', clean, B.outletId, (id) =>
      A.owner.ledger.trialBalance({ locationIds: [id] }),
    );
  },

  'ledger.profitAndLoss': async () => {
    const pl = await A.owner.ledger.profitAndLoss({});
    exactly('ledger.profitAndLoss revenue', pl.revenueMinor, SPEC_A.glRevenueMinor);
    exactly('ledger.profitAndLoss expense', pl.expenseMinor, SPEC_A.glRevenueMinor / 2n);
    clean.assertClean('ledger.profitAndLoss', pl);
    await assertSameAsNonexistent('ledger.profitAndLoss', clean, B.outletId, (id) =>
      A.owner.ledger.profitAndLoss({ locationIds: [id] }),
    );
  },

  'ledger.balanceSheet': async () => {
    const bs = await A.owner.ledger.balanceSheet({});
    exactly('ledger.balanceSheet result', bs.resultMinor, SPEC_A.glRevenueMinor - SPEC_A.glRevenueMinor / 2n);
    expect(bs.reconciles).toBe(true);
    clean.assertClean('ledger.balanceSheet', bs);
    await assertSameAsNonexistent('ledger.balanceSheet', clean, B.outletId, (id) =>
      A.owner.ledger.balanceSheet({ locationIds: [id] }),
    );
  },

  'ledger.postingExceptions': async () => {
    await bHolds('B exceptions', `select count(*)::text as v from app.posting_exception where tenant_id = $1`);
    const ex = await A.owner.ledger.postingExceptions({ includeResolved: true, limit: 500 });
    const own = await adminIds(`select id::text as id from app.posting_exception where tenant_id = $1`, [A.tenantId]);
    expect(own.length).toBeGreaterThan(0);
    clean.assertClean('ledger.postingExceptions', ex);
    exactly('ledger.postingExceptions count', ex.exceptions.length, own.length);
  },

  // ── logistics ────────────────────────────────────────────────────────────
  'logistics.get': async () => {
    const own = await A.owner.logistics.get({ deliveryId: A.deliveryId });
    expect(own.deliveryId).toBe(A.deliveryId);
    clean.assertClean('logistics.get', own);
    await bHolds('B delivery', `select count(*)::text as v from app.delivery where tenant_id = $1`);
    await assertSameAsNonexistent('logistics.get', clean, B.deliveryId, (id) =>
      A.owner.logistics.get({ deliveryId: id }),
    );
  },

  'logistics.list': async () => {
    const list = await A.owner.logistics.list({ limit: 500 });
    const own = await adminIds(`select id::text as id from app.delivery where tenant_id = $1`, [A.tenantId]);
    clean.assertClean('logistics.list', list);
    expect(list.deliveries.map((d) => d.deliveryId).sort()).toEqual(own);
    await assertSameAsNonexistent('logistics.list (B carrier)', clean, B.haulierId, (id) =>
      A.owner.logistics.list({ carrierSupplierId: id }),
    );
    await assertSameAsNonexistent('logistics.list (B source)', clean, B.purchaseOrderId, (id) =>
      A.owner.logistics.list({ sourceId: id }),
    );
  },

  'logistics.haulageSpend': async () => {
    const spend = await A.owner.logistics.haulageSpend({ from: FROM, to: TO });
    const expected = await admin(
      `select coalesce(sum(freight_cost_minor), 0)::text as v from app.delivery
        where tenant_id = $1 and business_date between $2::date and $3::date`,
      [A.tenantId, FROM, TO],
    );
    exactly('logistics.haulageSpend freight', spend.total.haulageSpendMinor, expected);
    exactly('logistics.haulageSpend freight is A’s', expected, SPEC_A.freightMinor);
    clean.assertClean('logistics.haulageSpend', spend);
    await assertSameAsNonexistent('logistics.haulageSpend', clean, B.outletId, (id) =>
      A.owner.logistics.haulageSpend({ from: FROM, to: TO, locationIds: [id] }),
    );
  },

  // ── procurement ──────────────────────────────────────────────────────────
  'procurement.listSuppliers': async () => {
    const list = await A.owner.procurement.listSuppliers({ includeInactive: true, limit: 500 });
    const own = await adminIds(
      `select id::text as id from app.supplier where tenant_id = $1 and deleted_at is null`,
      [A.tenantId],
    );
    expect(own.length).toBeGreaterThan(0);
    clean.assertClean('procurement.listSuppliers', list);
    expect(list.suppliers.map((s) => s.supplierId).sort()).toEqual(own);
  },

  'procurement.suppliersForProduct': async () => {
    const own = await A.owner.procurement.suppliersForProduct({ productId: A.productId, includeInactive: true });
    clean.assertClean('procurement.suppliersForProduct', own);
    await assertSameAsNonexistent('procurement.suppliersForProduct', clean, B.productId, (id) =>
      A.owner.procurement.suppliersForProduct({ productId: id }),
    );
  },

  'procurement.purchaseOrder': async () => {
    const own = await A.owner.procurement.purchaseOrder({ purchaseOrderId: A.purchaseOrderId });
    expect(own.purchaseOrderId).toBe(A.purchaseOrderId);
    clean.assertClean('procurement.purchaseOrder', own);
    await bHolds('B order', `select count(*)::text as v from app.purchase_order where tenant_id = $1`);
    await assertSameAsNonexistent('procurement.purchaseOrder', clean, B.purchaseOrderId, (id) =>
      A.owner.procurement.purchaseOrder({ purchaseOrderId: id }),
    );
  },

  'procurement.listPurchaseOrders': async () => {
    const list = await A.owner.procurement.listPurchaseOrders({ limit: 500 });
    const own = await adminIds(
      `select id::text as id from app.purchase_order where tenant_id = $1 and deleted_at is null`,
      [A.tenantId],
    );
    clean.assertClean('procurement.listPurchaseOrders', list);
    expect(list.orders.map((o) => o.purchaseOrderId).sort()).toEqual(own);
    await assertSameAsNonexistent('procurement.listPurchaseOrders (B supplier)', clean, B.supplierId, (id) =>
      A.owner.procurement.listPurchaseOrders({ supplierId: id }),
    );
    await assertSameAsNonexistent('procurement.listPurchaseOrders (B location)', clean, B.outletId, (id) =>
      A.owner.procurement.listPurchaseOrders({ locationIds: [id] }),
    );
  },

  'procurement.reorderSuggestions': async () => {
    const own = await A.owner.procurement.reorderSuggestions({});
    expect(JSON.stringify(own)).toContain(A.productId);
    clean.assertClean('procurement.reorderSuggestions', own);
    await assertSameAsNonexistent('procurement.reorderSuggestions', clean, B.outletId, (id) =>
      A.owner.procurement.reorderSuggestions({ locationIds: [id] }),
    );
  },

  // ── provisioning (the operator plane) ────────────────────────────────────
  'provisioning.activationReadiness': async () => {
    // Non-vacuity: the operator plane DOES answer about tenant B.
    const operator = h.callerFor(await h.identityFor(B.tenantId, { operator: true, role: 'operator' }));
    const truth = await operator.provisioning.activationReadiness({ tenantId: B.tenantId });
    expect(truth.tenantId).toBe(B.tenantId);
    // A TENANT token is not the operator plane — not for B, not for itself.
    const answer = await assertSameAsNonexistent('provisioning.activationReadiness', clean, B.tenantId, (id) =>
      A.owner.provisioning.activationReadiness({ tenantId: id }),
    );
    expect(answer).toMatch(/^refused FORBIDDEN/);
    await expect(
      A.owner.provisioning.activationReadiness({ tenantId: A.tenantId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  },

  // ── receiving ────────────────────────────────────────────────────────────
  'receiving.get': async () => {
    const own = await A.owner.receiving.get({ goodsReceiptId: A.goodsReceiptId });
    expect(JSON.stringify(own)).toContain(A.goodsReceiptId);
    clean.assertClean('receiving.get', own);
    await bHolds('B receipt', `select count(*)::text as v from app.goods_receipt where tenant_id = $1`);
    await assertSameAsNonexistent('receiving.get', clean, B.goodsReceiptId, (id) =>
      A.owner.receiving.get({ goodsReceiptId: id }),
    );
  },

  'receiving.purchaseOrderReceiptStatus': async () => {
    const own = await A.owner.receiving.purchaseOrderReceiptStatus({ purchaseOrderId: A.purchaseOrderId });
    expect(JSON.stringify(own)).toContain(A.purchaseOrderLineId);
    clean.assertClean('receiving.purchaseOrderReceiptStatus', own);
    await assertSameAsNonexistent('receiving.purchaseOrderReceiptStatus', clean, B.purchaseOrderId, (id) =>
      A.owner.receiving.purchaseOrderReceiptStatus({ purchaseOrderId: id }),
    );
  },

  // ── reports: the aggregates ──────────────────────────────────────────────
  'reports.salesByLocation': async () => {
    await bHolds('B sales', `select count(*)::text as v from app.sale where tenant_id = $1`);
    const r = await A.owner.reports.salesByLocation({ from: FROM, to: TO });
    expect(r.scope.network).toBe(true);
    exactly('reports.salesByLocation total', r.total.totalMinor, await salesTotal(A.tenantId));
    exactly('reports.salesByLocation count', r.total.saleCount, await saleCount(A.tenantId));
    clean.assertClean('reports.salesByLocation', r);
    await assertSameAsNonexistent('reports.salesByLocation', clean, B.outletId, (id) =>
      A.owner.reports.salesByLocation({ from: FROM, to: TO, locationIds: [id] }),
    );
  },

  'reports.salesByDay': async () => {
    const r = await A.owner.reports.salesByDay({ from: FROM, to: TO });
    exactly('reports.salesByDay total', r.total.totalMinor, await salesTotal(A.tenantId));
    exactly(
      'reports.salesByDay Σ(days)',
      r.series.reduce((a, d) => a + BigInt(d.totalMinor), 0n),
      await salesTotal(A.tenantId),
    );
    clean.assertClean('reports.salesByDay', r);
    await assertSameAsNonexistent('reports.salesByDay', clean, B.outletId, (id) =>
      A.owner.reports.salesByDay({ from: FROM, to: TO, locationIds: [id] }),
    );
  },

  'reports.stockOnHand': async () => {
    await bHolds('B stock', `select count(*)::text as v from app.stock_movement where tenant_id = $1`);
    const r = await A.owner.reports.stockOnHand({});
    // NON-VACUITY, the line the Phase 2 gate found missing: an empty report
    // passed the old `for … of locations` loop.
    const lines = r.locations.flatMap((l) => l.lines);
    expect(lines.length).toBeGreaterThan(0);
    const network = r.networkByProduct.find((p) => p.productId === A.productId);
    expect(network).toBeDefined();
    exactly(
      'reports.stockOnHand network qty',
      network!.qtyOnHand,
      await admin(
        `select coalesce(sum(qty_delta), 0)::text as v from app.stock_movement where tenant_id = $1 and product_id = $2`,
        [A.tenantId, A.productId],
      ),
    );
    clean.assertClean('reports.stockOnHand', r);
    await assertSameAsNonexistent('reports.stockOnHand', clean, B.outletId, (id) =>
      A.owner.reports.stockOnHand({ locationIds: [id] }),
    );
  },

  'reports.cashPosition': async () => {
    await bHolds('B payments', `select count(*)::text as v from app.credit_entry where tenant_id = $1 and kind = 'PAYMENT'`);
    const r = await A.owner.reports.cashPosition({ from: FROM, to: TO });
    exactly('reports.cashPosition billed', r.total.billedTotalMinor, await salesTotal(A.tenantId));
    // The tenant-WIDE figure: `app.credit_entry` has no location, so this
    // query has no location predicate at all — RLS is the ONLY thing between
    // it and tenant B's payments. B paid a conspicuous 46464.
    exactly(
      'reports.cashPosition credit receipts',
      r.unattributed.creditReceiptsMinor,
      await admin(
        `select coalesce(-sum(amount_minor), 0)::text as v from app.credit_entry
          where tenant_id = $1 and kind = 'PAYMENT' and business_date between $2::date and $3::date`,
        [A.tenantId, FROM, TO],
      ),
    );
    exactly('reports.cashPosition credit receipts are A’s', r.unattributed.creditReceiptsMinor, SPEC_A.paymentMinor);
    clean.assertClean('reports.cashPosition', r);
    await assertSameAsNonexistent('reports.cashPosition', clean, B.outletId, (id) =>
      A.owner.reports.cashPosition({ from: FROM, to: TO, locationIds: [id] }),
    );
  },

  'reports.inventoryDays': async () => {
    const r = await A.owner.reports.inventoryDays({ from: FROM, to: TO });
    exactly('reports.inventoryDays net revenue', r.total.netRevenueMinor, await netRevenue(A.tenantId));
    const outlet = r.locations.find((l) => l.locationId === A.outletId);
    expect(outlet?.cogsMinor).not.toBeNull();
    expect(BigInt(outlet!.cogsMinor!)).toBeGreaterThan(0n);
    clean.assertClean('reports.inventoryDays', r);
    await assertSameAsNonexistent('reports.inventoryDays', clean, B.outletId, (id) =>
      A.owner.reports.inventoryDays({ from: FROM, to: TO, locationIds: [id] }),
    );
  },

  'reports.distributionCostRatio': async () => {
    const r = await A.owner.reports.distributionCostRatio({ from: FROM, to: TO });
    clean.assertClean('reports.distributionCostRatio', r);
    const text = JSON.stringify(r);
    breachUnless(!text.includes(`"${SPEC_B.freightMinor}"`), 'reports.distributionCostRatio: B’s freight in A’s ratio');
    expect(text).toContain(`"${SPEC_A.freightMinor}"`);
    await assertSameAsNonexistent('reports.distributionCostRatio', clean, B.outletId, (id) =>
      A.owner.reports.distributionCostRatio({ from: FROM, to: TO, locationIds: [id] }),
    );
  },

  // ── review ───────────────────────────────────────────────────────────────
  'review.list': async () => {
    await bHolds('B reviews', `select count(*)::text as v from app.conflict_review where tenant_id = $1`);
    const list = await A.owner.review.list({ statuses: ['open', 'claimed', 'resolved'], limit: 500 });
    const own = await adminIds(
      `select id::text as id from app.conflict_review where tenant_id = $1 and deleted_at is null`,
      [A.tenantId],
    );
    clean.assertClean('review.list', list);
    expect(list.reviews.map((r) => r.reviewId).sort()).toEqual(own);
  },

  'review.get': async () => {
    const own = await A.owner.review.get({ reviewId: A.reviewId });
    expect(own.reviewId).toBe(A.reviewId);
    clean.assertClean('review.get', own);
    await assertSameAsNonexistent('review.get', clean, B.reviewId, (id) => A.owner.review.get({ reviewId: id }));
  },

  // ── sales ────────────────────────────────────────────────────────────────
  'sales.get': async () => {
    const own = await A.owner.sales.get({ saleId: A.creditSaleId });
    expect(JSON.stringify(own)).toContain(A.creditSaleId);
    clean.assertClean('sales.get', own);
    await bHolds('B sale', `select count(*)::text as v from app.sale where tenant_id = $1 and id = $2`, [B.cashSaleId]);
    for (const foreign of [B.cashSaleId, B.creditSaleId]) {
      await assertSameAsNonexistent('sales.get', clean, foreign, (id) => A.owner.sales.get({ saleId: id }));
    }
  },

  'sales.recomputeCheck': async () => {
    const own = await A.owner.sales.recomputeCheck({ saleId: A.cashSaleId });
    clean.assertClean('sales.recomputeCheck', own);
    expect(JSON.stringify(own)).toContain(A.cashSaleId);
    await assertSameAsNonexistent('sales.recomputeCheck', clean, B.cashSaleId, (id) =>
      A.owner.sales.recomputeCheck({ saleId: id }),
    );
  },

  // ── session ──────────────────────────────────────────────────────────────
  'session.permissions': async () => {
    const own = await A.owner.session.permissions();
    expect(own.grants.length).toBeGreaterThan(0);
    clean.assertClean('session.permissions', own);
    // A token for tenant A whose `uid` is tenant B's real owner. The tenant is
    // the context, never a parameter: B's user must resolve to nothing.
    await bHolds('B grants', `select count(*)::text as v from app.user_role_assignment where tenant_id = $1 and user_id = $2`, [
      B.ownerIdentity.userId,
    ]);
    const answer = await assertSameAsNonexistent('session.permissions', clean, B.ownerIdentity.userId, async (uid) =>
      h.callerFor(await h.identityFor(A.tenantId, { uid, grant: 'none' })).session.permissions(),
    );
    expect(answer).toContain('"grants":[]');
  },
};

describe('every query procedure: tenant A sees none of tenant B, at every read path', () => {
  it('[isolation:catalogue.list] the whole catalogue, paged, is exactly A’s products', () => probes['catalogue.list']!());
  it('[isolation:catalogue.search] B’s marker product is unfindable; a wide search carries nothing of B’s', () =>
    probes['catalogue.search']!());
  it('[isolation:catalogue.detail] A’s product resolves (positive control); B’s answers as a nonexistent id', () =>
    probes['catalogue.detail']!());
  it('[isolation:credit.accountForCustomer] B’s customer answers as a nonexistent one', () =>
    probes['credit.accountForCustomer']!());
  it('[isolation:credit.exposure] A’s exposure is exact; B’s account answers as nonexistent', () =>
    probes['credit.exposure']!());
  it('[isolation:credit.ageing] B’s account answers as nonexistent', () => probes['credit.ageing']!());
  it('[isolation:credit.previewFacilityFee] B’s account answers as nonexistent', () =>
    probes['credit.previewFacilityFee']!());
  it('[isolation:inventory.onHand] exact on-hand; B’s product and B’s location both answer as nonexistent', () =>
    probes['inventory.onHand']!());
  it('[isolation:inventory.reorderPoints] A’s thresholds only; B’s location answers as nonexistent', () =>
    probes['inventory.reorderPoints']!());
  it('[isolation:inventory.lowStock] A’s alerts only; B’s location answers as nonexistent', () =>
    probes['inventory.lowStock']!());
  it('[isolation:ledger.trialBalance] debits equal A’s posted lines exactly', () => probes['ledger.trialBalance']!());
  it('[isolation:ledger.profitAndLoss] revenue and expense are A’s, to the pesewa', () =>
    probes['ledger.profitAndLoss']!());
  it('[isolation:ledger.balanceSheet] the result is A’s and the statements reconcile', () =>
    probes['ledger.balanceSheet']!());
  it('[isolation:ledger.postingExceptions] exactly A’s exceptions', () => probes['ledger.postingExceptions']!());
  it('[isolation:logistics.get] B’s delivery answers as nonexistent', () => probes['logistics.get']!());
  it('[isolation:logistics.list] exactly A’s deliveries; B’s carrier and source filter as nonexistent', () =>
    probes['logistics.list']!());
  it('[isolation:logistics.haulageSpend] freight equals A’s, not A’s plus B’s', () =>
    probes['logistics.haulageSpend']!());
  it('[isolation:procurement.listSuppliers] exactly A’s suppliers', () => probes['procurement.listSuppliers']!());
  it('[isolation:procurement.suppliersForProduct] B’s product answers as nonexistent', () =>
    probes['procurement.suppliersForProduct']!());
  it('[isolation:procurement.purchaseOrder] B’s order answers as nonexistent', () =>
    probes['procurement.purchaseOrder']!());
  it('[isolation:procurement.listPurchaseOrders] exactly A’s orders; B’s supplier and location filter as nonexistent', () =>
    probes['procurement.listPurchaseOrders']!());
  it('[isolation:procurement.reorderSuggestions] A’s suggestions only; B’s location answers as nonexistent', () =>
    probes['procurement.reorderSuggestions']!());
  it('[isolation:provisioning.activationReadiness] a tenant token is not the operator plane, for B or for itself', () =>
    probes['provisioning.activationReadiness']!());
  it('[isolation:receiving.get] B’s receipt answers as nonexistent', () => probes['receiving.get']!());
  it('[isolation:receiving.purchaseOrderReceiptStatus] B’s order answers as nonexistent', () =>
    probes['receiving.purchaseOrderReceiptStatus']!());
  it('[isolation:reports.salesByLocation] the network total is A’s total exactly', () =>
    probes['reports.salesByLocation']!());
  it('[isolation:reports.salesByDay] the series and its total are A’s exactly', () => probes['reports.salesByDay']!());
  it('[isolation:reports.stockOnHand] non-empty, A’s quantities exactly, nothing of B’s', () =>
    probes['reports.stockOnHand']!());
  it('[isolation:reports.cashPosition] billed and the tenant-wide credit receipts are A’s exactly', () =>
    probes['reports.cashPosition']!());
  it('[isolation:reports.inventoryDays] net revenue is A’s exactly, with a real COGS', () =>
    probes['reports.inventoryDays']!());
  it('[isolation:reports.distributionCostRatio] A’s freight, not B’s', () => probes['reports.distributionCostRatio']!());
  it('[isolation:review.list] exactly A’s reviews', () => probes['review.list']!());
  it('[isolation:review.get] B’s review answers as nonexistent', () => probes['review.get']!());
  it('[isolation:sales.get] B’s sales answer as nonexistent', () => probes['sales.get']!());
  it('[isolation:sales.recomputeCheck] B’s sale answers as nonexistent', () => probes['sales.recomputeCheck']!());
  it('[isolation:session.permissions] B’s real user id, under A’s token, resolves to nothing', () =>
    probes['session.permissions']!());
});

// ---------------------------------------------------------------------------
// The probes can fail. Remove the backstop and watch them go red.
// ---------------------------------------------------------------------------

/**
 * Three database-level mutations, each the state a real defect would leave
 * behind. Every one starts from "row-level security is gone" — disabled on
 * every `app.*` table and on platform.tenant, the state a dropped policy, a
 * lost FORCE or a BYPASSRLS application role produces — and two of them add
 * the second failure a path needs before it can leak, because those paths
 * carry a second control:
 *
 *  - `rls-off` — nothing else. The probes red under this alone are the paths
 *    where RLS is the ONLY tenant control.
 *  - `rls-off-and-location-policy-too-wide` — app.location keeps RLS, but
 *    gains a second permissive policy admitting every tenant's non-root
 *    nodes. Roots stay scoped, so the permission layer still believes the
 *    caller is tenant-wide, while the network scope (`resolveLocationScope`'s
 *    unpredicated location read) and the ledger's location join now reach
 *    tenant B. Under plain `rls-off` these paths fail CLOSED instead — the
 *    second root makes the caller not tenant-wide — which is good behaviour
 *    and exactly why they need this mutation to show their probes can fail.
 *  - `rls-off-and-principal-in-both-tenants` — tenant A's owner's user id is
 *    also made an owner inside tenant B. Paths scoped by the caller's own
 *    grant set resolve that set with no tenant predicate (RLS scopes it), so
 *    with RLS gone B's grants join A's and B's locations enter A's scope.
 */
type Mutation =
  | 'rls-off'
  | 'rls-off-and-location-policy-too-wide'
  | 'rls-off-and-principal-in-both-tenants';

async function withMutation(mutation: Mutation, fn: () => Promise<void>): Promise<void> {
  const keepLocationRls = mutation === 'rls-off-and-location-policy-too-wide';
  const sharedUser = A.ownerIdentity.userId;
  if (mutation === 'rls-off-and-principal-in-both-tenants') {
    await h.grantOwner(B.tenantId, sharedUser);
  }
  const tables = await h.db.asAdmin((tx) =>
    tx.query<{ name: string }>(
      `select format('%I.%I', n.nspname, c.relname) as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and c.relrowsecurity
          and (n.nspname = 'app' or (n.nspname = 'platform' and c.relname = 'tenant'))
          and not ($1 and n.nspname = 'app' and c.relname = 'location')`,
      [keepLocationRls],
    ),
  );
  expect(tables.rows.length).toBeGreaterThan(40);
  await h.db.asAdmin(async (tx) => {
    for (const t of tables.rows) await tx.query(`alter table ${t.name} disable row level security`);
    if (keepLocationRls) {
      await tx.query(`create policy iso_mutation_too_wide on app.location using (parent_id is not null)`);
    }
  });
  try {
    await fn();
  } finally {
    await h.db.asAdmin(async (tx) => {
      if (keepLocationRls) await tx.query(`drop policy iso_mutation_too_wide on app.location`);
      for (const t of tables.rows) await tx.query(`alter table ${t.name} enable row level security`);
      if (mutation === 'rls-off-and-principal-in-both-tenants') {
        await tx.query(`delete from app.user_role_assignment where tenant_id = $1 and user_id = $2`, [
          B.tenantId,
          sharedUser,
        ]);
        await tx.query(`delete from app.user_account where tenant_id = $1 and id = $2`, [B.tenantId, sharedUser]);
      }
    });
  }
}

/**
 * For EVERY probe: the weakest mutation under which it goes red. Recorded
 * per probe, so a probe that loses its sensitivity — or a path that gains or
 * loses a control — changes this table in a reviewed diff.
 *
 * One entry is `code-only`: the operator plane reads through the operator
 * runner, not app_user, so no RLS mutation reaches it; its control is the
 * `platformOperator` check in `operatorProcedure`. Mutation-checked by hand
 * (check deleted -> the probe went red with an IsolationBreach: tenant A's
 * token answered B's readiness while a nonexistent id answered NOT_FOUND).
 */
const DECISIVE_MUTATION: Record<string, Mutation | 'code-only'> = {
  'catalogue.list': 'rls-off',
  'catalogue.search': 'rls-off',
  'catalogue.detail': 'rls-off',
  'credit.accountForCustomer': 'rls-off',
  'credit.exposure': 'rls-off',
  'credit.ageing': 'rls-off',
  'credit.previewFacilityFee': 'rls-off',
  'inventory.onHand': 'rls-off',
  'inventory.reorderPoints': 'rls-off-and-principal-in-both-tenants',
  'inventory.lowStock': 'rls-off-and-principal-in-both-tenants',
  'ledger.trialBalance': 'rls-off-and-location-policy-too-wide',
  'ledger.profitAndLoss': 'rls-off-and-location-policy-too-wide',
  'ledger.balanceSheet': 'rls-off-and-location-policy-too-wide',
  'ledger.postingExceptions': 'rls-off-and-location-policy-too-wide',
  'logistics.get': 'rls-off',
  'logistics.list': 'rls-off-and-principal-in-both-tenants',
  'logistics.haulageSpend': 'rls-off-and-location-policy-too-wide',
  'procurement.listSuppliers': 'rls-off',
  'procurement.suppliersForProduct': 'rls-off',
  'procurement.purchaseOrder': 'rls-off',
  'procurement.listPurchaseOrders': 'rls-off-and-principal-in-both-tenants',
  'procurement.reorderSuggestions': 'rls-off-and-principal-in-both-tenants',
  'provisioning.activationReadiness': 'code-only',
  'receiving.get': 'rls-off',
  'receiving.purchaseOrderReceiptStatus': 'rls-off',
  'reports.salesByLocation': 'rls-off-and-location-policy-too-wide',
  'reports.salesByDay': 'rls-off-and-location-policy-too-wide',
  'reports.stockOnHand': 'rls-off-and-location-policy-too-wide',
  'reports.cashPosition': 'rls-off',
  'reports.inventoryDays': 'rls-off-and-location-policy-too-wide',
  'reports.distributionCostRatio': 'rls-off-and-location-policy-too-wide',
  'review.list': 'rls-off-and-principal-in-both-tenants',
  'review.get': 'rls-off',
  'sales.get': 'rls-off',
  'sales.recomputeCheck': 'rls-off',
  'session.permissions': 'rls-off',
};

describe('mutation: remove the backstop and every probe goes red — with an IsolationBreach', () => {
  it('every probe declares the mutation that turns it red', () => {
    expect(Object.keys(DECISIVE_MUTATION).sort()).toEqual(Object.keys(probes).sort());
  });

  for (const [procedure, mutation] of Object.entries(DECISIVE_MUTATION)) {
    if (mutation === 'code-only') continue;
    it(`${procedure} goes red under ${mutation}`, async () => {
      let caught: unknown;
      await withMutation(mutation, async () => {
        try {
          await probes[procedure]!();
        } catch (err) {
          caught = err;
        }
      });
      expect(caught, `${procedure}: the probe stayed green under ${mutation}`).toBeInstanceOf(IsolationBreach);
    });
  }

  it('…and with the mutations undone, every probe is green again', async () => {
    const leftovers = await h.db.asAdmin((tx) =>
      tx.query<{ off: string; policies: string; shared: string }>(
        `select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where c.relkind in ('r', 'p') and not c.relrowsecurity
                    and (n.nspname = 'app' or (n.nspname = 'platform' and c.relname = 'tenant')))::text as off,
                (select count(*) from pg_policy where polname = 'iso_mutation_too_wide')::text as policies,
                (select count(*) from app.user_account where tenant_id = $1 and id = $2)::text as shared`,
        [B.tenantId, A.ownerIdentity.userId],
      ),
    );
    expect(leftovers.rows[0]).toEqual({ off: '0', policies: '0', shared: '0' });
    for (const probe of Object.values(probes)) await probe();
  });
});
