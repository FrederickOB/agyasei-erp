/**
 * Two-tenant isolation on the ACCESS-CONTROL tables, at the SQL level, as
 * app_user (CLAUDE.md §2.7 category 3).
 *
 * These tables deserve their own suite rather than a line in the general one:
 * a leak here is not "tenant B sees a row", it is "tenant B's authorization
 * model is visible or, worse, reachable" — a role composed of another
 * tenant's permissions, or an assignment naming another tenant's location.
 * Composite foreign keys carrying tenant_id make that a constraint violation
 * rather than a bug; RLS makes the read empty. Both are asserted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import { effectivePermissions, hasPermissionAnywhere } from '../src/permissions.js';
import type { TestDb } from '../src/testing/harness.js';
import { assignRole, makeLocation, makeRole, makeUser } from './rbac-fixtures.js';
import { newWrite, nextHlc, setupDb, setupTwoTenants, TENANT_A, TENANT_B } from './util.js';

let db: TestDb;

let locA: string;
let locB: string;
let roleA: string;
let roleB: string;
let userA: string;
let userB: string;

const RBAC_TABLES = [
  'app.location_closure',
  'app.role',
  'app.role_permission',
  'app.user_account',
  'app.user_role_assignment',
] as const;

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);

  await db.withTenant(TENANT_A, async (tx) => {
    locA = await makeLocation(tx, TENANT_A, { code: 'A-ROOT', kind: 'GROUP' });
    roleA = await makeRole(tx, TENANT_A, {
      name: 'A staff',
      permissions: [{ code: 'sale.record' }],
    });
    userA = await makeUser(tx, TENANT_A, 'a-user');
    await assignRole(tx, TENANT_A, { userId: userA, roleId: roleA, scopeLocationId: locA });
  });

  await db.withTenant(TENANT_B, async (tx) => {
    locB = await makeLocation(tx, TENANT_B, { code: 'B-ROOT', kind: 'GROUP' });
    roleB = await makeRole(tx, TENANT_B, {
      name: 'B staff',
      // Same NAME shape, different tenant, and a permission A's role lacks.
      permissions: [{ code: 'sale.record' }, { code: 'sale.override_price' }],
    });
    userB = await makeUser(tx, TENANT_B, 'b-user');
    await assignRole(tx, TENANT_B, { userId: userB, roleId: roleB, scopeLocationId: locB });
  });
});

afterAll(async () => {
  await db.close();
});

describe('two-tenant isolation on the access-control tables', () => {
  it('control: both tenants really wrote rows (visible to the admin role)', async () => {
    for (const table of RBAC_TABLES) {
      const res = await db.asAdmin((tx) =>
        tx.query<{ n: string }>(`select count(*)::text as n from ${table}`),
      );
      expect(Number(res.rows[0]!.n)).toBeGreaterThanOrEqual(2);
    }
  });

  it('an UNPREDICATED select on every new table returns only the current tenant', async () => {
    for (const table of RBAC_TABLES) {
      const rows = await db.withTenant(TENANT_A, (tx) =>
        tx.query<{ tenant_id: string }>(`select tenant_id from ${table}`),
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      expect([...new Set(rows.rows.map((r) => r.tenant_id))]).toEqual([TENANT_A]);
    }
  });

  it("B's role and its permissions are invisible to A, even by primary key", async () => {
    const role = await db.withTenant(TENANT_A, (tx) =>
      tx.query('select * from app.role where id = $1', [roleB]),
    );
    expect(role.rows).toEqual([]);
    const perms = await db.withTenant(TENANT_A, (tx) =>
      tx.query('select * from app.role_permission where role_id = $1', [roleB]),
    );
    expect(perms.rows).toEqual([]);
  });

  it("resolving B's user under A's context yields NOTHING — not an error, not a leak", async () => {
    const ep = await db.withTenant(TENANT_A, (tx) => effectivePermissions(tx, userB));
    expect(ep.rows).toEqual([]);
    expect(hasPermissionAnywhere(ep, 'sale.override_price')).toBe(false);
    // ...and B's own context still resolves it, so the emptiness above is
    // isolation and not a broken fixture.
    const own = await db.withTenant(TENANT_B, (tx) => effectivePermissions(tx, userB));
    expect(hasPermissionAnywhere(own, 'sale.override_price')).toBe(true);
  });

  it("A cannot compose a role out of B's role by id (composite FK carries the tenant)", async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A);
        await tx.query(
          `insert into app.role_permission
             (tenant_id, id, write_id, hlc, role_id, permission_code)
           values ($1, $2, $3, $4, $5, 'sale.override_price')`,
          [TENANT_A, uuidv7(), w, nextHlc(), roleB],
        );
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it("A cannot assign one of its users into B's location tree", async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        assignRole(tx, TENANT_A, { userId: userA, roleId: roleA, scopeLocationId: locB }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("A cannot assign B's user to one of its own roles", async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        assignRole(tx, TENANT_A, { userId: userB, roleId: roleA, scopeLocationId: locA }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('an INSERT stamping another tenant_id is refused by WITH CHECK on every new table', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A);
        await tx.query(
          `insert into app.role (tenant_id, id, write_id, hlc, name, description, is_owner)
           values ($1, $2, $3, $4, 'Smuggled', '', false)`,
          [TENANT_B, uuidv7(), w, nextHlc()],
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A);
        await tx.query(
          `insert into app.user_account
             (tenant_id, id, write_id, hlc, username, display_name)
           values ($1, $2, $3, $4, 'smuggled', 'Smuggled')`,
          [TENANT_B, uuidv7(), w, nextHlc()],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a location closure row cannot be forged across tenants', async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A);
        await tx.query(
          `insert into app.location_closure
             (tenant_id, id, write_id, hlc, ancestor_id, descendant_id, depth)
           values ($1, $2, $3, $4, $5, $6, 1)`,
          [TENANT_A, uuidv7(), w, nextHlc(), locA, locB],
        );
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it('with NO tenant context every access-control read is empty — fails closed', async () => {
    for (const table of RBAC_TABLES) {
      const res = await db.asAppUserWithoutTenant((tx) =>
        tx.query(`select * from ${table}`),
      );
      expect(res.rows).toEqual([]);
    }
    const ep = await db.asAppUserWithoutTenant((tx) => effectivePermissions(tx, userA));
    expect(ep.rows).toEqual([]);
  });
});
