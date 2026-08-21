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
}

export async function seedProduct(db: LocalDb, input: SeedProductInput): Promise<ProductWithPrice> {
  const id = input.id ?? uuidv7();
  const priceListId = input.priceListId ?? uuidv7();
  await db.execute(
    `INSERT INTO product (id, code, name, aliases, category, uom_label, qty_scale, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      input.code,
      input.name,
      input.aliases ?? null,
      input.category ?? null,
      input.uomLabel ?? 'each',
      input.qtyScale ?? 0,
    ],
  );
  await db.execute(
    `INSERT INTO price (id, product_id, price_list_id, unit_price_e4)
     VALUES (?, ?, ?, CAST(? AS INTEGER))`,
    [uuidv7(), id, priceListId, input.unitPriceE4.toString()],
  );
  return {
    id,
    code: input.code,
    name: input.name,
    aliases: input.aliases ?? null,
    category: input.category ?? null,
    uomLabel: input.uomLabel ?? 'each',
    qtyScale: input.qtyScale ?? 0,
    priceListId,
    unitPriceE4: input.unitPriceE4,
  };
}
