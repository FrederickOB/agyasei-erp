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

/**
 * The low-stock threshold, per (location, product). Migration 0007.
 *
 * Every quantity here is a scaled integer in the product's STOCKING unit —
 * `uomId`/`qtyScale` snapshot which unit that is, and a constraint trigger
 * refuses a row denominated in anything else. That is what makes "on hand <=
 * reorder point" a bare integer comparison for a SKU that sells by the bar
 * OR by the tonne (04 §4.4.1).
 *
 * `reorderUpToQty` and `leadTimeDays` are the Phase 2 seam: unread by the
 * Phase 1 alert, read by reorder management, on the same rows.
 */
export const reorderPoint = tenantTable(
  'reorder_point',
  {
    locationId: uuid('location_id').notNull(),
    productId: uuid('product_id').notNull(),
    /** Snapshot of the product's stocking unit — never a selling unit. */
    uomId: uuid('uom_id').notNull(),
    qtyScale: smallint('qty_scale').notNull(),
    /** At or below this, the product is low. bigint, never number (ADR-0004). */
    reorderPointQty: bigint('reorder_point_qty', { mode: 'bigint' }).notNull(),
    reorderUpToQty: bigint('reorder_up_to_qty', { mode: 'bigint' }),
    leadTimeDays: smallint('lead_time_days'),
    isActive: boolean('is_active').notNull(),
    notes: text('notes'),
    originTemplateId: text('origin_template_id'),
    originRef: text('origin_ref'),
  },
  (t) => [
    uniqueIndex('reorder_point_uq').on(t.tenantId, t.locationId, t.productId),
    index('reorder_point_location_ix').on(t.tenantId, t.locationId, t.productId),
  ],
);

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
    /** What the customer's paper says when it differs from receipt_no — a
     *  #14 collision landing under the emergency form (03 §3.7.5). NULL is
     *  the normal case. */
    receiptNoClaimed: text('receipt_no_claimed'),
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

// ---------------------------------------------------------------------------
// Human-facing document numbers, allocated offline (03 §3.7.5), and the
// review queue their failure mode reports into (03 §3.6.2). Mirrors
// migrations/0006_app_sequence_and_review.sql.
// ---------------------------------------------------------------------------

/**
 * The server-side allocation counter. NEVER synced to a device — 04 §4.7
 * deleted `document_number_range` precisely because a device-readable counter
 * is read back stale after a reset.
 */
export const sequenceCounter = tenantTable(
  'sequence_counter',
  {
    /** Pack + tenant vocabulary ('RECEIPT', …). Never a hard-coded enum. */
    sequenceKey: text('sequence_key').notNull(),
    locationId: uuid('location_id').notNull(),
    /** Next block_start to hand out. Only ever advances. */
    nextStart: bigint('next_start', { mode: 'bigint' }).notNull(),
    blockSize: integer('block_size').notNull(),
    /** e.g. '{location_code}-{prefix}-{n:06d}' — tenant configuration. */
    numberFormat: text('number_format').notNull(),
    numberPrefix: text('number_prefix').notNull(),
    originTemplateId: text('origin_template_id'),
    originRef: text('origin_ref'),
  },
  (t) => [
    uniqueIndex('sequence_counter_uq').on(t.tenantId, t.sequenceKey, t.locationId),
  ],
);

/** One allocated range held by one device. */
export const sequenceBlock = tenantTable(
  'sequence_block',
  {
    sequenceKey: text('sequence_key').notNull(),
    locationId: uuid('location_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    blockStart: bigint('block_start', { mode: 'bigint' }).notNull(),
    blockSize: integer('block_size').notNull(),
    /** Device-reported high-water mark. Never authoritative; never regresses. */
    consumedUpto: bigint('consumed_upto', { mode: 'bigint' }),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    exhaustedAt: timestamp('exhausted_at', { withTimezone: true }),
    closedReason: text('closed_reason'),
  },
  (t) => [
    uniqueIndex('sequence_block_range_uq').on(t.tenantId, t.sequenceKey, t.locationId, t.blockStart),
    index('sequence_block_device_ix').on(
      t.tenantId,
      t.sequenceKey,
      t.locationId,
      t.deviceId,
      t.blockStart,
    ),
  ],
);

/** The human review queue (03 §3.6.2). Money inside jsonb is a STRING. */
export const conflictReview = tenantTable(
  'conflict_review',
  {
    conflictClass: text('conflict_class').notNull(),
    /** 1 blocking .. 4 informational. */
    severity: smallint('severity').notNull(),
    entityTable: text('entity_table').notNull(),
    entityId: uuid('entity_id').notNull(),
    fieldPath: text('field_path'),
    ancestorValue: jsonb('ancestor_value'),
    proposals: jsonb('proposals').notNull(),
    pendingState: text('pending_state').notNull(),
    pendingValue: jsonb('pending_value').notNull(),
    /** Routes the queue by PERMISSION, never by named individual. */
    requiredPermission: text('required_permission').notNull(),
    status: text('status').notNull(),
    claimedBy: uuid('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: jsonb('resolution'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    escalateAt: timestamp('escalate_at', { withTimezone: true }).notNull(),
    escalationLevel: smallint('escalation_level').notNull(),
  },
  (t) => [
    index('conflict_review_queue_ix').on(t.tenantId, t.status, t.severity, t.openedAt),
    index('conflict_review_entity_ix').on(t.tenantId, t.entityTable, t.entityId),
  ],
);

/** Normalised review scope — §3.6.2's fix for the unused `location_scope[]`. */
export const conflictReviewLocation = tenantTable(
  'conflict_review_location',
  {
    reviewId: uuid('review_id').notNull(),
    locationId: uuid('location_id').notNull(),
  },
  (t) => [uniqueIndex('conflict_review_location_uq').on(t.tenantId, t.reviewId, t.locationId)],
);

// ---------------------------------------------------------------------------
// Access control (0005). See that migration's header for the one decision
// that shapes all of it: the PERMISSION CATALOGUE IS GLOBAL PLATFORM DATA
// (platform.permission, no tenant_id); everything a tenant OWNS — roles,
// their composition, users, assignments, the location closure — is in `app`
// through the tenant pattern, with RLS enabled and forced.
// ---------------------------------------------------------------------------

/**
 * The platform's vocabulary of atomic capabilities. GLOBAL — no tenant_id,
 * because a permission code is a server-side check, not a label, and a
 * tenant-minted code would resolve while granting nothing (02 §2.4).
 */
export const permission = platformSchema.table('permission', {
  code: text('code').primaryKey(),
  domain: text('domain').notNull(),
  description: text('description').notNull(),
  isSensitive: boolean('is_sensitive').notNull(),
  requiresFreshAuthorization: boolean('requires_fresh_authorization').notNull(),
  /** Shape of role_permission.bound, or null. Money inside is a STRING. */
  boundSchema: jsonb('bound_schema'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

/**
 * Derived transitive closure of app.location.parent_id, including the
 * depth-0 self row. Maintained by trigger; the adjacency list is the truth.
 * It exists so the SYNC boundary can resolve a user's locations without a
 * recursive CTE (02 §2.5).
 */
export const locationClosure = tenantTable(
  'location_closure',
  {
    ancestorId: uuid('ancestor_id').notNull(),
    descendantId: uuid('descendant_id').notNull(),
    depth: integer('depth').notNull(),
  },
  (t) => [
    uniqueIndex('location_closure_uq').on(t.tenantId, t.ancestorId, t.descendantId),
    index('location_closure_desc_ix').on(t.tenantId, t.descendantId, t.ancestorId),
  ],
);

/**
 * A tenant-owned, tenant-named, editable role. `name` is the TENANT's word
 * for one of the TENANT's jobs and no platform code reads it (CLAUDE.md
 * §2.9). `is_owner` is a capability statement, not a name: the one role that
 * holds the whole catalogue by construction.
 */
export const role = tenantTable('role', {
  name: text('name').notNull(),
  description: text('description').notNull(),
  isOwner: boolean('is_owner').notNull(),
  originTemplateId: text('origin_template_id'),
  originRef: text('origin_ref'),
});

/** The composition. Additive only — there are no deny rules (02 §2.4). */
export const rolePermission = tenantTable(
  'role_permission',
  {
    roleId: uuid('role_id').notNull(),
    permissionCode: text('permission_code').notNull(),
    /** Bound object; money members are decimal STRINGS (ADR-0004). */
    bound: jsonb('bound'),
  },
  (t) => [index('role_permission_role_ix').on(t.tenantId, t.roleId)],
);

/** The login identity the token's `uid` claim names. */
export const userAccount = tenantTable(
  'user_account',
  {
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    staffId: uuid('staff_id'),
    status: text('status').notNull(),
  },
  (t) => [index('user_account_staff_ix').on(t.tenantId, t.staffId)],
);

/**
 * A user holds a ROLE at a SCOPE NODE, effective-dated. Several rows per
 * user are normal and are the point: resolution is the union of grants PER
 * LOCATION, so a permission granted at one location never leaks to another.
 * `id` is what audit_event.grant_id points at.
 */
export const userRoleAssignment = tenantTable(
  'user_role_assignment',
  {
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    /** ANY node in the tenant's tree, at any depth — never an outlet id. */
    scopeLocationId: uuid('scope_location_id').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
  },
  (t) => [
    index('user_role_assignment_user_ix').on(t.tenantId, t.userId, t.scopeLocationId),
    index('user_role_assignment_role_ix').on(t.tenantId, t.roleId),
  ],
);
