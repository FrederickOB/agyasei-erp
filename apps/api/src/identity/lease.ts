/**
 * The offline lease (02 §2.7 "The offline session — an explicit decision").
 *
 * Three credentials, deliberately separate: the 15-minute access token and the
 * device refresh credential work ONLINE only; the lease is what authorises
 * local operation while unreachable, and it decays in two steps so the
 * business loses its risk exposure before it loses its ability to trade:
 *
 *   0 → full_until (T, default 72 h)        full: every permission whose
 *                                           offline_mode is until_lease_expiry
 *                                           or always
 *   full_until → hard_stop_at (+24 h)        restricted: offline_mode = always
 *                                           only — cash at list price, lookups,
 *                                           reprints. No credit, no adjustments
 *   after hard_stop_at                      sealed: read-only, never wiped
 *
 * Signed by the LEASE ring, never the token ring: different rotation schedule
 * (annual, two-key overlap) and a different failure mode — a device that
 * cannot verify a new lease keeps the horizons of the last one it did verify
 * rather than sealing, so a key-rotation mistake is not a fleet outage.
 *
 * `issued_at` is the SERVER clock — the only trustworthy timestamp here. The
 * device enforces expiry against whichever fires first of: wall clock past
 * full_until; monotonic elapsed since issue past T; the wall clock jumping
 * backwards (apps/web/src/data/auth/lease.ts).
 */
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  LEASE_DEFAULT_FULL_S,
  LEASE_DEFAULT_GRACE_S,
  LEASE_MAX_FULL_S,
  type LeaseClaims,
  type LeaseEnvelope,
  type OfflineMode,
} from '@erp/contracts';
import { SIGNING_ALG, type KeyRing } from './keys.js';

export const LEASE_TYP = 'erp-lease+jwt';
export const LEASE_AUDIENCE = 'erp-lease';

export interface LeasePolicy {
  /** T, seconds. Capped at the platform ceiling of 14 days. */
  readonly fullS: number;
  /** The restricted-mode grace after T, seconds. */
  readonly graceS: number;
}

export const DEFAULT_LEASE_POLICY: LeasePolicy = {
  fullS: LEASE_DEFAULT_FULL_S,
  graceS: LEASE_DEFAULT_GRACE_S,
};

export function leasePolicy(fullS: number, graceS: number): LeasePolicy {
  if (!Number.isInteger(fullS) || fullS <= 0) throw new Error('lease: T must be a positive whole number of seconds');
  if (fullS > LEASE_MAX_FULL_S) {
    // §2.7: tenant-configurable up to a platform ceiling of 14 days. Above it
    // is refused, not clamped — a configuration that asks for 30 days must
    // fail loudly, not quietly get 14.
    throw new Error(`lease: T of ${fullS}s exceeds the platform ceiling of ${LEASE_MAX_FULL_S}s (14 days)`);
  }
  if (!Number.isInteger(graceS) || graceS < 0 || graceS > fullS) {
    throw new Error('lease: grace must be between 0 and T');
  }
  return { fullS, graceS };
}

export interface LeaseGrant {
  readonly code: string;
  readonly locationId: string;
}

export interface LeaseInput {
  readonly tid: string;
  readonly sub: string;
  readonly did: string;
  /** user_location_scope ∩ device ceiling, expanded. */
  readonly scope: readonly string[];
  /** The user's grants within that scope (code at location). */
  readonly grants: readonly LeaseGrant[];
  /** platform.permission.offline_mode, the single source of the sets. */
  readonly offlineModes: ReadonlyMap<string, OfflineMode>;
}

/**
 * The snapshot hash binds the lease to the exact permission set it was issued
 * against; a device can tell a changed grant from an unchanged one without
 * the server shipping the grants themselves.
 */
export function permissionSnapshotHash(grants: readonly LeaseGrant[]): string {
  const lines = [...new Set(grants.map((g) => `${g.code}@${g.locationId}`))].sort();
  return `sha256:${createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')}`;
}

export function leaseClaimsFor(input: LeaseInput, policy: LeasePolicy, nowS: number): LeaseClaims {
  const scope = new Set(input.scope);
  const inScope = input.grants.filter((g) => scope.has(g.locationId));
  const always = new Set<string>();
  const untilExpiry = new Set<string>();
  for (const g of inScope) {
    const mode = input.offlineModes.get(g.code) ?? 'never';
    if (mode === 'always') always.add(g.code);
    else if (mode === 'until_lease_expiry') untilExpiry.add(g.code);
    // `never` is not on the lease at all: it has never worked offline.
  }
  const fullUntil = nowS + policy.fullS;
  return {
    tid: input.tid,
    sub: input.sub,
    did: input.did,
    scope: [...scope].sort(),
    permission_snapshot_hash: permissionSnapshotHash(inScope),
    offline: { always: [...always].sort(), until_lease_expiry: [...untilExpiry].sort() },
    issued_at: nowS,
    full_until: fullUntil,
    hard_stop_at: fullUntil + policy.graceS,
  };
}

export async function signLease(ring: KeyRing, issuer: string, claims: LeaseClaims): Promise<LeaseEnvelope> {
  const lease = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: SIGNING_ALG, kid: ring.active.kid, typ: LEASE_TYP })
    .setIssuer(issuer)
    .setAudience(LEASE_AUDIENCE)
    .setIssuedAt(claims.issued_at)
    .setExpirationTime(claims.hard_stop_at)
    .sign(ring.active.privateKey);
  // Every lease carries the CURRENT and PREVIOUS lease public keys, so a
  // device that syncs at all keeps both pins fresh (§2.7, two-key overlap).
  return { lease, keys: { keys: ring.jwks().keys.map((k) => ({ ...k }) as Record<string, unknown>) } };
}
