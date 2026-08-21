/**
 * THE SECOND UPLOADABLE KIND, PROVEN THE SAME WAY THE FIRST ONE IS.
 *
 * `sequence.sync_block` is the reconnect conversation for receipt numbers
 * (03-offline-sync §3.7.5): the device says how far through its block it got,
 * the server says which numbers it may use next. It arrived from a branch that
 * declared its schema privately inside `apps/api/src/routers/sequence.ts` and
 * built the payload independently in `apps/web/src/data/sequence.ts` — the
 * exact two-sides-one-shape arrangement that made every sale the PWA uploaded
 * a BAD_REQUEST for weeks, and that `@erp/contracts` exists to make impossible.
 *
 * On merge the schema moved into `@erp/contracts` and the kind joined
 * `DEVICE_OP_KINDS`, which made `outbox-surface.test.ts` go red on purpose:
 * the PWA can now emit a kind that no test drives end to end. This file is the
 * answer to that tripwire, and nothing about the tripwire was relaxed.
 *
 * No fixtures stand in for either side:
 *   client  apps/web's real local SQLite, real `enqueueBlockReport`, real
 *           `drainOutbox`, real `httpUploadTransport`, real
 *           `sequenceResultHandler` adoption.
 *   wire    a real fetch-shaped call with a browser Origin at a real Fastify
 *           server (app.inject carries the bytes instead of TCP).
 *   server  apps/api's real route, real router, real idempotent pipeline, real
 *           Postgres (PGlite) with RLS on.
 *
 * What it proves, in order: a device holding nothing gets a real block; a
 * routine report moves the server's high-water mark and opens nothing; and a
 * WIPED device — the case the whole mechanism exists for — is detected, its
 * block burned, a fresh one issued, and a severity-1 review opened naming the
 * overlap range, with the device adopting the replacement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceOpContracts, syncBlockInput } from '@erp/contracts';

// ---- the server, from apps/api's own sources -------------------------------
import { signDevToken } from '../../../apps/api/src/auth.js';
import { appRouter } from '../../../apps/api/src/routers/index.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from '../../../apps/api/test/util.js';

// ---- the client, from apps/web's own sources -------------------------------
import {
  buildBlockReport,
  enqueueBlockReport,
  readCurrentBlock,
  sequenceResultHandler,
  takeNumber,
} from '../../../apps/web/src/data/sequence';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import { httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { drainOutbox } from '../../../apps/web/src/data/sync/upload';
import type { LocalDb } from '../../../apps/web/src/data/db';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import { fixedHlc, provisionDevice } from '../../../apps/web/tests/helpers/fixtures';

const PWA_ORIGIN = 'http://localhost:5173';
/** One HLC node per simulated till. */
const NODE_FRESH = 'b1'.repeat(16);
const NODE_WIPE = 'b2'.repeat(16);

type Server = Awaited<ReturnType<typeof buildServer>>;

let h: ApiHarness;
let app: Server;
let tenantId: string;
let outlet: { id: string; code: string };

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

/**
 * A device is a local database plus its OWN bearer carrying its OWN `dev`
 * claim. The device id is what the server keys a block on, so two tills at one
 * outlet must not share one — sharing would make the whole mechanism look like
 * it worked while measuring one device twice.
 */
interface Till {
  db: LocalDb;
  bearer: string;
  deviceId: string;
  node: string;
}

async function till(deviceId: string, node: string): Promise<Till> {
  const db = openTestDb();
  await provisionDevice(db, { locationId: outlet.id, locationCode: outlet.code });
  const uid = '018f3a1e-0000-7000-8000-0000000000c1';
  await h.grantOwner(tenantId, uid);
  const bearer = await signDevToken(JWT_SECRET, {
    tid: tenantId,
    uid,
    role: 'outlet-manager',
    locs: [outlet.id],
    dev: deviceId,
  });
  return { db, bearer, deviceId, node };
}

/** The reconnect, end to end: queue the report, drain it, adopt the answer. */
async function reconnect(t: Till): Promise<{ carriedResult: boolean }> {
  let carriedResult = false;
  await enqueueBlockReport(t.db, {
    locationId: outlet.id,
    claimedHlc: fixedHlc(Date.now(), t.node).next(),
  });
  const report = await drainOutbox(
    t.db,
    httpUploadTransport({ apiUrl: 'http://api.local', apiToken: t.bearer, fetchFn: browserFetch }),
    {
      onResult: async (op, result) => {
        // The ack carried the mutation's stored response — without it the
        // device cannot learn which numbers it may use next (03 §3.7.5).
        carriedResult = true;
        await sequenceResultHandler(t.db)(op, result);
      },
    },
  );
  expect(report.transportOk).toBe(true);
  expect(report.rejected).toBe(0);
  expect(report.completed).toBe(1);
  return { carriedResult };
}

async function serverBlocks(deviceId: string) {
  return h.db.withTenant(tenantId, async (tx) => {
    const res = await tx.query<{
      block_start: string;
      consumed_upto: string | null;
      closed_reason: string | null;
      exhausted: boolean;
    }>(
      `select block_start::text, consumed_upto::text, closed_reason,
              (exhausted_at is not null) as exhausted
         from app.sequence_block where device_id = $1
        order by app.sequence_block.block_start`,
      [deviceId],
    );
    return res.rows;
  });
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('sequence-conformance-co');
  await h.applyTemplate(tenantId, true);
  outlet = await h.firstOutlet(tenantId);
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

describe('the router validates with the shared contract, not a private schema', () => {
  it('sequence.syncBlock parses with @erp/contracts syncBlockInput — the same object', () => {
    const def = (appRouter.sequence.syncBlock as { _def?: { inputs?: unknown[] } })._def;
    expect(def?.inputs).toHaveLength(1);
    expect(def?.inputs?.[0]).toBe(syncBlockInput);
    expect(deviceOpContracts['sequence.sync_block']).toBe(syncBlockInput);
  });

  it("the PWA's own report payload satisfies the parser the router runs", async () => {
    const db = openTestDb();
    await provisionDevice(db, { locationId: outlet.id, locationCode: outlet.code });
    const payload = await buildBlockReport(db, { locationId: outlet.id });
    // The envelope is added by the transport; the contract needs it, so this
    // parses the exact object the client builds plus the key the wire adds.
    const parsed = syncBlockInput.safeParse({
      ...payload,
      idempotencyKey: '018f3a1e-0000-7000-8000-0000000000d1',
    });
    expect(parsed.success).toBe(true);
    // Counters cross as decimal STRINGS and become bigint at the boundary.
    expect(payload.report).toBeNull();
    expect(payload.wantBlock).toBe(true);
  });
});

describe("a fresh till's first reconnect", () => {
  it('is handed a real server block, and the counter then prints from it', async () => {
    const t = await till('018f3a1e-0000-7000-8000-00000000e001', NODE_FRESH);

    expect(await readCurrentBlock(t.db, outlet.id)).toBeNull();
    const { carriedResult } = await reconnect(t);
    expect(carriedResult).toBe(true);

    const block = await readCurrentBlock(t.db, outlet.id);
    expect(block).not.toBeNull();
    // SERVER-allocated: ranges are disjoint by a row lock, so the printed
    // number carries no device tag.
    expect(block!.source).toBe('server');
    expect(block!.consumedUpto).toBeNull();

    const taken = await takeNumber(t.db, {
      locationId: outlet.id,
      deviceId: t.deviceId,
      locationCode: outlet.code,
    });
    expect(taken.emergency).toBe(false);
    expect(taken.receiptNo).toContain(outlet.code);
    expect(taken.n).toBe(block!.blockStart);

    // …and a routine second report moves the server's high-water mark without
    // opening anything.
    await reconnect(t);
    const rows = await serverBlocks(t.deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consumed_upto).toBe(block!.blockStart.toString(10));
    expect(rows[0]!.exhausted).toBe(false);
  });
});

describe('the wipe — the case the mechanism exists for', () => {
  it('is detected on reconnect: block burned, fresh block issued, severity-1 review opened', async () => {
    const t = await till('018f3a1e-0000-7000-8000-00000000e002', NODE_WIPE);
    await reconnect(t);
    const first = await readCurrentBlock(t.db, outlet.id);
    expect(first).not.toBeNull();
    for (let i = 0; i < 3; i += 1) {
      await takeNumber(t.db, {
        locationId: outlet.id,
        deviceId: t.deviceId,
        locationCode: outlet.code,
      });
    }
    await reconnect(t);

    // OPFS eviction / PWA reinstall on the SAME enrolled device: the local-only
    // row goes with the file, and the identity survives.
    await t.db.execute('DELETE FROM sequence_block');
    expect(await readCurrentBlock(t.db, outlet.id)).toBeNull();

    await reconnect(t);

    const rows = await serverBlocks(t.deviceId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.block_start).toBe(first!.blockStart.toString(10));
    expect(rows[0]!.closed_reason).toBe('REGRESSION_BURN');
    expect(rows[0]!.exhausted).toBe(true);
    expect(rows[1]!.exhausted).toBe(false);
    // Strictly above everything the burned block covered: a block is never
    // reused, never returned, never reissued to a device that was reset.
    expect(BigInt(rows[1]!.block_start)).toBeGreaterThan(
      first!.blockStart + first!.blockSize - 1n,
    );

    // The device adopted the replacement rather than numbering on from a range
    // the server has destroyed.
    const adoptedBlock = await readCurrentBlock(t.db, outlet.id);
    expect(adoptedBlock!.blockStart.toString(10)).toBe(rows[1]!.block_start);
    expect(adoptedBlock!.source).toBe('server');

    const review = await h.db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{
        severity: number;
        status: string;
        conflict_class: string;
        required_permission: string;
        overlap_from: string;
        overlap_to: string;
        scoped: number;
      }>(
        `select cr.severity, cr.status, cr.conflict_class, cr.required_permission,
                cr.pending_value ->> 'overlapFrom' as overlap_from,
                cr.pending_value ->> 'overlapTo'   as overlap_to,
                (select count(*)::int from app.conflict_review_location crl
                  where crl.tenant_id = cr.tenant_id and crl.review_id = cr.id) as scoped
           from app.conflict_review cr
          where cr.conflict_class = 'SEQUENCE_CONSUMED_UPTO_REGRESSION'
          order by cr.opened_at desc limit 1`,
      );
      return res.rows[0] ?? null;
    });
    expect(review).not.toBeNull();
    expect(review!.severity).toBe(1);
    expect(review!.status).toBe('open');
    // Routed by a CATALOGUED permission — one a tenant can actually grant.
    expect(review!.required_permission).toBe('sync.conflict.review');
    // The honest statement of exposure: the numbers that may exist twice.
    expect(review!.overlap_from).toBe(first!.blockStart.toString(10));
    expect(review!.overlap_to).toBe((first!.blockStart + 2n).toString(10));
    // Scoped to the outlet, not broadcast to every eligible holder everywhere.
    expect(review!.scoped).toBe(1);
  });
});
