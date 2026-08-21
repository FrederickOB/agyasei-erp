/**
 * THE TEST THAT WOULD HAVE CAUGHT IT.
 *
 * Every sale the PWA uploaded was rejected BAD_REQUEST for weeks. Five sync
 * drills were green the whole time, because `packages/sync-drills` builds its
 * own API-shaped JSON in `src/context.ts` — so the client's real payload had
 * never once been handed to the server's real schema. The CORS bug before it
 * had the same shape: the drills use `@powersync/node`, which has no browser
 * origin, so nothing checked that a browser could reach the API at all. In
 * both cases the two sides were only ever tested against a third thing that
 * agreed with neither of them.
 *
 * So this file imports NO fixtures and NO test doubles for either side:
 *
 *   client  apps/web's real local SQLite (the device's own schema), real
 *           `createCart` → `addProductToCart` → `checkout` → outbox, real
 *           `readPendingOps`, real `drainOutbox`, real `httpUploadTransport`.
 *   wire    a real `fetch`-shaped call carrying a browser `Origin` header at
 *           a real Fastify server with CORS configured — the layer the first
 *           bug of this class lived in.
 *   server  apps/api's real routes, real tRPC routers, the real idempotent
 *           pipeline, on a real Postgres (PGlite) with RLS on.
 *
 * The only thing standing in for reality is the socket: `app.inject()` carries
 * the bytes instead of TCP. Everything the two agents disagreed about is on
 * the real code path. Drill D6 (`packages/sync-drills`) runs the same journey
 * over an actual socket against the docker stack.
 *
 * If either side's shape drifts again, this goes red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSaleInput,
  deviceOpContracts,
  syncTokenResponse,
  type UploadAck,
} from '@erp/contracts';

// ---- the server, imported from apps/api's own sources ----------------------
import { signDevToken } from '../../../apps/api/src/auth.js';
import { appRouter } from '../../../apps/api/src/routers/index.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from '../../../apps/api/test/util.js';

// ---- the client, imported from apps/web's own sources ----------------------
import { addProductToCart, createCart } from '../../../apps/web/src/data/mutations/cart';
import { loadActiveProducts } from '../../../apps/web/src/data/queries/products';
import { checkout } from '../../../apps/web/src/data/mutations/checkout';
import { CredentialCache } from '../../../apps/web/src/data/sync/credentials';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import { httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { classifyRejection, drainOutbox, readPendingOps } from '../../../apps/web/src/data/sync/upload';
import type { LocalDb } from '../../../apps/web/src/data/db';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import { fixedHlc, provisionDevice, seedProduct } from '../../../apps/web/tests/helpers/fixtures';

/** The origin the PWA is served from in dev — a browser, not a Node client. */
const PWA_ORIGIN = 'http://localhost:5173';
const BUSINESS_DATE = '2026-08-21';
/** GH₵25.00 per unit, as e4 minor units: 25_000_000 e4 = 2500 minor. */
const SERVER_UNIT_PRICE_E4 = 25_000_000n;

/** One HLC node per simulated till — see `provisionedDevice`. */
const NODE_PARSE = 'a1'.repeat(16);
const NODE_KIND = 'a2'.repeat(16);
const NODE_JOURNEY = 'a3'.repeat(16);
const NODE_REPLAY = 'a4'.repeat(16);
const NODE_PRICE_FORGERY = 'a5'.repeat(16);

/** Inferred rather than imported: this package deliberately has no fastify
 *  dependency of its own — it borrows both apps', it does not own either. */
type Server = Awaited<ReturnType<typeof buildServer>>;

let h: ApiHarness;
let app: Server;
let tenantId: string;
let outlet: { id: string; code: string };
let product: { id: string; skuCode: string; uomCode: string; qtyScale: number };
let bearer: string;

/**
 * A `fetch` the PWA's own transport can use, that speaks to the real server
 * and carries the header a browser would. `app.inject()` is the socket; every
 * other layer is production code.
 */
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

function transport() {
  return httpUploadTransport({ apiUrl: 'http://api.local', apiToken: bearer, fetchFn: browserFetch });
}

/**
 * A provisioned device holding the SERVER's real location, list and product.
 *
 * `deviceNode` is per-device on purpose: two tills at one outlet allocate
 * receipt numbers from their own self-issued blocks, and it is the device tag
 * in the printed number that keeps them disjoint (03 §3.7.5, and the note in
 * `data/sequence.ts` that cross-device disjointness is the formatter's job).
 * Reusing one node here would collide two devices' receipt numbers and the
 * failure would look like a server bug.
 */
async function provisionedDevice(deviceNode: string): Promise<LocalDb> {
  const db = openTestDb();
  const device = await provisionDevice(db, {
    locationId: outlet.id,
    locationCode: outlet.code,
    priceListCode: 'WHOLESALE',
  });
  await seedProduct(db, {
    id: product.id,
    code: product.skuCode,
    name: 'Conformance product',
    uomLabel: product.uomCode,
    qtyScale: product.qtyScale,
    // DELIBERATELY NOT the server's price. The till's arithmetic is a claim,
    // never a source (CLAUDE.md §2.5): the assertions below prove what landed
    // in app.sale is the server's repricing and not this number.
    unitPriceE4: 99_000_000n,
    priceListId: device.priceListId,
  });
  return db;
}

/** Ring up `qty` units and complete the sale — the counter's real path. */
async function ringUpAndCheckout(
  db: LocalDb,
  qty: number,
  nowIso: string,
  deviceNode: string,
): Promise<{ saleId: string; receiptNo: string; totalMinor: bigint }> {
  const cartId = await createCart(db, { nowIso });
  // The counter's REAL read path — the client's own projection over the
  // catalogue shape the sync stream delivers, priced from the list this
  // device is provisioned with. A hand-written SELECT here would prove the
  // wire against a shelf the device does not actually have.
  const catalogue = await loadActiveProducts(db, nowIso);
  const row = catalogue.find((p) => p.id === product.id);
  if (row === undefined) throw new Error('device catalogue is empty');
  for (let i = 0; i < qty; i += 1) {
    await addProductToCart(db, cartId, row);
  }
  const result = await checkout(db, {
    cartId,
    tenderedMinor: 100_000_000n,
    hlc: fixedHlc(Date.parse(nowIso), deviceNode),
    nowIso,
    businessDate: BUSINESS_DATE,
  });
  return { saleId: result.saleId, receiptNo: result.receiptNo, totalMinor: result.totalMinor };
}

interface SaleRow {
  receipt_no: string;
  business_date: string;
  subtotal_net_minor: string;
  discount_minor: string;
  tax_total_minor: string;
  total_minor: string;
  location_id: string;
  tenant_id: string;
}

async function saleByReceipt(receiptNo: string): Promise<SaleRow[]> {
  return h.db.asAdmin(async (tx) => {
    const res = await tx.query<SaleRow>(
      `select receipt_no, business_date::text, subtotal_net_minor::text, discount_minor::text,
              tax_total_minor::text, total_minor::text, location_id, tenant_id
         from app.sale where tenant_id = $1 and receipt_no = $2`,
      [tenantId, receiptNo],
    );
    return res.rows;
  });
}

/**
 * The server's own sale id. It is `deterministicUuid(writeKey, 'sale')`, NOT
 * the client's idempotency key — child rows hang off it, so a test that
 * counted by the write key would count zero and call it a pass.
 */
async function serverSaleId(receiptNo: string): Promise<string> {
  const rows = await h.db.asAdmin(async (tx) => {
    const res = await tx.query<{ id: string }>(
      `select id from app.sale where tenant_id = $1 and receipt_no = $2`,
      [tenantId, receiptNo],
    );
    return res.rows;
  });
  if (rows[0] === undefined) throw new Error(`no sale on the server for receipt ${receiptNo}`);
  return rows[0].id;
}

async function countFor(table: string, saleId: string): Promise<number> {
  return h.db.asAdmin(async (tx) => {
    const res = await tx.query<{ n: string }>(
      `select count(*)::text as n from app.${table} where tenant_id = $1 and sale_id = $2`,
      [tenantId, saleId],
    );
    return Number(res.rows[0]?.n ?? '0');
  });
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('conformance-co');
  await h.applyTemplate(tenantId, true);
  outlet = await h.firstOutlet(tenantId);
  const picked = await h.pickProduct(tenantId);
  product = {
    id: picked.id,
    skuCode: picked.skuCode,
    uomCode: picked.uomCode,
    qtyScale: picked.qtyScale,
  };
  await h.seedWholesalePrice(tenantId, product.id, SERVER_UNIT_PRICE_E4);
  bearer = await signDevToken(JWT_SECRET, {
    tid: tenantId,
    uid: '018f3a1e-0000-7000-8000-0000000000aa',
    role: 'outlet-manager',
    locs: [outlet.id],
  });
  app = await buildServer({
    deps: h.deps,
    jwtSecret: JWT_SECRET,
    sync: { powersyncUrl: 'http://localhost:8080' },
    // The PWA's origin. The drills never needed this and never had it.
    corsOrigins: [PWA_ORIGIN],
  });
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

// ---------------------------------------------------------------------------
// 1. The two sides are wired to ONE declaration — provably, not by convention
// ---------------------------------------------------------------------------

/** The zod parser the tRPC procedure ACTUALLY validates with. */
function routerInputOf(procedure: unknown): unknown {
  const def = (procedure as { _def?: { inputs?: unknown[] } })._def;
  const inputs = def?.inputs ?? [];
  expect(inputs).toHaveLength(1);
  return inputs[0];
}

describe('the router validates with the shared contract, not a private schema', () => {
  it('sales.createSale parses with @erp/contracts createSaleInput — the same object', () => {
    expect(routerInputOf(appRouter.sales.createSale)).toBe(createSaleInput);
  });

  it('EVERY uploadable device op is declared in the shared contract and used by its router', () => {
    // If this list and the registry ever disagree the build fails first
    // (device-ops.ts `satisfies Record<DeviceOpKind, ZodType>`); this asserts
    // the other half — that the router actually parses with the registered
    // schema, so no uploadable op can keep a client-invisible shape.
    const routed: Record<keyof typeof deviceOpContracts, unknown> = {
      'sale.create': appRouter.sales.createSale,
      'stock.record_movement': appRouter.inventory.recordMovement,
      'credit.open_account': appRouter.credit.openAccount,
      'credit.record_entry': appRouter.credit.recordEntry,
      'sequence.sync_block': appRouter.sequence.syncBlock,
    };
    for (const [kind, procedure] of Object.entries(routed)) {
      expect(routerInputOf(procedure)).toBe(
        deviceOpContracts[kind as keyof typeof deviceOpContracts],
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The client's REAL payload, against the server's REAL parser
// ---------------------------------------------------------------------------

describe("the PWA's own payload satisfies the parser the router runs", () => {
  it('parses the bytes checkout() put in the outbox — not a hand-written fixture', async () => {
    const db = await provisionedDevice(NODE_PARSE);
    const sale = await ringUpAndCheckout(db, 4, '2026-08-21T09:00:00.000Z', NODE_PARSE);

    const pending = await readPendingOps(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.idempotencyKey).toBe(sale.saleId);

    // The exact bytes the transport would ship, through the exact parser the
    // procedure runs. Not `createSaleInput` imported here — the one pulled
    // back out of the live router.
    const parser = routerInputOf(appRouter.sales.createSale) as typeof createSaleInput;
    const parsed = parser.safeParse(JSON.parse(pending[0]!.payloadJson));
    if (!parsed.success) {
      throw new Error(
        `the client's payload does not satisfy the API's schema: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    // Money and quantity arrived as bigint, never as JS numbers (ADR-0004).
    for (const line of parsed.data.lines) {
      expect(typeof line.qty).toBe('bigint');
      expect(typeof line.lineDiscountMinor).toBe('bigint');
    }
    expect(typeof parsed.data.clientTotalMinor).toBe('bigint');
  });

  it('the outbox kind maps onto an op the server dispatches', async () => {
    const db = await provisionedDevice(NODE_KIND);
    await ringUpAndCheckout(db, 1, '2026-08-21T09:01:00.000Z', NODE_KIND);
    const pending = await readPendingOps(db);
    // The device writes 'sale' locally; the wire discriminator is the
    // contract's. An op the server has no handler for is answered
    // UNKNOWN_KIND, which dead-letters instead of wedging the queue.
    expect(pending[0]!.kind).toBe('sale');
    expect(Object.keys(deviceOpContracts)).toContain('sale.create');
  });
});

// ---------------------------------------------------------------------------
// 3. The whole journey: counter → outbox → CORS → API → Postgres
// ---------------------------------------------------------------------------

describe('the browser is allowed to make the exact request the transport makes', () => {
  // Bug #1 of this class. `apps/api/test/cors.test.ts` proves the CORS plugin
  // behaves; this proves it for THIS request — the origin the PWA is served
  // from, the method, and the two headers `httpUploadTransport` actually sets.
  // A Node sync client sends no Origin and would never have noticed.
  it('answers the preflight for POST /sync/upload with authorization + content-type', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/sync/upload',
      headers: {
        origin: PWA_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(PWA_ORIGIN);
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST');
    const allowed = String(res.headers['access-control-allow-headers']).toLowerCase();
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('content-type');
    // Identity travels in the Authorization header, never a cookie, so the
    // browser must not be told to attach ambient credentials.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('stamps the allow-origin header on the real POST, so the browser can read the acks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/upload',
      headers: { authorization: `Bearer ${bearer}`, origin: PWA_ORIGIN },
      payload: { ops: [] },
    });
    expect(res.headers['access-control-allow-origin']).toBe(PWA_ORIGIN);
  });

  it('does NOT admit an arbitrary origin — the bearer establishes tenant identity', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/sync/upload',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('a sale rung up on the device lands in Postgres, priced by the server', () => {
  let db: LocalDb;
  let sale: { saleId: string; receiptNo: string; totalMinor: bigint };
  let acks: readonly UploadAck[];

  beforeAll(async () => {
    db = await provisionedDevice(NODE_JOURNEY);
    sale = await ringUpAndCheckout(db, 4, '2026-08-21T09:02:00.000Z', NODE_JOURNEY);
    const result = await transport().send(await readPendingOps(db));
    expect(result.ok).toBe(true);
    acks = result.acks;
  });

  it('is ACKED APPLIED — not rejected', () => {
    expect(acks).toHaveLength(1);
    expect(acks[0]!.key).toBe(sale.saleId);
    // The whole bug, in one assertion.
    expect(acks[0]!.reason).toBeUndefined();
    expect(acks[0]!.status).toBe('applied');
  });

  it('wrote the sale header under the VERIFIED tenant and the device location', async () => {
    const rows = await saleByReceipt(sale.receiptNo);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe(tenantId);
    expect(rows[0]!.location_id).toBe(outlet.id);
    expect(rows[0]!.business_date).toBe(BUSINESS_DATE);
  });

  it('wrote the lines, the tax lines and the stock movements', async () => {
    const serverId = await serverSaleId(sale.receiptNo);
    expect(await countFor('sale_line', serverId)).toBe(1);
    // The Ghana pack's rate rows in force on the business date, per line.
    expect(await countFor('sale_tax_line', serverId)).toBeGreaterThan(0);
    const movements = await h.db.asAdmin(async (tx) => {
      const res = await tx.query<{ qty_delta: string; source_kind: string }>(
        `select qty_delta::text, source_kind from app.stock_movement
          where tenant_id = $1 and source_id = $2`,
        [tenantId, serverId],
      );
      return res.rows;
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]!.source_kind).toBe('SALE');
    // Outflow is negative; 4 units off the shelf.
    expect(BigInt(movements[0]!.qty_delta)).toBe(-4n);
  });

  it("the total is the SERVER's exact bigint, not the till's claim", async () => {
    const row = (await saleByReceipt(sale.receiptNo))[0]!;
    const subtotal = BigInt(row.subtotal_net_minor);
    const discount = BigInt(row.discount_minor);
    const tax = BigInt(row.tax_total_minor);
    const total = BigInt(row.total_minor);

    // 4 units × 25_000_000 e4 = 10_000 minor units, rounded once, exactly.
    expect(subtotal).toBe(10_000n);
    expect(discount).toBe(0n);
    expect(tax).toBeGreaterThan(0n);
    // The schema's sale_total_identity CHECK, restated as an assertion.
    expect(total).toBe(subtotal - discount + tax);
    // The device priced the same goods at 99_000_000 e4 and said so; the
    // server ignored it. If these were equal, the till would be the pricing
    // authority and CLAUDE.md §2.5 would be broken.
    expect(sale.totalMinor).toBe(39_600n);
    expect(total).not.toBe(sale.totalMinor);
  });

  it('reports the divergence back rather than swallowing it (the stale-price-list detector)', async () => {
    const body = await h.db.asAdmin(async (tx) => {
      const res = await tx.query<{ response_body: unknown }>(
        `select response_body from app.write_log where tenant_id = $1 and id = $2`,
        [tenantId, sale.saleId],
      );
      return res.rows[0]?.response_body as Record<string, unknown> | undefined;
    });
    expect(body).toBeDefined();
    const priceCheck = body!['priceCheck'] as Record<string, unknown>;
    expect(priceCheck).toBeDefined();
    expect(priceCheck['matches']).toBe(false);
    // Money inside jsonb is a decimal STRING — JSON.parse of a number is a
    // float64 (03 §3.6.2).
    expect(typeof priceCheck['clientTotalMinor']).toBe('string');
    expect(typeof priceCheck['serverTotalMinor']).toBe('string');
    expect(priceCheck['clientTotalMinor']).toBe('39600');
    const row = (await saleByReceipt(sale.receiptNo))[0]!;
    expect(priceCheck['serverTotalMinor']).toBe(row.total_minor);
  });

  it('the drain marks the op acked, so the counter stops showing it as pending', async () => {
    const report = await drainOutbox(db, transport());
    // Already sent above, so this pass re-sends the same key and gets
    // `duplicate` — either way the op completes, never lost.
    expect(report.transportOk).toBe(true);
    expect(report.rejected).toBe(0);
    const stillPending = await readPendingOps(db);
    expect(stillPending).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Replay: the same idempotency key, no second effect
// ---------------------------------------------------------------------------

describe('a re-sent batch is a duplicate, not a second sale', () => {
  it('acks duplicate and leaves exactly one sale, one line and one movement', async () => {
    const db = await provisionedDevice(NODE_REPLAY);
    const sale = await ringUpAndCheckout(db, 2, '2026-08-21T09:03:00.000Z', NODE_REPLAY);
    const ops = await readPendingOps(db);

    const first = await transport().send(ops);
    expect(first.acks[0]!.status).toBe('applied');

    // Byte-identical replay — the ambiguous-failure case (03 §3.9): the
    // server committed, the device never saw the response, the queue retries.
    const second = await transport().send(ops);
    expect(second.acks[0]!.status).toBe('duplicate');
    const third = await transport().send(ops);
    expect(third.acks[0]!.status).toBe('duplicate');

    expect(await saleByReceipt(sale.receiptNo)).toHaveLength(1);
    const serverId = await serverSaleId(sale.receiptNo);
    expect(await countFor('sale_line', serverId)).toBe(1);
    const movements = await h.db.asAdmin(async (tx) => {
      const res = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.stock_movement
          where tenant_id = $1 and source_id = $2`,
        [tenantId, serverId],
      );
      return Number(res.rows[0]?.n ?? '0');
    });
    expect(movements).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Negative control — this suite can actually fail
// ---------------------------------------------------------------------------

describe('the assertions have teeth: a drifted payload is refused', () => {
  /** The exact shape `buildSalePayload` emitted when the bug was live. */
  function driftedPayload(): Record<string, unknown> {
    return {
      kind: 'sale',
      sale_id: '018f3a1e-0000-7000-8000-0000000000fe',
      price_list_id: '018f3a1e-0000-7000-8000-0000000000fd',
      created_at: '2026-08-21T09:04:00.000Z',
      total_minor: '10000',
      tax_lines: [],
      tender: { kind: 'cash', tendered_minor: '10000', change_minor: '0' },
      lines: [
        {
          seq: 1,
          product_id: product.id,
          name: 'x',
          uom_label: 'each',
          qty_scale: 0,
          qty_scaled: '4',
          unit_price_e4: '25000000',
          line_total_minor: '10000',
        },
      ],
    };
  }

  it('the old hand-rolled shape is rejected by the live route, and nothing lands', async () => {
    const key = '018f3a1e-0000-7000-8000-0000000000fc';
    const result = await transport().send([
      {
        id: key,
        idempotencyKey: key,
        claimedHlc: null,
        kind: 'sale',
        payloadJson: JSON.stringify(driftedPayload()),
        createdAt: '2026-08-21T09:04:00.000Z',
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.acks[0]!.status).toBe('rejected');
    expect(result.acks[0]!.reason).toMatch(/^BAD_REQUEST/);
    // And the client classes it definitively, so it becomes visible work
    // rather than an infinite retry (03 §3.3.4).
    expect(classifyRejection(result.acks[0]!.reason)).toBe('definitive');

    const landed = await h.db.asAdmin(async (tx) => {
      const res = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.sale where tenant_id = $1 and write_id = $2`,
        [tenantId, key],
      );
      return Number(res.rows[0]?.n ?? '0');
    });
    expect(landed).toBe(0);
  });

  it('a client-asserted price is refused even when everything else is right', async () => {
    const db = await provisionedDevice(NODE_PRICE_FORGERY);
    const sale = await ringUpAndCheckout(db, 1, '2026-08-21T09:05:00.000Z', NODE_PRICE_FORGERY);
    const op = (await readPendingOps(db))[0]!;
    const payload = JSON.parse(op.payloadJson) as Record<string, unknown>;
    const lines = payload['lines'] as Record<string, unknown>[];
    lines[0]!['unitPriceE4'] = '99000000';

    const result = await transport().send([{ ...op, payloadJson: JSON.stringify(payload) }]);
    expect(result.acks[0]!.status).toBe('rejected');
    expect(result.acks[0]!.reason).toMatch(/^BAD_REQUEST/);
    expect(await saleByReceipt(sale.receiptNo)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. The OTHER client→server payload: GET /sync/token
// ---------------------------------------------------------------------------

describe('the download path: the PWA parses what the API actually sends', () => {
  it("the API's live /sync/token response satisfies the client's contract", async () => {
    const res = await browserFetch('http://api.local/sync/token', {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(res.ok).toBe(true);
    const parsed = syncTokenResponse.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    // `endpoint` is optional in the contract because the client ignores it,
    // but the API does send it — asserted here against the live route rather
    // than baked into the schema as a requirement devices do not have.
    expect(parsed.success && parsed.data.endpoint).toBeTruthy();
  });

  it("the PWA's real CredentialCache accepts the live response", async () => {
    const cache = new CredentialCache({
      apiUrl: 'http://api.local',
      apiToken: bearer,
      powersyncUrl: 'http://localhost:8080',
      fetchFn: browserFetch,
    });
    const creds = await cache.get();
    expect(creds.token.split('.')).toHaveLength(3);
    expect(creds.expiresAtMs).toBeGreaterThan(Date.now());
    // Configuration is authoritative for where a device connects.
    expect(creds.endpoint).toBe('http://localhost:8080');
  });

  it('a token carries no tenant identity the client supplied', async () => {
    const res = await browserFetch('http://api.local/sync/token', {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
    });
    const body = syncTokenResponse.parse(await res.json());
    const claims = JSON.parse(
      Buffer.from(body.token.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(claims['tid']).toBe(tenantId);
    expect(claims['aud']).toBe('powersync');
  });
});
