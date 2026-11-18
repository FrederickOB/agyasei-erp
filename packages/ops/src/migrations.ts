/**
 * Production migrations: the existing runner (`@erp/db` `migrate()`), made
 * safe to run unattended as Fly's `release_command` (09 §9.3.6).
 *
 * What this adds around the runner — and deliberately nothing else; the SQL
 * files and the runner stay the one source of truth:
 *
 *  1. AN ADVISORY LOCK, so two deploys started together cannot interleave
 *     their migrations. The second one waits, then finds nothing to do.
 *  2. A REFUSAL when the database holds migrations this build does not know.
 *     That is either a rollback of the code after an expand (legitimate, and a
 *     DECISION — §9.8 Case C) or two branches that each migrated (never
 *     legitimate). Either way an unattended release must not proceed on a
 *     guess, so it stops and says which. `allowDbAhead` is the recorded
 *     decision for the first case; nothing unlocks the second.
 *  3. CHECKSUMS. An applied migration whose file has since changed means the
 *     schema in production is not the schema in the repository. The runner
 *     records filenames only, so the checksum lives beside it in
 *     `erp_meta.schema_migration_checksum`, adopted on first sight.
 *  4. `lock_timeout` ON EVERY MIGRATION SESSION, with bounded retry. §9.3.2's
 *     single highest-value rule: an ALTER queued behind a long report blocks
 *     every query on that table for every tenant. Fail fast, retry, give up
 *     loudly.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrate, type SqlClient } from '@erp/db';
import type { LockProvider, Queryable } from './db.js';

export interface MigrationFile {
  readonly filename: string;
  readonly sha256: string;
}

/** Same selection rule as the runner: numbered `.sql` files, filename order. */
export async function listMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  const out: MigrationFile[] = [];
  for (const filename of names) {
    const body = await readFile(join(dir, filename));
    out.push({ filename, sha256: createHash('sha256').update(body).digest('hex') });
  }
  return out;
}

export interface MigrationState {
  /** Files this build ships, in order. */
  readonly known: readonly string[];
  /** Files the database records as applied. */
  readonly applied: readonly string[];
  /** Known to this build, not yet applied. */
  readonly pending: readonly string[];
  /** Applied in the database, unknown to this build. */
  readonly ahead: readonly string[];
  /** Applied files whose content no longer matches what was recorded. */
  readonly checksumMismatch: readonly { filename: string; recorded: string; current: string }[];
}

export async function migrationState(db: Queryable, files: readonly MigrationFile[]): Promise<MigrationState> {
  const exists = await db.query<{ runner: string | null; sums: string | null }>(
    `select to_regclass('erp_meta.schema_migrations')::text as runner,
            to_regclass('erp_meta.schema_migration_checksum')::text as sums`,
  );
  const hasRunner = exists.rows[0]?.runner != null;
  const hasSums = exists.rows[0]?.sums != null;

  const applied = hasRunner
    ? (await db.query<{ filename: string }>(`select filename from erp_meta.schema_migrations order by filename`)).rows.map(
        (r) => r.filename,
      )
    : [];
  const recorded = hasSums
    ? new Map(
        (
          await db.query<{ filename: string; sha256: string }>(
            `select filename, sha256 from erp_meta.schema_migration_checksum`,
          )
        ).rows.map((r) => [r.filename, r.sha256]),
      )
    : new Map<string, string>();

  const known = files.map((f) => f.filename);
  const knownSet = new Set(known);
  const appliedSet = new Set(applied);
  const checksumMismatch: { filename: string; recorded: string; current: string }[] = [];
  for (const f of files) {
    const r = recorded.get(f.filename);
    if (appliedSet.has(f.filename) && r !== undefined && r !== f.sha256) {
      checksumMismatch.push({ filename: f.filename, recorded: r, current: f.sha256 });
    }
  }
  return {
    known,
    applied,
    pending: known.filter((f) => !appliedSet.has(f)),
    ahead: applied.filter((f) => !knownSet.has(f)),
    checksumMismatch,
  };
}

export class MigrationRefused extends Error {
  constructor(
    message: string,
    readonly reason: 'checksum_mismatch' | 'divergent' | 'db_ahead' | 'lock_unavailable',
  ) {
    super(message);
    this.name = 'MigrationRefused';
  }
}

export interface MigrateProductionOptions {
  readonly dir: string;
  /** §9.8 Case C: the operator has decided to run an older build against an expanded schema. */
  readonly allowDbAhead?: boolean;
  /** Who/what applied (build id). Recorded beside each checksum. */
  readonly appliedBy?: string | null;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  /** Retries of the whole pass when a DDL statement hits lock_timeout. */
  readonly lockRetries?: number;
  /** How long to wait for another migrator's advisory lock. */
  readonly lockWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (msg: string) => void;
  /** Converge grants/publication after migrating, under the same lock. */
  readonly after?: (db: SqlClient) => Promise<void>;
}

export interface MigrateProductionResult {
  readonly applied: readonly string[];
  readonly ahead: readonly string[];
  readonly adoptedChecksums: number;
  readonly attempts: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** lock_not_available (55P03), anywhere in the cause chain the runner wraps it in. */
export function isLockTimeout(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && typeof e === 'object' && e !== null; depth += 1) {
    if ((e as { code?: unknown }).code === '55P03') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Migrate the database `db` (one session — a direct or session-mode
 * connection, never a transaction-mode pooler) under an advisory lock.
 */
export async function migrateProduction(
  db: SqlClient,
  locks: LockProvider,
  opts: MigrateProductionOptions,
): Promise<MigrateProductionResult> {
  const sleep = opts.sleep ?? realSleep;
  const log = opts.log ?? (() => undefined);
  const files = await listMigrationFiles(opts.dir);
  if (files.length === 0) throw new Error(`no migration files in ${opts.dir}`);

  const waitUntil = Date.now() + (opts.lockWaitMs ?? 5 * 60_000);
  for (;;) {
    const outcome = await locks.tryWithLock('migrate', () => migrateLocked(db, files, opts, sleep, log));
    if (outcome.acquired) return outcome.value;
    if (Date.now() >= waitUntil) {
      throw new MigrationRefused(
        'another migrator has held the migration lock for longer than the wait budget; refusing to proceed',
        'lock_unavailable',
      );
    }
    log('migration lock held by another process; waiting');
    await sleep(2_000);
  }
}

async function migrateLocked(
  db: SqlClient,
  files: readonly MigrationFile[],
  opts: MigrateProductionOptions,
  sleep: (ms: number) => Promise<void>,
  log: (msg: string) => void,
): Promise<MigrateProductionResult> {
  const state = await migrationState(db, files);

  if (state.checksumMismatch.length > 0) {
    throw new MigrationRefused(
      `applied migration(s) changed since they were applied: ${state.checksumMismatch
        .map((m) => m.filename)
        .join(', ')}. Migrations are forward-only; a fix is a NEW migration, never an edit.`,
      'checksum_mismatch',
    );
  }
  if (state.ahead.length > 0 && state.pending.length > 0) {
    throw new MigrationRefused(
      `divergent schema history: the database has ${state.ahead.join(', ')} which this build does not know, ` +
        `and this build has ${state.pending.join(', ')} which the database lacks. Two branches have migrated ` +
        `production. Nothing is applied; this needs a human.`,
      'divergent',
    );
  }
  if (state.ahead.length > 0) {
    if (opts.allowDbAhead !== true) {
      throw new MigrationRefused(
        `the database is AHEAD of this build (${state.ahead.join(', ')}). If this is a deliberate rollback ` +
          `of the code after an expand migration (production runbook, rollback Case C), redeploy with ` +
          `ERP_MIGRATE_ALLOW_DB_AHEAD=true. Nothing has been applied.`,
        'db_ahead',
      );
    }
    log(`database is ahead of this build by ${state.ahead.join(', ')}; allowed by operator decision. Applying nothing.`);
    const adopted = await recordChecksums(db, files, state.applied, [], opts.appliedBy ?? null);
    return { applied: [], ahead: state.ahead, adoptedChecksums: adopted, attempts: 0 };
  }

  await db.exec(`set lock_timeout = '${Math.max(1, Math.floor(opts.lockTimeoutMs ?? 3_000))}ms'`);
  await db.exec(`set statement_timeout = '${Math.max(1, Math.floor(opts.statementTimeoutMs ?? 15 * 60_000))}ms'`);

  const retries = opts.lockRetries ?? 5;
  const applied: string[] = [];
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const res = await migrate(db, opts.dir);
      applied.push(...res.applied);
      break;
    } catch (err) {
      if (isLockTimeout(err) && attempts <= retries) {
        const backoff = 1_000 * 2 ** (attempts - 1);
        log(`a migration statement hit lock_timeout (attempt ${attempts}); retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  await db.exec(`reset lock_timeout`);
  await db.exec(`reset statement_timeout`);

  if (opts.after) await opts.after(db);

  const adopted = await recordChecksums(db, files, [...state.applied, ...applied], applied, opts.appliedBy ?? null);
  return { applied, ahead: [], adoptedChecksums: adopted, attempts };
}

async function recordChecksums(
  db: SqlClient,
  files: readonly MigrationFile[],
  appliedNow: readonly string[],
  appliedThisRun: readonly string[],
  appliedBy: string | null,
): Promise<number> {
  await db.exec(`
    create schema if not exists erp_meta;
    create table if not exists erp_meta.schema_migration_checksum (
      filename    text primary key,
      sha256      text not null,
      recorded_at timestamptz not null default clock_timestamp(),
      how         text not null check (how in ('applied', 'adopted')),
      build       text
    );
  `);
  const appliedSet = new Set(appliedNow);
  const thisRun = new Set(appliedThisRun);
  let adopted = 0;
  for (const f of files) {
    if (!appliedSet.has(f.filename)) continue;
    const res = await db.query<{ filename: string }>(
      `insert into erp_meta.schema_migration_checksum (filename, sha256, how, build)
       values ($1, $2, $3, $4)
       on conflict (filename) do nothing
       returning filename`,
      [f.filename, f.sha256, thisRun.has(f.filename) ? 'applied' : 'adopted', appliedBy],
    );
    if (res.rows.length > 0 && !thisRun.has(f.filename)) adopted += 1;
  }
  return adopted;
}
