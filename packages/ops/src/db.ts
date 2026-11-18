/**
 * The database seams operations code runs against, and their `pg`
 * implementation.
 *
 * THREE SEAMS, BECAUSE THERE ARE THREE KINDS OF ACCESS AND MIXING THEM IS HOW
 * A CROSS-TENANT LEAK HAPPENS:
 *
 *   TenantRunner   per-tenant work on `app.*` — one transaction, `SET LOCAL
 *                  ROLE app_user`, the tenant GUC set. RLS genuinely applies,
 *                  so a job can only ever see, count or digest what that one
 *                  tenant owns. This is the ONLY way ops code reads `app`.
 *   OpsDb          the operator plane — `platform.*` bookkeeping (job runs,
 *                  alert state) and `pg_catalog`. Never `app.*`: with forced
 *                  RLS and no tenant GUC that returns nothing, by design.
 *   LockProvider   cluster-wide mutual exclusion (a Postgres advisory lock).
 *
 * The same shapes are satisfied by the PGlite harness in tests, so the
 * production code path is the tested one.
 *
 * TRANSPORT SECURITY. `sslmode` in a URL is stripped and replaced by an
 * explicit setting, because node-postgres lets a URL parameter silently
 * override the `ssl` option — and "which one won?" is not a question to be
 * answering about the connection that carries every tenant's books.
 */
import { hostname } from 'node:os';
import pg from 'pg';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface TenantRunner {
  withTenant<T>(tenantId: string, fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface OpsDb extends Queryable {
  /** One transaction on one connection, as the connecting (operator) role. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export type LockOutcome<T> = { acquired: true; value: T } | { acquired: false };

export interface LockProvider {
  /**
   * Run `fn` while holding the named cluster-wide lock, or return
   * `{ acquired: false }` immediately if another process holds it.
   */
  tryWithLock<T>(name: string, fn: () => Promise<T>): Promise<LockOutcome<T>>;
}

export type SslMode = 'disable' | 'require' | 'verify-full';

export interface PgConnectOptions {
  readonly url: string;
  readonly sslMode: SslMode;
  /** PEM. Required in practice for verify-full against Supabase (its own CA). */
  readonly caCert?: string | undefined;
  readonly max?: number | undefined;
  readonly applicationName?: string | undefined;
  readonly statementTimeoutMs?: number | undefined;
}

const URL_SSL_PARAMS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl', 'uselibpqcompat'];

/** Build a `pg` pool config with TLS decided HERE, not by URL parameters. */
export function pgPoolConfig(opts: PgConnectOptions): pg.PoolConfig {
  const u = new URL(opts.url);
  for (const k of URL_SSL_PARAMS) u.searchParams.delete(k);
  const ssl =
    opts.sslMode === 'disable'
      ? false
      : opts.sslMode === 'require'
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true, ...(opts.caCert ? { ca: opts.caCert } : {}) };
  return {
    connectionString: u.toString(),
    ssl,
    max: opts.max ?? 5,
    application_name: opts.applicationName ?? 'erp-ops',
    ...(opts.statementTimeoutMs !== undefined ? { statement_timeout: opts.statementTimeoutMs } : {}),
    // A connection that cannot be made in 10s is a connection that is not
    // going to be made; fail and let the caller's retry/alert decide.
    connectionTimeoutMillis: 10_000,
  };
}

/** A connection string safe to print: the password is never shown. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<unparseable url>';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PgOps {
  readonly runner: TenantRunner;
  readonly ops: OpsDb;
  readonly locks: LockProvider;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export function createPgOps(opts: PgConnectOptions): PgOps {
  const pool = new pg.Pool(pgPoolConfig(opts));
  // An idle client losing its connection must not take the process down.
  pool.on('error', () => undefined);

  async function inTransaction<T>(
    setup: (c: pg.PoolClient) => Promise<void>,
    fn: (tx: Queryable) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    const tx: Queryable = {
      query: async <R>(sql: string, params?: unknown[]) => {
        const res = await client.query(sql, params as never);
        return { rows: res.rows as R[] };
      },
    };
    try {
      await client.query('begin');
      await setup(client);
      const out = await fn(tx);
      await client.query('commit');
      return out;
    } catch (err) {
      try {
        await client.query('rollback');
      } catch {
        // the original error is the one that matters
      }
      throw err;
    } finally {
      client.release();
    }
  }

  const runner: TenantRunner = {
    withTenant(tenantId, fn) {
      if (!UUID_RE.test(tenantId)) {
        throw new Error(`withTenant: tenantId must be a uuid, got ${JSON.stringify(tenantId)}`);
      }
      return inTransaction(async (c) => {
        await c.query('set local role app_user');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      }, fn);
    },
  };

  const ops: OpsDb = {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, params as never);
      return { rows: res.rows as T[] };
    },
    transaction: (fn) => inTransaction(async () => undefined, fn),
  };

  const locks: LockProvider = {
    async tryWithLock(name, fn) {
      // A TRANSACTION-scoped advisory lock held by a transaction left open on
      // its own connection for the duration. Session-scoped locks are unsafe
      // behind a transaction-mode pooler (the session is not ours); an open
      // transaction pins one backend in every pooling mode, so this holds
      // wherever the URL points.
      const client = await pool.connect();
      let lost = false;
      const onError = () => {
        lost = true;
      };
      client.on('error', onError);
      try {
        await client.query('begin');
        await client.query(`set local idle_in_transaction_session_timeout = 0`);
        await client.query(`set local statement_timeout = 0`);
        const got = await client.query<{ ok: boolean }>(
          `select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as ok`,
          [`erp:${name}`],
        );
        if (got.rows[0]?.ok !== true) {
          await client.query('rollback');
          return { acquired: false };
        }
        try {
          const value = await fn();
          return { acquired: true, value };
        } finally {
          if (!lost) {
            try {
              await client.query('commit');
            } catch {
              // releasing a lock whose connection died is a no-op
            }
          }
        }
      } finally {
        client.off('error', onError);
        client.release(lost);
      }
    },
  };

  return { runner, ops, locks, pool, close: () => pool.end() };
}

/** Identifies this process in job_run.runner: the Fly machine id when there is one. */
export function runnerIdentity(): string {
  const machine = process.env['FLY_MACHINE_ID'];
  const region = process.env['FLY_REGION'];
  return machine ? `fly:${machine}${region ? `@${region}` : ''}` : `host:${hostname()}:${process.pid}`;
}

/** Build provenance (Requirement 9.8-A's argument, applied to jobs). */
export function buildIdentity(): string | null {
  return process.env['ERP_BUILD'] ?? process.env['FLY_IMAGE_REF'] ?? null;
}

/**
 * Every tenant the platform should be watching: anything that may still hold
 * data. A tenant mid-offboarding still has books, and a suspended tenant's
 * devices still hold writes (§9.3.4: suspension is a pause, not a disposal).
 */
export async function listTenantIds(ops: Queryable): Promise<string[]> {
  const res = await ops.query<{ id: string }>(
    `select id::text as id from platform.tenant
      where status not in ('offboarded', 'abandoned')
      order by id`,
  );
  return res.rows.map((r) => r.id);
}
