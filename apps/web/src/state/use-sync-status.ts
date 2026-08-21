import { useEffect, useRef, useState } from 'react';
import type { LocalDb } from '../data/db';
import { readOutboxQueue } from '../data/queries/sales';
import { SyncStatusMachine, type SyncUiState } from './sync-status';

const TICK_MS = 30_000;

/**
 * Wires the §8.4 state machine to the world: connectivity, the outbox queue
 * (via the change bus), and a slow clock tick so a queue that stops draining
 * eventually gets called stuck in so many words.
 *
 * Connectivity and upload progress come from the ACTUAL connector status
 * (`db.sync`, present when a sync stack is configured): the PowerSync
 * stream's connected flag and the outbox drain's "sending x of y". In
 * local-only mode — and in the node test adapter — there is no connector, so
 * browser connectivity events are the honest fallback.
 */
export function useSyncStatus(db: LocalDb): SyncUiState {
  const machineRef = useRef<SyncStatusMachine | null>(null);
  if (machineRef.current === null) {
    machineRef.current = new SyncStatusMachine({
      online: db.sync
        ? db.sync.connected
        : typeof navigator !== 'undefined'
          ? navigator.onLine
          : false,
      nowMs: Date.now(),
    });
  }
  const machine = machineRef.current;
  const [state, setState] = useState<SyncUiState>(machine.state);

  useEffect(() => {
    let alive = true;
    const push = (next: SyncUiState): void => {
      if (alive) setState(next);
    };

    const cleanups: (() => void)[] = [];
    const source = db.sync;
    if (source !== undefined) {
      // Real connector status: the stream's connectivity and drain progress.
      push(machine.apply({ type: 'connectivity', online: source.connected }));
      cleanups.push(
        source.onConnectivity((online) =>
          push(machine.apply({ type: 'connectivity', online })),
        ),
      );
      cleanups.push(
        source.onProgress((progress) =>
          push(machine.apply({ type: 'progress', progress })),
        ),
      );
    } else {
      const onOnline = (): void => push(machine.apply({ type: 'connectivity', online: true }));
      const onOffline = (): void => push(machine.apply({ type: 'connectivity', online: false }));
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      cleanups.push(() => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      });
    }

    const readQueue = (): void => {
      void readOutboxQueue(db).then((queue) => {
        machine.apply({ type: 'tick', nowMs: Date.now() });
        push(
          machine.apply({
            type: 'queue',
            pendingCount: queue.pendingCount,
            oldestQueuedAtMs: queue.oldestQueuedAtMs,
          }),
        );
      });
    };
    readQueue();
    cleanups.push(db.changes.subscribe(readQueue));
    const interval = setInterval(() => {
      push(machine.apply({ type: 'tick', nowMs: Date.now() }));
    }, TICK_MS);
    cleanups.push(() => clearInterval(interval));

    return () => {
      alive = false;
      for (const cleanup of cleanups) cleanup();
    };
  }, [db, machine]);

  return state;
}
