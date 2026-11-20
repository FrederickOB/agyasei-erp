/**
 * The production migration wrapper: under a lock, strict about history,
 * checksummed, retrying on lock_timeout — and the post-migration convergence
 * of grants and the PowerSync publication.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, type SqlClient } from '@erp/db';
import { convergeGrants, convergePublication, POWERSYNC_PUBLICATION_TABLES } from '../src/converge.js';
import { isLockTimeout, listMigrationFiles, migrateProduction, migrationState, MigrationRefused } from '../src/migrations.js';
import { memoryLocks } from './util.js';

let pg: PGlite;
let db: SqlClient;
let dir: string;

beforeEach(async () => {
  pg = new PGlite();
  db = {
    exec: (sql) => pg.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pg.query(sql, params)).rows as T[] }),
  };
  dir = await mkdtemp(join(tmpdir(), 'erp-mig-'));
  await cp(MIGRATIONS_DIR, dir, { recursive: true });
});
afterEach(async () => {
  await pg.close();
  await rm(dir, { recursive: true, force: true });
});

const noSleep = async () => undefined;

describe('migrateProduction', () => {
  it('applies everything to an empty database, records checksums, and is a no-op the second time', async () => {
    const first = await migrateProduction(db, memoryLocks(), { dir, sleep: noSleep, appliedBy: 'build-1' });
    const files = await listMigrationFiles(dir);
    expect(first.applied).toEqual(files.map((f) => f.filename));
    const sums = await db.query<{ n: number; how: string }>(`select count(*)::int as n, min(how) as how from erp_meta.schema_migration_checksum`);
    expect(sums.rows[0]).toEqual({ n: files.length, how: 'applied' });

    const second = await migrateProduction(db, memoryLocks(), { dir, sleep: noSleep });
    expect(second.applied).toEqual([]);
    const state = await migrationState(db, files);
    expect(state.pending).toEqual([]);
    expect(state.ahead).toEqual([]);
  });

  it('adopts checksums for migrations applied before the wrapper existed', async () => {
    const { migrate } = await import('@erp/db');
    await migrate(db, dir);
    const r = await migrateProduction(db, memoryLocks(), { dir, sleep: noSleep });
    expect(r.applied).toEqual([]);
    expect(r.adoptedChecksums).toBe((await listMigrationFiles(dir)).length);
  });

  it('refuses when an applied migration file has been edited', async () => {
    await migrateProduction(db, memoryLocks(), { dir, sleep: noSleep });
    const f = join(dir, '0001_platform.sql');
    await writeFile(f, `${await readFile(f, 'utf8')}\n-- an innocent edit\n`);
    await expect(migrateProduction(db, memoryLocks(), { dir, sleep: noSleep })).rejects.toMatchObject({
      reason: 'checksum_mismatch',
    });
  });

  it('refuses when the database is ahead of the build, unless the operator has decided to allow it', async () => {
    await migrateProduction(db, memoryLocks(), { dir, sleep: noSleep });
    await rm(join(dir, '0029_ops_jobs_digest_drill.sql'));
    const err = await migrateProduction(db, memoryLocks(), { dir, sleep: noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationRefused);
    expect((err as MigrationRefused).reason).toBe('db_ahead');
    expect((err as Error).message).toContain('0029_ops_jobs_digest_drill.sql');

    const allowed = await migrateProduction(db, memoryLocks(), { dir, sleep: noSleep, allowDbAhead: true });
    expect(allowed).toMatchObject({ applied: [], ahead: ['0029_ops_jobs_digest_drill.sql'] });
  });

  it('refuses divergent history outright — no flag unlocks it', async () => {
    await rm(join(dir, '0029_ops_jobs_digest_drill.sql'));
    await migrateProduction(db, memoryLocks(), { dir, sleep: noSleep });
    await db.query(`insert into erp_meta.schema_migrations (filename) values ('0099_from_another_branch.sql')`);
    await writeFile(join(dir, '0029_ops_jobs_digest_drill.sql'), await readFile(join(MIGRATIONS_DIR, '0029_ops_jobs_digest_drill.sql')));
    await expect(migrateProduction(db, memoryLocks(), { dir, sleep: noSleep, allowDbAhead: true })).rejects.toMatchObject({
      reason: 'divergent',
    });
  });

  it('waits for the migration lock and gives up loudly when it never frees', async () => {
    const locks = memoryLocks();
    locks.held.add('migrate');
    await expect(migrateProduction(db, locks, { dir, sleep: noSleep, lockWaitMs: 0 })).rejects.toMatchObject({
      reason: 'lock_unavailable',
    });
  });

  it('retries the pass when a statement hits lock_timeout', async () => {
    let calls = 0;
    const flaky: SqlClient = {
      exec: async (sql) => {
        if (/create table platform\.jurisdiction/.test(sql) && calls++ === 0) {
          throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
        }
        return db.exec(sql);
      },
      query: db.query,
    };
    const r = await migrateProduction(flaky, memoryLocks(), { dir, sleep: noSleep });
    expect(r.attempts).toBe(2);
    expect(isLockTimeout(new Error('wrapped', { cause: { code: '55P03' } }))).toBe(true);
    expect(isLockTimeout(new Error('other'))).toBe(false);
  });
});

describe('convergence', () => {
  it('grants converge idempotently when the login roles do not exist (dev, CI, scratch)', async () => {
    await migrateProduction(db, memoryLocks(), { dir, sleep: noSleep, after: (d) => convergeGrants(d) });
    await convergeGrants(db);
  });

  it('grants the documented privileges to the login roles that do exist', async () => {
    await migrateProduction(db, memoryLocks(), { dir, sleep: noSleep });
    await db.exec(`create role erp_api login noinherit; create role erp_jobs login noinherit; create role powersync_repl login replication bypassrls;`);
    await convergeGrants(db);
    const r = await db.query<Record<string, boolean>>(
      `select pg_has_role('erp_api', 'app_user', 'MEMBER') as api_member,
              has_table_privilege('erp_api', 'erp_meta.schema_migrations', 'select') as api_readyz,
              has_table_privilege('erp_api', 'platform.tenant', 'insert') as api_platform_write,
              has_table_privilege('erp_jobs', 'platform.job_run', 'insert') as jobs_runs,
              has_table_privilege('app_user', 'platform.job_run', 'select') as app_user_reads_runs,
              has_table_privilege('powersync_repl', 'app.sale', 'select') as repl_sale,
              has_table_privilege('powersync_repl', 'app.write_log', 'select') as repl_write_log`,
    );
    expect(r.rows[0]).toEqual({
      api_member: true,
      api_readyz: true,
      api_platform_write: false,
      jobs_runs: true,
      app_user_reads_runs: false,
      repl_sale: true,
      repl_write_log: false,
    });
  });

  it('the publication is created, then only ever expanded — never shrunk automatically', async () => {
    await migrateProduction(db, memoryLocks(), { dir, sleep: noSleep });
    const created = await convergePublication(db);
    expect(created.created).toBe(true);
    await db.exec(`alter publication powersync drop table app.sale; alter publication powersync add table app.write_log`);
    const again = await convergePublication(db);
    expect(again).toEqual({ created: false, added: ['app.sale'], unexpected: ['app.write_log'] });
    const now = await db.query<{ n: number }>(`select count(*)::int as n from pg_publication_tables where pubname = 'powersync'`);
    expect(now.rows[0]!.n).toBe(POWERSYNC_PUBLICATION_TABLES.length + 1);
  });

  it('every table the sync rules read is in the publication (drift guard)', async () => {
    const rules = await readFile(new URL('../../../infra/powersync/sync_rules.yaml', import.meta.url), 'utf8');
    const referenced = new Set<string>();
    for (const line of rules.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      for (const m of line.matchAll(/"(app|platform)"\."([a-z_]+)"/g)) referenced.add(`${m[1]}.${m[2]}`);
    }
    expect(referenced.size).toBeGreaterThan(10);
    const missing = [...referenced].filter((t) => !POWERSYNC_PUBLICATION_TABLES.includes(t));
    expect(missing).toEqual([]);
  });
});
