/**
 * Requirement 9.5-A digests and the backup manifest: deterministic, order-
 * independent, sensitive to change, and computed strictly inside each
 * tenant's RLS boundary. Plus the drill's comparison, which must be exact.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from '@erp/db/testing';
import { buildManifest, compareManifests, type Manifest } from '../src/backup/manifest.js';
import { digestSql, digestTables, foldLanes } from '../src/digest.js';
import { silentLogger } from '../src/log.js';
import { tableDigestJob } from '../src/jobs/builtin.js';
import { runJob } from '../src/jobs/runner.js';
import { deviceWrite, memoryLocks, opsOf, setup, TENANT_A, TENANT_B, uuidv7 } from './util.js';

let db: TestDb;
beforeAll(async () => {
  db = await setup();
  await db.withTenant(TENANT_A, async (tx) => {
    for (let i = 0; i < 5; i += 1) await deviceWrite(tx, TENANT_A, { deviceId: uuidv7() });
  });
  await db.withTenant(TENANT_B, async (tx) => {
    for (let i = 0; i < 2; i += 1) await deviceWrite(tx, TENANT_B, { deviceId: uuidv7() });
  });
});
afterAll(async () => {
  await db.close();
});

const writeLog = (tenant: string) =>
  db.withTenant(tenant, async (tx) => (await digestTables(tx, ['write_log']))[0]!);

describe('table digests', () => {
  it('fold lanes into a fixed-width, sign-independent hex digest', () => {
    expect(foldLanes(['0', '1', '-1', '4294967296'])).toBe('00000000' + '00000001' + 'ffffffff' + '00000000');
  });

  it('quotes only identifiers it recognises', () => {
    expect(() => digestSql('sale; drop table x', ['id'])).toThrow();
    expect(digestSql('sale', ['tenant_id', 'id'])).toContain('row(t."tenant_id", t."id")::text');
  });

  it('counts only the current tenant’s rows, and two tenants’ digests differ', async () => {
    const a = await writeLog(TENANT_A);
    const b = await writeLog(TENANT_B);
    expect(a.rowCount).toBe(5n);
    expect(b.rowCount).toBe(2n);
    expect(a.pkDigest).not.toBe(b.pkDigest);
    expect(a.rowDigest).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic, and changes when a row is added', async () => {
    const before = await writeLog(TENANT_A);
    expect(await writeLog(TENANT_A)).toEqual(before);
    await db.withTenant(TENANT_A, (tx) => deviceWrite(tx, TENANT_A, { deviceId: uuidv7() }));
    const after = await writeLog(TENANT_A);
    expect(after.rowCount).toBe(6n);
    expect(after.pkDigest).not.toBe(before.pkDigest);
  });

  it('the row digest catches an in-place change the key digest cannot see', async () => {
    await db.withTenant(TENANT_A, async (tx) => {
      const loc = uuidv7();
      await tx.query(
        `insert into app.write_log (tenant_id, id, origin, hlc, op, request_hash)
         values ($1, $2, 'SERVER', '0000000000001-00000-00000000000000000000000000000001', 'seed', '\\x00')`,
        [TENANT_A, loc],
      );
    });
    const before = await db.withTenant(TENANT_A, async (tx) => (await digestTables(tx, ['write_log']))[0]!);
    // write_log.response_body is the one legitimately mutable column (pruning).
    await db.asAdmin((tx) => tx.query(`alter table app.write_log disable trigger user`));
    await db.asAdmin((tx) =>
      tx.query(`update app.write_log set response_body = '{"x":1}' where tenant_id = $1 and op = 'seed'`, [TENANT_A]),
    );
    await db.asAdmin((tx) => tx.query(`alter table app.write_log enable trigger user`));
    const after = await db.withTenant(TENANT_A, async (tx) => (await digestTables(tx, ['write_log']))[0]!);
    expect(after.pkDigest).toBe(before.pkDigest);
    expect(after.rowDigest).not.toBe(before.rowDigest);
  });

  it('the digest job writes rows each tenant can see only for itself, and prunes by retention', async () => {
    const job = tableDigestJob({ name: 'ops.table_digest', scope: 'money', intervalSeconds: 3600, retentionDays: 35 });
    const out = await runJob(job, {
      runner: db,
      ops: opsOf(db),
      locks: memoryLocks(),
      sink: { send: async () => undefined },
      log: silentLogger,
      runnerId: 't',
      build: null,
      alertRepeatMs: 1,
    });
    expect(out.status).toBe('succeeded');
    const seen = async (tenant: string) =>
      db.withTenant(tenant, async (tx) =>
        (await tx.query<{ tenant_id: string; table_name: string; row_count: string }>(
          `select tenant_id::text, table_name, row_count::text from app.table_digest where table_name = 'write_log'`,
        )).rows,
      );
    const a = await seen(TENANT_A);
    const b = await seen(TENANT_B);
    expect(a.every((r) => r.tenant_id === TENANT_A)).toBe(true);
    expect(b).toEqual([{ tenant_id: TENANT_B, table_name: 'write_log', row_count: '2' }]);

    await db.asAdmin((tx) => tx.query(`update app.table_digest set as_of = now() - interval '40 days'`));
    await runJob(job, {
      runner: db,
      ops: opsOf(db),
      locks: memoryLocks(),
      sink: { send: async () => undefined },
      log: silentLogger,
      runnerId: 't',
      build: null,
      alertRepeatMs: 1,
    });
    const after = await db.asAdmin(async (tx) =>
      (await tx.query<{ old: number }>(`select count(*) filter (where as_of < now() - interval '35 days')::int as old from app.table_digest`)).rows[0]!,
    );
    expect(after.old).toBe(0);
  });
});

describe('backup manifest', () => {
  let manifest: Manifest;
  beforeAll(async () => {
    manifest = await db.asAdmin(async (tx) => {
      await tx.query('set transaction isolation level repeatable read');
      return buildManifest(tx);
    });
  });

  it('describes every tenant from inside its own boundary', () => {
    expect(manifest.tenants.map((t) => t.tenantId)).toEqual([TENANT_A, TENANT_B].sort());
    const wl = (tenant: string) => manifest.tenants.find((t) => t.tenantId === tenant)!.tables.find((t) => t.tableName === 'write_log')!;
    expect(wl(TENANT_B).rowCount).toBe('2');
    expect(BigInt(wl(TENANT_A).rowCount)).toBeGreaterThan(2n);
    expect(manifest.catalogue.app).toContain('table_digest');
    expect(manifest.migrations).toContain('0029_ops_jobs_digest_drill.sql');
    expect(manifest.platformRowCounts['tenant']).toBe('2');
  });

  it('a manifest compared with itself passes', () => {
    const c = compareManifests(manifest, structuredClone(manifest));
    expect(c.passed).toBe(true);
    expect(c.trialBalanceMatchedTenants).toEqual(manifest.tenants.map((t) => t.tenantId));
  });

  it('one minor unit of difference in one tenant’s trial balance fails that tenant, by id only', () => {
    const src: Manifest = {
      ...manifest,
      tenants: manifest.tenants.map((t) => ({
        ...t,
        trialBalance: {
          lines: [{ code: '1000', accountId: 'acc', locationId: 'loc', debitMinor: '150000', creditMinor: '0' }],
          debitMinor: '150000',
          creditMinor: '150000',
          balanced: true,
        },
      })),
    };
    const restored: Manifest = structuredClone(src);
    const bad = restored.tenants[0]!;
    (bad.trialBalance as { debitMinor: string }).debitMinor = '150001';
    (bad.trialBalance.lines[0] as { debitMinor: string }).debitMinor = '150001';
    const c = compareManifests(src, restored);
    expect(c.passed).toBe(false);
    expect(c.trialBalanceFailedTenants).toEqual([bad.tenantId]);
    expect(c.trialBalanceMatchedTenants).toEqual(src.tenants.slice(1).map((t) => t.tenantId));
    expect(c.differences.join('\n')).toContain(`tenant ${bad.tenantId}: trial balance differs`);
  });

  it('a lost row or a lost table is reported, with counts and names only', () => {
    const restored: Manifest = structuredClone(manifest);
    const t = restored.tenants[0]!;
    const wl = t.tables.find((x) => x.tableName === 'write_log')!;
    (wl as { rowCount: string }).rowCount = String(BigInt(wl.rowCount) - 1n);
    (t as { tables: unknown[] }).tables = t.tables.filter((x) => x.tableName !== 'sale');
    const c = compareManifests(manifest, restored);
    expect(c.digestsMatched).toBe(false);
    expect(c.differences.some((d) => d.includes('write_log: rows'))).toBe(true);
    expect(c.differences.some((d) => d.includes('sale: table absent'))).toBe(true);
  });
});
