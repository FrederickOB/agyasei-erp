/**
 * Draft-cart reads (§8.2): the cart lives in local-only SQLite so a battery
 * pull mid-sale cannot lose it. Money/quantity columns come back as
 * CAST(... AS TEXT) and become bigint exactly once, here.
 */
import type { DbExecutor, DbRow, LocalDb } from '../db';

export interface CartRow {
  readonly id: string; // UUIDv7 — the future sale id and idempotency key
  readonly createdAt: string;
  readonly priceListId: string | null;
  readonly status: string;
}

export interface CartLineRow {
  readonly id: string;
  readonly cartId: string;
  readonly seq: number;
  readonly productId: string;
  readonly name: string;
  readonly uomLabel: string;
  readonly qtyScale: number;
  readonly qtyScaled: bigint;
  readonly unitPriceE4: bigint;
}

function mapCartLine(row: DbRow): CartLineRow {
  return {
    id: String(row['id']),
    cartId: String(row['cart_id']),
    seq: Number(row['seq']),
    productId: String(row['product_id']),
    name: String(row['name_snapshot']),
    uomLabel: String(row['uom_label_snapshot']),
    qtyScale: Number(row['qty_scale']),
    qtyScaled: BigInt(String(row['qty_scaled'])), // TEXT -> bigint, once, here
    unitPriceE4: BigInt(String(row['unit_price_e4'])),
  };
}

export async function getOpenCart(db: DbExecutor): Promise<CartRow | null> {
  const rows = await db.getAll(
    `SELECT id, created_at, price_list_id, status
       FROM cart WHERE status = 'open'
      ORDER BY created_at DESC LIMIT 1`,
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: String(row['id']),
    createdAt: String(row['created_at']),
    priceListId: row['price_list_id'] === null ? null : String(row['price_list_id']),
    status: String(row['status']),
  };
}

export async function getCartLines(db: DbExecutor, cartId: string): Promise<CartLineRow[]> {
  const rows = await db.getAll(
    `SELECT id, cart_id, seq, product_id, name_snapshot, uom_label_snapshot, qty_scale,
            CAST(qty_scaled AS TEXT) AS qty_scaled,
            CAST(unit_price_e4 AS TEXT) AS unit_price_e4
       FROM cart_line
      WHERE cart_id = ?
      ORDER BY seq`,
    [cartId],
  );
  return rows.map(mapCartLine);
}

export async function countCartLines(db: LocalDb, cartId: string | null): Promise<number> {
  if (cartId === null) return 0;
  const rows = await db.getAll('SELECT COUNT(*) AS n FROM cart_line WHERE cart_id = ?', [cartId]);
  return Number(rows[0]?.['n'] ?? 0);
}
