/**
 * D7 — WHO MAY DO WHAT, PROVEN OVER A REAL SOCKET.
 *
 *   pnpm stack:up
 *   pnpm --filter @erp/api dev:stack          # API on :3001
 *   pnpm --filter @erp/wire-conformance drill:rbac
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AS A LIVE DRILL AND NOT ONLY AS A UNIT TEST
 * ═════════════════════════════════════════════════════════════════════════
 * `apps/api/test/rbac.test.ts` and the `packages/db` permission suites prove
 * the resolution logic in-process on PGlite. They are fast, they run on every
 * `pnpm test`, and they are not enough — because five of this project's bugs
 * so far were paths that were written, unit-tested, and never once driven end
 * to end (CORS, the sale payload, device enrolment, the price list, the
 * currency spec). Each was invisible to a green suite.
 *
 * This one nearly became the sixth. Permission enforcement was added to the
 * API with 535 unit tests passing, while on the live stack:
 *
 *   - migration 0005 had never been applied, so `app.effective_permission`
 *     did not exist at all;
 *   - `applyTemplate` seeds ROLES but deliberately seeds no users and no
 *     assignments, so every tenant had five roles and zero grants;
 *   - every Phase 1 acceptance drill died at warm-up with
 *     `FORBIDDEN: PERMISSION_DENIED: stock.adjust is not held by this user`.
 *
 * None of that is visible from a unit test, because the API test harness
 * grants each identity the owner role by default. So the refusal is asserted
 * HERE: a real HS256 bearer, a real HTTP request to :3001, a real Postgres
 * on :5433, a real 403 on the wire.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT IT ASSERTS — a matrix, not a single happy refusal
 * ═════════════════════════════════════════════════════════════════════════
 * Every case is a PAIR: a principal who lacks the capability is refused, and
 * a principal who holds it succeeds against the same route with the same
 * payload shape. A refusal on its own proves nothing — a route that is broken
 * for everyone also returns 403.
 *
 *   1. stock adjustment       counter staff DENIED   / outlet manager ALLOWED
 *   2. credit account + limit counter staff DENIED   / accounts ALLOWED
 *      ... and the OUTLET MANAGER is denied too. That is the brief's second
 *      hard prohibition holding at both levels: the capability is absent from
 *      the role, not policed by a role name.
 *   3. location scope         manager at OUT-01 DENIED at OUT-04 (a different
 *                             region) / ALLOWED at OUT-01 — same token, same
 *                             capability, different place.
 *   4. the closure tree       regional manager at REG-BONO ALLOWED at BOTH
 *                             OUT-01 and OUT-03 from one grant. The FY3
 *                             regional role, demonstrated on day one.
 *   5. segregation of duties  accounts at the ROOT — the widest scope there
 *                             is — DENIED a stock adjustment. Scope is not
 *                             authority.
 *   6. revocation is live     revoke the grant, replay the SAME UNEXPIRED
 *                             token: now denied. Proof the answer comes from
 *                             the database per request and not from the token.
 *   7. the role claim is inert  a counter-staff principal carrying
 *                             `role: "head_of_operations"` in its own token is
 *                             refused exactly as before. Nothing on the
 *                             platform branches on that string (CLAUDE.md
 *                             §2.9), and this is what proves it rather than
 *                             asserting it.
 *
 * Prints `__DRILL_RESULT__ {json}` so a report can fold it in. Exits non-zero
 * if any check fails.
 */
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';

import { provisionPrincipal } from '@erp/db/seed';

const API_URL = process.env['API_URL'] ?? 'http://127.0.0.1:3001';
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://erp:erp_dev@localhost:5433/erp';
const DEV_JWT_SECRET = process.env['DEV_JWT_SECRET'] ?? 'dev-secret-change-me';

const encoder = new TextEncoder();

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];

function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
}

// ---------------------------------------------------------------------------
// Postgres — provisioning principals the way onboarding will
// ---------------------------------------------------------------------------

const client = new pg.Client({ connectionString: DATABASE_URL });

/** The shape `@erp/db`'s seed helpers take. */
interface DbQueryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

async function withTenant<T>(tenantId: string, fn: (tx: DbQueryable) => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    await client.query('set local role app_user');
    await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    const out = await fn({
      query: async <R,>(sql: string, params?: unknown[]) => {
        const r = await client.query(sql, params as unknown[]);
        return { rows: r.rows as R[] };
      },
    });
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
}

async function locationByCode(tenantId: string, code: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `select id from app.location where tenant_id = $1 and code = $2 and deleted_at is null`,
    [tenantId, code],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`tenant ${tenantId} has no location ${code}`);
  return id;
}

/**
 * A principal, its grant, and a bearer for it.
 *
 * `locs` is the CLOSURE EXPANSION of the scope node, which is what a real
 * enrolment would put in the token — so when a request is refused below it is
 * refused by the permission check and not merely by `assertLocationInScope`.
 * The two controls are independent and this drill is about the second one.
 */
interface Principal {
  label: string;
  userId: string;
  bearer: string;
  locationIds: string[];
  scopeLocationId: string;
}

async function makePrincipal(
  tenantId: string,
  label: string,
  roleRef: string | undefined,
  scopeLocationId: string,
  /** Override the token's opaque `role` claim — used by check 7. */
  roleClaim = 'a tenant-chosen job title the platform never reads',
): Promise<Principal> {
  const userId = randomUUID();
  const provisioned = await withTenant(tenantId, (tx) =>
    provisionPrincipal(tx, tenantId, {
      userId,
      username: `rbac-drill-${label}-${userId.slice(0, 8)}`,
      displayName: `RBAC drill ${label}`,
      ...(roleRef !== undefined ? { roleRef } : {}),
      scopeLocationId,
    }),
  );
  const bearer = await new SignJWT({
    tid: tenantId,
    uid: userId,
    role: roleClaim,
    locs: provisioned.locationIds,
    dev: randomUUID(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(encoder.encode(DEV_JWT_SECRET));

  return { label, userId, bearer, locationIds: provisioned.locationIds, scopeLocationId };
}

async function revokeGrants(tenantId: string, userId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.query(
      `update app.user_role_assignment set deleted_at = transaction_timestamp()
        where user_id = $1 and deleted_at is null`,
      [userId],
    );
  });
}

// ---------------------------------------------------------------------------
// HTTP — the real wire
// ---------------------------------------------------------------------------

interface Outcome {
  status: number;
  /** The tRPC error code, when the call failed. */
  errorCode: string | null;
  message: string;
  body: unknown;
}

/** POST one tRPC mutation over HTTP with this principal's bearer. */
async function callMutation(
  principal: Principal,
  procedure: string,
  input: Record<string, unknown>,
): Promise<Outcome> {
  const res = await fetch(`${API_URL}/trpc/${procedure}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${principal.bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ json: input }),
  });
  const body: unknown = await res.json().catch(() => null);
  const err = (body as { error?: { json?: { message?: string; data?: { code?: string } } } })?.error
    ?.json;
  return {
    status: res.status,
    errorCode: err?.data?.code ?? null,
    message: err?.message ?? '',
    body,
  };
}

/** The two assertions that matter, spelled out so a FAIL says which half broke. */
function expectForbidden(name: string, o: Outcome, expectPrefix: string): void {
  const ok = o.status === 403 && o.errorCode === 'FORBIDDEN' && o.message.startsWith(expectPrefix);
  check(
    name,
    ok,
    `HTTP ${o.status} ${o.errorCode ?? '-'} "${o.message.slice(0, 110)}"` +
      (ok ? '' : ` (wanted 403 FORBIDDEN starting "${expectPrefix}")`),
  );
}

function expectAllowed(name: string, o: Outcome, detail: string): void {
  check(
    name,
    o.status === 200,
    o.status === 200
      ? detail
      : `HTTP ${o.status} ${o.errorCode ?? '-'} "${o.message.slice(0, 140)}"`,
  );
}

const envelope = (): { idempotencyKey: string; businessDate: string } => ({
  idempotencyKey: randomUUID(),
  businessDate: new Date().toISOString().slice(0, 10),
});

function writeOff(locationId: string, productId: string): Record<string, unknown> {
  return {
    ...envelope(),
    locationId,
    productId,
    qtyDelta: '-1',
    // WRITE_OFF maps to `stock.adjust` — the audited, reason-coded capability.
    sourceKind: 'WRITE_OFF',
    reasonCode: 'DAMAGE',
  };
}

function openAccount(suffix: string, creditLimitMinor: string): Record<string, unknown> {
  // No businessDate: opening an account is not a dated document. The schema
  // is .strict(), so an extra key is a 400 — which is exactly the behaviour
  // that must not be mistaken for a 403 in this drill's output.
  return {
    idempotencyKey: randomUUID(),
    newCustomer: { code: `RBAC-${suffix}`, name: `RBAC drill contractor ${suffix}` },
    termsDays: 30,
    feeRateBpPerMonth: 200,
    creditLimitMinor,
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== D7 — RBAC over the real wire (API :3001, Postgres :5433) ===');
  await client.connect();

  const tenants = (await import('../../../infra/dev-tenants.json', { with: { type: 'json' } }))
    .default as { tenantA: { id: string } };
  const tenantId = tenants.tenantA.id;

  const [root, regBono, out01, out03, out04] = await Promise.all([
    locationByCode(tenantId, 'ROOT'),
    locationByCode(tenantId, 'REG-BONO'),
    locationByCode(tenantId, 'OUT-01'),
    locationByCode(tenantId, 'OUT-03'),
    locationByCode(tenantId, 'OUT-04'), // deliberately NOT under REG-BONO
  ]);

  const product = (
    await client.query<{ id: string }>(
      `select p.id from app.product p
        where p.tenant_id = $1 and p.stock_tracking = 'STOCKED' and p.deleted_at is null
        order by p.sku_code limit 1`,
      [tenantId],
    )
  ).rows[0];
  if (!product) throw new Error('tenant A has no stocked product — run pnpm stack:reset');

  // Principals, each holding exactly ONE template role at ONE node.
  const counter = await makePrincipal(tenantId, 'counter', 'counter_staff', out01);
  const manager = await makePrincipal(tenantId, 'manager', 'outlet_manager', out01);
  const regional = await makePrincipal(tenantId, 'regional', 'regional_manager', regBono);
  const accounts = await makePrincipal(tenantId, 'accounts', 'accounts', root);
  console.log(
    `  [setup] counter@OUT-01 manager@OUT-01 regional@REG-BONO(${regional.locationIds.length} locs) accounts@ROOT`,
  );

  // -- 1. stock adjustment: the capability is absent from the counter role --
  expectForbidden(
    '1a. counter staff CANNOT adjust stock (stock.adjust absent from the role)',
    await callMutation(counter, 'inventory.recordMovement', writeOff(out01, product.id)),
    'PERMISSION_DENIED: stock.adjust',
  );
  expectAllowed(
    '1b. outlet manager CAN adjust stock at the same counter, same payload',
    await callMutation(manager, 'inventory.recordMovement', writeOff(out01, product.id)),
    'the positive control succeeded — the route is not simply broken',
  );

  // -- 2. the brief's second hard prohibition: the credit limit -------------
  expectForbidden(
    '2a. counter staff CANNOT open a credit account with a limit',
    await callMutation(counter, 'credit.openAccount', openAccount(`c-${Date.now()}`, '5000000')),
    'PERMISSION_DENIED: credit.account.manage',
  );
  expectForbidden(
    '2b. the OUTLET MANAGER cannot either — the capability is absent, not the name',
    await callMutation(manager, 'credit.openAccount', openAccount(`m-${Date.now()}`, '5000000')),
    'PERMISSION_DENIED: credit.account.manage',
  );
  expectAllowed(
    '2c. Accounts CAN — held at the tenant root, where an account with no location lives',
    await callMutation(accounts, 'credit.openAccount', openAccount(`a-${Date.now()}`, '5000000')),
    'the positive control succeeded — GH₵50,000 limit accepted for the role that holds it',
  );

  // -- 3. a capability is a capability AT A PLACE ---------------------------
  expectForbidden(
    '3a. the manager holds stock.adjust — but NOT at an outlet in another region',
    await callMutation(manager, 'inventory.recordMovement', writeOff(out04, product.id)),
    'PERMISSION_OUT_OF_SCOPE',
  );

  // -- 4. one grant at a region node, expanded down the closure -------------
  expectAllowed(
    '4a. regional manager (granted once at REG-BONO) may act at OUT-01',
    await callMutation(regional, 'inventory.recordMovement', writeOff(out01, product.id)),
    'one grant, first location',
  );
  expectAllowed(
    '4b. …and at OUT-03, from the SAME single grant — the closure expanded it',
    await callMutation(regional, 'inventory.recordMovement', writeOff(out03, product.id)),
    'one grant, second location — no per-outlet assignment exists',
  );
  expectForbidden(
    '4c. …and still not at OUT-04, which is under a different region node',
    await callMutation(regional, 'inventory.recordMovement', writeOff(out04, product.id)),
    'PERMISSION_OUT_OF_SCOPE',
  );

  // -- 5. the widest scope in the tenant is still not authority ------------
  expectForbidden(
    '5a. Accounts, at the tenant ROOT, CANNOT adjust stock (segregation of duties)',
    await callMutation(accounts, 'inventory.recordMovement', writeOff(out01, product.id)),
    'PERMISSION_DENIED: stock.adjust',
  );

  // -- 6. revocation takes effect NOW, on an unexpired token ---------------
  const beforeRevoke = await callMutation(
    manager,
    'inventory.recordMovement',
    writeOff(out01, product.id),
  );
  await revokeGrants(tenantId, manager.userId);
  const afterRevoke = await callMutation(
    manager,
    'inventory.recordMovement',
    writeOff(out01, product.id),
  );
  check(
    '6a. revoking the grant refuses the SAME unexpired token on the next request',
    beforeRevoke.status === 200 && afterRevoke.status === 403,
    `before=${beforeRevoke.status} after=${afterRevoke.status} "${afterRevoke.message.slice(0, 80)}" ` +
      '— the decision is a database read per request, never a token claim',
  );

  // -- 7. the token's `role` string is inert -------------------------------
  const impostor = await makePrincipal(
    tenantId,
    'impostor',
    'counter_staff',
    out01,
    // The most privileged-sounding string in this tenant's org chart, in a
    // token the server itself signed. It must change nothing.
    'head_of_operations',
  );
  expectForbidden(
    '7a. a counter-staff grant carrying role:"head_of_operations" is still refused',
    await callMutation(impostor, 'inventory.recordMovement', writeOff(out01, product.id)),
    'PERMISSION_DENIED: stock.adjust',
  );
  expectForbidden(
    '7b. …and still cannot reach a credit limit',
    await callMutation(impostor, 'credit.openAccount', openAccount(`i-${Date.now()}`, '5000000')),
    'PERMISSION_DENIED: credit.account.manage',
  );

  await client.end();

  const failed = checks.filter((c) => !c.pass);
  const summary = {
    drill: 'D7-rbac-live',
    passed: checks.length - failed.length,
    total: checks.length,
    checks,
  };
  console.log(`__DRILL_RESULT__ ${JSON.stringify(summary)}`);
  console.log(
    `=== ${summary.passed}/${summary.total} RBAC checks passed over real HTTP ===`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('rbac drill fatal:', err);
  await client.end().catch(() => undefined);
  process.exit(1);
});
