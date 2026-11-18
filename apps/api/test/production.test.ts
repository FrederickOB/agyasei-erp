/**
 * The production server surface: configuration refuses unsafe values without
 * echoing them; /readyz tells the truth about the schema; credential routes
 * are rate limited; bodies are capped per route; and request logs carry no
 * tenant data — not the tRPC input in the query string, not the bearer.
 */
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApiConfig } from '../src/config.js';
import { pathOnly, productionLoggerOptions } from '../src/logging.js';
import { matchPrefix } from '../src/rate-limit.js';
import { readinessCheck } from '../src/readiness.js';
import { buildServer } from '../src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness } from './util.js';

const AUTH = 'a'.repeat(40);
const SYNC = 'b'.repeat(40);

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://erp_api:pw@pooler.example:6543/postgres',
    DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----',
    AUTH_JWT_SECRET: AUTH,
    POWERSYNC_JWT_SECRET: SYNC,
    POWERSYNC_URL: 'https://sync.example',
    CORS_ORIGINS: 'https://app.example',
    ...over,
  };
}

describe('loadApiConfig', () => {
  it('accepts a sound production configuration with safe defaults', () => {
    const c = loadApiConfig(env());
    expect(c).toMatchObject({
      PORT: 8080,
      sslMode: 'verify-full',
      CORS_ORIGINS: ['https://app.example'],
      BODY_LIMIT_BYTES: 1_048_576,
      UPLOAD_BODY_LIMIT_BYTES: 8_388_608,
      TRUST_PROXY: true,
    });
    expect(c.OPERATOR_DATABASE_URL).toBeUndefined(); // operator plane off unless asked for
    expect(c.caCert).toContain('\nMIIB\n'); // escaped newlines from a Fly secret restored
  });

  it.each([
    ['the dev default secret', { AUTH_JWT_SECRET: 'dev-secret-change-me' }, 'AUTH_JWT_SECRET'],
    ['a short secret', { POWERSYNC_JWT_SECRET: 'short' }, 'POWERSYNC_JWT_SECRET'],
    ['one secret for both token kinds', { POWERSYNC_JWT_SECRET: AUTH }, 'POWERSYNC_JWT_SECRET'],
    ['a wildcard origin', { CORS_ORIGINS: '*' }, 'CORS_ORIGINS'],
    ['an origin with a path', { CORS_ORIGINS: 'https://app.example/x' }, 'CORS_ORIGINS'],
    ['a plain-http origin in production', { CORS_ORIGINS: 'http://app.example' }, 'CORS_ORIGINS'],
    ['plain-http sync in production', { POWERSYNC_URL: 'http://sync.example' }, 'POWERSYNC_URL'],
    ['TLS disabled in production', { DATABASE_SSL_MODE: 'disable' }, 'DATABASE_SSL_MODE'],
    ['a non-postgres database URL', { DATABASE_URL: 'mysql://x' }, 'DATABASE_URL'],
    ['a missing database URL', { DATABASE_URL: undefined }, 'DATABASE_URL'],
  ])('refuses %s, naming the variable and never the value', (_label, over, variable) => {
    let message = '';
    try {
      loadApiConfig(env(over));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(variable);
    expect(message).not.toContain(AUTH);
    expect(message).not.toContain('dev-secret-change-me');
    expect(message).not.toContain(':pw@');
  });

  it('allows plain http and no TLS for local development only', () => {
    const c = loadApiConfig(
      env({ NODE_ENV: 'development', CORS_ORIGINS: 'http://localhost:5173', POWERSYNC_URL: 'http://localhost:8080', DATABASE_CA_CERT: undefined }),
    );
    expect(c.sslMode).toBe('disable');
  });
});

describe('readinessCheck', () => {
  const ok = { query: async () => ({ rows: [{ filename: '0001_a.sql' }, { filename: '0002_b.sql' }] as never[] }) };

  it('is ready when every expected migration is applied', async () => {
    expect(await readinessCheck({ ...ok, expectedMigrations: ['0001_a.sql', '0002_b.sql'] })()).toEqual({ ready: true, ahead: [] });
  });

  it('is NOT ready when this build expects a migration the database lacks', async () => {
    const r = await readinessCheck({ ...ok, expectedMigrations: ['0001_a.sql', '0002_b.sql', '0003_c.sql'] })();
    expect(r).toMatchObject({ ready: false, reason: 'migrations_pending', pending: ['0003_c.sql'] });
  });

  it('is ready, and says so, when the database is AHEAD (the expand rollback case)', async () => {
    expect(await readinessCheck({ ...ok, expectedMigrations: ['0001_a.sql'] })()).toEqual({ ready: true, ahead: ['0002_b.sql'] });
  });

  it('is not ready when the database cannot be reached, and caches briefly', async () => {
    let calls = 0;
    let t = 0;
    const check = readinessCheck({
      query: async () => {
        calls += 1;
        throw new Error('ECONNREFUSED');
      },
      expectedMigrations: [],
      now: () => t,
    });
    expect(await check()).toEqual({ ready: false, reason: 'database_unreachable' });
    await check();
    expect(calls).toBe(1);
    t = 10_000;
    await check();
    expect(calls).toBe(2);
  });
});

describe('the production server surface', () => {
  let h: ApiHarness;
  let app: FastifyInstance;
  const lines: string[] = [];
  let ready = true;

  beforeAll(async () => {
    h = await createApiHarness();
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    app = await buildServer({
      deps: h.deps,
      jwtSecret: JWT_SECRET,
      logger: { ...productionLoggerOptions('info'), stream } as never,
      bodyLimit: 64 * 1024,
      sync: { uploadBodyLimit: 512 * 1024 },
      trustProxy: true,
      readiness: async () => (ready ? { ready: true } : { ready: false, reason: 'migrations_pending', pending: ['0099_x.sql'] }),
      rateLimit: { prefixes: ['/sync/token'], max: 3, windowMs: 60_000 },
    });
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it('/readyz is 200 when ready and 503 with a coarse reason when not — migration names stay in the log', async () => {
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    ready = false;
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ready: false, reason: 'migrations_pending' });
    expect(res.body).not.toContain('0099_x.sql');
    ready = true;
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('rate limits the credential exchange per client address, and nothing else', async () => {
    const hit = (ip: string) =>
      app.inject({ method: 'GET', url: '/sync/token', headers: { 'fly-client-ip': ip } }).then((r) => r.statusCode);
    expect([await hit('198.51.100.1'), await hit('198.51.100.1'), await hit('198.51.100.1')]).toEqual([401, 401, 401]);
    const limited = await app.inject({ method: 'GET', url: '/sync/token', headers: { 'fly-client-ip': '198.51.100.1' } });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(await hit('198.51.100.2')).toBe(401); // another address is unaffected
    expect((await app.inject({ method: 'GET', url: '/healthz', headers: { 'fly-client-ip': '198.51.100.1' } })).statusCode).toBe(200);
    expect(matchPrefix('/trpc/session.login', ['/trpc/session'])).toBe('/trpc/session');
    expect(matchPrefix('/trpc/sessions', ['/trpc/session'])).toBeNull();
  });

  it('caps request bodies, with a larger cap for the upload batch only', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(200 * 1024) });
    const trpc = await app.inject({ method: 'POST', url: '/trpc/sales.createSale', headers: { 'content-type': 'application/json' }, payload: big });
    expect(trpc.statusCode).toBe(413);
    const upload = await app.inject({ method: 'POST', url: '/sync/upload', headers: { 'content-type': 'application/json' }, payload: big });
    expect(upload.statusCode).toBe(401); // past the size gate, refused on identity
  });

  it('logs no query-string input and no bearer', async () => {
    lines.length = 0;
    await app.inject({
      method: 'GET',
      url: `/trpc/credit.searchCustomers?input=${encodeURIComponent(JSON.stringify({ q: 'Kwame Mensah' }))}`,
      headers: { authorization: 'Bearer eyJhbGciOi.secret-token-body.sig' },
    });
    const all = lines.join('');
    expect(all).toContain('/trpc/credit.searchCustomers');
    expect(all).not.toContain('Kwame');
    expect(all).not.toContain('secret-token-body');
    expect(pathOnly('/a/b?input=1')).toBe('/a/b');
  });
});
