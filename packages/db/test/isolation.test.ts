/**
 * Two-tenant isolation AT THE SQL LEVEL, as app_user — proving RLS itself,
 * not the application layer (CLAUDE.md §2.7 category 3; ADR-0005).
 *
 * The harness runs every tenant-scoped block as the non-superuser,
 * non-BYPASSRLS role app_user inside SET LOCAL ROLE — PGlite's default
 * connection is a superuser, which bypasses RLS entirely, and a suite that
 * queried as superuser would be theatre.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import type { TestDb } from '../src/testing/harness.js';
import { newWrite, nextHlc, setupDb, setupTwoTenants, TENANT_A, TENANT_B } from './util.js';

let db: TestDb;
const ltA = uuidv7();
const ltB = uuidv7();
const locA = uuidv7();
const locB = uuidv7();

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);

  await db.withTenant(TENANT_A, async (tx) => {
    const w = await newWrite(tx, TENANT_A);
    await tx.query(
      `insert into app.location_type (tenant_id, id, write_id, hlc, code, name)
       values ($1, $2, $3, $4, 'SHOP', 'Shop')`,
      [TENANT_A, ltA, w, nextHlc()],
    );
    await tx.query(
      `insert into app.location (tenant_id, id, write_id, hlc, code, name, kind, location_type_id, timezone)
       values ($1, $2, $3, $4, 'A-01', 'Tenant A shop', 'OUTLET', $5, 'Africa/Accra')`,
      [TENANT_A, locA, w, nextHlc(), ltA],
    );
  });

  await db.withTenant(TENANT_B, async (tx) => {
    const w = await newWrite(tx, TENANT_B);
    await tx.query(
      `insert into app.location_type (tenant_id, id, write_id, hlc, code, name)
       values ($1, $2, $3, $4, 'DEPOT', 'Depot')`,
      [TENANT_B, ltB, w, nextHlc()],
    );
    await tx.query(
      `insert into app.location (tenant_id, id, write_id, hlc, code, name, kind, location_type_id, timezone)
       values ($1, $2, $3, $4, 'B-01', 'Tenant B depot', 'OUTLET', $5, 'Africa/Accra')`,
      [TENANT_B, locB, w, nextHlc(), ltB],
    );
  });
});

afterAll(async () => {
  await db.close();
});

describe('two-tenant isolation at the SQL level (as app_user)', () => {
  it('control: both tenants really wrote rows (visible to the admin role)', async () => {
    const res = await db.asAdmin((tx) => tx.query<{ n: string }>('select count(*) as n from app.location'));
    expect(Number(res.rows[0]!.n)).toBe(2);
  });

  it("an UNPREDICATED query under tenant A returns ONLY A's rows — RLS, not the app layer", async () => {
    const res = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ code: string }>('select code from app.location'), // no WHERE at all
    );
    expect(res.rows.map((r) => r.code)).toEqual(['A-01']);
  });

  it("B's row is invisible to A even when addressed by primary key", async () => {
    const res = await db.withTenant(TENANT_A, (tx) =>
      tx.query('select * from app.location where id = $1', [locB]),
    );
    expect(res.rows).toEqual([]);
  });

  it('an INSERT claiming another tenant_id is refused by WITH CHECK', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A);
        await tx.query(
          `insert into app.location_type (tenant_id, id, write_id, hlc, code, name)
           values ($1, $2, $3, $4, 'EVIL', 'Wrong tenant')`,
          [TENANT_B, uuidv7(), w, nextHlc()],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("a cross-tenant FK write fails: A cannot reference B's row even with A's own tenant_id", async () => {
    // Composite FK (tenant_id, location_type_id): the constraint itself
    // carries the tenant, so this fails even if RLS were disabled — the belt
    // to RLS's braces (04 §4.2.2).
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A);
        await tx.query(
          `insert into app.location (tenant_id, id, write_id, hlc, code, name, kind, location_type_id, timezone)
           values ($1, $2, $3, $4, 'A-XX', 'Points at B', 'OUTLET', $5, 'Africa/Accra')`,
          [TENANT_A, uuidv7(), w, nextHlc(), ltB],
        );
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it("a cross-tenant write_id fails the same way: B's unit of work cannot parent A's row", async () => {
    const wB = await db.withTenant(TENANT_B, (tx) => newWrite(tx, TENANT_B));
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `insert into app.location_type (tenant_id, id, write_id, hlc, code, name)
           values ($1, $2, $3, $4, 'X', 'X')`,
          [TENANT_A, uuidv7(), wB, nextHlc()],
        ),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('no tenant context ⇒ zero rows, not an error and never another tenant’s data (fails closed)', async () => {
    const res = await db.asAppUserWithoutTenant((tx) => tx.query('select * from app.location'));
    expect(res.rows).toEqual([]);
  });

  it('no tenant context ⇒ inserts are refused', async () => {
    await expect(
      db.asAppUserWithoutTenant((tx) =>
        tx.query(
          `insert into app.location_type (tenant_id, id, write_id, hlc, code, name)
           values ($1, $2, $3, $4, 'NOCTX', 'No context')`,
          [TENANT_A, uuidv7(), uuidv7(), nextHlc()],
        ),
      ),
    ).rejects.toThrow(); // RLS with-check or FK — either way it must not land
  });

  it('app_user cannot write the platform registry', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update platform.tenant set legal_name = 'Owned' where id = $1`, [TENANT_A]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('control: the operator plane (admin role) sees BOTH tenants in the registry', async () => {
    const res = await db.asAdmin((tx) =>
      tx.query<{ id: string }>('select id from platform.tenant order by id'),
    );
    expect(res.rows.map((r) => r.id)).toEqual([TENANT_A, TENANT_B].sort());
  });

  it("platform.tenant, UNPREDICATED, under tenant A returns ONLY A's row — RLS, not the resolver (0027)", async () => {
    // The Phase 2 gate's probe, verbatim: before 0027 this returned both
    // tenants' slugs and legal names to app_user with A's GUC set.
    const a = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ id: string; legal_name: string }>('select id, legal_name from platform.tenant'),
    );
    expect(a.rows).toEqual([{ id: TENANT_A, legal_name: 'Tenant A Ltd' }]);
    const b = await db.withTenant(TENANT_B, (tx) =>
      tx.query<{ id: string }>('select id from platform.tenant'),
    );
    expect(b.rows).toEqual([{ id: TENANT_B }]);
  });

  it("B's registry row is invisible to A even by primary key, and with no context there is none", async () => {
    const byPk = await db.withTenant(TENANT_A, (tx) =>
      tx.query('select * from platform.tenant where id = $1', [TENANT_B]),
    );
    expect(byPk.rows).toEqual([]);
    const none = await db.asAppUserWithoutTenant((tx) => tx.query('select * from platform.tenant'));
    expect(none.rows).toEqual([]);
  });

  it('platform.tenant_database is closed to app_user outright — not even its own row', async () => {
    // dsn_ref / sync_service_ref are operator secret-store pointers; no
    // application path reads them. Refused, not filtered.
    await expect(
      db.withTenant(TENANT_A, (tx) => tx.query('select * from platform.tenant_database')),
    ).rejects.toThrow(/permission denied/i);
    // The operator plane still reads both placements.
    const admin = await db.asAdmin((tx) =>
      tx.query<{ n: string }>('select count(*)::text as n from platform.tenant_database'),
    );
    expect(admin.rows[0]!.n).toBe('2');
  });

  it('global reference data is read in full by every tenant and written by none', async () => {
    const all = await db.asAdmin((tx) =>
      tx.query<{ n: string }>('select count(*)::text as n from platform.tax_rate'),
    );
    expect(Number(all.rows[0]!.n)).toBeGreaterThan(0);
    for (const tenant of [TENANT_A, TENANT_B]) {
      const seen = await db.withTenant(tenant, (tx) =>
        tx.query<{ n: string }>('select count(*)::text as n from platform.tax_rate'),
      );
      expect(seen.rows[0]!.n).toBe(all.rows[0]!.n);
    }
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update platform.tax_rate set rate_bp = 0 where jurisdiction_code = 'GH'`),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `insert into platform.permission (code, domain, description) values ('x.y', 'x', 'minted')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the derived stock view is tenant-scoped too (security_invoker)', async () => {
    const res = await db.withTenant(TENANT_A, (tx) => tx.query('select * from app.stock_on_hand'));
    expect(res.rows).toEqual([]); // no movements yet — and no error, and no cross-tenant rows
  });
});
