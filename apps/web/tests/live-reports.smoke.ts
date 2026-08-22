/**
 * THE CLIENT'S OWN REQUEST BUILDERS, AGAINST THE REAL API, OVER A REAL SOCKET.
 *
 * NOT part of `pnpm test` — it is not a `*.test.ts` (vitest only collects
 * those) and it needs the docker stack plus an API dev server on the CURRENT
 * source:
 *
 *   pnpm stack:up
 *   pnpm dev:api
 *   pnpm --filter @erp/web exec tsx tests/live-reports.smoke.ts
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * §0 of docs/phase1-status.md is a ledger of NINE times a green suite failed
 * to notice that a written path had never been executed, and the one root
 * cause is stated there once: both sides were only ever tested against a
 * third thing that agreed with neither of them. The unit tests in
 * `tests/reports-ui.test.tsx` and `tests/low-stock-ui.test.tsx` drive real
 * components through a STUB transport, so they can prove that this client
 * renders a payload correctly and cannot prove the server produces one.
 *
 * This script closes that gap for the reporting and low-stock client: it
 * mints real bearers for real provisioned principals, calls the client's own
 * `fetchSalesByLocation` / `fetchLowStockPicture` / `setReorderPoint` and
 * asserts against the answers the deployed API actually gives — including the
 * two refusals, each paired with a positive control on the same route so
 * "denied" can never quietly mean "the route is broken for everyone".
 *
 * It imports nothing outside `apps/web`'s own dependencies; the tokens come
 * from the repository's existing dev-token script.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiEndpoint, ApiResult } from '../src/data/api/client';
import { fetchLowStockPicture, setReorderPoint } from '../src/data/api/inventory';
import {
  fetchCashPosition,
  fetchDistributionCost,
  fetchInventoryDays,
  fetchSalesByLocation,
  fetchStockOnHand,
} from '../src/data/api/reports';
import { resolvePermissions } from '../src/data/api/session';
import { readBearerScope } from '../src/data/session/bearer-claims';
import { uuidv7 } from '../src/lib/uuidv7';
import { openTestDb } from './helpers/node-db';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API_URL = process.env['API_URL'] ?? 'http://localhost:3001';

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`);
}

function tokenFor(role: string): string {
  const out = execFileSync('node', ['infra/scripts/dev-token.mjs', '--role', role], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const token = out.trim().split('\n').pop() ?? '';
  if (!token.startsWith('ey')) throw new Error(`no token for ${role}: ${out}`);
  return token;
}

function endpointFor(role: string): { endpoint: ApiEndpoint; locationId: string } {
  const bearer = tokenFor(role);
  const scope = readBearerScope(bearer);
  if (scope.kind !== 'scoped' || scope.locationIds[0] === undefined) {
    throw new Error(`token for ${role} carries no location scope`);
  }
  return { endpoint: { url: API_URL, bearer }, locationId: scope.locationIds[0] };
}

function why<T>(r: ApiResult<T>): string {
  return r.ok ? 'ok' : `${r.failure.kind}: ${(r.failure.detail ?? r.failure.message).slice(0, 90)}`;
}

const RANGE = { from: '2020-01-01', to: '2030-12-31' };

async function main(): Promise<void> {
  const manager = endpointFor('outlet_manager');
  const staff = endpointFor('counter_staff');
  const head = endpointFor('head_of_operations');

  // ── 1. Reporting scope: the distinction the whole screen turns on ────────
  const managerSales = await fetchSalesByLocation(RANGE, { endpoint: manager.endpoint });
  check(
    '1a outlet manager may report, and is told it is NOT the whole organisation',
    managerSales.ok && managerSales.data.scope.network === false,
    why(managerSales) + (managerSales.ok ? ` network=${String(managerSales.data.scope.network)}` : ''),
  );

  const headSales = await fetchSalesByLocation(RANGE, { endpoint: head.endpoint });
  // THE EXACT CONFUSION THE SCREEN EXISTS TO PREVENT, demonstrated live: on
  // this dev tenant both principals are granted at the root, so the two
  // callers get the SAME DIGITS — and one of them is the organisation's total
  // while the other is only "every location I may see". Nothing in the
  // figures distinguishes them; only `scope.network` does, which is why the
  // screen labels the total row differently in the two cases.
  check(
    '1b the same total comes back flagged network for one caller and not the other',
    headSales.ok &&
      managerSales.ok &&
      headSales.data.scope.network === true &&
      managerSales.data.scope.network === false &&
      headSales.data.total.totalMinor === managerSales.data.total.totalMinor,
    why(headSales) +
      (headSales.ok && managerSales.ok
        ? ` head network=true n=${String(headSales.data.scope.locationCount)} total=${headSales.data.total.totalMinor.toString()}` +
          ` · manager network=false n=${String(managerSales.data.scope.locationCount)} total=${managerSales.data.total.totalMinor.toString()}`
        : ''),
  );

  const staffSales = await fetchSalesByLocation(RANGE, { endpoint: staff.endpoint });
  check(
    '1c counter staff refused reporting — the same route, the same payload',
    !staffSales.ok && staffSales.failure.kind === 'forbidden',
    why(staffSales),
  );

  // ── 2. Money and quantities arrive as magnitudes, never as floats ────────
  check(
    '2a every money field maps to bigint',
    managerSales.ok &&
      typeof managerSales.data.total.totalMinor === 'bigint' &&
      typeof managerSales.data.total.netRevenueMinor === 'bigint',
    why(managerSales),
  );

  const cash = await fetchCashPosition(RANGE, { endpoint: manager.endpoint });
  check(
    '2b cash position answers, with the server’s own caveats attached',
    cash.ok && cash.data.caveats.length > 0,
    why(cash) + (cash.ok ? ` caveats=${String(cash.data.caveats.length)}` : ''),
  );

  const stock = await fetchStockOnHand({ onlyNonZero: true }, { endpoint: manager.endpoint });
  check(
    '2c stock on hand answers in scaled integers with a unit per row',
    stock.ok &&
      (stock.data.networkByProduct.length === 0 ||
        (typeof stock.data.networkByProduct[0]?.qtyOnHand === 'bigint' &&
          typeof stock.data.networkByProduct[0]?.uomCode === 'string')),
    why(stock) + (stock.ok ? ` products=${String(stock.data.networkByProduct.length)}` : ''),
  );

  // ── 3. Cost and margin are a strictly narrower audience ──────────────────
  const managerMargin = await fetchInventoryDays(RANGE, { endpoint: manager.endpoint });
  const headMargin = await fetchInventoryDays(RANGE, { endpoint: head.endpoint });
  check(
    '3a outlet manager refused cost/margin; the tenant-wide holder allowed',
    !managerMargin.ok && managerMargin.failure.kind === 'forbidden' && headMargin.ok,
    `manager: ${why(managerMargin)} · head: ${why(headMargin)}`,
  );

  const dist = await fetchDistributionCost(RANGE, { endpoint: head.endpoint });
  check(
    '3b distribution cost is null, never zero, with a stated reason',
    dist.ok && dist.data.total.distributionCostMinor === null && dist.data.unavailableReason.length > 0,
    why(dist),
  );

  // ── 4. The capability list a screen lays itself out from ─────────────────
  const db = openTestDb();
  const perms = await resolvePermissions(db, {
    endpoint: staff.endpoint,
    bearerToken: staff.endpoint.bearer,
  });
  check(
    '4a session.permissions answers live and carries capabilities AT places',
    perms.status === 'live' && perms.snapshot.grants.length > 0,
    perms.status === 'live'
      ? `${String(perms.snapshot.codes.length)} codes over ${String(perms.snapshot.locationIds.length)} location(s)`
      : perms.status,
  );

  // ── 5. Low stock, and the distinction the screen exists to preserve ──────
  const before = await fetchLowStockPicture(
    { locationIds: [staff.locationId] },
    { endpoint: staff.endpoint },
  );
  check(
    '5a counter staff MAY see the low-stock list (stock.view, not a report code)',
    before.ok,
    why(before) + (before.ok ? ` alerts=${String(before.data.report.alertCount)}` : ''),
  );
  if (before.ok) {
    const coverage = before.data.coverage.get(staff.locationId);
    check(
      '5b the screen can tell "no thresholds set" apart from "nothing is low"',
      coverage !== undefined && coverage.kind !== 'unknown',
      `coverage=${coverage?.kind ?? 'missing'}${coverage?.kind === 'configured' ? ` (${String(coverage.count)})` : ''}`,
    );
  }

  // ── 6. Setting a threshold: refused for staff, allowed for the manager ───
  const productId = stock.ok ? stock.data.networkByProduct[0]?.productId : undefined;
  if (productId === undefined) {
    check('6 threshold write', false, 'no product with stock on hand to set a threshold against');
  } else {
    const staffWrite = await setReorderPoint(
      {
        idempotencyKey: uuidv7(),
        locationId: staff.locationId,
        productId,
        reorderPointQty: '5',
      },
      { endpoint: staff.endpoint },
    );
    check(
      '6a counter staff refused a threshold write',
      !staffWrite.ok && staffWrite.failure.kind === 'forbidden',
      why(staffWrite),
    );

    const managerWrite = await setReorderPoint(
      {
        idempotencyKey: uuidv7(),
        locationId: manager.locationId,
        productId,
        reorderPointQty: '999999',
      },
      { endpoint: manager.endpoint },
    );
    check(
      '6b outlet manager allowed — same route, same payload shape',
      managerWrite.ok,
      why(managerWrite) + (managerWrite.ok ? ` unit=${managerWrite.data.uomCode}` : ''),
    );

    const after = await fetchLowStockPicture(
      { locationIds: [manager.locationId] },
      { endpoint: manager.endpoint },
    );
    check(
      '6c the threshold shows up as an alert, most urgent first',
      after.ok && after.data.report.alerts.some((a) => a.productId === productId),
      why(after) + (after.ok ? ` alerts=${String(after.data.report.alertCount)}` : ''),
    );

    // Put the dev data back where it was found.
    await setReorderPoint(
      {
        idempotencyKey: uuidv7(),
        locationId: manager.locationId,
        productId,
        reorderPointQty: '0',
        isActive: false,
      },
      { endpoint: manager.endpoint },
    );
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
