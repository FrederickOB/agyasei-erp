/**
 * CLAUDE.md §2.7 category 2: the device half of the receipt-number mechanism
 * (03 §3.7.5). Real SQLite through the LocalDb seam, the same schema the device
 * runs; the server half lives in apps/api/test/sequence-regression.test.ts and
 * the whole path is drilled against the real stack by D6 in @erp/sync-drills.
 *
 * What has to hold here:
 *  - the counter never touches the network to print a number;
 *  - the cursor advances in the SAME transaction that mints the number;
 *  - exhaustion does not stop trading, and does not wrap onto numbers the
 *    device does not own;
 *  - a wiped device reports "I hold nothing" TRUTHFULLY — the whole detection
 *    depends on this device not guessing;
 *  - an issued block is adopted, including when it replaces a burned one.
 */
import { describe, expect, it } from 'vitest';
import type { LocalDb } from '../src/data/db';
import {
  adoptBlock,
  applySyncBlockResult,
  buildBlockReport,
  enqueueBlockReport,
  readCurrentBlock,
  sequenceResultHandler,
  takeNumber,
} from '../src/data/sequence';
import { drainOutbox, type UploadResult, type UploadTransport } from '../src/data/sync/upload';
import { wireKind } from '../src/data/sync/transport';
import { fixedHlc } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const LOCATION = 'loc-out-01';
const DEVICE = '01a02430-5627-780b-b10a-f9bec1050341';

/** Tenant configuration, as the server hands it down. Never a constant here. */
const FORMAT = {
  format: '{location_code}-{prefix}-{n:06d}',
  prefix: 'RCT',
  locationCode: 'OUT-01',
} as const;

async function withBlock(
  db: LocalDb,
  blockStart: string,
  blockSize: number,
): Promise<void> {
  await adoptBlock(db, { locationId: LOCATION, block: { blockStart, blockSize }, format: FORMAT });
}

async function take(db: LocalDb) {
  return takeNumber(db, { locationId: LOCATION, deviceId: DEVICE, locationCode: 'OUT-01' });
}

describe('consuming a block at the counter', () => {
  it('issues numbers in the tenant\'s format, with no network on the path', async () => {
    const db = openTestDb();
    await withBlock(db, '1000', 500);

    expect((await take(db)).receiptNo).toBe('OUT-01-RCT-001000');
    expect((await take(db)).receiptNo).toBe('OUT-01-RCT-001001');
    expect((await take(db)).receiptNo).toBe('OUT-01-RCT-001002');

    const block = await readCurrentBlock(db, LOCATION);
    expect(block!.consumedUpto).toBe(1002n);
  });

  it('with NO block it self-issues a device-tagged one — the till still trades', async () => {
    // The reporting half arrived refusing to issue anything without a
    // server-allocated block. That refusal was rejected on merge: it stops a
    // counter trading until the radio comes back, in a market where the radio
    // is down for days (CLAUDE.md §2.2). Disjointness comes from the DEVICE TAG
    // instead — un-collidable by construction, visibly exceptional on the paper,
    // and reported to the server on the next reconnect.
    const db = openTestDb();
    const first = await take(db);
    expect(first.emergency).toBe(true);
    expect(first.receiptNo).toMatch(/-01A024$/);

    const block = await readCurrentBlock(db, LOCATION);
    expect(block!.source).toBe('device');
    expect(block!.consumedUpto).toBe(first.n);

    // …and the very next reconnect asks for a real block, unconditionally.
    expect((await buildBlockReport(db, { locationId: LOCATION })).wantBlock).toBe(true);
  });

  it('advances the cursor in the SAME transaction that mints the number', async () => {
    // A battery pull between minting and recording would hand the next customer
    // a number this one already has — so the two must not be separable.
    const db = openTestDb({ failOn: (sql) => sql.includes('SET consumed_upto') });
    await withBlock(db, '1000', 500);
    await expect(take(db)).rejects.toThrow(/injected fault/);
    expect((await readCurrentBlock(db, LOCATION))!.consumedUpto).toBeNull();
  });

  it('exhaustion switches to the emergency form — trading never stops', async () => {
    const db = openTestDb();
    await withBlock(db, '4998', 2);
    expect((await take(db)).receiptNo).toBe('OUT-01-RCT-004998');
    expect((await take(db)).receiptNo).toBe('OUT-01-RCT-004999');

    // Spent. The server block is closed and a self-issued one opens in the same
    // transaction: the number is device-tagged (§3.7.5's emergency form) and
    // cannot collide with any allocated range at this or any other till.
    const spent = await take(db);
    expect(spent.emergency).toBe(true);
    expect(spent.receiptNo).toMatch(/-01A024$/);
    expect(spent.receiptNo).not.toBe('OUT-01-RCT-004999');

    // Two emergency numbers from ONE device do not collide with each other.
    const another = await take(db);
    expect(another.receiptNo).not.toBe(spent.receiptNo);

    // The burned block is KEPT, closed — §3.7.5 requires gaps be reportable and
    // a deleted row reports nothing.
    const rows = await db.getAll(
      'SELECT source, exhausted_at FROM sequence_block ORDER BY block_start',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!['source']).toBe('server');
    expect(rows[0]!['exhausted_at']).not.toBeNull();
    expect(rows[1]!['source']).toBe('device');
  });
});

describe('the reconnect report', () => {
  it('reports the cursor, and does not ask for a block while there is room', async () => {
    const db = openTestDb();
    await withBlock(db, '1000', 500);
    for (let i = 0; i < 10; i += 1) await take(db);

    const payload = await buildBlockReport(db, { locationId: LOCATION });
    expect(payload.report).toEqual({ blockStart: '1000', consumedUpto: '1009' });
    expect(payload.wantBlock).toBe(false);
  });

  it('asks for a replacement by DAYS of observed throughput (§3.7.5, corrected)', async () => {
    const db = openTestDb();
    await withBlock(db, '1000', 500);
    for (let i = 0; i < 150; i += 1) await take(db);

    // 350 left. At 20/day that is comfortable; at a flagship till's 150/day it
    // is barely two days and the block must be replaced now.
    expect((await buildBlockReport(db, { locationId: LOCATION, observedPerDay: 20 })).wantBlock).toBe(false);
    expect((await buildBlockReport(db, { locationId: LOCATION, observedPerDay: 150 })).wantBlock).toBe(true);
  });

  it('a WIPED device reports "I hold nothing" — truthfully, and asks for a block', async () => {
    const db = openTestDb();
    await withBlock(db, '1000', 500);
    for (let i = 0; i < 12; i += 1) await take(db);

    // OPFS eviction / PWA reinstall: the local-only row goes with it.
    await db.execute('DELETE FROM sequence_block');

    const payload = await buildBlockReport(db, { locationId: LOCATION });
    // This null IS the detection. The device must not invent a cursor here —
    // only the server holds the other half of the comparison.
    expect(payload.report).toBeNull();
    expect(payload.wantBlock).toBe(true);
  });

  it('rides the ordered outbox, not a side channel', async () => {
    const db = openTestDb();
    const hlc = fixedHlc();
    await withBlock(db, '1000', 500);
    await take(db);

    const key = await enqueueBlockReport(db, {
      locationId: LOCATION,
      claimedHlc: hlc.next(),
      nowIso: '2026-08-21T09:00:00.000Z',
    });
    const rows = await db.getAll('SELECT idempotency_key, kind, payload FROM outbox');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['idempotency_key']).toBe(key);
    expect(rows[0]!['kind']).toBe('sequence_block');
    // …and the outbox kind maps to the server's op discriminator.
    expect(wireKind('sequence_block')).toBe('sequence.sync_block');
  });
});

describe('adopting the server\'s answer', () => {
  it('adopts a replacement block after a regression, discarding the burned one', async () => {
    const db = openTestDb();
    await withBlock(db, '1000', 500);
    for (let i = 0; i < 5; i += 1) await take(db);

    const outcome = await applySyncBlockResult(
      db,
      JSON.stringify({ locationId: LOCATION, sequenceKey: 'RECEIPT' }),
      {
        status: 'regression',
        block: { blockStart: '1500', blockSize: 500, nextNumber: '1500' },
        format: FORMAT,
        review: { id: 'review-1', overlapFrom: '1000', overlapTo: '1004' },
      },
    );

    expect(outcome).toEqual({ adopted: true, regression: true, reviewId: 'review-1' });
    const block = await readCurrentBlock(db, LOCATION);
    expect(block!.blockStart).toBe(1500n);
    // The cursor restarts inside the NEW block — it does not carry over from a
    // block the server has destroyed.
    expect(block!.consumedUpto).toBeNull();
    expect((await take(db)).receiptNo).toBe('OUT-01-RCT-001500');

    // Exactly one LIVE block, locally as on the server. The burned one stays on
    // disk, closed: it is the record of which numbers were issued and which
    // were never used.
    const rows = await db.getAll('SELECT id FROM sequence_block WHERE exhausted_at IS NULL');
    expect(rows).toHaveLength(1);
    const all = await db.getAll('SELECT id FROM sequence_block');
    expect(all).toHaveLength(2);
  });

  it('a routine report about the SAME block leaves the cursor alone', async () => {
    const db = openTestDb();
    await withBlock(db, '1000', 500);
    for (let i = 0; i < 7; i += 1) await take(db);

    const outcome = await applySyncBlockResult(
      db,
      JSON.stringify({ locationId: LOCATION, sequenceKey: 'RECEIPT' }),
      {
        status: 'ok',
        block: { blockStart: '1000', blockSize: 500, nextNumber: '1007' },
        format: FORMAT,
        review: null,
      },
    );
    expect(outcome.adopted).toBe(false);
    expect((await readCurrentBlock(db, LOCATION))!.consumedUpto).toBe(1006n);
  });

  it('ignores an unparseable result rather than guessing at a block', async () => {
    const db = openTestDb();
    await withBlock(db, '1000', 500);
    for (const bad of [null, 'nope', {}, { status: 'ok', block: null, format: null }]) {
      const outcome = await applySyncBlockResult(
        db,
        JSON.stringify({ locationId: LOCATION }),
        bad,
      );
      expect(outcome.adopted).toBe(false);
    }
    expect((await readCurrentBlock(db, LOCATION))!.blockStart).toBe(1000n);
  });
});

describe('end to end through the drain', () => {
  it('a queued report is acked and its issued block becomes the one the counter uses', async () => {
    const db = openTestDb();
    const hlc = fixedHlc();
    await withBlock(db, '1000', 500);
    for (let i = 0; i < 3; i += 1) await take(db);
    // The wipe, after the device has already queued nothing: it reconnects
    // holding no block at all.
    await db.execute('DELETE FROM sequence_block');
    const key = await enqueueBlockReport(db, { locationId: LOCATION, claimedHlc: hlc.next() });

    const transport: UploadTransport = {
      async send(): Promise<UploadResult> {
        return {
          ok: true,
          status: 200,
          acks: [
            {
              key,
              status: 'applied',
              result: {
                status: 'regression',
                block: { blockStart: '1500', blockSize: 500, nextNumber: '1500' },
                format: FORMAT,
                review: { id: 'rev-9', overlapFrom: '1000', overlapTo: '1002' },
              },
            },
          ],
        };
      },
    };

    const seen: string[] = [];
    const report = await drainOutbox(db, transport, {
      onResult: sequenceResultHandler(db, (o) => seen.push(o.reviewId ?? '')),
    });

    expect(report.completed).toBe(1);
    expect(report.rejected).toBe(0);
    expect(seen).toEqual(['rev-9']); // the till is told, not just the server
    expect((await take(db)).receiptNo).toBe('OUT-01-RCT-001500');
  });

  it('a failed transport adopts nothing and keeps the report queued', async () => {
    const db = openTestDb();
    const hlc = fixedHlc();
    await enqueueBlockReport(db, { locationId: LOCATION, claimedHlc: hlc.next() });

    const transport: UploadTransport = {
      async send(): Promise<UploadResult> {
        return { ok: false, status: 0, acks: [] };
      },
    };
    const report = await drainOutbox(db, transport, { onResult: sequenceResultHandler(db) });

    expect(report.transportOk).toBe(false);
    expect(report.deferred).toBe(1);
    expect(await readCurrentBlock(db, LOCATION)).toBeNull();
    const pending = await db.getAll('SELECT id FROM outbox WHERE server_ack_at IS NULL');
    expect(pending).toHaveLength(1);
  });
});
