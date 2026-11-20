/**
 * THE IDENTITY WIRE, BOTH SIDES AT ONCE.
 *
 * The PWA's real `DeviceAuth` (apps/web/src/data/auth) against the API's real
 * identity routes (apps/api/src/identity) — no doubles for either side. Only
 * the socket is simulated (`app.inject`), and the IdP is a key pair that
 * honours PKCE and the nonce exactly as a real provider must.
 *
 * What this proves that neither side's own suite can:
 *   · the DPoP proofs WebCrypto produces verify under the server's verifier,
 *     and the thumbprint the client computes is the one the server binds;
 *   · the authorization-code + PKCE round trip, with the nonce bound to the
 *     device key, signs a person in end to end;
 *   · the lease the server signs verifies under the pins the client keeps;
 *   · a revocation reaches the client as 423, the outbox drains to REVIEW,
 *     and the device wipes only after the server has every write.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { createIdentityRig, IDP_ISSUER, API, type IdentityRig } from '../../../apps/api/test/identity-harness.js';
import { DeviceAuth } from '../../../apps/web/src/data/auth/device-auth';
import { runRevokedDrain } from '../../../apps/web/src/data/auth/drain';
import { memoryStore } from '../../../apps/web/src/data/auth/store';
import type { PinKdf } from '../../../apps/web/src/data/auth/pin';
import { CredentialCache } from '../../../apps/web/src/data/sync/credentials';
import { openTestDb } from '../../../apps/web/tests/helpers/node-db';

let rig: IdentityRig;
let tenant: string;
let outlet: string;

const fastKdf: PinKdf = async (pin, salt) =>
  new Uint8Array(createHash('sha256').update(`${pin}:${Buffer.from(salt).toString('hex')}`).digest());

/** The socket: API calls go through app.inject; the IdP's token endpoint is simulated. */
function makeFetch(sub: string, authorizeUrl: { current: string | null }): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === new URL(IDP_ISSUER).origin) {
      // A real provider's token endpoint: PKCE verified, nonce echoed.
      const form = new URLSearchParams(String(init?.body));
      const auth = new URL(authorizeUrl.current!);
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== auth.searchParams.get('code_challenge')) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      const idToken = await rig.idToken(sub, auth.searchParams.get('nonce')!);
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const res = await rig.app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: `${url.pathname}${url.search}`,
      headers,
      ...(init?.body !== undefined ? { payload: String(init.body) } : {}),
    });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function pendingStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

beforeAll(async () => {
  rig = await createIdentityRig();
  tenant = await rig.h.provisionTenant('wire-identity');
  await rig.h.applyTemplate(tenant, true);
  outlet = (await rig.h.firstOutlet(tenant)).id;
});

afterAll(async () => {
  await rig.close();
});

describe('the PWA device controller against the real identity routes', () => {
  it('enrols, signs in through PKCE, sets a PIN, calls the API with DPoP, and holds a verified lease', async () => {
    const sub = `idp|${uuidv7()}`;
    const userId = await rig.linkedUser(tenant, sub, 'outlet_manager', outlet);
    const authorizeUrl = { current: null as string | null };
    const fetchFn = makeFetch(sub, authorizeUrl);
    const store = memoryStore();
    const auth = new DeviceAuth({ apiUrl: API, store, fetchFn, kdf: fastKdf, pendingStore: pendingStore() });

    // Enrol with a code the back office issued.
    const code = await rig.issueCode(tenant, outlet);
    const enrolled = await auth.enrol(code);
    expect(enrolled.tenantId).toBe(tenant);
    const device = await auth.device();
    const serverJkt = await rig.h.db.withTenant(tenant, async (tx) =>
      (await tx.query<{ jkt: string }>(`select jkt from app.device where id = $1`, [enrolled.deviceId])).rows[0]?.jkt,
    );
    expect(serverJkt).toBe(device!.jkt); // the client's thumbprint IS the server's binding

    // Sign in: authorize URL → (IdP) → callback → token → our session.
    authorizeUrl.current = await auth.beginSignIn('http://pwa.test/auth/callback');
    const a = new URL(authorizeUrl.current);
    expect(a.searchParams.get('code_challenge_method')).toBe('S256');
    expect(a.searchParams.get('nonce')!.startsWith(`${device!.jkt}.`)).toBe(true);
    const session = await auth.completeSignIn(
      `http://pwa.test/auth/callback?code=c0de&state=${a.searchParams.get('state')}`,
    );
    expect(session.userId).toBe(userId);
    expect((await auth.phase()).kind).toBe('pin-setup');
    await auth.setPin('246810');
    expect((await auth.phase()).kind).toBe('unlocked');

    // A DPoP-bound call, headers built by the client, verified by the server.
    const url = `${API}/trpc/session.permissions`;
    const res = await fetchFn(url, { method: 'GET', headers: await auth.authorize('GET', url) });
    expect(res.status).toBe(200);

    // The lease the server signed verifies under the pins the client keeps.
    const held = await auth.heldLease();
    expect(held).not.toBeNull();
    expect(held!.claims.did).toBe(enrolled.deviceId);
    expect((await auth.leaseVerdict()).verdict.mode).toBe('full');

    // The sync-token exchange through the client's own credential cache.
    const leases: unknown[] = [];
    const cache = new CredentialCache({
      apiUrl: API,
      apiToken: '',
      powersyncUrl: 'http://ps.test',
      authorize: (m, u) => auth.authorize(m, u),
      onLease: (l) => {
        leases.push(l);
      },
      fetchFn: (u, i) => fetchFn(u, i as RequestInit) as never,
    });
    const token = await cache.get();
    expect(token.token.split('.')).toHaveLength(3);
    expect(leases).toHaveLength(1);

    // Lock is a shift change: nothing deleted; the PIN unlocks again.
    auth.lock();
    expect(await auth.unlock(userId, '135791')).toBe('wrong_pin');
    expect(await auth.unlock(userId, '246810')).toBe('unlocked');
    expect(auth.current()?.accessToken).toBeTruthy(); // refreshed online with the rotated credential
  });

  it('a revocation reaches the device as 423; the outbox drains to REVIEW; then — and only then — it wipes', async () => {
    const sub = `idp|${uuidv7()}`;
    await rig.linkedUser(tenant, sub, 'counter_staff', outlet);
    const authorizeUrl = { current: null as string | null };
    const fetchFn = makeFetch(sub, authorizeUrl);
    const auth = new DeviceAuth({ apiUrl: API, store: memoryStore(), fetchFn, kdf: fastKdf, pendingStore: pendingStore() });
    const enrolled = await auth.enrol(await rig.issueCode(tenant, outlet));
    authorizeUrl.current = await auth.beginSignIn('http://pwa.test/auth/callback');
    await auth.completeSignIn(`http://pwa.test/auth/callback?code=x&state=${new URL(authorizeUrl.current).searchParams.get('state')}`);
    await auth.setPin('112233');

    // Two writes queued while offline.
    const db = openTestDb();
    const keys = [uuidv7(), uuidv7()];
    for (const [i, k] of keys.entries()) {
      await db.execute(
        `INSERT INTO outbox (id, idempotency_key, claimed_hlc, kind, payload, created_at, queue_seq)
         VALUES (?, ?, NULL, 'sale', ?, ?, ?)`,
        [k, k, JSON.stringify({ locationId: outlet, tender: 'CASH', lines: [] }), new Date().toISOString(), i + 1],
      );
    }

    await rig.h.callerFor(await rig.h.identityFor(tenant)).admin.devices.revoke({
      idempotencyKey: uuidv7(),
      deviceId: enrolled.deviceId,
      reason: 'lost',
    });

    // The next sync-token exchange hears 423 and records it.
    const cache = new CredentialCache({
      apiUrl: API,
      apiToken: '',
      powersyncUrl: 'http://ps.test',
      authorize: (m, u) => auth.authorize(m, u),
      onRevoked: (b) => auth.markRevoked(b),
      fetchFn: (u, i) => fetchFn(u, i as RequestInit) as never,
    });
    await expect(cache.get()).rejects.toThrow();
    expect((await auth.revoked())?.drain).toBe('allowed');

    let wiped = false;
    const out = await runRevokedDrain({ apiUrl: API, db, auth, fetchFn, wipeLocal: async () => { wiped = true; } });
    expect(out).toEqual({ kind: 'wiped', undrained: 0 });
    expect(wiped).toBe(true);
    const reviews = await rig.h.db.withTenant(tenant, async (tx) =>
      (await tx.query<{ conflict_class: string }>(
        `select conflict_class from app.conflict_review where entity_id = $1`,
        [enrolled.deviceId],
      )).rows,
    );
    expect(reviews.map((r) => r.conflict_class)).toEqual(['REVOKED_DEVICE_WRITE', 'REVOKED_DEVICE_WRITE']);
    const sales = await rig.h.db.withTenant(tenant, async (tx) =>
      (await tx.query(`select 1 from app.sale where write_id = any($1::uuid[])`, [keys])).rows.length,
    );
    expect(sales).toBe(0); // nothing posted into the books
    expect(await auth.device()).toBeNull();
  });
});
