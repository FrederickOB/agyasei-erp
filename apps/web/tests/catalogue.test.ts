/**
 * What a counter may sell, and at what price (§2.7 category 1 — money — and
 * category 3 — a read path).
 *
 * The projection this exercises replaced one that read columns only the dev
 * seed ever wrote, which is why a synced till showed five demo products and
 * none of its tenant's 219. Everything below is about the four questions it
 * now answers from the tenant's own rows: which list, which unit, which
 * effective window, and what the price actually is.
 */
import { describe, expect, it } from 'vitest';
import type { LocalDb } from '../src/data/db';
import { loadActiveProducts } from '../src/data/queries/products';
import { CONFIG_KEY_PRICE_LIST_ID } from '../src/data/queries/session';
import { uuidv7 } from '../src/lib/uuidv7';
import { provisionDevice, seedProduct } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const TODAY = '2026-08-21';
const NOW = `${TODAY}T09:00:00.000Z`;

interface ItemFixture {
  readonly priceListId: string;
  readonly productId: string;
  readonly uomId: string;
  readonly unitPriceE4: bigint;
  readonly minQty?: bigint;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string | null;
}

/** A price row, with the parts the projection has to choose between. */
async function seedPrice(db: LocalDb, item: ItemFixture): Promise<void> {
  await db.execute(
    `INSERT INTO price_list_item (id, tenant_id, price_list_id, product_id, uom_id,
                                  unit_price_e4, min_qty, effective_from, effective_to,
                                  hlc, updated_at)
     VALUES (?, NULL, ?, ?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), ?, ?, NULL, NULL)`,
    [
      uuidv7(),
      item.priceListId,
      item.productId,
      item.uomId,
      item.unitPriceE4.toString(),
      (item.minQty ?? 0n).toString(),
      item.effectiveFrom ?? '2026-08-01',
      item.effectiveTo ?? null,
    ],
  );
}

/** The unit a product was seeded in — the one flagged `is_default_sell`. */
async function defaultUomId(db: LocalDb, productId: string): Promise<string> {
  const rows = await db.getAll(
    'SELECT uom_id FROM product_uom WHERE product_id = ? AND is_default_sell = 1',
    [productId],
  );
  return String(rows[0]?.['uom_id']);
}

/** A second, non-default selling unit on an existing product. */
async function seedAlternateUom(db: LocalDb, productId: string, code: string): Promise<string> {
  const uomId = uuidv7();
  await db.execute(
    `INSERT INTO unit_of_measure (id, tenant_id, code, name, dimension, qty_scale, hlc, updated_at)
     VALUES (?, NULL, ?, ?, NULL, 0, NULL, NULL)`,
    [uomId, code, code],
  );
  await db.execute(
    `INSERT INTO product_uom (id, tenant_id, product_id, uom_id, factor_num, factor_den,
                              can_sell, can_buy, is_default_sell, tolerance_bp, sort_order,
                              hlc, updated_at)
     VALUES (?, NULL, ?, ?, 1, 1, 1, 1, 0, 0, 1, NULL, NULL)`,
    [uuidv7(), productId, uomId],
  );
  return uomId;
}

describe('the shelf a counter sells from', () => {
  it('prices from THIS device’s list, not from another list holding the same product', async () => {
    const db = openTestDb();
    const device = await provisionDevice(db);
    const product = await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: 620_000_000n,
      priceListId: device.priceListId,
    });
    // The same product, dearer, on a list this counter is not set up for.
    await seedPrice(db, {
      priceListId: uuidv7(),
      productId: product.id,
      uomId: await defaultUomId(db, product.id),
      unitPriceE4: 999_000_000n,
    });

    const shelf = await loadActiveProducts(db, NOW);

    expect(shelf).toHaveLength(1);
    expect(shelf[0]?.unitPriceE4).toBe(620_000_000n);
    expect(shelf[0]?.priceListId).toBe(device.priceListId);
  });

  it('leaves an unpriced product OFF the shelf rather than showing it at nothing', async () => {
    const db = openTestDb();
    const device = await provisionDevice(db);
    await seedProduct(db, {
      code: 'PRICED',
      name: 'Priced',
      unitPriceE4: 100_000n,
      priceListId: device.priceListId,
    });
    // Priced on someone else's list only: this counter cannot name a price.
    await seedProduct(db, {
      code: 'UNPRICED',
      name: 'Unpriced here',
      unitPriceE4: 100_000n,
      priceListId: uuidv7(),
    });

    const shelf = await loadActiveProducts(db, NOW);

    // A till that lets someone ring an item it cannot price hands the refusal
    // to the API, hours later, after the customer has gone.
    expect(shelf.map((p) => p.code)).toEqual(['PRICED']);
  });

  it('honours the effective window, with effective_to EXCLUSIVE like the server’s', async () => {
    const db = openTestDb();
    const device = await provisionDevice(db);
    const product = await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: 1n,
      priceListId: uuidv7(), // not this counter's — the rows below are
    });
    const uomId = await defaultUomId(db, product.id);

    // Lapses at the start of today: the API's own predicate is
    // `effective_to > $date`, so a device that disagreed by a day would price
    // against a row the server then refuses.
    await seedPrice(db, {
      priceListId: device.priceListId,
      productId: product.id,
      uomId,
      unitPriceE4: 500_000n,
      effectiveFrom: '2026-01-01',
      effectiveTo: TODAY,
    });
    expect(await loadActiveProducts(db, NOW)).toEqual([]);

    // Starts tomorrow.
    await seedPrice(db, {
      priceListId: device.priceListId,
      productId: product.id,
      uomId,
      unitPriceE4: 700_000n,
      effectiveFrom: '2026-08-22',
    });
    expect(await loadActiveProducts(db, NOW)).toEqual([]);

    await seedPrice(db, {
      priceListId: device.priceListId,
      productId: product.id,
      uomId,
      unitPriceE4: 600_000n,
      effectiveFrom: TODAY,
    });
    const shelf = await loadActiveProducts(db, NOW);
    expect(shelf.map((p) => p.unitPriceE4)).toEqual([600_000n]);
  });

  it('shows the price for buying ONE, not a quantity break', async () => {
    const db = openTestDb();
    const device = await provisionDevice(db);
    const product = await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: 620_000_000n,
      priceListId: device.priceListId,
    });
    // A cheaper price from ten up. The server applies breaks when it reprices;
    // the shelf must not advertise a price nobody buying one will be charged.
    await seedPrice(db, {
      priceListId: device.priceListId,
      productId: product.id,
      uomId: await defaultUomId(db, product.id),
      unitPriceE4: 500_000_000n,
      minQty: 10n,
    });

    const shelf = await loadActiveProducts(db, NOW);

    expect(shelf.map((p) => p.unitPriceE4)).toEqual([620_000_000n]);
  });

  it('picks one row deterministically when two prices are equally applicable', async () => {
    const db = openTestDb();
    const device = await provisionDevice(db);
    const product = await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: 100_000n, // effective 2000-01-01 via the fixture
      priceListId: device.priceListId,
    });
    // A repricing that started this month, same quantity break. The newer
    // window wins — and, more importantly, the answer never changes between
    // reads: a shelf price that flickered would be worse than either value.
    await seedPrice(db, {
      priceListId: device.priceListId,
      productId: product.id,
      uomId: await defaultUomId(db, product.id),
      unitPriceE4: 130_000n,
      effectiveFrom: '2026-08-01',
    });

    const first = await loadActiveProducts(db, NOW);
    const second = await loadActiveProducts(db, NOW);

    expect(first.map((p) => p.unitPriceE4)).toEqual([130_000n]);
    expect(second).toEqual(first);
  });

  it('sells in the unit the server prices in — the default selling unit', async () => {
    const db = openTestDb();
    const device = await provisionDevice(db);
    const product = await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      uomLabel: 'bag',
      unitPriceE4: 620_000_000n,
      priceListId: device.priceListId,
    });
    // The same product priced by the pallet. The wire carries no uomCode, so
    // `sales.createSale` prices the DEFAULT selling unit; a shelf offering the
    // pallet price would be repriced to something else on arrival.
    const palletId = await seedAlternateUom(db, product.id, 'PALLET');
    await seedPrice(db, {
      priceListId: device.priceListId,
      productId: product.id,
      uomId: palletId,
      unitPriceE4: 30_000_000_000n,
    });

    const shelf = await loadActiveProducts(db, NOW);

    expect(shelf).toHaveLength(1);
    expect(shelf[0]?.uomLabel).toBe('bag');
    expect(shelf[0]?.unitPriceE4).toBe(620_000_000n);
  });

  it('leaves a product priced only in a non-default unit off the shelf', async () => {
    const db = openTestDb();
    const device = await provisionDevice(db);
    const product = await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: 1n,
      priceListId: uuidv7(),
    });
    await seedPrice(db, {
      priceListId: device.priceListId,
      productId: product.id,
      uomId: await seedAlternateUom(db, product.id, 'PALLET'),
      unitPriceE4: 30_000_000_000n,
    });

    expect(await loadActiveProducts(db, NOW)).toEqual([]);
  });

  it('leaves a product its tenant marked unsellable off the shelf', async () => {
    const db = openTestDb();
    const device = await provisionDevice(db);
    const product = await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: 620_000_000n,
      priceListId: device.priceListId,
    });
    await db.execute('UPDATE product SET is_sellable = 0 WHERE id = ?', [product.id]);

    expect(await loadActiveProducts(db, NOW)).toEqual([]);
  });

  it('carries the price as an exact integer, past where a float would drift', async () => {
    const db = openTestDb();
    const device = await provisionDevice(db);
    // Beyond Number.MAX_SAFE_INTEGER: a projection that touched `number`
    // anywhere would return ...992 or ...994 here (ADR-0004).
    const exact = 9_007_199_254_740_993n;
    await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: exact,
      priceListId: device.priceListId,
    });

    const shelf = await loadActiveProducts(db, NOW);

    expect(shelf[0]?.unitPriceE4).toBe(exact);
    expect(typeof shelf[0]?.unitPriceE4).toBe('bigint');
  });

  it('derives the trading day in the LOCATION’s timezone, not the tablet’s', async () => {
    const db = openTestDb();
    // 23:30 UTC is already the next day in Auckland, where the counter stands.
    const device = await provisionDevice(db, { timeZone: 'Pacific/Auckland' });
    const product = await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: 1n,
      priceListId: uuidv7(),
    });
    await seedPrice(db, {
      priceListId: device.priceListId,
      productId: product.id,
      uomId: await defaultUomId(db, product.id),
      unitPriceE4: 400_000n,
      effectiveFrom: '2026-08-22',
    });

    expect(await loadActiveProducts(db, `${TODAY}T09:00:00.000Z`)).toEqual([]);
    const shelf = await loadActiveProducts(db, `${TODAY}T23:30:00.000Z`);
    expect(shelf.map((p) => p.unitPriceE4)).toEqual([400_000n]);
  });

  it('offers nothing at all when this device has no price list', async () => {
    const db = openTestDb();
    const device = await provisionDevice(db);
    await seedProduct(db, {
      code: 'P-1',
      name: 'A product',
      unitPriceE4: 620_000_000n,
      priceListId: device.priceListId,
    });
    await db.execute('DELETE FROM local_config WHERE key = ?', [CONFIG_KEY_PRICE_LIST_ID]);

    // The gate in App.tsx speaks to this before a counter is ever shown; the
    // read path must not quietly invent a shelf behind it.
    expect(await loadActiveProducts(db, NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (§2.7 category 3)
// ---------------------------------------------------------------------------

describe('a second tenant’s catalogue', () => {
  it('is invisible to this counter, priced on its own list', async () => {
    // A device holds one tenant's rows because the sync rules put them there
    // (`WHERE tenant_id = bucket.tenant_id`). This proves the client does not
    // widen that: the shelf is bounded by the list this device was provisioned
    // with, never by comparing tenant ids — which the client has no business
    // asserting (§2.1) and could not do, since it holds none.
    const db = openTestDb();
    const device = await provisionDevice(db);
    const ours = await seedProduct(db, {
      code: 'OURS',
      name: 'Ours',
      unitPriceE4: 620_000_000n,
      priceListId: device.priceListId,
    });
    const theirProduct = await seedProduct(db, {
      code: 'THEIRS',
      name: 'Theirs',
      unitPriceE4: 111_000_000n,
      priceListId: uuidv7(), // their list
    });
    await db.execute('UPDATE product SET tenant_id = ? WHERE id = ?', [uuidv7(), theirProduct.id]);

    const shelf = await loadActiveProducts(db, NOW);

    expect(shelf.map((p) => p.id)).toEqual([ours.id]);
  });
});
