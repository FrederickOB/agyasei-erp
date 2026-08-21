/**
 * CLAUDE.md §2.7 categories 1 and 2: checkout touches money and is the
 * client's write path into the sync outbox. These tests run against real
 * SQLite over the device's own schema and SQL.
 *
 * THE REGRESSION THIS FILE EXISTS FOR: `buildSalePayload` used to invent its
 * own snake_case shape (`kind`, `sale_id`, `price_list_id`, `total_minor`,
 * a nested `tender` object) while the API parsed a `.strict()` schema wanting
 * `locationId`, `priceListCode`, `receiptNo`, `businessDate` and a
 * `'CASH' | 'CREDIT'` tender. Every sale the PWA uploaded was a BAD_REQUEST.
 * No test caught it because `packages/sync-drills` built its own API-shaped
 * payloads instead of the client's — the real client shape was never once
 * checked against the API.
 *
 * So the tests below parse the CLIENT'S OWN payload with the REAL contract
 * schema imported from `@erp/contracts`. Not a copy of it, not a fixture
 * shaped like it: the object `apps/api` parses. A future divergence fails
 * here, and fails `tsc` before it gets that far.
 */
import { createSaleInput } from '@erp/contracts';
import { describe, expect, it } from 'vitest';
import { CLAIMED_HLC_RE } from '../src/lib/hlc';
import { UUID_RE } from '../src/lib/uuidv7';
import { addProductToCart, createCart, setCartLineQty } from '../src/data/mutations/cart';
import {
  buildSalePayload,
  checkout,
  DuplicateSaleError,
  EmptyCartError,
  SaleContextIncompleteError,
  SalePayloadInvalidError,
  ShortTenderError,
  cartTotalMinor,
} from '../src/data/mutations/checkout';
import { getCartLines, getOpenCart } from '../src/data/queries/cart';
import { getRecordedSale, readOutboxQueue, recentSales } from '../src/data/queries/sales';
import { CONFIG_KEY_LOCATION_ID } from '../src/data/queries/session';
import { openTestDb } from './helpers/node-db';
import { fixedHlc, provisionDevice, seedProduct, type ProvisionedDevice } from './helpers/fixtures';
import type { LocalDb } from '../src/data/db';

interface Fixture {
  readonly cartId: string;
  readonly device: ProvisionedDevice;
}

async function cartWithTwoLines(db: LocalDb): Promise<Fixture> {
  const device = await provisionDevice(db);
  // 20 bags at 62000 minor units each (unit_price_e4 = 620000000).
  const bags = await seedProduct(db, {
    code: 'BAG-1',
    name: 'Bagged product',
    uomLabel: 'bag',
    qtyScale: 0,
    unitPriceE4: 620000000n,
    priceListId: device.priceListId,
  });
  // 2.500 kg at scale 3, 975 minor units per kg (unit_price_e4 = 9750000).
  const wire = await seedProduct(db, {
    code: 'KG-1',
    name: 'By-weight product',
    uomLabel: 'kg',
    qtyScale: 3,
    unitPriceE4: 9750000n,
    priceListId: device.priceListId,
  });
  const cartId = await createCart(db, { nowIso: '2026-08-21T09:00:00.000Z' });
  for (let i = 0; i < 20; i++) await addProductToCart(db, cartId, bags);
  await addProductToCart(db, cartId, wire);
  const lines = await getCartLines(db, cartId);
  const wireLine = lines.find((l) => l.productId === wire.id);
  if (wireLine === undefined) throw new Error('wire line missing');
  await setCartLineQty(db, wireLine.id, 2500n); // 2.500 kg
  return { cartId, device };
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
    expect(result.receiptNo.length).toBeGreaterThan(0);

    // Outbox row exists, carries the idempotency key and the claimed HLC.
    const rows = await db.getAll(
      `SELECT id, idempotency_key, claimed_hlc, kind, payload, receipt_no,
              CAST(total_minor AS TEXT) AS total_minor,
              CAST(tendered_minor AS TEXT) AS tendered_minor,
              CAST(change_minor AS TEXT) AS change_minor, server_ack_at
         FROM outbox`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row['idempotency_key']).toBe(cartId);
    expect(String(row['idempotency_key'])).toMatch(UUID_RE);
    expect(String(row['claimed_hlc'])).toMatch(CLAIMED_HLC_RE);
    expect(row['kind']).toBe('sale');
    expect(BigInt(String(row['total_minor']))).toBe(EXPECTED_TOTAL);
    expect(row['receipt_no']).toBe(result.receiptNo);
    expect(row['server_ack_at']).toBeNull();

    // Cash tendered and change are kept LOCALLY — the contract refuses them
    // because the server has nowhere to put them yet, so the device is the
    // only place cash-up can read them from. Dropping them entirely would
    // have lost data the old payload carried.
    expect(BigInt(String(row['tendered_minor']))).toBe(1_300_000n);
    expect(BigInt(String(row['change_minor']))).toBe(1_300_000n - EXPECTED_TOTAL);

    // Cart and lines are gone — atomically, in the same transaction.
    expect(await getOpenCart(db)).toBeNull();
    expect(await getCartLines(db, cartId)).toHaveLength(0);

    // The sale is visible in recent sales as pending (§8.5).
    const sales = await recentSales(db);
    expect(sales).toHaveLength(1);
    expect(sales[0]!.syncState).toBe('pending');
    expect(sales[0]!.totalMinor).toBe(EXPECTED_TOTAL);
    expect(sales[0]!.receiptNo).toBe(result.receiptNo);

    const queue = await readOutboxQueue(db);
    expect(queue.pendingCount).toBe(1);
    expect(queue.oldestQueuedAtMs).toBe(Date.parse('2026-08-21T09:05:00.000Z'));
  });

  it('rolls back the outbox insert, the cart clear AND the receipt number together', async () => {
    const db = openTestDb({ failOn: (sql) => sql.startsWith('DELETE FROM cart_line') });
    const { cartId } = await cartWithTwoLines(db);

    await expect(
      checkout(db, { cartId, tenderedMinor: 2_000_000n, hlc: fixedHlc() }),
    ).rejects.toThrow(/injected fault/);

    // NEITHER side of the transaction survives: no phantom sale, cart intact.
    expect(await db.getAll('SELECT id FROM outbox')).toHaveLength(0);
    expect(await getOpenCart(db)).not.toBeNull();
    expect(await getCartLines(db, cartId)).toHaveLength(2);
    // A failed checkout burns NO receipt number: the block row rolled back
    // with everything else, so the next sale gets the number this one nearly
    // took. Numbers are consumed by recorded sales, not by attempts.
    expect(await db.getAll('SELECT id FROM sequence_block')).toHaveLength(0);
  });

  it('refuses a replayed idempotency key and leaves the cart untouched', async () => {
    const db = openTestDb();
    const { cartId, device } = await cartWithTwoLines(db);
    await checkout(db, { cartId, tenderedMinor: 2_000_000n, hlc: fixedHlc() });

    // A crash-and-resume that somehow reconstructs the same cart id must be
    // refused, not double-recorded.
    await createCart(db, { id: cartId });
    const product = await seedProduct(db, {
      code: 'X',
      name: 'Extra',
      unitPriceE4: 10000n,
      priceListId: device.priceListId,
    });
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
    const device = await provisionDevice(db);
    const cartId = await createCart(db);
    await expect(
      checkout(db, { cartId, tenderedMinor: 1_000n, hlc: fixedHlc() }),
    ).rejects.toThrow(EmptyCartError);

    const product = await seedProduct(db, {
      code: 'P',
      name: 'Thing',
      unitPriceE4: 50_000_000n,
      priceListId: device.priceListId,
    });
    await addProductToCart(db, cartId, product); // total 5000 minor units
    await expect(
      checkout(db, { cartId, tenderedMinor: 4_999n, hlc: fixedHlc() }),
    ).rejects.toThrow(ShortTenderError);

    expect(await db.getAll('SELECT id FROM outbox')).toHaveLength(0);
    expect(await getCartLines(db, cartId)).toHaveLength(1);
  });

  it('refuses to record when the device does not know where it is', async () => {
    const db = openTestDb();
    const { cartId } = await cartWithTwoLines(db);
    // An unprovisioned device: the location binding is gone.
    await db.execute('DELETE FROM local_config WHERE key = ?', [CONFIG_KEY_LOCATION_ID]);

    await expect(
      checkout(db, { cartId, tenderedMinor: 2_000_000n, hlc: fixedHlc() }),
    ).rejects.toThrow(SaleContextIncompleteError);

    // Refused BEFORE anything was written, and the cart is still on screen —
    // the sale is visible work, never a silent drop.
    expect(await db.getAll('SELECT id FROM outbox')).toHaveLength(0);
    expect(await getCartLines(db, cartId)).toHaveLength(2);
  });

  it('refuses to record when the price list it rang against cannot be named', async () => {
    const db = openTestDb();
    const { cartId, device } = await cartWithTwoLines(db);
    // The synced price_list row has not arrived (or was renamed away): the
    // device cannot tell the server which list to reprice from.
    await db.execute('DELETE FROM price_list WHERE id = ?', [device.priceListId]);

    await expect(
      checkout(db, { cartId, tenderedMinor: 2_000_000n, hlc: fixedHlc() }),
    ).rejects.toThrow(SaleContextIncompleteError);
    expect(await db.getAll('SELECT id FROM outbox')).toHaveLength(0);
    expect(await getCartLines(db, cartId)).toHaveLength(2);
  });

  it('records a credit sale under the CREDIT tender and refuses one with no customer', async () => {
    const db = openTestDb();
    const { cartId } = await cartWithTwoLines(db);
    await expect(
      checkout(db, { cartId, tenderedMinor: 0n, hlc: fixedHlc(), tender: 'CREDIT' }),
    ).rejects.toThrow(SaleContextIncompleteError);

    const customerId = '018f0c4c-0000-7000-8000-0000000000c1';
    const result = await checkout(db, {
      cartId,
      tenderedMinor: 0n, // no cash changes hands on credit
      hlc: fixedHlc(),
      tender: 'CREDIT',
      customerId,
    });
    expect(result.changeMinor).toBe(0n);

    const rows = await db.getAll('SELECT payload FROM outbox');
    const payload = createSaleInput.parse(JSON.parse(String(rows[0]!['payload'])));
    expect(payload.tender).toBe('CREDIT');
    expect(payload.customerId).toBe(customerId);
  });
});

describe('buildSalePayload — the wire contract, not a shape of our own', () => {
  async function payloadOf(db: LocalDb): Promise<{ raw: unknown; device: ProvisionedDevice }> {
    const { cartId, device } = await cartWithTwoLines(db);
    await checkout(db, {
      cartId,
      tenderedMinor: 1_300_000n,
      hlc: fixedHlc(),
      nowIso: '2026-08-21T09:05:00.000Z',
    });
    const rows = await db.getAll('SELECT payload FROM outbox');
    return { raw: JSON.parse(String(rows[0]!['payload'])), device };
  }

  it('PARSES against the real contract schema the API parses with', async () => {
    const db = openTestDb();
    const { raw, device } = await payloadOf(db);

    // The regression. `.strict()` means every key must be one the API accepts
    // and every required key must be present — if this passes, the API cannot
    // BAD_REQUEST the payload on shape.
    const parsed = createSaleInput.parse(raw);

    expect(parsed.locationId).toBe(device.locationId);
    expect(parsed.priceListCode).toBe(device.priceListCode);
    expect(parsed.businessDate).toBe('2026-08-21');
    expect(parsed.tender).toBe('CASH');
    expect(parsed.receiptNo.length).toBeGreaterThan(0);
    expect(parsed.lines).toHaveLength(2);
    // Money and quantity arrive as bigint on the far side of the transform —
    // never as a JS number, at any point (ADR-0004).
    expect(parsed.clientTotalMinor).toBe(EXPECTED_TOTAL);
    for (const line of parsed.lines) {
      expect(typeof line.qty).toBe('bigint');
      expect(line.qty > 0n).toBe(true);
      expect(line.lineDiscountMinor).toBe(0n);
    }
  });

  it('sends NO authoritative price: no unit price, no line total, no sale total', async () => {
    const db = openTestDb();
    const { raw } = await payloadOf(db);
    const obj = raw as Record<string, unknown>;

    // The server reprices from the price list in force on the business date.
    // A client-asserted price is not a field the contract has, and the whole
    // reason `.strict()` rejects unknown keys is to keep it that way.
    for (const banned of ['total_minor', 'totalMinor', 'unitPriceE4', 'lineTotalMinor', 'taxLines']) {
      expect(banned in obj).toBe(false);
    }
    for (const line of obj['lines'] as Record<string, unknown>[]) {
      expect('unit_price_e4' in line).toBe(false);
      expect('unitPriceE4' in line).toBe(false);
      expect('line_total_minor' in line).toBe(false);
      expect('lineTotalMinor' in line).toBe(false);
    }
    // The one place a client-believed total is allowed — the contract's
    // stale-price-list DETECTOR, which the server compares and never obeys.
    expect(obj['clientTotalMinor']).toBe(EXPECTED_TOTAL.toString());
  });

  it('carries no tenant identity in any spelling (CLAUDE.md §2.1)', async () => {
    const db = openTestDb();
    const { raw } = await payloadOf(db);
    const json = JSON.stringify(raw);
    for (const spelling of ['tenant_id', 'tenantId', '"tid"']) {
      expect(json.includes(spelling)).toBe(false);
    }
  });

  it('serialises every monetary and quantity value as a decimal string, never a JSON number', async () => {
    const db = openTestDb();
    const { raw } = await payloadOf(db);
    const obj = raw as Record<string, unknown>;

    expect(typeof obj['clientTotalMinor']).toBe('string');
    for (const line of obj['lines'] as Record<string, unknown>[]) {
      expect(typeof line['qty']).toBe('string');
      expect(typeof line['lineDiscountMinor']).toBe('string');
    }
    // Nothing anywhere in the payload is a JSON number: a float64 never
    // carries a magnitude on this wire.
    const numbers: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number') numbers.push(path);
      else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (typeof value === 'object' && value !== null) {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      }
    };
    walk(obj, '$');
    expect(numbers).toEqual([]);
  });

  it('keeps the Q8 seam closed — sale capture only, no issuance or clearance', async () => {
    const db = openTestDb();
    const { raw } = await payloadOf(db);
    const obj = raw as Record<string, unknown>;
    for (const banned of ['clearance', 'invoice_number', 'invoiceNumber', 'qr', 'sdc']) {
      expect(banned in obj).toBe(false);
    }
  });

  it('would have FAILED on the old hand-rolled shape (the bug, reproduced)', () => {
    // Verbatim shape of the payload this client used to upload. Every sale it
    // produced was rejected BAD_REQUEST at the API's zod gate; this asserts
    // the test above is actually load-bearing.
    const legacy = {
      kind: 'sale',
      sale_id: '018f0c4c-0000-7000-8000-000000000001',
      price_list_id: '018f0c4c-0000-7000-8000-000000000002',
      created_at: '2026-08-21T09:05:00.000Z',
      lines: [
        {
          seq: 1,
          product_id: '018f0c4c-0000-7000-8000-000000000003',
          name: 'Bagged product',
          uom_label: 'bag',
          qty_scale: 0,
          qty_scaled: '20',
          unit_price_e4: '620000000',
          line_total_minor: '1240000',
        },
      ],
      tax_lines: [],
      total_minor: '1242438',
      tender: { kind: 'cash', tendered_minor: '1300000', change_minor: '57562' },
    };
    const result = createSaleInput.safeParse(legacy);
    expect(result.success).toBe(false);
  });

  it('refuses a payload the contract rejects BEFORE it reaches the outbox', async () => {
    const db = openTestDb();
    const { cartId, device } = await cartWithTwoLines(db);
    const lines = await getCartLines(db, cartId);

    // A location id that is not a UUID is exactly the class of defect that
    // used to travel silently to the server and come back a BAD_REQUEST hours
    // later, with the customer long gone.
    expect(() =>
      buildSalePayload({
        saleId: cartId,
        locationId: 'not-a-uuid',
        priceListCode: device.priceListCode,
        receiptNo: 'LOC1-000001',
        businessDate: '2026-08-21',
        tender: 'CASH',
        createdAt: '2026-08-21T09:05:00.000Z',
        lines,
        tenderedMinor: 1_300_000n,
      }),
    ).toThrow(SalePayloadInvalidError);

    // And a business date that is not a calendar date (30 February parses in
    // V8 and rolls over) is caught here rather than at Postgres.
    expect(() =>
      buildSalePayload({
        saleId: cartId,
        locationId: device.locationId,
        priceListCode: device.priceListCode,
        receiptNo: 'LOC1-000001',
        businessDate: '2026-02-30',
        tender: 'CASH',
        createdAt: '2026-08-21T09:05:00.000Z',
        lines,
        tenderedMinor: 1_300_000n,
      }),
    ).toThrow(SalePayloadInvalidError);

    expect(await db.getAll('SELECT id FROM outbox')).toHaveLength(0);
  });

  it('keeps the local display total intact — the counter still shows a figure offline', async () => {
    const db = openTestDb();
    const { cartId } = await cartWithTwoLines(db);
    const lines = await getCartLines(db, cartId);
    const built = buildSalePayload({
      saleId: cartId,
      locationId: '018f0c4c-0000-7000-8000-0000000000aa',
      priceListCode: 'DEFAULT',
      receiptNo: 'LOC1-000001',
      businessDate: '2026-08-21',
      tender: 'CASH',
      createdAt: '2026-08-21T09:05:00.000Z',
      lines,
      tenderedMinor: 1_300_000n,
    });
    // Same arithmetic as before the contract landed: the wire changed, the
    // counter's own figure did not.
    expect(built.totalMinor).toBe(EXPECTED_TOTAL);
    expect(built.changeMinor).toBe(1_300_000n - EXPECTED_TOTAL);
    expect(built.totalMinor).toBe(cartTotalMinor(lines));
  });
});
