/**
 * Catalogue reads. The ONLY layer where product SQL and raw rows exist (§8.3).
 * Money-adjacent columns (`unit_price_e4`) are selected as CAST(... AS TEXT)
 * and parsed with BigInt() exactly once, here.
 */
import type { DbRow, LocalDb } from '../db';

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

function mapProduct(row: DbRow): ProductWithPrice {
  return {
    id: String(row['id']),
    code: String(row['code']),
    name: String(row['name']),
    aliases: row['aliases'] === null ? null : String(row['aliases']),
    category: row['category'] === null ? null : String(row['category']),
    uomLabel: String(row['uom_label']),
    qtyScale: Number(row['qty_scale']),
    priceListId: String(row['price_list_id']),
    unitPriceE4: BigInt(String(row['unit_price_e4'])), // TEXT -> bigint, exactly once, here
  };
}

/**
 * Active products joined with their price row. The skeleton reads a single
 * price list; the real counter carries the tenant's price lists as data and a
 * persistent chip naming the active one (§8.7).
 */
export async function loadActiveProducts(db: LocalDb): Promise<ProductWithPrice[]> {
  const rows = await db.getAll(
    `SELECT p.id, p.code, p.name, p.aliases, p.category, p.uom_label, p.qty_scale,
            pr.price_list_id,
            CAST(pr.unit_price_e4 AS TEXT) AS unit_price_e4
       FROM product p
       JOIN price pr ON pr.product_id = p.id
      WHERE p.active = 1
      ORDER BY p.name`,
  );
  return rows.map(mapProduct);
}
