/** Shared test fixtures. */
import type { ProductWithPrice } from '../../src/data/queries/products';
import { createClaimedHlcClock, type ClaimedHlcClock } from '../../src/lib/hlc';
import { uuidv7 } from '../../src/lib/uuidv7';
import type { LocalDb } from '../../src/data/db';
import {
  CONFIG_KEY_LOCATION_CODE,
  CONFIG_KEY_LOCATION_ID,
  CONFIG_KEY_PRICE_LIST_ID,
  CONFIG_KEY_RECEIPT_FORMAT,
} from '../../src/data/queries/session';
import type { ReceiptNumberFormat } from '../../src/lib/receipt-number';

export const TEST_NODE = 'ab'.repeat(16);

export function fixedHlc(nowMs = 1_755_000_000_000, node: string = TEST_NODE): ClaimedHlcClock {
  return createClaimedHlcClock(node, () => nowMs);
}

/**
 * A provisioned device: bound to a location, selling from a named price list.
 * Ids are real UUIDs because the wire contract requires UUIDs — a fixture that
 * cannot produce a payload the API would accept tests nothing.
 */
export interface ProvisionedDevice {
  readonly locationId: string;
  readonly locationCode: string;
  readonly priceListId: string;
  readonly priceListCode: string;
}

export interface ProvisionOptions {
  /** Share one location across two test devices — the collision case. */
  readonly locationId?: string;
  readonly locationCode?: string;
  readonly priceListCode?: string;
  /** IANA zone the trading day is derived in. */
  readonly timeZone?: string;
  readonly receiptFormat?: ReceiptNumberFormat;
}

export async function provisionDevice(
  db: LocalDb,
  options: ProvisionOptions = {},
): Promise<ProvisionedDevice> {
  const locationId = options.locationId ?? uuidv7();
  const priceListId = uuidv7();
  const locationCode = options.locationCode ?? 'LOC1';
  const priceListCode = options.priceListCode ?? 'DEFAULT';

  await db.execute(
    `INSERT INTO location (id, tenant_id, code, name, kind, location_type_id, parent_id,
                           is_active, timezone, hlc, updated_at)
     VALUES (?, NULL, ?, ?, NULL, NULL, NULL, 1, ?, NULL, NULL)`,
    [locationId, locationCode, 'Test counter', options.timeZone ?? 'UTC'],
  );
  await db.execute(
    `INSERT INTO price_list (id, tenant_id, code, name, is_tax_inclusive, currency_code,
                             priority, location_id, effective_from, effective_to, hlc, updated_at)
     VALUES (?, NULL, ?, ?, 0, 'XTS', 0, NULL, NULL, NULL, NULL, NULL)`,
    [priceListId, priceListCode, 'Test price list'],
  );
  const config: [string, string][] = [
    [CONFIG_KEY_LOCATION_ID, locationId],
    [CONFIG_KEY_LOCATION_CODE, locationCode],
    [CONFIG_KEY_PRICE_LIST_ID, priceListId],
  ];
  if (options.receiptFormat !== undefined) {
    config.push([CONFIG_KEY_RECEIPT_FORMAT, JSON.stringify(options.receiptFormat)]);
  }
  for (const [key, value] of config) {
    await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
      uuidv7(),
      key,
      value,
    ]);
  }
  return { locationId, locationCode, priceListId, priceListCode };
}

export interface SeedProductInput {
  /**
   * Override the generated id. The conformance suite seeds the device
   * catalogue with the SERVER's real product ids so the payload it builds
   * names a product the API can actually price.
   */
  readonly id?: string;
  readonly code: string;
  readonly name: string;
  readonly aliases?: string;
  readonly category?: string;
  readonly uomLabel?: string;
  readonly qtyScale?: number;
  readonly unitPriceE4: bigint;
  /** The list this price belongs to; defaults to a non-provisioned test list. */
  readonly priceListId?: string;
  /**
   * Mirrors the server's NOT NULL DEFAULT 'STOCKED' (migration 0003), which is
   * what the sync stream actually delivers. Overridable so a test can prove
   * the adjustment screen leaves a non-stocked product out — the server
   * answers PRECONDITION_FAILED for one, and that refusal is RETRYABLE, so it
   * would wedge the outbox rather than dead-letter.
   */
  readonly stockTracking?: 'STOCKED' | 'NON_STOCKED';
}

export async function seedProduct(db: LocalDb, input: SeedProductInput): Promise<ProductWithPrice> {
  const id = input.id ?? uuidv7();
  const priceListId = input.priceListId ?? uuidv7();
  const uomId = uuidv7();
  const categoryId = input.category === undefined ? null : uuidv7();
  const uomLabel = input.uomLabel ?? 'each';
  const qtyScale = input.qtyScale ?? 0;

  // The shape the SYNC STREAM delivers, which is the only shape the counter's
  // projection reads (src/data/queries/products.ts). A fixture that wrote a
  // shape of its own would agree with nothing the device actually holds.
  await db.execute(
    `INSERT INTO unit_of_measure (id, tenant_id, code, name, dimension, qty_scale, hlc, updated_at)
     VALUES (?, NULL, ?, ?, NULL, CAST(? AS INTEGER), NULL, NULL)`,
    [uomId, uomLabel.toUpperCase(), uomLabel, qtyScale],
  );
  if (categoryId !== null && input.category !== undefined) {
    await db.execute(
      `INSERT INTO product_category (id, tenant_id, code, name, parent_id, hlc, updated_at)
       VALUES (?, NULL, ?, ?, NULL, NULL, NULL)`,
      [categoryId, input.category.toUpperCase(), input.category],
    );
  }
  await db.execute(
    `INSERT INTO product (id, tenant_id, sku_code, name, aliases, category_id, stocking_uom_id,
                          tax_code, stock_tracking, is_sellable, is_purchasable, hlc, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?, 1, 1, NULL, NULL)`,
    [id, input.code, input.name, input.aliases ?? null, categoryId, uomId,
     input.stockTracking ?? 'STOCKED'],
  );
  await db.execute(
    `INSERT INTO product_uom (id, tenant_id, product_id, uom_id, factor_num, factor_den,
                              can_sell, can_buy, is_default_sell, tolerance_bp, sort_order,
                              hlc, updated_at)
     VALUES (?, NULL, ?, ?, 1, 1, 1, 1, 1, 0, 0, NULL, NULL)`,
    [uuidv7(), id, uomId],
  );
  await db.execute(
    `INSERT INTO price_list_item (id, tenant_id, price_list_id, product_id, uom_id,
                                  unit_price_e4, min_qty, effective_from, effective_to,
                                  hlc, updated_at)
     VALUES (?, NULL, ?, ?, ?, CAST(? AS INTEGER), 0, '2000-01-01', NULL, NULL, NULL)`,
    [uuidv7(), priceListId, id, uomId, input.unitPriceE4.toString()],
  );

  return {
    id,
    code: input.code,
    name: input.name,
    aliases: input.aliases ?? null,
    category: input.category ?? null,
    uomLabel,
    qtyScale,
    priceListId,
    unitPriceE4: input.unitPriceE4,
  };
}

// ---------------------------------------------------------------------------
// Tenant vocabulary and customers, as the sync stream delivers them
// ---------------------------------------------------------------------------

/**
 * A movement reason. TENANT data (`app.movement_reason`, tenant_reference
 * bucket) — the tenant's own editable words, which the adjustment screen picks
 * from and never compares to a literal.
 */
export async function seedMovementReason(
  db: LocalDb,
  input: { readonly code: string; readonly name: string },
): Promise<void> {
  await db.execute(
    `INSERT INTO movement_reason (id, tenant_id, code, name, hlc, updated_at)
     VALUES (?, NULL, ?, ?, NULL, NULL)`,
    [uuidv7(), input.code, input.name],
  );
}

/**
 * A customer. IDENTITY ONLY, exactly as the `tenant_customers` bucket carries
 * it — no balance, no limit, nothing about money. A fixture that carried one
 * would be describing a device state that cannot exist.
 */
export async function seedCustomer(
  db: LocalDb,
  input: {
    readonly id?: string;
    readonly code: string;
    readonly name: string;
    readonly onAccount?: boolean;
  },
): Promise<string> {
  const id = input.id ?? uuidv7();
  await db.execute(
    `INSERT INTO customer (id, tenant_id, code, name, phone, is_credit_customer, hlc, updated_at)
     VALUES (?, NULL, ?, ?, NULL, ?, NULL, NULL)`,
    [id, input.code, input.name, input.onAccount === false ? 0 : 1],
  );
  return id;
}
