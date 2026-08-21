/**
 * CLAUDE.md §2.7 categories 1 and 2: checkout touches money and is the
 * client's write path into the sync outbox. These tests run against real
 * SQLite over the device's own schema and SQL.
 */
import { describe, expect, it } from 'vitest';
import { CLAIMED_HLC_RE } from '../src/lib/hlc';
import { UUID_RE } from '../src/lib/uuidv7';
import { addProductToCart, createCart, setCartLineQty } from '../src/data/mutations/cart';
import {
  buildSalePayload,
  checkout,
  DuplicateSaleError,
  EmptyCartError,
  ShortTenderError,
  cartTotalMinor,
} from '../src/data/mutations/checkout';
import { getCartLines, getOpenCart } from '../src/data/queries/cart';
import { getRecordedSale, readOutboxQueue, recentSales } from '../src/data/queries/sales';
import { openTestDb } from './helpers/node-db';
import { fixedHlc, seedProduct } from './helpers/fixtures';
import type { LocalDb } from '../src/data/db';

async function cartWithTwoLines(db: LocalDb): Promise<{ cartId: string }> {
  // 20 bags at 62000 minor units each (unit_price_e4 = 620000000).
  const bags = await seedProduct(db, {
    code: 'BAG-1',
    name: 'Bagged product',
    uomLabel: 'bag',
    qtyScale: 0,
    unitPriceE4: 620000000n,
  });
  // 2.500 kg at scale 3, 975 minor units per kg (unit_price_e4 = 9750000).
  const wire = await seedProduct(db, {
    code: 'KG-1',
    name: 'By-weight product',
    uomLabel: 'kg',
    qtyScale: 3,
    unitPriceE4: 9750000n,
  });
  const cartId = await createCart(db, { nowIso: '2026-08-21T09:00:00.000Z' });
  for (let i = 0; i < 20; i++) await addProductToCart(db, cartId, bags);
  await addProductToCart(db, cartId, wire);
  const lines = await getCartLines(db, cartId);
  const wireLine = lines.find((l) => l.productId === wire.id);
  if (wireLine === undefined) throw new Error('wire line missing');
  await setCartLineQty(db, wireLine.id, 2500n); // 2.500 kg
  return { cartId };
}

// Independent expected values:
//   line 1: 20 × 620000000 / 10^4                = 1_240_000 minor units
//   line 2: 2500 × 9750000 / 10^(3+4) = 2437.5   -> half-up -> 2438
//   total  = 1_242_438
const EXPECTED_TOTAL = 1_242_438n;

describe('checkout', () => {
  it('computes the exact bigint total across whole-unit and fractional lines', async () => {
    const db = openTestDb();
    const { cartId } = await cartWithTwoLines(db);
    const lines = await getCartLines(db, cartId);
    expect(cartTotalMinor(lines)).toBe(EXPECTED_TOTAL);
  });

  it('writes the outbox row and clears the cart in ONE transaction', async () => {
    const db = openTestDb();
    const { cartId } = await cartWithTwoLines(db);

    const result = await checkout(db, {
      cartId,
      tenderedMinor: 1_300_000n,
      hlc: fixedHlc(),
      nowIso: '2026-08-21T09:05:00.000Z',
    });

    expect(result.saleId).toBe(cartId);
    expect(result.totalMinor).toBe(EXPECTED_TOTAL);
    expect(result.changeMinor).toBe(1_300_000n - EXPECTED_TOTAL);

    // Outbox row exists, carries the idempotency key and the claimed HLC.
    const rows = await db.getAll(
      `SELECT id, idempotency_key, claimed_hlc, kind, payload,
              CAST(total_minor AS TEXT) AS total_minor, server_ack_at
         FROM outbox`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row['idempotency_key']).toBe(cartId);
    expect(String(row['idempotency_key'])).toMatch(UUID_RE);
    expect(String(row['claimed_hlc'])).toMatch(CLAIMED_HLC_RE);
    expect(row['kind']).toBe('sale');
    expect(BigInt(String(row['total_minor']))).toBe(EXPECTED_TOTAL);
    expect(row['server_ack_at']).toBeNull();

    // Cart and lines are gone — atomically, in the same transaction.
    expect(await getOpenCart(db)).toBeNull();
    expect(await getCartLines(db, cartId)).toHaveLength(0);

    // The sale is visible in recent sales as pending (§8.5).
    const sales = await recentSales(db);
    expect(sales).toHaveLength(1);
    expect(sales[0]!.syncState).toBe('pending');
    expect(sales[0]!.totalMinor).toBe(EXPECTED_TOTAL);

    const queue = await readOutboxQueue(db);
    expect(queue.pendingCount).toBe(1);
    expect(queue.oldestQueuedAtMs).toBe(Date.parse('2026-08-21T09:05:00.000Z'));
  });

  it('rolls back the outbox insert when clearing the cart fails (atomicity)', async () => {
    const db = openTestDb({ failOn: (sql) => sql.startsWith('DELETE FROM cart_line') });
    const { cartId } = await cartWithTwoLines(db);

    await expect(
      checkout(db, { cartId, tenderedMinor: 2_000_000n, hlc: fixedHlc() }),
    ).rejects.toThrow(/injected fault/);

    // NEITHER side of the transaction survives: no phantom sale, cart intact.
    expect(await db.getAll('SELECT id FROM outbox')).toHaveLength(0);
    expect(await getOpenCart(db)).not.toBeNull();
    expect(await getCartLines(db, cartId)).toHaveLength(2);
  });

  it('refuses a replayed idempotency key and leaves the cart untouched', async () => {
    const db = openTestDb();
    const { cartId } = await cartWithTwoLines(db);
    await checkout(db, { cartId, tenderedMinor: 2_000_000n, hlc: fixedHlc() });

    // A crash-and-resume that somehow reconstructs the same cart id must be
    // refused, not double-recorded.
    await createCart(db, { id: cartId });
    const product = await seedProduct(db, { code: 'X', name: 'Extra', unitPriceE4: 10000n });
    await addProductToCart(db, cartId, product);

    await expect(
      checkout(db, { cartId, tenderedMinor: 2_000_000n, hlc: fixedHlc() }),
    ).rejects.toThrow(DuplicateSaleError);

    // Exactly one recorded sale; the second cart rolled back intact.
    expect(await db.getAll('SELECT id FROM outbox')).toHaveLength(1);
    expect(await getCartLines(db, cartId)).toHaveLength(1);
    expect(await getRecordedSale(db, cartId)).not.toBeNull();
  });

  it('refuses an empty cart and a short tender, recording nothing', async () => {
    const db = openTestDb();
    const cartId = await createCart(db);
    await expect(
      checkout(db, { cartId, tenderedMinor: 1_000n, hlc: fixedHlc() }),
    ).rejects.toThrow(EmptyCartError);

    const product = await seedProduct(db, { code: 'P', name: 'Thing', unitPriceE4: 50_000_000n });
    await addProductToCart(db, cartId, product); // total 5000 minor units
    await expect(
      checkout(db, { cartId, tenderedMinor: 4_999n, hlc: fixedHlc() }),
    ).rejects.toThrow(ShortTenderError);

    expect(await db.getAll('SELECT id FROM outbox')).toHaveLength(0);
    expect(await getCartLines(db, cartId)).toHaveLength(1);
  });
});

describe('buildSalePayload', () => {
  it('serialises every monetary value as a decimal string, never a JSON number', async () => {
    const db = openTestDb();
    const { cartId } = await cartWithTwoLines(db);
    const lines = await getCartLines(db, cartId);
    const built = buildSalePayload({
      saleId: cartId,
      priceListId: null,
      createdAt: '2026-08-21T09:05:00.000Z',
      lines,
      tenderedMinor: 1_300_000n,
    });
    const payload = JSON.parse(built.payloadJson) as Record<string, unknown>;

    expect(payload['total_minor']).toBe(EXPECTED_TOTAL.toString());
    expect(typeof payload['total_minor']).toBe('string');

    const tender = payload['tender'] as Record<string, unknown>;
    expect(tender['tendered_minor']).toBe('1300000');
    expect(tender['change_minor']).toBe((1_300_000n - EXPECTED_TOTAL).toString());

    for (const rawLine of payload['lines'] as Record<string, unknown>[]) {
      expect(typeof rawLine['qty_scaled']).toBe('string');
      expect(typeof rawLine['unit_price_e4']).toBe('string');
      expect(typeof rawLine['line_total_minor']).toBe('string');
    }

    // Q8 seam: sale capture only — no issuance/clearance fields.
    expect(payload['tax_lines']).toEqual([]);
    expect('clearance' in payload).toBe(false);
    expect('invoice_number' in payload).toBe(false);
  });
});
