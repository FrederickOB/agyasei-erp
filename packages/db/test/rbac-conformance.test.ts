/**
 * Structural conformance for the ACCESS-CONTROL tables, asserted BY NAME.
 *
 * test/conformance.test.ts already refuses any app table missing the tenant
 * pattern — but it would pass just as happily if all five of these tables
 * disappeared. This file is the other half: these specific tables exist, and
 * they carry the pattern.
 *
 * It also asserts the two things that make this model what it claims to be:
 * the resolution path cannot read a role NAME, and it cannot skip the
 * location scope.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDb } from '../src/testing/harness.js';
import { setupDb } from './util.js';

let db: TestDb;

const RBAC_TABLES = [
  'location_closure',
  'role',
  'role_permission',
  'user_account',
  'user_role_assignment',
] as const;

beforeAll(async () => {
  db = await setupDb();
});
afterAll(async () => {
  await db.close();
});

describe('access-control tables carry the tenant pattern, by name', () => {
  it('all five exist with tenant_id, RLS enabled AND forced, a tenant-leading index and write_id', async () => {
    const res = await db.query<{
      relname: string;
      has_tenant_id: boolean;
      rls_enabled: boolean;
      rls_forced: boolean;
      tenant_leading_index: boolean;
      has_write_id: boolean;
      tenant_leading_pk: boolean;
    }>(
      `select c.relname,
              exists (select 1 from pg_attribute a
                       where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
                as has_tenant_id,
              c.relrowsecurity as rls_enabled,
              c.relforcerowsecurity as rls_forced,
              exists (select 1 from pg_index i
                        join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
                       where i.indrelid = c.oid and a.attname = 'tenant_id')
                as tenant_leading_index,
              exists (select 1 from pg_attribute a
                       where a.attrelid = c.oid and a.attname = 'write_id' and not a.attisdropped)
                as has_write_id,
              exists (select 1 from pg_index i
                        join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
                       where i.indrelid = c.oid and i.indisprimary and a.attname = 'tenant_id')
                as tenant_leading_pk
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'r' and c.relname = any($1::text[])
        order by c.relname`,
      [[...RBAC_TABLES]],
    );

    expect(res.rows.map((r) => r.relname)).toEqual([...RBAC_TABLES].sort());
    for (const row of res.rows) {
      expect({ table: row.relname, ...row }).toMatchObject({
        has_tenant_id: true,
        rls_enabled: true,
        rls_forced: true,
        tenant_leading_index: true,
        tenant_leading_pk: true,
        has_write_id: true,
      });
    }
  });

  it('each carries exactly one permissive policy with the canonical predicate', async () => {
    const res = await db.query<{ relname: string; qual: string; withcheck: string }>(
      `select c.relname,
              pg_get_expr(p.polqual, c.oid) as qual,
              pg_get_expr(p.polwithcheck, c.oid) as withcheck
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_policy p on p.polrelid = c.oid
        where n.nspname = 'app' and c.relname = any($1::text[])
        order by c.relname`,
      [[...RBAC_TABLES]],
    );
    expect(res.rows).toHaveLength(RBAC_TABLES.length);
    for (const row of res.rows) {
      expect(row.qual).toBe('(tenant_id = app.current_tenant())');
      expect(row.withcheck).toBe('(tenant_id = app.current_tenant())');
    }
  });

  it('the resolution views run with security_invoker — RLS as the caller, not the owner', async () => {
    const res = await db.query<{ relname: string; ok: boolean }>(
      `select c.relname,
              coalesce(c.reloptions @> array['security_invoker=true'], false) as ok
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'v'
          and c.relname in ('effective_permission', 'user_location_scope')
        order by c.relname`,
    );
    expect(res.rows).toEqual([
      { relname: 'effective_permission', ok: true },
      { relname: 'user_location_scope', ok: true },
    ]);
  });
});

describe('the permission catalogue is deliberately NOT tenant data', () => {
  it('lives in platform, has no tenant_id, and is not in the app schema', async () => {
    const cols = await db.query<{ attname: string }>(
      `select a.attname from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'platform' and c.relname = 'permission'
          and a.attnum > 0 and not a.attisdropped`,
    );
    expect(cols.rows.length).toBeGreaterThan(0);
    expect(cols.rows.map((r) => r.attname)).not.toContain('tenant_id');

    const inApp = await db.query(
      `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'permission'`,
    );
    expect(inApp.rows).toEqual([]);
  });

  it('every app table still has tenant_id — the catalogue bought no exemption', async () => {
    const res = await db.query<{ relname: string }>(
      `select c.relname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'r'
          and not exists (select 1 from pg_attribute a
                           where a.attrelid = c.oid and a.attname = 'tenant_id'
                             and not a.attisdropped)`,
    );
    expect(res.rows).toEqual([]);
  });

  it('a role_permission cannot name a code the platform has not defined', async () => {
    const fk = await db.query<{ n: string }>(
      `select count(*)::text as n
         from pg_constraint
        where conrelid = 'app.role_permission'::regclass
          and contype = 'f'
          and confrelid = 'platform.permission'::regclass`,
    );
    expect(Number(fk.rows[0]!.n)).toBe(1);
  });
});

describe('the resolution path cannot cheat', () => {
  it('never reads a role NAME — the tenant’s word for the tenant’s job', async () => {
    const res = await db.query<{ def: string }>(
      `select pg_get_viewdef('app.effective_permission'::regclass, true) as def`,
    );
    const def = res.rows[0]!.def;
    expect(def).toMatch(/role_permission/);
    // r.name never appears: the only column of app.role the view touches is
    // is_owner, which is a capability statement, not a name.
    expect(def).not.toMatch(/\br\.name\b/);
    expect(def).toMatch(/is_owner/);
  });

  it('cannot skip the location scope: the closure join is in the view itself', async () => {
    const res = await db.query<{ def: string }>(
      `select pg_get_viewdef('app.effective_permission'::regclass, true) as def`,
    );
    expect(res.rows[0]!.def).toMatch(/location_closure/);
    expect(res.rows[0]!.def).toMatch(/scope_location_id/);
  });
});
