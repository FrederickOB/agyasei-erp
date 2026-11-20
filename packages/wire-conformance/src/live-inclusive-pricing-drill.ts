/**
 * D17 — CAN TENANT #1 RING A RETAIL SALE ON THEIR OWN CONFIGURATION?
 *
 *   pnpm stack:reset && pnpm dev:api
 *   pnpm --filter @erp/wire-conformance drill:inclusive
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS DRILL EXISTS, AND WHY NO EXISTING ONE COULD ANSWER THE QUESTION
 * ═══════════════════════════════════════════════════════════════════════════
 * Tenant #1's best-ranked price list is `RETAIL`, `is_tax_inclusive = true` —
 * a Ghanaian shelf price, tax included, which is what a walk-in customer
 * actually hands over. Until this pass neither side could price it: the API
 * answered `PRECONDITION_FAILED: tax-inclusive price lists are not yet
 * supported` and the counter had no extraction path either, so it refused at
 * the till rather than falling through to the trade list.
 *
 * Every live drill was nevertheless green, because `infra/scripts/dev-prices.ts`
 * flipped the list to tax-EXCLUSIVE on every `pnpm stack:reset`. The dev stack
 * was the only place in the world running that configuration. **That flip is
 * deleted**, and this drill is the check that it stays deleted: A1 fails loudly
 * if anything makes tenant #1's counter list exclusive again.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INVARIANT UNDER TEST
 * ═══════════════════════════════════════════════════════════════════════════
 *     net + Σ(tax lines) === gross, EXACTLY, for every input
 * and, on an undiscounted sale, gross === shelf price × quantity. Not to a
 * tolerance: a shelf price is what the customer hands over, so if the parts do
 * not sum to it either the customer is short-changed or the books do not
 * reconcile. Every figure below is re-derived by THIS FILE in SQL and compared
 * to the API's, never taken from the API's own arithmetic.
 *
 * Extraction must invert whatever composition the pack declares. Ghana's
 * current regime puts NHIL, GETFund and VAT all on the net (20% of net); the
 * regime that lapsed on 2026-01-01 cascaded — levies on net, VAT on
 * net + levies — for an effective 21.9%, with NO rate changing. Part C rings
 * a sale dated into the old window and proves the server priced it against the
 * rows in force THEN, from data, not from a constant (ADR-0002, ADR-0007).
 *
 * What it asserts, in order:
 *   A. tenant #1's real configuration, read from Postgres: RETAIL is the
 *      best-ranked list in force and it is tax-INCLUSIVE.
 *   B. the device BINDS that list through `apps/web`'s own reconciliation
 *      (it previously refused), rings a sale through the PWA's own checkout
 *      and transport over real HTTP, and is acked `applied`.
 *   C. the customer pays the shelf price: total === shelf × qty, and
 *      net − discount + Σ(sale_tax_line) === total, both checked in SQL.
 *   D. the client's local total equals the server's, to the minor unit.
 *   E. a sale dated before the rate change is priced by the OLD composition.
 *   F. every read this drill touches is swept for a superjson `meta` envelope.
 *
 * Prints `__DRILL_RESULT__ {json}`. Exits non-zero if any check fails.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { createHlcClock, deterministicUuid, hlcNodeFromName, sha256Hex } from '@erp/db';

import { addProductToCart, createCart } from '../../../apps/web/src/data/mutations/cart';
import { checkout } from '../../../apps/web/src/data/mutations/checkout';
import { closeTill, openTill, readOpenTill, tillExpectedCash } from '../../../apps/web/src/data/mutations/till';
import { getCartLines, getOpenCart } from '../../../apps/web/src/data/queries/cart';
import { priceCart } from '../../../apps/web/src/data/pricing/cart-pricing';
import { readPricingBasis } from '../../../apps/web/src/data/pricing/cart-basis';
import { readTaxComponentsInForce } from '../../../apps/web/src/data/pricing/tax-components';
import {
  blocksSales,
  reconcileDevicePriceList,
} from '../../../apps/web/src/data/session/device-price-list';
import { httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { readPendingOps } from '../../../apps/web/src/data/sync/upload';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import type { LocalDb } from '../../../apps/web/src/data/db';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import { fixedHlc, replaceTenderMethods } from '../../../apps/web/tests/helpers/fixtures';
import {
  CONFIG_KEY_LOCATION_CODE,
  CONFIG_KEY_LOCATION_ID,
} from '../../../apps/web/src/data/queries/session';
import { uuidv7 } from '../../../apps/web/src/lib/uuidv7';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API_URL = process.env['API_URL'] ?? 'http://localhost:3001';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://erp:erp_dev@localhost:5433/erp';
const PWA_ORIGIN = process.env['PWA_ORIGIN'] ?? 'http://localhost:5173';

/** Quantity rung, in whole selling units. Three of them, so the extension is
 *  not accidentally equal to the unit price and a per-unit bug can hide. */
const QTY = 3n;

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

function devToken(role = 'counter_staff'): string {
  return execFileSync(
    'node',
    [path.join(REPO_ROOT, 'infra/scripts/dev-token.mjs'), '--role', role],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ).trim();
}

function claimsOf(token: string): { tid: string; locs: string[] } {
  const part = token.split('.')[1] ?? '';
  const raw = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
    tid: string;
    locs?: string[];
  };
  return { tid: raw.tid, locs: raw.locs ?? [] };
}

/** The browser's fetch, with the PWA's origin — the transport's own seam. */
const browserFetch: FetchLike = async (url, init) => {
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  headers.set('origin', PWA_ORIGIN);
  const res = await fetch(url, { ...init, headers });
  const shaped: HttpResponseLike = {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
  };
  return shaped;
};

/** Ledger row 16's signature: a superjson `meta` sibling next to a `json` key. */
function metaKeysIn(body: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${at}[${i}]`));
      return;
    }
    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'meta' && Object.prototype.hasOwnProperty.call(rec, 'json')) found.push(`${at}.meta`);
      walk(v, `${at}.${k}`);
    }
  };
  walk(body, '$');
  return found;
}

async function rawQuery(
  route: string,
  input: unknown,
  bearer: string,
): Promise<{ status: number; body: unknown }> {
  const url = `${API_URL}/trpc/${route}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${bearer}`, origin: PWA_ORIGIN },
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

// ---------------------------------------------------------------------------
// The device, seeded from the SERVER'S OWN ROWS
// ---------------------------------------------------------------------------
//
// Every row below is copied out of Postgres, not invented: the location, both
// of the tenant's price lists with their real ids, codes, rankings, effective
// windows and `is_tax_inclusive` flags, the jurisdiction pack's `tax_rate`
// rows, and one product with its RETAIL shelf price. That is exactly what the
// `jurisdiction_pack`, `tenant_reference` and `location_ops` sync buckets
// deliver. A fixture that made its own numbers up would agree with nothing.
//
// What is deliberately NOT seeded is `local_config`'s active price list: the
// device is left unbound so that PART B drives the real reconciliation and the
// binding is a RESULT rather than a setup step.

interface ServerPriceList {
  id: string;
  code: string;
  name: string;
  is_tax_inclusive: boolean;
  priority: number;
  location_id: string | null;
  effective_from: string;
  effective_to: string | null;
}

interface ServerTaxRate {
  jurisdiction_code: string;
  tax_code: string;
  rate_bp: string;
  base_kind: string;
  base_includes: string;
  rounding_level: string;
  rounding_mode: string;
  effective: string;
}

interface ServerProduct {
  id: string;
  sku_code: string;
  name: string;
  uom_id: string;
  uom_code: string;
  qty_scale: number;
  unit_price_e4: string;
}

async function seedDeviceFromServer(
  db: LocalDb,
  opts: {
    locationId: string;
    locationCode: string;
    timeZone: string;
    lists: readonly ServerPriceList[];
    rates: readonly ServerTaxRate[];
    product: ServerProduct;
    priceListId: string;
  },
): Promise<void> {
  await db.execute(
    `INSERT INTO location (id, tenant_id, code, name, kind, location_type_id, parent_id,
                           is_active, timezone, hlc, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, 1, ?, NULL, NULL)`,
    [opts.locationId, 'T', opts.locationCode, opts.locationCode, opts.timeZone],
  );
  await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
    uuidv7(),
    CONFIG_KEY_LOCATION_ID,
    opts.locationId,
  ]);
  await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
    uuidv7(),
    CONFIG_KEY_LOCATION_CODE,
    opts.locationCode,
  ]);

  for (const l of opts.lists) {
    await db.execute(
      `INSERT INTO price_list (id, tenant_id, code, name, is_tax_inclusive, currency_code,
                               priority, location_id, effective_from, effective_to, hlc, updated_at)
       VALUES (?, ?, ?, ?, CAST(? AS INTEGER), 'GHS', CAST(? AS INTEGER), ?, ?, ?, NULL, NULL)`,
      [
        l.id,
        'T',
        l.code,
        l.name,
        l.is_tax_inclusive ? 1 : 0,
        l.priority,
        l.location_id,
        l.effective_from,
        l.effective_to,
      ],
    );
  }

  for (const r of opts.rates) {
    await db.execute(
      `INSERT INTO tax_rate (id, jurisdiction_code, tax_code, rate_bp, base_kind, base_includes,
                             rounding_level, rounding_mode, effective, legal_reference,
                             confirmed_by, confirmed_at)
       VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [
        uuidv7(),
        r.jurisdiction_code,
        r.tax_code,
        r.rate_bp,
        r.base_kind,
        r.base_includes,
        r.rounding_level,
        r.rounding_mode,
        r.effective,
      ],
    );
  }

  const p = opts.product;
  await db.execute(
    `INSERT INTO unit_of_measure (id, tenant_id, code, name, dimension, qty_scale, hlc, updated_at)
     VALUES (?, ?, ?, ?, NULL, CAST(? AS INTEGER), NULL, NULL)`,
    [p.uom_id, 'T', p.uom_code, p.uom_code, p.qty_scale],
  );
  await db.execute(
    `INSERT INTO product (id, tenant_id, sku_code, name, aliases, category_id, stocking_uom_id,
                          tax_code, stock_tracking, is_sellable, is_purchasable, hlc, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, 'STOCKED', 1, 1, NULL, NULL)`,
    [p.id, 'T', p.sku_code, p.name, p.uom_id],
  );
  await db.execute(
    `INSERT INTO product_uom (id, tenant_id, product_id, uom_id, factor_num, factor_den,
                              can_sell, can_buy, is_default_sell, tolerance_bp, sort_order,
                              hlc, updated_at)
     VALUES (?, ?, ?, ?, 1, 1, 1, 1, 1, 0, 0, NULL, NULL)`,
    [uuidv7(), 'T', p.id, p.uom_id],
  );
  await db.execute(
    `INSERT INTO price_list_item (id, tenant_id, price_list_id, product_id, uom_id,
                                  unit_price_e4, min_qty, effective_from, effective_to,
                                  hlc, updated_at)
     VALUES (?, ?, ?, ?, ?, CAST(? AS INTEGER), 0, '2019-01-01', NULL, NULL, NULL)`,
    [uuidv7(), 'T', opts.priceListId, p.id, p.uom_id, p.unit_price_e4],
  );
}

async function main(): Promise<void> {
  console.log('=== D17 — a tax-INCLUSIVE retail sale on tenant #1\'s real configuration ===');

  const token = devToken('counter_staff');
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
    // ═══════════════════════════════════════════════════════════════════════
    // A — TENANT #1's REAL CONFIGURATION, READ FROM POSTGRES
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\nA · the configuration this drill runs against (nothing fixtured away)');
    const today = new Date().toISOString().slice(0, 10);
    const lists = await scoped<ServerPriceList>(
      `select id, code, name, is_tax_inclusive, priority, location_id,
              effective_from::text, effective_to::text
         from app.price_list
        where deleted_at is null
          and (location_id is null or location_id = $1)
          and effective_from <= $2::date
          and (effective_to is null or effective_to > $2::date)
        order by priority asc, code asc`,
      [locationId, today],
    );
    const best = lists[0];
    if (best === undefined) throw new Error('tenant #1 has no price list in force — stack:reset');
    measure(
      `lists in force: ${lists
        .map((l) => `${l.code}(p${String(l.priority)},${l.is_tax_inclusive ? 'incl' : 'excl'})`)
        .join(' ')}`,
    );

    check(
      'A1 the best-ranked list a counter resolves is TAX-INCLUSIVE — the flip is gone',
      best.is_tax_inclusive === true,
      `${best.code} priority=${String(best.priority)} is_tax_inclusive=${String(best.is_tax_inclusive)}`,
    );
    check(
      'A2 nothing has quietly rewritten a shipped list to tax-exclusive',
      lists.some((l) => l.is_tax_inclusive) &&
        lists.filter((l) => l.priority === best.priority).length === 1,
      `inclusive=${lists.filter((l) => l.is_tax_inclusive).map((l) => l.code).join(',')} ` +
        `tied-at-best=${lists.filter((l) => l.priority === best.priority).length}`,
    );

    const rates = await scoped<ServerTaxRate>(
      `select jurisdiction_code, tax_code, rate_bp::text, base_kind,
              coalesce(array_to_string(base_includes, ','), '') as base_includes,
              rounding_level, rounding_mode, effective::text
         from platform.tax_rate
        order by lower(effective), base_kind, tax_code`,
    );
    check(
      'A3 the pack carries MORE THAN ONE regime, so "the row in force" is a real question',
      new Set(rates.map((r) => r.effective)).size > 1,
      `${rates.length} rate rows across ${new Set(rates.map((r) => r.effective)).size} windows`,
    );
    const cascading = rates.filter((r) => r.base_kind === 'net_plus');
    check(
      'A4 one of those regimes CASCADES (base_kind net_plus), the other does not',
      cascading.length > 0 && rates.some((r) => r.base_kind === 'net'),
      `net_plus rows: ${cascading.map((r) => `${r.tax_code}${r.effective}`).join(' ')}`,
    );

    const [prod] = await scoped<ServerProduct>(
      `select p.id, p.sku_code, p.name, pu.uom_id, u.code as uom_code, u.qty_scale,
              i.unit_price_e4::text
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
      [best.id],
    );
    if (prod === undefined) throw new Error(`no priced stocked product on ${best.code}`);
    const shelfMinor = BigInt(prod.unit_price_e4) / 10_000n;
    if (BigInt(prod.unit_price_e4) % 10_000n !== 0n) {
      throw new Error('shelf price is not a whole minor unit — this drill assumes it is');
    }
    const expectedGross = shelfMinor * QTY;
    measure(
      `sku ${prod.sku_code} · shelf ${shelfMinor.toString()} minor units × ${QTY.toString()} ` +
        `= ${expectedGross.toString()} the customer hands over`,
    );

    // ═══════════════════════════════════════════════════════════════════════
    // B — THE DEVICE BINDS THE LIST IT USED TO REFUSE, AND RINGS THE SALE
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\nB · the PWA\'s own modules: binding, pricing, checkout, transport');
    const [loc] = await scoped<{ code: string; timezone: string | null }>(
      `select code, timezone from app.location where id = $1 and deleted_at is null`,
      [locationId],
    );
    if (loc === undefined) throw new Error('the token names a location that does not exist');

    const deviceNode = randomBytes(16).toString('hex');
    const nowIso = new Date().toISOString();
    const db: LocalDb = openTestDb();
    await seedDeviceFromServer(db, {
      locationId,
      locationCode: loc.code,
      timeZone: loc.timezone ?? 'UTC',
      lists,
      rates,
      product: prod,
      priceListId: best.id,
    });

    // THE BINDING. This is the call that used to answer `status: 'unsupported'`
    // with a null price list, because the best-ranked list was inclusive and
    // nothing could de-gross it. It is driven with the device's real bearer,
    // so the local-only escape hatch is not what answers.
    const bound = await reconcileDevicePriceList(db, token, nowIso);
    check(
      'B1 the device BINDS the tax-inclusive counter list (it previously refused)',
      bound.priceListId === best.id && !blocksSales(bound),
      `status=${bound.status} priceListId=${String(bound.priceListId)} ` +
        `blocks=${String(blocksSales(bound))} message=${String(bound.message)}`,
    );

    // The tenant's REAL tender methods, as the reference bucket would deliver
    // them, and a till for today opened through the PWA's own path — there is
    // no sale without one (08 §8.2a). The open rides the outbox ahead of the
    // sale and is sent in the same batch below.
    const methods = await scoped<{
      id: string; name: string; posting_role: string; is_cash: boolean;
      is_on_account: boolean; requires_reference: boolean; sort_order: number;
    }>(
      `select id, name, posting_role, is_cash, is_on_account, requires_reference, sort_order
         from app.tender_method where is_active and deleted_at is null`,
      [],
    );
    await replaceTenderMethods(db, methods.map((m) => ({
      id: m.id, name: m.name, postingRole: m.posting_role, isCash: m.is_cash,
      isOnAccount: m.is_on_account, requiresReference: m.requires_reference, sortOrder: m.sort_order,
    })));
    await openTill(db, {
      openingFloatMinor: 0n, businessDate: today, openedOffline: false, drawer: 'SHARED',
      hlc: fixedHlc(Date.parse(nowIso) - 1000, deviceNode), nowIso,
    });

    const componentSet = await readTaxComponentsInForce(db, today);
    check(
      'B2 the device reads its own pack rows — components are DATA, not a constant',
      componentSet.problem === null && componentSet.components.length > 0,
      `components=[${componentSet.components
        .map((c) => `${c.code}:${c.rateBp.toString()}bp/${c.baseKind}`)
        .join(' ')}] problem=${String(componentSet.problem)}`,
    );

    const cartId = await createCart(db, { nowIso });
    for (let i = 0n; i < QTY; i += 1n) await addProductToCart(db, cartId, {
      id: prod.id,
      code: prod.sku_code,
      name: prod.name,
      aliases: null,
      category: null,
      uomLabel: prod.uom_code,
      qtyScale: prod.qty_scale,
      priceListId: best.id,
      unitPriceE4: BigInt(prod.unit_price_e4),
    });

    // The counter's OWN figure, from the same modules the tender panel reads.
    const openCart = await getOpenCart(db);
    if (openCart === null || openCart.id !== cartId) {
      throw new Error('the cart the counter would tender is not the one that was rung');
    }
    const cartLines = await getCartLines(db, cartId);
    const basis = await readPricingBasis(db, best.is_tax_inclusive, today);
    const local = priceCart(cartLines, basis);
    check(
      'B3 the till shows the SHELF PRICE as the amount due, not shelf + tax again',
      local.grossMinor === expectedGross,
      `till gross=${local.grossMinor.toString()} expected=${expectedGross.toString()}`,
    );
    check(
      'B4 the till can state the split, and it sums to the shelf price EXACTLY',
      local.breakdown !== null &&
        local.breakdown.netMinor +
          local.breakdown.taxes.reduce((a, t) => a + t.taxMinor, 0n) ===
          expectedGross,
      local.breakdown === null
        ? 'no breakdown'
        : `net=${local.breakdown.netMinor.toString()} + [${local.breakdown.taxes
            .map((t) => `${t.code}=${t.taxMinor.toString()}`)
            .join(' ')}] = ${expectedGross.toString()}`,
    );

    const sale = await checkout(db, {
      cartId,
      tenderedMinor: expectedGross,
      hlc: fixedHlc(Date.parse(nowIso), deviceNode),
      nowIso,
    });
    measure(`receipt ${sale.receiptNo} · till total ${sale.totalMinor.toString()} minor units`);
    check(
      'B5 checkout took the shelf price as the total and gave no change on exact tender',
      sale.totalMinor === expectedGross && sale.changeMinor === 0n,
      `total=${sale.totalMinor.toString()} change=${sale.changeMinor.toString()}`,
    );

    const transport = httpUploadTransport({ apiUrl: API_URL, apiToken: token, fetchFn: browserFetch });
    const ops = await readPendingOps(db);
    const t0 = performance.now();
    const posted = await transport.send(ops);
    const elapsedMs = performance.now() - t0; // lint-money-ignore — milliseconds, not minor units
    measure(`POST ${API_URL}/sync/upload from origin ${PWA_ORIGIN}: ${elapsedMs.toFixed(0)}ms`);
    const ack = posted.acks.find((a) => a.key === sale.saleId);
    check(
      'B6 the sale is ACKED APPLIED — no PRECONDITION_FAILED on a tax-inclusive list',
      posted.ok && ack?.status === 'applied',
      `ok=${String(posted.ok)} ack=${JSON.stringify(ack ?? null)}`,
    );

    // ═══════════════════════════════════════════════════════════════════════
    // C — WHAT POSTGRES ACTUALLY HOLDS, RE-DERIVED HERE IN SQL
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\nC · the invariant, checked against the rows rather than the API\'s arithmetic');

    interface SaleRow {
      id: string;
      business_date: string;
      subtotal_net_minor: string;
      discount_minor: string;
      tax_total_minor: string;
      total_minor: string;
    }
    const readSale = async (receiptNo: string): Promise<SaleRow> => {
      const rows = await scoped<SaleRow>(
        `select id, business_date::text, subtotal_net_minor::text, discount_minor::text,
                tax_total_minor::text, total_minor::text
           from app.sale where receipt_no = $1 and deleted_at is null`,
        [receiptNo],
      );
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) {
        throw new Error(`expected exactly one sale for receipt ${receiptNo}, got ${rows.length}`);
      }
      return row;
    };
    interface TaxRow {
      tax_code: string;
      rate_bp: number;
      base_kind: string;
      base_includes: string;
      base_minor: string;
      tax_minor: string;
    }
    const readTaxLines = (saleId: string): Promise<TaxRow[]> =>
      scoped<TaxRow>(
        `select t.tax_code, t.rate_bp, t.base_kind,
                coalesce(array_to_string(t.base_includes, ','), '') as base_includes,
                t.base_minor::text, t.tax_minor::text
           from app.sale_tax_line t
          where t.sale_id = $1 and t.deleted_at is null
          order by t.seq`,
        [saleId],
      );

    const row = await readSale(sale.receiptNo);
    const taxLines = await readTaxLines(row.id);
    const sqlTaxSum = taxLines.reduce((a, t) => a + BigInt(t.tax_minor), 0n);
    const net = BigInt(row.subtotal_net_minor);
    const discount = BigInt(row.discount_minor);
    const total = BigInt(row.total_minor);
    measure(
      `server: net=${net.toString()} tax=[${taxLines
        .map((t) => `${t.tax_code}@${String(t.rate_bp)}bp/${t.base_kind} base=${t.base_minor} tax=${t.tax_minor}`)
        .join(' ')}] total=${total.toString()}`,
    );

    check(
      'C1 THE CUSTOMER PAYS THE SHELF PRICE: stored total === shelf × qty, exactly',
      total === expectedGross,
      `stored ${total.toString()} vs ${shelfMinor.toString()}×${QTY.toString()}=${expectedGross.toString()}`,
    );
    check(
      'C2 net + Σ(tax lines) === total, re-summed in SQL from sale_tax_line',
      taxLines.length > 0 && net - discount + sqlTaxSum === total,
      `${net.toString()} − ${discount.toString()} + ${sqlTaxSum.toString()} = ` +
        `${(net - discount + sqlTaxSum).toString()} vs total ${total.toString()} ` +
        `(${taxLines.length} component lines)`,
    );
    check(
      'C3 the sale\'s own tax_total agrees with the component rows it is made of',
      BigInt(row.tax_total_minor) === sqlTaxSum,
      `sale.tax_total=${row.tax_total_minor} Σ(sale_tax_line)=${sqlTaxSum.toString()}`,
    );
    const lineNets = await scoped<{ n: string; d: string; t: string }>(
      `select coalesce(sum(line_net_minor),0)::text as n,
              coalesce(sum(line_discount_minor),0)::text as d,
              coalesce(sum(tax_minor),0)::text as t
         from app.sale_line where sale_id = $1 and deleted_at is null`,
      [row.id],
    );
    check(
      'C4 the document figures are the SUM of the line figures, not a second computation',
      lineNets[0] !== undefined &&
        BigInt(lineNets[0].n) === net &&
        BigInt(lineNets[0].d) === discount &&
        BigInt(lineNets[0].t) === sqlTaxSum,
      `lines n=${lineNets[0]?.n ?? '?'} d=${lineNets[0]?.d ?? '?'} t=${lineNets[0]?.t ?? '?'} ` +
        `vs doc n=${net.toString()} d=${discount.toString()} t=${sqlTaxSum.toString()}`,
    );
    check(
      'C5 the shelf price was NOT taxed a second time (total > net is tax, not markup)',
      net < total && net + sqlTaxSum === total,
      `net=${net.toString()} < total=${total.toString()}, tax=${sqlTaxSum.toString()}`,
    );

    // ═══════════════════════════════════════════════════════════════════════
    // D — THE CLIENT AND THE SERVER AGREE
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\nD · the till\'s figure and the server\'s, on a correct path');
    check(
      'D1 the client\'s local total EQUALS the server\'s stored total',
      sale.totalMinor === total,
      `till=${sale.totalMinor.toString()} server=${total.toString()}`,
    );
    const logged = (
      await scoped<{ response_body: Record<string, unknown> | null }>(
        `select response_body from app.write_log where id = $1`,
        [sale.saleId],
      )
    )[0];
    const priceCheck = (logged?.response_body?.['priceCheck'] ?? null) as Record<
      string,
      unknown
    > | null;
    check(
      'D2 the server RECORDED the comparison and found no divergence',
      priceCheck !== null && priceCheck['matches'] === true,
      `priceCheck=${JSON.stringify(priceCheck)}`,
    );
    check(
      'D3 the client\'s own split equals the server\'s, component by component',
      local.breakdown !== null &&
        local.breakdown.netMinor === net &&
        local.breakdown.taxes.length === taxLines.length &&
        local.breakdown.taxes.every(
          (t, i) => t.code === taxLines[i]?.tax_code && t.taxMinor === BigInt(taxLines[i]!.tax_minor),
        ),
      local.breakdown === null
        ? 'the till stated no split'
        : `till [${local.breakdown.taxes.map((t) => `${t.code}=${t.taxMinor.toString()}`).join(' ')}] ` +
          `vs server [${taxLines.map((t) => `${t.tax_code}=${t.tax_minor}`).join(' ')}]`,
    );

    // ═══════════════════════════════════════════════════════════════════════
    // E — A SALE DATED BEFORE THE RATE CHANGE USES THE OLD COMPOSITION
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The point is NOT that an old rate is used — no rate changes between
    // Ghana's two regimes. It is that the COMPOSITION does: until 2026-01-01
    // VAT sat on a base that already included the levies, and from 2026-01-01
    // it sits on the net. Same shelf price, same rates, different net. A single
    // division by a constant cannot produce both, which is the whole reason
    // extraction has to invert the pack (ADR-0002, ADR-0007).
    //
    // The tenant's shipped RETAIL list starts on 2026-08-01, so a 2025 sale
    // needs a list that was in force then. This drill seeds its OWN — inclusive
    // like RETAIL, ranked far below it so it can never become a device default,
    // and with a window that CLOSES before the shipped list opens, so it is
    // invisible to every other drill. It takes the one write path: a write_log
    // row first, then the rows, under the tenant's own RLS context.
    console.log('\nE · the same shelf price, priced against the regime in force on the sale\'s day');
    const HIST_DATE = '2025-06-15';
    const histListId = deterministicUuid(tenantId, 'qa-d17', 'price-list', 'QA-HIST-INCL');
    {
      const clock = createHlcClock(hlcNodeFromName(`qa-d17:${tenantId}`));
      const writeId = deterministicUuid(tenantId, 'qa-d17', 'write', 'seed');
      await scoped(
        `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
         values ($1, $2, 'SERVER', $3, 'qa-d17.seed', 1, decode($4, 'hex'))
         on conflict (tenant_id, id) do nothing`,
        [tenantId, writeId, clock.next(), sha256Hex(`qa-d17:${tenantId}`)],
      );
      await scoped(
        `insert into app.price_list
           (tenant_id, id, write_id, hlc, code, name, is_tax_inclusive, currency_code,
            priority, location_id, effective_from, effective_to)
         values ($1, $2, $3, $4, 'QA-HIST-INCL', 'QA historical inclusive', true, 'GHS',
                 900, null, '2019-01-01'::date, '2026-01-01'::date)
         on conflict (tenant_id, id) do nothing`,
        [tenantId, histListId, writeId, clock.next()],
      );
      await scoped(
        `insert into app.price_list_item
           (tenant_id, id, write_id, hlc, price_list_id, product_id, uom_id,
            unit_price_e4, min_qty, effective_from)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 0, '2019-01-01'::date)
         on conflict do nothing`,
        [
          tenantId,
          deterministicUuid(tenantId, 'qa-d17', 'item', prod.id),
          writeId,
          clock.next(),
          histListId,
          prod.id,
          prod.uom_id,
          prod.unit_price_e4,
        ],
      );
    }
    const [histList] = await scoped<ServerPriceList>(
      `select id, code, name, is_tax_inclusive, priority, location_id,
              effective_from::text, effective_to::text
         from app.price_list where id = $1`,
      [histListId],
    );
    if (histList === undefined) throw new Error('the historical price list did not seed');

    // The device receives it exactly as the sync stream would.
    await db.execute(
      `INSERT INTO price_list (id, tenant_id, code, name, is_tax_inclusive, currency_code,
                               priority, location_id, effective_from, effective_to, hlc, updated_at)
       VALUES (?, ?, ?, ?, 1, 'GHS', CAST(? AS INTEGER), NULL, ?, ?, NULL, NULL)`,
      [
        histList.id,
        'T',
        histList.code,
        histList.name,
        histList.priority,
        histList.effective_from,
        histList.effective_to,
      ],
    );
    await db.execute(
      `INSERT INTO price_list_item (id, tenant_id, price_list_id, product_id, uom_id,
                                    unit_price_e4, min_qty, effective_from, effective_to,
                                    hlc, updated_at)
       VALUES (?, ?, ?, ?, ?, CAST(? AS INTEGER), 0, '2019-01-01', NULL, NULL, NULL)`,
      [uuidv7(), 'T', histList.id, prod.id, prod.uom_id, prod.unit_price_e4],
    );

    // The device still binds RETAIL: a lapsed list must not become the default.
    const stillBound = await reconcileDevicePriceList(db, token, nowIso);
    check(
      'E1 a list that lapsed in 2026 does NOT become this counter\'s default today',
      stillBound.priceListId === best.id,
      `bound=${String(stillBound.priceListId)} (${stillBound.status}) vs RETAIL ${best.id}`,
    );

    // A BACK-DATED sale is rung into a till opened FOR that day (08 §8.2a):
    // today's till is cashed up first — BEFORE the back-dated cart exists,
    // because a till cannot be cashed up with a sale in progress (the client
    // refuses, rightly) — then a till for HIST_DATE is opened,
    // flagged offline because the server's date check would (rightly) refuse
    // it online. Both ride the outbox ahead of the sale.
    const todays = await readOpenTill(db);
    if (todays !== null) {
      await closeTill(db, {
        tillId: todays.id, countedMinor: await tillExpectedCash(db, todays),
        hlc: fixedHlc(Date.parse(nowIso) + 500, deviceNode), nowIso,
      });
    }
    // The device's wall clock says HIST_DATE — that is what a till that
    // traded that day saw. The HLC stays real time: the server clamps a claimed
    // HLC to ±24h of its own clock, and the HLC is not the trading day.
    const histNow = `${HIST_DATE}T12:00:00.000Z`;
    await openTill(db, {
      openingFloatMinor: 0n, businessDate: HIST_DATE, openedOffline: true, drawer: 'SHARED',
      hlc: fixedHlc(Date.parse(nowIso) + 700, deviceNode), nowIso: histNow,
    });
    const histCart = await createCart(db, { nowIso, priceListId: histList.id });
    for (let i = 0n; i < QTY; i += 1n) await addProductToCart(db, histCart, {
      id: prod.id,
      code: prod.sku_code,
      name: prod.name,
      aliases: null,
      category: null,
      uomLabel: prod.uom_code,
      qtyScale: prod.qty_scale,
      priceListId: histList.id,
      unitPriceE4: BigInt(prod.unit_price_e4),
    });
    const histLines = await getCartLines(db, histCart);
    const histBasis = await readPricingBasis(db, true, HIST_DATE);
    const histLocal = priceCart(histLines, histBasis);
    const histSale = await checkout(db, {
      cartId: histCart,
      tenderedMinor: expectedGross,
      hlc: fixedHlc(Date.parse(nowIso) + 1000, deviceNode),
      nowIso: histNow,
    });
    const histOps = await readPendingOps(db);
    const histPosted = await transport.send(histOps);
    const histAck = histPosted.acks.find((a) => a.key === histSale.saleId);
    check(
      'E2 the back-dated sale is ACKED APPLIED against the list in force THEN',
      histPosted.ok && histAck?.status === 'applied',
      `ack=${JSON.stringify(histAck ?? null)}`,
    );

    const histRow = await readSale(histSale.receiptNo);
    const histTax = await readTaxLines(histRow.id);
    const histTaxSum = histTax.reduce((a, t) => a + BigInt(t.tax_minor), 0n);
    const histNet = BigInt(histRow.subtotal_net_minor);
    measure(
      `${HIST_DATE}: net=${histNet.toString()} tax=[${histTax
        .map((t) => `${t.tax_code}@${String(t.rate_bp)}bp/${t.base_kind} base=${t.base_minor}`)
        .join(' ')}] total=${histRow.total_minor}`,
    );
    check(
      'E3 the customer still hands over the shelf price, and the parts still sum to it',
      BigInt(histRow.total_minor) === expectedGross && histNet + histTaxSum === expectedGross,
      `total=${histRow.total_minor} net+tax=${(histNet + histTaxSum).toString()} ` +
        `expected=${expectedGross.toString()}`,
    );
    const cascadedLine = histTax.find((t) => t.base_kind === 'net_plus');
    check(
      'E4 the OLD composition was applied: a component cascaded onto a base above the net',
      cascadedLine !== undefined && BigInt(cascadedLine.base_minor) > histNet,
      cascadedLine === undefined
        ? `no net_plus component on the back-dated sale — got ${histTax.map((t) => `${t.tax_code}/${t.base_kind}`).join(' ')}`
        : `${cascadedLine.tax_code} base=${cascadedLine.base_minor} > net=${histNet.toString()} ` +
          `(includes ${cascadedLine.base_includes})`,
    );
    check(
      'E5 today\'s sale did NOT cascade — the two regimes are read from data, not assumed',
      taxLines.every((t) => t.base_kind === 'net') &&
        taxLines.every((t) => BigInt(t.base_minor) === net),
      `today: ${taxLines.map((t) => `${t.tax_code}/${t.base_kind}`).join(' ')}`,
    );
    const codesToday = new Set(taxLines.map((t) => t.tax_code));
    const codesHist = new Set(histTax.map((t) => t.tax_code));
    check(
      'E6 the component SET differs between the regimes, from the pack rows alone',
      [...codesHist].some((c) => !codesToday.has(c)) || codesHist.size !== codesToday.size,
      `then=[${[...codesHist].join(' ')}] now=[${[...codesToday].join(' ')}]`,
    );
    check(
      'E7 SAME shelf price, DIFFERENT net — a single constant divisor cannot produce both',
      histNet !== net && BigInt(histRow.total_minor) === total,
      `net then=${histNet.toString()} now=${net.toString()} on the same gross ${total.toString()}`,
    );
    check(
      'E8 the till reached the SAME back-dated split as the server did',
      histLocal.grossMinor === BigInt(histRow.total_minor) &&
        histLocal.breakdown !== null &&
        histLocal.breakdown.netMinor === histNet,
      histLocal.breakdown === null
        ? `till gross=${histLocal.grossMinor.toString()}, no split`
        : `till net=${histLocal.breakdown.netMinor.toString()} server net=${histNet.toString()}`,
    );

    // ═══════════════════════════════════════════════════════════════════════
    // F — THE META-ENVELOPE SWEEP ON EVERY READ THIS DRILL TOUCHES
    // ═══════════════════════════════════════════════════════════════════════
    //
    // §0 row 16: a `Date` selected uncast makes superjson annotate the response
    // with a `meta` sibling, and `apps/web`'s client refuses the whole payload
    // rather than render an un-deserialised value — on an HTTP 200. It is
    // invisible to any test that drives the router in-process, so it is swept
    // at raw HTTP, on the routes this drill actually reads through.
    console.log('\nF · the reads this drill touches, swept for a superjson meta envelope');
    const accountsToken = devToken('accounts');
    const sweeps: { route: string; input: unknown; bearer: string }[] = [
      { route: 'sales.get', input: { saleId: row.id }, bearer: accountsToken },
      { route: 'sales.get', input: { saleId: histRow.id }, bearer: accountsToken },
      {
        route: 'sales.recomputeCheck',
        input: { saleId: row.id },
        bearer: accountsToken,
      },
    ];
    const dirty: string[] = [];
    for (const s of sweeps) {
      const res = await rawQuery(s.route, s.input, s.bearer);
      const metas = metaKeysIn(res.body);
      const ok = res.status === 200 && metas.length === 0;
      if (!ok) dirty.push(`${s.route}(${String(res.status)})${metas.join(',')}`);
      check(
        `F· ${s.route} answers 200 with NO superjson meta envelope`,
        ok,
        `HTTP ${String(res.status)}${metas.length === 0 ? ', plain json' : `, META AT ${metas.join(', ')}`}`,
      );
    }
    check(
      'F· the whole read surface this drill drives is meta-free',
      dirty.length === 0,
      dirty.length === 0 ? `${sweeps.length} routes clean` : `dirty: ${dirty.join(' ')}`,
    );

    // ═══════════════════════════════════════════════════════════════════════
    // G — REPLAY: an inclusive sale is as idempotent as any other
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\nG · replay');
    const replay = await transport.send(ops);
    const replayAck = replay.acks.find((a) => a.key === sale.saleId);
    check(
      'G1 a byte-identical re-POST is acked duplicate',
      replayAck?.status === 'duplicate',
      `ack=${JSON.stringify(replayAck ?? null)}`,
    );
    const after = await scoped<{ n: string }>(
      `select count(*)::text as n from app.sale where receipt_no = $1 and deleted_at is null`,
      [sale.receiptNo],
    );
    check(
      'G2 the replay produced no second sale and no second tax line',
      after[0]?.n === '1' && (await readTaxLines(row.id)).length === taxLines.length,
      `sales=${after[0]?.n ?? '?'} tax lines=${taxLines.length}`,
    );
  } finally {
    await sql.end();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n=== D17: ${checks.length - failed.length}/${checks.length} checks passed ===`);
  console.log(`__DRILL_RESULT__ ${JSON.stringify({ checks, measurements })}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error('D17 aborted:', message);
  console.log(`__DRILL_RESULT__ ${JSON.stringify({ checks, measurements, error: message })}`);
  process.exit(1);
});
