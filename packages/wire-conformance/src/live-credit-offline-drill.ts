/**
 * D16 — THE OFFLINE CREDIT POSITION, AND SUSPENSION, AGAINST THE LIVE STACK.
 *
 *   pnpm stack:up && pnpm stack:bootstrap
 *   pnpm dev:api                    # :3001, on THIS code
 *   pnpm --filter @erp/wire-conformance drill:credit-offline
 *
 * Migration 0013 made the credit book syncable and `credit.setStatus` made an
 * account suspendable. This drill asks the four questions those two changes
 * created, and asks each of them of the REAL code on both sides:
 *
 *  A. Does the figure a partitioned device would show EQUAL the figure the
 *     server gives online — and does Σ(ageing) still reconcile to it LOCALLY?
 *     Checked three ways: the client's own `loadSyncedCreditPosition` reading
 *     the rows the sync bucket ships, the API's own `credit.exposure`, and
 *     this file's own `sum(app.credit_entry.amount_minor)` in SQL.
 *  B. Is the staleness STATED, and does the device avoid implying a check it
 *     did not make? An entry newer than the snapshot must be LISTED, never
 *     folded into the balance (docs/credit-offline-plan.md R2/R3).
 *  C. Does suspension actually stop a credit sale — with a positive control
 *     that an ACTIVE customer's identical sale succeeds?
 *  D. Every credit read the client uses, swept for row 16's superjson `meta`
 *     envelope, INCLUDING the routes this pass added; plus the Q4 fee gate.
 *  E. What ACTUALLY happens to a sale a dark device recorded before a
 *     suspension it could not see. Measured, not assumed.
 *
 * Prints `__DRILL_RESULT__ {json}` and exits non-zero if any check fails.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { LiveTills, liveTenderIds, tenderLines } from './live-tills.js';

import type { ApiCallOptions, ApiFetch } from '../../../apps/web/src/data/api/client';
import {
  fetchAgeing, fetchExposure, openCreditAccount, setCreditStatus,
} from '../../../apps/web/src/data/api/credit';
import {
  loadAccountIdForCustomer, loadStatementLines, loadSyncedCreditPosition,
} from '../../../apps/web/src/data/queries/credit-position';
import type { FetchLike, HttpResponseLike } from '../../../apps/web/src/data/sync/credentials';
import { httpUploadTransport } from '../../../apps/web/src/data/sync/transport';
import { classifyRejection, drainOutbox } from '../../../apps/web/src/data/sync/upload';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';
import { provisionDevice } from '../../../apps/web/tests/helpers/fixtures';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API_URL = process.env['API_URL'] ?? 'http://localhost:3001';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql://erp:erp_dev@localhost:5433/erp';
const PWA_ORIGIN = process.env['PWA_ORIGIN'] ?? 'http://localhost:5173';
const TODAY = new Date().toISOString().slice(0, 10);

interface Check { name: string; pass: boolean; detail: string }
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
  const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    tid: string; uid: string; locs?: string[];
  };
  return { tid: d.tid, uid: d.uid, locs: d.locs ?? [] };
}

const browserFetch: ApiFetch & FetchLike = (async (url: string, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: { ...init.headers, origin: PWA_ORIGIN },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const response: HttpResponseLike = {
    ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown>,
  };
  return response;
}) as ApiFetch & FetchLike;

async function rawQuery(route: string, input: unknown, bearer: string) {
  const url = `${API_URL}/trpc/${route}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const res = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${bearer}`, origin: PWA_ORIGIN } });
  return { status: res.status, body: (await res.json()) as unknown };
}

async function rawMutate(route: string, input: unknown, bearer: string) {
  const res = await fetch(`${API_URL}/trpc/${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, origin: PWA_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

/** Row 16's signature: a superjson `meta` sibling of a `json` key. */
function metaKeysIn(body: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${at}[${String(i)}]`)); return; }
    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'meta' && Object.prototype.hasOwnProperty.call(rec, 'json')) found.push(`${at}.meta`);
      walk(v, `${at}.${k}`);
    }
  };
  walk(body, '$');
  return found;
}

let seq = 0;
const RUN = Date.now();
function key(): string {
  seq += 1;
  const hex = (RUN * 1000 + seq).toString(16).padStart(12, '0').slice(-12);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${String(seq).padStart(12, '0')}`;
}

/** One op in the shape `POST /sync/upload` actually validates (snake_case
 *  envelope keys, payload minus the envelope) — @erp/contracts uploadOpSchema. */
function uploadOp(kind: string, n: number, payload: Record<string, unknown>) {
  return {
    idempotency_key: key(),
    kind,
    claimed_hlc: `${String(Date.now()).padStart(13, '0')}-${String(n).padStart(5, '0')}-${'a'.repeat(32)}`,
    client_wall_at: new Date().toISOString(),
    payload,
  };
}

async function uploadOps(bearer: string, ops: unknown[]) {
  const res = await fetch(`${API_URL}/sync/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, origin: PWA_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ ops }),
  });
  const body = (await res.json()) as { acks?: { key: string; status: string; reason?: string }[] };
  return { status: res.status, acks: body.acks ?? [], raw: JSON.stringify(body).slice(0, 300) };
}

export default async function main(): Promise<void> {
  const accountsToken = devToken('accounts');
  const managerToken = devToken('outlet_manager');
  const claims = claimsOf(accountsToken);
  const options: ApiCallOptions = { endpoint: { url: API_URL, bearer: accountsToken }, fetchFn: browserFetch };
  const sql = new pg.Client({ connectionString: DATABASE_URL });
  await sql.connect();
  const stamp = Date.now().toString(36);
  console.log('\nD16 · the offline credit position, and suspension, on the live stack\n');

  // ══ A — the offline figure equals the online one ═════════════════════════
  console.log('A · the figure a partitioned device would show');
  const opened = await openCreditAccount({
    idempotencyKey: key(), clientWallAt: new Date().toISOString(),
    newCustomer: { code: `OFF-${stamp}`, name: `Offline customer ${stamp}` },
    termsDays: 30, feeRateBpPerMonth: 250, creditLimitMinor: '50000000',
  }, options);
  if (!opened.ok) throw new Error(`cannot open account: ${opened.failure.detail ?? ''}`);
  const { accountId, customerId } = opened.data;

  // Two charges, ageing into two different bands, through the DEVICE path.
  const dueOld = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  const dueNew = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const up = await uploadOps(accountsToken, [
    uploadOp('credit.record_entry', 1,
      { accountId, kind: 'CHARGE', amountMinor: '6120400', businessDate: dueOld, dueDate: dueOld }),
    uploadOp('credit.record_entry', 2,
      { accountId, kind: 'CHARGE', amountMinor: '2049600', businessDate: dueNew, dueDate: dueNew }),
  ]);
  // NON-VACUOUS BY CONSTRUCTION: `[].every(...)` is `true`, and an earlier
  // draft of this drill passed A4–A8 on 0 == 0 == 0 because a malformed
  // envelope meant nothing was ever written. The count is asserted first.
  check('A0 the two seed charges upload through the real device pipeline',
    up.status === 200 && up.acks.length === 2 && up.acks.every((a) => a.status === 'applied'),
    `HTTP ${String(up.status)}, ${String(up.acks.length)} ack(s): ${up.acks.map((a) => `${a.status}${a.reason === undefined ? '' : `: ${a.reason}`}`).join(', ')}`);
  if (up.acks.length !== 2 || !up.acks.every((a) => a.status === 'applied')) {
    throw new Error('seed charges did not land — every figure below would be a vacuous zero');
  }

  // THREE independent computations of the same number.
  const sqlSum = await sql.query<{ bal: string | null }>(
    `select sum(amount_minor::bigint)::text as bal from app.credit_entry
      where account_id = $1 and deleted_at is null`, [accountId]);
  const sqlBalance = BigInt(sqlSum.rows[0]?.bal ?? '0');
  const online = await fetchExposure(accountId, options);
  if (!online.ok) throw new Error('exposure read failed');
  const onlineAgeing = await fetchAgeing(accountId, TODAY, options);
  if (!onlineAgeing.ok) throw new Error('ageing read failed');

  // The rows the `tenant_credit` bucket will ship, read from the SAME server
  // tables the sync rules select from — then loaded into a REAL device SQLite
  // built from the PWA's own schema, and read back through the PWA's own
  // `loadSyncedCreditPosition`. Nothing is hand-shaped.
  const snap = await sql.query(
    `select account_id::text, customer_id::text, status, terms_days,
            credit_limit_minor::text, limit_version_id::text, balance_minor::text,
            trade_exposure_minor::text, available_minor::text,
            on_account_credit_minor::text, fee_outstanding_minor::text,
            opening_before_window_minor::text, aged_by, fee_confirmed_at,
            entry_window_days, as_of::text, as_of_hlc, computed_at
       from app.credit_position_snapshot where account_id = $1`, [accountId]);
  const snapRow = snap.rows[0] as Record<string, unknown> | undefined;
  check('A1 the server derived a position snapshot for the new account',
    snapRow !== undefined, snapRow === undefined ? 'NO SNAPSHOT ROW' : `balance ${String(snapRow['balance_minor'])}`);
  if (snapRow === undefined) throw new Error('no snapshot to sync');

  const bucketRows = await sql.query(
    `select id::text, account_id::text, seq, label, from_dpd, to_dpd,
            amount_minor::text, as_of::text, as_of_hlc
       from app.credit_position_bucket where account_id = $1 order by seq`, [accountId]);
  const entryRows = await sql.query(
    `select id::text, account_id::text, kind, amount_minor::text, business_date::text,
            due_date::text, hlc from app.credit_entry
      where account_id = $1 and archived_at is null order by hlc`, [accountId]);

  const db = openTestDb();
  await db.execute(
    `INSERT INTO customer_account (id, tenant_id, customer_id, credit_limit_minor, terms_days,
       facility_fee_bp_per_month, status, hlc, created_at, updated_at)
     VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, ?, ?)`,
    [accountId, claims.tid, customerId, String(snapRow['credit_limit_minor']), 30, 250,
     String(snapRow['status']), 'h', '', ''],
  );
  await db.execute(
    `INSERT INTO credit_position_snapshot (id, tenant_id, account_id, customer_id, status, terms_days,
       credit_limit_minor, limit_version_id, balance_minor, trade_exposure_minor, available_minor,
       on_account_credit_minor, fee_outstanding_minor, opening_before_window_minor, aged_by,
       fee_confirmed_at, entry_window_days, as_of, as_of_hlc, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, CAST(? AS INTEGER), CAST(? AS INTEGER),
             CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER),
             ?, ?, ?, ?, ?, ?)`,
    ['snap-1', claims.tid, accountId, customerId, String(snapRow['status']),
     Number(snapRow['terms_days']), String(snapRow['credit_limit_minor']),
     snapRow['limit_version_id'] === null ? null : String(snapRow['limit_version_id']),
     String(snapRow['balance_minor']), String(snapRow['trade_exposure_minor']),
     String(snapRow['available_minor']), String(snapRow['on_account_credit_minor']),
     String(snapRow['fee_outstanding_minor']), String(snapRow['opening_before_window_minor']),
     String(snapRow['aged_by']), snapRow['fee_confirmed_at'] === null ? null : String(snapRow['fee_confirmed_at']),
     Number(snapRow['entry_window_days']), String(snapRow['as_of']), String(snapRow['as_of_hlc']),
     new Date(String(snapRow['computed_at'])).toISOString()],
  );
  for (const b of bucketRows.rows as Record<string, unknown>[]) {
    await db.execute(
      `INSERT INTO credit_position_bucket (id, tenant_id, account_id, seq, label, from_dpd, to_dpd,
         amount_minor, as_of, as_of_hlc)
       VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, ?)`,
      [String(b['id']), claims.tid, accountId, Number(b['seq']), String(b['label']),
       b['from_dpd'] === null ? null : Number(b['from_dpd']),
       b['to_dpd'] === null ? null : Number(b['to_dpd']),
       String(b['amount_minor']), String(b['as_of']), String(b['as_of_hlc'])],
    );
  }
  for (const e of entryRows.rows as Record<string, unknown>[]) {
    await db.execute(
      `INSERT INTO credit_entry (id, tenant_id, account_id, kind, amount_minor, business_date,
         due_date, source_kind, source_id, applies_to_id, hlc, created_at)
       VALUES (?, ?, ?, ?, CAST(? AS INTEGER), ?, ?, NULL, NULL, NULL, ?, '')`,
      [String(e['id']), claims.tid, accountId, String(e['kind']), String(e['amount_minor']),
       String(e['business_date']), e['due_date'] === null ? null : String(e['due_date']), String(e['hlc'])],
    );
  }

  const foundAccount = await loadAccountIdForCustomer(db, customerId);
  check('A2 the device finds the account from the CUSTOMER id — the only id a device holds',
    foundAccount === accountId, `loadAccountIdForCustomer → ${String(foundAccount)}`);

  const read = await loadSyncedCreditPosition(db, accountId);
  check('A3 the device answers with a position, not "unavailable"',
    read.kind === 'synced_as_of', `kind=${read.kind}`);
  if (read.kind !== 'synced_as_of') throw new Error('device has no synced position');
  const pos = read.position;

  check('A4 the OFFLINE balance equals the ONLINE balance for the same entries',
    pos.balanceMinor === online.data.exposureMinor,
    `offline=${pos.balanceMinor} online=${online.data.exposureMinor}`);
  check('A5 …and both equal this file\'s own SQL sum over app.credit_entry',
    pos.balanceMinor === sqlBalance && online.data.exposureMinor === sqlBalance,
    `sql=${sqlBalance}`);
  check('A6 Σ(ageing buckets) − on-account + fee = balance, computed LOCALLY by the shared identity check',
    pos.agreement.kind === 'agrees',
    pos.agreement.kind === 'agrees'
      ? `${pos.buckets.map((b) => `${b.label}=${b.amountMinor}`).join(' ')} ⇒ ${pos.balanceMinor}`
      : `DISAGREES by ${String(pos.agreement.differenceMinor)}`);
  const localBucketSum = pos.buckets.reduce((a, b) => a + b.amountMinor, 0n);
  const onlineBucketSum = onlineAgeing.data.buckets.reduce((a, b) => a + b.amountMinor, 0n);
  check('A7 the device\'s ageing vector matches the server\'s ageing route, band for band',
    localBucketSum === onlineBucketSum &&
      pos.buckets.length === onlineAgeing.data.buckets.length &&
      pos.buckets.every((b, i) => b.amountMinor === onlineAgeing.data.buckets[i]?.amountMinor),
    `device Σ=${localBucketSum} server Σ=${onlineBucketSum} over ${String(pos.buckets.length)} bands`);
  check('A8 the windowing identity holds in bigint: opening_before_window + Σ(local live entries) = balance',
    pos.openingBeforeWindowMinor +
      (entryRows.rows as Record<string, unknown>[]).reduce((a, e) => a + BigInt(String(e['amount_minor'])), 0n)
      === pos.balanceMinor,
    `opening=${pos.openingBeforeWindowMinor} + Σ(${String(entryRows.rows.length)} local entries) = ${pos.balanceMinor}`);

  // ══ B — staleness stated, and no implied check ═══════════════════════════
  console.log('\nB · staleness');
  check('B1 the figure carries the date it was aged against and the server HLC it was evaluated through',
    pos.asOf !== '' && pos.asOfHlc !== '' && pos.computedAtMs !== null,
    `as_of=${pos.asOf} as_of_hlc=${pos.asOfHlc.slice(0, 20)}… computed_at=${String(pos.computedAtMs)}`);
  check('B2 the fee figure is labelled PROVISIONAL while no human has confirmed the fee policy',
    pos.feeProvisional, `fee_confirmed_at is ${snapRow['fee_confirmed_at'] === null ? 'null' : 'set'}`);
  check('B3 the window is stated, so a short statement can never read as "no activity"',
    pos.entryWindowDays > 0, `entry_window_days=${String(pos.entryWindowDays)}`);
  const lines = await loadStatementLines(db, accountId);
  check('B4 the statement lists entries and the device exposes no way to total them',
    lines.length === entryRows.rows.length,
    `${String(lines.length)} lines, opening_before_window ${pos.openingBeforeWindowMinor} carried separately`);

  // An entry the device holds that the snapshot does NOT include: it is
  // LISTED, and the balance does not move. Two server HLCs are compared.
  const laterHlc = `${'9'.repeat(13)}-99999-${'f'.repeat(32)}`;
  await db.execute(
    `INSERT INTO credit_entry (id, tenant_id, account_id, kind, amount_minor, business_date,
       due_date, source_kind, source_id, applies_to_id, hlc, created_at)
     VALUES ('since-1', ?, ?, 'CHARGE', CAST('999999' AS INTEGER), ?, ?, NULL, NULL, NULL, ?, '')`,
    [claims.tid, accountId, TODAY, TODAY, laterHlc],
  );
  const after = await loadSyncedCreditPosition(db, accountId);
  const afterPos = after.kind === 'synced_as_of' ? after.position : null;
  check('B5 an entry NEWER than the snapshot is listed as "recorded since", never added to the balance',
    afterPos !== null && afterPos.movementsSince.length === 1 &&
      afterPos.movementsSince[0]?.amountMinor === 999_999n &&
      afterPos.balanceMinor === pos.balanceMinor,
    afterPos === null ? 'no position' :
      `movementsSince=${String(afterPos.movementsSince.length)}, balance unchanged at ${afterPos.balanceMinor}`);

  // ══ C — suspension actually stops a credit sale ══════════════════════════
  console.log('\nC · suspension');
  const location = claims.locs[0] ?? '';
  const product = await sql.query<{ id: string }>(
    `select p.id::text from app.product p
       join app.product_uom pu on pu.tenant_id = p.tenant_id and pu.product_id = p.id
        and pu.is_default_sell and pu.deleted_at is null
       join app.price_list_item pli on pli.tenant_id = p.tenant_id and pli.product_id = p.id
        and pli.uom_id = pu.uom_id and pli.deleted_at is null
       join app.price_list pl on pl.tenant_id = p.tenant_id and pl.id = pli.price_list_id
        and pl.code = 'WHOLESALE'
      where p.tenant_id = $1 and p.deleted_at is null and p.is_sellable
      order by p.sku_code limit 1`, [claims.tid]);
  const productId = product.rows[0]?.id;
  check('C0 a priced, sellable product exists for the positive control',
    productId !== undefined, productId ?? 'NONE — the control below cannot be trusted');

  // Since 0020 a sale names its till (whose date is the sale's) and the
  // tenant's own tender methods. One shared till for today, opened by the
  // manager through the real route.
  const tenderIds = await liveTenderIds(
    async (q, params) => (await sql.query(q, params)).rows as never[],
    claims.tid,
  );
  const tills = new LiveTills(async (input) => {
    const o = await rawMutate('cashSession.open', input, managerToken);
    return { ok: o.status === 200, detail: `HTTP ${String(o.status)} ${JSON.stringify(o.body).slice(0, 160)}` };
  });
  const tillId = await tills.till(location, TODAY);
  const creditSale = (receiptNo: string) => ({
    idempotencyKey: key(), clientWallAt: new Date().toISOString(),
    locationId: location, cashSessionId: tillId, priceListCode: 'WHOLESALE', receiptNo,
    tenders: tenderLines('CREDIT', tenderIds), customerId,
    lines: [{ productId: productId ?? '', qty: '1' }],
  });

  // Positive control FIRST, while the account is ACTIVE.
  const activeSale = await rawMutate('sales.createSale', creditSale(`OFF-A-${stamp}`), managerToken);
  check('C1 POSITIVE CONTROL: a credit sale to an ACTIVE account succeeds on this route, this payload',
    activeSale.status === 200, `HTTP ${String(activeSale.status)}`);

  const suspended = await setCreditStatus({
    idempotencyKey: key(), clientWallAt: new Date().toISOString(),
    accountId, status: 'SUSPENDED', expectedStatus: 'ACTIVE',
    reason: 'D16 drill: stopped paying',
  }, options);
  check('C2 credit.setStatus moves the account ACTIVE → SUSPENDED through the real client',
    suspended.kind === 'changed' && suspended.result.status === 'SUSPENDED' && suspended.result.changed,
    suspended.kind === 'changed' ? `${suspended.result.fromStatus} → ${suspended.result.status}, change ${String(suspended.result.changeId)}`
      : `outcome=${suspended.kind}`);
  const dbStatus = await sql.query<{ s: string }>(
    `select status as s from app.customer_account where id = $1`, [accountId]);
  check('C3 …and Postgres agrees, read by this file',
    dbStatus.rows[0]?.s === 'SUSPENDED', `app.customer_account.status = ${String(dbStatus.rows[0]?.s)}`);

  const refused = await rawMutate('sales.createSale', creditSale(`OFF-S-${stamp}`), managerToken);
  const refusedText = JSON.stringify(refused.body);
  check('C4 a credit sale to the SUSPENDED account is REFUSED — same route, same payload shape',
    refused.status === 412 && refusedText.includes('SUSPENDED'),
    `HTTP ${String(refused.status)} — ${refusedText.slice(0, 160)}`);

  const cashSale = { ...creditSale(`OFF-C-${stamp}`), tenders: tenderLines('CASH', tenderIds) };
  const cashOk = await rawMutate('sales.createSale', cashSale, managerToken);
  check('C5 suspending CREDIT does not stop the customer buying for CASH (plan R4)',
    cashOk.status === 200, `HTTP ${String(cashOk.status)}`);

  // ══ E — the dark device, and what the counter sees on reconnect ══════════
  console.log('\nE · a device that was dark when the account was suspended');
  // What a dark till actually queues: the sale payload MINUS the envelope,
  // which the outbox row supplies — exactly the shape drainOutbox posts.
  const { idempotencyKey: _k, clientWallAt: _w, ...darkPayload } = creditSale(`OFF-D-${stamp}`);
  const darkSale = uploadOp('sale.create', 9, darkPayload);
  const drained = await uploadOps(managerToken, [darkSale]);
  const ack = drained.acks[0];
  check('E1 the batch is ACCEPTED as a batch — one bad op never refuses the envelope',
    drained.status === 200 && drained.acks.length === 1,
    `HTTP ${String(drained.status)}, ${String(drained.acks.length)} ack(s) — ${drained.raw}`);
  check('E2 MEASURED: what happens to a credit sale a dark device recorded before the suspension',
    ack !== undefined,
    ack === undefined ? 'no ack' : `status=${ack.status}${ack.reason === undefined ? '' : ` reason=${ack.reason}`}`);
  const landed = await sql.query<{ n: string }>(
    `select count(*)::text as n from app.sale where tenant_id = $1 and receipt_no = $2`,
    [claims.tid, `OFF-D-${stamp}`]);
  // PINNED, NOT ENDORSED. `docs/credit-offline-plan.md` R4 item 4 rules that a
  // credit sale arriving after a suspension is ACCEPTED and flagged, because
  // the goods are already gone. The shipped behaviour is the opposite: the op
  // is refused and no sale row is written. These two checks pin what the code
  // actually does, so building R4.4 turns them RED and forces this drill and
  // the status document to be updated together.
  check('E3 PINNED (diverges from plan R4.4): the sale is NOT written — the server keeps no record of goods that left the yard',
    landed.rows[0]?.n === '0' && ack?.status === 'rejected',
    `app.sale rows for receipt OFF-D-${stamp}: ${String(landed.rows[0]?.n)}; ack=${String(ack?.status)}`);
  const reviews = await sql.query<{ n: string }>(
    `select count(*)::text as n from app.conflict_review
      where tenant_id = $1 and conflict_class = 'credit_sale_after_suspension'`, [claims.tid]);
  check('E4 PINNED (diverges from plan R4.4): NO credit_sale_after_suspension review is raised',
    reviews.rows[0]?.n === '0', `conflict_review rows of that class: ${String(reviews.rows[0]?.n)}`);

  // What the COUNTER sees. The refusal is classified by the client's own
  // taxonomy, and PRECONDITION_FAILED is not in DEFINITIVE_PREFIXES — so the
  // op is NOT dead-lettered. It stays pending and is retried on every drain.
  check('E5 the client classifies this refusal RETRYABLE — the sale is not discarded, it stays queued',
    classifyRejection(ack?.reason) === 'retryable',
    `classifyRejection("${String(ack?.reason)}") = ${classifyRejection(ack?.reason)}`);

  // Proven with the REAL outbox and the REAL transport, not by reading the
  // table of prefixes: queue a credit sale for the suspended account, drain,
  // and look at what the row and the report say.
  const till = openTestDb();
  await provisionDevice(till, { locationId: location, locationCode: 'D16', priceListCode: 'WHOLESALE' });
  const darkKey = key();
  const { idempotencyKey: _k2, clientWallAt: _w2, ...queuedPayload } = creditSale(`OFF-Q-${stamp}`);
  await till.execute(
    `INSERT INTO outbox (id, idempotency_key, claimed_hlc, kind, payload, total_minor,
       receipt_no, created_at, queue_seq)
     VALUES (?, ?, ?, 'sale.create', ?, CAST('0' AS INTEGER), ?, ?, 1)`,
    [darkKey, darkKey, `${String(Date.now()).padStart(13, '0')}-00010-${'c'.repeat(32)}`,
     JSON.stringify(queuedPayload), `OFF-Q-${stamp}`, new Date().toISOString()],
  );
  const transport = httpUploadTransport({ apiUrl: API_URL, apiToken: managerToken, fetchFn: browserFetch });
  const pass1 = await drainOutbox(till, transport);
  const stillPending = await till.getAll(
    `SELECT rejected_at, reject_reason, server_ack_at FROM outbox WHERE id = ?`, [darkKey]);
  check('E6 REAL client drain: the op is deferred, the row stays pending, and the reason is legible to the counter',
    pass1.completed === 0 && pass1.rejected === 0 && pass1.deferred === 1 &&
      stillPending[0]?.['rejected_at'] === null && stillPending[0]?.['server_ack_at'] === null,
    `completed=${String(pass1.completed)} rejected=${String(pass1.rejected)} deferred=${String(pass1.deferred)}; rejected_at=${String(stillPending[0]?.['rejected_at'])}`);

  // Reactivate, drain the SAME row again: it lands, once, under its original
  // idempotency key. The sale is delayed by the suspension, never lost.
  await setCreditStatus({
    idempotencyKey: key(), clientWallAt: new Date().toISOString(),
    accountId, status: 'ACTIVE', expectedStatus: 'SUSPENDED', reason: 'D16 drill: reopen for E7',
  }, options);
  const pass2 = await drainOutbox(till, transport);
  const nowLanded = await sql.query<{ n: string }>(
    `select count(*)::text as n from app.sale where tenant_id = $1 and receipt_no = $2`,
    [claims.tid, `OFF-Q-${stamp}`]);
  check('E7 …and on the NEXT drain after reactivation the same queued sale lands, exactly once',
    pass2.completed === 1 && pass2.rejected === 0 && nowLanded.rows[0]?.n === '1',
    `completed=${String(pass2.completed)} rejected=${String(pass2.rejected)}; app.sale rows = ${String(nowLanded.rows[0]?.n)}`);
  // Put the account back where C6 expects to find it.
  await setCreditStatus({
    idempotencyKey: key(), clientWallAt: new Date().toISOString(),
    accountId, status: 'SUSPENDED', expectedStatus: 'ACTIVE', reason: 'D16 drill: restore for C6',
  }, options);

  // Reopen, so the fixture does not leave a suspended account behind.
  const reopened = await setCreditStatus({
    idempotencyKey: key(), clientWallAt: new Date().toISOString(),
    accountId, status: 'ACTIVE', expectedStatus: 'SUSPENDED', reason: 'D16 drill: reopen',
  }, options);
  check('C6 SUSPENDED → ACTIVE reopens, and the same credit sale then succeeds',
    reopened.kind === 'changed' &&
      (await rawMutate('sales.createSale', creditSale(`OFF-R-${stamp}`), managerToken)).status === 200,
    reopened.kind === 'changed' ? `${reopened.result.fromStatus} → ${reopened.result.status}` : `outcome=${reopened.kind}`);

  // ══ D — the meta sweep, and the fee gate ════════════════════════════════
  console.log('\nD · every credit read the client uses, swept for a superjson meta envelope');
  const reads: ReadonlyArray<{ route: string; input: unknown }> = [
    { route: 'credit.accountForCustomer', input: { customerId } },
    { route: 'credit.exposure', input: { accountId } },
    { route: 'credit.ageing', input: { accountId, asOf: TODAY } },
    { route: 'credit.previewFacilityFee', input: { accountId, asOf: TODAY } },
  ];
  let clean = 0;
  for (const rd of reads) {
    const res = await rawQuery(rd.route, rd.input, accountsToken);
    const metas = metaKeysIn(res.body);
    const ok = res.status === 200 && metas.length === 0;
    if (ok) clean += 1;
    check(`D1 ${rd.route} carries NO superjson meta envelope`, ok,
      `HTTP ${String(res.status)}${metas.length === 0 ? ', plain json' : `, META AT ${metas.join(', ')}`}`);
  }
  check('D2 the whole credit READ surface is meta-free', clean === reads.length,
    `${String(clean)}/${String(reads.length)}`);

  // The mutation replies the client also decodes — setStatus is new this pass.
  const statusReply = await rawMutate('credit.setStatus', {
    idempotencyKey: key(), clientWallAt: new Date().toISOString(),
    accountId, status: 'ACTIVE', expectedStatus: 'ACTIVE', reason: 'D16 meta sweep no-op',
  }, accountsToken);
  check('D3 credit.setStatus\'s REPLY carries no meta envelope (the route this pass added)',
    statusReply.status === 200 && metaKeysIn(statusReply.body).length === 0,
    `HTTP ${String(statusReply.status)}, meta=[${metaKeysIn(statusReply.body).join(', ')}]`);
  const noopDecoded = await setCreditStatus({
    idempotencyKey: key(), clientWallAt: new Date().toISOString(),
    accountId, status: 'ACTIVE', expectedStatus: 'ACTIVE', reason: 'D16 meta sweep no-op 2',
  }, options);
  check('D4 …and the CLIENT\'s own mapper decodes it — X → X is a no-op, not an error',
    noopDecoded.kind === 'changed' && !noopDecoded.result.changed && noopDecoded.result.changeId === null,
    noopDecoded.kind === 'changed' ? `changed=${String(noopDecoded.result.changed)} changeId=${String(noopDecoded.result.changeId)}`
      : `outcome=${noopDecoded.kind}`);

  console.log('\nD · the Q4 fee gate');
  const accrue = await rawMutate('credit.accrueFacilityFee',
    { idempotencyKey: key(), clientWallAt: new Date().toISOString(), accountId, asOf: TODAY }, accountsToken);
  const accrueText = JSON.stringify(accrue.body);
  check('D5 accrueFacilityFee still REFUSES — 412 FEE_POLICY_UNCONFIRMED',
    accrue.status === 412 && accrueText.includes('FEE_POLICY_UNCONFIRMED'),
    `HTTP ${String(accrue.status)} — ${accrueText.slice(0, 140)}`);
  const feeRows = await sql.query<{ n: string }>(
    `select count(*)::text as n from app.credit_entry where account_id = $1 and kind = 'FEE'`, [accountId]);
  check('D6 …and the account carries ZERO FEE rows', feeRows.rows[0]?.n === '0',
    `${String(feeRows.rows[0]?.n)} FEE entries`);

  await sql.end();
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n=== ${String(checks.length - failed.length)}/${String(checks.length)} checks passed ===`);
  console.log(`__DRILL_RESULT__ ${JSON.stringify({ drill: 'D16', total: checks.length, failed: failed.length, checks })}`);
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.map((c) => c.name).join('; ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('D16 fatal:', err);
  process.exit(1);
});
