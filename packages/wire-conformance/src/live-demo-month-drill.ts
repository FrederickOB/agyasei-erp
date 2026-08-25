/**
 * D18 — A MONTH OF TRADING, END TO END, OVER THE REAL WIRE.
 *
 *   pnpm stack:reset && pnpm dev:api
 *   pnpm --filter @erp/wire-conformance drill:demo-month
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═════════════════════════════════════════════════════════════════════════
 * Two jobs at once, and they are the same job.
 *
 * 1. **DEMO DATA.** Tenant #1 has not traded (open-questions Q21, answered
 *    2026-08-25), so every screen in this product renders an empty state on a
 *    fresh stack. A system nobody can look at is a system nobody can judge,
 *    and `CLAUDE.md` §3 asks each phase to end in a *demoable* system.
 *
 * 2. **THE §2.8 DRY RUN.** The blocking accountant gate needs "at least one
 *    full month of generated statements against manual expectations". That
 *    month does not have to be a month of REAL trading — it has to be a month
 *    of statements a professional can check. Generating it now means the
 *    reviewer has something waiting on day one instead of starting a
 *    month-long clock on arrival. **This is the only item on the go-live path
 *    that engineering could pull forward, and this drill is that pull.**
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT MAKES IT A DRILL RATHER THAN A SEEDER
 * ═════════════════════════════════════════════════════════════════════════
 * Every sale is rung through `POST /trpc/sales.createSale` against the
 * running API — server-priced from the tenant's own price list, taxed from the
 * jurisdiction pack in force on the business date, authorised by a real
 * principal's real grants. Nothing is inserted into `app.sale` directly. A
 * generator that wrote rows itself would produce data no code path had ever
 * agreed to, and every statement built on it would prove nothing.
 *
 * Then it SWEEPS the settled sales into the ledger and asserts the books
 * against the operational system, figure by figure. The reconciliation at the
 * end is the point: if `Σ(app.sale)` and the trial balance ever disagree, one
 * of them is lying, and that is precisely what the accountant's month is for.
 *
 * DETERMINISTIC. A seeded PRNG, so the same month regenerates identically —
 * the reviewer's manual expectation must be checkable twice.
 */
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';
import { provisionPrincipal } from '@erp/db/seed';
import { sweepSettledSales } from '@erp/db';

const API_URL = process.env['API_URL'] ?? 'http://127.0.0.1:3001';
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://erp:erp_dev@localhost:5433/erp';
const DEV_JWT_SECRET = process.env['DEV_JWT_SECRET'] ?? 'dev-secret-change-me';
const encoder = new TextEncoder();

/** August 2026 — period 1 of FY27, fully covered by the draft calendar. */
const MONTH_START = '2026-08-01';
const MONTH_END = '2026-08-31';
const DAYS = 31;

const checks: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
}

/**
 * Mulberry32. A named, seeded generator so this month is reproducible —
 * `Math.random()` would make the accountant's second look at the same month
 * a different month.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260801);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const between = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

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
const runner = { withTenant };

interface Principal {
  label: string;
  userId: string;
  bearer: string;
  locationIds: string[];
}

async function principal(
  tenantId: string,
  roleRef: string,
  scopeLocationId: string,
): Promise<Principal> {
  const userId = randomUUID();
  const provisioned = await withTenant(tenantId, (tx) =>
    provisionPrincipal(tx, tenantId, {
      userId,
      username: `demo-${roleRef}-${userId.slice(0, 8)}`,
      displayName: `Demo ${roleRef}`,
      roleRef,
      scopeLocationId,
    }),
  );
  const bearer = await new SignJWT({
    tid: tenantId,
    uid: userId,
    role: roleRef,
    locs: provisioned.locationIds,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(encoder.encode(DEV_JWT_SECRET));
  return { label: roleRef, userId, bearer, locationIds: provisioned.locationIds };
}

async function post(
  p: Principal,
  procedure: string,
  input: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown>; message: string }> {
  const res = await fetch(`${API_URL}/trpc/${procedure}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${p.bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
  const body = (await res.json().catch(() => null)) as {
    result?: { data?: { json?: Record<string, unknown> } };
    error?: { json?: { message?: string } };
  } | null;
  return {
    status: res.status,
    json: body?.result?.data?.json ?? {},
    message: body?.error?.json?.message ?? '',
  };
}

async function get(
  p: Principal,
  procedure: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ input: JSON.stringify({ json: input }) });
  const res = await fetch(`${API_URL}/trpc/${procedure}?${qs.toString()}`, {
    headers: { authorization: `Bearer ${p.bearer}` },
  });
  const body = (await res.json().catch(() => null)) as {
    result?: { data?: { json?: Record<string, unknown> } };
  } | null;
  return body?.result?.data?.json ?? {};
}

function isoDay(n: number): string {
  const d = new Date(Date.UTC(2026, 7, 1 + n));
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  await client.connect();
  console.log('=== D18 — a month of trading, end to end ===\n');

  const t = await client.query<{ id: string; slug: string }>(
    `select id, slug from platform.tenant where slug = 'agyasei-jnr'`,
  );
  const tenantId = t.rows[0]!.id;

  const root = (
    await client.query<{ id: string }>(
      `select id from app.location where tenant_id=$1 and code='ROOT'`, [tenantId])
  ).rows[0]!.id;
  const outlets = (
    await client.query<{ id: string; code: string }>(
      `select id, code from app.location where tenant_id=$1 and kind='OUTLET' and deleted_at is null
       order by code limit 3`, [tenantId])
  ).rows;
  const products = (
    await client.query<{ id: string; sku: string }>(
      `select p.id, p.sku_code as sku from app.product p
        join app.price_list_item i on i.tenant_id=p.tenant_id and i.product_id=p.id
        join app.price_list l on l.tenant_id=i.tenant_id and l.id=i.price_list_id and l.code='RETAIL'
       where p.tenant_id=$1 and p.is_sellable and p.deleted_at is null
       group by p.id, p.sku_code order by p.sku_code limit 40`, [tenantId])
  ).rows;

  check('fixture: outlets and priced products exist',
    outlets.length >= 2 && products.length >= 10,
    `${outlets.length} outlet(s), ${products.length} priced product(s)`);

  const manager = await principal(tenantId, 'outlet_manager', root);
  const accounts = await principal(tenantId, 'accounts', root);

  // ── A contractor to sell to on credit ────────────────────────────────────
  const customer = await post(accounts, 'credit.openAccount', {
    idempotencyKey: randomUUID(),
    newCustomer: { code: `DEMO-C${between(100, 999)}`, name: 'Demo Contractor Ltd' },
    termsDays: 30,
    feeRateBpPerMonth: 200,
    creditLimitMinor: '500000000',
  });
  check('a credit account opens over the wire', customer.status === 200,
    customer.status === 200 ? `customer ${String(customer.json['customerId']).slice(0, 8)}…` : customer.message);
  const customerId = customer.json['customerId'] as string;

  // ── The month ────────────────────────────────────────────────────────────
  console.log(`\n  ringing ${MONTH_START} .. ${MONTH_END} through sales.createSale …`);
  let rung = 0;
  let refused = 0;
  let cash = 0;
  let credit = 0;
  let receipt = 0;
  const firstRefusal: string[] = [];

  for (let day = 0; day < DAYS; day += 1) {
    const businessDate = isoDay(day);
    const isSunday = new Date(`${businessDate}T00:00:00Z`).getUTCDay() === 0;
    const salesToday = isSunday ? between(1, 3) : between(4, 9);

    for (let i = 0; i < salesToday; i += 1) {
      const outlet = pick(outlets);
      const onCredit = rand() < 0.25;
      const lineCount = between(1, 3);
      const lines = Array.from({ length: lineCount }, () => ({
        productId: pick(products).id,
        qty: String(between(1, 12)),
      }));
      receipt += 1;
      const res = await post(manager, 'sales.createSale', {
        idempotencyKey: randomUUID(),
        locationId: outlet.id,
        priceListCode: 'RETAIL',
        receiptNo: `DEMO-${outlet.code}-${String(receipt).padStart(5, '0')}`,
        businessDate,
        tender: onCredit ? 'CREDIT' : 'CASH',
        ...(onCredit ? { customerId } : {}),
        lines,
      });
      if (res.status === 200) {
        rung += 1;
        if (onCredit) credit += 1;
        else cash += 1;
      } else {
        refused += 1;
        if (firstRefusal.length < 3) firstRefusal.push(`${res.status} ${res.message.slice(0, 90)}`);
      }
    }
  }

  // A credit sale over the manager's own bound is REFUSED, and that is the
  // system working — recorded rather than hidden, because a demo month with
  // no refusals in it would misrepresent how the product behaves.
  check('a month of sales is rung through the REAL sale route',
    rung > 100 && refused < rung,
    `${rung} applied (${cash} cash, ${credit} credit), ${refused} refused${
      firstRefusal.length > 0 ? ` — e.g. ${firstRefusal[0]}` : ''}`);

  // ── A payment against the credit book, mid-month ─────────────────────────
  // The contract takes an ACCOUNT id, not a customer id, and a payment is
  // SIGNED NEGATIVE (`ce_sign`: CHARGE > 0, PAYMENT < 0). Both were wrong on
  // the first run of this drill and the API refused — which is the drill
  // doing its job: a generator that wrote rows directly would have produced a
  // payment no contract had ever agreed to.
  const paid = await post(accounts, 'credit.recordEntry', {
    idempotencyKey: randomUUID(),
    accountId: customer.json['accountId'] as string,
    kind: 'PAYMENT',
    amountMinor: '-5000000',
    businessDate: isoDay(20),
  });
  check('a contractor payment is recorded against the book', paid.status === 200,
    paid.status === 200 ? 'GH₵50,000 paid, signed negative per ce_sign' : paid.message.slice(0, 120));

  // ── Sweep: settled sales -> the ledger ───────────────────────────────────
  console.log('\n  sweeping settled sales into the ledger …');
  const swept = await sweepSettledSales(runner, {
    tenantId,
    postedBy: accounts.userId,
    postingRuleVersion: 1,
  });
  check('every settled sale reaches the books, or opens a visible exception',
    swept.posted > 0 && swept.posted + swept.exceptions === swept.examined,
    `examined ${swept.examined}, posted ${swept.posted}, exceptions ${swept.exceptions}`);

  // ── THE RECONCILIATION — books vs the operational system ─────────────────
  const sale = (
    await withTenant(tenantId, (tx) =>
      tx.query<{ net: string; tax: string; disc: string; cash_total: string; credit_total: string; n: string }>(
        `select coalesce(sum(subtotal_net_minor),0)::text net,
                coalesce(sum(tax_total_minor),0)::text tax,
                coalesce(sum(discount_minor),0)::text disc,
                coalesce(sum(total_minor) filter (where not exists
                  (select 1 from app.credit_entry ce where ce.source_kind='SALE'
                     and ce.source_id=s.id and ce.kind='CHARGE')),0)::text cash_total,
                coalesce(sum(total_minor) filter (where exists
                  (select 1 from app.credit_entry ce where ce.source_kind='SALE'
                     and ce.source_id=s.id and ce.kind='CHARGE')),0)::text credit_total,
                count(*)::text n
           from app.sale s where s.deleted_at is null and s.voids_sale_id is null`))
  ).rows[0]!;

  const ledger = new Map(
    (await withTenant(tenantId, (tx) =>
      tx.query<{ code: string; net: string }>(
        `select a.code, (sum(l.debit_minor)-sum(l.credit_minor))::text net
           from app.journal_line l
           join app.gl_account a on a.tenant_id=l.tenant_id and a.id=l.account_id
           join app.journal_entry e on e.tenant_id=l.tenant_id and e.id=l.journal_entry_id
          where e.status='posted' group by a.code`))).rows.map((r) => [r.code, BigInt(r.net)]),
  );

  check('REVENUE: the ledger equals Σ(sale.subtotal_net) exactly',
    -(ledger.get('4100') ?? 0n) === BigInt(sale.net),
    `ledger ${-(ledger.get('4100') ?? 0n)} vs sales ${sale.net}`);
  check('OUTPUT TAX: the ledger equals Σ(sale.tax_total) exactly',
    -(ledger.get('2200') ?? 0n) === BigInt(sale.tax),
    `ledger ${-(ledger.get('2200') ?? 0n)} vs sales ${sale.tax}`);
  check('TILL: the ledger equals Σ(cash sale totals) exactly',
    (ledger.get('1000') ?? 0n) === BigInt(sale.cash_total),
    `ledger ${ledger.get('1000') ?? 0n} vs cash sales ${sale.cash_total}`);
  check('RECEIVABLES: the ledger equals Σ(credit sale totals) exactly',
    (ledger.get('1400') ?? 0n) === BigInt(sale.credit_total),
    `ledger ${ledger.get('1400') ?? 0n} vs credit sales ${sale.credit_total}`);

  // ── The statements, read the way a reviewer will read them ───────────────
  const tb = await get(accounts, 'ledger.trialBalance', {});
  const byLocation = (tb['byLocation'] ?? []) as { locationId: string; balanced: boolean }[];
  check('the trial balance sums to zero for the tenant',
    tb['balanced'] === true, `Dr ${String(tb['debitMinor'])} / Cr ${String(tb['creditMinor'])}`);
  check('…and for EVERY location independently — §5.9.2',
    byLocation.length > 0 && byLocation.every((l) => l.balanced),
    `${byLocation.length} location(s), all balanced`);

  const pl = await get(accounts, 'ledger.profitAndLoss', {});
  const bs = await get(accounts, 'ledger.balanceSheet', {});
  check('the two statements agree about one ledger',
    bs['reconciles'] === true,
    `balance-sheet gap ${String(bs['gapMinor'])} === P&L result ${String(pl['resultMinor'])}`);

  check('COGS is ABSENT — Q16 is a gate, not a default',
    (ledger.get('5000') ?? 0n) === 0n,
    'no cost of sales posted; gross profit is not readable until the costing method is decided');

  // ── Isolation, live, on the same stack ───────────────────────────────────
  const tB = await client.query<{ id: string }>(
    `select id from platform.tenant where slug = 'kumasi-builders'`);
  if (tB.rows[0]) {
    // The root by STRUCTURE (parent_id is null), not by the code 'ROOT' —
    // tenant B ships a different template and its top node is not called
    // that. Keying on a code would be tenant vocabulary deciding a platform
    // lookup, which is the §2.9 mistake in miniature; the first run of this
    // drill made it and crashed here.
    const rootB = (
      await client.query<{ id: string }>(
        `select id from app.location
          where tenant_id=$1 and parent_id is null and deleted_at is null limit 1`,
        [tB.rows[0].id])
    ).rows[0]?.id;
    if (rootB === undefined) {
      check('tenant B sees NONE of this month — isolation, on the live stack', false,
        'tenant B has no location tree root — fixture problem, not an isolation result');
    } else {
      const accountsB = await principal(tB.rows[0].id, 'accounts', rootB);
      const tbB = await get(accountsB, 'ledger.trialBalance', {});
      check('tenant B sees NONE of this month — isolation, on the live stack',
        tbB['accountCount'] === 0 && (tbB['rows'] as unknown[]).length === 0,
        `tenant B: ${String(tbB['accountCount'])} accounts, ${(tbB['rows'] as unknown[]).length} rows` +
          ` (tenant A: ${String(tb['accountCount'])} accounts)`);
    }
  }

  const passed = checks.filter((c) => c.pass).length;
  console.log(`\n=== D18: ${passed}/${checks.length} checks passed ===`);
  console.log(
    `    ${sale.n} sales · net ${sale.net} · tax ${sale.tax} · ` +
      `${MONTH_START}..${MONTH_END} · reproducible (seed 20260801)`,
  );
  console.log(
    `__DRILL_RESULT__ ${JSON.stringify({ drill: 'D18-demo-month', passed, total: checks.length, checks })}`,
  );
  await client.end();
  if (passed !== checks.length) process.exitCode = 1;
}

void main();
