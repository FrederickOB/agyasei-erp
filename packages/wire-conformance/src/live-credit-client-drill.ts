/**
 * D14 — CREDIT ACCOUNT MANAGEMENT, THROUGH THE PWA'S OWN MODULES, OVER A REAL
 * SOCKET.
 *
 *   pnpm stack:up && pnpm stack:bootstrap
 *   pnpm dev:api                    # :3001, on THIS code
 *   pnpm --filter @erp/wire-conformance drill:credit-client
 *
 * `test/credit-client-to-api.test.ts` proves the same journey in one process
 * on PGlite, on every `pnpm test`, with no docker. This proves it where the
 * ledger in `docs/phase1-status.md` §0 says the failures actually live: a real
 * HTTP request carrying a browser `Origin`, at the API dev server, landing in
 * the docker Postgres — so CORS preflight, a dev server on stale code, and a
 * migration that never ran are all in scope.
 *
 * Everything below drives `apps/web/src/data/api/credit.ts` and
 * `apps/web/src/data/mutations/recordRepayment.ts` — the PWA's own functions,
 * not a hand-written payload — and compares every figure to Postgres.
 *
 * Prints `__DRILL_RESULT__ {json}` and exits non-zero if any check fails.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import type { ApiCallOptions, ApiFetch } from '../../../apps/web/src/data/api/client';
import {
  fetchAccountForCustomer,
  fetchCreditPosition,
  openCreditAccount,
  setCreditLimit,
} from '../../../apps/web/src/data/api/credit';
import { recordRepayment } from '../../../apps/web/src/data/mutations/recordRepayment';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import { httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { drainOutbox, readPendingOps } from '../../../apps/web/src/data/sync/upload';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import { fixedHlc, provisionDevice } from '../../../apps/web/tests/helpers/fixtures';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API_URL = process.env['API_URL'] ?? 'http://localhost:3001';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://erp:erp_dev@localhost:5433/erp';
const PWA_ORIGIN = process.env['PWA_ORIGIN'] ?? 'http://localhost:5173';
const TODAY = new Date().toISOString().slice(0, 10);

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

/** A real cross-origin fetch, exactly as a browser makes one. */
const browserFetch: ApiFetch & FetchLike = (async (url: string, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: { ...init.headers, origin: PWA_ORIGIN },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const response: HttpResponseLike = {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
  };
  return response;
}) as ApiFetch & FetchLike;

async function main(): Promise<void> {
  const accountsToken = devToken('accounts');
  const managerToken = devToken('outlet_manager');
  const claims = claimsOf(accountsToken);
  const locationId = claims.locs[0];
  if (locationId === undefined) throw new Error('the accounts dev token carries no locations');

  const options: ApiCallOptions = {
    endpoint: { url: API_URL, bearer: accountsToken },
    fetchFn: browserFetch,
  };
  const managerOptions: ApiCallOptions = {
    endpoint: { url: API_URL, bearer: managerToken },
    fetchFn: browserFetch,
  };

  const sql = new pg.Client({ connectionString: DATABASE_URL });
  await sql.connect();

  const stamp = Date.now().toString(36);
  const key = (n: number): string =>
    `018f3a1e-0000-7000-8000-${(Date.now() % 1e9).toString().padStart(9, '0')}${String(n).padStart(3, '0')}`;

  console.log('\nD14 · credit account management, client modules over real HTTP\n');

  // -- 1. Open an account through the client -------------------------------
  const opened = await openCreditAccount(
    {
      idempotencyKey: key(1),
      clientWallAt: new Date().toISOString(),
      newCustomer: { code: `DRILL-${stamp}`, name: `Drill customer ${stamp}` },
      termsDays: 30,
      feeRateBpPerMonth: 250,
      creditLimitMinor: '5000000',
    },
    options,
  );
  check(
    '1a openCreditAccount decodes over real HTTP',
    opened.ok,
    opened.ok ? `account ${opened.data.accountId}` : `refused: ${opened.failure.detail ?? ''}`,
  );
  if (!opened.ok) throw new Error('cannot continue without an account');
  const accountId = opened.data.accountId;
  const customerId = opened.data.customerId;

  const genesis = await sql.query<{ n: string; state: string; limit_minor: string }>(
    `select count(*)::text as n, min(state) as state, min(limit_minor)::text as limit_minor
       from app.credit_limit_version where credit_account_id = $1`,
    [accountId],
  );
  check(
    '1b the genesis limit version is in Postgres, accepted',
    genesis.rows[0]!.n === '1' && genesis.rows[0]!.state === 'accepted',
    `${genesis.rows[0]!.n} version(s), state=${genesis.rows[0]!.state}, limit=${genesis.rows[0]!.limit_minor}`,
  );

  // -- 2. Find it by customer ----------------------------------------------
  const found = await fetchAccountForCustomer(customerId, options);
  check(
    '2a accountForCustomer answers with the account, no UUID typed by anyone',
    found.ok && found.data?.accountId === accountId,
    found.ok ? `→ ${String(found.data?.accountId)}` : `refused: ${found.failure.detail ?? ''}`,
  );

  const offline = await fetchAccountForCustomer(customerId, {
    endpoint: { url: API_URL, bearer: accountsToken },
    fetchFn: () => Promise.reject(new Error('network unreachable')),
  });
  check(
    '2b OFFLINE it refuses — never "this customer has no account"',
    !offline.ok && offline.failure.kind === 'offline',
    offline.ok ? `WRONG: answered data=${String(offline.data)}` : offline.failure.kind,
  );

  // -- 3. The position, and the version the limit form decides against ------
  const before = await fetchCreditPosition(accountId, TODAY, options);
  check(
    '3a fetchCreditPosition decodes: exposure, ageing and the fee working',
    before.ok,
    before.ok
      ? `balance=${before.data.exposure.exposureMinor.toString()} limit=${before.data.exposure.creditLimitMinor.toString()} version=${String(before.data.exposure.limitVersionId)}`
      : `refused: ${before.failure.detail ?? ''}`,
  );
  if (!before.ok) throw new Error('cannot continue without a position');

  // -- 4. Change the limit, and the compare-and-set -------------------------
  const changed = await setCreditLimit(
    {
      idempotencyKey: key(2),
      clientWallAt: new Date().toISOString(),
      accountId,
      creditLimitMinor: '8000000',
      termsDays: 45,
      effectiveFrom: TODAY,
      reason: 'drill: deposit cleared',
      ...(before.data.exposure.limitVersionId === null
        ? {}
        : { supersedesId: before.data.exposure.limitVersionId }),
    },
    options,
  );
  check(
    '4a setCreditLimit changes it, and the client decodes the reply',
    changed.kind === 'changed',
    changed.kind === 'changed'
      ? `${changed.result.previousLimitMinor.toString()} → ${changed.result.creditLimitMinor.toString()}`
      : JSON.stringify(changed),
  );

  const projected = await sql.query<{ credit_limit_minor: string; terms_days: number }>(
    `select credit_limit_minor::text, terms_days from app.customer_account where id = $1`,
    [accountId],
  );
  check(
    '4b the PROJECTION on customer_account followed the accepted version',
    projected.rows[0]!.credit_limit_minor === '8000000' && projected.rows[0]!.terms_days === 45,
    `limit=${projected.rows[0]!.credit_limit_minor} terms=${String(projected.rows[0]!.terms_days)}`,
  );

  // The canonical hard case: a second decision against the version they BOTH
  // saw. Refused with the figure that won; nothing overwritten.
  const stale = await setCreditLimit(
    {
      idempotencyKey: key(3),
      clientWallAt: new Date().toISOString(),
      accountId,
      creditLimitMinor: '3000000',
      termsDays: 30,
      effectiveFrom: TODAY,
      reason: 'drill: heard they are slow paying',
      ...(before.data.exposure.limitVersionId === null
        ? {}
        : { supersedesId: before.data.exposure.limitVersionId }),
    },
    options,
  );
  const after = await sql.query<{ credit_limit_minor: string }>(
    `select credit_limit_minor::text from app.customer_account where id = $1`,
    [accountId],
  );
  check(
    '4c THE CANONICAL HARD CASE: the second decision is refused, not applied',
    stale.kind === 'superseded' && after.rows[0]!.credit_limit_minor === '8000000',
    `outcome=${stale.kind} limit still ${after.rows[0]!.credit_limit_minor}`,
  );

  // -- 5. The manager may NOT read and may NOT change ----------------------
  //
  // This block used to open with the manager READING the position, as the
  // positive control on the refusal below. That stopped being the design: the
  // template no longer grants `credit.view` to the outlet-manager role
  // (packages/db/src/seed/roles.ts, "THE RESIDENCY RULE"; credit-offline-plan
  // R1.b), because that code now decides DEVICE RESIDENCY as well as the
  // online read — an outlet tablet must not carry 400 days of the book. So the
  // manager is refused BOTH, and the positive control moves to a route the
  // manager does hold, on the same socket with the same bearer, so "refused"
  // still cannot mean "this principal cannot reach the API at all".
  const managerControl = await fetch(
    `${API_URL}/trpc/inventory.lowStock?input=${encodeURIComponent(JSON.stringify({ json: {} }))}`,
    { headers: { authorization: `Bearer ${managerToken}`, origin: PWA_ORIGIN } },
  );
  check(
    '5·0 the manager principal reaches the API on a capability it DOES hold (positive control)',
    managerControl.ok,
    `inventory.lowStock HTTP ${String(managerControl.status)} with the manager bearer`,
  );
  const managerRead = await fetchCreditPosition(accountId, TODAY, managerOptions);
  const managerWrite = await setCreditLimit(
    {
      idempotencyKey: key(4),
      clientWallAt: new Date().toISOString(),
      accountId,
      creditLimitMinor: '9000000',
      termsDays: 30,
      effectiveFrom: TODAY,
      reason: 'drill: trying it on',
    },
    managerOptions,
  );
  check(
    '5a an outlet manager is REFUSED the credit position — the book is not theirs to hold (R1.b)',
    !managerRead.ok && (managerRead.failure.detail ?? '').includes('credit.view'),
    managerRead.ok ? 'WRONG: allowed' : `refused: ${managerRead.failure.detail ?? ''}`,
  );
  check(
    '5b and is REFUSED the limit change, on the same socket',
    managerWrite.kind === 'refused' && managerWrite.failure.status === 403,
    managerWrite.kind === 'refused'
      ? `${String(managerWrite.failure.status)} ${managerWrite.failure.detail ?? ''}`
      : `WRONG: ${managerWrite.kind}`,
  );

  // -- 6. A charge, then a repayment through the OUTBOX --------------------
  const chargeRes = await fetch(`${API_URL}/trpc/credit.recordEntry`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accountsToken}`,
      'content-type': 'application/json',
      origin: PWA_ORIGIN,
    },
    body: JSON.stringify({
      json: {
        idempotencyKey: key(5),
        accountId,
        kind: 'CHARGE',
        amountMinor: '1200000',
        businessDate: TODAY,
      },
    }),
  });
  check('6a a charge lands (the thing a repayment pays down)', chargeRes.ok, `HTTP ${String(chargeRes.status)}`);

  const db = openTestDb();
  await provisionDevice(db, { locationId, locationCode: 'DRILL', priceListCode: 'WHOLESALE' });
  const entryId = key(6);
  const queued = await recordRepayment(db, {
    entryId,
    accountId,
    amountReceivedMinor: 400_000n,
    hlc: fixedHlc(Date.now(), 'e1'.repeat(16)),
  });
  check(
    '6b the repayment is queued locally, SIGNED, with no socket on the path',
    queued.amountMinor === -400_000n && (await readPendingOps(db)).length === 1,
    `amountMinor=${queued.amountMinor.toString()}`,
  );

  const deadDrain = await drainOutbox(
    db,
    httpUploadTransport({
      apiUrl: API_URL,
      apiToken: accountsToken,
      fetchFn: () => Promise.reject(new Error('network unreachable')),
    }),
  );
  const absent = await sql.query<{ n: string }>(
    `select count(*)::text as n from app.credit_entry where write_id = $1`,
    [entryId],
  );
  check(
    '6c PARTITIONED: deferred, never rejected, and absent from the server',
    !deadDrain.transportOk && deadDrain.deferred === 1 && absent.rows[0]!.n === '0',
    `transportOk=${String(deadDrain.transportOk)} deferred=${String(deadDrain.deferred)} rows=${absent.rows[0]!.n}`,
  );

  const startedAt = Date.now();
  const drained = await drainOutbox(
    db,
    httpUploadTransport({ apiUrl: API_URL, apiToken: accountsToken, fetchFn: browserFetch }),
  );
  const elapsedMs = Date.now() - startedAt;
  check(
    '6d RECONNECT: acked applied',
    drained.completed === 1 && drained.rejected === 0,
    `completed=${String(drained.completed)} in ${String(elapsedMs)}ms`,
  );

  const landed = await sql.query<{ kind: string; amount_minor: string }>(
    `select kind, amount_minor::text from app.credit_entry where write_id = $1`,
    [entryId],
  );
  check(
    '6e one negative PAYMENT in Postgres, the client’s exact bigint',
    landed.rows.length === 1 &&
      landed.rows[0]!.kind === 'PAYMENT' &&
      landed.rows[0]!.amount_minor === '-400000',
    JSON.stringify(landed.rows),
  );

  // -- 7. The balance identity --------------------------------------------
  const ledger = await sql.query<{ total: string | null }>(
    `select sum(amount_minor)::text as total from app.credit_entry where account_id = $1`,
    [accountId],
  );
  const position = await fetchCreditPosition(accountId, TODAY, options);
  const sum = BigInt(ledger.rows[0]?.total ?? '0');
  check(
    '7a THE BALANCE IDENTITY: what the client shows IS Σ(entries) in Postgres',
    position.ok && position.data.exposure.exposureMinor === sum,
    position.ok
      ? `client=${position.data.exposure.exposureMinor.toString()} postgres=${sum.toString()}`
      : `refused: ${position.failure.detail ?? ''}`,
  );
  check(
    '7b and the ageing breakdown reconciles to the headline, exactly',
    position.ok && position.data.agreement.kind === 'agrees',
    position.ok ? position.data.agreement.kind : 'n/a',
  );

  // -- 8. The fee is still gated ------------------------------------------
  check(
    '8a the facility fee is still PROVISIONAL and labelled by the server',
    position.ok && position.data.fee !== null && position.data.fee.provisional,
    position.ok && position.data.fee !== null ? position.data.fee.label : 'no fee working',
  );

  await sql.end();

  const failed = checks.filter((c) => !c.pass);
  const result = {
    drill: 'D14',
    checks: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
  };
  console.log(`\n__DRILL_RESULT__ ${JSON.stringify(result)}`);
  console.log(`\n${String(result.passed)}/${String(result.checks)} checks passed\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
