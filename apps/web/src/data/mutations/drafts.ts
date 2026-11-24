/**
 * DRAFT SALES — set a sale aside so the next customer can be served.
 *
 * A draft is a cart whose status is 'parked'. Nothing else about it changes:
 * the same id (so the same idempotency key — resuming continues the SAME
 * sale), the same lines with the prices they were rung at, the same pinned
 * price list. Only the cart whose status is 'open' is ever rung into or
 * checked out (queries/cart.ts `getOpenCart`; checkout refuses any other id),
 * so a draft can never be charged by accident.
 *
 * Every change here is one local transaction that keeps the invariant the
 * whole counter relies on: AT MOST ONE OPEN CART. Parking opens the next
 * customer's cart in the same transaction, so there is no instant with no cart
 * for a tap to land in; resuming swaps the draft in and the current sale out.
 *
 * Drafts live on this device only (cart is a local-only table). They are not
 * sales: no money has moved, nothing is queued for the server, and a deleted
 * draft discards a key the server has never seen (see startFreshCart for the
 * same argument).
 */
import { uuidv7 } from '../../lib/uuidv7';
import type { DbExecutor, LocalDb } from '../db';
import { getOpenCart } from '../queries/cart';
import { readActivePriceListId } from '../queries/session';

/** A draft operation that cannot be done, said as a person would act on it. */
export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftError';
  }
}

/** A typed name is a note, not an essay — and never empty-but-present. */
const MAX_LABEL = 60;
function cleanLabel(label: string | null | undefined): string | null {
  const t = (label ?? '').trim().replace(/\s+/g, ' ');
  return t.length === 0 ? null : t.slice(0, MAX_LABEL);
}

async function lineCount(tx: DbExecutor, cartId: string): Promise<number> {
  const rows = await tx.getAll('SELECT COUNT(*) AS n FROM cart_line WHERE cart_id = ?', [cartId]);
  return Number(rows[0]?.['n'] ?? 0);
}

/**
 * Park the open sale as a draft and open a fresh cart for the next customer —
 * one transaction. Refuses an empty sale (there is nothing to come back to)
 * and a cart that is no longer the open one (somebody got there first).
 * Returns the new open cart's id.
 */
export async function saveCartAsDraft(
  db: LocalDb,
  cartId: string,
  options: { readonly label?: string | null; readonly nowIso?: string } = {},
): Promise<string> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const priceListId = await readActivePriceListId(db);
  const nextId = uuidv7();
  await db.writeTransaction(async (tx) => {
    const open = await getOpenCart(tx);
    if (open === null || open.id !== cartId) {
      throw new DraftError('This sale is no longer the one on the counter.');
    }
    if ((await lineCount(tx, cartId)) === 0) {
      throw new DraftError('There is nothing in this sale to save yet.');
    }
    await tx.execute(`UPDATE cart SET status = 'parked', label = ?, parked_at = ? WHERE id = ?`, [
      cleanLabel(options.label),
      nowIso,
      cartId,
    ]);
    await tx.execute(
      `INSERT INTO cart (id, created_at, price_list_id, status, label, parked_at)
       VALUES (?, ?, ?, 'open', NULL, NULL)`,
      [nextId, nowIso, priceListId],
    );
  });
  db.changes.notify();
  return nextId;
}

export interface ResumeResult {
  /** True when the sale that was on the counter had items, and became a draft itself. */
  readonly setAsideCurrent: boolean;
}

/**
 * Bring a draft back to the counter. The sale currently on the counter is
 * never lost: with items in it, it becomes a draft itself; empty, it is
 * simply removed (an empty cart is nothing to come back to).
 */
export async function resumeDraft(
  db: LocalDb,
  draftId: string,
  options: { readonly nowIso?: string } = {},
): Promise<ResumeResult> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const result = await db.writeTransaction(async (tx) => {
    const found = await tx.getAll(`SELECT id FROM cart WHERE id = ? AND status = 'parked' LIMIT 1`, [draftId]);
    if (found.length === 0) throw new DraftError('That draft is no longer saved on this device.');

    let setAsideCurrent = false;
    const open = await getOpenCart(tx);
    if (open !== null) {
      if ((await lineCount(tx, open.id)) > 0) {
        await tx.execute(`UPDATE cart SET status = 'parked', parked_at = ? WHERE id = ?`, [nowIso, open.id]);
        setAsideCurrent = true;
      } else {
        await tx.execute(`DELETE FROM cart WHERE id = ?`, [open.id]);
      }
    }
    await tx.execute(`UPDATE cart SET status = 'open', parked_at = NULL WHERE id = ?`, [draftId]);
    return { setAsideCurrent };
  });
  db.changes.notify();
  return result;
}

/** Discard a draft and its lines. Only a draft — never the sale on the counter. */
export async function deleteDraft(db: LocalDb, draftId: string): Promise<void> {
  await db.writeTransaction(async (tx) => {
    const found = await tx.getAll(`SELECT id FROM cart WHERE id = ? AND status = 'parked' LIMIT 1`, [draftId]);
    if (found.length === 0) throw new DraftError('That draft is no longer saved on this device.');
    await tx.execute('DELETE FROM cart_line WHERE cart_id = ?', [draftId]);
    await tx.execute('DELETE FROM cart WHERE id = ?', [draftId]);
  });
  db.changes.notify();
}
