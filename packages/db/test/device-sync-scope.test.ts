/**
 * Migrations 0023 + 0024 — the device registry and the projections the sync
 * rules now read instead of a token claim (02 §2.3 Contract 1, §2.5, §2.7).
 *
 * What is proved here, at the SQL level, as app_user under forced RLS:
 *
 *   1. The projection is the INTERSECTION of the user's scope and the device's
 *      ceiling, closure-expanded, syncable kinds only — and nothing wider.
 *   2. Every revocation path EMPTIES it for that device: retiring the device,
 *      suspending it, disabling the user, ending the assignment, narrowing the
 *      device's scope away. Each with a positive control asserted first.
 *   3. A future-dated lapse is NOT caught by triggers (no DML fires) and IS
 *      caught by `app.refresh_sync_scope_all()` — the plain function the
 *      production package schedules. Run as app_user, which the 0013 sweep
 *      silently could not do.
 *   4. Two tenants: every new table is invisible across the boundary.
 *   5. The pre-tenant routes are unreadable by app_user directly, and their
 *      functions take the tenant from the GUC, never from a parameter.
 *   6. A device's key is immutable and retirement is terminal; the audit table
 *      is append-only.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import type { Queryable, TestDb } from '../src/testing/harness.js';
import { assignRole, makeLocation, makeRole, makeUser } from './rbac-fixtures.js';
import { newWrite, nextHlc, setupDb, setupTwoTenants, TENANT_A, TENANT_B } from './util.js';

let db: TestDb;

/** A 43-char base64url string — the shape of an RFC 7638 SHA-256 thumbprint. */
function fakeJkt(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url');
}

async function makeDevice(
  tx: Queryable,
  tenantId: string,
  enrolledBy: string,
  opts: { locations?: string[]; status?: 'active' | 'suspended' } = {},
): Promise<{ id: string; jkt: string }> {
  const id = uuidv7();
  const jkt = fakeJkt(id);
  const w = await newWrite(tx, tenantId, 'test.device');
  await tx.query(
    `insert into app.device
       (tenant_id, id, write_id, hlc, label, form_factor, public_jwk, jkt, status, enrolled_by)
     values ($1,$2,$3,$4,'Counter 1','tablet','{"kty":"EC"}'::jsonb,$5,$6,$7)`,
    [tenantId, id, w, nextHlc(), jkt, opts.status ?? 'active', enrolledBy],
  );
  for (const loc of opts.locations ?? []) {
    await tx.query(
      `insert into app.device_location_scope
         (tenant_id, id, write_id, hlc, device_id, location_id, added_by)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, uuidv7(), w, nextHlc(), id, loc, enrolledBy],
    );
  }
  return { id, jkt };
}

interface Tree {
  root: string;
  region: string;
  techiman: string;
  techimanTransit: string;
  wenchi: string;
}

async function makeTree(tx: Queryable, tenantId: string, prefix: string): Promise<Tree> {
  const root = await makeLocation(tx, tenantId, { code: `${prefix}-ROOT`, kind: 'GROUP' });
  const region = await makeLocation(tx, tenantId, { code: `${prefix}-BONO`, kind: 'GROUP', parentId: root });
  const techiman = await makeLocation(tx, tenantId, { code: `${prefix}-TEC`, kind: 'OUTLET', parentId: region });
  const techimanTransit = await makeLocation(tx, tenantId, {
    code: `${prefix}-TEC-TR`,
    kind: 'TRANSIT',
    parentId: techiman,
  });
  const wenchi = await makeLocation(tx, tenantId, { code: `${prefix}-WEN`, kind: 'OUTLET', parentId: region });
  return { root, region, techiman, techimanTransit, wenchi };
}

async function scopeRows(tenantId: string, deviceId: string): Promise<{ user_id: string; location_id: string; credit_allowance: string }[]> {
  return db.withTenant(tenantId, async (tx) =>
    (
      await tx.query<{ user_id: string; location_id: string; credit_allowance: string }>(
        `select user_id, location_id, credit_allowance from app.device_sync_location_scope
          where device_id = $1 order by user_id, location_id`,
        [deviceId],
      )
    ).rows,
  );
}

async function grantRows(tenantId: string, deviceId: string): Promise<{ user_id: string; jurisdiction_code: string; credit_book: string }[]> {
  return db.withTenant(tenantId, async (tx) =>
    (
      await tx.query<{ user_id: string; jurisdiction_code: string; credit_book: string }>(
        `select user_id, jurisdiction_code, credit_book from app.device_sync_grant
          where device_id = $1 order by user_id`,
        [deviceId],
      )
    ).rows,
  );
}

let treeA: Tree;
let treeB: Tree;
let clerkRole: string;
let accountsRole: string;
let admin: string;

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);
  await db.withTenant(TENANT_A, async (tx) => {
    treeA = await makeTree(tx, TENANT_A, 'A');
    admin = await makeUser(tx, TENANT_A, 'admin-a');
    clerkRole = await makeRole(tx, TENANT_A, {
      name: 'Clerk',
      permissions: [{ code: 'sale.record' }, { code: 'sale.record.credit', bound: { max_order_value_minor: '100' } }],
    });
    accountsRole = await makeRole(tx, TENANT_A, { name: 'Accounts', permissions: [{ code: 'credit.view' }] });
  });
  await db.withTenant(TENANT_B, async (tx) => {
    treeB = await makeTree(tx, TENANT_B, 'B');
  });
});

afterAll(async () => {
  await db.close();
});

describe('the projection is user scope ∩ device ceiling — nothing wider', () => {
  it('a clerk at Techiman on a Techiman tablet gets Techiman and its TRANSIT node, never Wenchi or a GROUP', async () => {
    const { device, clerk } = await db.withTenant(TENANT_A, async (tx) => {
      const clerk = await makeUser(tx, TENANT_A, `clerk-${uuidv7()}`);
      await assignRole(tx, TENANT_A, { userId: clerk, roleId: clerkRole, scopeLocationId: treeA.techiman });
      const device = await makeDevice(tx, TENANT_A, admin, { locations: [treeA.techiman] });
      return { device, clerk };
    });
    const rows = await scopeRows(TENANT_A, device.id);
    expect(rows.map((r) => r.location_id).sort()).toEqual([treeA.techiman, treeA.techimanTransit].sort());
    expect(rows.every((r) => r.user_id === clerk)).toBe(true);
    // sale.record.credit at Techiman → the allowance slice may come down there.
    expect(rows.every((r) => r.credit_allowance === 'allowance')).toBe(true);
    const grants = await grantRows(TENANT_A, device.id);
    expect(grants).toEqual([{ user_id: clerk, jurisdiction_code: 'GH', credit_book: 'none' }]);
  });

  it('a ROOT-scoped user on a counter tablet gets only the tablet\'s outlet (the ceiling holds)', async () => {
    const { device, founder } = await db.withTenant(TENANT_A, async (tx) => {
      const founder = await makeUser(tx, TENANT_A, `founder-${uuidv7()}`);
      await assignRole(tx, TENANT_A, { userId: founder, roleId: clerkRole, scopeLocationId: treeA.root });
      const device = await makeDevice(tx, TENANT_A, admin, { locations: [treeA.wenchi] });
      return { device, founder };
    });
    const rows = (await scopeRows(TENANT_A, device.id)).filter((r) => r.user_id === founder);
    expect(rows.map((r) => r.location_id)).toEqual([treeA.wenchi]);
  });

  it('a user scoped elsewhere gets NOTHING on this tablet — not even the catalogue gate', async () => {
    const { device, other } = await db.withTenant(TENANT_A, async (tx) => {
      const other = await makeUser(tx, TENANT_A, `wenchi-${uuidv7()}`);
      await assignRole(tx, TENANT_A, { userId: other, roleId: clerkRole, scopeLocationId: treeA.wenchi });
      const device = await makeDevice(tx, TENANT_A, admin, { locations: [treeA.techiman] });
      return { device, other };
    });
    expect((await scopeRows(TENANT_A, device.id)).filter((r) => r.user_id === other)).toEqual([]);
    expect((await grantRows(TENANT_A, device.id)).filter((r) => r.user_id === other)).toEqual([]);
  });

  it('a device with an EMPTY ceiling (the back-office laptop) has no grant at all', async () => {
    const device = await db.withTenant(TENANT_A, async (tx) => {
      const u = await makeUser(tx, TENANT_A, `office-${uuidv7()}`);
      await assignRole(tx, TENANT_A, { userId: u, roleId: clerkRole, scopeLocationId: treeA.root });
      return makeDevice(tx, TENANT_A, admin, { locations: [] });
    });
    expect(await scopeRows(TENANT_A, device.id)).toEqual([]);
    expect(await grantRows(TENANT_A, device.id)).toEqual([]);
  });

  it('a GROUP-node ceiling expands down the closure to every outlet under it', async () => {
    const { device, u } = await db.withTenant(TENANT_A, async (tx) => {
      const u = await makeUser(tx, TENANT_A, `regional-${uuidv7()}`);
      await assignRole(tx, TENANT_A, { userId: u, roleId: clerkRole, scopeLocationId: treeA.region });
      const device = await makeDevice(tx, TENANT_A, admin, { locations: [treeA.region] });
      return { device, u };
    });
    const locs = (await scopeRows(TENANT_A, device.id)).filter((r) => r.user_id === u).map((r) => r.location_id);
    expect(locs.sort()).toEqual([treeA.techiman, treeA.techimanTransit, treeA.wenchi].sort());
  });

  it('credit.view at the ROOT marks the pair for the credit book; revoking it unmarks', async () => {
    const { device, acc, assignment } = await db.withTenant(TENANT_A, async (tx) => {
      const acc = await makeUser(tx, TENANT_A, `acc-${uuidv7()}`);
      await assignRole(tx, TENANT_A, { userId: acc, roleId: clerkRole, scopeLocationId: treeA.techiman });
      const assignment = await assignRole(tx, TENANT_A, { userId: acc, roleId: accountsRole, scopeLocationId: treeA.root });
      const device = await makeDevice(tx, TENANT_A, admin, { locations: [treeA.techiman] });
      return { device, acc, assignment };
    });
    expect((await grantRows(TENANT_A, device.id)).find((g) => g.user_id === acc)?.credit_book).toBe('book');
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(`update app.user_role_assignment set deleted_at = transaction_timestamp() where id = $1`, [assignment]),
    );
    expect((await grantRows(TENANT_A, device.id)).find((g) => g.user_id === acc)?.credit_book).toBe('none');
  });
});

describe('every revocation path empties the device — each with its positive control', () => {
  async function fixture(): Promise<{ device: { id: string; jkt: string }; clerk: string; assignment: string }> {
    return db.withTenant(TENANT_A, async (tx) => {
      const clerk = await makeUser(tx, TENANT_A, `rev-${uuidv7()}`);
      const assignment = await assignRole(tx, TENANT_A, { userId: clerk, roleId: clerkRole, scopeLocationId: treeA.techiman });
      const device = await makeDevice(tx, TENANT_A, admin, { locations: [treeA.techiman] });
      return { device, clerk, assignment };
    });
  }

  it('retiring the device', async () => {
    const { device } = await fixture();
    expect((await grantRows(TENANT_A, device.id)).length).toBeGreaterThan(0); // positive control
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(
        `update app.device set status = 'retired', retired_reason = 'lost', retired_by = $2,
                retired_at = transaction_timestamp() where id = $1`,
        [device.id, admin],
      ),
    );
    expect(await grantRows(TENANT_A, device.id)).toEqual([]);
    expect(await scopeRows(TENANT_A, device.id)).toEqual([]);
  });

  it('suspending the device', async () => {
    const { device } = await fixture();
    expect((await grantRows(TENANT_A, device.id)).length).toBeGreaterThan(0);
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(`update app.device set status = 'suspended' where id = $1`, [device.id]),
    );
    expect(await grantRows(TENANT_A, device.id)).toEqual([]);
    // ...and reinstating it restores the grant: suspension is not retirement.
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(`update app.device set status = 'active' where id = $1`, [device.id]),
    );
    expect((await grantRows(TENANT_A, device.id)).length).toBeGreaterThan(0);
  });

  it('disabling the user', async () => {
    const { device, clerk } = await fixture();
    const mine = async () => (await grantRows(TENANT_A, device.id)).filter((g) => g.user_id === clerk);
    expect((await mine()).length).toBe(1);
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(`update app.user_account set status = 'DISABLED' where id = $1`, [clerk]),
    );
    expect(await mine()).toEqual([]);
  });

  it('ending the assignment now', async () => {
    const { device, assignment, clerk } = await fixture();
    const mine = async () => (await grantRows(TENANT_A, device.id)).filter((g) => g.user_id === clerk);
    expect((await mine()).length).toBe(1);
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(
        `update app.user_role_assignment set effective_to = transaction_timestamp() + interval '1 millisecond'
          where id = $1`,
        [assignment],
      ),
    );
    // effective_to a millisecond out is still live at the trigger's instant —
    // that is the effective-dating hole. The sweep closes it below.
    await new Promise((r) => setTimeout(r, 20));
    await db.withTenant(TENANT_A, (tx) => tx.query(`select app.refresh_sync_scope_all()`));
    expect(await mine()).toEqual([]);
  });

  it('narrowing the device\'s scope away', async () => {
    const { device } = await fixture();
    expect((await grantRows(TENANT_A, device.id)).length).toBeGreaterThan(0);
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(
        `update app.device_location_scope set deleted_at = transaction_timestamp(), removed_by = $2
          where device_id = $1`,
        [device.id, admin],
      ),
    );
    expect(await grantRows(TENANT_A, device.id)).toEqual([]);
  });
});

describe('the effective-dating hole, and the plain function that closes it', () => {
  it('a FUTURE-dated lapse is invisible to triggers and caught by the per-tenant refresh the scheduler runs', async () => {
    const clerk = await db.withTenant(TENANT_A, (tx) => makeUser(tx, TENANT_A, `lapse-${uuidv7()}`));
    const mine = async () => (await grantRows(TENANT_A, device.id)).filter((g) => g.user_id === clerk);
    const device = await db.withTenant(TENANT_A, async (tx) => {
      await tx.query(
        `insert into app.user_role_assignment
           (tenant_id, id, write_id, hlc, user_id, role_id, scope_location_id, effective_from, effective_to)
         values ($1,$2,$3,$4,$5,$6,$7, transaction_timestamp() - interval '1 hour',
                 transaction_timestamp() + interval '1500 milliseconds')`,
        [TENANT_A, uuidv7(), await newWrite(tx, TENANT_A), nextHlc(), clerk, clerkRole, treeA.techiman],
      );
      return makeDevice(tx, TENANT_A, admin, { locations: [treeA.techiman] });
    });
    expect((await mine()).length).toBe(1);
    await new Promise((r) => setTimeout(r, 1700));
    // Time passed; no DML; the projection is stale. This is the hole.
    expect((await mine()).length).toBe(1);
    // The all-tenant sweep, as app_user with NO tenant GUC, sees NO tenants:
    // platform.tenant is RLS-forced (0027) and an application session must not
    // enumerate tenants. It refreshes nothing — and says so (0 tenants).
    const n = await db.asAppUserWithoutTenant(async (tx) =>
      (await tx.query<{ n: number }>(`select app.refresh_sync_scope_all() as n`)).rows[0]!.n,
    );
    expect(n).toBe(0);
    expect((await mine()).length).toBe(1);
    // What the scheduler actually runs (packages/ops sync.scope_refresh): the
    // per-tenant functions, inside the tenant's own context, as app_user.
    await db.withTenant(TENANT_A, async (tx) => {
      await tx.query(`select app.refresh_credit_sync_scope($1::uuid)`, [TENANT_A]);
      await tx.query(`select app.refresh_device_sync_scope($1::uuid)`, [TENANT_A]);
    });
    expect(await mine()).toEqual([]);
    // The owner/operator can still sweep every tenant at once.
    const all = await db.asAdmin(async (tx) =>
      (await tx.query<{ n: number }>(`select app.refresh_sync_scope_all() as n`)).rows[0]!.n,
    );
    expect(all).toBeGreaterThanOrEqual(2);
  });
});

describe('two tenants', () => {
  it('tenant B sees none of tenant A\'s devices, scopes, codes, sessions, events or projections', async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      const u = await makeUser(tx, TENANT_A, `iso-${uuidv7()}`);
      await assignRole(tx, TENANT_A, { userId: u, roleId: clerkRole, scopeLocationId: treeA.techiman });
      const d = await makeDevice(tx, TENANT_A, admin, { locations: [treeA.techiman] });
      const w = await newWrite(tx, TENANT_A, 'test.code');
      await tx.query(
        `insert into app.device_enrolment_code
           (tenant_id, id, write_id, hlc, code_hash, location_id, label, form_factor, issued_by, expires_at)
         values ($1,$2,$3,$4,$5,$6,'T','tablet',$7, transaction_timestamp() + interval '10 minutes')`,
        [TENANT_A, uuidv7(), w, nextHlc(), createHash('sha256').update(`iso${u}`).digest(), treeA.techiman, admin],
      );
      await tx.query(
        `insert into app.device_session (tenant_id, id, device_id, user_id, refresh_hash, expires_at)
         values ($1,$2,$3,$4,$5, transaction_timestamp() + interval '1 day')`,
        [TENANT_A, uuidv7(), d.id, u, createHash('sha256').update('r').digest()],
      );
      await tx.query(
        `insert into app.identity_event
           (tenant_id, id, write_id, hlc, event_class, actor_kind, action, subject_table, subject_id)
         values ($1,$2,$3,$4,'write','user','device.enrol','device',$5)`,
        [TENANT_A, uuidv7(), w, nextHlc(), d.id],
      );
    });
    const tables = [
      'device',
      'device_location_scope',
      'device_enrolment_code',
      'device_session',
      'identity_event',
      'device_sync_grant',
      'device_sync_location_scope',
    ];
    for (const t of tables) {
      const inA = await db.withTenant(TENANT_A, async (tx) =>
        (await tx.query<{ n: number }>(`select count(*)::int as n from app.${t}`)).rows[0]!.n,
      );
      const inB = await db.withTenant(TENANT_B, async (tx) =>
        (await tx.query<{ n: number }>(`select count(*)::int as n from app.${t}`)).rows[0]!.n,
      );
      const noTenant = await db.asAppUserWithoutTenant(async (tx) =>
        (await tx.query<{ n: number }>(`select count(*)::int as n from app.${t}`)).rows[0]!.n,
      );
      expect({ t, positiveControl: inA > 0 }).toEqual({ t, positiveControl: true });
      expect({ t, inB, noTenant }).toEqual({ t, inB: 0, noTenant: 0 });
    }
  });

  it('a tenant-B device cannot be scoped to a tenant-A location (composite FK)', async () => {
    await expect(
      db.withTenant(TENANT_B, async (tx) => {
        const u = await makeUser(tx, TENANT_B, `b-${uuidv7()}`);
        await makeDevice(tx, TENANT_B, u, { locations: [treeA.techiman] });
      }),
    ).rejects.toThrow();
    // positive control: the same shape inside B is accepted
    await db.withTenant(TENANT_B, async (tx) => {
      const u = await makeUser(tx, TENANT_B, `b-${uuidv7()}`);
      await makeDevice(tx, TENANT_B, u, { locations: [treeB.techiman] });
    });
  });
});

describe('the pre-tenant routes', () => {
  it('app_user cannot read either route table directly', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) => tx.query(`select * from platform.device_key_route`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.withTenant(TENANT_A, (tx) => tx.query(`select * from platform.enrolment_code_route`)),
    ).rejects.toThrow(/permission denied/);
  });

  it('register_device_key takes the tenant from the GUC and refuses a device that is not in it', async () => {
    const device = await db.withTenant(TENANT_A, (tx) => makeDevice(tx, TENANT_A, admin));
    // From tenant B's context the tenant-A device does not exist.
    await expect(
      db.withTenant(TENANT_B, (tx) =>
        tx.query(`select platform.register_device_key($1, $2)`, [device.jkt, device.id]),
      ),
    ).rejects.toThrow(/not in the current tenant/);
    // No context at all: refused.
    await expect(
      db.asAppUserWithoutTenant((tx) =>
        tx.query(`select platform.register_device_key($1, $2)`, [device.jkt, device.id]),
      ),
    ).rejects.toThrow(/no tenant context/);
    // Positive control: from its own tenant it registers, and resolves back to A.
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(`select platform.register_device_key($1, $2)`, [device.jkt, device.id]),
    );
    const resolved = await db.asAppUserWithoutTenant(async (tx) =>
      (await tx.query<{ tenant_id: string; device_id: string }>(
        `select * from platform.resolve_device_key($1)`,
        [device.jkt],
      )).rows,
    );
    expect(resolved).toEqual([{ tenant_id: TENANT_A, device_id: device.id }]);
  });

  it('claim_enrolment_code burns on the first claim and reports it', async () => {
    const hash = createHash('sha256').update(`claim-${uuidv7()}`).digest();
    await db.withTenant(TENANT_A, async (tx) => {
      const id = uuidv7();
      await tx.query(
        `insert into app.device_enrolment_code
           (tenant_id, id, write_id, hlc, code_hash, location_id, label, form_factor, issued_by, expires_at)
         values ($1,$2,$3,$4,$5,$6,'T','tablet',$7, transaction_timestamp() + interval '10 minutes')`,
        [TENANT_A, id, await newWrite(tx, TENANT_A), nextHlc(), hash, treeA.techiman, admin],
      );
      await tx.query(`select platform.publish_enrolment_code($1, $2)`, [hash, id]);
    });
    const claim = (h: Buffer) =>
      db.asAppUserWithoutTenant(async (tx) =>
        (await tx.query<{ tenant_id: string; first_claim: boolean }>(
          `select tenant_id, first_claim from platform.claim_enrolment_code($1)`,
          [h],
        )).rows,
      );
    expect(await claim(hash)).toEqual([{ tenant_id: TENANT_A, first_claim: true }]);
    expect(await claim(hash)).toEqual([{ tenant_id: TENANT_A, first_claim: false }]);
    expect(await claim(createHash('sha256').update('nope').digest())).toEqual([]);
  });
});

describe('immutability', () => {
  it('a device key cannot change, and retirement is terminal', async () => {
    const device = await db.withTenant(TENANT_A, (tx) => makeDevice(tx, TENANT_A, admin));
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update app.device set jkt = $2 where id = $1`, [device.id, fakeJkt('other')]),
      ),
    ).rejects.toThrow(/key is its identity/);
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(
        `update app.device set status = 'retired', retired_reason = 'stolen', retired_by = $2,
                retired_at = transaction_timestamp() where id = $1`,
        [device.id, admin],
      ),
    );
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update app.device set status = 'active' where id = $1`, [device.id]),
      ),
    ).rejects.toThrow(/retirement is terminal/);
    await expect(
      db.withTenant(TENANT_A, (tx) => tx.query(`delete from app.device where id = $1`, [device.id])),
    ).rejects.toThrow(/permission denied/);
  });

  it('identity_event is append-only', async () => {
    const id = uuidv7();
    await db.withTenant(TENANT_A, async (tx) => {
      await tx.query(
        `insert into app.identity_event
           (tenant_id, id, write_id, hlc, event_class, actor_kind, action, subject_table)
         values ($1,$2,$3,$4,'write','system','test.event','device')`,
        [TENANT_A, id, await newWrite(tx, TENANT_A), nextHlc()],
      );
    });
    await expect(
      db.withTenant(TENANT_A, (tx) => tx.query(`update app.identity_event set action = 'x.y' where id = $1`, [id])),
    ).rejects.toThrow();
    await expect(
      db.withTenant(TENANT_A, (tx) => tx.query(`delete from app.identity_event where id = $1`, [id])),
    ).rejects.toThrow();
  });
});

describe('platform.permission.offline_mode', () => {
  it('cash and lookups survive restricted mode; risk stops at full_until; the two prohibitions never work offline', async () => {
    const modes = await db.asAdmin(async (tx) =>
      Object.fromEntries(
        (await tx.query<{ code: string; offline_mode: string }>(`select code, offline_mode from platform.permission`)).rows.map(
          (r) => [r.code, r.offline_mode],
        ),
      ),
    );
    expect(modes['sale.record']).toBe('always');
    expect(modes['stock.view']).toBe('always');
    expect(modes['sale.receipt.reprint']).toBe('always');
    // Every sale is rung into an open till and tills close at midnight: a till
    // that could not open (or cash up) in restricted mode would stop cash
    // sales on the second day offline — the thing restricted mode keeps.
    expect(modes['cash.session.open']).toBe('always');
    expect(modes['cash.session.close']).toBe('always');
    expect(modes['sale.record.credit']).toBe('until_lease_expiry');
    expect(modes['stock.adjust']).toBe('until_lease_expiry');
    expect(modes['sale.override_price']).toBe('never');
    expect(modes['credit.limit.change']).toBe('never');
    for (const [code, mode] of Object.entries(modes)) {
      if (code.startsWith('admin.')) expect({ code, mode }).toEqual({ code, mode: 'never' });
    }
  });
});
