/**
 * The identity wire — enrolment, sign-in, refresh, the offline lease, and the
 * revoked-device drain (02-security §2.2, §2.7).
 *
 * Shared by `apps/api` (which parses requests and builds responses) and
 * `apps/web` (which builds requests and parses responses), so a renamed field
 * is a compile error rather than a till that cannot sign in.
 *
 * NOTHING HERE CARRIES A TENANT the client may assert. `tenantId` appears in
 * RESPONSES only — the server telling an enrolled device which tenant it now
 * belongs to, so it can open the right local database (08 §8.1a). No request
 * schema has a tenant, device, user or location field: the device is proven by
 * its DPoP key, the user by the IdP, the tenant derived from both server-side.
 */
import { z } from 'zod';
import { zUuid } from './wire.js';

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** ADR-0003 A1: tablet primary; laptop and phone secondary. Descriptive only. */
export const DEVICE_FORM_FACTORS = ['tablet', 'phone', 'laptop'] as const;
export type DeviceFormFactor = (typeof DEVICE_FORM_FACTORS)[number];

/** §2.7's retirement reasons. `stolen` closes the drain window to zero. */
export const DEVICE_RETIRED_REASONS = ['lost', 'stolen', 'damaged', 'decommissioned', 'replaced'] as const;
export type DeviceRetiredReason = (typeof DEVICE_RETIRED_REASONS)[number];

/** A public P-256 JWK — the device key's public half. Never carries `d`. */
export const publicEcJwk = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type PublicEcJwk = z.infer<typeof publicEcJwk>;

/** POST /auth/enrol — a DPoP proof from the SAME key must accompany it. */
export const enrolRequest = z
  .object({
    /** As typed by a person: case, hyphens and O/0 I/L/1 confusions forgiven. */
    code: z.string().min(8).max(16),
    publicJwk: publicEcJwk,
    /** Client-generated UUIDv7. A retry of the same request replays, never re-burns. */
    idempotencyKey: zUuid,
    appVersion: z.string().max(40).optional(),
  })
  .strict();
export type EnrolRequest = z.infer<typeof enrolRequest>;

export const enrolResponse = z.object({
  deviceId: zUuid,
  /** The tenant this device now belongs to — SERVER-DERIVED from the code. */
  tenantId: zUuid,
  label: z.string(),
  formFactor: z.enum(DEVICE_FORM_FACTORS),
  /** The device ceiling's nodes (unexpanded). Empty = a laptop that syncs nothing. */
  locationIds: z.array(zUuid),
});
export type EnrolResponse = z.infer<typeof enrolResponse>;

// ---------------------------------------------------------------------------
// Sign-in, refresh
// ---------------------------------------------------------------------------

/** GET /auth/config — public: what the PWA needs to start an OIDC sign-in. */
export const authConfigResponse = z.object({
  oidc: z
    .object({
      issuer: z.string(),
      clientId: z.string(),
      authorizationEndpoint: z.string(),
      tokenEndpoint: z.string(),
      scope: z.string(),
    })
    .nullable(),
});
export type AuthConfigResponse = z.infer<typeof authConfigResponse>;

/**
 * POST /auth/session. `nonce` is what the PWA sent the IdP; it MUST be
 * `${deviceJkt}.${random}` — the server checks the prefix against the PROVEN
 * key, which binds the id_token to this device.
 */
export const sessionRequest = z
  .object({
    idToken: z.string().min(16).max(16_384),
    nonce: z.string().min(60).max(200),
  })
  .strict();
export type SessionRequest = z.infer<typeof sessionRequest>;

/** POST /auth/refresh — device-key-bound: DPoP from the enrolled key required. */
export const refreshRequest = z
  .object({
    refreshToken: z.string().min(40).max(200),
  })
  .strict();
export type RefreshRequest = z.infer<typeof refreshRequest>;

/** A lease plus the lease PUBLIC keys it should verify under (pins refresh on every sync). */
export const leaseEnvelope = z.object({
  lease: z.string().min(16),
  keys: z.object({ keys: z.array(z.record(z.unknown())) }),
});
export type LeaseEnvelope = z.infer<typeof leaseEnvelope>;

export const sessionResponse = z.object({
  accessToken: z.string(),
  /** Epoch seconds. */
  accessExpiresAt: z.number().int(),
  /** Rotating, device-key-bound. Each refresh returns a new one; the old is dead. */
  refreshToken: z.string(),
  sessionId: zUuid,
  userId: zUuid,
  displayName: z.string(),
  deviceId: zUuid,
  tenantId: zUuid,
  /** The device ceiling ∩ this user's scope, unexpanded — where this session may act. */
  locationIds: z.array(zUuid),
  lease: leaseEnvelope.nullable(),
});
export type SessionResponse = z.infer<typeof sessionResponse>;

// ---------------------------------------------------------------------------
// The offline lease (§2.7)
// ---------------------------------------------------------------------------

/** Platform ceiling on T: 14 days. Tenant-configurable up to it (not yet built). */
export const LEASE_MAX_FULL_S = 14 * 24 * 60 * 60;
export const LEASE_DEFAULT_FULL_S = 72 * 60 * 60;
export const LEASE_DEFAULT_GRACE_S = 24 * 60 * 60;

export const OFFLINE_MODES = ['never', 'until_lease_expiry', 'always'] as const;
export type OfflineMode = (typeof OFFLINE_MODES)[number];

/**
 * The lease's claims. Signed by a DEDICATED lease key (not the token key),
 * typ `erp-lease+jwt`. Timestamps are SERVER clock, epoch seconds.
 */
export const leaseClaims = z.object({
  tid: zUuid,
  sub: zUuid,
  did: zUuid,
  /** user_location_scope ∩ device_location_scope, expanded, syncable kinds. */
  scope: z.array(zUuid),
  permission_snapshot_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** The codes this user holds within the device's scope, by offline_mode. */
  offline: z.object({
    always: z.array(z.string()),
    until_lease_expiry: z.array(z.string()),
  }),
  issued_at: z.number().int(),
  full_until: z.number().int(),
  hard_stop_at: z.number().int(),
});
export type LeaseClaims = z.infer<typeof leaseClaims>;

// ---------------------------------------------------------------------------
// Revocation: 423, drain, abandon (§2.7 "drain before wipe")
// ---------------------------------------------------------------------------

/**
 * The body of `423 LOCKED` — §3.3.4's retryable set, so the client keeps
 * trying to reach the server instead of giving up and deleting.
 * `drain: 'refused'` is `stolen`: wipe on contact.
 */
export const deviceRevokedBody = z.object({
  error: z.literal('LOCKED'),
  reason: z.literal('device_revoked'),
  drain: z.enum(['allowed', 'refused']),
  /** Epoch seconds after which the server stops accepting the drain. Null when refused. */
  drainUntil: z.number().int().nullable(),
});
export type DeviceRevokedBody = z.infer<typeof deviceRevokedBody>;

/** The drain ack: every op becomes a review; NOTHING is posted to the books. */
export const drainAck = z.object({
  key: z.string(),
  status: z.enum(['quarantined', 'duplicate', 'rejected']),
  reviewId: zUuid.optional(),
  reason: z.string().optional(),
});
export const drainResponse = z.object({ acks: z.array(drainAck) });
export type DrainResponse = z.infer<typeof drainResponse>;

/** POST /sync/revoked-drain/abandoned — a bare count, no payload. */
export const drainAbandonedRequest = z
  .object({ undrainedCount: z.number().int().min(0).max(1_000_000) })
  .strict();
