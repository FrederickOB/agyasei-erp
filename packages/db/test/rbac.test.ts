/**
 * Effective-permission RESOLUTION.
 *
 * The whole point of this suite is the case that a single-role, single-outlet
 * model gets wrong: a user holding SEVERAL roles at SEVERAL scopes. The union
 * must be per LOCATION, and a permission granted at one location must not
 * silently apply at another — which is exactly the bug that "role" columns
 * and "locs" claims produce.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authorize,
  boundAt,
  catalogueDrift,
  effectivePermissions,
  hasPermissionAt,
  hasPermissionAnywhere,
  locationsFor,
  mergeBounds,
  permissionCodesAt,
  PERMISSION_CODES,
} from '../src/permissions.js';
import type { TestDb } from '../src/testing/harness.js';
import { assignRole, makeLocation, makeRole, makeUser } from './rbac-fixtures.js';
import { setupDb, setupTwoTenants, TENANT_A } from './util.js';

let db: TestDb;

// The tree:  root ─┬─ regionN ─┬─ outletA
//                  │           └─ outletB
//                  └─ regionS ──── outletC
let root: string;
let regionN: string;
let regionS: string;
let outletA: string;
let outletB: string;
let outletC: string;

let uMulti: string; // three roles at three different depths
let uOwner: string; // the owner role at the root
let uLapsed: string; // an assignment whose window has closed
let uSuspended: string; // an active assignment on a suspended account

let rSell: string;
let rYard: string;
let rReport: string;
let rOwner: string;

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);

  await db.withTenant(TENANT_A, async (tx) => {
    root = await makeLocation(tx, TENANT_A, { code: 'ROOT', kind: 'GROUP' });
    regionN = await makeLocation(tx, TENANT_A, { code: 'REG-N', kind: 'GROUP', parentId: root });
    regionS = await makeLocation(tx, TENANT_A, { code: 'REG-S', kind: 'GROUP', parentId: root });
    outletA = await makeLocation(tx, TENANT_A, { code: 'OUT-A', parentId: regionN });
    outletB = await makeLocation(tx, TENANT_A, { code: 'OUT-B', parentId: regionN });
    outletC = await makeLocation(tx, TENANT_A, { code: 'OUT-C', parentId: regionS });

    rSell = await makeRole(tx, TENANT_A, {
      name: 'Sells things',
      permissions: [
        { code: 'sale.record' },
        { code: 'sale.record.credit', bound: { max_order_value_minor: '0' } },
      ],
    });
    rYard = await makeRole(tx, TENANT_A, {
      name: 'Runs the yard',
      permissions: [
        { code: 'stock.adjust' },
        { code: 'sale.record.credit', bound: { max_order_value_minor: '500000' } },
      ],
    });
    rReport = await makeRole(tx, TENANT_A, {
      name: 'Reads the numbers',
      permissions: [{ code: 'report.view.tenant' }],
    });
    rOwner = await makeRole(tx, TENANT_A, { name: 'Runs the company', isOwner: true });

    uMulti = await makeUser(tx, TENANT_A, 'multi');
    uOwner = await makeUser(tx, TENANT_A, 'owner');
    uLapsed = await makeUser(tx, TENANT_A, 'lapsed');
    uSuspended = await makeUser(tx, TENANT_A, 'suspended', 'SUSPENDED');

    // Three roles, three depths: leaf, region, root.
    await assignRole(tx, TENANT_A, { userId: uMulti, roleId: rSell, scopeLocationId: outletA });
    await assignRole(tx, TENANT_A, { userId: uMulti, roleId: rYard, scopeLocationId: regionN });
    await assignRole(tx, TENANT_A, { userId: uMulti, roleId: rReport, scopeLocationId: root });

    await assignRole(tx, TENANT_A, { userId: uOwner, roleId: rOwner, scopeLocationId: root });

    await assignRole(tx, TENANT_A, {
      userId: uLapsed,
      roleId: rYard,
      scopeLocationId: root,
      effectiveFrom: '2020-01-01T00:00:00Z',
      effectiveTo: '2021-01-01T00:00:00Z',
    });
    await assignRole(tx, TENANT_A, {
      userId: uSuspended,
      roleId: rYard,
      scopeLocationId: root,
    });
  });
});

afterAll(async () => {
  await db.close();
});

const resolve = (userId: string) =>
  db.withTenant(TENANT_A, (tx) => effectivePermissions(tx, userId));

describe('the location closure', () => {
  it('is built by trigger from the adjacency list, self row included', async () => {
    const res = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ code: string; depth: number }>(
        `select l.code, c.depth
           from app.location_closure c
           join app.location l on l.tenant_id = c.tenant_id and l.id = c.descendant_id
          where c.ancestor_id = $1 order by c.depth, l.code`,
        [regionN],
      ),
    );
    expect(res.rows).toEqual([
      { code: 'REG-N', depth: 0 },
      { code: 'OUT-A', depth: 1 },
      { code: 'OUT-B', depth: 1 },
    ]);
  });

  it('the root reaches all six nodes; a leaf reaches only itself', async () => {
    const count = async (anc: string) =>
      Number(
        (
          await db.withTenant(TENANT_A, (tx) =>
            tx.query<{ n: string }>(
              'select count(*)::text as n from app.location_closure where ancestor_id = $1',
              [anc],
            ),
          )
        ).rows[0]!.n,
      );
    expect(await count(root)).toBe(6);
    expect(await count(outletA)).toBe(1);
  });
});

describe('effectivePermissions — multi-role, multi-scope', () => {
  it('unions permissions PER LOCATION, at three different depths', async () => {
    const ep = await resolve(uMulti);
    // Granted at the leaf: nowhere else.
    expect(locationsFor(ep, 'sale.record')).toEqual([outletA]);
    // Granted at the region: the region node and both its outlets.
    expect(locationsFor(ep, 'stock.adjust').sort()).toEqual([outletA, outletB, regionN].sort());
    // Granted at the root: every node in the tree.
    expect(locationsFor(ep, 'report.view.tenant')).toHaveLength(6);
  });

  it('THE TRAP: a permission granted at one location does not apply at another', async () => {
    const ep = await resolve(uMulti);
    expect(hasPermissionAt(ep, 'sale.record', outletA)).toBe(true);
    // Same tenant, same user, sibling outlet under the SAME region — and no.
    expect(hasPermissionAt(ep, 'sale.record', outletB)).toBe(false);
    // A different region entirely: neither sale.record nor stock.adjust.
    expect(hasPermissionAt(ep, 'stock.adjust', outletC)).toBe(false);
    expect(hasPermissionAt(ep, 'sale.record', outletC)).toBe(false);
    // ...even though the user genuinely holds stock.adjust — somewhere else.
    expect(hasPermissionAnywhere(ep, 'stock.adjust')).toBe(true);
  });

  it('distinguishes "not here" from "not at all"', async () => {
    const ep = await resolve(uMulti);
    expect(authorize(ep, 'sale.record', { locationId: outletB })).toEqual({
      allow: false,
      reason: 'out_of_scope',
    });
    expect(authorize(ep, 'sale.override_price', { locationId: outletA })).toEqual({
      allow: false,
      reason: 'no_permission',
    });
  });

  it('merges bounds most-permissively, and only where both grants reach', async () => {
    const ep = await resolve(uMulti);
    // outletA has BOTH grants: bound 0 (leaf role) ∪ bound 500000 (region role).
    expect(boundAt(ep, 'sale.record.credit', outletA)).toEqual({
      max_order_value_minor: '500000',
    });
    // outletB has only the region role, so the same bound and nothing else.
    expect(boundAt(ep, 'sale.record.credit', outletB)).toEqual({
      max_order_value_minor: '500000',
    });
    // outletC has neither.
    expect(hasPermissionAt(ep, 'sale.record.credit', outletC)).toBe(false);
  });

  it('enforces a money bound with bigint arithmetic, never a float', async () => {
    const ep = await resolve(uMulti);
    const under = authorize(ep, 'sale.record.credit', {
      locationId: outletA,
      amountMinor: 499_999n,
    });
    expect(under.allow).toBe(true);
    expect(
      authorize(ep, 'sale.record.credit', { locationId: outletA, amountMinor: 500_000n }).allow,
    ).toBe(true);
    expect(
      authorize(ep, 'sale.record.credit', { locationId: outletA, amountMinor: 500_001n }),
    ).toEqual({ allow: false, reason: 'bound_exceeded' });
  });

  it('records WHICH assignment authorised each decision (audit grant_id)', async () => {
    const ep = await resolve(uMulti);
    const d = authorize(ep, 'stock.adjust', { locationId: outletB });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.grantIds).toHaveLength(1);
  });

  it('the owner role holds the WHOLE catalogue, everywhere in its scope', async () => {
    const ep = await resolve(uOwner);
    expect(permissionCodesAt(ep, outletC)).toEqual([...PERMISSION_CODES].sort());
    expect(permissionCodesAt(ep, root)).toHaveLength(PERMISSION_CODES.length);
    // Including the two the brief restricts — this is the visible escalation
    // path, not a back door.
    expect(hasPermissionAt(ep, 'sale.override_price', outletA)).toBe(true);
    expect(hasPermissionAt(ep, 'credit.limit.change', outletA)).toBe(true);
  });

  it('an assignment outside its effective window resolves to nothing', async () => {
    const ep = await resolve(uLapsed);
    expect(ep.rows).toEqual([]);
  });

  it('a suspended account resolves to nothing even with a live assignment', async () => {
    const ep = await resolve(uSuspended);
    expect(ep.rows).toEqual([]);
  });

  it('removing a permission from a role removes it everywhere that role reaches', async () => {
    const before = await resolve(uMulti);
    expect(hasPermissionAt(before, 'stock.adjust', outletB)).toBe(true);
    await db.asAdmin((tx) =>
      tx.query(
        `update app.role_permission set deleted_at = transaction_timestamp()
          where tenant_id = $1 and role_id = $2 and permission_code = 'stock.adjust'`,
        [TENANT_A, rYard],
      ),
    );
    try {
      const after = await resolve(uMulti);
      expect(hasPermissionAnywhere(after, 'stock.adjust')).toBe(false);
    } finally {
      await db.asAdmin((tx) =>
        tx.query(
          `update app.role_permission set deleted_at = null
            where tenant_id = $1 and role_id = $2 and permission_code = 'stock.adjust'`,
          [TENANT_A, rYard],
        ),
      );
    }
  });

  it('reparenting a location moves scope with it — no authorization migration', async () => {
    // The FY3 move: outletC leaves the south region and joins the north one.
    await db.asAdmin((tx) =>
      tx.query('update app.location set parent_id = $1 where tenant_id = $2 and id = $3', [
        regionN,
        TENANT_A,
        outletC,
      ]),
    );
    try {
      const ep = await resolve(uMulti);
      expect(hasPermissionAt(ep, 'stock.adjust', outletC)).toBe(true);
    } finally {
      await db.asAdmin((tx) =>
        tx.query('update app.location set parent_id = $1 where tenant_id = $2 and id = $3', [
          regionS,
          TENANT_A,
          outletC,
        ]),
      );
    }
    const restored = await resolve(uMulti);
    expect(hasPermissionAt(restored, 'stock.adjust', outletC)).toBe(false);
  });
});

describe('app.user_location_scope — the SYNC boundary\u2019s question', () => {
  it('is the flattened set of locations a user touches, and nothing wider', async () => {
    const res = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ location_id: string }>(
        'select location_id from app.user_location_scope where user_id = $1',
        [uMulti],
      ),
    );
    const ids = res.rows.map((r) => r.location_id).sort();
    // Root assignment reaches everything, so this user's device COULD be
    // sent all six nodes' data. That is precisely why sync scope is a
    // separate, narrower grant than permission (02 §2.5) — the view answers
    // "may see", not "should download".
    expect(ids).toEqual([root, regionN, regionS, outletA, outletB, outletC].sort());
  });

  it('is empty for a lapsed assignment and for a suspended account', async () => {
    for (const user of [uLapsed, uSuspended]) {
      const res = await db.withTenant(TENANT_A, (tx) =>
        tx.query('select * from app.user_location_scope where user_id = $1', [user]),
      );
      expect(res.rows).toEqual([]);
    }
  });
});

describe('the catalogue', () => {
  it('platform.permission and PERMISSION_CODES do not drift', async () => {
    const drift = await db.withTenant(TENANT_A, (tx) => catalogueDrift(tx));
    expect(drift).toEqual({ missingInDb: [], missingInCode: [] });
  });

  it('is GLOBAL platform data: no tenant_id column, readable by the app role', async () => {
    const cols = await db.query<{ attname: string }>(
      `select a.attname from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'platform' and c.relname = 'permission'
          and a.attnum > 0 and not a.attisdropped`,
    );
    expect(cols.rows.map((r) => r.attname)).not.toContain('tenant_id');
    const seen = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ n: string }>('select count(*)::text as n from platform.permission'),
    );
    expect(Number(seen.rows[0]!.n)).toBe(PERMISSION_CODES.length);
  });

  it('a role cannot be composed from a permission code the platform does not define', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        makeRole(tx, TENANT_A, {
          name: 'Invented capability',
          permissions: [{ code: 'sale.super_record' }],
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('carries no tenant #1 vocabulary in any code', async () => {
    const banned = /outlet|flagship|rdc|micro|agyasei|techiman|contractor|cement/i;
    expect(PERMISSION_CODES.filter((c) => banned.test(c))).toEqual([]);
  });
});

describe('mergeBounds', () => {
  it('unbounded beats every bound', () => {
    expect(mergeBounds(null, { max_bps: 300 })).toBeNull();
    expect(mergeBounds({ max_bps: 300 }, null)).toBeNull();
  });

  it('takes the larger integer, and money stays a decimal string', () => {
    expect(
      mergeBounds({ max_order_value_minor: '900719925474099100' }, {
        max_order_value_minor: '900719925474099200',
      }),
    ).toEqual({ max_order_value_minor: '900719925474099200' });
  });

  it('drops a dimension the other grant does not constrain at all', () => {
    expect(mergeBounds({ max_bps: 300 }, { max_order_value_minor: '5' })).toEqual({});
  });
});
