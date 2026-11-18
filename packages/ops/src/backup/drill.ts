/**
 * The restore drill (§9.5): restore a logical backup into a FRESH scratch
 * database, then prove the books came back — not merely the bytes.
 *
 *   1. verify the dump's checksum against its manifest;
 *   2. create a new, uniquely named scratch database (never an existing one);
 *   3. pg_restore into it;
 *   4. run the §1.3 catalogue assertion on the restored schema (a restore
 *      that lost a policy or FORCE is a restore that leaks);
 *   5. recompute the manifest — per tenant, under that tenant's RLS — and
 *      compare it to the source manifest EXACTLY: catalogue, migrations,
 *      platform row counts, every tenant's per-table row counts and digests,
 *      and every tenant's trial balance by account and location, in minor
 *      units;
 *   6. stop the stopwatch (RTO-server, §9.5: decision → books verified);
 *   7. destroy the scratch database and record when (§9.2: a copy of every
 *      tenant's books left running is the bigger exposure).
 *
 * What it does NOT exercise, stated because §9.5 step 6 requires it of a full
 * drill: replication-slot re-creation, sync-service re-initialisation and the
 * sequence-counter fast-forward. Those need the sync service and a device
 * fleet pointed at scratch; the runbook covers them as manual steps and the
 * record says they were not exercised.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { uuidv7 } from '@erp/db';
import { catalogueViolations } from '../catalogue.js';
import { pgPoolConfig, type OpsDb } from '../db.js';
import type { Logger } from '../log.js';
import { BACKUP_FORMAT, sha256File, type BackupRecord } from './dump.js';
import { buildManifest, compareManifests, type DrillComparison } from './manifest.js';
import { pgBin, run, withLibpqEnv, type PgTarget } from './pgtools.js';

export interface DrillOptions {
  readonly recordPath: string;
  /** Defaults to the file named in the record, beside it. */
  readonly dumpPath?: string;
  /** A maintenance connection on the SCRATCH server, able to CREATE DATABASE. */
  readonly scratchAdmin: PgTarget;
  readonly scratchDbName?: string;
  readonly keep?: boolean;
  /** When the restore was decided — the stopwatch starts here, not at the first command. */
  readonly startedAt?: Date;
  readonly log: Logger;
}

export interface DrillReport {
  readonly id: string;
  readonly ranAt: string;
  readonly restoreTarget: string;
  readonly sourceManifestSha256: string;
  readonly scratchDatabase: string;
  readonly catalogueViolations: readonly string[];
  readonly comparison: DrillComparison;
  readonly rtoServerSeconds: number;
  readonly scratchDestroyedAt: string | null;
  readonly passed: boolean;
}

function dbUrl(base: string, database: string): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

export async function restoreDrill(opts: DrillOptions): Promise<DrillReport> {
  const started = opts.startedAt ?? new Date();
  const raw = await readFile(opts.recordPath);
  const record = JSON.parse(raw.toString('utf8')) as BackupRecord;
  if (record.format !== BACKUP_FORMAT) throw new Error(`not an ${BACKUP_FORMAT} record: ${opts.recordPath}`);
  const sourceManifestSha256 = createHash('sha256').update(raw).digest('hex');

  const dumpPath = opts.dumpPath ?? join(dirname(opts.recordPath), record.dump.file);
  const actual = await sha256File(dumpPath);
  if (actual !== record.dump.sha256) {
    throw new Error(`dump checksum mismatch: the archive is not the one the manifest describes (${dumpPath})`);
  }

  const name = opts.scratchDbName ?? `erp_drill_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  if (!/^erp_drill_[a-z0-9_]{1,40}$/.test(name)) {
    throw new Error(`scratch database name must look like erp_drill_<suffix>: ${name}`);
  }

  const adminCfg = pgPoolConfig({ url: opts.scratchAdmin.url, sslMode: opts.scratchAdmin.sslMode, caCert: opts.scratchAdmin.caCert, applicationName: 'erp-drill' });
  const admin = new pg.Client(adminCfg);
  await admin.connect();
  let created = false;
  let destroyedAt: string | null = null;
  const id = uuidv7();
  try {
    const exists = await admin.query(`select 1 from pg_database where datname = $1`, [name]);
    if (exists.rows.length > 0) throw new Error(`scratch database ${name} already exists; a drill never restores over anything`);
    await admin.query(`create database ${name}`);
    created = true;
    // Cluster-wide role the restored policies and the manifest's RLS context need.
    await admin.query(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'app_user') then
          create role app_user nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
        end if;
      end $$`);
    const member = await admin.query<{ ok: boolean }>(`select pg_has_role(current_user, 'app_user', 'MEMBER') as ok`);
    if (member.rows[0]?.ok !== true) await admin.query(`grant app_user to current_user`);
    opts.log.info('scratch database created; restoring', { scratch: name });

    const scratch: PgTarget = { ...opts.scratchAdmin, url: dbUrl(opts.scratchAdmin.url, name) };
    await withLibpqEnv(scratch, (url, env) =>
      run(pgBin('pg_restore'), ['--no-owner', '--no-privileges', '--exit-on-error', '--no-password', `--dbname=${url}`], env, {
        stdinFile: dumpPath,
      }),
    );

    const client = new pg.Client(pgPoolConfig({ ...scratch, applicationName: 'erp-drill' }));
    await client.connect();
    let violations: string[];
    let restored;
    try {
      // --no-privileges dropped the grants; the manifest reads as app_user.
      await client.query(`grant usage on schema app, platform, erp_meta to app_user`);
      await client.query(`grant select on all tables in schema app, platform to app_user`);
      await client.query('begin isolation level repeatable read read only');
      const tx = {
        query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params as never)).rows as T[] }),
      };
      violations = await catalogueViolations(tx);
      restored = await buildManifest(tx);
      await client.query('commit');
    } finally {
      await client.end();
    }

    const comparison = compareManifests(record.manifest, restored);
    const rtoServerSeconds = Math.round((Date.now() - started.getTime()) / 1000);
    opts.log.info('restore verified against the manifest', {
      passed: comparison.passed && violations.length === 0,
      rto_server_seconds: rtoServerSeconds,
      differences: comparison.differences.length,
    });

    if (!opts.keep) {
      await admin.query(`drop database ${name} with (force)`);
      created = false;
      destroyedAt = new Date().toISOString();
    }
    return {
      id,
      ranAt: started.toISOString(),
      restoreTarget: record.manifest.snapshotAt,
      sourceManifestSha256,
      scratchDatabase: name,
      catalogueViolations: violations,
      comparison,
      rtoServerSeconds,
      scratchDestroyedAt: destroyedAt,
      passed: comparison.passed && violations.length === 0,
    };
  } catch (err) {
    if (created && !opts.keep) {
      try {
        await admin.query(`drop database ${name} with (force)`);
      } catch {
        opts.log.error('could not drop the scratch database after a failure: destroy it by hand', { scratch: name });
      }
    }
    throw err;
  } finally {
    await admin.end();
  }
}

/** Record a drill in platform.restore_drill (§9.5). */
export async function recordDrill(ops: OpsDb, report: DrillReport, operator: string, notes?: string): Promise<void> {
  await ops.query(
    `insert into platform.restore_drill
       (id, ran_at, operator, method, restore_target, source_manifest_sha256, rto_server_seconds,
        rto_fleet_seconds, catalogue_assertion_passed, digests_matched,
        trial_balance_matched_tenants, trial_balance_failed_tenants,
        slot_and_sync_reinit_exercised, sequence_fastforward_exercised, scratch_destroyed_at, notes)
     values ($1, $2, $3, 'logical_dump', $4, $5, $6, null, $7, $8, $9::uuid[], $10::uuid[], false, false, $11, $12)`,
    [
      report.id,
      report.ranAt,
      operator,
      report.restoreTarget,
      report.sourceManifestSha256,
      report.rtoServerSeconds,
      report.catalogueViolations.length === 0,
      report.comparison.digestsMatched && report.comparison.platformCountsMatched,
      report.comparison.trialBalanceMatchedTenants,
      report.comparison.trialBalanceFailedTenants,
      report.scratchDestroyedAt,
      notes ?? null,
    ],
  );
}
