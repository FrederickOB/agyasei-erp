/**
 * D15 — INDEPENDENT VERIFICATION of the credit account client.
 *
 *   pnpm stack:up && pnpm stack:bootstrap
 *   pnpm dev:api                    # :3001, on THIS code
 *   pnpm --filter @erp/wire-conformance drill:credit-verify
 *
 * This is the QA pass's OWN drill, written against the same live stack as D14
 * but deliberately NOT sharing its assertions. Where D14 asks "did the client
 * get an answer", this asks the three questions the ledger in
 * `docs/phase1-status.md` §0 says actually catch defects:
 *
 *  1. **Is the number right when a second, independent computation is run?**
 *     Every balance here is checked against `sum(app.credit_entry.amount_minor)`
 *     computed in SQL by this file, never against the API's own arithmetic.
 *  2. **Can the client READ the reply?** Ledger row 16: `receiving.get`
 *     answered `200 OK` with a correct payload that the PWA refused, because a
 *     `Date` selected uncast made superjson annotate it in a `meta` block.
 *     Part D drives EVERY credit read the client uses at the raw HTTP level
 *     and asserts no response carries a `meta` envelope.
 *  3. **Is the refusal real, and is the route actually alive?** Every negative
 *     control here is paired with a positive one on the same route with the
 *     same payload, so "denied" can never quietly mean "broken for everyone".
 *
 * Prints `__DRILL_RESULT__ {json}` and exits non-zero if any check fails.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import type { ApiCallOptions, ApiFetch } from '../../../apps/web/src/data/api/client';
import {
  accrueFacilityFee,
  fetchAccountForCustomer,
  fetchAgeing,
  fetchCreditPosition,
  fetchExposure,
  fetchFeePreview,
  openCreditAccount,
  setCreditLimit,
} from '../../../apps/web/src/data/api/credit';
import { recordRepayment } from '../../../apps/web/src/data/mutations/recordRepayment';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import { httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { drainOutbox } from '../../../apps/web/src/data/sync/upload';
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

/**
 * RAW tRPC calls, bypassing the client's mappers entirely. This is how Part D
 * can see the shape of the envelope the SERVER actually put on the wire —
 * `apps/web`'s own client REFUSES a `meta` envelope, so driving through it
 * would only ever report "malformed" without showing why.
 */
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

async function rawMutate(
  route: string,
  input: unknown,
  bearer: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_URL}/trpc/${route}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      origin: PWA_ORIGIN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ json: input }),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

/**
 * Ledger row 16's signature, stated once. A tRPC success envelope is
 * `{"result":{"data":{"json":…}}}`. When superjson has to annotate a value it
 * cannot carry in plain JSON — a `Date` above all — it adds a SIBLING `meta`
 * key next to `json`, and `apps/web/src/data/api/client.ts` refuses the whole
 * response rather than drop the annotation and render a raw value.
 */
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
      if (k === 'meta' && Object.prototype.hasOwnProperty.call(rec, 'json')) {
        found.push(`${at}.meta`);
      }
      walk(v, `${at}.${k}`);
    }
  };
  walk(body, '$');
  return found;
}

let seq = 0;
const RUN = Date.now();
/** A v7-shaped uuid, unique per call, so no two writes share an idempotency key. */
function key(): string {
  seq += 1;
  const hex = (RUN * 1000 + seq).toString(16).padStart(12, '0').slice(-12);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${String(seq).padStart(12, '0')}`;
}

/** Σ(app.credit_entry.amount_minor) — this file's own arithmetic, not the API's. */
async function sqlBalance(sql: pg.Client, accountId: string): Promise<bigint> {
  const r = await sql.query<{ bal: string | null }>(
    `select sum(amount_minor::bigint)::text as bal
       from app.credit_entry where account_id = $1 and deleted_at is null`,
    [accountId],
  );
  return BigInt(r.rows[0]?.bal ?? '0');
}

async function main(): Promise<void> {
  const accountsToken = devToken('accounts');
  const managerToken = devToken('outlet_manager');
  const counterToken = devToken('counter_staff');
  const claims = claimsOf(accountsToken);

  const opt = (bearer: string): ApiCallOptions => ({
    endpoint: { url: API_URL, bearer },
    fetchFn: browserFetch,
  });
  const options = opt(accountsToken);

  const sql = new pg.Client({ connectionString: DATABASE_URL });
  await sql.connect();

  const stamp = Date.now().toString(36);
  console.log('\nD15 · independent verification of the credit client\n');

  // ══ PART A — opening an account, and who may ═════════════════════════════
  console.log('A · opening an account');

  const opened = await openCreditAccount(
    {
      idempotencyKey: key(),
      clientWallAt: new Date().toISOString(),
      newCustomer: { code: `VER-${stamp}`, name: `Verify customer ${stamp}` },
      termsDays: 30,
      feeRateBpPerMonth: 250,
      creditLimitMinor: '5000000',
    },
    options,
  );
  check(
    'A1 accounts holder opens an account through the client',
    opened.ok,
    opened.ok ? `account ${opened.data.accountId}` : `refused: ${opened.failure.detail ?? ''}`,
  );
  if (!opened.ok) throw new Error('cannot continue without an account');
  const accountId = opened.data.accountId;
  const customerId = opened.data.customerId;

  // The row, in Postgres, read by this file.
  const row = await sql.query<{ n: string; tid: string; cust: string }>(
    `select count(*)::text as n, min(tenant_id::text) as tid, min(customer_id::text) as cust
       from app.customer_account where id = $1`,
    [accountId],
  );
  check(
    'A2 the account row is in Postgres, on the token\'s OWN tenant',
    row.rows[0]?.n === '1' && row.rows[0]?.tid === claims.tid && row.rows[0]?.cust === customerId,
    `n=${String(row.rows[0]?.n)} tenant=${String(row.rows[0]?.tid) === claims.tid ? 'matches token' : 'MISMATCH'}`,
  );

  const genesis = await sql.query<{ n: string; state: string; lim: string; terms: string }>(
    `select count(*)::text as n, min(state::text) as state,
            min(limit_minor::bigint)::text as lim, min(terms_days)::text as terms
       from app.credit_limit_version where credit_account_id = $1`,
    [accountId],
  );
  check(
    'A3 the genesis limit version is accepted, at the limit the client sent',
    genesis.rows[0]?.n === '1' &&
      genesis.rows[0]?.state === 'accepted' &&
      genesis.rows[0]?.lim === '5000000' &&
      genesis.rows[0]?.terms === '30',
    `${String(genesis.rows[0]?.n)} version, state=${String(genesis.rows[0]?.state)}, limit=${String(genesis.rows[0]?.lim)}, terms=${String(genesis.rows[0]?.terms)}`,
  );

  // -- the refusal, and its positive control -------------------------------
  const mgrOpen = await openCreditAccount(
    {
      idempotencyKey: key(),
      clientWallAt: new Date().toISOString(),
      newCustomer: { code: `VER-MGR-${stamp}`, name: `Manager attempt ${stamp}` },
      termsDays: 30,
      feeRateBpPerMonth: 250,
      creditLimitMinor: '5000000',
    },
    opt(managerToken),
  );
  check(
    'A4 an outlet manager is REFUSED openAccount over real HTTP (403)',
    !mgrOpen.ok && mgrOpen.failure.kind === 'forbidden' && mgrOpen.failure.status === 403,
    mgrOpen.ok
      ? `WRONG: opened ${mgrOpen.data.accountId}`
      : `${String(mgrOpen.failure.status)} ${mgrOpen.failure.kind}: ${mgrOpen.failure.detail ?? ''}`,
  );
  const mgrLeak = await sql.query<{ n: string }>(
    `select count(*)::text as n from app.customer c
       join app.customer_account a on a.customer_id = c.id
      where c.code = $1`,
    [`VER-MGR-${stamp}`],
  );
  check(
    'A5 …and the refusal wrote NOTHING',
    mgrLeak.rows[0]?.n === '0',
    `${String(mgrLeak.rows[0]?.n)} account(s) for the refused code`,
  );

  // POSITIVE CONTROL on the same route with the same payload shape: the route
  // is alive, so A4 means "this caller may not", never "this route is broken".
  const control = await openCreditAccount(
    {
      idempotencyKey: key(),
      clientWallAt: new Date().toISOString(),
      newCustomer: { code: `VER-CTL-${stamp}`, name: `Control customer ${stamp}` },
      termsDays: 30,
      feeRateBpPerMonth: 250,
      creditLimitMinor: '5000000',
    },
    options,
  );
  check(
    'A6 POSITIVE CONTROL — the identical payload succeeds for the holder',
    control.ok,
    control.ok ? `opened ${control.data.accountId}` : `refused: ${control.failure.detail ?? ''}`,
  );

  // Part D — the row-16 sweep — runs UNCONDITIONALLY. A sweep that only runs
  // when everything upstream passed is a sweep that goes quiet in exactly the
  // conditions worth sweeping, so an arithmetic failure in B or C must not be
  // able to skip it.
  try {
    await partB(sql, accountId, customerId, options, managerToken, counterToken);
  } catch (err: unknown) {
    check('B/C reached the end without aborting', false, `aborted: ${String(err)}`);
  }
  await partD(sql, accountId, customerId, options);
  await sql.end();
}

// ══ PART B — changing a limit, and who never may ═══════════════════════════
async function partB(
  sql: pg.Client,
  accountId: string,
  customerId: string,
  options: ApiCallOptions,
  managerToken: string,
  counterToken: string,
): Promise<void> {
  console.log('\nB · changing a credit limit');

  const before = await fetchCreditPosition(accountId, TODAY, options);
  check(
    'B1 fetchCreditPosition decodes — exposure, ageing and the fee working',
    before.ok,
    before.ok
      ? `limit=${before.data.exposure.creditLimitMinor.toString()} head=${String(before.data.exposure.limitVersionId)}`
      : `refused: ${before.failure.detail ?? ''}`,
  );
  if (!before.ok) throw new Error('cannot continue without a position');
  const head = before.data.exposure.limitVersionId;

  const changed = await setCreditLimit(
    {
      idempotencyKey: key(),
      clientWallAt: new Date().toISOString(),
      accountId,
      creditLimitMinor: '8000000',
      termsDays: 45,
      effectiveFrom: TODAY,
      reason: 'verification drill: deposit cleared',
      ...(head === null ? {} : { supersedesId: head }),
    },
    options,
  );
  check(
    'B2 the limit changes, and the client decodes the reply',
    changed.kind === 'changed',
    changed.kind === 'changed'
      ? `${changed.result.previousLimitMinor.toString()} → ${changed.result.creditLimitMinor.toString()}, terms ${String(changed.result.previousTermsDays)} → ${String(changed.result.termsDays)}`
      : JSON.stringify(changed),
  );

  const after = await sql.query<{ n: string; lim: string; terms: string; sup: string | null }>(
    `select count(*)::text as n, min(limit_minor::bigint)::text as lim,
            min(terms_days)::text as terms, min(supersedes_id::text) as sup
       from app.credit_limit_version
      where credit_account_id = $1 and state = 'accepted'`,
    [accountId],
  );
  check(
    'B3 Postgres holds exactly ONE accepted head, at the new limit',
    after.rows[0]?.n === '1' && after.rows[0]?.lim === '8000000' && after.rows[0]?.terms === '45',
    `n=${String(after.rows[0]?.n)} limit=${String(after.rows[0]?.lim)} terms=${String(after.rows[0]?.terms)} supersedes=${String(after.rows[0]?.sup)}`,
  );

  const log = await sql.query<{ n: string }>(
    `select count(*)::text as n from app.credit_limit_version where credit_account_id = $1`,
    [accountId],
  );
  check(
    'B4 the superseded version is KEPT — the decision log is append-only',
    log.rows[0]?.n === '2',
    `${String(log.rows[0]?.n)} versions on the account`,
  );

  // -- counter staff, on the most sensitive credit route there is ----------
  const counterLimit = await setCreditLimit(
    {
      idempotencyKey: key(),
      clientWallAt: new Date().toISOString(),
      accountId,
      creditLimitMinor: '99000000',
      termsDays: 90,
      effectiveFrom: TODAY,
      reason: 'verification drill: counter staff must never do this',
      ...(changed.kind === 'changed' ? { supersedesId: changed.result.versionId } : {}),
    },
    { endpoint: { url: API_URL, bearer: counterToken }, fetchFn: browserFetch },
  );
  check(
    'B5 COUNTER STAFF is refused a limit change (CLAUDE.md §2.6, verbatim)',
    counterLimit.kind === 'refused',
    counterLimit.kind === 'refused'
      ? `${counterLimit.failure.kind}: ${counterLimit.failure.detail ?? ''}`
      : `WRONG: ${JSON.stringify(counterLimit)}`,
  );
  const mgrLimit = await setCreditLimit(
    {
      idempotencyKey: key(),
      clientWallAt: new Date().toISOString(),
      accountId,
      creditLimitMinor: '77000000',
      termsDays: 90,
      effectiveFrom: TODAY,
      reason: 'verification drill: outlet manager may not either',
      ...(changed.kind === 'changed' ? { supersedesId: changed.result.versionId } : {}),
    },
    { endpoint: { url: API_URL, bearer: managerToken }, fetchFn: browserFetch },
  );
  check(
    'B6 an outlet manager is refused it too',
    mgrLimit.kind === 'refused',
    mgrLimit.kind === 'refused' ? mgrLimit.failure.kind : `WRONG: ${JSON.stringify(mgrLimit)}`,
  );
  const stillHead = await sql.query<{ lim: string }>(
    `select min(limit_minor::bigint)::text as lim from app.credit_limit_version
      where credit_account_id = $1 and state = 'accepted'`,
    [accountId],
  );
  check(
    'B7 …and after BOTH refusals the accepted limit is untouched',
    stillHead.rows[0]?.lim === '8000000',
    `limit is still ${String(stillHead.rows[0]?.lim)}`,
  );

  await partC(sql, accountId, customerId, options);
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

// ══ PART C — a repayment, and arithmetic checked against SQL ═══════════════
async function partC(
  sql: pg.Client,
  accountId: string,
  customerId: string,
  options: ApiCallOptions,
): Promise<void> {
  console.log('\nC · a repayment, and the arithmetic behind it');
  const bearer = options.endpoint?.bearer ?? '';

  // Two charges on DIFFERENT trading days, so ageing cannot pass by lumping
  // them: one already past its 45-day terms, one raised today.
  const OLD = daysAgo(60);
  const c1 = await rawMutate(
    'credit.recordEntry',
    { idempotencyKey: key(), accountId, kind: 'CHARGE', amountMinor: '1200000', businessDate: OLD },
    bearer,
  );
  const c2 = await rawMutate(
    'credit.recordEntry',
    { idempotencyKey: key(), accountId, kind: 'CHARGE', amountMinor: '500000', businessDate: TODAY },
    bearer,
  );
  check(
    'C1 two charges land on two different trading days',
    c1.status === 200 && c2.status === 200,
    `HTTP ${String(c1.status)} / ${String(c2.status)}, dates ${OLD} and ${TODAY}`,
  );

  const oldest = await sql.query<{ id: string }>(
    `select id::text as id from app.credit_entry
      where account_id = $1 and kind = 'CHARGE' and business_date = $2 limit 1`,
    [accountId, OLD],
  );
  const oldInvoiceId = oldest.rows[0]?.id;

  // -- the repayment, through the PWA's own outbox and transport -----------
  const db = openTestDb();
  const locs = claimsOf(bearer).locs;
  await provisionDevice(db, {
    locationId: locs[0] ?? '',
    locationCode: 'VERIFY',
    priceListCode: 'WHOLESALE',
  });
  const queued = await recordRepayment(db, {
    entryId: key(),
    accountId,
    amountReceivedMinor: 400_000n,
    ...(oldInvoiceId === undefined ? {} : { appliesToId: oldInvoiceId }),
    hlc: fixedHlc(Date.now(), 'ab'.repeat(16)),
  });
  check(
    'C2 the client SIGNS the repayment negative and queues it offline',
    queued.amountMinor === -400_000n,
    `amountMinor=${queued.amountMinor.toString()} appliesTo=${String(queued.appliesToId)}`,
  );

  const drained = await drainOutbox(
    db,
    httpUploadTransport({ apiUrl: API_URL, apiToken: bearer, fetchFn: browserFetch }),
  );
  check(
    'C3 it drains over real HTTP and the server APPLIES it',
    drained.completed === 1 && drained.rejected === 0,
    `applied=${String(drained.completed)} rejected=${String(drained.rejected)}`,
  );

  // ── THE ARITHMETIC. This file computes the balance itself. ──────────────
  const independent = await sqlBalance(sql, accountId);
  const pos = await fetchCreditPosition(accountId, TODAY, options);
  check(
    'C4 balance == Σ(app.credit_entry) computed independently in SQL',
    pos.ok && pos.data.exposure.exposureMinor === independent,
    pos.ok
      ? `API ${pos.data.exposure.exposureMinor.toString()} vs SQL ${independent.toString()} (expected 1300000)`
      : `position refused: ${pos.failure.detail ?? ''}`,
  );
  if (!pos.ok) throw new Error('cannot continue without a position');
  check(
    'C5 …and that is the arithmetic a person would do: 1200000 + 500000 − 400000',
    independent === 1_300_000n,
    `Σ = ${independent.toString()}`,
  );

  const buckets = pos.data.ageing.buckets.reduce((a, b) => a + b.amountMinor, 0n);
  check(
    'C6 Σ(ageing buckets) still equals the balance, exactly',
    buckets === independent,
    `Σbuckets=${buckets.toString()} balance=${independent.toString()} over ${String(pos.data.ageing.buckets.length)} buckets`,
  );

  const invoices = pos.data.ageing.invoices;
  const paid = invoices.find((i) => i.chargeId === oldInvoiceId);
  const fresh = invoices.find((i) => i.chargeId !== oldInvoiceId);
  check(
    'C7 the PAID-DOWN invoice ages at its own age, reduced by exactly the payment',
    paid !== undefined && paid.outstandingMinor === 800_000n,
    paid === undefined
      ? 'the paid invoice is absent from ageing'
      : `outstanding=${paid.outstandingMinor.toString()} (1200000 − 400000), dpd=${String(paid.daysPastDue)}`,
  );
  check(
    'C8 …and the OTHER invoice is untouched, at its own age',
    fresh !== undefined && fresh.outstandingMinor === 500_000n,
    fresh === undefined
      ? 'the second invoice is absent'
      : `outstanding=${fresh.outstandingMinor.toString()}, dpd=${String(fresh.daysPastDue)}`,
  );
  check(
    'C9 the two invoices age SEPARATELY — different days past due',
    paid !== undefined && fresh !== undefined && paid.daysPastDue !== fresh.daysPastDue,
    `dpd=[${String(paid?.daysPastDue)}, ${String(fresh?.daysPastDue)}]`,
  );

}

// ══ PART D — the row-16 sweep, and the fee gate ════════════════════════════
async function partD(
  sql: pg.Client,
  accountId: string,
  customerId: string,
  options: ApiCallOptions,
): Promise<void> {
  console.log('\nD · every credit read the client uses, swept for a superjson meta envelope');
  const bearer = options.endpoint?.bearer ?? '';

  /** Every credit READ a production screen actually performs. */
  const reads: ReadonlyArray<{ route: string; input: unknown }> = [
    { route: 'credit.accountForCustomer', input: { customerId } },
    { route: 'credit.exposure', input: { accountId } },
    { route: 'credit.ageing', input: { accountId, asOf: TODAY } },
    { route: 'credit.previewFacilityFee', input: { accountId, asOf: TODAY } },
  ];

  let sweptClean = 0;
  for (const r of reads) {
    const res = await rawQuery(r.route, r.input, bearer);
    const metas = metaKeysIn(res.body);
    const ok = res.status === 200 && metas.length === 0;
    if (ok) sweptClean += 1;
    check(
      `D1 ${r.route} carries NO superjson meta envelope`,
      ok,
      `HTTP ${String(res.status)}${metas.length === 0 ? ', envelope is plain json' : `, META AT ${metas.join(', ')}`}`,
    );
  }
  check(
    'D2 the whole credit read surface the client uses is meta-free',
    sweptClean === reads.length,
    `${String(sweptClean)}/${String(reads.length)} reads clean`,
  );

  // The two MUTATION replies the client also decodes. Row 16 was a read, but
  // the serializer does not care which verb annotated the value.
  const openReply = await rawMutate(
    'credit.openAccount',
    {
      idempotencyKey: key(),
      newCustomer: { code: `VER-META-${Date.now().toString(36)}`, name: 'Meta sweep' },
      termsDays: 30,
      feeRateBpPerMonth: 250,
      creditLimitMinor: '100000',
    },
    bearer,
  );
  check(
    'D3 credit.openAccount\'s REPLY carries no meta envelope either',
    openReply.status === 200 && metaKeysIn(openReply.body).length === 0,
    `HTTP ${String(openReply.status)}, meta=[${metaKeysIn(openReply.body).join(', ')}]`,
  );

  // And the client's own mappers decode every one of them for real — a clean
  // envelope that the mapper still rejects would be a different bug.
  const [exposure, ageing, preview, ref] = await Promise.all([
    fetchExposure(accountId, options),
    fetchAgeing(accountId, TODAY, options),
    fetchFeePreview(accountId, TODAY, options),
    fetchAccountForCustomer(customerId, options),
  ]);
  check(
    'D4 the client\'s OWN mappers decode all four reads without refusing',
    exposure.ok && ageing.ok && preview.ok && ref.ok,
    `exposure=${String(exposure.ok)} ageing=${String(ageing.ok)} fee=${String(preview.ok)} ref=${String(ref.ok)}`,
  );

  // -- the fee gate --------------------------------------------------------
  console.log('\nE · the facility fee gate');
  const accrue = await accrueFacilityFee(
    { idempotencyKey: key(), accountId, asOf: TODAY, clientWallAt: new Date().toISOString() },
    options,
  );
  check(
    'E1 accrueFacilityFee still REFUSES — 412 FEE_POLICY_UNCONFIRMED',
    accrue.kind === 'policy-unconfirmed',
    accrue.kind === 'policy-unconfirmed'
      ? 'the human gate held (Q4 is NEEDS-HUMAN)'
      : `WRONG: ${JSON.stringify(accrue).slice(0, 160)}`,
  );
  const feeRows = await sql.query<{ n: string }>(
    `select count(*)::text as n from app.credit_entry where account_id = $1 and kind = 'FEE'`,
    [accountId],
  );
  check(
    'E2 …and the account carries ZERO FEE rows',
    feeRows.rows[0]?.n === '0',
    `${String(feeRows.rows[0]?.n)} FEE entries`,
  );
  check(
    'E3 the fee is VISIBLE but flagged provisional, never chargeable',
    preview.ok && preview.data.provisional,
    preview.ok
      ? `provisional=${String(preview.data.provisional)} label="${preview.data.label}"`
      : 'the preview refused',
  );

  // The balance must not have moved a single minor unit across all of Part D.
  const stillBalance = await sqlBalance(sql, accountId);
  check(
    'E4 nothing in the fee path moved the balance',
    stillBalance === 1_300_000n,
    `Σ(credit_entry) = ${stillBalance.toString()}`,
  );
}

main()
  .then(() => {
    const failed = checks.filter((c) => !c.pass);
    console.log(
      `\n__DRILL_RESULT__ ${JSON.stringify({
        drill: 'D15',
        total: checks.length,
        passed: checks.length - failed.length,
        failed: failed.length,
        failures: failed.map((f) => f.name),
      })}`,
    );
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((err: unknown) => {
    console.error('\nD15 ABORTED:', err);
    console.log(
      `\n__DRILL_RESULT__ ${JSON.stringify({
        drill: 'D15',
        total: checks.length,
        passed: checks.filter((c) => c.pass).length,
        failed: checks.filter((c) => !c.pass).length + 1,
        aborted: String(err),
      })}`,
    );
    process.exit(1);
  });
