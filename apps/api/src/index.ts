/**
 * @erp/api — the write path and Phase 1 routers.
 *
 * Fastify + tRPC v11 + superjson. Every mutation flows through ONE
 * idempotent pipeline over app.write_log (per-tenant key uniqueness,
 * server-stamped HLC, claimed_hlc stored untrusted); every statement runs
 * as app_user under forced RLS with the tenant id taken from the verified
 * token and never from a payload.
 */
export { appRouter, type AppRouter } from './routers/index.js';
export { buildServer, type BuildServerOptions } from './server.js';
export { createContextFromHeader, type ContextOptions } from './context.js';
export { signDevToken, verifyToken, type Claims, type VerifiedIdentity } from './auth.js';
export {
  createCallerFactory,
  type ApiDeps,
  type Context,
} from './trpc.js';
export { runIdempotent, type WriteMeta, type WriteResult, type JsonValue } from './pipeline.js';
export { canonicalJson, requestHashHex } from './canonical.js';
export {
  createMemoryPolicyStore,
  days30,
  PROVISIONAL_TEMPLATE_POLICY,
  type CreditPolicy,
  type CreditPolicyStore,
} from './credit-policy.js';
export { adminRunnerFrom, type AdminRunner, type Queryable, type TenantRunner } from './db.js';
export { registerSyncRoutes, type SyncRouteOptions, type UploadAck, type UploadAckStatus } from './sync.js';
export { createPgRunners, type PgRunners } from './pg-runner.js';
export { taxComponentsInForce, computeLineTaxes } from './tax.js';
