/**
 * WebCrypto, and only WebCrypto, for the device's own key (02-security §2.7).
 *
 * The device key is ECDSA P-256 — the curve WebCrypto has supported on every
 * Android Chrome for a decade, and the curve the server pins (ES256). Ed25519
 * would be §2.2's first choice; it is not available to WebCrypto in the
 * Chrome builds on the low-end tablets ADR-0003 targets, and that is the
 * recorded reason for the deviation (apps/api/src/identity/keys.ts).
 *
 * The private key is generated NON-EXTRACTABLE: no JavaScript — ours, a
 * dependency's, or an injected script's — can read its bytes. It can only be
 * asked to sign. The CryptoKey handle is persisted by structured clone in
 * IndexedDB (store.ts). Honest limit, stated in §2.7: this is not
 * hardware-backed on most low-end Android through a browser, and it does not
 * resist root plus offline access to the browser profile (Q-SEC-1).
 */

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlJson(value: unknown): string {
  return b64urlEncode(enc.encode(JSON.stringify(value)));
}

export function randomB64url(bytes = 16): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export interface PublicEcJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

/** A fresh device key pair. The private half is NON-EXTRACTABLE. */
export async function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
}

export async function exportPublicJwk(key: CryptoKey): Promise<PublicEcJwk> {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new Error('device key is not a P-256 EC key');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/** RFC 7638 thumbprint — the server binds tokens to this as `cnf.jkt`. */
export async function jwkThumbprint(jwk: PublicEcJwk): Promise<string> {
  // Required members, lexicographic order, no whitespace.
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64urlEncode(await crypto.subtle.digest('SHA-256', enc.encode(canonical)));
}

export async function sha256B64url(text: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/** A compact JWS, ES256. WebCrypto's ECDSA output is already r‖s (IEEE P1363), which is JWS's form. */
export async function signEs256(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const signingInput = `${b64urlJson({ ...header, alg: 'ES256' })}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(signingInput));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

export interface VerifiedJws {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}

/**
 * Verify an ES256 compact JWS against a set of public JWKs, selecting by
 * `kid`. Returns null — never throws — for anything that does not verify: an
 * unknown kid, a wrong alg, a bad signature. The caller decides what null
 * means (for a lease: keep the last lease that DID verify, §2.7).
 */
export async function verifyEs256(
  jws: string,
  keys: readonly Record<string, unknown>[],
): Promise<VerifiedJws | null> {
  const parts = jws.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h))) as Record<string, unknown>;
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header['alg'] !== 'ES256') return null; // pinned: never none, never HS*
  const jwk = keys.find((k) => k['kid'] === header['kid']);
  if (!jwk || jwk['kty'] !== 'EC' || jwk['crv'] !== 'P-256') return null;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: String(jwk['x']), y: String(jwk['y']), ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlDecode(s), enc.encode(`${h}.${p}`));
    return ok ? { header, payload } : null;
  } catch {
    return null;
  }
}
