import { describe, expect, it } from 'vitest';
import { deriveRecordSyncState, recordBadgeLabel } from '../src/lib/badges';
import { formatQtyScaled, oneWholeUnit } from '../src/lib/quantity';

describe('per-record sync state (§8.5) — derived from data, not a client flag', () => {
  it('pending until the server acks', () => {
    expect(deriveRecordSyncState({ server_ack_at: null, rejected_at: null })).toBe('pending');
  });
  it('synced once acked', () => {
    expect(
      deriveRecordSyncState({ server_ack_at: '2026-08-21T09:06:00Z', rejected_at: null }),
    ).toBe('synced');
  });
  it('attention wins over everything — a rejected write is work, not history', () => {
    expect(
      deriveRecordSyncState({
        server_ack_at: '2026-08-21T09:06:00Z',
        rejected_at: '2026-08-21T09:07:00Z',
      }),
    ).toBe('attention');
  });
  it('labels are the three glanceable phrases', () => {
    expect(recordBadgeLabel('pending')).toBe('Waiting to send');
    expect(recordBadgeLabel('synced')).toBe('Saved');
    expect(recordBadgeLabel('attention')).toBe('Needs checking');
  });
});

describe('scaled quantities (ADR-0004, §8.3)', () => {
  it('one whole unit respects the unit scale', () => {
    expect(oneWholeUnit(0)).toBe(1n);
    expect(oneWholeUnit(3)).toBe(1000n);
  });
  it('formats exactly with trailing zeros trimmed — display only', () => {
    expect(formatQtyScaled(2500n, 3)).toBe('2.5');
    expect(formatQtyScaled(2000n, 3)).toBe('2');
    expect(formatQtyScaled(25n, 1)).toBe('2.5');
    expect(formatQtyScaled(7n, 0)).toBe('7');
    expect(formatQtyScaled(1n, 3)).toBe('0.001');
  });
  it('rejects scales outside the platform range', () => {
    expect(() => oneWholeUnit(7)).toThrow();
    expect(() => oneWholeUnit(-1)).toThrow();
    expect(() => formatQtyScaled(1n, 1.5)).toThrow();
  });
});
