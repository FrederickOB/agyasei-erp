/**
 * Fixtures for the procurement suites (migration 0008).
 *
 * Everything runs through the tenant's own RLS context, as app_user — the same
 * path production takes. Nothing here uses `asAdmin` to set up a row a real
 * caller could not have written, because a fixture that bypasses the rules is
 * a fixture that agrees with neither side (docs/phase1-status.md §0).
 *
 * The catalogue built here is a deliberate echo of the hard case: a product
 * stocked in a DISCRETE unit and bought in a CONTINUOUS one — bars in the
 * yard, tonnes on the invoice, at exactly 13500/d² bars per tonne (04 §4.4.1)
 * — because that is where a receipt's two quantities stop being the same
 * number.
 */
import { uuidv7 } from '../src/ids.js';
import type { Queryable } from '../src/testing/harness.js';
import { newWrite, nextHlc } from './util.js';

export interface CatalogueFixture {
  categoryId: string;
  /** BAR_12M, scale 0 — the stocking unit; what a stocktaker counts. */
  stockingUomId: string;
  /** TON, scale 3 — the purchase unit; what the supplier invoices. */
  purchaseUomId: string;
  productId: string;
}

async function makeUom(
  tx: Queryable,
  tenantId: string,
  code: string,
  dimension: string,
  qtyScale: number,
): Promise<string> {
  const id = uuidv7();
  const w = await newWrite(tx, tenantId, 'test.uom');
  await tx.query(
    `insert into app.unit_of_measure (tenant_id, id, write_id, hlc, code, name, dimension, qty_scale)
     values ($1, $2, $3, $4, $5, $5, $6, $7)`,
    [tenantId, id, w, nextHlc(), code, dimension, qtyScale],
  );
  return id;
}

/**
 * A category, two units and one product with a stocking `product_uom` row and
 * a BUYABLE one. `can_buy` on the second row is the whole point: 0008 refuses
 * a `supplier_product` whose purchase unit is not a buyable unit of the
 * product, so a fixture that forgot it would fail loudly rather than quietly
 * prove nothing.
 */
export async function makeCatalogue(
  tx: Queryable,
  tenantId: string,
  opts: { skuCode?: string; buyableCanBuy?: boolean } = {},
): Promise<CatalogueFixture> {
  const w = await newWrite(tx, tenantId, 'test.catalogue');
  const categoryId = uuidv7();
  await tx.query(
    `insert into app.product_category (tenant_id, id, write_id, hlc, code, name)
     values ($1, $2, $3, $4, $5, $5)`,
    [tenantId, categoryId, w, nextHlc(), `CAT-${categoryId.slice(-6)}`],
  );

  const stockingUomId = await makeUom(tx, tenantId, `BAR-${categoryId.slice(-4)}`, 'COUNT', 0);
  const purchaseUomId = await makeUom(tx, tenantId, `TON-${categoryId.slice(-4)}`, 'MASS', 3);

  const productId = uuidv7();
  await tx.query(
    `insert into app.product
       (tenant_id, id, write_id, hlc, sku_code, name, category_id, stocking_uom_id, tax_code)
     values ($1, $2, $3, $4, $5, $5, $6, $7, 'GH.VAT.STD')`,
    [
      tenantId,
      productId,
      w,
      nextHlc(),
      opts.skuCode ?? `SKU-${productId.slice(-6)}`,
      categoryId,
      stockingUomId,
    ],
  );

  // The stocking unit at 1/1 — exact, so tolerance 0.
  await tx.query(
    `insert into app.product_uom
       (tenant_id, id, write_id, hlc, product_id, uom_id, factor_num, factor_den,
        can_sell, can_buy, is_default_sell, tolerance_bp, sort_order)
     values ($1, $2, $3, $4, $5, $6, 1, 1, true, true, true, 0, 0)`,
    [tenantId, uuidv7(), w, nextHlc(), productId, stockingUomId],
  );
  // The purchase unit: 13500/144 bars per tonne for 12 mm rebar. Exact as a
  // rational, not as a decimal. tolerance_bp has NO default and must be
  // stated (04 §4.4.4) — 43 bp is one bar of slack on a 234-bar line.
  await tx.query(
    `insert into app.product_uom
       (tenant_id, id, write_id, hlc, product_id, uom_id, factor_num, factor_den,
        can_sell, can_buy, is_default_sell, tolerance_bp, sort_order)
     values ($1, $2, $3, $4, $5, $6, 13500, 144, true, $7, false, 43, 1)`,
    [tenantId, uuidv7(), w, nextHlc(), productId, purchaseUomId, opts.buyableCanBuy ?? true],
  );

  return { categoryId, stockingUomId, purchaseUomId, productId };
}

export interface SupplierFixture {
  supplierId: string;
  goodsCapabilityTypeId: string;
  haulageCapabilityTypeId: string;
}

/**
 * The two capability TYPES a tenant defines. `code`/`name` are the tenant's
 * own words — deliberately NOT 'GOODS'/'HAULAGE' here, so a test that
 * accidentally matched on the tenant's vocabulary instead of the platform
 * `kind` would fail (ADR-0006, CLAUDE.md §2.9).
 */
export async function makeCapabilityTypes(
  tx: Queryable,
  tenantId: string,
  prefix = 'T',
): Promise<{ goods: string; haulage: string }> {
  const w = await newWrite(tx, tenantId, 'test.capability_types');
  const goods = uuidv7();
  const haulage = uuidv7();
  await tx.query(
    `insert into app.supplier_capability_type (tenant_id, id, write_id, hlc, code, name, kind)
     values ($1, $2, $3, $4, $5, 'Sells things', 'GOODS')`,
    [tenantId, goods, w, nextHlc(), `${prefix}-SELLS`],
  );
  await tx.query(
    `insert into app.supplier_capability_type (tenant_id, id, write_id, hlc, code, name, kind)
     values ($1, $2, $3, $4, $5, 'Trucking', 'HAULAGE')`,
    [tenantId, haulage, w, nextHlc(), `${prefix}-TRUCKS`],
  );
  return { goods, haulage };
}

export async function makeSupplier(
  tx: Queryable,
  tenantId: string,
  opts: {
    code: string;
    name?: string;
    capabilityTypeIds?: readonly string[];
    paymentTermsDays?: number;
    currencyCode?: string;
  },
): Promise<string> {
  const id = uuidv7();
  const w = await newWrite(tx, tenantId, 'test.supplier');
  await tx.query(
    `insert into app.supplier
       (tenant_id, id, write_id, hlc, code, name, payment_terms_days, currency_code)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      id,
      w,
      nextHlc(),
      opts.code,
      opts.name ?? opts.code,
      opts.paymentTermsDays ?? 30,
      opts.currencyCode ?? 'GHS',
    ],
  );
  for (const capId of opts.capabilityTypeIds ?? []) {
    await tx.query(
      `insert into app.supplier_capability
         (tenant_id, id, write_id, hlc, supplier_id, capability_type_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [tenantId, uuidv7(), w, nextHlc(), id, capId],
    );
  }
  return id;
}

export interface OrderFixture {
  purchaseOrderId: string;
  purchaseOrderLineId: string;
}

/**
 * A DRAFT order with one line. Every order starts as a draft — 0008 refuses
 * an insert at any other status, which is the structural half of "approval is
 * a separate act".
 */
export async function makeDraftOrder(
  tx: Queryable,
  tenantId: string,
  opts: {
    supplierId: string;
    locationId: string;
    catalogue: CatalogueFixture;
    qtyOrdered?: string;
    withLine?: boolean;
  },
): Promise<OrderFixture> {
  const w = await newWrite(tx, tenantId, 'test.purchase_order');
  const purchaseOrderId = uuidv7();
  await tx.query(
    `insert into app.purchase_order
       (tenant_id, id, write_id, hlc, supplier_id, deliver_to_location_id,
        order_date, currency_code, money_scale)
     values ($1, $2, $3, $4, $5, $6, '2026-08-21', 'GHS', 100)`,
    [tenantId, purchaseOrderId, w, nextHlc(), opts.supplierId, opts.locationId],
  );

  let purchaseOrderLineId = '';
  if (opts.withLine !== false) {
    purchaseOrderLineId = uuidv7();
    // 10.000 t at 13500/144 bars per tonne = 937.5 → 937 bars expected.
    await tx.query(
      `insert into app.purchase_order_line
         (tenant_id, id, write_id, hlc, purchase_order_id, line_no, product_id,
          uom_id, qty_scale, qty_ordered, unit_price_e4,
          stocking_uom_id, qty_stock_scale, qty_ordered_stock, factor_num, factor_den,
          line_net_minor)
       values ($1, $2, $3, $4, $5, 1, $6, $7, 3, $8, 45000000, $9, 0, 937, 13500, 144, 4500000)`,
      [
        tenantId,
        purchaseOrderLineId,
        w,
        nextHlc(),
        purchaseOrderId,
        opts.catalogue.productId,
        opts.catalogue.purchaseUomId,
        opts.qtyOrdered ?? '10000',
        opts.catalogue.stockingUomId,
      ],
    );
  }
  return { purchaseOrderId, purchaseOrderLineId };
}

/** Move an order's status. Returns nothing; the trigger decides legality. */
export async function setOrderStatus(
  tx: Queryable,
  tenantId: string,
  purchaseOrderId: string,
  toStatus: string,
  opts: { approvedByUserId?: string } = {},
): Promise<void> {
  const approvalColumns =
    toStatus === 'APPROVED'
      ? `, approved_at = transaction_timestamp(), approved_by_user_id = $4`
      : '';
  const params: unknown[] = [tenantId, purchaseOrderId, toStatus];
  if (toStatus === 'APPROVED') params.push(opts.approvedByUserId ?? null);
  await tx.query(
    `update app.purchase_order set status = $3${approvalColumns}
      where tenant_id = $1 and id = $2`,
    params,
  );
}
