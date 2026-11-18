/**
 * The job registry — how anything in the platform gets a scheduled job.
 *
 * Registering a job is one call, from the jobs entry point
 * (`apps/api/src/cli/jobs.ts`):
 *
 *     registry.register(defineJob({
 *       name: 'identity.sync_scope_refresh',
 *       description: 'Recompute device sync scope after lapsed grants',
 *       intervalSeconds: 3600,
 *       async run(ctx) {
 *         for (const tenantId of await ctx.tenants()) {
 *           await ctx.runner.withTenant(tenantId, (tx) => tx.query('select ...'));
 *         }
 *         return { summary: { tenants: n } };
 *       },
 *     }));
 *
 * THE CONTRACT EVERY JOB SIGNS:
 *   1. IDEMPOTENT. A job may run twice (a lost lock connection, an operator
 *      running it by hand while the scheduler does). Running twice must be
 *      the same as running once.
 *   2. TENANT DATA ONLY THROUGH `ctx.runner.withTenant`. That is the RLS
 *      context; `ctx.ops` is for platform bookkeeping and the catalogue.
 *   3. SUMMARIES ARE COUNTS AND IDS. They are stored in platform.job_run and
 *      read by operators across every tenant.
 *   4. ONE TENANT'S FAILURE IS NOT EVERY TENANT'S. Catch per tenant, record,
 *      continue, and return `degraded`.
 */
import type { AlertSignal } from '../alerts.js';
import type { OpsDb, Queryable, TenantRunner } from '../db.js';
import { safeError, type Logger } from '../log.js';

export type SummaryValue = string | number | boolean | null | SummaryValue[] | { [k: string]: SummaryValue };

export interface JobContext {
  readonly jobRunId: string;
  /** Per-tenant work, under that tenant's RLS. The only door to `app.*`. */
  readonly runner: TenantRunner;
  /** Operator plane: platform bookkeeping and the catalogue. */
  readonly ops: OpsDb;
  /** Every tenant that may still hold data. */
  tenants(): Promise<string[]>;
  readonly log: Logger;
  readonly now: () => Date;
  /** Aborted on shutdown. Check it between tenants. */
  readonly signal: AbortSignal;
  /** Names and intervals of every registered job (for staleness checks). */
  readonly registered: readonly { name: string; intervalSeconds: number }[];
}

export interface JobResult {
  readonly summary?: { [k: string]: SummaryValue };
  /** True when the job completed but found something that needs a human. */
  readonly degraded?: boolean;
  /**
   * The COMPLETE current set of this job's alerts. Undefined means "this job
   * does not manage alerts"; an empty array resolves every open one.
   */
  readonly alerts?: readonly AlertSignal[];
}

export interface JobDefinition {
  /** `area.what`, lowercase: 'ledger.posting_sweep'. Stored in job_run.job_name. */
  readonly name: string;
  readonly description: string;
  /** Cadence for the due-scheduler. A failed run is retried sooner (see runner). */
  readonly intervalSeconds: number;
  run(ctx: JobContext): Promise<JobResult>;
}

const NAME = /^[a-z][a-z0-9_.]{0,63}$/;

export function defineJob(def: JobDefinition): JobDefinition {
  if (!NAME.test(def.name)) throw new Error(`job name must match ${NAME}: ${JSON.stringify(def.name)}`);
  if (!Number.isInteger(def.intervalSeconds) || def.intervalSeconds < 60) {
    throw new Error(`job ${def.name}: intervalSeconds must be an integer >= 60`);
  }
  return Object.freeze({ ...def });
}

export class JobRegistry {
  readonly #jobs = new Map<string, JobDefinition>();

  register(def: JobDefinition): this {
    if (this.#jobs.has(def.name)) throw new Error(`job ${def.name} is already registered`);
    this.#jobs.set(def.name, defineJob(def));
    return this;
  }

  get(name: string): JobDefinition | undefined {
    return this.#jobs.get(name);
  }

  list(): JobDefinition[] {
    return [...this.#jobs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Per-tenant loop with the contract's failure isolation built in. */
export async function forEachTenant<T>(
  ctx: Pick<JobContext, 'tenants' | 'signal' | 'log'>,
  fn: (tenantId: string) => Promise<T>,
): Promise<{ ok: Map<string, T>; failed: Map<string, { code: string | null; message: string }> }> {
  const ok = new Map<string, T>();
  const failed = new Map<string, { code: string | null; message: string }>();
  for (const tenantId of await ctx.tenants()) {
    if (ctx.signal.aborted) break;
    try {
      ok.set(tenantId, await fn(tenantId));
    } catch (err) {
      const e = safeError(err);
      failed.set(tenantId, e);
      ctx.log.warn('job step failed for tenant', { tenant_id: tenantId, sqlstate: e.code, error: e.message });
    }
  }
  return { ok, failed };
}

export type { Queryable };
