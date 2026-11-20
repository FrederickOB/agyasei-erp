/**
 * A cart that cannot be sold, and the way out of it (§2.7 category 1 — this
 * decides whether a sale is recorded and which list the server reprices it
 * from; and it touches the sale's idempotency key).
 *
 * THE DEAD END BEING TESTED. A cart pins its price list once, at creation, and
 * the only statement in the app that deletes a cart is the one inside a
 * SUCCESSFUL checkout. So a cart whose pinned list has gone refuses at
 * checkout, survives the rollback, and is still the open cart on the next
 * attempt — forever, with no in-app escape. That is what put a real till out
 * of action: the device healed its synced tables (dropping the price list) and
 * kept its local-only ones (keeping the cart), exactly as designed, and the
 * cart outlived the row it pointed at.
 */
import { describe, expect, it } from 'vitest';
import type { LocalDb } from '../src/data/db';
import { addProductToCart, createCart, startFreshCart } from '../src/data/mutations/cart';
import { checkout, SaleContextIncompleteError } from '../src/data/mutations/checkout';
import { getCartLines, getOpenCart } from '../src/data/queries/cart';
import { CONFIG_KEY_PRICE_LIST_ID, readActivePriceListId } from '../src/data/queries/session';
import { blocksSale, resolveCartPriceList } from '../src/data/session/device-price-list';
import { readPendingOps } from '../src/data/sync/upload';
import { uuidv7 } from '../src/lib/uuidv7';
import { ensureOpenTill, fixedHlc, provisionDevice, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const TODAY = '2026-08-21';
const NOW = `${TODAY}T09:00:00.000Z`;

interface SyncedListFixture {
  readonly code?: string;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
  readonly locationId?: string | null;
  readonly taxInclusive?: boolean;
}

/** A price list as the SYNC STREAM delivers it: with a tenant_id. */
async function seedSyncedList(db: LocalDb, list: SyncedListFixture = {}): Promise<string> {
  const id = uuidv7();
  await db.execute(
    `INSERT INTO price_list (id, tenant_id, code, name, is_tax_inclusive, currency_code,
                             priority, location_id, effective_from, effective_to, hlc, updated_at)
     VALUES (?, ?, ?, 'A list', CAST(? AS INTEGER), 'XTS', 10, ?, ?, ?, NULL, NULL)`,
    [
      id,
      uuidv7(),
      list.code ?? 'THE-LIST',
      list.taxInclusive === true ? '1' : '0',
      list.locationId ?? null,
      list.effectiveFrom ?? '2026-08-01',
      list.effectiveTo ?? null,
    ],
  );
  return id;
}

/** Point the device at a list without going through provisioning policy. */
async function storeActiveList(db: LocalDb, priceListId: string): Promise<void> {
  await db.execute('DELETE FROM local_config WHERE key = ?', [CONFIG_KEY_PRICE_LIST_ID]);
  await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
    uuidv7(),
    CONFIG_KEY_PRICE_LIST_ID,
    priceListId,
  ]);
}

// ---------------------------------------------------------------------------
// Can this cart be sold?
// ---------------------------------------------------------------------------

describe('the price list a cart was rung against', () => {
  // FIRST, and deliberately: the offline rehearsal must not regress. The dev
  // seed's placeholder list carries no tenant_id and no effective window —
  // the two things that make it local-only — so judging it against tenant
  // configuration it was never part of would make every local-only cart
  // permanently unsellable, which is this whole defect, re-created one layer
  // down. A row with no tenant_id is asked nothing but whether it exists.
  it('leaves a local-only device’s placeholder list alone', async () => {
    const db = openTestDb();
    const device = await provisionDevice(db);

    const state = await resolveCartPriceList(db, device.priceListId, NOW);

    expect(state.status).toBe('sellable');
    expect(state.code).toBe(device.priceListCode);
    expect(blocksSale(state)).toBe(false);
  });

  it('refuses a cart pinned to nothing at all', async () => {
    const db = openTestDb();
    await provisionDevice(db);

    const state = await resolveCartPriceList(db, null, NOW);

    expect(state.status).toBe('unrecognised');
    expect(blocksSale(state)).toBe(true);
    expect(state.message).toContain('Start a fresh cart');
  });

  it('refuses a cart whose list is no longer on this device', async () => {
    // Exactly what a device healing its synced tables does to a cart that
    // outlived them: `price_list` is synced, `cart` is not.
    const db = openTestDb();
    const device = await provisionDevice(db);
    await db.execute('DELETE FROM price_list WHERE id = ?', [device.priceListId]);

    const state = await resolveCartPriceList(db, device.priceListId, NOW);

    expect(state.status).toBe('unrecognised');
    expect(state.code).toBeNull();
  });

  it('sells from a tenant’s list that covers this counter and is in force', async () => {
    const db = openTestDb();
    await provisionDevice(db);
    const listId = await seedSyncedList(db, { code: 'IN-FORCE' });

    const state = await resolveCartPriceList(db, listId, NOW);

    expect(state).toEqual({
      status: 'sellable',
      code: 'IN-FORCE',
      message: null,
      isTaxInclusive: false,
    });
  });

  it('refuses a list that lapsed overnight, at the counter', async () => {
    // THE SECOND HOLE. The row is right there and resolves perfectly, so the
    // code used to go up the wire and the API refused the sale hours later —
    // recorded at the counter, rejected at upload, which is the worst of the
    // three outcomes. `effective_to` is EXCLUSIVE, matching the API's window.
    const db = openTestDb();
    await provisionDevice(db);
    const listId = await seedSyncedList(db, { effectiveTo: TODAY });

    const state = await resolveCartPriceList(db, listId, NOW);

    expect(state.status).toBe('not-offered');
    expect(blocksSale(state)).toBe(true);
  });

  it('still sells from a list that lapses tomorrow', async () => {
    const db = openTestDb();
    await provisionDevice(db);
    const listId = await seedSyncedList(db, { effectiveTo: '2026-08-22' });

    expect((await resolveCartPriceList(db, listId, NOW)).status).toBe('sellable');
  });

  it('refuses a list scoped to another counter', async () => {
    const db = openTestDb();
    await provisionDevice(db);
    const listId = await seedSyncedList(db, { locationId: uuidv7() });

    expect((await resolveCartPriceList(db, listId, NOW)).status).toBe('not-offered');
  });

  it('sells a list that turned tax-inclusive under an open cart, and says so', async () => {
    // `is_tax_inclusive` is a synced column and CAN change under a cart that is
    // already open. It used to be a refusal — nothing could de-gross a shelf
    // price. Now it is an input: the verdict carries the LIVE value, so the
    // cart is priced in whichever direction the list currently declares rather
    // than the one it declared when the cart was pinned.
    const db = openTestDb();
    await provisionDevice(db);
    const listId = await seedSyncedList(db, { taxInclusive: true });

    const state = await resolveCartPriceList(db, listId, NOW);

    expect(blocksSale(state)).toBe(false);
    expect(state.isTaxInclusive).toBe(true);
  });

  it('derives the trading day in the LOCATION’s timezone, not the tablet’s', async () => {
    // 23:30 UTC is already the 22nd in Auckland, where this counter stands, so
    // a list that lapses on the 22nd is lapsed there while UTC still says the
    // 21st. The sale is filed on the location's day; the list is judged on it.
    const db = openTestDb();
    await provisionDevice(db, { timeZone: 'Pacific/Auckland' });
    const listId = await seedSyncedList(db, { effectiveTo: '2026-08-22' });

    expect((await resolveCartPriceList(db, listId, `${TODAY}T09:00:00.000Z`)).status).toBe(
      'sellable',
    );
    expect((await resolveCartPriceList(db, listId, `${TODAY}T23:30:00.000Z`)).status).toBe(
      'not-offered',
    );
  });
});

// ---------------------------------------------------------------------------
// The way out
// ---------------------------------------------------------------------------

describe('starting a fresh cart', () => {
  async function stuckTill(db: LocalDb): Promise<{ cartId: string; goodListId: string }> {
    const device = await provisionDevice(db);
    const product = await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: 620_000_000n,
      priceListId: device.priceListId,
    });
    const cartId = await createCart(db, { nowIso: NOW });
    await addProductToCart(db, cartId, product);
    // The list the cart was rung against disappears; the device is
    // re-provisioned onto the tenant's own list.
    await db.execute('DELETE FROM price_list WHERE id = ?', [device.priceListId]);
    const goodListId = await seedSyncedList(db, { code: 'CURRENT' });
    await storeActiveList(db, goodListId);
    return { cartId, goodListId };
  }

  it('is the only escape: the cart is otherwise permanent', async () => {
    const db = openTestDb();
    const { cartId } = await stuckTill(db);

    // Every attempt refuses, and the cart survives every refusal — which is
    // correct, and is also why nothing ever mints a replacement.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await ensureOpenTill(db, TODAY);
      await expect(
        checkout(db, { cartId, tenderedMinor: 100_000_000n, hlc: fixedHlc(), nowIso: NOW }),
      ).rejects.toBeInstanceOf(SaleContextIncompleteError);
      expect((await getOpenCart(db))?.id).toBe(cartId);
      expect(await getCartLines(db, cartId)).toHaveLength(1);
    }
  });

  it('discards the cart and its lines, and opens exactly one new one', async () => {
    const db = openTestDb();
    const { cartId, goodListId } = await stuckTill(db);

    const freshId = await startFreshCart(db, cartId);

    expect(freshId).not.toBe(cartId);
    const open = await getOpenCart(db);
    expect(open?.id).toBe(freshId);
    expect(open?.priceListId).toBe(goodListId);
    expect(await readActivePriceListId(db)).toBe(goodListId);
    expect(await getCartLines(db, cartId)).toHaveLength(0);
    expect(await db.getAll('SELECT id FROM cart')).toHaveLength(1);
  });

  it('records no sale — a discarded draft was never one', async () => {
    // The cart id IS the idempotency key (§8.2), and a key only ever reaches
    // the server through an outbox row, which only a completed checkout
    // writes. Discarding a cart that has none cannot orphan or duplicate a
    // sale, because no sale exists.
    const db = openTestDb();
    const { cartId } = await stuckTill(db);

    await startFreshCart(db, cartId);

    expect(await readPendingOps(db)).toHaveLength(0);
  });

  it('does not manufacture a second open cart when asked twice', async () => {
    // The repair effect and a finger on the button can both fire. A blind
    // delete-and-insert would leave TWO open carts, and `getOpenCart` takes
    // the newest — so the older one's lines would resurface at the next
    // tender. Recovering from a mis-ring must not manufacture one.
    const db = openTestDb();
    const { cartId } = await stuckTill(db);

    const first = await startFreshCart(db, cartId);
    const second = await startFreshCart(db, cartId); // the id is stale now

    expect(second).toBe(first);
    expect(await db.getAll('SELECT id FROM cart')).toHaveLength(1);
    expect((await getOpenCart(db))?.id).toBe(first);
  });

  it('leaves the till able to sell, under a new idempotency key', async () => {
    const db = openTestDb();
    const { cartId, goodListId } = await stuckTill(db);
    const freshId = await startFreshCart(db, cartId);

    // Re-ring against the list the counter actually sells from now.
    const product = await seedProduct(db, {
      code: 'P-2',
      name: 'Another product',
      unitPriceE4: 100_000_000n,
      priceListId: goodListId,
    });
    await addProductToCart(db, freshId, product);
    await ensureOpenTill(db, TODAY);
    const result = await checkout(db, {
      cartId: freshId,
      tenderedMinor: 100_000_000n,
      hlc: fixedHlc(),
      nowIso: NOW,
    });

    expect(result.saleId).toBe(freshId);
    const pending = await readPendingOps(db);
    expect(pending).toHaveLength(1);
    // The discarded cart's key never reached the wire, and the replacement is
    // a different sale — which is what re-ringing the goods actually is.
    expect(pending[0]?.idempotencyKey).toBe(freshId);
    expect(pending[0]?.idempotencyKey).not.toBe(cartId);
  });
});
