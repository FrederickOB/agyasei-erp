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
import { readFile } from 'node:fs/promises';
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
import { uuidv7 } from '../src/ids.js';
import { assignRole, makeUser } from './rbac-fixtures.js';
import { newWrite, nextHlc, setupDb } from './util.js';

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
 * outlet-manager template role" — §2's own template table gives `credit.read`
 * (this catalogue's `credit.view`) to Accounts and to nobody else, and
 * `infra/powersync/sync_rules.yaml` repeats it above the `tenant_credit` bucket.
 *
 * The template used to grant it to Outlet manager and Regional manager as well.
 * These tests no longer PIN that divergence — they ENFORCE its absence, which is
 * the only durable protection available: the database cannot forbid the grant
 * (CLAUDE.md §2.9 — a tenant may compose whatever role it likes, and one whose
 * org chart genuinely puts the book in a branch office may), so the guard has to
 * sit on THIS FILE. Re-adding the code to either role turns the first test red
 * and names the role that did it.
 *
 * Two layers, and both are needed:
 *   1. the TEMPLATE (here) — the code is not granted to a counter or outlet role
 *      in the first place, so no assignment scope can confer the book;
 *   2. the RESIDENCY GATE (migration 0013) — only a grant at the tenant ROOT
 *      confers it, so even a root-happy tenant assigning Accounts at a leaf gets
 *      nothing. Proven below and in `credit-position.test.ts`, "admits a
 *      ROOT-scoped credit.view holder and refuses an OUTLET-scoped one".
 */
describe('credit.view is a device-residency decision, not only a read', () => {
  it('exactly ONE template role holds credit.view — Accounts', () => {
    const holders = TEMPLATE_ROLES.filter((r) =>
      r.permissions.some((p) => p.code === 'credit.view'),
    )
      .map((r) => r.ref)
      .sort();
    expect(holders).toEqual(['accounts']);
  });

  it('NEITHER the counter-staff NOR the outlet-manager role grants credit.view — R1.b, verbatim', () => {
    // Named separately from the test above, and asserted per role, so a future
    // seed edit gets a failure that says WHICH role reintroduced it rather than
    // an array diff. This is the regression guard the fix is worth nothing
    // without: the template is the only place this rule can live.
    for (const ref of ['counter_staff', 'outlet_manager'] as const) {
      const role = TEMPLATE_ROLES.find((r) => r.ref === ref)!;
      const codes = role.permissions.map((p) => p.code);
      expect(codes, `${ref} must not grant credit.view (credit-offline-plan R1.b)`).not.toContain(
        'credit.view',
      );
    }
  });

  it('the regional-manager role does not inherit it through the spread either', () => {
    // It is composed as OUTLET_MANAGER.permissions minus two codes, so removing
    // the grant upstream silently removes it here too. Assert it, because the
    // next person to re-add a code to the outlet role will not be thinking
    // about this one — and a regional manager's tablet travels across six
    // regions, which is a field device, not a back office.
    const regional = TEMPLATE_ROLES.find((r) => r.ref === 'regional_manager')!;
    expect(regional.permissions.map((p) => p.code)).not.toContain('credit.view');
  });

  it('a ROOT-scoped OUTLET MANAGER is now OUT of the credit sync book scope, and a ROOT-scoped ACCOUNTS user is in it', async () => {
    // The positive control and the refusal come from ONE query in ONE run, so
    // "the manager is absent" cannot mean "the projection is empty" or "the
    // fixture never ran". Both users sit at the SAME node — the tenant root,
    // the only scope that confers the book at all — so the ONLY thing that
    // differs is the role's composition. This is the test the template fix
    // exists to turn green; before it, the manager was in this list.
    const managerAtRoot = await db.withTenant(T1, (tx) => makeUser(tx, T1, 'tpl-om-root'));
    const accountsAtRoot = await db.withTenant(T1, (tx) => makeUser(tx, T1, 'tpl-acc-root'));
    await db.withTenant(T1, (tx) =>
      assignRole(tx, T1, {
        userId: managerAtRoot,
        roleId: roleIdByRef.get('outlet_manager')!,
        scopeLocationId: rootLoc,
      }),
    );
    await db.withTenant(T1, (tx) =>
      assignRole(tx, T1, {
        userId: accountsAtRoot,
        roleId: roleIdByRef.get('accounts')!,
        scopeLocationId: rootLoc,
      }),
    );
    const held = await db.withTenant(T1, (tx) =>
      tx.query<{ user_id: string }>(
        `select user_id from app.credit_sync_book_scope where user_id = any($1::uuid[])`,
        [[managerAtRoot, accountsAtRoot]],
      ),
    );
    expect(held.rows.map((r) => r.user_id)).toEqual([accountsAtRoot]);
  });

  it('the residency gate still narrows the role that DOES hold it — Accounts at an OUTLET receives nothing', async () => {
    // The second layer, on the role that legitimately carries the code. A
    // credit account has no location (06 §6.5), so an outlet-scoped grant is a
    // right the tenant-keyed bucket cannot express and must not serve.
    const accountsAtOutlet = await db.withTenant(T1, (tx) => makeUser(tx, T1, 'tpl-acc-outlet'));
    await db.withTenant(T1, (tx) =>
      assignRole(tx, T1, {
        userId: accountsAtOutlet,
        roleId: roleIdByRef.get('accounts')!,
        scopeLocationId: flagship,
      }),
    );
    const held = await db.withTenant(T1, (tx) =>
      tx.query<{ user_id: string }>(
        `select user_id from app.credit_sync_book_scope where user_id = $1`,
        [accountsAtOutlet],
      ),
    );
    expect(held.rows).toEqual([]);
  });

  it('counter staff hold sale.record.credit and NOT credit.view — the counter never gets the book', () => {
    const counter = TEMPLATE_ROLES.find((r) => r.ref === 'counter_staff')!;
    const codes = counter.permissions.map((p) => p.code);
    expect(codes).toContain('sale.record.credit');
    expect(codes).not.toContain('credit.view');
  });

  it('an outlet manager keeps the capability that lets them SELL on credit — the fix removes a read, not their job', () => {
    // Stated as its own assertion because the failure mode of over-correcting
    // here is a role that cannot do the work: `sale.record.credit` with its
    // bound is what "credit sales up to a set limit" means, and it is also the
    // gate on `location_credit_allowance` (credit-offline-plan R1.a) — the
    // narrower, per-location headroom slice that replaces the book at the till
    // once 06 §6.7's cap leases exist.
    const manager = TEMPLATE_ROLES.find((r) => r.ref === 'outlet_manager')!;
    const credit = manager.permissions.find((p) => p.code === 'sale.record.credit');
    expect(credit?.bound).toEqual({ max_order_value_minor: '500000' });
    expect(manager.permissions.map((p) => p.code)).toContain('customer.view');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MIGRATION 0014 — THE OTHER HALF OF THE FIX
 * ═══════════════════════════════════════════════════════════════════════════
 * The seed correction above protects tenants provisioned from tomorrow. Every
 * tenant provisioned before it is still carrying the grant, and its devices are
 * still holding the book — so the fix is only real if the migration's predicate
 * matches the rows `applyTemplate` actually wrote. That is what these two tests
 * check, by rebuilding the pre-fix row exactly as the applier built it (same
 * role, same `write_id`, same `origin`/`op` on the write-log entry) and running
 * the migration file itself.
 *
 * The second test is the one that stops this migration being too blunt: a grant
 * the TENANT added is a decision the tenant owns (ADR-0006) and the platform
 * must not silently revoke it. 0014 warns and leaves it.
 *
 * Placed last in the file: it mutates T1's role rows, so nothing may run after.
 */
describe('migration 0014 withdraws the grant from a tenant already provisioned', () => {
  const MIGRATION = new URL(
    '../migrations/0014_credit_view_template_correction.sql',
    import.meta.url,
  );

  let managerAtRoot: string;
  let regionalAtRoot: string;

  beforeAll(async () => {
    const templateWrite = await db.withTenant(T1, (tx) =>
      tx.query<{ id: string }>(
        `select id from app.write_log where op = 'template.apply:roles' and origin = 'SERVER'`,
      ),
    );
    const writeId = templateWrite.rows[0]!.id;
    expect(writeId).toBeDefined();

    // (a) THE PRE-FIX ROW, rebuilt byte-for-byte in provenance: the applier's
    //     own write_log entry, on the template's own outlet_manager role.
    // (b) A TENANT-MADE ROW on the regional role, carrying an ordinary DEVICE
    //     write — indistinguishable by role, distinguishable by write.
    await db.withTenant(T1, async (tx) => {
      const tenantWrite = await newWrite(tx, T1, 'role.grant');
      await tx.query(
        `insert into app.role_permission (tenant_id, id, write_id, hlc, role_id, permission_code)
         values ($1, $2, $3, $4, $5, 'credit.view'), ($1, $6, $7, $8, $9, 'credit.view')`,
        [
          T1,
          uuidv7(),
          writeId,
          nextHlc(),
          roleIdByRef.get('outlet_manager')!,
          uuidv7(),
          tenantWrite,
          nextHlc(),
          roleIdByRef.get('regional_manager')!,
        ],
      );
    });

    managerAtRoot = await db.withTenant(T1, (tx) => makeUser(tx, T1, 'mig-om-root'));
    regionalAtRoot = await db.withTenant(T1, (tx) => makeUser(tx, T1, 'mig-rm-root'));
    await db.withTenant(T1, (tx) =>
      assignRole(tx, T1, {
        userId: managerAtRoot,
        roleId: roleIdByRef.get('outlet_manager')!,
        scopeLocationId: rootLoc,
      }),
    );
    await db.withTenant(T1, (tx) =>
      assignRole(tx, T1, {
        userId: regionalAtRoot,
        roleId: roleIdByRef.get('regional_manager')!,
        scopeLocationId: rootLoc,
      }),
    );

    // The exposure, before: BOTH principals are holding the whole book. If this
    // is ever empty the test below proves nothing, so it is asserted, not assumed.
    const before = await db.withTenant(T1, (tx) =>
      tx.query<{ user_id: string }>(
        `select user_id from app.credit_sync_book_scope where user_id = any($1::uuid[]) order by user_id`,
        [[managerAtRoot, regionalAtRoot].sort()],
      ),
    );
    expect(before.rows.map((r) => r.user_id)).toEqual([managerAtRoot, regionalAtRoot].sort());

    // Run the migration file itself — not a paraphrase of it. `exec` is the
    // same call the runner makes. (Under PGlite this connects as a superuser,
    // which BYPASSES rls; the per-tenant `set_config` in the DO block is what
    // makes the same SQL work for the schema owner in production, where FORCE
    // ROW LEVEL SECURITY does apply. The predicate is what is under test here.)
    await db.exec(await readFile(MIGRATION, 'utf8'));
  }, 120_000);

  it('withdraws the TEMPLATE-written grant and takes the book off that device', async () => {
    const row = await db.withTenant(T1, (tx) =>
      tx.query<{ deleted_at: string | null }>(
        `select deleted_at from app.role_permission
          where role_id = $1 and permission_code = 'credit.view'`,
        [roleIdByRef.get('outlet_manager')!],
      ),
    );
    // Soft-deleted, not erased: the row IS the audit record that this tenant's
    // outlet manager once held it (app.effective_permission reads deleted_at).
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.deleted_at).not.toBeNull();

    const held = await db.withTenant(T1, (tx) =>
      tx.query<{ user_id: string }>(
        `select user_id from app.credit_sync_book_scope where user_id = $1`,
        [managerAtRoot],
      ),
    );
    expect(held.rows).toEqual([]);
  });

  it('LEAVES a grant the tenant made itself — the platform corrects its own row, not the tenant org chart', async () => {
    const row = await db.withTenant(T1, (tx) =>
      tx.query<{ deleted_at: string | null }>(
        `select deleted_at from app.role_permission
          where role_id = $1 and permission_code = 'credit.view'`,
        [roleIdByRef.get('regional_manager')!],
      ),
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.deleted_at).toBeNull();

    // And it still works, which is the whole point of not touching it: a tenant
    // that deliberately put the book in a regional office still has it there.
    // 0014 raises a WARNING naming the tenant instead of silently revoking.
    const held = await db.withTenant(T1, (tx) =>
      tx.query<{ user_id: string }>(
        `select user_id from app.credit_sync_book_scope where user_id = $1`,
        [regionalAtRoot],
      ),
    );
    expect(held.rows.map((r) => r.user_id)).toEqual([regionalAtRoot]);
  });
});
