/**
 * The sync runtime: WHEN drains happen. Single-flight, drain on start / on
 * local change / on reconnect, retry while work is left behind, and the
 * §8.4 status feed (connectivity + progress) for the UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncRuntime } from '../src/data/sync/runtime';
import type { DrainReport } from '../src/data/sync/upload';

function report(overrides: Partial<DrainReport> = {}): DrainReport {
  return {
    batchSize: 0,
    completed: 0,
    rejected: 0,
    deferred: 0,
    deferredReasons: [],
    transportOk: true,
    ...overrides,
  };
}

interface Harness {
  runtime: SyncRuntime;
  drains: number;
  fireChange: () => void;
}

function harness(reports: DrainReport[], retryDelayMs = 1_000): Harness {
  const listeners: (() => void)[] = [];
  const h: Harness = {
    drains: 0,
    fireChange: () => {
      for (const l of listeners) l();
    },
    runtime: null as unknown as SyncRuntime,
  };
  h.runtime = new SyncRuntime({
    drain: (onProgress) => {
      h.drains += 1;
      onProgress(null);
      return Promise.resolve(reports.shift() ?? report());
    },
    subscribeChanges: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    retryDelayMs,
  });
  return h;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SyncRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains on start and again when a local write lands', async () => {
    const h = harness([]);
    h.runtime.start();
    await flush();
    expect(h.drains).toBe(1);

    h.fireChange();
    await flush();
    expect(h.drains).toBe(2);
    h.runtime.stop();
  });

  it('coming online drains immediately and notifies connectivity listeners', async () => {
    const h = harness([]);
    const seen: boolean[] = [];
    h.runtime.onConnectivity((online) => seen.push(online));
    h.runtime.start();
    await flush();

    h.runtime.setConnected(true);
    await flush();

    expect(h.runtime.connected).toBe(true);
    expect(seen).toEqual([true]);
    expect(h.drains).toBe(2);
    h.runtime.stop();
  });

  it('retries after the delay while work was left behind, and stops retrying once clean', async () => {
    const h = harness([report({ batchSize: 1, deferred: 1 }), report()]);
    h.runtime.start();
    await flush();
    expect(h.drains).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.drains).toBe(2); // retry fired

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.drains).toBe(2); // clean pass scheduled nothing further
    h.runtime.stop();
  });

  it('a transport failure also schedules a retry', async () => {
    const h = harness([report({ batchSize: 2, deferred: 2, transportOk: false }), report()]);
    h.runtime.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.drains).toBe(2);
    h.runtime.stop();
  });

  it('drains are single-flight: a request mid-drain queues exactly one re-run', async () => {
    let release: (() => void) | null = null;
    let drains = 0;
    const runtime = new SyncRuntime({
      drain: () => {
        drains += 1;
        return new Promise<DrainReport>((resolve) => {
          release = () => resolve(report());
        });
      },
      subscribeChanges: () => () => undefined,
      retryDelayMs: 1_000,
    });

    const first = runtime.drainNow();
    void runtime.drainNow();
    void runtime.drainNow(); // collapses into ONE queued re-run
    expect(drains).toBe(1);

    (release as unknown as () => void)();
    await flush();
    // The queued re-run started; release it too.
    expect(drains).toBe(2);
    (release as unknown as () => void)();
    await first;
    runtime.stop();
  });

  it('stop() silences the retry timer', async () => {
    const h = harness([report({ deferred: 1, batchSize: 1 })]);
    h.runtime.start();
    await flush();
    h.runtime.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.drains).toBe(1);
  });
});
