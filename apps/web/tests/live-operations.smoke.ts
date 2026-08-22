/**
 * THE TWO OPERATIONS CLIENTS, AGAINST THE REAL API, OVER A REAL SOCKET.
 *
 * NOT part of `pnpm test` — it is not a `*.test.ts` (vitest only collects
 * those) and it needs the docker stack plus an API dev server on the CURRENT
 * source:
 *
 *   pnpm stack:up
 *   pnpm dev:api
 *   pnpm --filter @erp/web exec tsx tests/live-operations.smoke.ts
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS — §0 of docs/phase1-status.md, again
 * ---------------------------------------------------------------------------
 * The unit tests for these two features drive the real components and the real
 * builders through a STUB transport and a mocked outbox drain. They can prove
 * this client renders and queues correctly; they cannot prove the server
 * accepts what it queues, and the repository's own ledger of nine failures is
 * a ledger of exactly that gap — both sides tested against a third thing that
 * agreed with neither.
 *
 * So this script drives the PWA's OWN artefacts end to end:
 *
 *  · the adjustment path builds a payload with `buildMovementPayload`, writes
 *    a real outbox row, and drains it with `httpUploadTransport` +
 *    `drainOutbox` against `POST /sync/upload` — the same two modules the
 *    device runs. Nothing here re-shapes the JSON.
 *  · the credit path calls `fetchCreditPosition` and `accrueFacilityFee` and
 *    asserts against the answers the deployed API actually gives, including
 *    the Q4 gate and the two refusals — each paired with a positive control on
 *    the same route, so "denied" can never quietly mean "broken for everyone".
 *
 * Tokens come from the repository's existing dev-token script.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAccountInput, recordEntryInput } from '@erp/contracts';
import type { ApiEndpoint, ApiResult } from '../src/data/api/client';
import {
  accrueFacilityFee,
  checkAgreement,
  fetchCreditPosition,
  fetchExposure,
} from '../src/data/api/credit';
import { fetchStockOnHand } from '../src/data/api/reports';
import {
  ADJUSTMENT_OUTBOX_KIND,
  buildMovementPayload,
} from '../src/data/mutations/adjustStock';
import { recentAdjustments } from '../src/data/queries/adjustments';
import { readBearerScope } from '../src/data/session/bearer-claims';
import { httpUploadTransport } from '../src/data/sync/transport';
import { drainOutbox, readPendingOps } from '../src/data/sync/upload';
import type { LocalDb } from '../src/data/db';
import { createClaimedHlcClock } from '../src/lib/hlc';
import { uuidv7 } from '../src/lib/uuidv7';
import { openTestDb } from './helpers/node-db';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API_URL = process.env['API_URL'] ?? 'http://localhost:3001';
const NODE = 'ab'.repeat(16);

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

/** A raw tRPC mutation, for SETUP only — never for anything under test. */
async function setupMutation(
  endpoint: ApiEndpoint,
  procedure: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_URL}/trpc/${procedure}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
  const body = (await res.json().catch(() => null)) as
    | { result?: { data?: { json?: Record<string, unknown> } }; error?: unknown }
    | null;
  if (!res.ok) throw new Error(`${procedure} failed ${String(res.status)}: ${JSON.stringify(body)}`);
  return body?.result?.data?.json ?? {};
}

/**
 * A device with one queued adjustment, built by the client's OWN builder and
 * written into a real outbox row exactly as `recordAdjustment` writes one.
 * (`recordAdjustment` itself reads the device's provisioned location from
 * `local_config`; here the location comes from the live token's scope, which
 * is the same value a provisioned device would hold.)
 */
async function queueAdjustment(
  db: LocalDb,
  args: {
    readonly locationId: string;
    readonly productId: string;
    readonly qtyDelta: bigint;
    readonly reasonCode: string;
  },
): Promise<string> {
  const hlc = createClaimedHlcClock(NODE);
  const movementId = uuidv7();
  const claimedHlc = hlc.next();
  const nowIso = new Date().toISOString();
  const built = buildMovementPayload({
    movementId,
    locationId: args.locationId,
    productId: args.productId,
    qtyDelta: args.qtyDelta,
    kind: 'CORRECTION',
    reasonCode: args.reasonCode,
    businessDate: nowIso.slice(0, 10),
    claimedHlc,
    createdAt: nowIso,
  });
  await db.execute(
    `INSERT INTO outbox (id, idempotency_key, claimed_hlc, kind, payload, created_at,
                         server_ack_at, rejected_at, reject_reason)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    [movementId, movementId, claimedHlc, ADJUSTMENT_OUTBOX_KIND, built.payloadJson, nowIso],
  );
  return movementId;
}

async function main(): Promise<void> {
  const manager = endpointFor('outlet_manager');
  const staff = endpointFor('counter_staff');
  const accounts = endpointFor('accounts');

  // ═══ PART 1 — THE ADJUSTMENT, THROUGH THE OUTBOX, OVER /sync/upload ═══════

  const stock = await fetchStockOnHand({ onlyNonZero: true }, { endpoint: manager.endpoint });
  const productId = stock.ok ? stock.data.networkByProduct[0]?.productId : undefined;
  if (productId === undefined) {
    check('0 a product to adjust', false, why(stock));
  } else {
    // 1a. The manager holds `stock.adjust`. The PWA's own payload, applied.
    {
      const db = openTestDb();
      const id = await queueAdjustment(db, {
        locationId: manager.locationId,
        productId,
        qtyDelta: 1n,
        reasonCode: 'CORRECTION',
      });
      const report = await drainOutbox(
        db,
        httpUploadTransport({ apiUrl: API_URL, apiToken: manager.endpoint.bearer }),
      );
      const listed = await recentAdjustments(db);
      check(
        '1a outlet manager — the client’s own movement payload is APPLIED by the live API',
        report.completed === 1 && listed[0]?.syncState === 'synced',
        `completed=${String(report.completed)} rejected=${String(report.rejected)} ` +
          `deferred=${String(report.deferred)} badge=${String(listed[0]?.syncState)} id=${id.slice(0, 8)}`,
      );

      // 1b. Replaying the SAME key is one movement, not two.
      await db.execute('UPDATE outbox SET server_ack_at = NULL WHERE id = ?', [id]);
      const replay = await drainOutbox(
        db,
        httpUploadTransport({ apiUrl: API_URL, apiToken: manager.endpoint.bearer }),
      );
      check(
        '1b the same idempotency key replays as DUPLICATE, never as a second movement',
        replay.completed === 1 && replay.rejected === 0,
        `completed=${String(replay.completed)} rejected=${String(replay.rejected)}`,
      );
    }

    // 1c. Counter staff do NOT hold `stock.adjust`. Byte-identical payload.
    {
      const db = openTestDb();
      await queueAdjustment(db, {
        locationId: staff.locationId,
        productId,
        qtyDelta: 1n,
        reasonCode: 'CORRECTION',
      });
      // Read the ACK ITSELF first, so "refused" cannot quietly mean "the batch
      // never got a 200". The transport is the device's own module.
      const transport = httpUploadTransport({
        apiUrl: API_URL,
        apiToken: staff.endpoint.bearer,
      });
      const sent = await transport.send(await readPendingOps(db));
      const ack = sent.acks[0];
      check(
        '1c counter staff REFUSED the identical payload — the capability, not the screen',
        sent.ok && ack?.status === 'rejected' && /FORBIDDEN|PERMISSION_DENIED/.test(ack.reason ?? ''),
        `http=${String(sent.status)} status=${String(ack?.status)} reason=${(ack?.reason ?? '').slice(0, 70)}`,
      );

      const report = await drainOutbox(db, transport);
      const rows = await db.getAll('SELECT reject_reason, server_ack_at FROM outbox');
      const acked = rows[0]?.['server_ack_at'];
      check(
        '1c2 …and the refusal is RETRYABLE, so the movement is not marked done',
        report.completed === 0 && acked === null,
        `completed=${String(report.completed)} deferred=${String(report.deferred)}`,
      );
      // And the refusal is treated as RETRYABLE, so a permission fixed at HQ
      // drains the movement rather than having discarded it (03 §3.3.4).
      check(
        '1d a FORBIDDEN refusal keeps the movement on the device, never discards it',
        (await recentAdjustments(db)).length === 1,
        `rows=${String((await recentAdjustments(db)).length)}`,
      );
    }

    // 1e. A reason code the tenant does not have is refused BY THE DEVICE, so
    //     it can never reach the queue — the server's PRECONDITION_FAILED for
    //     one is retryable and would wedge the outbox behind it.
    {
      let threw = false;
      try {
        buildMovementPayload({
          movementId: uuidv7(),
          locationId: manager.locationId,
          productId,
          qtyDelta: 1n,
          kind: 'WRITE_OFF',
          reasonCode: 'CORRECTION',
          businessDate: new Date().toISOString().slice(0, 10),
          createdAt: new Date().toISOString(),
        });
      } catch {
        threw = true;
      }
      check(
        '1e a sign the ledger’s CHECK would refuse never reaches the wire',
        threw,
        'positive qty on an outflow-only kind, refused at the device',
      );
    }
  }

  // ═══ PART 2 — CREDIT, ONLINE, THROUGH THE CLIENT'S OWN READS ══════════════

  const key = uuidv7();
  const opened = await setupMutation(accounts.endpoint, 'credit.openAccount', {
    ...openAccountInput.parse({
      idempotencyKey: key,
      clientWallAt: new Date().toISOString(),
      // The tail of a UUIDv7 is the random half; the head is a timestamp, and two
      // runs a second apart would collide on `customer_code_uq`.
      newCustomer: { code: `SMOKE-${key.slice(-12)}`, name: 'Smoke test account' },
      termsDays: 30,
      feeRateBpPerMonth: 200,
      creditLimitMinor: '5000000',
    }),
    // zod's transform turns the money into a bigint; the wire wants the string.
    creditLimitMinor: '5000000',
  });
  const accountId = String(opened['accountId']);

  const chargeKey = uuidv7();
  const asOf = new Date().toISOString().slice(0, 10);
  const longAgo = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
  await setupMutation(accounts.endpoint, 'credit.recordEntry', {
    ...recordEntryInput.parse({
      idempotencyKey: chargeKey,
      clientWallAt: new Date().toISOString(),
      accountId,
      kind: 'CHARGE',
      amountMinor: '494400',
      businessDate: longAgo,
    }),
    amountMinor: '494400',
  });

  // 2a. The client's own reads, against a real ledger.
  const position = await fetchCreditPosition(accountId, asOf, { endpoint: accounts.endpoint });
  check(
    '2a the client reads a real balance, limit and headroom as bigint minor units',
    position.ok &&
      position.data.exposure.exposureMinor === 494_400n &&
      position.data.exposure.creditLimitMinor === 5_000_000n &&
      position.data.exposure.availableMinor === 4_505_600n,
    why(position) +
      (position.ok
        ? ` balance=${position.data.exposure.exposureMinor.toString()} ` +
          `left=${position.data.exposure.availableMinor.toString()}`
        : ''),
  );

  // 2b. THE INVARIANT drill:credit proved, now evaluated by the client's own
  //     arithmetic over the server's own answers.
  check(
    '2b Σ buckets − on-account + fee = balance, on real server data',
    position.ok && checkAgreement(position.data.exposure, position.data.ageing).kind === 'agrees',
    position.ok
      ? `buckets=${position.data.ageing.buckets
          .map((b) => `${b.label}:${b.amountMinor.toString()}`)
          .join(' ')} agedBy=${position.data.ageing.agedBy}`
      : why(position),
  );

  // 2c. The fee comes back labelled by the SERVER, and it is provisional.
  check(
    '2c the fee working is labelled by the server as provisional and not chargeable',
    position.ok && position.data.fee !== null && position.data.fee.provisional,
    position.ok && position.data.fee !== null
      ? `label="${position.data.fee.label}" total=${position.data.fee.totalDeltaMinor.toString()}`
      : why(position),
  );

  // 2d. THE Q4 GATE, live: posting is refused, and the client classifies the
  //     refusal apart from every other one so no screen can offer a retry.
  const accrual = await accrueFacilityFee(
    {
      idempotencyKey: uuidv7(),
      clientWallAt: new Date().toISOString(),
      accountId,
      asOf,
    },
    { endpoint: accounts.endpoint },
  );
  check(
    '2d accrual is REFUSED as a human gate, not as a retryable error',
    accrual.kind === 'policy-unconfirmed',
    accrual.kind === 'policy-unconfirmed'
      ? accrual.detail.slice(0, 80)
      : `kind=${accrual.kind}`,
  );

  // 2e/2f. The refusal, paired with its positive control on the same route.
  const staffRead = await fetchExposure(accountId, { endpoint: staff.endpoint });
  check(
    '2e counter staff REFUSED the credit read',
    !staffRead.ok && staffRead.failure.kind === 'forbidden',
    why(staffRead),
  );
  const managerRead = await fetchExposure(accountId, { endpoint: manager.endpoint });
  check(
    '2f a principal holding credit.view is ALLOWED — same route, same account',
    managerRead.ok,
    why(managerRead),
  );

  // 2g. A reference that names no account fails LOUDLY. That is exactly why a
  //     device may remember an identifier and may never remember a figure.
  const missing = await fetchExposure(uuidv7(), { endpoint: accounts.endpoint });
  check(
    '2g an account reference that names nothing is refused, never answered with a zero',
    !missing.ok && missing.failure.kind === 'refused',
    why(missing),
  );

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${String(failures)} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
