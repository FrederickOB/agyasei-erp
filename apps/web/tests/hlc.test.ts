/**
 * The device's claimed HLC (§8.2 forensics-only clock assertion) and its
 * one exception: `refreshClaimedHlc`, the client half of the resync 03
 * §3.4.1 promises for a write whose claim has aged past the server's ±24h
 * tolerance while queued (sync-upload.test.ts exercises the settlement
 * path that calls it).
 */
import { describe, expect, it } from 'vitest';
import {
  CLAIMED_HLC_RE,
  createClaimedHlcClock,
  deviceNodeFromClaimedHlc,
  randomDeviceNode,
  refreshClaimedHlc,
} from '../src/lib/hlc';

describe('createClaimedHlcClock', () => {
  it('is monotonic within one wall millisecond', () => {
    const node = randomDeviceNode();
    const clock = createClaimedHlcClock(node, () => 1000);
    const a = clock.next();
    const b = clock.next();
    expect(a).not.toBe(b);
    expect(a < b).toBe(true);
  });

  it('produces a value matching the shared shape', () => {
    const clock = createClaimedHlcClock(randomDeviceNode());
    expect(CLAIMED_HLC_RE.test(clock.next())).toBe(true);
  });
});

describe('refreshClaimedHlc', () => {
  const node = 'ab'.repeat(16);
  const original = `1700000000000-00003-${node}`;

  it('carries the SAME device node forward', () => {
    const fresh = refreshClaimedHlc(original, () => 1_800_000_000_000);
    expect(deviceNodeFromClaimedHlc(fresh)).toBe(node);
  });

  it('produces a value matching the shared shape', () => {
    const fresh = refreshClaimedHlc(original, () => 1_800_000_000_000);
    expect(CLAIMED_HLC_RE.test(fresh)).toBe(true);
  });

  it('is a genuinely different value from the stale one it replaces', () => {
    const fresh = refreshClaimedHlc(original, () => 1_800_000_000_000);
    expect(fresh).not.toBe(original);
    // The whole point: the wall component moves to the new instant.
    expect(fresh.startsWith('1800000000000-')).toBe(true);
  });

  it('two calls a millisecond apart produce different wall components', () => {
    const a = refreshClaimedHlc(original, () => 1_800_000_000_000);
    const b = refreshClaimedHlc(original, () => 1_800_000_000_001);
    expect(a).not.toBe(b);
  });

  it('defaults to the real clock when no override is given', () => {
    const before = Date.now();
    const fresh = refreshClaimedHlc(original);
    const after = Date.now();
    const wall = Number(fresh.slice(0, 13));
    expect(wall).toBeGreaterThanOrEqual(before);
    expect(wall).toBeLessThanOrEqual(after);
  });
});
