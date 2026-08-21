/**
 * The write pipeline's clock discipline (03 §3.4.1; CLAUDE.md §2.2).
 *
 * The device's own HLC assertion is STORED — write_log.claimed_hlc,
 * untrusted, forensics only — but it never orders anything: the hlc column
 * is stamped by the SERVER's monotonic clock at ingest, so two writes whose
 * device clocks disagree wildly still land in ingest order. A claim whose
 * wall component is more than ±24h from server time is refused RETRYABLY
 * at the boundary, before it can enter anything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hlcNodeFromName, uuidv7 } from '@erp/db';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantId: string;
let outletId: string;
let productId: string;
let caller: ReturnType<ApiHarness['callerFor']>;

/** The server clock node the test harness stamps with (see util.ts). */
const SERVER_NODE = hlcNodeFromName('api-test-node');
/** A device node id, deliberately different from the server's. */
const DEVICE_NODE = 'ab'.repeat(16);

function claimedHlcAt(wallMs: number, counter = 0): string {
  return `${String(wallMs).padStart(13, '0')}-${String(counter).padStart(5, '0')}-${DEVICE_NODE}`;
}

interface WriteLogRow {
  id: string;
  hlc: string;
  claimed_hlc: string | null;
  origin: string;
}

async function writeLogRow(key: string): Promise<WriteLogRow> {
  const res = await h.db.asAdmin((tx) =>
    tx.query<WriteLogRow>(
      `select id, hlc, claimed_hlc, origin from app.write_log where tenant_id = $1 and id = $2`,
      [tenantId, key],
    ),
  );
  expect(res.rows).toHaveLength(1);
  return res.rows[0]!;
}

function movement(key: string, claimedHlc?: string) {
  return {
    idempotencyKey: key,
    ...(claimedHlc !== undefined ? { claimedHlc } : {}),
    locationId: outletId,
    productId,
    qtyDelta: '10',
    sourceKind: 'RECEIPT' as const,
    reasonCode: 'OPENING',
    businessDate: '2026-08-15',
  };
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('pipe-t');
  await h.applyTemplate(tenantId);
  const outlet = await h.firstOutlet(tenantId);
  outletId = outlet.id;
  productId = (await h.pickProduct(tenantId)).id;
  caller = h.callerFor(await h.identityFor(tenantId, { locs: [outletId] }));
}, 180_000);

afterAll(async () => {
  await h.close();
});

describe('claimed_hlc is stored verbatim but never orders anything', () => {
  it('two writes with REVERSED device clocks land in ingest order under the server HLC', async () => {
    const now = Date.now();
    const key1 = uuidv7();
    const key2 = uuidv7();
    // The FIRST write claims the LATER device time; the second claims a
    // minute earlier. If claimed time ordered anything, they would invert.
    const claim1 = claimedHlcAt(now);
    const claim2 = claimedHlcAt(now - 60_000);

    const m1 = await caller.inventory.recordMovement(movement(key1, claim1));
    const m2 = await caller.inventory.recordMovement(movement(key2, claim2));

    const row1 = await writeLogRow(key1);
    const row2 = await writeLogRow(key2);

    // Stored verbatim: the device's assertion survives for forensics…
    expect(row1.claimed_hlc).toBe(claim1);
    expect(row2.claimed_hlc).toBe(claim2);
    // …and the claimed order really is reversed relative to ingest order.
    expect(row2.claimed_hlc! < row1.claimed_hlc!).toBe(true);

    // The ORDERING column is the server's stamp: its node id is the server
    // clock's, not the device's, and it is monotonic in ingest order —
    // lexicographic byte order IS causal order (04 §4.2.1).
    for (const row of [row1, row2]) {
      expect(row.hlc.slice(-32)).toBe(SERVER_NODE);
      expect(row.hlc.slice(-32)).not.toBe(DEVICE_NODE);
      expect(row.hlc).not.toBe(row.claimed_hlc);
    }
    expect(row1.hlc < row2.hlc).toBe(true);

    // And the business rows replay in server order too: the movement
    // ledger's replay index orders by hlc, which yields ingest order.
    const replay = await h.db.withTenant(tenantId, (tx) =>
      tx.query<{ id: string }>(
        `select id from app.stock_movement
         where location_id = $1 and product_id = $2 and id in ($3, $4)
         order by hlc`,
        [outletId, productId, m1.movementId, m2.movementId],
      ),
    );
    expect(replay.rows.map((r) => r.id)).toEqual([m1.movementId, m2.movementId]);
  });

  it('a write WITHOUT a claim is accepted and stores claimed_hlc as NULL', async () => {
    const key = uuidv7();
    await caller.inventory.recordMovement(movement(key));
    const row = await writeLogRow(key);
    expect(row.claimed_hlc).toBeNull();
    expect(row.origin).toBe('DEVICE');
    expect(row.hlc.slice(-32)).toBe(SERVER_NODE);
  });

  it('a claim beyond ±24h skew is refused retryably, BEFORE anything is written', async () => {
    const key = uuidv7();
    const before = await caller.inventory.onHand({ locationId: outletId, productId });

    await expect(
      caller.inventory.recordMovement(movement(key, claimedHlcAt(Date.now() - 25 * 3_600_000))),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('CLOCK_RESYNC_REQUIRED'),
    });

    // Nothing entered: no marker, no movement, on-hand unchanged. The device
    // resyncs its clock and resends the SAME queued mutation — a fresh
    // attempt, because nothing was applied.
    const marker = await h.db.asAdmin((tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from app.write_log where tenant_id = $1 and id = $2`,
        [tenantId, key],
      ),
    );
    expect(marker.rows[0]!.n).toBe('0');
    const after = await caller.inventory.onHand({ locationId: outletId, productId });
    expect(after.qtyOnHand).toBe(before.qtyOnHand);

    // After the "resync", the same key goes through cleanly.
    await caller.inventory.recordMovement(movement(key, claimedHlcAt(Date.now())));
    const row = await writeLogRow(key);
    expect(row.hlc.slice(-32)).toBe(SERVER_NODE);
  });
});
