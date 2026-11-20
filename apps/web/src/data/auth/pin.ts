/**
 * The per-user PIN and the per-user, per-device key it unwraps (02 §2.7).
 *
 * A counter tablet is SHARED, so users authenticate individually: once online
 * through the IdP, and from then on with a 6-digit PIN that unlocks THIS
 * user's key on THIS device. The PIN never leaves the device and is never a
 * server credential.
 *
 *   PIN ──Argon2id(salt, m=64 MiB, t=3, p=1)──► KEK (AES-256-GCM, in memory)
 *   KEK ──unwraps──► the user's data key (random 256-bit, per user per device)
 *   data key ──decrypts──► the user's refresh credential (and, when §2.7's
 *                          field-level encryption lands, the sensitive set)
 *
 * THE PIN, HONESTLY (§2.7): against the adversary the design names — root plus
 * the browser profile — the attempt cap is an app counter in storage the
 * attacker owns. What stands between them and the key is the KDF: at these
 * parameters roughly 300–500 ms per guess on the low-end Android class and
 * hours to a couple of days of offline work for all 10^6 PINs on a GPU. A
 * delay, not a barrier — sized to the lease window, after which the server
 * credential this key protects is dead anyway.
 *
 * THE PARAMETERS ARE NOT LOWERED HERE. If 64 MiB proves too heavy for the
 * reference tablet (§8.10's 2 GB envelope) that is a finding for the hardware
 * survey (Q-SEC-1), and the answer is a decision recorded in §2.7 — not a
 * quieter constant in this file. `pin.test.ts` pins them.
 *
 * Failed unlocks SEAL the user's local unlock after MAX_PIN_ATTEMPTS (an
 * online IdP sign-in reopens it). They never wipe anything: "a staff member
 * with fat fingers must not be able to destroy the day's takings."
 */
import { argon2id } from 'hash-wasm';
import { b64urlDecode, b64urlEncode } from './webcrypto';

export const ARGON2_PARAMS = Object.freeze({
  /** KiB. 64 MiB. */
  memorySize: 64 * 1024,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
});

export const PIN_LENGTH = 6;
export const MAX_PIN_ATTEMPTS = 5;

/** The KDF seam, so a unit test can swap the 64 MiB derivation for a cheap one. */
export type PinKdf = (pin: string, salt: Uint8Array) => Promise<Uint8Array>;

export const argon2idKdf: PinKdf = async (pin, salt) =>
  argon2id({
    password: pin,
    salt,
    ...ARGON2_PARAMS,
    outputType: 'binary',
  });

export function isValidPin(pin: string): boolean {
  return new RegExp(`^[0-9]{${PIN_LENGTH}}$`).test(pin);
}

/** What is stored per user on the device. Never the PIN, never the KEK. */
export interface WrappedUserKey {
  readonly salt: string;
  /** iv + AES-GCM(KEK, data key) */
  readonly wrapped: string;
}

async function kekFrom(kdf: PinKdf, pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = new Uint8Array(await kdf(pin, salt));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** First time on this device for this user: a fresh data key, wrapped under the PIN. */
export async function createUserKey(
  pin: string,
  kdf: PinKdf = argon2idKdf,
): Promise<{ record: WrappedUserKey; dataKey: CryptoKey }> {
  if (!isValidPin(pin)) throw new Error(`a PIN is ${PIN_LENGTH} digits`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const kek = await kekFrom(kdf, pin, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw));
  const dataKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  raw.fill(0);
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return { record: { salt: b64urlEncode(salt), wrapped: b64urlEncode(packed) }, dataKey };
}

/** Unwrap with a PIN. Null for a wrong PIN — AES-GCM's tag is the check. */
export async function unwrapUserKey(
  record: WrappedUserKey,
  pin: string,
  kdf: PinKdf = argon2idKdf,
): Promise<CryptoKey | null> {
  if (!isValidPin(pin)) return null;
  const kek = await kekFrom(kdf, pin, b64urlDecode(record.salt));
  const packed = b64urlDecode(record.wrapped);
  try {
    const raw = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, kek, packed.slice(12)),
    );
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    raw.fill(0);
    return key;
  } catch {
    return null;
  }
}

export async function sealText(dataKey: CryptoKey, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dataKey, new TextEncoder().encode(text)));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return b64urlEncode(packed);
}

export async function openText(dataKey: CryptoKey, sealed: string): Promise<string | null> {
  const packed = b64urlDecode(sealed);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, dataKey, packed.slice(12));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
