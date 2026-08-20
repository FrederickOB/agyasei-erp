/**
 * Hybrid logical clock — the text projection defined in 04-data-model §4.2.1:
 * 13-digit wall milliseconds, 5-digit counter, full 32-hex node, so that
 * lexicographic byte order IS causal order.
 *
 * The wall/counter components are SERVER-STAMPED at ingest; a device's own
 * assertion is stored separately as write_log.claimed_hlc and is untrusted.
 * This module is the server-side stamper (also used by the seed machinery,
 * whose writes are origin='SERVER').
 */
import { createHash, randomBytes } from 'node:crypto';

export const HLC_RE = /^[0-9]{13}-[0-9]{5}-[0-9a-f]{32}$/;

/** Derive a stable 32-hex node id from a name (e.g. 'template-applier'). */
export function hlcNodeFromName(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 32);
}

/** A random node id, for tests. */
export function randomHlcNode(): string {
  return randomBytes(16).toString('hex');
}

export interface HlcClock {
  next(): string;
}

/**
 * A monotonic HLC stamper for one node. Never emits the same value twice:
 * within one wall millisecond the 5-digit counter increments.
 */
export function createHlcClock(node32hex: string, now: () => number = Date.now): HlcClock {
  if (!/^[0-9a-f]{32}$/.test(node32hex)) {
    throw new Error(`HLC node must be 32 lowercase hex chars, got: ${node32hex}`);
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
          // 100k events in one clock-frozen millisecond: step the wall component.
          lastWall += 1;
          counter = 0;
        }
      }
      const wallPart = String(lastWall).padStart(13, '0');
      const counterPart = String(counter).padStart(5, '0');
      const hlc = `${wallPart}-${counterPart}-${node32hex}`;
      if (!HLC_RE.test(hlc)) {
        throw new Error(`generated HLC failed its own shape check: ${hlc}`);
      }
      return hlc;
    },
  };
}
