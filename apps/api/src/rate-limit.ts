/**
 * Basic rate limiting for credential-exchange routes.
 *
 * A fixed window per (client address, route prefix), in process memory. It
 * exists to make credential stuffing and token-endpoint hammering expensive,
 * not to shape sync traffic — uploads and downloads are governed by the sync
 * protocol's own backpressure (Rule 9.1-B), and are deliberately not listed.
 *
 * Honest limits, stated: per MACHINE (two API machines double the effective
 * ceiling); and keyed on address, which on Ghanaian mobile networks is often
 * a carrier-grade NAT shared by many subscribers — so the default ceiling is
 * generous enough for a whole outlet fleet behind one address (25 outlets ×
 * 4 devices refreshing a 5-minute sync token is ~20 requests a minute).
 *
 * Behind Fly's proxy the client address is `Fly-Client-IP`; elsewhere,
 * Fastify's `request.ip` (with trustProxy set by the caller).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pathOnly } from './logging.js';

export interface RateLimitOptions {
  /** Path prefixes to limit: '/sync/token' matches itself and '/sync/token/…'. */
  readonly prefixes: readonly string[];
  readonly max: number;
  readonly windowMs: number;
  readonly now?: () => number;
  /** Prune when this many keys are tracked. */
  readonly maxKeys?: number;
}

function clientAddress(req: FastifyRequest): string {
  const fly = req.headers['fly-client-ip'];
  if (typeof fly === 'string' && fly.length > 0 && fly.length < 64) return fly;
  return req.ip;
}

export function matchPrefix(path: string, prefixes: readonly string[]): string | null {
  for (const p of prefixes) {
    const base = p.endsWith('/') ? p.slice(0, -1) : p;
    if (path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}.`)) return base;
  }
  return null;
}

export function registerRateLimit(app: FastifyInstance, opts: RateLimitOptions): void {
  if (opts.prefixes.length === 0) return;
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  const windows = new Map<string, { count: number; resetAt: number }>();

  app.addHook('onRequest', async (req, reply) => {
    const prefix = matchPrefix(pathOnly(req.url), opts.prefixes);
    if (prefix === null) return;
    const t = now();
    if (windows.size >= maxKeys) {
      for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
    }
    const key = `${clientAddress(req)}|${prefix}`;
    let w = windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + opts.windowMs };
      windows.set(key, w);
    }
    w.count += 1;
    if (w.count > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((w.resetAt - t) / 1000));
      return reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send({ error: 'RATE_LIMITED: too many requests to this endpoint; retry later' });
    }
    return undefined;
  });
}
