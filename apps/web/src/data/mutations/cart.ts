/**
 * Draft-cart writes. Every write is a local transaction that resolves before
 * the network is consulted (§8.2) — nothing here awaits a socket.
 */
import { oneWholeUnit } from '../../lib/quantity';
import { uuidv7 } from '../../lib/uuidv7';
import type { LocalDb } from '../db';
import { getOpenCart } from '../queries/cart';
import type { ProductWithPrice } from '../queries/products';
import { readActivePriceListId } from '../queries/session';

export interface CreateCartOptions {
  readonly id?: string;
  readonly priceListId?: string | null;
  readonly nowIso?: string;
}

/**
 * Mint the cart. Its UUIDv7 id is the future sale id AND the idempotency key,
 * generated HERE — at cart creation, before the first line — not at the
 * moment "Complete" is tapped (§8.2).
 *
 * The cart also pins the price list it is being rung against, resolved from
 * device configuration when the caller does not name one. The API prices by
 * price-list CODE and the sale resolves the code from this id, so a cart with
 * no list is a sale the server cannot price — better to carry it from the
 * first line than to discover it at tender.
 */
export async function createCart(db: LocalDb, options: CreateCartOptions = {}): Promise<string> {
  const id = options.id ?? uuidv7();
  const nowIso = options.nowIso ?? new Date().toISOString();
  const priceListId =
    options.priceListId !== undefined ? options.priceListId : await readActivePriceListId(db);
  await db.execute(
    `INSERT INTO cart (id, created_at, price_list_id, status) VALUES (?, ?, ?, 'open')`,
    [id, nowIso, priceListId],
  );
  db.changes.notify();
  return id;
}

/**
 * Throw away a cart that cannot be sold and open a fresh one in its place.
 *
 * THE DEAD END THIS EXISTS TO END. A cart pins its price list once, above, and
 * the only other statement in this app that touches a `cart` row is the DELETE
 * inside a SUCCESSFUL checkout. So a cart whose pinned list has gone — a
 * device healed its synced tables, a list lapsed overnight — refuses at
 * checkout, survives the rollback, and is still the open cart on the next
 * attempt. No new cart is ever minted, the corrected configuration is never
 * picked up, and clearing every line changes nothing. Short of wiping the
 * device's storage there was no way out, which is not a thing to ask of
 * someone standing at a counter with a queue.
 *
 * WHY THIS IS SAFE TO DO. The cart's id IS the sale's idempotency key (§8.2),
 * so discarding a cart discards a key — and that only matters if the server
 * might have seen it. It cannot have: a key reaches the server through the
 * outbox, and an outbox row is only ever written by a checkout that completed,
 * which is the one path that already deletes this cart. A cart still open has
 * never been uploaded under any key.
 *
 * The lines go with it, deliberately. They were priced from a list this device
 * can no longer sell from, and re-pinning them to another list would charge a
 * customer from prices nobody quoted them.
 */
export async function startFreshCart(db: LocalDb, cartId: string): Promise<string> {
  const id = uuidv7();
  const priceListId = await readActivePriceListId(db);
  const replaced = await db.writeTransaction(async (tx) => {
    // ── COMPARE AND SWAP, NOT DELETE AND INSERT ──────────────────────────
    // Two things can ask for this at once: the effect that repairs an empty
    // cart and a finger on the button. A blind delete-and-insert run twice
    // leaves TWO open carts, and `getOpenCart` takes the newest — so the
    // older one's lines would sit there invisibly and resurface at the next
    // tender. Recovering from a mis-ring must not manufacture one.
    const open = await getOpenCart(tx);
    if (open === null || open.id !== cartId) return null;

    // Same three statements, same order, as the end of a completed sale.
    await tx.execute(`DELETE FROM cart_line WHERE cart_id = ?`, [cartId]);
    await tx.execute(`DELETE FROM cart WHERE id = ?`, [cartId]);
    await tx.execute(
      `INSERT INTO cart (id, created_at, price_list_id, status) VALUES (?, ?, ?, 'open')`,
      [id, new Date().toISOString(), priceListId],
    );
    return id;
  });
  db.changes.notify();
  // Somebody got there first; the cart they opened is the one to ring into.
  return replaced ?? (await getOpenCart(db))?.id ?? id;
}

/**
 * Add one whole selling unit of a product; if the product is already in the
 * cart, bump its line instead of adding a second one. Snapshots name, unit
 * label, scale and the price in force onto the line (§8.3) so later catalogue
 * edits cannot rewrite this sale.
 */
export async function addProductToCart(
  db: LocalDb,
  cartId: string,
  product: ProductWithPrice,
): Promise<void> {
  const step = oneWholeUnit(product.qtyScale);
  await db.writeTransaction(async (tx) => {
    const existing = await tx.getAll(
      `SELECT id, CAST(qty_scaled AS TEXT) AS qty_scaled
         FROM cart_line WHERE cart_id = ? AND product_id = ? LIMIT 1`,
      [cartId, product.id],
    );
    const row = existing[0];
    if (row !== undefined) {
      const next = BigInt(String(row['qty_scaled'])) + step;
      await tx.execute(`UPDATE cart_line SET qty_scaled = CAST(? AS INTEGER) WHERE id = ?`, [
        next.toString(),
        String(row['id']),
      ]);
      return;
    }
    const seqRows = await tx.getAll(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM cart_line WHERE cart_id = ?`,
      [cartId],
    );
    const nextSeq = Number(seqRows[0]?.['next_seq'] ?? 1);
    await tx.execute(
      `INSERT INTO cart_line
         (id, cart_id, seq, product_id, name_snapshot, uom_label_snapshot,
          qty_scale, qty_scaled, unit_price_e4)
       VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER))`,
      [
        uuidv7(),
        cartId,
        nextSeq,
        product.id,
        product.name,
        product.uomLabel,
        product.qtyScale,
        step.toString(),
        product.unitPriceE4.toString(),
      ],
    );
  });
  db.changes.notify();
}

/** Set a line's scaled quantity; zero or negative removes the line. */
export async function setCartLineQty(db: LocalDb, lineId: string, qtyScaled: bigint): Promise<void> {
  if (qtyScaled <= 0n) {
    await db.execute(`DELETE FROM cart_line WHERE id = ?`, [lineId]);
  } else {
    await db.execute(`UPDATE cart_line SET qty_scaled = CAST(? AS INTEGER) WHERE id = ?`, [
      qtyScaled.toString(),
      lineId,
    ]);
  }
  db.changes.notify();
}

/** Remove a line. Destructive actions get undo, not confirmation (§8.7) — the caller renders the undo bar. */
export async function removeCartLine(db: LocalDb, lineId: string): Promise<void> {
  await db.execute(`DELETE FROM cart_line WHERE id = ?`, [lineId]);
  db.changes.notify();
}
