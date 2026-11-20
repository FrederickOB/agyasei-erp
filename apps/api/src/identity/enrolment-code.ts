/**
 * Enrolment codes (02 §2.7): 8 characters of Crockford base32 — 32 symbols,
 * no I, L, O or U, case-insensitive — so 40 bits from a CSPRNG. Single use,
 * 15-minute TTL, bound to the tenant and (optionally) one location.
 *
 * Crockford's decoding is forgiving on purpose because a person reads the
 * code off one screen and types it into another: `O`→0, `I`/`L`→1, case and
 * hyphens ignored. Normalisation happens BEFORE hashing, so `abcd-efgh` and
 * `ABCDEFGH` are the same code.
 *
 * The code is never stored — only SHA-256(normalised code).
 */
import { createHash, randomInt } from 'node:crypto';

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ENROLMENT_CODE_LENGTH = 8;
export const ENROLMENT_CODE_TTL_S = 15 * 60;

/** A fresh code: 8 symbols, each drawn uniformly from the 32 by the CSPRNG. */
export function generateEnrolmentCode(): string {
  let out = '';
  for (let i = 0; i < ENROLMENT_CODE_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[randomInt(32)]!;
  }
  return out;
}

/** Normalise what a person typed. `null` if it cannot be a code at all. */
export function normaliseEnrolmentCode(typed: string): string | null {
  const cleaned = typed
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== ENROLMENT_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CROCKFORD_ALPHABET.includes(ch)) return null;
  return cleaned;
}

export function hashEnrolmentCode(normalised: string): Buffer {
  return createHash('sha256').update(`erp-enrolment-code:${normalised}`, 'utf8').digest();
}

/** Display form: `ABCD-EFGH`, easier to read aloud and transcribe. */
export function displayEnrolmentCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
