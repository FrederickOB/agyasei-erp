/**
 * A logical backup: `pg_dump` of the platform's schemas, taken INSIDE a
 * snapshot whose contents the manifest describes per tenant.
 *
 * This is in ADDITION to Supabase PITR, never instead of it (§9.5): PITR is
 * the operational backup (RPO minutes); a logical dump is a second,
 * provider-independent copy that can be restored anywhere, and — because its
 * manifest is exact — the cheapest complete restore drill there is.
 *
 * Scope: schemas `app`, `platform` and `erp_meta` only — the platform's data,
 * not the hosting provider's internal schemas, which neither restore cleanly
 * elsewhere nor belong to us.
 *
 * The dump holds every tenant's books. It is written 0600, and the runbook
 * says where it may live (encrypted object storage with a retention lock) and
 * where it may not (a laptop's Downloads folder, a CI artefact).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import pg from 'pg';
import { pgPoolConfig } from '../db.js';
import type { Logger } from '../log.js';
import { buildManifest, type Manifest } from './manifest.js';
import { pgBin, run, withLibpqEnv, type PgTarget } from './pgtools.js';

export const BACKUP_FORMAT = 'erp-backup/1';

export interface BackupRecord {
  readonly format: typeof BACKUP_FORMAT;
  readonly manifest: Manifest;
  readonly dump: { readonly file: string; readonly sha256: string; readonly bytes: number };
  readonly schemas: readonly string[];
}

export const DUMP_SCHEMAS = ['app', 'platform', 'erp_meta'] as const;

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export interface DumpResult {
  readonly dumpPath: string;
  readonly recordPath: string;
  readonly record: BackupRecord;
}

export async function logicalDump(opts: { source: PgTarget; outDir: string; log: Logger }): Promise<DumpResult> {
  await mkdir(opts.outDir, { recursive: true, mode: 0o700 });
  const client = new pg.Client(
    pgPoolConfig({ url: opts.source.url, sslMode: opts.source.sslMode, caCert: opts.source.caCert, applicationName: 'erp-backup' }),
  );
  await client.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const snap = (await client.query<{ s: string }>('select pg_export_snapshot() as s')).rows[0]!.s;
    const tx = {
      query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params as never)).rows as T[] }),
    };
    const manifest = await buildManifest(tx);
    const stamp = manifest.snapshotAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const dumpPath = join(opts.outDir, `erp-${stamp}.dump`);
    opts.log.info('manifest computed inside the snapshot; dumping', {
      snapshot_at: manifest.snapshotAt,
      tenants: manifest.tenants.length,
    });

    await withLibpqEnv(opts.source, (url, env) =>
      run(
        pgBin('pg_dump'),
        [
          '--format=custom',
          '--compress=6',
          '--no-password',
          `--snapshot=${snap}`,
          ...DUMP_SCHEMAS.map((s) => `--schema=${s}`),
          `--dbname=${url}`,
        ],
        env,
        { stdoutFile: dumpPath },
      ),
    );
    // The snapshot only has to outlive pg_dump's import of it; holding it to
    // the end costs nothing and removes the question.
    await client.query('commit');

    const record: BackupRecord = {
      format: BACKUP_FORMAT,
      manifest,
      dump: { file: basename(dumpPath), sha256: await sha256File(dumpPath), bytes: (await stat(dumpPath)).size },
      schemas: [...DUMP_SCHEMAS],
    };
    const recordPath = join(opts.outDir, `erp-${stamp}.manifest.json`);
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return { dumpPath, recordPath, record };
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // ignore
    }
    throw err;
  } finally {
    await client.end();
  }
}
