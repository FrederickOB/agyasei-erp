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
import type { AdminRunner, PreTenantRunner, Queryable, TenantRunner } from './db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PgRunners {
  runner: TenantRunner;
  admin: AdminRunner;
  /** app_user, no tenant GUC — the two pre-tenant route lookups only. */
  preTenant: PreTenantRunner;
  close(): Promise<void>;
}

export function createPgRunners(databaseUrl: string): PgRunners {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });

  async function inTransaction<T>(
    setup: (tx: Queryable) => Promise<void>,
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
    admin: {
      run(fn) {
        return inTransaction(async () => undefined, fn);
      },
    },
    preTenant: {
      withoutTenant(fn) {
        return inTransaction(async (tx) => {
          await tx.query('set local role app_user');
        }, fn);
      },
    },
    close: () => pool.end(),
  };
}
