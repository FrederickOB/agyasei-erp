/**
 * Identity configuration from the environment — the exact list the production
 * package provisions. Nothing here has a production default: a missing key or
 * issuer refuses to start rather than generating a fallback.
 *
 *   ERP_TOKEN_ISSUER        our `iss`, e.g. https://api.<platform>/ (exact match)
 *   ERP_PUBLIC_URL          the API's public base URL (DPoP htu). Behind Fly's
 *                           proxy this MUST be set. Defaults to the issuer.
 *   ERP_SIGNING_JWKS        JWKS of PRIVATE ES256 keys with kid; first signs.
 *                           Served (public halves) at /.well-known/jwks.json for
 *                           the PowerSync service.
 *   ERP_LEASE_JWKS          JWKS of PRIVATE ES256 keys for the offline lease —
 *                           a SEPARATE ring (02 §2.7), annual, two-key overlap.
 *   OIDC_ISSUER             the IdP's exact issuer
 *   OIDC_CLIENT_ID          our public client id at the IdP (PKCE, no secret)
 *   OIDC_ID_TOKEN_ALGS      comma list, default "ES256,EdDSA"; HS-family and none refused
 *   OIDC_JWKS_URI           optional override of the discovered jwks_uri
 *   OIDC_SCOPE              default "openid profile"
 *   LEASE_FULL_HOURS        T, default 72; ceiling 336 (14 days), refused above
 *   LEASE_GRACE_HOURS       default 24
 *
 * DEV ONLY (refused when NODE_ENV=production):
 *   DEV_JWT_SECRET          the HS256 shared secret for drills / dev:token
 *   ERP_DEV_KEYS_FILE       where the dev server persists generated ES256 keys
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { JWK } from 'jose';
import type { HlcClock } from '@erp/db';
import type { PreTenantRunner, TenantRunner } from '../db.js';
import { generatePrivateJwk, keyRingFromJwks, parseJwksEnv, type KeyRing } from './keys.js';
import { leasePolicy } from './lease.js';
import { DEFAULT_ID_TOKEN_ALGS, createIdTokenVerifier, type OidcConfig } from './oidc.js';
import { createIdentityService, type IdentityService } from './service.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface IdentityEnvResult {
  readonly identity: IdentityService;
  /** HS256 dev secret, or undefined in production. */
  readonly devJwtSecret: string | undefined;
  readonly publicUrl: string;
  readonly issuer: string;
  readonly oidcConfigured: boolean;
}

function isProduction(env: Env): boolean {
  return env['NODE_ENV'] === 'production';
}

async function loadRing(env: Env, name: string, devFile: string | undefined, devKid: string): Promise<KeyRing> {
  const raw = env[name];
  if (raw !== undefined && raw.trim().length > 0) return keyRingFromJwks(parseJwksEnv(name, raw));
  if (isProduction(env)) throw new Error(`${name} is required in production`);
  // DEV: persist generated keys so a restart does not invalidate every lease a
  // dev tablet has pinned. Never in the repository (the file is gitignored).
  if (devFile) {
    const store: Record<string, JWK[]> = existsSync(devFile)
      ? (JSON.parse(readFileSync(devFile, 'utf8')) as Record<string, JWK[]>)
      : {};
    if (!store[name]) {
      store[name] = [await generatePrivateJwk(devKid)];
      writeFileSync(devFile, JSON.stringify(store, null, 2), { mode: 0o600 });
    }
    return keyRingFromJwks(store[name]!);
  }
  return keyRingFromJwks([await generatePrivateJwk(devKid)]);
}

export async function identityFromEnv(
  env: Env,
  deps: { runner: TenantRunner; preTenant: PreTenantRunner; clock: HlcClock },
  devDefaults: { issuer: string; keysFile?: string } = { issuer: 'http://localhost:3001' },
): Promise<IdentityEnvResult> {
  const prod = isProduction(env);
  const devJwtSecret = env['DEV_JWT_SECRET'];
  if (prod && devJwtSecret !== undefined) {
    throw new Error('DEV_JWT_SECRET is set with NODE_ENV=production — the HS256 dev path must never reach production');
  }
  const issuer = env['ERP_TOKEN_ISSUER'] ?? (prod ? undefined : devDefaults.issuer);
  if (!issuer) throw new Error('ERP_TOKEN_ISSUER is required in production');
  const publicUrl = env['ERP_PUBLIC_URL'] ?? issuer;

  const keysFile = env['ERP_DEV_KEYS_FILE'] ?? devDefaults.keysFile;
  const signing = await loadRing(env, 'ERP_SIGNING_JWKS', keysFile, 'dev-signing-1');
  const leaseKeys = await loadRing(env, 'ERP_LEASE_JWKS', keysFile, 'dev-lease-1');
  if (signing.keys.some((k) => leaseKeys.keys.some((l) => l.kid === k.kid))) {
    throw new Error('ERP_LEASE_JWKS shares a kid with ERP_SIGNING_JWKS — the lease ring must be separate');
  }

  let oidc: { config: OidcConfig; verifier: ReturnType<typeof createIdTokenVerifier> } | undefined;
  const oidcIssuer = env['OIDC_ISSUER'];
  const clientId = env['OIDC_CLIENT_ID'];
  if (oidcIssuer && clientId) {
    const algs = (env['OIDC_ID_TOKEN_ALGS'] ?? DEFAULT_ID_TOKEN_ALGS.join(','))
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    const config: OidcConfig = {
      issuer: oidcIssuer,
      clientId,
      algorithms: algs,
      jwksUri: env['OIDC_JWKS_URI'],
      scope: env['OIDC_SCOPE'] ?? 'openid profile',
    };
    oidc = { config, verifier: createIdTokenVerifier(config) };
  } else if (prod) {
    throw new Error('OIDC_ISSUER and OIDC_CLIENT_ID are required in production');
  }

  const fullH = Number(env['LEASE_FULL_HOURS'] ?? 72);
  const graceH = Number(env['LEASE_GRACE_HOURS'] ?? 24);
  const policy = leasePolicy(Math.round(fullH * 3600), Math.round(graceH * 3600));

  const identity = createIdentityService({
    runner: deps.runner,
    preTenant: deps.preTenant,
    clock: deps.clock,
    issuer,
    signing,
    leaseKeys,
    leasePolicy: policy,
    oidc,
  });
  return { identity, devJwtSecret: prod ? undefined : devJwtSecret ?? 'dev-secret-change-me', publicUrl, issuer, oidcConfigured: oidc !== undefined };
}
