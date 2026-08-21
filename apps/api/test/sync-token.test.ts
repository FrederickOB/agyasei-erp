/**
 * GET /sync/token — exchanges a verified API JWT for a short-lived PowerSync
 * client token (infra/README "Auth contract"; sync_rules.yaml token
 * contract): HS256 with the ONE shared dev secret, aud "powersync", `tid`
 * from the VERIFIED session — never from any input — plus the interim
 * `location_id` scope claim, short expiry.
 *
 * The deps carry a runner that THROWS on use: token minting must read
 * nothing from the database and nothing from the request beyond the
 * verified bearer identity.
 */
import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHlcClock, hlcNodeFromName, uuidv7 } from '@erp/db';
import { signDevToken } from '../src/auth.js';
import { createMemoryPolicyStore } from '../src/credit-policy.js';
import { buildServer } from '../src/server.js';

const JWT_SECRET = 'test-secret-not-for-production';
const TTL_S = 300;

let app: FastifyInstance;
const tenantA = uuidv7();
const tenantB = uuidv7();
const userId = uuidv7();
const locationId = uuidv7();

beforeAll(async () => {
  app = await buildServer({
    deps: {
      runner: {
        withTenant: () => {
          throw new Error('token minting must not touch the database');
        },
      },
      clock: createHlcClock(hlcNodeFromName('sync-token-test')),
      policyStore: createMemoryPolicyStore(),
    },
    jwtSecret: JWT_SECRET,
    // powersyncSecret deliberately omitted: it defaults to the ONE shared
    // dev secret, which is the infra contract under test.
    sync: { tokenTtlSeconds: TTL_S, powersyncUrl: 'http://localhost:8080' },
  });
});

afterAll(async () => {
  await app.close();
});

async function getToken(bearer?: string, url = '/sync/token') {
  return app.inject({
    method: 'GET',
    url,
    ...(bearer !== undefined ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
  });
}

async function apiBearer(tid: string): Promise<string> {
  return signDevToken(JWT_SECRET, {
    tid,
    uid: userId,
    role: 'outlet-staff',
    locs: [locationId],
  });
}

describe('GET /sync/token', () => {
  it('refuses unauthenticated calls: no bearer and garbage bearer both 401', async () => {
    expect((await getToken()).statusCode).toBe(401);
    expect((await getToken('not-a-jwt')).statusCode).toBe(401);
    const expired = await signDevToken(JWT_SECRET, {
      tid: tenantA,
      uid: userId,
      role: 'outlet-staff',
      locs: [],
    }, { expiresIn: '0s' });
    expect((await getToken(expired)).statusCode).toBe(401);
  });

  it('mints an HS256 token with aud "powersync", tid from the verified session, and short expiry', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await getToken(await apiBearer(tenantA));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; expires_at: string; endpoint: string };
    expect(body.endpoint).toBe('http://localhost:8080');

    // Verifies under the SAME shared secret the PowerSync service holds,
    // with the audience the service's client_auth requires.
    const { payload, protectedHeader } = await jwtVerify(
      body.token,
      new TextEncoder().encode(JWT_SECRET),
      { audience: 'powersync' },
    );
    expect(protectedHeader.alg).toBe('HS256');
    expect(payload.tid).toBe(tenantA);
    expect(payload.sub).toBe(userId);
    expect(payload.location_id).toBe(locationId);

    // Short-lived: exp − iat is exactly the configured TTL (≤ 5 min).
    expect(payload.exp! - payload.iat!).toBe(TTL_S);
    expect(payload.iat!).toBeGreaterThanOrEqual(before - 5);
    expect(Date.parse(body.expires_at)).toBe(payload.exp! * 1000);
  });

  it('rejects verification under a different audience — aud is really set', async () => {
    const res = await getToken(await apiBearer(tenantA));
    const { token } = res.json() as { token: string };
    await expect(
      jwtVerify(token, new TextEncoder().encode(JWT_SECRET), { audience: 'api' }),
    ).rejects.toThrow();
  });

  it('ignores every attempt to choose a tenant via the request — the session tid wins', async () => {
    const res = await getToken(
      await apiBearer(tenantA),
      `/sync/token?tid=${tenantB}&tenant_id=${tenantB}`,
    );
    expect(res.statusCode).toBe(200);
    const { token } = res.json() as { token: string };
    const { payload } = await jwtVerify(token, new TextEncoder().encode(JWT_SECRET), {
      audience: 'powersync',
    });
    expect(payload.tid).toBe(tenantA);
  });

  it('a session with no location scope gets a token with NO location_id claim (fail closed)', async () => {
    const noLocs = await signDevToken(JWT_SECRET, {
      tid: tenantA,
      uid: userId,
      role: 'outlet-staff',
      locs: [],
    });
    const res = await getToken(noLocs);
    expect(res.statusCode).toBe(200);
    const { token } = res.json() as { token: string };
    const { payload } = await jwtVerify(token, new TextEncoder().encode(JWT_SECRET), {
      audience: 'powersync',
    });
    expect(payload.tid).toBe(tenantA);
    expect('location_id' in payload).toBe(false);
  });
});
