/**
 * app.write_log — the ONE write registry (04 §4.2.2).
 *
 * write_log.id IS the idempotency key, and PRIMARY KEY (tenant_id, id)
 * scopes its uniqueness PER TENANT, never globally (ADR-0005; CLAUDE.md
 * §2.1). The ingest shape is INSERT ... ON CONFLICT DO NOTHING: a retry
 * after a flaky sync is a no-op, and two tenants can mint the same key
 * without colliding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import { sha256Hex } from '../src/ids.js';
import type { TestDb } from '../src/testing/harness.js';
import { nextHlc, setupDb, setupTwoTenants, TENANT_A, TENANT_B } from './util.js';

let db: TestDb;

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);
});
afterAll(async () => {
  await db.close();
});

function ingest(tenantId: string, key: string, response: string | null = null) {
  return db.withTenant(tenantId, (tx) =>
    tx.query(
      `insert into app.write_log
         (tenant_id, id, origin, hlc, claimed_hlc, device_id, user_id, location_id,
          op, schema_version, request_hash, response_body)
       values ($1, $2, 'DEVICE', $3, $4, $5, $6, null, 'sale.create', 1, decode($7, 'hex'), $8)
       on conflict (tenant_id, id) do nothing`,
      [tenantId, key, nextHlc(), nextHlc(), uuidv7(), uuidv7(), sha256Hex(key), response],
    ),
  );
}

describe('write_log idempotency', () => {
  it('same (tenant, key) twice → exactly one row', async () => {
    const key = uuidv7();
    await ingest(TENANT_A, key, '{"receipt":"R-1"}');
    await ingest(TENANT_A, key, '{"receipt":"R-DIFFERENT"}'); // retry: swallowed
    const res = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ n: string; response_body: unknown }>(
        'select count(*)::text as n from app.write_log where id = $1',
        [key],
      ),
    );
    expect(res.rows[0]!.n).toBe('1');
    // The FIRST write's response survives, to be replayed verbatim on retry.
    const body = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ response_body: { receipt: string } }>(
        'select response_body from app.write_log where id = $1',
        [key],
      ),
    );
    expect(body.rows[0]!.response_body).toEqual({ receipt: 'R-1' });
  });

  it('same key, DIFFERENT tenant → two independent rows (uniqueness is per tenant, never global)', async () => {
    const key = uuidv7();
    await ingest(TENANT_A, key);
    await ingest(TENANT_B, key);
    const res = await db.asAdmin((tx) =>
      tx.query<{ tenant_id: string }>('select tenant_id from app.write_log where id = $1 order by tenant_id', [key]),
    );
    expect(res.rows.map((r) => r.tenant_id).sort()).toEqual([TENANT_A, TENANT_B].sort());
  });

  it('without ON CONFLICT the duplicate is a loud unique violation, not a second row', async () => {
    const key = uuidv7();
    await ingest(TENANT_A, key);
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `insert into app.write_log
             (tenant_id, id, origin, hlc, device_id, user_id, op, schema_version, request_hash)
           values ($1, $2, 'DEVICE', $3, $4, $5, 'sale.create', 1, decode($6, 'hex'))`,
          [TENANT_A, key, nextHlc(), uuidv7(), uuidv7(), sha256Hex(key)],
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('stores the server-stamped hlc AND the untrusted claimed_hlc separately', async () => {
    const key = uuidv7();
    await ingest(TENANT_A, key);
    const res = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ hlc: string; claimed_hlc: string }>(
        'select hlc, claimed_hlc from app.write_log where id = $1',
        [key],
      ),
    );
    const row = res.rows[0]!;
    expect(row.hlc).toMatch(/^[0-9]{13}-[0-9]{5}-[0-9a-f]{32}$/);
    expect(row.claimed_hlc).toMatch(/^[0-9]{13}-[0-9]{5}-[0-9a-f]{32}$/);
    expect(row.hlc).not.toBe(row.claimed_hlc);
  });

  it('a DEVICE write must carry device and user identity; SERVER writes need neither', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
           values ($1, $2, 'DEVICE', $3, 'x', 1, decode('00', 'hex'))`,
          [TENANT_A, uuidv7(), nextHlc()],
        ),
      ),
    ).rejects.toThrow(/check constraint|violates/i);

    // SERVER-origin (scheduled jobs, template application): no device, no user.
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(
        `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
         values ($1, $2, 'SERVER', $3, 'template.apply:test', 1, decode('00', 'hex'))`,
        [TENANT_A, uuidv7(), nextHlc()],
      ),
    );
  });

  it('the registry is append-only: UPDATE and DELETE are refused for app_user', async () => {
    const key = uuidv7();
    await ingest(TENANT_A, key);
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update app.write_log set op = 'tampered' where id = $1`, [key]),
      ),
    ).rejects.toThrow(/permission denied|append-only/i);
    await expect(
      db.withTenant(TENANT_A, (tx) => tx.query('delete from app.write_log where id = $1', [key])),
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('a malformed hlc is rejected by the domain — the shape is load-bearing', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
           values ($1, $2, 'SERVER', 'not-an-hlc', 'x', 1, decode('00', 'hex'))`,
          [TENANT_A, uuidv7()],
        ),
      ),
    ).rejects.toThrow(/hlc|check/i);
  });
});
