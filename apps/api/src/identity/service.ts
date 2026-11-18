/**
 * THE IDENTITY SERVICE — enrolment, sign-in, refresh, per-request
 * authentication, the offline lease, and the revoked-device drain.
 * (02-security §2.2, §2.5, §2.7; ADR-0003 A1/A4.)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE THE TENANT COMES FROM, at every entry point — the whole point
 * ─────────────────────────────────────────────────────────────────────────
 *   enrol      the enrolment CODE (route: SHA-256 → tenant). Never a field.
 *   sign-in    the device KEY, proven by a DPoP signature (route: jkt →
 *              tenant). The IdP's id_token contributes `iss` + `sub` only,
 *              mapped to a user INSIDE that tenant; no IdP claim names a tenant.
 *   refresh    the device KEY again, plus a rotating secret bound to it.
 *   requests   the access token we signed (`tid`), bound to the key by
 *              cnf.jkt and a fresh DPoP proof on every request.
 *
 * A client-supplied tenant id has no field to arrive in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FAILURE IS CLOSED AND NAMED
 * ─────────────────────────────────────────────────────────────────────────
 * Every refusal is an IdentityError with an HTTP status and a stable code:
 *   401  no valid credential (bad token, bad proof, unknown device, dead session)
 *   403  a valid credential that may not do this (suspended device, inactive user)
 *   423  device_revoked — §3.3.4's retryable set: keep trying, drain, then wipe
 *   429  enrolment rate limit
 *   503  the revocation store could not be read — refused, NOT admitted (§2.2 step 4)
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { calculateJwkThumbprint } from 'jose';
import {
  deterministicUuid,
  uuidv7,
  type HlcClock,
} from '@erp/db';
import type {
  AuthConfigResponse,
  DeviceRevokedBody,
  DrainResponse,
  EnrolRequest,
  EnrolResponse,
  LeaseEnvelope,
  OfflineMode,
  RefreshRequest,
  SessionRequest,
  SessionResponse,
} from '@erp/contracts';
import type { PreTenantRunner, Queryable, TenantRunner } from '../db.js';
import { runIdempotent, type JsonValue } from '../pipeline.js';
import { openConflictReview } from '../routers/sequence.js';
import type { VerifiedIdentity } from '../auth.js';
import { recordIdentityEvent, serverWrite } from './audit.js';
import { DpopRejected, createReplayCache, verifyDpopProof, type ReplayCache, type VerifiedProof } from './dpop.js';
import {
  ENROLMENT_CODE_TTL_S,
  hashEnrolmentCode,
  normaliseEnrolmentCode,
} from './enrolment-code.js';
import type { KeyRing } from './keys.js';
import { DEFAULT_LEASE_POLICY, leaseClaimsFor, signLease, type LeasePolicy } from './lease.js';
import type { IdTokenVerifier, OidcConfig } from './oidc.js';
import {
  ENROL_PER_SOURCE_PER_HOUR,
  ENROL_PER_TENANT_PER_HOUR,
  HOUR_MS,
  createRateLimiter,
  type RateLimiter,
} from './rate-limit.js';
import {
  TokenRejected,
  mintAccessToken,
  mintSyncToken,
  verifyAccessToken,
  type MintedToken,
} from './tokens.js';

export class IdentityError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 423 | 429 | 503,
    readonly code: string,
    message: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
  toBody(): Record<string, unknown> {
    return this.body ?? { error: this.code, message: this.message };
  }
}

/** Something a human must look at now (tenant enrolment limit, an abandoned drain). */
export interface IdentityAlert {
  readonly kind: 'enrolment_rate_limit' | 'drain_abandoned' | 'refresh_reuse';
  readonly tenantId: string;
  readonly deviceId?: string;
  readonly detail: string;
}

export interface IdentityServiceOptions {
  readonly runner: TenantRunner;
  readonly preTenant: PreTenantRunner;
  readonly clock: HlcClock;
  /** Our token issuer — exact `iss` on every token we mint. */
  readonly issuer: string;
  readonly signing: KeyRing;
  /** SEPARATE from `signing` (§2.7). */
  readonly leaseKeys: KeyRing;
  readonly leasePolicy?: LeasePolicy;
  readonly oidc?: { readonly config: OidcConfig; readonly verifier: IdTokenVerifier } | undefined;
  /** Session sliding lifetime and absolute cap (refresh credential horizon). */
  readonly sessionIdleS?: number;
  readonly sessionMaxS?: number;
  readonly replay?: ReplayCache;
  readonly perSource?: RateLimiter;
  readonly perTenant?: RateLimiter;
  /** How long a revocation-store answer may be reused. Default 5 s. */
  readonly revocationCacheMs?: number;
  readonly onAlert?: (alert: IdentityAlert) => void;
  readonly nowMs?: () => number;
}

/** Device sessions: 30 days sliding, 90 days absolute — then an online IdP sign-in. */
export const SESSION_IDLE_S = 30 * 24 * 60 * 60;
export const SESSION_MAX_S = 90 * 24 * 60 * 60;
/** §2.7 step 5: the client wipes 24 h after its first 423; the server allows an hour's slack. */
export const DRAIN_WINDOW_S = 25 * 60 * 60;

export interface RequestProof {
  readonly method: string;
  readonly url: string;
  readonly dpop: string | undefined;
}

interface DeviceRow {
  id: string;
  jkt: string;
  status: 'active' | 'suspended' | 'retired';
  retired_reason: string | null;
  drain_opened_at: string | null;
  label: string;
  form_factor: string;
}

const sha256 = (s: string | Buffer): Buffer => createHash('sha256').update(s).digest();

function safeEqual(a: Buffer, b: Buffer | null): boolean {
  return b !== null && a.length === b.length && timingSafeEqual(a, b);
}

function toBuffer(v: unknown): Buffer | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string' && v.startsWith('\\x')) return Buffer.from(v.slice(2), 'hex');
  return null;
}

export interface IdentityService {
  readonly issuer: string;
  jwks(): { keys: unknown[] };
  leaseJwks(): { keys: unknown[] };
  authConfig(): Promise<AuthConfigResponse>;
  /** The configured IdP issuer — what a new user's subject is recorded under. */
  oidcIssuer(): string | null;
  /** Verify a DPoP proof for a request that carries no access token. */
  proveDevice(req: RequestProof): Promise<VerifiedProof>;
  enrol(req: EnrolRequest, proof: VerifiedProof, source: string): Promise<EnrolResponse>;
  signIn(req: SessionRequest, proof: VerifiedProof): Promise<SessionResponse>;
  refresh(req: RefreshRequest, proof: VerifiedProof): Promise<SessionResponse>;
  signOut(identity: VerifiedIdentity): Promise<void>;
  /** §2.2 verification, all four steps, for one request. Throws IdentityError. */
  authenticate(accessToken: string, req: RequestProof): Promise<VerifiedIdentity>;
  syncToken(identity: VerifiedIdentity): Promise<MintedToken>;
  lease(identity: VerifiedIdentity): Promise<LeaseEnvelope>;
  /** Drop cached revocation answers for a device (after a local revoke). */
  forgetDevice(tenantId: string, deviceId: string): void;
  drain(proof: VerifiedProof, ops: readonly DrainOp[]): Promise<DrainResponse>;
  drainAbandoned(proof: VerifiedProof, undrainedCount: number): Promise<void>;
}

export interface DrainOp {
  readonly idempotency_key: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly claimed_hlc?: string | undefined;
  readonly client_wall_at?: string | undefined;
}

export function createIdentityService(opts: IdentityServiceOptions): IdentityService {
  const now = (): number => (opts.nowMs ?? Date.now)();
  const nowS = (): number => Math.floor(now() / 1000);
  const replay = opts.replay ?? createReplayCache();
  const perSource = opts.perSource ?? createRateLimiter(ENROL_PER_SOURCE_PER_HOUR, HOUR_MS);
  const perTenant = opts.perTenant ?? createRateLimiter(ENROL_PER_TENANT_PER_HOUR, HOUR_MS);
  const leasePolicy = opts.leasePolicy ?? DEFAULT_LEASE_POLICY;
  const idleS = opts.sessionIdleS ?? SESSION_IDLE_S;
  const maxS = opts.sessionMaxS ?? SESSION_MAX_S;
  const cacheMs = opts.revocationCacheMs ?? 5_000;
  const alert = (a: IdentityAlert): void => {
    if (opts.onAlert) opts.onAlert(a);
    else console.error(`[identity] ALERT ${a.kind} tenant=${a.tenantId} device=${a.deviceId ?? '-'}: ${a.detail}`);
  };

  // ------------------------------------------------------------------------
  // Device resolution — from a PROVEN key to (tenant, device row)
  // ------------------------------------------------------------------------

  async function resolveProvenDevice(proof: VerifiedProof): Promise<{ tenantId: string; device: DeviceRow }> {
    const route = await opts.preTenant.withoutTenant(async (tx) => {
      const r = await tx.query<{ tenant_id: string; device_id: string }>(
        `select tenant_id, device_id from platform.resolve_device_key($1)`,
        [proof.jkt],
      );
      return r.rows[0];
    });
    if (!route) throw new IdentityError(401, 'device_not_enrolled', 'this device key is not enrolled');
    const device = await opts.runner.withTenant(route.tenant_id, async (tx) => loadDevice(tx, route.device_id));
    // Belt and braces: the route and the registry must agree on the key.
    if (!device || device.jkt !== proof.jkt) {
      throw new IdentityError(401, 'device_not_enrolled', 'this device key is not enrolled');
    }
    return { tenantId: route.tenant_id, device };
  }

  async function loadDevice(tx: Queryable, deviceId: string): Promise<DeviceRow | undefined> {
    const r = await tx.query<DeviceRow>(
      `select id, jkt, status, retired_reason, drain_opened_at::text, label, form_factor
         from app.device where id = $1`,
      [deviceId],
    );
    return r.rows[0];
  }

  /** The 423 body for a retired device, opening its drain clock on first contact. */
  async function revokedBody(tenantId: string, device: DeviceRow): Promise<DeviceRevokedBody> {
    if (device.retired_reason === 'stolen') {
      return { error: 'LOCKED', reason: 'device_revoked', drain: 'refused', drainUntil: null };
    }
    const opened = await opts.runner.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ opened: string }>(
        `update app.device set drain_opened_at = coalesce(drain_opened_at, transaction_timestamp())
          where id = $1 returning extract(epoch from drain_opened_at)::bigint::text as opened`,
        [device.id],
      );
      return Number(r.rows[0]?.opened ?? nowS());
    });
    return { error: 'LOCKED', reason: 'device_revoked', drain: 'allowed', drainUntil: opened + DRAIN_WINDOW_S };
  }

  async function refuseUnlessActive(tenantId: string, device: DeviceRow): Promise<void> {
    if (device.status === 'retired') {
      const body = await revokedBody(tenantId, device);
      throw new IdentityError(423, 'device_revoked', 'this device has been revoked', body);
    }
    if (device.status === 'suspended') {
      throw new IdentityError(403, 'device_suspended', 'this device is suspended');
    }
  }

  // ------------------------------------------------------------------------
  // Scope and lease — what this session may act at, and hold offline
  // ------------------------------------------------------------------------

  /** Device ceiling nodes the user's scope covers (unexpanded). */
  async function sessionLocations(tx: Queryable, deviceId: string, userId: string): Promise<string[]> {
    const r = await tx.query<{ location_id: string }>(
      `select distinct dls.location_id
         from app.device_location_scope dls
         join app.user_location_scope uls
           on uls.tenant_id = dls.tenant_id and uls.location_id = dls.location_id and uls.user_id = $2
        where dls.device_id = $1 and dls.deleted_at is null
        order by dls.location_id`,
      [deviceId, userId],
    );
    return r.rows.map((x) => x.location_id);
  }

  async function buildLease(tenantId: string, deviceId: string, userId: string): Promise<LeaseEnvelope> {
    const { scope, grants, modes } = await opts.runner.withTenant(tenantId, async (tx) => {
      const scopeRows = await tx.query<{ location_id: string }>(
        `select location_id from app.device_sync_location_scope
          where device_id = $1 and user_id = $2 order by location_id`,
        [deviceId, userId],
      );
      const scope = scopeRows.rows.map((r) => r.location_id);
      const grantRows = scope.length === 0
        ? { rows: [] as { permission_code: string; location_id: string }[] }
        : await tx.query<{ permission_code: string; location_id: string }>(
            `select distinct permission_code, location_id from app.effective_permission
              where user_id = $1 and location_id = any($2::uuid[])`,
            [userId, scope],
          );
      const modeRows = await tx.query<{ code: string; offline_mode: OfflineMode }>(
        `select code, offline_mode from platform.permission`,
      );
      return {
        scope,
        grants: grantRows.rows.map((g) => ({ code: g.permission_code, locationId: g.location_id })),
        modes: new Map(modeRows.rows.map((m) => [m.code, m.offline_mode] as const)),
      };
    });
    const claims = leaseClaimsFor(
      { tid: tenantId, sub: userId, did: deviceId, scope, grants, offlineModes: modes },
      leasePolicy,
      nowS(),
    );
    return signLease(opts.leaseKeys, opts.issuer, claims);
  }

  // ------------------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------------------

  function newRefreshSecret(): { secret: string; hash: Buffer } {
    const secret = randomBytes(32).toString('base64url');
    return { secret, hash: sha256(secret) };
  }

  async function issueSession(
    tenantId: string,
    device: DeviceRow,
    user: { id: string; display_name: string },
    sessionId: string,
    refreshSecret: string,
  ): Promise<SessionResponse> {
    const access = await mintAccessToken(opts.signing, opts.issuer, {
      tid: tenantId,
      sub: user.id,
      did: device.id,
      sid: sessionId,
      jti: uuidv7(),
      cnf: { jkt: device.jkt },
    }, { nowS: nowS() });
    const locationIds = await opts.runner.withTenant(tenantId, (tx) => sessionLocations(tx, device.id, user.id));
    const lease = await buildLease(tenantId, device.id, user.id);
    return {
      accessToken: access.token,
      accessExpiresAt: access.expiresAtS,
      refreshToken: `${sessionId}.${refreshSecret}`,
      sessionId,
      userId: user.id,
      displayName: user.display_name,
      deviceId: device.id,
      tenantId,
      locationIds,
      lease,
    };
  }

  // ------------------------------------------------------------------------
  // Per-request revocation check (§2.2 step 4) — Postgres is the store
  // ------------------------------------------------------------------------

  type Liveness =
    | { kind: 'ok'; locationIds: string[] }
    | { kind: 'retired'; device: DeviceRow }
    | { kind: 'suspended' }
    | { kind: 'session_dead'; why: string };

  const livenessCache = new Map<string, { at: number; value: Liveness }>();

  async function liveness(tenantId: string, deviceId: string, sessionId: string, userId: string): Promise<Liveness> {
    const key = `${tenantId}:${deviceId}:${sessionId}`;
    const hit = livenessCache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.value;
    let value: Liveness;
    try {
      value = await opts.runner.withTenant(tenantId, async (tx) => {
        const device = await loadDevice(tx, deviceId);
        if (!device) return { kind: 'session_dead', why: 'unknown device' } as const;
        if (device.status === 'retired') return { kind: 'retired', device } as const;
        if (device.status === 'suspended') return { kind: 'suspended' } as const;
        const s = await tx.query<{ revoked: boolean; expired: boolean; user_status: string; user_id: string }>(
          `select (s.revoked_at is not null) as revoked,
                  (s.expires_at <= transaction_timestamp()) as expired,
                  ua.status as user_status, s.user_id
             from app.device_session s
             join app.user_account ua on ua.tenant_id = s.tenant_id and ua.id = s.user_id
            where s.id = $1 and s.device_id = $2 and ua.deleted_at is null`,
          [sessionId, deviceId],
        );
        const row = s.rows[0];
        if (!row) return { kind: 'session_dead', why: 'unknown session' } as const;
        if (row.user_id !== userId) return { kind: 'session_dead', why: 'session/user mismatch' } as const;
        if (row.revoked) return { kind: 'session_dead', why: 'session revoked' } as const;
        if (row.expired) return { kind: 'session_dead', why: 'session expired' } as const;
        if (row.user_status !== 'ACTIVE') return { kind: 'session_dead', why: 'user not active' } as const;
        // The device ceiling, closure-expanded: where this session may WRITE
        // (assertLocationInScope). The permission check decides the rest.
        const locs = await tx.query<{ location_id: string }>(
          `select distinct lc.descendant_id as location_id
             from app.device_location_scope dls
             join app.location_closure lc
               on lc.tenant_id = dls.tenant_id and lc.ancestor_id = dls.location_id
            where dls.device_id = $1 and dls.deleted_at is null`,
          [deviceId],
        );
        return { kind: 'ok', locationIds: locs.rows.map((r) => r.location_id) } as const;
      });
    } catch (err) {
      // §2.2 step 4: a fail-open revocation check is not a revocation check.
      throw new IdentityError(
        503,
        'revocation_unavailable',
        `the revocation store could not be read — refused, not admitted (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    livenessCache.set(key, { at: now(), value });
    if (livenessCache.size > 20_000) {
      for (const [k, v] of livenessCache) if (now() - v.at >= cacheMs) livenessCache.delete(k);
    }
    return value;
  }

  async function proveDevice(req: RequestProof, accessToken?: string): Promise<VerifiedProof> {
    if (!req.dpop) throw new IdentityError(401, 'dpop_required', 'a DPoP proof from the enrolled device key is required');
    try {
      return await verifyDpopProof(req.dpop, {
        method: req.method,
        url: req.url,
        accessToken,
        replay,
        nowS: nowS(),
      });
    } catch (err) {
      if (err instanceof DpopRejected) throw new IdentityError(401, 'dpop_invalid', err.message);
      throw err;
    }
  }

  // ------------------------------------------------------------------------
  // The service
  // ------------------------------------------------------------------------

  return {
    issuer: opts.issuer,
    jwks: () => opts.signing.jwks(),
    leaseJwks: () => opts.leaseKeys.jwks(),

    oidcIssuer: () => opts.oidc?.config.issuer ?? null,

    async authConfig() {
      if (!opts.oidc) return { oidc: null };
      const d = await opts.oidc.verifier.discovery();
      return {
        oidc: {
          issuer: opts.oidc.config.issuer,
          clientId: opts.oidc.config.clientId,
          authorizationEndpoint: d.authorizationEndpoint,
          tokenEndpoint: d.tokenEndpoint,
          scope: opts.oidc.config.scope ?? 'openid',
        },
      };
    },

    proveDevice: (req) => proveDevice(req),

    // ---------------------------------------------------------------- enrol
    async enrol(req, proof, source) {
      if (!perSource.hit(`src:${source}`, now())) {
        throw new IdentityError(429, 'enrolment_rate_limited', 'too many enrolment attempts from this source — wait an hour');
      }
      const normalised = normaliseEnrolmentCode(req.code);
      if (normalised === null) {
        throw new IdentityError(400, 'enrolment_code_malformed', 'an enrolment code is 8 letters and digits');
      }
      // The proof must come from the key being registered: otherwise anyone
      // holding a code could enrol SOMEBODY ELSE'S public key.
      const registering = await calculateJwkThumbprint(req.publicJwk, 'sha256');
      if (registering !== proof.jkt) {
        throw new IdentityError(400, 'enrolment_key_mismatch', 'the DPoP proof was not signed by the key being enrolled');
      }

      const codeHash = hashEnrolmentCode(normalised);
      const claim = await opts.preTenant.withoutTenant(async (tx) => {
        const r = await tx.query<{ tenant_id: string; code_id: string; expires_at: Date | string; first_claim: boolean }>(
          `select tenant_id, code_id, expires_at, first_claim from platform.claim_enrolment_code($1)`,
          [codeHash],
        );
        return r.rows[0];
      });
      if (!claim) {
        throw new IdentityError(404, 'enrolment_code_unknown', 'that enrolment code is not recognised');
      }
      const tenantId = claim.tenant_id;

      if (!perTenant.hit(`tenant:${tenantId}`, now())) {
        alert({
          kind: 'enrolment_rate_limit',
          tenantId,
          detail: `more than ${ENROL_PER_TENANT_PER_HOUR} enrolment redemptions in an hour`,
        });
        throw new IdentityError(429, 'enrolment_rate_limited', 'too many enrolments for this business this hour');
      }

      // Recording a refusal is its own small unit of work, so the burn and the
      // audit row survive the request failing.
      const refuse = async (reason: string, status: 409 | 410, message: string): Promise<never> => {
        await opts.runner.withTenant(tenantId, async (tx) => {
          const w = await serverWrite(tx, opts.clock, { tenantId, op: 'device.enrol_refused' });
          await tx.query(
            `update app.device_enrolment_code
                set consumed_at = coalesce(consumed_at, transaction_timestamp()),
                    outcome = coalesce(outcome, 'refused'), updated_at = transaction_timestamp()
              where id = $1 and outcome is distinct from 'enrolled'`,
            [claim.code_id],
          );
          await recordIdentityEvent(tx, opts.clock, {
            tenantId,
            writeId: w,
            eventClass: 'denial',
            actorKind: 'device',
            action: 'enrolment_code.redeem',
            subjectTable: 'device_enrolment_code',
            subjectId: claim.code_id,
            reasonCode: reason,
            after: { jkt: proof.jkt },
          });
        });
        throw new IdentityError(status, reason, message);
      };

      if (!claim.first_claim) {
        // Either a retry of the SAME request (the response was lost on 2G) —
        // which replays — or a second attempt at a burned code, which never does.
        const isRetry = await opts.runner.withTenant(tenantId, async (tx) => {
          const r = await tx.query(`select 1 from app.write_log where id = $1`, [req.idempotencyKey]);
          return r.rows.length > 0;
        });
        if (!isRetry) {
          return refuse('enrolment_code_used', 409, 'that enrolment code has already been used — ask for a new one');
        }
      } else if (new Date(claim.expires_at).getTime() <= now()) {
        return refuse('enrolment_code_expired', 410, 'that enrolment code has expired — ask for a new one');
      }

      const deviceId = deterministicUuid(req.idempotencyKey, 'device');
      const code = await opts.runner.withTenant(tenantId, async (tx) => {
        const r = await tx.query<{ issued_by: string; location_id: string | null; label: string; form_factor: string }>(
          `select issued_by, location_id, label, form_factor from app.device_enrolment_code where id = $1`,
          [claim.code_id],
        );
        return r.rows[0];
      });
      if (!code) throw new IdentityError(404, 'enrolment_code_unknown', 'that enrolment code is not recognised');

      const result = await runIdempotent<JsonValue>(
        { runner: opts.runner, clock: opts.clock },
        // The device performs the write under the authority of the person who
        // issued the code — that person is `enrolled_by`, and the write's user.
        { tenantId, userId: code.issued_by, deviceId },
        { op: 'device.enrol', idempotencyKey: req.idempotencyKey, locationId: code.location_id },
        { jkt: proof.jkt, codeId: claim.code_id, appVersion: req.appVersion ?? null },
        async (tx) => {
          const live = await tx.query<{ consumed_at: string | null; ok_location: boolean }>(
            `select c.consumed_at::text,
                    (c.location_id is null or exists (
                       select 1 from app.location l
                        where l.id = c.location_id and l.deleted_at is null and l.is_active)) as ok_location
               from app.device_enrolment_code c where c.id = $1`,
            [claim.code_id],
          );
          const row = live.rows[0];
          if (!row || row.consumed_at !== null) {
            throw new IdentityError(409, 'enrolment_code_used', 'that enrolment code has already been used');
          }
          if (!row.ok_location) {
            throw new IdentityError(409, 'enrolment_location_inactive', 'the location this code names is no longer active');
          }
          const response: EnrolResponse = {
            deviceId,
            tenantId,
            label: code.label,
            formFactor: code.form_factor as EnrolResponse['formFactor'],
            locationIds: code.location_id === null ? [] : [code.location_id],
          };
          return {
            response: response as unknown as JsonValue,
            apply: async (atx) => {
              const hlc = opts.clock.next();
              await atx.query(
                `insert into app.device
                   (tenant_id, id, write_id, hlc, label, form_factor, public_jwk, jkt, status,
                    enrolled_by, enrolment_code_id, app_version, last_seen_at)
                 values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'active',$9,$10,$11, transaction_timestamp())`,
                [
                  tenantId, deviceId, req.idempotencyKey, hlc, code.label, code.form_factor,
                  JSON.stringify(req.publicJwk), proof.jkt, code.issued_by, claim.code_id,
                  req.appVersion ?? null,
                ],
              );
              if (code.location_id !== null) {
                await atx.query(
                  `insert into app.device_location_scope
                     (tenant_id, id, write_id, hlc, device_id, location_id, added_by)
                   values ($1,$2,$3,$4,$5,$6,$7)`,
                  [
                    tenantId, deterministicUuid(deviceId, 'dls', code.location_id), req.idempotencyKey,
                    opts.clock.next(), deviceId, code.location_id, code.issued_by,
                  ],
                );
              }
              await atx.query(
                `update app.device_enrolment_code
                    set consumed_at = transaction_timestamp(), outcome = 'enrolled', device_id = $2,
                        updated_at = transaction_timestamp()
                  where id = $1`,
                [claim.code_id, deviceId],
              );
              await atx.query(`select platform.register_device_key($1, $2)`, [proof.jkt, deviceId]);
              await recordIdentityEvent(atx, opts.clock, {
                tenantId,
                writeId: req.idempotencyKey,
                eventClass: 'write',
                actorKind: 'device',
                actorUserId: code.issued_by,
                actorDeviceId: deviceId,
                action: 'device.enrol',
                permissionUsed: 'admin.device.enrol',
                subjectTable: 'device',
                subjectId: deviceId,
                after: {
                  label: code.label,
                  formFactor: code.form_factor,
                  jkt: proof.jkt,
                  locationId: code.location_id,
                  enrolmentCodeId: claim.code_id,
                },
              });
            },
          };
        },
      ).catch((err: unknown) => {
        if (err instanceof IdentityError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/device_key_route_pkey|duplicate key/.test(msg)) {
          throw new IdentityError(409, 'device_key_already_enrolled', 'this device key is already enrolled — generate a new one');
        }
        throw err;
      });
      return result.response as unknown as EnrolResponse;
    },

    // -------------------------------------------------------------- sign in
    async signIn(req, proof) {
      if (!opts.oidc) throw new IdentityError(503, 'oidc_not_configured', 'sign-in is not configured on this server');
      // The nonce binds the id_token to THIS key: `${jkt}.${random}`.
      if (!req.nonce.startsWith(`${proof.jkt}.`)) {
        throw new IdentityError(400, 'nonce_not_bound', 'the sign-in nonce is not bound to this device key');
      }
      const { tenantId, device } = await resolveProvenDevice(proof);
      await refuseUnlessActive(tenantId, device);

      let subject: { issuer: string; subject: string };
      try {
        subject = await opts.oidc.verifier.verify(req.idToken, req.nonce, nowS());
      } catch (err) {
        throw new IdentityError(401, 'id_token_invalid', err instanceof Error ? err.message : String(err));
      }
      if (!replay.claim(`nonce:${req.nonce}`, now() + 15 * 60 * 1000)) {
        throw new IdentityError(401, 'id_token_replayed', 'this sign-in has already been used');
      }

      const { secret, hash } = newRefreshSecret();
      const sessionId = uuidv7();
      const user = await opts.runner.withTenant(tenantId, async (tx) => {
        const u = await tx.query<{ id: string; display_name: string; status: string }>(
          `select id, display_name, status from app.user_account
            where subject_issuer = $1 and subject_ref = $2 and deleted_at is null`,
          [subject.issuer, subject.subject],
        );
        const row = u.rows[0];
        if (!row || row.status !== 'ACTIVE') {
          const w = await serverWrite(tx, opts.clock, { tenantId, op: 'auth.sign_in_refused', deviceId: device.id });
          await recordIdentityEvent(tx, opts.clock, {
            tenantId,
            writeId: w,
            eventClass: 'denial',
            actorKind: 'device',
            actorDeviceId: device.id,
            actorUserId: row?.id ?? null,
            action: 'session.sign_in',
            subjectTable: 'user_account',
            subjectId: row?.id ?? null,
            reasonCode: row ? 'user_not_active' : 'no_user_for_subject',
          });
          return null;
        }
        await tx.query(
          `insert into app.device_session (tenant_id, id, device_id, user_id, refresh_hash, expires_at)
           values ($1, $2, $3, $4, $5, transaction_timestamp() + ($6 || ' seconds')::interval)`,
          [tenantId, sessionId, device.id, row.id, hash, String(Math.min(idleS, maxS))],
        );
        await tx.query(
          `update app.device set last_authenticated_at = transaction_timestamp(),
                                 last_seen_at = transaction_timestamp()
            where id = $1`,
          [device.id],
        );
        return { id: row.id, display_name: row.display_name };
      });
      if (!user) {
        // One answer for "no such user" and "user disabled": telling a caller
        // which would confirm an account's existence.
        throw new IdentityError(403, 'no_active_user', 'this sign-in is not linked to an active user here');
      }
      return issueSession(tenantId, device, user, sessionId, secret);
    },

    // -------------------------------------------------------------- refresh
    async refresh(req, proof) {
      const [sessionId, secret] = req.refreshToken.split('.', 2);
      if (!sessionId || !secret || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
        throw new IdentityError(401, 'refresh_invalid', 'refresh credential is malformed');
      }
      const { tenantId, device } = await resolveProvenDevice(proof);
      await refuseUnlessActive(tenantId, device);
      const presented = sha256(secret);
      const next = newRefreshSecret();

      const outcome = await opts.runner.withTenant(tenantId, async (tx) => {
        const r = await tx.query<{
          user_id: string;
          refresh_hash: unknown;
          refresh_prev_hash: unknown;
          revoked: boolean;
          expired: boolean;
          user_status: string;
          display_name: string;
        }>(
          `select s.user_id, s.refresh_hash, s.refresh_prev_hash,
                  (s.revoked_at is not null) as revoked,
                  (s.expires_at <= transaction_timestamp()) as expired,
                  ua.status as user_status, ua.display_name
             from app.device_session s
             join app.user_account ua on ua.tenant_id = s.tenant_id and ua.id = s.user_id
            where s.id = $1 and s.device_id = $2
            for update of s`,
          [sessionId, device.id],
        );
        const s = r.rows[0];
        if (!s) return { kind: 'dead', why: 'unknown session' } as const;
        if (s.revoked) return { kind: 'dead', why: 'session revoked' } as const;
        if (s.expired) return { kind: 'dead', why: 'session expired' } as const;
        if (s.user_status !== 'ACTIVE') {
          await tx.query(
            `update app.device_session set revoked_at = transaction_timestamp(), revoked_reason = 'user_disabled',
                    updated_at = transaction_timestamp() where id = $1`,
            [sessionId],
          );
          return { kind: 'dead', why: 'user not active' } as const;
        }
        if (safeEqual(presented, toBuffer(s.refresh_hash))) {
          await tx.query(
            `update app.device_session
                set refresh_prev_hash = refresh_hash, refresh_hash = $2,
                    refresh_count = refresh_count + 1,
                    last_refreshed_at = transaction_timestamp(), updated_at = transaction_timestamp(),
                    expires_at = least(created_at + ($3 || ' seconds')::interval,
                                       transaction_timestamp() + ($4 || ' seconds')::interval)
              where id = $1`,
            [sessionId, next.hash, String(maxS), String(idleS)],
          );
          await tx.query(`update app.device set last_seen_at = transaction_timestamp() where id = $1`, [device.id]);
          return { kind: 'ok', user: { id: s.user_id, display_name: s.display_name } } as const;
        }
        if (safeEqual(presented, toBuffer(s.refresh_prev_hash))) {
          // A credential that was already rotated, presented again: two
          // holders of one secret. The standard response is to kill the
          // session — the legitimate holder signs in again; the copy dies.
          await tx.query(
            `update app.device_session set revoked_at = transaction_timestamp(), revoked_reason = 'refresh_reuse',
                    updated_at = transaction_timestamp() where id = $1`,
            [sessionId],
          );
          const w = await serverWrite(tx, opts.clock, { tenantId, op: 'auth.refresh_reuse', deviceId: device.id, userId: s.user_id });
          await recordIdentityEvent(tx, opts.clock, {
            tenantId,
            writeId: w,
            eventClass: 'denial',
            actorKind: 'device',
            actorDeviceId: device.id,
            actorUserId: s.user_id,
            action: 'session.refresh_reuse',
            subjectTable: 'device_session',
            subjectId: sessionId,
            reasonCode: 'refresh_reuse',
          });
          return { kind: 'reuse', userId: s.user_id } as const;
        }
        return { kind: 'dead', why: 'refresh credential does not match' } as const;
      });

      if (outcome.kind === 'reuse') {
        livenessCache.clear();
        alert({ kind: 'refresh_reuse', tenantId, deviceId: device.id, detail: `session ${sessionId} revoked` });
        throw new IdentityError(401, 'refresh_reused', 'this refresh credential was already used — sign in again');
      }
      if (outcome.kind === 'dead') throw new IdentityError(401, 'refresh_invalid', outcome.why);
      return issueSession(tenantId, device, outcome.user, sessionId, next.secret);
    },

    // ------------------------------------------------------------- sign out
    async signOut(identity) {
      if (!identity.sessionId) return;
      await opts.runner.withTenant(identity.tenantId, (tx) =>
        tx.query(
          `update app.device_session set revoked_at = coalesce(revoked_at, transaction_timestamp()),
                  revoked_reason = coalesce(revoked_reason, 'signed_out'), updated_at = transaction_timestamp()
            where id = $1 and device_id = $2`,
          [identity.sessionId, identity.deviceId],
        ),
      );
      livenessCache.delete(`${identity.tenantId}:${identity.deviceId}:${identity.sessionId}`);
    },

    // -------------------------------------------------------- authenticate
    async authenticate(accessToken, req) {
      let claims;
      try {
        claims = await verifyAccessToken(opts.signing, opts.issuer, accessToken, { nowS: nowS() });
      } catch (err) {
        if (err instanceof TokenRejected) throw new IdentityError(401, 'token_invalid', err.message);
        throw err;
      }
      const proof = await proveDevice(req, accessToken);
      if (proof.jkt !== claims.cnf.jkt) {
        throw new IdentityError(401, 'dpop_key_mismatch', 'the DPoP proof was not signed by the key this token is bound to');
      }
      const live = await liveness(claims.tid, claims.did, claims.sid, claims.sub);
      switch (live.kind) {
        case 'retired': {
          const body = await revokedBody(claims.tid, live.device);
          throw new IdentityError(423, 'device_revoked', 'this device has been revoked', body);
        }
        case 'suspended':
          throw new IdentityError(403, 'device_suspended', 'this device is suspended');
        case 'session_dead':
          throw new IdentityError(401, 'session_invalid', live.why);
        case 'ok':
          return {
            tenantId: claims.tid,
            userId: claims.sub,
            // Opaque label, never branched on (CLAUDE.md §2.9). A device
            // session carries no role at all — permissions are resolved per
            // request from the database.
            role: 'device-session',
            locationIds: live.locationIds,
            deviceId: claims.did,
            sessionId: claims.sid,
            platformOperator: false,
            authKind: 'device',
          };
      }
    },

    async syncToken(identity) {
      return mintSyncToken(opts.signing, opts.issuer, {
        tid: identity.tenantId,
        sub: identity.userId,
        did: identity.deviceId,
        jti: uuidv7(),
      }, { nowS: nowS() });
    },

    lease: (identity) => buildLease(identity.tenantId, identity.deviceId, identity.userId),

    forgetDevice(tenantId, deviceId) {
      for (const k of livenessCache.keys()) if (k.startsWith(`${tenantId}:${deviceId}:`)) livenessCache.delete(k);
    },

    // --------------------------------------------------------------- drain
    async drain(proof, ops) {
      const { tenantId, device } = await resolveProvenDevice(proof);
      if (device.status !== 'retired') {
        // A live device uploads through /sync/upload; the drain is for the dead.
        throw new IdentityError(409, 'device_not_revoked', 'the drain is only for a revoked device — use /sync/upload');
      }
      const body = await revokedBody(tenantId, device);
      if (body.drain === 'refused') {
        throw new IdentityError(423, 'device_revoked', 'this device was reported stolen — wipe now', body);
      }
      if (body.drainUntil !== null && nowS() > body.drainUntil) {
        throw new IdentityError(410, 'drain_window_closed', 'the drain window for this device has closed');
      }
      const locationIds = await opts.runner.withTenant(tenantId, async (tx) =>
        (
          await tx.query<{ location_id: string }>(
            `select location_id from app.device_location_scope where device_id = $1 order by created_at`,
            [device.id],
          )
        ).rows.map((r) => r.location_id),
      );

      const acks: DrainResponse['acks'] = [];
      for (const op of ops) {
        acks.push(
          await opts.runner.withTenant(tenantId, async (tx) => {
            // Idempotent on the op's own key — the same registry every write
            // uses. A key the server ALREADY HAS was applied before revocation
            // (the ack was lost): it is in the books, there is nothing to review.
            const seen = await tx.query<{ op: string; response_body: { reviewId?: string } | null }>(
              `select op, response_body from app.write_log where id = $1`,
              [op.idempotency_key],
            );
            const prior = seen.rows[0];
            if (prior) {
              return {
                key: op.idempotency_key,
                status: 'duplicate' as const,
                ...(prior.op === 'sync.revoked_drain' && prior.response_body?.reviewId
                  ? { reviewId: prior.response_body.reviewId }
                  : {}),
              };
            }
            const reviewId = deterministicUuid(op.idempotency_key, 'revoked-drain-review');
            const hlc = opts.clock.next();
            // Strip any tenant spelling from the payload before it is stored —
            // a review is evidence, and evidence must not carry a forged tenant.
            const payload: Record<string, unknown> = { ...op.payload };
            for (const k of ['tenant_id', 'tenantId', 'tid']) delete payload[k];
            await tx.query(
              `insert into app.write_log
                 (tenant_id, id, origin, hlc, claimed_hlc, device_id, op, schema_version,
                  request_hash, response_body, client_wall_at)
               values ($1,$2,'SERVER',$3,$4,$5,'sync.revoked_drain',1,$6,$7::jsonb,$8)`,
              [
                tenantId, op.idempotency_key, hlc,
                op.claimed_hlc && /^[0-9]{13}-[0-9]{5}-[0-9a-f]{32}$/.test(op.claimed_hlc) ? op.claimed_hlc : null,
                device.id, sha256(JSON.stringify({ kind: op.kind, payload })),
                JSON.stringify({ reviewId }),
                op.client_wall_at ?? null,
              ],
            );
            await openConflictReview(tx, {
              tenantId,
              writeId: op.idempotency_key,
              hlc,
              reviewId,
              conflictClass: 'REVOKED_DEVICE_WRITE',
              severity: 2,
              entityTable: 'device',
              entityId: device.id,
              proposals: {
                device: { deviceId: device.id, label: device.label, retiredReason: device.retired_reason },
                write: { kind: op.kind, idempotencyKey: op.idempotency_key, payload: payload as JsonValue },
                claimedHlc: op.claimed_hlc ?? null,
                clientWallAt: op.client_wall_at ?? null,
              },
              pendingState: 'safe_default',
              // NOTHING POSTED. A holder of sync.conflict.review decides.
              pendingValue: { posted: false },
              requiredPermission: 'sync.conflict.review',
              locationIds,
            });
            return { key: op.idempotency_key, status: 'quarantined' as const, reviewId };
          }),
        );
      }
      return { acks };
    },

    async drainAbandoned(proof, undrainedCount) {
      const { tenantId, device } = await resolveProvenDevice(proof);
      if (device.status !== 'retired') {
        throw new IdentityError(409, 'device_not_revoked', 'only a revoked device abandons a drain');
      }
      await opts.runner.withTenant(tenantId, async (tx) => {
        const w = await serverWrite(tx, opts.clock, { tenantId, op: 'sync.drain_abandoned', deviceId: device.id });
        const locs = (
          await tx.query<{ location_id: string }>(
            `select location_id from app.device_location_scope where device_id = $1`,
            [device.id],
          )
        ).rows.map((r) => r.location_id);
        await recordIdentityEvent(tx, opts.clock, {
          tenantId,
          writeId: w,
          eventClass: 'write',
          actorKind: 'device',
          actorDeviceId: device.id,
          action: 'device.drain_abandoned',
          subjectTable: 'device',
          subjectId: device.id,
          after: { undrainedCount, locationIds: locs },
        });
        // Severity 1: writes the business made and will never see. Named
        // device, location and count — §2.7 step 5.
        await openConflictReview(tx, {
          tenantId,
          writeId: w,
          hlc: opts.clock.next(),
          reviewId: deterministicUuid(w, 'drain-abandoned'),
          conflictClass: 'REVOKED_DEVICE_DRAIN_ABANDONED',
          severity: 1,
          entityTable: 'device',
          entityId: device.id,
          proposals: { device: { deviceId: device.id, label: device.label }, undrainedCount },
          pendingState: 'safe_default',
          pendingValue: { posted: false, undrainedCount },
          requiredPermission: 'sync.conflict.review',
          locationIds: locs,
        });
      });
      alert({
        kind: 'drain_abandoned',
        tenantId,
        deviceId: device.id,
        detail: `${undrainedCount} write(s) never reached the server (device "${device.label}")`,
      });
    },
  };
}

export const ENROLMENT_TTL_S = ENROLMENT_CODE_TTL_S;
