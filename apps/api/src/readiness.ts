/**
 * /readyz — may this machine take traffic?
 *
 *   - the database answers, through the same pool requests use;
 *   - every migration this build knows is applied. A build that expects a
 *     column the database lacks must not serve; Fly's health check keeps it
 *     out of rotation and the deploy fails instead of the requests.
 *
 * A database AHEAD of this build is READY: that is the expand–migrate–
 * contract rollback case (§9.8), where the previous server deliberately
 * tolerates an expanded schema. It is reported, not refused — the refusal
 * belongs to the migrator, which must not apply anything on a guess.
 *
 * The public body says ready or not and a coarse reason. Details (which
 * migrations) are logged, not served: /readyz is reachable from the internet.
 */
export interface ReadinessResult {
  readonly ready: boolean;
  readonly reason?: 'database_unreachable' | 'migrations_pending';
  readonly pending?: readonly string[];
  readonly ahead?: readonly string[];
}

export interface ReadinessDeps {
  /** As the API's own role, outside any tenant context. */
  query<T>(sql: string): Promise<{ rows: T[] }>;
  readonly expectedMigrations: readonly string[];
  /** Cache a result this long; health checks arrive every few seconds. */
  readonly cacheMs?: number;
  readonly now?: () => number;
}

export function readinessCheck(deps: ReadinessDeps): () => Promise<ReadinessResult> {
  const now = deps.now ?? Date.now;
  let cached: { at: number; result: ReadinessResult } | null = null;
  return async () => {
    if (cached && now() - cached.at < (deps.cacheMs ?? 5_000)) return cached.result;
    let result: ReadinessResult;
    try {
      const rows = (await deps.query<{ filename: string }>(`select filename from erp_meta.schema_migrations`)).rows;
      const applied = new Set(rows.map((r) => r.filename));
      const known = new Set(deps.expectedMigrations);
      const pending = deps.expectedMigrations.filter((f) => !applied.has(f));
      const ahead = [...applied].filter((f) => !known.has(f)).sort();
      result = pending.length > 0 ? { ready: false, reason: 'migrations_pending', pending, ahead } : { ready: true, ahead };
    } catch {
      result = { ready: false, reason: 'database_unreachable' };
    }
    cached = { at: now(), result };
    return result;
  };
}
