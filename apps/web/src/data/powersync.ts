/**
 * The device database: PowerSync-managed SQLite (wasm, OPFS-persisted, driven
 * from a worker — §8.1). We do not hand-roll sync (CLAUDE.md §2.2).
 *
 * LOCAL-ONLY MODE: when the sync env is not configured the database opens
 * with the SAME schema and simply never connects. The app is fully usable in
 * dev with zero backend — which is also an honest rehearsal of the product's
 * normal condition, offline.
 *
 * SYNC MODE (all three env vars set — see env.example):
 *
 *   VITE_POWERSYNC_URL  the self-hosted PowerSync service (downloads ONLY —
 *                       its sync_rules.yaml buckets are the tenant boundary),
 *   VITE_API_URL        the API dev server: GET /sync/token mints the
 *                       short-lived PowerSync client token (aud "powersync",
 *                       tid from the VERIFIED session), POST /sync/upload is
 *                       the ONE write path into app.write_log,
 *   VITE_API_TOKEN      dev-only API bearer; real credential exchange is the
 *                       online login flow (§8.2).
 *
 * The connector splits exactly as 03-offline-sync §3.3 requires: downloads
 * stream from the sync service under the token's tid; uploads drain the
 * local outbox to the API and complete ONLY on a per-key server ack
 * (src/data/sync/upload.ts). The sync service never sees a write.
 */
import { column, PowerSyncDatabase, Schema, Table } from '@powersync/web';
import type { ColumnsType, PowerSyncBackendConnector } from '@powersync/web';
import { DataBus, type DbExecutor, type DbRow, type LocalDb, type SqlValue } from './db';
import { LOCAL_TABLES, type LocalTableDef } from './schema';
import { discardStrayCrud, holdsUnsyncedSeedRows } from './sync/crud-guard';
import { CredentialCache } from './sync/credentials';
import { SyncRuntime } from './sync/runtime';
import { httpUploadTransport } from './sync/transport';
import { drainOutbox, needsClockResync } from './sync/upload';
import { sequenceResultHandler } from './sequence';

function toPowerSyncTable(def: LocalTableDef): Table {
  const columns: ColumnsType = {};
  for (const c of def.columns) {
    columns[c.name] = c.type === 'integer' ? column.integer : column.text;
  }
  return new Table(columns, { localOnly: def.localOnly });
}

export function buildPowerSyncSchema(): Schema {
  const tables: Record<string, Table> = {};
  for (const def of LOCAL_TABLES) tables[def.name] = toPowerSyncTable(def);
  return new Schema(tables);
}

// ---------------------------------------------------------------------------
// Environment — the fixed dev contract (infra/README, env.example)
// ---------------------------------------------------------------------------

export interface SyncEnv {
  readonly apiUrl: string;
  readonly powersyncUrl: string;
  readonly apiToken: string;
}

/** The sync env, or null → local-only fallback. All three are required. */
export function readSyncEnv(): SyncEnv | null {
  const apiUrl = import.meta.env.VITE_API_URL;
  const powersyncUrl = import.meta.env.VITE_POWERSYNC_URL;
  const apiToken = import.meta.env.VITE_API_TOKEN;
  if (
    typeof apiUrl !== 'string' ||
    apiUrl.length === 0 ||
    typeof powersyncUrl !== 'string' ||
    powersyncUrl.length === 0 ||
    typeof apiToken !== 'string' ||
    apiToken.length === 0
  ) {
    return null;
  }
  return { apiUrl, powersyncUrl, apiToken };
}

export function syncConfigured(): boolean {
  return readSyncEnv() !== null;
}

/**
 * The device's API bearer, or `null` when there is none (local-only mode).
 *
 * Read separately from `readSyncEnv()` on purpose: enrolment needs only the
 * bearer, and a device that holds a session but has not been pointed at a sync
 * service should still bind itself to the right location rather than fall back
 * to dev placeholders.
 */
export function readApiBearerToken(): string | null {
  const token = import.meta.env.VITE_API_TOKEN;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

// ---------------------------------------------------------------------------
// Connector — credentials from the API, uploads through the API
// ---------------------------------------------------------------------------

/**
 * fetchCredentials: GET /sync/token, cached until near expiry
 * (sync/credentials.ts). uploadData: drain the outbox through the runtime.
 * PowerSync itself will rarely invoke uploadData (synced tables are read-only
 * on the device, so its CRUD queue stays empty) — the runtime schedules
 * drains off the change bus — but if it ever does, the same single-flight
 * drain runs: a batch is never completed without a server ack, from any path.
 *
 * AND IF PowerSync'S OWN QUEUE IS NOT EMPTY, THAT IS DEALT WITH FIRST.
 * PowerSync calls `uploadData` precisely because it is holding something, and
 * a connector that returns without emptying the queue does not merely skip an
 * upload — it leaves every DOWNLOAD unapplied for as long as the queue has a
 * head, and gets called again a second later, forever (data/sync/crud-guard.ts
 * has the mechanism). A till frozen behind a setup gate is what that looks
 * like from the counter, so the queue is drained and reported here rather than
 * left to accumulate silently.
 */
export function buildConnector(env: SyncEnv, runtime: SyncRuntime): PowerSyncBackendConnector {
  const credentials = new CredentialCache({
    apiUrl: env.apiUrl,
    apiToken: env.apiToken,
    powersyncUrl: env.powersyncUrl,
  });
  return {
    async fetchCredentials() {
      const fresh = await credentials.get();
      return {
        endpoint: fresh.endpoint,
        token: fresh.token,
        expiresAt: new Date(fresh.expiresAtMs),
      };
    },
    async uploadData(database) {
      await discardStrayCrud(database, (entry) => {
        // Loud on purpose, and never once-per-session: this is a write that
        // reached a table no code on this device is allowed to write, and the
        // sale path (the outbox) cannot produce one.
        console.error(
          `[sync] discarded a local write to the synced table "${entry.table}" ` +
            `(${entry.op} ${entry.id}). Synced tables are read-only on a device; ` +
            `every write belongs in the outbox. Downloads were blocked until now.`,
        );
      });
      await runtime.drainNow();
    },
  };
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export async function openLocalDb(): Promise<LocalDb> {
  const ps = new PowerSyncDatabase({
    schema: buildPowerSyncSchema(),
    database: { dbFilename: 'erp-local.db' },
  });
  await ps.init();

  const changes = new DataBus();
  const wrapExecutor = (target: {
    execute: (sql: string, params?: unknown[]) => Promise<unknown>;
    getAll: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  }): DbExecutor => ({
    async execute(sql: string, params?: readonly SqlValue[]): Promise<void> {
      await target.execute(sql, params === undefined ? undefined : [...params]);
    },
    async getAll(sql: string, params?: readonly SqlValue[]): Promise<DbRow[]> {
      return target.getAll<DbRow>(sql, params === undefined ? undefined : [...params]);
    },
  });

  const root = wrapExecutor(ps);
  const base: Omit<LocalDb, 'sync'> = {
    execute: root.execute,
    getAll: root.getAll,
    async writeTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      return ps.writeTransaction(async (tx) => fn(wrapExecutor(tx)));
    },
    changes,
  };

  const env = readSyncEnv();
  if (env === null) {
    // Local-only fallback: same schema, no connection, no runtime.
    return base;
  }

  // ── A DEVICE FROZEN BY AN EARLIER BUILD HEALS ITSELF, ONCE ───────────────
  // The dev seed used to write the synced tables on every start, including in
  // sync mode, which froze downloads permanently (data/seed.ts, crud-guard.ts).
  // The seed no longer does that — but a browser's OPFS database outlives any
  // number of rebuilds, so the devices that ALREADY hold those rows would stay
  // frozen through the fix and need someone to know to clear their storage.
  //
  // `clearLocal: false` is the whole safety of this: it drops only the synced
  // half, which is by definition re-downloadable, and preserves every
  // local-only table — the OUTBOX above all. A sale captured offline and not
  // yet acked survives this, which is the one thing that must never be traded
  // for a clean resync. Runs before `connect`, so there is no stream to
  // interrupt and nothing half-applied to race.
  if (await holdsUnsyncedSeedRows(root)) {
    console.error(
      '[sync] this device holds dev-seed rows in synced tables, which blocks ' +
        'PowerSync from applying downloads. Clearing synced data and ' +
        're-downloading; the outbox and device configuration are kept.',
    );
    await ps.disconnectAndClear({ clearLocal: false });
  }

  // ── DOWNLOADS MUST RING THE CHANGE BUS TOO ───────────────────────────────
  // `db.changes` is notified by local mutations, so until now a row that
  // ARRIVED over the sync stream changed the database without any live read
  // hearing about it. That is invisible for a catalogue that hydrates before
  // anyone looks, and load-bearing for the setup gates: a device waiting for
  // its price lists (data/session/device-price-list.ts) would sit blocked
  // until someone reloaded the till, even though the rows it was waiting for
  // had landed. Same for a location gate showing bare ids until the `location`
  // rows arrive to name them.
  //
  // Scoped to the SYNCED tables on purpose. Including `outbox` would have each
  // drain's ack writes re-notify the bus, which re-triggers the runtime that
  // just wrote them; the loop converges (a drain with nothing to do is a
  // no-op) but there is no reason to spin it.
  const syncedTables = LOCAL_TABLES.filter((t) => !t.localOnly).map((t) => t.name);
  ps.onChange(
    {
      onChange: () => {
        changes.notify();
      },
    },
    { tables: syncedTables },
  );

  const transport = httpUploadTransport({ apiUrl: env.apiUrl, apiToken: env.apiToken });
  // The runtime drains against the same LocalDb seam the app writes through,
  // so ack marking rides the same change bus the badges re-render from.
  const runtime = new SyncRuntime({
    // `onResult` is how an acked sequence-block report becomes the block the
    // counter prints from (03 §3.7.5). Without it the server's answer is acked
    // and thrown away, and a device whose block was burned keeps numbering
    // from a range that no longer exists.
    //
    // KNOWN GAP, stated rather than hidden: nothing yet ENQUEUES the report on
    // reconnect, so in the shipped PWA this handler only fires for a report
    // something else queued. The adoption half is live; the "report on every
    // reconnect" trigger belongs with the counter's reconnect UX and is not
    // wired. `packages/wire-conformance/test/sequence-client-to-api.test.ts`
    // and drill D7 exercise the whole path explicitly.
    drain: async (onProgress) => {
      const report = await drainOutbox(base, transport, {
        onProgress,
        onResult: sequenceResultHandler(base),
      });
      // The server refused these and the device will keep trying. Said out
      // loud, once per pass, because the alternative is a write retried every
      // 30 seconds for hours with the reason visible nowhere — not in the
      // status bar, not on the record, and not in the API's log either, where
      // a per-op refusal is an HTTP 200 carrying a rejected ack.
      for (const d of report.deferredReasons) {
        if (needsClockResync(d.reason)) {
          // The client half of the resync 03 §3.4.1 promises: the op's
          // clock claim has aged past the server's ±24h tolerance while
          // queued, drainOutbox has already refreshed it, and the next pass
          // resends the identical mutation under the device's current time.
          console.warn(
            `[sync] refreshed the clock claim on ${d.kind} ${d.idempotencyKey} after ` +
              `CLOCK_RESYNC_REQUIRED; it will retry with the device's current time`,
          );
          continue;
        }
        console.warn(
          `[sync] the server refused ${d.kind} ${d.idempotencyKey} and it stays queued: ${d.reason}`,
        );
      }
      return report;
    },
    subscribeChanges: (listener) => changes.subscribe(listener),
  });

  const db: LocalDb = { ...base, sync: runtime };

  // The four offline states follow the ACTUAL connector status (§8.4).
  ps.registerListener({
    statusChanged: (status) => {
      runtime.setConnected(status.connected);
    },
  });
  // Radio back → try the queue immediately, ahead of the retry timer.
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => void runtime.drainNow());
  }

  await ps.connect(buildConnector(env, runtime));
  runtime.start();
  return db;
}
