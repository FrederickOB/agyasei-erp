/**
 * The §1.3 catalogue assertion, runnable against ANY database — production at
 * provisioning, a restored scratch copy in a drill. The same rules the
 * conformance suite enforces in CI (packages/db/test/conformance.test.ts),
 * asked of a live catalogue: a restore that dropped a policy or lost FORCE is
 * a restore that leaks, however perfectly the rows came back.
 */
import type { Queryable } from './db.js';

export async function catalogueViolations(tx: Queryable): Promise<string[]> {
  const res = await tx.query<{ relname: string; problem: string }>(`
    with app_tables as (
      select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and c.relkind in ('r', 'p')
    )
    select relname::text, 'missing tenant_id' as problem from app_tables t
     where not exists (select 1 from pg_attribute a
                        where a.attrelid = t.oid and a.attname = 'tenant_id' and not a.attisdropped)
    union all
    select relname::text, 'row security not enabled' from app_tables where not relrowsecurity
    union all
    select relname::text, 'row security not forced' from app_tables where not relforcerowsecurity
    union all
    select t.relname::text, 'policy is not the canonical tenant predicate'
      from app_tables t left join pg_policy p on p.polrelid = t.oid
     group by t.oid, t.relname
    having count(*) filter (where p.polpermissive) <> 1
        or bool_or(pg_get_expr(p.polqual, t.oid) is distinct from '(tenant_id = app.current_tenant())')
        or bool_or(pg_get_expr(p.polwithcheck, t.oid) is distinct from '(tenant_id = app.current_tenant())')
    order by 1, 2`);
  return res.rows.map((r) => `app.${r.relname}: ${r.problem}`);
}
