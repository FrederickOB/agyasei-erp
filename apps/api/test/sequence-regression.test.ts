/**
 * CLAUDE.md §2.7 category 2 (sync/conflict logic) and category 3 (tenant
 * boundary): the receipt-number regression mechanism, 03 §3.7.5 / conflict
 * class #14, on hermetic PGlite with RLS genuinely enforced.
 *
 * The failure being closed, restated because it is the sharpest edge in the
 * document: `consumed_upto` lives on the device. Wipe the device's local
 * database mid-block — OPFS eviction, a PWA reinstall on the same enrolled
 * device — and the cursor resets while the server still shows the block live.
 * The device then reissues numbers it has already printed, on a document type
 * that may be a statutory VAT invoice.
 *
 * Before this mechanism the collision surfaced as a raw
 * `duplicate key value violates unique constraint "sale_receipt_uq"`, which
 * the client's §3.3.4 taxonomy classes RETRYABLE — so the op retried forever,
 * the outbox never drained, and the till went dark for uploads while looking
 * merely "stuck". Both halves are tested here: the regression is DETECTED and
 * REPORTED before it can spread, and a collision that already happened LANDS
 * rather than jamming the queue.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSION_CODES, uuidv7 } from '@erp/db';
import { renderNumber } from '@erp/sequence';
import { signDevToken } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from './util.js';

let h: ApiHarness;
let app: FastifyInstance;
let tenantA: string;
let tenantB: string;
let outletA: { id: string; code: string };
let outletB: { id: string; code: string };
let productA: string;

/** One device: its own uuid, its own token, its own local cursor. */
class Device {
  consumedUpto: bigint | null = null;
  blockStart: bigint | null = null;
  blockSize = 0;
  format: { format: string; prefix: string; locationCode: string } | null = null;

  constructor(
    readonly deviceId: string,
    readonly tenantId: string,
    readonly locationId: string,
    readonly bearer: string,
  ) {}

  /** Wipe the local database. The server still shows the block live. */
  wipeLocalDb(): void {
    this.consumedUpto = null;
    this.blockStart = null;
    this.blockSize = 0;
    this.format = null;
  }

  /** Issue the next number locally — no network, like a real till. */
  issue(): string {
    if (this.blockStart === null || this.format === null) throw new Error('no block');
    const next = this.consumedUpto === null ? this.blockStart : this.consumedUpto + 1n;
    if (next > this.blockStart + BigInt(this.blockSize) - 1n) throw new Error('block spent');
    this.consumedUpto = next;
    return renderNumber(this.format, next);
  }

  async syncBlock(
    opts: { report?: 'auto' | null; wantBlock?: boolean } = {},
  ): Promise<Record<string, never> & SyncBlockAck> {
    const report =
      opts.report === null || this.blockStart === null
        ? null
        : { blockStart: this.blockStart.toString(10), consumedUpto: this.consumedUpto?.toString(10) ?? null };
    const res = await upload(this.bearer, [
      {
        idempotency_key: uuidv7(),
        kind: 'sequence.sync_block',
        payload: {
          locationId: this.locationId,
          sequenceKey: 'RECEIPT',
          report,
          wantBlock: opts.wantBlock ?? true,
        },
      },
    ]);
    const ack = res.acks[0]!;
    if (ack.status === 'rejected') throw new Error(`syncBlock rejected: ${ack.reason}`);
    const body = await readResponse(this.tenantId, ack.key);
    if (body.block !== null) {
      const issued = BigInt(body.block.blockStart);
      if (this.blockStart !== issued) {
        // A NEW block: the local cursor restarts inside it. Reporting on the
        // block it already holds must leave the cursor exactly where it is.
        this.blockStart = issued;
        this.blockSize = body.block.blockSize;
        this.consumedUpto = null;
      }
      this.format = body.format;
    }
    return body as never;
  }
}

interface SyncBlockAck {
  status: string;
  block: { blockStart: string; blockSize: number; blockEnd: string; nextNumber: string | null; remaining: string } | null;
  format: { format: string; prefix: string; locationCode: string } | null;
  burned: { blockStart: string; blockEnd: string; consumedUpto: string | null; burnedFrom: string; burnedTo: string; reason: string } | null;
  review: { id: string; conflictClass: string; severity: number; kind: string; overlapFrom: string; overlapTo: string } | null;
}

interface UploadOp {
  idempotency_key: string;
  kind: string;
  payload: Record<string, unknown>;
}

async function upload(bearer: string, ops: UploadOp[]) {
  const res = await app.inject({
    method: 'POST',
    url: '/sync/upload',
    headers: { authorization: `Bearer ${bearer}` },
    payload: { ops },
  });
  return res.json() as { acks: { key: string; status: string; reason?: string }[] };
}

/** The pipeline stores every response verbatim; read it back for assertions. */
async function readResponse(tenantId: string, key: string): Promise<SyncBlockAck> {
  const res = await h.db.asAdmin((tx) =>
    tx.query<{ response_body: SyncBlockAck }>(
      `select response_body from app.write_log where tenant_id = $1 and id = $2`,
      [tenantId, key],
    ),
  );
  return res.rows[0]!.response_body;
}

async function tokenFor(tenantId: string, locationId: string, deviceId: string): Promise<string> {
  return signDevToken(JWT_SECRET, {
    tid: tenantId,
    uid: uuidv7(),
    role: 'outlet_manager',
    locs: [locationId],
    dev: deviceId,
  });
}

async function blocksOf(tenantId: string, deviceId: string) {
  return h.db.withTenant(tenantId, async (tx) => {
    const r = await tx.query<{
      block_start: string;
      block_size: number;
      consumed_upto: string | null;
      exhausted_at: string | null;
      closed_reason: string | null;
    }>(
      `select block_start::text, block_size, consumed_upto::text, exhausted_at::text, closed_reason
         from app.sequence_block where device_id = $1
        order by app.sequence_block.block_start`,
      [deviceId],
    );
    return r.rows;
  });
}

async function reviewsOf(tenantId: string, conflictClass?: string) {
  return h.db.withTenant(tenantId, async (tx) => {
    const r = await tx.query<{
      id: string;
      conflict_class: string;
      severity: number;
      status: string;
      entity_table: string;
      field_path: string | null;
      pending_value: Record<string, string | null>;
      proposals: Record<string, string | null>[];
      required_permission: string;
    }>(
      `select id, conflict_class, severity, status, entity_table, field_path,
              pending_value, proposals, required_permission
         from app.conflict_review
        where ($1::text is null or conflict_class = $1)
        order by opened_at, id`,
      [conflictClass ?? null],
    );
    return r.rows;
  });
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('seq-a');
  tenantB = await h.provisionTenant('seq-b');
  await h.applyTemplate(tenantA);
  await h.applyTemplate(tenantB);
  outletA = await h.firstOutlet(tenantA);
  outletB = await h.firstOutlet(tenantB);
  const p = await h.pickProduct(tenantA);
  productA = p.id;
  await h.seedWholesalePrice(tenantA, productA, 25_000_000n);
  app = await buildServer({ deps: h.deps, jwtSecret: JWT_SECRET });
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

// ---------------------------------------------------------------------------

describe('block allocation (03 §3.7.5)', () => {
  it('the template seeds a counter per selling location — and only per selling location', async () => {
    const rows = await h.db.withTenant(tenantA, async (tx) => {
      const r = await tx.query<{ n: string; kinds: string }>(
        `select count(*)::text as n,
                string_agg(distinct l.kind, ',') as kinds
           from app.sequence_counter c
           join app.location l on l.tenant_id = c.tenant_id and l.id = c.location_id`,
      );
      return r.rows[0]!;
    });
    expect(Number(rows.n)).toBeGreaterThan(0);
    expect(rows.kinds).toBe('OUTLET'); // never a GROUP or TRANSIT node
  });

  it('issues a block, and the format is the TENANT\'s value — not a platform constant', async () => {
    const deviceId = uuidv7();
    const d = new Device(deviceId, tenantA, outletA.id, await tokenFor(tenantA, outletA.id, deviceId));
    const res = await d.syncBlock();

    expect(res.status).toBe('ok');
    expect(res.review).toBeNull();
    expect(res.block!.blockStart).toBe('1');
    expect(res.block!.nextNumber).toBe('1');
    expect(res.format!.format).toBe('{location_code}-{prefix}-{n:06d}');
    expect(res.format!.prefix).toBe('RCT');
    expect(res.format!.locationCode).toBe(outletA.code);
    // Rendered by the SHARED module, so the device prints what the server means.
    expect(renderNumber(res.format!, 1n)).toBe(`${outletA.code}-RCT-000001`);
  });

  it('two devices at one location never receive overlapping ranges', async () => {
    const [id1, id2] = [uuidv7(), uuidv7()];
    const d1 = new Device(id1, tenantA, outletA.id, await tokenFor(tenantA, outletA.id, id1));
    const d2 = new Device(id2, tenantA, outletA.id, await tokenFor(tenantA, outletA.id, id2));
    const [r1, r2] = [await d1.syncBlock(), await d2.syncBlock()];

    const s1 = BigInt(r1.block!.blockStart);
    const e1 = BigInt(r1.block!.blockEnd);
    const s2 = BigInt(r2.block!.blockStart);
    expect(s2).toBeGreaterThan(e1);
    expect(s1).not.toBe(s2);
  });

  it('a location with no counter row is REFUSED, never defaulted', async () => {
    // The numbering format is tenant data (ADR-0007). A platform default here
    // would be `if (country === 'GH')` wearing a different hat.
    const deviceId = uuidv7();
    const bearer = await tokenFor(tenantA, outletA.id, deviceId);
    const res = await upload(bearer, [
      {
        idempotency_key: uuidv7(),
        kind: 'sequence.sync_block',
        payload: { locationId: outletA.id, sequenceKey: 'INVOICE', report: null, wantBlock: true },
      },
    ]);
    expect(res.acks[0]!.status).toBe('rejected');
    expect(res.acks[0]!.reason).toMatch(/PRECONDITION_FAILED.*no INVOICE sequence counter/);
  });
});

describe('reporting consumed_upto', () => {
  it('raises the server high-water mark and opens nothing', async () => {
    const deviceId = uuidv7();
    const d = new Device(deviceId, tenantA, outletA.id, await tokenFor(tenantA, outletA.id, deviceId));
    await d.syncBlock();
    for (let i = 0; i < 5; i += 1) d.issue();

    const res = await d.syncBlock({ wantBlock: false });
    expect(res.status).toBe('ok');
    expect(res.review).toBeNull();
    expect(res.burned).toBeNull();

    const blocks = await blocksOf(tenantA, deviceId);
    expect(blocks).toHaveLength(1);
    expect(BigInt(blocks[0]!.consumed_upto!)).toBe(d.consumedUpto);
    expect(blocks[0]!.exhausted_at).toBeNull();
  });

  it('a block consumed to its last number closes as EXHAUSTED and a fresh one issues', async () => {
    const deviceId = uuidv7();
    const d = new Device(deviceId, tenantA, outletA.id, await tokenFor(tenantA, outletA.id, deviceId));
    const first = await d.syncBlock();
    const size = first.block!.blockSize;
    for (let i = 0; i < size; i += 1) d.issue();

    const res = await d.syncBlock();
    expect(res.status).toBe('ok'); // exhaustion is normal, not a conflict
    expect(res.review).toBeNull();
    expect(res.burned!.reason).toBe('EXHAUSTED');
    expect(BigInt(res.block!.blockStart)).toBe(BigInt(first.block!.blockEnd) + 1n);

    const blocks = await blocksOf(tenantA, deviceId);
    expect(blocks.map((b) => b.closed_reason)).toEqual(['EXHAUSTED', null]);
  });
});

// ---------------------------------------------------------------------------
// The §3.9 drill, at API level. The real-stack version is D6 in @erp/sync-drills.
// ---------------------------------------------------------------------------

describe('§3.9 drill — wipe a device\'s local DB mid-block, reissue', () => {
  it('detects the regression on reconnect, burns the block, reissues, and opens a SEVERITY-1 review naming the overlap range', async () => {
    const deviceId = uuidv7();
    const d = new Device(deviceId, tenantA, outletA.id, await tokenFor(tenantA, outletA.id, deviceId));
    const issued = await d.syncBlock();
    const blockStart = BigInt(issued.block!.blockStart);

    // Trade, reconnect, report: the server now knows how far this device got.
    for (let i = 0; i < 12; i += 1) d.issue();
    await d.syncBlock({ wantBlock: false });
    const serverSaw = d.consumedUpto!;
    expect(serverSaw).toBe(blockStart + 11n);

    // ---- OPFS evicted. The local database is gone; the block is still live
    // on the server, and the device has no idea it ever had one.
    d.wipeLocalDb();

    const res = await d.syncBlock();

    expect(res.status).toBe('regression');
    expect(res.review).not.toBeNull();
    expect(res.review!.severity).toBe(1);
    expect(res.review!.kind).toBe('LOST_CURSOR');
    // The overlap range is the honest statement of exposure: every number from
    // the block's start to the last one the server saw issued may now be
    // printed twice, because the wiped device restarts at block_start.
    expect(res.review!.overlapFrom).toBe(blockStart.toString(10));
    expect(res.review!.overlapTo).toBe(serverSaw.toString(10));

    // The remainder is burned — never reused, never returned, never reissued.
    expect(res.burned!.reason).toBe('REGRESSION_BURN');
    expect(BigInt(res.burned!.burnedFrom)).toBe(serverSaw + 1n);
    expect(BigInt(res.burned!.burnedTo)).toBe(BigInt(issued.block!.blockEnd));

    // A fresh block, strictly above everything the old one covered.
    expect(BigInt(res.block!.blockStart)).toBeGreaterThan(BigInt(issued.block!.blockEnd));
    expect(res.block!.nextNumber).toBe(res.block!.blockStart);

    const blocks = await blocksOf(tenantA, deviceId);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.closed_reason).toBe('REGRESSION_BURN');
    expect(blocks[1]!.exhausted_at).toBeNull(); // exactly one live block

    // The review is real, routed by PERMISSION, and names the numbers a human
    // has to chase.
    const reviews = await reviewsOf(tenantA, 'SEQUENCE_CONSUMED_UPTO_REGRESSION');
    const review = reviews.find((r) => r.id === res.review!.id)!;
    expect(review.severity).toBe(1);
    expect(review.status).toBe('open');
    expect(review.entity_table).toBe('app.sequence_block');
    expect(review.field_path).toBe('consumed_upto');
    // The CATALOGUED code (packages/db permissions.ts, migration 0005), not a
    // code this router minted for itself: a required_permission nobody can be
    // granted is a severity-1 queue nobody can read.
    expect(review.required_permission).toBe('sync.conflict.review');
    expect(PERMISSION_CODES).toContain(review.required_permission);
    expect(review.pending_value.overlapFrom).toBe(blockStart.toString(10));
    expect(review.pending_value.overlapTo).toBe(serverSaw.toString(10));
    // Both sides of the story, with provenance.
    expect(review.proposals.map((p) => p['party'])).toEqual(['server', 'device']);
    expect(review.proposals[0]!['consumedUpto']).toBe(serverSaw.toString(10));
    expect(review.proposals[1]!['consumedUpto']).toBeNull();

    // Scope is normalised, not a broadcast to all 25 outlets (§3.6.2).
    const scope = await h.db.withTenant(tenantA, async (tx) => {
      const r = await tx.query<{ location_id: string }>(
        `select location_id from app.conflict_review_location where review_id = $1`,
        [res.review!.id],
      );
      return r.rows.map((x) => x.location_id);
    });
    expect(scope).toEqual([outletA.id]);
  });

  it('the canonical case: same block, cursor rewound — overlap is (reported, recorded]', async () => {
    const deviceId = uuidv7();
    const d = new Device(deviceId, tenantA, outletA.id, await tokenFor(tenantA, outletA.id, deviceId));
    const issued = await d.syncBlock();
    const start = BigInt(issued.block!.blockStart);
    for (let i = 0; i < 20; i += 1) d.issue();
    await d.syncBlock({ wantBlock: false });

    // A partial restore: the device comes back believing it is 8 numbers back.
    d.consumedUpto = start + 11n;
    const res = await d.syncBlock();

    expect(res.review!.kind).toBe('CONSUMED_UPTO_REGRESSION');
    expect(res.review!.overlapFrom).toBe((start + 12n).toString(10));
    expect(res.review!.overlapTo).toBe((start + 19n).toString(10));
    expect(res.burned!.reason).toBe('REGRESSION_BURN');
  });

  it('a block this server never issued is a regression too (self-issued or stale)', async () => {
    const deviceId = uuidv7();
    const d = new Device(deviceId, tenantA, outletA.id, await tokenFor(tenantA, outletA.id, deviceId));
    d.blockStart = 900_000n;
    d.blockSize = 100;
    d.consumedUpto = 900_010n;

    const res = await d.syncBlock();
    expect(res.review!.kind).toBe('UNKNOWN_BLOCK');
    expect(res.review!.overlapFrom).toBe('900000');
    expect(res.review!.overlapTo).toBe('900010');
    expect(res.block).not.toBeNull(); // and it is handed a real block
  });

  it('a cursor outside the block\'s own range is a conflict, not a constraint crash', async () => {
    // Left ungurded this hits sequence_block_consumed_in_range as a raw error:
    // INTERNAL_SERVER_ERROR, retryable, outbox stalled — the very failure this
    // mechanism exists to remove.
    const deviceId = uuidv7();
    const d = new Device(deviceId, tenantA, outletA.id, await tokenFor(tenantA, outletA.id, deviceId));
    const issued = await d.syncBlock();
    const end = BigInt(issued.block!.blockEnd);

    d.consumedUpto = end + 25n; // numbers it was never given
    const res = await d.syncBlock();

    expect(res.status).toBe('regression');
    expect(res.review!.kind).toBe('UNKNOWN_BLOCK');
    expect(res.review!.overlapFrom).toBe((end + 1n).toString(10));
    expect(res.review!.overlapTo).toBe((end + 25n).toString(10));
    expect(res.burned!.reason).toBe('REGRESSION_BURN');
    // …and nothing invalid was stored.
    const blocks = await blocksOf(tenantA, deviceId);
    expect(blocks[0]!.consumed_upto).toBeNull();
  });

  it('re-reporting a burned block does not open a second review — a sev-1 queue must not be spammed', async () => {
    const deviceId = uuidv7();
    const d = new Device(deviceId, tenantA, outletA.id, await tokenFor(tenantA, outletA.id, deviceId));
    const issued = await d.syncBlock();
    for (let i = 0; i < 3; i += 1) d.issue();
    await d.syncBlock({ wantBlock: false });

    d.wipeLocalDb();
    await d.syncBlock();
    const after = await reviewsOf(tenantA, 'SEQUENCE_CONSUMED_UPTO_REGRESSION');

    // The device stubbornly reports the burned block again.
    d.blockStart = BigInt(issued.block!.blockStart);
    d.blockSize = issued.block!.blockSize;
    d.consumedUpto = null;
    const again = await d.syncBlock({ wantBlock: false });
    expect(again.status).toBe('ok');
    expect(again.review).toBeNull();
    expect(await reviewsOf(tenantA, 'SEQUENCE_CONSUMED_UPTO_REGRESSION')).toHaveLength(after.length);
  });

  it('is idempotent: a replayed report burns no second block and opens no second review', async () => {
    const deviceId = uuidv7();
    const bearer = await tokenFor(tenantA, outletA.id, deviceId);
    const d = new Device(deviceId, tenantA, outletA.id, bearer);
    await d.syncBlock();
    for (let i = 0; i < 4; i += 1) d.issue();
    await d.syncBlock({ wantBlock: false });

    const key = uuidv7();
    const op: UploadOp = {
      idempotency_key: key,
      kind: 'sequence.sync_block',
      payload: { locationId: outletA.id, sequenceKey: 'RECEIPT', report: null, wantBlock: true },
    };
    const first = await upload(bearer, [op]);
    expect(first.acks[0]!.status).toBe('applied');
    const blocksAfterFirst = await blocksOf(tenantA, deviceId);
    const reviewsAfterFirst = await reviewsOf(tenantA);

    const replay = await upload(bearer, [op]);
    expect(replay.acks[0]!.status).toBe('duplicate');
    expect(await blocksOf(tenantA, deviceId)).toEqual(blocksAfterFirst);
    expect((await reviewsOf(tenantA)).length).toBe(reviewsAfterFirst.length);
  });
});

describe('the database refuses a regression structurally', () => {
  it('consumed_upto cannot be lowered, even by a direct UPDATE', async () => {
    const deviceId = uuidv7();
    const d = new Device(deviceId, tenantA, outletA.id, await tokenFor(tenantA, outletA.id, deviceId));
    await d.syncBlock();
    for (let i = 0; i < 6; i += 1) d.issue();
    await d.syncBlock({ wantBlock: false });

    await expect(
      h.db.withTenant(tenantA, (tx) =>
        tx.query(`update app.sequence_block set consumed_upto = block_start where device_id = $1`, [
          deviceId,
        ]),
      ),
    ).rejects.toThrow(/cannot regress/i);

    await expect(
      h.db.withTenant(tenantA, (tx) =>
        tx.query(`update app.sequence_block set consumed_upto = null where device_id = $1`, [deviceId]),
      ),
    ).rejects.toThrow(/cannot regress/i);
  });

  it('a closed block never reopens, and a range is immutable once issued', async () => {
    const deviceId = uuidv7();
    const d = new Device(deviceId, tenantA, outletA.id, await tokenFor(tenantA, outletA.id, deviceId));
    await d.syncBlock();
    d.issue();
    await d.syncBlock({ wantBlock: false });
    d.wipeLocalDb();
    await d.syncBlock();

    await expect(
      h.db.withTenant(tenantA, (tx) =>
        tx.query(
          `update app.sequence_block set exhausted_at = null, closed_reason = null
            where device_id = $1 and exhausted_at is not null`,
          [deviceId],
        ),
      ),
    ).rejects.toThrow(/never reopens/i);

    await expect(
      h.db.withTenant(tenantA, (tx) =>
        tx.query(`update app.sequence_block set block_start = block_start + 1 where device_id = $1`, [
          deviceId,
        ]),
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it('the allocation counter never rewinds', async () => {
    await expect(
      h.db.withTenant(tenantA, (tx) =>
        tx.query(`update app.sequence_counter set next_start = 1 where sequence_key = 'RECEIPT'`),
      ),
    ).rejects.toThrow(/cannot rewind/i);
  });
});

// ---------------------------------------------------------------------------
// The landing path: a collision that already happened must not jam the queue.
// ---------------------------------------------------------------------------

describe('receipt-number collision on upload (the till must not go dark)', () => {
  const receiptNo = 'COLLIDE-RCT-000042';
  let firstSaleId: string;
  let deviceId: string;
  let bearer: string;

  function saleOp(key: string): UploadOp {
    return {
      idempotency_key: key,
      kind: 'sale.create',
      payload: {
        locationId: outletA.id,
        priceListCode: 'WHOLESALE',
        receiptNo,
        businessDate: '2026-08-15',
        tender: 'CASH',
        lines: [{ productId: productA, qty: '5' }],
      },
    };
  }

  it('the second sale LANDS — acked applied, never rejected, never lost', async () => {
    deviceId = uuidv7();
    bearer = await tokenFor(tenantA, outletA.id, deviceId);

    const first = await upload(bearer, [saleOp(uuidv7())]);
    expect(first.acks[0]!.status).toBe('applied');
    firstSaleId = (await readResponse(tenantA, first.acks[0]!.key) as unknown as { saleId: string })
      .saleId;

    // The same number again, from the same wiped device, under a NEW key —
    // this is a different sale, not a retry.
    const second = await upload(bearer, [saleOp(uuidv7())]);
    expect(second.acks[0]!.status).toBe('applied');
    expect(second.acks[0]!.reason).toBeUndefined();

    // Specifically NOT the old behaviour, which is what jammed the outbox.
    expect(JSON.stringify(second.acks)).not.toMatch(/sale_receipt_uq|INTERNAL_SERVER_ERROR/);

    const body = (await readResponse(tenantA, second.acks[0]!.key)) as unknown as {
      saleId: string;
      receiptNo: string;
      receiptNoClaimed: string | null;
      receiptCollisionWithSaleId: string | null;
    };
    // Recorded under §3.7.5's emergency form, with the PRINTED number kept.
    expect(body.receiptNo).not.toBe(receiptNo);
    expect(body.receiptNo.startsWith(`${receiptNo}-`)).toBe(true);
    expect(body.receiptNoClaimed).toBe(receiptNo);
    expect(body.receiptCollisionWithSaleId).toBe(firstSaleId);

    const rows = await h.db.withTenant(tenantA, async (tx) => {
      const r = await tx.query<{ id: string; receipt_no: string; receipt_no_claimed: string | null }>(
        `select id, receipt_no, receipt_no_claimed from app.sale
          where receipt_no = $1 or receipt_no_claimed = $1 order by receipt_no`,
        [receiptNo],
      );
      return r.rows;
    });
    // Two sales, two distinct stored numbers, both findable by what was printed.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.receipt_no)).size).toBe(2);
  });

  it('and a severity-1 review names both documents', async () => {
    const reviews = await reviewsOf(tenantA, 'RECEIPT_NUMBER_COLLISION');
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    expect(review.severity).toBe(1);
    expect(review.entity_table).toBe('app.sale');
    expect(review.field_path).toBe('receipt_no');
    expect(review.pending_value['receiptNoPrinted']).toBe(receiptNo);
    expect(review.proposals[0]!['saleId']).toBe(firstSaleId);
    expect(review.proposals[1]!['receiptNoPrinted']).toBe(receiptNo);
    // Money inside jsonb is a decimal STRING, never a JSON number (ADR-0004).
    expect(typeof review.pending_value['totalMinor']).toBe('string');
  });

  it('a THIRD sale on the same number still lands, distinctly', async () => {
    const third = await upload(bearer, [saleOp(uuidv7())]);
    expect(third.acks[0]!.status).toBe('applied');
    const rows = await h.db.withTenant(tenantA, async (tx) => {
      const r = await tx.query<{ receipt_no: string }>(
        `select receipt_no from app.sale where receipt_no = $1 or receipt_no_claimed = $1`,
        [receiptNo],
      );
      return r.rows.map((x) => x.receipt_no);
    });
    // Three sales, three distinct stored numbers — the emergency form does not
    // collide with itself, which would stall the queue exactly as before.
    expect(rows).toHaveLength(3);
    expect(new Set(rows).size).toBe(3);
  });

  it('even when a device rings the same number twice, both land distinctly', async () => {
    // Same device, same printed number, back to back: the emergency suffix is
    // device-derived, so only the per-sale discriminator separates these two.
    const before = await h.db.withTenant(tenantA, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.sale where receipt_no like $1`,
        [`${receiptNo}%`],
      );
      return Number(r.rows[0]!.n);
    });
    const batch = await upload(bearer, [saleOp(uuidv7()), saleOp(uuidv7())]);
    expect(batch.acks.map((a) => a.status)).toEqual(['applied', 'applied']);
    const after = await h.db.withTenant(tenantA, async (tx) => {
      const r = await tx.query<{ receipt_no: string }>(
        `select receipt_no from app.sale where receipt_no like $1`,
        [`${receiptNo}%`],
      );
      return r.rows.map((x) => x.receipt_no);
    });
    expect(after).toHaveLength(before + 2);
    expect(new Set(after).size).toBe(after.length);
  });
});

// ---------------------------------------------------------------------------
// CLAUDE.md §2.7 category 3 — every new read path proves the boundary holds.
// ---------------------------------------------------------------------------

describe('tenant isolation across the new read paths', () => {
  it('tenant B sees none of tenant A\'s counters, blocks or reviews', async () => {
    const deviceId = uuidv7();
    const dB = new Device(deviceId, tenantB, outletB.id, await tokenFor(tenantB, outletB.id, deviceId));
    await dB.syncBlock();

    const seen = await h.db.withTenant(tenantB, async (tx) => {
      const counters = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.sequence_counter where location_id = $1`,
        [outletA.id],
      );
      const blocks = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.sequence_block where location_id = $1`,
        [outletA.id],
      );
      const reviews = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.conflict_review
          where conflict_class in ('SEQUENCE_CONSUMED_UPTO_REGRESSION','RECEIPT_NUMBER_COLLISION')`,
      );
      const scope = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.conflict_review_location where location_id = $1`,
        [outletA.id],
      );
      return [counters, blocks, reviews, scope].map((r) => Number(r.rows[0]!.n));
    });
    // Tenant A demonstrably HAS all four (non-vacuous), and tenant B sees zero.
    const aHas = await h.db.withTenant(tenantA, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.sequence_block where location_id = $1`,
        [outletA.id],
      );
      return Number(r.rows[0]!.n);
    });
    expect(aHas).toBeGreaterThan(0);
    expect(seen).toEqual([0, 0, 0, 0]);
  });

  it('tenant B\'s own numbering starts from ITS counter, not A\'s', async () => {
    const rows = await h.db.withTenant(tenantB, async (tx) => {
      const r = await tx.query<{ block_start: string }>(
        `select block_start::text from app.sequence_block order by app.sequence_block.block_start`,
      );
      return r.rows;
    });
    expect(rows[0]!.block_start).toBe('1');
  });

  it('a token scoped to tenant A cannot allocate at tenant B\'s location', async () => {
    const deviceId = uuidv7();
    const bearerA = await tokenFor(tenantA, outletA.id, deviceId);
    const res = await upload(bearerA, [
      {
        idempotency_key: uuidv7(),
        kind: 'sequence.sync_block',
        payload: { locationId: outletB.id, sequenceKey: 'RECEIPT', report: null, wantBlock: true },
      },
    ]);
    expect(res.acks[0]!.status).toBe('rejected');
    expect(res.acks[0]!.reason).toMatch(/FORBIDDEN/);
  });
});
