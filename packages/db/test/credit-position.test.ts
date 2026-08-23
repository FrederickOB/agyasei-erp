/**
 * THE SERVER-DERIVED CREDIT POSITION (migration 0013) — the rows that make the
 * credit book safe to put on a device.
 *
 * Three things are proven, and each of them is the reason a specific column
 * exists rather than a general "does it work":
 *
 *  1. **The composition adds up.** `Σ(buckets) − on-account + fee = balance`,
 *     exactly, in bigint. This is the identity the CLIENT re-checks with
 *     `checkAgreement` — the same function it checks the online answer with —
 *     so if this projection ever drifted from the API's `credit.ageing`, a
 *     device says "these do not add up" instead of showing a wrong headline.
 *  2. **Archiving moves money between the window and the opening, and NOWHERE
 *     else.** The balance is unchanged and
 *     `opening_before_window_minor` moves by exactly the archived amount, so a
 *     device holding a short log can still state the whole account.
 *  3. **The second tenant is invisible.** One test per read path, per §2.7.
 *
 * Every figure is asserted by EXACT VALUE and every "zero rows" assertion is
 * paired with the same query shape returning rows for the tenant that should
 * have them — a count of zero on a query that returns zero everywhere proves
 * nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import type { Queryable, TestDb } from '../src/testing/harness.js';
import { assignRole, makeLocation, makeRole, makeUser } from './rbac-fixtures.js';
import { newWrite, nextHlc, setupDb, setupTwoTenants, TENANT_A, TENANT_B } from './util.js';

interface Seeded {
  readonly customerId: string;
  readonly accountId: string;
}

async function seedAccount(
  tx: Queryable,
  tenantId: string,
  opts: { readonly code: string; readonly limitMinor: string },
): Promise<Seeded> {
  const customerId = uuidv7();
  const accountId = uuidv7();
  await tx.query(
    `insert into app.customer (tenant_id, id, write_id, hlc, code, name, is_credit_customer)
     values ($1,$2,$3,$4,$5,$5,true)`,
    [tenantId, customerId, await newWrite(tx, tenantId, 'customer.open'), nextHlc(), opts.code],
  );
  await tx.query(
    `insert into app.customer_account
       (tenant_id, id, write_id, hlc, customer_id, credit_limit_minor, terms_days,
        facility_fee_bp_per_month, status)
     values ($1,$2,$3,$4,$5,$6,30,250,'ACTIVE')`,
    [
      tenantId,
      accountId,
      await newWrite(tx, tenantId, 'credit.open'),
      nextHlc(),
      customerId,
      opts.limitMinor,
    ],
  );
  return { customerId, accountId };
}

async function addEntry(
  tx: Queryable,
  tenantId: string,
  accountId: string,
  e: {
    readonly kind: string;
    readonly amountMinor: string;
    readonly businessDate: string;
    readonly dueDate?: string | null;
    readonly appliesToId?: string | null;
  },
): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `insert into app.credit_entry
       (tenant_id, id, write_id, hlc, account_id, kind, amount_minor, business_date,
        due_date, applies_to_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10)`,
    [
      tenantId,
      id,
      await newWrite(tx, tenantId, 'credit.record_entry'),
      nextHlc(),
      accountId,
      e.kind,
      e.amountMinor,
      e.businessDate,
      e.dueDate ?? null,
      e.appliesToId ?? null,
    ],
  );
  return id;
}

interface SnapshotRow {
  balance_minor: string;
  trade_exposure_minor: string;
  available_minor: string;
  on_account_credit_minor: string;
  fee_outstanding_minor: string;
  opening_before_window_minor: string;
  as_of_hlc: string;
  entry_window_days: number;
}

async function snapshot(tx: Queryable, accountId: string): Promise<SnapshotRow> {
  const res = await tx.query<SnapshotRow>(
    `select balance_minor::text, trade_exposure_minor::text, available_minor::text,
            on_account_credit_minor::text, fee_outstanding_minor::text,
            opening_before_window_minor::text, as_of_hlc, entry_window_days
       from app.credit_position_snapshot where account_id = $1`,
    [accountId],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('no snapshot row');
  return row;
}

async function buckets(tx: Queryable, accountId: string): Promise<[string, bigint][]> {
  const res = await tx.query<{ label: string; amount_minor: string }>(
    `select label, amount_minor::text from app.credit_position_bucket
      where account_id = $1 order by seq`,
    [accountId],
  );
  return res.rows.map((r) => [r.label, BigInt(r.amount_minor)]);
}

describe('credit_position_snapshot', () => {
  let db: TestDb;
  let a: Seeded;

  beforeAll(async () => {
    db = await setupDb();
    await setupTwoTenants(db);
    await db.withTenant(TENANT_A, async (tx) => {
      a = await seedAccount(tx, TENANT_A, { code: 'CU-A1', limitMinor: '5000000' });
      // Two charges on different days, one already past due; one payment
      // applied to the overdue charge; one unapplied payment; one fee.
      const overdue = await addEntry(tx, TENANT_A, a.accountId, {
        kind: 'CHARGE',
        amountMinor: '400000',
        businessDate: '2020-01-01',
        dueDate: '2020-01-31',
      });
      await addEntry(tx, TENANT_A, a.accountId, {
        kind: 'CHARGE',
        amountMinor: '300000',
        businessDate: '2020-02-01',
        // Due far in the future so it lands in `current` whenever this runs.
        dueDate: '2999-01-01',
      });
      await addEntry(tx, TENANT_A, a.accountId, {
        kind: 'PAYMENT',
        amountMinor: '-100000',
        businessDate: '2020-03-01',
        appliesToId: overdue,
      });
      await addEntry(tx, TENANT_A, a.accountId, {
        kind: 'PAYMENT',
        amountMinor: '-50000',
        businessDate: '2020-03-02',
      });
      await addEntry(tx, TENANT_A, a.accountId, {
        kind: 'FEE',
        amountMinor: '7500',
        businessDate: '2020-03-03',
      });
    });
  });
  afterAll(async () => {
    await db.close();
  });

  it('is written by the entry trigger, with the account balance the API derives', async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      const s = await snapshot(tx, a.accountId);
      // 400000 + 300000 − 100000 − 50000 + 7500
      expect(BigInt(s.balance_minor)).toBe(557_500n);
      // …the same, excluding the fee: what a limit is measured against.
      expect(BigInt(s.trade_exposure_minor)).toBe(550_000n);
      expect(BigInt(s.available_minor)).toBe(5_000_000n - 550_000n);
      expect(BigInt(s.on_account_credit_minor)).toBe(50_000n);
      expect(BigInt(s.fee_outstanding_minor)).toBe(7_500n);
      expect(BigInt(s.opening_before_window_minor)).toBe(0n);
      expect(s.entry_window_days).toBe(400);
    });
  });

  it('renders the tenant’s ageing bands and Σ(buckets) reconciles to the balance', async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      const vector = await buckets(tx, a.accountId);
      // The template default bands: current / 1-30 / 31-60 / 61-90 / 90+.
      expect(vector.map(([label]) => label)).toEqual(['current', '1-30', '31-60', '61-90', '90+']);
      // The unpaid 300000 is not yet due; the overdue charge is 400000 less the
      // 100000 put against it, and it is years past due, so it is in the tail.
      expect(Object.fromEntries(vector)['current']).toBe(300_000n);
      expect(Object.fromEntries(vector)['90+']).toBe(300_000n);

      // THE IDENTITY the client re-checks with checkAgreement.
      const s = await snapshot(tx, a.accountId);
      const total = vector.reduce((acc, [, amount]) => acc + amount, 0n);
      expect(total - BigInt(s.on_account_credit_minor) + BigInt(s.fee_outstanding_minor)).toBe(
        BigInt(s.balance_minor),
      );
    });
  });

  it('carries the greatest server-stamped HLC of the entries, not a clock reading', async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      const s = await snapshot(tx, a.accountId);
      const res = await tx.query<{ max: string }>(
        `select max(hlc) as max from app.credit_entry where account_id = $1`,
        [a.accountId],
      );
      expect(s.as_of_hlc).toBe(res.rows[0]?.max);
    });
  });

  it('refuses the archival mark to app_user, which holds no UPDATE on the log', async () => {
    // 0004 revoked UPDATE from app_user and 0013 did not give it back: the
    // window is advanced by the maintenance job, never by application SQL.
    await db.withTenant(TENANT_A, async (tx) => {
      await expect(
        tx.query(
          `update app.credit_entry set archived_at = transaction_timestamp()
            where tenant_id = $1 and account_id = $2`,
          [TENANT_A, a.accountId],
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it('moves money from the window to the opening on archive, and NOWHERE else', async () => {
    const fee = await db.asAdmin(async (tx) => {
      const res = await tx.query<{ id: string; amount_minor: string }>(
        `select id, amount_minor::text from app.credit_entry
          where account_id = $1 and kind = 'FEE' limit 1`,
        [a.accountId],
      );
      const row = res.rows[0];
      if (row === undefined) throw new Error('expected a fee entry');
      return row;
    });
    const before = await db.withTenant(TENANT_A, (tx) => snapshot(tx, a.accountId));

    // The archival mark is the ONE permitted update…
    await db.asAdmin(async (tx) => {
      await tx.query(`select set_config('app.tenant_id', $1, true)`, [TENANT_A]);
      await tx.query(
        `update app.credit_entry set archived_at = transaction_timestamp()
          where tenant_id = $1 and id = $2`,
        [TENANT_A, fee.id],
      );
    });
    // …and the append-only guard still refuses everything else, whatever
    // privilege the caller holds. Its own transaction: an error aborts the
    // whole one it is raised in, which would take the archive above with it.
    await expect(
      db.asAdmin((tx) =>
        tx.query(`update app.credit_entry set amount_minor = 1 where tenant_id = $1 and id = $2`, [
          TENANT_A,
          fee.id,
        ]),
      ),
    ).rejects.toThrow(/append-only/);

    const after = await db.withTenant(TENANT_A, (tx) => snapshot(tx, a.accountId));
    expect(BigInt(after.balance_minor)).toBe(BigInt(before.balance_minor));
    expect(BigInt(after.opening_before_window_minor)).toBe(
      BigInt(before.opening_before_window_minor) + BigInt(fee.amount_minor),
    );
  });
});

describe('tenant isolation at the derived credit read paths', () => {
  let db: TestDb;
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    db = await setupDb();
    await setupTwoTenants(db);
    await db.withTenant(TENANT_A, async (tx) => {
      a = await seedAccount(tx, TENANT_A, { code: 'CU-A1', limitMinor: '5000000' });
      await addEntry(tx, TENANT_A, a.accountId, {
        kind: 'CHARGE',
        amountMinor: '111111',
        businessDate: '2020-01-01',
        dueDate: '2020-01-31',
      });
    });
    await db.withTenant(TENANT_B, async (tx) => {
      b = await seedAccount(tx, TENANT_B, { code: 'CU-B1', limitMinor: '900000' });
      await addEntry(tx, TENANT_B, b.accountId, {
        kind: 'CHARGE',
        amountMinor: '222222',
        businessDate: '2020-01-01',
        dueDate: '2020-01-31',
      });
    });
  });
  afterAll(async () => {
    await db.close();
  });

  it('shows each tenant its own position by exact value, and none of the other’s', async () => {
    // Positive control FIRST, so the zero below means something.
    await db.withTenant(TENANT_A, async (tx) => {
      const mine = await tx.query<{ balance_minor: string }>(
        `select balance_minor::text from app.credit_position_snapshot`,
      );
      expect(mine.rows.map((r) => BigInt(r.balance_minor))).toEqual([111_111n]);
      const theirs = await tx.query(
        `select 1 from app.credit_position_snapshot where account_id = $1`,
        [b.accountId],
      );
      expect(theirs.rows).toEqual([]);
    });
    // …and the same in the other direction, so neither passes by seeding luck.
    await db.withTenant(TENANT_B, async (tx) => {
      const mine = await tx.query<{ balance_minor: string }>(
        `select balance_minor::text from app.credit_position_snapshot`,
      );
      expect(mine.rows.map((r) => BigInt(r.balance_minor))).toEqual([222_222n]);
      const theirs = await tx.query(
        `select 1 from app.credit_position_snapshot where account_id = $1`,
        [a.accountId],
      );
      expect(theirs.rows).toEqual([]);
    });
  });

  it('scopes the ageing vector the same way', async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      const mine = await tx.query(`select 1 from app.credit_position_bucket`);
      expect(mine.rows.length).toBeGreaterThan(0);
      const theirs = await tx.query(
        `select 1 from app.credit_position_bucket where account_id = $1`,
        [b.accountId],
      );
      expect(theirs.rows).toEqual([]);
    });
  });

  it('answers nothing at all with no tenant set — the fail-closed path', async () => {
    await db.asAppUserWithoutTenant(async (tx) => {
      const res = await tx.query(`select 1 from app.credit_position_snapshot`);
      expect(res.rows).toEqual([]);
    });
  });
});

/**
 * THE GATE — who may HOLD the credit book on a device, which is a narrower
 * question than who may read it (02 §2.5).
 *
 * `app.credit_sync_book_scope` is what the `tenant_credit` sync bucket's
 * parameter query reads. It exists because the 0005 permission tables are
 * VIEWS and Postgres cannot publish a view to logical replication — and it is
 * gated rather than merely projected because a device that keeps a grant it no
 * longer holds is the failure a token claim makes unavoidable.
 *
 * Every zero below is paired with the same query returning a row for the user
 * who should have one, in the same run.
 */
describe('the credit sync gate', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupDb();
    await setupTwoTenants(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it('admits a ROOT-scoped credit.view holder and refuses an OUTLET-scoped one', async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      const root = await makeLocation(tx, TENANT_A, { code: 'ROOT-G', kind: 'GROUP' });
      const outlet = await makeLocation(tx, TENANT_A, { code: 'OUT-G', parentId: root });
      const role = await makeRole(tx, TENANT_A, {
        name: 'reads credit',
        permissions: [{ code: 'credit.view' }],
      });
      const backOffice = await makeUser(tx, TENANT_A, 'gate-back-office');
      const atOutlet = await makeUser(tx, TENANT_A, 'gate-outlet');
      await assignRole(tx, TENANT_A, { userId: backOffice, roleId: role, scopeLocationId: root });
      await assignRole(tx, TENANT_A, { userId: atOutlet, roleId: role, scopeLocationId: outlet });

      const held = await tx.query<{ user_id: string }>(
        `select user_id from app.credit_sync_book_scope where user_id = any($1::uuid[])`,
        [[backOffice, atOutlet]],
      );
      // POSITIVE CONTROL and the refusal, from ONE query in ONE run: the
      // root-scoped user is there and the outlet-scoped one is not. A credit
      // account has no location, so an outlet-scoped grant is a right the
      // tenant-keyed bucket cannot express and must not serve.
      expect(held.rows.map((r) => r.user_id)).toEqual([backOffice]);
    });
  });

  it('empties the device when the grant is revoked', async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      const root = await makeLocation(tx, TENANT_A, { code: 'ROOT-R', kind: 'GROUP' });
      const role = await makeRole(tx, TENANT_A, {
        name: 'reads credit (revocable)',
        permissions: [{ code: 'credit.view' }],
      });
      const user = await makeUser(tx, TENANT_A, 'gate-revoked');
      const assignment = await assignRole(tx, TENANT_A, {
        userId: user,
        roleId: role,
        scopeLocationId: root,
      });
      const before = await tx.query(
        `select 1 from app.credit_sync_book_scope where user_id = $1`,
        [user],
      );
      expect(before.rows.length).toBe(1);

      // Ordinary revocation: the assignment is soft-deleted. (`effective_to`
      // cannot equal `effective_from` — `ura_effective_order` refuses it — so
      // "revoke now" IS this, and it is an UPDATE, so the trigger sees it.)
      await tx.query(
        `update app.user_role_assignment set deleted_at = transaction_timestamp()
          where tenant_id = $1 and id = $2`,
        [TENANT_A, assignment],
      );
      const after = await tx.query(
        `select 1 from app.credit_sync_book_scope where user_id = $1`,
        [user],
      );
      // This is the property a signed token claim cannot have: the row is gone
      // the moment the grant is, so the next sync takes the book off the device.
      expect(after.rows).toEqual([]);
    });
  });

  it('keeps the counter gate separate: sale.record.credit at that location only', async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      const root = await makeLocation(tx, TENANT_A, { code: 'ROOT-C', kind: 'GROUP' });
      const here = await makeLocation(tx, TENANT_A, { code: 'OUT-HERE', parentId: root });
      const elsewhere = await makeLocation(tx, TENANT_A, { code: 'OUT-ELSE', parentId: root });
      const role = await makeRole(tx, TENANT_A, {
        name: 'sells on credit',
        permissions: [{ code: 'sale.record.credit' }],
      });
      const teller = await makeUser(tx, TENANT_A, 'gate-teller');
      await assignRole(tx, TENANT_A, { userId: teller, roleId: role, scopeLocationId: here });

      const rows = await tx.query<{ location_id: string }>(
        `select location_id from app.credit_sync_location_scope where user_id = $1`,
        [teller],
      );
      expect(rows.rows.map((r) => r.location_id)).toEqual([here]);
      expect(rows.rows.some((r) => r.location_id === elsewhere)).toBe(false);
      // …and selling on credit is NOT a right to hold the book.
      const book = await tx.query(`select 1 from app.credit_sync_book_scope where user_id = $1`, [
        teller,
      ]);
      expect(book.rows).toEqual([]);
    });
  });
});
