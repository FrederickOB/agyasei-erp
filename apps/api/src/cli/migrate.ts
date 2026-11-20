/**
 * `db:migrate` — Fly's release_command (`node dist/bin/migrate.js`).
 *
 * Runs BEFORE any new machine starts. Exit non-zero and Fly aborts the deploy
 * with the old machines still serving — which is the outcome every refusal
 * below wants. See packages/ops/src/migrations.ts for what is refused and why.
 *
 * After migrating, under the same lock: grants and the PowerSync publication
 * are converged (expand-only), so privileges never lag the schema.
 */
import pg from 'pg';
import { MIGRATIONS_DIR, type SqlClient } from '@erp/db';
import {
  ConfigError,
  convergeGrants,
  convergePublication,
  createPgOps,
  jsonLogger,
  migrateEnvSchema,
  migrateProduction,
  MigrationRefused,
  parseEnv,
  pgPoolConfig,
  redactUrl,
  safeError,
  sslFromEnv,
} from '@erp/ops';

const log = jsonLogger({ component: 'migrate' });

async function main(): Promise<number> {
  let env;
  let ssl;
  try {
    env = parseEnv(migrateEnvSchema, process.env);
    ssl = sslFromEnv(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(err.message);
      return 1;
    }
    throw err;
  }
  const conn = { url: env.MIGRATE_DATABASE_URL, sslMode: ssl.sslMode, caCert: ssl.caCert };
  const locks = createPgOps({ ...conn, max: 1, applicationName: 'erp-migrate-lock' });
  const client = new pg.Client(pgPoolConfig({ ...conn, applicationName: 'erp-migrate' }));
  client.on('error', () => undefined);
  await client.connect();
  const db: SqlClient = {
    exec: (sql) => client.query(sql),
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params as never)).rows as T[] }),
  };
  log.info('migrating', { target: redactUrl(env.MIGRATE_DATABASE_URL), build: env.ERP_BUILD });
  try {
    const r = await migrateProduction(db, locks.locks, {
      dir: env.MIGRATIONS_DIR ?? MIGRATIONS_DIR,
      allowDbAhead: env.ERP_MIGRATE_ALLOW_DB_AHEAD,
      appliedBy: env.ERP_BUILD ?? null,
      log: (m) => log.info(m),
      after: async (d) => {
        await convergeGrants(d);
        const p = await convergePublication(d);
        log.info('publication converged', {
          created: p.created,
          added: p.added.join(','),
          unexpected: p.unexpected.join(','),
        });
        if (p.unexpected.length > 0) {
          log.warn('publication carries tables the sync rules do not list; removal is a contraction and is left to a human');
        }
      },
    });
    log.info('migrations complete', {
      applied: r.applied.length,
      applied_files: r.applied.join(','),
      ahead: r.ahead.join(','),
      adopted_checksums: r.adoptedChecksums,
      attempts: r.attempts,
    });
    return 0;
  } catch (err) {
    if (err instanceof MigrationRefused) {
      log.error(`REFUSED (${err.reason}): ${err.message}`);
    } else {
      const e = safeError(err);
      log.error('migration failed', { sqlstate: e.code, error: e.message });
    }
    return 1;
  } finally {
    await client.end();
    await locks.close();
  }
}

process.exit(await main());
