/**
 * The thin database seam. All SQL in the app lives under `src/data/` (§8.3) —
 * components never see SQL or raw rows, and there is exactly one place where
 * the CAST-AS-TEXT money discipline can fail and exactly one place to test it.
 *
 * Two implementations:
 * - `src/data/powersync.ts` — the device: PowerSync-managed SQLite (wasm/OPFS),
 * - `tests/helpers/node-db.ts` — real SQLite via node:sqlite for tests,
 * both over the same schema definition in `schema.ts`.
 */

export type SqlValue = string | number | null;

export interface DbRow {
  readonly [column: string]: SqlValue;
}

export interface DbExecutor {
  execute(sql: string, params?: readonly SqlValue[]): Promise<void>;
  getAll(sql: string, params?: readonly SqlValue[]): Promise<DbRow[]>;
}

/** Upload progress snapshot for the status bar's "Sending · x of y" (§8.4). */
export interface UploadProgressSnapshot {
  readonly sentCount: number;
  readonly batchSize: number;
}

/**
 * What the connector runtime exposes to the UI (§8.4): REAL connector
 * connectivity (the PowerSync stream, not `navigator.onLine` guesswork) and
 * upload progress while the outbox drains. Absent in local-only mode and in
 * the node test adapter — consumers must fall back gracefully.
 */
export interface SyncStatusSource {
  readonly connected: boolean;
  /** Fires on connectivity change. Returns unsubscribe. */
  onConnectivity(listener: (online: boolean) => void): () => void;
  /** Fires during outbox drains; `null` marks the end of a pass. Returns unsubscribe. */
  onProgress(listener: (progress: UploadProgressSnapshot | null) => void): () => void;
}

export interface LocalDb extends DbExecutor {
  /**
   * One local ACID transaction. Everything a sale needs commits or rolls back
   * as a unit — checkout writes the outbox row and clears the cart in ONE
   * transaction, which is what makes a crash unable to produce either a
   * phantom sale or a lost one. Nothing inside awaits a socket (§8.2).
   */
  writeTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
  /** Change notifications for live-ish reads (see DataBus). */
  readonly changes: DataBus;
  /** Connector status feed — present only when a sync stack is configured. */
  readonly sync?: SyncStatusSource;
}

/**
 * Minimal change bus: mutations notify, `useLiveQuery` re-runs. The full
 * client uses the sync layer's incremental live queries (§8.2, §8.10 —
 * narrow subscriptions); this bus is the skeleton's stand-in and keeps the
 * same component-facing contract: declare a query, get re-rendered data.
 */
export class DataBus {
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
