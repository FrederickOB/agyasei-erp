/**
 * Catalogue reads. The ONLY layer where product SQL and raw rows exist (§8.3).
 * Money-adjacent columns (`unit_price_e4`) are selected as CAST(... AS TEXT)
 * and parsed with BigInt() exactly once, here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A COUNTER MAY SELL IS A QUESTION WITH FOUR PARTS, AND ALL FOUR ARE DATA
 * ═══════════════════════════════════════════════════════════════════════════
 * This projection used to read a parallel set of columns that only the dev
 * seed ever wrote (`product.code`, `.uom_label`, `.active`, and a local `price`
 * table). A synced device therefore showed the seed's demo products and none
 * of the tenant's, because the tenant's catalogue lives in the shape the
 * server models — and nothing read that shape. It is read here now:
 *
 *   product          — what it is, and whether it may be sold at all
 *   product_uom      — the unit it is SOLD in, flagged `is_default_sell`. The
 *                      same unit `sales.createSale` prices in when the wire
 *                      carries no `uomCode`, which is exactly what this client
 *                      sends (mutations/checkout.ts). Agreeing with the server
 *                      about the unit is not cosmetic: it is the difference
 *                      between a price per bag and a price per tonne.
 *   unit_of_measure  — the unit's own name and its quantity SCALE, so a scaled
 *                      integer quantity can be displayed and typed (ADR-0004).
 *   price_list_item  — the price, on THIS counter's list, in force on THIS
 *                      trading day.
 *
 * The device's list and trading day are not parameters a caller may choose:
 * they are what this device was provisioned with (queries/session.ts) and the
 * day at its own location (lib/business-date.ts). A caller that could pass
 * either one could put a price on screen that the server will not honour.
 *
 * NO PRICE, NO ROW. A product whose price has not arrived, or whose price
 * lapsed yesterday, is absent from the counter rather than present at zero or
 * present unpriced. The alternative is a till that lets someone ring an item
 * it cannot price, which the server then refuses after the customer has gone.
 */
import { businessDateFor } from '../../lib/business-date';
import type { DbRow, LocalDb } from '../db';
import { readActivePriceListId, readDeviceLocation } from './session';

export interface ProductWithPrice {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly aliases: string | null;
  readonly category: string | null;
  readonly uomLabel: string;
  readonly qtyScale: number; // digit count, not a monetary magnitude
  readonly priceListId: string;
  readonly unitPriceE4: bigint; // minor units per selling unit × 10^4
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mapProduct(row: DbRow): ProductWithPrice {
  return {
    id: String(row['id']),
    code: String(row['code'] ?? ''),
    name: String(row['name']),
    aliases: text(row['aliases']),
    category: text(row['category']),
    uomLabel: String(row['uom_label']),
    qtyScale: Number(row['qty_scale']),
    priceListId: String(row['price_list_id']),
    unitPriceE4: BigInt(String(row['unit_price_e4'])), // TEXT -> bigint, exactly once, here
  };
}

/**
 * `effective_to` is EXCLUSIVE, matching the API's own window exactly
 * (`effective_to is null or effective_to > $date`, apps/api/src/routers/
 * sales.ts) and the same comparison the price-list gate uses
 * (data/session/device-price-list.ts). `substr(...,1,10)` compares the
 * calendar date whether the column arrives as a date or a full timestamp; a
 * lexicographic compare on a zero-padded ISO date IS a chronological one.
 */
const ITEM_IN_FORCE =
  "i2.effective_from IS NOT NULL AND substr(i2.effective_from, 1, 10) <= ?1" +
  " AND (i2.effective_to IS NULL OR substr(i2.effective_to, 1, 10) > ?1)";

/**
 * ONE price per product, chosen the same way every time.
 *
 * A list may hold several prices for one product: quantity breaks (`min_qty`)
 * and successive effective windows. The counter shows the price for buying
 * ONE — the lowest `min_qty` — and, among equals, the most recently effective.
 * The tie-break on id is not decoration: without it two rows priced the same
 * day could swap places between reads, and the shelf price would flicker.
 * Quantity-break pricing itself is the server's to apply (it reprices every
 * line); this is what the counter DISPLAYS.
 *
 * Restricted to the DEFAULT SELLING UNIT (`i2.uom_id = pu.uom_id`), and that
 * restriction belongs inside the choice, not after it. Without it a price in
 * some other unit — a pallet rate entered last week beside a per-bag price
 * entered years ago — wins the ordering, fails the unit join, and the product
 * silently leaves the shelf. It is priced; it just disappears.
 */
const PRICE_ROW =
  `i.id = (SELECT i2.id FROM price_list_item i2
            WHERE i2.product_id = p.id AND i2.price_list_id = i.price_list_id
              AND i2.uom_id = pu.uom_id
              AND ${ITEM_IN_FORCE}
            ORDER BY i2.min_qty ASC, substr(i2.effective_from, 1, 10) DESC, i2.id ASC
            LIMIT 1)`;

/**
 * The products this counter can sell today, priced from its own list.
 *
 * Empty is a legitimate answer, and a loud one: it means this device holds no
 * price list, or none of its tenant's prices have arrived yet. The setup gates
 * (App.tsx) speak to the first case before a counter is ever shown; the second
 * resolves itself as rows land, and the live query re-runs when they do.
 */
export async function loadActiveProducts(
  db: LocalDb,
  nowIso: string = new Date().toISOString(),
): Promise<ProductWithPrice[]> {
  const priceListId = await readActivePriceListId(db);
  if (priceListId === null) return [];
  const location = await readDeviceLocation(db);
  const businessDate = businessDateFor(nowIso, location?.timeZone ?? null);

  const rows = await db.getAll(
    `SELECT p.id, p.sku_code AS code, p.name, p.aliases,
            c.name AS category,
            COALESCE(u.name, u.code) AS uom_label,
            u.qty_scale,
            i.price_list_id,
            CAST(i.unit_price_e4 AS TEXT) AS unit_price_e4
       FROM product p
       JOIN product_uom pu ON pu.product_id = p.id AND pu.can_sell = 1 AND pu.is_default_sell = 1
       JOIN unit_of_measure u ON u.id = pu.uom_id
       JOIN price_list_item i ON i.product_id = p.id AND i.price_list_id = ?2
                             AND i.uom_id = pu.uom_id AND ${PRICE_ROW}
       LEFT JOIN product_category c ON c.id = p.category_id
      WHERE p.is_sellable = 1
      ORDER BY p.name`,
    [businessDate, priceListId],
  );
  return rows.map(mapProduct);
}
