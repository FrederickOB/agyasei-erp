/**
 * The job runner: one entry point, each job under its own advisory lock, every
 * attempt recorded in platform.job_run, alerts reconciled and sent.
 *
 * SCHEDULING IS DATABASE-BACKED, NOT WALL-CLOCK. The worker wakes every tick
 * and asks platform.job_run which jobs are due (last attempt older than the
 * job's interval; sooner after a failure). A restart, a deploy or a crashed
 * machine therefore cannot make a job silently skip its slot — it simply runs
 * on the next tick — and two workers cannot both run a job, because each run
 * holds `pg_try_advisory_xact_lock('erp:job:<name>')` for its duration.
 *
 * THE MONITOR NEEDS A MONITOR. If the worker itself dies, nothing it would
 * have alerted on can alert. So after every tick that completed, it pings an
 * external heartbeat URL (a dead-man's switch: the external service pages
 * when the pings STOP). Absence of signal is the signal (§9.4), applied to the
 * thing that watches for absence.
 */
import { uuidv7 } from '@erp/db';
import { markSent, reconcileAlerts, type AlertSignal, type AlertSink } from '../alerts.js';
import { listTenantIds, type LockProvider, type OpsDb, type TenantRunner } from '../db.js';
import { safeError, type Logger } from '../log.js';
import type { JobDefinition, JobRegistry } from './registry.js';

export interface RunnerDeps {
  readonly runner: TenantRunner;
  readonly ops: OpsDb;
  readonly locks: LockProvider;
  readonly sink: AlertSink;
  readonly log: Logger;
  readonly runnerId: string;
  readonly build: string | null;
  /** How often a still-open alert is re-sent. */
  readonly alertRepeatMs: number;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  /** Every registered job, so a job can check the others' staleness. */
  readonly registered?: readonly { name: string; intervalSeconds: number }[];
}

export type RunStatus = 'succeeded' | 'degraded' | 'failed' | 'skipped_locked';

export interface RunOutcome {
  readonly job: string;
  readonly status: RunStatus;
  readonly jobRunId?: string;
  readonly durationMs?: number;
  readonly error?: { code: string | null; message: string };
  readonly notified?: number;
}

/** Retry a failed job after this long, or its interval if shorter. */
export const FAILURE_RETRY_SECONDS = 600;

async function dispatchAlerts(
  deps: RunnerDeps,
  source: string,
  signals: readonly AlertSignal[],
): Promise<number> {
  const notes = await reconcileAlerts(deps.ops, source, signals, { repeatAfterMs: deps.alertRepeatMs });
  if (notes.length === 0) return 0;
  try {
    await deps.sink.send(notes);
    await markSent(
      deps.ops,
      notes.filter((n) => n.state !== 'resolved').map((n) => n.key),
    );
    return notes.length;
  } catch (err) {
    // Not marked sent: a firing alert is re-attempted on the next evaluation.
    const e = safeError(err);
    deps.log.error('alert delivery failed', { source, count: notes.length, error: e.message });
    return 0;
  }
}

export async function runJob(def: JobDefinition, deps: RunnerDeps): Promise<RunOutcome> {
  const log = deps.log.child({ job: def.name });
  const now = deps.now ?? (() => new Date());
  const signal = deps.signal ?? new AbortController().signal;

  const outcome = await deps.locks.tryWithLock(`job:${def.name}`, async (): Promise<RunOutcome> => {
    // We hold the lock, so any 'running' row for this job belongs to a runner
    // that is gone. Close it honestly rather than leaving it to look alive.
    await deps.ops.query(
      `update platform.job_run
          set status = 'abandoned', finished_at = clock_timestamp(),
              error = 'runner exited before recording an outcome'
        where job_name = $1 and status = 'running'`,
      [def.name],
    );
    const jobRunId = uuidv7();
    await deps.ops.query(
      `insert into platform.job_run (id, job_name, status, runner, build)
       values ($1, $2, 'running', $3, $4)`,
      [jobRunId, def.name, deps.runnerId, deps.build],
    );
    const started = Date.now();
    log.info('job started', { job_run_id: jobRunId });

    try {
      const result = await def.run({
        jobRunId,
        runner: deps.runner,
        ops: deps.ops,
        tenants: () => listTenantIds(deps.ops),
        log: log.child({ job_run_id: jobRunId }),
        now,
        signal,
        registered: deps.registered ?? [],
      });
      const durationMs = Date.now() - started;
      const status = result.degraded ? 'degraded' : 'succeeded';
      await deps.ops.query(
        `update platform.job_run
            set status = $2, finished_at = clock_timestamp(), duration_ms = $3, summary = $4::jsonb
          where id = $1`,
        [jobRunId, status, durationMs, JSON.stringify(result.summary ?? {})],
      );
      let notified = 0;
      if (result.alerts !== undefined) notified += await dispatchAlerts(deps, def.name, result.alerts);
      notified += await dispatchAlerts(deps, `runner.${def.name}`, []);
      log.info('job finished', { job_run_id: jobRunId, status, duration_ms: durationMs, notified });
      return { job: def.name, status, jobRunId, durationMs, notified };
    } catch (err) {
      const durationMs = Date.now() - started;
      const e = safeError(err);
      await deps.ops.query(
        `update platform.job_run
            set status = 'failed', finished_at = clock_timestamp(), duration_ms = $2, error = $3
          where id = $1`,
        [jobRunId, durationMs, e.code ? `${e.code}: ${e.message}` : e.message],
      );
      log.error('job failed', { job_run_id: jobRunId, sqlstate: e.code, error: e.message });
      const notified = await dispatchAlerts(deps, `runner.${def.name}`, [
        {
          key: `job_failed:${def.name}`,
          kind: 'job_failed',
          severity: 'page',
          summary: `scheduled job ${def.name} failed (run ${jobRunId}${e.code ? `, sqlstate ${e.code}` : ''})`,
        },
      ]);
      return { job: def.name, status: 'failed', jobRunId, durationMs, error: e, notified };
    }
  });

  if (!outcome.acquired) {
    log.info('job skipped: another runner holds its lock');
    return { job: def.name, status: 'skipped_locked' };
  }
  return outcome.value;
}

/** Which registered jobs are due now, from platform.job_run. */
export async function dueJobs(registry: JobRegistry, ops: OpsDb, now: Date): Promise<JobDefinition[]> {
  const defs = registry.list();
  if (defs.length === 0) return [];
  const res = await ops.query<{ job_name: string; last_at: string; last_status: string }>(
    `select distinct on (job_name) job_name, started_at::text as last_at, status as last_status
       from platform.job_run
      where job_name = any($1::text[])
      order by job_name, started_at desc`,
    [defs.map((d) => d.name)],
  );
  const last = new Map(res.rows.map((r) => [r.job_name, r]));
  return defs.filter((d) => {
    const l = last.get(d.name);
    if (!l) return true;
    const failed = l.last_status === 'failed' || l.last_status === 'abandoned';
    const waitS = failed ? Math.min(d.intervalSeconds, FAILURE_RETRY_SECONDS) : d.intervalSeconds;
    return now.getTime() - Date.parse(l.last_at) >= waitS * 1000;
  });
}

export interface LoopOptions {
  readonly tickMs?: number;
  readonly signal: AbortSignal;
  /** Dead-man's switch: called after every tick that completed without error. */
  readonly heartbeat?: () => Promise<void>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/** The worker: run whatever is due, sequentially, forever (until aborted). */
export async function runLoop(registry: JobRegistry, deps: RunnerDeps, opts: LoopOptions): Promise<void> {
  const tickMs = opts.tickMs ?? 60_000;
  const registered = registry.list().map((d) => ({ name: d.name, intervalSeconds: d.intervalSeconds }));
  const withSignal: RunnerDeps = { ...deps, signal: opts.signal, registered };
  while (!opts.signal.aborted) {
    try {
      const due = await dueJobs(registry, deps.ops, (deps.now ?? (() => new Date()))());
      for (const def of due) {
        if (opts.signal.aborted) break;
        await runJob(def, withSignal);
      }
      if (opts.heartbeat) {
        try {
          await opts.heartbeat();
        } catch (err) {
          deps.log.warn('heartbeat ping failed', { error: safeError(err).message });
        }
      }
    } catch (err) {
      // Typically: the database is unreachable. No heartbeat this tick — which
      // is exactly what makes the external switch fire if it persists.
      const e = safeError(err);
      deps.log.error('scheduler tick failed', { sqlstate: e.code, error: e.message });
    }
    await sleep(tickMs, opts.signal);
  }
}

/** A heartbeat that GETs a URL (healthchecks.io / Better Stack style). */
export function urlHeartbeat(url: string, fetchImpl: typeof fetch = fetch): () => Promise<void> {
  return async () => {
    const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`heartbeat answered HTTP ${res.status}`);
  };
}
