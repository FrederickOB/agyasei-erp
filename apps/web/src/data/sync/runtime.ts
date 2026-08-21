/**
 * The sync runtime: drives outbox drains and republishes connector status to
 * the UI (§8.4). It exists because the write path is the API, not the sync
 * service (03-offline-sync §3.3): synced tables are read-only on the device,
 * so PowerSync's own CRUD queue stays empty and PowerSync alone would never
 * call `uploadData`. The runtime drains:
 *
 *   - when a local write lands in the outbox (change bus),
 *   - when the connector comes up (`setConnected(true)`),
 *   - on a retry timer while anything is deferred or the transport failed.
 *
 * Drains are single-flight: one at a time, with a queued re-run when a write
 * arrives mid-drain. The drain function itself owns the never-complete-
 * without-ack discipline (upload.ts); the runtime only decides WHEN.
 *
 * It implements the `SyncStatusSource` seam in db.ts, which is what hooks the
 * four offline states to the ACTUAL connector status instead of
 * `navigator.onLine` guesswork.
 */
import type { SyncStatusSource } from '../db';
import type { DrainProgress, DrainReport } from './upload';

export interface SyncRuntimeOptions {
  /** One drain pass (see upload.ts drainOutbox); reports progress via the callback. */
  readonly drain: (onProgress: (p: DrainProgress | null) => void) => Promise<DrainReport>;
  /** Subscribe to local data changes (new outbox rows). Returns unsubscribe. */
  readonly subscribeChanges: (listener: () => void) => () => void;
  /** Delay before retrying a pass that left work behind. Default 30s. */
  readonly retryDelayMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 30_000;

export class SyncRuntime implements SyncStatusSource {
  private connectedFlag = false;
  private draining = false;
  private rerunRequested = false;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeChanges: (() => void) | null = null;
  private readonly progressListeners = new Set<(p: DrainProgress | null) => void>();
  private readonly connectivityListeners = new Set<(online: boolean) => void>();

  constructor(private readonly opts: SyncRuntimeOptions) {}

  get connected(): boolean {
    return this.connectedFlag;
  }

  /** Fed by the PowerSync client's status listener (powersync.ts). */
  setConnected(online: boolean): void {
    if (online === this.connectedFlag) return;
    this.connectedFlag = online;
    for (const listener of [...this.connectivityListeners]) listener(online);
    if (online && !this.stopped) void this.drainNow();
  }

  onConnectivity(listener: (online: boolean) => void): () => void {
    this.connectivityListeners.add(listener);
    return () => {
      this.connectivityListeners.delete(listener);
    };
  }

  onProgress(listener: (p: DrainProgress | null) => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribeChanges = this.opts.subscribeChanges(() => {
      if (!this.stopped) void this.drainNow();
    });
    void this.drainNow();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribeChanges?.();
    this.unsubscribeChanges = null;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Single-flight drain; a call during a drain queues exactly one re-run. */
  async drainNow(): Promise<void> {
    if (this.draining) {
      this.rerunRequested = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.rerunRequested = false;
        const report = await this.opts.drain((p) => this.emitProgress(p));
        if (!this.stopped && (report.deferred > 0 || !report.transportOk)) {
          this.scheduleRetry();
        }
        // `stopped` gates timers and subscriptions, not an explicit request:
        // a queued re-run always drains (the drain itself is safe anytime).
      } while (this.rerunRequested);
    } catch {
      // A drain failure (local db error) is retried like a transport failure.
      this.emitProgress(null);
      if (!this.stopped) this.scheduleRetry();
    } finally {
      this.draining = false;
    }
  }

  private emitProgress(p: DrainProgress | null): void {
    for (const listener of [...this.progressListeners]) listener(p);
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) void this.drainNow();
    }, this.opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  }
}
