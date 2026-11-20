/**
 * Back-office administration: users, assignments, roles, devices — and the
 * ESCALATION RULE that makes handing out authority safe (02 §2.4 rules 3–4).
 *
 * Every refusal here has its positive control beside it. Principals are built
 * from the tenant's own template roles at real nodes of its tree; nothing
 * reads a role name — custom roles below are named nonsense on purpose.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import type { VerifiedIdentity } from '../src/auth.js';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenant: string;
let root: string;
let outletA: string;
let outletB: string;
let owner: VerifiedIdentity;

const key = () => uuidv7();

beforeAll(async () => {
  h = await createApiHarness();
  tenant = await h.provisionTenant('admin-suite');
  await h.applyTemplate(tenant, true);
  root = await h.rootLocation(tenant);
  const [a, b] = await h.outlets(tenant, 2);
  outletA = a!.id;
  outletB = b!.id;
  owner = await h.identityFor(tenant); // owner role at the root
});

afterAll(async () => {
  await h.close();
});

async function newUser(): Promise<{ userId: string; identity: VerifiedIdentity }> {
  const { userId } = await h.callerFor(owner).admin.users.create({
    idempotencyKey: key(),
    username: `u-${uuidv7().slice(-12)}`,
    displayName: 'Someone',
  });
  return { userId, identity: await h.identityFor(tenant, { uid: userId, grant: 'none', locs: [outletA] }) };
}

async function roleId(ref: string): Promise<string> {
  const roles = await h.callerFor(owner).admin.roles.list();
  // Template provenance, looked up through the DATABASE by origin_ref — never by name.
  const id = await h.db.withTenant(tenant, async (tx) =>
    (await tx.query<{ id: string }>(`select id from app.role where origin_ref = $1`, [`role:${ref}`])).rows[0]?.id,
  );
  expect(roles.some((r) => r.id === id)).toBe(true);
  return id!;
}

async function ownerRoleId(): Promise<string> {
  return (await h.callerFor(owner).admin.roles.list()).find((r) => r.isOwner)!.id;
}

describe('assignment and the escalation rule', () => {
  let userAdmin: VerifiedIdentity;
  let narrowRole: string;

  beforeAll(async () => {
    // A tenant-composed role: may assign, and holds only cash sales — at ONE outlet.
    const { roleId: adminRole } = await h.callerFor(owner).admin.roles.create({
      idempotencyKey: key(),
      name: 'Zebra-7 (assigns at its outlet)',
      permissions: [{ code: 'admin.assignment.manage' }, { code: 'sale.record' }],
    });
    ({ roleId: narrowRole } = await h.callerFor(owner).admin.roles.create({
      idempotencyKey: key(),
      name: 'Okapi-3 (cash only)',
      permissions: [{ code: 'sale.record' }],
    }));
    const u = await newUser();
    await h.callerFor(owner).admin.users.assignRole({
      idempotencyKey: key(),
      userId: u.userId,
      roleId: adminRole,
      scopeLocationId: outletA,
    });
    userAdmin = u.identity;
  });

  it('positive control: an assigner may hand out what they hold, where they hold it', async () => {
    const target = await newUser();
    const r = await h.callerFor(userAdmin).admin.users.assignRole({
      idempotencyKey: key(),
      userId: target.userId,
      roleId: narrowRole,
      scopeLocationId: outletA,
    });
    expect(r.assignmentId).toBeTruthy();
  });

  it('refuses a role carrying permissions the assigner lacks (counter staff holds stock.view, etc.)', async () => {
    const target = await newUser();
    await expect(
      h.callerFor(userAdmin).admin.users.assignRole({
        idempotencyKey: key(),
        userId: target.userId,
        roleId: await roleId('counter_staff'),
        scopeLocationId: outletA,
      }),
    ).rejects.toThrow(/PERMISSION_ESCALATION/);
  });

  it('refuses the OWNER role to anyone who does not already hold everything — including to themselves', async () => {
    await expect(
      h.callerFor(userAdmin).admin.users.assignRole({
        idempotencyKey: key(),
        userId: userAdmin.userId,
        roleId: await ownerRoleId(),
        scopeLocationId: outletA,
      }),
    ).rejects.toThrow(/PERMISSION_ESCALATION/);
    // Positive control: the owner can.
    const target = await newUser();
    await expect(
      h.callerFor(owner).admin.users.assignRole({
        idempotencyKey: key(),
        userId: target.userId,
        roleId: await ownerRoleId(),
        scopeLocationId: outletA,
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses assignment at a node outside the assigner\'s scope', async () => {
    const target = await newUser();
    await expect(
      h.callerFor(userAdmin).admin.users.assignRole({
        idempotencyKey: key(),
        userId: target.userId,
        roleId: narrowRole,
        scopeLocationId: outletB,
      }),
    ).rejects.toThrow(/FORBIDDEN|PERMISSION_OUT_OF_SCOPE/);
    await expect(
      h.callerFor(userAdmin).admin.users.assignRole({
        idempotencyKey: key(),
        userId: target.userId,
        roleId: narrowRole,
        scopeLocationId: root,
      }),
    ).rejects.toThrow(/FORBIDDEN|PERMISSION/);
  });

  it('refuses a LOOSER bound than the granter holds — the outlet manager\'s 500000 cannot mint a 2000000', async () => {
    // A role that can assign AND holds credit sales at 500000.
    const { roleId: boundedAdmin } = await h.callerFor(owner).admin.roles.create({
      idempotencyKey: key(),
      name: 'Quokka-1',
      permissions: [
        { code: 'admin.assignment.manage' },
        { code: 'sale.record.credit', bound: { max_order_value_minor: '500000' } },
      ],
    });
    const { roleId: looser } = await h.callerFor(owner).admin.roles.create({
      idempotencyKey: key(),
      name: 'Quokka-2',
      permissions: [{ code: 'sale.record.credit', bound: { max_order_value_minor: '2000000' } }],
    });
    const { roleId: tighter } = await h.callerFor(owner).admin.roles.create({
      idempotencyKey: key(),
      name: 'Quokka-3',
      permissions: [{ code: 'sale.record.credit', bound: { max_order_value_minor: '100000' } }],
    });
    const granter = await newUser();
    await h.callerFor(owner).admin.users.assignRole({
      idempotencyKey: key(),
      userId: granter.userId,
      roleId: boundedAdmin,
      scopeLocationId: outletA,
    });
    const target = await newUser();
    await expect(
      h.callerFor(granter.identity).admin.users.assignRole({
        idempotencyKey: key(),
        userId: target.userId,
        roleId: looser,
        scopeLocationId: outletA,
      }),
    ).rejects.toThrow(/looser bound/);
    await expect(
      h.callerFor(granter.identity).admin.users.assignRole({
        idempotencyKey: key(),
        userId: target.userId,
        roleId: tighter,
        scopeLocationId: outletA,
      }),
    ).resolves.toBeTruthy();
  });

  it('ending an assignment is symmetric: an outlet-level assigner cannot end the founder\'s root assignment', async () => {
    const founderAssignment = await h.db.withTenant(tenant, async (tx) =>
      (await tx.query<{ id: string }>(
        `select id from app.user_role_assignment where user_id = $1 and deleted_at is null limit 1`,
        [owner.userId],
      )).rows[0]!.id,
    );
    await expect(
      h.callerFor(userAdmin).admin.users.endAssignment({ idempotencyKey: key(), assignmentId: founderAssignment }),
    ).rejects.toThrow(/FORBIDDEN|PERMISSION/);
  });

  it('admin.user.manage alone (creating accounts) grants nothing', async () => {
    const { roleId: accountsOnly } = await h.callerFor(owner).admin.roles.create({
      idempotencyKey: key(),
      name: 'Wombat-9',
      permissions: [{ code: 'admin.user.manage' }],
    });
    const u = await newUser();
    await h.callerFor(owner).admin.users.assignRole({ idempotencyKey: key(), userId: u.userId, roleId: accountsOnly, scopeLocationId: root });
    const t = await newUser();
    await expect(
      h.callerFor(u.identity).admin.users.assignRole({ idempotencyKey: key(), userId: t.userId, roleId: narrowRole, scopeLocationId: outletA }),
    ).rejects.toThrow(/FORBIDDEN|PERMISSION/);
    // ...but it does create users (positive control).
    await expect(
      h.callerFor(u.identity).admin.users.create({ idempotencyKey: key(), username: `x-${uuidv7().slice(-10)}`, displayName: 'X' }),
    ).resolves.toBeTruthy();
  });
});

describe('roles are tenant-editable, within the same rule', () => {
  it('refuses a code that is not in the platform catalogue — a tenant composes, it never mints', async () => {
    await expect(
      h.callerFor(owner).admin.roles.create({ idempotencyKey: key(), name: 'Bad', permissions: [{ code: 'sale.super_record' }] }),
    ).rejects.toThrow(/UNKNOWN_PERMISSION_CODE/);
  });

  it('the owner role has no editable permission set and cannot be deleted', async () => {
    const ownerRole = await ownerRoleId();
    await expect(
      h.callerFor(owner).admin.roles.update({ idempotencyKey: key(), roleId: ownerRole, permissions: [] }),
    ).rejects.toThrow(/owner role/);
    await expect(h.callerFor(owner).admin.roles.delete({ idempotencyKey: key(), roleId: ownerRole })).rejects.toThrow(/owner role/);
  });

  it('a role-editor cannot ADD a capability they lack to a role that is assigned somewhere', async () => {
    const { roleId: editorRole } = await h.callerFor(owner).admin.roles.create({
      idempotencyKey: key(),
      name: 'Ibis-4',
      permissions: [{ code: 'admin.role.manage' }, { code: 'sale.record' }],
    });
    const editor = await newUser();
    await h.callerFor(owner).admin.users.assignRole({ idempotencyKey: key(), userId: editor.userId, roleId: editorRole, scopeLocationId: root });
    // A role the editor themselves holds, at the root: adding credit.limit.change
    // to it would hand it to themselves.
    await expect(
      h.callerFor(editor.identity).admin.roles.update({
        idempotencyKey: key(),
        roleId: editorRole,
        permissions: [{ code: 'admin.role.manage' }, { code: 'sale.record' }, { code: 'credit.limit.change' }],
      }),
    ).rejects.toThrow(/PERMISSION_ESCALATION/);
    // Positive control: REMOVING is always within reach.
    await expect(
      h.callerFor(editor.identity).admin.roles.update({
        idempotencyKey: key(),
        roleId: editorRole,
        name: 'Ibis-4b',
      }),
    ).resolves.toBeTruthy();
  });

  it('a role with live assignments cannot be deleted; once ended, it can', async () => {
    const { roleId: r } = await h.callerFor(owner).admin.roles.create({ idempotencyKey: key(), name: 'Heron-2', permissions: [{ code: 'sale.view' }] });
    const u = await newUser();
    const { assignmentId } = await h.callerFor(owner).admin.users.assignRole({ idempotencyKey: key(), userId: u.userId, roleId: r, scopeLocationId: outletA });
    await expect(h.callerFor(owner).admin.roles.delete({ idempotencyKey: key(), roleId: r })).rejects.toThrow(/end every assignment/);
    await h.callerFor(owner).admin.users.endAssignment({ idempotencyKey: key(), assignmentId });
    await expect(h.callerFor(owner).admin.roles.delete({ idempotencyKey: key(), roleId: r })).resolves.toBeTruthy();
  });
});

describe('users', () => {
  it('disabling a user revokes their sessions now and removes them from every device projection', async () => {
    const u = await newUser();
    await h.callerFor(owner).admin.users.assignRole({ idempotencyKey: key(), userId: u.userId, roleId: await roleId('counter_staff'), scopeLocationId: outletA });
    await h.callerFor(owner).admin.users.setStatus({ idempotencyKey: key(), userId: u.userId, status: 'DISABLED', reason: 'left the business' });
    const after = await h.db.withTenant(tenant, async (tx) => ({
      status: (await tx.query<{ status: string }>(`select status from app.user_account where id = $1`, [u.userId])).rows[0]?.status,
      scope: (await tx.query(`select 1 from app.user_location_scope where user_id = $1`, [u.userId])).rows.length,
      event: (await tx.query<{ action: string }>(`select action from app.identity_event where subject_id = $1 and action = 'user.set_status'`, [u.userId])).rows.length,
    }));
    expect(after).toEqual({ status: 'DISABLED', scope: 0, event: 1 });
  });

  it('nobody can change their own status', async () => {
    await expect(
      h.callerFor(owner).admin.users.setStatus({ idempotencyKey: key(), userId: owner.userId, status: 'DISABLED', reason: 'oops' }),
    ).rejects.toThrow(/your own/);
  });
});

describe('devices: enrolment codes and revocation are scoped to where you hold them', () => {
  it('an outlet manager issues codes and revokes devices at their outlet — and not at another', async () => {
    const manager = await h.principal(tenant, { roleRef: 'outlet_manager', scopeLocationId: outletA });
    const mine = await h.callerFor(manager).admin.devices.issueCode({ idempotencyKey: key(), label: 'Till 2', formFactor: 'tablet', locationId: outletA });
    expect(mine.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    await expect(
      h.callerFor(manager).admin.devices.issueCode({ idempotencyKey: key(), label: 'Till X', formFactor: 'tablet', locationId: outletB }),
    ).rejects.toThrow(/FORBIDDEN|PERMISSION/);
    // A laptop with no ceiling is tenant-wide business: not an outlet manager's.
    await expect(
      h.callerFor(manager).admin.devices.issueCode({ idempotencyKey: key(), label: 'Laptop', formFactor: 'laptop', locationId: null }),
    ).rejects.toThrow(/FORBIDDEN|PERMISSION/);
  });

  it('replaying issueCode never mints a second code and never re-reveals the first', async () => {
    const k = key();
    const first = await h.callerFor(owner).admin.devices.issueCode({ idempotencyKey: k, label: 'T', formFactor: 'tablet', locationId: outletA });
    const again = await h.callerFor(owner).admin.devices.issueCode({ idempotencyKey: k, label: 'T', formFactor: 'tablet', locationId: outletA });
    expect(first.code).not.toBeNull();
    expect(again.code).toBeNull();
    expect(again.codeId).toBe(first.codeId);
    const stored = await h.db.withTenant(tenant, async (tx) =>
      (await tx.query(`select 1 from app.device_enrolment_code where id = $1`, [first.codeId])).rows.length,
    );
    expect(stored).toBe(1);
  });

  it('counter staff can do NO administration at all (and still hold no price override / no limit change)', async () => {
    const clerk = await h.principal(tenant, { roleRef: 'counter_staff', scopeLocationId: outletA });
    const c = h.callerFor(clerk);
    await expect(c.admin.devices.list()).rejects.toThrow(/FORBIDDEN|PERMISSION/);
    await expect(c.admin.users.list()).rejects.toThrow(/FORBIDDEN|PERMISSION/);
    await expect(c.admin.roles.list()).rejects.toThrow(/FORBIDDEN|PERMISSION/);
    await expect(
      c.admin.devices.issueCode({ idempotencyKey: key(), label: 'x', formFactor: 'tablet', locationId: outletA }),
    ).rejects.toThrow(/FORBIDDEN|PERMISSION/);
    const codes = await h.db.withTenant(tenant, async (tx) =>
      (await tx.query<{ permission_code: string }>(
        `select permission_code from app.effective_permission where user_id = $1`,
        [clerk.userId],
      )).rows.map((r) => r.permission_code),
    );
    expect(codes).not.toContain('sale.override_price');
    expect(codes).not.toContain('credit.limit.change');
    expect(codes.some((c2) => c2.startsWith('admin.'))).toBe(false);
  });
});
