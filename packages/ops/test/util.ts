/**
 * Fixtures for @erp/ops: the real migrations on PGlite, two tenants, and the
 * ops seams (OpsDb, LockProvider) adapted onto the harness — so the code
 * under test is the production code, running against real Postgres with RLS
 * genuinely enforced (the harness's withTenant is SET LOCAL ROLE app_user).
 */
import { createHlcClock, randomHlcNode, sha256Hex, uuidv7 } from '@erp/db';
import { seedGhanaJurisdiction } from '@erp/db/seed';
import { createTenant, createTestDb, type Queryable, type TestDb } from '@erp/db/testing';
import type { LockProvider, OpsDb } from '../src/db.js';

export const TENANT_A = '018f0000-0000-8000-8000-0000000000aa';
export const TENANT_B = '018f0000-0000-8000-8000-0000000000bb';

const clock = createHlcClock(randomHlcNode());

export async function setup(): Promise<TestDb> {
  const db = await createTestDb();
  await db.asAdmin((tx) => seedGhanaJurisdiction(tx));
  await createTenant(db, { id: TENANT_A, slug: 'tenant-a' });
  await createTenant(db, { id: TENANT_B, slug: 'tenant-b' });
  return db;
}

export function opsOf(db: TestDb): OpsDb {
  return {
    query: (sql, params) => db.asAdmin((tx) => tx.query(sql, params)),
    transaction: (fn) => db.asAdmin(fn),
  };
}

/** In-process stand-in for the advisory lock: same contract, observable. */
export function memoryLocks(): LockProvider & { held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    async tryWithLock(name, fn) {
      if (held.has(name)) return { acquired: false };
      held.add(name);
      try {
        return { acquired: true, value: await fn() };
      } finally {
        held.delete(name);
      }
    },
  };
}

/** A DEVICE-origin write for the current tenant, at a chosen receive time. */
export async function deviceWrite(
  tx: Queryable,
  tenantId: string,
  opts: { deviceId: string; locationId?: string | null; receivedAt?: string; op?: string },
): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `insert into app.write_log
       (tenant_id, id, origin, hlc, claimed_hlc, device_id, user_id, location_id,
        op, schema_version, request_hash, received_at)
     values ($1, $2, 'DEVICE', $3, null, $4, $5, $6, $7, 1, decode($8, 'hex'), coalesce($9::timestamptz, transaction_timestamp()))`,
    [
      tenantId,
      id,
      clock.next(),
      opts.deviceId,
      uuidv7(),
      opts.locationId ?? null,
      opts.op ?? 'test.write',
      sha256Hex(id),
      opts.receivedAt ?? null,
    ],
  );
  return id;
}

/** A SERVER-origin write marker (the spine every business row references). */
export async function serverWrite(tx: Queryable, tenantId: string, op = 'test.server'): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `insert into app.write_log
       (tenant_id, id, origin, hlc, claimed_hlc, device_id, user_id, location_id,
        op, schema_version, request_hash)
     values ($1, $2, 'SERVER', $3, null, null, null, null, $4, 1, decode($5, 'hex'))`,
    [tenantId, id, clock.next(), op, sha256Hex(id)],
  );
  return id;
}

export function nextHlc(): string {
  return clock.next();
}

export { uuidv7 };
