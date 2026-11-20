/**
 * The two tokens this server mints (02 §2.2 "What the token carries").
 *
 * Two SEPARATE mints with different single-valued audiences — never one token
 * with `aud: ["erp-api","erp-sync"]`, which would make a token captured from
 * either surface work at both.
 *
 *   access token  aud erp-api   15 min   tid sub did sid jti cnf.jkt
 *   sync token    aud erp-sync   5 min   tid sub did     jti
 *
 * THIN. No permissions, no location scope, no role name, no tenant name: all
 * of it is resolved server-side per request, so revocation is a lookup rather
 * than a wait for a fat token to expire.
 *
 * The sync token carries no `cnf`: the sync service cannot check a DPoP proof.
 * It is bounded instead by its 5-minute life and — the control that actually
 * works — by the device-liveness term in EVERY sync parameter query (migration
 * 0024), keyed on the `did` and `sub` claims below.
 *
 * Verification pins the algorithm and the key ring: `none`, `HS*` and any
 * substitution are refused before a signature is checked, and an unknown
 * `kid` is a refusal (the ring is local; there is nothing to refetch).
 */
import { SignJWT, createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { SIGNING_ALG, type KeyRing } from './keys.js';

export const API_AUDIENCE = 'erp-api';
export const SYNC_AUDIENCE = 'erp-sync';
export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const SYNC_TOKEN_TTL_S = 5 * 60;
/** §2.2 step 2: iat not in the future beyond a 60-second skew allowance. */
export const CLOCK_SKEW_S = 60;

const zUuidStr = z.string().uuid();

export const accessClaimsSchema = z.object({
  tid: zUuidStr,
  sub: zUuidStr,
  did: zUuidStr,
  sid: zUuidStr,
  jti: zUuidStr,
  cnf: z.object({ jkt: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
});
export type AccessClaims = z.infer<typeof accessClaimsSchema>;

export interface MintedToken {
  readonly token: string;
  readonly expiresAtS: number;
}

export async function mintAccessToken(
  ring: KeyRing,
  issuer: string,
  claims: AccessClaims,
  opts: { nowS?: number; ttlS?: number } = {},
): Promise<MintedToken> {
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  const exp = now + (opts.ttlS ?? ACCESS_TOKEN_TTL_S);
  const token = await new SignJWT({ tid: claims.tid, did: claims.did, sid: claims.sid, cnf: claims.cnf })
    .setProtectedHeader({ alg: SIGNING_ALG, kid: ring.active.kid, typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(API_AUDIENCE)
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuedAt(now)
    .setNotBefore(now - 1)
    .setExpirationTime(exp)
    .sign(ring.active.privateKey);
  return { token, expiresAtS: exp };
}

export interface SyncClaims {
  readonly tid: string;
  readonly sub: string;
  readonly did: string;
  readonly jti: string;
}

export async function mintSyncToken(
  ring: KeyRing,
  issuer: string,
  claims: SyncClaims,
  opts: { nowS?: number; ttlS?: number } = {},
): Promise<MintedToken> {
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  const exp = now + (opts.ttlS ?? SYNC_TOKEN_TTL_S);
  const token = await new SignJWT({ tid: claims.tid, did: claims.did })
    .setProtectedHeader({ alg: SIGNING_ALG, kid: ring.active.kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(SYNC_AUDIENCE)
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(ring.active.privateKey);
  return { token, expiresAtS: exp };
}

export class TokenRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenRejected';
  }
}

/**
 * Verify an API access token. §2.2 steps 1 and 2: alg pinned, kid in the
 * ring, iss exact, aud exactly erp-api, exp/nbf, iat not in the future. The
 * DPoP and revocation steps (3 and 4) are the caller's — they need the request.
 */
export async function verifyAccessToken(
  ring: KeyRing,
  issuer: string,
  token: string,
  opts: { nowS?: number } = {},
): Promise<AccessClaims> {
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, createLocalJWKSet(ring.jwks()), {
      algorithms: [SIGNING_ALG],
      issuer,
      audience: API_AUDIENCE,
      typ: 'at+jwt',
      clockTolerance: CLOCK_SKEW_S,
      ...(opts.nowS !== undefined ? { currentDate: new Date(opts.nowS * 1000) } : {}),
    });
    payload = verified.payload;
  } catch (err) {
    throw new TokenRejected(`access token refused: ${err instanceof Error ? err.message : String(err)}`);
  }
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== 'number' || payload.iat > now + CLOCK_SKEW_S) {
    throw new TokenRejected('access token refused: iat is in the future');
  }
  const parsed = accessClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new TokenRejected('access token refused: claims are not the access-token shape');
  }
  return parsed.data;
}

/** True when a bearer string LOOKS like one of ours (ES256 header) — routing only, never trust. */
export function looksLikeDeviceToken(token: string): boolean {
  const head = token.split('.')[0];
  if (!head) return false;
  try {
    const json = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: unknown };
    return json.alg === SIGNING_ALG;
  } catch {
    return false;
  }
}
