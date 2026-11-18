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
import { uploadBodySchema, type DeviceOpKind, type UploadBody } from '@erp/contracts';
import type { FetchLike, HttpResponseLike } from './credentials';
import type { AckStatus, PendingOp, UploadAck, UploadResult, UploadTransport } from './upload';

/**
 * Outbox `kind` → the wire op discriminator.
 *
 * The values are typed as the contract's `DeviceOpKind`, so a kind this client
 * ships that the server has no handler for does not compile. Unknown kinds
 * still pass through verbatim at RUNTIME: the server answers UNKNOWN_KIND,
 * which dead-letters the op into the VISIBLE attention state rather than
 * silently wedging the queue.
 */
export const WIRE_KINDS: Readonly<Record<string, DeviceOpKind>> = {
  sale: 'sale.create',
  // A stock adjustment is TRADE, not configuration, so it rides the same
  // ordered queue as a sale and completes on the same per-key ack
  // (data/mutations/adjustStock.ts). Adding it here is what makes the
  // adjustment screen work with the radio off.
  stock_movement: 'stock.record_movement',
  sequence_block: 'sequence.sync_block',
  // Phase 2. A yard receives goods while partitioned — the truck arrived and
  // the bags are on the ground whether or not the tower is up — and a delivery
  // status is recorded by whoever hears from the driver, wherever they are.
  // Both are TRADE, both ride this ordered queue, and both complete only on
  // their own per-key ack (data/mutations/recordGoodsReceipt.ts,
  // data/mutations/updateDeliveryStatus.ts). PLANNING a delivery and raising or
  // approving a purchase order are deliberately NOT here: those are
  // commitments made against supplier terms and an approval bound a
  // partitioned device may hold a stale copy of, so they go over tRPC and are
  // refused out loud (packages/contracts/src/procurement.ts).
  goods_receipt: 'goods.record_receipt',
  delivery_status: 'logistics.update_delivery_status',
  // A customer paying down their balance is TRADE, the same as a sale: the
  // money is in the drawer whether or not the tower is up, and refusing it
  // offline teaches a clerk to keep the receipt on paper. It is safe to queue
  // where a limit edit is not, because `credit_entry` is an append-only log of
  // SIGNED INTEGERS and exposure is Σ (06 §6.2) — two offline batches arriving
  // in either order produce the same sum, so a repayment has no conflict case
  // for a review queue to hold. The builder narrows it to PAYMENT
  // (data/mutations/recordRepayment.ts).
  //
  // `credit.open_account` and a limit change are NOT here and must not be:
  // both SET A CREDIT LIMIT, which is a risk judgement 06 §6.6.3(7) requires
  // connectivity for, and a partitioned device cannot see the version it would
  // be superseding. They go over tRPC and are refused out loud
  // (data/api/credit.ts).
  credit_payment: 'credit.record_entry',
  // THE TILL (08 §8.2a). Opening and closing a till are trade, not
  // configuration: an outlet opens at seven whether or not the tower is up,
  // and every sale it rings names the till. Riding THIS ordered queue is what
  // guarantees the open reaches the server before the sales that name it and
  // the close after the last of them (data/mutations/till.ts).
  cash_session_open: 'cash_session.open',
  cash_session_close: 'cash_session.close',
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
      // TYPED AS THE CONTRACT'S ENVELOPE — the same declaration the API's
      // /sync/upload route parses. The envelope used to be hand-rolled here
      // against a schema defined only on the server.
      const body: UploadBody = {
        ops: ops.map((op) => ({
          idempotency_key: op.idempotencyKey,
          ...(op.claimedHlc !== null ? { claimed_hlc: op.claimedHlc } : {}),
          client_wall_at: op.createdAt,
          kind: wireKind(op.kind),
          payload: parsePayload(op.payloadJson),
        })),
      };
      // Prove the batch against the contract before it leaves the device. A
      // malformed envelope refuses the WHOLE batch server-side and applies
      // nothing, so the outcome is identical either way — but caught here it
      // is visible on the device without a round trip. The ops stay pending
      // and the §8.4 "stuck" state surfaces the queue that stopped draining:
      // loud, never lost (§3.3.4 — the unknown case defaults to retry).
      const envelope = uploadBodySchema.safeParse(body);
      if (!envelope.success) {
        return { ok: false, status: 0, acks: [] };
      }

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
