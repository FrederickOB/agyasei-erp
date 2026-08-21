/**
 * The idempotent write pipeline — every mutation in this package goes
 * through runIdempotent(). It implements 03 §3.3 against the ONE write
 * registry, app.write_log, whose PRIMARY KEY (tenant_id, id) makes
 * idempotency-key uniqueness PER TENANT, never global (ADR-0005).
 *
 * Shape of one application, all inside ONE transaction (marker and effect
 * commit atomically — §3.3.3):
 *
 *   1. SELECT the key from write_log. Found ⇒ this is a RETRY:
 *      - request_hash differs  → 409 IDEMPOTENCY_KEY_REUSE, apply nothing;
 *      - matches               → return the STORED response verbatim.
 *   2. plan(tx): READS ONLY — price lines, resolve rates, compute totals,
 *      build the full response DTO and the list of row inserts.
 *   3. INSERT the write_log row — server-stamped HLC, the device's claim
 *      stored as claimed_hlc (UNTRUSTED), and response_body ALREADY SET
 *      (the registry is append-only: there is no post-hoc UPDATE, so the
 *      response is computed before the marker is written).
 *      ON CONFLICT (tenant_id, id) DO NOTHING; zero rows back means a
 *      concurrent twin won the race → abort this transaction untouched and
 *      replay the winner's stored response.
 *   4. apply(tx): insert the business rows. Every one carries write_id with
 *      a composite FK back to the marker, so omitting the key is a
 *      foreign-key violation, not a convention.
 *
 * If plan() or apply() throws, the whole transaction — marker included —
 * rolls back, and a retry gets a genuine fresh attempt: correct, because
 * nothing was applied.
 *
 * The response DTO must be JSON-safe with every monetary magnitude a
 * decimal string (serializeMoney contract): it is stored in response_body
 * and replayed VERBATIM, so original and replay are indistinguishable.
 */
import { TRPCError } from '@trpc/server';
import type { HlcClock } from '@erp/db';
import { requestHashHex } from './canonical.js';
import type { Queryable, TenantRunner } from './db.js';

/** JSON-safe response value — what response_body can hold and replay. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface WriteIdentity {
  tenantId: string;
  userId: string;
  deviceId: string;
}

export interface WriteMeta {
  /** e.g. 'sale.create' — the write_log.op discriminator. */
  op: string;
  /** Client-generated UUIDv7. THE idempotency key (write_log.id). */
  idempotencyKey: string;
  /** The device's own HLC assertion. Stored as claimed_hlc; UNTRUSTED. */
  claimedHlc?: string | undefined;
  /** The device's wall clock. Stored as client_wall_at; forensics only. */
  clientWallAt?: string | undefined;
  /** Validated location for this write (from the session-checked input). */
  locationId?: string | null | undefined;
}

export interface Plan<R extends JsonValue> {
  response: R;
  apply: (tx: Queryable) => Promise<void>;
}

export interface WriteResult<R extends JsonValue> {
  replayed: boolean;
  response: R;
}

/** Bounded skew: beyond ±24h the write is refused RETRYABLY, before the
 *  claim can enter anything (03 §3.4.1 — the 2030-tablet corruption path). */
const SKEW_LIMIT_MS = 24 * 60 * 60 * 1000;

class ReplayRace extends Error {
  constructor() {
    super('concurrent duplicate won the write_log insert');
  }
}

interface StoredRow {
  response_body: JsonValue | null;
  hash_hex: string;
}

async function readStored(tx: Queryable, key: string): Promise<StoredRow | undefined> {
  const res = await tx.query<StoredRow>(
    `select response_body, encode(request_hash, 'hex') as hash_hex
     from app.write_log where id = $1`,
    [key],
  );
  return res.rows[0];
}

function replayOrRefuse<R extends JsonValue>(stored: StoredRow, hashHex: string): WriteResult<R> {
  if (stored.hash_hex !== hashHex) {
    // Same key, different payload: a client bug, never a retry. Apply
    // nothing — silently applying the second version is exactly the
    // corruption the registry exists to prevent (§3.3.3).
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'IDEMPOTENCY_KEY_REUSE: this key was already used with a different payload',
    });
  }
  if (stored.response_body === null) {
    // The first writer's transaction has not committed its response yet
    // (or a SERVER-origin row shares the key). Retryable, never definitive.
    throw new TRPCError({ code: 'CONFLICT', message: 'RETRY_LATER: first application still in flight' });
  }
  return { replayed: true, response: stored.response_body as R };
}

export async function runIdempotent<R extends JsonValue>(
  deps: { runner: TenantRunner; clock: HlcClock },
  identity: WriteIdentity,
  meta: WriteMeta,
  input: unknown,
  plan: (tx: Queryable) => Promise<Plan<R>>,
): Promise<WriteResult<R>> {
  const hashHex = requestHashHex(meta.op, input);

  // Clamp at the ingest boundary, BEFORE the claim can touch the shared
  // order. Refused retryably: the client resyncs its clock and resends the
  // identical queued mutation — nothing is lost, nothing poisoned enters.
  if (meta.claimedHlc !== undefined) {
    const claimedWall = Number(meta.claimedHlc.slice(0, 13));
    if (Math.abs(claimedWall - Date.now()) > SKEW_LIMIT_MS) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'CLOCK_RESYNC_REQUIRED: device clock skew exceeds ±24h — resync and retry (03 §3.4.1)',
      });
    }
  }

  try {
    return await deps.runner.withTenant(identity.tenantId, async (tx) => {
      // 1 — retry detection.
      const stored = await readStored(tx, meta.idempotencyKey);
      if (stored) return replayOrRefuse<R>(stored, hashHex);

      // 2 — pure plan: reads and arithmetic only.
      const planned = await plan(tx);

      // 3 — the marker, response included, server-stamped HLC. The client's
      // clock value lands ONLY in claimed_hlc / client_wall_at (untrusted).
      const ins = await tx.query<{ id: string }>(
        `insert into app.write_log
           (tenant_id, id, origin, hlc, claimed_hlc, device_id, user_id, location_id,
            op, schema_version, request_hash, response_body, client_wall_at)
         values ($1, $2, 'DEVICE', $3, $4, $5, $6, $7, $8, 1, decode($9, 'hex'), $10::jsonb, $11)
         on conflict (tenant_id, id) do nothing
         returning id`,
        [
          identity.tenantId,
          meta.idempotencyKey,
          deps.clock.next(),
          meta.claimedHlc ?? null,
          identity.deviceId,
          identity.userId,
          meta.locationId ?? null,
          meta.op,
          hashHex,
          JSON.stringify(planned.response),
          meta.clientWallAt ?? null,
        ],
      );
      if (ins.rows.length === 0) throw new ReplayRace();

      // 4 — the effect, same transaction as the marker.
      await planned.apply(tx);
      return { replayed: false, response: planned.response };
    });
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    const isRace =
      err instanceof ReplayRace || /duplicate key|unique/i.test(err instanceof Error ? err.message : '');
    if (!isRace) throw err;
    // A concurrent twin beat us somewhere (write_log PK, or a business-row
    // unique like receipt_no). Our transaction rolled back untouched; the
    // winner's stored response is the answer.
    const stored = await deps.runner.withTenant(identity.tenantId, (tx) =>
      readStored(tx, meta.idempotencyKey),
    );
    if (stored) return replayOrRefuse<R>(stored, hashHex);
    throw err;
  }
}
