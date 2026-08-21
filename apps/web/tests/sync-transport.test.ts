/**
 * The HTTP transport for POST /sync/upload, against a mocked fetch. The wire
 * shape is `@erp/contracts`' `uploadBodySchema` — `{ops: [...]}` in,
 * `{acks: [...]}` out — and NOTHING in an op names a tenant.
 *
 * The fixture ops carry REAL UUIDs and a REAL HLC. They used to carry `'k-1'`
 * and a datetime where the HLC belongs, which the server's envelope schema
 * would have refused — a transport test whose fixtures the server rejects
 * proves the transport works against a wire nobody speaks.
 */
import { describe, expect, it } from 'vitest';
import type { FetchInitLike, FetchLike } from '../src/data/sync/credentials';
import { httpUploadTransport, wireKind } from '../src/data/sync/transport';
import type { PendingOp } from '../src/data/sync/upload';

const KEY_1 = '018f0c4c-0000-7000-8000-000000000001';
const KEY_2 = '018f0c4c-0000-7000-8000-000000000002';
const HLC = `1755000000000-00000-${'ab'.repeat(16)}`;

function op(overrides: Partial<PendingOp> = {}): PendingOp {
  return {
    id: KEY_1,
    idempotencyKey: KEY_1,
    claimedHlc: HLC,
    kind: 'sale',
    payloadJson: JSON.stringify({ locationId: KEY_2, clientTotalMinor: '100' }),
    createdAt: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

function makeFetch(respond: () => { status: number; body: unknown } | 'throw'): {
  fetchFn: FetchLike;
  calls: { url: string; init: FetchInitLike }[];
} {
  const calls: { url: string; init: FetchInitLike }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const out = respond();
    if (out === 'throw') throw new Error('network down');
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: () => Promise.resolve(out.body),
    };
  };
  return { fetchFn, calls };
}

describe('httpUploadTransport', () => {
  it('POSTs the batch to /sync/upload with the bearer, in wire shape and order', async () => {
    const { fetchFn, calls } = makeFetch(() => ({
      status: 200,
      body: { acks: [{ key: 'k-1', status: 'applied' }, { key: 'k-2', status: 'applied' }] },
    }));
    const transport = httpUploadTransport({
      apiUrl: 'http://localhost:3001',
      apiToken: 'dev-api-jwt',
      fetchFn,
    });

    const result = await transport.send([
      op(),
      op({ id: KEY_2, idempotencyKey: KEY_2, claimedHlc: null }),
    ]);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:3001/sync/upload');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers['authorization']).toBe('Bearer dev-api-jwt');

    const body = JSON.parse(calls[0]?.init.body ?? '{}') as {
      ops: Record<string, unknown>[];
    };
    expect(body.ops).toHaveLength(2);
    const first = body.ops[0];
    expect(first?.['idempotency_key']).toBe(KEY_1);
    expect(first?.['kind']).toBe('sale.create'); // outbox 'sale' → wire discriminator
    expect(first?.['client_wall_at']).toBe('2026-08-21T09:00:00.000Z');
    expect(typeof first?.['claimed_hlc']).toBe('string');
    expect(first?.['payload']).toEqual({ locationId: KEY_2, clientTotalMinor: '100' });
    // Money crossed the wire as a decimal STRING (ADR-0004), and no tenant id
    // appears anywhere in the op.
    expect((first?.['payload'] as Record<string, unknown>)['clientTotalMinor']).toBe('100');
    expect(JSON.stringify(first)).not.toContain('tenant');
    // Absent claimed_hlc is OMITTED, not null (the api schema is .strict()).
    expect('claimed_hlc' in (body.ops[1] ?? {})).toBe(false);
  });

  it('parses acks on 200 and hands them through untouched', async () => {
    const { fetchFn } = makeFetch(() => ({
      status: 200,
      body: {
        acks: [{ key: KEY_1, status: 'rejected', reason: 'BAD_REQUEST: nope' }],
      },
    }));
    const transport = httpUploadTransport({ apiUrl: 'http://x', apiToken: 't', fetchFn });
    const result = await transport.send([op()]);
    expect(result.acks).toEqual([{ key: KEY_1, status: 'rejected', reason: 'BAD_REQUEST: nope' }]);
  });

  it('a non-200 is ok:false with no acks — the drain then completes nothing', async () => {
    const { fetchFn } = makeFetch(() => ({ status: 401, body: { error: 'UNAUTHORIZED' } }));
    const transport = httpUploadTransport({ apiUrl: 'http://x', apiToken: 't', fetchFn });
    const result = await transport.send([op()]);
    expect(result).toEqual({ ok: false, status: 401, acks: [] });
  });

  it('a malformed ack body is ok:false — never guessed at', async () => {
    const { fetchFn } = makeFetch(() => ({ status: 200, body: { acks: [{ nope: 1 }] } }));
    const transport = httpUploadTransport({ apiUrl: 'http://x', apiToken: 't', fetchFn });
    const result = await transport.send([op()]);
    expect(result.ok).toBe(false);
  });

  it('a network failure is ok:false status 0', async () => {
    const { fetchFn } = makeFetch(() => 'throw');
    const transport = httpUploadTransport({ apiUrl: 'http://x', apiToken: 't', fetchFn });
    const result = await transport.send([op()]);
    expect(result).toEqual({ ok: false, status: 0, acks: [] });
  });

  it('unknown kinds pass through verbatim — the server dead-letters them VISIBLY', () => {
    expect(wireKind('sale')).toBe('sale.create');
    expect(wireKind('somekind.future')).toBe('somekind.future');
  });

  it('refuses to ship an op the contract envelope would reject, without a round trip', async () => {
    // A key that is not a UUID would refuse the WHOLE batch server-side and
    // apply nothing. Catching it here costs no round trip and leaves every op
    // pending (never completed, never lost) — the §8.4 stuck state surfaces it.
    const { fetchFn, calls } = makeFetch(() => ({ status: 200, body: { acks: [] } }));
    const transport = httpUploadTransport({ apiUrl: 'http://x', apiToken: 't', fetchFn });
    const result = await transport.send([op({ id: 'k-1', idempotencyKey: 'k-1' })]);
    expect(result).toEqual({ ok: false, status: 0, acks: [] });
    expect(calls).toHaveLength(0);
  });
});
