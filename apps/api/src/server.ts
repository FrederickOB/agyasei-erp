/**
 * Fastify transport: tRPC mounted at /trpc with superjson, context built
 * from the Authorization header per request, plus the two plain sync routes
 * (POST /sync/upload, GET /sync/token — see sync.ts).
 */
import Fastify, { type FastifyInstance } from 'fastify';
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
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

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
