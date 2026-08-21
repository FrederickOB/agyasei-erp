/**
 * CORS — the PWA is served from a different origin than the API (dev: :5173 vs
 * :3001), so every browser call is cross-origin and fails at preflight unless
 * the API answers OPTIONS with the right headers.
 *
 * This regression exists because the sync drills use @powersync/node, which has
 * no browser origin and therefore never exercised this path: the drills passed
 * 5/5 while the actual PWA could not reach the API at all. A green drill suite
 * is not evidence that a browser can talk to the server.
 *
 * The allow-list is explicit and never `origin: true`: these requests carry the
 * bearer token that establishes tenant identity, so reflecting arbitrary
 * origins would let any page a staff member visits drive the API as them.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHlcClock, hlcNodeFromName, uuidv7 } from '@erp/db';
import { signDevToken } from '../src/auth.js';
import { createMemoryPolicyStore } from '../src/credit-policy.js';
import { buildServer } from '../src/server.js';

const JWT_SECRET = 'test-secret-not-for-production';
const ALLOWED = 'http://localhost:5173';
const FOREIGN = 'https://evil.example.com';

let app: FastifyInstance;
let noCors: FastifyInstance;

const tenantId = uuidv7();
const userId = uuidv7();
const locationId = uuidv7();

function deps() {
  return {
    runner: {
      withTenant: () => {
        throw new Error('these routes must not touch the database');
      },
    },
    clock: createHlcClock(hlcNodeFromName('cors-test')),
    policyStore: createMemoryPolicyStore(),
  };
}

beforeAll(async () => {
  app = await buildServer({
    deps: deps(),
    jwtSecret: JWT_SECRET,
    sync: { powersyncUrl: 'http://localhost:8080' },
    corsOrigins: [ALLOWED, 'http://127.0.0.1:5173'],
  });
  // Same server with CORS unconfigured — the drills' shape.
  noCors = await buildServer({
    deps: deps(),
    jwtSecret: JWT_SECRET,
    sync: { powersyncUrl: 'http://localhost:8080' },
  });
});

afterAll(async () => {
  await app.close();
  await noCors.close();
});

const bearer = () =>
  signDevToken(JWT_SECRET, {
    tid: tenantId,
    uid: userId,
    role: 'outlet_manager',
    locs: [locationId],
  });

describe('preflight', () => {
  it('answers OPTIONS /sync/token for an allowed origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/sync/token',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    // The original bug: this route 404'd, so the browser blocked every call.
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization',
    );
  });

  it('answers OPTIONS /sync/upload — the write path the outbox drains to', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/sync/upload',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('does not grant an unlisted origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/sync/token',
      headers: {
        origin: FOREIGN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('actual requests', () => {
  it('echoes the allowed origin on a real GET so the browser accepts the body', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sync/token',
      headers: { origin: ALLOWED, authorization: `Bearer ${await bearer()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('never sets allow-credentials: identity is a bearer header, not a cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sync/token',
      headers: { origin: ALLOWED, authorization: `Bearer ${await bearer()}` },
    });
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('CORS does not weaken auth — an unlisted origin still cannot read without a token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sync/token',
      headers: { origin: FOREIGN },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('unconfigured', () => {
  it('serves non-browser callers normally when corsOrigins is unset', async () => {
    // The drills' path: no Origin header, no CORS needed.
    const res = await noCors.inject({
      method: 'GET',
      url: '/sync/token',
      headers: { authorization: `Bearer ${await bearer()}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
