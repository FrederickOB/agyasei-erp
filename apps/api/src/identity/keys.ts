/**
 * Signing key rings — one for API/sync tokens, a SEPARATE one for offline
 * leases (02 §2.7: "Lease signing keys are separate from the JWT signing keys
 * and rotate on a different schedule").
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ES256 (ECDSA P-256), not EdDSA — a recorded deviation from §2.2's "alg is
 * pinned to EdDSA". The reason is the DEVICE, not the server: the same curve
 * is used for the device's own DPoP key, and WebCrypto Ed25519 is not
 * available in the Chrome builds on the low-end Android tablets ADR-0003
 * targets, while P-256 has been in WebCrypto everywhere for a decade. One
 * curve on both sides means one verifier and one set of failure modes. The
 * security property §2.2 cares about — the verifier pins ONE algorithm and
 * refuses `none`, `HS*` and substitution before the signature is checked —
 * holds identically with ES256 pinned.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A ring is ordered: the FIRST key signs, every key verifies. Rotation is
 * "prepend the new key, keep the old one until every token it signed has
 * expired" (09 Rule 9.9-A: retirement lag > max TTL + 7 days). For the lease
 * ring the overlap is two keys and a year (§2.7).
 *
 * Keys come from the environment as a JWKS document of PRIVATE JWKs, each
 * with a `kid`. Nothing here ever reads a key from the repository; a missing
 * key in production is a refusal to start, not a generated fallback.
 */
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  type KeyLike,
} from 'jose';

export const SIGNING_ALG = 'ES256' as const;

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyLike;
  /** Public half only — `d` stripped. Safe to publish. */
  readonly publicJwk: JWK;
}

export interface KeyRing {
  /** The key new tokens are signed with. */
  readonly active: SigningKey;
  /** Every key that still VERIFIES, active first. */
  readonly keys: readonly SigningKey[];
  /** The public JWKS document — what `/.well-known/jwks.json` serves. */
  jwks(): { keys: JWK[] };
}

function publicOnly(jwk: JWK, kid: string): JWK {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, k: _k, ...rest } = jwk;
  void _d; void _p; void _q; void _dp; void _dq; void _qi; void _k;
  return { ...rest, kid, alg: SIGNING_ALG, use: 'sig' };
}

function ringOf(keys: SigningKey[]): KeyRing {
  const first = keys[0];
  if (!first) throw new Error('key ring: at least one signing key is required');
  const kids = new Set<string>();
  for (const k of keys) {
    if (kids.has(k.kid)) throw new Error(`key ring: duplicate kid ${k.kid}`);
    kids.add(k.kid);
  }
  return {
    active: first,
    keys,
    jwks: () => ({ keys: keys.map((k) => ({ ...k.publicJwk })) }),
  };
}

/**
 * Build a ring from PRIVATE JWKs (as provisioned in the secret store).
 * Refuses anything that is not an EC P-256 private key with a kid — an RSA
 * key, a symmetric `oct` key or a public-only key is a provisioning mistake
 * that must fail at boot, not at the first login.
 */
export async function keyRingFromJwks(privateJwks: readonly JWK[]): Promise<KeyRing> {
  const keys: SigningKey[] = [];
  for (const jwk of privateJwks) {
    if (typeof jwk.kid !== 'string' || jwk.kid.length === 0) {
      throw new Error('key ring: every key needs a kid');
    }
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') {
      throw new Error(`key ring: ${jwk.kid} is not an EC P-256 PRIVATE key (ES256 is pinned)`);
    }
    const privateKey = (await importJWK(jwk, SIGNING_ALG)) as KeyLike;
    keys.push({ kid: jwk.kid, privateKey, publicJwk: publicOnly(jwk, jwk.kid) });
  }
  return ringOf(keys);
}

/**
 * Parse the env form: a JSON JWKS document `{"keys":[…private JWKs…]}`.
 * The first key signs.
 */
export function parseJwksEnv(name: string, raw: string | undefined): JWK[] {
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error(`${name} is not set`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(`${name} must be a JWKS document with at least one key`);
  }
  return keys as JWK[];
}

/** A fresh, EPHEMERAL ring — tests and the local dev server only. */
export async function generateKeyRing(kid: string): Promise<KeyRing> {
  const { privateKey } = await generateKeyPair(SIGNING_ALG, { extractable: true });
  const jwk = await exportJWK(privateKey);
  return keyRingFromJwks([{ ...jwk, kid }]);
}

/** Export a ring's private JWKs — the dev server prints nothing; tests only. */
export async function generatePrivateJwk(kid: string): Promise<JWK> {
  const { privateKey } = await generateKeyPair(SIGNING_ALG, { extractable: true });
  return { ...(await exportJWK(privateKey)), kid };
}
