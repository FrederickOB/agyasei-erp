/**
 * DRAFT SALES (mutations/drafts.ts) — setting a sale aside so the next
 * customer can be served. Against real SQLite over the device's own schema.
 *
 * What must hold, because the whole counter leans on it:
 *   - there is never more than ONE open cart, and never an instant with none;
 *   - a draft is the same sale — same id (= idempotency key), same lines,
 *     same prices — when it comes back;
 *   - a draft can never be charged by accident: checkout takes the open cart
 *     only;
 *   - resuming never loses the sale that was on the counter;
 *   - a draft is not a sale in flight, so it does not block cash-up.
 */
import { describe, expect, it } from 'vitest';
import type { LocalDb } from '../src/data/db';
import { addProductToCart, createCart } from '../src/data/mutations/cart';
import { checkout } from '../src/data/mutations/checkout';
import { deleteDraft, DraftError, resumeDraft, saveCartAsDraft } from '../src/data/mutations/drafts';
import { closeTill, openTill } from '../src/data/mutations/till';
import { getCartLines, getOpenCart } from '../src/data/queries/cart';
import { listDrafts, readOpenCartLabel } from '../src/data/queries/drafts';
import type { ProductWithPrice } from '../src/data/queries/products';
import { fixedHlc, provisionDevice, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const DAY = '2026-08-21';
const NOW = `${DAY}T09:00:00.000Z`;

async function openCarts(db: LocalDb): Promise<number> {
  const rows = await db.getAll(`SELECT COUNT(*) AS n FROM cart WHERE status = 'open'`);
  return Number(rows[0]?.['n'] ?? 0);
}

async function counterWithSale(): Promise<{ db: LocalDb; cartId: string; bags: ProductWithPrice; tiles: ProductWithPrice }> {
  const db = openTestDb();
  const device = await provisionDevice(db, { till: DAY });
  // 620.00 a bag; 15.00 a tile.
  const bags = await seedProduct(db, { code: 'BAG', name: 'Cement 50kg', uomLabel: 'bag', unitPriceE4: 620_000_000n, priceListId: device.priceListId });
  const tiles = await seedProduct(db, { code: 'TILE', name: 'Floor tile', uomLabel: 'piece', unitPriceE4: 15_000_000n, priceListId: device.priceListId });
  const cartId = await createCart(db, { nowIso: NOW });
  await addProductToCart(db, cartId, bags);
  await addProductToCart(db, cartId, bags);
  await addProductToCart(db, cartId, tiles);
  return { db, cartId, bags, tiles };
}

describe('saving a sale as a draft', () => {
  it('sets the sale aside whole and opens the next customer’s cart in the same step', async () => {
    const { db, cartId } = await counterWithSale();
    const before = await getCartLines(db, cartId);

    const nextId = await saveCartAsDraft(db, cartId, { label: '  Kofi —  collecting at 3pm ', nowIso: NOW });

    // Exactly one open cart, and it is the new, empty one.
    expect(await openCarts(db)).toBe(1);
    expect((await getOpenCart(db))?.id).toBe(nextId);
    expect(await getCartLines(db, nextId)).toHaveLength(0);
    // The draft is the same sale: same id, same lines, same prices.
    const [draft] = await listDrafts(db);
    expect(draft?.id).toBe(cartId);
    expect(draft?.label).toBe('Kofi — collecting at 3pm');
    expect(draft?.lines.map((l) => [l.productId, l.qtyScaled, l.unitPriceE4])).toEqual(
      before.map((l) => [l.productId, l.qtyScaled, l.unitPriceE4]),
    );
    // 2 × 620.00 + 15.00, in minor units, exactly.
    expect(draft?.totalMinor).toBe(125_500n);
  });

  it('refuses an empty sale, and a cart that is not the one on the counter', async () => {
    const { db, cartId } = await counterWithSale();
    const nextId = await saveCartAsDraft(db, cartId, { nowIso: NOW });
    await expect(saveCartAsDraft(db, nextId)).rejects.toThrow(DraftError); // empty
    await expect(saveCartAsDraft(db, cartId)).rejects.toThrow(/no longer the one on the counter/); // already a draft
    expect(await openCarts(db)).toBe(1);
    expect(await listDrafts(db)).toHaveLength(1);
  });

  it('a draft can never be checked out — only the sale on the counter can', async () => {
    const { db, cartId } = await counterWithSale();
    await saveCartAsDraft(db, cartId, { nowIso: NOW });
    await expect(checkout(db, { cartId, tenderedMinor: 200_000n, hlc: fixedHlc() })).rejects.toThrow(/no open cart/);
    expect(await db.getAll('SELECT id FROM outbox')).toHaveLength(0);
    expect(await getCartLines(db, cartId)).toHaveLength(3 - 1); // two products, three taps → two lines
  });
});

describe('resuming a draft', () => {
  it('brings the SAME sale back, and it completes under its original id', async () => {
    const { db, cartId } = await counterWithSale();
    await saveCartAsDraft(db, cartId, { label: 'Kofi', nowIso: NOW });

    const result = await resumeDraft(db, cartId, { nowIso: NOW });
    expect(result.setAsideCurrent).toBe(false);
    // The empty cart opened for the next customer was removed, not kept.
    expect(await openCarts(db)).toBe(1);
    expect((await getOpenCart(db))?.id).toBe(cartId);
    expect(await readOpenCartLabel(db)).toBe('Kofi');
    expect(await listDrafts(db)).toHaveLength(0);

    const sale = await checkout(db, { cartId, tenderedMinor: 200_000n, hlc: fixedHlc(), nowIso: NOW });
    expect(sale.saleId).toBe(cartId); // the idempotency key survived the round trip
    expect(sale.totalMinor).toBe(125_500n);
  });

  it('never loses the sale on the counter: with items, it becomes a draft itself', async () => {
    const { db, cartId: first, tiles } = await counterWithSale();
    const second = await saveCartAsDraft(db, first, { label: 'First customer', nowIso: NOW });
    await addProductToCart(db, second, tiles);

    const result = await resumeDraft(db, first, { nowIso: '2026-08-21T09:05:00.000Z' });
    expect(result.setAsideCurrent).toBe(true);
    expect(await openCarts(db)).toBe(1);
    expect((await getOpenCart(db))?.id).toBe(first);
    const drafts = await listDrafts(db);
    expect(drafts.map((d) => d.id)).toEqual([second]);
    expect(drafts[0]?.lines).toHaveLength(1);
  });

  it('refuses a draft that is not there any more', async () => {
    const { db, cartId } = await counterWithSale();
    await expect(resumeDraft(db, cartId)).rejects.toThrow(DraftError); // it is the OPEN cart, not a draft
    expect((await getOpenCart(db))?.id).toBe(cartId);
  });
});

describe('deleting a draft', () => {
  it('removes the draft and its lines, and never touches the sale on the counter', async () => {
    const { db, cartId } = await counterWithSale();
    const next = await saveCartAsDraft(db, cartId, { nowIso: NOW });
    await expect(deleteDraft(db, next)).rejects.toThrow(DraftError); // the open cart is not a draft
    await deleteDraft(db, cartId);
    expect(await listDrafts(db)).toHaveLength(0);
    expect(await db.getAll('SELECT id FROM cart_line WHERE cart_id = ?', [cartId])).toHaveLength(0);
    expect((await getOpenCart(db))?.id).toBe(next);
  });
});

describe('drafts and the till', () => {
  it('a draft does not block cash-up — the sale on the counter still does', async () => {
    const db = openTestDb();
    const device = await provisionDevice(db, { till: false });
    const till = await openTill(db, { openingFloatMinor: 0n, businessDate: DAY, openedOffline: false, hlc: fixedHlc(), nowIso: NOW });
    const bags = await seedProduct(db, { code: 'BAG', name: 'Cement', unitPriceE4: 620_000_000n, priceListId: device.priceListId });
    const cartId = await createCart(db, { nowIso: NOW });
    await addProductToCart(db, cartId, bags);
    await expect(closeTill(db, { tillId: till.id, countedMinor: 0n, hlc: fixedHlc(), nowIso: NOW })).rejects.toThrow(
      /sale is in progress/,
    );

    await saveCartAsDraft(db, cartId, { nowIso: NOW });
    await expect(closeTill(db, { tillId: till.id, countedMinor: 0n, hlc: fixedHlc(), nowIso: NOW })).resolves.toMatchObject({
      varianceMinor: 0n,
    });
    // …and the draft is still there for tomorrow.
    expect(await listDrafts(db)).toHaveLength(1);
  });
});
