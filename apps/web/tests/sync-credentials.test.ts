/**
 * CLAUDE.md §2.7 category 2: credential exchange is sync logic. Mocked fetch
 * — no live service. fetchCredentials must cache until NEAR expiry, refresh
 * on time or on invalidate, deduplicate concurrent fetches, and never invent
 * credentials on a failure.
 */
import { describe, expect, it } from 'vitest';
import {
  CredentialCache,
  TokenEndpointError,
  type FetchInitLike,
  type FetchLike,
} from '../src/data/sync/credentials';

interface Call {
  readonly url: string;
  readonly init: FetchInitLike;
}

function makeFetch(
  respond: (call: Call) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
): { fetchFn: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const { status, body } = await respond(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    };
  };
  return { fetchFn, calls };
}

const POWERSYNC_URL = 'http://localhost:8080';
const API_URL = 'http://localhost:3001';
const T0 = Date.parse('2026-08-21T09:00:00.000Z');
const EXPIRES = '2026-08-21T09:05:00.000Z'; // 5-minute token, per the contract

function cacheWith(fetchFn: FetchLike, now: () => number): CredentialCache {
  return new CredentialCache({
    apiUrl: API_URL,
    apiToken: 'dev-api-jwt',
    powersyncUrl: POWERSYNC_URL,
    fetchFn,
    nowMs: now,
  });
}

describe('credential exchange', () => {
  it('GETs /sync/token with the API bearer and returns the configured endpoint', async () => {
    const { fetchFn, calls } = makeFetch(() => ({
      status: 200,
      body: { token: 'ps-token-1', expires_at: EXPIRES, endpoint: 'http://elsewhere:9' },
    }));
    const cache = cacheWith(fetchFn, () => T0);

    const creds = await cache.get();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:3001/sync/token');
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.headers['authorization']).toBe('Bearer dev-api-jwt');
    expect(creds.token).toBe('ps-token-1');
    expect(creds.expiresAtMs).toBe(Date.parse(EXPIRES));
    // Configuration is authoritative for where the client connects — the
    // response's endpoint field is advisory only.
    expect(creds.endpoint).toBe(POWERSYNC_URL);
  });

  it('caches while comfortably valid — one fetch serves repeated gets', async () => {
    const { fetchFn, calls } = makeFetch(() => ({
      status: 200,
      body: { token: 'ps-token-1', expires_at: EXPIRES },
    }));
    let now = T0;
    const cache = cacheWith(fetchFn, () => now);

    await cache.get();
    now = T0 + 120_000; // 2 min in; 3 min of validity left
    const again = await cache.get();

    expect(calls).toHaveLength(1);
    expect(again.token).toBe('ps-token-1');
  });

  it('refreshes once NEAR expiry, before the token actually dies', async () => {
    let counter = 0;
    const { fetchFn, calls } = makeFetch(() => {
      counter += 1;
      return {
        status: 200,
        body: { token: `ps-token-${counter}`, expires_at: EXPIRES },
      };
    });
    let now = T0;
    const cache = cacheWith(fetchFn, () => now);

    await cache.get();
    // 30s BEFORE expiry — inside the 60s refresh skew, token still "valid".
    now = Date.parse(EXPIRES) - 30_000;
    const refreshed = await cache.get();

    expect(calls).toHaveLength(2);
    expect(refreshed.token).toBe('ps-token-2');
  });

  it('invalidate() drops the cache so the next get refetches', async () => {
    let counter = 0;
    const { fetchFn, calls } = makeFetch(() => {
      counter += 1;
      return { status: 200, body: { token: `ps-token-${counter}`, expires_at: EXPIRES } };
    });
    const cache = cacheWith(fetchFn, () => T0);

    await cache.get();
    cache.invalidate();
    const fresh = await cache.get();

    expect(calls).toHaveLength(2);
    expect(fresh.token).toBe('ps-token-2');
  });

  it('a non-200 throws and poisons nothing — the next get retries', async () => {
    let status = 503;
    const { fetchFn, calls } = makeFetch(() => ({
      status,
      body: status === 200 ? { token: 'ps-token-ok', expires_at: EXPIRES } : { error: 'down' },
    }));
    const cache = cacheWith(fetchFn, () => T0);

    await expect(cache.get()).rejects.toBeInstanceOf(TokenEndpointError);
    status = 200;
    const creds = await cache.get();

    expect(calls).toHaveLength(2);
    expect(creds.token).toBe('ps-token-ok');
  });

  it('a malformed body throws rather than inventing credentials', async () => {
    const { fetchFn } = makeFetch(() => ({ status: 200, body: { nope: true } }));
    const cache = cacheWith(fetchFn, () => T0);
    await expect(cache.get()).rejects.toBeInstanceOf(TokenEndpointError);
  });

  it('concurrent gets share ONE fetch', async () => {
    let resolveBody: ((v: { status: number; body: unknown }) => void) | null = null;
    const { fetchFn, calls } = makeFetch(
      () =>
        new Promise<{ status: number; body: unknown }>((resolve) => {
          resolveBody = resolve;
        }),
    );
    const cache = cacheWith(fetchFn, () => T0);

    const p1 = cache.get();
    const p2 = cache.get();
    expect(resolveBody).not.toBeNull();
    (resolveBody as unknown as (v: { status: number; body: unknown }) => void)({
      status: 200,
      body: { token: 'ps-token-1', expires_at: EXPIRES },
    });
    const [a, b] = await Promise.all([p1, p2]);

    expect(calls).toHaveLength(1);
    expect(a.token).toBe('ps-token-1');
    expect(b.token).toBe('ps-token-1');
  });
});
