/**
 * Work package B — identity, device enrolment, offline sessions, revocation.
 * (02-security §2.2, §2.5, §2.7.)
 *
 * Everything here goes over HTTP (`app.inject`) against the real server, the
 * real identity service and PGlite under forced RLS. The IdP is a key pair in
 * this file; the devices hold real P-256 keys and sign real DPoP proofs.
 *
 * Each refusal is paired with its POSITIVE CONTROL: the same request, made
 * correctly, succeeds — so a refusal proves the guard and not a broken rig.
 */
import { SignJWT, createLocalJWKSet, generateKeyPair, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { leaseClaims } from '@erp/contracts';
import { signDevToken } from '../src/auth.js';
import { createIdentityService } from '../src/identity/service.js';
import { HOUR_MS, createRateLimiter } from '../src/identity/rate-limit.js';
import { preTenantRunnerFrom } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { createIdentityRig, newDevice, API, ISSUER, IDP_ISSUER, type IdentityRig } from './identity-harness.js';
import { JWT_SECRET } from './util.js';

let rig: IdentityRig;
let tenantA: string;
let tenantB: string;
let outletA: string;
let outletA2: string;
let outletB: string;

beforeAll(async () => {
  rig = await createIdentityRig();
  tenantA = await rig.h.provisionTenant('ident-a');
  tenantB = await rig.h.provisionTenant('ident-b');
  await rig.h.applyTemplate(tenantA, true);
  await rig.h.applyTemplate(tenantB, true);
  const [a1, a2] = await rig.h.outlets(tenantA, 2);
  outletA = a1!.id;
  outletA2 = a2!.id;
  // The pilot network ships with one live outlet; open a second for the
  // ceiling tests (issuing a code at an INACTIVE location is refused).
  await rig.h.db.withTenant(tenantA, (tx) => tx.query(`update app.location set is_active = true where id = $1`, [outletA2]));
  outletB = (await rig.h.firstOutlet(tenantB)).id;
});

afterAll(async () => {
  await rig.close();
});

async function enrolled(tenantId: string, locationId: string | null) {
  const device = await newDevice();
  const code = await rig.issueCode(tenantId, locationId);
  const r = await rig.enrol(device, code);
  expect(r.status).toBe(200);
  return { device, deviceId: r.body['deviceId'] as string };
}

describe('the token service', () => {
  it('serves its PUBLIC signing keys at /.well-known/jwks.json — ES256, kid, no private member', async () => {
    const res = await rig.app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(res.statusCode).toBe(200);
    const { keys } = res.json() as { keys: Record<string, unknown>[] };
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k['kty']).toBe('EC');
      expect(k['alg']).toBe('ES256');
      expect(typeof k['kid']).toBe('string');
      expect('d' in k).toBe(false);
    }
    // The lease ring is SEPARATE: none of its kids appear here.
    const lease = (await rig.app.inject({ method: 'GET', url: '/.well-known/lease-jwks.json' })).json() as { keys: { kid: string }[] };
    expect(lease.keys.map((k) => k.kid)).not.toContain(keys[0]!['kid']);
  });
});

describe('enrolment (§2.7)', () => {
  it('a valid code enrols the device: registry row, one ceiling row, code consumed, audited', async () => {
    const device = await newDevice();
    const code = await rig.issueCode(tenantA, outletA);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const r = await rig.enrol(device, code);
    expect(r.status).toBe(200);
    expect(r.body['tenantId']).toBe(tenantA);
    expect(r.body['locationIds']).toEqual([outletA]);
    const deviceId = r.body['deviceId'] as string;
    const row = await rig.h.db.withTenant(tenantA, async (tx) => ({
      device: (await tx.query<{ jkt: string; status: string }>(`select jkt, status from app.device where id = $1`, [deviceId])).rows[0],
      scope: (await tx.query<{ location_id: string }>(`select location_id from app.device_location_scope where device_id = $1`, [deviceId])).rows,
      events: (await tx.query<{ action: string }>(`select action from app.identity_event where subject_id = $1`, [deviceId])).rows,
    }));
    expect(row.device).toEqual({ jkt: device.jkt, status: 'active' });
    expect(row.scope).toEqual([{ location_id: outletA }]);
    expect(row.events.map((e) => e.action)).toContain('device.enrol');
  });

  it('a retry of the SAME request replays; a second device with the same code is refused', async () => {
    const device = await newDevice();
    const code = await rig.issueCode(tenantA, outletA);
    const key = uuidv7();
    const first = await rig.enrol(device, code, { key });
    const retry = await rig.enrol(device, code, { key });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body['deviceId']).toBe(first.body['deviceId']);
    const other = await rig.enrol(await newDevice(), code);
    expect(other.status).toBe(409);
    expect(other.body['error']).toBe('enrolment_code_used');
  });

  it('is case- and hyphen-forgiving (positive), and refuses unknown, malformed and expired codes', async () => {
    const code = await rig.issueCode(tenantA, outletA);
    expect((await rig.enrol(await newDevice(), code.toLowerCase().replace('-', ''))).status).toBe(200);
    expect((await rig.enrol(await newDevice(), 'ZZZZ-ZZZZ')).status).toBe(404);
    expect((await rig.enrol(await newDevice(), 'ABC!-1234')).status).toBe(400);
    const stale = await rig.issueCode(tenantA, outletA);
    await rig.h.db.asAdmin((tx) =>
      tx.query(`update platform.enrolment_code_route set expires_at = now() - interval '1 minute' where claimed_at is null`),
    );
    const r = await rig.enrol(await newDevice(), stale);
    expect(r.status).toBe(410);
  });

  it('refuses a proof signed by a key OTHER than the one being enrolled', async () => {
    const device = await newDevice();
    const imposter = await newDevice();
    const code = await rig.issueCode(tenantA, outletA);
    const res = await rig.app.inject({
      method: 'POST',
      url: '/auth/enrol',
      headers: { dpop: await imposter.proof('POST', '/auth/enrol') },
      payload: { code, publicJwk: device.publicJwk, idempotencyKey: uuidv7() },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('enrolment_key_mismatch');
  });

  it('rate-limits redemption per source: 5 an hour, the sixth refused', async () => {
    const remote = '10.99.99.99';
    for (let i = 0; i < 5; i += 1) {
      expect((await rig.enrol(await newDevice(), 'ZZZZ-ZZZY', { remote })).status).toBe(404);
    }
    expect((await rig.enrol(await newDevice(), 'ZZZZ-ZZZY', { remote })).status).toBe(429);
    // A different source is unaffected (positive control).
    expect((await rig.enrol(await newDevice(), 'ZZZZ-ZZZY', { remote: '10.99.99.98' })).status).toBe(404);
  });

  it('rate-limits per TENANT and raises an alert, not merely a refusal', async () => {
    const alerts: string[] = [];
    const svc = createIdentityService({
      runner: rig.h.db,
      preTenant: preTenantRunnerFrom(rig.h.db),
      clock: rig.h.deps.clock,
      issuer: ISSUER,
      signing: rig.signing,
      leaseKeys: rig.leaseKeys,
      perTenant: createRateLimiter(2, HOUR_MS),
      onAlert: (a) => alerts.push(`${a.kind}:${a.tenantId}`),
    });
    const app = await buildServer({ deps: rig.h.deps, identity: svc, publicUrl: API });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const device = await newDevice();
        const code = await rig.issueCode(tenantB, outletB);
        const res = await app.inject({
          method: 'POST',
          url: '/auth/enrol',
          remoteAddress: `10.77.0.${i}`,
          headers: { dpop: await device.proof('POST', '/auth/enrol') },
          payload: { code, publicJwk: device.publicJwk, idempotencyKey: uuidv7() },
        });
        statuses.push(res.statusCode);
      }
      expect(statuses).toEqual([200, 200, 429]);
      expect(alerts).toEqual([`enrolment_rate_limit:${tenantB}`]);
    } finally {
      await app.close();
    }
  });

  it('refuses a code for an INACTIVE location at issue time', async () => {
    const inactive = await rig.h.db.withTenant(tenantA, async (tx) =>
      (await tx.query<{ id: string }>(`select id from app.location where kind = 'OUTLET' and not is_active limit 1`)).rows[0]?.id,
    );
    expect(inactive).toBeTruthy();
    await expect(rig.issueCode(tenantA, inactive!)).rejects.toThrow(/no such active location/);
  });

  it('a code for tenant A enrols into tenant A whatever the device claims — there is no field to claim with', async () => {
    const code = await rig.issueCode(tenantA, outletA);
    const device = await newDevice();
    const res = await rig.app.inject({
      method: 'POST',
      url: '/auth/enrol',
      headers: { dpop: await device.proof('POST', '/auth/enrol') },
      payload: { code, publicJwk: device.publicJwk, idempotencyKey: uuidv7(), tenantId: tenantB },
    });
    // .strict() refuses the forged field outright — it is never merely ignored.
    expect(res.statusCode).toBe(400);
  });
});

describe('sign-in via the IdP (§2.2)', () => {
  it('issues a DPoP-bound, single-audience, thin access token; the tenant comes from the DEVICE', async () => {
    const { device, deviceId } = await enrolled(tenantA, outletA);
    const sub = `idp|${uuidv7()}`;
    const userId = await rig.linkedUser(tenantA, sub, 'counter_staff', outletA);
    const s = await rig.signedIn(device, sub);
    expect(s.userId).toBe(userId);
    expect(s.tenantId).toBe(tenantA);
    expect(s.deviceId).toBe(deviceId);
    expect(s.locationIds).toEqual([outletA]);
    const { payload, protectedHeader } = await jwtVerify(s.accessToken, createLocalJWKSet(rig.signing.jwks()), {
      issuer: ISSUER,
      audience: 'erp-api',
    });
    expect(protectedHeader.alg).toBe('ES256');
    expect(payload['tid']).toBe(tenantA);
    expect(payload['did']).toBe(deviceId);
    expect(payload['sid']).toBe(s.sessionId);
    expect(payload['sid']).not.toBe(deviceId);
    expect((payload['cnf'] as { jkt: string }).jkt).toBe(device.jkt);
    expect(payload.exp! - payload.iat!).toBe(15 * 60);
    // Thin: no permissions, no scope, no role.
    for (const k of ['perms', 'permissions', 'locs', 'role', 'scope']) expect(k in payload).toBe(false);
  });

  it('IGNORES a tenant claim in the id_token — an IdP admin cannot move a user between tenants', async () => {
    const { device } = await enrolled(tenantA, outletA);
    const sub = `idp|${uuidv7()}`;
    await rig.linkedUser(tenantA, sub, 'counter_staff', outletA);
    const nonce = `${device.jkt}.${'x'.repeat(22)}`;
    const res = await rig.app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { dpop: await device.proof('POST', '/auth/session') },
      payload: { idToken: await rig.idToken(sub, nonce, { tid: tenantB, tenant_id: tenantB, org: tenantB }), nonce },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { tenantId: string }).tenantId).toBe(tenantA);
  });

  it('a subject linked only in tenant B cannot sign in on a tenant-A device', async () => {
    const { device } = await enrolled(tenantA, outletA);
    const sub = `idp|${uuidv7()}`;
    await rig.linkedUser(tenantB, sub, 'counter_staff', outletB);
    const r = await rig.signIn(device, sub);
    expect(r.status).toBe(403);
    // Positive control: the same subject on a tenant-B device signs in.
    const { device: bDevice } = await enrolled(tenantB, outletB);
    expect((await rig.signIn(bDevice, sub)).status).toBe(200);
  });

  it('refuses: nonce not bound to the key, wrong audience, foreign IdP key, stale id_token, unlinked and disabled users', async () => {
    const { device } = await enrolled(tenantA, outletA);
    const sub = `idp|${uuidv7()}`;
    const userId = await rig.linkedUser(tenantA, sub, 'counter_staff', outletA);
    const post = async (idToken: string, nonce: string) =>
      (
        await rig.app.inject({
          method: 'POST',
          url: '/auth/session',
          headers: { dpop: await device.proof('POST', '/auth/session') },
          payload: { idToken, nonce },
        })
      ).statusCode;

    const other = await newDevice();
    const unbound = `${other.jkt}.${'a'.repeat(22)}`;
    expect(await post(await rig.idToken(sub, unbound), unbound)).toBe(400);

    const nonce = () => `${device.jkt}.${uuidv7().replace(/-/g, '')}`;
    let n = nonce();
    expect(await post(await rig.idToken(sub, n, {}, { aud: 'someone-else' }), n)).toBe(401);
    const { privateKey: foreignKey } = await generateKeyPair('ES256');
    n = nonce();
    expect(await post(await rig.idToken(sub, n, {}, { key: foreignKey }), n)).toBe(401);
    n = nonce();
    expect(await post(await rig.idToken(sub, n, {}, { iatOffsetS: -20 * 60 }), n)).toBe(401);
    n = nonce();
    expect(await post(await rig.idToken(sub, nonce()), n)).toBe(401); // nonce mismatch
    n = nonce();
    expect(await post(await rig.idToken(`idp|${uuidv7()}`, n), n)).toBe(403); // unlinked
    // An id_token can be used ONCE.
    n = nonce();
    const once = await rig.idToken(sub, n);
    expect(await post(once, n)).toBe(200);
    expect(await post(once, n)).toBe(401);
    // Disabled user: refused (positive control above was the same user).
    await rig.h.db.withTenant(tenantA, (tx) => tx.query(`update app.user_account set status = 'DISABLED' where id = $1`, [userId]));
    n = nonce();
    expect(await post(await rig.idToken(sub, n), n)).toBe(403);
  });
});

describe('per-request verification: forged token, foreign device, revoked device (§2.2 steps 1–4)', () => {
  let device: Awaited<ReturnType<typeof newDevice>>;
  let s: Awaited<ReturnType<IdentityRig['signedIn']>>;
  beforeAll(async () => {
    ({ device } = await enrolled(tenantA, outletA));
    const sub = `idp|${uuidv7()}`;
    await rig.linkedUser(tenantA, sub, 'outlet_manager', outletA);
    s = await rig.signedIn(device, sub);
  });

  it('positive control: the token + a proof from its key reads the session', async () => {
    const r = await rig.trpcQuery(device, s, 'session.permissions');
    expect(r.status).toBe(200);
  });

  it('a FORGED token (right kid, wrong key) is refused', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const forged = await new SignJWT({ tid: tenantB, did: s.deviceId, sid: s.sessionId, cnf: { jkt: device.jkt } })
      .setProtectedHeader({ alg: 'ES256', kid: rig.signing.active.kid, typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience('erp-api')
      .setSubject(s.userId)
      .setJti(uuidv7())
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
    expect((await rig.trpcQuery(device, { accessToken: forged }, 'session.permissions')).status).toBe(401);
  });

  it('an HS256 dev token is refused on the DPoP scheme, and an ES256 token is refused as a bare Bearer', async () => {
    const dev = await signDevToken(JWT_SECRET, { tid: tenantA, uid: s.userId, role: 'x', locs: [outletA] });
    expect((await rig.trpcQuery(device, { accessToken: dev }, 'session.permissions')).status).toBe(401);
    const r = await rig.call(device, s, 'GET', '/trpc/session.permissions', undefined, { scheme: 'Bearer', proof: null });
    expect(r.status).toBe(401);
  });

  it('a token replayed WITHOUT a proof, or with a proof from a FOREIGN device key, is refused', async () => {
    expect((await rig.call(device, s, 'GET', '/trpc/session.permissions', undefined, { proof: null })).status).toBe(401);
    const thief = await newDevice();
    const proof = await thief.proof('GET', '/trpc/session.permissions', s.accessToken);
    expect((await rig.call(device, s, 'GET', '/trpc/session.permissions', undefined, { proof })).status).toBe(401);
  });

  it('a proof for a different URL or method, a replayed proof, or one not bound to this token is refused', async () => {
    const wrongUrl = await device.proof('GET', '/trpc/session.other', s.accessToken);
    expect((await rig.call(device, s, 'GET', '/trpc/session.permissions', undefined, { proof: wrongUrl })).status).toBe(401);
    const wrongMethod = await device.proof('POST', '/trpc/session.permissions', s.accessToken);
    expect((await rig.call(device, s, 'GET', '/trpc/session.permissions', undefined, { proof: wrongMethod })).status).toBe(401);
    const noAth = await device.proof('GET', '/trpc/session.permissions');
    expect((await rig.call(device, s, 'GET', '/trpc/session.permissions', undefined, { proof: noAth })).status).toBe(401);
    const once = await device.proof('GET', '/trpc/session.permissions', s.accessToken);
    expect((await rig.call(device, s, 'GET', '/trpc/session.permissions', undefined, { proof: once })).status).toBe(200);
    expect((await rig.call(device, s, 'GET', '/trpc/session.permissions', undefined, { proof: once })).status).toBe(401);
  });

  it('the revocation store being unreadable REFUSES with 503 — never admits', async () => {
    const failing = createIdentityService({
      runner: { withTenant: () => Promise.reject(new Error('store down')) },
      preTenant: preTenantRunnerFrom(rig.h.db),
      clock: rig.h.deps.clock,
      issuer: ISSUER,
      signing: rig.signing,
      leaseKeys: rig.leaseKeys,
      revocationCacheMs: 0,
    });
    const app = await buildServer({ deps: rig.h.deps, identity: failing, publicUrl: API });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/trpc/session.permissions',
        headers: {
          authorization: `DPoP ${s.accessToken}`,
          dpop: await device.proof('GET', '/trpc/session.permissions', s.accessToken),
        },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: string }).error).toBe('revocation_unavailable');
    } finally {
      await app.close();
    }
  });
});

describe('revocation answers 423 and drains before wipe (§2.7)', () => {
  it('a retired device gets 423 device_revoked on every surface; its writes drain into REVIEW and post nothing', async () => {
    const { device, deviceId } = await enrolled(tenantA, outletA);
    const sub = `idp|${uuidv7()}`;
    await rig.linkedUser(tenantA, sub, 'outlet_manager', outletA);
    const s = await rig.signedIn(device, sub);
    // Positive control: live before revocation.
    expect((await rig.trpcQuery(device, s, 'session.permissions')).status).toBe(200);

    const admin = await rig.admin(tenantA);
    await rig.h.callerFor(admin).admin.devices.revoke({ idempotencyKey: uuidv7(), deviceId, reason: 'lost' });

    const api = await rig.trpcQuery(device, s, 'session.permissions');
    expect(api.status).toBe(423);
    expect(api.body).toMatchObject({ error: 'LOCKED', reason: 'device_revoked', drain: 'allowed' });
    const upload = await rig.call(device, s, 'POST', '/sync/upload', { ops: [] });
    expect(upload.status).toBe(423);
    const refresh = await rig.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { dpop: await device.proof('POST', '/auth/refresh') },
      payload: { refreshToken: s.refreshToken },
    });
    expect(refresh.statusCode).toBe(423);

    // The drain: same envelope as /sync/upload, DPoP-only (the token is dead).
    const op = {
      idempotency_key: uuidv7(),
      kind: 'sale.create',
      client_wall_at: new Date().toISOString(),
      payload: { locationId: outletA, tender: 'CASH', lines: [], tenant_id: tenantB },
    };
    const drain = async () =>
      rig.app.inject({
        method: 'POST',
        url: '/sync/revoked-drain',
        headers: { dpop: await device.proof('POST', '/sync/revoked-drain') },
        payload: { ops: [op] },
      });
    const first = await drain();
    expect(first.statusCode).toBe(200);
    const ack = (first.json() as { acks: { status: string; reviewId: string }[] }).acks[0]!;
    expect(ack.status).toBe('quarantined');
    const again = await drain();
    expect((again.json() as { acks: { status: string }[] }).acks[0]!.status).toBe('duplicate');

    const after = await rig.h.db.withTenant(tenantA, async (tx) => ({
      review: (await tx.query<{ conflict_class: string; status: string; proposals: { write: { payload: Record<string, unknown> } } }>(
        `select conflict_class, status, proposals from app.conflict_review where id = $1`,
        [ack.reviewId],
      )).rows[0],
      sales: (await tx.query(`select 1 from app.sale where write_id = $1`, [op.idempotency_key])).rows.length,
    }));
    expect(after.review?.conflict_class).toBe('REVOKED_DEVICE_WRITE');
    expect(after.review?.status).toBe('open');
    expect('tenant_id' in (after.review?.proposals.write.payload ?? {})).toBe(false); // forged tenant stripped
    expect(after.sales).toBe(0); // NOTHING posted into the books

    // The bare count of what could not be delivered: a severity-1 review.
    const abandoned = await rig.app.inject({
      method: 'POST',
      url: '/sync/revoked-drain/abandoned',
      headers: { dpop: await device.proof('POST', '/sync/revoked-drain/abandoned') },
      payload: { undrainedCount: 7 },
    });
    expect(abandoned.statusCode).toBe(200);
    const sev1 = await rig.h.db.withTenant(tenantA, async (tx) =>
      (await tx.query<{ severity: number }>(
        `select severity from app.conflict_review where conflict_class = 'REVOKED_DEVICE_DRAIN_ABANDONED' and entity_id = $1`,
        [deviceId],
      )).rows,
    );
    expect(sev1).toEqual([{ severity: 1 }]);
  });

  it('a device revoked as STOLEN gets drain=refused and the drain is closed — wipe on contact', async () => {
    const { device, deviceId } = await enrolled(tenantA, outletA);
    const sub = `idp|${uuidv7()}`;
    await rig.linkedUser(tenantA, sub, 'counter_staff', outletA);
    const s = await rig.signedIn(device, sub);
    const admin = await rig.admin(tenantA);
    await rig.h.callerFor(admin).admin.devices.revoke({ idempotencyKey: uuidv7(), deviceId, reason: 'stolen' });
    const r = await rig.trpcQuery(device, s, 'session.permissions');
    expect(r.status).toBe(423);
    expect(r.body).toMatchObject({ drain: 'refused', drainUntil: null });
    const drain = await rig.app.inject({
      method: 'POST',
      url: '/sync/revoked-drain',
      headers: { dpop: await device.proof('POST', '/sync/revoked-drain') },
      payload: { ops: [{ idempotency_key: uuidv7(), kind: 'sale.create', client_wall_at: new Date().toISOString(), payload: {} }] },
    });
    expect(drain.statusCode).toBe(423);
  });

  it('a LIVE device cannot use the drain — it is for the dead', async () => {
    const { device } = await enrolled(tenantA, outletA);
    const res = await rig.app.inject({
      method: 'POST',
      url: '/sync/revoked-drain',
      headers: { dpop: await device.proof('POST', '/sync/revoked-drain') },
      payload: { ops: [{ idempotency_key: uuidv7(), kind: 'sale.create', client_wall_at: new Date().toISOString(), payload: {} }] },
    });
    expect(res.statusCode).toBe(409);
  });

  it('a suspended device is refused (403) and reinstated by the same act (positive control)', async () => {
    const { device, deviceId } = await enrolled(tenantA, outletA);
    const sub = `idp|${uuidv7()}`;
    await rig.linkedUser(tenantA, sub, 'counter_staff', outletA);
    const s = await rig.signedIn(device, sub);
    const admin = rig.h.callerFor(await rig.admin(tenantA));
    await admin.admin.devices.setStatus({ idempotencyKey: uuidv7(), deviceId, status: 'suspended' });
    expect((await rig.trpcQuery(device, s, 'session.permissions')).status).toBe(403);
    await admin.admin.devices.setStatus({ idempotencyKey: uuidv7(), deviceId, status: 'active' });
    expect((await rig.trpcQuery(device, s, 'session.permissions')).status).toBe(200);
  });
});

describe('the rotating refresh credential', () => {
  it('rotates on use; presenting a spent credential is REUSE and kills the session', async () => {
    const { device } = await enrolled(tenantA, outletA);
    const sub = `idp|${uuidv7()}`;
    await rig.linkedUser(tenantA, sub, 'counter_staff', outletA);
    const s = await rig.signedIn(device, sub);
    const refresh = async (token: string) => {
      const res = await rig.app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { dpop: await device.proof('POST', '/auth/refresh') },
        payload: { refreshToken: token },
      });
      return { status: res.statusCode, body: res.json() as { refreshToken: string; accessToken: string; error?: string } };
    };
    const r1 = await refresh(s.refreshToken);
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);
    // The new access token works (positive control).
    expect((await rig.trpcQuery(device, r1.body, 'session.permissions')).status).toBe(200);
    // The spent one, again: reuse.
    const reuse = await refresh(s.refreshToken);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toBe('refresh_reused');
    // ...and the WHOLE session is dead: the current refresh and access token too.
    expect((await refresh(r1.body.refreshToken)).status).toBe(401);
    expect((await rig.trpcQuery(device, r1.body, 'session.permissions')).status).toBe(401);
  });

  it('a refresh credential from ANOTHER device is refused (bound to the key)', async () => {
    const { device } = await enrolled(tenantA, outletA);
    const { device: other } = await enrolled(tenantA, outletA);
    const sub = `idp|${uuidv7()}`;
    await rig.linkedUser(tenantA, sub, 'counter_staff', outletA);
    const s = await rig.signedIn(device, sub);
    const res = await rig.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { dpop: await other.proof('POST', '/auth/refresh') },
      payload: { refreshToken: s.refreshToken },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('the sync token and the offline lease', () => {
  it('a device session gets an ES256 erp-sync token keyed on tid/sub/did, and a lease signed by the LEASE key', async () => {
    const { device, deviceId } = await enrolled(tenantA, outletA);
    const sub = `idp|${uuidv7()}`;
    const userId = await rig.linkedUser(tenantA, sub, 'counter_staff', outletA);
    const s = await rig.signedIn(device, sub);
    const r = await rig.call(device, s, 'GET', '/sync/token');
    expect(r.status).toBe(200);
    const body = r.body as { token: string; lease: { lease: string; keys: { keys: Record<string, unknown>[] } } };
    const jwks = (await rig.app.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json() as { keys: never[] };
    const { payload } = await jwtVerify(body.token, createLocalJWKSet(jwks), { audience: 'erp-sync', issuer: ISSUER });
    expect(payload).toMatchObject({ tid: tenantA, sub: userId, did: deviceId });
    expect(payload.exp! - payload.iat!).toBe(300);

    // The lease does NOT verify under the token keys, and does under the lease keys.
    await expect(jwtVerify(body.lease.lease, createLocalJWKSet(jwks))).rejects.toThrow();
    const lease = await jwtVerify(body.lease.lease, createLocalJWKSet(body.lease.keys as never), { typ: 'erp-lease+jwt' });
    const claims = leaseClaims.parse(lease.payload);
    expect(claims.full_until - claims.issued_at).toBe(72 * 3600);
    expect(claims.hard_stop_at - claims.full_until).toBe(24 * 3600);
    expect(claims.scope).toContain(outletA);
    // Counter staff: cash survives restricted mode; stock.adjust is not theirs;
    // a `never` code (report.view.tenant) is not on a lease at all.
    expect(claims.offline.always).toContain('sale.record');
    expect(claims.offline.until_lease_expiry).not.toContain('stock.adjust');
    expect([...claims.offline.always, ...claims.offline.until_lease_expiry]).not.toContain('report.view.tenant');
  });

  it('an outlet manager\'s lease carries stock.adjust as until_lease_expiry — it stops in restricted mode', async () => {
    const { device } = await enrolled(tenantA, outletA);
    const sub = `idp|${uuidv7()}`;
    await rig.linkedUser(tenantA, sub, 'outlet_manager', outletA);
    const s = await rig.signedIn(device, sub);
    const claims = leaseClaims.parse(
      (await jwtVerify(s.lease!.lease, createLocalJWKSet(s.lease!.keys as never))).payload,
    );
    expect(claims.offline.until_lease_expiry).toContain('stock.adjust');
    expect(claims.offline.always).not.toContain('stock.adjust');
  });

  it('the device ceiling bounds the lease: a root-scoped user on an outlet tablet gets that outlet only', async () => {
    const { device } = await enrolled(tenantA, outletA2);
    const sub = `idp|${uuidv7()}`;
    const root = await rig.h.rootLocation(tenantA);
    await rig.linkedUser(tenantA, sub, 'regional_manager', root);
    const s = await rig.signedIn(device, sub);
    expect(s.locationIds).toEqual([outletA2]);
    const claims = leaseClaims.parse((await jwtVerify(s.lease!.lease, createLocalJWKSet(s.lease!.keys as never))).payload);
    expect(claims.scope).toContain(outletA2);
    expect(claims.scope).not.toContain(outletA);
  });

  it('a laptop enrolled with NO location has an empty ceiling: a session, but nothing to hold offline', async () => {
    const { device } = await enrolled(tenantA, null);
    const sub = `idp|${uuidv7()}`;
    await rig.linkedUser(tenantA, sub, 'accounts', await rig.h.rootLocation(tenantA));
    const s = await rig.signedIn(device, sub);
    expect(s.locationIds).toEqual([]);
    const claims = leaseClaims.parse((await jwtVerify(s.lease!.lease, createLocalJWKSet(s.lease!.keys as never))).payload);
    expect(claims.scope).toEqual([]);
    // ...and it still works ONLINE (positive control for the empty ceiling).
    expect((await rig.trpcQuery(device, s, 'session.permissions')).status).toBe(200);
  });
});

describe('two tenants — every new read path', () => {
  it('admin reads in tenant B see none of tenant A\'s devices, codes, users or roles', async () => {
    await enrolled(tenantA, outletA);
    const callerA = rig.h.callerFor(await rig.admin(tenantA));
    const callerB = rig.h.callerFor(await rig.admin(tenantB));
    const aDevices = await callerA.admin.devices.list();
    const bDevices = await callerB.admin.devices.list();
    expect(aDevices.length).toBeGreaterThan(0); // positive control
    const aIds = new Set(aDevices.map((d) => d.id));
    expect(bDevices.filter((d) => aIds.has(d.id))).toEqual([]);

    const aCodes = await callerA.admin.devices.codes();
    const bCodes = await callerB.admin.devices.codes();
    expect(aCodes.length).toBeGreaterThan(0);
    expect(bCodes.filter((c) => aCodes.some((a) => a.id === c.id))).toEqual([]);

    const aUsers = await callerA.admin.users.list();
    const bUsers = await callerB.admin.users.list();
    expect(aUsers.length).toBeGreaterThan(0);
    expect(bUsers.filter((u) => aUsers.some((a) => a.id === u.id))).toEqual([]);

    const aRoles = await callerA.admin.roles.list();
    const bRoles = await callerB.admin.roles.list();
    expect(bRoles.filter((r) => aRoles.some((a) => a.id === r.id))).toEqual([]);

    const bLocations = await callerB.admin.locations();
    expect(bLocations.some((l) => l.id === outletA)).toBe(false);
    expect(bLocations.some((l) => l.id === outletB)).toBe(true);
  });

  it('tenant B cannot revoke, suspend or rescope a tenant-A device', async () => {
    const { deviceId } = await enrolled(tenantA, outletA);
    const callerB = rig.h.callerFor(await rig.admin(tenantB));
    await expect(callerB.admin.devices.revoke({ idempotencyKey: uuidv7(), deviceId, reason: 'lost' })).rejects.toThrow();
    await expect(callerB.admin.devices.setStatus({ idempotencyKey: uuidv7(), deviceId, status: 'suspended' })).rejects.toThrow();
    const status = await rig.h.db.withTenant(tenantA, async (tx) =>
      (await tx.query<{ status: string }>(`select status from app.device where id = $1`, [deviceId])).rows[0]?.status,
    );
    expect(status).toBe('active');
  });

  it('a tenant-A device key cannot sign anyone into tenant B, and the sync projections never cross', async () => {
    const { device, deviceId } = await enrolled(tenantA, outletA);
    const sub = `idp|${uuidv7()}`;
    const userId = await rig.linkedUser(tenantA, sub, 'counter_staff', outletA);
    await rig.signedIn(device, sub);
    // The same subject linked in tenant B gets nothing on this (tenant-A) key.
    await rig.linkedUser(tenantB, sub, 'counter_staff', outletB);
    const again = await rig.signIn(device, sub);
    expect((again.body as { tenantId?: string }).tenantId).toBe(tenantA);
    const inB = await rig.h.db.withTenant(tenantB, async (tx) =>
      (await tx.query(`select 1 from app.device_sync_grant where device_id = $1`, [deviceId])).rows.length,
    );
    const inA = await rig.h.db.withTenant(tenantA, async (tx) =>
      (await tx.query<{ user_id: string }>(`select user_id from app.device_sync_grant where device_id = $1`, [deviceId])).rows,
    );
    // One grant row per user whose scope meets this tablet's ceiling — the
    // clerk, and the tenant's root-scoped people (founder, accounts).
    expect(inA.map((r) => r.user_id)).toContain(userId);
    expect(inB).toBe(0);
  });
});

describe('auth config', () => {
  it('publishes the IdP endpoints the PWA needs, and nothing secret', async () => {
    const res = await rig.app.inject({ method: 'GET', url: '/auth/config' });
    const body = res.json() as { oidc: Record<string, string> };
    expect(body.oidc).toMatchObject({ issuer: IDP_ISSUER, clientId: 'erp-pwa' });
    expect(JSON.stringify(body)).not.toMatch(/secret|"d"/);
  });
});
