/**
 * THE OTHER SIDE OF THE WIRE — the token, not the payload.
 *
 * A device now configures itself from the `locs` claim of the bearer it holds
 * (apps/web/src/data/session/bearer-claims.ts), because that is the claim the
 * API enforces every write against (`assertLocationInScope`, apps/api/src/trpc.ts).
 * That makes the token a client↔server contract in exactly the way the sale
 * payload was, and it fails in exactly the same silent way: the API renames or
 * reshapes a claim, the client keeps reading the old one, and every device in
 * the fleet quietly stops being able to tell which counter it is standing at.
 *
 * So this file imports BOTH real implementations — the API's own signer and
 * the PWA's own reader — and proves they agree. No fixture token, no copy of
 * the claim set. Nothing here needs a database: it is a shape test, and it
 * should stay one so it always runs.
 */
import { describe, expect, it } from 'vitest';

import { signDevToken, verifyToken } from '../../../apps/api/src/auth.js';
import { readBearerScope } from '../../../apps/web/src/data/session/bearer-claims';

const SECRET = 'wire-conformance-secret';

const TENANT = '0192f4c1-0000-7000-8000-000000000001';
const USER = '0192f4c1-0000-7000-8000-000000000002';
const OUTLET_A = '0192f4c1-0000-7000-8000-00000000000a';
const OUTLET_B = '0192f4c1-0000-7000-8000-00000000000b';

describe('the device reads the same location scope the API enforces', () => {
  it('reads one location out of a real API-signed token', async () => {
    const token = await signDevToken(SECRET, {
      tid: TENANT,
      uid: USER,
      role: 'a tenant-defined role name',
      locs: [OUTLET_A],
    });

    const scope = readBearerScope(token);

    expect(scope).toEqual({ kind: 'scoped', locationIds: [OUTLET_A] });
    // And it is the SAME list the server derives from the same bytes — the
    // list `assertLocationInScope` will compare every sale against.
    const identity = await verifyToken(SECRET, token);
    expect(scope.kind === 'scoped' ? scope.locationIds : null).toEqual(identity.locationIds);
  });

  it('reads every location of a multi-location token, in the same order', async () => {
    const token = await signDevToken(SECRET, {
      tid: TENANT,
      uid: USER,
      role: 'a tenant-defined role name',
      locs: [OUTLET_A, OUTLET_B],
    });

    const scope = readBearerScope(token);
    const identity = await verifyToken(SECRET, token);

    expect(scope).toEqual({ kind: 'scoped', locationIds: [OUTLET_A, OUTLET_B] });
    expect(identity.locationIds).toEqual([OUTLET_A, OUTLET_B]);
  });

  it('agrees with the server that an empty claim scopes the device nowhere', async () => {
    const token = await signDevToken(SECRET, {
      tid: TENANT,
      uid: USER,
      role: 'a tenant-defined role name',
      locs: [],
    });

    expect(readBearerScope(token)).toEqual({ kind: 'scoped', locationIds: [] });
    expect((await verifyToken(SECRET, token)).locationIds).toEqual([]);
    // Both sides fail closed on the same input: the client refuses to record a
    // sale, and the server would answer FORBIDDEN to any location named.
  });

  it('reads the claim without verifying it — and that is all it is trusted for', async () => {
    const token = await signDevToken(SECRET, {
      tid: TENANT,
      uid: USER,
      role: 'a tenant-defined role name',
      locs: [OUTLET_A],
    });
    // Same claims, a signature that is not the API's. The client still reads
    // it: decoding is self-configuration, not authorization.
    const tampered = `${token.slice(0, token.lastIndexOf('.'))}.this-is-not-a-signature`;
    expect(readBearerScope(tampered)).toEqual({ kind: 'scoped', locationIds: [OUTLET_A] });
    // The server is where it stops. A device that lied to itself gets its
    // uploads refused; it never gets to file a sale anywhere.
    await expect(verifyToken(SECRET, tampered)).rejects.toThrow();
  });
});
