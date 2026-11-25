import { useEffect, useRef, useState } from 'react';
import type { LocalDb } from '../data/db';
import { readOutboxQueue } from '../data/queries/sales';
import { CONNECTING_GRACE_MS, SyncStatusMachine, type SyncUiState } from './sync-status';

const TICK_MS = 30_000;

function browserNetwork(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : false;
}

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
 *
 * The browser's own network signal is fed in both cases: with a connector it
 * is what tells "Connecting" (a network, the stream not up yet) from
 * "Offline" (no network, or the stream down past the grace). A timer fires at
 * the end of the grace so "Connecting" turns into "Offline" on time rather
 * than at the next slow tick.
 */
export function useSyncStatus(db: LocalDb): SyncUiState {
  const machineRef = useRef<SyncStatusMachine | null>(null);
  if (machineRef.current === null) {
    const now = Date.now();
    machineRef.current = new SyncStatusMachine({
      online: db.sync ? db.sync.connected : browserNetwork(),
      network: browserNetwork(),
      nowMs: now,
    });
  }
  const machine = machineRef.current;
  const [state, setState] = useState<SyncUiState>(machine.state);

  useEffect(() => {
    let alive = true;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const push = (next: SyncUiState): void => {
      if (!alive) return;
      setState(next);
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      if (next.kind === 'connecting') {
        // Re-derive just after the grace ends; a reconnect in the meantime
        // pushes a new state and clears this.
        graceTimer = setTimeout(() => {
          graceTimer = null;
          push(machine.apply({ type: 'tick', nowMs: Date.now() }));
        }, CONNECTING_GRACE_MS + 250);
      }
    };

    const cleanups: (() => void)[] = [];
    const source = db.sync;
    if (source !== undefined) {
      // Real connector status: the stream's connectivity and drain progress.
      push(machine.apply({ type: 'connectivity', online: source.connected, atMs: Date.now() }));
      cleanups.push(
        source.onConnectivity((online) =>
          push(machine.apply({ type: 'connectivity', online, atMs: Date.now() })),
        ),
      );
      cleanups.push(
        source.onProgress((progress) =>
          push(machine.apply({ type: 'progress', progress })),
        ),
      );
    }
    const onNetwork = (online: boolean) => (): void => {
      const at = Date.now();
      push(machine.apply({ type: 'network', online, atMs: at }));
      // Without a connector the browser's signal IS the connectivity.
      if (source === undefined) push(machine.apply({ type: 'connectivity', online, atMs: at }));
    };
    const onOnline = onNetwork(true);
    const onOffline = onNetwork(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    cleanups.push(() => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    });

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
      if (graceTimer !== null) clearTimeout(graceTimer);
      for (const cleanup of cleanups) cleanup();
    };
  }, [db, machine]);

  return state;
}
