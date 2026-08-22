/**
 * D11 — PROCURE TO STOCK, THROUGH THE CLIENT'S OWN CODE, OVER A REAL SOCKET.
 *
 *   pnpm stack:up
 *   pnpm --filter @erp/api dev:stack          # API on :3001
 *   pnpm --filter @erp/wire-conformance drill:procure
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * `docs/phase1-status.md` §0 is a ledger of ELEVEN paths that were written,
 * unit-tested green, and never once executed against the real stack. Two of
 * them were the CLIENT path specifically. Phase 2 has just landed nine tables,
 * three routers, four screens and a shared contract, and the in-process
 * conformance suite (receipt/delivery/procurement-reads `*-client-to-api`)
 * proves the payloads agree — against PGlite, with a test harness that grants
 * every identity the owner role.
 *
 * That harness default is the third thing §0 names as the single root cause.
 * So this file asserts what only the deployed stack can:
 *
 *   · REAL dev tokens for REAL provisioned principals with REAL grants, so a
 *     refusal is the template's own separation of duties rather than an
 *     absent row — the exact failure that killed the whole acceptance suite at
 *     warm-up in §0 row 7;
 *   · a REAL socket with a browser `Origin`, so CORS is on the path (§0 row 1);
 *   · REAL docker Postgres with 0008/0009 applied, asserted here rather than
 *     assumed (§0 row 7 again: a migration that was never applied);
 *   · the CLIENT's own modules — `data/api/procurement.ts`,
 *     `data/api/logistics.ts`, `data/mutations/recordGoodsReceipt.ts`,
 *     `data/mutations/updateDeliveryStatus.ts` — never a hand-written payload.
 *
 * ---------------------------------------------------------------------------
 * THE LOOP IT DRIVES
 * ---------------------------------------------------------------------------
 *   1  RAISE      a holder of purchase.order.create raises a DRAFT; a counter
 *                 clerk is refused the byte-identical payload.
 *   2  APPROVE    the SAME raiser is REFUSED the approval — over HTTP, from a
 *                 real grant — and a holder of purchase.order.approve is
 *                 allowed the byte-identical payload. Separation of duties is
 *                 the whole control against a fabricated receipt.
 *   3  RECEIVE    SHORT, and with the radio genuinely off: the receipt is
 *                 complete locally, ABSENT from Postgres, then drains on
 *                 reconnect. On-hand rises by exactly `qty_stock`; the
 *                 conversion the device computed equals the server's; the
 *                 count variance is recorded and reviewed.
 *   4  REPLAY     the same idempotency key again appends NO second movement.
 *   5  DISPATCH   a haulier — a SUPPLIER with a HAULAGE capability, never a
 *                 truck (ADR-0001) — carries it, and the status reaches
 *                 DELIVERED through the same ordered outbox.
 *   6  ISOLATION  every new read path, asked by tenant B for tenant A's ids.
 *
 * Nothing here is a literal that both sides could agree on wrongly: the
 * conversion is read from Postgres, computed by the device's own `toStockQty`,
 * and compared to the server's stored `qty_stock_computed`.
 *
 * Prints a `__DRILL_RESULT__ {json}` line, exits non-zero on any failure.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// ---- the client, from apps/web's own sources -------------------------------
import type { ApiCallOptions, ApiFetch, ApiResult } from '../../../apps/web/src/data/api/client';
import {
  changePurchaseOrderStatus,
  createPurchaseOrder,
  fetchPurchaseOrder,
  fetchPurchaseOrders,
  fetchReorderSuggestions,
  fetchSourcesForProduct,
  fetchSuppliers,
} from '../../../apps/web/src/data/api/procurement';
import {
  fetchDeliveries,
  fetchDelivery,
  planDelivery,
} from '../../../apps/web/src/data/api/logistics';
import { recordGoodsReceipt } from '../../../apps/web/src/data/mutations/recordGoodsReceipt';
import { recordDeliveryStatus } from '../../../apps/web/src/data/mutations/updateDeliveryStatus';
import { loadPurchaseUnits, toStockQty } from '../../../apps/web/src/data/queries/purchase-units';
import { httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { drainOutbox, readPendingOps } from '../../../apps/web/src/data/sync/upload';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import type { LocalDb } from '../../../apps/web/src/data/db';
import { uuidv7 } from '../../../apps/web/src/lib/uuidv7';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import {
  fixedHlc,
  provisionDevice,
  seedProduct,
  seedPurchaseUnit,
} from '../../../apps/web/tests/helpers/fixtures';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API_URL = process.env['API_URL'] ?? 'http://localhost:3001';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://erp:erp_dev@localhost:5433/erp';
const PWA_ORIGIN = process.env['PWA_ORIGIN'] ?? 'http://localhost:5173';

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

/** A bearer for a REAL provisioned principal — never a hand-minted claim. */
function devToken(roleRef: string, tenant = 'A', locationCode?: string): string {
  const args = [path.join(REPO_ROOT, 'infra/scripts/dev-token.mjs'), '--role', roleRef, '--tenant', tenant];
  if (locationCode !== undefined) args.push('--location', locationCode);
  return execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function claimsOf(token: string): { tid: string; uid: string; locs: string[] } {
  const payload = token.split('.')[1];
  if (payload === undefined) throw new Error('malformed dev token');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tid: string;
    uid: string;
    locs?: string[];
  };
  return { tid: decoded.tid, uid: decoded.uid, locs: decoded.locs ?? [] };
}

/** The client's `ApiFetch`, backed by real `fetch`, with a browser origin. */
const browserApiFetch: ApiFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: { ...init.headers, origin: PWA_ORIGIN },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
};
/** The radio, off. `fetch` REJECTS, exactly as it does on a dead link. */
const deadApiFetch: ApiFetch = () => Promise.reject(new Error('network unreachable'));

function optionsFor(bearer: string, fetchFn: ApiFetch = browserApiFetch): ApiCallOptions {
  return { endpoint: { url: API_URL, bearer }, fetchFn };
}

const browserUploadFetch: FetchLike = async (url, init) => {
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
const deadUploadFetch: FetchLike = () => Promise.reject(new Error('network unreachable'));

/** Raw tRPC, for FIXTURES and for routes no client module exists for. */
async function rawMutate(bearer: string, procedure: string, input: unknown): Promise<unknown> {
  const res = await fetch(`${API_URL}/trpc/${procedure}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      origin: PWA_ORIGIN,
    },
    body: JSON.stringify({ json: input }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${procedure} ${String(res.status)}: ${JSON.stringify(body)}`);
  return (body['result'] as { data?: { json?: unknown } } | undefined)?.data?.json;
}

async function rawQuery(
  bearer: string,
  procedure: string,
  input: unknown,
): Promise<{ status: number; json: unknown }> {
  const url = `${API_URL}/trpc/${procedure}?${new URLSearchParams({
    input: JSON.stringify({ json: input }),
  }).toString()}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${bearer}`, origin: PWA_ORIGIN },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return {
    status: res.status,
    json: (body['result'] as { data?: { json?: unknown } } | undefined)?.data?.json ?? body,
  };
}

function failureKind(result: ApiResult<unknown>): string {
  return result.ok ? 'ok' : result.failure.kind;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log('=== D11 — procure to stock, through the client, over a real socket ===');

  const managerToken = devToken('outlet_manager');
  const counterToken = devToken('counter_staff');
  const accountsToken = devToken('accounts');
  const { tid: tenantId, locs } = claimsOf(managerToken);
  const { uid: accountsUid } = claimsOf(accountsToken);
  const locationId = locs[0];
  if (locationId === undefined) throw new Error('dev token carries no location scope');

  const sql = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  const scopedTo =
    (tid: string) =>
    async <R extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> => {
      const client = await sql.connect();
      try {
        await client.query('begin');
        await client.query('set local role app_user');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
        const res = await client.query<R>(text, params);
        await client.query('commit');
        return res.rows;
      } finally {
        client.release();
      }
    };
  const scoped = scopedTo(tenantId);

  try {
    // =====================================================================
    // 0 — THE STACK IS THE ONE THE CODE WAS WRITTEN FOR
    // =====================================================================
    console.log('\n-- 0. the deployed stack -----------------------------------');
    // Read as the CONNECTION's own role: `erp_meta` is the migrator's
    // bookkeeping and `app_user` (correctly) cannot see it.
    const migrations = (
      await sql.query<{ filename: string }>(
        `select filename from erp_meta.schema_migrations order by filename`,
      )
    ).rows;
    const applied = new Set(migrations.map((m) => m.filename));
    check(
      "0a migrations 0008 and 0009 are APPLIED to the database the API is talking to",
      applied.has('0008_procurement.sql') && applied.has('0009_procurement_permissions.sql'),
      `applied=[${[...applied].join(', ')}]`,
    );

    const [loc] = await scoped<{ code: string; name: string }>(
      `select code, name from app.location where id = $1 and deleted_at is null`,
      [locationId],
    );
    if (loc === undefined) throw new Error('the token names a location that does not exist');
    measure(`tenant ${tenantId} · location ${loc.code} (${loc.name})`);

    // A product bought in a unit that is NOT its stocking unit. Chosen from
    // the tenant's own catalogue, never authored here — the whole point of
    // §4.10's "same product_uom machinery" is that this is ordinary data.
    const [conv] = await scoped<{
      product_id: string;
      sku_code: string;
      product_name: string;
      buy_uom_id: string;
      buy_uom_code: string;
      buy_scale: number;
      factor_num: string;
      factor_den: string;
      tolerance_bp: string;
      stock_uom_code: string;
      stock_scale: number;
    }>(
      `select p.id as product_id, p.sku_code, p.name as product_name,
              pu.uom_id as buy_uom_id, u.code as buy_uom_code, u.qty_scale as buy_scale,
              pu.factor_num::text, pu.factor_den::text, pu.tolerance_bp::text,
              su.code as stock_uom_code, su.qty_scale as stock_scale
         from app.product_uom pu
         join app.product p on p.tenant_id = pu.tenant_id and p.id = pu.product_id
         join app.unit_of_measure u on u.id = pu.uom_id
         join app.unit_of_measure su on su.id = p.stocking_uom_id
        where pu.tenant_id = $1 and pu.can_buy and pu.factor_num <> pu.factor_den
          and p.is_purchasable and p.stock_tracking = 'STOCKED' and p.deleted_at is null
        order by p.sku_code limit 1`,
      [tenantId],
    );
    if (conv === undefined) {
      throw new Error('no product in this catalogue is bought in a unit other than its stocking unit');
    }
    measure(
      `conversion under test: ${conv.sku_code} bought in ${conv.buy_uom_code} (scale ${String(conv.buy_scale)}), ` +
        `stocked in ${conv.stock_uom_code} (scale ${String(conv.stock_scale)}), ` +
        `factor ${conv.factor_num}/${conv.factor_den}, tolerance ${conv.tolerance_bp}bp`,
    );

    // =====================================================================
    // 1 — SUPPLIERS AND SOURCES, through the client's own module
    // =====================================================================
    console.log('\n-- 1. suppliers and sources --------------------------------');
    const goods = await fetchSuppliers({ kind: 'GOODS' }, optionsFor(managerToken));
    check(
      "1a the client's fetchSuppliers reads GOODS suppliers over real HTTP",
      goods.ok && goods.data.suppliers.length > 0,
      goods.ok ? `suppliers=${String(goods.data.suppliers.length)}` : `failure=${JSON.stringify(goods.failure)}`,
    );
    if (!goods.ok) throw new Error('cannot continue without a supplier');
    const supplier = goods.data.suppliers[0];
    if (supplier === undefined) throw new Error('no GOODS supplier on this tenant');

    const carriers = await fetchSuppliers({ kind: 'HAULAGE' }, optionsFor(managerToken));
    check(
      '1b a HAULIER is found by the PLATFORM capability kind HAULAGE — a supplier, not a truck (ADR-0001)',
      carriers.ok &&
        carriers.data.suppliers.length > 0 &&
        carriers.data.suppliers.every((s) => s.capabilities.some((c) => c.kind === 'HAULAGE')),
      carriers.ok
        ? `carriers=${String(carriers.data.suppliers.length)} first=${carriers.data.suppliers[0]?.code ?? '?'}`
        : `failure=${JSON.stringify(carriers.failure)}`,
    );
    if (!carriers.ok) throw new Error('cannot continue without a carrier');
    const carrier = carriers.data.suppliers[0];
    if (carrier === undefined) throw new Error('no HAULAGE supplier on this tenant');

    // FIXTURE, over raw tRPC: this product needs a source in the supplier's
    // unit. `supplier.manage` is Accounts' capability, not the manager's.
    await rawMutate(accountsToken, 'procurement.upsertSupplierProduct', {
      idempotencyKey: randomUUID(),
      supplierId: supplier.supplierId,
      productId: conv.product_id,
      purchaseUomId: conv.buy_uom_id,
      lastPriceE4: '9000000000',
      leadTimeDays: 7,
      isPreferred: true,
    });

    const sources = await fetchSourcesForProduct(conv.product_id, optionsFor(managerToken));
    check(
      '1c the product now has at least one comparable SOURCE, ranked by the server',
      sources.ok && sources.data.sources.length > 0,
      sources.ok
        ? `sources=${String(sources.data.sources.length)} first=${sources.data.sources[0]?.supplierCode ?? '?'} ` +
          `perStockUnitE4=${sources.data.sources[0]?.pricePerStockUnitE4?.toString() ?? 'null'}`
        : `failure=${JSON.stringify(sources.failure)}`,
    );

    const counterSuppliers = await fetchSuppliers({ kind: 'GOODS' }, optionsFor(counterToken));
    check(
      '1d counter staff is REFUSED the supplier list, same payload (positive control: 1a)',
      !counterSuppliers.ok && counterSuppliers.failure.kind === 'forbidden',
      `kind=${failureKind(counterSuppliers)}`,
    );

    // Phase 1's low-stock alert, now SOURCED — the reorder tie CLAUDE.md §3
    // asks Phase 2 for. FIXTURE first: a threshold this product is under, so
    // the list cannot pass vacuously empty.
    const [onHandNow] = await scoped<{ q: string }>(
      `select coalesce(sum(qty_delta), 0)::text as q from app.stock_movement
        where tenant_id = $1 and location_id = $2 and product_id = $3`,
      [tenantId, locationId, conv.product_id],
    );
    await rawMutate(managerToken, 'inventory.setReorderPoint', {
      idempotencyKey: randomUUID(),
      locationId,
      productId: conv.product_id,
      reorderPointQty: (BigInt(onHandNow?.q ?? '0') + 1_000n).toString(),
    });

    const suggestions = await fetchReorderSuggestions({ locationIds: [locationId] }, optionsFor(managerToken));
    const mine = suggestions.ok
      ? suggestions.data.suggestions.find((x) => x.productId === conv.product_id)
      : undefined;
    check(
      '1e the Phase 1 low-stock alert comes back SOURCED — the alert, joined to a real supplier',
      suggestions.ok && mine !== undefined && mine.recommendation.supplierId !== null,
      suggestions.ok
        ? `suggestions=${String(suggestions.data.suggestions.length)} ` +
          `unsourced=${String(suggestions.data.unsourced.length)} ` +
          `mine=${mine === undefined ? 'ABSENT' : `shortfall=${mine.shortfallQty.toString()} basis=${mine.recommendation.basis} source=${mine.recommendation.supplierCode ?? 'none'} qtyToOrder=${String(mine.recommendation.qtyToOrder)} ${mine.recommendation.purchaseUomCode ?? ''}`}`
        : `failure=${JSON.stringify(suggestions.failure)}`,
    );

    // =====================================================================
    // 2 — RAISE, then the SEPARATION OF DUTIES, over HTTP
    // =====================================================================
    console.log('\n-- 2. raise and approve ------------------------------------');
    const qtyOrdered = 1600n; // 1.600 in the purchase unit
    const unitPriceE4 = 9_000_000_000n;
    const orderKey = randomUUID();
    const raised = await createPurchaseOrder(
      {
        idempotencyKey: orderKey,
        supplierId: supplier.supplierId,
        deliverToLocationId: locationId,
        orderDate: today(),
        lines: [
          {
            lineNo: 1,
            productId: conv.product_id,
            uomId: conv.buy_uom_id,
            qtyOrdered: qtyOrdered.toString(),
            unitPriceE4: unitPriceE4.toString(),
          },
        ],
      },
      optionsFor(managerToken),
    );
    check(
      '2a a holder of purchase.order.create raises a DRAFT through the CLIENT',
      raised.ok && raised.data.status === 'DRAFT',
      raised.ok
        ? `purchaseOrderId=${raised.data.purchaseOrderId} status=${raised.data.status} total=${raised.data.totalMinor.toString()}`
        : `failure=${JSON.stringify(raised.failure)}`,
    );
    if (!raised.ok) throw new Error('cannot continue without an order');
    const purchaseOrderId = raised.data.purchaseOrderId;

    // `app.purchase_order` carries NO total column on purpose — the total is
    // Σ(line_net_minor), computed by the server with the one rounding rule.
    const [orderRow] = await scoped<{
      status: string;
      total_minor: string;
      deliver_to_location_id: string;
      lines: string;
    }>(
      `select po.status, po.deliver_to_location_id,
              coalesce((select sum(l.line_net_minor) from app.purchase_order_line l
                         where l.tenant_id = po.tenant_id and l.purchase_order_id = po.id
                           and l.deleted_at is null), 0)::text as total_minor,
              (select count(*) from app.purchase_order_line l
                where l.tenant_id = po.tenant_id and l.purchase_order_id = po.id
                  and l.deleted_at is null)::text as lines
         from app.purchase_order po where po.tenant_id = $1 and po.id = $2`,
      [tenantId, purchaseOrderId],
    );
    check(
      "2b Postgres holds it as a DRAFT at the manager's own location, and Σ(line_net_minor) equals the client's total",
      orderRow !== undefined &&
        orderRow.status === 'DRAFT' &&
        orderRow.deliver_to_location_id === locationId &&
        orderRow.lines === '1' &&
        BigInt(orderRow.total_minor) === raised.data.totalMinor,
      orderRow === undefined
        ? 'no row'
        : `status=${orderRow.status} lines=${orderRow.lines} total=${orderRow.total_minor} ` +
          `client=${raised.data.totalMinor.toString()}`,
    );

    const counterRaise = await createPurchaseOrder(
      {
        idempotencyKey: randomUUID(),
        supplierId: supplier.supplierId,
        deliverToLocationId: locationId,
        orderDate: today(),
        lines: [
          {
            lineNo: 1,
            productId: conv.product_id,
            uomId: conv.buy_uom_id,
            qtyOrdered: qtyOrdered.toString(),
            unitPriceE4: unitPriceE4.toString(),
          },
        ],
      },
      optionsFor(counterToken),
    );
    check(
      '2c counter staff is REFUSED the byte-identical order (positive control: 2a)',
      !counterRaise.ok && counterRaise.failure.kind === 'forbidden',
      `kind=${failureKind(counterRaise)}`,
    );

    const submitted = await changePurchaseOrderStatus(
      { idempotencyKey: randomUUID(), purchaseOrderId, toStatus: 'SUBMITTED' },
      optionsFor(managerToken),
    );
    check(
      '2d the raiser may SUBMIT it — purchase.order.create carries its own draft along',
      submitted.ok && submitted.data.status === 'SUBMITTED',
      submitted.ok ? `${submitted.data.fromStatus} -> ${submitted.data.status}` : `failure=${JSON.stringify(submitted.failure)}`,
    );

    // THE CONTROL. Same principal, same order, same payload shape.
    const approvePayload = { purchaseOrderId, toStatus: 'APPROVED' } as const;
    const selfApprove = await changePurchaseOrderStatus(
      { idempotencyKey: randomUUID(), ...approvePayload },
      optionsFor(managerToken),
    );
    check(
      '2e SEPARATION OF DUTIES: the RAISER is REFUSED the approval, over HTTP, on a real grant',
      !selfApprove.ok && selfApprove.failure.kind === 'forbidden',
      `kind=${failureKind(selfApprove)} detail=${selfApprove.ok ? 'n/a' : String(selfApprove.failure.detail)}`,
    );

    const [afterRefusal] = await scoped<{ status: string; approved_by: string | null }>(
      `select status, approved_by_user_id::text as approved_by
         from app.purchase_order where tenant_id = $1 and id = $2`,
      [tenantId, purchaseOrderId],
    );
    check(
      '2f the refused approval left NO trace — still SUBMITTED, nobody recorded as approver',
      afterRefusal?.status === 'SUBMITTED' && afterRefusal.approved_by === null,
      `status=${afterRefusal?.status ?? '?'} approved_by=${afterRefusal?.approved_by ?? 'null'}`,
    );

    const approved = await changePurchaseOrderStatus(
      { idempotencyKey: randomUUID(), ...approvePayload },
      optionsFor(accountsToken),
    );
    check(
      '2g a holder of purchase.order.approve IS allowed the byte-identical payload',
      approved.ok && approved.data.status === 'APPROVED',
      approved.ok ? `${approved.data.fromStatus} -> ${approved.data.status}` : `failure=${JSON.stringify(approved.failure)}`,
    );

    const [approvedRow] = await scoped<{ status: string; approved_by: string | null }>(
      `select status, approved_by_user_id::text as approved_by
         from app.purchase_order where tenant_id = $1 and id = $2`,
      [tenantId, purchaseOrderId],
    );
    check(
      '2h Postgres records WHO approved it — the approver, not the raiser',
      approvedRow?.status === 'APPROVED' && approvedRow.approved_by === accountsUid,
      `status=${approvedRow?.status ?? '?'} approved_by=${approvedRow?.approved_by ?? 'null'} accounts=${accountsUid}`,
    );

    // =====================================================================
    // 2b — THE APPROVAL BOUND, MEASURED AGAINST THE SERVER'S OWN TOTAL
    // =====================================================================
    // `purchase.order.approve` carries `max_order_value_minor` exactly as
    // `sale.record.credit` does (0009). The template bounds the regional
    // manager and leaves Accounts unbounded, so both halves of the control
    // exist in ordinary tenant DATA — no code branches on either role name.
    console.log('\n-- 2b. the approval bound ----------------------------------');
    const [boundRow] = await scoped<{ location_code: string; bound: string | null }>(
      `select l.code as location_code, rp.bound->>'max_order_value_minor' as bound
         from app.role_permission rp
         join app.role r on r.tenant_id = rp.tenant_id and r.id = rp.role_id
         join app.user_role_assignment ura on ura.tenant_id = r.tenant_id and ura.role_id = r.id
         join app.user_account u on u.tenant_id = ura.tenant_id and u.id = ura.user_id
         join app.user_location_scope s on s.tenant_id = u.tenant_id and s.user_id = u.id
         join app.location l on l.tenant_id = s.tenant_id and l.id = s.location_id
        where rp.tenant_id = $1 and rp.permission_code = 'purchase.order.approve'
          and rp.bound ? 'max_order_value_minor' and u.username = 'dev-regional_manager'
          and l.kind = 'OUTLET'
        order by l.code limit 1`,
      [tenantId],
    );
    if (boundRow?.bound == null) throw new Error('no bounded approver in this template');
    const bound = BigInt(boundRow.bound);
    const boundedToken = devToken('regional_manager', 'A', boundRow.location_code);
    const { locs: boundedLocs } = claimsOf(boundedToken);
    const boundedLocation = boundedLocs[0];
    if (boundedLocation === undefined) throw new Error('bounded token carries no location');
    measure(
      `bounded approver: dev-regional_manager at ${boundRow.location_code}, ` +
        `max_order_value_minor=${bound.toString()}`,
    );

    /** Raise + submit an order whose server-priced total lands where we want. */
    const orderWorth = async (qty: bigint): Promise<{ id: string; total: bigint }> => {
      const r = await createPurchaseOrder(
        {
          idempotencyKey: randomUUID(),
          supplierId: supplier.supplierId,
          deliverToLocationId: boundedLocation,
          orderDate: today(),
          lines: [
            {
              lineNo: 1,
              productId: conv.product_id,
              uomId: conv.buy_uom_id,
              qtyOrdered: qty.toString(),
              unitPriceE4: unitPriceE4.toString(),
            },
          ],
        },
        optionsFor(boundedToken),
      );
      if (!r.ok) throw new Error(`could not raise the bound fixture: ${JSON.stringify(r.failure)}`);
      const sub = await changePurchaseOrderStatus(
        { idempotencyKey: randomUUID(), purchaseOrderId: r.data.purchaseOrderId, toStatus: 'SUBMITTED' },
        optionsFor(boundedToken),
      );
      if (!sub.ok) throw new Error(`could not submit the bound fixture: ${JSON.stringify(sub.failure)}`);
      return { id: r.data.purchaseOrderId, total: r.data.totalMinor };
    };

    const over = await orderWorth(10_000n);
    const under = await orderWorth(1_000n);
    check(
      '2i the two fixture orders straddle the bound, on the SERVER\'s own repriced totals',
      over.total > bound && under.total <= bound,
      `over=${over.total.toString()} under=${under.total.toString()} bound=${bound.toString()}`,
    );

    const overApprove = await changePurchaseOrderStatus(
      { idempotencyKey: randomUUID(), purchaseOrderId: over.id, toStatus: 'APPROVED' },
      optionsFor(boundedToken),
    );
    check(
      '2j THE BOUND BITES: the bounded approver is REFUSED above it, and the refusal names the server\'s total',
      !overApprove.ok &&
        overApprove.failure.kind === 'forbidden' &&
        String(overApprove.failure.detail ?? '').includes(over.total.toString()),
      overApprove.ok
        ? 'APPROVED OVER THE BOUND'
        : `kind=${overApprove.failure.kind} detail=${String(overApprove.failure.detail)}`,
    );

    const underApprove = await changePurchaseOrderStatus(
      { idempotencyKey: randomUUID(), purchaseOrderId: under.id, toStatus: 'APPROVED' },
      optionsFor(boundedToken),
    );
    check(
      '2k the SAME principal IS allowed under the bound — so 2j is the amount, not the capability',
      underApprove.ok && underApprove.data.status === 'APPROVED',
      underApprove.ok ? `${underApprove.data.fromStatus} -> ${underApprove.data.status}` : `failure=${failureKind(underApprove)}`,
    );

    // A token for the SAME unbounded principal, standing at the location the
    // order is destined for: `locs` is a DEVICE scope and is checked
    // independently of the grant, so a bearer for OUT-01 cannot act at OUT-22
    // however wide its authority. That is a second control, not this one.
    const accountsThere = devToken('accounts', 'A', boundRow.location_code);
    const overByAccounts = await changePurchaseOrderStatus(
      { idempotencyKey: randomUUID(), purchaseOrderId: over.id, toStatus: 'APPROVED' },
      optionsFor(accountsThere),
    );
    check(
      '2l an UNBOUNDED approver clears the same order — the bound is a grant, never a route',
      overByAccounts.ok && overByAccounts.data.status === 'APPROVED',
      overByAccounts.ok ? `${overByAccounts.data.fromStatus} -> ${overByAccounts.data.status}` : `failure=${failureKind(overByAccounts)}`,
    );

    const [overRow] = await scoped<{ status: string }>(
      `select status from app.purchase_order where tenant_id = $1 and id = $2`,
      [tenantId, over.id],
    );
    check(
      '2m and the refused approval had left the order SUBMITTED — a refusal writes nothing',
      overRow?.status === 'APPROVED',
      `status now=${overRow?.status ?? '?'} (APPROVED only after the unbounded approver acted)`,
    );

    // =====================================================================
    // 3 — RECEIVE IT SHORT, WITH THE RADIO OFF
    // =====================================================================
    console.log('\n-- 3. goods received, short, offline -----------------------');
    const deviceDb: LocalDb = openTestDb();
    await provisionDevice(deviceDb, { locationId, locationCode: loc.code });
    // The device's catalogue, as the `tenant_reference` sync bucket delivers
    // it: the SERVER's ids, the SERVER's factor, the SERVER's scales.
    await seedProduct(deviceDb, {
      id: conv.product_id,
      code: conv.sku_code,
      name: conv.product_name,
      uomLabel: conv.stock_uom_code,
      qtyScale: conv.stock_scale,
      unitPriceE4: 1_000_000n,
    });
    await seedPurchaseUnit(deviceDb, {
      productId: conv.product_id,
      uomId: conv.buy_uom_id,
      code: conv.buy_uom_code,
      qtyScale: conv.buy_scale,
      factorNum: BigInt(conv.factor_num),
      factorDen: BigInt(conv.factor_den),
      toleranceBp: BigInt(conv.tolerance_bp),
    });

    const units = await loadPurchaseUnits(deviceDb, conv.product_id);
    const unit = units.find((u) => u.uomId === conv.buy_uom_id);
    if (unit === undefined) throw new Error('the device holds no buyable unit for this product');

    // SHORT: 1.500 of the 1.600 ordered. And the yard COUNTED three fewer
    // than the conversion says, which is a second, independent fact.
    const qtyReceived = 1500n;
    const computedStock = toStockQty(qtyReceived, unit);
    const countedStock = computedStock - 3n;
    measure(
      `ordered ${qtyOrdered.toString()} ${conv.buy_uom_code}; invoiced ${qtyReceived.toString()}; ` +
        `conversion says ${computedStock.toString()} ${conv.stock_uom_code}; counted ${countedStock.toString()}`,
    );

    const [poLine] = await scoped<{ id: string }>(
      `select id from app.purchase_order_line
        where tenant_id = $1 and purchase_order_id = $2 and deleted_at is null order by line_no limit 1`,
      [tenantId, purchaseOrderId],
    );
    if (poLine === undefined) throw new Error('the order has no line');

    const [before] = await scoped<{ on_hand: string }>(
      `select coalesce(sum(qty_delta), 0)::text as on_hand from app.stock_movement
        where tenant_id = $1 and location_id = $2 and product_id = $3`,
      [tenantId, locationId, conv.product_id],
    );
    const onHandBefore = BigInt(before?.on_hand ?? '0');

    const receiptId = randomUUID();
    await recordGoodsReceipt(deviceDb, {
      goodsReceiptId: receiptId,
      supplierId: supplier.supplierId,
      purchaseOrderId,
      supplierDeliveryNoteRef: `D11-${receiptId.slice(0, 8)}`,
      lines: [
        {
          purchaseOrderLineId: poLine.id,
          productId: conv.product_id,
          unit,
          qtyReceived,
          qtyStock: countedStock,
          unitCostE4: unitPriceE4,
        },
      ],
      hlc: fixedHlc(Date.now(), randomBytes(16).toString('hex')),
      businessDate: today(),
    });
    check(
      '3a the receipt is complete LOCALLY with no network on the path',
      (await readPendingOps(deviceDb)).length === 1,
      `pending=${String((await readPendingOps(deviceDb)).length)} key=${receiptId}`,
    );

    const offlineDrain = await drainOutbox(
      deviceDb,
      httpUploadTransport({ apiUrl: API_URL, apiToken: managerToken, fetchFn: deadUploadFetch }),
    );
    // The receipt's OWN id is derived server-side from the key; the key is on
    // the row as `write_id`, which is what the device actually knows.
    const [absent] = await scoped<{ n: string }>(
      `select count(*)::text as n from app.goods_receipt where tenant_id = $1 and write_id = $2`,
      [tenantId, receiptId],
    );
    check(
      '3b it is ABSENT from the server while the device is genuinely partitioned',
      !offlineDrain.transportOk && offlineDrain.deferred === 1 && absent?.n === '0',
      `transportOk=${String(offlineDrain.transportOk)} deferred=${String(offlineDrain.deferred)} rows=${absent?.n ?? '?'}`,
    );

    const t0 = Date.now();
    const onlineDrain = await drainOutbox(
      deviceDb,
      httpUploadTransport({ apiUrl: API_URL, apiToken: managerToken, fetchFn: browserUploadFetch }),
    );
    const elapsed = Date.now() - t0;
    check(
      '3c on reconnect it drains and is ACKED APPLIED',
      onlineDrain.transportOk && onlineDrain.completed === 1 && onlineDrain.rejected === 0,
      `completed=${String(onlineDrain.completed)} rejected=${String(onlineDrain.rejected)} ` +
        `deferred=${String(onlineDrain.deferred)} in ${String(elapsed)}ms`,
    );
    measure(`offline goods receipt drained on reconnect in ${String(elapsed)}ms (budget 60000ms)`);

    const [receiptRow] = await scoped<{ id: string }>(
      `select id from app.goods_receipt where tenant_id = $1 and write_id = $2`,
      [tenantId, receiptId],
    );
    const goodsReceiptId = receiptRow?.id ?? null;
    const [line] = await scoped<{
      qty_received: string;
      qty_stock: string;
      qty_stock_computed: string;
      conversion_confirmed: boolean | null;
    }>(
      `select l.qty_received::text, l.qty_stock::text, l.qty_stock_computed::text,
              l.conversion_confirmed_by is not null as conversion_confirmed
         from app.goods_receipt_line l
        where l.tenant_id = $1 and l.goods_receipt_id = $2 order by l.line_no limit 1`,
      [tenantId, goodsReceiptId],
    );
    check(
      '3d the line carries BOTH quantities — what was invoiced AND what entered the yard',
      line !== undefined &&
        BigInt(line.qty_received) === qtyReceived &&
        BigInt(line.qty_stock) === countedStock &&
        line.conversion_confirmed === true,
      line === undefined
        ? 'no line'
        : `qty_received=${line.qty_received} qty_stock=${line.qty_stock} computed=${line.qty_stock_computed} ` +
          `signedFor=${String(line.conversion_confirmed)}`,
    );
    check(
      "3e THE CONVERSION AGREES: the device's toStockQty equals the server's qty_stock_computed",
      line !== undefined && BigInt(line.qty_stock_computed) === computedStock,
      `device=${computedStock.toString()} server=${line?.qty_stock_computed ?? '?'} ` +
        `(${conv.factor_num}/${conv.factor_den}, buy scale ${String(conv.buy_scale)} → stock scale ${String(conv.stock_scale)})`,
    );

    const [after] = await scoped<{ on_hand: string }>(
      `select coalesce(sum(qty_delta), 0)::text as on_hand from app.stock_movement
        where tenant_id = $1 and location_id = $2 and product_id = $3`,
      [tenantId, locationId, conv.product_id],
    );
    const onHandAfter = BigInt(after?.on_hand ?? '0');
    check(
      '3f ON-HAND ROSE BY EXACTLY qty_stock — what was counted, never what was invoiced',
      onHandAfter - onHandBefore === countedStock,
      `before=${onHandBefore.toString()} after=${onHandAfter.toString()} ` +
        `delta=${(onHandAfter - onHandBefore).toString()} qty_stock=${countedStock.toString()}`,
    );

    const movements = await scoped<{ n: string; qty_delta: string; source_kind: string }>(
      `select count(*) over ()::text as n, qty_delta::text, source_kind
         from app.stock_movement where tenant_id = $1 and write_id = $2`,
      [tenantId, receiptId],
    );
    check(
      '3g the receipt APPENDED a movement, and set no counter (CLAUDE.md §2.2)',
      movements.length === 1 &&
        BigInt(movements[0]!.qty_delta) === countedStock &&
        movements[0]!.source_kind === 'RECEIPT',
      movements.length === 0
        ? 'no movement'
        : `rows=${movements[0]!.n} qty_delta=${movements[0]!.qty_delta} kind=${movements[0]!.source_kind}`,
    );

    const [review] = await scoped<{
      conflict_class: string;
      severity: number;
      status: string;
      required_permission: string | null;
      in_catalogue: string;
    }>(
      `select r.conflict_class, r.severity, r.status, r.required_permission,
              (select count(*) from platform.permission p
                where p.code = r.required_permission)::text as in_catalogue
         from app.conflict_review r
        where r.tenant_id = $1 and r.entity_table = 'app.goods_receipt_line'
          and r.entity_id in (select id from app.goods_receipt_line
                               where tenant_id = $1 and goods_receipt_id = $2)`,
      [tenantId, goodsReceiptId],
    );
    check(
      '3h THE COUNT VARIANCE IS RECORDED, not absorbed — a human review is open on the line',
      review !== undefined && review.conflict_class === 'CONVERSION_OUT_OF_TOLERANCE',
      review === undefined
        ? 'NO REVIEW OPENED for a count 3 units from the conversion'
        : `class=${review.conflict_class} severity=${String(review.severity)} status=${review.status}`,
    );
    // §0 row 6: a review routed on a permission code the catalogue has never
    // heard of lands in a queue no user can ever hold the right to read.
    check(
      '3k the review is routed on a permission code that EXISTS in platform.permission (§0 row 6)',
      review !== undefined && review.in_catalogue === '1',
      review === undefined
        ? 'no review'
        : `required_permission=${String(review.required_permission)} inCatalogue=${review.in_catalogue}`,
    );

    const detail = await fetchPurchaseOrder(purchaseOrderId, optionsFor(managerToken));
    const outstanding = detail.ok ? detail.data.lines[0]?.qtyOutstanding : undefined;
    check(
      '3i THE SHORT DELIVERY IS VISIBLE ON THE ORDER — outstanding = ordered − received',
      detail.ok && outstanding === qtyOrdered - qtyReceived,
      detail.ok
        ? `status=${detail.data.status} qtyOrdered=${detail.data.lines[0]?.qtyOrdered.toString() ?? '?'} ` +
          `qtyReceived=${detail.data.lines[0]?.qtyReceived.toString() ?? '?'} outstanding=${outstanding?.toString() ?? '?'}`
        : `failure=${JSON.stringify(detail.failure)}`,
    );
    check(
      '3j the order moved itself to PARTIALLY_RECEIVED — a short delivery is normal, not an error',
      detail.ok && detail.data.status === 'PARTIALLY_RECEIVED',
      detail.ok ? `status=${detail.data.status}` : 'n/a',
    );

    // =====================================================================
    // 4 — THE REPLAY THE CONSTITUTION FORBIDS DOUBLE-COUNTING
    // =====================================================================
    console.log('\n-- 4. the same receipt, sent again -------------------------');
    // The real-world case: the ack was lost on a flaky link, so the DEVICE
    // still holds the op as pending and sends the byte-identical bytes again.
    // Driven through the client's own transport — a hand-built body here would
    // be the third thing that agrees with neither side (§0).
    await deviceDb.execute('UPDATE outbox SET server_ack_at = NULL WHERE idempotency_key = ?', [
      receiptId,
    ]);
    const real = httpUploadTransport({
      apiUrl: API_URL,
      apiToken: managerToken,
      fetchFn: browserUploadFetch,
    });
    let replayAck: string | undefined;
    const replayDrain = await drainOutbox(deviceDb, {
      async send(ops) {
        const res = await real.send(ops);
        if (res.ok) replayAck = res.acks.find((a) => a.key === receiptId)?.status;
        return res;
      },
    });
    check(
      '4a the byte-identical replay is acked DUPLICATE, not applied again',
      replayDrain.transportOk && replayAck === 'duplicate',
      `ack=${String(replayAck)} completed=${String(replayDrain.completed)} rejected=${String(replayDrain.rejected)}`,
    );

    const [afterReplay] = await scoped<{ on_hand: string }>(
      `select coalesce(sum(qty_delta), 0)::text as on_hand from app.stock_movement
        where tenant_id = $1 and location_id = $2 and product_id = $3`,
      [tenantId, locationId, conv.product_id],
    );
    const movementsAfter = await scoped<{ n: string }>(
      `select count(*)::text as n from app.stock_movement where tenant_id = $1 and write_id = $2`,
      [tenantId, receiptId],
    );
    const receiptsAfter = await scoped<{ n: string }>(
      `select count(*)::text as n from app.goods_receipt where tenant_id = $1 and write_id = $2`,
      [tenantId, receiptId],
    );
    check(
      '4b NO SECOND STOCK MOVEMENT and no second receipt — on-hand is unchanged (CLAUDE.md §2.2)',
      BigInt(afterReplay?.on_hand ?? '-1') === onHandAfter &&
        movementsAfter[0]?.n === '1' &&
        receiptsAfter[0]?.n === '1',
      `on_hand=${afterReplay?.on_hand ?? '?'} (was ${onHandAfter.toString()}) ` +
        `movements=${movementsAfter[0]?.n ?? '?'} receipts=${receiptsAfter[0]?.n ?? '?'}`,
    );

    // =====================================================================
    // 5 — DISPATCH TO A HAULIER, AND ON TO DELIVERED
    // =====================================================================
    console.log('\n-- 5. dispatch and delivery status -------------------------');
    const freightMinor = 45_000n;
    const planned = await planDelivery(
      {
        idempotencyKey: randomUUID(),
        sourceKind: 'PURCHASE_ORDER',
        sourceId: purchaseOrderId,
        carrierSupplierId: carrier.supplierId,
        carrierReference: `WB-${randomUUID().slice(0, 8)}`,
        toLocationId: locationId,
        plannedFor: today(),
        freightCostMinor: freightMinor.toString(),
      },
      optionsFor(managerToken),
    );
    check(
      '5a a delivery is PLANNED against a carrier that is a SUPPLIER (ADR-0001, no fleet)',
      planned.ok && planned.data.status === 'PLANNED',
      planned.ok
        ? `deliveryId=${planned.data.deliveryId} carrier=${carrier.code} status=${planned.data.status}`
        : `failure=${JSON.stringify(planned.failure)}`,
    );
    if (!planned.ok) throw new Error('cannot continue without a delivery');
    const deliveryId = planned.data.deliveryId;

    const hlc = fixedHlc(Date.now(), randomBytes(16).toString('hex'));
    // ─────────────────────────────────────────────────────────────────────
    // THE OUTBOX IS ORDERED BY ENQUEUE POSITION, NOT BY THE CLOCK.
    // This drill is what FOUND the defect: `readPendingOps` used to be
    // `ORDER BY created_at ASC, id ASC`, `created_at` is an ISO string at
    // millisecond resolution, and `id` is a uuidv7 with NO monotonic counter
    // inside a millisecond — so two writes made in the same millisecond
    // uploaded in a RANDOM relative order and PLANNED -> DELIVERED reached
    // the server. It self-healed (the out-of-order op is refused with a
    // retryable CONFLICT and lands on the next drain) but it was luck.
    //
    // The queue now orders on `outbox.queue_seq`, a strictly increasing
    // integer stamped inside the same local transaction as the insert
    // (apps/web/src/data/sync/queue-seq.ts). Both instants are still pinned
    // identical here so the tie happens EVERY run — and the assertion is now
    // the stronger one it could never make before: both moves apply on the
    // FIRST pass, in the order they were queued. See docs/phase2-status.md §0.
    // ─────────────────────────────────────────────────────────────────────
    const sameInstant = new Date().toISOString();
    for (const [from, to] of [
      ['PLANNED', 'DISPATCHED'],
      ['DISPATCHED', 'DELIVERED'],
    ] as const) {
      await recordDeliveryStatus(deviceDb, {
        updateId: uuidv7(),
        deliveryId,
        fromStatus: from,
        toStatus: to,
        hlc,
        nowIso: sameInstant,
      });
    }

    const statusAcks: string[] = [];
    let passes = 0;
    let firstPassCompleted = -1;
    let lastDrain = { transportOk: false, completed: 0, rejected: 0, deferred: 0 };
    while (passes < 3 && (await readPendingOps(deviceDb)).length > 0) {
      const report = await drainOutbox(deviceDb, {
        async send(ops) {
          const res = await real.send(ops);
          if (res.ok) {
            for (const a of res.acks) {
              statusAcks.push(`${a.status}${a.reason === undefined ? '' : `(${a.reason.slice(0, 40)}…)`}`);
            }
          }
          return res;
        },
      });
      if (passes === 0) firstPassCompleted = report.completed;
      lastDrain = report;
      passes += 1;
    }
    check(
      '5b both status moves apply IN QUEUE ORDER on the FIRST pass, from the same millisecond',
      lastDrain.rejected === 0 &&
        (await readPendingOps(deviceDb)).length === 0 &&
        firstPassCompleted === 2 &&
        passes === 1,
      `passes=${String(passes)} firstPassCompleted=${String(firstPassCompleted)}/2 ` +
        `pending=${String((await readPendingOps(deviceDb)).length)} acks=[${statusAcks.join(' | ')}]`,
    );
    measure(
      `two outbox writes at the SAME millisecond applied in ${String(passes)} drain pass(es); ` +
        `${String(firstPassCompleted)} of 2 on the first — the queue orders on outbox.queue_seq, ` +
        'the enqueue position, not on a millisecond clock plus a random uuid tail',
    );

    const [deliveryRow] = await scoped<{
      status: string;
      dispatched_at: string | null;
      delivered_at: string | null;
      carrier_supplier_id: string;
      freight_cost_minor: string | null;
    }>(
      `select status, dispatched_at::text, delivered_at::text, carrier_supplier_id::text,
              freight_cost_minor::text
         from app.delivery where tenant_id = $1 and id = $2`,
      [tenantId, deliveryId],
    );
    check(
      '5c Postgres says DELIVERED, with both timestamps and the carrier supplier on the row',
      deliveryRow?.status === 'DELIVERED' &&
        deliveryRow.dispatched_at !== null &&
        deliveryRow.delivered_at !== null &&
        deliveryRow.carrier_supplier_id === carrier.supplierId,
      `status=${deliveryRow?.status ?? '?'} dispatched=${deliveryRow?.dispatched_at ?? 'null'} ` +
        `delivered=${deliveryRow?.delivered_at ?? 'null'}`,
    );

    const readBack = await fetchDelivery(deliveryId, optionsFor(managerToken));
    check(
      "5d the client's own read agrees — and carries the freight as a bigint, never a number",
      readBack.ok && readBack.data.status === 'DELIVERED' && readBack.data.freightCostMinor === freightMinor,
      readBack.ok
        ? `status=${readBack.data.status} freight=${String(readBack.data.freightCostMinor)}`
        : `failure=${JSON.stringify(readBack.failure)}`,
    );

    const list = await fetchDeliveries(
      { sourceKind: 'PURCHASE_ORDER', sourceId: purchaseOrderId },
      optionsFor(managerToken),
    );
    check(
      '5e the delivery list finds it by the document it carries',
      list.ok && list.data.deliveries.some((d) => d.deliveryId === deliveryId),
      list.ok ? `deliveries=${String(list.data.deliveries.length)}` : `failure=${failureKind(list)}`,
    );

    // Q1: is haulage spend attributable? `logistics.haulageSpend` has NO
    // client module, so this one goes over raw tRPC and says so.
    const spend = await rawQuery(accountsToken, 'logistics.haulageSpend', {
      sourceId: purchaseOrderId,
      sourceKind: 'PURCHASE_ORDER',
    });
    const spendJson = spend.json as {
      total?: { haulageSpendMinor?: string };
      locations?: { locationId: string; haulageSpendMinor: string }[];
      basis?: string;
    };
    const attributed = spendJson.locations?.find((l) => l.locationId === locationId);
    check(
      '5f HAULAGE SPEND IS ATTRIBUTABLE TO THE LOCATION that received the goods (ADR-0001, Q1)',
      spend.status === 200 &&
        attributed !== undefined &&
        BigInt(attributed.haulageSpendMinor) === freightMinor,
      `status=${String(spend.status)} location=${attributed?.haulageSpendMinor ?? 'absent'} ` +
        `total=${spendJson.total?.haulageSpendMinor ?? '?'} basis=${spendJson.basis ?? '?'}`,
    );

    // The other half of Q1, now JOINED to the numerator above rather than
    // answering null. The drill asserts the two agree over the same period
    // and the same location — one numerator, published by two routes.
    const ratio = await rawQuery(accountsToken, 'reports.distributionCostRatio', {
      from: today(),
      to: today(),
      locationIds: [locationId],
    });
    const ratioJson = ratio.json as {
      locations?: {
        distributionCostMinor: string | null;
        distributionCostPctE4: string | null;
        deliveryCount?: number;
        unavailable: string | null;
      }[];
      total?: { distributionCostMinor: string | null };
    };
    const ratioRow = ratioJson.locations?.[0];

    // The comparison has to be like for like. 5f narrowed the spend to THIS
    // order; the ratio cannot be narrowed that way and must not be, so the
    // control is the same spend query over the same location and the same
    // day with no document filter. If the two numbers differ, two screens
    // are quoting different answers for one month.
    const daySpend = await rawQuery(accountsToken, 'logistics.haulageSpend', {
      from: today(),
      to: today(),
      locationIds: [locationId],
    });
    const daySpendJson = daySpend.json as {
      locations?: { locationId: string; haulageSpendMinor: string }[];
    };
    const dayRow = daySpendJson.locations?.find((l) => l.locationId === locationId);
    check(
      '5g THE Q1 RATIO IS COMPUTABLE: distributionCostRatio carries the haulage numerator',
      ratio.status === 200 &&
        daySpend.status === 200 &&
        ratioRow?.distributionCostMinor != null &&
        dayRow !== undefined &&
        ratioRow.distributionCostMinor === dayRow.haulageSpendMinor &&
        BigInt(ratioRow.distributionCostMinor) >= freightMinor,
      `ratio=${String(ratioRow?.distributionCostMinor)} spend=${String(dayRow?.haulageSpendMinor)} ` +
        `pctE4=${String(ratioRow?.distributionCostPctE4)} ` +
        `deliveries=${String(ratioRow?.deliveryCount)} unavailable=${String(ratioRow?.unavailable)} ` +
        `— one numerator, two routes, and it includes this drill's ${freightMinor.toString(10)}`,
    );

    // =====================================================================
    // 6 — TWO TENANTS, EVERY NEW READ PATH
    // =====================================================================
    console.log('\n-- 6. tenant isolation on the new read paths ---------------');
    const bManager = devToken('outlet_manager', 'B');
    const bAccounts = devToken('accounts', 'B');
    const { tid: tenantB } = claimsOf(bManager);
    check(
      '6a the second tenant is a different tenant',
      tenantB !== tenantId,
      `A=${tenantId} B=${tenantB}`,
    );

    const bOrder = await fetchPurchaseOrder(purchaseOrderId, optionsFor(bManager));
    check(
      "6b tenant B asking for tenant A's PURCHASE ORDER by id gets nothing",
      !bOrder.ok,
      bOrder.ok ? `LEAK: status=${bOrder.data.status} total=${bOrder.data.totalMinor.toString()}` : `kind=${failureKind(bOrder)}`,
    );

    const bDelivery = await fetchDelivery(deliveryId, optionsFor(bManager));
    check(
      "6c tenant B asking for tenant A's DELIVERY by id gets nothing",
      !bDelivery.ok,
      bDelivery.ok ? `LEAK: status=${bDelivery.data.status}` : `kind=${failureKind(bDelivery)}`,
    );

    const bOrders = await fetchPurchaseOrders({ limit: 500 }, optionsFor(bManager));
    check(
      "6d tenant B's ORDER LIST contains none of tenant A's orders",
      bOrders.ok && !bOrders.data.orders.some((o) => o.purchaseOrderId === purchaseOrderId),
      bOrders.ok ? `orders=${String(bOrders.data.orders.length)}` : `failure=${failureKind(bOrders)}`,
    );

    const bDeliveries = await fetchDeliveries({ limit: 500 }, optionsFor(bManager));
    check(
      "6e tenant B's DELIVERY LIST contains none of tenant A's deliveries",
      bDeliveries.ok && !bDeliveries.data.deliveries.some((d) => d.deliveryId === deliveryId),
      bDeliveries.ok ? `deliveries=${String(bDeliveries.data.deliveries.length)}` : `failure=${failureKind(bDeliveries)}`,
    );

    const bSuppliers = await fetchSuppliers({}, optionsFor(bManager));
    const aSupplierIds = new Set(goods.data.suppliers.map((s) => s.supplierId));
    check(
      "6f tenant B's SUPPLIER LIST shares no supplier ID with tenant A's — same codes, different rows",
      bSuppliers.ok && !bSuppliers.data.suppliers.some((s) => aSupplierIds.has(s.supplierId)),
      bSuppliers.ok
        ? `B suppliers=${String(bSuppliers.data.suppliers.length)} overlap=0`
        : `failure=${failureKind(bSuppliers)}`,
    );

    const bSources = await fetchSourcesForProduct(conv.product_id, optionsFor(bManager));
    check(
      "6g tenant B asking about tenant A's PRODUCT gets no sources for it",
      !bSources.ok || bSources.data.sources.length === 0,
      bSources.ok ? `sources=${String(bSources.data.sources.length)}` : `kind=${failureKind(bSources)}`,
    );

    // The POSITIVE CONTROL first: the id is real and tenant A can read it, so
    // tenant B's refusal is isolation rather than a nonexistent row.
    const aReceipt = await rawQuery(managerToken, 'receiving.get', {
      goodsReceiptId: goodsReceiptId ?? receiptId,
    });
    check(
      "6h.0 positive control: tenant A CAN read its own goods receipt by that id",
      aReceipt.status === 200,
      `status=${String(aReceipt.status)} id=${String(goodsReceiptId)}`,
    );
    const bReceipt = await rawQuery(bManager, 'receiving.get', {
      goodsReceiptId: goodsReceiptId ?? receiptId,
    });
    check(
      "6h tenant B asking for tenant A's GOODS RECEIPT by that same id gets nothing",
      bReceipt.status !== 200,
      `status=${String(bReceipt.status)}`,
    );

    const bStatus = await rawQuery(bManager, 'receiving.purchaseOrderReceiptStatus', {
      purchaseOrderId,
    });
    check(
      "6i tenant B asking for tenant A's RECEIPT STATUS by order id gets nothing",
      bStatus.status !== 200,
      `status=${String(bStatus.status)}`,
    );

    const bSpend = await rawQuery(bAccounts, 'logistics.haulageSpend', {
      sourceId: purchaseOrderId,
      sourceKind: 'PURCHASE_ORDER',
    });
    const bSpendJson = bSpend.json as { total?: { haulageSpendMinor?: string; deliveryCount?: number } };
    check(
      "6j tenant B's HAULAGE SPEND for tenant A's order is empty, not tenant A's figure",
      bSpend.status === 200 &&
        bSpendJson.total?.haulageSpendMinor === '0' &&
        bSpendJson.total.deliveryCount === 0,
      `spend=${String(bSpendJson.total?.haulageSpendMinor)} deliveries=${String(bSpendJson.total?.deliveryCount)}`,
    );

    const bSuggest = await fetchReorderSuggestions({ locationIds: [locationId] }, optionsFor(bManager));
    check(
      "6k tenant B narrowing REORDER SUGGESTIONS to tenant A's location is refused, not answered",
      !bSuggest.ok,
      bSuggest.ok ? `LEAK: suggestions=${String(bSuggest.data.suggestions.length)}` : `kind=${failureKind(bSuggest)}`,
    );

    // =====================================================================
    // 7 — OFFLINE HONESTY on the buying reads
    // =====================================================================
    console.log('\n-- 7. offline honesty --------------------------------------');
    const offline = optionsFor(managerToken, deadApiFetch);
    for (const [what, result] of [
      ['the supplier list', await fetchSuppliers({}, offline)],
      ['an order', await fetchPurchaseOrder(purchaseOrderId, offline)],
      ['the order list', await fetchPurchaseOrders({ limit: 10 }, offline)],
      ['a delivery', await fetchDelivery(deliveryId, offline)],
      ['reorder suggestions', await fetchReorderSuggestions({ locationIds: [locationId] }, offline)],
    ] as const) {
      check(
        `7 ${what} answers OFFLINE — never an empty list, never a zero`,
        !result.ok && result.failure.kind === 'offline',
        result.ok ? 'RETURNED DATA WITH NO NETWORK' : `kind=${result.failure.kind}`,
      );
    }
  } finally {
    await sql.end();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n=== D11: ${checks.length - failed.length}/${checks.length} checks passed ===`);
  console.log(`__DRILL_RESULT__ ${JSON.stringify({ checks, measurements })}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error('D11 aborted:', message);
  console.log(`__DRILL_RESULT__ ${JSON.stringify({ checks, measurements, error: message })}`);
  process.exit(1);
});
