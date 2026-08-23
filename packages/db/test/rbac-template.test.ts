/**
 * The template's five roles, and THE TWO HARD PROHIBITIONS.
 *
 * The brief: counter staff get no pricing overrides and no credit-limit
 * changes, genuinely — not hidden in the UI. This suite proves that the
 * enforcement is DATA: the counter role simply does not hold
 * `sale.override_price` or `credit.limit.change`, so every check in the
 * system refuses, and nothing anywhere consults the role's NAME.
 *
 * The last test is the one that matters most, and it deliberately proves the
 * opposite of a lock: a tenant that WANTS its counter staff to override
 * prices can grant it, and it takes effect. That is the correct behaviour
 * (CLAUDE.md §2.9 — another tenant has a different org chart), and it is what
 * distinguishes a real permission model from a role enum with the names
 * changed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BRIEF_RESTRICTED_PERMISSIONS,
  effectivePermissions,
  hasPermissionAt,
  permissionCodesAt,
  PERMISSION_CODES,
} from '../src/permissions.js';
import { applyTemplate, applyTenant1Locations, TEMPLATE_ID } from '../src/seed/template.js';
import { TEMPLATE_ROLES } from '../src/seed/roles.js';
import { createTenant, type TestDb } from '../src/testing/harness.js';
import { assignRole, makeUser } from './rbac-fixtures.js';
import { setupDb } from './util.js';

const T1 = '018f0000-0000-8000-8000-0000000000f1';

let db: TestDb;
let rootLoc: string;
let flagship: string;
const roleIdByRef = new Map<string, string>();

async function locationIdByCode(code: string): Promise<string> {
  const res = await db.withTenant(T1, (tx) =>
    tx.query<{ id: string }>('select id from app.location where code = $1', [code]),
  );
  return res.rows[0]!.id;
}

beforeAll(async () => {
  db = await setupDb();
  await createTenant(db, { id: T1, slug: 'agyasei-jnr', legalName: 'Agyasei Jnr & Company Limited' });
  await db.withTenant(T1, (tx) => applyTemplate(tx, T1));
  await db.withTenant(T1, (tx) => applyTenant1Locations(tx, T1));

  rootLoc = await locationIdByCode('ROOT');
  const outlets = await db.withTenant(T1, (tx) =>
    tx.query<{ id: string }>(
      `select id from app.location where kind = 'OUTLET' order by code limit 1`,
    ),
  );
  flagship = outlets.rows[0]!.id;

  const roles = await db.withTenant(T1, (tx) =>
    tx.query<{ id: string; origin_ref: string }>(
      'select id, origin_ref from app.role where origin_template_id = $1',
      [TEMPLATE_ID],
    ),
  );
  for (const r of roles.rows) roleIdByRef.set(r.origin_ref.replace(/^role:/, ''), r.id);
});

afterAll(async () => {
  await db.close();
});

describe("tenant #1's five roles ship as template data", () => {
  it('seeds exactly five roles, as ordinary editable rows with provenance', async () => {
    const res = await db.withTenant(T1, (tx) =>
      tx.query<{ name: string; is_owner: boolean; origin_template_id: string }>(
        'select name, is_owner, origin_template_id from app.role order by name',
      ),
    );
    expect(res.rows).toHaveLength(5);
    expect(res.rows.map((r) => r.name)).toEqual(
      [...TEMPLATE_ROLES].map((r) => r.name).sort((a, b) => a.localeCompare(b)),
    );
    expect(res.rows.every((r) => r.origin_template_id === TEMPLATE_ID)).toBe(true);
    expect(res.rows.filter((r) => r.is_owner)).toHaveLength(1);
  });

  it('seeds no users and no assignments — those are onboarding input, not template content', async () => {
    const users = await db.withTenant(T1, (tx) =>
      tx.query<{ n: string }>('select count(*)::text as n from app.user_account'),
    );
    const assignments = await db.withTenant(T1, (tx) =>
      tx.query<{ n: string }>('select count(*)::text as n from app.user_role_assignment'),
    );
    expect(Number(users.rows[0]!.n)).toBe(0);
    expect(Number(assignments.rows[0]!.n)).toBe(0);
  });

  it('a tenant cannot end up with two owner roles', async () => {
    await expect(
      db.asAdmin((tx) =>
        tx.query(
          `update app.role set is_owner = true
            where tenant_id = $1 and origin_ref = 'role:accounts'`,
          [T1],
        ),
      ),
    ).rejects.toThrow(/role_owner_uq|unique/i);
  });

  it('the owner role — the visible escalation path — cannot be deleted', async () => {
    await expect(
      db.asAdmin((tx) =>
        tx.query(`delete from app.role where tenant_id = $1 and is_owner`, [T1]),
      ),
    ).rejects.toThrow(/owner role cannot be deleted/i);
    await expect(
      db.asAdmin((tx) =>
        tx.query(
          `update app.role set deleted_at = transaction_timestamp()
            where tenant_id = $1 and is_owner`,
          [T1],
        ),
      ),
    ).rejects.toThrow(/owner role cannot be soft-deleted/i);
  });

  it('re-applying the template changes nothing (roles included)', async () => {
    const snapshot = () =>
      db.withTenant(T1, (tx) =>
        tx.query<{ t: string; n: string }>(`
          select 'role' as t, count(*)::text as n from app.role
          union all select 'role_permission', count(*)::text from app.role_permission
          order by t
        `),
      );
    const before = await snapshot();
    await db.withTenant(T1, (tx) => applyTemplate(tx, T1));
    expect((await snapshot()).rows).toEqual(before.rows);
  });
});

describe('THE TWO HARD PROHIBITIONS, resolved from data', () => {
  let counterUser: string;
  let accountsUser: string;
  let founderUser: string;

  beforeAll(async () => {
    await db.withTenant(T1, async (tx) => {
      counterUser = await makeUser(tx, T1, 'kofi.counter');
      accountsUser = await makeUser(tx, T1, 'ama.accounts');
      founderUser = await makeUser(tx, T1, 'the.founder');
      await assignRole(tx, T1, {
        userId: counterUser,
        roleId: roleIdByRef.get('counter_staff')!,
        scopeLocationId: flagship,
      });
      await assignRole(tx, T1, {
        userId: accountsUser,
        roleId: roleIdByRef.get('accounts')!,
        scopeLocationId: rootLoc,
      });
      await assignRole(tx, T1, {
        userId: founderUser,
        roleId: roleIdByRef.get('head_of_operations')!,
        scopeLocationId: rootLoc,
      });
    });
  });

  it("the counter role's composition simply lacks both permissions", async () => {
    const res = await db.withTenant(T1, (tx) =>
      tx.query<{ permission_code: string }>(
        `select rp.permission_code
           from app.role_permission rp
           join app.role r on r.tenant_id = rp.tenant_id and r.id = rp.role_id
          where r.origin_ref = 'role:counter_staff'`,
      ),
    );
    const codes = res.rows.map((r) => r.permission_code);
    expect(codes.length).toBeGreaterThan(0);
    for (const restricted of BRIEF_RESTRICTED_PERMISSIONS) {
      expect(codes).not.toContain(restricted);
    }
  });

  it('a counter-staff user resolves WITHOUT price override and WITHOUT credit-limit change', async () => {
    const ep = await db.withTenant(T1, (tx) => effectivePermissions(tx, counterUser));
    const codes = permissionCodesAt(ep, flagship);
    expect(codes).toContain('sale.record'); // they can do their job
    for (const restricted of BRIEF_RESTRICTED_PERMISSIONS) {
      expect(codes).not.toContain(restricted);
      expect(hasPermissionAt(ep, restricted, flagship)).toBe(false);
      // ...and not at the root or anywhere else in the network either.
      expect(hasPermissionAt(ep, restricted, rootLoc)).toBe(false);
    }
  });

  it('their credit-sale capability is bounded to zero, not absent — a manager can raise it', async () => {
    const ep = await db.withTenant(T1, (tx) => effectivePermissions(tx, counterUser));
    expect(hasPermissionAt(ep, 'sale.record.credit', flagship)).toBe(true);
    expect(ep.byCode.get('sale.record.credit')!.get(flagship)!.bound).toEqual({
      max_order_value_minor: '0',
    });
  });

  it('the counter role reaches their outlet and its transit node — not the network', async () => {
    const ep = await db.withTenant(T1, (tx) => effectivePermissions(tx, counterUser));
    const locations = [...new Set(ep.rows.map((r) => r.locationId))];
    // Two nodes, and both of them are theirs: the outlet, plus the durable
    // TRANSIT child that holds their own goods in motion (04 §4.7.3). That
    // falls out of the closure tree — it is not a special case — and it is
    // exactly the behaviour a transfer needs. 55 of the network's 57 nodes
    // remain out of reach.
    expect(locations).toHaveLength(2);
    const codes = await db.withTenant(T1, (tx) =>
      tx.query<{ code: string; parent_id: string }>(
        'select code, parent_id from app.location where id = any($1::uuid[]) order by code',
        [locations],
      ),
    );
    expect(codes.rows.map((r) => r.code.slice(0, 3)).sort()).toEqual(['OUT', 'TRA']);
    expect(locations).toContain(flagship);
  });

  it('accounts HOLDS credit.limit.change — the brief restricts counter staff, not the capability', async () => {
    const ep = await db.withTenant(T1, (tx) => effectivePermissions(tx, accountsUser));
    expect(hasPermissionAt(ep, 'credit.limit.change', rootLoc)).toBe(true);
    expect(hasPermissionAt(ep, 'payroll.register.export', rootLoc)).toBe(true);
    // Segregation of duties: accounts does not sell and does not adjust stock.
    expect(hasPermissionAt(ep, 'sale.record', flagship)).toBe(false);
    expect(hasPermissionAt(ep, 'stock.adjust', flagship)).toBe(false);
    // ...and still no price override.
    expect(hasPermissionAt(ep, 'sale.override_price', flagship)).toBe(false);
  });

  it('the founder holds the whole catalogue at every one of the 57 nodes', async () => {
    const ep = await db.withTenant(T1, (tx) => effectivePermissions(tx, founderUser));
    expect(permissionCodesAt(ep, flagship)).toEqual([...PERMISSION_CODES].sort());
    const locations = new Set(ep.rows.map((r) => r.locationId));
    expect(locations.size).toBe(57); // 1 root + 6 regions + 25 outlets + 25 transit
  });

  it('RENAMING the counter role changes nothing — no platform code reads the name', async () => {
    await db.asAdmin((tx) =>
      tx.query(
        `update app.role set name = 'Tellers' where tenant_id = $1 and origin_ref = 'role:counter_staff'`,
        [T1],
      ),
    );
    const ep = await db.withTenant(T1, (tx) => effectivePermissions(tx, counterUser));
    expect(hasPermissionAt(ep, 'sale.record', flagship)).toBe(true);
    for (const restricted of BRIEF_RESTRICTED_PERMISSIONS) {
      expect(hasPermissionAt(ep, restricted, flagship)).toBe(false);
    }
  });

  it('a tenant that WANTS counter staff to override prices can grant it, visibly, by adding a row', async () => {
    // This is not a hole — it is the design. The platform does not police a
    // tenant's org chart (CLAUDE.md §2.9); it guarantees that the capability
    // is only ever reachable through a check, and that granting it is an
    // explicit, auditable act with a name attached.
    const before = await db.withTenant(T1, (tx) => effectivePermissions(tx, counterUser));
    expect(hasPermissionAt(before, 'sale.override_price', flagship)).toBe(false);

    await db.asAdmin((tx) =>
      tx.query(
        `insert into app.role_permission (tenant_id, id, write_id, hlc, role_id, permission_code)
         select r.tenant_id, md5(r.id::text || ':override')::uuid, r.write_id, r.hlc,
                r.id, 'sale.override_price'
           from app.role r
          where r.tenant_id = $1 and r.origin_ref = 'role:counter_staff'`,
        [T1],
      ),
    );
    try {
      const after = await db.withTenant(T1, (tx) => effectivePermissions(tx, counterUser));
      expect(hasPermissionAt(after, 'sale.override_price', flagship)).toBe(true);
      // Still scoped: their one outlet, never the network.
      expect(hasPermissionAt(after, 'sale.override_price', rootLoc)).toBe(false);
    } finally {
      await db.asAdmin((tx) =>
        tx.query(
          `delete from app.role_permission
            where tenant_id = $1 and permission_code = 'sale.override_price'
              and role_id in (select id from app.role
                               where tenant_id = $1 and origin_ref = 'role:counter_staff')`,
          [T1],
        ),
      );
    }
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH SHIPPED ROLES PUT THE WHOLE CREDIT BOOK ON A TABLET
 * ═══════════════════════════════════════════════════════════════════════════
 * Migration 0013 gave `credit.view` a second meaning it did not have when the
 * template was written. It used to authorise a READ the server answers one
 * account at a time and can refuse the next second. It now also decides
 * membership of `app.credit_sync_book_scope`, and therefore whether a device
 * downloads ~400 days of every credit customer's balance, ageing and payment
 * history and keeps it.
 *
 * `02-security-and-access-control` §2.5: THE RIGHT TO SEE SOMETHING IS NOT THE
 * RIGHT TO HAVE IT ON YOUR DEVICE. `docs/credit-offline-plan.md` R1.b says so
 * in as many words — "`credit.view` must never be in the counter-staff or
 * outlet-manager template role" — and `infra/powersync/sync_rules.yaml` repeats
 * it above the `tenant_credit` bucket.
 *
 * The shipped template grants it to **Outlet manager** and **Regional
 * manager** as well as Accounts. These tests PIN that, they do not endorse it:
 * the exposure is real, it is named in §6 of `docs/phase1-status.md`, and
 * removing the grant is a product decision (it also removes the ONLINE credit
 * reads those roles have today, and `app.credit_allowance` — the counter's
 * intended replacement — is deliberately unpopulated until 06 §6.7's cap
 * leases exist). When that decision is taken, these two tests go red and say
 * exactly what to change.
 *
 * The mitigation that IS in force is the residency gate: only a grant at the
 * tenant ROOT confers the book. An outlet manager assigned at their outlet, or
 * a regional manager at their region, receives nothing — proven in
 * `credit-position.test.ts`, "admits a ROOT-scoped credit.view holder and
 * refuses an OUTLET-scoped one".
 */
describe('credit.view is now a device-residency decision, not only a read', () => {
  it('PINNED: three template roles hold credit.view — R1.b says exactly one should', () => {
    const holders = TEMPLATE_ROLES.filter((r) =>
      r.permissions.some((p) => p.code === 'credit.view'),
    )
      .map((r) => r.ref)
      .sort();
    expect(holders).toEqual(['accounts', 'outlet_manager', 'regional_manager']);
  });

  it('a ROOT-scoped outlet manager is in the credit sync book scope; the same role at an OUTLET is not', async () => {
    const atRoot = await db.withTenant(T1, (tx) => makeUser(tx, T1, 'tpl-om-root'));
    const atOutlet = await db.withTenant(T1, (tx) => makeUser(tx, T1, 'tpl-om-outlet'));
    const om = roleIdByRef.get('outlet_manager')!;
    await db.withTenant(T1, (tx) =>
      assignRole(tx, T1, { userId: atRoot, roleId: om, scopeLocationId: rootLoc }),
    );
    await db.withTenant(T1, (tx) =>
      assignRole(tx, T1, { userId: atOutlet, roleId: om, scopeLocationId: flagship }),
    );
    const held = await db.withTenant(T1, (tx) =>
      tx.query<{ user_id: string }>(
        `select user_id from app.credit_sync_book_scope where user_id = any($1::uuid[])`,
        [[atRoot, atOutlet]],
      ),
    );
    // The positive control and the refusal come from ONE query in ONE run:
    // this is the residency gate doing the narrowing the template does not.
    expect(held.rows.map((r) => r.user_id)).toEqual([atRoot]);
  });

  it('counter staff hold sale.record.credit and NOT credit.view — the counter never gets the book', () => {
    const counter = TEMPLATE_ROLES.find((r) => r.ref === 'counter_staff')!;
    const codes = counter.permissions.map((p) => p.code);
    expect(codes).toContain('sale.record.credit');
    expect(codes).not.toContain('credit.view');
  });
});
