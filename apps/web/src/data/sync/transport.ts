/**
 * HTTP transport for the outbox drain: `POST {apiUrl}/sync/upload` with the
 * API bearer token (api/src/sync.ts). Body: `{ops: [...]}` — each op carries
 * its idempotency key, its untrusted `claimed_hlc`, its device wall clock and
 * its payload. NOTHING here names a tenant: `tid` lives in the verified
 * token, and any tenant spelling smuggled into a payload is stripped
 * server-side (CLAUDE.md §2.1).
 *
 * A non-200 or a malformed response is returned as `ok: false` — the drain
 * then completes nothing (upload.ts). The transport never interprets acks;
 * it only carries them.
 */
import type { FetchLike, HttpResponseLike } from './credentials';
import type { AckStatus, PendingOp, UploadAck, UploadResult, UploadTransport } from './upload';

/**
 * Outbox `kind` → the wire op discriminator (api/src/sync.ts DEVICE_OPS).
 * Unknown kinds pass through verbatim: the server answers UNKNOWN_KIND, which
 * dead-letters the op into the VISIBLE attention state rather than silently
 * wedging the queue.
 */
export const WIRE_KINDS: Readonly<Record<string, string>> = {
  sale: 'sale.create',
  sequence_block: 'sequence.sync_block',
};

export function wireKind(kind: string): string {
  return WIRE_KINDS[kind] ?? kind;
}

export interface HttpTransportOptions {
  /** API dev server base URL (VITE_API_URL). */
  readonly apiUrl: string;
  /** Dev-only API bearer; real credential exchange is the online login flow (§8.2). */
  readonly apiToken: string;
  readonly fetchFn?: FetchLike;
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  // A locally corrupt payload still ships as an (empty) op: the server's
  // BAD_REQUEST answer dead-letters it VISIBLY instead of wedging the queue.
  return {};
}

function parseAcks(body: unknown): UploadAck[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const acks = (body as Record<string, unknown>)['acks'];
  if (!Array.isArray(acks)) return null;
  const parsed: UploadAck[] = [];
  for (const entry of acks) {
    if (typeof entry !== 'object' || entry === null) return null;
    const rec = entry as Record<string, unknown>;
    const key = rec['key'];
    const status = rec['status'];
    if (typeof key !== 'string') return null;
    if (status !== 'applied' && status !== 'duplicate' && status !== 'rejected') return null;
    const reason = rec['reason'];
    const result = rec['result'];
    parsed.push({
      key,
      status: status as AckStatus,
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(result === undefined ? {} : { result }),
    });
  }
  return parsed;
}

export function httpUploadTransport(opts: HttpTransportOptions): UploadTransport {
  const base = opts.apiUrl.endsWith('/') ? opts.apiUrl.slice(0, -1) : opts.apiUrl;
  const fetchFn: FetchLike =
    opts.fetchFn ??
    ((url, init) =>
      fetch(url, init as RequestInit) as Promise<HttpResponseLike>);

  return {
    async send(ops: readonly PendingOp[]): Promise<UploadResult> {
      const body = {
        ops: ops.map((op) => ({
          idempotency_key: op.idempotencyKey,
          ...(op.claimedHlc !== null ? { claimed_hlc: op.claimedHlc } : {}),
          client_wall_at: op.createdAt,
          kind: wireKind(op.kind),
          payload: parsePayload(op.payloadJson),
        })),
      };
      let res: HttpResponseLike;
      try {
        res = await fetchFn(`${base}/sync/upload`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.apiToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch {
        return { ok: false, status: 0, acks: [] };
      }
      if (!res.ok) return { ok: false, status: res.status, acks: [] };
      let parsedBody: unknown;
      try {
        parsedBody = await res.json();
      } catch {
        return { ok: false, status: res.status, acks: [] };
      }
      const acks = parseAcks(parsedBody);
      if (acks === null) return { ok: false, status: res.status, acks: [] };
      return { ok: true, status: res.status, acks };
    },
  };
}
