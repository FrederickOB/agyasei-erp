/**
 * Grants and the PowerSync publication, converged after every migration —
 * under the migration lock, by the migrator, as part of the release.
 *
 * WHY HERE AND NOT ONLY IN A ONE-OFF PROVISIONING SCRIPT: the schema grows with
 * every release, and a grant written once at provisioning is a grant that is
 * missing from the first platform table added after it. Converging on every
 * release keeps privileges in lockstep with the schema they protect. Each step
 * is idempotent and skips roles that do not exist, so the same code runs
 * against production, the dev stack, CI and the restore drill's scratch
 * database.
 *
 * THE ROLE MODEL (infra/supabase/roles.sql creates the login roles; see the
 * production runbook):
 *
 *   app_user        NOLOGIN, NOBYPASSRLS. The only role application code acts
 *                   as on `app.*` (migration 0001). Every login role below
 *                   reaches tenant data ONLY by `SET LOCAL ROLE app_user`
 *                   with the tenant GUC set — so RLS applies, always.
 *   erp_api         the API. Member of app_user (SET, NOINHERIT); reads
 *                   `erp_meta.schema_migrations` for /readyz. No platform
 *                   writes at all.
 *   erp_operator    the API's operator plane (tenant lifecycle). Writes
 *                   `platform.tenant` / `platform.tenant_database` only.
 *                   Configured only when an operator needs it.
 *   erp_jobs        the scheduled-job runner. Member of app_user; writes its
 *                   own bookkeeping (`platform.job_run`, `platform.ops_alert`).
 *   powersync_repl  REPLICATION + BYPASSRLS (the initial snapshot is a plain
 *                   SELECT, and forced RLS would return nothing). SELECT on
 *                   the published tables and nothing else. The sync rules are
 *                   the isolation boundary on the far side of this role.
 *   <migrator>      Supabase's `postgres`. Owns the schema; member of
 *                   app_user so the backup manifest can compute each tenant's
 *                   figures under that tenant's RLS.
 */
import type { SqlClient } from '@erp/db';

/**
 * Tables the sync rules read — data queries AND parameter queries. THE ONE
 * LIST: the dev bootstrap and production both converge onto it, and a test
 * fails if `infra/powersync/sync_rules.yaml` names a table that is missing.
 */
export const POWERSYNC_PUBLICATION = 'powersync';

export const POWERSYNC_PUBLICATION_TABLES: readonly string[] = [
  'app.location',
  'app.location_type',
  'app.unit_of_measure',
  'app.product_category',
  'app.product',
  'app.product_uom',
  'app.price_list',
  'app.price_list_item',
  'app.movement_reason',
  // The till and the tenders (migrations 0020–0021): methods and the period
  // calendar in tenant_reference, sessions and tender rows in location_ops.
  'app.tender_method',
  'app.accounting_period',
  'app.cash_session',
  'app.sale_tender',
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

const IDENT = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/**
 * SQL boolean: may `role` actually `SET ROLE app_user`? On Postgres 16+
 * membership and the SET option are separate — a role's CREATOR holds ADMIN
 * membership without SET (createrole_self_grant), so a plain MEMBER check
 * says yes while SET ROLE is refused. 15 and earlier: membership is enough.
 */
export function canSetAppUserSql(roleExpr = 'current_user'): string {
  return `(case when current_setting('server_version_num')::int >= 160000
                then pg_has_role(${roleExpr}, 'app_user', 'SET')
                else pg_has_role(${roleExpr}, 'app_user', 'MEMBER') end)`;
}

/** Make the current role able to SET ROLE app_user (idempotent, version-aware). */
export const SELF_GRANT_APP_USER_SQL = `
do $self$
begin
  if current_setting('server_version_num')::int >= 160000 then
    if not pg_has_role(current_user, 'app_user', 'SET') then
      execute format('grant app_user to %I with set true', current_user);
    end if;
  elsif not pg_has_role(current_user, 'app_user', 'MEMBER') then
    execute format('grant app_user to %I', current_user);
  end if;
end
$self$;`;

function assertQualified(tables: readonly string[]): void {
  for (const t of tables) {
    if (!IDENT.test(t)) throw new Error(`not a schema-qualified table name: ${JSON.stringify(t)}`);
  }
}

/** Every grant the platform's login roles need. Idempotent; absent roles are skipped. */
export function grantsSql(publicationTables: readonly string[] = POWERSYNC_PUBLICATION_TABLES): string {
  assertQualified(publicationTables);
  const published = publicationTables.join(', ');
  // The migrator (whoever is running this) acts as app_user to compute
  // per-tenant figures under RLS for the backup manifest.
  return `${SELF_GRANT_APP_USER_SQL}
do $grants$
declare
  has_job_run boolean := to_regclass('platform.job_run') is not null;
begin
  if exists (select 1 from pg_roles where rolname = 'erp_api') then
    grant usage on schema app, platform to erp_api;
    grant app_user to erp_api;
    if to_regclass('erp_meta.schema_migrations') is not null then
      grant usage on schema erp_meta to erp_api;
      grant select on erp_meta.schema_migrations to erp_api;
    end if;
  end if;

  if exists (select 1 from pg_roles where rolname = 'erp_operator') then
    grant usage on schema app, platform to erp_operator;
    grant select, insert, update on platform.tenant to erp_operator;
    grant select, insert on platform.tenant_database to erp_operator;
    grant select on platform.jurisdiction, platform.tax_code, platform.tax_rate to erp_operator;
  end if;

  if exists (select 1 from pg_roles where rolname = 'erp_jobs') then
    grant usage on schema app, platform to erp_jobs;
    grant app_user to erp_jobs;
    grant select on platform.tenant to erp_jobs;
    if has_job_run then
      grant select, insert, update on platform.job_run, platform.ops_alert to erp_jobs;
      grant select on platform.restore_drill to erp_jobs;
    end if;
    if to_regclass('erp_meta.schema_migrations') is not null then
      grant usage on schema erp_meta to erp_jobs;
      grant select on erp_meta.schema_migrations to erp_jobs;
    end if;
  end if;

  if exists (select 1 from pg_roles where rolname = 'powersync_repl') then
    grant usage on schema app, platform to powersync_repl;
    grant select on ${published} to powersync_repl;
  end if;
end
$grants$;`;
}

export async function convergeGrants(db: SqlClient, publicationTables?: readonly string[]): Promise<void> {
  await db.exec(grantsSql(publicationTables));
}

export interface PublicationResult {
  readonly created: boolean;
  readonly added: readonly string[];
  /** In the publication but not in the list. NEVER dropped automatically: removing a table is a contraction. */
  readonly unexpected: readonly string[];
}

/**
 * Converge the PowerSync publication by EXPANSION ONLY: create it, or add
 * what is missing. Removing a table from a live publication is a contraction
 * with a fleet-wide cost (Rule 9.3-D), so it is reported, never performed.
 */
export async function convergePublication(
  db: SqlClient,
  tables: readonly string[] = POWERSYNC_PUBLICATION_TABLES,
  name: string = POWERSYNC_PUBLICATION,
): Promise<PublicationResult> {
  assertQualified(tables);
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`bad publication name ${name}`);
  const exists = await db.query<{ n: number }>(`select count(*)::int as n from pg_publication where pubname = $1`, [
    name,
  ]);
  if ((exists.rows[0]?.n ?? 0) === 0) {
    await db.exec(`create publication ${name} for table ${tables.join(', ')}`);
    return { created: true, added: [...tables], unexpected: [] };
  }
  const current = new Set(
    (
      await db.query<{ t: string }>(
        `select schemaname || '.' || tablename as t from pg_publication_tables where pubname = $1`,
        [name],
      )
    ).rows.map((r) => r.t),
  );
  const missing = tables.filter((t) => !current.has(t));
  if (missing.length > 0) {
    await db.exec(`alter publication ${name} add table ${missing.join(', ')}`);
  }
  const wanted = new Set(tables);
  return { created: false, added: missing, unexpected: [...current].filter((t) => !wanted.has(t)).sort() };
}
