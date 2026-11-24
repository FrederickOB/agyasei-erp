/**
 * Draft sales on this device (mutations/drafts.ts), newest set aside first,
 * each with what it comes to — priced on its OWN pinned list's convention, so
 * a draft on a tax-exclusive list shows what the customer will actually hand
 * over, the same figure the counter will show when it is resumed.
 */
import type { DbExecutor } from '../db';
import { readCartPricingBasis } from '../pricing/cart-basis';
import { priceCart, type CartPricingBasis } from '../pricing/cart-pricing';
import { getCartLines, type CartLineRow } from './cart';

export interface DraftSale {
  readonly id: string;
  /** What the cashier called it, if anything. */
  readonly label: string | null;
  readonly parkedAt: string;
  readonly createdAt: string;
  readonly lines: readonly CartLineRow[];
  readonly totalMinor: bigint;
}

export async function listDrafts(db: DbExecutor): Promise<DraftSale[]> {
  const rows = await db.getAll(
    `SELECT id, label, parked_at, created_at, price_list_id
       FROM cart WHERE status = 'parked'
      ORDER BY parked_at DESC, created_at DESC`,
  );
  const bases = new Map<string, CartPricingBasis>();
  const out: DraftSale[] = [];
  for (const r of rows) {
    const id = String(r['id']);
    const listId = r['price_list_id'] === null ? null : String(r['price_list_id']);
    const key = listId ?? '';
    let basis = bases.get(key);
    if (basis === undefined) {
      basis = await readCartPricingBasis(db, listId);
      bases.set(key, basis);
    }
    const lines = await getCartLines(db, id);
    out.push({
      id,
      label: typeof r['label'] === 'string' && r['label'].length > 0 ? r['label'] : null,
      parkedAt: String(r['parked_at'] ?? r['created_at']),
      createdAt: String(r['created_at']),
      lines,
      totalMinor: priceCart(lines, basis).grossMinor,
    });
  }
  return out;
}

/** The open cart's own name, if it was a draft that was given one. */
export async function readOpenCartLabel(db: DbExecutor): Promise<string | null> {
  const rows = await db.getAll(`SELECT label FROM cart WHERE status = 'open' ORDER BY created_at DESC LIMIT 1`);
  const l = rows[0]?.['label'];
  return typeof l === 'string' && l.length > 0 ? l : null;
}
