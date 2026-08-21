/**
 * Per-request context. The bearer token is verified here — or the request
 * proceeds with identity=null and every protected procedure refuses. The
 * tenant id in the context is the JWT `tid` claim; nothing downstream can
 * substitute another.
 */
import { verifyToken } from './auth.js';
import type { ApiDeps, Context } from './trpc.js';

export interface ContextOptions {
  deps: ApiDeps;
  jwtSecret: string;
}

export async function createContextFromHeader(
  opts: ContextOptions,
  authorizationHeader: string | undefined,
): Promise<Context> {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return { deps: opts.deps, identity: null };
  }
  try {
    const identity = await verifyToken(opts.jwtSecret, authorizationHeader.slice('Bearer '.length));
    return { deps: opts.deps, identity };
  } catch {
    // Verification failure and missing token look identical downstream.
    return { deps: opts.deps, identity: null };
  }
}
