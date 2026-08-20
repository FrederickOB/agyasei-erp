/**
 * Tiny ordered SQL migration runner. No framework.
 *
 * The numbered .sql files in ./migrations are THE source of truth for the
 * schema (the Drizzle definitions in ./schema.ts mirror them, never generate
 * them). Files run in filename order, each inside its own transaction, and
 * are recorded in erp_meta.schema_migrations so a re-run is a no-op.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** The minimal database surface the runner needs. Satisfied by PGlite and by pg. */
export interface SqlClient {
  /** Run one or more SQL statements (no parameters). */
  exec(sql: string): Promise<unknown>;
  /** Run a single parameterised statement. */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(db: SqlClient, dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
  await db.exec(`
    create schema if not exists erp_meta;
    create table if not exists erp_meta.schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default transaction_timestamp()
    );
  `);

  const files = (await readdir(dir)).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  if (files.length === 0) {
    throw new Error(`migrate: no migration files found in ${dir}`);
  }

  const done = new Set(
    (
      await db.query<{ filename: string }>('select filename from erp_meta.schema_migrations')
    ).rows.map((r) => r.filename),
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(join(dir, file), 'utf8');
    await db.exec('begin');
    try {
      await db.exec(sql);
      await db.query('insert into erp_meta.schema_migrations (filename) values ($1)', [file]);
      await db.exec('commit');
    } catch (err) {
      await db.exec('rollback');
      throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    applied.push(file);
  }

  return { applied, skipped };
}
