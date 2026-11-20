/**
 * Operator commands (`node dist/bin/ops.js <cmd>`, or `pnpm ops <cmd>` from a
 * checkout). Each reads its credentials from the environment, never from
 * arguments, so nothing sensitive lands in shell history or `ps`.
 *
 *   verify     §9.1 provisioning checks, PASS/FAIL/WARN/MANUAL/SKIP; exit 1 on any FAIL
 *              MIGRATE_DATABASE_URL (required), API_DATABASE_URL, JOBS_DATABASE_URL,
 *              POWERSYNC_REPLICATION_URL, POWERSYNC_STORAGE_URL,
 *              SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF, EXPECTED_REGION
 *   signals    the live §9.4 snapshot and the alerts it would raise (JOBS_DATABASE_URL)
 *   backup     logical dump + per-tenant manifest     --out <dir>      (BACKUP_DATABASE_URL)
 *   drill      restore into a fresh scratch database and compare
 *              --manifest <file> [--dump <file>] [--keep] [--started-at <iso>] [--record]
 *              (SCRATCH_ADMIN_URL; --record writes platform.restore_drill via RECORD_DATABASE_URL)
 *   grants     converge grants and the publication only (MIGRATE_DATABASE_URL)
 *
 * Cross-tenant output here (signals) is the OPERATOR's view: tenant ids and
 * counts, assembled from per-tenant reads under RLS. It is never served to a
 * tenant and never leaves through the public API.
 */
import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { MIGRATIONS_DIR, type SqlClient } from '@erp/db';
import {
  collectSignals,
  convergeGrants,
  convergePublication,
  createPgOps,
  evaluateSignals,
  builtinJobsConfig,
  jobsEnvSchema,
  jsonLogger,
  listTenantIds,
  logicalDump,
  parseEnv,
  pgPoolConfig,
  recordDrill,
  renderChecks,
  restoreDrill,
  sslFromEnv,
  verifyProvisioning,
  ConfigError,
} from '@erp/ops';
import { platformRegistry } from '../jobs.js';

// Logs to stderr: stdout carries each command's report (JSON or the verify table).
const log = jsonLogger({ component: 'ops' }, (line) => process.stderr.write(`${line}\n`));

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new ConfigError([`${name}: required for this command`]);
  return v;
}

async function verify(): Promise<number> {
  const ssl = sslFromEnv(process.env);
  const token = process.env['SUPABASE_ACCESS_TOKEN'];
  const ref = process.env['SUPABASE_PROJECT_REF'];
  const results = await verifyProvisioning({
    migratorUrl: need('MIGRATE_DATABASE_URL'),
    apiUrl: process.env['API_DATABASE_URL'],
    jobsUrl: process.env['JOBS_DATABASE_URL'],
    replicationUrl: process.env['POWERSYNC_REPLICATION_URL'],
    storageUrl: process.env['POWERSYNC_STORAGE_URL'],
    sslMode: ssl.sslMode,
    caCert: ssl.caCert,
    migrationsDir: process.env['MIGRATIONS_DIR'] ?? MIGRATIONS_DIR,
    supabase: token && ref ? { accessToken: token, projectRef: ref } : undefined,
    expectedRegion: process.env['EXPECTED_REGION'] ?? 'eu-west-2',
  });
  process.stdout.write(`${renderChecks(results)}\n`);
  const counts = results.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
  process.stdout.write(`\n${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('  ')}\n`);
  return results.some((r) => r.status === 'FAIL') ? 1 : 0;
}

async function signals(): Promise<number> {
  const env = parseEnv(jobsEnvSchema, process.env);
  const ssl = sslFromEnv(process.env);
  const db = createPgOps({ url: env.JOBS_DATABASE_URL, sslMode: ssl.sslMode, caCert: ssl.caCert, max: 2, applicationName: 'erp-ops-signals' });
  try {
    const registry = platformRegistry(env);
    const snapshot = await collectSignals({
      runner: db.runner,
      ops: db.ops,
      tenants: await listTenantIds(db.ops),
      registered: registry.list().map((d) => ({ name: d.name, intervalSeconds: d.intervalSeconds })),
      deviceLookbackDays: env.DEVICE_LOOKBACK_DAYS,
    });
    const alerts = evaluateSignals(snapshot, builtinJobsConfig(env).thresholds, new Date());
    process.stdout.write(`${JSON.stringify({ snapshot, alerts }, null, 2)}\n`);
    return 0;
  } finally {
    await db.close();
  }
}

async function backup(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { out: { type: 'string' } } });
  if (!values.out) throw new ConfigError(['--out <dir>: required']);
  const ssl = sslFromEnv(process.env);
  const r = await logicalDump({ source: { url: need('BACKUP_DATABASE_URL'), ...ssl }, outDir: values.out, log });
  process.stdout.write(
    `${JSON.stringify({ dump: r.dumpPath, manifest: r.recordPath, sha256: r.record.dump.sha256, bytes: r.record.dump.bytes, snapshotAt: r.record.manifest.snapshotAt, tenants: r.record.manifest.tenants.length }, null, 2)}\n`,
  );
  return 0;
}

async function drill(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: 'string' },
      dump: { type: 'string' },
      keep: { type: 'boolean', default: false },
      'started-at': { type: 'string' },
      record: { type: 'boolean', default: false },
      operator: { type: 'string' },
      notes: { type: 'string' },
    },
  });
  if (!values.manifest) throw new ConfigError(['--manifest <file>: required']);
  const ssl = sslFromEnv(process.env);
  const report = await restoreDrill({
    recordPath: values.manifest,
    ...(values.dump ? { dumpPath: values.dump } : {}),
    scratchAdmin: { url: need('SCRATCH_ADMIN_URL'), ...ssl },
    keep: values.keep === true,
    ...(values['started-at'] ? { startedAt: new Date(values['started-at']) } : {}),
    log,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (values.record) {
    const db = createPgOps({ url: need('RECORD_DATABASE_URL'), ...ssl, max: 1, applicationName: 'erp-ops-drill' });
    try {
      await recordDrill(db.ops, report, values.operator ?? process.env['USER'] ?? hostname(), values.notes);
      log.info('drill recorded in platform.restore_drill', { id: report.id });
    } finally {
      await db.close();
    }
  }
  if (values.keep) log.warn('scratch database KEPT: it holds every tenant\'s books. Drop it and record scratch_destroyed_at.', { scratch: report.scratchDatabase });
  return report.passed ? 0 : 1;
}

async function grants(): Promise<number> {
  const ssl = sslFromEnv(process.env);
  const client = new pg.Client(pgPoolConfig({ url: need('MIGRATE_DATABASE_URL'), ...ssl, applicationName: 'erp-ops-grants' }));
  await client.connect();
  try {
    const db: SqlClient = {
      exec: (sql) => client.query(sql),
      query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params as never)).rows as T[] }),
    };
    await convergeGrants(db);
    const p = await convergePublication(db);
    process.stdout.write(`${JSON.stringify(p)}\n`);
    return 0;
  } finally {
    await client.end();
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'verify':
        return await verify();
      case 'signals':
        return await signals();
      case 'backup':
        return await backup(rest);
      case 'drill':
        return await drill(rest);
      case 'grants':
        return await grants();
      default:
        process.stderr.write('usage: ops.js verify | signals | backup --out <dir> | drill --manifest <file> [...] | grants\n');
        return 2;
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(err.message);
      return 1;
    }
    log.error('command failed', { error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
