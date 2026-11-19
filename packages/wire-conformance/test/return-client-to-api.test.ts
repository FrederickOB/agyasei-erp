/**
 * VOIDS AND RETURNS, CLIENT → SERVER — the PWA's own builders against the API's
 * own parser and pipeline, for the new uploadable kind `sale.return`
 * (migration 0030). Shaped like till-client-to-api.test.ts, for the same class
 * of bug: a device payload only one side has ever seen.
 *
 *   client  apps/web's real local SQLite: openTill → checkout → recordVoid
 *           (the sale NOT yet synced — the void names it by its own key), all
 *           queued under a REAL partition and drained in order on reconnect;
 *           then, with the server's rows synced down, recordReturn priced on
 *           the device from those rows.
 *   server  apps/api's real routes, routers and idempotent pipeline on a real
 *           Postgres with RLS on.
 *
 * What it proves:
 *   1. a void queued offline behind the sale it voids lands AFTER it, and the
 *      server reverses exactly what IT recorded;
 *   2. the device's return price — computed from the synced snapshot by the
 *      same rule — is the server's, to the minor unit (no reconciliation
 *      review opens);
 *   3. a byte-identical replay of everything is duplicates: one void, one
 *      return, one refund each, no second restock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSaleReturnInput, deviceOpContracts } from '@erp/contracts';

import { signDevToken } from '../../../apps/api/src/auth.js';
import { appRouter } from '../../../apps/api/src/routers/index.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from '../../../apps/api/test/util.js';

import type { LocalDb } from '../../../apps/web/src/data/db';
import { addProductToCart, createCart } from '../../../apps/web/src/data/mutations/cart';
import { checkout } from '../../../apps/web/src/data/mutations/checkout';
import { recordReturn, recordVoid } from '../../../apps/web/src/data/mutations/saleReturn';
import { openTill } from '../../../apps/web/src/data/mutations/till';
import { loadActiveProducts } from '../../../apps/web/src/data/queries/products';
import { loadTenderMethods } from '../../../apps/web/src/data/queries/tender-methods';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import { httpUploadTransport, WIRE_KINDS } from '../../../apps/web/src/data/sync/transport';
import { drainOutbox, readPendingOps, type PendingOp } from '../../../apps/web/src/data/sync/upload';
import { fixedHlc, provisionDevice, replaceTenderMethods, seedProduct } from '../../../apps/web/tests/helpers/fixtures';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';

const PWA_ORIGIN = 'http://localhost:5173';
const NODE = 'e2'.repeat(16);
const BASE_MS = Date.now();
const at = (offsetS: number): string => new Date(BASE_MS + offsetS * 1_000).toISOString();
const BUSINESS_DATE = at(0).slice(0, 10);
const DEVICE_ID = '018f3a1e-0000-7000-8000-0000000000e1';

type Server = Awaited<ReturnType<typeof buildServer>>;
let h: ApiHarness;
let app: Server;
let tenantId: string;
let outlet: { id: string; code: string };
let product: { id: string; skuCode: string; uomCode: string; qtyScale: number };
let bearer: string;

const browserFetch: FetchLike = async (url, init) => {
  const res = await app.inject({
    method: (init.method as 'GET' | 'POST') ?? 'GET',
    url: new URL(url, 'http://api.local').pathname,
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
  httpUploadTransport({ apiUrl: 'http://api.local', apiToken: bearer, fetchFn: () => Promise.reject(new Error('network unreachable')) });

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return h.db.withTenant(tenantId, async (tx) => (await tx.query<T>(sql, params)).rows);
}

/** Copy one server sale's rows into the device, as the sync buckets would deliver them. */
/** One column as a SQLite bind value — a missing key is NULL, never undefined. */
const v = (row: Record<string, unknown>, k: string): string | number | null => (row[k] ?? null) as string | number | null;

async function syncDown(db: LocalDb, key: string): Promise<void> {
  const [s] = await q<Record<string, string | null>>(
    `select id, write_id, location_id, receipt_no, business_date::text, cash_session_id, price_list_id, customer_id,
            currency_code, money_scale::text, subtotal_net_minor::text, discount_minor::text,
            tax_total_minor::text, total_minor::text
       from app.sale where write_id = $1`, [key]);
  await db.execute(
    `INSERT INTO sale (id, write_id, location_id, receipt_no, business_date, cash_session_id, price_list_id, customer_id,
                       currency_code, money_scale, subtotal_net_minor, discount_minor, tax_total_minor, total_minor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER))`,
    [v(s!, 'id'), v(s!, 'write_id'), v(s!, 'location_id'), v(s!, 'receipt_no'), v(s!, 'business_date'), v(s!, 'cash_session_id'), v(s!, 'price_list_id'),
     v(s!, 'customer_id'), v(s!, 'currency_code'), v(s!, 'money_scale'), v(s!, 'subtotal_net_minor'), v(s!, 'discount_minor'),
     v(s!, 'tax_total_minor'), v(s!, 'total_minor')],
  );
  for (const l of await q<Record<string, string | number>>(
    `select id, sale_id, line_no, product_id, selling_uom_id, qty_sell::text, qty_sell_scale, unit_price_e4::text,
            stocking_uom_id, qty_stock::text, qty_stock_scale, line_discount_minor::text, line_net_minor::text, tax_minor::text
       from app.sale_line where sale_id = $1`, [v(s!, 'id')])) {
    await db.execute(
      `INSERT INTO sale_line (id, sale_id, line_no, product_id, selling_uom_id, qty_sell, qty_sell_scale, unit_price_e4,
                              stocking_uom_id, qty_stock, qty_stock_scale, line_discount_minor, line_net_minor, tax_minor)
       VALUES (?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, CAST(? AS INTEGER), ?, CAST(? AS INTEGER), ?, CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER))`,
      [v(l, 'id'), v(l, 'sale_id'), v(l, 'line_no'), v(l, 'product_id'), v(l, 'selling_uom_id'), v(l, 'qty_sell'), v(l, 'qty_sell_scale'),
       v(l, 'unit_price_e4'), v(l, 'stocking_uom_id'), v(l, 'qty_stock'), v(l, 'qty_stock_scale'), v(l, 'line_discount_minor'),
       v(l, 'line_net_minor'), v(l, 'tax_minor')],
    );
  }
  for (const t of await q<Record<string, string | number>>(
    `select id, sale_id, sale_line_id, seq, tax_code, rate_bp, base_minor::text, tax_minor::text, tax_rate_id
       from app.sale_tax_line where sale_id = $1`, [v(s!, 'id')])) {
    await db.execute(
      `INSERT INTO sale_tax_line (id, sale_id, sale_line_id, seq, tax_code, rate_bp, base_minor, tax_minor, tax_rate_id)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), ?)`,
      [v(t, 'id'), v(t, 'sale_id'), v(t, 'sale_line_id'), v(t, 'seq'), v(t, 'tax_code'), v(t, 'rate_bp'), v(t, 'base_minor'), v(t, 'tax_minor'), v(t, 'tax_rate_id')],
    );
  }
  for (const t of await q<Record<string, string | number>>(
    `select id, sale_id, seq, method_id, amount_minor::text, location_id from app.sale_tender where sale_id = $1`, [v(s!, 'id')])) {
    await db.execute(
      `INSERT INTO sale_tender (id, sale_id, seq, method_id, amount_minor, location_id) VALUES (?, ?, ?, ?, CAST(? AS INTEGER), ?)`,
      [v(t, 'id'), v(t, 'sale_id'), v(t, 'seq'), v(t, 'method_id'), v(t, 'amount_minor'), v(t, 'location_id')],
    );
  }
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('return-conformance');
  await h.applyTemplate(tenantId, true);
  outlet = await h.firstOutlet(tenantId);
  const picked = await h.pickProduct(tenantId);
  product = { id: picked.id, skuCode: picked.skuCode, uomCode: picked.uomCode, qtyScale: picked.qtyScale };
  await h.seedWholesalePrice(tenantId, product.id, 25_000_000n);
  const uid = '018f3a1e-0000-7000-8000-0000000000e2';
  await h.grantOwner(tenantId, uid);
  bearer = await signDevToken(JWT_SECRET, { tid: tenantId, uid, role: 'x', locs: [outlet.id], dev: DEVICE_ID });
  app = await buildServer({
    deps: h.deps, jwtSecret: JWT_SECRET, sync: { powersyncUrl: 'http://localhost:8080' }, corsOrigins: [PWA_ORIGIN],
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe('the router validates sale.return with the shared contract', () => {
  it('returns.record parses with the registered schema object', () => {
    const inputOf = (p: unknown) => (p as { _def: { inputs: unknown[] } })._def.inputs[0];
    expect(inputOf(appRouter.returns.record)).toBe(createSaleReturnInput);
    expect(deviceOpContracts['sale.return']).toBe(createSaleReturnInput);
    expect(WIRE_KINDS['sale_return']).toBe('sale.return');
  });
});

describe('a sale voided offline, then a return priced on the device from synced rows', () => {
  let db: LocalDb;
  let tillId: string;
  let firstSale: string;
  let voidId: string;
  let queued: PendingOp[];

  beforeAll(async () => {
    db = openTestDb();
    const device = await provisionDevice(db, {
      locationId: outlet.id, locationCode: outlet.code, priceListCode: 'WHOLESALE', till: false,
    });
    await seedProduct(db, {
      id: product.id, code: product.skuCode, name: 'Return product', uomLabel: product.uomCode,
      qtyScale: product.qtyScale, unitPriceE4: 25_000_000n, priceListId: device.priceListId,
    });
    const methods = await h.db.withTenant(tenantId, async (tx) =>
      (await tx.query<{ id: string; name: string; posting_role: string; is_cash: boolean; is_on_account: boolean;
                         requires_reference: boolean; sort_order: number }>(
        `select id, name, posting_role, is_cash, is_on_account, requires_reference, sort_order
           from app.tender_method where is_active and deleted_at is null`)).rows);
    await replaceTenderMethods(db, methods.map((m) => ({
      id: m.id, name: m.name, postingRole: m.posting_role, isCash: m.is_cash, isOnAccount: m.is_on_account,
      requiresReference: m.requires_reference, sortOrder: m.sort_order,
    })));

    const till = await openTill(db, {
      openingFloatMinor: 10_000n, businessDate: BUSINESS_DATE, openedOffline: true,
      hlc: fixedHlc(Date.parse(at(0)), NODE), nowIso: at(0),
    });
    tillId = till.id;
    const cartId = await createCart(db, { nowIso: at(30) });
    const row = (await loadActiveProducts(db, at(30))).find((p) => p.id === product.id)!;
    await addProductToCart(db, cartId, row);
    await addProductToCart(db, cartId, row);
    const sale = await checkout(db, { cartId, hlc: fixedHlc(Date.parse(at(30)), NODE), nowIso: at(30) });
    firstSale = sale.saleId;
    const v = await recordVoid(db, { saleKey: firstSale, reason: 'Rung in error', hlc: fixedHlc(Date.parse(at(60)), NODE), nowIso: at(60) });
    voidId = v.returnId;

    queued = await readPendingOps(db);
    const offline = await drainOutbox(db, partitioned());
    expect(offline).toMatchObject({ transportOk: false, completed: 0 });
  });

  it('queued open, sale, void — in the order they happened', () => {
    expect(queued.map((o) => o.kind)).toEqual(['cash_session_open', 'sale', 'sale_return']);
    expect(queued[2]!.idempotencyKey).toBe(voidId);
  });

  it('on reconnect every op applies in order, and the void reverses what the SERVER recorded', async () => {
    const report = await drainOutbox(db, online());
    expect(report).toMatchObject({ transportOk: true, completed: 3, rejected: 0, deferred: 0 });
    const [sale] = await q<{ id: string; total: string }>(`select id, total_minor::text as total from app.sale where write_id = $1`, [firstSale]);
    const [ret] = await q<{ kind: string; original: string; total: string; session: string }>(
      `select kind, original_sale_id as original, total_minor::text as total, cash_session_id as session
         from app.sale_return where id = $1`, [voidId]);
    expect(ret).toEqual({ kind: 'VOID', original: sale!.id, total: sale!.total, session: tillId });
    const [net] = await q<{ n: string }>(
      `select coalesce(sum(qty_delta), 0)::text n from app.stock_movement where source_id = any($1::uuid[])`, [[sale!.id, voidId]]);
    expect(net!.n).toBe('0');
  });

  it('a return priced on the device from synced rows is the server’s figure, to the minor unit', async () => {
    const cartId = await createCart(db, { nowIso: at(90) });
    const row = (await loadActiveProducts(db, at(90))).find((p) => p.id === product.id)!;
    for (let i = 0; i < 3; i += 1) await addProductToCart(db, cartId, row);
    const second = await checkout(db, { cartId, hlc: fixedHlc(Date.parse(at(90)), NODE), nowIso: at(90) });
    expect((await drainOutbox(db, online())).completed).toBe(1);
    await syncDown(db, second.saleId);

    const cash = (await loadTenderMethods(db)).find((m) => m.isCash)!;
    const r = await recordReturn(db, {
      saleKey: second.saleId, reason: 'Changed mind', hlc: fixedHlc(Date.parse(at(120)), NODE), nowIso: at(120),
      method: cash, picks: [{ lineNo: 1, qty: 1n, disposition: 'RESTOCK' }],
    });
    expect((await drainOutbox(db, online())).completed).toBe(1);
    const [server] = await q<{ total: string; reviews: string }>(
      `select r.total_minor::text as total,
              (select count(*) from app.conflict_review cr where cr.entity_id = r.id)::text as reviews
         from app.sale_return r where r.id = $1`, [r.returnId]);
    expect(server).toEqual({ total: r.totalMinor.toString(), reviews: '0' });
  });

  it('a byte-identical replay of everything is duplicates — no second void, refund or restock', async () => {
    const before = await q<{ n: string }>(`select count(*)::text n from app.stock_movement`);
    const replay = await online().send(queued);
    expect(replay.acks.map((a) => a.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(await q(`select count(*)::text n from app.stock_movement`)).toEqual(before);
    const [counts] = await q<{ voids: string; refunds: string }>(
      `select (select count(*) from app.sale_return where id = $1)::text voids,
              (select count(*) from app.sale_return_refund where return_id = $1)::text refunds`, [voidId]);
    expect(counts).toEqual({ voids: '1', refunds: '1' });
  });
});
