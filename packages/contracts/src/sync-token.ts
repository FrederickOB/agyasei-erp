/**
 * The `GET /sync/token` response — the OTHER client↔server payload, and the
 * second one that no test had ever checked across both sides.
 *
 * The API built `{token, expires_at, endpoint}` by hand in `sync.ts`; the PWA
 * pulled those three keys out of an `unknown` by hand in
 * `data/sync/credentials.ts`. Neither referenced a shared declaration, so
 * renaming `expires_at` would have broken every device's download path with a
 * `TokenEndpointError` — silently, on reconnect, in the field — and nothing in
 * the suite would have gone red. Same class as the sale payload, opposite
 * direction of travel.
 *
 * It is a RESPONSE, so it is not `.strict()`: adding a field server-side must
 * not break older clients that have never heard of it. Removing or renaming
 * one still fails here, which is the direction that actually breaks devices.
 *
 * `endpoint` is `.optional()` on purpose, and the asymmetry is the point. The
 * client does not use it — the CONFIGURED PowerSync URL is authoritative for
 * where a device connects — so requiring it here would invent a failure mode
 * the client never had, for a field it ignores. The API does send it, and the
 * conformance suite asserts that against the live route rather than against
 * this schema.
 *
 * The token itself is opaque to the client — a short-lived HS256 JWT whose
 * `tid` the API takes from the VERIFIED session and from nothing else
 * (CLAUDE.md §2.1). Nothing in this shape is tenant identity the client may
 * assert.
 */
import { z } from 'zod';
import { leaseEnvelope } from './identity.js';

export const syncTokenResponse = z.object({
  /** The PowerSync client JWT. Opaque to the client. */
  token: z.string().min(1),
  /** Absolute expiry, ISO 8601 with offset. Short-lived (~5 min). */
  expires_at: z.string().datetime({ offset: true }),
  /** Advisory service endpoint; client configuration wins. */
  endpoint: z.string().min(1).optional(),
  /**
   * A fresh offline lease (02 §2.7: "issued by the server on every successful
   * sync"). Present for an enrolled device's session; absent on the dev-token
   * path, which has no device key to bind a lease to.
   */
  lease: leaseEnvelope.optional(),
});

export type SyncTokenResponse = z.infer<typeof syncTokenResponse>;
