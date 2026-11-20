/**
 * DPoP proofs (RFC 9449) from the device's non-extractable key — one per
 * request, bound to the method, the URL and (when present) the access token.
 * The server refuses a token without a fresh proof from the key it is bound
 * to, so a token copied off this tablet is worthless anywhere else (§2.2).
 */
import { randomB64url, sha256B64url, signEs256, type PublicEcJwk } from './webcrypto';

export interface DeviceKey {
  readonly privateKey: CryptoKey;
  readonly publicJwk: PublicEcJwk;
}

/** scheme://host/path — DPoP's htu carries no query and no fragment. */
export function htu(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

export async function createDpopProof(
  key: DeviceKey,
  method: string,
  url: string,
  accessToken?: string,
  nowMs: number = Date.now(),
): Promise<string> {
  return signEs256(
    key.privateKey,
    { typ: 'dpop+jwt', jwk: key.publicJwk },
    {
      htm: method.toUpperCase(),
      htu: htu(url),
      iat: Math.floor(nowMs / 1000),
      jti: randomB64url(16),
      ...(accessToken !== undefined ? { ath: await sha256B64url(accessToken) } : {}),
    },
  );
}
