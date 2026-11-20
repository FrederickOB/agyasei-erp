/**
 * DRAIN BEFORE WIPE (02-security §2.7) — what a revoked device does.
 *
 * The earlier design wiped the outbox on revocation, "because those writes
 * will be quarantined server-side anyway". That was false: the outbox is BY
 * DEFINITION the writes the server does not have. A tablet reported stolen at
 * 09:00 and found in the stockroom at 11:00 would have destroyed three days of
 * unsynced sales before uploading any of them. So:
 *
 *   1. The server answers `423 LOCKED reason=device_revoked` — retryable, so
 *      the device keeps trying to reach it rather than giving up.
 *   2. The device's first act is a drain-only upload to /sync/revoked-drain,
 *      authenticated by its KEY alone (its sessions are dead). Every write
 *      becomes a REVOKED_DEVICE_WRITE review; NOTHING posts to the books.
 *   3. The ordinary upload queue stays blocked throughout (the runtime does
 *      not drain while revoked): either the server has the write, or the
 *      server has it in review, or the queue stays blocked.
 *   4. The wipe happens only once the server has acknowledged every write —
 *      then it is complete: local database, device key, wrapped user keys,
 *      cached tokens and leases.
 *   5. 24 hours after the first 423 the device wipes anyway, first reporting
 *      the COUNT of undrained writes (a bare number succeeds far more often
 *      over 2G than a bulk upload); the server raises a severity-1 alarm.
 *
 * `stolen` (drain = refused) wipes on contact — the revoking user's explicit,
 * audited choice, never a default.
 */
import { drainResponse, uploadBodySchema, type UploadBody } from '@erp/contracts';
import type { LocalDb } from '../db';
import { readPendingOps } from '../sync/upload';
import type { DeviceAuth } from './device-auth';

export const DRAIN_DEADLINE_MS = 24 * 60 * 60 * 1000;

export type DrainOutcome =
  /** Everything acknowledged (or nothing to send, or stolen): the device is wiped. */
  | { readonly kind: 'wiped'; readonly undrained: number }
  /** Progress was made; more remains. Call again. */
  | { readonly kind: 'draining'; readonly remaining: number }
  /** The server could not be reached. Nothing changed. Call again later. */
  | { readonly kind: 'waiting'; readonly remaining: number };

export interface DrainDeps {
  readonly apiUrl: string;
  readonly db: LocalDb;
  readonly auth: DeviceAuth;
  /** Clear the local database — PowerSync disconnectAndClear, outbox included. */
  readonly wipeLocal: () => Promise<void>;
  readonly fetchFn?: typeof fetch;
  readonly nowMs?: () => number;
}

async function pendingCount(db: LocalDb): Promise<number> {
  const rows = await db.getAll(
    `SELECT count(*) AS n FROM outbox WHERE server_ack_at IS NULL AND rejected_at IS NULL`,
  );
  return Number(rows[0]?.['n'] ?? 0);
}

async function wipe(deps: DrainDeps, undrained: number): Promise<DrainOutcome> {
  await deps.wipeLocal();
  await deps.auth.wipeIdentity();
  return { kind: 'wiped', undrained };
}

export async function runRevokedDrain(deps: DrainDeps): Promise<DrainOutcome> {
  const fetchFn = deps.fetchFn ?? ((...a) => fetch(...a));
  const now = deps.nowMs ?? Date.now;
  const revoked = await deps.auth.revoked();
  if (!revoked) throw new Error('runRevokedDrain called on a device that is not revoked');

  // Stolen: wipe on contact. The revoker chose this, audited, at revocation.
  if (revoked.drain === 'refused') return wipe(deps, await pendingCount(deps.db));

  const remaining = await pendingCount(deps.db);
  if (remaining === 0) return wipe(deps, 0);

  const deadlinePassed =
    now() - revoked.firstSeenMs >= DRAIN_DEADLINE_MS ||
    (revoked.drainUntilS !== null && now() / 1000 > revoked.drainUntilS);
  if (deadlinePassed) {
    // The bare count, best effort. If even that fails the loss is unattributed —
    // stated in §2.7, and the reason the 60-second sync criterion is a security one.
    const url = `${deps.apiUrl}/sync/revoked-drain/abandoned`;
    try {
      await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', dpop: await deps.auth.deviceProof('POST', url) },
        body: JSON.stringify({ undrainedCount: remaining }),
      });
    } catch {
      // nothing more can be done from here
    }
    return wipe(deps, remaining);
  }

  const ops = await readPendingOps(deps.db);
  const body: UploadBody = {
    ops: ops.map((op) => ({
      idempotency_key: op.idempotencyKey,
      ...(op.claimedHlc !== null ? { claimed_hlc: op.claimedHlc } : {}),
      client_wall_at: op.createdAt,
      kind: op.kind,
      payload: JSON.parse(op.payloadJson) as Record<string, unknown>,
    })),
  };
  if (!uploadBodySchema.safeParse(body).success) return { kind: 'waiting', remaining };

  const url = `${deps.apiUrl}/sync/revoked-drain`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', dpop: await deps.auth.deviceProof('POST', url) },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'waiting', remaining };
  }
  if (res.status === 423) {
    // The server now says stolen: wipe on contact.
    return wipe(deps, remaining);
  }
  if (res.status === 410) {
    // The server's window closed: report the count, then wipe.
    await deps.auth.markRevoked({ drain: 'allowed', drainUntil: 0 });
    return runRevokedDrain(deps);
  }
  if (!res.ok) return { kind: 'waiting', remaining };
  const parsed = drainResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return { kind: 'waiting', remaining };

  const acked = new Map(parsed.data.acks.map((a) => [a.key, a] as const));
  const stamp = new Date(now()).toISOString();
  await deps.db.writeTransaction(async (tx) => {
    for (const op of ops) {
      const ack = acked.get(op.idempotencyKey);
      if (!ack || ack.status === 'rejected') continue; // stays pending; retried
      // The server HAS it — in review (quarantined) or already in the books
      // (duplicate). Either way it is no longer only on this device.
      await tx.execute(
        `UPDATE outbox SET server_ack_at = ?, last_refusal_reason = ?, last_refusal_at = ?
          WHERE id = ? AND server_ack_at IS NULL AND rejected_at IS NULL`,
        [
          stamp,
          ack.status === 'quarantined'
            ? `QUARANTINED: revoked device — review ${ack.reviewId ?? ''}`.trim()
            : 'DUPLICATE: already applied before revocation',
          stamp,
          op.id,
        ],
      );
    }
  });
  const left = await pendingCount(deps.db);
  if (left === 0) return wipe(deps, 0);
  return { kind: 'draining', remaining: left };
}
