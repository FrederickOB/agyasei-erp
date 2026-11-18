/**
 * DPoP proof-of-possession (RFC 9449), §2.2 verification step 3.
 *
 * Every request from an enrolled device carries a fresh proof JWT signed by
 * the device's NON-EXTRACTABLE P-256 key (§2.7 enrolment). Its JWK thumbprint
 * must equal the access token's `cnf.jkt`. Without this the token is a pure
 * bearer credential and `did` is an assertion ABOUT a device rather than proof
 * of one; with it, a token lifted off a tablet is useless anywhere else.
 *
 * The same proof is what authenticates a device when it has no token at all —
 * enrolment (proving it holds the key it is registering), sign-in and refresh
 * (proving it is the enrolled device the platform route names). The key is the
 * credential; the thumbprint is how the server finds the tenant (0023).
 *
 * Checked, failing closed at each step:
 *   typ = dpop+jwt · alg pinned ES256 · embedded jwk is a PUBLIC EC P-256 key
 *   · signature · htm = the request method · htu = the request URL (no query,
 *   no fragment) · iat within ±60 s · jti unseen in the window · and, when an
 *   access token accompanies it, ath = base64url(SHA-256(token)).
 */
import { createHash } from 'node:crypto';
import { EmbeddedJWK, calculateJwkThumbprint, jwtVerify, type JWK } from 'jose';
import { SIGNING_ALG } from './keys.js';

export const DPOP_MAX_AGE_S = 60;

export class DpopRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DpopRejected';
  }
}

/** Remembers proof `jti`s for the acceptance window. Per process. */
export interface ReplayCache {
  /** True if `key` was unseen (and is now recorded); false on a replay. */
  claim(key: string, expiresAtMs: number): boolean;
}

export function createReplayCache(maxEntries = 100_000): ReplayCache {
  const seen = new Map<string, number>();
  return {
    claim(key, expiresAtMs) {
      const now = Date.now();
      if (seen.size >= maxEntries) {
        for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
        // Still full of live entries: refuse rather than forget — a cache
        // that evicts live jtis under load is a replay window under load.
        if (seen.size >= maxEntries) return false;
      }
      const prior = seen.get(key);
      if (prior !== undefined && prior > now) return false;
      seen.set(key, expiresAtMs);
      return true;
    },
  };
}

export interface DpopCheck {
  readonly method: string;
  /** The absolute URL the client called, without query or fragment. */
  readonly url: string;
  /** When present, the proof must carry ath = SHA-256 of this token. */
  readonly accessToken?: string | undefined;
  readonly replay: ReplayCache;
  readonly nowS?: number;
}

export interface VerifiedProof {
  readonly jkt: string;
  readonly jwk: JWK;
}

export function accessTokenHash(token: string): string {
  return createHash('sha256').update(token, 'ascii').digest('base64url');
}

/** Normalise a URL for htu comparison: scheme+host+path, no query/fragment. */
export function htuOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

export async function verifyDpopProof(proof: string, check: DpopCheck): Promise<VerifiedProof> {
  let header: { jwk?: JWK; typ?: string };
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(proof, EmbeddedJWK, {
      algorithms: [SIGNING_ALG],
      typ: 'dpop+jwt',
    });
    header = verified.protectedHeader as { jwk?: JWK; typ?: string };
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    throw new DpopRejected(`DPoP proof refused: ${err instanceof Error ? err.message : String(err)}`);
  }
  const jwk = header.jwk;
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || 'd' in jwk) {
    throw new DpopRejected('DPoP proof refused: the embedded key is not a public P-256 key');
  }

  if (payload['htm'] !== check.method.toUpperCase()) {
    throw new DpopRejected('DPoP proof refused: htm does not match the request method');
  }
  let htu: string;
  try {
    htu = htuOf(String(payload['htu']));
  } catch {
    throw new DpopRejected('DPoP proof refused: htu is not a URL');
  }
  if (htu !== htuOf(check.url)) {
    throw new DpopRejected('DPoP proof refused: htu does not match the request URL');
  }

  const now = check.nowS ?? Math.floor(Date.now() / 1000);
  const iat = payload['iat'];
  if (typeof iat !== 'number' || Math.abs(now - iat) > DPOP_MAX_AGE_S) {
    throw new DpopRejected('DPoP proof refused: iat is outside the acceptance window');
  }

  if (check.accessToken !== undefined) {
    if (payload['ath'] !== accessTokenHash(check.accessToken)) {
      throw new DpopRejected('DPoP proof refused: ath does not bind this access token');
    }
  }

  const jti = payload['jti'];
  if (typeof jti !== 'string' || jti.length < 16 || jti.length > 128) {
    throw new DpopRejected('DPoP proof refused: jti missing or malformed');
  }
  const jkt = await calculateJwkThumbprint(jwk, 'sha256');
  if (!check.replay.claim(`${jkt}:${jti}`, (iat + DPOP_MAX_AGE_S * 2) * 1000)) {
    throw new DpopRejected('DPoP proof refused: replayed jti');
  }
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new DpopRejected('DPoP proof refused: the embedded key has no coordinates');
  }
  return { jkt, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}
