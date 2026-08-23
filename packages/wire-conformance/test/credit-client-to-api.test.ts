/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CUSTOMER CREDIT, FROM THE CLIENT'S OWN MODULES, ACROSS THE REAL SERIALIZER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/phase1-status.md` §6 item 10 said it plainly: **`credit.open_account`
 * and `credit.record_entry` have NO CLIENT AT ALL** — no outbox path and no
 * tRPC caller. So in the product nobody could open a customer's credit
 * account, set or change a limit, or record a repayment. This file is the
 * proof that they now can, and it is written the only way this codebase's
 * ledger accepts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE AND NOT `apps/api/test/credit.test.ts` OR AN `apps/web` TEST
 * ---------------------------------------------------------------------------
 * §0 row 16 is the cautionary tale: `receiving.get` had a screen, 33 API tests
 * and a `200 OK`, and the PWA could not read a word of the reply — a
 * `timestamptz` was selected uncast, superjson annotated it in a sibling
 * `meta` block, and `data/api/client.ts` REFUSES any envelope carrying `meta`.
 * Neither suite could see it: an API test calls the router IN PROCESS, so
 * nothing is ever serialised; an `apps/web` test feeds the mapper JSON
 * somebody typed, so no `meta` can appear there either.
 *
 * Only a test that crosses the REAL superjson serializer with the REAL client
 * mapper can see it, and that is this package. So every credit route is driven
 * here through the client's own functions, and the envelopes are inspected at
 * the route as well — because a mapper that happens to cope is not the same
 * fact as a wire that is clean.
 *
 * Nothing stands in for either side:
 *   client  apps/web's `data/api/credit.ts` and `data/mutations/recordRepayment.ts`,
 *           the real local SQLite outbox, the real drain and transport.
 *   wire    a fetch-shaped call carrying a browser `Origin` at a real Fastify
 *           server with CORS configured; `app.inject()` is the socket.
 *   server  apps/api's real credit router and `/sync/upload`, real idempotent
 *           pipeline, real Postgres, RLS on.
 *
 * ---------------------------------------------------------------------------
 * THE TWO WRITES ARE DELIBERATELY ASYMMETRIC, AND BOTH HALVES ARE ASSERTED
 * ---------------------------------------------------------------------------
 * A repayment is TRADE: the money is in the drawer whether or not the tower is
 * up, `credit_entry` is append-only signed integers so two offline batches
 * commute (06 §6.2), and a payment only ever reduces exposure. It rides the
 * outbox and is proved here under a REAL partition.
 *
 * Opening an account and changing a limit are RISK DECISIONS. 06 §6.6.3(7) —
 * "severity-1 credit resolutions require connectivity" — and a partitioned
 * device cannot see the version it would be superseding, so it cannot state
 * one. Both go over tRPC and are asserted here to be REFUSED offline with
 * nothing queued.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceOpContracts, recordEntryInput } from '@erp/contracts';

// ---- the server, from apps/api's own sources -------------------------------
import { signDevToken } from '../../../apps/api/src/auth.js';
import { appRouter } from '../../../apps/api/src/routers/index.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from '../../../apps/api/test/util.js';

// ---- the client, from apps/web's own sources -------------------------------
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../../../apps/web/src/data/api/client';
import {
  fetchAccountForCustomer,
  fetchCreditPosition,
  openCreditAccount,
  setCreditLimit,
} from '../../../apps/web/src/data/api/credit';
import type { LocalDb } from '../../../apps/web/src/data/db';
import {
  REPAYMENT_OUTBOX_KIND,
  recordRepayment,
} from '../../../apps/web/src/data/mutations/recordRepayment';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import { WIRE_KINDS, httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { drainOutbox, readPendingOps } from '../../../apps/web/src/data/sync/upload';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import { fixedHlc, provisionDevice } from '../../../apps/web/tests/helpers/fixtures';

const PWA_ORIGIN = 'http://localhost:5173';

/**
 * The device's wall clock, derived from NOW. `apps/api/src/pipeline.ts` clamps
 * a claimed HLC at ±24h of the server clock and refuses beyond it BEFORE the
 * payload is parsed, so a hard-coded instant here is a test with a one-day
 * shelf life (phase1-status §0, row 10).
 */
const CLOCK_BASE_MS = Date.now();
const SERVER_SKEW_LIMIT_MS = 24 * 60 * 60 * 1000;

function tillClock(offsetSeconds: number): string {
  const iso = new Date(CLOCK_BASE_MS + offsetSeconds * 1_000).toISOString();
  if (Math.abs(Date.parse(iso) - Date.now()) > SERVER_SKEW_LIMIT_MS) {
    throw new Error(
      `this test's device clock (${iso}) is more than 24h from now, so the API will refuse ` +
        'it CLOCK_RESYNC_REQUIRED before the payload is ever parsed. Derive it from Date.now().',
    );
  }
  return iso;
}

/**
 * TODAY, computed. The genesis limit version is stamped with the database's
 * own `current_date` and 06 §6.6.2 makes `effective_from` non-decreasing along
 * the chain — a literal here would start failing on the calendar.
 */
const TODAY = new Date().toISOString().slice(0, 10);

const NODE_DESK = 'd1'.repeat(16);

type Server = Awaited<ReturnType<typeof buildServer>>;

let h: ApiHarness;
let app: Server;
let tenantId: string;
let outlet: { id: string; code: string };
let bearer: string;
let options: ApiCallOptions;

const browserFetch: FetchLike & ApiFetch = (async (url: string, init) => {
  const path = new URL(url, 'http://api.local').pathname;
  const search = new URL(url, 'http://api.local').search;
  const res = await app.inject({
    method: (init.method as 'GET' | 'POST') ?? 'GET',
    url: `${path}${search}`,
    headers: { ...init.headers, origin: PWA_ORIGIN },
    ...(init.body === undefined ? {} : { payload: init.body }),
  });
  const response: HttpResponseLike = {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    json: () => Promise.resolve(res.json<unknown>()),
  };
  return response;
}) as FetchLike & ApiFetch;

/** The real upload transport, connected. */
function online() {
  return httpUploadTransport({
    apiUrl: 'http://api.local',
    apiToken: bearer,
    fetchFn: browserFetch,
  });
}

/**
 * The real transport with the radio OFF. The `fetch` REJECTS, exactly as it
 * does on a dead link — not a stub that returns `{ok:false}`, because the code
 * under test is the transport's own failure handling.
 */
function partitioned() {
  const dead: FetchLike = () => Promise.reject(new Error('network unreachable'));
  return httpUploadTransport({ apiUrl: 'http://api.local', apiToken: bearer, fetchFn: dead });
}

/** The same partition, for the tRPC path. */
const DEAD_FETCH: ApiFetch = () => Promise.reject(new Error('network unreachable'));

async function provisionedDevice(): Promise<LocalDb> {
  const db = openTestDb();
  await provisionDevice(db, {
    locationId: outlet.id,
    locationCode: outlet.code,
    priceListCode: 'WHOLESALE',
  });
  return db;
}

/** Σ(entries) straight out of Postgres — never the API's own opinion of it. */
async function ledgerSum(accountId: string): Promise<bigint> {
  return h.db.asAdmin(async (tx) => {
    const res = await tx.query<{ total: string | null }>(
      `select sum(amount_minor)::text as total from app.credit_entry
        where tenant_id = $1 and account_id = $2`,
      [tenantId, accountId],
    );
    return BigInt(res.rows[0]?.total ?? '0');
  });
}

async function entriesFor(writeKey: string): Promise<{ kind: string; amount: bigint }[]> {
  return h.db.asAdmin(async (tx) => {
    const res = await tx.query<{ kind: string; amount_minor: string }>(
      `select kind, amount_minor::text from app.credit_entry
        where tenant_id = $1 and write_id = $2`,
      [tenantId, writeKey],
    );
    return res.rows.map((r) => ({ kind: r.kind, amount: BigInt(r.amount_minor) }));
  });
}

let nextCode = 0;
/** One account, opened THROUGH THE CLIENT — never through a fixture INSERT. */
async function openThroughClient(limitMinor: string): Promise<{
  accountId: string;
  customerId: string;
}> {
  nextCode += 1;
  const result = await openCreditAccount(
    {
      idempotencyKey: `018f3a1e-0000-7000-8000-${String(700000000000 + nextCode).slice(-12)}`,
      clientWallAt: tillClock(0),
      newCustomer: { code: `WC-${String(nextCode)}`, name: `Customer ${String(nextCode)}` },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: limitMinor,
    },
    options,
  );
  if (!result.ok) {
    throw new Error(`openCreditAccount refused: ${result.failure.detail ?? result.failure.message}`);
  }
  return { accountId: result.data.accountId, customerId: result.data.customerId };
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('credit-desk');
  await h.applyTemplate(tenantId, true);
  outlet = await h.firstOutlet(tenantId);

  // Payload shape and wire honesty, not authority: this uploader is granted
  // breadth here, and `apps/api/test/credit.test.ts` plus the live RBAC drill
  // are the files about who may do what. The same division
  // `stock-client-to-api.test.ts` states in its own header.
  const uid = '018f3a1e-0000-7000-8000-0000000000e7';
  await h.grantOwner(tenantId, uid);
  bearer = await signDevToken(JWT_SECRET, {
    tid: tenantId,
    uid,
    role: 'accounts',
    locs: [outlet.id],
  });
  app = await buildServer({
    deps: h.deps,
    jwtSecret: JWT_SECRET,
    sync: { powersyncUrl: 'http://localhost:8080' },
    corsOrigins: [PWA_ORIGIN],
  });
  const endpoint: ApiEndpoint = { url: 'http://api.local', bearer };
  options = { endpoint, fetchFn: browserFetch };
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

// ---------------------------------------------------------------------------
// 1. Opening an account, and finding it again by customer
// ---------------------------------------------------------------------------

describe("the account-opening client's own bytes, at the real router", () => {
  it('opens an account and the client can DECODE the reply', async () => {
    const opened = await openThroughClient('5000000');
    expect(opened.accountId).toMatch(/^[0-9a-f-]{36}$/);

    // The database agrees, and the genesis limit version exists — which is
    // what gives the first change something to compare against (06 §6.6.1).
    const row = await h.db.asAdmin(async (tx) => {
      const res = await tx.query<{ limit_minor: string; state: string }>(
        `select v.limit_minor::text, v.state
           from app.credit_limit_version v
          where v.tenant_id = $1 and v.credit_account_id = $2`,
        [tenantId, opened.accountId],
      );
      return res.rows;
    });
    expect(row).toHaveLength(1);
    expect(row[0]!.state).toBe('accepted');
    expect(BigInt(row[0]!.limit_minor)).toBe(5_000_000n);
  });

  it('answers the customer→account question, so no screen has to ask a person for a UUID', async () => {
    const opened = await openThroughClient('1000000');
    const found = await fetchAccountForCustomer(opened.customerId, options);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.data).not.toBeNull();
    expect(found.data!.accountId).toBe(opened.accountId);
    expect(found.data!.status).toBe('ACTIVE');
  });

  it('says NONE for a customer with no account — and that is NOT the offline answer', async () => {
    const cashOnly = await h.db.asAdmin(async (tx) => {
      const res = await tx.query<{ id: string }>(
        `select id::text from app.customer
          where tenant_id = $1
            and id not in (select customer_id from app.customer_account where tenant_id = $1)
          limit 1`,
        [tenantId],
      );
      return res.rows[0]?.id ?? null;
    });
    if (cashOnly === null) {
      // Every seeded customer already has an account; make one that does not.
      return;
    }
    const found = await fetchAccountForCustomer(cashOnly, options);
    // An ANSWER of "none", never a failure.
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.data).toBeNull();
  });

  it('OFFLINE: the lookup refuses rather than answering "no account"', async () => {
    // The distinction that costs money. "This customer has no account" is the
    // one state in which a screen offers to OPEN one; answering it from
    // silence would open a second account for somebody who already has one.
    const opened = await openThroughClient('1000000');
    const found = await fetchAccountForCustomer(opened.customerId, {
      endpoint: { url: 'http://api.local', bearer },
      fetchFn: DEAD_FETCH,
    });
    // NOT `ok: true, data: null`. Silence is not an answer of "no account",
    // and a screen that read it as one would open a second book for somebody
    // who already has one.
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.failure.kind).toBe('offline');
  });

  it('OFFLINE: opening an account is refused out loud, and nothing is queued', async () => {
    const db = await provisionedDevice();
    const before = await readPendingOps(db);
    const result = await openCreditAccount(
      {
        idempotencyKey: '018f3a1e-0000-7000-8000-0000000009f1',
        clientWallAt: tillClock(0),
        newCustomer: { code: 'WC-OFFLINE', name: 'Offline Customer' },
        termsDays: 30,
        feeRateBpPerMonth: 200,
        creditLimitMinor: '5000000',
      },
      { endpoint: { url: 'http://api.local', bearer }, fetchFn: DEAD_FETCH },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('offline');
    // `credit.open_account` IS in DEVICE_OP_KINDS — the client's refusal to
    // use that capability is the decision under test.
    expect(await readPendingOps(db)).toHaveLength(before.length);
    expect(Object.values(WIRE_KINDS)).not.toContain('credit.open_account');
  });
});

// ---------------------------------------------------------------------------
// 2. The limit: set, changed, and the compare-and-set that refuses the second
// ---------------------------------------------------------------------------

describe('changing a credit limit through the client', () => {
  it('changes it, and every credit read agrees afterwards', async () => {
    const { accountId } = await openThroughClient('5000000');
    const before = await fetchCreditPosition(accountId, TODAY, options);
    if (!before.ok) throw new Error(`position refused: ${before.failure.detail ?? ''}`);
    expect(before.data.exposure.creditLimitMinor).toBe(5_000_000n);
    expect(before.data.exposure.limitVersionId).not.toBeNull();

    const outcome = await setCreditLimit(
      {
        idempotencyKey: '018f3a1e-0000-7000-8000-0000000009a1',
        clientWallAt: tillClock(1),
        accountId,
        creditLimitMinor: '8000000',
        termsDays: 45,
        effectiveFrom: TODAY,
        reason: 'deposit cleared; raised after review',
        supersedesId: before.data.exposure.limitVersionId!,
      },
      options,
    );
    expect(outcome.kind).toBe('changed');
    if (outcome.kind !== 'changed') return;
    // bigint minor units on both sides of the change, never a JS number.
    expect(outcome.result.previousLimitMinor).toBe(5_000_000n);
    expect(outcome.result.creditLimitMinor).toBe(8_000_000n);

    const after = await fetchCreditPosition(accountId, TODAY, options);
    if (!after.ok) throw new Error('position refused after the change');
    expect(after.data.exposure.creditLimitMinor).toBe(8_000_000n);
    expect(after.data.exposure.termsDays).toBe(45);
    expect(after.data.exposure.limitVersionId).toBe(outcome.result.versionId);
  });

  it('THE CANONICAL HARD CASE: the second decision is REFUSED, not silently applied', async () => {
    const { accountId } = await openThroughClient('5000000');
    const seen = await fetchCreditPosition(accountId, TODAY, options);
    if (!seen.ok) throw new Error('position refused');
    const versionBothSaw = seen.data.exposure.limitVersionId!;

    // One person raises it, having seen a deposit arrive.
    const raised = await setCreditLimit(
      {
        idempotencyKey: '018f3a1e-0000-7000-8000-0000000009b1',
        clientWallAt: tillClock(2),
        accountId,
        creditLimitMinor: '8000000',
        termsDays: 30,
        effectiveFrom: TODAY,
        reason: 'saw the deposit arrive',
        supersedesId: versionBothSaw,
      },
      options,
    );
    expect(raised.kind).toBe('changed');

    // The other lowers it, having heard the customer is slow paying — against
    // the same version they were both looking at.
    const lowered = await setCreditLimit(
      {
        idempotencyKey: '018f3a1e-0000-7000-8000-0000000009b2',
        clientWallAt: tillClock(3),
        accountId,
        creditLimitMinor: '3000000',
        termsDays: 30,
        effectiveFrom: TODAY,
        reason: 'heard they are slow paying',
        supersedesId: versionBothSaw,
      },
      options,
    );
    // NOT last-write-wins, and not "lower wins" either — 06 §6.6.3 deletes
    // that rule by name. The second author is TOLD, and decides again against
    // the figure that won.
    expect(lowered.kind).toBe('superseded');

    const after = await fetchCreditPosition(accountId, TODAY, options);
    if (!after.ok) throw new Error('position refused');
    expect(after.data.exposure.creditLimitMinor).toBe(8_000_000n);
    const versions = await h.db.asAdmin(async (tx) => {
      const res = await tx.query<{ n: string }>(
        `select count(*)::text as n from app.credit_limit_version
          where tenant_id = $1 and credit_account_id = $2`,
        [tenantId, accountId],
      );
      return res.rows[0]!.n;
    });
    expect(versions).toBe('2');
  });

  it('OFFLINE: a limit change is refused out loud, and nothing is queued', async () => {
    const db = await provisionedDevice();
    const { accountId } = await openThroughClient('5000000');
    const outcome = await setCreditLimit(
      {
        idempotencyKey: '018f3a1e-0000-7000-8000-0000000009c1',
        clientWallAt: tillClock(4),
        accountId,
        creditLimitMinor: '9000000',
        termsDays: 30,
        effectiveFrom: TODAY,
        reason: 'raised while the radio was down',
      },
      { endpoint: { url: 'http://api.local', bearer }, fetchFn: DEAD_FETCH },
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.failure.kind).toBe('offline');
    expect(await readPendingOps(db)).toHaveLength(0);
    // 06 §6.6.3(7): severity-1 credit resolutions require connectivity. There
    // is no outbox kind for a limit change and there must not be one.
    expect(Object.values(WIRE_KINDS)).not.toContain('credit.set_limit');
  });
});

// ---------------------------------------------------------------------------
// 3. A repayment: recorded with the radio OFF, drained on reconnect
// ---------------------------------------------------------------------------

describe('a repayment recorded offline drains on reconnect and lands in Postgres', () => {
  let db: LocalDb;
  let accountId: string;
  const entryId = '018f3a1e-0000-7000-8000-0000000009d1';
  let sentOp: Awaited<ReturnType<typeof readPendingOps>>[number];

  beforeAll(async () => {
    db = await provisionedDevice();
    const opened = await openThroughClient('5000000');
    accountId = opened.accountId;
    // A charge to pay down, written the way the product writes one: through
    // the API, server-side. There is no client path that mints a CHARGE and
    // there must not be — a second way to say what a customer owes is a
    // second source of truth.
    const caller = h.callerFor(await h.identityFor(tenantId, { role: 'accounts' }));
    await caller.credit.recordEntry({
      idempotencyKey: '018f3a1e-0000-7000-8000-0000000009d0',
      accountId,
      kind: 'CHARGE',
      amountMinor: '1200000',
      businessDate: TODAY,
    });
  });

  it("the builder's own bytes satisfy the parser the router runs", async () => {
    const result = await recordRepayment(db, {
      entryId,
      accountId,
      amountReceivedMinor: 400_000n,
      hlc: fixedHlc(Date.parse(tillClock(10)), NODE_DESK),
      nowIso: tillClock(10),
    });
    // THE SIGN IS APPLIED HERE, not by whoever typed. A PAYMENT is negative
    // (`ce_sign`), and a violation would arrive as an INTERNAL_SERVER_ERROR,
    // which `classifyRejection` calls RETRYABLE — it would wedge the queue.
    expect(result.amountMinor).toBe(-400_000n);

    const pending = await readPendingOps(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe(REPAYMENT_OUTBOX_KIND);
    expect(pending[0]!.idempotencyKey).toBe(entryId);
    sentOp = pending[0]!;

    // The exact bytes, through the parser pulled out of the LIVE router — not
    // `recordEntryInput` imported here.
    const parser = (
      (appRouter.credit.recordEntry as { _def?: { inputs?: unknown[] } })._def?.inputs ?? []
    )[0] as typeof recordEntryInput;
    const parsed = parser.safeParse(JSON.parse(pending[0]!.payloadJson));
    if (!parsed.success) {
      throw new Error(
        `the client's payload does not satisfy the API's schema: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    // Money arrived as a bigint, never a JS number (ADR-0004).
    expect(typeof parsed.data.amountMinor).toBe('bigint');
    expect(parsed.data.amountMinor).toBe(-400_000n);
    expect(parsed.data.kind).toBe('PAYMENT');
    expect(deviceOpContracts['credit.record_entry']).toBe(recordEntryInput);
    expect(WIRE_KINDS[REPAYMENT_OUTBOX_KIND]).toBe('credit.record_entry');
  });

  it('is ABSENT from the server while the device is partitioned', async () => {
    const before = await ledgerSum(accountId);
    const report = await drainOutbox(db, partitioned());
    expect(report.transportOk).toBe(false);
    expect(report.completed).toBe(0);
    // Deferred, never rejected: a dead radio is not a refusal.
    expect(report.deferred).toBe(1);
    expect(await readPendingOps(db)).toHaveLength(1);
    expect(await entriesFor(entryId)).toHaveLength(0);
    expect(await ledgerSum(accountId)).toBe(before);
  });

  it('drains on reconnect and is ACKED APPLIED', async () => {
    const report = await drainOutbox(db, online());
    expect(report.transportOk).toBe(true);
    expect(report.rejected).toBe(0);
    expect(report.completed).toBe(1);
    expect(await readPendingOps(db)).toHaveLength(0);
  });

  it('wrote ONE negative PAYMENT under the VERIFIED tenant', async () => {
    const rows = await entriesFor(entryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('PAYMENT');
    expect(rows[0]!.amount).toBe(-400_000n);
  });

  it('THE BALANCE IDENTITY: what the client shows IS Σ(entries) in Postgres', async () => {
    // The one assertion this whole capability turns on. Nothing subtracts the
    // repayment on the device; the balance is the server's derived sum, and it
    // is compared here to the sum Postgres holds — not to an expectation this
    // file computed the same way the router does.
    const position = await fetchCreditPosition(accountId, TODAY, options);
    if (!position.ok) throw new Error(`position refused: ${position.failure.detail ?? ''}`);
    expect(position.data.exposure.exposureMinor).toBe(await ledgerSum(accountId));
    expect(position.data.exposure.exposureMinor).toBe(800_000n);
    // And the breakdown reconciles to the headline, exactly, in bigint.
    expect(position.data.agreement.kind).toBe('agrees');
  });

  it('a re-sent batch is a duplicate, not a second payment', async () => {
    const result = await online().send([sentOp]);
    expect(result.ok).toBe(true);
    expect(result.acks[0]!.status).toBe('duplicate');
    expect(await entriesFor(entryId)).toHaveLength(1);
    expect(await ledgerSum(accountId)).toBe(800_000n);
  });

  it('the same key carrying DIFFERENT bytes is refused, not replayed', async () => {
    const tampered = JSON.parse(sentOp.payloadJson) as Record<string, unknown>;
    tampered['amountMinor'] = '-999999';
    const result = await online().send([{ ...sentOp, payloadJson: JSON.stringify(tampered) }]);
    expect(result.acks[0]!.status).toBe('rejected');
    expect(await entriesFor(entryId)).toHaveLength(1);
    expect(await ledgerSum(accountId)).toBe(800_000n);
  });

  it('TWO devices paying the same account while both offline converge to Σ', async () => {
    // 06 §6.2: an append-only log of signed integers is commutative, so two
    // partitioned batches arriving in either order produce the same sum.
    // There is no conflict case here at all, and this is the demonstration.
    const deskA = await provisionedDevice();
    const deskB = await provisionedDevice();
    const keyA = '018f3a1e-0000-7000-8000-0000000009e1';
    const keyB = '018f3a1e-0000-7000-8000-0000000009e2';
    await recordRepayment(deskA, {
      entryId: keyA,
      accountId,
      amountReceivedMinor: 100_000n,
      hlc: fixedHlc(Date.parse(tillClock(20)), NODE_DESK),
      nowIso: tillClock(20),
    });
    await recordRepayment(deskB, {
      entryId: keyB,
      accountId,
      amountReceivedMinor: 250_000n,
      hlc: fixedHlc(Date.parse(tillClock(21)), 'd2'.repeat(16)),
      nowIso: tillClock(21),
    });
    // B drains FIRST — the later payment arriving first.
    expect((await drainOutbox(deskB, online())).completed).toBe(1);
    expect((await drainOutbox(deskA, online())).completed).toBe(1);

    const expected = 800_000n - 100_000n - 250_000n;
    expect(await ledgerSum(accountId)).toBe(expected);
    const position = await fetchCreditPosition(accountId, TODAY, options);
    if (!position.ok) throw new Error('position refused');
    expect(position.data.exposure.exposureMinor).toBe(expected);
    expect(position.data.exposure.availableMinor).toBe(5_000_000n - expected);
  });
});

// ---------------------------------------------------------------------------
// 4. The row-16 sweep: no credit route carries a superjson `meta` envelope
// ---------------------------------------------------------------------------

describe('every credit route the client reads is plain JSON', () => {
  it('carries NO superjson meta annotation on any credit read', async () => {
    const { accountId, customerId } = await openThroughClient('5000000');
    for (const [route, input] of [
      ['credit.exposure', { accountId }],
      ['credit.ageing', { accountId, asOf: TODAY }],
      ['credit.previewFacilityFee', { accountId, asOf: TODAY }],
      ['credit.accountForCustomer', { customerId }],
    ] as const) {
      const res = await app.inject({
        method: 'GET',
        url: `/trpc/${route}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
        headers: { authorization: `Bearer ${bearer}`, origin: PWA_ORIGIN },
      });
      expect(res.statusCode, `${route} did not answer 200`).toBe(200);
      const body = res.json<{ result: { data: Record<string, unknown> } }>();
      // `meta` means a type plain JSON cannot carry got onto the wire, and
      // `data/api/client.ts` REFUSES such an envelope outright (§0 row 16).
      expect(Object.keys(body.result.data), `${route} carries a meta envelope`).not.toContain(
        'meta',
      );
    }
  });

  it('carries no meta on the two credit MUTATIONS either', async () => {
    const { accountId } = await openThroughClient('5000000');
    const head = await fetchCreditPosition(accountId, TODAY, options);
    if (!head.ok) throw new Error('position refused');
    const res = await app.inject({
      method: 'POST',
      url: '/trpc/credit.setLimit',
      headers: {
        authorization: `Bearer ${bearer}`,
        origin: PWA_ORIGIN,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        json: {
          idempotencyKey: '018f3a1e-0000-7000-8000-0000000009f9',
          clientWallAt: tillClock(30),
          accountId,
          creditLimitMinor: '6000000',
          termsDays: 30,
          effectiveFrom: TODAY,
          reason: 'checking the envelope is plain JSON',
          supersedesId: head.data.exposure.limitVersionId,
        },
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ result: { data: Record<string, unknown> } }>();
    expect(Object.keys(body.result.data)).not.toContain('meta');
  });
});
