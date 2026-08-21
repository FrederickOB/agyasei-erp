/**
 * The HTTP transport for POST /sync/upload, against a mocked fetch. The wire
 * shape is the api contract (apps/api/src/sync.ts): `{ops: [...]}` in,
 * `{acks: [...]}` out — and NOTHING in an op names a tenant.
 */
import { describe, expect, it } from 'vitest';
import type { FetchInitLike, FetchLike } from '../src/data/sync/credentials';
import { httpUploadTransport, wireKind } from '../src/data/sync/transport';
import type { PendingOp } from '../src/data/sync/upload';

function op(overrides: Partial<PendingOp> = {}): PendingOp {
  return {
    id: 'k-1',
    idempotencyKey: 'k-1',
    claimedHlc: '2026-08-21T09:00:00.000Z-0000-abababababababababababababababab',
    kind: 'sale',
    payloadJson: JSON.stringify({ kind: 'sale', sale_id: 'k-1', total_minor: '100' }),
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
      op({ id: 'k-2', idempotencyKey: 'k-2', claimedHlc: null }),
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
    expect(first?.['idempotency_key']).toBe('k-1');
    expect(first?.['kind']).toBe('sale.create'); // outbox 'sale' → wire discriminator
    expect(first?.['client_wall_at']).toBe('2026-08-21T09:00:00.000Z');
    expect(typeof first?.['claimed_hlc']).toBe('string');
    expect(first?.['payload']).toEqual({ kind: 'sale', sale_id: 'k-1', total_minor: '100' });
    // Money crossed the wire as a decimal STRING (ADR-0004), and no tenant id
    // appears anywhere in the op.
    expect((first?.['payload'] as Record<string, unknown>)['total_minor']).toBe('100');
    expect(JSON.stringify(first)).not.toContain('tenant');
    // Absent claimed_hlc is OMITTED, not null (the api schema is .strict()).
    expect('claimed_hlc' in (body.ops[1] ?? {})).toBe(false);
  });

  it('parses acks on 200 and hands them through untouched', async () => {
    const { fetchFn } = makeFetch(() => ({
      status: 200,
      body: {
        acks: [{ key: 'k-1', status: 'rejected', reason: 'BAD_REQUEST: nope' }],
      },
    }));
    const transport = httpUploadTransport({ apiUrl: 'http://x', apiToken: 't', fetchFn });
    const result = await transport.send([op()]);
    expect(result.acks).toEqual([{ key: 'k-1', status: 'rejected', reason: 'BAD_REQUEST: nope' }]);
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
});
