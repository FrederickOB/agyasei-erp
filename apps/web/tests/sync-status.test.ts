/**
 * The offline states (§8.4): transition coverage for the explicit state
 * machine, and the calm-wording contract — offline is never presented as an
 * error, and "stuck" can only be entered while connectivity is present.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTING_GRACE_MS,
  DEFAULT_STUCK_THRESHOLD_MS,
  SyncStatusMachine,
  deriveSyncUiState,
  statusLine,
  type SyncUiState,
} from '../src/state/sync-status';

const T0 = Date.parse('2026-08-21T09:12:00.000Z');
const MIN = 60_000;

describe('deriveSyncUiState', () => {
  it('offline with a queue is OFFLINE — calm, not stuck, however old the queue', () => {
    const state = deriveSyncUiState({
      online: false,
      pendingCount: 14,
      oldestQueuedAtMs: T0 - 10 * 60 * MIN, // ten hours old
      nowMs: T0,
      progress: null,
    });
    expect(state).toEqual({ kind: 'offline', pendingCount: 14 });
  });

  it('online with an empty queue is caught up', () => {
    const state = deriveSyncUiState({
      online: true,
      pendingCount: 0,
      oldestQueuedAtMs: null,
      nowMs: T0,
      progress: null,
    });
    expect(state.kind).toBe('online_synced');
  });

  it('online with a fresh queue is syncing', () => {
    const state = deriveSyncUiState({
      online: true,
      pendingCount: 14,
      oldestQueuedAtMs: T0 - MIN,
      nowMs: T0,
      progress: { sentCount: 9, batchSize: 14 },
    });
    expect(state.kind).toBe('syncing');
  });

  it('online with the oldest write past the threshold is STUCK', () => {
    const state = deriveSyncUiState({
      online: true,
      pendingCount: 14,
      oldestQueuedAtMs: T0 - DEFAULT_STUCK_THRESHOLD_MS,
      nowMs: T0,
      progress: null,
    });
    expect(state.kind).toBe('stuck');
  });

  it('just under the threshold is still syncing, not stuck', () => {
    const state = deriveSyncUiState({
      online: true,
      pendingCount: 3,
      oldestQueuedAtMs: T0 - DEFAULT_STUCK_THRESHOLD_MS + 1,
      nowMs: T0,
      progress: null,
    });
    expect(state.kind).toBe('syncing');
  });
});

describe('SyncStatusMachine transitions', () => {
  it('walks offline -> reconnect -> sending -> caught up', () => {
    const m = new SyncStatusMachine({ nowMs: T0 });
    expect(m.apply({ type: 'connectivity', online: false }).kind).toBe('offline');
    expect(m.apply({ type: 'queue', pendingCount: 14, oldestQueuedAtMs: T0 - MIN }).kind).toBe(
      'offline',
    );
    expect(m.apply({ type: 'connectivity', online: true }).kind).toBe('syncing');
    m.apply({ type: 'progress', progress: { sentCount: 9, batchSize: 14 } });
    expect(m.state.kind).toBe('syncing');
    expect(m.apply({ type: 'queue', pendingCount: 0, oldestQueuedAtMs: null }).kind).toBe(
      'online_synced',
    );
  });

  it('becomes stuck only by AGEING while online, and calms back to offline on disconnect', () => {
    const m = new SyncStatusMachine({ nowMs: T0 });
    m.apply({ type: 'connectivity', online: true });
    m.apply({ type: 'queue', pendingCount: 5, oldestQueuedAtMs: T0 });
    expect(m.state.kind).toBe('syncing');
    // Time passes with connectivity present and nothing draining.
    expect(m.apply({ type: 'tick', nowMs: T0 + DEFAULT_STUCK_THRESHOLD_MS + MIN }).kind).toBe(
      'stuck',
    );
    // Losing connectivity is NOT an escalation: back to calm offline.
    expect(m.apply({ type: 'connectivity', online: false }).kind).toBe('offline');
  });
});

describe('Connecting — a network, the stream not up yet', () => {
  // What the founder saw: full signal, "Offline" on the bar, for as long as a
  // sleeping API took to wake. The stream's flag alone cannot tell "no
  // network" from "reconnecting"; the browser's network signal can.
  it('down with a network and inside the grace is CONNECTING; past it, or with no network, OFFLINE', () => {
    const base = { online: false, pendingCount: 2, oldestQueuedAtMs: T0, progress: null };
    expect(deriveSyncUiState({ ...base, network: true, downSinceMs: T0, nowMs: T0 + 30_000 })).toEqual({
      kind: 'connecting',
      pendingCount: 2,
    });
    expect(deriveSyncUiState({ ...base, network: true, downSinceMs: T0, nowMs: T0 + CONNECTING_GRACE_MS }).kind).toBe(
      'offline',
    );
    expect(deriveSyncUiState({ ...base, network: false, downSinceMs: T0, nowMs: T0 + 1 }).kind).toBe('offline');
  });

  it('the app opening with a network says connecting, then connected — never offline in between', () => {
    const m = new SyncStatusMachine({ online: false, network: true, nowMs: T0 });
    expect(m.state.kind).toBe('connecting');
    // The API was asleep: 30 s later the stream comes up.
    expect(m.apply({ type: 'tick', nowMs: T0 + 30_000 }).kind).toBe('connecting');
    expect(m.apply({ type: 'connectivity', online: true, atMs: T0 + 31_000 }).kind).toBe('online_synced');
  });

  it('a stream that drops while the tablet has signal is connecting, not offline — until the grace runs out', () => {
    const m = new SyncStatusMachine({ online: true, network: true, nowMs: T0 });
    expect(m.state.kind).toBe('online_synced');
    expect(m.apply({ type: 'connectivity', online: false, atMs: T0 + MIN }).kind).toBe('connecting');
    expect(m.apply({ type: 'tick', nowMs: T0 + MIN + CONNECTING_GRACE_MS - 1 }).kind).toBe('connecting');
    expect(m.apply({ type: 'tick', nowMs: T0 + MIN + CONNECTING_GRACE_MS }).kind).toBe('offline');
  });

  it('losing the network is offline at once; its return opens a fresh reconnect window', () => {
    const m = new SyncStatusMachine({ online: false, network: true, nowMs: T0 });
    expect(m.apply({ type: 'network', online: false, atMs: T0 + 1_000 }).kind).toBe('offline');
    // Long after the first window would have closed, the radio comes back.
    expect(m.apply({ type: 'network', online: true, atMs: T0 + 10 * MIN }).kind).toBe('connecting');
    expect(m.apply({ type: 'tick', nowMs: T0 + 10 * MIN + CONNECTING_GRACE_MS }).kind).toBe('offline');
  });

  it('is never stuck: a queue only ages into stuck while the stream is up', () => {
    const m = new SyncStatusMachine({ online: false, network: true, nowMs: T0 });
    m.apply({ type: 'queue', pendingCount: 3, oldestQueuedAtMs: T0 - DEFAULT_STUCK_THRESHOLD_MS * 2 });
    expect(m.state.kind).toBe('connecting');
  });
});

describe('statusLine wording', () => {
  const clock = (): string => '09:12';

  it('matches the §8.4 table', () => {
    expect(statusLine({ kind: 'online_synced' })).toBe('Online · all saved');
    expect(statusLine({ kind: 'offline', pendingCount: 14 })).toBe('Offline · 14 records waiting');
    expect(statusLine({ kind: 'connecting', pendingCount: 0 })).toBe('Connecting · nothing waiting');
    expect(statusLine({ kind: 'connecting', pendingCount: 1 })).toBe('Connecting · 1 record waiting');
    expect(
      statusLine({
        kind: 'syncing',
        pendingCount: 14,
        progress: { sentCount: 9, batchSize: 14 },
      }),
    ).toBe('Sending · 9 of 14');
    expect(
      statusLine(
        { kind: 'stuck', pendingCount: 14, oldestQueuedAtMs: T0 },
        { formatClock: clock },
      ),
    ).toBe('Not sending · 14 records waiting since 09:12 — tell your manager');
  });

  it('uses honest local-only wording when no sync endpoint is configured', () => {
    expect(statusLine({ kind: 'offline', pendingCount: 3 }, { localOnly: true })).toBe(
      'Local only · 3 records saved on this device',
    );
    expect(statusLine({ kind: 'online_synced' }, { localOnly: true })).toBe(
      'Local only · all saved on this device',
    );
  });

  it('does not call every queued write a sale — the outbox holds all of them', () => {
    // `readOutboxQueue` counts the WHOLE outbox with no filter on kind: stock
    // adjustments, goods receipts, delivery updates, credit entries and
    // sequence-block reports all queue beside sales. This line used to name
    // them all "sale", so a wedged stock adjustment read "1 sale waiting" and
    // sent whoever escalated it hunting for a sale that did not exist.
    const lines = [
      statusLine({ kind: 'offline', pendingCount: 1 }),
      statusLine({ kind: 'stuck', pendingCount: 1, oldestQueuedAtMs: T0 }, { formatClock: clock }),
      statusLine({ kind: 'offline', pendingCount: 4 }, { localOnly: true }),
    ];
    for (const line of lines) expect(line).not.toMatch(/\bsales?\b/);
    expect(lines[0]).toBe('Offline · 1 record waiting');
  });

  it('never contains alarm words: offline is a state, not an error', () => {
    const states: SyncUiState[] = [
      { kind: 'online_synced' },
      { kind: 'offline', pendingCount: 7 },
      { kind: 'syncing', pendingCount: 7, progress: null },
      { kind: 'stuck', pendingCount: 7, oldestQueuedAtMs: T0 },
    ];
    for (const state of states) {
      for (const localOnly of [true, false]) {
        const line = statusLine(state, { formatClock: clock, localOnly });
        expect(line.toLowerCase()).not.toContain('error');
        expect(line.toLowerCase()).not.toContain('fail');
        expect(line.toLowerCase()).not.toContain('warning');
      }
    }
  });
});
