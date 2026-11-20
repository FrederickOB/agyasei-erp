/**
 * TILLS AND TENDERS AT THE SQL LEVEL — migrations 0020, 0021, 0022.
 *
 * Everything here runs as `app_user` with the tenant GUC set (RLS genuinely
 * applies), except the backfill suite, which drives the migration runner
 * itself against a database frozen at 0019 — the only honest way to prove a
 * backfill is to run it over data written before it existed.
 *
 * Every refusal has a positive control beside it: a suite in which everything
 * is refused passes just as well when the fixture is broken.
 */
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import { migrate, MIGRATIONS_DIR, type SqlClient } from '../src/migrate.js';
import { seedGhanaJurisdiction } from '../src/seed/ghana.js';
import type { Queryable, TestDb } from '../src/testing/harness.js';
import { makeLocation } from './rbac-fixtures.js';
import { newWrite, nextHlc, setupDb, setupTwoTenants, TENANT_A, TENANT_B } from './util.js';

let db: TestDb;
let locA: string;
let locB: string;
const DEVICE = '018f0000-0000-7000-8000-00000000d001';
const USER = '018f0000-0000-7000-8000-00000000e001';

async function tenderMethod(
  tx: Queryable,
  tenantId: string,
  code: string,
  postingRole: string,
  requiresReference = false,
): Promise<string> {
  const id = uuidv7();
  const w = await newWrite(tx, tenantId, 'test.tender_method');
  await tx.query(
    `insert into app.tender_method
       (tenant_id, id, write_id, hlc, code, name, posting_role, requires_reference)
     values ($1, $2, $3, $4, $5, $5, $6, $7)`,
    [tenantId, id, w, nextHlc(), code, postingRole, requiresReference],
  );
  return id;
}

async function openSession(
  tx: Queryable,
  tenantId: string,
  locationId: string,
  opts: { businessDate?: string; deviceId?: string | null; floatMinor?: bigint; contested?: string } = {},
): Promise<string> {
  const id = uuidv7();
  const w = await newWrite(tx, tenantId, 'test.cash_session.open');
  await tx.query(
    `insert into app.cash_session
       (tenant_id, id, write_id, hlc, location_id, device_id, business_date, server_date_at_open,
        opened_by, opened_at, opened_offline, opening_float_minor, contested_session_id)
     values ($1, $2, $3, $4, $5, $6, $7::date, $7::date, $8, transaction_timestamp(), false, $9, $10)`,
    [
      tenantId, id, w, nextHlc(), locationId,
      opts.deviceId === undefined ? DEVICE : opts.deviceId,
      opts.businessDate ?? '2026-12-01', USER, (opts.floatMinor ?? 20_000n).toString(10),
      opts.contested ?? null,
    ],
  );
  return id;
}

async function closeSession(
  tx: Queryable,
  tenantId: string,
  id: string,
  f: { expected: bigint; counted: bigint | null; variance: bigint | null; banked?: bigint | null; auto?: boolean },
): Promise<void> {
  const w = await newWrite(tx, tenantId, 'test.cash_session.close');
  await tx.query(
    `update app.cash_session
        set status = 'CLOSED', closed_by = $2, closed_at = transaction_timestamp(),
            auto_closed = $3, counted_minor = $4, banked_minor = $5,
            expected_cash_minor = $6, variance_minor = $7, close_write_id = $8, hlc = $9
      where id = $1`,
    [
      id, USER, f.auto ?? false,
      f.counted === null ? null : f.counted.toString(10),
      f.banked === undefined || f.banked === null ? null : f.banked.toString(10),
      f.expected.toString(10),
      f.variance === null ? null : f.variance.toString(10),
      w, nextHlc(),
    ],
  );
}

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);
  locA = await db.withTenant(TENANT_A, (tx) => makeLocation(tx, TENANT_A, { code: 'TILL-A1' }));
  locB = await db.withTenant(TENANT_B, (tx) => makeLocation(tx, TENANT_B, { code: 'TILL-B1' }));
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('tender_method — the platform reads the ROLE, never the tenant’s words', () => {
  it('is_cash and is_on_account are DERIVED from the posting role', async () => {
    const rows = await db.withTenant(TENANT_A, async (tx) => {
      await tenderMethod(tx, TENANT_A, 'NOTES-AND-COINS', 'TILL_CASH');
      await tenderMethod(tx, TENANT_A, 'WALLET', 'MOMO_WALLET', true);
      await tenderMethod(tx, TENANT_A, 'TAB', 'AR_TRADE');
      const r = await tx.query<{ code: string; is_cash: boolean; is_on_account: boolean }>(
        `select code, is_cash, is_on_account from app.tender_method order by code`,
      );
      return r.rows;
    });
    // The codes are deliberately not any template's: nothing keys off them.
    expect(rows).toEqual([
      { code: 'NOTES-AND-COINS', is_cash: true, is_on_account: false },
      { code: 'TAB', is_cash: false, is_on_account: true },
      { code: 'WALLET', is_cash: false, is_on_account: false },
    ]);
  });

  it('a tenant cannot assert is_cash against the role — the column is generated', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A);
        await tx.query(
          `insert into app.tender_method (tenant_id, id, write_id, hlc, code, name, posting_role, is_cash)
           values ($1, $2, $3, $4, 'FAKE-CASH', 'Fake', 'BANK', true)`,
          [TENANT_A, uuidv7(), w, nextHlc()],
        );
      }),
    ).rejects.toThrow(/non-DEFAULT value into column "is_cash"/);
  });

  it('a method cannot settle into revenue, a payable or an expense — only where money lands', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) => tenderMethod(tx, TENANT_A, 'BAD', 'SALES_REVENUE')),
    ).rejects.toThrow(/tm_settlement_role/);
    // Positive control: a bank role is accepted.
    await expect(
      db.withTenant(TENANT_A, (tx) => tenderMethod(tx, TENANT_A, 'WIRE', 'BANK', true)),
    ).resolves.toBeTypeOf('string');
  });
});

describe('cash_session — opened once, closed once, then frozen', () => {
  it('the close transition is accepted, with the variance identity holding', async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      const id = await openSession(tx, TENANT_A, locA, { businessDate: '2026-12-02' });
      await closeSession(tx, TENANT_A, id, { expected: 120_000n, counted: 119_500n, variance: -500n, banked: 100_000n });
      const r = await tx.query<{ status: string; variance_minor: string }>(
        `select status, variance_minor::text from app.cash_session where id = $1`, [id]);
      expect(r.rows[0]).toEqual({ status: 'CLOSED', variance_minor: '-500' });
    });
  });

  it('a CLOSED session refuses every further update — the count is final', async () => {
    const id = await db.withTenant(TENANT_A, async (tx) => {
      const s = await openSession(tx, TENANT_A, locA, { businessDate: '2026-12-03' });
      await closeSession(tx, TENANT_A, s, { expected: 20_000n, counted: 20_000n, variance: 0n });
      return s;
    });
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update app.cash_session set counted_minor = 99999, variance_minor = 79999 where id = $1`, [id])),
    ).rejects.toThrow(/is final/);
  });

  it('the close may not move what the open asserted — the business date is frozen', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const s = await openSession(tx, TENANT_A, locA, { businessDate: '2026-12-04' });
        const w = await newWrite(tx, TENANT_A);
        await tx.query(
          `update app.cash_session
              set status = 'CLOSED', closed_by = $2, closed_at = transaction_timestamp(),
                  expected_cash_minor = 20000, close_write_id = $3,
                  business_date = '2026-12-05'
            where id = $1`,
          [s, USER, w],
        );
      }),
    ).rejects.toThrow(/frozen/);
  });

  it('a session is never deleted', async () => {
    const id = await db.withTenant(TENANT_A, (tx) =>
      openSession(tx, TENANT_A, locA, { businessDate: '2026-12-06' }));
    await expect(
      db.withTenant(TENANT_A, (tx) => tx.query(`delete from app.cash_session where id = $1`, [id])),
    ).rejects.toThrow(/permission denied|never deleted/);
  });

  it('a stored variance that is not counted − expected is refused', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const s = await openSession(tx, TENANT_A, locA, { businessDate: '2026-12-07' });
        await closeSession(tx, TENANT_A, s, { expected: 50_000n, counted: 49_000n, variance: 0n });
      }),
    ).rejects.toThrow(/cs_variance_identity/);
  });

  it('the midnight auto-close counts nothing — a count on an auto-close is refused', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const s = await openSession(tx, TENANT_A, locA, { businessDate: '2026-12-08' });
        await closeSession(tx, TENANT_A, s, { expected: 20_000n, counted: 20_000n, variance: 0n, auto: true });
      }),
    ).rejects.toThrow(/cs_auto_close_uncounted/);
    // Positive control: uncounted, it lands.
    await db.withTenant(TENANT_A, async (tx) => {
      const s = await openSession(tx, TENANT_A, locA, { businessDate: '2026-12-09' });
      await closeSession(tx, TENANT_A, s, { expected: 20_000n, counted: null, variance: null, auto: true });
    });
  });

  it('banking more than was counted is refused', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const s = await openSession(tx, TENANT_A, locA, { businessDate: '2026-12-10' });
        await closeSession(tx, TENANT_A, s, { expected: 10_000n, counted: 10_000n, variance: 0n, banked: 10_001n });
      }),
    ).rejects.toThrow(/cs_banked_within_count/);
  });
});

describe('one session per till per business date — and class #17’s landing path', () => {
  it('a second UNCONTESTED claim on the same till and day is refused by the index', async () => {
    await db.withTenant(TENANT_A, (tx) => openSession(tx, TENANT_A, locA, { businessDate: '2026-12-11' }));
    await expect(
      db.withTenant(TENANT_A, (tx) => openSession(tx, TENANT_A, locA, { businessDate: '2026-12-11' })),
    ).rejects.toThrow(/cash_session_till_day_uq/);
    // Positive control: a DIFFERENT device's own drawer the same day is a
    // different till and lands.
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        openSession(tx, TENANT_A, locA, { businessDate: '2026-12-11', deviceId: uuidv7() })),
    ).resolves.toBeTypeOf('string');
  });

  it('two SHARED-drawer claims on one day are the same till (device_id NULL is not "distinct")', async () => {
    await db.withTenant(TENANT_A, (tx) =>
      openSession(tx, TENANT_A, locA, { businessDate: '2026-12-12', deviceId: null }));
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        openSession(tx, TENANT_A, locA, { businessDate: '2026-12-12', deviceId: null })),
    ).rejects.toThrow(/cash_session_till_day_uq/);
  });

  it('the second claim LANDS when it names the first as contested — the path the API takes', async () => {
    const both = await db.withTenant(TENANT_A, async (tx) => {
      const first = await openSession(tx, TENANT_A, locA, { businessDate: '2026-12-13', deviceId: null });
      const second = await openSession(tx, TENANT_A, locA, {
        businessDate: '2026-12-13', deviceId: null, contested: first,
      });
      return { first, second };
    });
    expect(both.second).not.toBe(both.first);
  });
});

describe('two-tenant isolation on every new table (§2.7 category 3)', () => {
  let sessionA: string;
  beforeAll(async () => {
    sessionA = await db.withTenant(TENANT_A, (tx) =>
      openSession(tx, TENANT_A, locA, { businessDate: '2026-12-20' }));
    await db.withTenant(TENANT_B, async (tx) => {
      await tenderMethod(tx, TENANT_B, 'B-ONLY', 'TILL_CASH');
      await openSession(tx, TENANT_B, locB, { businessDate: '2026-12-20' });
    });
  });

  it('control: both tenants really wrote tender methods and sessions (admin view)', async () => {
    const n = await db.asAdmin(async (tx) => {
      const r = await tx.query<{ t: string }>(
        `select distinct tenant_id::text as t from app.cash_session
         union select distinct tenant_id::text from app.tender_method order by 1`);
      return r.rows.map((x) => x.t);
    });
    expect(n).toEqual(expect.arrayContaining([TENANT_A, TENANT_B]));
  });

  it('tenant B sees none of A’s tender methods or sessions, even by id', async () => {
    const seen = await db.withTenant(TENANT_B, async (tx) => {
      const m = await tx.query<{ code: string }>(`select code from app.tender_method`);
      const s = await tx.query<{ id: string }>(`select id from app.cash_session where id = $1`, [sessionA]);
      const all = await tx.query<{ tenant_id: string }>(`select distinct tenant_id from app.cash_session`);
      return { codes: m.rows.map((r) => r.code), byId: s.rows, tenants: all.rows.map((r) => r.tenant_id) };
    });
    expect(seen.codes).toEqual(['B-ONLY']);
    expect(seen.byId).toEqual([]);
    expect(seen.tenants).toEqual([TENANT_B]);
  });

  it('tenant B cannot write a session or a tender method into A’s tenant', async () => {
    await expect(
      db.withTenant(TENANT_B, (tx) => tenderMethod(tx, TENANT_A, 'SMUGGLED', 'TILL_CASH')),
    ).rejects.toThrow(/row-level security|violates/);
  });

  it('with NO tenant context every new table reads empty — fail closed', async () => {
    const counts = await db.asAppUserWithoutTenant(async (tx) => {
      const out: Record<string, number> = {};
      for (const t of ['tender_method', 'cash_session', 'sale_tender']) {
        const r = await tx.query<{ n: string }>(`select count(*)::text as n from app.${t}`);
        out[t] = Number(r.rows[0]!.n);
      }
      return out;
    });
    expect(counts).toEqual({ tender_method: 0, cash_session: 0, sale_tender: 0 });
  });
});

// ---------------------------------------------------------------------------
// THE BACKFILL — run over data written before 0020 existed.
// ---------------------------------------------------------------------------

describe('0021’s backfill: every sale written before tenders existed satisfies the identity', () => {
  const T1 = '018f0000-0000-8000-8000-0000000001aa';
  const T2 = '018f0000-0000-8000-8000-0000000001bb'; // a tenant with no sales at all
  let pg: PGlite;
  let client: SqlClient;
  let dir: string;
  const ids = { cash: uuidv7(), credit: uuidv7(), known: uuidv7(), free: uuidv7() };

  beforeAll(async () => {
    pg = new PGlite();
    client = {
      exec: (sql) => pg.exec(sql),
      query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pg.query(sql, params)).rows as T[] }),
    };
    dir = await mkdtemp(join(tmpdir(), 'erp-0019-'));
    const all = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
    for (const f of all.filter((f) => f < '0020')) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
    await migrate(client, dir);
    await seedGhanaJurisdiction(client);

    // Legacy data, written the way the pre-0021 API wrote it: a header, and a
    // CHARGE for a credit sale. As the migration superuser — this is history.
    for (const t of [T1, T2]) {
      await client.query(
        `insert into platform.tenant (id, slug, legal_name, status, jurisdiction_code)
         values ($1, $2, $2, 'provisioning', 'GH')`, [t, `bf-${t.slice(-2)}`]);
    }
    const w = uuidv7();
    await client.query(
      `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
       values ($1, $2, 'SERVER', $3, 'test.legacy', 1, decode('00', 'hex'))`, [T1, w, nextHlc()]);
    const loc = uuidv7();
    await client.query(
      `insert into app.location (tenant_id, id, write_id, hlc, code, name, kind, timezone)
       values ($1, $2, $3, $4, 'L1', 'Legacy outlet', 'OUTLET', 'Africa/Accra')`, [T1, loc, w, nextHlc()]);
    const pl = uuidv7();
    await client.query(
      `insert into app.price_list (tenant_id, id, write_id, hlc, code, name, is_tax_inclusive, currency_code,
                                   priority, effective_from)
       values ($1, $2, $3, $4, 'L', 'Legacy list', false, 'GHS', 10, '2026-01-01')`, [T1, pl, w, nextHlc()]);
    const cust = uuidv7();
    await client.query(
      `insert into app.customer (tenant_id, id, write_id, hlc, code, name, is_credit_customer)
       values ($1, $2, $3, $4, 'C1', 'Legacy contractor', true)`, [T1, cust, w, nextHlc()]);
    const acct = uuidv7();
    await client.query(
      `insert into app.customer_account (tenant_id, id, write_id, hlc, customer_id, credit_limit_minor,
                                         terms_days, facility_fee_bp_per_month)
       values ($1, $2, $3, $4, $5, 10000000, 30, 200)`, [T1, acct, w, nextHlc(), cust]);
    const sale = async (id: string, receipt: string, total: bigint, customer: string | null) =>
      client.query(
        `insert into app.sale (tenant_id, id, write_id, hlc, location_id, customer_id, price_list_id,
                               receipt_no, business_date, occurred_at, currency_code, money_scale,
                               subtotal_net_minor, discount_minor, tax_total_minor, total_minor)
         values ($1, $2, $3, $4, $5, $6, $7, $8, '2026-08-20', '2026-08-20T10:00:00Z', 'GHS', 100,
                 $9, 0, 0, $9)`,
        [T1, id, w, nextHlc(), loc, customer, pl, receipt, total.toString(10)]);
    await sale(ids.cash, 'R-1', 11_800n, null);
    await sale(ids.credit, 'R-2', 50_000n, cust);
    await sale(ids.known, 'R-3', 7_000n, cust); // a KNOWN customer who paid cash
    await sale(ids.free, 'R-4', 0n, null);
    await client.query(
      `insert into app.credit_entry (tenant_id, id, write_id, hlc, account_id, kind, amount_minor,
                                     business_date, source_kind, source_id)
       values ($1, $2, $3, $4, $5, 'CHARGE', 50000, '2026-08-20', 'SALE', $6)`,
      [T1, uuidv7(), w, nextHlc(), acct, ids.credit]);

    // NOW the go-live migrations, over that history.
    for (const f of all.filter((f) => f >= '0020')) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
    const ran = await migrate(client, dir);
    expect(ran.applied).toEqual(all.filter((f) => f >= '0020'));
  }, 120_000);

  afterAll(async () => {
    await pg?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function tendersOf(saleId: string) {
    const r = await client.query<{ code: string; amount: string; is_on_account: boolean; is_active: boolean }>(
      `select m.code, st.amount_minor::text as amount, m.is_on_account, m.is_active
         from app.sale_tender st join app.tender_method m on m.id = st.method_id
        where st.sale_id = $1 order by st.seq`, [saleId]);
    return r.rows;
  }

  it('a cash sale is settled at the counter, for exactly its total', async () => {
    expect(await tendersOf(ids.cash)).toEqual([
      { code: 'PRE-0021-COUNTER', amount: '11800', is_on_account: false, is_active: false },
    ]);
  });

  it('a credit sale is on account for EXACTLY its CHARGE — the inference every reader used, written once', async () => {
    expect(await tendersOf(ids.credit)).toEqual([
      { code: 'PRE-0021-ACCOUNT', amount: '50000', is_on_account: true, is_active: false },
    ]);
  });

  it('a cash sale by a KNOWN customer stays at the counter — customer_id is not a tender', async () => {
    expect(await tendersOf(ids.known)).toEqual([
      { code: 'PRE-0021-COUNTER', amount: '7000', is_on_account: false, is_active: false },
    ]);
  });

  it('a zero-total sale gets no tender row: Σ of nothing is its total', async () => {
    expect(await tendersOf(ids.free)).toEqual([]);
  });

  it('the identities 0022 enforces hold for every backfilled sale', async () => {
    const bad = await client.query<{ id: string }>(
      `select s.id from app.sale s
        where s.total_minor <> coalesce((select sum(amount_minor) from app.sale_tender st where st.sale_id = s.id), 0)
           or coalesce((select sum(st.amount_minor) from app.sale_tender st
                          join app.tender_method m on m.id = st.method_id
                         where st.sale_id = s.id and m.is_on_account), 0)
              <> coalesce((select sum(amount_minor) from app.credit_entry ce
                            where ce.source_kind = 'SALE' and ce.source_id = s.id and ce.kind = 'CHARGE'), 0)`);
    expect(bad.rows).toEqual([]);
  });

  it('a tenant with no sales gets no migration tender methods at all', async () => {
    const r = await client.query<{ n: string }>(
      `select count(*)::text as n from app.tender_method where tenant_id = $1`, [T2]);
    expect(r.rows[0]!.n).toBe('0');
  });

  it('history keeps its NULL session; a NEW sale without one is refused', async () => {
    const legacy = await client.query<{ n: string }>(
      `select count(*)::text as n from app.sale where cash_session_id is null`);
    expect(legacy.rows[0]!.n).toBe('4');
    await expect(
      client.query(
        `insert into app.sale (tenant_id, id, write_id, hlc, location_id, price_list_id, receipt_no,
                               business_date, occurred_at, currency_code, money_scale,
                               subtotal_net_minor, discount_minor, tax_total_minor, total_minor)
         select tenant_id, $1, write_id, hlc, location_id, price_list_id, 'R-NEW', business_date,
                occurred_at, currency_code, money_scale, 0, 0, 0, 0
           from app.sale where id = $2`,
        [uuidv7(), ids.free]),
    ).rejects.toThrow(/sale_cash_session_required/);
  });
});
