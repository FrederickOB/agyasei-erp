/**
 * D6 — THE REAL CLIENT, THE REAL SOCKET.
 *
 *   pnpm stack:up
 *   pnpm --filter @erp/wire-conformance drill:live
 *   # or, in the drill report:  pnpm --filter @erp/sync-drills drill
 *
 * `test/sale-client-to-api.test.ts` proves the same journey in one process on
 * PGlite. This proves it where it actually failed: a real HTTP request, from
 * the PWA's own transport, carrying a browser `Origin`, at the API dev server
 * on :3001, landing in the docker Postgres on :5433.
 *
 * Both exist on purpose, and neither is redundant:
 *   - the vitest suite runs on every `pnpm test`, with no docker, so drift is
 *     caught in seconds by anyone;
 *   - this one runs against the deployed stack, so it also catches the things
 *     an in-process harness cannot — CORS preflight, the dev server running
 *     stale code, seed data that does not match the contract, a migration
 *     that never ran.
 * The first bug of this class (CORS) was invisible to in-process tests. The
 * second (this one) was invisible to the drills. One of each, from now on.
 *
 * What it asserts, in order:
 *   1. a sale rung up through the PWA's real checkout is ACKED `applied`;
 *   2. the sale, its lines, its tax lines and its stock movements are in
 *      Postgres, under the token's tenant, at the device's location;
 *   3. the server's total is an exact bigint satisfying
 *      subtotal − discount + tax = total, and is NOT the till's claim;
 *   4. a byte-identical re-POST is acked `duplicate` with no second effect.
 *
 * Prints a `__DRILL_RESULT__ {json}` line so `@erp/sync-drills` D6 can fold it
 * into docs/sync-drill-report.md. Exits non-zero if any check fails.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { checkout } from '../../../apps/web/src/data/mutations/checkout';
import { openTill } from '../../../apps/web/src/data/mutations/till';
import { addProductToCart, createCart } from '../../../apps/web/src/data/mutations/cart';
import { httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { readPendingOps } from '../../../apps/web/src/data/sync/upload';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import type { LocalDb } from '../../../apps/web/src/data/db';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import {
  fixedHlc,
  provisionDevice,
  replaceTenderMethods,
  seedProduct,
} from '../../../apps/web/tests/helpers/fixtures';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API_URL = process.env['API_URL'] ?? 'http://localhost:3001';
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://erp:erp_dev@localhost:5433/erp';
/** The origin the PWA is served from in dev. A Node sync client has none. */
const PWA_ORIGIN = process.env['PWA_ORIGIN'] ?? 'http://localhost:5173';
/** The till's local unit price, deliberately wrong — see check 3. */
const DEVICE_UNIT_PRICE_E4 = 99_000_000n;

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
const measurements: string[] = [];

function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
}
function measure(line: string): void {
  measurements.push(line);
  console.log(`  [measure] ${line}`);
}

function devToken(): string {
  return execFileSync('node', [path.join(REPO_ROOT, 'infra/scripts/dev-token.mjs')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

/** Claims the API verified — the tenant and location the token, not us, names. */
function claimsOf(token: string): { tid: string; locs: string[] } {
  const payload = token.split('.')[1];
  if (payload === undefined) throw new Error('malformed dev token');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tid: string;
    locs?: string[];
  };
  return { tid: decoded.tid, locs: decoded.locs ?? [] };
}

/** Real `fetch`, plus the header a browser would send. */
const browserFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: { ...init.headers, origin: PWA_ORIGIN },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const shaped: HttpResponseLike = {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
  };
  return shaped;
};

async function main(): Promise<void> {
  console.log('=== D6 — the PWA\'s own payload, over a real socket, into real Postgres ===');

  const token = devToken();
  const { tid: tenantId, locs } = claimsOf(token);
  const locationId = locs[0];
  if (locationId === undefined) throw new Error('dev token carries no location scope');

  const sql = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  /** Read under the tenant's own RLS context, exactly as the API does. */
  const scoped = async <R extends pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<R[]> => {
    const client = await sql.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_user');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const res = await client.query<R>(text, params);
      await client.query('commit');
      return res.rows;
    } finally {
      client.release();
    }
  };

  try {
    // ---- what the device is supposed to know -----------------------------
    const [loc] = await scoped<{ code: string }>(
      `select code from app.location where id = $1 and deleted_at is null`,
      [locationId],
    );
    if (loc === undefined) throw new Error('the token names a location that does not exist');
    // THE TAX-EXCLUSIVE LIST, ON PURPOSE — and no longer for the old reason.
    // This filter used to be the only way a drill could ring anything: the
    // best-ranked list was tax-inclusive and neither side could price one. That
    // is fixed, and D17 (`drill:inclusive`) rings the counter's REAL default,
    // inclusive, on tenant #1's own configuration. This drill keeps the
    // exclusive list so the two directions of §4.13 are both exercised live —
    // compose tax onto a net here, de-gross a shelf price there. `priority desc`
    // picks the worst-ranked list deliberately: it is the one a counter would
    // NOT resolve, which keeps this drill and D17 on different data.
    const [list] = await scoped<{ code: string; id: string }>(
      `select id, code from app.price_list
        where deleted_at is null and is_tax_inclusive = false
        order by priority desc, code limit 1`,
    );
    if (list === undefined) throw new Error('no tax-exclusive price list — run pnpm stack:reset');
    const [prod] = await scoped<{ id: string; sku_code: string; uom_code: string; qty_scale: number }>(
      `select p.id, p.sku_code, u.code as uom_code, u.qty_scale
         from app.product p
         join app.product_uom pu on pu.tenant_id = p.tenant_id and pu.product_id = p.id
                                and pu.is_default_sell and pu.deleted_at is null
         join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = pu.uom_id
         join app.price_list_item i on i.tenant_id = p.tenant_id and i.product_id = p.id
                                   and i.price_list_id = $1 and i.uom_id = pu.uom_id
                                   and i.deleted_at is null
        where p.deleted_at is null and p.is_sellable and p.stock_tracking = 'STOCKED'
          and u.qty_scale = 0
        order by p.sku_code limit 1`,
      [list.id],
    );
    if (prod === undefined) {
      throw new Error(`no priced, stocked product on list ${list.code} — run pnpm stack:reset`);
    }
    measure(`tenant ${tenantId} · location ${loc.code} · list ${list.code} · sku ${prod.sku_code}`);

    // ---- the device: real local SQLite, real cart, real checkout ----------
    //
    // A FRESH device node per run, and it is not cosmetic. Every run opens an
    // empty local database, so the till self-issues a block starting at 1 and
    // prints receipt 000001 again; §3.7.5 makes cross-device disjointness the
    // formatter's job, and the device tag is what carries it. With a fixed
    // node the second run collides on `sale_receipt_uq` — see the receipt-
    // regression gap recorded in docs/phase1-status.md, which is the real
    // §3.9 "wipe a device's local DB mid-block" drill and does NOT yet pass.
    const deviceNode = randomBytes(16).toString('hex');
    const nowIso = new Date().toISOString();
    const db: LocalDb = openTestDb();
    const device = await provisionDevice(db, {
      locationId,
      locationCode: loc.code,
      priceListCode: list.code,
      till: false,
    });
    // The tenant's REAL tender methods (the reference bucket's rows), and a
    // till opened through the PWA's own path: no sale without one (08 §8.2a).
    // SHARED, so a re-run on the same day lands as a #17 contested claim
    // rather than failing — the drill is about the sale, not the till.
    const methods = await scoped<{
      id: string; name: string; posting_role: string; is_cash: boolean;
      is_on_account: boolean; requires_reference: boolean; sort_order: number;
    }>(
      `select id, name, posting_role, is_cash, is_on_account, requires_reference, sort_order
         from app.tender_method where is_active and deleted_at is null`,
    );
    await replaceTenderMethods(db, methods.map((m) => ({
      id: m.id, name: m.name, postingRole: m.posting_role, isCash: m.is_cash,
      isOnAccount: m.is_on_account, requiresReference: m.requires_reference, sortOrder: m.sort_order,
    })));
    await openTill(db, {
      openingFloatMinor: 0n,
      businessDate: nowIso.slice(0, 10),
      openedOffline: false,
      drawer: 'SHARED',
      hlc: fixedHlc(Date.parse(nowIso) - 1_000, deviceNode),
      nowIso,
    });
    const product = await seedProduct(db, {
      id: prod.id,
      code: prod.sku_code,
      name: 'D6 line',
      uomLabel: prod.uom_code,
      qtyScale: prod.qty_scale,
      // Wrong on purpose: a till four days offline holds a price list that
      // may have moved, and its arithmetic is a claim (CLAUDE.md §2.5).
      unitPriceE4: DEVICE_UNIT_PRICE_E4,
      priceListId: device.priceListId,
    });
    const cartId = await createCart(db, { nowIso });
    for (let i = 0; i < 3; i += 1) await addProductToCart(db, cartId, product);
    const sale = await checkout(db, {
      cartId,
      tenderedMinor: 1_000_000_000n,
      hlc: fixedHlc(Date.parse(nowIso), deviceNode),
      nowIso,
    });
    measure(`receipt ${sale.receiptNo} · till claimed ${sale.totalMinor.toString()} minor units`);

    // ---- the wire: does a BROWSER get to make this request at all? -------
    //
    // Bug #1 of this class. Every drill device is `@powersync/node`, which has
    // no origin, so nothing here had ever sent a cross-origin request and CORS
    // was broken in production against a green 5/5. This is the preflight the
    // browser actually sends for `httpUploadTransport`'s request: POST, with
    // `authorization` and `content-type`, from the PWA's origin.
    const preflight = await fetch(`${API_URL}/sync/upload`, {
      method: 'OPTIONS',
      headers: {
        origin: PWA_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    const allowOrigin = preflight.headers.get('access-control-allow-origin');
    const allowHeaders = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    check(
      'the browser preflight for this exact request is approved',
      preflight.status < 300 &&
        allowOrigin === PWA_ORIGIN &&
        (preflight.headers.get('access-control-allow-methods') ?? '').includes('POST') &&
        allowHeaders.includes('authorization') &&
        allowHeaders.includes('content-type'),
      `status=${preflight.status} allow-origin=${String(allowOrigin)} ` +
        `allow-methods=${String(preflight.headers.get('access-control-allow-methods'))} ` +
        `allow-headers=${String(preflight.headers.get('access-control-allow-headers'))}`,
    );
    const foreign = await fetch(`${API_URL}/sync/upload`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    });
    check(
      'an arbitrary origin is NOT admitted (the bearer is tenant identity)',
      foreign.headers.get('access-control-allow-origin') === null,
      `allow-origin=${String(foreign.headers.get('access-control-allow-origin'))}`,
    );

    // ---- the wire: the PWA's own transport, real HTTP, browser Origin ----
    const transport = httpUploadTransport({
      apiUrl: API_URL,
      apiToken: token,
      fetchFn: browserFetch,
    });
    const ops = await readPendingOps(db);
    const t0 = performance.now();
    const first = await transport.send(ops);
    const elapsedMs = performance.now() - t0; // lint-money-ignore — milliseconds, not minor units
    measure(`POST ${API_URL}/sync/upload from origin ${PWA_ORIGIN}: ${elapsedMs.toFixed(0)}ms`);

    check(
      'the batch was delivered and answered (CORS, auth, envelope)',
      first.ok,
      `ok=${String(first.ok)} status=${String(first.status)}`,
    );
    const ack = first.acks.find((a) => a.key === sale.saleId);
    check(
      "the PWA's own sale payload is ACKED APPLIED, not rejected",
      ack?.status === 'applied',
      `ack=${JSON.stringify(ack ?? null)}`,
    );

    // ---- the server: did it actually land? -------------------------------
    const saleRows = await scoped<{
      id: string;
      location_id: string;
      business_date: string;
      subtotal_net_minor: string;
      discount_minor: string;
      tax_total_minor: string;
      total_minor: string;
    }>(
      `select id, location_id, business_date::text, subtotal_net_minor::text,
              discount_minor::text, tax_total_minor::text, total_minor::text
         from app.sale where receipt_no = $1`,
      [sale.receiptNo],
    );
    check('exactly one sale row landed', saleRows.length === 1, `rows=${saleRows.length}`);
    const row = saleRows[0];
    if (row === undefined) throw new Error('no sale row — nothing further can be asserted');

    check(
      'it is filed against the device location the token scopes',
      row.location_id === locationId,
      `${row.location_id} vs ${locationId}`,
    );

    const [lineCount] = await scoped<{ n: string }>(
      `select count(*)::text as n from app.sale_line where sale_id = $1`,
      [row.id],
    );
    check('the sale line landed', lineCount?.n === '1', `sale_line rows=${lineCount?.n ?? '0'}`);

    const [taxCount] = await scoped<{ n: string }>(
      `select count(*)::text as n from app.sale_tax_line where sale_id = $1`,
      [row.id],
    );
    check(
      'tax lines landed (the pack rates in force on the business date)',
      Number(taxCount?.n ?? '0') > 0,
      `sale_tax_line rows=${taxCount?.n ?? '0'}`,
    );

    const movements = await scoped<{ qty_delta: string; source_kind: string }>(
      `select qty_delta::text, source_kind from app.stock_movement where source_id = $1`,
      [row.id],
    );
    check(
      'the stock movement landed, signed for an outflow',
      movements.length === 1 && BigInt(movements[0]?.qty_delta ?? '0') === -3n,
      `movements=${JSON.stringify(movements)}`,
    );

    // ---- the money -------------------------------------------------------
    const subtotal = BigInt(row.subtotal_net_minor);
    const discount = BigInt(row.discount_minor);
    const tax = BigInt(row.tax_total_minor);
    const total = BigInt(row.total_minor);
    check(
      'the total is an exact bigint identity: subtotal − discount + tax',
      total === subtotal - discount + tax,
      `${total.toString()} = ${subtotal.toString()} − ${discount.toString()} + ${tax.toString()}`,
    );
    check(
      'tax is non-zero and positive',
      tax > 0n,
      `tax_total_minor=${tax.toString()}`,
    );
    check(
      "the SERVER priced it — the till's claim is not what was written",
      total !== sale.totalMinor,
      `server=${total.toString()} till=${sale.totalMinor.toString()}`,
    );

    const [logged] = await scoped<{ response_body: Record<string, unknown> | null }>(
      `select response_body from app.write_log where id = $1`,
      [sale.saleId],
    );
    const priceCheck = (logged?.response_body?.['priceCheck'] ?? null) as Record<
      string,
      unknown
    > | null;
    check(
      'the divergence is REPORTED back, not swallowed',
      priceCheck !== null &&
        priceCheck['matches'] === false &&
        typeof priceCheck['serverTotalMinor'] === 'string',
      `priceCheck=${JSON.stringify(priceCheck)}`,
    );

    // ---- replay ----------------------------------------------------------
    const second = await transport.send(ops);
    const ack2 = second.acks.find((a) => a.key === sale.saleId);
    check(
      'a byte-identical re-POST is acked duplicate',
      ack2?.status === 'duplicate',
      `ack=${JSON.stringify(ack2 ?? null)}`,
    );
    const afterReplay = await scoped<{ n: string }>(
      `select count(*)::text as n from app.sale where receipt_no = $1`,
      [sale.receiptNo],
    );
    check(
      'the replay produced NO second effect',
      afterReplay[0]?.n === '1',
      `sale rows after replay=${afterReplay[0]?.n ?? '?'}`,
    );
    const movementsAfter = await scoped<{ n: string }>(
      `select count(*)::text as n from app.stock_movement where source_id = $1`,
      [row.id],
    );
    check(
      'and no second stock movement',
      movementsAfter[0]?.n === '1',
      `stock_movement rows after replay=${movementsAfter[0]?.n ?? '?'}`,
    );
  } finally {
    await sql.end();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(
    `\n=== D6: ${checks.length - failed.length}/${checks.length} checks passed ===`,
  );
  console.log(`__DRILL_RESULT__ ${JSON.stringify({ checks, measurements })}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error('D6 aborted:', message);
  console.log(
    `__DRILL_RESULT__ ${JSON.stringify({ checks, measurements, error: message })}`,
  );
  process.exit(1);
});
