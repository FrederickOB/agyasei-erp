/**
 * Hermetic Postgres test harness: PGlite (real Postgres compiled to WASM),
 * the real migrations, and — critically — a real non-superuser role.
 *
 * PGlite connects as `postgres`, a SUPERUSER, and a superuser BYPASSES
 * row-level security entirely, FORCE or no FORCE. A test suite that queries
 * as the superuser "proves" isolation that is not being enforced — theatre.
 * So every tenant-scoped operation here runs inside a transaction that does
 *
 *     SET LOCAL ROLE app_user;                        -- nosuperuser, nobypassrls
 *     select set_config('app.tenant_id', $1, true);   -- SET LOCAL semantics
 *
 * which is exactly the shape the production withTenant() wrapper uses
 * (02-security: SET LOCAL, never SET — a session GUC on a pooled connection
 * hands one tenant's context to the next borrower).
 */
import { PGlite } from '@electric-sql/pglite';
import { migrate, type SqlClient } from '../migrate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface TestDb extends SqlClient {
  /**
   * Run `fn` inside one transaction as app_user with the tenant GUC set —
   * RLS genuinely applies. Rolls back on throw, commits otherwise.
   */
  withTenant<T>(tenantId: string, fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /**
   * Run `fn` inside one transaction as app_user with NO tenant GUC — the
   * fail-closed path (every predicate NULL, zero rows, inserts refused).
   */
  asAppUserWithoutTenant<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Run `fn` as the migration superuser (setup/verification only). */
  asAdmin<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();

  const client: SqlClient = {
    exec: (sql) => pg.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      const res = await pg.query(sql, params);
      return { rows: res.rows as T[] };
    },
  };

  await migrate(client);

  // One connection, so transactions must never interleave: chain them.
  let chain: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  async function inTransaction<T>(
    setup: (tx: Queryable) => Promise<void>,
    fn: (tx: Queryable) => Promise<T>,
  ): Promise<T> {
    return serialize(async () => {
      await pg.exec('begin');
      try {
        const tx: Queryable = {
          query: async (sql, params) => {
            const res = await pg.query(sql, params);
            return { rows: res.rows as never[] };
          },
        };
        await setup(tx);
        const out = await fn(tx);
        await pg.exec('commit');
        return out;
      } catch (err) {
        await pg.exec('rollback');
        throw err;
      }
    });
  }

  return {
    ...client,
    withTenant(tenantId, fn) {
      if (!UUID_RE.test(tenantId)) {
        // Refuse anything that is not already a UUID: the production wrapper
        // takes the tenant id from the verified token, never from free text.
        throw new Error(`withTenant: tenantId must be a uuid, got ${JSON.stringify(tenantId)}`);
      }
      return inTransaction(async (tx) => {
        await tx.query('set local role app_user');
        await tx.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      }, fn);
    },
    asAppUserWithoutTenant(fn) {
      return inTransaction(async (tx) => {
        await tx.query('set local role app_user');
      }, fn);
    },
    asAdmin(fn) {
      return inTransaction(async () => undefined, fn);
    },
    close: () => pg.close(),
  };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

export interface FixtureTenant {
  id: string;
  slug: string;
}

/**
 * Create an ACTIVE tenant (admin path — application code cannot write
 * platform.*). Requires the jurisdiction to exist (seedGhanaJurisdiction).
 */
export async function createTenant(
  db: TestDb,
  opts: { id: string; slug: string; legalName?: string; jurisdictionCode?: string },
): Promise<FixtureTenant> {
  const { id, slug } = opts;
  await db.asAdmin(async (tx) => {
    await tx.query(
      `insert into platform.tenant (id, slug, legal_name, status, jurisdiction_code, activated_at)
       values ($1, $2, $3, 'active', $4, transaction_timestamp())
       on conflict (id) do nothing`,
      [id, slug, opts.legalName ?? slug, opts.jurisdictionCode ?? 'GH'],
    );
    await tx.query(
      `insert into platform.tenant_database (tenant_id, dsn_ref, sync_service_ref)
       values ($1, $2, $3)
       on conflict (tenant_id) do nothing`,
      [id, `secret://clusters/eu-west-1-shared/dsn`, `https://sync.invalid/eu-west-1-shared`],
    );
  });
  return { id, slug };
}
