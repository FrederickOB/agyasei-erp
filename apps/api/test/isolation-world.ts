/**
 * THE TWO-TENANT WORLD every read-path isolation probe runs against
 * (CLAUDE.md §2.7 category 3; Phase 1 acceptance criterion 5).
 *
 * Two tenants, provisioned through the operator plane and templated
 * identically, each holding ONE OF EVERYTHING a query procedure can read:
 * stock, a costed receipt, cash and credit sales, a credit account with a
 * payment, a reorder point, a purchase order, a goods receipt, a planned
 * delivery with freight, a real conflict review, a posted journal and an open
 * posting exception. Tenant B's amounts and strings are chosen to be
 * CONSPICUOUS, so a leak shows up as a number or a word that cannot be A's.
 *
 * The leak detector does not rely on knowing which field might leak. It
 * collects EVERY primary id tenant B owns — every `id` in every `app.*` table
 * where `tenant_id = B`, read as the operator — and fails if any of them
 * appears anywhere in tenant A's answer (D5's byte-grep, applied to the API).
 * Template ids are derived from the tenant id (`seed/template.ts`), so the two
 * universes are disjoint; that is asserted, not assumed.
 *
 * Every isolation failure is thrown as an `IsolationBreach`, never as a plain
 * assertion error. That is what lets the mutation block in
 * `isolation-read-paths.test.ts` prove a probe goes red FOR THE RIGHT REASON
 * when the backstop is removed — a probe that went red because the fixture
 * broke would prove nothing.
 */
import { TRPCError } from '@trpc/server';
import { paymentEntry, postDocument, saleEntry, uuidv7 } from '@erp/db';
import type { VerifiedIdentity } from '../src/auth.js';
import type { ApiHarness } from './util.js';

export type Caller = ReturnType<ApiHarness['callerFor']>;

/** An isolation failure — the only error a probe throws when isolation breaks. */
export class IsolationBreach extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationBreach';
  }
}

export function breachUnless(condition: boolean, message: string): void {
  if (!condition) throw new IsolationBreach(message);
}

/** The window every dated read in the probes asks about. */
export const FROM = '2026-08-01';
export const TO = '2026-08-31';

interface TenantSpec {
  slug: string;
  /** A string that appears ONLY in this tenant's rows. */
  marker: string;
  receiptPrefix: string;
  priceE4: bigint;
  costE4: string;
  cashQty: string;
  creditQty: string;
  paymentMinor: bigint;
  freightMinor: bigint;
  glRevenueMinor: bigint;
}

export const SPEC_A: TenantSpec = {
  slug: 'iso-alpha',
  marker: 'ALPHA-OWN-MARKER',
  receiptPrefix: 'ISO-A',
  priceE4: 55_000_000n,
  costE4: '40000000',
  cashQty: '5',
  creditQty: '3',
  paymentMinor: 10_000n,
  freightMinor: 12_345n,
  glRevenueMinor: 15_000n,
};

/** Tenant B: every figure and word picked so it cannot be mistaken for A's. */
export const SPEC_B: TenantSpec = {
  slug: 'iso-zulu',
  marker: 'ZZB-LEAK-MARKER',
  receiptPrefix: 'ISO-B',
  priceE4: 77_770_000n,
  costE4: '61000000',
  cashQty: '4',
  creditQty: '2',
  paymentMinor: 46_464n,
  freightMinor: 96_431n,
  glRevenueMinor: 777_000n,
};

export interface TenantWorld {
  tenantId: string;
  spec: TenantSpec;
  rootId: string;
  outletId: string;
  /** A stocked, sellable, buyable product, priced on WHOLESALE. */
  productId: string;
  productUomId: string;
  /** A product only this tenant has, named with the marker. */
  markerProductId: string;
  customerId: string;
  accountId: string;
  cashSaleId: string;
  creditSaleId: string;
  supplierId: string;
  haulierId: string;
  purchaseOrderId: string;
  purchaseOrderLineId: string;
  goodsReceiptId: string;
  deliveryId: string;
  reviewId: string;
  /** The owner: every capability, at the root. */
  owner: Caller;
  ownerIdentity: VerifiedIdentity;
}

async function one<T>(h: ApiHarness, tenantId: string, sql: string, params: unknown[] = []): Promise<T> {
  return h.db.withTenant(tenantId, async (tx) => {
    const res = await tx.query<T>(sql, params);
    const row = res.rows[0];
    if (!row) throw new Error(`fixture: no row for ${sql.trim().slice(0, 80)}`);
    return row;
  });
}

async function serverWrite(h: ApiHarness, tenantId: string, op: string): Promise<string> {
  const id = uuidv7();
  await h.db.withTenant(tenantId, (tx) =>
    tx.query(
      `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
       values ($1, $2, 'SERVER', $3, $4, 1, decode('00', 'hex'))`,
      [tenantId, id, h.deps.clock.next(), op],
    ),
  );
  return id;
}

/** Open one REAL review: a device that wiped its database re-reports its block (class #14). */
async function openRealReview(caller: Caller, locationId: string): Promise<string> {
  const first = await caller.sequence.syncBlock({
    idempotencyKey: uuidv7(),
    locationId,
    sequenceKey: 'RECEIPT',
    report: null,
    wantBlock: true,
  });
  const block = first.block;
  if (!block) throw new Error('fixture: no receipt block issued');
  await caller.sequence.syncBlock({
    idempotencyKey: uuidv7(),
    locationId,
    sequenceKey: 'RECEIPT',
    report: { blockStart: block.blockStart, consumedUpto: (BigInt(block.blockStart) + 5n).toString(10) },
    wantBlock: false,
  });
  const regressed = await caller.sequence.syncBlock({
    idempotencyKey: uuidv7(),
    locationId,
    sequenceKey: 'RECEIPT',
    report: { blockStart: block.blockStart, consumedUpto: null },
    wantBlock: true,
  });
  if (!regressed.review) throw new Error('fixture: the writer opened no review');
  return regressed.review.id;
}

/** A fiscal year, one open period, a minimal chart, and two posted documents. */
async function buildLedger(h: ApiHarness, w: Omit<TenantWorld, 'reviewId'>): Promise<void> {
  const t = w.tenantId;
  await h.db.withTenant(t, async (tx) => {
    await tx.query(
      `insert into app.fiscal_year (tenant_id, fy_code, starts_on, ends_on)
       values ($1, 'FY27', '2026-08-01', '2027-07-31')`,
      [t],
    );
    await tx.query(`insert into app.gl_counter (tenant_id, fy_code) values ($1, 'FY27')`, [t]);
    await tx.query(
      `insert into app.accounting_period (tenant_id, id, fy_code, seq, starts_on, ends_on)
       values ($1, $2, 'FY27', 1, '2026-08-01', '2026-08-31')`,
      [t, uuidv7()],
    );
  });
  const chart: [string, string, string, string | null][] = [
    ['TILL_CASH', '1000', 'ASSET', 'TILL'],
    ['SALES_REVENUE', '4100', 'INCOME', null],
    ['OUTPUT_TAX', '2200', 'LIABILITY', null],
    ['COGS', '5000', 'EXPENSE', null],
    ['INVENTORY', '1300', 'ASSET', 'INVENTORY'],
    ['AR_TRADE', '1400', 'ASSET', 'AR'],
    ['INTERLOC_CLEARING', '1900', 'ASSET', null],
  ];
  for (const [role, code, type, control] of chart) {
    await h.db.withTenant(t, async (tx) => {
      const accountId = uuidv7();
      await tx.query(
        `insert into app.gl_account (tenant_id, id, code, name, account_type, normal_balance,
                                     is_postable, control_account_kind, report_line_key)
         values ($1, $2, $3, $4, $5, $6, true, $7, $8)`,
        [t, accountId, code, `${w.spec.marker} ${code}`, type,
         type === 'ASSET' || type === 'EXPENSE' ? 'D' : 'C', control, `line:${code}`],
      );
      await tx.query(
        `insert into app.gl_account_mapping
           (tenant_id, id, posting_role, scope_kind, account_id, mapping_set_version, effective_from)
         values ($1, $2, $3, 'tenant', $4, 1, '2026-01-01')`,
        [t, uuidv7(), role, accountId],
      );
    });
  }
  const opts = { tenantId: t, postedBy: w.ownerIdentity.userId, postingRuleVersion: 1 };
  const docs = [
    saleEntry({
      saleId: uuidv7(), locationId: w.outletId, businessDate: '2026-08-15',
      tenders: [{ role: 'TILL_CASH', amountMinor: w.spec.glRevenueMinor + w.spec.glRevenueMinor / 5n }],
      revenueMinor: w.spec.glRevenueMinor, discountMinor: 0n,
      taxes: [{ taxCode: 'GH.VAT.STD', taxMinor: w.spec.glRevenueMinor / 5n }],
      costMinor: w.spec.glRevenueMinor / 2n,
    }),
    paymentEntry({
      paymentId: uuidv7(), businessDate: '2026-08-20',
      receivingLocationId: w.outletId, obligationLocationId: w.outletId,
      customerId: w.customerId, amountMinor: w.spec.paymentMinor, instrument: 'CASH',
    }),
  ];
  for (const doc of docs) {
    const r = await postDocument(h.db, doc, opts);
    if (r.status !== 'posted') throw new Error(`fixture: ledger post ${JSON.stringify(r)}`);
  }
  // …and one that cannot post (no period in 2027-12): an open exception.
  const orphan = await postDocument(
    h.db,
    saleEntry({
      saleId: uuidv7(), locationId: w.outletId, businessDate: '2027-12-01',
      tenders: [{ role: 'TILL_CASH', amountMinor: 1_000n }],
      revenueMinor: 1_000n, discountMinor: 0n, taxes: [], costMinor: 0n,
    }),
    opts,
  );
  if (orphan.status !== 'exception') throw new Error('fixture: expected a posting exception');
}

/**
 * Build one tenant's world through the REAL routers wherever a router exists,
 * so every row is the shape production writes.
 */
export async function buildTenantWorld(h: ApiHarness, spec: TenantSpec): Promise<TenantWorld> {
  const tenantId = await h.provisionTenant(spec.slug);
  await h.applyTemplate(tenantId, true);
  // The legal name carries the marker too: the registry row is tenant data.
  await h.db.asAdmin((tx) =>
    tx.query(`update platform.tenant set legal_name = $2 where id = $1`, [
      tenantId,
      `${spec.marker} Holdings Ltd`,
    ]),
  );

  const rootId = await h.locationByCode(tenantId, 'ROOT');
  const outletId = await h.locationByCode(tenantId, 'OUT-01');
  const ownerIdentity = await h.identityFor(tenantId, { locs: [rootId, outletId] });
  const owner = h.callerFor(ownerIdentity);

  // A product that is stocked, sold and bought in the same scale-0 unit.
  const product = await one<{ id: string; uom_id: string }>(
    h,
    tenantId,
    `select p.id, pu.uom_id
       from app.product p
       join app.product_uom pu
         on pu.tenant_id = p.tenant_id and pu.product_id = p.id and pu.deleted_at is null
        and pu.is_default_sell and pu.can_buy and pu.uom_id = p.stocking_uom_id
       join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = pu.uom_id
      where p.deleted_at is null and p.is_sellable and p.stock_tracking = 'STOCKED'
        and u.qty_scale = 0
      order by p.sku_code limit 1`,
  );
  await h.seedWholesalePrice(tenantId, product.id, spec.priceE4);

  // A product only this tenant has — its name is the marker.
  const markerProductId = uuidv7();
  {
    const writeId = await serverWrite(h, tenantId, 'test.iso_marker_product');
    await h.db.withTenant(tenantId, async (tx) => {
      const donor = await tx.query<{ category_id: string; stocking_uom_id: string }>(
        `select category_id, stocking_uom_id from app.product where id = $1`,
        [product.id],
      );
      await tx.query(
        `insert into app.product
           (tenant_id, id, write_id, hlc, sku_code, name, category_id, stocking_uom_id, tax_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'GH.VAT.STD')`,
        [tenantId, markerProductId, writeId, h.deps.clock.next(), `${spec.receiptPrefix}-SKU`,
         `${spec.marker} Coupling`, donor.rows[0]!.category_id, donor.rows[0]!.stocking_uom_id],
      );
    });
  }

  // Stock, with a cost — the only source of a cost basis.
  await owner.inventory.recordMovement({
    idempotencyKey: uuidv7(),
    locationId: outletId,
    productId: product.id,
    qtyDelta: '100',
    sourceKind: 'RECEIPT',
    reasonCode: 'OPENING',
    businessDate: FROM,
    unitCostE4: spec.costE4,
  });

  const account = await owner.credit.openAccount({
    idempotencyKey: uuidv7(),
    newCustomer: { code: `${spec.receiptPrefix}-CUST`, name: `${spec.marker} Customer` },
    termsDays: 30,
    feeRateBpPerMonth: 200,
    creditLimitMinor: '50000000',
  });

  const cash = await owner.sales.createSale(await h.legacySale({
    idempotencyKey: uuidv7(),
    locationId: outletId,
    priceListCode: 'WHOLESALE',
    receiptNo: `${spec.receiptPrefix}-1`,
    businessDate: '2026-08-05',
    tender: 'CASH',
    lines: [{ productId: product.id, qty: spec.cashQty }],
  }));
  const credit = await owner.sales.createSale(await h.legacySale({
    idempotencyKey: uuidv7(),
    locationId: outletId,
    priceListCode: 'WHOLESALE',
    receiptNo: `${spec.receiptPrefix}-2`,
    businessDate: '2026-08-06',
    tender: 'CREDIT',
    customerId: account.customerId,
    lines: [{ productId: product.id, qty: spec.creditQty }],
  }));
  await owner.credit.recordEntry({
    idempotencyKey: uuidv7(),
    accountId: account.accountId,
    kind: 'PAYMENT',
    amountMinor: (-spec.paymentMinor).toString(10),
    businessDate: '2026-08-20',
  });

  // Far above on-hand, so the product is LOW and both alert paths answer.
  await owner.inventory.setReorderPoint({
    idempotencyKey: uuidv7(),
    locationId: outletId,
    productId: product.id,
    reorderPointQty: '1000',
    reorderUpToQty: '2000',
    leadTimeDays: 7,
    notes: `${spec.marker} reorder note`,
  });

  const supplierRef = async (ref: string) =>
    (await one<{ id: string }>(h, tenantId,
      `select id from app.supplier where origin_ref = $1 and deleted_at is null`, [`supplier:${ref}`])).id;
  const supplierId = await supplierRef('GHACEM');
  const haulierId = await supplierRef('HAULIER-GENERAL');

  const raised = await owner.procurement.createPurchaseOrder({
    idempotencyKey: uuidv7(),
    supplierId,
    deliverToLocationId: outletId,
    orderDate: '2026-08-10',
    notes: `${spec.marker} order note`,
    lines: [{ lineNo: 1, productId: product.id, uomId: product.uom_id, qtyOrdered: '20', unitPriceE4: spec.costE4 }],
  });
  for (const toStatus of ['SUBMITTED', 'APPROVED'] as const) {
    await owner.procurement.changePurchaseOrderStatus({
      idempotencyKey: uuidv7(),
      purchaseOrderId: raised.purchaseOrderId,
      toStatus,
    });
  }
  const purchaseOrderLineId = (await one<{ id: string }>(h, tenantId,
    `select id from app.purchase_order_line where purchase_order_id = $1 and deleted_at is null`,
    [raised.purchaseOrderId])).id;

  const receipt = await owner.receiving.recordReceipt({
    idempotencyKey: uuidv7(),
    purchaseOrderId: raised.purchaseOrderId,
    supplierId,
    locationId: outletId,
    businessDate: '2026-08-21',
    notes: `${spec.marker} receipt note`,
    lines: [{
      lineNo: 1,
      purchaseOrderLineId,
      productId: product.id,
      uomId: product.uom_id,
      qtyReceived: '10',
      qtyStock: '10',
      unitCostE4: spec.costE4,
    }],
  });

  const delivery = await owner.logistics.planDelivery({
    idempotencyKey: uuidv7(),
    sourceKind: 'PURCHASE_ORDER',
    sourceId: raised.purchaseOrderId,
    carrierSupplierId: haulierId,
    plannedFor: '2026-08-22',
    businessDate: '2026-08-22',
    freightCostMinor: spec.freightMinor.toString(10),
    notes: `${spec.marker} delivery note`,
  });

  const partial = {
    tenantId,
    spec,
    rootId,
    outletId,
    productId: product.id,
    productUomId: product.uom_id,
    markerProductId,
    customerId: account.customerId,
    accountId: account.accountId,
    cashSaleId: cash.saleId,
    creditSaleId: credit.saleId,
    supplierId,
    haulierId,
    purchaseOrderId: raised.purchaseOrderId,
    purchaseOrderLineId,
    goodsReceiptId: receipt.goodsReceiptId,
    deliveryId: delivery.deliveryId,
    owner,
    ownerIdentity,
  };
  await buildLedger(h, partial);
  const reviewId = await openRealReview(owner, outletId);
  return { ...partial, reviewId };
}

// ---------------------------------------------------------------------------
// The leak detector
// ---------------------------------------------------------------------------

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every primary id a tenant owns, read as the OPERATOR (no RLS in the way). */
export async function idUniverse(h: ApiHarness, tenantId: string): Promise<Set<string>> {
  const tables = await h.db.asAdmin((tx) =>
    tx.query<{ relname: string }>(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind in ('r', 'p')
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid
                       and a.attname = 'id' and not a.attisdropped)
        order by 1`,
    ),
  );
  const ids = new Set<string>([tenantId.toLowerCase()]);
  for (const t of tables.rows) {
    const res = await h.db.asAdmin((tx) =>
      tx.query<{ id: string }>(`select id::text as id from app.${t.relname} where tenant_id = $1`, [tenantId]),
    );
    for (const r of res.rows) ids.add(r.id.toLowerCase());
  }
  return ids;
}

export function serialise(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString(10) : v)) ?? 'undefined';
}

export interface LeakDetector {
  /** Throws IsolationBreach if anything of tenant B's is in `value`. */
  assertClean(label: string, value: unknown): void;
}

export function leakDetector(foreignIds: Set<string>, foreignMarkers: readonly string[]): LeakDetector {
  return {
    assertClean(label, value) {
      const text = serialise(value);
      const hits = [...new Set([...text.matchAll(UUID_G)].map((m) => m[0].toLowerCase()))].filter((id) =>
        foreignIds.has(id),
      );
      breachUnless(hits.length === 0, `${label}: tenant B ids in tenant A's answer: ${hits.slice(0, 5).join(', ')}`);
      for (const marker of foreignMarkers) {
        breachUnless(!text.includes(marker), `${label}: tenant B's marker "${marker}" in tenant A's answer`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The existence oracle
// ---------------------------------------------------------------------------

/**
 * What a call answered, with the probed id replaced by a placeholder — the
 * caller's OWN input echoed back is not a leak; anything else differing is.
 */
async function outcome(call: () => Promise<unknown>, probedId: string): Promise<string> {
  const scrub = (s: string) => s.split(probedId).join('<probed-id>');
  try {
    return `answered ${scrub(serialise(await call()))}`;
  } catch (err) {
    if (err instanceof TRPCError) return `refused ${err.code}: ${scrub(err.message)}`;
    throw err;
  }
}

/**
 * Naming tenant B's id must answer EXACTLY as naming an id that exists
 * nowhere — same code, same message, same body. A difference of any kind is
 * an oracle for B's existence. Returns the shared answer so the caller can
 * assert it is a refusal where one is expected.
 */
export async function assertSameAsNonexistent(
  label: string,
  detector: LeakDetector,
  foreignId: string,
  call: (id: string) => Promise<unknown>,
): Promise<string> {
  const ghost = uuidv7();
  const foreign = await outcome(() => call(foreignId), foreignId);
  const nobody = await outcome(() => call(ghost), ghost);
  breachUnless(
    foreign === nobody,
    `${label}: tenant B's id answered differently from a nonexistent one\n  B's id:      ${foreign}\n  nonexistent: ${nobody}`,
  );
  detector.assertClean(`${label} (error/answer for B's id)`, foreign);
  return foreign;
}
