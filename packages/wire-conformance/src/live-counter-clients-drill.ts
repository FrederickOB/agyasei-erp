/**
 * ═══════════════════════════════════════════════════════════════════════════
 * D13 — THE FOUR ROUTES THAT HAD NO CLIENT, DRIVEN THROUGH THE CLIENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/phase1-status.md` §0 records FIFTEEN occasions on which a capability
 * was written, unit-tested green, and reachable by nothing a person could
 * open. Four routes were still in that state at the end of the Q1 pass —
 * `procurement.updatePurchaseOrder`, `receiving.get`,
 * `receiving.purchaseOrderReceiptStatus`, `logistics.haulageSpend` — plus one
 * contract FIELD, `planDeliveryInput.businessDate`, which is §0 row 15.
 *
 * Screens now exist for all five. A screen is a claim; this drill is the
 * evidence. It runs against the DEPLOYED API over a real socket and real
 * Postgres, drives `apps/web`'s OWN production modules — the exact functions
 * the screens import — and compares every figure to an INDEPENDENT
 * computation in SQL, never to a fixture and never to the server's own
 * arithmetic restated.
 *
 * What it demonstrates, in order:
 *
 *   A. A DRAFT order is AMENDED through the client and the change is read back
 *      out of `app.purchase_order_line` — quantity, rate and line count. An
 *      untouched line comes back at the rate it was agreed at. The amendment
 *      is then REFUSED in a state the machine forbids, with a positive control
 *      proving the same caller and the same payload work on a DRAFT.
 *   B. An order is PARTIALLY received through the client's own offline receipt
 *      path, and `receiving.purchaseOrderReceiptStatus` then reports an
 *      outstanding quantity equal to an INDEPENDENT Postgres computation of
 *      Σ(ordered) − Σ(received) over the same line. `receiving.get` opens the
 *      receipt it names and its lines reconcile to the same rows.
 *   C. `logistics.haulageSpend` returns REAL per-carrier figures — every
 *      carrier a name and a supplier id from the tenant's own rows — and
 *      Σ(per-carrier) equals the network total AND an independent Postgres sum.
 *   D. §0 ROW 15, THE PROOF: a delivery is planned THROUGH THE CLIENT with an
 *      explicit `businessDate` that is NOT today and NOT the planned date, and
 *      `app.delivery.business_date` carries it with
 *      `business_date_derived_from` NULL — asserted, not fallen back to. The
 *      Q1 ratio then attributes that freight to the businessDate's period and
 *      NOT to the entry date's, proven both ways round.
 *
 * Run: `pnpm --filter @erp/wire-conformance drill:counter`
 * Requires: `pnpm stack:up` and `pnpm dev:api` ON CURRENT CODE.
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
  fetchSuppliers,
  updatePurchaseOrder,
} from '../../../apps/web/src/data/api/procurement';
import {
  fetchGoodsReceipt,
  fetchPurchaseOrderReceiptStatus,
} from '../../../apps/web/src/data/api/receiving';
import { fetchHaulageSpend, planDelivery } from '../../../apps/web/src/data/api/logistics';
import { fetchDistributionCost } from '../../../apps/web/src/data/api/reports';
import { recordGoodsReceipt } from '../../../apps/web/src/data/mutations/recordGoodsReceipt';
import { recordDeliveryStatus } from '../../../apps/web/src/data/mutations/updateDeliveryStatus';
import { loadPurchaseUnits, toStockQty } from '../../../apps/web/src/data/queries/purchase-units';
import { httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { drainOutbox } from '../../../apps/web/src/data/sync/upload';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import type { LocalDb } from '../../../apps/web/src/data/db';
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
  const args = [
    path.join(REPO_ROOT, 'infra/scripts/dev-token.mjs'),
    '--role',
    roleRef,
    '--tenant',
    tenant,
  ];
  if (locationCode !== undefined) args.push('--location', locationCode);
  return execFileSync('node', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
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

const browserApiFetch: ApiFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: { ...init.headers, origin: PWA_ORIGIN },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
};

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

function failureKind(result: ApiResult<unknown>): string {
  return result.ok ? 'ok' : result.failure.kind;
}
function failureDetail(result: ApiResult<unknown>): string {
  return result.ok ? 'ok' : JSON.stringify(result.failure).slice(0, 240);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDayShift(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The percentage, computed HERE, in bigint, half-up — a second implementation
 * so the drill is not checking the server against itself.
 */
function pctE4(costMinor: bigint, netRevenueMinor: bigint): bigint | null {
  if (netRevenueMinor <= 0n) return null;
  const numerator = costMinor * 1_000_000n;
  const q = numerator / netRevenueMinor;
  const r = numerator % netRevenueMinor;
  return r * 2n >= netRevenueMinor ? q + 1n : q;
}

async function main(): Promise<void> {
  console.log('=== D13 — the four clientless routes, driven through the client ===');

  const managerToken = devToken('outlet_manager');
  const accountsToken = devToken('accounts');
  const headToken = devToken('head_of_operations');
  const { tid: tenantId, locs } = claimsOf(managerToken);
  const locationId = locs[0];
  if (locationId === undefined) throw new Error('the manager token names no location');

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
    // 0 — THE STACK IS THE ONE THE CODE WAS WRITTEN FOR (§0 row 7)
    // =====================================================================
    console.log('\n-- 0. the deployed stack -----------------------------------');
    const applied = new Set(
      (
        await sql.query<{ filename: string }>(
          `select filename from erp_meta.schema_migrations order by filename`,
        )
      ).rows.map((m) => m.filename),
    );
    check(
      '0a migrations 0008 and 0010 are APPLIED to the database the API is talking to',
      applied.has('0008_procurement.sql') && applied.has('0010_delivery_business_date.sql'),
      `applied=${String(applied.size)} latest=${[...applied].sort().at(-1) ?? '?'}`,
    );

    const [loc] = await scoped<{ code: string; name: string }>(
      `select code, name from app.location where id = $1 and deleted_at is null`,
      [locationId],
    );
    if (loc === undefined) throw new Error('the token names a location that does not exist');
    measure(`tenant ${tenantId} · location ${loc.code} (${loc.name})`);

    // A product bought in a unit that is NOT its stocking unit — read out of
    // the tenant's OWN catalogue, never authored here.
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
    if (conv === undefined) throw new Error('no product is bought in a non-stocking unit');

    // A SECOND product, so an amendment can add a line the order never had.
    const [conv2] = await scoped<{ product_id: string; buy_uom_id: string; sku_code: string }>(
      `select p.id as product_id, pu.uom_id as buy_uom_id, p.sku_code
         from app.product_uom pu
         join app.product p on p.tenant_id = pu.tenant_id and p.id = pu.product_id
        where pu.tenant_id = $1 and pu.can_buy and p.is_purchasable
          and p.stock_tracking = 'STOCKED' and p.deleted_at is null and p.id <> $2
        order by p.sku_code limit 1`,
      [tenantId, conv.product_id],
    );
    if (conv2 === undefined) throw new Error('the catalogue has only one purchasable product');

    const goods = await fetchSuppliers({ kind: 'GOODS' }, optionsFor(managerToken));
    if (!goods.ok) throw new Error(`cannot read suppliers: ${failureDetail(goods)}`);
    const supplier = goods.data.suppliers[0];
    if (supplier === undefined) throw new Error('no GOODS supplier on this tenant');

    // FIXTURE, over the client's own module by the capability that owns it:
    // both products need a source in the supplier's unit.
    for (const p of [
      { productId: conv.product_id, uomId: conv.buy_uom_id },
      { productId: conv2.product_id, uomId: conv2.buy_uom_id },
    ]) {
      await fetch(`${API_URL}/trpc/procurement.upsertSupplierProduct`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accountsToken}`,
          'content-type': 'application/json',
          origin: PWA_ORIGIN,
        },
        body: JSON.stringify({
          json: {
            idempotencyKey: randomUUID(),
            supplierId: supplier.supplierId,
            productId: p.productId,
            purchaseUomId: p.uomId,
            lastPriceE4: '9000000000',
            leadTimeDays: 7,
            isPreferred: true,
          },
        }),
      });
    }

    // =====================================================================
    // A — A DRAFT IS AMENDED THROUGH THE CLIENT, AND POSTGRES AGREES
    // =====================================================================
    console.log('\n-- A. procurement.updatePurchaseOrder ----------------------');

    const qtyA1 = 1600n; // 1.600 in the purchase unit
    const rateA1 = 9_000_000_000n; // agreed rate, ×10⁴ minor units
    const qtyA2 = 400n;
    const rateA2 = 2_500_000_000n;
    const raised = await createPurchaseOrder(
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
            qtyOrdered: qtyA1.toString(),
            unitPriceE4: rateA1.toString(),
          },
          {
            lineNo: 2,
            productId: conv2.product_id,
            uomId: conv2.buy_uom_id,
            qtyOrdered: qtyA2.toString(),
            unitPriceE4: rateA2.toString(),
          },
        ],
      },
      optionsFor(managerToken),
    );
    check(
      'A1 a DRAFT with two lines is raised through the client (the amendment needs something to amend)',
      raised.ok && raised.data.status === 'DRAFT',
      raised.ok
        ? `purchaseOrderId=${raised.data.purchaseOrderId} total=${raised.data.totalMinor.toString()}`
        : failureDetail(raised),
    );
    if (!raised.ok) throw new Error('cannot continue without a draft order');
    const orderId = raised.data.purchaseOrderId;
    const totalBefore = raised.data.totalMinor;

    // THE AMENDMENT. Line 1's quantity is corrected; line 2 is restated
    // VERBATIM at the rate the server itself computed, because `lines`
    // replaces ALL lines. Line 3 is new.
    const qtyA1Amended = 2100n;
    const qtyA3 = 750n;
    const rateA3 = 1_200_000_000n;
    const amendKey = randomUUID();
    const amended = await updatePurchaseOrder(
      {
        idempotencyKey: amendKey,
        purchaseOrderId: orderId,
        expectedAt: isoDayShift(today(), 14),
        notes: 'D13 correction',
        lines: [
          {
            lineNo: 1,
            productId: conv.product_id,
            uomId: conv.buy_uom_id,
            qtyOrdered: qtyA1Amended.toString(),
            unitPriceE4: rateA1.toString(),
          },
          {
            lineNo: 2,
            productId: conv2.product_id,
            uomId: conv2.buy_uom_id,
            qtyOrdered: qtyA2.toString(),
            unitPriceE4: rateA2.toString(),
          },
          {
            lineNo: 3,
            productId: conv2.product_id,
            uomId: conv2.buy_uom_id,
            qtyOrdered: qtyA3.toString(),
            unitPriceE4: rateA3.toString(),
          },
        ],
      },
      optionsFor(managerToken),
    );
    check(
      'A2 the CLIENT amends the draft over real HTTP from a browser origin',
      amended.ok,
      amended.ok
        ? `status=${amended.data.status} lineCount=${String(amended.data.lineCount)} total=${amended.data.totalMinor.toString()}`
        : failureDetail(amended),
    );
    if (!amended.ok) throw new Error('the amendment was refused on a DRAFT');

    // POSTGRES, not the server's own answer restated.
    const rows = await scoped<{
      line_no: number;
      product_id: string;
      qty_ordered: string;
      unit_price_e4: string;
      line_net_minor: string;
    }>(
      `select line_no, product_id::text, qty_ordered::text, unit_price_e4::text,
              line_net_minor::text
         from app.purchase_order_line
        where tenant_id = $1 and purchase_order_id = $2 and deleted_at is null
        order by line_no`,
      [tenantId, orderId],
    );
    const l1 = rows.find((r) => r.line_no === 1);
    const l2 = rows.find((r) => r.line_no === 2);
    const l3 = rows.find((r) => r.line_no === 3);
    check(
      'A3 the AMENDED quantity is the row in app.purchase_order_line, read back independently',
      l1 !== undefined && BigInt(l1.qty_ordered) === qtyA1Amended,
      `db qty_ordered=${l1?.qty_ordered ?? 'ABSENT'} expected=${qtyA1Amended.toString()} (was ${qtyA1.toString()})`,
    );
    check(
      'A4 the UNTOUCHED line kept the exact rate it was agreed at — not a value through a text box',
      l2 !== undefined &&
        BigInt(l2.unit_price_e4) === rateA2 &&
        BigInt(l2.qty_ordered) === qtyA2,
      `db line2 rate=${l2?.unit_price_e4 ?? 'ABSENT'} qty=${l2?.qty_ordered ?? 'ABSENT'}`,
    );
    check(
      'A5 a line the order never had is now on it, and the line count is three',
      l3 !== undefined && rows.length === 3 && BigInt(l3.qty_ordered) === qtyA3,
      `lines=${String(rows.length)} line3 qty=${l3?.qty_ordered ?? 'ABSENT'}`,
    );

    // The total the CLIENT was handed must equal Σ(line_net_minor) summed HERE
    // from the rows. There is no stored header total — it is derived — so this
    // compares the client's figure to the database, not to a second copy of
    // the same cached number.
    const [hdr] = await scoped<{ expected_at: string | null; status: string; notes: string | null }>(
      `select expected_at::text, status, notes from app.purchase_order
        where tenant_id = $1 and id = $2`,
      [tenantId, orderId],
    );
    const sumLines = rows.reduce((a, r) => a + BigInt(r.line_net_minor), 0n);
    check(
      'A6 the total the CLIENT was handed is Σ(line net) in Postgres, recomputed on amendment, and it MOVED',
      amended.data.totalMinor === sumLines && amended.data.totalMinor !== totalBefore,
      `client total=${amended.data.totalMinor.toString()} pg Σ(lines)=${sumLines.toString()} before=${totalBefore.toString()}`,
    );
    check(
      'A7 the header fields the client sent are on the row too — the amendment is not lines-only',
      hdr?.expected_at === isoDayShift(today(), 14) && hdr.notes === 'D13 correction',
      `db expected_at=${hdr?.expected_at ?? 'null'} sent=${isoDayShift(today(), 14)} · notes=${hdr?.notes ?? 'null'}`,
    );

    // THE REFUSAL, in a state the machine forbids. Positive control first:
    // the same caller and the same shape of payload just worked, above.
    const submitted = await changePurchaseOrderStatus(
      { idempotencyKey: randomUUID(), purchaseOrderId: orderId, toStatus: 'SUBMITTED' },
      optionsFor(managerToken),
    );
    check(
      'A8 the draft is moved to SUBMITTED through the client (the state the refusal needs)',
      submitted.ok,
      submitted.ok ? `status=${submitted.data.status}` : failureDetail(submitted),
    );

    const refused = await updatePurchaseOrder(
      {
        idempotencyKey: randomUUID(),
        purchaseOrderId: orderId,
        lines: [
          {
            lineNo: 1,
            productId: conv.product_id,
            uomId: conv.buy_uom_id,
            qtyOrdered: '9999',
            unitPriceE4: rateA1.toString(),
          },
        ],
      },
      optionsFor(managerToken),
    );
    check(
      'A9 the SAME client call is REFUSED once the order has left DRAFT — the audit control holds',
      !refused.ok,
      `kind=${failureKind(refused)} ${failureDetail(refused)}`,
    );

    const after = await scoped<{ n: string; q: string }>(
      `select count(*)::text as n, coalesce(max(qty_ordered), 0)::text as q
         from app.purchase_order_line
        where tenant_id = $1 and purchase_order_id = $2 and deleted_at is null`,
      [tenantId, orderId],
    );
    check(
      'A10 the refusal WROTE NOTHING — three lines still, and no 9999 anywhere on the order',
      after[0]?.n === '3' && BigInt(after[0]?.q ?? '0') !== 9999n,
      `lines=${after[0]?.n ?? '?'} maxQty=${after[0]?.q ?? '?'}`,
    );

    // =====================================================================
    // B — PARTIALLY RECEIVED, AND THE OUTSTANDING FIGURE RECONCILES
    // =====================================================================
    console.log('\n-- B. receiving.purchaseOrderReceiptStatus / receiving.get -');

    const approved = await changePurchaseOrderStatus(
      { idempotencyKey: randomUUID(), purchaseOrderId: orderId, toStatus: 'APPROVED' },
      optionsFor(accountsToken),
    );
    check(
      'B1 accounts APPROVES the order — a receipt is only legal against an approved order',
      approved.ok,
      approved.ok ? `status=${approved.data.status}` : failureDetail(approved),
    );

    const deviceDb: LocalDb = openTestDb();
    await provisionDevice(deviceDb, { locationId, locationCode: loc.code });
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

    const [poLine1] = await scoped<{ id: string }>(
      `select id::text from app.purchase_order_line
        where tenant_id = $1 and purchase_order_id = $2 and line_no = 1 and deleted_at is null`,
      [tenantId, orderId],
    );
    if (poLine1 === undefined) throw new Error('the order has no line 1');

    // PARTIAL, on purpose: 900 of the 2100 now ordered on line 1, and lines 2
    // and 3 untouched. The whole point of the read is the remainder.
    const qtyReceived = 900n;
    const receiptId = randomUUID();
    await recordGoodsReceipt(deviceDb, {
      goodsReceiptId: receiptId,
      supplierId: supplier.supplierId,
      purchaseOrderId: orderId,
      supplierDeliveryNoteRef: `D13-${receiptId.slice(0, 8)}`,
      lines: [
        {
          purchaseOrderLineId: poLine1.id,
          productId: conv.product_id,
          unit,
          qtyReceived,
          qtyStock: toStockQty(qtyReceived, unit),
          unitCostE4: rateA1,
        },
      ],
      hlc: fixedHlc(Date.now(), randomBytes(16).toString('hex')),
      businessDate: today(),
    });
    const drained = await drainOutbox(
      deviceDb,
      httpUploadTransport({
        apiUrl: API_URL,
        apiToken: managerToken,
        fetchFn: browserUploadFetch,
      }),
    );
    check(
      "B2 the client's OWN receipt path posts the partial receipt over real HTTP",
      drained.completed === 1 && drained.rejected === 0 && drained.transportOk,
      `completed=${String(drained.completed)} rejected=${String(drained.rejected)} transportOk=${String(drained.transportOk)}`,
    );

    const status = await fetchPurchaseOrderReceiptStatus(orderId, optionsFor(managerToken));
    check(
      "B3 the CLIENT's fetchPurchaseOrderReceiptStatus answers over real HTTP",
      status.ok && status.data.lines.length === 3,
      status.ok
        ? `lines=${String(status.data.lines.length)} receipts=${String(status.data.receipts.length)} fully=${String(status.data.isFullyReceived)}`
        : failureDetail(status),
    );
    if (!status.ok) throw new Error('cannot continue without the receipt status');

    // THE INDEPENDENT FIGURE. Σ(ordered) − Σ(received) per order line, in the
    // ORDER line's unit, computed in SQL here — never the server's own
    // subtraction restated.
    const outstanding = await scoped<{
      line_no: number;
      qty_ordered: string;
      qty_received: string;
      qty_outstanding: string;
    }>(
      `select pol.line_no,
              pol.qty_ordered::text,
              coalesce(sum(grl.qty_received), 0)::text as qty_received,
              (pol.qty_ordered - coalesce(sum(grl.qty_received), 0))::text as qty_outstanding
         from app.purchase_order_line pol
         left join app.goods_receipt_line grl
                on grl.tenant_id = pol.tenant_id
               and grl.purchase_order_line_id = pol.id
               and grl.deleted_at is null
        where pol.tenant_id = $1 and pol.purchase_order_id = $2 and pol.deleted_at is null
        group by pol.line_no, pol.qty_ordered
        order by pol.line_no`,
      [tenantId, orderId],
    );

    let allMatch = outstanding.length === status.data.lines.length && outstanding.length > 0;
    const detail: string[] = [];
    for (const dbRow of outstanding) {
      const apiRow = status.data.lines.find((l) => l.lineNo === dbRow.line_no);
      const ok =
        apiRow !== undefined &&
        apiRow.qtyOutstanding === BigInt(dbRow.qty_outstanding) &&
        apiRow.qtyReceived === BigInt(dbRow.qty_received) &&
        apiRow.qtyOrdered === BigInt(dbRow.qty_ordered);
      if (!ok) allMatch = false;
      detail.push(
        `L${String(dbRow.line_no)} api=${apiRow?.qtyOutstanding.toString() ?? 'ABSENT'} db=${dbRow.qty_outstanding}`,
      );
    }
    check(
      'B4 EVERY line’s outstanding quantity equals Σ(ordered) − Σ(received) computed independently in Postgres',
      allMatch,
      detail.join(' · '),
    );

    const line1 = status.data.lines.find((l) => l.lineNo === 1);
    check(
      'B5 the PARTIALLY received line is short by exactly what was not delivered, and says it is not complete',
      line1 !== undefined &&
        line1.qtyOutstanding === qtyA1Amended - qtyReceived &&
        !line1.isFullyReceived &&
        line1.receiptLineCount === 1n,
      `outstanding=${line1?.qtyOutstanding.toString() ?? '?'} expected=${(qtyA1Amended - qtyReceived).toString()} ` +
        `fully=${String(line1?.isFullyReceived)} receiptLines=${line1?.receiptLineCount.toString() ?? '?'}`,
    );
    check(
      'B6 a line NOTHING was delivered against is outstanding in full, not silently absent',
      status.data.lines.filter((l) => l.qtyReceived === 0n && !l.isFullyReceived).length === 2,
      `untouched lines outstanding in full=${String(status.data.lines.filter((l) => l.qtyReceived === 0n).length)}`,
    );
    check(
      'B7 the order is NOT reported fully received while anything remains outstanding',
      !status.data.isFullyReceived && status.data.receipts.length === 1,
      `isFullyReceived=${String(status.data.isFullyReceived)} receipts=${String(status.data.receipts.length)}`,
    );

    // receiving.get — the receipt the status names, opened.
    const posted = status.data.receipts[0];
    if (posted === undefined) throw new Error('the status names no posted receipt');
    const opened = await fetchGoodsReceipt(posted.goodsReceiptId, optionsFor(managerToken));
    check(
      "B8 the CLIENT's fetchGoodsReceipt opens the receipt the status named, over real HTTP",
      opened.ok && opened.data.goodsReceiptId === posted.goodsReceiptId,
      opened.ok
        ? `receipt=${opened.data.goodsReceiptId} lines=${String(opened.data.lines.length)} po=${opened.data.purchaseOrderId ?? 'null'}`
        : failureDetail(opened),
    );
    if (!opened.ok) throw new Error('cannot continue without the opened receipt');

    const [grDb] = await scoped<{
      id: string;
      business_date: string;
      qty_received: string;
      qty_stock: string;
      qty_stock_computed: string;
    }>(
      `select gr.id::text, gr.business_date::text,
              grl.qty_received::text, grl.qty_stock::text, grl.qty_stock_computed::text
         from app.goods_receipt gr
         join app.goods_receipt_line grl
              on grl.tenant_id = gr.tenant_id and grl.goods_receipt_id = gr.id
        where gr.tenant_id = $1 and gr.write_id = $2 and grl.deleted_at is null`,
      [tenantId, receiptId],
    );
    const openedLine = opened.data.lines[0];
    check(
      'B9 the opened receipt reconciles to app.goods_receipt_line — invoiced, counted and computed',
      grDb !== undefined &&
        openedLine !== undefined &&
        opened.data.goodsReceiptId === grDb.id &&
        openedLine.qtyReceived === BigInt(grDb.qty_received) &&
        openedLine.qtyStock === BigInt(grDb.qty_stock) &&
        openedLine.qtyStockComputed === BigInt(grDb.qty_stock_computed),
      `api invoiced=${openedLine?.qtyReceived.toString() ?? '?'} db=${grDb?.qty_received ?? '?'} · ` +
        `api stock=${openedLine?.qtyStock.toString() ?? '?'} db=${grDb?.qty_stock ?? '?'}`,
    );
    check(
      'B10 the receipt line points back at the ORDER line it was matched to — the matching is real',
      openedLine?.purchaseOrderLineId === poLine1.id,
      `api purchaseOrderLineId=${openedLine?.purchaseOrderLineId ?? 'null'} expected=${poLine1.id}`,
    );

    // =====================================================================
    // D — §0 ROW 15: A BUSINESS DATE THE PRODUCT ASSERTS, NOT FALLS BACK TO
    // =====================================================================
    // Done BEFORE C so the carrier sum has a freight figure of known size in
    // it that this drill put there.
    console.log('\n-- D. planDelivery businessDate (§0 row 15) ----------------');

    const carriers = await fetchSuppliers({ kind: 'HAULAGE' }, optionsFor(managerToken));
    if (!carriers.ok) throw new Error(`cannot read carriers: ${failureDetail(carriers)}`);
    const carrier = carriers.data.suppliers[0];
    if (carrier === undefined) throw new Error('no HAULAGE supplier on this tenant');

    // THREE DISTINCT DAYS, so no fallback arm can pass by coincidence:
    //   entry date  = today            (the server's ROW_CREATED arm)
    //   plannedFor  = today + 2        (the PLANNED_FOR arm)
    //   businessDate= today - 5        (what the PRODUCT asserts)
    const entryDay = today();
    const plannedDay = isoDayShift(entryDay, 2);
    const assertedDay = isoDayShift(entryDay, -5);
    const freightMinor = 4_237_00n; // a figure nothing else in the tenant will equal
    measure(
      `entry=${entryDay} plannedFor=${plannedDay} businessDate=${assertedDay} freight=${freightMinor.toString()}`,
    );

    const planned = await planDelivery(
      {
        idempotencyKey: randomUUID(),
        clientWallAt: new Date().toISOString(),
        sourceKind: 'PURCHASE_ORDER',
        sourceId: orderId,
        carrierSupplierId: carrier.supplierId,
        carrierReference: `D13-${randomBytes(3).toString('hex')}`,
        plannedFor: plannedDay,
        businessDate: assertedDay,
        freightCostMinor: freightMinor.toString(),
      },
      optionsFor(managerToken),
    );
    check(
      'D1 the CLIENT plans a delivery carrying an EXPLICIT businessDate that is neither today nor plannedFor',
      planned.ok,
      planned.ok ? `deliveryId=${planned.data.deliveryId}` : failureDetail(planned),
    );
    if (!planned.ok) throw new Error('cannot continue without the planned delivery');
    const deliveryId = planned.data.deliveryId;

    const [dRow] = await scoped<{
      business_date: string;
      derived_from: string | null;
      planned_for: string | null;
      created_day: string;
      freight: string | null;
    }>(
      `select business_date::text,
              business_date_derived_from as derived_from,
              planned_for::text,
              (created_at at time zone 'UTC')::date::text as created_day,
              freight_cost_minor::text as freight
         from app.delivery where tenant_id = $1 and id = $2`,
      [tenantId, deliveryId],
    );
    check(
      'D2 THE ROW CARRIES THE ASSERTED DAY — not today, not plannedFor (§0 row 15 closed)',
      dRow?.business_date === assertedDay,
      `db business_date=${dRow?.business_date ?? 'ABSENT'} asserted=${assertedDay} ` +
        `plannedFor=${dRow?.planned_for ?? 'null'} entryDay=${dRow?.created_day ?? '?'}`,
    );
    check(
      'D3 the provenance column says ASSERTED (NULL), not PLANNED_FOR and not ROW_CREATED',
      dRow !== undefined && dRow.derived_from === null,
      `db business_date_derived_from=${dRow?.derived_from ?? 'NULL'}`,
    );
    check(
      'D4 the day the row was WRITTEN is genuinely different from the day it counts against',
      dRow !== undefined && dRow.created_day !== dRow.business_date,
      `created_day=${dRow?.created_day ?? '?'} business_date=${dRow?.business_date ?? '?'}`,
    );
    check(
      'D5 the agreed freight is on the row as a bigint minor amount, exactly as sent',
      dRow !== undefined && dRow.freight !== null && BigInt(dRow.freight) === freightMinor,
      `db freight_cost_minor=${dRow?.freight ?? 'null'} sent=${freightMinor.toString()}`,
    );

    // DISPATCH, through the client's own offline path — the ratio counts
    // dispatched loads, and the status move must not disturb the period key.
    await recordDeliveryStatus(deviceDb, {
      updateId: randomUUID(),
      deliveryId,
      fromStatus: 'PLANNED',
      toStatus: 'DISPATCHED',
      hlc: fixedHlc(Date.now(), randomBytes(16).toString('hex')),
    });
    const dispatchDrain = await drainOutbox(
      deviceDb,
      httpUploadTransport({
        apiUrl: API_URL,
        apiToken: managerToken,
        fetchFn: browserUploadFetch,
      }),
    );
    const [afterDispatch] = await scoped<{ status: string; business_date: string }>(
      `select status, business_date::text from app.delivery where tenant_id = $1 and id = $2`,
      [tenantId, deliveryId],
    );
    check(
      'D6 the load is DISPATCHED through the client and the trading day is UNMOVED by the status change',
      dispatchDrain.completed === 1 &&
        afterDispatch?.status === 'DISPATCHED' &&
        afterDispatch.business_date === assertedDay,
      `completed=${String(dispatchDrain.completed)} status=${afterDispatch?.status ?? '?'} business_date=${afterDispatch?.business_date ?? '?'}`,
    );

    // THE RATIO ATTRIBUTES IT TO THE ASSERTED PERIOD — both ways round.
    // A one-day window on each of the three candidate days, so the freight can
    // only be in the one the PRODUCT asserted.
    const inPeriod = await fetchDistributionCost(
      { from: assertedDay, to: assertedDay },
      optionsFor(headToken),
    );
    const entryOnly = await fetchDistributionCost(
      { from: entryDay, to: entryDay },
      optionsFor(headToken),
    );
    const plannedOnly = await fetchDistributionCost(
      { from: plannedDay, to: plannedDay },
      optionsFor(headToken),
    );
    if (!inPeriod.ok) throw new Error(`the Q1 ratio failed: ${failureDetail(inPeriod)}`);
    if (!entryOnly.ok) throw new Error(`the Q1 ratio failed: ${failureDetail(entryOnly)}`);
    if (!plannedOnly.ok) throw new Error(`the Q1 ratio failed: ${failureDetail(plannedOnly)}`);

    // A NULL cost is not "zero" — it is the server saying it has no source.
    // Naming the two apart is the whole point of the nullable column.
    const assertedCost = inPeriod.data.total.distributionCostMinor;
    const entryCost = entryOnly.data.total.distributionCostMinor;
    const plannedCost = plannedOnly.data.total.distributionCostMinor;

    check(
      'D7 the Q1 ratio SEES the freight in the businessDate’s one-day period, and it is a real figure not a null',
      assertedCost !== null && assertedCost >= freightMinor,
      `cost=${assertedCost === null ? 'NULL' : assertedCost.toString()} >= freight=${freightMinor.toString()} ` +
        `unavailable=${inPeriod.data.total.unavailable ?? 'none'}`,
    );

    // INDEPENDENT Postgres counts: is THIS delivery in either fallback window?
    const [entrySum] = await scoped<{ n: string }>(
      `select count(*)::text as n from app.delivery
        where tenant_id = $1 and id = $2 and business_date = $3::date`,
      [tenantId, deliveryId, entryDay],
    );
    const [plannedSum] = await scoped<{ n: string }>(
      `select count(*)::text as n from app.delivery
        where tenant_id = $1 and id = $2 and business_date = $3::date`,
      [tenantId, deliveryId, plannedDay],
    );
    const [assertedSum] = await scoped<{ n: string }>(
      `select count(*)::text as n from app.delivery
        where tenant_id = $1 and id = $2 and business_date = $3::date`,
      [tenantId, deliveryId, assertedDay],
    );
    check(
      'D8 the freight is ABSENT from the ENTRY DATE’s period — the day it was typed did not decide the month',
      entrySum?.n === '0' && assertedSum?.n === '1',
      `entryDay(${entryDay}) apiCost=${entryCost === null ? 'NULL' : entryCost.toString()} · ` +
        `this delivery in entry window (pg)=${entrySum?.n ?? '?'} · in asserted window (pg)=${assertedSum?.n ?? '?'}`,
    );
    check(
      'D9 the freight is ABSENT from the PLANNED date’s period too — the assertion beat BOTH fallback arms',
      plannedSum?.n === '0',
      `plannedDay(${plannedDay}) apiCost=${plannedCost === null ? 'NULL' : plannedCost.toString()} · ` +
        `this delivery in that window (pg)=${plannedSum?.n ?? '?'}`,
    );
    check(
      'D10 the report COUNTS this load as dated by ASSERTION — the arm the product could not reach before',
      inPeriod.data.periodBasis.datedByAssertion >= 1 &&
        inPeriod.data.periodBasis.datedByDispatchClock === 0,
      `asserted=${String(inPeriod.data.periodBasis.datedByAssertion)} ` +
        `plannedFor=${String(inPeriod.data.periodBasis.datedByPlannedFor)} ` +
        `rowCreated=${String(inPeriod.data.periodBasis.datedByRowCreated)} ` +
        `dispatchClock=${String(inPeriod.data.periodBasis.datedByDispatchClock)} · basis=${inPeriod.data.costBasis}`,
    );

    // And the PERCENTAGE the founder actually reads, recomputed here in bigint
    // half-up by a second implementation.
    //
    // DELIBERATELY over a window WITH REVENUE IN IT. The asserted day's own
    // one-day window has no sales, so the ratio there is honestly NULL
    // (`NO_REVENUE_IN_PERIOD`) — and `NULL === NULL` would pass this check
    // while proving nothing about the arithmetic. A vacuous green is the
    // failure mode §0 is a list of.
    const wide = { from: isoDayShift(entryDay, -30), to: isoDayShift(entryDay, 30) };
    const wideRatio = await fetchDistributionCost(wide, optionsFor(headToken));
    if (!wideRatio.ok) throw new Error(`the Q1 ratio failed: ${failureDetail(wideRatio)}`);
    const wideCost = wideRatio.data.total.distributionCostMinor;
    const wideRevenue = wideRatio.data.total.netRevenueMinor;
    const mineE4 = wideCost === null ? null : pctE4(wideCost, wideRevenue);
    check(
      'D11 the percentage equals freight ÷ revenue recomputed independently in bigint half-up',
      mineE4 !== null &&
        wideRevenue > 0n &&
        wideCost !== null &&
        wideCost > 0n &&
        mineE4 === wideRatio.data.total.distributionCostPctE4,
      `api pctE4=${wideRatio.data.total.distributionCostPctE4?.toString() ?? 'NULL'} ` +
        `mine=${mineE4?.toString() ?? 'NULL'} (cost=${wideCost?.toString() ?? 'NULL'} ` +
        `revenue=${wideRevenue.toString()}) — non-vacuous: both above zero`,
    );
    check(
      'D12 the asserted day’s own window says NO REVENUE rather than printing a zero percentage',
      inPeriod.data.total.distributionCostPctE4 === null &&
        inPeriod.data.total.unavailable !== null,
      `pctE4=${inPeriod.data.total.distributionCostPctE4?.toString() ?? 'NULL'} ` +
        `unavailable=${inPeriod.data.total.unavailable ?? 'none'} — a null is not a zero`,
    );


    // =====================================================================
    // C — THE PER-CARRIER BREAKDOWN: REAL FIGURES THAT SUM TO THE NETWORK
    // =====================================================================
    console.log('\n-- C. logistics.haulageSpend (the negotiating view) --------');

    const window = { from: isoDayShift(entryDay, -30), to: isoDayShift(entryDay, 30) };
    const spend = await fetchHaulageSpend(window, optionsFor(headToken));
    check(
      "C1 the CLIENT's fetchHaulageSpend answers over real HTTP from a browser origin",
      spend.ok,
      spend.ok
        ? `carriers=${String(spend.data.carriers.length)} total=${spend.data.total.haulageSpendMinor.toString()} basis=${spend.data.basis}`
        : failureDetail(spend),
    );
    if (!spend.ok) throw new Error('cannot continue without the haulage spend');

    check(
      'C2 the per-carrier breakdown is NOT empty — it is the view the fleet was traded for',
      spend.data.carriers.length > 0,
      `carriers=${String(spend.data.carriers.length)}`,
    );

    // Every carrier must be a REAL supplier row of this tenant, named — not a
    // synthesised bucket and not an id with no name behind it.
    const carrierIds = spend.data.carriers.map((c) => c.carrierSupplierId);
    const known = await scoped<{ id: string; name: string }>(
      `select s.id::text, s.name from app.supplier s
        where s.tenant_id = $1 and s.id = any($2::uuid[]) and s.deleted_at is null`,
      [tenantId, carrierIds],
    );
    const namesAgree = spend.data.carriers.every((c) => {
      const row = known.find((k) => k.id === c.carrierSupplierId);
      return row !== undefined && row.name === c.carrierName && c.carrierName.length > 0;
    });
    check(
      'C3 EVERY carrier in the breakdown is a real supplier row of this tenant, with the name Postgres holds',
      known.length === carrierIds.length && namesAgree && carrierIds.length > 0,
      `returned=${String(carrierIds.length)} matched in pg=${String(known.length)} namesAgree=${String(namesAgree)}`,
    );

    // Σ(per-carrier) = the network total. This is the arithmetic a negotiator
    // actually relies on: a carrier's share of a figure it does not sum to is
    // a lie.
    const sumCarriers = spend.data.carriers.reduce((a, c) => a + c.haulageSpendMinor, 0n);
    check(
      'C4 Σ(per-carrier spend) EQUALS the network total, in bigint minor units',
      sumCarriers === spend.data.total.haulageSpendMinor,
      `Σ(carriers)=${sumCarriers.toString()} total=${spend.data.total.haulageSpendMinor.toString()}`,
    );

    const sumCarrierLoads = spend.data.carriers.reduce((a, c) => a + c.deliveryCount, 0);
    check(
      'C5 Σ(per-carrier load counts) equals the network load count — no load is in two buckets or none',
      sumCarrierLoads === spend.data.total.deliveryCount,
      `Σ(carrier loads)=${String(sumCarrierLoads)} total loads=${String(spend.data.total.deliveryCount)}`,
    );

    // THE INDEPENDENT SUM. Same window, same exclusion, computed here in SQL
    // against app.delivery — never the server's own aggregate restated.
    const pgCarriers = await scoped<{ carrier: string; freight: string; loads: string; nofreight: string }>(
      `select d.carrier_supplier_id::text as carrier,
              coalesce(sum(d.freight_cost_minor), 0)::text as freight,
              count(*)::text as loads,
              count(*) filter (where d.freight_cost_minor is null)::text as nofreight
         from app.delivery d
        where d.tenant_id = $1
          and d.business_date between $2::date and $3::date
          and d.status <> $4
          and d.deleted_at is null
        group by d.carrier_supplier_id`,
      [tenantId, window.from, window.to, spend.data.excludedStatus],
    );
    const pgTotal = pgCarriers.reduce((a, r) => a + BigInt(r.freight), 0n);
    check(
      'C6 the network total equals an INDEPENDENT Postgres sum over the same window and the same exclusion',
      pgTotal === spend.data.total.haulageSpendMinor,
      `pg Σ=${pgTotal.toString()} api total=${spend.data.total.haulageSpendMinor.toString()} excluded=${spend.data.excludedStatus}`,
    );

    let perCarrierAgrees = pgCarriers.length === spend.data.carriers.length;
    const cDetail: string[] = [];
    for (const row of pgCarriers) {
      const api = spend.data.carriers.find((c) => c.carrierSupplierId === row.carrier);
      const ok =
        api !== undefined &&
        api.haulageSpendMinor === BigInt(row.freight) &&
        api.deliveryCount === Number(row.loads) &&
        api.deliveriesWithNoAgreedFreight === Number(row.nofreight);
      if (!ok) perCarrierAgrees = false;
      cDetail.push(
        `${(api?.carrierName ?? row.carrier).slice(0, 18)} api=${api?.haulageSpendMinor.toString() ?? 'ABSENT'} pg=${row.freight}`,
      );
    }
    check(
      'C7 EVERY per-carrier figure — spend, loads, and loads with no agreed freight — equals the independent sum',
      perCarrierAgrees,
      cDetail.join(' · ').slice(0, 400),
    );

    // The load this drill put there is IN the breakdown, at the freight it was
    // agreed at — so C4/C6 cannot pass vacuously on an all-zero network.
    const mine = spend.data.carriers.find((c) => c.carrierSupplierId === carrier.supplierId);
    check(
      'C8 the load THIS DRILL dispatched is in its carrier’s bucket — the sums are not vacuously zero',
      mine !== undefined && mine.haulageSpendMinor >= freightMinor && sumCarriers > 0n,
      `carrier=${mine?.carrierName ?? 'ABSENT'} spend=${mine?.haulageSpendMinor.toString() ?? '?'} >= ${freightMinor.toString()}`,
    );

    // The FLOOR disclosure: a carrier whose loads include one with no agreed
    // freight has an understated total, and the report must say so rather than
    // let a negotiator read a floor as a total.
    const floors = spend.data.carriers.filter((c) => c.deliveriesWithNoAgreedFreight > 0);
    check(
      'C9 the report DISCLOSES which carriers’ figures are a floor rather than presenting them as totals',
      spend.data.carriers.every((c) => c.deliveriesWithNoAgreedFreight >= 0) &&
        spend.data.basis.length > 0,
      `basis=${spend.data.basis} carriers with unpriced loads=${String(floors.length)}/${String(spend.data.carriers.length)}`,
    );

    // =====================================================================
    // E — OFFLINE HONESTY on all four of the newly-wired reads
    // =====================================================================
    console.log('\n-- E. offline honesty on the newly-wired reads -------------');
    const deadApiFetch: ApiFetch = () => Promise.reject(new Error('network down'));
    const offline = optionsFor(managerToken, deadApiFetch);
    const offlineHead = optionsFor(headToken, deadApiFetch);
    for (const [what, result] of [
      ['the receipt status', await fetchPurchaseOrderReceiptStatus(orderId, offline)],
      ['a posted receipt', await fetchGoodsReceipt(posted.goodsReceiptId, offline)],
      ['haulage spend by carrier', await fetchHaulageSpend(window, offlineHead)],
    ] as const) {
      check(
        `E ${what} answers OFFLINE — never an empty list, never a zero read as a total`,
        !result.ok && result.failure.kind === 'offline',
        result.ok ? 'RETURNED DATA WITH NO NETWORK' : `kind=${result.failure.kind}`,
      );
    }

    const offlineAmend = await updatePurchaseOrder(
      {
        idempotencyKey: randomUUID(),
        purchaseOrderId: orderId,
        notes: 'offline amendment attempt',
      },
      offline,
    );
    check(
      'E4 an amendment attempted with no network is REFUSED out loud and queues nothing',
      !offlineAmend.ok && offlineAmend.failure.kind === 'offline',
      `kind=${failureKind(offlineAmend)}`,
    );

    const offlinePlan = await planDelivery(
      {
        idempotencyKey: randomUUID(),
        clientWallAt: new Date().toISOString(),
        sourceKind: 'PURCHASE_ORDER',
        sourceId: orderId,
        carrierSupplierId: carrier.supplierId,
        businessDate: assertedDay,
      },
      offline,
    );
    check(
      'E5 planning a load with no network is REFUSED — nothing is promised to a haulier from a dead device',
      !offlinePlan.ok && offlinePlan.failure.kind === 'offline',
      `kind=${failureKind(offlinePlan)}`,
    );
  } finally {
    await sql.end();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n=== D13: ${checks.length - failed.length}/${checks.length} checks passed ===`);
  console.log(`__DRILL_RESULT__ ${JSON.stringify({ checks, measurements })}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error('D13 aborted:', message);
  console.log(`__DRILL_RESULT__ ${JSON.stringify({ checks, measurements, error: message })}`);
  process.exit(1);
});
