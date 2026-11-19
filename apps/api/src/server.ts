/**
 * Fastify transport: tRPC mounted at /trpc with superjson, the sync routes
 * (POST /sync/upload, GET /sync/token — sync.ts), and the identity routes
 * (/auth/*, /.well-known/jwks.json, /sync/revoked-drain — identity/routes.ts).
 *
 * Authentication runs ONCE per request, in an onRequest hook, before any
 * route: a request whose device is revoked is answered `423 device_revoked`
 * here and never reaches a handler (02 §2.7 "drain before wipe"); a request
 * the revocation store cannot vouch for is answered `503` here (§2.2 step 4).
 */
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import {
  fastifyTRPCPlugin,
  type CreateFastifyContextOptions,
} from '@trpc/server/adapters/fastify';
import { authenticateRequest, requestAuth, type ContextOptions } from './context.js';
import { registerIdentityRoutes } from './identity/routes.js';
import { registerRateLimit, type RateLimitOptions } from './rate-limit.js';
import type { ReadinessResult } from './readiness.js';
import { appRouter } from './routers/index.js';
import { registerSyncRoutes, type SyncRouteOptions } from './sync.js';
import type { Context } from './trpc.js';

export interface BuildServerOptions extends ContextOptions {
  /** `true` for Fastify's default logger; an options object in production (src/logging.ts). */
  logger?: FastifyServerOptions['logger'];
  sync?: SyncRouteOptions | undefined;
  /** Default request body cap. /sync/upload has its own (SyncRouteOptions.uploadBodyLimit). */
  bodyLimit?: number | undefined;
  /** Behind exactly one trusted proxy (Fly's edge) — so req.protocol is the client's (DPoP `htu`). */
  trustProxy?: boolean | undefined;
  /** Registers GET /readyz when given. */
  readiness?: (() => Promise<ReadinessResult>) | undefined;
  /** Rate limits for credential-exchange routes (src/rate-limit.ts). */
  rateLimit?: RateLimitOptions | undefined;
  /**
   * Browser origins permitted to call this API. The PWA is served from a
   * different origin than the API (dev: :5173 vs :3001), so without this every
   * fetch fails its preflight. An explicit allow-list, never `origin: true` —
   * these requests carry the credentials that establish tenant identity, so
   * reflecting arbitrary origins would let any page a staff member visits drive
   * the API with their credentials.
   *
   * Unset → CORS is not registered at all (the drills use @powersync/node,
   * which has no origin and needs none).
   */
  corsOrigins?: readonly string[] | undefined;
}

/** Routes whose identity comes from the request's own DPoP proof, not a token. */
const SELF_AUTHENTICATING = ['/auth/', '/.well-known/', '/sync/revoked-drain'];

function needsAuth(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (SELF_AUTHENTICATING.some((p) => path.startsWith(p))) return path === '/auth/sign-out' || path === '/auth/lease';
  return path.startsWith('/trpc') || path.startsWith('/sync/');
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    ...(opts.bodyLimit !== undefined ? { bodyLimit: opts.bodyLimit } : {}),
    ...(opts.trustProxy !== undefined ? { trustProxy: opts.trustProxy } : {}),
  });
  app.decorateRequest('erpAuth', null);

  // Before anything else, so a limited request does no other work.
  if (opts.rateLimit) registerRateLimit(app, opts.rateLimit);

  if (opts.corsOrigins && opts.corsOrigins.length > 0) {
    const allowed = new Set(opts.corsOrigins);
    await app.register(cors, {
      origin: (origin, cb) => {
        // Same-origin/non-browser callers send no Origin header — allow them;
        // they are not subject to the browser's cross-origin rules anyway.
        if (!origin) return cb(null, true);
        cb(null, allowed.has(origin));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      // `dpop` carries the device's proof-of-possession on every request.
      allowedHeaders: ['authorization', 'content-type', 'dpop'],
      // No credentials: identity travels in headers, never a cookie, so the
      // browser must not be told to attach ambient credentials.
      credentials: false,
      maxAge: 86400,
    });
  }

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS' || !needsAuth(req.url)) return;
    const outcome = await authenticateRequest(opts, {
      method: req.method,
      url: req.url,
      headers: req.headers,
      protocol: req.protocol,
    });
    if (outcome.kind === 'refused') {
      return reply.code(outcome.status).send(outcome.body);
    }
    req.erpAuth = outcome;
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }: CreateFastifyContextOptions): Context => {
        const outcome = requestAuth(req);
        return {
          deps: opts.deps,
          identity: outcome.kind === 'identity' ? outcome.identity : null,
          ...(opts.identity ? { identityService: opts.identity } : {}),
        };
      },
      // Ids and codes only. Never the input (tenant data) and never a stack:
      // a database error's DETAIL carries row values, and only the primary
      // message is kept, truncated, for server errors.
      onError({
        path,
        error,
        ctx,
      }: {
        path?: string | undefined;
        error: { code: string; message: string };
        ctx?: Context | undefined;
      }) {
        const fields = { trpc_path: path, code: error.code, tenant_id: ctx?.identity?.tenantId };
        if (error.code === 'INTERNAL_SERVER_ERROR') {
          app.log.error({ ...fields, error: error.message.split('\n')[0]?.slice(0, 300) }, 'trpc procedure failed');
        } else {
          app.log.info(fields, 'trpc procedure refused');
        }
      },
    },
  });

  await registerSyncRoutes(app, opts);
  await registerIdentityRoutes(app, opts);

  app.get('/healthz', async () => ({ ok: true }));

  if (opts.readiness) {
    const readiness = opts.readiness;
    let lastReady: boolean | null = null;
    app.get('/readyz', async (_req, reply) => {
      const r = await readiness();
      if (r.ready !== lastReady) {
        lastReady = r.ready;
        app.log[r.ready ? 'info' : 'warn'](
          { ready: r.ready, reason: r.reason, detail: r.detail, pending: r.pending?.join(','), ahead: r.ahead?.join(',') },
          'readiness changed',
        );
      }
      return reply.code(r.ready ? 200 : 503).send(r.ready ? { ready: true } : { ready: false, reason: r.reason });
    });
  }
  return app;
}
