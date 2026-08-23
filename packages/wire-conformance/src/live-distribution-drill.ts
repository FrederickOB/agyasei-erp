/**
 * ═══════════════════════════════════════════════════════════════════════════
 * D12 — THE Q1 DRILL: distribution cost as a % of revenue, live, end to end
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/open-questions.md` Q1 is the question the founder gave up the owned
 * fleet for (ADR-0001): the ERP promised, in exchange, to MEASURE distribution
 * cost as a percentage of revenue per outlet and per region. D11 proved the
 * numerator lands on the right row and then asserted, honestly, that the ratio
 * itself still answered `null` / `NO_DISTRIBUTION_COST_SOURCE`.
 *
 * This drill exists to prove the opposite, or to fail. It runs against the
 * DEPLOYED API over a real socket and real Postgres, drives `apps/web`'s own
 * production modules, and compares every figure to a SECOND, INDEPENDENT
 * computation written here in SQL — never to a fixture and never to the
 * server's own arithmetic restated.
 *
 * What it demonstrates, in order:
 *
 *   A. A haulier supplier is CREATED THROUGH THE CLIENT by a `supplier.manage`
 *      holder and the row is read back from Postgres; a `supplier.view`-only
 *      caller is REFUSED the identical call over HTTP and leaves no row.
 *   B. A delivery with a KNOWN freight cost is planned and dispatched through
 *      the client, and `reports.distributionCostRatio` then answers a REAL
 *      ratio — not null, not NO_DISTRIBUTION_COST_SOURCE.
 *   C. It RECONCILES: Σ(per-location freight) = the network figure; freight,
 *      revenue and the percentage each equal an independent Postgres
 *      computation over the same period and the same scope.
 *   D. The region rollup sums over the LOCATION CLOSURE, not over a hand-kept
 *      list — proven per group against `app.location_closure`.
 *   E. A delivery whose DEVICE CLOCK disagrees with its business_date lands in
 *      the business_date's period and not the device clock's (03 §3.4.2,
 *      migration 0010).
 *   F. A second source on a product, added through the client in a DIFFERENT
 *      purchase unit, still compares against the first.
 *   G. Two outbox ops written in the SAME MILLISECOND drain in enqueue order,
 *      deterministically, over repeated runs (§0 row 12).
 *
 * Run: `pnpm --filter @erp/wire-conformance drill:q1`
 * Requires: `pnpm stack:up` and `pnpm dev:api` ON CURRENT CODE.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// ---- the client, from apps/web's own sources -------------------------------
import type { ApiCallOptions, ApiFetch, ApiResult } from '../../../apps/web/src/data/api/client';
import {
  fetchSourcesForProduct,
  fetchSuppliers,
  upsertSupplier,
  upsertSupplierProduct,
} from '../../../apps/web/src/data/api/procurement';
import { fetchDeliveries, planDelivery } from '../../../apps/web/src/data/api/logistics';
import { fetchDistributionCost } from '../../../apps/web/src/data/api/reports';
import { recordDeliveryStatus } from '../../../apps/web/src/data/mutations/updateDeliveryStatus';
import { httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { drainOutbox, readPendingOps } from '../../../apps/web/src/data/sync/upload';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import type { LocalDb } from '../../../apps/web/src/data/db';
import { uuidv7 } from '../../../apps/web/src/lib/uuidv7';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import { fixedHlc, provisionDevice } from '../../../apps/web/tests/helpers/fixtures';

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

const browserApiFetch: ApiFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: { ...init.headers, origin: PWA_ORIGIN },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
};

function optionsFor(bearer: string): ApiCallOptions {
  return { endpoint: { url: API_URL, bearer }, fetchFn: browserApiFetch };
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
  return result.ok ? 'ok' : JSON.stringify(result.failure).slice(0, 200);
}

/**
 * The percentage, computed HERE, in bigint, half-up — a second implementation
 * of `divRound` so the drill is not checking the server against itself.
 */
function pctE4(costMinor: bigint, netRevenueMinor: bigint): bigint | null {
  if (netRevenueMinor <= 0n) return null;
  const numerator = costMinor * 1_000_000n;
  const q = numerator / netRevenueMinor;
  const r = numerator % netRevenueMinor;
  return r * 2n >= netRevenueMinor ? q + 1n : q;
}

function isoDayShift(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log('=== D12 — Q1: distribution cost as a % of revenue, live ===');

  const headToken = devToken('head_of_operations');
  const accountsToken = devToken('accounts');
  const managerToken = devToken('outlet_manager');
  const { tid: tenantId } = claimsOf(headToken);

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
    const applied = new Set(
      (
        await sql.query<{ filename: string }>(
          `select filename from erp_meta.schema_migrations order by filename`,
        )
      ).rows.map((m) => m.filename),
    );
    check(
      '0a migration 0010 (delivery.business_date) is APPLIED to the database the API is talking to',
      applied.has('0010_delivery_business_date.sql'),
      `applied=${String(applied.size)} migrations, latest=${[...applied].sort().at(-1) ?? '?'}`,
    );

    const [notNull] = await sql.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
        where table_schema='app' and table_name='delivery' and column_name='business_date'`,
    ).then((r) => r.rows);
    check(
      '0b app.delivery.business_date is NOT NULL — a period key with no exceptions',
      notNull?.is_nullable === 'NO',
      `is_nullable=${notNull?.is_nullable ?? 'absent'}`,
    );

    // =====================================================================
    // A — SUPPLIERS ARE WRITABLE FROM THE PRODUCT, AND ONLY BY THE RIGHT HANDS
    // =====================================================================
    console.log('\n-- A. a supplier, created through the client ----------------');

    // The capability TYPES are the tenant's own rows; the PLATFORM half is the
    // `kind`. The client names a type id, never a code (CLAUDE.md §2.9).
    const [haulageType] = await scoped<{ id: string; code: string; kind: string }>(
      `select id::text, code, kind from app.supplier_capability_type
        where tenant_id = $1 and kind = 'HAULAGE' and deleted_at is null
        order by code limit 1`,
      [tenantId],
    );
    if (haulageType === undefined) throw new Error('the tenant has no HAULAGE capability type');

    const carrierCode = `D12-HAUL-${randomBytes(3).toString('hex').toUpperCase()}`;
    const created = await upsertSupplier(
      {
        idempotencyKey: randomUUID(),
        code: carrierCode,
        name: `D12 drill haulier ${carrierCode}`,
        paymentTermsDays: 30,
        contactName: 'D12 drill',
        capabilityTypeIds: [haulageType.id],
      },
      optionsFor(accountsToken),
    );
    check(
      "A1 a `supplier.manage` holder CREATES a haulier through the CLIENT's own module",
      created.ok && created.data.code === carrierCode,
      created.ok ? `supplierId=${created.data.supplierId} code=${created.data.code}` : failureDetail(created),
    );
    if (!created.ok) throw new Error('A1 failed — nothing after it can be trusted');
    const carrierSupplierId = created.data.supplierId;

    const [pgSupplier] = await scoped<{
      code: string;
      name: string;
      payment_terms_days: number;
      is_active: boolean;
      caps: string | null;
    }>(
      `select s.code, s.name, s.payment_terms_days, s.is_active,
              (select string_agg(t.kind, ',')
                 from app.supplier_capability c
                 join app.supplier_capability_type t
                   on t.tenant_id = c.tenant_id and t.id = c.capability_type_id
                where c.tenant_id = s.tenant_id and c.supplier_id = s.id) as caps
         from app.supplier s where s.tenant_id = $1 and s.id = $2`,
      [tenantId, carrierSupplierId],
    );
    check(
      'A2 POSTGRES agrees — the row exists, with the terms, and carries the HAULAGE capability',
      pgSupplier?.code === carrierCode &&
        pgSupplier.payment_terms_days === 30 &&
        pgSupplier.is_active === true &&
        (pgSupplier.caps ?? '').includes('HAULAGE'),
      `code=${pgSupplier?.code ?? 'absent'} terms=${String(pgSupplier?.payment_terms_days)} ` +
        `active=${String(pgSupplier?.is_active)} caps=${pgSupplier?.caps ?? 'none'}`,
    );

    // The refusal, on the byte-identical shape, from a principal that holds
    // `supplier.view` and NOT `supplier.manage`.
    const refusedCode = `D12-REFUSED-${randomBytes(3).toString('hex').toUpperCase()}`;
    const refused = await upsertSupplier(
      {
        idempotencyKey: randomUUID(),
        code: refusedCode,
        name: `D12 must not exist ${refusedCode}`,
        paymentTermsDays: 30,
        capabilityTypeIds: [haulageType.id],
      },
      optionsFor(managerToken),
    );
    const refusedRows = await scoped<{ n: string }>(
      `select count(*)::text as n from app.supplier where tenant_id = $1 and code = $2`,
      [tenantId, refusedCode],
    );
    check(
      'A3 a `supplier.view`-ONLY caller is REFUSED over HTTP, and the refusal leaves NO ROW',
      !refused.ok && refusedRows[0]?.n === '0',
      `${failureKind(refused)} rowsWritten=${refusedRows[0]?.n ?? '?'} ${failureDetail(refused).slice(0, 120)}`,
    );

    // The same principal CAN still read — proving A3 was the permission and
    // not a broken token.
    const canRead = await fetchSuppliers({ kind: 'HAULAGE' }, optionsFor(managerToken));
    check(
      'A4 positive control: the SAME refused principal can still LIST suppliers, and sees the new haulier',
      canRead.ok && canRead.data.suppliers.some((s) => s.supplierId === carrierSupplierId),
      canRead.ok
        ? `hauliers=${String(canRead.data.suppliers.length)} includesNew=${String(
            canRead.data.suppliers.some((s) => s.supplierId === carrierSupplierId),
          )}`
        : failureDetail(canRead),
    );
    measure(`carrier ${carrierCode} (${carrierSupplierId}) created through data/api/procurement.ts`);

    // =====================================================================
    // B — A DISPATCH WITH A KNOWN FREIGHT COST
    // =====================================================================
    console.log('\n-- B. dispatch, through the client, with a known freight ----');

    // The period is chosen from the tenant's OWN data: the trading day that
    // actually has revenue. A ratio over a day with no denominator would be
    // `NO_REVENUE_IN_PERIOD` and would prove nothing about Q1.
    const [busiest] = await scoped<{ business_date: string }>(
      `select business_date::text from app.sale
        where tenant_id = $1 and deleted_at is null
        group by business_date order by count(*) desc, business_date desc limit 1`,
      [tenantId],
    );
    if (busiest === undefined) throw new Error('the tenant has no sales at all — no denominator');
    const day = busiest.business_date;
    const skewDay = isoDayShift(day, 3);

    /** Two purchase orders whose destinations are in DIFFERENT grouping nodes. */
    const orders = await scoped<{
      id: string;
      loc_id: string;
      loc_code: string;
      group_code: string | null;
    }>(
      `select distinct on (g.id) po.id::text, l.id::text as loc_id, l.code as loc_code,
              g.code as group_code
         from app.purchase_order po
         join app.location l on l.tenant_id = po.tenant_id and l.id = po.deliver_to_location_id
         left join app.location g on g.tenant_id = l.tenant_id and g.id = l.parent_id
        where po.tenant_id = $1 and po.deleted_at is null and l.kind = 'OUTLET'
        order by g.id, po.created_at desc`,
      [tenantId],
    );
    const orderA = orders[0];
    const orderB = orders[1];
    if (orderA === undefined) throw new Error('no purchase order to hang a delivery on');
    measure(
      `period ${day} · order A at ${orderA.loc_code} (${orderA.group_code ?? 'no group'})` +
        (orderB === undefined ? '' : ` · order B at ${orderB.loc_code} (${orderB.group_code ?? 'no group'})`),
    );

    /** The ratio BEFORE anything of ours is dispatched. */
    const before = await fetchDistributionCost({ from: day, to: day }, optionsFor(accountsToken));
    if (!before.ok) throw new Error(`baseline read failed: ${failureDetail(before)}`);
    const baselineCost = before.data.total.distributionCostMinor ?? 0n;

    /** Freight magnitudes chosen so the three are distinguishable in a sum. */
    const FREIGHT_A = 137_500n;
    const FREIGHT_B = 42_100n;
    const FREIGHT_SKEW = 9_900n;

    const planned: { id: string; freight: bigint; where: string }[] = [];
    const planOne = async (
      order: { id: string; loc_code: string },
      freight: bigint,
      businessDate: string,
    ): Promise<string> => {
      const res = await planDelivery(
        {
          idempotencyKey: randomUUID(),
          sourceKind: 'PURCHASE_ORDER',
          sourceId: order.id,
          carrierSupplierId,
          businessDate,
          freightCostMinor: freight.toString(10),
          notes: 'D12 drill',
        },
        optionsFor(headToken),
      );
      if (!res.ok) throw new Error(`planDelivery failed at ${order.loc_code}: ${failureDetail(res)}`);
      planned.push({ id: res.data.deliveryId, freight, where: order.loc_code });
      return res.data.deliveryId;
    };

    const deliveryA = await planOne(orderA, FREIGHT_A, day);
    const deliveryB = orderB === undefined ? null : await planOne(orderB, FREIGHT_B, day);
    const deliverySkew = await planOne(orderA, FREIGHT_SKEW, day);

    check(
      'B1 the client plans deliveries with a stated freight and a stated BUSINESS DATE',
      planned.length === (orderB === undefined ? 2 : 3),
      planned.map((p) => `${p.where}:${p.freight.toString(10)}`).join(' + '),
    );

    // Dispatch A and the skewed one through the DEVICE's own outbox — the same
    // ordered queue a sale rides — so "dispatch" here is a real dispatch.
    const deviceDb: LocalDb = openTestDb();
    await provisionDevice(deviceDb, { locationCode: orderA.loc_code });
    const hlc = fixedHlc(Date.now(), randomBytes(16).toString('hex'));
    const transport = httpUploadTransport({
      apiUrl: API_URL,
      apiToken: headToken,
      fetchFn: browserUploadFetch,
    });

    await recordDeliveryStatus(deviceDb, {
      updateId: uuidv7(),
      deliveryId: deliveryA,
      fromStatus: 'PLANNED',
      toStatus: 'DISPATCHED',
      hlc,
      nowIso: new Date().toISOString(),
    });
    /**
     * The clock-skew case, and it is the point of migration 0010. `nowIso` IS
     * the device clock — `recordDeliveryStatus` stamps it as `occurredAt` and
     * the server writes it to `dispatched_at`. Here the tablet is three days
     * fast, which is the exact failure 03 §3.4.2 forbids trusting: it must not
     * move GH-denominated freight across a period boundary.
     */
    await recordDeliveryStatus(deviceDb, {
      updateId: uuidv7(),
      deliveryId: deliverySkew,
      fromStatus: 'PLANNED',
      toStatus: 'DISPATCHED',
      hlc,
      nowIso: `${skewDay}T08:15:00.000Z`,
    });

    let drainPasses = 0;
    while (drainPasses < 3 && (await readPendingOps(deviceDb)).length > 0) {
      await drainOutbox(deviceDb, transport);
      drainPasses += 1;
    }
    const dispatchRows = await scoped<{
      id: string;
      status: string;
      business_date: string;
      derived: string | null;
      dispatched_day: string | null;
      freight: string | null;
    }>(
      `select id::text, status, business_date::text, business_date_derived_from as derived,
              (dispatched_at at time zone 'UTC')::date::text as dispatched_day,
              freight_cost_minor::text as freight
         from app.delivery where tenant_id = $1 and id = any($2::uuid[])`,
      [tenantId, planned.map((p) => p.id)],
    );
    const rowOf = (id: string) => dispatchRows.find((r) => r.id === id);
    check(
      'B2 both status moves reached Postgres through the outbox — DISPATCHED, freight intact',
      rowOf(deliveryA)?.status === 'DISPATCHED' &&
        rowOf(deliveryA)?.freight === FREIGHT_A.toString(10) &&
        rowOf(deliverySkew)?.status === 'DISPATCHED',
      `A=${rowOf(deliveryA)?.status ?? '?'}/${rowOf(deliveryA)?.freight ?? '?'} ` +
        `skew=${rowOf(deliverySkew)?.status ?? '?'} passes=${String(drainPasses)}`,
    );
    check(
      'B3 THE DEVICE CLOCK DISAGREES WITH THE BUSINESS DATE, AND THE ROW KEEPS BOTH',
      rowOf(deliverySkew)?.business_date === day &&
        rowOf(deliverySkew)?.dispatched_day === skewDay &&
        rowOf(deliverySkew)?.derived === null,
      `business_date=${rowOf(deliverySkew)?.business_date ?? '?'} ` +
        `dispatched_at::date=${rowOf(deliverySkew)?.dispatched_day ?? '?'} ` +
        `derived_from=${rowOf(deliverySkew)?.derived ?? 'ASSERTED'}`,
    );

    // =====================================================================
    // C — THE RATIO IS REAL, AND IT RECONCILES
    // =====================================================================
    console.log('\n-- C. the Q1 ratio, and an independent second opinion -------');
    const after = await fetchDistributionCost({ from: day, to: day }, optionsFor(accountsToken));
    if (!after.ok) throw new Error(`distributionCostRatio failed: ${failureDetail(after)}`);
    const report = after.data;

    check(
      'C1 THE Q1 RATIO IS A REAL FIGURE — not null, not NO_DISTRIBUTION_COST_SOURCE',
      report.total.distributionCostMinor !== null &&
        report.total.distributionCostPctE4 !== null &&
        report.total.unavailable !== 'NO_DISTRIBUTION_COST_SOURCE',
      `cost=${String(report.total.distributionCostMinor)} ` +
        `revenue=${String(report.total.netRevenueMinor)} ` +
        `pctE4=${String(report.total.distributionCostPctE4)} ` +
        `unavailable=${String(report.total.unavailable)}`,
    );

    const expectedDelta = FREIGHT_A + FREIGHT_SKEW + (deliveryB === null ? 0n : FREIGHT_B);
    check(
      "C2 the dispatch MOVED the figure — the ratio's numerator rose by exactly what was agreed",
      (report.total.distributionCostMinor ?? 0n) - baselineCost === expectedDelta,
      `before=${baselineCost.toString(10)} after=${String(report.total.distributionCostMinor)} ` +
        `delta=${((report.total.distributionCostMinor ?? 0n) - baselineCost).toString(10)} ` +
        `expected=${expectedDelta.toString(10)}`,
    );

    const perLocationCost = report.locations.reduce(
      (a, l) => a + (l.distributionCostMinor ?? 0n),
      0n,
    );
    const perLocationRevenue = report.locations.reduce((a, l) => a + l.netRevenueMinor, 0n);
    check(
      'C3 RECONCILES: Σ(per-location freight) EQUALS the network figure — and so does revenue',
      perLocationCost === report.total.distributionCostMinor &&
        perLocationRevenue === report.total.netRevenueMinor,
      `Σlocations=${perLocationCost.toString(10)} network=${String(report.total.distributionCostMinor)} ` +
        `Σrevenue=${perLocationRevenue.toString(10)} networkRevenue=${String(report.total.netRevenueMinor)}`,
    );

    /**
     * The SECOND OPINION. This SQL is written here, from the attribution rules
     * as stated in ADR-0001 and the router's header — not imported from the
     * router. If the two agree, they agree for a reason.
     */
    const scopeIds = report.locations.map((l) => l.locationId);
    const [independent] = await scoped<{
      freight: string;
      deliveries: string;
      no_freight: string;
    }>(
      `select coalesce(sum(d.freight_cost_minor), 0)::text as freight,
              count(*)::text as deliveries,
              count(*) filter (where d.freight_cost_minor is null)::text as no_freight
         from app.delivery d
         left join app.purchase_order po
           on d.source_kind = 'PURCHASE_ORDER' and po.tenant_id = d.tenant_id and po.id = d.source_id
         left join app.sale sa
           on d.source_kind = 'SALE' and sa.tenant_id = d.tenant_id and sa.id = d.source_id
        where d.tenant_id = $1
          and d.deleted_at is null
          and d.status <> 'CANCELLED'
          and d.business_date = $2::date
          and coalesce(po.deliver_to_location_id, sa.location_id,
                       d.from_location_id, d.to_location_id) = any($3::uuid[])`,
      [tenantId, day, scopeIds],
    );
    const [independentRevenue] = await scoped<{ net: string }>(
      `select coalesce(sum(s.subtotal_net_minor - s.discount_minor), 0)::text as net
         from app.sale s
        where s.tenant_id = $1 and s.deleted_at is null
          and s.business_date = $2::date and s.location_id = any($3::uuid[])`,
      [tenantId, day, scopeIds],
    );
    const pgFreight = BigInt(independent?.freight ?? '0');
    const pgRevenue = BigInt(independentRevenue?.net ?? '0');
    check(
      'C4 the NUMERATOR equals an independent Postgres sum over the same period and scope',
      pgFreight === report.total.distributionCostMinor,
      `postgres=${pgFreight.toString(10)} api=${String(report.total.distributionCostMinor)} ` +
        `deliveries=${independent?.deliveries ?? '?'} withoutFreight=${independent?.no_freight ?? '?'}`,
    );
    check(
      'C5 the DENOMINATOR equals an independent Postgres sum of (subtotal_net − discount)',
      pgRevenue === report.total.netRevenueMinor,
      `postgres=${pgRevenue.toString(10)} api=${String(report.total.netRevenueMinor)}`,
    );
    const ownPct = pctE4(pgFreight, pgRevenue);
    check(
      'C6 THE PERCENTAGE equals freight ÷ revenue computed here, in bigint, half-up',
      ownPct !== null && ownPct === report.total.distributionCostPctE4,
      `computedHere=${String(ownPct)} api=${String(report.total.distributionCostPctE4)} ` +
        `(= ${ownPct === null ? '?' : (Number(ownPct) / 10_000).toFixed(4)}% of revenue)`,
    );
    check(
      'C7 the delivery COUNTS agree too — a sum that matched on a different row set would be luck',
      String(report.total.deliveryCount) === (independent?.deliveries ?? '?') &&
        String(report.total.deliveriesWithNoAgreedFreight) === (independent?.no_freight ?? '?'),
      `apiCount=${String(report.total.deliveryCount)} pgCount=${independent?.deliveries ?? '?'} ` +
        `apiNoFreight=${String(report.total.deliveriesWithNoAgreedFreight)} pgNoFreight=${independent?.no_freight ?? '?'}`,
    );
    /**
     * C8 is the one that would fail if the period key were the device clock.
     * The skewed delivery's `dispatched_at` is on `skewDay`; its business date
     * is `day`. Its freight must be inside the `day` period and ABSENT from
     * the `skewDay` one.
     */
    const skewPeriod = await fetchDistributionCost(
      { from: skewDay, to: skewDay },
      optionsFor(accountsToken),
    );
    if (!skewPeriod.ok) throw new Error(`skew-period read failed: ${failureDetail(skewPeriod)}`);
    const [skewPg] = await scoped<{ freight: string }>(
      `select coalesce(sum(freight_cost_minor), 0)::text as freight
         from app.delivery
        where tenant_id = $1 and business_date = $2::date and deleted_at is null
          and status <> 'CANCELLED' and id = $3`,
      [tenantId, day, deliverySkew],
    );
    check(
      "C8 THE SKEWED DELIVERY LANDS IN ITS BUSINESS DATE'S PERIOD, NOT ITS DEVICE CLOCK'S",
      BigInt(skewPg?.freight ?? '0') === FREIGHT_SKEW &&
        (skewPeriod.data.total.distributionCostMinor ?? 0n) === 0n &&
        skewPeriod.data.total.deliveryCount === 0,
      `freight ${FREIGHT_SKEW.toString(10)} is inside ${day} (postgres=${skewPg?.freight ?? '?'}) ` +
        `and the ${skewDay} period — the day its dispatched_at names — reports cost=` +
        `${String(skewPeriod.data.total.distributionCostMinor)} over ` +
        `${String(skewPeriod.data.total.deliveryCount)} deliveries`,
    );

    measure(
      `Q1 ANSWERED: ${day} network distribution cost ${pgFreight.toString(10)} minor / ` +
        `revenue ${pgRevenue.toString(10)} minor = ` +
        `${ownPct === null ? '?' : (Number(ownPct) / 10_000).toFixed(4)}% ` +
        `(pctE4 ${String(report.total.distributionCostPctE4)}), over ${String(scopeIds.length)} locations`,
    );

    // =====================================================================
    // D — PER REGION, AND THE ROLLUP SUMS OVER THE CLOSURE
    // =====================================================================
    console.log('\n-- D. the region rollup, against app.location_closure -------');
    check(
      'D1 the report answers PER GROUPING NODE at all — Q1 asks for "per region"',
      report.groups.length > 0,
      `groups=[${report.groups.map((g) => g.groupCode).join(', ')}]`,
    );

    /**
     * The closure, read independently. `resolveGroupRollup` builds each group's
     * membership from `app.location_closure`; this asks Postgres the same
     * question in its own words and then sums the two figures over the answer.
     * A group that summed over `parent_id` instead would agree for the one-deep
     * case and diverge the moment a region nests.
     */
    const closure = await scoped<{ ancestor_id: string; descendant_id: string }>(
      `select c.ancestor_id::text, c.descendant_id::text
         from app.location_closure c
         join app.location l on l.tenant_id = c.tenant_id and l.id = c.ancestor_id
        where c.tenant_id = $1 and c.descendant_id = any($2::uuid[])
          and l.kind = 'GROUP' and l.deleted_at is null`,
      [tenantId, scopeIds],
    );
    const costByLocation = new Map(
      report.locations.map((l) => [l.locationId, l.distributionCostMinor ?? 0n]),
    );
    const revenueByLocation = new Map(report.locations.map((l) => [l.locationId, l.netRevenueMinor]));

    const groupProblems: string[] = [];
    for (const g of report.groups) {
      const members = closure.filter((c) => c.ancestor_id === g.groupId).map((c) => c.descendant_id);
      const cost = members.reduce((a, id) => a + (costByLocation.get(id) ?? 0n), 0n);
      const revenue = members.reduce((a, id) => a + (revenueByLocation.get(id) ?? 0n), 0n);
      const expectedPct = pctE4(cost, revenue);
      if (members.length !== g.locationCount)
        groupProblems.push(`${g.groupCode}: members ${String(members.length)} vs ${String(g.locationCount)}`);
      if (cost !== (g.distributionCostMinor ?? 0n))
        groupProblems.push(`${g.groupCode}: cost ${cost.toString(10)} vs ${String(g.distributionCostMinor)}`);
      if (revenue !== g.netRevenueMinor)
        groupProblems.push(`${g.groupCode}: revenue ${revenue.toString(10)} vs ${String(g.netRevenueMinor)}`);
      if (expectedPct !== g.distributionCostPctE4)
        groupProblems.push(`${g.groupCode}: pctE4 ${String(expectedPct)} vs ${String(g.distributionCostPctE4)}`);
    }
    check(
      'D2 EVERY GROUP SUMS OVER ITS CLOSURE — membership, freight, revenue and the percentage',
      groupProblems.length === 0,
      groupProblems.length === 0
        ? report.groups
            .map(
              (g) =>
                `${g.groupCode}(n=${String(g.locationCount)}, ` +
                `${g.distributionCostPctE4 === null ? 'no revenue' : `${(Number(g.distributionCostPctE4) / 10_000).toFixed(3)}%`})`,
            )
            .join(' · ')
        : groupProblems.join(' | '),
    );

    /**
     * The nesting claim the response publishes has to be true or the reader
     * will add the subtotals up. A root group that contains every scoped
     * location proves the hierarchy is more than one level deep.
     */
    const rootGroups = report.groups.filter(
      (g) => closure.filter((c) => c.ancestor_id === g.groupId).length === scopeIds.length,
    );
    check(
      'D3 groups NEST, and the response says so — a root node holds every scoped location',
      report.groupsNest && rootGroups.length >= 1,
      `groupsNest=${String(report.groupsNest)} ` +
        `rootGroups=[${rootGroups.map((g) => g.groupCode).join(', ')}] ` +
        `Σgroups=${report.groups
          .reduce((a, g) => a + (g.distributionCostMinor ?? 0n), 0n)
          .toString(10)} (deliberately NOT the network total ${String(report.total.distributionCostMinor)})`,
    );

    /** The freight we dispatched, per region, found where it should be. */
    const groupOf = (code: string | null) => report.groups.find((g) => g.groupCode === code);
    const gA = groupOf(orderA.group_code);
    check(
      'D4 the freight dispatched to a named outlet is visible in THAT outlet AND in ITS region',
      (costByLocation.get(orderA.loc_id) ?? 0n) >= FREIGHT_A + FREIGHT_SKEW &&
        gA !== undefined &&
        (gA.distributionCostMinor ?? 0n) >= FREIGHT_A + FREIGHT_SKEW,
      `${orderA.loc_code}=${(costByLocation.get(orderA.loc_id) ?? 0n).toString(10)} ` +
        `${orderA.group_code ?? '?'}=${String(gA?.distributionCostMinor)} ` +
        `(dispatched here: ${(FREIGHT_A + FREIGHT_SKEW).toString(10)})`,
    );

    // =====================================================================
    // E — A SECOND SOURCE, IN A DIFFERENT PURCHASE UNIT
    // =====================================================================
    console.log('\n-- E. multi-source across different purchase units ----------');
    const [target] = await scoped<{
      product_id: string;
      sku: string;
      uom_a: string;
      uom_a_code: string;
      uom_b: string;
      uom_b_code: string;
    }>(
      // A product that ALREADY has a source, plus a buyable unit that source
      // does NOT use — so the second source really is in a different unit and
      // the comparison has to convert to compare.
      `select p.id::text as product_id, p.sku_code as sku,
              sp.purchase_uom_id::text as uom_a, ua.code as uom_a_code,
              b.uom_id::text as uom_b, ub.code as uom_b_code
         from app.product p
         join app.supplier_product sp on sp.tenant_id = p.tenant_id and sp.product_id = p.id
                                     and sp.deleted_at is null and sp.is_active
         join app.unit_of_measure ua on ua.tenant_id = sp.tenant_id and ua.id = sp.purchase_uom_id
         join app.product_uom b on b.tenant_id = p.tenant_id and b.product_id = p.id
                                and b.can_buy and b.uom_id <> sp.purchase_uom_id
         join app.unit_of_measure ub on ub.tenant_id = b.tenant_id and ub.id = b.uom_id
        where p.tenant_id = $1 and p.deleted_at is null and p.is_purchasable
        order by p.sku_code limit 1`,
      [tenantId],
    );
    if (target === undefined) throw new Error('no product with two buyable units — E cannot run');

    const [goodsType] = await scoped<{ id: string }>(
      `select id::text from app.supplier_capability_type
        where tenant_id = $1 and kind = 'GOODS' and deleted_at is null order by code limit 1`,
      [tenantId],
    );
    const secondSupplier = await upsertSupplier(
      {
        idempotencyKey: randomUUID(),
        code: `D12-SRC-${randomBytes(3).toString('hex').toUpperCase()}`,
        name: 'D12 drill second source',
        paymentTermsDays: 14,
        ...(goodsType === undefined ? {} : { capabilityTypeIds: [goodsType.id] }),
      },
      optionsFor(accountsToken),
    );
    if (!secondSupplier.ok) throw new Error(`E setup failed: ${failureDetail(secondSupplier)}`);

    const sourceAdded = await upsertSupplierProduct(
      {
        idempotencyKey: randomUUID(),
        supplierId: secondSupplier.data.supplierId,
        productId: target.product_id,
        purchaseUomId: target.uom_b,
        supplierSku: 'D12-ALT',
        leadTimeDays: 7,
        lastPriceE4: '990000000',
        lastPriceOn: day,
      },
      optionsFor(accountsToken),
    );
    check(
      'E1 a SECOND SOURCE is added through the client, in a DIFFERENT purchase unit',
      sourceAdded.ok,
      sourceAdded.ok
        ? `${target.sku}: new source in ${target.uom_b_code} (existing units include ${target.uom_a_code})`
        : failureDetail(sourceAdded),
    );

    const refusedSource = await upsertSupplierProduct(
      {
        idempotencyKey: randomUUID(),
        supplierId: secondSupplier.data.supplierId,
        productId: target.product_id,
        purchaseUomId: target.uom_a,
        supplierSku: 'D12-MUST-NOT-EXIST',
      },
      optionsFor(managerToken),
    );
    check(
      'E2 the `supplier.view`-only caller is refused the source write too',
      !refusedSource.ok,
      `${failureKind(refusedSource)} ${failureDetail(refusedSource).slice(0, 120)}`,
    );

    const sources = await fetchSourcesForProduct(target.product_id, optionsFor(managerToken));
    const units = sources.ok
      ? new Set(sources.data.sources.map((s) => s.purchaseUomCode))
      : new Set<string>();
    const comparable = sources.ok
      ? sources.data.sources.filter((s) => s.pricePerStockUnitE4 !== null).length
      : 0;
    check(
      'E3 the MULTI-SOURCE COMPARISON still resolves across different purchase units',
      sources.ok &&
        sources.data.sources.length >= 2 &&
        units.size >= 2 &&
        comparable >= 2,
      sources.ok
        ? `sources=${String(sources.data.sources.length)} distinctUnits=${String(units.size)} ` +
          `comparable=${String(comparable)} units=[${[...units].join(', ')}]`
        : failureDetail(sources),
    );
    if (sources.ok) {
      const ranked = sources.data.sources
        .filter((s) => s.pricePerStockUnitE4 !== null)
        .map((s) => s.pricePerStockUnitE4 as bigint);
      const sortedAscending = ranked.every((v, i) => i === 0 || ranked[i - 1]! <= v);
      check(
        'E4 the server ORDERS the comparison — the list is authoritative, not the display rounding',
        sortedAscending,
        `pricePerStockUnitE4 in list order: [${ranked.map((v) => v.toString(10)).join(', ')}]`,
      );
    }

    // =====================================================================
    // F — TWO OPS IN THE SAME MILLISECOND, DRAINED IN ENQUEUE ORDER, EVERY RUN
    // =====================================================================
    console.log('\n-- F. the outbox tie, repeated ------------------------------');
    /**
     * §0 row 12: two writes in the same millisecond used to upload in a random
     * relative order, because the tie-break was a `uuidv7` whose intra-ms tail
     * is CSPRNG output. The fix is `outbox.queue_seq`, an enqueue-time integer.
     *
     * The pair below is the one that FOUND the bug: PLANNED→DISPATCHED then
     * DISPATCHED→DELIVERED. Out of order, the second is refused as an illegal
     * transition and the drain needs a second pass. So "one pass, two applied,
     * zero rejected" is a direct observation of the order, not a proxy for it.
     *
     * Repeated, because a coin flip passes half the time.
     */
    const RUNS = 6;
    const outcomes: string[] = [];
    let allDeterministic = true;
    let tiesObserved = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const target2 = await planOne(orderA, 1_000n + BigInt(run), day);
      const runDb: LocalDb = openTestDb();
      await provisionDevice(runDb, { locationCode: orderA.loc_code });
      const runHlc = fixedHlc(Date.now(), randomBytes(16).toString('hex'));
      /** ONE instant, shared, on purpose: the tie must happen every run. */
      const sameInstant = new Date().toISOString();
      for (const [from, to] of [
        ['PLANNED', 'DISPATCHED'],
        ['DISPATCHED', 'DELIVERED'],
      ] as const) {
        await recordDeliveryStatus(runDb, {
          updateId: uuidv7(),
          deliveryId: target2,
          fromStatus: from,
          toStatus: to,
          hlc: runHlc,
          nowIso: sameInstant,
        });
      }
      const queued = await runDb.getAll(
        'SELECT CAST(queue_seq AS TEXT) AS seq, created_at, id FROM outbox ORDER BY queue_seq ASC',
      );
      const instants = new Set(queued.map((r) => String(r['created_at'])));
      const seqs = queued.map((r) => Number(r['seq']));
      const tied = instants.size === 1 && queued.length === 2;
      if (tied) tiesObserved += 1;

      const report2 = await drainOutbox(
        runDb,
        httpUploadTransport({ apiUrl: API_URL, apiToken: headToken, fetchFn: browserUploadFetch }),
      );
      const [state] = await scoped<{ status: string }>(
        `select status from app.delivery where tenant_id = $1 and id = $2`,
        [tenantId, target2],
      );
      const clean =
        tied &&
        seqs.length === 2 &&
        seqs[0]! < seqs[1]! &&
        report2.completed === 2 &&
        report2.rejected === 0 &&
        (await readPendingOps(runDb)).length === 0 &&
        state?.status === 'DELIVERED';
      if (!clean) allDeterministic = false;
      outcomes.push(
        `run${String(run + 1)}:${clean ? 'ok' : 'BAD'}(seq ${seqs.join('<')},` +
          `applied ${String(report2.completed)}/2,rejected ${String(report2.rejected)},${state?.status ?? '?'})`,
      );
    }
    check(
      `F1 ${String(RUNS)} CONSECUTIVE RUNS: two ops written in the SAME MILLISECOND applied in ` +
        'ENQUEUE ORDER on the FIRST pass, every time',
      allDeterministic && tiesObserved === RUNS,
      `${outcomes.join(' ')} — ties actually observed: ${String(tiesObserved)}/${String(RUNS)}`,
    );
    measure(
      `outbox ordering is deterministic under a millisecond tie across ${String(RUNS)} runs; ` +
        'the key is outbox.queue_seq (enqueue position), not created_at plus a random uuid tail',
    );

    /** The delivery list read-back, so F is not the only witness to the writes. */
    const listed = await fetchDeliveries(
      { sourceKind: 'PURCHASE_ORDER', sourceId: orderA.id },
      optionsFor(headToken),
    );
    check(
      'F2 every delivery this drill planned is visible on the order it carries',
      listed.ok && listed.data.deliveries.some((d) => d.deliveryId === deliveryA),
      listed.ok ? `deliveries on ${orderA.loc_code}=${String(listed.data.deliveries.length)}` : failureDetail(listed),
    );

    // =====================================================================
    // G — TWO-TENANT ISOLATION ON THE PATHS THIS PASS ADDED (§2.7 cat. 3)
    // =====================================================================
    console.log('\n-- G. tenant B cannot reach any of it -----------------------');
    const bAccounts = devToken('accounts', 'B');
    const { tid: tenantB } = claimsOf(bAccounts);
    const scopedB = scopedTo(tenantB);

    /**
     * A supplier WRITE is the new surface, and an amend names an id. Tenant B
     * holds `supplier.manage` in its OWN tenant, so this is the dangerous
     * shape: the right capability, the wrong tenant, a REAL id.
     */
    const crossTenantAmend = await upsertSupplier(
      {
        idempotencyKey: randomUUID(),
        supplierId: carrierSupplierId,
        code: 'D12-STOLEN',
        name: 'D12 must never apply',
        paymentTermsDays: 1,
      },
      optionsFor(bAccounts),
    );
    const [stillMine] = await scoped<{ code: string; name: string; terms: number }>(
      `select code, name, payment_terms_days as terms from app.supplier
        where tenant_id = $1 and id = $2`,
      [tenantId, carrierSupplierId],
    );
    check(
      "G1 tenant B, HOLDING `supplier.manage`, cannot amend tenant A's supplier by its real id",
      !crossTenantAmend.ok &&
        stillMine?.code === carrierCode &&
        stillMine.terms === 30,
      `${failureKind(crossTenantAmend)} · tenant A's row unchanged: code=${stillMine?.code ?? '?'} ` +
        `terms=${String(stillMine?.terms)}`,
    );
    const bSuppliers = await scopedB<{ n: string }>(
      `select count(*)::text as n from app.supplier where code = $1`,
      [carrierCode],
    );
    check(
      "G2 …and no row with that code exists under tenant B either — nothing was copied across",
      bSuppliers[0]?.n === '0',
      `rows visible to tenant B with code ${carrierCode}: ${bSuppliers[0]?.n ?? '?'}`,
    );

    /** The Q1 report itself: tenant B's network figure contains none of ours. */
    const bReport = await fetchDistributionCost({ from: day, to: day }, optionsFor(bAccounts));
    const bIds = new Set(bReport.ok ? bReport.data.locations.map((l) => l.locationId) : []);
    const shared = scopeIds.filter((id) => bIds.has(id));
    check(
      'G3 THE Q1 REPORT ITSELF IS TENANT-SCOPED — zero shared location ids, and B cannot see our freight',
      bReport.ok &&
        shared.length === 0 &&
        (bReport.data.total.distributionCostMinor ?? 0n) !== report.total.distributionCostMinor,
      bReport.ok
        ? `B locations=${String(bReport.data.locations.length)} sharedIds=${String(shared.length)} ` +
          `Bcost=${String(bReport.data.total.distributionCostMinor)} vs Acost=${String(report.total.distributionCostMinor)}`
        : failureDetail(bReport),
    );

    /** Naming OUR location explicitly is the attack, not the accident. */
    const bNamesOurs = await fetchDistributionCost(
      { from: day, to: day, locationIds: [orderA.loc_id] },
      optionsFor(bAccounts),
    );
    check(
      "G4 tenant B naming tenant A's location id outright is REFUSED, not silently emptied",
      !bNamesOurs.ok,
      bNamesOurs.ok
        ? `LEAK: returned ${String(bNamesOurs.data.locations.length)} locations`
        : `${failureKind(bNamesOurs)} ${failureDetail(bNamesOurs).slice(0, 120)}`,
    );

    // =====================================================================
    // H — THE PERIOD KEY'S STANDING INVARIANT, AND THE GAP BESIDE IT
    // =====================================================================
    console.log('\n-- H. no period is dated by a device clock ------------------');
    /**
     * `DISPATCH_CLOCK` is migration 0010's BACKFILL label and nothing else may
     * ever write it. If a row created after 0010 ran carries it, some path has
     * started dating money by a tablet and the whole ratio is suspect.
     */
    const [applied0010] = await sql
      .query<{ at: string }>(
        `select applied_at::text as at from erp_meta.schema_migrations
          where filename = '0010_delivery_business_date.sql'`,
      )
      .then((r) => r.rows);
    const [clockDated] = await scoped<{ n: string }>(
      `select count(*)::text as n from app.delivery
        where tenant_id = $1 and business_date_derived_from = 'DISPATCH_CLOCK'
          and created_at > $2::timestamptz`,
      [tenantId, applied0010?.at ?? '1970-01-01'],
    );
    check(
      'H1 NO delivery written since 0010 is dated by a device clock — DISPATCH_CLOCK is backfill-only',
      clockDated?.n === '0',
      `rows created after ${applied0010?.at ?? '?'} with DISPATCH_CLOCK: ${clockDated?.n ?? '?'}`,
    );

    /**
     * The gap, MEASURED rather than asserted. `planDeliveryInput.businessDate`
     * is optional on the wire and the server records which of the three rules
     * dated the row. No screen in `apps/web` sends it — `Deliveries.tsx` sends
     * `plannedFor` only — so in the PRODUCT the trading day is always derived.
     * Both derived arms are trustworthy dates, which is why this is a gap and
     * not a defect; it is recorded here so the next reader sees it as a number.
     */
    const basis = await scoped<{ basis: string; n: string }>(
      `select coalesce(business_date_derived_from, 'ASSERTED') as basis, count(*)::text as n
         from app.delivery where tenant_id = $1 group by 1 order by 1`,
      [tenantId],
    );
    measure(
      'period basis across every delivery in the tenant: ' +
        basis.map((b) => `${b.basis}=${b.n}`).join(' · ') +
        ' — ASSERTED is now the PRODUCT path too: features/deliveries/Deliveries.tsx:416 ' +
        'sends businessDate on every planDelivery (ledger row 15, closed).',
    );
  } finally {
    await sql.end();
  }

  console.log('\n=== D12 summary ===========================================');
  for (const line of measurements) console.log(`  · ${line}`);
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n  ${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  if (failed.length > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
