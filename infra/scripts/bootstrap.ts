/**
 * Dev-stack database bootstrap — idempotent, safe to re-run.
 *
 * Run via `pnpm stack:up` / `pnpm stack:reset` (or directly:
 * `pnpm exec tsx infra/scripts/bootstrap.ts`). Against the compose Postgres
 * on localhost:5433 it:
 *
 *   1. runs the @erp/db migrations (the hand-written SQL is THE schema);
 *   2. ensures the PowerSync roles/storage db exist (belt over the
 *      first-boot init script) and grants powersync_repl read access;
 *   3. converges the `powersync` publication onto exactly the tables the
 *      sync rules read (infra/powersync/sync_rules.yaml);
 *   4. seeds the Ghana jurisdiction pack and TWO tenants via the existing
 *      seed/applyTemplate machinery (Phase 1 acceptance criterion 5 needs a
 *      second tenant) — every tenant-scoped statement runs as app_user under
 *      RLS, exactly like production writes;
 *   5. records both tenant ids in infra/dev-tenants.json.
 *
 * Tenant writes here follow the ONE write path: applyTemplate and the
 * tenant-B location seed write SERVER-origin app.write_log rows first —
 * nothing touches an app table without its write-spine row.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  migrate,
  createHlcClock,
  hlcNodeFromName,
  deterministicUuid,
  sha256Hex,
  type SqlClient,
} from '@erp/db';
import { applyTemplate, applyTenant1Locations, seedGhanaJurisdiction } from '@erp/db/seed';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://erp:erp_dev@localhost:5433/erp';

/** Fixed dev tenant ids (uuidv7-shaped, obviously synthetic) so every reset
 *  produces the same ids and infra/dev-tenants.json stays stable. */
const TENANT_A = {
  id: '01911111-1111-7111-8111-111111111111',
  slug: 'agyasei-jnr',
  legalName: 'Agyasei Jnr & Company Limited',
};
const TENANT_B = {
  id: '01922222-2222-7222-8222-222222222222',
  slug: 'kumasi-builders',
  legalName: 'Kumasi Builders Supply Ltd',
};

/** Tables the sync rules read — data queries AND parameter queries. The
 *  publication carries exactly these; extend it when sync_rules.yaml grows. */
const PUBLICATION_TABLES = [
  'app.location',
  'app.location_type',
  'app.unit_of_measure',
  'app.product_category',
  'app.product',
  'app.product_uom',
  'app.price_list',
  'app.price_list_item',
  'app.movement_reason',
  'app.customer',
  'app.stock_movement',
  'app.sale',
  'app.sale_line',
  'app.sale_tax_line',
  'platform.tenant',
  'platform.jurisdiction',
  'platform.tax_code',
  'platform.tax_rate',
];

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const db: SqlClient = {
    exec: (sql) => client.query(sql),
    query: async (sql, params) => {
      const res = await client.query(sql, params as unknown[]);
      return { rows: res.rows };
    },
  };

  try {
    // 1 — migrations ------------------------------------------------------
    const result = await migrate(db);
    console.log(
      `[bootstrap] migrations: applied ${result.applied.length} (${result.applied.join(', ') || 'none'}), ` +
        `skipped ${result.skipped.length}`,
    );

    // 2 — PowerSync roles, storage db, read grants ------------------------
    await db.exec(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'powersync_repl') then
          create role powersync_repl with replication bypassrls login password 'powersync_dev';
        end if;
        if not exists (select 1 from pg_roles where rolname = 'powersync_storage') then
          create role powersync_storage with login password 'powersync_dev';
        end if;
      end $$;
      grant usage on schema app to powersync_repl;
      grant usage on schema platform to powersync_repl;
      grant select on all tables in schema app to powersync_repl;
      grant select on all tables in schema platform to powersync_repl;
      alter default privileges in schema app grant select on tables to powersync_repl;
      alter default privileges in schema platform grant select on tables to powersync_repl;
    `);
    const storageDb = await db.query(
      `select 1 from pg_database where datname = 'powersync_storage'`,
    );
    if (storageDb.rows.length === 0) {
      // CREATE DATABASE cannot run inside a transaction block; plain query is fine.
      await db.exec(`create database powersync_storage owner powersync_storage`);
      console.log('[bootstrap] created powersync_storage database');
    }

    // 3 — the `powersync` publication (name required by the service) ------
    const pub = await db.query(`select 1 from pg_publication where pubname = 'powersync'`);
    if (pub.rows.length === 0) {
      await db.exec(`create publication powersync for table ${PUBLICATION_TABLES.join(', ')}`);
      console.log(`[bootstrap] created publication powersync (${PUBLICATION_TABLES.length} tables)`);
    } else {
      await db.exec(`alter publication powersync set table ${PUBLICATION_TABLES.join(', ')}`);
      console.log(`[bootstrap] converged publication powersync (${PUBLICATION_TABLES.length} tables)`);
    }

    // 4 — jurisdiction pack + two tenants ---------------------------------
    await seedGhanaJurisdiction(db); // platform.* writes: admin connection, idempotent

    for (const t of [TENANT_A, TENANT_B]) {
      await db.query(
        `insert into platform.tenant (id, slug, legal_name, status, jurisdiction_code, activated_at)
         values ($1, $2, $3, 'active', 'GH', transaction_timestamp())
         on conflict (id) do nothing`,
        [t.id, t.slug, t.legalName],
      );
      await db.query(
        `insert into platform.tenant_database (tenant_id, dsn_ref, sync_service_ref)
         values ($1, 'secret://dev/local-compose/dsn', 'http://localhost:8080')
         on conflict (tenant_id) do nothing`,
        [t.id],
      );
    }

    /** Run fn as app_user with the tenant GUC set — RLS genuinely applies,
     *  the same shape as the production withTenant() wrapper. */
    async function withTenant<T>(
      tenantId: string,
      fn: (tx: SqlClient) => Promise<T>,
    ): Promise<T> {
      await db.exec('begin');
      try {
        await db.query('set local role app_user');
        await db.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
        const out = await fn(db);
        await db.exec('commit');
        return out;
      } catch (err) {
        await db.exec('rollback');
        throw err;
      }
    }

    // Tenant A — the pilot: full template + tenant #1's outlet network.
    const resA = await withTenant(TENANT_A.id, async (tx) => {
      const r = await applyTemplate(tx, TENANT_A.id);
      await applyTenant1Locations(tx, TENANT_A.id);
      return r;
    });
    console.log(
      `[bootstrap] tenant A (${TENANT_A.slug}): template ${resA.templateId}@${resA.templateVersion}, ` +
        `${resA.founderPending.length} founder-pending SKUs`,
    );

    // Tenant B — the second tenant (acceptance criterion 5). Same (only)
    // template; a single hand-seeded location, through the write spine.
    const resB = await withTenant(TENANT_B.id, async (tx) => {
      const r = await applyTemplate(tx, TENANT_B.id);

      const SEED_NS = 'infra-dev-seed';
      const clock = createHlcClock(hlcNodeFromName(SEED_NS));
      const writeId = deterministicUuid(TENANT_B.id, SEED_NS, 'write', 'locations');
      await tx.query(
        `insert into app.write_log
           (tenant_id, id, origin, hlc, claimed_hlc, device_id, user_id, location_id,
            op, schema_version, request_hash, response_body)
         values ($1, $2, 'SERVER', $3, null, null, null, null,
                 'dev-seed.apply:locations', 1, decode($4, 'hex'), null)
         on conflict (tenant_id, id) do nothing`,
        [TENANT_B.id, writeId, clock.next(), sha256Hex(`${SEED_NS}:locations:${TENANT_B.id}`)],
      );
      const locType = await tx.query<{ id: string }>(
        `select id from app.location_type where tenant_id = $1 order by code limit 1`,
        [TENANT_B.id],
      );
      await tx.query(
        `insert into app.location
           (tenant_id, id, write_id, hlc, code, name, kind, location_type_id,
            parent_id, is_active, timezone, origin_template_id, origin_ref)
         values ($1, $2, $3, $4, 'MAIN', 'Main Depot', 'OUTLET', $5, null, true,
                 'Africa/Accra', null, null)
         on conflict (tenant_id, id) do nothing`,
        [
          TENANT_B.id,
          deterministicUuid(TENANT_B.id, SEED_NS, 'loc:MAIN'),
          writeId,
          clock.next(),
          locType.rows[0]?.id ?? null,
        ],
      );
      return r;
    });
    console.log(
      `[bootstrap] tenant B (${TENANT_B.slug}): template ${resB.templateId}@${resB.templateVersion}, ` +
        `${resB.founderPending.length} founder-pending SKUs`,
    );

    // 5 — record the dev tenant ids --------------------------------------
    const outPath = fileURLToPath(new URL('../dev-tenants.json', import.meta.url));
    const tenants = {
      note: 'Local dev-stack tenants, recreated identically by pnpm stack:reset.',
      tenantA: TENANT_A,
      tenantB: TENANT_B,
    };
    await writeFile(outPath, `${JSON.stringify(tenants, null, 2)}\n`);
    console.log(`[bootstrap] wrote ${outPath}`);
    console.log('[bootstrap] done');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[bootstrap] FAILED:', err);
  process.exitCode = 1;
});
