/**
 * PRODUCTION entry point: `node dist/bin/main.js` (the Fly `api` process).
 * Development keeps `src/dev.ts` (`pnpm --filter @erp/api dev:stack`).
 *
 * Start-up order, each step refusing loudly rather than limping:
 *   1. configuration (zod) — names the bad variable, never prints a value;
 *   2. pools — erp_api through the transaction pooler; the operator plane
 *      only if OPERATOR_DATABASE_URL is set;
 *   3. the migration list this build expects (for /readyz);
 *   4. listen.
 *
 * Shutdown (SIGTERM from Fly on deploy/scale): stop accepting, let in-flight
 * requests finish within SHUTDOWN_GRACE_MS, close the pools, exit 0. An
 * upload cut off mid-batch is safe by construction — every op is idempotent
 * and the device retries the unacknowledged keys.
 */
import { existsSync } from 'node:fs';
import { createHlcClock, MIGRATIONS_DIR, randomHlcNode } from '@erp/db';
import { ConfigError, listMigrationFiles, pgPoolConfig } from '@erp/ops';
import { loadApiConfig } from './config.js';
import { createMemoryPolicyStore } from './credit-policy.js';
import { productionLoggerOptions } from './logging.js';
import { createPgRunners } from './pg-runner.js';
import { readinessCheck } from './readiness.js';
import { buildServer } from './server.js';

function fail(message: string): never {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', time: new Date().toISOString(), msg: message })}\n`);
  process.exit(1);
}

let cfg: ReturnType<typeof loadApiConfig>;
try {
  cfg = loadApiConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) fail(err.message);
  throw err;
}

const runners = createPgRunners(cfg.DATABASE_URL, {
  poolConfig: pgPoolConfig({
    url: cfg.DATABASE_URL,
    sslMode: cfg.sslMode,
    caCert: cfg.caCert,
    max: cfg.DB_POOL_MAX,
    applicationName: 'erp-api',
    statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS,
  }),
  operator: cfg.OPERATOR_DATABASE_URL
    ? pgPoolConfig({
        url: cfg.OPERATOR_DATABASE_URL,
        sslMode: cfg.sslMode,
        caCert: cfg.caCert,
        max: 2,
        applicationName: 'erp-api-operator',
        statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS,
      })
    : 'disabled',
});

// Bundled: dist/bin/main.js → dist/migrations (MIGRATIONS_DIR resolves there
// by itself). From source: packages/db/migrations.
const migrationsDir = cfg.MIGRATIONS_DIR ?? MIGRATIONS_DIR;
if (!existsSync(migrationsDir)) fail(`migrations directory not found: ${migrationsDir}`);
const expected = (await listMigrationFiles(migrationsDir)).map((f) => f.filename);

const app = await buildServer({
  deps: {
    runner: runners.runner,
    admin: runners.admin,
    // A fresh HLC node per process: two machines never share a node id.
    clock: createHlcClock(randomHlcNode()),
    // Q4 seam, unchanged from dev: default UNCONFIRMED → fee accrual fails closed.
    policyStore: createMemoryPolicyStore(),
  },
  jwtSecret: cfg.AUTH_JWT_SECRET,
  logger: productionLoggerOptions(cfg.LOG_LEVEL),
  bodyLimit: cfg.BODY_LIMIT_BYTES,
  trustProxy: cfg.TRUST_PROXY,
  corsOrigins: cfg.CORS_ORIGINS,
  sync: {
    powersyncUrl: cfg.POWERSYNC_URL,
    powersyncSecret: cfg.POWERSYNC_JWT_SECRET,
    tokenTtlSeconds: cfg.POWERSYNC_TOKEN_TTL_SECONDS,
    uploadBodyLimit: cfg.UPLOAD_BODY_LIMIT_BYTES,
  },
  readiness: readinessCheck({ query: (sql) => runners.query(sql), expectedMigrations: expected }),
  rateLimit: {
    prefixes: cfg.RATE_LIMIT_PATHS,
    max: cfg.RATE_LIMIT_MAX,
    windowMs: cfg.RATE_LIMIT_WINDOW_SECONDS * 1000,
  },
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down: draining in-flight requests');
  const force = setTimeout(() => {
    app.log.error('shutdown grace period exceeded; exiting');
    process.exit(1);
  }, cfg.SHUTDOWN_GRACE_MS);
  force.unref();
  try {
    await app.close();
    await runners.close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  app.log.error({ error: reason instanceof Error ? reason.message.split('\n')[0] : 'non-error rejection' }, 'unhandled rejection');
});

await app.listen({ host: cfg.HOST, port: cfg.PORT });
app.log.info(
  {
    build: cfg.ERP_BUILD,
    migrations_expected: expected.length,
    operator_plane: runners.admin !== undefined,
    tls: cfg.sslMode,
  },
  '@erp/api listening',
);
