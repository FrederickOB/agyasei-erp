/**
 * D9 — ACCEPTANCE CRITERION 3, OVER A REAL SOCKET.
 *
 *   pnpm stack:up
 *   pnpm --filter @erp/api dev:stack          # API on :3001
 *   pnpm --filter @erp/wire-conformance drill:credit
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE CRITERION, VERBATIM (CLAUDE.md §3)
 * ═════════════════════════════════════════════════════════════════════════
 *   "A customer's credit balance, ageing and facility fee are all visible and
 *    correct after a mix of cash and credit sales across multiple locations."
 *
 * It is the one of the five that has never been demonstrated. Every previous
 * revision of `docs/phase1-status.md` recorded it as "TESTED, NOT YET FULLY
 * DEMONSTRATED", and the tests it referred to are `apps/api/test/credit.test.ts`
 * — in-process, on PGlite, against carts the test wrote itself. Those tests are
 * good and they are not this: nothing in them rings a sale at two different
 * outlets through the real router over a real socket and then asks the real
 * read paths what the customer owes.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT THIS DRILL PROVES, AND WHAT IT DELIBERATELY DOES NOT
 * ═════════════════════════════════════════════════════════════════════════
 * PROVES, with measured figures printed for the report:
 *   1. Cash sales at two outlets create NO credit exposure. The obvious way to
 *      get a wrong right-looking answer is to total sales instead of entries,
 *      and it would pass a test that only ever rang credit sales.
 *   2. Credit sales at two DIFFERENT outlets both land on the ONE tenant-level
 *      account, and exposure is their exact bigint sum. A credit account
 *      belongs to the tenant, not to an outlet — that is why the capability
 *      that opens one is checked tenant-wide — and this is the assertion that
 *      would fail if exposure were ever scoped to a location.
 *   3. Exposure is DERIVED: Σ(app.credit_entry.amount_minor) read straight out
 *      of Postgres equals what the API answers. Never a counter.
 *   4. `availableMinor` = limit − exposure, exactly.
 *   5. Ageing is by DAYS PAST DUE from each charge's own due date, and
 *      Σ(buckets) = exposure exactly — the parts add up to the whole.
 *   6. A part payment moves the right invoice into the right bucket and leaves
 *      the other where it was: the two sales are aged INDEPENDENTLY, which is
 *      the thing a single-invoice test cannot show.
 *
 * DOES NOT PROVE, and says so out loud rather than quietly passing:
 *   - **The facility fee is GATED (Q4).** `credit.accrueFacilityFee` fails
 *     closed until a qualified human confirms the five fee decisions
 *     (docs/open-questions.md Q4), and `previewFacilityFee` labels every
 *     figure provisional. This drill asserts the gate HOLDS — a refusal is
 *     the correct behaviour and a silent posting would be the bug — so what
 *     is demonstrated is "the fee is visible and correctly refuses to be
 *     chargeable", not "the fee is correct". The criterion is not met on that
 *     third clause and the drill's summary says so.
 *   - **The credit book is not synced to devices.** These reads are ONLINE.
 *     Until the RBAC sync-rule swap lands, `app.credit_entry` is deliberately
 *     absent from every bucket (fail-closed), so an outlet that is partitioned
 *     cannot see a customer's balance at all. Stated here because "visible"
 *     in an offline-first product has to mean visible from the till.
 *
 * Prints `__DRILL_RESULT__ {json}` in the same shape as D8. Non-zero exit on
 * any failed check.
 */
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';

import { provisionPrincipal } from '@erp/db/seed';
import { LiveTills, liveTenderIds, tenderLines } from './live-tills.js';

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

const client = new pg.Client({ connectionString: DATABASE_URL });

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

interface Principal {
  label: string;
  userId: string;
  bearer: string;
  locationIds: string[];
}

async function makePrincipal(
  tenantId: string,
  label: string,
  roleRef: string,
  scopeLocationId: string,
): Promise<Principal> {
  const userId = randomUUID();
  const provisioned = await withTenant(tenantId, (tx) =>
    provisionPrincipal(tx, tenantId, {
      userId,
      username: `credit-drill-${label}-${userId.slice(0, 8)}`,
      displayName: `Credit drill ${label}`,
      roleRef,
      scopeLocationId,
    }),
  );
  const bearer = await new SignJWT({
    tid: tenantId,
    uid: userId,
    role: 'a tenant-chosen job title the platform never reads',
    locs: provisioned.locationIds,
    dev: randomUUID(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(encoder.encode(DEV_JWT_SECRET));
  return { label, userId, bearer, locationIds: provisioned.locationIds };
}

interface Outcome {
  status: number;
  errorCode: string | null;
  message: string;
  body: unknown;
}

function parseOutcome(status: number, body: unknown): Outcome {
  const err = (body as { error?: { json?: { message?: string; data?: { code?: string } } } })?.error
    ?.json;
  return { status, errorCode: err?.data?.code ?? null, message: err?.message ?? '', body };
}

async function callMutation(
  p: Principal,
  procedure: string,
  input: Record<string, unknown>,
): Promise<Outcome> {
  const res = await fetch(`${API_URL}/trpc/${procedure}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${p.bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
  return parseOutcome(res.status, await res.json().catch(() => null));
}

async function callQuery(
  p: Principal,
  procedure: string,
  input: Record<string, unknown>,
): Promise<Outcome> {
  const qs = new URLSearchParams({ input: JSON.stringify({ json: input }) });
  const res = await fetch(`${API_URL}/trpc/${procedure}?${qs.toString()}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${p.bearer}` },
  });
  return parseOutcome(res.status, await res.json().catch(() => null));
}

function payload(o: Outcome): Record<string, unknown> {
  return (
    ((o.body as { result?: { data?: { json?: Record<string, unknown> } } })?.result?.data?.json) ??
    {}
  );
}

function must(o: Outcome, what: string): Record<string, unknown> {
  if (o.status !== 200) throw new Error(`${what} failed: HTTP ${o.status} ${o.message}`);
  return payload(o);
}

/** Business dates as plain UTC calendar arithmetic — never a device clock. */
function addDays(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log('=== D9 — credit balance, ageing and the fee gate, over the real wire ===');
  await client.connect();

  const tenants = (await import('../../../infra/dev-tenants.json', { with: { type: 'json' } }))
    .default as { tenantA: { id: string } };
  const tenantId = tenants.tenantA.id;

  const [root, regBono, out01, out03] = await Promise.all([
    locationByCode(tenantId, 'ROOT'),
    locationByCode(tenantId, 'REG-BONO'),
    locationByCode(tenantId, 'OUT-01'),
    locationByCode(tenantId, 'OUT-03'),
  ]);

  // The seller is a REGIONAL manager granted once at REG-BONO: one grant, two
  // outlets, expanded through the closure. That is what makes this a
  // cross-location demonstration rather than two unrelated ones — and its
  // `sale.record.credit` bound is GH₵20,000, comfortably above both carts.
  const seller = await makePrincipal(tenantId, 'seller', 'regional_manager', regBono);
  // Accounts, at the root, is the only role that may open an account with a
  // limit (D8 check 2). Segregation of duties: it cannot ring the sales.
  const accounts = await makePrincipal(tenantId, 'accounts', 'accounts', root);

  const product = (
    await client.query<{ id: string; sku_code: string }>(
      `select p.id, p.sku_code
         from app.price_list_item pli
         join app.price_list pl
           on pl.tenant_id = pli.tenant_id and pl.id = pli.price_list_id and pl.code = 'WHOLESALE'
         join app.product p
           on p.tenant_id = pli.tenant_id and p.id = pli.product_id
        where pli.tenant_id = $1 and p.stock_tracking = 'STOCKED' and p.deleted_at is null
        order by pli.unit_price_e4 desc
        limit 1`,
      [tenantId],
    )
  ).rows[0];
  if (!product) throw new Error('tenant A has no WHOLESALE-priced stocked product');
  const productId = product.id;

  const TERMS_DAYS = 30;
  const LIMIT = 5_000_000n; // GH₵50,000
  const opened = must(
    await callMutation(accounts, 'credit.openAccount', {
      idempotencyKey: randomUUID(),
      newCustomer: { code: `D9-${Date.now()}`, name: 'D9 drill contractor' },
      termsDays: TERMS_DAYS,
      feeRateBpPerMonth: 200,
      creditLimitMinor: LIMIT.toString(10),
    }),
    'credit.openAccount',
  );
  const accountId = String(opened['accountId']);
  const customerId = String(opened['customerId']);

  // Both sales are rung on the SAME business date so the two charges share a
  // due date and the ageing assertion below is about the buckets, not about a
  // date the drill happened to pick.
  const businessDate = new Date().toISOString().slice(0, 10);
  const dueDate = addDays(businessDate, TERMS_DAYS);

  // Since 0020 a sale names its till and its tender methods. The seller opens
  // one shared till per outlet for the day; the methods are the tenant's own.
  const tenderIds = await liveTenderIds(
    async (sql, params) => (await client.query(sql, params)).rows as never[],
    tenantId,
  );
  const tills = new LiveTills(async (input) => {
    const o = await callMutation(seller, 'cashSession.open', input);
    return { ok: o.status === 200, detail: `HTTP ${o.status} ${o.message}` };
  });
  const till01 = await tills.till(out01, businessDate);
  const till03 = await tills.till(out03, businessDate);

  function sale(
    locationId: string,
    qty: string,
    tender: 'CASH' | 'CREDIT',
  ): Record<string, unknown> {
    return {
      idempotencyKey: randomUUID(),
      locationId,
      cashSessionId: locationId === out01 ? till01 : till03,
      priceListCode: 'WHOLESALE',
      receiptNo: `D9-${randomUUID().slice(0, 12)}`,
      tenders: tenderLines(tender, tenderIds),
      ...(tender === 'CREDIT' ? { customerId } : {}),
      lines: [{ productId, qty }],
    };
  }

  // -- the mix: cash and credit, at two different outlets -------------------
  const cash01 = must(await callMutation(seller, 'sales.createSale', sale(out01, '2', 'CASH')), 'cash @ OUT-01');
  const credit01 = must(await callMutation(seller, 'sales.createSale', sale(out01, '3', 'CREDIT')), 'credit @ OUT-01');
  const cash03 = must(await callMutation(seller, 'sales.createSale', sale(out03, '1', 'CASH')), 'cash @ OUT-03');
  const credit03 = must(await callMutation(seller, 'sales.createSale', sale(out03, '4', 'CREDIT')), 'credit @ OUT-03');

  const cashTotal = BigInt(String(cash01['totalMinor'])) + BigInt(String(cash03['totalMinor']));
  const creditTotal =
    BigInt(String(credit01['totalMinor'])) + BigInt(String(credit03['totalMinor']));
  console.log(
    `  [setup] ${product.sku_code}: OUT-01 cash ${cash01['totalMinor']} + credit ${credit01['totalMinor']}, ` +
      `OUT-03 cash ${cash03['totalMinor']} + credit ${credit03['totalMinor']} (business date ${businessDate}, due ${dueDate})`,
  );

  // -- 1. the balance -------------------------------------------------------
  const exposure = must(await callQuery(accounts, 'credit.exposure', { accountId }), 'credit.exposure');
  const exposureMinor = BigInt(String(exposure['exposureMinor']));
  check(
    '1a. exposure is the exact bigint sum of the two CREDIT sales, rung at two different outlets',
    exposureMinor === creditTotal && creditTotal > 0n,
    `${exposureMinor} = ${credit01['totalMinor']} (OUT-01) + ${credit03['totalMinor']} (OUT-03)`,
  );
  check(
    '1b. the CASH sales at both outlets created NO exposure — takings are not lending',
    exposureMinor === creditTotal && cashTotal > 0n,
    `${cashTotal} of cash trade at the same two counters is absent from the balance`,
  );
  check(
    '1c. availableMinor = limit − exposure, exactly',
    BigInt(String(exposure['availableMinor'])) === LIMIT - exposureMinor,
    `${exposure['availableMinor']} = ${LIMIT} − ${exposureMinor}`,
  );

  // -- 2. it is DERIVED, not a stored counter -------------------------------
  const ledger = await withTenant(tenantId, async (tx) => {
    const r = await tx.query<{ total: string; n: string; locs: string }>(
      `select coalesce(sum(amount_minor), 0)::text as total,
              count(*)::text                       as n,
              count(distinct s.location_id)::text  as locs
         from app.credit_entry e
         left join app.sale s on s.tenant_id = e.tenant_id and s.id = e.source_id and e.source_kind = 'SALE'
        where e.account_id = $1`,
      [accountId],
    );
    return r.rows[0]!;
  });
  check(
    '2a. the API figure equals Σ(app.credit_entry) read straight out of Postgres — derived, never a counter',
    BigInt(ledger.total) === exposureMinor,
    `database ${ledger.total} === API ${exposureMinor} over ${ledger.n} entries`,
  );
  check(
    '2b. the entries trace back to sales at TWO distinct locations on ONE tenant-level account',
    ledger.locs === '2',
    `distinct sale locations behind the entries: ${ledger.locs} (a credit account belongs to the tenant, not an outlet)`,
  );

  // -- 3. ageing ------------------------------------------------------------
  // 16 days past a 30-day due date: both charges are overdue, in the same
  // bucket, and the buckets must add up to the balance.
  const asOfOverdue = addDays(dueDate, 16);
  const aged = must(
    await callQuery(accounts, 'credit.ageing', { accountId, asOf: asOfOverdue }),
    'credit.ageing',
  );
  const buckets = aged['buckets'] as { label: string; amountMinor: string }[];
  const bucketSum = buckets.reduce((s, b) => s + BigInt(b.amountMinor), 0n);
  const invoices = aged['invoices'] as { daysPastDue: number; outstandingMinor: string; bucket: string }[];
  check(
    '3a. Σ(ageing buckets) = the balance, exactly — the parts add up to the whole',
    bucketSum === exposureMinor,
    `${bucketSum} across ${buckets.length} buckets === exposure ${exposureMinor}`,
  );
  check(
    '3b. both credit sales are aged as separate invoices, by DAYS PAST DUE from their own due date',
    invoices.length === 2 && invoices.every((i) => i.daysPastDue === 16),
    `${invoices.length} invoice(s), dpd=[${invoices.map((i) => i.daysPastDue).join(', ')}], ` +
      `bucket(s)=[${[...new Set(invoices.map((i) => i.bucket))].join(', ')}], agedBy=${String(aged['agedBy'])}`,
  );
  const asOfCurrent = addDays(businessDate, 1);
  const agedCurrent = must(
    await callQuery(accounts, 'credit.ageing', { accountId, asOf: asOfCurrent }),
    'credit.ageing (current)',
  );
  const currentInvoices = agedCurrent['invoices'] as { daysPastDue: number; bucket: string }[];
  check(
    '3c. …and the SAME account read one day after the sale is CURRENT — ageing moves with the as-of date',
    currentInvoices.length === 2 && currentInvoices.every((i) => i.daysPastDue <= 0),
    `dpd=[${currentInvoices.map((i) => i.daysPastDue).join(', ')}], ` +
      `bucket(s)=[${[...new Set(currentInvoices.map((i) => i.bucket))].join(', ')}]`,
  );

  // -- 4. a payment applied to ONE invoice ----------------------------------
  //
  // The sharpest ageing assertion available: settle the OUT-01 charge and
  // nothing else. If the two sales were being aged as one lump, this moves
  // both or neither.
  const charge01 = await withTenant(tenantId, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `select e.id from app.credit_entry e
         join app.sale s
           on s.tenant_id = e.tenant_id and s.id = e.source_id and e.source_kind = 'SALE'
        where e.account_id = $1 and s.location_id = $2 and e.kind = 'CHARGE'`,
      [accountId, out01],
    );
    return r.rows[0]?.id ?? null;
  });
  if (!charge01) throw new Error('no CHARGE entry found for the OUT-01 credit sale');

  const paid = BigInt(String(credit01['totalMinor']));
  must(
    await callMutation(accounts, 'credit.recordEntry', {
      idempotencyKey: randomUUID(),
      accountId,
      kind: 'PAYMENT',
      amountMinor: (-paid).toString(10),
      businessDate: asOfOverdue,
      appliesToId: charge01,
    }),
    'credit.recordEntry (payment)',
  );

  const afterPay = must(await callQuery(accounts, 'credit.exposure', { accountId }), 'exposure after payment');
  const agedAfter = must(
    await callQuery(accounts, 'credit.ageing', { accountId, asOf: asOfOverdue }),
    'ageing after payment',
  );
  const afterInvoices = agedAfter['invoices'] as { outstandingMinor: string }[];
  const afterBuckets = (agedAfter['buckets'] as { amountMinor: string }[]).reduce(
    (s, b) => s + BigInt(b.amountMinor),
    0n,
  );
  check(
    '4a. a payment applied to the OUT-01 charge clears that invoice and leaves OUT-03 aged where it was',
    afterInvoices.length === 1 &&
      BigInt(afterInvoices[0]!.outstandingMinor) === BigInt(String(credit03['totalMinor'])),
    `1 invoice left, outstanding ${afterInvoices[0]?.outstandingMinor} === the OUT-03 sale ${credit03['totalMinor']}`,
  );
  check(
    '4b. balance and buckets both fall by exactly the amount paid, and still agree',
    BigInt(String(afterPay['exposureMinor'])) === exposureMinor - paid &&
      afterBuckets === exposureMinor - paid,
    `exposure ${afterPay['exposureMinor']} === buckets ${afterBuckets} === ${exposureMinor} − ${paid}`,
  );

  // -- 5. the facility fee: VISIBLE, PROVISIONAL, AND REFUSING TO POST ------
  const preview = must(
    await callQuery(accounts, 'credit.previewFacilityFee', { accountId, asOf: asOfOverdue }),
    'credit.previewFacilityFee',
  );
  check(
    '5a. the facility fee is VISIBLE in shadow mode, and every figure is labelled provisional',
    preview['provisional'] === true && String(preview['label']).includes('provisional'),
    `provisional=${String(preview['provisional'])} label="${String(preview['label'])}" ` +
      `totalDelta=${String(preview['totalDeltaMinor'])} over ${(preview['accruals'] as unknown[]).length} accrual(s)`,
  );
  const accrue = await callMutation(accounts, 'credit.accrueFacilityFee', {
    idempotencyKey: randomUUID(),
    accountId,
    asOf: asOfOverdue,
  });
  check(
    '5b. …and posting it FAILS CLOSED on the Q4 human gate — the refusal is the correct behaviour',
    accrue.status !== 200,
    `HTTP ${accrue.status} ${accrue.errorCode ?? '-'} "${accrue.message.slice(0, 150)}"`,
  );
  const feeRows = await withTenant(tenantId, async (tx) => {
    const r = await tx.query<{ n: string }>(
      `select count(*)::text as n from app.credit_entry where account_id = $1 and kind = 'FEE'`,
      [accountId],
    );
    return r.rows[0]!.n;
  });
  check(
    '5c. nothing was posted: the account carries ZERO fee entries, so no customer can be billed a guess',
    feeRows === '0',
    `app.credit_entry FEE rows for this account: ${feeRows}`,
  );

  await client.end();

  const failed = checks.filter((c) => !c.pass);
  const summary = {
    drill: 'D9-credit-live',
    passed: checks.length - failed.length,
    total: checks.length,
    /**
     * The honest verdict, carried in the machine-readable result so a report
     * generator cannot summarise this drill as a plain green tick.
     */
    criterion3: {
      balance: 'DEMONSTRATED',
      ageing: 'DEMONSTRATED',
      facilityFee: 'GATED — Q4 unconfirmed; visible and provisional, refuses to post',
      caveat:
        'These reads are ONLINE. Migration 0013 added the tenant_credit bucket, so a credit.view ' +
        'holder now ALSO has a synced, server-derived position offline (drill:credit-offline, D16 ' +
        'A1-A8; sync-drills D8 for who receives it). A counter device still does not: it gets a ' +
        'bounded credit_allowance and no balance at all, and that table is unpopulated until 06 ' +
        'section 6.7 cap leases exist — so a partitioned OUTLET still cannot see a balance.',
    },
    checks,
  };
  console.log(`__DRILL_RESULT__ ${JSON.stringify(summary)}`);
  console.log(`=== ${summary.passed}/${summary.total} credit checks passed over real HTTP ===`);
  console.log(
    '=== criterion 3: balance DEMONSTRATED, ageing DEMONSTRATED, facility fee GATED on Q4 ===',
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error('credit drill fatal:', err);
  await client.end().catch(() => undefined);
  process.exit(1);
});
