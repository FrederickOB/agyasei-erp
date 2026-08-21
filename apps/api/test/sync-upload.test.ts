/**
 * POST /sync/upload — the ONLY ingress for device writes (03 §3.3; the
 * PowerSync service is download-only). Each op flows through the EXISTING
 * idempotent pipeline via the real tRPC mutations, exercised here over the
 * real HTTP surface (fastify.inject) with verified JWTs on hermetic
 * PGlite — RLS enforced, nothing mocked.
 *
 * Proven here:
 *   - an idempotent re-send of a whole batch acks all `duplicate` with
 *     exactly one effect per key;
 *   - a failing op is acked `rejected` and does NOT poison the batch
 *     (one transaction per op);
 *   - forged tenant identity in an op payload is ignored — the server's
 *     verified tid wins (CLAUDE.md §2.1);
 *   - same key + different payload is refused (IDEMPOTENCY_KEY_REUSE),
 *     never applied;
 *   - unauthenticated calls are refused outright.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { signDevToken } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import type { UploadAck } from '../src/sync.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from './util.js';

let h: ApiHarness;
let app: FastifyInstance;
let tenantA: string;
let tenantB: string;
let outletId: string;
let productId: string;
let bearerA: string;

interface UploadOp {
  idempotency_key: string;
  claimed_hlc?: string;
  client_wall_at?: string;
  kind: string;
  payload: Record<string, unknown>;
}

function salePayload(receiptNo: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    locationId: outletId,
    priceListCode: 'WHOLESALE',
    receiptNo,
    businessDate: '2026-08-15',
    tender: 'CASH',
    lines: [{ productId, qty: '5' }],
    ...extra,
  };
}

function saleOp(key: string, receiptNo: string, extra: Record<string, unknown> = {}): UploadOp {
  return {
    idempotency_key: key,
    claimed_hlc: h.deps.clock.next(),
    kind: 'sale.create',
    payload: salePayload(receiptNo, extra),
  };
}

/** `bearer: null` sends NO Authorization header (default: tenant A's token). */
async function upload(ops: UploadOp[], bearer: string | null = bearerA) {
  const res = await app.inject({
    method: 'POST',
    url: '/sync/upload',
    ...(bearer !== null ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
    payload: { ops },
  });
  return res;
}

async function saleCount(tenantId: string, keys: string[]): Promise<number> {
  const res = await h.db.asAdmin((tx) =>
    tx.query<{ n: string }>(
      `select count(*)::text as n from app.sale where tenant_id = $1 and write_id = any($2::uuid[])`,
      [tenantId, keys],
    ),
  );
  return Number(res.rows[0]!.n);
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('sync-up-a');
  tenantB = await h.provisionTenant('sync-up-b');
  await h.applyTemplate(tenantA);
  const outlet = await h.firstOutlet(tenantA);
  outletId = outlet.id;
  const product = await h.pickProduct(tenantA);
  productId = product.id;
  await h.seedWholesalePrice(tenantA, productId, 55_000_000n); // GH₵55.00/unit, e4

  app = await buildServer({ deps: h.deps, jwtSecret: JWT_SECRET });
  // A PROVISIONED principal, not merely a signed token: every gated write
  // resolves its permissions server-side from app.user_role_assignment
  // (apps/api/src/permissions.ts). This file is about the upload envelope, so
  // it grants breadth and leaves who-may-do-what to test/rbac.test.ts.
  const uploaderUid = uuidv7();
  await h.grantOwner(tenantA, uploaderUid);
  bearerA = await signDevToken(JWT_SECRET, {
    tid: tenantA,
    uid: uploaderUid,
    role: 'outlet-staff',
    locs: [outletId],
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('POST /sync/upload', () => {
  it('refuses unauthenticated and garbage-bearer calls with 401, applying nothing', async () => {
    const key = uuidv7();
    const noAuth = await upload([saleOp(key, 'R-NOPE-1')], null);
    expect(noAuth.statusCode).toBe(401);
    const badAuth = await upload([saleOp(key, 'R-NOPE-1')], 'not-a-jwt');
    expect(badAuth.statusCode).toBe(401);
    expect(await saleCount(tenantA, [key])).toBe(0);
  });

  it('idempotent re-send of the whole batch → every ack duplicate, exactly one effect per key', async () => {
    const keys = [uuidv7(), uuidv7(), uuidv7()];
    // Built ONCE and re-sent byte-identical — the outbox re-sends the queued
    // op verbatim, claimed_hlc included.
    const ops = keys.map((k, i) => saleOp(k, `R-SYNC-1${i}`));

    const first = await upload(ops);
    expect(first.statusCode).toBe(200);
    const firstAcks = first.json().acks as UploadAck[];
    expect(firstAcks.map((a) => a.status)).toEqual(['applied', 'applied', 'applied']);
    // Acks come back in op order, keyed.
    expect(firstAcks.map((a) => a.key)).toEqual(keys);

    const second = await upload(ops);
    expect(second.statusCode).toBe(200);
    const secondAcks = second.json().acks as UploadAck[];
    expect(secondAcks.map((a) => a.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(secondAcks.map((a) => a.key)).toEqual(keys);

    // Exactly one sale per key, exactly one write_log marker per key.
    expect(await saleCount(tenantA, keys)).toBe(3);
    const markers = await h.db.asAdmin((tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from app.write_log where tenant_id = $1 and id = any($2::uuid[])`,
        [tenantA, keys],
      ),
    );
    expect(Number(markers.rows[0]!.n)).toBe(3);
  });

  it('a failing op is rejected without poisoning the batch — ops before and after still apply', async () => {
    const k1 = uuidv7();
    const kBad = uuidv7();
    const k3 = uuidv7();
    const ops: UploadOp[] = [
      saleOp(k1, 'R-SYNC-20'),
      // qty '0' violates the mutation's own strict schema (> 0 required).
      saleOp(kBad, 'R-SYNC-21', { lines: [{ productId, qty: '0' }] }),
      saleOp(k3, 'R-SYNC-22'),
    ];
    const res = await upload(ops);
    expect(res.statusCode).toBe(200);
    const acks = res.json().acks as UploadAck[];
    expect(acks.map((a) => a.status)).toEqual(['applied', 'rejected', 'applied']);
    expect(acks[1]!.reason).toMatch(/^BAD_REQUEST/);

    // Ops 1 and 3 took effect; the bad op left NOTHING — no marker, no sale.
    expect(await saleCount(tenantA, [k1, k3])).toBe(2);
    const badMarker = await h.db.asAdmin((tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from app.write_log where tenant_id = $1 and id = $2`,
        [tenantA, kBad],
      ),
    );
    expect(Number(badMarker.rows[0]!.n)).toBe(0);
  });

  it('an unknown kind is rejected definitively; the rest of the batch continues', async () => {
    const kBad = uuidv7();
    const kGood = uuidv7();
    const res = await upload([
      { idempotency_key: kBad, kind: 'payroll.compute_paye', payload: {} },
      saleOp(kGood, 'R-SYNC-30'),
    ]);
    expect(res.statusCode).toBe(200);
    const acks = res.json().acks as UploadAck[];
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.reason).toMatch(/^UNKNOWN_KIND/);
    expect(acks[1]!.status).toBe('applied');
  });

  it('forged tenant identity in an op payload is ignored — the verified tid wins', async () => {
    const key = uuidv7();
    const res = await upload([
      saleOp(key, 'R-SYNC-40', { tenant_id: tenantB, tid: tenantB }),
    ]);
    expect(res.statusCode).toBe(200);
    expect((res.json().acks as UploadAck[])[0]!.status).toBe('applied');

    // The sale landed under tenant A (the token's tid) — tenant B holds
    // neither the sale nor the write_log marker.
    expect(await saleCount(tenantA, [key])).toBe(1);
    expect(await saleCount(tenantB, [key])).toBe(0);
    const bRows = await h.db.asAdmin((tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from app.write_log where tenant_id = $1 and id = $2`,
        [tenantB, key],
      ),
    );
    expect(Number(bRows.rows[0]!.n)).toBe(0);
  });

  it('same key + different payload is refused (IDEMPOTENCY_KEY_REUSE), never applied twice', async () => {
    const key = uuidv7();
    const original = saleOp(key, 'R-SYNC-50');
    const first = await upload([original]);
    expect((first.json().acks as UploadAck[])[0]!.status).toBe('applied');

    const mutated: UploadOp = { ...original, payload: salePayload('R-SYNC-51') };
    const second = await upload([mutated]);
    const ack = (second.json().acks as UploadAck[])[0]!;
    expect(ack.status).toBe('rejected');
    expect(ack.reason).toMatch(/IDEMPOTENCY_KEY_REUSE/);
    expect(await saleCount(tenantA, [key])).toBe(1);
  });
});
