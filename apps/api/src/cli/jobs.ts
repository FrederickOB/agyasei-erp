/**
 * The scheduled-job worker (`node dist/bin/jobs.js`) — the Fly `worker`
 * process.
 *
 *   jobs.js loop              run whatever is due, every JOBS_TICK_SECONDS, forever
 *   jobs.js run <name> [...]  run named jobs now (by hand: fly ssh console -C …)
 *   jobs.js list              the registered jobs and their cadence
 *
 * `run` takes the same per-job lock as the loop, so running a job by hand
 * while the worker is mid-run is a polite no-op, not a double run.
 */
import {
  ConfigError,
  buildIdentity,
  createPgOps,
  jobsEnvSchema,
  jsonLogger,
  logSink,
  parseEnv,
  runJob,
  runLoop,
  runnerIdentity,
  sslFromEnv,
  urlHeartbeat,
  webhookSink,
  type RunnerDeps,
} from '@erp/ops';
import { platformRegistry } from '../jobs.js';

const log = jsonLogger({ component: 'jobs' });

async function main(argv: string[]): Promise<number> {
  const [cmd, ...names] = argv;
  let env;
  let ssl;
  try {
    env = parseEnv(jobsEnvSchema, process.env);
    ssl = sslFromEnv(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(err.message);
      return 1;
    }
    throw err;
  }
  const registry = platformRegistry(env);

  if (cmd === 'list') {
    for (const j of registry.list()) process.stdout.write(`${j.name.padEnd(28)} every ${j.intervalSeconds}s  ${j.description}\n`);
    return 0;
  }

  const db = createPgOps({
    url: env.JOBS_DATABASE_URL,
    sslMode: ssl.sslMode,
    caCert: ssl.caCert,
    max: 4,
    applicationName: 'erp-jobs',
    // Statement bound: erp_jobs' role default (roles.sql), not a startup
    // parameter a pooler might refuse.
  });
  const sink = env.ALERT_WEBHOOK_URL
    ? webhookSink(env.ALERT_WEBHOOK_URL, { environment: env.ALERT_ENVIRONMENT })
    : logSink((line, fields) => log.warn(`ALERT (no ALERT_WEBHOOK_URL configured) ${line}`, fields as never));
  if (!env.ALERT_WEBHOOK_URL) log.warn('ALERT_WEBHOOK_URL is not set: alerts go to the log only, and nobody is paged');

  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort());
  process.once('SIGINT', () => abort.abort());

  const deps: RunnerDeps = {
    runner: db.runner,
    ops: db.ops,
    locks: db.locks,
    sink,
    log,
    runnerId: runnerIdentity(),
    build: env.ERP_BUILD ?? buildIdentity(),
    alertRepeatMs: env.ALERT_REPEAT_HOURS * 3_600_000,
    signal: abort.signal,
    registered: registry.list().map((d) => ({ name: d.name, intervalSeconds: d.intervalSeconds })),
  };

  try {
    if (cmd === 'loop') {
      log.info('worker started', { jobs: registry.list().length, tick_seconds: env.JOBS_TICK_SECONDS });
      if (!env.JOBS_HEARTBEAT_URL) log.warn('JOBS_HEARTBEAT_URL is not set: if this worker dies, nothing will notice');
      await runLoop(registry, deps, {
        tickMs: env.JOBS_TICK_SECONDS * 1000,
        signal: abort.signal,
        ...(env.JOBS_HEARTBEAT_URL ? { heartbeat: urlHeartbeat(env.JOBS_HEARTBEAT_URL) } : {}),
      });
      log.info('worker stopped');
      return 0;
    }
    if (cmd === 'run' && names.length > 0) {
      let failed = 0;
      for (const name of names) {
        const def = registry.get(name);
        if (!def) {
          log.error('no such job', { job: name });
          failed += 1;
          continue;
        }
        const out = await runJob(def, deps);
        process.stdout.write(`${JSON.stringify(out)}\n`);
        if (out.status === 'failed') failed += 1;
      }
      return failed > 0 ? 1 : 0;
    }
    process.stderr.write('usage: jobs.js loop | run <job> [<job> ...] | list\n');
    return 2;
  } finally {
    await db.close();
  }
}

process.exit(await main(process.argv.slice(2)));
