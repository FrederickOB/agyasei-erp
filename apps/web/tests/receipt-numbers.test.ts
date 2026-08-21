/**
 * Device-allocated receipt numbers (03-offline-sync §3.7.5).
 *
 * This is a correctness test, not a cosmetic one. `app.sale` carries
 * `unique (tenant_id, location_id, receipt_no)`: two devices at one counter
 * minting the same string means two customers holding "the same" receipt, and
 * a hard rejection on sync of a sale whose goods already left the yard. The
 * numbers are also allocated with the radio off, for days at a time, so no
 * server round trip can be part of the answer.
 *
 * Each `openTestDb()` here is a SEPARATE DEVICE: its own local SQLite, its own
 * blocks, its own HLC node id. That is the only honest way to test the
 * property, because the collision this guards against is between databases
 * that cannot see each other.
 */
import { createSaleInput } from '@erp/contracts';
import { describe, expect, it } from 'vitest';
import { addProductToCart, createCart } from '../src/data/mutations/cart';
import { checkout } from '../src/data/mutations/checkout';
import {
  allocateReceiptNumber,
  DEFAULT_LOCAL_BLOCK_SIZE,
  issueSequenceBlock,
  readSequenceBlocks,
  SEQUENCE_KEY_RECEIPT,
} from '../src/data/sequence';
import type { LocalDb } from '../src/data/db';
import {
  DEFAULT_RECEIPT_FORMAT,
  deviceTag,
  formatReceiptNumber,
  MAX_RECEIPT_NO_LENGTH,
  ReceiptNumberError,
} from '../src/lib/receipt-number';
import { uuidv7 } from '../src/lib/uuidv7';
import { openTestDb } from './helpers/node-db';
import { fixedHlc, provisionDevice, seedProduct } from './helpers/fixtures';

const NODE_A = 'a1'.repeat(16);
const NODE_B = 'b2'.repeat(16);
const LOCATION = '018f0c4c-0000-7000-8000-000000000a01';
const LOCATION_2 = '018f0c4c-0000-7000-8000-000000000b02';

function allocator(db: LocalDb, node: string) {
  return (locationId: string = LOCATION, locationCode = 'LOC1'): Promise<string> =>
    db.writeTransaction(async (tx) => {
      const allocated = await allocateReceiptNumber(tx, {
        locationId,
        locationCode,
        deviceNode: node,
        format: DEFAULT_RECEIPT_FORMAT,
        nowIso: '2026-08-21T09:00:00.000Z',
        newId: uuidv7,
      });
      return allocated.receiptNo;
    });
}

describe('receipt numbers are unique per location, across devices, offline', () => {
  it('two devices at the same location never mint the same number', async () => {
    // Two tills at one counter. Neither has ever reached a server, both start
    // their own counter at 1, and both are offline — the worst case.
    const tillA = openTestDb();
    const tillB = openTestDb();
    const nextA = allocator(tillA, NODE_A);
    const nextB = allocator(tillB, NODE_B);

    const fromA: string[] = [];
    const fromB: string[] = [];
    for (let i = 0; i < 50; i++) {
      fromA.push(await nextA());
      fromB.push(await nextB());
    }

    const all = [...fromA, ...fromB];
    expect(new Set(all).size).toBe(all.length);
    expect(fromA.some((n) => fromB.includes(n))).toBe(false);

    // Both counters really did run over the same numeric range — the test
    // would be vacuous if they had not collided numerically.
    expect(fromA[0]).toContain('000001');
    expect(fromB[0]).toContain('000001');
    // …and the identifier is what separates them.
    expect(fromA[0]!.endsWith(deviceTag(NODE_A))).toBe(true);
    expect(fromB[0]!.endsWith(deviceTag(NODE_B))).toBe(true);
  });

  it('is monotonic within a device and never repeats a number', async () => {
    const db = openTestDb();
    const next = allocator(db, NODE_A);
    const seen: string[] = [];
    for (let i = 0; i < 200; i++) seen.push(await next());

    expect(new Set(seen).size).toBe(200);
    // Lexicographic order is issue order: fixed width, zero-padded.
    expect([...seen].sort()).toEqual(seen);
  });

  it('keeps separate counters per location on one device', async () => {
    // A number is unique within (tenant, location), so each location runs its
    // own sequence rather than one shared counter across the network.
    const next = allocator(openTestDb(), NODE_A);

    const a1 = await next(LOCATION, 'LOC1');
    const b1 = await next(LOCATION_2, 'LOC2');
    const a2 = await next(LOCATION, 'LOC1');

    expect(a1).toBe('LOC1-000001-A1A1A1');
    expect(b1).toBe('LOC2-000001-A1A1A1'); // its own counter, not a continuation
    expect(a2).toBe('LOC1-000002-A1A1A1');
  });

  it('rolls over an exhausted block and keeps trading (§3.7.5)', async () => {
    const db = openTestDb();
    const scope = { sequenceKey: SEQUENCE_KEY_RECEIPT, locationId: LOCATION };
    // A tiny block, so exhaustion happens in the test rather than in Techiman.
    await db.writeTransaction((tx) =>
      issueSequenceBlock(tx, {
        ...scope,
        id: uuidv7(),
        deviceNode: NODE_A,
        nowIso: '2026-08-21T08:00:00.000Z',
        blockSize: 3n,
      }),
    );
    const next = allocator(db, NODE_A);
    const seen = [await next(), await next(), await next(), await next(), await next()];

    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([
      'LOC1-000001-A1A1A1',
      'LOC1-000002-A1A1A1',
      'LOC1-000003-A1A1A1',
      'LOC1-000004-A1A1A1',
      'LOC1-000005-A1A1A1',
    ]);

    const blocks = await db.writeTransaction((tx) => readSequenceBlocks(tx, scope));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.blockSize).toBe(3n);
    expect(blocks[0]!.exhaustedAt).not.toBeNull();
    // The next block starts one past the last one — a block is never reused.
    expect(blocks[1]!.blockStart).toBe(4n);
    expect(blocks[1]!.blockSize).toBe(DEFAULT_LOCAL_BLOCK_SIZE);
    expect(blocks[1]!.exhaustedAt).toBeNull();
  });

  it('reports what it consumed, so the gaps can be named (§3.7.5)', async () => {
    const db = openTestDb();
    const next = allocator(db, NODE_A);
    await next();
    await next();

    const blocks = await db.writeTransaction((tx) =>
      readSequenceBlocks(tx, { sequenceKey: SEQUENCE_KEY_RECEIPT, locationId: LOCATION }),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.blockStart).toBe(1n);
    expect(blocks[0]!.consumedUpto).toBe(2n);
    expect(blocks[0]!.source).toBe('device');
  });

  it('drops the device tag once the SERVER allocates the block', async () => {
    // The steady state §3.7.5 designs for: disjoint ranges from a row-locked
    // server counter, so the printed number needs no disambiguator.
    const db = openTestDb();
    await db.writeTransaction((tx) =>
      issueSequenceBlock(tx, {
        sequenceKey: SEQUENCE_KEY_RECEIPT,
        locationId: LOCATION,
        id: uuidv7(),
        deviceNode: NODE_A,
        nowIso: '2026-08-21T08:00:00.000Z',
        source: 'server',
        blockStart: 4001n,
        blockSize: 2000n,
      }),
    );
    const first = await allocator(db, NODE_A)();
    expect(first).toBe('LOC1-004001');
    expect(first.includes(deviceTag(NODE_A))).toBe(false);
  });
});

describe('receipt number formatting', () => {
  const parts = { locationCode: 'LOC1', seq: 42n, deviceNode: NODE_A, source: 'device' } as const;

  it('honours a tenant template — the format is configuration, not a constant', () => {
    const out = formatReceiptNumber(
      { template: '{location}-{prefix}-{seq}', width: 6, prefix: 'RC' },
      { ...parts, source: 'server' },
    );
    expect(out).toBe('LOC1-RC-000042');
  });

  it('collapses the separator a blank prefix leaves behind', () => {
    const out = formatReceiptNumber(
      { template: '{location}-{prefix}-{seq}', width: 4, prefix: '' },
      { ...parts, source: 'server' },
    );
    expect(out).toBe('LOC1-0042');
  });

  it('appends the device tag even when the tenant template omits it', () => {
    // Configuration must not be able to switch off a uniqueness guarantee.
    const out = formatReceiptNumber(
      { template: '{location}-{seq}', width: 6, prefix: '' },
      parts,
    );
    expect(out).toBe(`LOC1-000042-${deviceTag(NODE_A)}`);
  });

  it('does not double the device tag when the template placed it', () => {
    const out = formatReceiptNumber(
      { template: '{location}-{seq}-{device}', width: 6, prefix: '' },
      parts,
    );
    expect(out).toBe(`LOC1-000042-${deviceTag(NODE_A)}`);
  });

  it('RAISES rather than wrapping when the sequence outgrows the width', () => {
    // §3.7.5: the platform raises rather than wrapping. A wrapped number is a
    // silent duplicate, which is the exact failure this whole file guards.
    expect(() =>
      formatReceiptNumber({ template: '{location}-{seq}', width: 3, prefix: '' }, {
        ...parts,
        seq: 1000n,
      }),
    ).toThrow(ReceiptNumberError);
  });

  it('refuses a number the wire contract could not carry', () => {
    expect(() =>
      formatReceiptNumber(
        { template: `{location}-{seq}`, width: 6, prefix: '' },
        { ...parts, locationCode: 'X'.repeat(MAX_RECEIPT_NO_LENGTH) },
      ),
    ).toThrow(ReceiptNumberError);
  });

  it('produces a number the contract accepts', () => {
    const receiptNo = formatReceiptNumber(DEFAULT_RECEIPT_FORMAT, parts);
    const parsed = createSaleInput.parse({
      idempotencyKey: '018f0c4c-0000-7000-8000-000000000001',
      locationId: '018f0c4c-0000-7000-8000-0000000000aa',
      priceListCode: 'DEFAULT',
      receiptNo,
      businessDate: '2026-08-21',
      tender: 'CASH',
      lines: [{ productId: '018f0c4c-0000-7000-8000-0000000000bb', qty: '1' }],
    });
    expect(parsed.receiptNo).toBe(receiptNo);
  });
});

describe('receipt numbers through a real checkout', () => {
  it('two offline devices at one location ring sales with distinct numbers', async () => {
    const tills = [
      { db: openTestDb(), node: 'a1'.repeat(16) },
      { db: openTestDb(), node: 'b2'.repeat(16) },
    ];
    const numbers: string[] = [];

    for (const till of tills) {
      // The SAME location — that is the whole point. Two tills, one counter,
      // neither able to see the other's database.
      const device = await provisionDevice(till.db, { locationId: LOCATION });
      const product = await seedProduct(till.db, {
        code: 'P1',
        name: 'Thing',
        unitPriceE4: 50_000_000n,
        priceListId: device.priceListId,
      });
      for (let i = 0; i < 3; i++) {
        const cartId = await createCart(till.db);
        await addProductToCart(till.db, cartId, product);
        const result = await checkout(till.db, {
          cartId,
          tenderedMinor: 10_000n,
          hlc: fixedHlc(1_755_000_000_000, till.node),
        });
        numbers.push(result.receiptNo);
      }
    }

    expect(numbers).toHaveLength(6);
    expect(new Set(numbers).size).toBe(6);
  });
});
