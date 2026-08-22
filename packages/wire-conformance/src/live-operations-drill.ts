/**
 * D10 — THE CLIENT'S OWN API LAYER, OVER A REAL SOCKET.
 *
 *   pnpm stack:up
 *   pnpm --filter @erp/api dev:stack          # API on :3001
 *   pnpm --filter @erp/wire-conformance drill:client
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * D6 proves the PWA's SALE reaches Postgres. It says nothing about the four
 * server-backed reads the counter and head office gained in this pass —
 * reporting, low stock, reorder thresholds and credit — because until now
 * `apps/web` called none of them, and `packages/contracts/src/reports.ts` had
 * exactly ONE importer.
 *
 * A client now exists. `docs/phase1-status.md` §0 records NINE occasions on
 * which a written path had never been executed and a green suite failed to
 * notice, and TWO of those (CORS, the sale payload) were specifically the
 * CLIENT path being untested against the real server. So the rule this file
 * enforces is the one that ledger earned: every new client read path is
 * driven, by ITS OWN production module, against the deployed API, over real
 * HTTP, from a browser origin — and its figures are compared against the
 * SERVER's own rows read straight out of Postgres, not against a fixture.
 *
 * `apps/web` cannot do this itself: it has no `pg` dependency and must not
 * grow one. This package is the only one that may import both trees, which is
 * why the comparison lives here rather than in a smoke test beside the client.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ASSERTS
 * ---------------------------------------------------------------------------
 *   1  REPORTING — an outlet manager's own `fetchSalesByLocation` returns
 *      figures that match Postgres; counter staff is REFUSED on the same call
 *      with the same payload (the positive control that makes the refusal mean
 *      "not allowed" rather than "route broken"). The refused caller gets no
 *      zeroes: an ApiFailure, not an empty report.
 *   2  LOW STOCK — the client sets a threshold through `setReorderPoint` and
 *      then reads a NON-EMPTY alert list through `fetchLowStockPicture`. An
 *      empty list would pass vacuously, so a non-empty one is the assertion.
 *      Coverage must read `configured`, not `none`.
 *   3  OFFLINE ADJUSTMENT — a movement recorded through the real
 *      `recordAdjustment` with the radio OFF is absent from the server, then
 *      drains on reconnect, is acked `applied`, and is in `app.stock_movement`.
 *   4  CREDIT — the client's `fetchExposure` / `fetchAgeing` figures are
 *      compared to Σ(`app.credit_entry.amount_minor`) read from Postgres, as
 *      an exact bigint identity.
 *   5  HONESTY OFFLINE — with the radio genuinely off, every one of those
 *      reads returns `offline`, never an empty list and never a zero.
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
import { fetchSalesByLocation, fetchStockOnHand } from '../../../apps/web/src/data/api/reports';
import {
  fetchLowStockPicture,
  fetchReorderPoints,
  setReorderPoint,
} from '../../../apps/web/src/data/api/inventory';
import { fetchCreditPosition, fetchExposure } from '../../../apps/web/src/data/api/credit';
import { recordAdjustment } from '../../../apps/web/src/data/mutations/adjustStock';
import { httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { drainOutbox, readPendingOps } from '../../../apps/web/src/data/sync/upload';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import type { LocalDb } from '../../../apps/web/src/data/db';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import {
  fixedHlc,
  provisionDevice,
  seedMovementReason,
  seedProduct,
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
function devToken(roleRef: string): string {
  return execFileSync(
    'node',
    [path.join(REPO_ROOT, 'infra/scripts/dev-token.mjs'), '--role', roleRef],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ).trim();
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

/**
 * The client's `ApiFetch`, backed by real `fetch`, carrying the header a
 * browser sends. This is the seam CORS lives in — bug #1 of §0's ledger was
 * invisible to every in-process test precisely because a Node client has no
 * origin.
 */
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

/** The upload transport's own fetch shape, for the outbox half of check 3. */
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

/** Raw tRPC, for building FIXTURES only — never for the path under test. */
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
  if (!res.ok) {
    throw new Error(`${procedure} ${String(res.status)}: ${JSON.stringify(body)}`);
  }
  return (body['result'] as { data?: { json?: unknown } } | undefined)?.data?.json;
}

function failureKind(result: ApiResult<unknown>): string {
  return result.ok ? 'ok' : result.failure.kind;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log("=== D10 — the client's own API layer, over a real socket ===");

  const managerToken = devToken('outlet_manager');
  const counterToken = devToken('counter_staff');
  const accountsToken = devToken('accounts');
  const { tid: tenantId, locs } = claimsOf(managerToken);
  const locationId = locs[0];
  if (locationId === undefined) throw new Error('dev token carries no location scope');

  const sql = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
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
    const [loc] = await scoped<{ code: string }>(
      `select code from app.location where id = $1 and deleted_at is null`,
      [locationId],
    );
    if (loc === undefined) throw new Error('the token names a location that does not exist');
    measure(`tenant ${tenantId} · location ${loc.code}`);

    // =====================================================================
    // 1 — REPORTING, through the client's own reports module
    // =====================================================================
    console.log('\n-- 1. reporting --------------------------------------------');
    const range = { from: '2000-01-01', to: '2099-12-31' };

    const managerSales = await fetchSalesByLocation(range, optionsFor(managerToken));
    check(
      "1a the manager's own client module gets a report over real HTTP",
      managerSales.ok,
      managerSales.ok
        ? `locations=${String(managerSales.data.locations.length)} network=${String(managerSales.data.scope.network)}`
        : `failure=${JSON.stringify(managerSales.failure)}`,
    );

    if (managerSales.ok) {
      // Non-vacuity and correctness in one: the client's figures are compared
      // to the SERVER's own rows, read straight out of Postgres.
      const [dbTotal] = await scoped<{ total: string | null; n: string }>(
        `select sum(total_minor)::text as total, count(*)::text as n
           from app.sale
          where tenant_id = $1 and location_id = any($2::uuid[]) and deleted_at is null`,
        [tenantId, managerSales.data.locations.map((l) => l.locationId)],
      );
      const serverTotal = BigInt(dbTotal?.total ?? '0');
      const clientTotal = managerSales.data.locations.reduce(
        (acc: bigint, l) => acc + l.totalMinor,
        0n,
      );
      check(
        "1b the client's revenue equals Postgres, as an exact bigint identity",
        clientTotal === serverTotal,
        `client=${clientTotal.toString()} postgres=${serverTotal.toString()} sales=${dbTotal?.n ?? '?'}`,
      );
      check(
        '1c the report is NON-VACUOUS — there is trade in it',
        serverTotal > 0n && managerSales.data.locations.length > 0,
        `revenue=${serverTotal.toString()} over ${String(managerSales.data.locations.length)} location(s)`,
      );
      check(
        "1d Σ(per-location) equals the client's own network total",
        managerSales.data.total.totalMinor === clientTotal,
        `total=${managerSales.data.total.totalMinor.toString()} Σlines=${clientTotal.toString()}`,
      );
      measure(
        `report scope: network=${String(managerSales.data.scope.network)} over ` +
          `${String(managerSales.data.scope.locationCount)} location(s)`,
      );
    }

    // The refusal, on the SAME call with the SAME payload.
    const counterSales = await fetchSalesByLocation(range, optionsFor(counterToken));
    check(
      '1e counter staff is REFUSED the same report, same payload',
      !counterSales.ok && counterSales.failure.kind === 'forbidden',
      `kind=${failureKind(counterSales)} status=${counterSales.ok ? '200' : String(counterSales.failure.status)}`,
    );
    check(
      '1f the refusal carries NO figures — a reason, never a table of zeroes',
      !counterSales.ok && !('data' in counterSales),
      counterSales.ok ? 'returned data' : `detail=${String(counterSales.failure.detail)}`,
    );

    // =====================================================================
    // 2 — LOW STOCK, non-vacuously
    // =====================================================================
    console.log('\n-- 2. low stock --------------------------------------------');
    // A product that HAS stock here, so a threshold above its on-hand
    // genuinely fires. Chosen from the ledger, not from a fixture.
    const [stocked] = await scoped<{ product_id: string; on_hand: string; sku_code: string }>(
      `select m.product_id, sum(m.qty_delta)::text as on_hand, p.sku_code
         from app.stock_movement m
         join app.product p on p.tenant_id = m.tenant_id and p.id = m.product_id
        where m.tenant_id = $1 and m.location_id = $2 and p.stock_tracking = 'STOCKED'
        group by m.product_id, p.sku_code
       having sum(m.qty_delta) > 0
        order by sum(m.qty_delta) desc
        limit 1`,
      [tenantId, locationId],
    );
    if (stocked === undefined) {
      throw new Error('no stocked product with a positive balance here — run the sync drills first');
    }
    const onHand = BigInt(stocked.on_hand);
    // Deliberately ABOVE on-hand, so the alert must fire. Setting it below
    // would produce an empty list that proves nothing.
    const threshold = onHand + 1_000n;
    const setResult = await setReorderPoint(
      {
        idempotencyKey: randomUUID(),
        locationId,
        productId: stocked.product_id,
        reorderPointQty: threshold.toString(),
      },
      optionsFor(managerToken),
    );
    check(
      "2a the client's setReorderPoint writes a threshold over real HTTP",
      setResult.ok,
      setResult.ok
        ? `reorderPointId=${setResult.data.reorderPointId} created=${String(setResult.data.created)}`
        : `failure=${JSON.stringify(setResult.failure)}`,
    );

    const counterSet = await setReorderPoint(
      {
        idempotencyKey: randomUUID(),
        locationId,
        productId: stocked.product_id,
        reorderPointQty: threshold.toString(),
      },
      optionsFor(counterToken),
    );
    check(
      '2b counter staff is REFUSED the threshold write, same payload',
      !counterSet.ok && counterSet.failure.kind === 'forbidden',
      `kind=${failureKind(counterSet)}`,
    );

    const picture = await fetchLowStockPicture({ locationIds: [locationId] }, optionsFor(managerToken));
    check(
      "2c the client's low-stock read answers over real HTTP",
      picture.ok,
      picture.ok
        ? `alerts=${String(picture.data.report.alertCount)}`
        : `failure=${JSON.stringify(picture.failure)}`,
    );
    if (picture.ok) {
      // THE ASSERTION THAT MATTERS. An empty list would pass vacuously and
      // would also be exactly what a broken client returns.
      check(
        '2d the alert list is NON-EMPTY — a vacuous empty list would prove nothing',
        picture.data.report.alerts.length >= 1,
        `alerts=${String(picture.data.report.alerts.length)} locations=${String(picture.data.report.locationCount)}`,
      );
      const mine = picture.data.report.alerts.find((a) => a.productId === stocked.product_id);
      check(
        '2e the threshold just set is the one raising the alert, with the ledger quantity',
        mine !== undefined && mine.qtyOnHand === onHand && mine.reorderPointQty === threshold,
        mine === undefined
          ? 'the product just thresholded is absent from the alert list'
          : `onHand=${mine.qtyOnHand.toString()} (ledger ${onHand.toString()}) ` +
            `threshold=${mine.reorderPointQty.toString()} shortfall=${mine.shortfallQty.toString()}`,
      );
      check(
        '2f coverage reads CONFIGURED — the screen may say what an empty list means',
        picture.data.coverage.get(locationId)?.kind === 'configured' &&
          !picture.data.noThresholdsAnywhere,
        `coverage=${JSON.stringify(picture.data.coverage.get(locationId))} ` +
          `noThresholdsAnywhere=${String(picture.data.noThresholdsAnywhere)}`,
      );
    }

    const points = await fetchReorderPoints(locationId, optionsFor(managerToken));
    check(
      '2g the threshold list agrees with the alert about the same row',
      points.ok && points.data.points.some((p) => p.productId === stocked.product_id && p.isLow),
      points.ok ? `points=${String(points.data.points.length)}` : `failure=${failureKind(points)}`,
    );

    // =====================================================================
    // 3 — A STOCK ADJUSTMENT RECORDED OFFLINE, DRAINED ON RECONNECT
    // =====================================================================
    console.log('\n-- 3. offline stock adjustment -----------------------------');
    const [reason] = await scoped<{ code: string; name: string }>(
      `select code, name from app.movement_reason
        where tenant_id = $1 and deleted_at is null order by code limit 1`,
      [tenantId],
    );
    if (reason === undefined) throw new Error('the tenant has no movement reasons');

    const [uom] = await scoped<{ code: string; qty_scale: number }>(
      `select u.code, u.qty_scale from app.product p
         join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
        where p.tenant_id = $1 and p.id = $2`,
      [tenantId, stocked.product_id],
    );
    if (uom === undefined) throw new Error('the product has no stocking unit');

    const deviceDb: LocalDb = openTestDb();
    await provisionDevice(deviceDb, { locationId, locationCode: loc.code });
    await seedProduct(deviceDb, {
      id: stocked.product_id,
      code: stocked.sku_code,
      name: 'D10 adjustment product',
      uomLabel: uom.code,
      qtyScale: uom.qty_scale,
      unitPriceE4: 1_000_000n,
    });
    await seedMovementReason(deviceDb, reason);

    const movementId = randomUUID();
    const nowIso = new Date().toISOString();
    const qtyDelta = -3n;
    await recordAdjustment(deviceDb, {
      movementId,
      productId: stocked.product_id,
      qtyDelta,
      kind: 'WRITE_OFF',
      reasonCode: reason.code,
      hlc: fixedHlc(Date.now(), randomBytes(16).toString('hex')),
      nowIso,
    });
    check(
      '3a the adjustment is recorded LOCALLY with no network on the path',
      (await readPendingOps(deviceDb)).length === 1,
      `pending=${String((await readPendingOps(deviceDb)).length)} key=${movementId}`,
    );

    const offlineDrain = await drainOutbox(
      deviceDb,
      httpUploadTransport({
        apiUrl: API_URL,
        apiToken: managerToken,
        fetchFn: deadUploadFetch,
      }),
    );
    const absentWhileOffline = await scoped<{ n: string }>(
      `select count(*)::text as n from app.stock_movement where tenant_id = $1 and write_id = $2`,
      [tenantId, movementId],
    );
    check(
      '3b it is ABSENT from the server while the device is partitioned',
      !offlineDrain.transportOk && offlineDrain.deferred === 1 && absentWhileOffline[0]?.n === '0',
      `transportOk=${String(offlineDrain.transportOk)} deferred=${String(offlineDrain.deferred)} ` +
        `rows=${absentWhileOffline[0]?.n ?? '?'}`,
    );

    const t0 = Date.now();
    const onlineDrain = await drainOutbox(
      deviceDb,
      httpUploadTransport({
        apiUrl: API_URL,
        apiToken: managerToken,
        fetchFn: browserUploadFetch,
      }),
    );
    const elapsed = Date.now() - t0;
    check(
      '3c on reconnect it drains and is ACKED APPLIED',
      onlineDrain.transportOk && onlineDrain.completed === 1 && onlineDrain.rejected === 0,
      `completed=${String(onlineDrain.completed)} rejected=${String(onlineDrain.rejected)} ` +
        `deferred=${String(onlineDrain.deferred)} in ${String(elapsed)}ms`,
    );
    measure(`offline adjustment drained on reconnect in ${String(elapsed)}ms (budget 60000ms)`);

    const landed = await scoped<{
      qty_delta: string;
      source_kind: string;
      location_id: string;
      n: string;
    }>(
      `select qty_delta::text, source_kind, location_id, count(*) over ()::text as n
         from app.stock_movement where tenant_id = $1 and write_id = $2`,
      [tenantId, movementId],
    );
    check(
      '3d the movement is in Postgres, once, with the client\'s exact bigint',
      landed.length === 1 &&
        BigInt(landed[0]!.qty_delta) === qtyDelta &&
        landed[0]!.source_kind === 'WRITE_OFF' &&
        landed[0]!.location_id === locationId,
      landed.length === 0
        ? 'no row'
        : `rows=${landed[0]!.n} qty_delta=${landed[0]!.qty_delta} kind=${landed[0]!.source_kind}`,
    );
    check(
      '3e the counter stops showing it as pending',
      (await readPendingOps(deviceDb)).length === 0,
      `pending=${String((await readPendingOps(deviceDb)).length)}`,
    );

    // =====================================================================
    // 4 — CREDIT, the client's figures against Postgres
    // =====================================================================
    console.log('\n-- 4. credit -----------------------------------------------');
    // FIXTURE, over raw tRPC: the path under test is the client's READ, so
    // the account and its entries are set up by the shortest honest route.
    const openKey = randomUUID();
    const opened = (await rawMutate(accountsToken, 'credit.openAccount', {
      idempotencyKey: openKey,
      newCustomer: { code: `D10-${openKey.slice(0, 8)}`, name: 'D10 account' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '5000000',
    })) as { accountId?: string };
    const accountId = opened.accountId;
    if (accountId === undefined) throw new Error('credit.openAccount returned no accountId');

    for (const [amount, kind] of [
      ['370800', 'CHARGE'],
      ['494400', 'CHARGE'],
      ['-100000', 'PAYMENT'],
    ] as const) {
      await rawMutate(accountsToken, 'credit.recordEntry', {
        idempotencyKey: randomUUID(),
        accountId,
        kind,
        amountMinor: amount,
        businessDate: today(),
      });
    }

    const exposure = await fetchExposure(accountId, optionsFor(accountsToken));
    check(
      "4a the client's credit module reads an exposure over real HTTP",
      exposure.ok,
      exposure.ok
        ? `exposure=${exposure.data.exposureMinor.toString()} available=${exposure.data.availableMinor.toString()}`
        : `failure=${JSON.stringify(exposure.failure)}`,
    );

    const [entrySum] = await scoped<{ total: string | null; n: string }>(
      `select sum(amount_minor)::text as total, count(*)::text as n
         from app.credit_entry where tenant_id = $1 and account_id = $2 and deleted_at is null`,
      [tenantId, accountId],
    );
    const serverExposure = BigInt(entrySum?.total ?? '0');
    check(
      "4b the client's exposure EQUALS Σ(app.credit_entry) — exact bigint identity",
      exposure.ok && exposure.data.exposureMinor === serverExposure,
      `client=${exposure.ok ? exposure.data.exposureMinor.toString() : 'n/a'} ` +
        `postgres=${serverExposure.toString()} over ${entrySum?.n ?? '?'} entries`,
    );
    check(
      '4c it is NON-VACUOUS — the account genuinely owes something',
      serverExposure > 0n,
      `Σ(entries)=${serverExposure.toString()}`,
    );
    check(
      "4d available = limit − exposure, on the client's own arithmetic",
      exposure.ok &&
        exposure.data.availableMinor ===
          exposure.data.creditLimitMinor - exposure.data.exposureMinor,
      exposure.ok
        ? `${exposure.data.creditLimitMinor.toString()} − ${exposure.data.exposureMinor.toString()} = ` +
          `${exposure.data.availableMinor.toString()}`
        : 'n/a',
    );

    // The reconciliation is checked by the CLIENT'S OWN `checkAgreement`, not
    // by an identity restated here. It is the function the credit screen
    // renders "these reconcile" from, so a drill that re-derived the sum
    // would be the third thing that agrees with neither side (§0).
    const position = await fetchCreditPosition(accountId, today(), optionsFor(accountsToken));
    check(
      "4e the client's own checkAgreement says balance and ageing RECONCILE",
      position.ok && position.data.agreement.kind === 'agrees',
      position.ok
        ? `agreement=${JSON.stringify(position.data.agreement, (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v)} ` +
          `Σbuckets=${position.data.ageing.buckets
            .reduce((a: bigint, b) => a + b.amountMinor, 0n)
            .toString()} onAccount=${position.data.ageing.onAccountCreditMinor.toString()} ` +
          `balance=${position.data.exposure.exposureMinor.toString()} ` +
          `agedBy=${position.data.ageing.agedBy}`
        : `failure=${failureKind(position)}`,
    );
    check(
      '4g the unapplied payment is on its OWN line, never netted into a bucket',
      position.ok && position.data.ageing.onAccountCreditMinor === 100_000n,
      position.ok
        ? `onAccountCredit=${position.data.ageing.onAccountCreditMinor.toString()} (paid 100000)`
        : `failure=${failureKind(position)}`,
    );
    check(
      '4h the facility fee is PROVISIONAL and refuses to be chargeable (Q4 gate)',
      position.ok &&
        (position.data.fee === null || position.data.fee.provisional) &&
        position.data.exposure.exposureMinor > 0n,
      position.ok
        ? `fee=${position.data.fee === null ? `withheld (${String(position.data.feeFailure?.kind)})` : `provisional=${String(position.data.fee.provisional)} label="${position.data.fee.label}"`}`
        : `failure=${failureKind(position)}`,
    );

    const counterExposure = await fetchExposure(accountId, optionsFor(counterToken));
    check(
      '4f counter staff is REFUSED the balance, same payload',
      !counterExposure.ok && counterExposure.failure.kind === 'forbidden',
      `kind=${failureKind(counterExposure)}`,
    );

    // =====================================================================
    // 5 — HONESTY WITH THE RADIO GENUINELY OFF
    // =====================================================================
    console.log('\n-- 5. offline honesty --------------------------------------');
    const offlineOpts = optionsFor(managerToken, deadApiFetch);
    const offlineReport = await fetchSalesByLocation(range, offlineOpts);
    const offlineStock = await fetchStockOnHand({ locationIds: [locationId] }, offlineOpts);
    const offlineAlerts = await fetchLowStockPicture({ locationIds: [locationId] }, offlineOpts);
    const offlineBalance = await fetchExposure(accountId, optionsFor(accountsToken, deadApiFetch));

    for (const [what, result] of [
      ['a report', offlineReport],
      ['stock on hand', offlineStock],
      ['the low-stock alert', offlineAlerts],
      ['a credit balance', offlineBalance],
    ] as const) {
      check(
        `5 ${what} answers OFFLINE — never an empty list, never a zero`,
        !result.ok && result.failure.kind === 'offline',
        result.ok ? 'RETURNED DATA WITH NO NETWORK' : `kind=${result.failure.kind}`,
      );
    }
  } finally {
    await sql.end();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n=== D10: ${checks.length - failed.length}/${checks.length} checks passed ===`);
  console.log(`__DRILL_RESULT__ ${JSON.stringify({ checks, measurements })}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error('D10 aborted:', message);
  console.log(`__DRILL_RESULT__ ${JSON.stringify({ checks, measurements, error: message })}`);
  process.exit(1);
});
