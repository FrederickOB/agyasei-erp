/**
 * The device's identity, offline: the PIN (Argon2id at §2.7's parameters),
 * the lease horizons (full → restricted → sealed, monotonic and
 * backwards-jump), the shared-tablet unlock that seals and never wipes, and
 * drain-before-wipe. Node environment: WebCrypto is real; the server is a
 * scripted fetch.
 */
import { describe, expect, it } from 'vitest';
import type { LeaseClaims } from '@erp/contracts';
import { DeviceAuth, type DeviceRecord, type UserRecord } from '../src/data/auth/device-auth';
import { runRevokedDrain } from '../src/data/auth/drain';
import {
  BACKWARDS_TOLERANCE_MS,
  leaseVerdict,
  offlineAllows,
  verifyLease,
  type HeldLease,
} from '../src/data/auth/lease';
import {
  ARGON2_PARAMS,
  MAX_PIN_ATTEMPTS,
  argon2idKdf,
  createUserKey,
  openText,
  sealText,
  unwrapUserKey,
  type PinKdf,
} from '../src/data/auth/pin';
import { memoryStore } from '../src/data/auth/store';
import {
  exportPublicJwk,
  generateDeviceKeyPair,
  jwkThumbprint,
  signEs256,
} from '../src/data/auth/webcrypto';
import { openTestDb } from './helpers/node-db';

/** A cheap KDF for the logic tests; the real one is exercised once, below. */
const fastKdf: PinKdf = async (pin, salt) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${pin}:${Array.from(salt).join(',')}`));
  return new Uint8Array(d);
};

describe('the PIN (§2.7)', () => {
  it('Argon2id parameters are §2.7\'s — 64 MiB, t=3, p=1 — and are not quietly lowered', () => {
    expect(ARGON2_PARAMS).toEqual({ memorySize: 65536, iterations: 3, parallelism: 1, hashLength: 32 });
  });

  it('the real Argon2id derivation runs and is deterministic for a salt', async () => {
    const salt = new Uint8Array(16).fill(7);
    const a = await argon2idKdf('123456', salt);
    const b = await argon2idKdf('123456', salt);
    const c = await argon2idKdf('123457', salt);
    expect(a.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  }, 60_000);

  it('the right PIN unwraps the user key; a wrong one does not; a non-6-digit PIN is refused', async () => {
    const { record, dataKey } = await createUserKey('482913', fastKdf);
    const sealed = await sealText(dataKey, 'refresh-secret');
    const good = await unwrapUserKey(record, '482913', fastKdf);
    expect(good).not.toBeNull();
    expect(await openText(good!, sealed)).toBe('refresh-secret');
    expect(await unwrapUserKey(record, '482914', fastKdf)).toBeNull();
    expect(await unwrapUserKey(record, '12345', fastKdf)).toBeNull();
    await expect(createUserKey('abcdef', fastKdf)).rejects.toThrow();
  });
});

function claims(issuedAt: number, overrides: Partial<LeaseClaims> = {}): LeaseClaims {
  return {
    tid: '01911111-1111-7111-8111-111111111111',
    sub: '01911111-1111-7111-8111-222222222222',
    did: '01911111-1111-7111-8111-333333333333',
    scope: [],
    permission_snapshot_hash: `sha256:${'0'.repeat(64)}`,
    offline: { always: ['sale.record'], until_lease_expiry: ['sale.record.credit', 'stock.adjust'] },
    issued_at: issuedAt,
    full_until: issuedAt + 72 * 3600,
    hard_stop_at: issuedAt + 96 * 3600,
    ...overrides,
  };
}

describe('the offline lease (§2.7)', () => {
  const t0 = 1_800_000_000; // server issue time, seconds
  const held = (pageId = 'p1', monoAt = 1_000): HeldLease => ({
    jws: 'x',
    claims: claims(t0),
    receivedWallMs: t0 * 1000,
    receivedMonoMs: monoAt,
    pageId,
  });
  const at = (hours: number, monoHours = hours) => ({ wallMs: t0 * 1000 + hours * 3600_000, monoMs: 1_000 + monoHours * 3600_000 });

  it('full → restricted at T → sealed at T+grace', () => {
    expect(leaseVerdict(held(), at(1), null, 'p1').mode).toBe('full');
    expect(leaseVerdict(held(), at(71.9), null, 'p1').mode).toBe('full');
    expect(leaseVerdict(held(), at(72.1), null, 'p1').mode).toBe('restricted');
    expect(leaseVerdict(held(), at(95.9), null, 'p1').mode).toBe('restricted');
    expect(leaseVerdict(held(), at(96.1), null, 'p1').mode).toBe('sealed');
  });

  it('MONOTONIC elapsed wins when the wall clock is wound back (same page): no free extension', () => {
    // Wall says 10 h have passed; the monotonic clock knows 80 h have.
    const v = leaseVerdict(held(), { wallMs: t0 * 1000 + 10 * 3600_000, monoMs: 1_000 + 80 * 3600_000 }, null, 'p1');
    expect(v.mode).toBe('restricted');
    // After a reload (another page) monotonic is unavailable: wall only — §2.7's stated fallback.
    expect(leaseVerdict(held(), { wallMs: t0 * 1000 + 10 * 3600_000, monoMs: 5 }, null, 'p2').mode).toBe('full');
  });

  it('a BACKWARDS wall-clock jump past the last recorded value seals immediately', () => {
    const last = t0 * 1000 + 50 * 3600_000;
    expect(leaseVerdict(held(), at(10), last, 'p2')).toMatchObject({ mode: 'sealed', reason: 'clock_moved_backwards' });
    // An NTP-sized correction is not tampering (positive control).
    const small = leaseVerdict(held(), { wallMs: last - BACKWARDS_TOLERANCE_MS + 1, monoMs: 0 }, last, 'p2');
    expect(small.mode).toBe('full');
  });

  it('no lease → sealed (read-only), never "full"', () => {
    expect(leaseVerdict(null, at(0), null, 'p1').mode).toBe('sealed');
  });

  it('restricted mode keeps `always` codes and stops `until_lease_expiry` ones; sealed stops everything', () => {
    const c = claims(t0);
    const full = leaseVerdict(held(), at(1), null, 'p1');
    const restricted = leaseVerdict(held(), at(80), null, 'p1');
    const sealed = leaseVerdict(held(), at(100), null, 'p1');
    expect(offlineAllows(full, c, 'sale.record.credit')).toBe(true);
    expect(offlineAllows(restricted, c, 'sale.record')).toBe(true);
    expect(offlineAllows(restricted, c, 'sale.record.credit')).toBe(false);
    expect(offlineAllows(restricted, c, 'stock.adjust')).toBe(false);
    expect(offlineAllows(sealed, c, 'sale.record')).toBe(false);
    // A code that is not on the lease at all (`never`) is never offline.
    expect(offlineAllows(full, c, 'report.view.tenant')).toBe(false);
  });

  it('verifies a lease only under a pinned key with the lease typ; an unknown kid is NOT honoured', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const pinned = [{ ...pub, kid: 'lease-1' }];
    const jws = await signEs256(kp.privateKey, { kid: 'lease-1', typ: 'erp-lease+jwt' }, claims(t0) as never);
    expect(await verifyLease(jws, pinned)).not.toBeNull();
    const other = await signEs256(kp.privateKey, { kid: 'lease-9', typ: 'erp-lease+jwt' }, claims(t0) as never);
    expect(await verifyLease(other, pinned)).toBeNull();
    const wrongTyp = await signEs256(kp.privateKey, { kid: 'lease-1', typ: 'JWT' }, claims(t0) as never);
    expect(await verifyLease(wrongTyp, pinned)).toBeNull();
  });
});

async function enrolledAuth(fetchFn: typeof fetch = async () => new Response('{}', { status: 503 })) {
  const store = memoryStore();
  const keyPair = await generateDeviceKeyPair();
  const publicJwk = await exportPublicJwk(keyPair.publicKey);
  const device: DeviceRecord = {
    deviceId: '01911111-1111-7111-8111-aaaaaaaaaaaa',
    tenantId: '01911111-1111-7111-8111-111111111111',
    label: 'Till 1',
    formFactor: 'tablet',
    locationIds: [],
    keyPair,
    publicJwk,
    jkt: await jwkThumbprint(publicJwk),
  };
  await store.set('device', device);
  const auth = new DeviceAuth({ apiUrl: 'http://api.test', store, fetchFn, kdf: fastKdf });
  return { auth, store, device };
}

describe('the shared counter tablet', () => {
  it('the device key is NON-EXTRACTABLE', async () => {
    const kp = await generateDeviceKeyPair();
    expect(kp.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', kp.privateKey)).rejects.toThrow();
  });

  it('wrong PINs SEAL the user after the cap — and never delete the device or anyone\'s data', async () => {
    const { auth, store } = await enrolledAuth();
    const { record, dataKey } = await createUserKey('111111', fastKdf);
    const user: UserRecord = {
      userId: 'u1',
      displayName: 'Ama',
      wrapped: record,
      refreshSealed: await sealText(dataKey, 'r'),
      failedAttempts: 0,
      sealed: false,
      locationIds: [],
    };
    await store.set('user/u1', user);
    for (let i = 1; i < MAX_PIN_ATTEMPTS; i += 1) expect(await auth.unlock('u1', '999999')).toBe('wrong_pin');
    expect(await auth.unlock('u1', '999999')).toBe('sealed');
    // Even the RIGHT PIN no longer opens it locally: an online sign-in does.
    expect(await auth.unlock('u1', '111111')).toBe('sealed');
    expect(await store.get('device')).toBeTruthy();
    expect(await store.get('user/u1')).toBeTruthy();
  });

  it('the right PIN unlocks offline (no server needed); lock() drops the key and deletes nothing', async () => {
    const { auth, store } = await enrolledAuth();
    const { record, dataKey } = await createUserKey('222222', fastKdf);
    await store.set('user/u2', {
      userId: 'u2', displayName: 'Kofi', wrapped: record, refreshSealed: await sealText(dataKey, 'r'),
      failedAttempts: 2, sealed: false, locationIds: ['l1'],
    } satisfies UserRecord);
    expect(await auth.unlock('u2', '222222')).toBe('unlocked');
    expect(auth.current()?.userId).toBe('u2');
    expect(auth.current()?.accessToken).toBeNull(); // offline: no token, the lease governs
    expect((await store.get<UserRecord>('user/u2'))!.failedAttempts).toBe(0);
    auth.lock();
    expect(auth.current()).toBeNull();
    expect(await store.get('user/u2')).toBeTruthy();
    expect((await auth.phase()).kind).toBe('signed-out');
  });
});

describe('drain before wipe (§2.7)', () => {
  async function queued(db: ReturnType<typeof openTestDb>, n: number) {
    for (let i = 0; i < n; i += 1) {
      const id = crypto.randomUUID();
      await db.execute(
        `INSERT INTO outbox (id, idempotency_key, claimed_hlc, kind, payload, created_at, queue_seq)
         VALUES (?, ?, NULL, 'sale', '{"tender":"CASH"}', ?, ?)`,
        [id, id, new Date().toISOString(), i + 1],
      );
    }
  }

  it('a revoked device sends its outbox to /sync/revoked-drain FIRST and wipes only once every write is acknowledged', async () => {
    const db = openTestDb();
    await queued(db, 3);
    const calls: string[] = [];
    let wiped = false;
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push(String(url));
      const body = JSON.parse(String(init?.body)) as { ops: { idempotency_key: string }[] };
      // Acknowledge only the first two on the first call.
      const acks = body.ops.slice(0, calls.length === 1 ? 2 : 3).map((o) => ({
        key: o.idempotency_key, status: 'quarantined', reviewId: crypto.randomUUID(),
      }));
      return new Response(JSON.stringify({ acks }), { status: 200 });
    };
    const { auth } = await enrolledAuth(fetchFn);
    await auth.markRevoked({ drain: 'allowed', drainUntil: Math.floor(Date.now() / 1000) + 3600 });
    const deps = { apiUrl: 'http://api.test', db, auth, fetchFn, wipeLocal: async () => { wiped = true; } };
    const first = await runRevokedDrain(deps);
    expect(first).toEqual({ kind: 'draining', remaining: 1 });
    expect(wiped).toBe(false); // NOT before the server has everything
    expect(await auth.device()).not.toBeNull();
    const second = await runRevokedDrain(deps);
    expect(second).toEqual({ kind: 'wiped', undrained: 0 });
    expect(wiped).toBe(true);
    expect(await auth.device()).toBeNull();
    expect(calls.every((u) => u === 'http://api.test/sync/revoked-drain')).toBe(true);
  });

  it('an unreachable server changes NOTHING — no wipe, writes kept', async () => {
    const db = openTestDb();
    await queued(db, 2);
    let wiped = false;
    const fetchFn: typeof fetch = async () => {
      throw new TypeError('network down');
    };
    const { auth } = await enrolledAuth(fetchFn);
    await auth.markRevoked({ drain: 'allowed', drainUntil: null });
    const out = await runRevokedDrain({ apiUrl: 'http://api.test', db, auth, fetchFn, wipeLocal: async () => { wiped = true; } });
    expect(out).toEqual({ kind: 'waiting', remaining: 2 });
    expect(wiped).toBe(false);
  });

  it('STOLEN wipes on contact; 24 h after the first 423 the device reports the COUNT and wipes', async () => {
    const db = openTestDb();
    await queued(db, 4);
    let wiped = false;
    const { auth } = await enrolledAuth();
    await auth.markRevoked({ drain: 'refused', drainUntil: null });
    expect(await runRevokedDrain({ apiUrl: 'http://api.test', db, auth, wipeLocal: async () => { wiped = true; } }))
      .toEqual({ kind: 'wiped', undrained: 4 });
    expect(wiped).toBe(true);

    const db2 = openTestDb();
    await queued(db2, 5);
    const sent: unknown[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{"ok":true}', { status: 200 });
    };
    const late = await enrolledAuth(fetchFn);
    await late.auth.markRevoked({ drain: 'allowed', drainUntil: null });
    const out = await runRevokedDrain({
      apiUrl: 'http://api.test', db: db2, auth: late.auth, fetchFn,
      wipeLocal: async () => undefined,
      nowMs: () => Date.now() + 25 * 3600_000,
    });
    expect(out).toEqual({ kind: 'wiped', undrained: 5 });
    expect(sent).toEqual([{ url: 'http://api.test/sync/revoked-drain/abandoned', body: { undrainedCount: 5 } }]);
  });
});
