/**
 * The device's CLAIMED hybrid logical clock.
 *
 * Architecture ruling: the server stamps the authoritative HLC at ingest; the
 * client's clock value is stored as `write_log.claimed_hlc` and is UNTRUSTED —
 * forensics, never ordering. This module produces that claimed value, in the
 * same text projection as the server (04-data-model §4.2.1, packages/db
 * src/hlc.ts): 13-digit wall milliseconds, 5-digit counter, 32-hex node id, so
 * lexicographic byte order is causal order for well-behaved clocks.
 *
 * Monotonic per device: within one wall millisecond (or when the wall clock
 * moves backwards — these devices' clocks drift) the counter increments.
 */

export const CLAIMED_HLC_RE = /^[0-9]{13}-[0-9]{5}-[0-9a-f]{32}$/;

export interface ClaimedHlcClock {
  next(): string;
}

/** A random 32-hex device node id. Persisted once per device in local_config. */
export function randomDeviceNode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function createClaimedHlcClock(
  node32hex: string,
  now: () => number = Date.now,
): ClaimedHlcClock {
  if (!/^[0-9a-f]{32}$/.test(node32hex)) {
    throw new Error(`claimed HLC node must be 32 lowercase hex chars, got: ${node32hex}`);
  }
  let lastWall = 0;
  let counter = 0;
  return {
    next(): string {
      const wall = now();
      if (wall > lastWall) {
        lastWall = wall;
        counter = 0;
      } else {
        counter += 1;
        if (counter > 99_999) {
          lastWall += 1;
          counter = 0;
        }
      }
      const value = `${String(lastWall).padStart(13, '0')}-${String(counter).padStart(5, '0')}-${node32hex}`;
      if (!CLAIMED_HLC_RE.test(value)) {
        throw new Error(`claimed HLC failed its own shape check: ${value}`);
      }
      return value;
    },
  };
}
