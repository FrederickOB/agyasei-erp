/**
 * A brand-new tenant's first administrator and first device (02 §2.2, §2.7).
 *
 * The gap this closes: sign-in needs an enrolled device, and a code is issued
 * only by an administrator on an enrolled device — so a fresh tenant had no
 * production path to its first device. bootstrapFirstAdmin is that path, and
 * these tests drive it end to end over real HTTP: the code it prints enrols a
 * real device, the linked subject signs in on it, and that administrator then
 * issues the NEXT code through the ordinary admin route — so nothing after the
 * bootstrap depends on it.
 *
 * Tenant isolation (CLAUDE.md §2.7 category 3): every read of the rows it
 * writes is repeated from a second tenant, which must see none of them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { FirstAdminRefused, bootstrapFirstAdmin, type FirstAdminInput } from '../src/identity/first-admin.js';
import { hashEnrolmentCode, normaliseEnrolmentCode } from '../src/identity/enrolment-code.js';
import { createIdentityRig, newDevice, IDP_ISSUER, type IdentityRig } from './identity-harness.js';

let rig: IdentityRig;
let tenantA: string;
let tenantB: string;
let outletA: string;
let outletB: string;

beforeAll(async () => {
  rig = await createIdentityRig();
  tenantA = await rig.h.provisionTenant('first-admin-a');
  tenantB = await rig.h.provisionTenant('first-admin-b');
  await rig.h.applyTemplate(tenantA, true);
  await rig.h.applyTemplate(tenantB, true);
  outletA = (await rig.h.firstOutlet(tenantA)).id;
  outletB = (await rig.h.firstOutlet(tenantB)).id;
});

afterAll(async () => {
  await rig.close();
});

function input(tenantId: string, sub: string, locationId: string | null, over: Partial<FirstAdminInput> = {}): FirstAdminInput {
  return {
    tenantId,
    subjectIssuer: IDP_ISSUER,
    subjectRef: sub,
    username: 'founder',
    displayName: 'Founder',
    device: { label: 'First tablet', formFactor: 'tablet', locationId },
    ...over,
  };
}

function bootstrap(tenantId: string, i: FirstAdminInput) {
  return rig.h.db.withTenant(tenantId, (tx) => bootstrapFirstAdmin(tx, rig.h.deps.clock, i));
}

async function countIn(tenantId: string, table: string): Promise<number> {
  const r = await rig.h.db.withTenant(tenantId, (tx) => tx.query<{ n: string }>(`select count(*)::text as n from ${table}`));
  return Number(r.rows[0]!.n);
}

describe('bootstrapFirstAdmin', () => {
  it('refuses bad input and a TRANSIT or unknown first-device location, writing nothing', async () => {
    await expect(bootstrap(tenantA, input(tenantA, 'founder-a', outletA, { subjectIssuer: 'not-a-url' }))).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
    await expect(bootstrap(tenantA, input(tenantA, 'founder-a', outletA, { username: 'x' }))).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
    await expect(bootstrap(tenantA, input(tenantA, 'founder-a', uuidv7()))).rejects.toMatchObject({ reason: 'BAD_LOCATION' });
    const transit = await rig.h.db.withTenant(tenantA, (tx) =>
      tx.query<{ id: string }>(`select id from app.location where kind = 'TRANSIT' and is_active and deleted_at is null limit 1`),
    );
    await expect(bootstrap(tenantA, input(tenantA, 'founder-a', transit.rows[0]!.id))).rejects.toMatchObject({ reason: 'BAD_LOCATION' });
    expect(await countIn(tenantA, 'app.user_account')).toBe(0);
    expect(await countIn(tenantA, 'app.device_enrolment_code')).toBe(0);
  });

  it('refuses to run in a context other than the tenant it names', async () => {
    await expect(bootstrap(tenantB, input(tenantA, 'founder-a', outletA))).rejects.toBeInstanceOf(FirstAdminRefused);
    await expect(bootstrap(tenantB, input(tenantA, 'founder-a', outletA))).rejects.toMatchObject({ reason: 'NOT_IN_TENANT_CONTEXT' });
    expect(await countIn(tenantB, 'app.user_account')).toBe(0);
  });

  it('brings a fresh tenant’s first device and administrator online, with no administrator to issue the code', async () => {
    expect(await countIn(tenantA, 'app.user_account')).toBe(0);
    const r = await bootstrap(tenantA, input(tenantA, 'founder-a', outletA));
    expect(r.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const device = await newDevice();
    const enrol = await rig.enrol(device, r.code);
    expect(enrol.status).toBe(200);

    const s = await rig.signedIn(device, 'founder-a');
    expect(s.tenantId).toBe(tenantA);
    expect(s.userId).toBe(r.userId);

    // The chain continues WITHOUT the bootstrap: the new administrator issues
    // the next code through the ordinary admin route, on its DPoP session.
    const next = await rig.call(device, s, 'POST', '/trpc/admin.devices.issueCode', {
      json: { idempotencyKey: uuidv7(), label: 'Second tablet', formFactor: 'tablet', locationId: outletA },
    });
    expect(next.status).toBe(200);
    const nextCode = (next.body as { result: { data: { json: { code: string } } } }).result.data.json.code;
    expect((await rig.enrol(await newDevice(), nextCode)).status).toBe(200);

    // Audited as a system act, on one SERVER-origin marker.
    const events = await rig.h.db.withTenant(tenantA, (tx) =>
      tx.query<{ action: string; actor_kind: string; origin: string }>(
        `select e.action, e.actor_kind, w.origin
           from app.identity_event e join app.write_log w on w.tenant_id = e.tenant_id and w.id = e.write_id
          where w.op = 'onboarding.first_admin' order by e.action`,
      ),
    );
    expect(events.rows).toEqual([
      { action: 'enrolment_code.issue', actor_kind: 'system', origin: 'SERVER' },
      { action: 'user.create', actor_kind: 'system', origin: 'SERVER' },
    ]);
  });

  it('is one-shot: once a tenant has a user it refuses, and the code it printed cannot be re-used', async () => {
    await expect(bootstrap(tenantA, input(tenantA, 'someone-else', outletA, { username: 'other' }))).rejects.toMatchObject({
      reason: 'FIRST_ADMIN_EXISTS',
    });
    // Positive control for the refusal: tenant B, still empty, is accepted.
    const b = await bootstrap(tenantB, input(tenantB, 'founder-b', outletB));
    expect(b.code).toMatch(/-/);
    // A code is single use: the one that enrolled tenant A's first device is spent.
    const stored = await rig.h.db.withTenant(tenantA, (tx) =>
      tx.query<{ consumed: boolean }>(
        `select consumed_at is not null as consumed from app.device_enrolment_code where label = 'First tablet'`,
      ),
    );
    expect(stored.rows).toEqual([{ consumed: true }]);
  });

  it('reissues for the SAME founder while no device has enrolled, cancelling the lapsed code; closes once one enrols', async () => {
    const t = await rig.h.provisionTenant('first-admin-d');
    await rig.h.applyTemplate(t, true);
    const outlet = (await rig.h.firstOutlet(t)).id;
    const first = await bootstrap(t, input(t, 'founder-d', outlet));
    expect(first.reissued).toBe(false);

    // A different person cannot take over an un-enrolled tenant.
    await expect(bootstrap(t, input(t, 'not-the-founder', outlet, { username: 'other' }))).rejects.toMatchObject({
      reason: 'FIRST_ADMIN_EXISTS',
    });

    const again = await bootstrap(t, input(t, 'founder-d', outlet));
    expect(again.reissued).toBe(true);
    expect(again.userId).toBe(first.userId);
    expect(again.code).not.toBe(first.code);

    const stale = await rig.enrol(await newDevice(), first.code);
    expect(stale.status).toBe(409);
    expect(stale.body['error']).toBe('enrolment_code_used');
    const device = await newDevice();
    expect((await rig.enrol(device, again.code)).status).toBe(200);
    expect((await rig.signedIn(device, 'founder-d')).userId).toBe(first.userId);

    // One device enrolled: closed for good, even for the founder.
    await expect(bootstrap(t, input(t, 'founder-d', outlet))).rejects.toMatchObject({ reason: 'FIRST_ADMIN_EXISTS' });
  });

  it('stores only the hash, expires within 15 minutes, and holds the owner role at the root', async () => {
    const t = await rig.h.provisionTenant('first-admin-c');
    await rig.h.applyTemplate(t, true);
    const outlet = (await rig.h.firstOutlet(t)).id;
    const r = await bootstrap(t, input(t, 'founder-c', outlet));
    const hash = hashEnrolmentCode(normaliseEnrolmentCode(r.code)!).toString('hex');
    const row = await rig.h.db.withTenant(t, (tx) =>
      tx.query<{ hash: string; ttl_s: string; issued_by: string; all_text: string }>(
        `select encode(code_hash, 'hex') as hash,
                extract(epoch from expires_at - created_at)::int::text as ttl_s,
                issued_by::text, c::text as all_text
           from app.device_enrolment_code c where id = $1`,
        [r.codeId],
      ),
    );
    expect(row.rows[0]!.hash).toBe(hash);
    expect(Number(row.rows[0]!.ttl_s)).toBeLessThanOrEqual(15 * 60);
    expect(row.rows[0]!.issued_by).toBe(r.userId);
    expect(row.rows[0]!.all_text).not.toContain(r.code.replace('-', ''));

    const role = await rig.h.db.withTenant(t, (tx) =>
      tx.query<{ is_owner: boolean; at_root: boolean }>(
        `select r.is_owner, l.parent_id is null as at_root
           from app.user_role_assignment a
           join app.role r on r.id = a.role_id
           join app.location l on l.id = a.scope_location_id
          where a.user_id = $1 and a.deleted_at is null`,
        [r.userId],
      ),
    );
    expect(role.rows).toEqual([{ is_owner: true, at_root: true }]);
  });
});

describe('isolation: a first administrator exists in exactly one tenant', () => {
  it('tenant B cannot see tenant A’s first administrator, code or audit rows', async () => {
    const aUser = await rig.h.db.withTenant(tenantA, (tx) =>
      tx.query<{ id: string }>(`select id from app.user_account where subject_ref = 'founder-a'`),
    );
    expect(aUser.rows).toHaveLength(1); // positive control: A sees its own
    const fromB = await rig.h.db.withTenant(tenantB, (tx) =>
      tx.query<{ n: string }>(
        `select ((select count(*) from app.user_account where id = $1 or subject_ref = 'founder-a')
              + (select count(*) from app.device_enrolment_code where issued_by = $1)
              + (select count(*) from app.identity_event where subject_id = $1))::text as n`,
        [aUser.rows[0]!.id],
      ),
    );
    expect(fromB.rows[0]!.n).toBe('0');
  });

  it('tenant A’s subject cannot sign in on a tenant B device; tenant B’s own subject can', async () => {
    const device = await newDevice();
    const code = await rig.issueCode(tenantB, outletB);
    expect((await rig.enrol(device, code)).status).toBe(200);
    const intruder = await rig.signIn(device, 'founder-a');
    expect(intruder.status).toBeGreaterThanOrEqual(400);
    expect((await rig.signedIn(device, 'founder-b')).tenantId).toBe(tenantB);
  });
});
