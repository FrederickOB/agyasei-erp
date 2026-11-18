/**
 * A hermetic identity rig: the real API server (Fastify + tRPC) over PGlite,
 * the real identity service, a TEST IdP built with `jose` (no IdP account,
 * no network), and test DEVICES that hold a P-256 key and sign real DPoP
 * proofs. Everything goes over `app.inject` — real HTTP semantics, real
 * headers, real status codes.
 */
import type { FastifyInstance } from 'fastify';
import {
  SignJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from 'jose';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@erp/db';
import { preTenantRunnerFrom } from '../src/db.js';
import { accessTokenHash } from '../src/identity/dpop.js';
import { generateKeyRing, type KeyRing } from '../src/identity/keys.js';
import { createIdTokenVerifier, type OidcConfig } from '../src/identity/oidc.js';
import { HOUR_MS, createRateLimiter } from '../src/identity/rate-limit.js';
import { createIdentityService, type IdentityService, type IdentityServiceOptions } from '../src/identity/service.js';
import { buildServer } from '../src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from './util.js';

export const API = 'http://api.test';
export const ISSUER = 'http://api.test';
export const IDP_ISSUER = 'https://idp.test/realms/erp';
export const CLIENT_ID = 'erp-pwa';

export interface TestDevice {
  privateKey: KeyLike;
  publicJwk: JWK & { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  jkt: string;
  /** A fresh DPoP proof for one request. */
  proof(method: string, path: string, accessToken?: string, overrides?: Record<string, unknown>): Promise<string>;
}

export async function newDevice(): Promise<TestDevice> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  const publicJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x!, y: jwk.y! };
  const jkt = await calculateJwkThumbprint(publicJwk, 'sha256');
  return {
    privateKey,
    publicJwk,
    jkt,
    async proof(method, path, accessToken, overrides = {}) {
      return new SignJWT({
        htm: method,
        htu: `${API}${path.split('?')[0]}`,
        jti: randomBytes(16).toString('base64url'),
        ...(accessToken ? { ath: accessTokenHash(accessToken) } : {}),
        ...overrides,
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk })
        .setIssuedAt()
        .sign(privateKey);
    },
  };
}

export interface SignedIn {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  userId: string;
  deviceId: string;
  tenantId: string;
  locationIds: string[];
  lease: { lease: string; keys: { keys: JWK[] } } | null;
}

export interface IdentityRig {
  h: ApiHarness;
  app: FastifyInstance;
  identity: IdentityService;
  signing: KeyRing;
  leaseKeys: KeyRing;
  idpPrivate: KeyLike;
  /** ONE owner-at-root admin identity per tenant, reused — see issueCode. */
  admin(tenantId: string): Promise<import('../src/auth.js').VerifiedIdentity>;
  idToken(sub: string, nonce: string, extra?: Record<string, unknown>, opts?: { aud?: string; key?: KeyLike; iatOffsetS?: number }): Promise<string>;
  /** Issue a code as the given (dev-path) admin identity's tenant. */
  issueCode(tenantId: string, locationId: string | null, label?: string): Promise<string>;
  enrol(device: TestDevice, code: string, opts?: { key?: string; remote?: string }): Promise<{ status: number; body: Record<string, unknown> }>;
  /** A user linked to IdP subject `sub`, holding a template role at a node. */
  linkedUser(tenantId: string, sub: string, roleRef: string, scopeLocationId: string): Promise<string>;
  signIn(device: TestDevice, sub: string, nonceSuffix?: string): Promise<{ status: number; body: Record<string, unknown> }>;
  signedIn(device: TestDevice, sub: string): Promise<SignedIn>;
  call(device: TestDevice, s: { accessToken: string }, method: 'GET' | 'POST', path: string, body?: unknown, opts?: { scheme?: string; proof?: string | null }): Promise<{ status: number; body: Record<string, unknown> }>;
  trpcQuery(device: TestDevice, s: { accessToken: string }, path: string, input?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

export async function createIdentityRig(
  serviceOverrides: Partial<IdentityServiceOptions> = {},
): Promise<IdentityRig> {
  const h = await createApiHarness();
  const { privateKey: idpPrivate, publicKey: idpPublic } = await generateKeyPair('ES256');
  const idpJwk = { ...(await exportJWK(idpPublic)), kid: 'idp-1', alg: 'ES256' };
  const oidcConfig: OidcConfig = { issuer: IDP_ISSUER, clientId: CLIENT_ID, algorithms: ['ES256'], scope: 'openid profile' };
  const verifier = createIdTokenVerifier(oidcConfig, {
    keys: createLocalJWKSet({ keys: [idpJwk] }),
    discovery: {
      issuer: IDP_ISSUER,
      authorizationEndpoint: `${IDP_ISSUER}/auth`,
      tokenEndpoint: `${IDP_ISSUER}/token`,
      jwksUri: `${IDP_ISSUER}/jwks`,
    },
  });
  const signing = await generateKeyRing('test-signing-1');
  const leaseKeys = await generateKeyRing('test-lease-1');
  const identity = createIdentityService({
    runner: h.db,
    preTenant: preTenantRunnerFrom(h.db),
    clock: h.deps.clock,
    issuer: ISSUER,
    signing,
    leaseKeys,
    oidc: { config: oidcConfig, verifier },
    revocationCacheMs: 0,
    onAlert: () => undefined,
    // A suite enrols far more than 20 devices into one tenant; the per-tenant
    // limit is proven by its own test with its own limiter.
    perTenant: createRateLimiter(10_000, HOUR_MS),
    ...serviceOverrides,
  });
  const app = await buildServer({
    deps: h.deps,
    jwtSecret: JWT_SECRET,
    identity,
    publicUrl: API,
  });

  async function idToken(
    sub: string,
    nonce: string,
    extra: Record<string, unknown> = {},
    opts: { aud?: string; key?: KeyLike; iatOffsetS?: number } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000) + (opts.iatOffsetS ?? 0);
    return new SignJWT({ nonce, ...extra })
      .setProtectedHeader({ alg: 'ES256', kid: 'idp-1' })
      .setIssuer(IDP_ISSUER)
      .setAudience(opts.aud ?? CLIENT_ID)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(opts.key ?? idpPrivate);
  }

  // Every h.identityFor() mints a NEW owner at the tenant root. A rig that
  // did that per code grew dozens of root users × dozens of devices, and
  // every trigger recomputed the whole product — the suite slowed to minutes
  // per test. One administrator per tenant, like a real back office.
  const admins = new Map<string, Promise<import('../src/auth.js').VerifiedIdentity>>();
  function admin(tenantId: string) {
    let a = admins.get(tenantId);
    if (!a) {
      a = h.identityFor(tenantId);
      admins.set(tenantId, a);
    }
    return a;
  }

  async function issueCode(tenantId: string, locationId: string | null, label = 'Counter tablet'): Promise<string> {
    const adminIdentity = await admin(tenantId); // owner at root, dev path
    const res = await h.callerFor(adminIdentity).admin.devices.issueCode({
      idempotencyKey: uuidv7(),
      label,
      formFactor: 'tablet',
      locationId,
    });
    if (!res.code) throw new Error('no code returned');
    return res.code;
  }

  async function enrol(device: TestDevice, code: string, opts: { key?: string; remote?: string } = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/enrol',
      remoteAddress: opts.remote ?? `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      headers: { dpop: await device.proof('POST', '/auth/enrol') },
      payload: { code, publicJwk: device.publicJwk, idempotencyKey: opts.key ?? uuidv7() },
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  async function linkedUser(tenantId: string, sub: string, roleRef: string, scopeLocationId: string): Promise<string> {
    const userId = uuidv7();
    await h.grantRole(tenantId, userId, roleRef, scopeLocationId);
    await h.db.withTenant(tenantId, (tx) =>
      tx.query(`update app.user_account set subject_issuer = $2, subject_ref = $3 where id = $1`, [userId, IDP_ISSUER, sub]),
    );
    return userId;
  }

  async function signIn(device: TestDevice, sub: string, nonceSuffix = randomBytes(16).toString('base64url')) {
    const nonce = `${device.jkt}.${nonceSuffix}`;
    const res = await app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { dpop: await device.proof('POST', '/auth/session') },
      payload: { idToken: await idToken(sub, nonce), nonce },
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  async function signedIn(device: TestDevice, sub: string): Promise<SignedIn> {
    const r = await signIn(device, sub);
    if (r.status !== 200) throw new Error(`sign-in failed ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body as unknown as SignedIn;
  }

  async function call(
    device: TestDevice,
    s: { accessToken: string },
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    opts: { scheme?: string; proof?: string | null } = {},
  ) {
    const proof = opts.proof === undefined ? await device.proof(method, path, s.accessToken) : opts.proof;
    const res = await app.inject({
      method,
      url: path,
      headers: {
        authorization: `${opts.scheme ?? 'DPoP'} ${s.accessToken}`,
        ...(proof !== null ? { dpop: proof } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = res.json() as Record<string, unknown>;
    } catch {
      parsed = { raw: res.body };
    }
    return { status: res.statusCode, body: parsed };
  }

  async function trpcQuery(device: TestDevice, s: { accessToken: string }, path: string, input?: unknown) {
    const q = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    return call(device, s, 'GET', `/trpc/${path}${q}`);
  }

  return {
    h,
    app,
    identity,
    signing,
    leaseKeys,
    idpPrivate,
    admin,
    idToken,
    issueCode,
    enrol,
    linkedUser,
    signIn,
    signedIn,
    call,
    trpcQuery,
    close: async () => {
      await app.close();
      await h.close();
    },
  };
}
