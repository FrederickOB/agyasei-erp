/**
 * UUIDv7 — the client-generated idempotency key (§8.2, CLAUDE.md §2.2).
 *
 * The sale id IS the idempotency key: generated at cart creation, before the
 * first line is added, so every retry, double-tap and crash-and-resume writes
 * the same key. Server-side, `app.write_log` makes a replay a primary-key
 * conflict (per tenant), never a second sale.
 *
 * Time-ordered (48-bit unix milliseconds), version 7, RFC 4122 variant.
 * `now` and `rand` are injectable for tests only.
 */

function defaultRand(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return out;
}

export function uuidv7(
  now: () => number = Date.now,
  rand: (bytes: number) => Uint8Array = defaultRand,
): string {
  const ms = now();
  if (!Number.isInteger(ms) || ms < 0 || ms > 2 ** 48 - 1) {
    throw new Error(`uuidv7: clock value out of range: ${String(ms)}`);
  }
  const bytes = new Uint8Array(16);
  // 48-bit big-endian timestamp.
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  const r = rand(10);
  bytes.set(r, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'));
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
