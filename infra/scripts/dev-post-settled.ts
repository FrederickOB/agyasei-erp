/**
 * Run the posting sweep against the dev stack: settled sales -> the ledger.
 *
 *   pnpm dev:post-settled            # tenant A
 *
 * THIS IS THE SCHEDULER-SHAPED HOLE, MADE VISIBLE. Production needs a real
 * scheduler for the sweep (the nightly-job gap recorded since Phase 1); until
 * one exists, posting is an explicit act with a visible caller — this script
 * in dev, and nothing anywhere else. A sweep that ran invisibly would be the
 * eighteen-defect pattern inverted: wired but unattributable.
 *
 * DEV ONLY, like dev-token and dev-prices. Reads dev-tenants.json for the
 * tenant, posts as a synthetic operator id, prints per-sale outcomes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sweepSettledSales } from '@erp/db';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://erp:erp_dev@localhost:5433/erp';
const tenants = JSON.parse(readFileSync(join(HERE, '..', 'dev-tenants.json'), 'utf8')) as {
  tenantA: { id: string; slug: string };
};

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const runner = {
  async withTenant<T>(tenantId: string, fn: (tx: {
    query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  }) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local role app_user`);
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await fn({
        query: async <R,>(sql: string, params?: unknown[]) => {
          const r = await client.query(sql, params as never);
          return { rows: r.rows as R[] };
        },
      });
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  },
};

// tsx runs this file as CJS (no top-level await), hence the wrapper.
async function main(): Promise<void> {
  const t = tenants.tenantA;
  const result = await sweepSettledSales(runner, {
    tenantId: t.id,
    postedBy: '00000000-0000-4000-8000-00000000dead', // dev operator marker
    postingRuleVersion: 1,
  });
  console.log(
    `[post-settled] tenant ${t.slug}: examined ${result.examined}, posted ${result.posted}, ` +
      `duplicates ${result.duplicates}, exceptions ${result.exceptions}`,
  );
  for (const o of result.outcomes) {
    if (o.result.status === 'exception') {
      console.log(`  [exception] sale ${o.saleId}: ${o.result.errorCode} — ${o.result.detail}`);
    }
  }
  if (result.exceptions > 0) process.exitCode = 1;
  await pool.end();
}
void main();
