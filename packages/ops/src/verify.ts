/**
 * PROVISIONING VERIFICATION — every §9.1 vendor filter, checked against the
 * live database rather than assumed from a pricing page (ADR-0003 A2:
 * "checked at provisioning, not assumed").
 *
 * Each check is PASS / FAIL / WARN / MANUAL / SKIP, with the reason. MANUAL
 * means "this cannot be observed from SQL; a human must confirm it and write
 * down the answer" — it is never silently treated as a pass. Any FAIL makes
 * the command exit non-zero.
 *
 * Checks that need a credential that was not supplied are SKIPped and say
 * which variable would enable them, so a partial run is honest about being
 * partial.
 */
import pg from 'pg';
import { catalogueViolations } from './catalogue.js';
import { canSetAppUserSql, POWERSYNC_PUBLICATION, POWERSYNC_PUBLICATION_TABLES } from './converge.js';
import { pgPoolConfig, type SslMode } from './db.js';
import { listMigrationFiles, migrationState } from './migrations.js';

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'MANUAL' | 'SKIP';

export interface CheckResult {
  readonly id: string;
  readonly filter: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface VerifyInputs {
  readonly migratorUrl: string;
  readonly apiUrl?: string | undefined;
  readonly jobsUrl?: string | undefined;
  readonly replicationUrl?: string | undefined;
  readonly storageUrl?: string | undefined;
  readonly sslMode: SslMode;
  readonly caCert?: string | undefined;
  readonly migrationsDir?: string | undefined;
  readonly supabase?: { accessToken: string; projectRef: string } | undefined;
  readonly expectedRegion?: string | undefined;
  readonly fetchImpl?: typeof fetch;
}

type Client = pg.Client;

async function connect(url: string, inputs: VerifyInputs, name: string): Promise<Client> {
  const c = new pg.Client(pgPoolConfig({ url, sslMode: inputs.sslMode, caCert: inputs.caCert, applicationName: `erp-verify-${name}` }));
  c.on('error', () => undefined);
  await c.connect();
  return c;
}

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (r === undefined) throw new Error('expected a row');
  return r;
}

export async function verifyProvisioning(inputs: VerifyInputs): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const add = (id: string, filter: string, status: CheckStatus, detail: string) => out.push({ id, filter, status, detail });
  const guard = async (id: string, filter: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      add(id, filter, 'FAIL', `check errored: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  };

  const mig = await connect(inputs.migratorUrl, inputs, 'migrator');
  try {
    await guard('tls.migrator', 'transport', async () => {
      const r = one((await mig.query<{ ssl: boolean | null }>(`select ssl from pg_stat_ssl where pid = pg_backend_pid()`)).rows);
      add('tls.migrator', 'transport', r.ssl ? 'PASS' : inputs.sslMode === 'disable' ? 'WARN' : 'FAIL', r.ssl ? 'TLS in use' : 'connection is NOT encrypted');
    });

    await guard('postgres.version', 'platform', async () => {
      const r = one((await mig.query<{ v: number; s: string }>(`select current_setting('server_version_num')::int as v, current_setting('server_version') as s`)).rows);
      add('postgres.version', 'platform', r.v >= 150000 ? 'PASS' : 'FAIL', `server ${r.s} (security_invoker views need 15+)`);
    });

    await guard('replication.wal_level', 'logical replication with user-managed slots', async () => {
      const r = one((await mig.query<{ w: string }>(`select current_setting('wal_level') as w`)).rows);
      add('replication.wal_level', 'logical replication with user-managed slots', r.w === 'logical' ? 'PASS' : 'FAIL', `wal_level = ${r.w}`);
    });

    await guard('replication.capacity', 'logical replication with user-managed slots', async () => {
      const r = one(
        (
          await mig.query<{ slots: number; used: number; senders: number }>(
            `select current_setting('max_replication_slots')::int as slots,
                    (select count(*) from pg_replication_slots)::int as used,
                    current_setting('max_wal_senders')::int as senders`,
          )
        ).rows,
      );
      const free = r.slots - r.used;
      add(
        'replication.capacity',
        'logical replication with user-managed slots',
        free >= 2 && r.senders >= 2 ? 'PASS' : 'FAIL',
        `${free} of ${r.slots} slots free, max_wal_senders ${r.senders} (PowerSync needs one slot; a re-initialisation briefly needs two)`,
      );
    });

    await guard('roles.no_bypassrls', 'application role without bypassrls', async () => {
      const rows = (
        await mig.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
          `select rolname::text, rolsuper, rolbypassrls from pg_roles
            where rolname in ('app_user', 'erp_api', 'erp_jobs', 'erp_operator') order by rolname`,
        )
      ).rows;
      const bad = rows.filter((r) => r.rolsuper || r.rolbypassrls).map((r) => r.rolname);
      const missing = ['app_user', 'erp_api', 'erp_jobs'].filter((n) => !rows.some((r) => r.rolname === n));
      add(
        'roles.no_bypassrls',
        'application role without bypassrls',
        bad.length > 0 || missing.length > 0 ? 'FAIL' : 'PASS',
        bad.length > 0
          ? `roles that bypass RLS: ${bad.join(', ')}`
          : missing.length > 0
            ? `roles missing: ${missing.join(', ')} (run infra/supabase/roles.sql)`
            : `${rows.map((r) => r.rolname).join(', ')}: nosuperuser, nobypassrls`,
      );
    });

    await guard('roles.migrator', 'backup and manifest', async () => {
      const r = one(
        (
          await mig.query<{ who: string; sup: boolean; bypass: boolean; member: boolean }>(
            `select current_user::text as who, rolsuper as sup, rolbypassrls as bypass,
                    ${canSetAppUserSql()} as member
               from pg_roles where rolname = current_user`,
          )
        ).rows,
      );
      const ok = (r.sup || r.bypass) && r.member;
      add(
        'roles.migrator',
        'backup and manifest',
        ok ? 'PASS' : 'FAIL',
        `${r.who}: bypassrls=${r.bypass || r.sup} (pg_dump of forced-RLS tables needs it), can SET ROLE app_user=${r.member} (the manifest computes each tenant under RLS; run db:migrate or infra/supabase/roles.sql to grant it)`,
      );
    });

    await guard('replication.role', 'logical replication with user-managed slots', async () => {
      const rows = (
        await mig.query<{ rolreplication: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
          `select rolreplication, rolbypassrls, rolcanlogin from pg_roles where rolname = 'powersync_repl'`,
        )
      ).rows;
      const r = rows[0];
      add(
        'replication.role',
        'logical replication with user-managed slots',
        r && r.rolreplication && r.rolbypassrls && r.rolcanlogin ? 'PASS' : 'FAIL',
        r
          ? `powersync_repl: replication=${r.rolreplication} bypassrls=${r.rolbypassrls} login=${r.rolcanlogin} (bypassrls: the initial snapshot is a SELECT under forced RLS)`
          : 'role powersync_repl does not exist',
      );
    });

    await guard('replication.publication', 'sync service', async () => {
      const rows = (
        await mig.query<{ t: string }>(
          `select schemaname || '.' || tablename as t from pg_publication_tables where pubname = $1`,
          [POWERSYNC_PUBLICATION],
        )
      ).rows.map((r) => r.t);
      const missing = POWERSYNC_PUBLICATION_TABLES.filter((t) => !rows.includes(t));
      add(
        'replication.publication',
        'sync service',
        rows.length === 0 ? 'FAIL' : missing.length > 0 ? 'FAIL' : 'PASS',
        rows.length === 0
          ? `publication ${POWERSYNC_PUBLICATION} missing or empty (db:migrate creates it)`
          : missing.length > 0
            ? `publication lacks: ${missing.join(', ')}`
            : `${rows.length} tables published`,
      );
    });

    await guard('observability.pg_stat_statements', 'pg_stat_statements, auto_explain, log export', async () => {
      const ext = (await mig.query<{ n: number }>(`select count(*)::int as n from pg_extension where extname = 'pg_stat_statements'`)).rows[0]!.n;
      if (ext === 0) {
        add('observability.pg_stat_statements', 'pg_stat_statements, auto_explain, log export', 'FAIL', 'extension not installed (create extension pg_stat_statements)');
        return;
      }
      await mig.query(`select count(*) from pg_stat_statements`);
      add('observability.pg_stat_statements', 'pg_stat_statements, auto_explain, log export', 'PASS', 'installed and readable');
    });

    await guard('observability.auto_explain', 'pg_stat_statements, auto_explain, log export', async () => {
      let r: { spl: string; sess: string };
      try {
        r = one(
          (
            await mig.query<{ spl: string; sess: string }>(
              `select current_setting('shared_preload_libraries', true) as spl,
                      coalesce(current_setting('session_preload_libraries', true), '') as sess`,
            )
          ).rows,
        );
      } catch {
        // A managed provider's `postgres` is not a superuser and may not read
        // shared_preload_libraries at all. Not a failure of the provider.
        add(
          'observability.auto_explain',
          'pg_stat_statements, auto_explain, log export',
          'WARN',
          'cannot read shared_preload_libraries as this role; confirm auto_explain availability with the provider and record it',
        );
        return;
      }
      const on = `${r.spl},${r.sess}`.includes('auto_explain');
      add(
        'observability.auto_explain',
        'pg_stat_statements, auto_explain, log export',
        on ? 'PASS' : 'WARN',
        on ? 'auto_explain preloaded' : 'auto_explain not preloaded; enable per role (ALTER ROLE erp_api SET session_preload_libraries = auto_explain) if the provider allows, or record the gap',
      );
    });
    add(
      'observability.log_export',
      'pg_stat_statements, auto_explain, log export',
      'MANUAL',
      'confirm Postgres logs can be exported (Supabase: log drains / Logs API on the chosen plan) and record where they go',
    );

    await guard('schema.migrations', 'release', async () => {
      if (!inputs.migrationsDir) {
        add('schema.migrations', 'release', 'SKIP', 'no migrations directory given');
        return;
      }
      const s = await migrationState(
        { query: async <T>(sql: string, p?: unknown[]) => ({ rows: (await mig.query(sql, p as never)).rows as T[] }) },
        await listMigrationFiles(inputs.migrationsDir),
      );
      add(
        'schema.migrations',
        'release',
        s.pending.length === 0 && s.ahead.length === 0 && s.checksumMismatch.length === 0 ? 'PASS' : 'FAIL',
        `${s.applied.length} applied; pending: ${s.pending.join(', ') || 'none'}; unknown to this build: ${s.ahead.join(', ') || 'none'}`,
      );
    });

    await guard('schema.catalogue', 'tenant isolation (§1.3 catalogue assertion)', async () => {
      const v = await catalogueViolations({
        query: async <T>(sql: string, p?: unknown[]) => ({ rows: (await mig.query(sql, p as never)).rows as T[] }),
      });
      add('schema.catalogue', 'tenant isolation (§1.3 catalogue assertion)', v.length === 0 ? 'PASS' : 'FAIL', v.length === 0 ? 'every app table: tenant_id, RLS enabled and forced, canonical policy' : v.join('; '));
    });
  } finally {
    await mig.end();
  }

  // ── The application role through the pooler ────────────────────────────
  if (!inputs.apiUrl) {
    add('pooler.set_local', 'transaction-mode pooling that preserves SET LOCAL', 'SKIP', 'set API_DATABASE_URL (erp_api via the transaction pooler) to run');
    add('rls.fail_closed', 'application role without bypassrls', 'SKIP', 'set API_DATABASE_URL to run');
  } else {
    await guard('pooler.set_local', 'transaction-mode pooling that preserves SET LOCAL', async () => {
      const port = new URL(inputs.apiUrl!).port;
      const pool = new pg.Pool({ ...pgPoolConfig({ url: inputs.apiUrl!, sslMode: inputs.sslMode, caCert: inputs.caCert, applicationName: 'erp-verify-api' }), max: 4 });
      pool.on('error', () => undefined);
      try {
        const problems: string[] = [];
        await Promise.all(
          Array.from({ length: 12 }, async (_, i) => {
            const tenant = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
            const c = await pool.connect();
            try {
              await c.query('begin');
              await c.query('set local role app_user');
              await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
              const inTx = one((await c.query<{ t: string; u: string }>(`select current_setting('app.tenant_id', true) as t, current_user::text as u`)).rows);
              await c.query('commit');
              if (inTx.t !== tenant || inTx.u !== 'app_user') problems.push(`in-transaction context lost (iteration ${i})`);
              const after = one((await c.query<{ t: string | null; u: string }>(`select nullif(current_setting('app.tenant_id', true), '') as t, current_user::text as u`)).rows);
              if (after.t !== null || after.u === 'app_user') problems.push(`context LEAKED past commit (iteration ${i})`);
            } finally {
              c.release();
            }
          }),
        );
        add(
          'pooler.set_local',
          'transaction-mode pooling that preserves SET LOCAL',
          problems.length === 0 ? 'PASS' : 'FAIL',
          problems.length === 0
            ? `SET LOCAL ROLE and the tenant GUC held inside 12 concurrent transactions and did not survive commit${port === '6543' ? ' (port 6543: Supavisor transaction mode)' : port ? ` (port ${port})` : ''}`
            : problems.slice(0, 3).join('; '),
        );
      } finally {
        await pool.end();
      }
    });

    await guard('rls.fail_closed', 'application role without bypassrls', async () => {
      const c = await connect(inputs.apiUrl!, inputs, 'api-rls');
      try {
        await c.query('begin');
        await c.query('set local role app_user');
        const r = one(
          (
            await c.query<{ active: boolean; n: number }>(
              `select row_security_active('app.write_log') as active, (select count(*) from app.write_log)::int as n`,
            )
          ).rows,
        );
        await c.query('rollback');
        add(
          'rls.fail_closed',
          'application role without bypassrls',
          r.active && r.n === 0 ? 'PASS' : 'FAIL',
          `as app_user with no tenant: row security active=${r.active}, rows visible=${r.n}`,
        );
        const g = one((await c.query<{ ok: boolean }>(`select has_table_privilege('erp_meta.schema_migrations', 'select') as ok`)).rows);
        add('api.readyz_grant', 'release', g.ok ? 'PASS' : 'FAIL', g.ok ? 'erp_api can read the applied migration list (/readyz)' : 'erp_api cannot read erp_meta.schema_migrations: run db:migrate (it converges grants)');
      } finally {
        await c.end();
      }
    });
  }

  if (!inputs.jobsUrl) {
    add('jobs.role', 'operations', 'SKIP', 'set JOBS_DATABASE_URL to run');
  } else {
    await guard('jobs.role', 'operations', async () => {
      const c = await connect(inputs.jobsUrl!, inputs, 'jobs');
      try {
        const r = one(
          (
            await c.query<{ ins: boolean; member: boolean; lock: boolean }>(
              `select has_table_privilege('platform.job_run', 'insert') as ins,
                      ${canSetAppUserSql()} as member,
                      pg_try_advisory_xact_lock(hashtextextended('erp:verify', 0)) as lock`,
            )
          ).rows,
        );
        add('jobs.role', 'operations', r.ins && r.member && r.lock ? 'PASS' : 'FAIL', `job_run insert=${r.ins}, can SET ROLE app_user=${r.member}, advisory lock=${r.lock}`);
      } finally {
        await c.end();
      }
    });
  }

  if (!inputs.replicationUrl) {
    add('replication.slot', 'logical replication with user-managed slots', 'SKIP', 'set POWERSYNC_REPLICATION_URL (powersync_repl, DIRECT connection) to run');
  } else {
    await guard('replication.slot', 'logical replication with user-managed slots', async () => {
      const c = await connect(inputs.replicationUrl!, inputs, 'repl');
      try {
        const name = `erp_verify_${Date.now().toString(36)}`;
        await c.query(`select pg_create_logical_replication_slot($1, 'pgoutput', true)`, [name]);
        await c.query(`select pg_drop_replication_slot($1)`, [name]);
        add('replication.slot', 'logical replication with user-managed slots', 'PASS', 'powersync_repl created and dropped a temporary pgoutput slot');
      } finally {
        await c.end();
      }
    });
  }

  if (!inputs.storageUrl) {
    add('powersync.storage', 'sync service', 'SKIP', 'set POWERSYNC_STORAGE_URL to run');
  } else {
    await guard('powersync.storage', 'sync service', async () => {
      const c = await connect(inputs.storageUrl!, inputs, 'storage');
      try {
        const r = one((await c.query<{ db: string; create: boolean }>(`select current_database()::text as db, has_database_privilege(current_database(), 'create') as create`)).rows);
        const sourceDb = new URL(inputs.migratorUrl).pathname.replace(/^\//, '') || 'postgres';
        const sameHost = new URL(inputs.migratorUrl).hostname === new URL(inputs.storageUrl!).hostname;
        const separate = !(sameHost && r.db === sourceDb);
        add(
          'powersync.storage',
          'sync service',
          separate && r.create ? 'PASS' : 'FAIL',
          `bucket storage database "${r.db}"${separate ? ', separate from the source database' : ' IS THE SOURCE DATABASE'}; create privilege=${r.create}`,
        );
      } finally {
        await c.end();
      }
    });
  }

  // ── What SQL cannot see ─────────────────────────────────────────────────
  if (inputs.supabase) {
    const f = inputs.fetchImpl ?? fetch;
    const api = `https://api.supabase.com/v1/projects/${encodeURIComponent(inputs.supabase.projectRef)}`;
    const headers = { authorization: `Bearer ${inputs.supabase.accessToken}` };
    await guard('provider.pitr', 'point-in-time recovery', async () => {
      const res = await f(`${api}/database/backups`, { headers, signal: AbortSignal.timeout(15_000) });
      const body = (await res.json()) as { pitr_enabled?: unknown };
      if (typeof body.pitr_enabled !== 'boolean') {
        add('provider.pitr', 'point-in-time recovery', 'MANUAL', `management API did not report pitr_enabled (HTTP ${res.status}); confirm in the dashboard: Database → Backups → Point in time`);
      } else {
        add('provider.pitr', 'point-in-time recovery', body.pitr_enabled ? 'PASS' : 'FAIL', body.pitr_enabled ? 'PITR enabled' : 'PITR is NOT enabled: daily backups only. Enable the PITR add-on before any tenant trades.');
      }
    });
    await guard('provider.region', 'EU region (ADR-0003 A2)', async () => {
      const res = await f(api, { headers, signal: AbortSignal.timeout(15_000) });
      const body = (await res.json()) as { region?: unknown };
      const want = inputs.expectedRegion ?? 'eu-west-2';
      if (typeof body.region !== 'string') add('provider.region', 'EU region (ADR-0003 A2)', 'MANUAL', `region not reported (HTTP ${res.status})`);
      else add('provider.region', 'EU region (ADR-0003 A2)', body.region === want ? 'PASS' : 'FAIL', `project region ${body.region}, expected ${want}`);
    });
  } else {
    add('provider.pitr', 'point-in-time recovery', 'MANUAL', 'set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF to check via the management API, or confirm in the dashboard that PITR is enabled');
    add('provider.region', 'EU region (ADR-0003 A2)', 'MANUAL', 'confirm the project region is eu-west-2 (London)');
  }
  add(
    'provider.rto',
    'a written RTO',
    'MANUAL',
    "obtain the provider's RTO for zone failure and failover IN WRITING (support ticket or SLA document) and record it in docs/production-runbook.md §Provider facts",
  );

  return out;
}

export function renderChecks(results: readonly CheckResult[]): string {
  const w = Math.max(...results.map((r) => r.id.length));
  return results.map((r) => `${r.status.padEnd(6)} ${r.id.padEnd(w)}  ${r.detail}`).join('\n');
}
