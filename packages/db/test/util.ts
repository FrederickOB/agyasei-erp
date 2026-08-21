/** Shared fixtures for the @erp/db test suites. */
import { createHlcClock, randomHlcNode } from '../src/hlc.js';
import { sha256Hex, uuidv7 } from '../src/ids.js';
import { seedGhanaJurisdiction } from '../src/seed/ghana.js';
import { createTenant, createTestDb, type Queryable, type TestDb } from '../src/testing/harness.js';

export const TENANT_A = '018f0000-0000-8000-8000-0000000000aa';
export const TENANT_B = '018f0000-0000-8000-8000-0000000000bb';

const clock = createHlcClock(randomHlcNode());

export async function setupDb(): Promise<TestDb> {
  const db = await createTestDb();
  await db.asAdmin((tx) => seedGhanaJurisdiction(tx));
  return db;
}

export async function setupTwoTenants(db: TestDb): Promise<void> {
  await createTenant(db, { id: TENANT_A, slug: 'tenant-a', legalName: 'Tenant A Ltd' });
  await createTenant(db, { id: TENANT_B, slug: 'tenant-b', legalName: 'Tenant B Ltd' });
}

/**
 * Insert a DEVICE-origin write_log row for the current tenant and return its
 * id — the unit-of-work spine every business row must reference.
 */
export async function newWrite(tx: Queryable, tenantId: string, op = 'test.write'): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `insert into app.write_log
       (tenant_id, id, origin, hlc, claimed_hlc, device_id, user_id, location_id,
        op, schema_version, request_hash)
     values ($1, $2, 'DEVICE', $3, $4, $5, $6, null, $7, 1, decode($8, 'hex'))`,
    [tenantId, id, clock.next(), clock.next(), uuidv7(), uuidv7(), op, sha256Hex(op + id)],
  );
  return id;
}

export function nextHlc(): string {
  return clock.next();
}
