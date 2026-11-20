/**
 * Per-request authentication. Two verifiers, chosen by the Authorization
 * scheme, and never both for one request:
 *
 *   `DPoP <token>`    THE production path (./identity/): an ES256 access
 *                     token we minted, bound by cnf.jkt to the enrolled device
 *                     key, with a fresh DPoP proof, checked against the
 *                     revocation store. Fails CLOSED with a status: 401 bad
 *                     credential, 403 suspended, 423 device_revoked, 503 store
 *                     unavailable.
 *   `Bearer <token>`  DEV ONLY (./auth.ts): HS256 with the shared dev secret.
 *                     Accepted only when the server was built with a
 *                     `jwtSecret` — `dev.ts` refuses one in production — so the
 *                     live drills and `pnpm dev:token` keep working against the
 *                     local stack.
 *
 * Either way the result is ONE VerifiedIdentity whose tenantId is a claim in a
 * token this server signed. Nothing downstream can substitute another.
 */
import type { FastifyRequest } from 'fastify';
import { verifyToken, type VerifiedIdentity } from './auth.js';
import { IdentityError, type IdentityService } from './identity/service.js';
import { looksLikeDeviceToken } from './identity/tokens.js';
import type { ApiDeps, Context } from './trpc.js';

export interface ContextOptions {
  deps: ApiDeps;
  /** DEV ONLY — the HS256 shared secret. Unset in production. */
  jwtSecret?: string | undefined;
  /** The production identity service. */
  identity?: IdentityService | undefined;
  /**
   * Public base URL of this API as the device sees it (DPoP `htu`). Behind a
   * proxy this MUST be set; otherwise it is derived from the request.
   */
  publicUrl?: string | undefined;
}

export type AuthOutcome =
  | { readonly kind: 'identity'; readonly identity: VerifiedIdentity }
  | { readonly kind: 'anonymous'; readonly why?: string }
  | { readonly kind: 'refused'; readonly status: number; readonly body: Record<string, unknown> };

declare module 'fastify' {
  interface FastifyRequest {
    /** Set once per request by the onRequest hook in server.ts. */
    erpAuth: AuthOutcome | null;
  }
}

/** The identity the onRequest hook established — the only source handlers read. */
export function requestAuth(req: FastifyRequest): AuthOutcome {
  return req.erpAuth ?? { kind: 'anonymous' };
}

export interface RequestLike {
  readonly method: string;
  /** Path + query as received. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly protocol?: string;
}

function header(req: RequestLike, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The absolute URL the client called, for DPoP htu. Query is irrelevant to htu. */
export function requestUrl(opts: Pick<ContextOptions, 'publicUrl'>, req: RequestLike): string {
  const path = req.url.split('?')[0] ?? '/';
  if (opts.publicUrl) {
    const base = opts.publicUrl.endsWith('/') ? opts.publicUrl.slice(0, -1) : opts.publicUrl;
    return `${base}${path}`;
  }
  const host = header(req, 'host') ?? 'localhost';
  return `${req.protocol ?? 'http'}://${host}${path}`;
}

export async function authenticateRequest(opts: ContextOptions, req: RequestLike): Promise<AuthOutcome> {
  const auth = header(req, 'authorization');
  if (!auth) return { kind: 'anonymous' };

  if (auth.startsWith('DPoP ')) {
    if (!opts.identity) return { kind: 'anonymous', why: 'device sign-in is not configured' };
    try {
      const identity = await opts.identity.authenticate(auth.slice('DPoP '.length), {
        method: req.method,
        url: requestUrl(opts, req),
        dpop: header(req, 'dpop'),
      });
      return { kind: 'identity', identity };
    } catch (err) {
      if (err instanceof IdentityError) {
        // 401 stays "anonymous" so tRPC answers UNAUTHORIZED in its own
        // envelope; every other refusal is final and carries its own body.
        if (err.status === 401) return { kind: 'anonymous', why: err.message };
        return { kind: 'refused', status: err.status, body: err.toBody() };
      }
      throw err;
    }
  }

  if (auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length);
    // A device token presented as a bare bearer has been stripped of its
    // proof-of-possession. It is refused, never downgraded.
    if (looksLikeDeviceToken(token)) return { kind: 'anonymous', why: 'device tokens require DPoP' };
    if (!opts.jwtSecret) return { kind: 'anonymous' };
    try {
      return { kind: 'identity', identity: await verifyToken(opts.jwtSecret, token) };
    } catch {
      return { kind: 'anonymous' };
    }
  }

  return { kind: 'anonymous' };
}

/**
 * The dev-bearer form, kept for callers that only have a header. Production
 * requests go through `authenticateRequest` (server.ts), which also handles
 * the DPoP scheme.
 */
export async function createContextFromHeader(
  opts: ContextOptions,
  authorizationHeader: string | undefined,
): Promise<Context> {
  const outcome = await authenticateRequest(opts, {
    method: 'GET',
    url: '/',
    headers: { authorization: authorizationHeader },
  });
  return { deps: opts.deps, identity: outcome.kind === 'identity' ? outcome.identity : null };
}
