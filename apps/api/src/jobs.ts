/**
 * THE PLATFORM'S SCHEDULED JOBS — the one list the worker runs.
 *
 * To add a job (e.g. the identity package's device sync-scope refresh):
 * build it with `defineJob` from @erp/ops — idempotent, tenant data only via
 * `ctx.runner.withTenant`, summaries of counts and ids — and add it to the
 * array below. That is the whole registration; the worker, its lock, its
 * job_run bookkeeping, its alerting and its staleness monitoring come with it.
 * See packages/ops/src/jobs/registry.ts for the contract.
 */
import { builtinJobs, builtinJobsConfig, JobRegistry, type JobDefinition, type JobsEnv } from '@erp/ops';

export function platformJobs(env: JobsEnv): JobDefinition[] {
  return [
    ...builtinJobs(builtinJobsConfig(env)),
    // ── Work packages register additional jobs here. ──────────────────────
  ];
}

export function platformRegistry(env: JobsEnv): JobRegistry {
  const registry = new JobRegistry();
  for (const job of platformJobs(env)) registry.register(job);
  return registry;
}
