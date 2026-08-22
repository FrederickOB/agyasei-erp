/**
 * The capability list a screen lays itself out from.
 *
 * Two things are being pinned here, and only one of them is behaviour.
 *
 * The behaviour: a device that cannot ask must not GUESS. It has three
 * answers — live, remembered, and "I do not know" — and the third is a real
 * answer rather than a tie-breaker between the first two.
 *
 * The other thing is a boundary. Nothing in this file is a security test,
 * because none of this is security: the server re-authorises every read and
 * every write at ingest. What is tested is that a remembered list belonging
 * to somebody ELSE is never used, because one person's affordances appearing
 * in another person's session is a bug even when it grants nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY,
  CONFIG_KEY_PERMISSIONS,
  holdsCapability,
  holdsCapabilityAt,
  resolvePermissions,
  type PermissionsState,
} from '../src/data/api/session';
import type { ApiEndpoint, ApiFetch } from '../src/data/api/client';
import { openTestDb } from './helpers/node-db';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'ignored' };
const LOC_A = '018f3a1e-0000-7000-8000-00000000aaaa';
const LOC_B = '018f3a1e-0000-7000-8000-00000000bbbb';

/** A bearer this device can read a `uid` out of. Never verified — §8.1. */
function tokenFor(uid: string): string {
  const b64 = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ uid, tid: 'ignored', locs: [LOC_A] })}.sig`;
}

function answering(grants: readonly { code: string; locationId: string }[], userId: string): ApiFetch {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          result: { data: { json: { advisory: 'UX AFFORDANCE ONLY', userId, grants, locationIds: [] } } },
        }),
    });
}

const dead: ApiFetch = () => Promise.reject(new Error('no radio'));

describe('resolving what this session may do', () => {
  it('asks the server, and remembers the answer for this user', async () => {
    const db = openTestDb();
    const live = await resolvePermissions(db, {
      endpoint: ENDPOINT,
      fetchFn: answering([{ code: CAPABILITY.stockView, locationId: LOC_A }], 'user-1'),
      bearerToken: tokenFor('user-1'),
    });
    expect(live.status).toBe('live');

    const rows = await db.getAll('SELECT value FROM local_config WHERE key = ?', [
      CONFIG_KEY_PERMISSIONS,
    ]);
    expect(rows.length).toBe(1);
  });

  it('falls back to what it remembers when the server cannot be reached', async () => {
    const db = openTestDb();
    await resolvePermissions(db, {
      endpoint: ENDPOINT,
      fetchFn: answering([{ code: CAPABILITY.reportLocation, locationId: LOC_A }], 'user-1'),
      bearerToken: tokenFor('user-1'),
    });

    const offline = await resolvePermissions(db, {
      endpoint: ENDPOINT,
      fetchFn: dead,
      bearerToken: tokenFor('user-1'),
    });
    expect(offline.status).toBe('remembered');
    expect(holdsCapability(offline, CAPABILITY.reportLocation)).toBe(true);
    expect(holdsCapability(offline, CAPABILITY.reportMargin)).toBe(false);
    if (offline.status === 'remembered') expect(offline.failure.kind).toBe('offline');
  });

  it('never lends one person’s remembered list to another session', async () => {
    const db = openTestDb();
    await resolvePermissions(db, {
      endpoint: ENDPOINT,
      fetchFn: answering([{ code: CAPABILITY.reorderManage, locationId: LOC_A }], 'user-1'),
      bearerToken: tokenFor('user-1'),
    });

    const other = await resolvePermissions(db, {
      endpoint: ENDPOINT,
      fetchFn: dead,
      bearerToken: tokenFor('user-2'),
    });
    expect(other.status).toBe('unknown');
  });

  it('distinguishes a device with no server from a device that cannot reach one', async () => {
    const db = openTestDb();
    const none = await resolvePermissions(db, { endpoint: null });
    expect(none.status).toBe('no-session');
  });

  it('replaces the remembered list the next time the server answers', async () => {
    const db = openTestDb();
    await resolvePermissions(db, {
      endpoint: ENDPOINT,
      fetchFn: answering(
        [
          { code: CAPABILITY.stockView, locationId: LOC_A },
          { code: CAPABILITY.reorderManage, locationId: LOC_A },
        ],
        'user-1',
      ),
      bearerToken: tokenFor('user-1'),
    });
    // Head office takes the threshold capability away.
    const narrowed = await resolvePermissions(db, {
      endpoint: ENDPOINT,
      fetchFn: answering([{ code: CAPABILITY.stockView, locationId: LOC_A }], 'user-1'),
      bearerToken: tokenFor('user-1'),
    });
    expect(holdsCapabilityAt(narrowed, CAPABILITY.reorderManage, LOC_A)).toBe(false);

    const afterwards = await resolvePermissions(db, {
      endpoint: ENDPOINT,
      fetchFn: dead,
      bearerToken: tokenFor('user-1'),
    });
    expect(holdsCapabilityAt(afterwards, CAPABILITY.reorderManage, LOC_A)).toBe(false);
  });
});

describe('what an unanswered question means for a control', () => {
  const unknown: PermissionsState = {
    status: 'unknown',
    failure: { kind: 'offline', message: 'x', detail: null, status: null },
  };

  it('offers everything when the list could not be fetched — the screen behind it is honest', () => {
    expect(holdsCapability(unknown, CAPABILITY.reportMargin)).toBe(true);
    expect(holdsCapabilityAt(unknown, CAPABILITY.reorderManage, LOC_B)).toBe(true);
  });

  it('offers nothing server-backed on a device with no server', () => {
    const none: PermissionsState = { status: 'no-session' };
    expect(holdsCapability(none, CAPABILITY.stockView)).toBe(false);
  });

  it('is a capability AT A PLACE, never a bare capability', () => {
    const live: PermissionsState = {
      status: 'live',
      asOfMs: 0,
      snapshot: {
        userId: 'user-1',
        grants: [{ code: CAPABILITY.reorderManage, locationId: LOC_A }],
        codes: [CAPABILITY.reorderManage],
        locationIds: [LOC_A],
      },
    };
    expect(holdsCapabilityAt(live, CAPABILITY.reorderManage, LOC_A)).toBe(true);
    expect(holdsCapabilityAt(live, CAPABILITY.reorderManage, LOC_B)).toBe(false);
  });
});
