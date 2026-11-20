/**
 * The identity HTTP surface (02-security §2.2, §2.7). Plain Fastify routes,
 * not tRPC, because three of them authenticate a device that has NO access
 * token yet — the request's own DPoP proof is the credential — and because the
 * revoked-device answer must be a real `423`, which tRPC has no code for.
 *
 *   GET  /.well-known/jwks.json      our token-signing PUBLIC keys. The
 *                                    self-hosted PowerSync service verifies
 *                                    sync tokens against this (client_auth
 *                                    jwks_uri, infra/powersync/config.yaml).
 *   GET  /.well-known/lease-jwks.json  the LEASE public keys (separate ring).
 *   GET  /auth/config                what the PWA needs to start OIDC sign-in.
 *   POST /auth/enrol                 code + public key + DPoP from that key.
 *   POST /auth/session               IdP id_token + device DPoP → session.
 *   POST /auth/refresh               rotating refresh credential + DPoP.
 *   POST /auth/sign-out              (authenticated) revoke this session.
 *   GET  /auth/lease                 (authenticated) a fresh offline lease.
 *   POST /sync/revoked-drain         a REVOKED device's outbox → reviews.
 *                                    Posts NOTHING into the books.
 *   POST /sync/revoked-drain/abandoned  the bare count it could not deliver.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  drainAbandonedRequest,
  enrolRequest,
  refreshRequest,
  sessionRequest,
  uploadBodySchema,
} from '@erp/contracts';
import { requestAuth, requestUrl, type ContextOptions } from '../context.js';
import { IdentityError, type IdentityService } from './service.js';

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof IdentityError) return reply.code(err.status).send(err.toBody());
  throw err;
}

export async function registerIdentityRoutes(app: FastifyInstance, opts: ContextOptions): Promise<void> {
  const svc: IdentityService | undefined = opts.identity;

  app.get('/.well-known/jwks.json', async (_req, reply) => {
    if (!svc) return reply.code(404).send({ error: 'not_configured' });
    // Public keys only; short cache so a rotation propagates within minutes.
    return reply.header('cache-control', 'public, max-age=300').send(svc.jwks());
  });

  app.get('/.well-known/lease-jwks.json', async (_req, reply) => {
    if (!svc) return reply.code(404).send({ error: 'not_configured' });
    return reply.header('cache-control', 'public, max-age=300').send(svc.leaseJwks());
  });

  app.get('/auth/config', async (_req, reply) => {
    if (!svc) return reply.send({ oidc: null });
    try {
      return reply.send(await svc.authConfig());
    } catch (err) {
      return reply.code(503).send({ error: 'oidc_unavailable', message: err instanceof Error ? err.message : String(err) });
    }
  });

  const proof = (req: FastifyRequest) =>
    svc!.proveDevice({ method: req.method, url: requestUrl(opts, req), dpop: header(req, 'dpop') });

  app.post('/auth/enrol', async (req, reply) => {
    if (!svc) return reply.code(404).send({ error: 'not_configured' });
    const parsed = enrolRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    try {
      const p = await proof(req);
      return reply.send(await svc.enrol(parsed.data, p, req.ip));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/auth/session', async (req, reply) => {
    if (!svc) return reply.code(404).send({ error: 'not_configured' });
    const parsed = sessionRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    try {
      return reply.send(await svc.signIn(parsed.data, await proof(req)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/auth/refresh', async (req, reply) => {
    if (!svc) return reply.code(404).send({ error: 'not_configured' });
    const parsed = refreshRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    try {
      return reply.send(await svc.refresh(parsed.data, await proof(req)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/auth/sign-out', async (req, reply) => {
    const auth = requestAuth(req);
    if (!svc || auth.kind !== 'identity' || auth.identity.authKind !== 'device') {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    await svc.signOut(auth.identity);
    return reply.send({ ok: true });
  });

  app.get('/auth/lease', async (req, reply) => {
    const auth = requestAuth(req);
    if (!svc || auth.kind !== 'identity' || auth.identity.authKind !== 'device') {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return reply.send(await svc.lease(auth.identity));
  });

  // ---- drain before wipe (§2.7) -------------------------------------------
  app.post('/sync/revoked-drain', async (req, reply) => {
    if (!svc) return reply.code(404).send({ error: 'not_configured' });
    // The SAME envelope as /sync/upload, so the outbox drains into here with
    // no second payload shape — and the same batch cap.
    const parsed = uploadBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    try {
      const p = await proof(req);
      return reply.send(await svc.drain(p, parsed.data.ops));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/sync/revoked-drain/abandoned', async (req, reply) => {
    if (!svc) return reply.code(404).send({ error: 'not_configured' });
    const parsed = drainAbandonedRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    try {
      await svc.drainAbandoned(await proof(req), parsed.data.undrainedCount);
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
