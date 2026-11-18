/**
 * Structural conformance: interrogate pg_catalog on the MIGRATED schema and
 * fail on any app table that is missing any part of the tenant pattern
 * (01-tenancy §1.3 layer 3; 04 §4.2.5). This is the layer that actually
 * holds, because it is the only one that does not depend on anyone using the
 * right tool: a new table added by hand shows up here with no test written
 * for it.
 *
 * Assertions, per app relation:
 *   1. has a tenant_id column
 *   2. row security ENABLED
 *   3. row security FORCED (owner not exempt)
 *   4. an index whose FIRST key column is tenant_id
 *   5. exactly one permissive policy whose USING and WITH CHECK are the
 *      canonical predicate (a policy that exists but reads USING (true) is a
 *      leak wearing a seatbelt)
 *   6. has a write_id column (per-assertion exemption: write_log only)
 *   7. views run with security_invoker = true
 *   8. no float/money/numeric column anywhere in app
 *   9. the database's app tables and the tenantTable() registry agree
 *
 * And, beyond `app` (added after docs/phase2-gate-evidence.md §4.4.3 found the
 * whole `platform` schema outside this file — RLS off, not forced, readable
 * by app_user, and nothing here able to notice):
 *  10. EVERY relation in EVERY non-system schema that carries a tenant_id
 *      column has row security ENABLED and FORCED, and every policy on it is
 *      the canonical tenant predicate. Enumerated from the live catalogue, so
 *      a `platform.*`, `public.*` or brand-new-schema table with a tenant_id
 *      and no forced RLS turns this red the day it is migrated.
 *  11. tenant_id-bearing relations live in `app` or `platform` and nowhere
 *      else (02-security §2.3's promised assertion).
 *  12. EVERY platform table is CLASSIFIED (PLATFORM_TABLES below) and its
 *      catalogue state matches the class: tenant-keyed tables are RLS-forced
 *      on their key column; global reference data carries no tenant_id and is
 *      read-only to app_user. An unclassified platform table fails — a human
 *      decides which class it is, in a reviewed diff, before it ships.
 *  13. views and the float/numeric guard cover `platform` as well as `app`.
 *
 * NOTHING may ever be exempt from tenant_id or forced RLS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Importing the mirrors populates the tenantTable() registry the
// database-vs-registry reconciliation below compares against.
import '../src/schema.js';
import { registeredAppTableNames, WRITE_ID_EXEMPT } from '../src/tenant-table.js';
import type { TestDb } from '../src/testing/harness.js';
import { setupDb } from './util.js';

interface TableFacts {
  relname: string;
  relkind: string;
  has_tenant_id: boolean;
  rls_enabled: boolean;
  rls_forced: boolean;
  has_tenant_leading_index: boolean;
  has_write_id: boolean;
}

async function tableFacts(db: TestDb): Promise<TableFacts[]> {
  const res = await db.query<TableFacts>(`
    select c.relname,
           c.relkind,
           exists (select 1 from pg_attribute a
                   where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
             as has_tenant_id,
           c.relrowsecurity  as rls_enabled,
           c.relforcerowsecurity as rls_forced,
           exists (select 1
                   from pg_index i
                   join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
                   where i.indrelid = c.oid and a.attname = 'tenant_id')
             as has_tenant_leading_index,
           exists (select 1 from pg_attribute a
                   where a.attrelid = c.oid and a.attname = 'write_id' and not a.attisdropped)
             as has_write_id
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in ('r', 'p')
    order by c.relname
  `);
  return res.rows;
}

// ---------------------------------------------------------------------------
// Beyond `app`: every schema that can hold a tenant's rows.
// ---------------------------------------------------------------------------

/** Schemas Postgres owns. Everything else is ours and is swept. */
const SYSTEM_SCHEMA_SQL = `(n.nspname in ('pg_catalog', 'information_schema') or n.nspname like 'pg\\_%')`;

/** The only schemas a tenant_id-bearing relation may live in (02-security §2.3). */
const TENANT_SCHEMAS = ['app', 'platform'] as const;

/**
 * Every platform table, CLASSIFIED. Migration 0027 carries the reasoning for
 * each entry; this list is the machine-checked half of it.
 *
 *  - `tenant-keyed`: the row identifies or belongs to one tenant. RLS ENABLED
 *    and FORCED, every policy keyed `<keyColumn> = app.current_tenant()`, and
 *    app_user never holds a write privilege. `appUserSelect` says whether the
 *    application may read its own row at all.
 *  - `global`: platform-owned reference data, identical for every tenant in a
 *    jurisdiction (or for every tenant, full stop). No tenant_id column;
 *    app_user may SELECT and nothing else.
 *
 * ADDING A PLATFORM TABLE? Add it here, with its class, in the same diff as
 * the migration — and say why in the migration. If it carries a tenant_id it
 * is tenant-keyed; that is not a choice.
 */
const PLATFORM_TABLES: Record<
  string,
  | { class: 'tenant-keyed'; keyColumn: string; appUserSelect: boolean }
  | { class: 'global' }
  // Operator telemetry (job runs, alerts, restore drills — migration 0029).
  // app_user holds NO privilege, not even SELECT, and the table carries no
  // tenant_id: a tenant it is ABOUT is named `subject_tenant_id`, because in
  // this schema `tenant_id` means "owned by, and RLS-forced on", and the
  // writer (erp_jobs) is deliberately NOBYPASSRLS.
  | { class: 'operator-only' }
> = {
  tenant: { class: 'tenant-keyed', keyColumn: 'id', appUserSelect: true },
  tenant_database: { class: 'tenant-keyed', keyColumn: 'tenant_id', appUserSelect: false },
  jurisdiction: { class: 'global' },
  tax_code: { class: 'global' },
  tax_rate: { class: 'global' },
  permission: { class: 'global' },
  posting_role_catalog: { class: 'global' },
  job_run: { class: 'operator-only' },
  ops_alert: { class: 'operator-only' },
  restore_drill: { class: 'operator-only' },
};

const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;

interface TenantBearingFacts {
  nspname: string;
  relname: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_count: number;
  noncanonical_policies: string[];
}

/** Every relation in every non-system schema with a tenant_id column. */
async function tenantBearingRelations(db: TestDb): Promise<TenantBearingFacts[]> {
  const res = await db.query<TenantBearingFacts>(`
    select n.nspname,
           c.relname,
           c.relrowsecurity      as rls_enabled,
           c.relforcerowsecurity as rls_forced,
           (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policy_count,
           coalesce((
             select array_agg(p.polname::text order by p.polname)
               from pg_policy p
              where p.polrelid = c.oid
                and (not p.polpermissive
                     or pg_get_expr(p.polqual, c.oid) is distinct from '(tenant_id = app.current_tenant())'
                     or (p.polwithcheck is not null
                         and pg_get_expr(p.polwithcheck, c.oid) is distinct from '(tenant_id = app.current_tenant())'))
           ), '{}') as noncanonical_policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where not ${SYSTEM_SCHEMA_SQL}
       and c.relkind in ('r', 'p')
       and exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
     order by n.nspname, c.relname
  `);
  return res.rows;
}

function tenantBearingViolations(facts: TenantBearingFacts[]): string[] {
  const out: string[] = [];
  for (const t of facts) {
    const name = `${t.nspname}.${t.relname}`;
    if (!(TENANT_SCHEMAS as readonly string[]).includes(t.nspname))
      out.push(`${name}: tenant_id outside app/platform`);
    if (!t.rls_enabled) out.push(`${name}: row security not ENABLED`);
    if (!t.rls_forced) out.push(`${name}: row security not FORCED`);
    if (t.policy_count === 0) out.push(`${name}: no policy`);
    for (const p of t.noncanonical_policies)
      out.push(`${name}: policy ${p} is not the canonical tenant predicate`);
  }
  return out;
}

interface PlatformFacts {
  relname: string;
  has_tenant_id: boolean;
  rls_enabled: boolean;
  rls_forced: boolean;
  policies: { name: string; permissive: boolean; qual: string | null; withcheck: string | null }[];
  app_user_select: boolean;
  app_user_writes: string[];
}

async function platformFacts(db: TestDb): Promise<PlatformFacts[]> {
  const res = await db.query<PlatformFacts>(
    `select c.relname,
            exists (select 1 from pg_attribute a
                     where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
              as has_tenant_id,
            c.relrowsecurity      as rls_enabled,
            c.relforcerowsecurity as rls_forced,
            coalesce((
              select json_agg(json_build_object(
                       'name', p.polname,
                       'permissive', p.polpermissive,
                       'qual', pg_get_expr(p.polqual, c.oid),
                       'withcheck', pg_get_expr(p.polwithcheck, c.oid)) order by p.polname)
                from pg_policy p where p.polrelid = c.oid
            ), '[]'::json) as policies,
            has_table_privilege('app_user', c.oid, 'SELECT') as app_user_select,
            array(select priv from unnest($1::text[]) priv
                   where has_table_privilege('app_user', c.oid, priv)) as app_user_writes
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'platform' and c.relkind in ('r', 'p')
      order by c.relname`,
    [[...WRITE_PRIVILEGES]],
  );
  return res.rows;
}

function platformViolations(facts: PlatformFacts[]): string[] {
  const out: string[] = [];
  for (const t of facts) {
    const name = `platform.${t.relname}`;
    // Never exemptible: app_user writes no platform table, whatever its class.
    for (const w of t.app_user_writes) out.push(`${name}: app_user holds ${w}`);
    const cls = PLATFORM_TABLES[t.relname];
    if (!cls) {
      out.push(`${name}: not classified in PLATFORM_TABLES (tenant-keyed, global or operator-only?)`);
      continue;
    }
    if (cls.class === 'operator-only') {
      if (t.has_tenant_id) out.push(`${name}: operator-only but carries tenant_id (name the subject, not the owner)`);
      if (t.app_user_select) out.push(`${name}: operator-only but app_user can SELECT it`);
      continue;
    }
    if (cls.class === 'global') {
      if (t.has_tenant_id) out.push(`${name}: classified global but carries tenant_id`);
      if (!t.app_user_select) out.push(`${name}: global reference data app_user cannot read`);
      continue;
    }
    const canonical = `(${cls.keyColumn} = app.current_tenant())`;
    if (!t.rls_enabled) out.push(`${name}: row security not ENABLED`);
    if (!t.rls_forced) out.push(`${name}: row security not FORCED`);
    if (t.policies.length === 0) out.push(`${name}: no policy`);
    for (const p of t.policies) {
      if (!p.permissive) out.push(`${name}: policy ${p.name} is restrictive, not the tenant predicate`);
      if (p.qual !== canonical) out.push(`${name}: policy ${p.name} reads ${p.qual}, not ${canonical}`);
      if (p.withcheck !== null && p.withcheck !== canonical)
        out.push(`${name}: policy ${p.name} checks ${p.withcheck}, not ${canonical}`);
    }
    if (t.app_user_select !== cls.appUserSelect)
      out.push(`${name}: app_user SELECT is ${t.app_user_select}, classified ${cls.appUserSelect}`);
  }
  for (const listed of Object.keys(PLATFORM_TABLES)) {
    if (!facts.some((t) => t.relname === listed))
      out.push(`platform.${listed}: classified but does not exist (stale entry)`);
  }
  return out;
}

function violations(facts: TableFacts[]): string[] {
  const out: string[] = [];
  for (const t of facts) {
    // These two are NEVER exemptible, for any table, ever.
    if (!t.has_tenant_id) out.push(`${t.relname}: missing tenant_id`);
    if (!t.rls_enabled) out.push(`${t.relname}: row security not ENABLED`);
    if (!t.rls_forced) out.push(`${t.relname}: row security not FORCED`);
    if (!t.has_tenant_leading_index) out.push(`${t.relname}: no index leading with tenant_id`);
    if (!t.has_write_id && !WRITE_ID_EXEMPT.includes(t.relname))
      out.push(`${t.relname}: missing write_id (and not on the per-assertion exemption list)`);
  }
  return out;
}

describe('app schema structural conformance', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('every app table has tenant_id, enabled+forced RLS, a tenant-leading index and the write spine', async () => {
    const facts = await tableFacts(db);
    expect(facts.length).toBeGreaterThan(0);
    expect(violations(facts)).toEqual([]);
  });

  it('every app table has exactly one permissive policy carrying the canonical tenant predicate', async () => {
    const res = await db.query<{ relname: string; problem: string }>(`
      select c.relname,
             'policy is not the canonical tenant predicate' as problem
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'app' and c.relkind in ('r', 'p')
      group by c.oid, c.relname
      having count(*) filter (where p.polpermissive) <> 1
          or bool_or(pg_get_expr(p.polqual, c.oid)
               is distinct from '(tenant_id = app.current_tenant())')
          or bool_or(pg_get_expr(p.polwithcheck, c.oid)
               is distinct from '(tenant_id = app.current_tenant())')
    `);
    expect(res.rows).toEqual([]);
  });

  it('every view in every non-system schema runs with security_invoker (RLS evaluated as the caller, not the owner)', async () => {
    // Widened from `app` alone: a view in `public` or `platform` over app
    // tables, owned by a BYPASSRLS role, returns every tenant's rows.
    const res = await db.query<{ relname: string }>(`
      select n.nspname || '.' || c.relname as relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where not ${SYSTEM_SCHEMA_SQL} and c.relkind in ('v', 'm')
        and not coalesce(c.reloptions @> array['security_invoker=true'], false)
    `);
    expect(res.rows).toEqual([]);
  });

  it('no float, money or numeric column exists in any non-system schema (ADR-0004, domains resolved)', async () => {
    // Widened from `app` alone: platform carries jurisdiction money facts
    // (minor-unit divisors, rate basis points) and is held to the same rule.
    const res = await db.query<{ relname: string; attname: string; base_type: string }>(`
      select n.nspname || '.' || c.relname as relname, a.attname, bt.typname as base_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      join pg_type t on t.oid = a.atttypid
      -- resolve domains to their base type so a domain over float8 cannot hide
      join lateral (
        select case when t.typtype = 'd' then (select typname from pg_type where oid = t.typbasetype)
                    else t.typname end as typname
      ) bt on true
      where not ${SYSTEM_SCHEMA_SQL} and c.relkind in ('r', 'p', 'v', 'm')
        and bt.typname in ('float4', 'float8', 'money', 'numeric')
    `);
    expect(res.rows).toEqual([]);
  });

  it('the database and the tenantTable() registry agree — a table in one but not the other fails', async () => {
    const facts = await tableFacts(db);
    const dbTables = facts.map((t) => t.relname).sort();
    expect(dbTables).toEqual(registeredAppTableNames());
  });

  it('a new table missing the pattern is caught (negative control)', async () => {
    await db.asAdmin(async (tx) => {
      await tx.query('create table app.smoke_bad (id int primary key)');
    });
    try {
      const facts = await tableFacts(db);
      const bad = violations(facts).filter((v) => v.startsWith('smoke_bad:'));
      expect(bad).toContain('smoke_bad: missing tenant_id');
      expect(bad).toContain('smoke_bad: row security not ENABLED');
      expect(bad).toContain('smoke_bad: row security not FORCED');
      expect(bad).toContain('smoke_bad: no index leading with tenant_id');
      // ...and it is not in the registry either:
      expect(registeredAppTableNames()).not.toContain('smoke_bad');
    } finally {
      await db.asAdmin(async (tx) => {
        await tx.query('drop table app.smoke_bad');
      });
    }
  });
});

describe('beyond app: every schema that can hold a tenant’s rows', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await setupDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('EVERY relation with a tenant_id, in ANY schema, has RLS enabled AND forced with only the canonical policy', async () => {
    const facts = await tenantBearingRelations(db);
    // Non-vacuity: the sweep really sees both schemas it is about. If the
    // enumeration broke and returned nothing, "no violations" would be a lie.
    expect(facts.some((t) => t.nspname === 'app')).toBe(true);
    expect(facts.some((t) => t.nspname === 'platform' && t.relname === 'tenant_database')).toBe(true);
    expect(tenantBearingViolations(facts)).toEqual([]);
  });

  it('every platform table is classified, and its catalogue state matches its class', async () => {
    const facts = await platformFacts(db);
    expect(facts.map((t) => t.relname).sort()).toEqual(Object.keys(PLATFORM_TABLES).sort());
    expect(platformViolations(facts)).toEqual([]);
  });

  it('negative control: a platform table with a tenant_id and no forced RLS is caught', async () => {
    await db.asAdmin((tx) =>
      tx.query('create table platform.smoke_tenant_leak (tenant_id uuid primary key, secret text)'),
    );
    try {
      const sweep = tenantBearingViolations(await tenantBearingRelations(db)).filter((v) =>
        v.startsWith('platform.smoke_tenant_leak:'),
      );
      expect(sweep).toContain('platform.smoke_tenant_leak: row security not ENABLED');
      expect(sweep).toContain('platform.smoke_tenant_leak: row security not FORCED');
      expect(sweep).toContain('platform.smoke_tenant_leak: no policy');
      const classified = platformViolations(await platformFacts(db)).filter((v) =>
        v.startsWith('platform.smoke_tenant_leak:'),
      );
      expect(classified).toContain(
        'platform.smoke_tenant_leak: not classified in PLATFORM_TABLES (tenant-keyed, global or operator-only?)',
      );
    } finally {
      await db.asAdmin((tx) => tx.query('drop table platform.smoke_tenant_leak'));
    }
  });

  it('negative control: ENABLED but not FORCED, or a USING (true) policy, is still caught', async () => {
    await db.asAdmin(async (tx) => {
      await tx.query('create table platform.smoke_half (tenant_id uuid primary key)');
      await tx.query('alter table platform.smoke_half enable row level security');
      await tx.query('create policy wide_open on platform.smoke_half using (true)');
    });
    try {
      const sweep = tenantBearingViolations(await tenantBearingRelations(db)).filter((v) =>
        v.startsWith('platform.smoke_half:'),
      );
      expect(sweep).toEqual([
        'platform.smoke_half: row security not FORCED',
        'platform.smoke_half: policy wide_open is not the canonical tenant predicate',
      ]);
    } finally {
      await db.asAdmin((tx) => tx.query('drop table platform.smoke_half'));
    }
  });

  it('negative control: a tenant_id table outside app/platform is caught, wherever it is', async () => {
    await db.asAdmin((tx) => tx.query('create table public.smoke_stray (tenant_id uuid, id uuid)'));
    try {
      const sweep = tenantBearingViolations(await tenantBearingRelations(db)).filter((v) =>
        v.startsWith('public.smoke_stray:'),
      );
      expect(sweep).toContain('public.smoke_stray: tenant_id outside app/platform');
      expect(sweep).toContain('public.smoke_stray: row security not FORCED');
    } finally {
      await db.asAdmin((tx) => tx.query('drop table public.smoke_stray'));
    }
  });

  it('negative control: a tenant-keyed platform table loses FORCE, or app_user gains a write grant — caught', async () => {
    // Mutate the REAL tables (then restore), so the classification check is
    // shown to depend on the catalogue state of the tables it names, not only
    // on smoke tables it was written against.
    await db.asAdmin(async (tx) => {
      await tx.query('alter table platform.tenant no force row level security');
      await tx.query('grant insert on platform.jurisdiction to app_user');
      await tx.query('grant select on platform.tenant_database to app_user');
    });
    try {
      const bad = platformViolations(await platformFacts(db));
      expect(bad).toContain('platform.tenant: row security not FORCED');
      expect(bad).toContain('platform.jurisdiction: app_user holds INSERT');
      expect(bad).toContain('platform.tenant_database: app_user SELECT is true, classified false');
    } finally {
      await db.asAdmin(async (tx) => {
        await tx.query('alter table platform.tenant force row level security');
        await tx.query('revoke insert on platform.jurisdiction from app_user');
        await tx.query('revoke select on platform.tenant_database from app_user');
      });
    }
    expect(platformViolations(await platformFacts(db))).toEqual([]);
  });

  it('negative control: a view outside app without security_invoker is caught', async () => {
    await db.asAdmin((tx) => tx.query('create view public.smoke_view as select id from app.location'));
    try {
      const res = await db.query<{ relname: string }>(`
        select n.nspname || '.' || c.relname as relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where not ${SYSTEM_SCHEMA_SQL} and c.relkind in ('v', 'm')
          and not coalesce(c.reloptions @> array['security_invoker=true'], false)
      `);
      expect(res.rows.map((r) => r.relname)).toContain('public.smoke_view');
    } finally {
      await db.asAdmin((tx) => tx.query('drop view public.smoke_view'));
    }
  });
});
