/**
 * TenantRunner/AdminRunner over a real Postgres pool (`pg`) — the production
 * shape of the seam the PGlite test harness satisfies in tests. Identical
 * transaction discipline (02-security; ADR-0005):
 *
 *     BEGIN;
 *     SET LOCAL ROLE app_user;                        -- nosuperuser, nobypassrls
 *     select set_config('app.tenant_id', $1, true);   -- SET LOCAL semantics
 *
 * SET LOCAL, never SET: a session GUC on a pooled connection would hand one
 * tenant's context to the next borrower. The tenant id parameter comes from
 * the verified token via the auth context — never from any client payload.
 *
 * Money safety: `pg` returns int8/numeric columns as STRINGS by default (no
 * type-parser overrides here, deliberately), and the routers select
 * monetary columns `::text` besides — no monetary magnitude ever becomes a
 * JS `number` on this path (ADR-0004).
 */
import pg from 'pg';
import type { AdminRunner, Queryable, TenantRunner } from './db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PgRunners {
  runner: TenantRunner;
  /** Undefined when the operator plane is disabled (production default). */
  admin: AdminRunner | undefined;
  /**
   * One statement as the CONNECTING role, outside any tenant context — for
   * health checks against non-tenant tables only (erp_meta). Forced RLS
   * makes `app.*` return nothing here, by design.
   */
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

export interface PgRunnerOptions {
  /** Full pool config (TLS, size, timeouts) — production builds it with @erp/ops pgPoolConfig. */
  poolConfig?: pg.PoolConfig;
  /**
   * Where operator-plane statements run:
   *  - 'same-pool' (default, dev): the tenant pool's own credential;
   *  - a pool config: a separate operator credential (erp_operator);
   *  - 'disabled': no operator plane at all; operator procedures refuse.
   */
  operator?: 'same-pool' | 'disabled' | pg.PoolConfig;
}

export function createPgRunners(databaseUrl: string, options: PgRunnerOptions = {}): PgRunners {
  const pool = new pg.Pool(options.poolConfig ?? { connectionString: databaseUrl, max: 10 });
  // An idle pooled connection dropping (pooler restart, failover) must not
  // crash the process; the next checkout reconnects.
  pool.on('error', () => undefined);
  const operator = options.operator ?? 'same-pool';
  const operatorPool =
    operator === 'same-pool' ? pool : operator === 'disabled' ? null : new pg.Pool(operator);
  operatorPool?.on('error', () => undefined);

  async function inTransaction<T>(
    setup: (tx: Queryable) => Promise<void>,
    fn: (tx: Queryable) => Promise<T>,
    on: pg.Pool = pool,
  ): Promise<T> {
    const client = await on.connect();
    const tx: Queryable = {
      query: async <R>(sql: string, params?: unknown[]) => {
        const res = await client.query(sql, params as never);
        return { rows: res.rows as R[] };
      },
    };
    try {
      await client.query('begin');
      await setup(tx);
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

  return {
    runner: {
      withTenant(tenantId, fn) {
        if (!UUID_RE.test(tenantId)) {
          // Refuse anything that is not already a UUID: the tenant id comes
          // from the verified token, never from free text.
          throw new Error(`withTenant: tenantId must be a uuid, got ${JSON.stringify(tenantId)}`);
        }
        return inTransaction(async (tx) => {
          await tx.query('set local role app_user');
          await tx.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
        }, fn);
      },
    },
    admin:
      operatorPool === null
        ? undefined
        : {
            run(fn) {
              return inTransaction(async () => undefined, fn, operatorPool);
            },
          },
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, params as never);
      return { rows: res.rows as T[] };
    },
    close: async () => {
      await pool.end();
      if (operatorPool !== null && operatorPool !== pool) await operatorPool.end();
    },
  };
}
