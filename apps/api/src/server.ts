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
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import {
  fastifyTRPCPlugin,
  type CreateFastifyContextOptions,
} from '@trpc/server/adapters/fastify';
import { authenticateRequest, requestAuth, type ContextOptions } from './context.js';
import { registerIdentityRoutes } from './identity/routes.js';
import { appRouter } from './routers/index.js';
import { registerSyncRoutes, type SyncRouteOptions } from './sync.js';
import type { Context } from './trpc.js';

export interface BuildServerOptions extends ContextOptions {
  logger?: boolean;
  sync?: SyncRouteOptions | undefined;
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
  /** Fastify trustProxy — set behind Fly.io so req.protocol is the client's. */
  trustProxy?: boolean | undefined;
}

/** Routes whose identity comes from the request's own DPoP proof, not a token. */
const SELF_AUTHENTICATING = ['/auth/', '/.well-known/', '/sync/revoked-drain'];

function needsAuth(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (SELF_AUTHENTICATING.some((p) => path.startsWith(p))) return path === '/auth/sign-out' || path === '/auth/lease';
  return path.startsWith('/trpc') || path.startsWith('/sync/');
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false });
  app.decorateRequest('erpAuth', null);

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
    },
  });

  await registerSyncRoutes(app, opts);
  await registerIdentityRoutes(app, opts);

  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
