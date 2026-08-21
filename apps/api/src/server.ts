/**
 * Fastify transport: tRPC mounted at /trpc with superjson, context built
 * from the Authorization header per request, plus the two plain sync routes
 * (POST /sync/upload, GET /sync/token — see sync.ts).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import {
  fastifyTRPCPlugin,
  type CreateFastifyContextOptions,
} from '@trpc/server/adapters/fastify';
import { createContextFromHeader, type ContextOptions } from './context.js';
import { appRouter } from './routers/index.js';
import { registerSyncRoutes, type SyncRouteOptions } from './sync.js';

export interface BuildServerOptions extends ContextOptions {
  logger?: boolean;
  sync?: SyncRouteOptions | undefined;
  /**
   * Browser origins permitted to call this API. The PWA is served from a
   * different origin than the API (dev: :5173 vs :3001), so without this every
   * fetch fails its preflight. An explicit allow-list, never `origin: true` —
   * these requests carry the bearer token that establishes tenant identity, so
   * reflecting arbitrary origins would let any page a staff member visits drive
   * the API with their credentials.
   *
   * Unset → CORS is not registered at all (the drills use @powersync/node,
   * which has no origin and needs none).
   */
  corsOrigins?: readonly string[] | undefined;
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

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
      allowedHeaders: ['authorization', 'content-type'],
      // No credentials: identity travels in the Authorization header, never a
      // cookie, so the browser must not be told to attach ambient credentials.
      credentials: false,
      maxAge: 86400,
    });
  }

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }: CreateFastifyContextOptions) =>
        createContextFromHeader(opts, req.headers.authorization),
    },
  });

  await registerSyncRoutes(app, opts);

  app.get('/healthz', async () => ({ ok: true }));
  return app;
}
