/**
 * The server seam, tested for the four answers a counter actually gets:
 * an answer, no radio, no permission, and something unreadable.
 *
 * The reason this file exists at all is §0 of the phase-1 status report: the
 * project's most reliable defect is a payload declared on one side of the
 * wire and never handed to the other. So these tests drive the REAL request
 * builder — the one the screens call — and assert on the bytes it produces,
 * not on a hand-written envelope that would agree with it by construction.
 */
import { describe, expect, it } from 'vitest';
import {
  apiMutate,
  apiQuery,
  asScaled,
  type ApiEndpoint,
  type ApiFetch,
  type ApiFetchInit,
} from '../src/data/api/client';
import { fetchSalesByLocation } from '../src/data/api/reports';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev-token' };

interface Seen {
  url: string;
  init: ApiFetchInit;
}

function stub(
  reply: { status: number; body: unknown },
  seen: Seen[] = [],
): { fetchFn: ApiFetch; seen: Seen[] } {
  const fetchFn: ApiFetch = (url, init) => {
    seen.push({ url, init });
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: () => Promise.resolve(reply.body),
    });
  };
  return { fetchFn, seen };
}

const identity = (json: unknown): unknown => json;

describe('the tRPC transport', () => {
  it('sends a query as GET with the superjson input envelope and the bearer', async () => {
    const { fetchFn, seen } = stub({ status: 200, body: { result: { data: { json: { ok: 1 } } } } });
    const result = await apiQuery('reports.salesByLocation', { from: 'a', to: 'b' }, identity, {
      endpoint: ENDPOINT,
      fetchFn,
    });

    expect(result.ok).toBe(true);
    const call = seen[0];
    expect(call).toBeDefined();
    expect(call?.init.method).toBe('GET');
    expect(call?.init.headers['authorization']).toBe('Bearer dev-token');
    const url = new URL(call?.url ?? '');
    expect(url.pathname).toBe('/trpc/reports.salesByLocation');
    // The server's transformer unwraps `{json: …}`; a bare object is silently
    // read as `undefined` input, which is how a report for no period at all
    // would get produced.
    expect(JSON.parse(url.searchParams.get('input') ?? 'null')).toEqual({
      json: { from: 'a', to: 'b' },
    });
  });

  it('sends a mutation as POST with the same envelope in the body', async () => {
    const { fetchFn, seen } = stub({ status: 200, body: { result: { data: { json: {} } } } });
    await apiMutate('inventory.setReorderPoint', { a: 1 }, identity, {
      endpoint: ENDPOINT,
      fetchFn,
    });
    expect(seen[0]?.init.method).toBe('POST');
    expect(JSON.parse(seen[0]?.init.body ?? 'null')).toEqual({ json: { a: 1 } });
  });

  it('never names a tenant in a request it builds', async () => {
    const { fetchFn, seen } = stub({ status: 200, body: { result: { data: { json: {} } } } });
    await apiQuery('reports.salesByLocation', { from: 'a', to: 'b' }, identity, {
      endpoint: ENDPOINT,
      fetchFn,
    });
    const sent = `${seen[0]?.url ?? ''}${seen[0]?.init.body ?? ''}`;
    expect(sent).not.toMatch(/tenant/i);
  });
});

describe('the four kinds of no', () => {
  it('calls a failed fetch OFFLINE, in those words, and never an error', async () => {
    const fetchFn: ApiFetch = () => Promise.reject(new Error('network down'));
    const result = await apiQuery('reports.cashPosition', {}, identity, {
      endpoint: ENDPOINT,
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('offline');
    expect(result.failure.message.toLowerCase()).toContain('offline');
    expect(result.failure.message.toLowerCase()).not.toContain('error');
  });

  it('separates a slow link from a dead one', async () => {
    const fetchFn: ApiFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const result = await apiQuery('reports.cashPosition', {}, identity, {
      endpoint: ENDPOINT,
      fetchFn,
      timeoutMs: 5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('timeout');
  });

  it('maps 403 to FORBIDDEN and keeps the server’s own sentence as the detail', async () => {
    const { fetchFn } = stub({
      status: 403,
      body: {
        error: {
          json: {
            message: 'PERMISSION_DENIED: report.view.margin is not held by this user',
            data: { code: 'FORBIDDEN' },
          },
        },
      },
    });
    const result = await apiQuery('reports.inventoryDays', {}, identity, {
      endpoint: ENDPOINT,
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('forbidden');
    expect(result.failure.detail).toContain('report.view.margin');
  });

  it('maps 401 to a sign-in problem and 500 to a server problem', async () => {
    const unauth = await apiQuery('session.permissions', undefined, identity, {
      endpoint: ENDPOINT,
      fetchFn: stub({ status: 401, body: {} }).fetchFn,
    });
    const broken = await apiQuery('session.permissions', undefined, identity, {
      endpoint: ENDPOINT,
      fetchFn: stub({ status: 500, body: {} }).fetchFn,
    });
    expect(unauth.ok || broken.ok).toBe(false);
    if (!unauth.ok) expect(unauth.failure.kind).toBe('unauthenticated');
    if (!broken.ok) expect(broken.failure.kind).toBe('server-error');
  });

  it('says so when this build has no server at all, rather than looking offline', async () => {
    const result = await apiQuery('reports.cashPosition', {}, identity, { endpoint: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('not-configured');
  });
});

describe('a response this device cannot read is loud, never empty', () => {
  it('refuses a 200 that is not in the expected envelope', async () => {
    const { fetchFn } = stub({ status: 200, body: { rows: [] } });
    const result = await apiQuery('reports.salesByLocation', {}, identity, {
      endpoint: ENDPOINT,
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('malformed');
  });

  it('refuses a payload carrying an encoding it was not written to apply', async () => {
    const { fetchFn } = stub({
      status: 200,
      body: { result: { data: { json: {}, meta: { values: { at: ['Date'] } } } } },
    });
    const result = await apiQuery('reports.salesByLocation', {}, identity, {
      endpoint: ENDPOINT,
      fetchFn,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('malformed');
  });

  it('turns a money field that arrived as a JSON number into a refusal', async () => {
    // The whole reason money crosses as a decimal string: a JSON number is a
    // float64 in every consumer. If one ever appears, this device stops rather
    // than rendering a magnitude it cannot vouch for (ADR-0004).
    const { fetchFn } = stub({
      status: 200,
      body: { result: { data: { json: { totalMinor: 115000 } } } },
    });
    const result = await apiQuery(
      'reports.salesByLocation',
      {},
      (json) => asScaled((json as Record<string, unknown>)['totalMinor'], 'totalMinor'),
      { endpoint: ENDPOINT, fetchFn },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('malformed');
    expect(result.failure.detail).toContain('totalMinor');
  });
});

describe('the shared contract is enforced before the request leaves the device', () => {
  it('refuses a reversed date range instead of quietly swapping the ends', async () => {
    let called = false;
    const fetchFn: ApiFetch = () => {
      called = true;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    const result = await fetchSalesByLocation(
      { from: '2026-08-31', to: '2026-08-01' },
      { endpoint: ENDPOINT, fetchFn },
    );
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('invalid-request');
    expect(result.failure.detail).toContain('from must not be after to');
  });

  it('refuses a date that is not a calendar date', async () => {
    const result = await fetchSalesByLocation(
      { from: '2026-02-30', to: '2026-03-01' },
      { endpoint: ENDPOINT, fetchFn: stub({ status: 200, body: {} }).fetchFn },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('invalid-request');
  });

  it('accepts and sends a range the contract is happy with', async () => {
    const { fetchFn, seen } = stub({
      status: 200,
      body: {
        result: {
          data: {
            json: {
              from: '2026-08-01',
              to: '2026-08-07',
              days: 7,
              scope: { network: true, locationCount: 2 },
              locations: [],
              total: {
                saleCount: '0',
                subtotalNetMinor: '0',
                discountMinor: '0',
                netRevenueMinor: '0',
                taxTotalMinor: '0',
                totalMinor: '0',
              },
            },
          },
        },
      },
    });
    const result = await fetchSalesByLocation(
      { from: '2026-08-01', to: '2026-08-07' },
      { endpoint: ENDPOINT, fetchFn },
    );
    expect(seen.length).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.scope.network).toBe(true);
    // Every magnitude is a bigint on this side of the boundary.
    expect(typeof result.data.total.totalMinor).toBe('bigint');
  });
});
