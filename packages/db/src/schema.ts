/**
 * Drizzle MIRRORS of the hand-written migrations. Never generated from, and
 * never generating, DDL — migrations/*.sql are the source of truth.
 *
 * Money, quantities and rates are `bigint` with { mode: 'bigint' } so the
 * TypeScript side is bigint too — one canonical type across both layers,
 * never `number` (ADR-0004). Rates (unit prices/costs) are e4 scaled
 * integers; quantities are scaled integers whose scale rides in qty_scale.
 */
import {
  bigint,
  boolean,
  char,
  customType,
  date,
  integer,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  index,
  uuid,
} from 'drizzle-orm/pg-core';
import { appSchema, platformSchema, registerAppTable, tenantTable } from './tenant-table.js';

/** Postgres daterange, kept as its text literal in TS. */
const daterange = customType<{ data: string }>({
  dataType() {
    return 'daterange';
  },
});

const textArray = customType<{ data: string[] }>({
  dataType() {
    return 'text[]';
  },
});

// ---------------------------------------------------------------------------
// platform — NOT tenant-owned; exempt by explicit list from the tenant
// pattern (01-tenancy §1). Reviewed by a human on every migration.
// ---------------------------------------------------------------------------

export const jurisdiction = platformSchema.table('jurisdiction', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  currencySymbol: text('currency_symbol').notNull(),
  /** The divisor itself (GHS: 100n). NEVER assumed. bigint (ADR-0004/0007). */
  minorUnitsPerMajor: bigint('minor_units_per_major', { mode: 'bigint' }).notNull(),
  cashRoundingUnitMinor: bigint('cash_rounding_unit_minor', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const tenant = platformSchema.table('tenant', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull(),
  legalName: text('legal_name').notNull(),
  status: text('status').notNull(),
  jurisdictionCode: text('jurisdiction_code').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  offboardedAt: timestamp('offboarded_at', { withTimezone: true }),
});

export const tenantDatabase = platformSchema.table('tenant_database', {
  tenantId: uuid('tenant_id').primaryKey(),
  /** Pointer into the secret store — never a DSN. */
  dsnRef: text('dsn_ref').notNull(),
  syncServiceRef: text('sync_service_ref').notNull(),
  movedAt: timestamp('moved_at', { withTimezone: true }).notNull(),
});

export const taxCode = platformSchema.table('tax_code', {
  jurisdictionCode: text('jurisdiction_code').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  inputDeductible: boolean('input_deductible').notNull(),
});

export const taxRate = platformSchema.table('tax_rate', {
  id: uuid('id').primaryKey(),
  jurisdictionCode: text('jurisdiction_code').notNull(),
  taxCode: text('tax_code').notNull(),
  rateBp: integer('rate_bp').notNull(),
  baseKind: text('base_kind').notNull(),
  baseIncludes: textArray('base_includes').notNull(),
  roundingLevel: text('rounding_level').notNull(),
  roundingMode: text('rounding_mode').notNull(),
  effective: daterange('effective').notNull(),
  legalReference: text('legal_reference').notNull(),
  /** NULL = [UNCONFIRMED]; the §2.8 go-live gate in the schema. */
  confirmedBy: text('confirmed_by'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// app.write_log — the ONE write registry (04 §4.2.2). Not built by
// tenantTable because it IS the referent of the write spine; explicitly
// registered with a per-assertion write_id exemption (see tenant-table.ts).
// ---------------------------------------------------------------------------
export const writeLog = appSchema.table('write_log', {
  tenantId: uuid('tenant_id').notNull(),
  /** UUIDv7 from the device. THE idempotency key — unique PER TENANT. */
  id: uuid('id').notNull(),
  origin: text('origin').notNull(),
  /** Server-stamped at ingest. */
  hlc: text('hlc').notNull(),
  /** The device's own clock assertion. UNTRUSTED. */
  claimedHlc: text('claimed_hlc'),
  deviceId: uuid('device_id'),
  userId: uuid('user_id'),
  locationId: uuid('location_id'),
  op: text('op').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  requestHash: text('request_hash').notNull(), // bytea in SQL; hex in the mirror
  responseBody: jsonb('response_body'),
  clientWallAt: timestamp('client_wall_at', { withTimezone: true }),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
});
registerAppTable('write_log', writeLog);

// ---------------------------------------------------------------------------
// app — every table below is defined through tenantTable(): the factory
// injects tenant_id / id / write_id / hlc and the (tenant_id, id) PK.
// ---------------------------------------------------------------------------

export const locationType = tenantTable('location_type', {
  code: text('code').notNull(),
  name: text('name').notNull(),
  originTemplateId: text('origin_template_id'),
  originRef: text('origin_ref'),
});

export const location = tenantTable(
  'location',
  {
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Closed PLATFORM enum: OUTLET | WAREHOUSE | GROUP | TRANSIT (04 §4.3). */
    kind: text('kind').notNull(),
    locationTypeId: uuid('location_type_id'),
    parentId: uuid('parent_id'),
    isActive: boolean('is_active').notNull(),
    timezone: text('timezone').notNull(),
    originTemplateId: text('origin_template_id'),
    originRef: text('origin_ref'),
  },
  (t) => [index('location_parent_ix').on(t.tenantId, t.parentId)],
);

export const unitOfMeasure = tenantTable('unit_of_measure', {
  code: text('code').notNull(),
  name: text('name').notNull(),
  dimension: text('dimension').notNull(),
  qtyScale: smallint('qty_scale').notNull(),
  originTemplateId: text('origin_template_id'),
  originRef: text('origin_ref'),
});

export const productCategory = tenantTable('product_category', {
  code: text('code').notNull(),
  name: text('name').notNull(),
  parentId: uuid('parent_id'),
  originTemplateId: text('origin_template_id'),
  originRef: text('origin_ref'),
});

export const product = tenantTable(
  'product',
  {
    skuCode: text('sku_code').notNull(),
    name: text('name').notNull(),
    categoryId: uuid('category_id').notNull(),
    stockingUomId: uuid('stocking_uom_id').notNull(),
    taxCode: text('tax_code').notNull(),
    stockTracking: text('stock_tracking').notNull(),
    isSellable: boolean('is_sellable').notNull(),
    isPurchasable: boolean('is_purchasable').notNull(),
    notes: text('notes'),
    originTemplateId: text('origin_template_id'),
    originRef: text('origin_ref'),
  },
  (t) => [index('product_category_ix').on(t.tenantId, t.categoryId)],
);

export const productUom = tenantTable('product_uom', {
  productId: uuid('product_id').notNull(),
  uomId: uuid('uom_id').notNull(),
  /** Rational conversion: num/den stocking units per ONE selling unit. */
  factorNum: bigint('factor_num', { mode: 'bigint' }).notNull(),
  factorDen: bigint('factor_den', { mode: 'bigint' }).notNull(),
  canSell: boolean('can_sell').notNull(),
  canBuy: boolean('can_buy').notNull(),
  isDefaultSell: boolean('is_default_sell').notNull(),
  /** NO default in the DDL — a tolerance must be stated (04 §4.4.4). */
  toleranceBp: integer('tolerance_bp').notNull(),
  sortOrder: smallint('sort_order').notNull(),
  originTemplateId: text('origin_template_id'),
  originRef: text('origin_ref'),
});

export const priceList = tenantTable('price_list', {
  code: text('code').notNull(),
  name: text('name').notNull(),
  isTaxInclusive: boolean('is_tax_inclusive').notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  priority: smallint('priority').notNull(),
  locationId: uuid('location_id'),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  originTemplateId: text('origin_template_id'),
  originRef: text('origin_ref'),
});

export const priceListItem = tenantTable('price_list_item', {
  priceListId: uuid('price_list_id').notNull(),
  productId: uuid('product_id').notNull(),
  uomId: uuid('uom_id').notNull(),
  /** Minor units per selling unit × 10⁴ — bigint, never number (ADR-0004). */
  unitPriceE4: bigint('unit_price_e4', { mode: 'bigint' }).notNull(),
  minQty: bigint('min_qty', { mode: 'bigint' }).notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
});

export const movementReason = tenantTable('movement_reason', {
  code: text('code').notNull(),
  name: text('name').notNull(),
  originTemplateId: text('origin_template_id'),
  originRef: text('origin_ref'),
});

export const stockMovement = tenantTable(
  'stock_movement',
  {
    locationId: uuid('location_id').notNull(),
    productId: uuid('product_id').notNull(),
    /** SIGNED scaled integer in the stocking unit; scale in qtyScale. */
    qtyDelta: bigint('qty_delta', { mode: 'bigint' }).notNull(),
    qtyScale: smallint('qty_scale').notNull(),
    uomId: uuid('uom_id').notNull(),
    reasonId: uuid('reason_id').notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceId: uuid('source_id'),
    unitCostE4: bigint('unit_cost_e4', { mode: 'bigint' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    businessDate: date('business_date').notNull(),
    reversesId: uuid('reverses_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    index('stock_movement_replay_ix').on(t.tenantId, t.locationId, t.productId, t.hlc),
    index('stock_movement_day_ix').on(t.tenantId, t.businessDate, t.locationId),
    index('stock_movement_source_ix').on(t.tenantId, t.sourceKind, t.sourceId),
  ],
);

export const customer = tenantTable('customer', {
  code: text('code').notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  isCreditCustomer: boolean('is_credit_customer').notNull(),
});

export const customerAccount = tenantTable('customer_account', {
  customerId: uuid('customer_id').notNull(),
  creditLimitMinor: bigint('credit_limit_minor', { mode: 'bigint' }).notNull(),
  termsDays: smallint('terms_days').notNull(),
  facilityFeeBpPerMonth: integer('facility_fee_bp_per_month').notNull(),
  status: text('status').notNull(),
});

export const creditEntry = tenantTable(
  'credit_entry',
  {
    accountId: uuid('account_id').notNull(),
    kind: text('kind').notNull(),
    /** SIGNED minor units; debit-to-customer is positive. */
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    businessDate: date('business_date').notNull(),
    dueDate: date('due_date'),
    sourceKind: text('source_kind'),
    sourceId: uuid('source_id'),
    appliesToId: uuid('applies_to_id'),
  },
  (t) => [index('credit_entry_account_ix').on(t.tenantId, t.accountId, t.businessDate)],
);

export const sale = tenantTable(
  'sale',
  {
    locationId: uuid('location_id').notNull(),
    customerId: uuid('customer_id'),
    priceListId: uuid('price_list_id').notNull(),
    receiptNo: text('receipt_no').notNull(),
    businessDate: date('business_date').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    voidsSaleId: uuid('voids_sale_id'),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    /** Snapshot of minor_units_per_major. NEVER assume 100. */
    moneyScale: bigint('money_scale', { mode: 'bigint' }).notNull(),
    subtotalNetMinor: bigint('subtotal_net_minor', { mode: 'bigint' }).notNull(),
    discountMinor: bigint('discount_minor', { mode: 'bigint' }).notNull(),
    taxTotalMinor: bigint('tax_total_minor', { mode: 'bigint' }).notNull(),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    uniqueIndex('sale_receipt_uq').on(t.tenantId, t.locationId, t.receiptNo),
    index('sale_day_ix').on(t.tenantId, t.locationId, t.businessDate),
  ],
);

export const saleLine = tenantTable(
  'sale_line',
  {
    saleId: uuid('sale_id').notNull(),
    lineNo: smallint('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    sellingUomId: uuid('selling_uom_id').notNull(),
    qtySell: bigint('qty_sell', { mode: 'bigint' }).notNull(),
    qtySellScale: smallint('qty_sell_scale').notNull(),
    unitPriceE4: bigint('unit_price_e4', { mode: 'bigint' }).notNull(),
    stockingUomId: uuid('stocking_uom_id').notNull(),
    qtyStock: bigint('qty_stock', { mode: 'bigint' }).notNull(),
    qtyStockScale: smallint('qty_stock_scale').notNull(),
    factorNum: bigint('factor_num', { mode: 'bigint' }).notNull(),
    factorDen: bigint('factor_den', { mode: 'bigint' }).notNull(),
    lineDiscountMinor: bigint('line_discount_minor', { mode: 'bigint' }).notNull(),
    lineNetMinor: bigint('line_net_minor', { mode: 'bigint' }).notNull(),
    taxCode: text('tax_code').notNull(),
    taxMinor: bigint('tax_minor', { mode: 'bigint' }).notNull(),
  },
  (t) => [uniqueIndex('sale_line_uq').on(t.tenantId, t.saleId, t.lineNo)],
);

export const saleTaxLine = tenantTable(
  'sale_tax_line',
  {
    saleId: uuid('sale_id').notNull(),
    saleLineId: uuid('sale_line_id').notNull(),
    seq: smallint('seq').notNull(),
    taxCode: text('tax_code').notNull(),
    rateBp: integer('rate_bp').notNull(),
    baseKind: text('base_kind').notNull(),
    baseIncludes: textArray('base_includes').notNull(),
    roundingLevel: text('rounding_level').notNull(),
    roundingMode: text('rounding_mode').notNull(),
    baseMinor: bigint('base_minor', { mode: 'bigint' }).notNull(),
    taxMinor: bigint('tax_minor', { mode: 'bigint' }).notNull(),
    /** The exact effective-dated platform.tax_rate row used. */
    taxRateId: uuid('tax_rate_id').notNull(),
  },
  (t) => [uniqueIndex('sale_tax_line_uq').on(t.tenantId, t.saleLineId, t.seq)],
);

/**
 * Staff — CAPTURE ONLY (CLAUDE.md §2.4). No statutory columns, no rates, no
 * brackets, in any jurisdiction, ever. Bureau figures arrive as imported
 * rows in a later phase and are recorded, never derived.
 */
export const staff = tenantTable('staff', {
  code: text('code').notNull(),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  nationalIdRef: text('national_id_ref'),
  hiredOn: date('hired_on'),
  endedOn: date('ended_on'),
});
