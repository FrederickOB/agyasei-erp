/**
 * The idempotency key (UUIDv7) and the claimed HLC — the two values every
 * outbox write carries (CLAUDE.md §2.2; server stamps the authoritative HLC
 * at ingest, the claim is untrusted).
 */
import { describe, expect, it } from 'vitest';
import { CLAIMED_HLC_RE, createClaimedHlcClock, randomDeviceNode } from '../src/lib/hlc';
import { UUID_RE, uuidv7 } from '../src/lib/uuidv7';

describe('uuidv7', () => {
  it('produces version-7, RFC-variant uuids', () => {
    for (let i = 0; i < 50; i++) {
      expect(uuidv7()).toMatch(UUID_RE);
    }
  });

  it('is time-ordered across increasing clock values', () => {
    const a = uuidv7(() => 1_000_000_000_000);
    const b = uuidv7(() => 1_000_000_000_001);
    expect(a < b).toBe(true);
  });

  it('does not collide across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(uuidv7());
    expect(seen.size).toBe(1000);
  });
});

describe('claimed HLC clock', () => {
  const NODE = 'cd'.repeat(16);

  it('matches the platform text projection', () => {
    const clock = createClaimedHlcClock(NODE, () => 1_755_000_000_000);
    const value = clock.next();
    expect(value).toMatch(CLAIMED_HLC_RE);
    expect(value.startsWith('1755000000000-00000-')).toBe(true);
    expect(value.endsWith(NODE)).toBe(true);
  });

  it('increments the counter within a frozen millisecond — never emits twice', () => {
    const clock = createClaimedHlcClock(NODE, () => 1_755_000_000_000);
    const first = clock.next();
    const second = clock.next();
    expect(second > first).toBe(true);
    expect(second.startsWith('1755000000000-00001-')).toBe(true);
  });

  it('stays monotonic when the wall clock goes backwards', () => {
    let t = 1_755_000_000_500;
    const clock = createClaimedHlcClock(NODE, () => t);
    const first = clock.next();
    t = 1_755_000_000_100; // device clock stepped back
    const second = clock.next();
    expect(second > first).toBe(true);
  });

  it('rejects a malformed node id', () => {
    expect(() => createClaimedHlcClock('short')).toThrow();
    expect(randomDeviceNode()).toMatch(/^[0-9a-f]{32}$/);
  });
});
