/**
 * D8 — WHO MAY DO WHAT, PROVEN OVER A REAL SOCKET.
 *
 * (Numbered D7 when it was written; renumbered on merge, because the sync-drill
 * harness gained a real D7 — the receipt-number regression. One sequence across
 * the repo, so nobody has to ask which D7 a report means.)
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

/**
 * GET one tRPC QUERY over HTTP with this principal's bearer.
 *
 * The reporting and alert routes are queries, not mutations, so they arrive
 * as GET with the input in the query string — a different transport path
 * through the same Fastify/tRPC stack. It is exercised here for the same
 * reason the POST path is: a guard that only ever ran under a POST has not
 * been shown to run.
 */
async function callQuery(
  principal: Principal,
  procedure: string,
  input: Record<string, unknown>,
): Promise<Outcome> {
  const qs = new URLSearchParams({ input: JSON.stringify({ json: input }) });
  const res = await fetch(`${API_URL}/trpc/${procedure}?${qs.toString()}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${principal.bearer}` },
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

/** The `result.data.json` payload of a successful tRPC call. */
function payload(o: Outcome): Record<string, unknown> {
  return (
    ((o.body as { result?: { data?: { json?: Record<string, unknown> } } })?.result?.data?.json) ??
    {}
  );
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

/**
 * A sale payload. `priceListCode` is WHOLESALE deliberately: the shipped
 * template's best-ranked list (RETAIL) is tax-INCLUSIVE and neither the till
 * nor `sales.createSale` can price one yet, so a drill that used it would be
 * measuring that blocker instead of the bound. Nothing here asserts a price:
 * the server reprices from its own list and the total it computes is the only
 * figure the bound is ever measured against.
 */
function saleOp(
  locationId: string,
  productId: string,
  qty: bigint,
  tender: 'CASH' | 'CREDIT',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...envelope(),
    locationId,
    priceListCode: 'WHOLESALE',
    receiptNo: `RBAC-${randomUUID().slice(0, 12)}`,
    tender,
    lines: [{ productId, qty: qty.toString(10) }],
    ...extra,
  };
}

/**
 * A reorder point carries NO businessDate — a threshold is a standing setting,
 * not a dated document, and `setReorderPointInput` is `.strict()`, so sending
 * one is a 400. Spelled out as its own builder rather than reusing
 * `envelope()`, because a 400 here would look like a refusal and is not one.
 */
function reorderOp(
  locationId: string,
  productId: string,
  reorderPointQty: string,
): Record<string, unknown> {
  return { idempotencyKey: randomUUID(), locationId, productId, reorderPointQty };
}

function receiptOp(
  locationId: string,
  productId: string,
  qtyDelta: string,
): Record<string, unknown> {
  return {
    ...envelope(),
    locationId,
    productId,
    qtyDelta,
    sourceKind: 'RECEIPT',
    reasonCode: 'OPENING',
  };
}

/** Has any sale with this receipt number landed? The refusal's other half. */
async function saleExists(tenantId: string, receiptNo: string): Promise<boolean> {
  const r = await client.query<{ n: string }>(
    `select count(*)::text as n from app.sale where tenant_id = $1 and receipt_no = $2`,
    [tenantId, receiptNo],
  );
  return (r.rows[0]?.n ?? '0') !== '0';
}

async function creditEntryCount(tenantId: string): Promise<bigint> {
  const r = await client.query<{ n: string }>(
    `select count(*)::text as n from app.credit_entry where tenant_id = $1`,
    [tenantId],
  );
  return BigInt(r.rows[0]?.n ?? '0');
}

/**
 * The amount the server says the refused act was worth, read out of the
 * `PERMISSION_BOUND_EXCEEDED` message.
 *
 * Asserting on it is the point: it proves the figure the bound was measured
 * against is the SERVER's repriced total, not anything the caller supplied.
 */
function boundActAmount(message: string): bigint | null {
  const m = /this act is (-?\d+)/.exec(message);
  return m ? BigInt(m[1]!) : null;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== D8 — RBAC over the real wire (API :3001, Postgres :5433) ===');
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

  // ═══════════════════════════════════════════════════════════════════════
  // 8. THE CREDIT BOUND — the hole this drill was extended to close.
  //
  // Until `sales.createSale` was guarded, `max_order_value_minor` was data
  // nothing read: a counter clerk could open unbounded credit exposure
  // through the sale path with a green suite behind them. The template says
  // counter staff "0" and outlet manager "500000". This is that sentence,
  // asserted over a real socket against the real router.
  //
  // The manager used here is a FRESH principal: check 6 revoked the other
  // one's grants on purpose, and reusing it would make every refusal below
  // ambiguous.
  // ═══════════════════════════════════════════════════════════════════════
  const saleMgr = await makePrincipal(tenantId, 'salemgr', 'outlet_manager', out01);

  // A credit customer, opened by the only role that may (check 2c's route).
  const acct = await callMutation(
    accounts,
    'credit.openAccount',
    openAccount(`bound-${Date.now()}`, '100000000'),
  );
  const customerId = String(payload(acct)['customerId'] ?? '');
  if (acct.status !== 200 || !customerId) {
    throw new Error(`could not open the drill's credit account: ${acct.status} ${acct.message}`);
  }

  // A stocked, WHOLESALE-priced product, and the SERVER's own figure for one
  // of them. Deriving the cart sizes from a real priced sale rather than from
  // arithmetic in this file keeps the drill honest about rounding: the bound
  // is measured against whatever the pricing pipeline actually produces.
  const priced = (
    await client.query<{ id: string; sku_code: string }>(
      `select p.id, p.sku_code
         from app.price_list_item pli
         join app.price_list pl
           on pl.tenant_id = pli.tenant_id and pl.id = pli.price_list_id and pl.code = 'WHOLESALE'
         join app.product p
           on p.tenant_id = pli.tenant_id and p.id = pli.product_id
        where pli.tenant_id = $1
          and p.stock_tracking = 'STOCKED'
          and p.deleted_at is null
        order by pli.unit_price_e4 desc
        limit 1`,
      [tenantId],
    )
  ).rows[0];
  if (!priced) throw new Error('tenant A has no WHOLESALE-priced stocked product');

  const probe = await callMutation(saleMgr, 'sales.createSale', saleOp(out01, priced.id, 1n, 'CASH'));
  if (probe.status !== 200) {
    throw new Error(`the pricing probe failed: ${probe.status} ${probe.message}`);
  }
  const unitTotal = BigInt(String(payload(probe)['totalMinor']));
  const BOUND = 500_000n; // the outlet manager's template bound, GH₵5,000
  const qtyBelow = BOUND / unitTotal; // largest cart at or under the bound
  const qtyAbove = qtyBelow + 1n;
  if (qtyBelow < 1n) throw new Error(`one unit (${unitTotal}) already exceeds the bound`);
  console.log(
    `  [setup] ${priced.sku_code} prices at ${unitTotal} minor/unit — ` +
      `${qtyBelow} under the ${BOUND} bound, ${qtyAbove} over it`,
  );

  // -- 8a/8b. counter staff: bounded at "0", so ANY credit sale is refused --
  const counterCredit = saleOp(out01, priced.id, qtyBelow, 'CREDIT', { customerId });
  const counterCreditOutcome = await callMutation(counter, 'sales.createSale', counterCredit);
  expectForbidden(
    '8a. counter staff CANNOT ring a credit sale — bounded at "0", so any amount exceeds it',
    counterCreditOutcome,
    'PERMISSION_BOUND_EXCEEDED: sale.record.credit',
  );
  expectAllowed(
    '8b. …and CAN ring the identical cart for CASH — the refusal is the bound, not the cart',
    await callMutation(counter, 'sales.createSale', saleOp(out01, priced.id, qtyBelow, 'CASH')),
    'the positive control succeeded — the clerk sells, they just cannot lend',
  );

  // -- 8c/8d. the outlet manager: allowed under "500000", refused over it ---
  const belowOutcome = await callMutation(
    saleMgr,
    'sales.createSale',
    saleOp(out01, priced.id, qtyBelow, 'CREDIT', { customerId }),
  );
  const belowTotal = belowOutcome.status === 200 ? BigInt(String(payload(belowOutcome)['totalMinor'])) : -1n;
  check(
    '8c. outlet manager CAN ring a credit sale UNDER their "500000" bound',
    belowOutcome.status === 200 && belowTotal > 0n && belowTotal <= BOUND,
    belowOutcome.status === 200
      ? `applied, server-priced total ${belowTotal} <= ${BOUND}`
      : `HTTP ${belowOutcome.status} ${belowOutcome.errorCode ?? '-'} "${belowOutcome.message.slice(0, 120)}"`,
  );

  const aboveOp = saleOp(out01, priced.id, qtyAbove, 'CREDIT', { customerId });
  const aboveOutcome = await callMutation(saleMgr, 'sales.createSale', aboveOp);
  expectForbidden(
    '8d. …and CANNOT ring one OVER it — same role, same customer, same counter',
    aboveOutcome,
    'PERMISSION_BOUND_EXCEEDED: sale.record.credit',
  );
  const refusedAmount = boundActAmount(aboveOutcome.message);
  check(
    '8e. the refusal names the SERVER-repriced total, and it really is over the bound',
    refusedAmount !== null && refusedAmount > BOUND,
    `refused act = ${refusedAmount ?? 'unparseable'} > ${BOUND} (the message the server sent back)`,
  );

  // -- 8f. the till cannot talk its way under the bound --------------------
  //
  // `clientTotalMinor` is the stale-price-list signal: accepted, compared,
  // never authoritative. A device that could set the number the bound is
  // measured against would have no bound at all, so the same over-bound cart
  // is sent again claiming to be worth one pesewa.
  const liarOutcome = await callMutation(
    saleMgr,
    'sales.createSale',
    saleOp(out01, priced.id, qtyAbove, 'CREDIT', { customerId, clientTotalMinor: '1' }),
  );
  const liarAmount = boundActAmount(liarOutcome.message);
  check(
    '8f. a till claiming clientTotalMinor:"1" is still refused — the bound reads the SERVER total',
    liarOutcome.status === 403 &&
      liarOutcome.message.startsWith('PERMISSION_BOUND_EXCEEDED: sale.record.credit') &&
      liarAmount !== null &&
      liarAmount > BOUND,
    `HTTP ${liarOutcome.status}, measured against ${liarAmount ?? 'unparseable'}, not the claimed 1`,
  );

  // -- 8g. a refused credit sale leaves NOTHING behind ----------------------
  const entriesBefore = await creditEntryCount(tenantId);
  const [counterLanded, aboveLanded] = await Promise.all([
    saleExists(tenantId, String(counterCredit['receiptNo'])),
    saleExists(tenantId, String(aboveOp['receiptNo'])),
  ]);
  check(
    '8g. neither refused credit sale wrote a row — the whole transaction rolled back',
    !counterLanded && !aboveLanded,
    `app.sale rows for the two refused receipt numbers: ` +
      `counter=${counterLanded ? 'PRESENT' : 'absent'}, over-bound=${aboveLanded ? 'PRESENT' : 'absent'}; ` +
      `credit entries now ${entriesBefore}`,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // 9. CROSS-LOCATION REPORTING — a QUERY, over GET, guarded the same way.
  // ═══════════════════════════════════════════════════════════════════════
  const range = { from: '2026-08-01', to: '2026-08-31' };

  expectForbidden(
    '9a. counter staff CANNOT read the sales report (report.view.location absent from the role)',
    await callQuery(counter, 'reports.salesByLocation', range),
    'PERMISSION_DENIED: report.view.location',
  );
  const mgrReport = await callQuery(saleMgr, 'reports.salesByLocation', range);
  const mgrScope = (payload(mgrReport)['scope'] ?? {}) as { network?: boolean; locationCount?: number };
  check(
    '9b. the outlet manager CAN — and is told the total is NOT the network\'s',
    mgrReport.status === 200 && mgrScope.network === false,
    mgrReport.status === 200
      ? `200, network=${String(mgrScope.network)} over ${mgrScope.locationCount} location(s) — ` +
        'a true total of what this caller may see, labelled as such'
      : `HTTP ${mgrReport.status} "${mgrReport.message.slice(0, 120)}"`,
  );
  const acctReport = await callQuery(accounts, 'reports.salesByLocation', range);
  const acctScope = (payload(acctReport)['scope'] ?? {}) as { network?: boolean; locationCount?: number };
  check(
    '9c. Accounts, holding report.view.tenant at the root, gets the NETWORK total',
    acctReport.status === 200 && acctScope.network === true,
    acctReport.status === 200
      ? `200, network=${String(acctScope.network)} over ${acctScope.locationCount} location(s) — ` +
        'the widener is held, so "total" means the tenant'
      : `HTTP ${acctReport.status} "${acctReport.message.slice(0, 120)}"`,
  );
  expectForbidden(
    '9d. the outlet manager CANNOT see cost/margin — report.view.margin is a narrower audience',
    await callQuery(saleMgr, 'reports.inventoryDays', range),
    'PERMISSION_DENIED: report.view.margin',
  );
  expectAllowed(
    '9e. …and Accounts CAN — the positive control on the same route, same payload',
    await callQuery(accounts, 'reports.inventoryDays', range),
    'the margin route answers for the role that holds report.view.margin',
  );

  // ═══════════════════════════════════════════════════════════════════════
  // 10. THE LOW-STOCK ALERT — guarded by stock.view, so the person who has
  //     to tell a customer "we're out" is the person who can see it coming.
  // ═══════════════════════════════════════════════════════════════════════
  const alertProduct = (
    await client.query<{ id: string; sku_code: string }>(
      `select id, sku_code from app.product
        where tenant_id = $1 and stock_tracking = 'STOCKED' and deleted_at is null
          and id <> $2
        order by sku_code limit 1`,
      [tenantId, priced.id],
    )
  ).rows[0];
  if (!alertProduct) throw new Error('tenant A has no second stocked product');

  const received = await callMutation(
    saleMgr,
    'inventory.recordMovement',
    receiptOp(out01, alertProduct.id, '10'),
  );
  if (received.status !== 200) {
    throw new Error(`could not stock the alert product: ${received.status} ${received.message}`);
  }

  // The threshold is derived from the on-hand this location ACTUALLY holds,
  // read back from the ledger after the receipt landed. A hard-coded number
  // made the drill order-dependent: run after the sync drills, which stock
  // hundreds of units of the same SKU at this outlet, and a threshold of 100
  // is comfortably below on-hand, so nothing is low and the check fails for a
  // reason that has nothing to do with authorisation.
  const onHand = (
    await client.query<{ qty: string }>(
      `select coalesce(qty_on_hand, 0)::text as qty from app.stock_on_hand
        where tenant_id = $1 and location_id = $2 and product_id = $3`,
      [tenantId, out01, alertProduct.id],
    )
  ).rows[0]?.qty ?? '0';
  const threshold = (BigInt(onHand) + 100n).toString(10);

  expectForbidden(
    '10a. counter staff CANNOT set a reorder point (stock.reorder.manage absent from the role)',
    await callMutation(counter, 'inventory.setReorderPoint', reorderOp(out01, alertProduct.id, threshold)),
    'PERMISSION_DENIED: stock.reorder.manage',
  );
  expectAllowed(
    '10b. …and the outlet manager CAN — they live with the stock-out, they tune the alert',
    await callMutation(saleMgr, 'inventory.setReorderPoint', reorderOp(out01, alertProduct.id, threshold)),
    `threshold ${threshold} set against a measured on-hand of ${onHand} — ${alertProduct.sku_code} is now low`,
  );

  const counterAlerts = await callQuery(counter, 'inventory.lowStock', { locationIds: [out01] });
  const alertCount = Number(payload(counterAlerts)['alertCount'] ?? -1);
  check(
    '10c. counter staff CAN read the low-stock alert at their own outlet, and it is non-empty',
    counterAlerts.status === 200 && alertCount >= 1,
    counterAlerts.status === 200
      ? `200, ${alertCount} alert(s) — a vacuously empty list would prove nothing, so this asserts >= 1`
      : `HTTP ${counterAlerts.status} "${counterAlerts.message.slice(0, 120)}"`,
  );
  expectForbidden(
    '10d. Accounts CANNOT — stock.view is absent from the role, at any scope including the root',
    await callQuery(accounts, 'inventory.lowStock', {}),
    'PERMISSION_DENIED: stock.view',
  );
  expectForbidden(
    '10e. …and the manager cannot narrow the alert to an outlet outside their scope',
    await callQuery(saleMgr, 'inventory.lowStock', { locationIds: [out04] }),
    'PERMISSION_OUT_OF_SCOPE: stock.view',
  );

  await client.end();

  const failed = checks.filter((c) => !c.pass);
  const summary = {
    drill: 'D8-rbac-live',
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
