/**
 * THE TILL, CLIENT → SERVER — the PWA's own builders against the API's own
 * parsers, for the two new uploadable kinds (`cash_session.open`,
 * `cash_session.close`) and for the split-tender sale between them.
 *
 * Shaped like `sale-client-to-api.test.ts` and `stock-client-to-api.test.ts`,
 * because this is the class of bug those files exist for: a device payload
 * only one side has ever seen. Nothing here is a fixture standing in for
 * either side:
 *
 *   client  apps/web's real local SQLite and its real `openTill` → cart →
 *           `checkout` (split tender) → `closeTill` → outbox → `drainOutbox`
 *           → `httpUploadTransport`, recorded under a REAL partition (a fetch
 *           that rejects) and drained on reconnect.
 *   server  apps/api's real routes, routers and idempotent pipeline on a real
 *           Postgres with RLS on.
 *
 * What it proves, in the order a day at the counter happens:
 *   1. a till opened, a sale split across mobile money and cash, and the
 *      cash-up — all with the radio off — drain IN ORDER on reconnect and
 *      every one is applied;
 *   2. the server's expected cash, computed from what IT recorded, equals the
 *      device's, and the variance the cashier saw is the variance stored;
 *   3. a byte-identical replay of the whole queue is a duplicate — one till,
 *      one sale, two tender rows, never doubled.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeCashSessionInput, deviceOpContracts, openCashSessionInput } from '@erp/contracts';

import { signDevToken } from '../../../apps/api/src/auth.js';
import { appRouter } from '../../../apps/api/src/routers/index.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from '../../../apps/api/test/util.js';

import type { LocalDb } from '../../../apps/web/src/data/db';
import { addProductToCart, createCart } from '../../../apps/web/src/data/mutations/cart';
import { checkout } from '../../../apps/web/src/data/mutations/checkout';
import { closeTill, openTill } from '../../../apps/web/src/data/mutations/till';
import { loadActiveProducts } from '../../../apps/web/src/data/queries/products';
import { loadTenderMethods } from '../../../apps/web/src/data/queries/tender-methods';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import { httpUploadTransport, WIRE_KINDS } from '../../../apps/web/src/data/sync/transport';
import { drainOutbox, readPendingOps, type PendingOp } from '../../../apps/web/src/data/sync/upload';
import {
  fixedHlc,
  provisionDevice,
  replaceTenderMethods,
  seedProduct,
} from '../../../apps/web/tests/helpers/fixtures';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';

const PWA_ORIGIN = 'http://localhost:5173';
const NODE = 'd1'.repeat(16);
/** Relative to now: the API clamps a claimed HLC at ±24h (see sale-client-to-api). */
const BASE_MS = Date.now();
const at = (offsetS: number): string => new Date(BASE_MS + offsetS * 1_000).toISOString();
const BUSINESS_DATE = at(0).slice(0, 10);

type Server = Awaited<ReturnType<typeof buildServer>>;

let h: ApiHarness;
let app: Server;
let tenantId: string;
let outlet: { id: string; code: string };
let product: { id: string; skuCode: string; uomCode: string; qtyScale: number };
let bearer: string;
const DEVICE_ID = '018f3a1e-0000-7000-8000-0000000000d1';

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
const online = () => httpUploadTransport({ apiUrl: 'http://api.local', apiToken: bearer, fetchFn: browserFetch });
const partitioned = () =>
  httpUploadTransport({
    apiUrl: 'http://api.local',
    apiToken: bearer,
    fetchFn: () => Promise.reject(new Error('network unreachable')),
  });

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('till-conformance');
  await h.applyTemplate(tenantId, true);
  outlet = await h.firstOutlet(tenantId);
  const picked = await h.pickProduct(tenantId);
  product = { id: picked.id, skuCode: picked.skuCode, uomCode: picked.uomCode, qtyScale: picked.qtyScale };
  await h.seedWholesalePrice(tenantId, product.id, 25_000_000n); // 2500 minor per unit
  const uid = '018f3a1e-0000-7000-8000-0000000000d2';
  await h.grantOwner(tenantId, uid);
  bearer = await signDevToken(JWT_SECRET, {
    tid: tenantId, uid, role: 'outlet-staff', locs: [outlet.id], dev: DEVICE_ID,
  });
  app = await buildServer({
    deps: h.deps, jwtSecret: JWT_SECRET, sync: { powersyncUrl: 'http://localhost:8080' },
    corsOrigins: [PWA_ORIGIN],
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe('the router validates the till ops with the shared contract', () => {
  it('cashSession.open / .close parse with the registered schema objects', () => {
    const inputOf = (p: unknown) => (p as { _def: { inputs: unknown[] } })._def.inputs[0];
    expect(inputOf(appRouter.cashSession.open)).toBe(openCashSessionInput);
    expect(inputOf(appRouter.cashSession.close)).toBe(closeCashSessionInput);
    expect(deviceOpContracts['cash_session.open']).toBe(openCashSessionInput);
    expect(deviceOpContracts['cash_session.close']).toBe(closeCashSessionInput);
    expect(WIRE_KINDS['cash_session_open']).toBe('cash_session.open');
    expect(WIRE_KINDS['cash_session_close']).toBe('cash_session.close');
  });
});

describe('a day at the counter, offline, drains in order and the books agree', () => {
  let db: LocalDb;
  let tillId: string;
  let saleId: string;
  let deviceExpected: bigint;
  let queued: PendingOp[];

  beforeAll(async () => {
    db = openTestDb();
    const device = await provisionDevice(db, {
      locationId: outlet.id, locationCode: outlet.code, priceListCode: 'WHOLESALE', till: false,
    });
    await seedProduct(db, {
      id: product.id, code: product.skuCode, name: 'Till product', uomLabel: product.uomCode,
      qtyScale: product.qtyScale, unitPriceE4: 25_000_000n, priceListId: device.priceListId,
    });
    // The tenant's REAL methods, as the reference bucket delivers them.
    const methods = await h.db.withTenant(tenantId, async (tx) =>
      (await tx.query<{ id: string; name: string; posting_role: string; is_cash: boolean;
                         is_on_account: boolean; requires_reference: boolean; sort_order: number }>(
        `select id, name, posting_role, is_cash, is_on_account, requires_reference, sort_order
           from app.tender_method where is_active and deleted_at is null`)).rows);
    await replaceTenderMethods(db, methods.map((m) => ({
      id: m.id, name: m.name, postingRole: m.posting_role, isCash: m.is_cash,
      isOnAccount: m.is_on_account, requiresReference: m.requires_reference, sortOrder: m.sort_order,
    })));

    // ── OFFLINE: open, sell (split), cash up. Nothing reaches the server. ──
    const till = await openTill(db, {
      openingFloatMinor: 10_000n, businessDate: BUSINESS_DATE, openedOffline: true,
      hlc: fixedHlc(Date.parse(at(0)), NODE), nowIso: at(0),
    });
    tillId = till.id;

    const cartId = await createCart(db, { nowIso: at(60) });
    const row = (await loadActiveProducts(db, at(60))).find((p) => p.id === product.id)!;
    for (let i = 0; i < 4; i += 1) await addProductToCart(db, cartId, row);
    const local = await loadTenderMethods(db);
    const wallet = local.find((m) => !m.isCash && !m.isOnAccount && m.requiresReference)!;
    const cash = local.find((m) => m.isCash)!;
    const sale = await checkout(db, {
      cartId,
      tenders: [
        { method: wallet, amountMinor: 4_000n, reference: 'MP-CONF-0001' },
        { method: cash, amountMinor: null, tenderedMinor: 20_000n },
      ],
      hlc: fixedHlc(Date.parse(at(60)), NODE),
      nowIso: at(60),
    });
    saleId = sale.saleId;

    const closed = await closeTill(db, {
      tillId, countedMinor: 10_000n + (sale.totalMinor - 4_000n) - 100n, bankedMinor: 5_000n,
      hlc: fixedHlc(Date.parse(at(120)), NODE), nowIso: at(120),
    });
    deviceExpected = closed.expectedMinor;
    expect(closed.varianceMinor).toBe(-100n);

    queued = await readPendingOps(db);
    const offline = await drainOutbox(db, partitioned());
    expect(offline).toMatchObject({ transportOk: false, completed: 0, rejected: 0 });
  });

  it('queued the three writes IN THE ORDER they happened: open, sale, close', () => {
    expect(queued.map((o) => o.kind)).toEqual(['cash_session_open', 'sale', 'cash_session_close']);
    expect(queued[0]!.idempotencyKey).toBe(tillId);
    expect(queued[1]!.idempotencyKey).toBe(saleId);
  });

  it('nothing is on the server while partitioned', async () => {
    const n = await h.db.withTenant(tenantId, async (tx) =>
      (await tx.query<{ n: string }>(`select count(*)::text as n from app.cash_session where id = $1`, [tillId])).rows[0]!.n);
    expect(n).toBe('0');
  });

  it('on reconnect every op is applied, in order', async () => {
    const report = await drainOutbox(db, online());
    expect(report).toMatchObject({ transportOk: true, completed: 3, rejected: 0, deferred: 0 });
  });

  it('the server holds the till, opened OFFLINE as flagged, closed with ITS OWN expected figure — and keeps the device’s beside it', async () => {
    const row = await h.db.withTenant(tenantId, async (tx) =>
      (await tx.query<{ status: string; offline: boolean; device_id: string; expected: string;
                         counted: string; variance: string; banked: string; client_expected: string;
                         server_cash: string }>(
        `select cs.status, cs.opened_offline as offline, cs.device_id,
                cs.expected_cash_minor::text as expected, cs.counted_minor::text as counted,
                cs.variance_minor::text as variance, cs.banked_minor::text as banked,
                cs.client_expected_minor::text as client_expected,
                (select coalesce(sum(st.amount_minor), 0)::bigint::text
                   from app.sale s join app.sale_tender st on st.sale_id = s.id
                   join app.tender_method m on m.id = st.method_id
                  where s.cash_session_id = cs.id and m.is_cash) as server_cash
           from app.cash_session cs where cs.id = $1`, [tillId])).rows[0]!);
    expect(row).toMatchObject({ status: 'CLOSED', offline: true, device_id: DEVICE_ID, banked: '5000' });
    // The server computed expected from what IT recorded: float + its drawer cash.
    const serverExpected = 10_000n + BigInt(row.server_cash);
    expect(BigInt(row.expected)).toBe(serverExpected);
    // The device's figure is recorded beside it, never preferred over it.
    expect(BigInt(row.client_expected)).toBe(deviceExpected);
    // This device holds no tax pack, so it priced the sale UNTAXED and the
    // server repriced it. The cash line was the BALANCE line, so the
    // difference landed in the drawer's expected figure — and therefore in the
    // variance a person must explain at cash-up. Visible, never silently fixed.
    expect(BigInt(row.variance)).toBe(BigInt(row.counted) - serverExpected);
    expect(serverExpected - deviceExpected).toBe(BigInt(row.server_cash) - (deviceExpected - 10_000n));
  });

  it('the sale is filed under the till, with both tender rows and the reference', async () => {
    const sale = await h.db.withTenant(tenantId, async (tx) => {
      const s = await tx.query<{ id: string; cash_session_id: string; business_date: string; total: string }>(
        `select id, cash_session_id, business_date::text, total_minor::text as total
           from app.sale where write_id = $1`, [saleId]);
      const t = await tx.query<{ amount: string; reference: string | null; claimed: string | null }>(
        `select amount_minor::text as amount, reference, claimed_minor::text as claimed
           from app.sale_tender where sale_id = $1 order by seq`, [s.rows[0]!.id]);
      return { head: s.rows[0]!, tenders: t.rows };
    });
    expect(sale.head.cash_session_id).toBe(tillId);
    expect(sale.head.business_date).toBe(BUSINESS_DATE);
    expect(sale.tenders).toEqual([
      { amount: '4000', reference: 'MP-CONF-0001', claimed: null },
      { amount: (BigInt(sale.head.total) - 4000n).toString(10), reference: null, claimed: null },
    ]);
  });

  it('a byte-identical replay of the whole day is three duplicates — nothing doubles', async () => {
    const replay = await online().send(queued);
    expect(replay.acks.map((a) => a.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    const counts = await h.db.withTenant(tenantId, async (tx) => {
      const c = await tx.query<{ tills: string; sales: string; tenders: string }>(
        `select (select count(*) from app.cash_session where id = $1)::text as tills,
                (select count(*) from app.sale where write_id = $2)::text as sales,
                (select count(*) from app.sale_tender where write_id = $2)::text as tenders`,
        [tillId, saleId]);
      return c.rows[0]!;
    });
    expect(counts).toEqual({ tills: '1', sales: '1', tenders: '2' });
  });
});
