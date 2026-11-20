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
 *   DEV_JWT_SECRET  dev-secret-change-me — the DEV-ONLY HS256 secret shared by
 *                   drill/dev:token bearers and the PowerSync service's
 *                   client_auth. Refused when NODE_ENV=production.
 *
 *   The production identity path (device enrolment, OIDC sign-in, DPoP-bound
 *   ES256 tokens, the offline lease) is configured by the variables listed in
 *   src/identity/config.ts. In dev every one has a default: ES256 keys are
 *   generated once into apps/api/.dev-keys.json (gitignored), and OIDC points
 *   at the dev IdP (infra/dev-idp, `pnpm dev:idp`) when OIDC_ISSUER is set.
 *   API_PORT        3001
 *   API_HOST        127.0.0.1 (set 0.0.0.0 for LAN device trials)
 *   POWERSYNC_URL   http://localhost:8080 — handed to clients by /sync/token
 */
import { fileURLToPath } from 'node:url';
import { createHlcClock, randomHlcNode } from '@erp/db';
import { createMemoryPolicyStore } from './credit-policy.js';
import { identityFromEnv } from './identity/config.js';
import { createPgRunners } from './pg-runner.js';
import { buildServer } from './server.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://erp:erp_dev@localhost:5433/erp';
const API_PORT = Number(process.env.API_PORT ?? 3001);
const API_HOST = process.env.API_HOST ?? '127.0.0.1';
const POWERSYNC_URL = process.env.POWERSYNC_URL ?? 'http://localhost:8080';
// Browser origins allowed to call this API. The PWA runs on a different origin
// (:5173) than the API (:3001), so without this every fetch fails preflight.
// Comma-separated override for LAN device trials, e.g.
// CORS_ORIGINS=http://192.168.1.20:5173
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const { runner, admin, preTenant, close } = createPgRunners(DATABASE_URL);
// Fresh node id per process: two dev servers never share an HLC node.
const clock = createHlcClock(randomHlcNode());

const auth = await identityFromEnv(process.env, { runner, preTenant, clock }, {
  issuer: `http://localhost:${API_PORT}`,
  keysFile: fileURLToPath(new URL('../.dev-keys.json', import.meta.url)),
});

const app = await buildServer({
  deps: {
    runner,
    admin,
    clock,
    // Q4 seam: in-memory policy store, default UNCONFIRMED → accrual fails
    // closed (phase1-status §3) — unchanged here.
    policyStore: createMemoryPolicyStore(),
  },
  jwtSecret: auth.devJwtSecret,
  identity: auth.identity,
  publicUrl: process.env.ERP_PUBLIC_URL,
  trustProxy: process.env.ERP_TRUST_PROXY === '1',
  logger: true,
  sync: { powersyncUrl: POWERSYNC_URL },
  corsOrigins: CORS_ORIGINS,
});

await app.listen({ port: API_PORT, host: API_HOST });
app.log.info(`@erp/api dev server on http://${API_HOST}:${API_PORT} (db ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')})`);
app.log.info(
  `identity: issuer ${auth.issuer}; OIDC ${auth.oidcConfigured ? 'configured' : 'NOT configured (device sign-in disabled; dev bearer only)'}; ` +
    `dev HS256 bearer ${auth.devJwtSecret ? 'ENABLED (dev only)' : 'disabled'}`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => close())
      .finally(() => process.exit(0));
  });
}
