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

  it('every app view runs with security_invoker (RLS evaluated as the caller, not the owner)', async () => {
    const res = await db.query<{ relname: string }>(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relkind in ('v', 'm')
        and not coalesce(c.reloptions @> array['security_invoker=true'], false)
    `);
    expect(res.rows).toEqual([]);
  });

  it('no float, money or numeric column exists anywhere in app (ADR-0004, domains resolved)', async () => {
    const res = await db.query<{ relname: string; attname: string; base_type: string }>(`
      select c.relname, a.attname, bt.typname as base_type
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      join pg_type t on t.oid = a.atttypid
      -- resolve domains to their base type so a domain over float8 cannot hide
      join lateral (
        select case when t.typtype = 'd' then (select typname from pg_type where oid = t.typbasetype)
                    else t.typname end as typname
      ) bt on true
      where n.nspname = 'app' and c.relkind in ('r', 'p', 'v', 'm')
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
