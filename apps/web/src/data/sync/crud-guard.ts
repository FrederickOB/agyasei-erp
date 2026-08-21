/**
 * The guard that keeps a stray local write from freezing every download.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MECHANISM, BECAUSE IT IS NOT OBVIOUS AND IT COST A TILL A DAY.
 * ═══════════════════════════════════════════════════════════════════════════
 * The synced tables (`localOnly: false` in data/schema.ts) are READ-ONLY on
 * this device: every real write goes through the local `outbox` to the API
 * (data/sync/upload.ts), and the PowerSync service here is download-only
 * (infra/powersync/sync_rules.yaml). Our connector's `uploadData` therefore
 * drains the outbox and nothing else — it never calls `getCrudBatch()`.
 *
 * PowerSync does not know that. Any INSERT/UPDATE/DELETE against a synced
 * table enqueues a row in its own write queue, `ps_crud`, and parks
 * `ps_buckets.$local.target_op` at MAX. Its sync core then declines to APPLY
 * any downloaded checkpoint while that queue is non-empty — the two probes are
 * visible in the core itself:
 *
 *     SELECT 1 FROM ps_buckets WHERE target_op > last_op AND name = '$local'
 *     SELECT 1 FROM ps_crud LIMIT 1
 *
 * So one unnoticed local write to a synced table is a PERMANENT download
 * freeze: rows stream in, none are applied, the upload loop spins on the same
 * queue head forever, and the device shows a setup gate that can never clear.
 * That is exactly how the dev seed took a till down — see data/seed.ts.
 *
 * Two halves live here, both boring on a healthy device and both load-bearing
 * on a device that is not:
 *   `discardStrayCrud`      — completes the queue so downloads can resume.
 *   `holdsUnsyncedSeedRows` — spots a device already carrying the dev seed's
 *                             rows in its synced tables.
 *
 * DISCARDING IS SAFE HERE, AND ONLY HERE. It would be data loss if the queue
 * held real writes. It cannot: the ONE write path a sale takes is the outbox,
 * a local-only table PowerSync never sees. Anything in `ps_crud` is a write
 * that should not have happened, so it is reported entry by entry and dropped
 * rather than silently retried against a service that will not accept it.
 */
import type { DbExecutor } from '../db';

/** One entry PowerSync is holding, as much of it as a report needs. */
export interface StrayCrudEntry {
  /** PUT / PATCH / DELETE. */
  readonly op: string;
  /** The synced table the write landed on. */
  readonly table: string;
  readonly id: string;
}

/**
 * The slice of the PowerSync database this guard uses. Structural on purpose:
 * the SDK is a browser package (wasm + workers) and nothing here should drag
 * it into a node test run.
 */
export interface StrayCrudSource {
  getCrudBatch(limit?: number): Promise<{
    readonly crud: readonly StrayCrudEntry[];
    complete(writeCheckpoint?: string | null): Promise<void>;
  } | null>;
}

/**
 * Empty PowerSync's write queue, reporting every entry it drops.
 *
 * Returns how many entries were discarded — zero on every healthy device,
 * which is the only number this should ever return once the seed is fixed.
 * A non-zero return is a bug somewhere upstream that has just been contained,
 * not resolved: report it loudly at the call site.
 */
export async function discardStrayCrud(
  source: StrayCrudSource,
  report: (entry: StrayCrudEntry) => void,
): Promise<number> {
  let discarded = 0;
  // Bounded so a queue that refuses to drain (a `complete()` that silently did
  // nothing) cannot spin this loop forever at startup — it gives up and lets
  // the caller report a device that needs clearing instead.
  for (let pass = 0; pass < 100; pass += 1) {
    const batch = await source.getCrudBatch(100);
    if (batch === null) return discarded;
    for (const entry of batch.crud) report(entry);
    discarded += batch.crud.length;
    await batch.complete();
  }
  return discarded;
}

/**
 * Tables the dev seed used to write into, and the column that gives it away.
 *
 * A row that ARRIVED over the sync stream always carries a `tenant_id` — the
 * server column is `not null` and every bucket selects by it. The seed's rows
 * carry none, which is what made them local-only in the first place
 * (data/seed.ts). So `tenant_id IS NULL` is not a heuristic here; it is the
 * same structural test provisioning already uses to tell configuration from a
 * placeholder (data/session/device-price-list.ts).
 */
const SEEDED_TABLES = ['price_list', 'location', 'product'] as const;

/**
 * Is this device carrying dev-seed rows in tables that belong to the sync
 * stream? True only for a database created by a build that seeded them, which
 * is precisely the database that needs its synced half thrown away and
 * re-downloaded.
 */
export async function holdsUnsyncedSeedRows(db: DbExecutor): Promise<boolean> {
  for (const table of SEEDED_TABLES) {
    const rows = await db.getAll(
      `SELECT 1 AS hit FROM ${table} WHERE tenant_id IS NULL LIMIT 1`,
    );
    if (rows.length > 0) return true;
  }
  return false;
}
