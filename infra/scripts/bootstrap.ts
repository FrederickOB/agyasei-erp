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
 *   5. provisions one DEV PRINCIPAL per template role on each tenant, because
 *      a template seeds roles but deliberately seeds no users and no role
 *      assignments — and the API resolves permissions from the database on
 *      every request, so without this step every dev token is refused at
 *      the first guarded route;
 *   6. seeds DEV PRICES for every sellable product, because a template seeds
 *      price-list structure and deliberately no prices — leaving a stack whose
 *      counter cannot ring anything (infra/scripts/dev-prices.ts);
 *   7. records both tenant ids in infra/dev-tenants.json.
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
import {
  applySequenceCounters,
  applyTemplate,
  applyTenant1Locations,
  provisionPrincipal,
  seedGhanaJurisdiction,
} from '@erp/db/seed';
import { applyDevPrices } from './dev-prices.js';
import { seedDevLedger } from '@erp/db';
import { applyDevPurchaseUnits } from './dev-purchase-units.js';

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
  // Credit (migration 0013). The two *_scope tables are PARAMETER-query
  // sources — the gate itself — and must replicate or every credit bucket
  // fails closed to zero rows. The rest are the data queries.
  'app.credit_sync_book_scope',
  'app.credit_sync_location_scope',
  'app.customer_account',
  'app.credit_limit_version',
  'app.credit_entry',
  'app.credit_position_snapshot',
  'app.credit_position_bucket',
  'app.credit_allowance',
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

    // Dev tenants are created in 'provisioning', exactly as `createTenant`
    // now creates them (G-1). They are NOT activated here, and the bootstrap
    // is deliberately not given a way to activate them: activation requires a
    // qualified practitioner's confirmation on every tax rate in force
    // (CLAUDE.md §2.8), and a dev seeder that could wave that through would be
    // a backdoor to a human review gate — which is worth more than the
    // convenience of a green status column.
    //
    // Nothing enforces active status yet, so the dev stack trades exactly as
    // before. What changes is that the gate is VISIBLE every time anybody
    // runs `pnpm stack:up`, rather than being bypassed silently.
    for (const t of [TENANT_A, TENANT_B]) {
      await db.query(
        `insert into platform.tenant (id, slug, legal_name, status, jurisdiction_code)
         values ($1, $2, $3, 'provisioning', 'GH')
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
      await applySequenceCounters(tx, TENANT_A.id);
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
      // Tenant B's location is hand-seeded, so its receipt-number counter is
      // too — the same additive applier, run after the location exists.
      await applySequenceCounters(tx, TENANT_B.id);
      return r;
    });
    console.log(
      `[bootstrap] tenant B (${TENANT_B.slug}): template ${resB.templateId}@${resB.templateVersion}, ` +
        `${resB.founderPending.length} founder-pending SKUs`,
    );

    // 5 — dev principals ---------------------------------------------------
    //
    // ════════════════════════════════════════════════════════════════════════
    // WHY THE STACK IS UNUSABLE WITHOUT THIS
    // ════════════════════════════════════════════════════════════════════════
    // `applyTemplate` seeds a tenant's five ROLES and their permission
    // composition, and deliberately seeds no users and no assignments: who
    // works here, and at which node of the tree, is onboarding input rather
    // than template content (01 §1.6).
    //
    // The API resolves permissions per request from `app.effective_permission`
    // keyed on the token's `uid`. So a freshly-bootstrapped tenant has five
    // roles, zero grants, and every signed token on earth is refused at the
    // first guarded route. That is correct behaviour and a broken dev stack at
    // the same time.
    //
    // There is no admin.user.manage endpoint yet to do this properly, so the
    // bootstrap plays the onboarding operator: one principal per template
    // role, fixed username, so `infra/scripts/dev-token.mjs --role <ref>` can
    // find it and mint a bearer that actually works.
    //
    // DEV CONVENIENCE, STATED PLAINLY: the counter and manager principals are
    // scoped at the tenant ROOT rather than at a leaf, so `--location OUT-07`
    // works without re-provisioning. Real onboarding scopes them at their own
    // outlet, and the leaf-scoped behaviour — a manager at OUT-01 refused at
    // OUT-04 — is demonstrated over real HTTP by
    // `pnpm --filter @erp/wire-conformance drill:rbac`. What this does NOT do
    // is widen anyone's CAPABILITIES: the counter role still holds no
    // stock.adjust and no credit.limit.change at any scope, which is the part
    // the brief cares about.
    const DEV_PRINCIPALS: { roleRef: string; scope: 'root' | 'region'; label: string }[] = [
      { roleRef: 'counter_staff', scope: 'root', label: 'Counter staff (dev)' },
      { roleRef: 'outlet_manager', scope: 'root', label: 'Outlet manager (dev)' },
      { roleRef: 'regional_manager', scope: 'region', label: 'Regional manager (dev)' },
      { roleRef: 'accounts', scope: 'root', label: 'Accounts (dev)' },
      { roleRef: 'head_of_operations', scope: 'root', label: 'Head of operations (dev)' },
    ];

    for (const t of [TENANT_A, TENANT_B]) {
      const provisioned = await withTenant(t.id, async (tx) => {
        const regionRes = await tx.query<{ id: string }>(
          `select id from app.location where kind = 'GROUP' and parent_id is not null
             and deleted_at is null order by code limit 1`,
        );
        const names: string[] = [];
        for (const p of DEV_PRINCIPALS) {
          // Deterministic uid so a reset produces the same principals and any
          // token minted earlier in the day still resolves.
          const userId = deterministicUuid(t.id, 'dev-principal', p.roleRef);
          const scopeLocationId =
            p.scope === 'region' ? regionRes.rows[0]?.id : undefined;
          await provisionPrincipal(tx, t.id, {
            userId,
            username: `dev-${p.roleRef}`,
            displayName: p.label,
            roleRef: p.roleRef,
            ...(scopeLocationId ? { scopeLocationId } : {}),
          });
          names.push(p.roleRef);
        }
        return names;
      });
      console.log(`[bootstrap] tenant ${t.slug}: dev principals ${provisioned.join(', ')}`);
    }

    // 6 — dev prices -------------------------------------------------------
    //
    // A template seeds price list STRUCTURE and no prices — what a business
    // charges is the most tenant-owned number there is (packages/db/src/seed/
    // template.ts). Correct, and it leaves a dev stack with 219 products that
    // cannot be rung, so the bootstrap plays the onboarding operator here too.
    // See infra/scripts/dev-prices.ts for what these numbers are and are not.
    for (const t of [TENANT_A, TENANT_B]) {
      const priced = await withTenant(t.id, (tx) => applyDevPrices(tx, t.id));
      console.log(
        `[bootstrap] tenant ${t.slug}: ${priced.items} dev prices across ` +
          `${priced.lists.join(', ')}`,
      );
      if (priced.inclusiveLists.length > 0) {
        console.log(
          `[bootstrap] tenant ${t.slug}: ${priced.inclusiveLists.join(', ')} priced ` +
            'tax-INCLUSIVE, exactly as the template ships them. The bootstrap no longer ' +
            'flips them to exclusive; a shelf price is de-grossed at the till and on the ' +
            'server, so the dev stack now runs the configuration a real tenant runs.',
        );
      }
    }

    // 6b — dev purchase units ---------------------------------------------
    //
    // The template marks every converting unit `can_sell` and never `can_buy`
    // — the founder confirms the buying direction — so a stack built from
    // nothing has no product bought in anything but its stocking unit, and the
    // procurement, distribution-cost and counter drills abort at their first
    // precondition. See infra/scripts/dev-purchase-units.ts for why this
    // enables an existing row rather than authoring a factor.
    for (const t of [TENANT_A, TENANT_B]) {
      const units = await withTenant(t.id, (tx) => applyDevPurchaseUnits(tx, t.id));
      console.log(
        `[bootstrap] tenant ${t.slug}: ${units.enabled} converting unit(s) made buyable ` +
          `(${units.buyable.length} buyable in total, e.g. ${units.buyable.slice(0, 3).join(', ')})`,
      );
    }

    // 7 — record the dev tenant ids --------------------------------------
    const outPath = fileURLToPath(new URL('../dev-tenants.json', import.meta.url));
    const tenants = {
      note: 'Local dev-stack tenants, recreated identically by pnpm stack:reset.',
      tenantA: TENANT_A,
      tenantB: TENANT_B,
    };
    await writeFile(outPath, `${JSON.stringify(tenants, null, 2)}\n`);
    // ── The DRAFT chart of accounts — dev fixture, tenant A only. ─────────
    // Same footing as dev prices: the template deliberately ships a ledger
    // with no accounts (Track B, §2.8 accountant review, Q6), and a dev stack
    // whose Books screen can only ever show an empty state exercises nothing.
    // Tenant B stays empty ON PURPOSE — a live isolation check: B's books
    // must read empty while A's carry figures.
    // packages/db/src/seed/dev-ledger.ts says why this is not template
    // content; docs/draft-chart-of-accounts.md is the review artifact.
    const ledger = await withTenant(TENANT_A.id, (tx) => seedDevLedger(tx, TENANT_A.id));
    if (ledger.unmappedRequired.length > 0) {
      throw new Error(
        `[bootstrap] the draft ledger fails its own completeness gate: ${ledger.unmappedRequired.join(', ')}`,
      );
    }
    console.log(
      `[bootstrap] tenant ${TENANT_A.slug}: DRAFT chart of accounts — ${ledger.accounts} accounts, ` +
        `${ledger.mappings} role mappings, ${ledger.periods} periods (FY27). UNREVIEWED (§2.8, Q6): ` +
        `a proposal for the accountant, never template content. Post settled sales with: pnpm dev:post-settled`,
    );

    // Say plainly what is standing between these tenants and activation.
    const unconfirmed = await db.query<{ tax_code: string }>(
      `select tax_code from platform.tax_rate
        where jurisdiction_code = 'GH' and upper_inf(effective) and confirmed_by is null
        order by tax_code`,
    );
    if (unconfirmed.rows.length > 0) {
      console.log(
        `[bootstrap] tenants are 'provisioning', NOT active: ${unconfirmed.rows.length} tax rate(s) ` +
          `in force carry no practitioner confirmation (${unconfirmed.rows.map((r) => r.tax_code).join(', ')}). ` +
          `That is open-questions Q8 and CLAUDE.md §2.8; the dev stack still trades, and the gate is real.`,
      );
    } else {
      console.log(`[bootstrap] every tax rate in force is confirmed — these tenants can be activated`);
    }

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
