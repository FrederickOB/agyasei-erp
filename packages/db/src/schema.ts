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

/**
 * The credit limit's append-only decision log (migration 0011, 06 §6.6.1).
 *
 * `customer_account.credit_limit_minor` above is a PROJECTION of the accepted
 * head of this chain, written only by `app.apply_credit_limit_version()`;
 * `supersedes_id` is the compare-and-set, and `credit_limit_one_head` is what
 * makes two concurrent decisions impossible rather than merely unlikely.
 */
export const creditLimitVersion = tenantTable(
  'credit_limit_version',
  {
    creditAccountId: uuid('credit_account_id').notNull(),
    limitMinor: bigint('limit_minor', { mode: 'bigint' }).notNull(),
    termsDays: smallint('terms_days').notNull(),
    feeRateBp: integer('fee_rate_bp').notNull(),
    reasonCode: text('reason_code').notNull(),
    note: text('note'),
    /** The version its author believed was current. NULL only for genesis. */
    supersedesId: uuid('supersedes_id'),
    state: text('state').notNull(),
    decidedBy: uuid('decided_by').notNull(),
    decidedAtLocation: uuid('decided_at_location'),
    effectiveFrom: date('effective_from').notNull(),
  },
  (t) => [
    index('credit_limit_version_account_ix').on(t.tenantId, t.creditAccountId, t.effectiveFrom),
  ],
);

/**
 * The credit account's append-only lifecycle log (migration 0012,
 * credit-offline-plan R4).
 *
 * `customer_account.status` is a PROJECTION of the latest row here, written
 * only by `app.apply_credit_status_change()`; the guard on
 * `app.customer_account` refuses any other write to the column, and this table
 * refuses UPDATE and DELETE outright — a suspension is undone by recording the
 * reinstatement, never by editing or deleting the decision.
 *
 * `note` is NOT NULL because "why was this customer cut off" is the question
 * somebody asks three months later.
 */
export const creditStatusChange = tenantTable(
  'credit_status_change',
  {
    creditAccountId: uuid('credit_account_id').notNull(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    reasonCode: text('reason_code').notNull(),
    note: text('note').notNull(),
    exposureAtDecisionMinor: bigint('exposure_at_decision_minor', {
      mode: 'bigint',
    }).notNull(),
    decidedBy: uuid('decided_by').notNull(),
    decidedAtLocation: uuid('decided_at_location'),
  },
  (t) => [
    index('credit_status_change_account_ix').on(t.tenantId, t.creditAccountId, t.createdAt),
  ],
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

// ---------------------------------------------------------------------------
// Procurement, receiving and logistics (0008). See that migration's header
// for the two decisions that shape all of it: a HAULIER IS A SUPPLIER WITH A
// HAULAGE CAPABILITY (ADR-0001 — there is no vehicle, driver, fuel or
// maintenance entity anywhere in this system), and A PURCHASE UNIT IS A
// product_uom ROW WITH can_buy, so buying cement by the tonne and selling it
// by the 50 kg bag go through the same conversion machinery (§4.10).
// ---------------------------------------------------------------------------

/**
 * Everyone the tenant buys from or pays to carry goods. One party type,
 * because the books do not distinguish them: both invoice, both are paid on
 * terms, both belong in AP — which is what puts haulage spend where
 * distribution cost as a % of revenue can be measured (ADR-0001, Q1).
 */
export const supplier = tenantTable(
  'supplier',
  {
    code: text('code').notNull(),
    name: text('name').notNull(),
    paymentTermsDays: smallint('payment_terms_days').notNull(),
    /** Snapshot; a trigger refuses anything but the tenant's pack currency. */
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    contactName: text('contact_name'),
    contactPhone: text('contact_phone'),
    contactEmail: text('contact_email'),
    addressText: text('address_text'),
    notes: text('notes'),
    isActive: boolean('is_active').notNull(),
    originTemplateId: text('origin_template_id'),
    originRef: text('origin_ref'),
  },
  (t) => [
    uniqueIndex('supplier_code_uq').on(t.tenantId, t.code),
    index('supplier_active_ix').on(t.tenantId, t.isActive, t.code),
  ],
);

/**
 * What a supplier can do, as the tenant's own vocabulary over a platform
 * structure — the `location_type` / `location.kind` split of 04 §4.3, applied
 * again. `code`/`name` are the TENANT's words and no platform code reads
 * them; `kind` is the closed platform enum the platform genuinely branches on
 * (a carrier must be able to HAUL).
 */
export const supplierCapabilityType = tenantTable(
  'supplier_capability_type',
  {
    /** TENANT vocabulary. Never branched on (ADR-0006). */
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** PLATFORM structure: 'GOODS' | 'HAULAGE'. The only readable column. */
    kind: text('kind').notNull(),
    originTemplateId: text('origin_template_id'),
    originRef: text('origin_ref'),
  },
  (t) => [
    uniqueIndex('supplier_capability_type_code_uq').on(t.tenantId, t.code),
    index('supplier_capability_type_kind_ix').on(t.tenantId, t.kind),
  ],
);

/** A supplier holds several capabilities at once — selling and hauling both. */
export const supplierCapability = tenantTable(
  'supplier_capability',
  {
    supplierId: uuid('supplier_id').notNull(),
    capabilityTypeId: uuid('capability_type_id').notNull(),
    notes: text('notes'),
    originTemplateId: text('origin_template_id'),
    originRef: text('origin_ref'),
  },
  (t) => [
    uniqueIndex('supplier_capability_uq').on(t.tenantId, t.supplierId, t.capabilityTypeId),
    index('supplier_capability_type_ix').on(t.tenantId, t.capabilityTypeId, t.supplierId),
  ],
);

/**
 * MULTI-SOURCE: one row per (supplier, product). The same cement from three
 * manufacturers is three rows, which is what makes the plan's negotiating
 * leverage data rather than a memory.
 *
 * `purchaseUomId` must be a live `product_uom` row for the product with
 * `can_buy` — enforced by constraint trigger, because a purchase unit with no
 * conversion factor cannot be turned into the stocking unit the ledger is
 * denominated in. `lastPriceE4` is minor units per ONE purchase unit × 10⁴.
 */
export const supplierProduct = tenantTable(
  'supplier_product',
  {
    supplierId: uuid('supplier_id').notNull(),
    productId: uuid('product_id').notNull(),
    supplierSku: text('supplier_sku'),
    purchaseUomId: uuid('purchase_uom_id').notNull(),
    leadTimeDays: smallint('lead_time_days'),
    /** e4 rate per ONE purchase unit; bigint, never number (ADR-0004). */
    lastPriceE4: bigint('last_price_e4', { mode: 'bigint' }),
    lastPriceOn: date('last_price_on'),
    isPreferred: boolean('is_preferred').notNull(),
    isActive: boolean('is_active').notNull(),
    notes: text('notes'),
    originTemplateId: text('origin_template_id'),
    originRef: text('origin_ref'),
  },
  (t) => [
    uniqueIndex('supplier_product_uq').on(t.tenantId, t.supplierId, t.productId),
    index('supplier_product_product_ix').on(t.tenantId, t.productId, t.supplierId),
  ],
);

/**
 * A purchase order, and a STATE MACHINE. Legal transitions live in
 * `app.purchase_order_legal_transitions()` and are enforced by trigger:
 * inserts must be DRAFT, nothing returns to DRAFT once goods have been
 * received, and CANCELLED is unreachable after any receipt. A short delivery
 * ends at CLOSED, which keeps the receipts attached.
 */
export const purchaseOrder = tenantTable(
  'purchase_order',
  {
    supplierId: uuid('supplier_id').notNull(),
    deliverToLocationId: uuid('deliver_to_location_id').notNull(),
    /** Nullable: a network-wide sequence is coordination offline cannot do. */
    orderNo: text('order_no'),
    status: text('status').notNull(),
    orderDate: date('order_date').notNull(),
    expectedAt: date('expected_at'),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    /** Pack snapshot of minor_units_per_major. NEVER assume 100. */
    moneyScale: bigint('money_scale', { mode: 'bigint' }).notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByUserId: uuid('approved_by_user_id'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    notes: text('notes'),
    originTemplateId: text('origin_template_id'),
    originRef: text('origin_ref'),
  },
  (t) => [
    uniqueIndex('purchase_order_no_uq').on(t.tenantId, t.orderNo),
    index('purchase_order_supplier_ix').on(t.tenantId, t.supplierId, t.orderDate),
    index('purchase_order_location_ix').on(
      t.tenantId,
      t.deliverToLocationId,
      t.status,
      t.orderDate,
    ),
    index('purchase_order_open_ix').on(t.tenantId, t.status, t.expectedAt),
  ],
);

/**
 * Mirrors `sale_line`'s shape deliberately (04 §4.4.4): what is PRICED
 * (`qtyOrdered`, in the supplier's unit) and what the yard EXPECTS
 * (`qtyOrderedStock`, in the stocking unit) are two facts, with the rational
 * conversion factor snapshotted so correcting it tomorrow does not restate a
 * historical document. Lines are editable only while the order is DRAFT.
 */
export const purchaseOrderLine = tenantTable(
  'purchase_order_line',
  {
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    lineNo: smallint('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    uomId: uuid('uom_id').notNull(),
    qtyScale: smallint('qty_scale').notNull(),
    qtyOrdered: bigint('qty_ordered', { mode: 'bigint' }).notNull(),
    unitPriceE4: bigint('unit_price_e4', { mode: 'bigint' }).notNull(),
    stockingUomId: uuid('stocking_uom_id').notNull(),
    qtyStockScale: smallint('qty_stock_scale').notNull(),
    qtyOrderedStock: bigint('qty_ordered_stock', { mode: 'bigint' }).notNull(),
    factorNum: bigint('factor_num', { mode: 'bigint' }).notNull(),
    factorDen: bigint('factor_den', { mode: 'bigint' }).notNull(),
    lineNetMinor: bigint('line_net_minor', { mode: 'bigint' }).notNull(),
    notes: text('notes'),
  },
  (t) => [
    uniqueIndex('purchase_order_line_uq').on(t.tenantId, t.purchaseOrderId, t.lineNo),
    index('purchase_order_line_product_ix').on(t.tenantId, t.productId, t.purchaseOrderId),
  ],
);

/**
 * A goods receipt. A DOCUMENT: append-only, never soft-deleted (04 §4.2.4).
 * `purchaseOrderId` is nullable because a receipt with no order genuinely
 * happens, and recording it honestly beats inventing an order to satisfy a
 * NOT NULL. Where there IS an order, a trigger refuses a receipt unless the
 * order is APPROVED or PARTIALLY_RECEIVED and the supplier matches.
 */
export const goodsReceipt = tenantTable(
  'goods_receipt',
  {
    purchaseOrderId: uuid('purchase_order_id'),
    supplierId: uuid('supplier_id').notNull(),
    locationId: uuid('location_id').notNull(),
    /** The trading day the goods landed — the accounting fact. */
    businessDate: date('business_date').notNull(),
    /** Device time. UNTRUSTED; display and forensics only (03 §3.4.2). */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    supplierDeliveryNoteRef: text('supplier_delivery_note_ref'),
    supplierInvoiceRef: text('supplier_invoice_ref'),
    receivedByUserId: uuid('received_by_user_id'),
    notes: text('notes'),
  },
  (t) => [
    index('goods_receipt_order_ix').on(t.tenantId, t.purchaseOrderId),
    index('goods_receipt_location_ix').on(t.tenantId, t.locationId, t.businessDate),
    index('goods_receipt_supplier_ix').on(t.tenantId, t.supplierId, t.businessDate),
  ],
);

/**
 * TWO QUANTITIES, BECAUSE SHORT DELIVERIES ARE NORMAL (§4.10):
 * `qtyReceived` is what the supplier invoiced, in THEIR unit; `qtyStock` is
 * what entered the yard, in the stocking unit, and is the only figure
 * `stock_movement` sees. Neither is derived from the other.
 * `qtyStockComputed` is what the snapshotted factor said it should be, and a
 * difference needs a human's id in `conversionConfirmedBy` (04 §4.4.4).
 */
export const goodsReceiptLine = tenantTable(
  'goods_receipt_line',
  {
    goodsReceiptId: uuid('goods_receipt_id').notNull(),
    lineNo: smallint('line_no').notNull(),
    purchaseOrderLineId: uuid('purchase_order_line_id'),
    productId: uuid('product_id').notNull(),
    uomId: uuid('uom_id').notNull(),
    qtyReceivedScale: smallint('qty_received_scale').notNull(),
    qtyReceived: bigint('qty_received', { mode: 'bigint' }).notNull(),
    stockingUomId: uuid('stocking_uom_id').notNull(),
    qtyStockScale: smallint('qty_stock_scale').notNull(),
    qtyStock: bigint('qty_stock', { mode: 'bigint' }).notNull(),
    qtyStockComputed: bigint('qty_stock_computed', { mode: 'bigint' }).notNull(),
    factorNum: bigint('factor_num', { mode: 'bigint' }).notNull(),
    factorDen: bigint('factor_den', { mode: 'bigint' }).notNull(),
    conversionConfirmedBy: uuid('conversion_confirmed_by'),
    /** As invoiced, per ONE purchase unit, × 10⁴. */
    unitCostE4: bigint('unit_cost_e4', { mode: 'bigint' }).notNull(),
    /** The same cost per ONE stocking unit — what stock_movement carries. */
    stockUnitCostE4: bigint('stock_unit_cost_e4', { mode: 'bigint' }).notNull(),
    lineNetMinor: bigint('line_net_minor', { mode: 'bigint' }).notNull(),
    notes: text('notes'),
  },
  (t) => [
    uniqueIndex('goods_receipt_line_uq').on(t.tenantId, t.goodsReceiptId, t.lineNo),
    index('goods_receipt_line_order_line_ix').on(t.tenantId, t.purchaseOrderLineId),
    index('goods_receipt_line_product_ix').on(t.tenantId, t.productId, t.goodsReceiptId),
  ],
);

/**
 * Third-party dispatch and delivery status. ADR-0001 is absolute: there is no
 * vehicle here, and there is no driver, fuel or maintenance entity anywhere
 * in this system. `carrierSupplierId` is the carrier abstraction ADR-0001
 * names as the attachment point if owned vehicles ever appear, and it is NOT
 * NULL because naming who carried it is what makes the cost of carrying
 * measurable.
 *
 * `sourceKind` is platform document vocabulary ('PURCHASE_ORDER' | 'SALE');
 * `sourceId` is polymorphic, so it carries no FK and a trigger checks the
 * referent per kind. Status is a state machine —
 * `app.delivery_legal_transitions()` — with DELIVERED and CANCELLED terminal.
 */
export const delivery = tenantTable(
  'delivery',
  {
    sourceKind: text('source_kind').notNull(),
    sourceId: uuid('source_id').notNull(),
    carrierSupplierId: uuid('carrier_supplier_id').notNull(),
    carrierReference: text('carrier_reference'),
    fromLocationId: uuid('from_location_id'),
    toLocationId: uuid('to_location_id'),
    toAddressText: text('to_address_text'),
    status: text('status').notNull(),
    /**
     * The trading day the haulage is attributed to (migration 0010) — the
     * period key `distribution cost as a % of revenue` is computed on, and
     * the same kind of value as `sale.businessDate`. NOT a device clock.
     */
    businessDate: date('business_date').notNull(),
    /**
     * How `businessDate` was obtained: null = asserted, 'PLANNED_FOR',
     * 'ROW_CREATED', or 'DISPATCH_CLOCK' (migration 0010's backfill only).
     */
    businessDateDerivedFrom: text('business_date_derived_from'),
    plannedFor: date('planned_for'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedReason: text('failed_reason'),
    /** The AGREED freight; the AP invoice is authoritative (Phase 3). */
    freightCostMinor: bigint('freight_cost_minor', { mode: 'bigint' }),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    moneyScale: bigint('money_scale', { mode: 'bigint' }).notNull(),
    notes: text('notes'),
  },
  (t) => [
    index('delivery_source_ix').on(t.tenantId, t.sourceKind, t.sourceId),
    index('delivery_open_ix').on(t.tenantId, t.status, t.plannedFor),
    index('delivery_carrier_ix').on(t.tenantId, t.carrierSupplierId, t.dispatchedAt),
    index('delivery_business_date_ix').on(t.tenantId, t.businessDate, t.carrierSupplierId),
  ],
);

// ---------------------------------------------------------------------------
// Migration 0013 — the credit book becomes syncable.
//
// Every table below is SERVER-DERIVED (04 §4.17.3): no client write creates
// one, so none carries a `write_id` and none goes through `tenantTable()`,
// whose factory injects the write spine. They are registered by hand and named
// on `WRITE_ID_EXEMPT` for exactly that reason. The structural pattern that is
// never exempt — tenant_id, forced RLS, the canonical policy, a tenant-leading
// index — holds for all of them and is asserted by the conformance suite.
// ---------------------------------------------------------------------------

/** Projection of app.effective_permission for `credit.view`. The
 *  `tenant_credit` sync bucket's parameter query reads this: a view cannot be
 *  published to logical replication, and a token claim cannot be revoked. */
export const creditSyncBookScope = appSchema.table('credit_sync_book_scope', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  userId: uuid('user_id').notNull(),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull(),
});
registerAppTable('credit_sync_book_scope', creditSyncBookScope);

/** app.user_location_scope ∩ app.effective_permission for
 *  `sale.record.credit` AT THAT LOCATION. The `location_credit_allowance`
 *  bucket's parameter query reads this. */
export const creditSyncLocationScope = appSchema.table('credit_sync_location_scope', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  userId: uuid('user_id').notNull(),
  locationId: uuid('location_id').notNull(),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull(),
});
registerAppTable('credit_sync_location_scope', creditSyncLocationScope);

/** The tenant's ageing boundaries, in days past due. Configuration, never a
 *  branch (CLAUDE.md §2.9); no rows = the template default {30, 60, 90}. */
export const creditAgeingBand = appSchema.table('credit_ageing_band', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  upperDays: smallint('upper_days').notNull(),
});
registerAppTable('credit_ageing_band', creditAgeingBand);

/**
 * One row per account: the balance and its composition, computed server-side.
 *
 * This is what makes a WINDOWED entry log safe to put on a device.
 * Σ(entries the device holds) ≠ balance by construction once anything has been
 * archived, so `openingBeforeWindowMinor` carries the archived remainder and
 * `opening + Σ(local live entries) = balance` holds exactly, in bigint.
 */
export const creditPositionSnapshot = appSchema.table('credit_position_snapshot', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  accountId: uuid('account_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  status: text('status').notNull(),
  termsDays: smallint('terms_days').notNull(),
  creditLimitMinor: bigint('credit_limit_minor', { mode: 'bigint' }).notNull(),
  limitVersionId: uuid('limit_version_id'),
  balanceMinor: bigint('balance_minor', { mode: 'bigint' }).notNull(),
  tradeExposureMinor: bigint('trade_exposure_minor', { mode: 'bigint' }).notNull(),
  availableMinor: bigint('available_minor', { mode: 'bigint' }).notNull(),
  onAccountCreditMinor: bigint('on_account_credit_minor', { mode: 'bigint' }).notNull(),
  feeOutstandingMinor: bigint('fee_outstanding_minor', { mode: 'bigint' }).notNull(),
  openingBeforeWindowMinor: bigint('opening_before_window_minor', { mode: 'bigint' }).notNull(),
  agedBy: text('aged_by').notNull(),
  feeConfirmedAt: timestamp('fee_confirmed_at', { withTimezone: true }),
  entryWindowDays: integer('entry_window_days').notNull(),
  asOf: date('as_of').notNull(),
  /** The greatest server-stamped HLC among the entries included — the value a
   *  till's causal `local_deduction` compares its own `ack_hlc` against. */
  asOfHlc: text('as_of_hlc').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
});
registerAppTable('credit_position_snapshot', creditPositionSnapshot);

/** The ageing vector, rendered server-side against the tenant's own bands. A
 *  device may not compute this: the band edges are policy, and policy is not
 *  on the device. */
export const creditPositionBucket = appSchema.table('credit_position_bucket', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  accountId: uuid('account_id').notNull(),
  seq: smallint('seq').notNull(),
  label: text('label').notNull(),
  fromDpd: integer('from_dpd'),
  toDpd: integer('to_dpd'),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  asOf: date('as_of').notNull(),
  asOfHlc: text('as_of_hlc').notNull(),
});
registerAppTable('credit_position_bucket', creditPositionBucket);

/**
 * What ONE OUTLET may lend ONE CUSTOMER today (06 §6.5) — never the account.
 * No limit, no balance, no ageing, no entry, no history: a stolen counter
 * tablet discloses this outlet's lending room for the customers who trade
 * here, and nothing about customers who trade elsewhere.
 */
export const creditAllowance = appSchema.table('credit_allowance', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  locationId: uuid('location_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  capMinor: bigint('cap_minor', { mode: 'bigint' }).notNull(),
  headroomMinor: bigint('headroom_minor', { mode: 'bigint' }).notNull(),
  offlineCeilingMinor: bigint('offline_ceiling_minor', { mode: 'bigint' }),
  creditHold: boolean('credit_hold').notNull(),
  capValidUntil: timestamp('cap_valid_until', { withTimezone: true }).notNull(),
  capVersionId: uuid('cap_version_id').notNull(),
  snapshotAsOf: timestamp('snapshot_as_of', { withTimezone: true }).notNull(),
  snapshotAsOfHlc: text('snapshot_as_of_hlc').notNull(),
});
registerAppTable('credit_allowance', creditAllowance);

// ---------------------------------------------------------------------------
// THE GENERAL LEDGER (migration 0015, Phase 3 Track A)
//
// Mirrors only. The hand-written SQL is the schema, and everything that makes
// this a LEDGER rather than a set of tables — balance enforced twice,
// immutability, the postable-account foreign key — lives there where no ORM
// can route around it.
//
// None of these carry `write_id` or `hlc`, and they are named in
// `WRITE_ID_EXEMPT` with the reason: the GL is server-side only (05 §5.2.6).
// No device may write a journal, no journal table is in any sync rule, and
// every entry is derived from a document that already carries its own spine.
// ---------------------------------------------------------------------------

/** The tenant's own fiscal calendar. Nothing on the platform assumes January. */
export const fiscalYear = appSchema.table('fiscal_year', {
  tenantId: uuid('tenant_id').notNull(),
  fyCode: text('fy_code').notNull(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
});
registerAppTable('fiscal_year', fiscalYear);

/** Periods that tile a fiscal year: no gaps, no overlaps, enforced by trigger. */
export const accountingPeriod = appSchema.table('accounting_period', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  fyCode: text('fy_code').notNull(),
  seq: integer('seq').notNull(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  status: text('status').notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by'),
  reopenedAt: timestamp('reopened_at', { withTimezone: true }),
  reopenedBy: uuid('reopened_by'),
  reopenReason: text('reopen_reason'),
});
registerAppTable('accounting_period', accountingPeriod);

/**
 * The chart of accounts. STRUCTURE ONLY — there are no rows, in any template,
 * and there must not be until the §2.8 accountant review has happened (Q6).
 */
export const glAccount = appSchema.table('gl_account', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  accountType: text('account_type').notNull(),
  normalBalance: char('normal_balance', { length: 1 }).notNull(),
  parentAccountId: uuid('parent_account_id'),
  isPostable: boolean('is_postable').notNull(),
  requiresCounterparty: text('requires_counterparty'),
  controlAccountKind: text('control_account_kind'),
  reportLineKey: text('report_line_key').notNull(),
  isActive: boolean('is_active').notNull(),
  closedAt: date('closed_at'),
  templateRef: text('template_ref'),
});
registerAppTable('gl_account', glAccount);

/** The gapless entry number, per (tenant, fiscal year). Server-side, locked. */
export const glCounter = appSchema.table('gl_counter', {
  tenantId: uuid('tenant_id').notNull(),
  fyCode: text('fy_code').notNull(),
  nextNo: bigint('next_no', { mode: 'bigint' }).notNull(),
});
registerAppTable('gl_counter', glCounter);

/**
 * The journal header. `debitTotalMinor` / `creditTotalMinor` / `lineCount` are
 * DERIVED and maintained by trigger — never written by application code, and
 * never trusted by the balance backstop, which recomputes from the lines.
 */
export const journalEntry = appSchema.table('journal_entry', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  entryNo: bigint('entry_no', { mode: 'bigint' }).notNull(),
  periodId: uuid('period_id').notNull(),
  fyCode: text('fy_code').notNull(),
  documentDate: date('document_date').notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  status: text('status').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceId: uuid('source_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  postingRuleVersion: integer('posting_rule_version').notNull(),
  mappingSetVersion: integer('mapping_set_version').notNull(),
  isLateArrival: boolean('is_late_arrival').notNull(),
  memo: text('memo'),
  createdBy: uuid('created_by').notNull(),
  reversesEntryId: uuid('reverses_entry_id'),
  reversedByEntryId: uuid('reversed_by_entry_id'),
  debitTotalMinor: bigint('debit_total_minor', { mode: 'bigint' }).notNull(),
  creditTotalMinor: bigint('credit_total_minor', { mode: 'bigint' }).notNull(),
  lineCount: integer('line_count').notNull(),
});
registerAppTable('journal_entry', journalEntry);

/**
 * Where double entry lives: two non-negative columns, exactly one non-zero.
 * `locationId` is NOT NULL because an entry balances PER LOCATION — a line
 * with no location has nothing to balance against (05 §5.5.3).
 */
export const journalLine = appSchema.table('journal_line', {
  tenantId: uuid('tenant_id').notNull(),
  journalEntryId: uuid('journal_entry_id').notNull(),
  lineNo: integer('line_no').notNull(),
  accountId: uuid('account_id').notNull(),
  accountPostable: boolean('account_postable').notNull(),
  locationId: uuid('location_id').notNull(),
  debitMinor: bigint('debit_minor', { mode: 'bigint' }).notNull(),
  creditMinor: bigint('credit_minor', { mode: 'bigint' }).notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull(),
  counterpartyKind: text('counterparty_kind'),
  counterpartyId: uuid('counterparty_id'),
  productId: uuid('product_id'),
  sourceLineId: uuid('source_line_id'),
  memo: text('memo'),
});
registerAppTable('journal_line', journalLine);

/**
 * Which of the tenant's own accounts each posting ROLE resolves to.
 *
 * Resolution is most-specific-first: product_category -> location -> tenant
 * default. `scopeKey` is a GENERATED column standing in for a null scope,
 * because a primary key takes columns and not expressions — the architecture's
 * `coalesce(scope_id, uuid_nil())` key is not valid Postgres.
 */
export const glAccountMapping = appSchema.table('gl_account_mapping', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  postingRole: text('posting_role').notNull(),
  scopeKind: text('scope_kind').notNull(),
  scopeId: uuid('scope_id'),
  scopeKey: uuid('scope_key').notNull(),
  accountId: uuid('account_id').notNull(),
  mappingSetVersion: integer('mapping_set_version').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
});
registerAppTable('gl_account_mapping', glAccountMapping);

/**
 * A settled document that could not be posted. Acceptance and posting are
 * separate and a posting failure NEVER rejects a settled document (05 §5.6.1)
 * — so the gap is made visible here rather than left implicit, and it is a
 * close gate.
 */
export const postingException = appSchema.table('posting_exception', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  sourceKind: text('source_kind').notNull(),
  sourceId: uuid('source_id').notNull(),
  locationId: uuid('location_id').notNull(),
  documentDate: date('document_date').notNull(),
  postingRole: text('posting_role'),
  errorCode: text('error_code').notNull(),
  errorDetail: text('error_detail'),
  severity: smallint('severity').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by'),
  resolutionNote: text('resolution_note'),
});
registerAppTable('posting_exception', postingException);

// ---------------------------------------------------------------------------
// PAYROLL — CAPTURE ONLY (migration 0017, CLAUDE.md §2.4)
//
// The column split is the design. `bureau_*` fields are the bureau's answer
// and are NULL until an import supplies them; nothing in this codebase may
// compute one, and `tools/lint-payroll.mjs` fails the build if anything tries.
// ---------------------------------------------------------------------------

/** Staff records. No tax identifier: statutory identity belongs elsewhere. */
export const employee = appSchema.table('employee', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  writeId: uuid('write_id').notNull(),
  staffRef: text('staff_ref').notNull(),
  displayName: text('display_name').notNull(),
  locationId: uuid('location_id').notNull(),
  jobTitle: text('job_title'),
  startedOn: date('started_on').notNull(),
  endedOn: date('ended_on'),
  isActive: boolean('is_active').notNull(),
});
registerAppTable('employee', employee);

export const payPeriod = appSchema.table('pay_period', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  code: text('code').notNull(),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  status: text('status').notNull(),
  exportedAt: timestamp('exported_at', { withTimezone: true }),
  returnedAt: timestamp('returned_at', { withTimezone: true }),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  journalEntryId: uuid('journal_entry_id'),
});
registerAppTable('pay_period', payPeriod);

/** One file from the bureau. The ONLY authority for a `bureau_*` figure. */
export const payrollBureauImport = appSchema.table('payroll_bureau_import', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').notNull(),
  payPeriodId: uuid('pay_period_id').notNull(),
  bureauRef: text('bureau_ref').notNull(),
  fileName: text('file_name'),
  fileDigest: text('file_digest').notNull(),
  importedBy: uuid('imported_by').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull(),
  statedGrossMinor: bigint('stated_gross_minor', { mode: 'bigint' }).notNull(),
  statedEmployeeTaxMinor: bigint('stated_employee_tax_minor', { mode: 'bigint' }).notNull(),
  statedEmployeeSocialMinor: bigint('stated_employee_social_minor', { mode: 'bigint' }).notNull(),
  statedOtherMinor: bigint('stated_other_minor', { mode: 'bigint' }).notNull(),
  statedEmployerSocialMinor: bigint('stated_employer_social_minor', { mode: 'bigint' }).notNull(),
  statedNetMinor: bigint('stated_net_minor', { mode: 'bigint' }).notNull(),
});
registerAppTable('payroll_bureau_import', payrollBureauImport);

export const payrollEntry = appSchema.table('payroll_entry', {
  tenantId: uuid('tenant_id').notNull(),
  payPeriodId: uuid('pay_period_id').notNull(),
  employeeId: uuid('employee_id').notNull(),
  locationId: uuid('location_id').notNull(),
  hoursWorkedScaled: bigint('hours_worked_scaled', { mode: 'bigint' }).notNull(),
  hoursScale: smallint('hours_scale').notNull(),
  basePayMinor: bigint('base_pay_minor', { mode: 'bigint' }).notNull(),
  overtimeMinor: bigint('overtime_minor', { mode: 'bigint' }).notNull(),
  commissionMinor: bigint('commission_minor', { mode: 'bigint' }).notNull(),
  allowancesMinor: bigint('allowances_minor', { mode: 'bigint' }).notNull(),
  grossPayMinor: bigint('gross_pay_minor', { mode: 'bigint' }).notNull(),
  // Below this line: the bureau's, never ours.
  bureauEmployeeTaxMinor: bigint('bureau_employee_tax_minor', { mode: 'bigint' }),
  bureauEmployeeSocialMinor: bigint('bureau_employee_social_minor', { mode: 'bigint' }),
  bureauOtherDeductionsMinor: bigint('bureau_other_deductions_minor', { mode: 'bigint' }),
  bureauEmployerSocialMinor: bigint('bureau_employer_social_minor', { mode: 'bigint' }),
  bureauNetPayMinor: bigint('bureau_net_pay_minor', { mode: 'bigint' }),
  bureauImportId: uuid('bureau_import_id'),
});
registerAppTable('payroll_entry', payrollEntry);
