/**
 * THE DEVICE'S IDENTITY — enrolment, sign-in, the PIN, the shared-tablet user
 * switch, token refresh, the offline lease, and revocation.
 * (02-security §2.2, §2.5, §2.7; 08 §8.1, §8.1a.)
 *
 * Replaces the static `VITE_API_TOKEN` bearer for real devices. That dev path
 * still exists, clearly marked, for `pnpm dev:token` and the live drills
 * (data/powersync.ts readSyncEnv); this module is what a pilot tablet runs.
 *
 * LIFECYCLE
 *   unenrolled ──enrol(code)──► enrolled, nobody signed in
 *   ──beginSignIn → IdP → completeSignIn──► pending PIN ──setPin──► unlocked
 *   unlocked ──lock()──► locked (shift change: data key dropped, nothing wiped)
 *   locked ──unlock(user, PIN)──► unlocked (another user = the fast switch)
 *   any ──423 device_revoked──► revoked: the outbox DRAINS to review, then the
 *                                device wipes (drain.ts). Never before.
 *
 * What is in memory only: the access token, the user's unwrapped data key.
 * What is at rest (IndexedDB): the device key (non-extractable), each user's
 * PIN-wrapped key, each user's refresh credential SEALED under that key, the
 * last verified lease per user, the pinned lease keys.
 */
import {
  enrolResponse,
  leaseEnvelope,
  sessionResponse,
  type EnrolResponse,
  type LeaseClaims,
  type LeaseEnvelope,
  type SessionResponse,
} from '@erp/contracts';
import { createDpopProof, type DeviceKey } from './dpop';
import { leaseVerdict, verifyLease, type HeldLease, type LeaseVerdict } from './lease';
import { exchangeCode, fetchAuthConfig, prepareSignIn, type PendingSignIn } from './oidc';
import {
  MAX_PIN_ATTEMPTS,
  argon2idKdf,
  createUserKey,
  openText,
  sealText,
  unwrapUserKey,
  type PinKdf,
  type WrappedUserKey,
} from './pin';
import type { AuthStore } from './store';
import { exportPublicJwk, generateDeviceKeyPair, jwkThumbprint, randomB64url, type PublicEcJwk } from './webcrypto';

export interface DeviceRecord {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly label: string;
  readonly formFactor: string;
  /** The device ceiling's nodes as enrolled. */
  readonly locationIds: readonly string[];
  readonly keyPair: CryptoKeyPair;
  readonly publicJwk: PublicEcJwk;
  readonly jkt: string;
}

export interface UserRecord {
  readonly userId: string;
  readonly displayName: string;
  readonly wrapped: WrappedUserKey;
  readonly refreshSealed: string;
  readonly failedAttempts: number;
  /** Too many wrong PINs: local unlock closed until an online IdP sign-in. Never a wipe. */
  readonly sealed: boolean;
  readonly locationIds: readonly string[];
}

export interface RevokedRecord {
  readonly firstSeenMs: number;
  readonly drain: 'allowed' | 'refused';
  readonly drainUntilS: number | null;
}

export interface ActiveSession {
  readonly userId: string;
  readonly displayName: string;
  readonly sessionId: string | null;
  readonly locationIds: readonly string[];
  /** In memory only. Null while offline after a PIN unlock. */
  readonly accessToken: string | null;
  readonly accessExpiresAtS: number;
}

export type AuthPhase =
  | { readonly kind: 'unenrolled' }
  | { readonly kind: 'signed-out'; readonly device: DeviceRecord; readonly users: readonly UserRecord[] }
  | { readonly kind: 'pin-setup'; readonly device: DeviceRecord; readonly pending: SessionResponse }
  | { readonly kind: 'unlocked'; readonly device: DeviceRecord; readonly session: ActiveSession }
  | { readonly kind: 'revoked'; readonly device: DeviceRecord | null; readonly revoked: RevokedRecord };

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface DeviceAuthOptions {
  readonly apiUrl: string;
  readonly store: AuthStore;
  /** sessionStorage-like for the in-flight OIDC round trip. */
  readonly pendingStore?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly fetchFn?: typeof fetch;
  readonly kdf?: PinKdf;
  readonly nowMs?: () => number;
  readonly monoMs?: () => number;
  /** Distinguishes one page lifetime from the next (monotonic clock validity). */
  readonly pageId?: string;
}

const K = {
  device: 'device',
  user: (id: string) => `user/${id}`,
  lease: (id: string) => `lease/${id}`,
  leaseKeys: 'lease-keys',
  clock: 'clock',
  revoked: 'revoked',
} as const;

const PENDING_KEY = 'erp.oidc.pending';
/** Refresh this long before the access token expires. */
const REFRESH_SKEW_S = 60;

export class DeviceAuth {
  private readonly fetchFn: typeof fetch;
  private readonly kdf: PinKdf;
  private readonly now: () => number;
  private readonly mono: () => number;
  private readonly pageId: string;
  private active: { session: ActiveSession; dataKey: CryptoKey } | null = null;
  private pendingSession: SessionResponse | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly opts: DeviceAuthOptions) {
    this.fetchFn = opts.fetchFn ?? ((...a) => fetch(...a));
    this.kdf = opts.kdf ?? argon2idKdf;
    this.now = opts.nowMs ?? Date.now;
    this.mono = opts.monoMs ?? (() => performance.now());
    this.pageId = opts.pageId ?? randomB64url(8);
  }

  // ---------------------------------------------------------------- state

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  async device(): Promise<DeviceRecord | null> {
    return (await this.opts.store.get<DeviceRecord>(K.device)) ?? null;
  }

  async users(): Promise<UserRecord[]> {
    const keys = await this.opts.store.keys('user/');
    const out: UserRecord[] = [];
    for (const k of keys) {
      const u = await this.opts.store.get<UserRecord>(k);
      if (u) out.push(u);
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async phase(): Promise<AuthPhase> {
    const revoked = await this.opts.store.get<RevokedRecord>(K.revoked);
    const device = await this.device();
    if (revoked) return { kind: 'revoked', device, revoked };
    if (!device) return { kind: 'unenrolled' };
    if (this.pendingSession) return { kind: 'pin-setup', device, pending: this.pendingSession };
    if (this.active) return { kind: 'unlocked', device, session: this.active.session };
    return { kind: 'signed-out', device, users: await this.users() };
  }

  /** The unlocked user's session, or null. Synchronous: for request headers and the shell. */
  current(): ActiveSession | null {
    return this.active?.session ?? null;
  }

  private async deviceKey(): Promise<{ device: DeviceRecord; key: DeviceKey }> {
    const device = await this.device();
    if (!device) throw new AuthError('not_enrolled', 'this device is not enrolled');
    return { device, key: { privateKey: device.keyPair.privateKey, publicJwk: device.publicJwk } };
  }

  // -------------------------------------------------------------- enrolment

  /**
   * Enrol with a one-time code (§2.7): a fresh NON-EXTRACTABLE key pair is
   * generated here, its public half registered, and the request carries a
   * DPoP proof from it so the server knows the key is really ours.
   */
  async enrol(code: string, appVersion?: string): Promise<EnrolResponse> {
    if (await this.device()) throw new AuthError('already_enrolled', 'this device is already enrolled');
    const keyPair = await generateDeviceKeyPair();
    const publicJwk = await exportPublicJwk(keyPair.publicKey);
    const jkt = await jwkThumbprint(publicJwk);
    const url = `${this.opts.apiUrl}/auth/enrol`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        dpop: await createDpopProof({ privateKey: keyPair.privateKey, publicJwk }, 'POST', url, undefined, this.now()),
      },
      body: JSON.stringify({
        code,
        publicJwk,
        idempotencyKey: crypto.randomUUID(),
        ...(appVersion ? { appVersion } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new AuthError(String(body['error'] ?? `http_${res.status}`), String(body['message'] ?? 'enrolment was refused'));
    }
    const enrolled = enrolResponse.parse(body);
    const record: DeviceRecord = {
      deviceId: enrolled.deviceId,
      tenantId: enrolled.tenantId,
      label: enrolled.label,
      formFactor: enrolled.formFactor,
      locationIds: enrolled.locationIds,
      keyPair,
      publicJwk,
      jkt,
    };
    await this.opts.store.set(K.device, record);
    this.emit();
    return enrolled;
  }

  // ---------------------------------------------------------------- sign-in

  /** Start the IdP round trip. Returns the URL to navigate to. */
  async beginSignIn(redirectUri: string): Promise<string> {
    const { device } = await this.deviceKey();
    const config = await fetchAuthConfig(this.opts.apiUrl, this.fetchFn);
    if (!config) throw new AuthError('oidc_not_configured', 'sign-in is not configured on the server');
    const { url, pending } = await prepareSignIn(config, device.jkt, redirectUri, this.now());
    this.opts.pendingStore?.setItem(PENDING_KEY, JSON.stringify(pending));
    return url;
  }

  /** The IdP sent us back: exchange the code, then open a session on OUR API. */
  async completeSignIn(callbackUrl: string): Promise<SessionResponse> {
    const raw = this.opts.pendingStore?.getItem(PENDING_KEY);
    this.opts.pendingStore?.removeItem(PENDING_KEY);
    if (!raw) throw new AuthError('no_pending_sign_in', 'no sign-in was started on this device');
    const pending = JSON.parse(raw) as PendingSignIn;
    const idToken = await exchangeCode(callbackUrl, pending, this.fetchFn, this.now());
    const { key } = await this.deviceKey();
    const url = `${this.opts.apiUrl}/auth/session`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', dpop: await createDpopProof(key, 'POST', url, undefined, this.now()) },
      body: JSON.stringify({ idToken, nonce: pending.nonce }),
    });
    const session = await this.parseSession(res);
    this.pendingSession = session;
    this.emit();
    return session;
  }

  /**
   * Set (or reset) the user's PIN on this device, right after an online
   * sign-in. Wraps a fresh per-user key and seals the refresh credential.
   */
  async setPin(pin: string): Promise<void> {
    const pending = this.pendingSession;
    if (!pending) throw new AuthError('no_pending_session', 'sign in before choosing a PIN');
    const { record, dataKey } = await createUserKey(pin, this.kdf);
    const user: UserRecord = {
      userId: pending.userId,
      displayName: pending.displayName,
      wrapped: record,
      refreshSealed: await sealText(dataKey, pending.refreshToken),
      failedAttempts: 0,
      sealed: false,
      locationIds: pending.locationIds,
    };
    await this.opts.store.set(K.user(pending.userId), user);
    this.pendingSession = null;
    this.active = {
      dataKey,
      session: {
        userId: pending.userId,
        displayName: pending.displayName,
        sessionId: pending.sessionId,
        locationIds: pending.locationIds,
        accessToken: pending.accessToken,
        accessExpiresAtS: pending.accessExpiresAt,
      },
    };
    if (pending.lease) await this.acceptLease(pending.lease);
    this.emit();
  }

  // ------------------------------------------------------ PIN unlock / switch

  /**
   * Unlock a user who has signed in on this device before — the shift change
   * on a shared counter tablet (§2.5). Works OFFLINE: the PIN unwraps the
   * key locally; the refresh is attempted and its failure is not fatal.
   */
  async unlock(userId: string, pin: string): Promise<'unlocked' | 'wrong_pin' | 'sealed'> {
    const user = await this.opts.store.get<UserRecord>(K.user(userId));
    if (!user) throw new AuthError('unknown_user', 'that person has not signed in on this device');
    if (user.sealed) return 'sealed';
    const dataKey = await unwrapUserKey(user.wrapped, pin, this.kdf);
    if (!dataKey) {
      const failedAttempts = user.failedAttempts + 1;
      await this.opts.store.set(K.user(userId), {
        ...user,
        failedAttempts,
        sealed: failedAttempts >= MAX_PIN_ATTEMPTS,
      } satisfies UserRecord);
      this.emit();
      return failedAttempts >= MAX_PIN_ATTEMPTS ? 'sealed' : 'wrong_pin';
    }
    if (user.failedAttempts > 0) await this.opts.store.set(K.user(userId), { ...user, failedAttempts: 0 });
    // Switching user: the previous user's key leaves memory now.
    this.active = {
      dataKey,
      session: {
        userId,
        displayName: user.displayName,
        sessionId: null,
        locationIds: user.locationIds,
        accessToken: null,
        accessExpiresAtS: 0,
      },
    };
    this.emit();
    await this.refresh().catch(() => undefined); // offline is fine; the lease governs
    return 'unlocked';
  }

  /** Lock the screen: drop the data key and the token. NEVER deletes data (§8.1a). */
  lock(): void {
    this.active = null;
    this.pendingSession = null;
    this.emit();
  }

  /** Sign out of the server session too (online), then lock. Local data stays. */
  async signOut(): Promise<void> {
    const s = this.active?.session;
    if (s?.accessToken) {
      const url = `${this.opts.apiUrl}/auth/sign-out`;
      await this.fetchFn(url, { method: 'POST', headers: await this.authorize('POST', url) }).catch(() => undefined);
    }
    this.lock();
  }

  // ----------------------------------------------------------------- tokens

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const active = this.active;
    if (!active) throw new AuthError('locked', 'nobody is signed in');
    const user = await this.opts.store.get<UserRecord>(K.user(active.session.userId));
    if (!user) throw new AuthError('unknown_user', 'no stored session for this user');
    const refreshToken = await openText(active.dataKey, user.refreshSealed);
    if (!refreshToken) throw new AuthError('refresh_unreadable', 'the stored session could not be opened');
    const { key } = await this.deviceKey();
    const url = `${this.opts.apiUrl}/auth/refresh`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', dpop: await createDpopProof(key, 'POST', url, undefined, this.now()) },
      body: JSON.stringify({ refreshToken }),
    });
    const session = await this.parseSession(res);
    await this.opts.store.set(K.user(user.userId), {
      ...user,
      refreshSealed: await sealText(active.dataKey, session.refreshToken),
      locationIds: session.locationIds,
    } satisfies UserRecord);
    this.active = {
      dataKey: active.dataKey,
      session: {
        userId: session.userId,
        displayName: session.displayName,
        sessionId: session.sessionId,
        locationIds: session.locationIds,
        accessToken: session.accessToken,
        accessExpiresAtS: session.accessExpiresAt,
      },
    };
    if (session.lease) await this.acceptLease(session.lease);
    this.emit();
  }

  /** Headers for one API request: the DPoP-bound access token and a fresh proof. */
  async authorize(method: string, url: string): Promise<Record<string, string>> {
    let s = this.active?.session;
    if (!s) throw new AuthError('locked', 'nobody is signed in');
    if (!s.accessToken || s.accessExpiresAtS - REFRESH_SKEW_S <= Math.floor(this.now() / 1000)) {
      await this.refresh();
      s = this.active?.session;
      if (!s?.accessToken) throw new AuthError('offline', 'no session token — the server could not be reached');
    }
    const { key } = await this.deviceKey();
    return {
      authorization: `DPoP ${s.accessToken}`,
      dpop: await createDpopProof(key, method, url, s.accessToken ?? undefined, this.now()),
    };
  }

  /** A DPoP proof with NO token — the revoked-device drain authenticates by key alone. */
  async deviceProof(method: string, url: string): Promise<string> {
    const { key } = await this.deviceKey();
    return createDpopProof(key, method, url, undefined, this.now());
  }

  private async parseSession(res: Response): Promise<SessionResponse> {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 423) {
      await this.markRevoked(body);
      throw new AuthError('device_revoked', 'this device has been revoked');
    }
    if (!res.ok) {
      throw new AuthError(String(body['error'] ?? `http_${res.status}`), String(body['message'] ?? 'the server refused'));
    }
    return sessionResponse.parse(body);
  }

  // ------------------------------------------------------------------ lease

  /** Accept a lease envelope: refresh the pins, verify, keep it if it verifies (§2.7). */
  async acceptLease(envelope: LeaseEnvelope): Promise<'held' | 'unverifiable'> {
    const userId = this.active?.session.userId;
    if (!userId) return 'unverifiable';
    const parsed = leaseEnvelope.safeParse(envelope);
    if (!parsed.success) return 'unverifiable';
    // Pins refresh on every sync: merge, current keys first.
    const old = (await this.opts.store.get<Record<string, unknown>[]>(K.leaseKeys)) ?? [];
    const fresh = parsed.data.keys.keys;
    const kids = new Set(fresh.map((k) => k['kid']));
    const pins = [...fresh, ...old.filter((k) => !kids.has(k['kid']))].slice(0, 4);
    await this.opts.store.set(K.leaseKeys, pins);
    const claims = await verifyLease(parsed.data.lease, pins);
    if (!claims || claims.sub !== userId) {
      // Not honoured for extension; does not seal. The last verified lease stands.
      return 'unverifiable';
    }
    const device = await this.device();
    if (device && claims.did !== device.deviceId) return 'unverifiable';
    const held: HeldLease = {
      jws: parsed.data.lease,
      claims,
      receivedWallMs: this.now(),
      receivedMonoMs: this.mono(),
      pageId: this.pageId,
    };
    await this.opts.store.set(K.lease(userId), held);
    this.emit();
    return 'held';
  }

  async heldLease(userId?: string): Promise<HeldLease | null> {
    const id = userId ?? this.active?.session.userId;
    if (!id) return null;
    return (await this.opts.store.get<HeldLease>(K.lease(id))) ?? null;
  }

  /** The lease verdict for the active user, recording the wall clock for the backwards-jump check. */
  async leaseVerdict(): Promise<{ verdict: LeaseVerdict; claims: LeaseClaims | null }> {
    const held = await this.heldLease();
    const clock = (await this.opts.store.get<{ lastWallMs: number }>(K.clock)) ?? null;
    const now = { wallMs: this.now(), monoMs: this.mono() };
    const verdict = leaseVerdict(held, now, clock?.lastWallMs ?? null, this.pageId);
    if (!clock || now.wallMs > clock.lastWallMs) await this.opts.store.set(K.clock, { lastWallMs: now.wallMs });
    return { verdict, claims: held?.claims ?? null };
  }

  // ------------------------------------------------------------- revocation

  /** Record a 423 device_revoked. The outbox then drains (drain.ts) before any wipe. */
  async markRevoked(body: Record<string, unknown>): Promise<void> {
    const existing = await this.opts.store.get<RevokedRecord>(K.revoked);
    if (existing) return;
    const record: RevokedRecord = {
      firstSeenMs: this.now(),
      drain: body['drain'] === 'refused' ? 'refused' : 'allowed',
      drainUntilS: typeof body['drainUntil'] === 'number' ? body['drainUntil'] : null,
    };
    await this.opts.store.set(K.revoked, record);
    this.active = null;
    this.emit();
  }

  async revoked(): Promise<RevokedRecord | null> {
    return (await this.opts.store.get<RevokedRecord>(K.revoked)) ?? null;
  }

  /** The wipe: keys, wrapped user keys, sessions, leases. Only after the drain (§2.7 step 4). */
  async wipeIdentity(): Promise<void> {
    await this.opts.store.clear();
    this.active = null;
    this.pendingSession = null;
    this.emit();
  }
}
