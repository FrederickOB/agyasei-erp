/**
 * Dev serving entrypoint against the local docker stack (infra/):
 * `pnpm --filter @erp/api dev:stack`.
 *
 * Environment (defaults are the documented dev-stack values — see
 * apps/api/env.example and infra/env.example; real secrets never live here):
 *
 *   DATABASE_URL    postgresql://erp:erp_dev@localhost:5433/erp
 *                   (Postgres 16 in docker, wal_level=logical — NOT the
 *                    host's Postgres 14 on 5432)
 *   DEV_JWT_SECRET  dev-secret-change-me — the ONE HS256 secret shared by
 *                   API-issued tokens and the PowerSync service's client_auth
 *   API_PORT        3001
 *   API_HOST        127.0.0.1 (set 0.0.0.0 for LAN device trials)
 *   POWERSYNC_URL   http://localhost:8080 — handed to clients by /sync/token
 */
import { createHlcClock, randomHlcNode } from '@erp/db';
import { createMemoryPolicyStore } from './credit-policy.js';
import { createPgRunners } from './pg-runner.js';
import { buildServer } from './server.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://erp:erp_dev@localhost:5433/erp';
const DEV_JWT_SECRET = process.env.DEV_JWT_SECRET ?? 'dev-secret-change-me';
const API_PORT = Number(process.env.API_PORT ?? 3001);
const API_HOST = process.env.API_HOST ?? '127.0.0.1';
const POWERSYNC_URL = process.env.POWERSYNC_URL ?? 'http://localhost:8080';

const { runner, admin, close } = createPgRunners(DATABASE_URL);

const app = await buildServer({
  deps: {
    runner,
    admin,
    // Fresh node id per process: two dev servers never share an HLC node.
    clock: createHlcClock(randomHlcNode()),
    // Q4 seam: in-memory policy store, default UNCONFIRMED → accrual fails
    // closed (phase1-status §3) — unchanged here.
    policyStore: createMemoryPolicyStore(),
  },
  jwtSecret: DEV_JWT_SECRET,
  logger: true,
  sync: { powersyncUrl: POWERSYNC_URL },
});

await app.listen({ port: API_PORT, host: API_HOST });
app.log.info(`@erp/api dev server on http://${API_HOST}:${API_PORT} (db ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => close())
      .finally(() => process.exit(0));
  });
}
