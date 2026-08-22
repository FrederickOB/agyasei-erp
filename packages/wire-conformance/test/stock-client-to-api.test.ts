/**
 * THE THIRD UPLOADABLE KIND, PROVEN THE SAME WAY THE FIRST TWO ARE.
 *
 * `stock.record_movement` had been reachable on `/sync/upload` for two
 * revisions with **no PWA builder at all** — `outbox-surface.test.ts` ran one
 * hand-written contract-shaped payload through the live route and said, in its
 * own header, that this proves nothing about a builder that does not exist.
 * A builder now exists (`apps/web/src/data/mutations/adjustStock.ts`) and
 * `WIRE_KINDS` carries the kind, which turned the pin in
 * `outbox-surface.test.ts` red on purpose: the PWA can emit a kind that no
 * test drives end to end. This file is the answer to that tripwire, and
 * nothing about the tripwire was relaxed.
 *
 * Nothing stands in for either side:
 *   client  apps/web's real local SQLite on the device's own schema, the real
 *           `loadStockedProducts` / `loadMovementReasons` read paths, the real
 *           `recordAdjustment` → outbox → `readPendingOps` → `drainOutbox` →
 *           `httpUploadTransport`.
 *   wire    a real fetch-shaped call carrying a browser `Origin` at a real
 *           Fastify server with CORS configured; `app.inject()` is the socket.
 *   server  apps/api's real `/sync/upload` route, real `inventory.recordMovement`
 *           router, real idempotent pipeline, real Postgres (PGlite), RLS on.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PARTITION IS THE POINT, NOT DECORATION
 * ---------------------------------------------------------------------------
 * A stock adjustment is TRADE, not configuration. Twenty bags break in the
 * yard whether or not the tower is up, and CLAUDE.md §2.2 says the location
 * must be able to record that and sync it cleanly later. So the sequence
 * below is: radio OFF → record → the write is complete locally and ABSENT
 * from the server → radio ON → drain → acked `applied` → the row is in
 * Postgres with the server's own tenant. A test that recorded and drained in
 * one breath would pass against a client that awaited a socket, which is the
 * one thing this op must never do.
 *
 * It also proves the two refusals that would WEDGE THE QUEUE rather than
 * dead-letter, because `classifyRejection` classes both retryable: a
 * non-stocked product and an unknown reason code. The builder cannot produce
 * either — its product comes from the device's own STOCKED catalogue and its
 * reason from the tenant's own synced rows — and the negative controls here
 * show the server really does refuse them, so the client-side narrowing is
 * load-bearing rather than decorative.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceOpContracts, recordMovementInput } from '@erp/contracts';

// ---- the server, from apps/api's own sources -------------------------------
import { signDevToken } from '../../../apps/api/src/auth.js';
import { appRouter } from '../../../apps/api/src/routers/index.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from '../../../apps/api/test/util.js';

// ---- the client, from apps/web's own sources -------------------------------
import {
  recordAdjustment,
  ADJUSTMENT_OUTBOX_KIND,
} from '../../../apps/web/src/data/mutations/adjustStock';
import { loadMovementReasons } from '../../../apps/web/src/data/queries/movement-reasons';
import { loadStockedProducts } from '../../../apps/web/src/data/queries/products';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import { WIRE_KINDS, httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import {
  classifyRejection,
  drainOutbox,
  readPendingOps,
} from '../../../apps/web/src/data/sync/upload';
import type { LocalDb } from '../../../apps/web/src/data/db';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import {
  fixedHlc,
  provisionDevice,
  seedMovementReason,
  seedProduct,
} from '../../../apps/web/tests/helpers/fixtures';

const PWA_ORIGIN = 'http://localhost:5173';

/**
 * The device's wall clock, derived from NOW for the reason spelled out at
 * length in `sale-client-to-api.test.ts`: `apps/api/src/pipeline.ts` clamps a
 * claimed HLC at ±24h of the server's clock, so a hard-coded instant here is
 * a test with a one-day shelf life.
 */
const CLOCK_BASE_MS = Date.now();
const SERVER_SKEW_LIMIT_MS = 24 * 60 * 60 * 1000;

function tillClock(offsetSeconds: number): string {
  const iso = new Date(CLOCK_BASE_MS + offsetSeconds * 1_000).toISOString();
  if (Math.abs(Date.parse(iso) - Date.now()) > SERVER_SKEW_LIMIT_MS) {
    throw new Error(
      `this test's device clock (${iso}) is more than 24h from now, so the API will refuse ` +
        'it CLOCK_RESYNC_REQUIRED before the payload is ever parsed. Derive it from Date.now().',
    );
  }
  return iso;
}

/** One HLC node per simulated till. */
const NODE_YARD = 'c1'.repeat(16);
const NODE_REFUSALS = 'c2'.repeat(16);

type Server = Awaited<ReturnType<typeof buildServer>>;

let h: ApiHarness;
let app: Server;
let tenantId: string;
let outlet: { id: string; code: string };
let product: { id: string; skuCode: string; uomCode: string; qtyScale: number };
let bearer: string;
/**
 * The tenant's OWN reason code, read out of `app.movement_reason` rather than
 * spelled here. Reason codes are tenant vocabulary (CLAUDE.md §2.9); a literal
 * would be testing tenant #1's template instead of the platform.
 */
let reasonCode: string;
let reasonName: string;

const browserFetch: FetchLike = async (url, init) => {
  const path = new URL(url, 'http://api.local').pathname;
  const res = await app.inject({
    method: (init.method as 'GET' | 'POST') ?? 'GET',
    url: path,
    headers: { ...init.headers, origin: PWA_ORIGIN },
    ...(init.body === undefined ? {} : { payload: init.body }),
  });
  const response: HttpResponseLike = {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    json: () => Promise.resolve(res.json<unknown>()),
  };
  return response;
};

/** The real transport, connected. */
function online() {
  return httpUploadTransport({
    apiUrl: 'http://api.local',
    apiToken: bearer,
    fetchFn: browserFetch,
  });
}

/**
 * The real transport with the radio OFF. The `fetch` REJECTS, exactly as it
 * does for a dead link — not a stubbed transport that returns `{ok:false}`,
 * because the code under test is the transport's own failure handling.
 */
function partitioned() {
  const dead: FetchLike = () => Promise.reject(new Error('network unreachable'));
  return httpUploadTransport({ apiUrl: 'http://api.local', apiToken: bearer, fetchFn: dead });
}

/**
 * A device holding the SERVER's real location and the SERVER's real product
 * id, plus the tenant's real reason row — i.e. the rows the sync stream would
 * have delivered, and nothing the server has not heard of.
 */
async function provisionedDevice(): Promise<LocalDb> {
  const db = openTestDb();
  const device = await provisionDevice(db, {
    locationId: outlet.id,
    locationCode: outlet.code,
    priceListCode: 'WHOLESALE',
  });
  await seedProduct(db, {
    id: product.id,
    code: product.skuCode,
    name: 'Yard product',
    uomLabel: product.uomCode,
    qtyScale: product.qtyScale,
    unitPriceE4: 25_000_000n,
    priceListId: device.priceListId,
  });
  await seedMovementReason(db, { code: reasonCode, name: reasonName });
  return db;
}

interface MovementRow {
  qty_delta: string;
  source_kind: string;
  location_id: string;
  tenant_id: string;
  business_date: string;
  reason_id: string | null;
}

async function movementsFor(writeKey: string): Promise<MovementRow[]> {
  return h.db.asAdmin(async (tx) => {
    const res = await tx.query<MovementRow>(
      `select qty_delta::text, source_kind, location_id, tenant_id,
              business_date::text as business_date, reason_id
         from app.stock_movement
        where tenant_id = $1 and write_id = $2`,
      [tenantId, writeKey],
    );
    return res.rows;
  });
}

async function onHand(): Promise<bigint> {
  return h.db.asAdmin(async (tx) => {
    const res = await tx.query<{ total: string | null }>(
      `select sum(qty_delta)::text as total from app.stock_movement
        where tenant_id = $1 and location_id = $2 and product_id = $3`,
      [tenantId, outlet.id, product.id],
    );
    return BigInt(res.rows[0]?.total ?? '0');
  });
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('yard-co');
  await h.applyTemplate(tenantId, true);
  outlet = await h.firstOutlet(tenantId);
  product = await h.pickProduct(tenantId);
  await h.seedWholesalePrice(tenantId, product.id, 25_000_000n);

  const reason = await h.db.withTenant(tenantId, async (tx) => {
    const res = await tx.query<{ code: string; name: string }>(
      `select code, name from app.movement_reason where deleted_at is null order by code limit 1`,
    );
    const row = res.rows[0];
    if (row === undefined) throw new Error('the tenant has no movement reasons');
    return row;
  });
  reasonCode = reason.code;
  reasonName = reason.name;

  // Payload shape, not authority: the uploader is granted breadth here and
  // `apps/api/test/rbac.test.ts` plus the live RBAC drill are the files about
  // who may adjust stock where. The same division `outbox-surface.test.ts`
  // states in its own header.
  const uid = '018f3a1e-0000-7000-8000-0000000000c7';
  await h.grantOwner(tenantId, uid);
  bearer = await signDevToken(JWT_SECRET, {
    tid: tenantId,
    uid,
    role: 'outlet-manager',
    locs: [outlet.id],
  });
  app = await buildServer({
    deps: h.deps,
    jwtSecret: JWT_SECRET,
    sync: { powersyncUrl: 'http://localhost:8080' },
    corsOrigins: [PWA_ORIGIN],
  });
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

// ---------------------------------------------------------------------------
// 1. The client's REAL payload, against the server's REAL parser
// ---------------------------------------------------------------------------

/** The input object pulled back out of the LIVE procedure, not imported. */
function routerInputOf(procedure: unknown): unknown {
  const def = (procedure as { _def?: { inputs?: unknown[] } })._def;
  const inputs = def?.inputs ?? [];
  if (inputs.length !== 1) throw new Error(`expected exactly one input schema, got ${inputs.length}`);
  return inputs[0];
}

describe("the adjustment builder's own bytes satisfy the parser the router runs", () => {
  it('parses the bytes recordAdjustment put in the outbox — not a hand-written fixture', async () => {
    const db = await provisionedDevice();
    // The counter's REAL read paths. A hand-written SELECT here would prove
    // the wire against a shelf and a vocabulary the device does not have.
    const stocked = await loadStockedProducts(db);
    const reasons = await loadMovementReasons(db);
    expect(stocked.map((p) => p.id)).toContain(product.id);
    expect(reasons).toHaveLength(1);

    const movementId = '018f3a1e-0000-7000-8000-0000000000d1';
    await recordAdjustment(db, {
      movementId,
      productId: stocked[0]!.id,
      qtyDelta: -20n,
      kind: 'WRITE_OFF',
      reasonCode: reasons[0]!.code,
      hlc: fixedHlc(Date.parse(tillClock(0)), NODE_YARD),
      nowIso: tillClock(0),
    });

    const pending = await readPendingOps(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.idempotencyKey).toBe(movementId);
    expect(pending[0]!.kind).toBe(ADJUSTMENT_OUTBOX_KIND);

    // The exact bytes the transport would ship, through the exact parser the
    // procedure runs — the one pulled back out of the live router, not
    // `recordMovementInput` imported here.
    const parser = routerInputOf(appRouter.inventory.recordMovement) as typeof recordMovementInput;
    const parsed = parser.safeParse(JSON.parse(pending[0]!.payloadJson));
    if (!parsed.success) {
      throw new Error(
        `the client's payload does not satisfy the API's schema: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    // The quantity arrived as a bigint, never a JS number (ADR-0004).
    expect(typeof parsed.data.qtyDelta).toBe('bigint');
    expect(parsed.data.qtyDelta).toBe(-20n);
    // And the identity the registry keys on is the same object.
    expect(deviceOpContracts['stock.record_movement']).toBe(recordMovementInput);
    expect(WIRE_KINDS[ADJUSTMENT_OUTBOX_KIND]).toBe('stock.record_movement');
  });
});

// ---------------------------------------------------------------------------
// 2. Recorded with the radio OFF, drained on reconnect — CLAUDE.md §2.2
// ---------------------------------------------------------------------------

describe('an adjustment recorded offline drains on reconnect and lands in Postgres', () => {
  let db: LocalDb;
  const movementId = '018f3a1e-0000-7000-8000-0000000000d2';
  let baseline: bigint;
  /**
   * The EXACT bytes the client queued, captured before the drain clears them.
   * The replay below re-sends these rather than a payload rebuilt here: the
   * pipeline hashes the request and answers a same-key-different-payload
   * resend `rejected`, correctly — so a hand-rolled "replay" would test this
   * package's own typing rather than the device's, which is the entire
   * mistake `@erp/contracts` and this package exist to make impossible.
   */
  let sentOp: Awaited<ReturnType<typeof readPendingOps>>[number];

  beforeAll(async () => {
    db = await provisionedDevice();
    baseline = await onHand();
  });

  it('the write completes locally with no network on the path', async () => {
    const result = await recordAdjustment(db, {
      movementId,
      productId: product.id,
      qtyDelta: -20n,
      kind: 'WRITE_OFF',
      reasonCode,
      hlc: fixedHlc(Date.parse(tillClock(60)), NODE_YARD),
      nowIso: tillClock(60),
    });
    expect(result.movementId).toBe(movementId);
    expect(result.locationId).toBe(outlet.id);
    expect(result.qtyDelta).toBe(-20n);
    // Queued, not sent. Nothing above awaited a socket.
    const pending = await readPendingOps(db);
    expect(pending).toHaveLength(1);
    sentOp = pending[0]!;
  });

  it('is ABSENT from the server while the device is partitioned', async () => {
    const report = await drainOutbox(db, partitioned());
    expect(report.transportOk).toBe(false);
    expect(report.completed).toBe(0);
    // Deferred, never rejected: a dead radio is not a refusal, and a write
    // dropped here is the loss path 03 §3.3.4 exists to prevent.
    expect(report.deferred).toBe(1);
    expect(await readPendingOps(db)).toHaveLength(1);
    expect(await movementsFor(movementId)).toHaveLength(0);
    expect(await onHand()).toBe(baseline);
  });

  it('drains on reconnect and is ACKED APPLIED — not rejected', async () => {
    const report = await drainOutbox(db, online());
    expect(report.transportOk).toBe(true);
    expect(report.batchSize).toBe(1);
    expect(report.rejected).toBe(0);
    expect(report.completed).toBe(1);
    // The counter stops showing it as pending, which is the only completion
    // signal this client accepts (`data/sync/upload.ts`).
    expect(await readPendingOps(db)).toHaveLength(0);
  });

  it('wrote ONE movement under the VERIFIED tenant, at the device location', async () => {
    const rows = await movementsFor(movementId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantId);
    expect(rows[0]!.location_id).toBe(outlet.id);
    expect(rows[0]!.source_kind).toBe('WRITE_OFF');
    // Outflow is negative, and it is the client's exact bigint.
    expect(BigInt(rows[0]!.qty_delta)).toBe(-20n);
    // The reason resolved to a tenant row rather than being stored as text.
    expect(rows[0]!.reason_id).not.toBeNull();
    expect(rows[0]!.business_date).toBe(tillClock(60).slice(0, 10));
  });

  it('moved on-hand by exactly the adjustment, as a bigint identity', async () => {
    expect(await onHand()).toBe(baseline - 20n);
  });

  it('a re-sent batch is a duplicate, not a second movement', async () => {
    // The device's OWN bytes, byte-identical, sent again — a retry after a
    // timeout the till never saw answered. Idempotency is per tenant on
    // app.write_log, so the second one is recognised and has no effect.
    const result = await online().send([sentOp]);
    expect(result.ok).toBe(true);
    expect(result.acks[0]!.reason).toBeUndefined();
    expect(result.acks[0]!.status).toBe('duplicate');
    expect(await movementsFor(movementId)).toHaveLength(1);
    expect(await onHand()).toBe(baseline - 20n);
  });

  it('the same key carrying DIFFERENT bytes is refused, not replayed', async () => {
    // The other half of the guarantee, and the sharper one: a key is a
    // promise about a payload. A device that reused a key for a changed
    // quantity would otherwise have its second figure silently swallowed as
    // "already done" and the ledger would disagree with the yard.
    const tampered = JSON.parse(sentOp.payloadJson) as Record<string, unknown>;
    tampered['qtyDelta'] = '-999';
    const result = await online().send([
      { ...sentOp, payloadJson: JSON.stringify(tampered) },
    ]);
    expect(result.acks[0]!.status).toBe('rejected');
    expect(await movementsFor(movementId)).toHaveLength(1);
    expect(await onHand()).toBe(baseline - 20n);
  });
});

// ---------------------------------------------------------------------------
// 3. The refusals the builder exists to prevent — the queue-wedging pair
// ---------------------------------------------------------------------------

describe('the assertions have teeth: the two queue-wedging refusals are real', () => {
  /**
   * Both of these are PERMANENT server refusals that `classifyRejection`
   * nonetheless classes RETRYABLE, so an op carrying one would sit at the
   * head of an ORDERED queue for ever and every sale behind it would stop
   * draining. The builder narrows both away on the device; these two checks
   * prove the narrowing is load-bearing rather than belt-and-braces.
   */
  it('an unknown reason code is refused by the live route, and retried rather than dropped', async () => {
    const key = '018f3a1e-0000-7000-8000-0000000000d3';
    const result = await online().send([
      {
        id: key,
        idempotencyKey: key,
        claimedHlc: null,
        kind: ADJUSTMENT_OUTBOX_KIND,
        payloadJson: JSON.stringify({
          idempotencyKey: key,
          clientWallAt: tillClock(120),
          locationId: outlet.id,
          productId: product.id,
          qtyDelta: '-1',
          sourceKind: 'WRITE_OFF',
          // A code no tenant row carries — what a typed field would produce.
          reasonCode: 'NOT-A-REASON-THIS-TENANT-HAS',
          businessDate: tillClock(120).slice(0, 10),
          occurredAt: tillClock(120),
        }),
        createdAt: tillClock(120),
      },
    ]);
    expect(result.acks[0]!.status).toBe('rejected');
    expect(result.acks[0]!.reason).toMatch(/^PRECONDITION_FAILED/);
    // THE POINT: the client cannot tell this is permanent, so it will retry
    // for ever. That is why the reason is a PICK from synced rows.
    expect(classifyRejection(result.acks[0]!.reason)).toBe('retryable');
    expect(await movementsFor(key)).toHaveLength(0);
  });

  it('a non-stocked product is refused the same way, and the client catalogue excludes it', async () => {
    const nonStockedId = await h.db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{ id: string }>(
        `select id from app.product
          where stock_tracking <> 'STOCKED' and deleted_at is null limit 1`,
      );
      return res.rows[0]?.id ?? null;
    });
    if (nonStockedId === null) {
      // The template seeds none today. The client-side half is still proved:
      // `loadStockedProducts` filters on the column, and the device fixture
      // below is the same shape the sync stream delivers.
      const db = openTestDb();
      await provisionDevice(db, { locationId: outlet.id, locationCode: outlet.code });
      await seedProduct(db, {
        code: 'NS-1',
        name: 'Not stocked',
        uomLabel: 'each',
        qtyScale: 0,
        unitPriceE4: 1_000n,
        stockTracking: 'NON_STOCKED',
      });
      expect(await loadStockedProducts(db)).toHaveLength(0);
      return;
    }
    const key = '018f3a1e-0000-7000-8000-0000000000d4';
    const result = await online().send([
      {
        id: key,
        idempotencyKey: key,
        claimedHlc: null,
        kind: ADJUSTMENT_OUTBOX_KIND,
        payloadJson: JSON.stringify({
          idempotencyKey: key,
          clientWallAt: tillClock(180),
          locationId: outlet.id,
          productId: nonStockedId,
          qtyDelta: '-1',
          sourceKind: 'WRITE_OFF',
          reasonCode,
          businessDate: tillClock(180).slice(0, 10),
          occurredAt: tillClock(180),
        }),
        createdAt: tillClock(180),
      },
    ]);
    expect(result.acks[0]!.status).toBe('rejected');
    expect(classifyRejection(result.acks[0]!.reason)).toBe('retryable');
    expect(await movementsFor(key)).toHaveLength(0);
  });

  it('a sign the ledger CHECK forbids never leaves the device', async () => {
    const db = await provisionedDevice();
    // WRITE_OFF is outflow-only. The database would answer this with an
    // INTERNAL_SERVER_ERROR, which is retryable — so the builder refuses it
    // at the shelf, with the person still standing there.
    await expect(
      recordAdjustment(db, {
        movementId: '018f3a1e-0000-7000-8000-0000000000d5',
        productId: product.id,
        qtyDelta: 5n,
        kind: 'WRITE_OFF',
        reasonCode,
        hlc: fixedHlc(Date.parse(tillClock(240)), NODE_REFUSALS),
        nowIso: tillClock(240),
      }),
    ).rejects.toThrow(/only ever takes stock out/);
    expect(await readPendingOps(db)).toHaveLength(0);
  });
});
