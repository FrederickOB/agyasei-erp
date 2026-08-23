-- ============================================================================
-- 0014_credit_view_template_correction.sql — withdraw `credit.view` from the
-- two template roles that never should have carried it, on tenants that were
-- already provisioned.
--
-- 0013 IS NEVER EDITED. Its header still says the template grants `credit.view`
-- to Outlet manager and Regional manager and calls that "a role-template defect,
-- tracked as such". That was true when it was written. This file is the fix, and
-- a migration is a historical fact, not a document — so 0013's text stands and
-- the superseding note goes on the live object comment at the foot of this file.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- `credit.view` used to authorise a READ: one account, answered by the server,
-- refusable the next second. Migration 0013 gave it a second meaning — it now
-- decides membership of `app.credit_sync_book_scope`, and therefore whether a
-- device DOWNLOADS AND KEEPS ~400 days of every credit customer's balance,
-- ageing and payment history.
--
-- `02-security-and-access-control` §2.5: the right to see something is not the
-- right to have it on your device. `docs/credit-offline-plan.md` R1.b says the
-- consequence in as many words — "`credit.view` must never be in the
-- counter-staff or outlet-manager template role" — and §2's own template table
-- gives `credit.read` (this catalogue's `credit.view`) to Accounts and to nobody
-- else. The shipped template gave it to Accounts, Outlet manager AND Regional
-- manager.
--
-- 0013's residency gate (root-scoped grants only) narrowed the blast radius but
-- could not close it: a tenant that assigns an outlet manager at the tenant root
-- — which the dev seed does for convenience, and which a small tenant with one
-- location does for real — puts the whole book on that manager's tablet. The
-- failure mode is the unrecoverable one (CLAUDE.md §2.1): once the book is on
-- the hardware it cannot be recalled.
--
-- ---------------------------------------------------------------------------
-- WHY A MIGRATION AND NOT JUST THE SEED
-- ---------------------------------------------------------------------------
-- `packages/db/src/seed/roles.ts` is applied ONCE at onboarding (ADR-0006).
-- Correcting it protects tenants provisioned from tomorrow and does exactly
-- nothing for the ones provisioned yesterday, whose devices are holding the book
-- right now. The seed change and this file are one fix in two halves.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS WITHDRAWS, AND WHAT IT DELIBERATELY LEAVES ALONE
-- ---------------------------------------------------------------------------
-- After onboarding a tenant OWNS its roles (ADR-0006). The platform may correct
-- what the platform wrote; it may not silently revoke a decision the tenant made.
-- Those two rows are distinguishable, exactly, without guessing:
--
--   * The template applier stamps `app.role.origin_template_id` / `.origin_ref`
--     on the roles it creates, and writes every grant in that module against ONE
--     `app.write_log` row whose `origin` is 'SERVER' and whose `op` is
--     'template.apply:roles'.
--   * A grant the tenant added later goes through the ordinary write path and
--     carries its own write-log entry.
--
-- Counter staff are in the predicate too. The shipped template never granted it
-- there, so the clause matches nothing today — but R1.b names that role first,
-- and a predicate that only covers the defect actually observed is a predicate
-- that misses an older template version still sitting in a tenant's history.
--
-- So the predicate below is "this row was written by the template applier, onto a
-- role the template created" — a proof of provenance, not a heuristic on a name.
-- Nothing here reads a role's NAME, and nothing here reads a tenant's identity
-- (CLAUDE.md §2.9): every tenant is treated identically and a tenant with no
-- template-provenance roles is untouched.
--
-- A tenant-made `credit.view` grant on one of those roles is REPORTED as a
-- warning and left in place. That is the honest split, and it is the one that
-- respects both §2.1 and ADR-0006.
--
-- ---------------------------------------------------------------------------
-- WHY SOFT-DELETE, AND WHERE THE AUDIT RECORD IS
-- ---------------------------------------------------------------------------
-- `deleted_at` is what `app.effective_permission` reads (`rp.deleted_at is null`
-- on its join), so a soft delete is a real withdrawal — the view stops returning
-- the code, the trigger on `app.role_permission` fires, `credit_sync_book_scope`
-- loses the user, and the next sync takes the book off the device. It is also the
-- audit record: the row stays, timestamped, so "this tenant's outlet manager held
-- `credit.view` until 0014 withdrew it" remains queryable forever. A hard delete
-- would erase the evidence of the exposure along with the exposure.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS NO CONSTRAINT ENFORCING THIS
-- ---------------------------------------------------------------------------
-- Because it would be wrong. A tenant whose org chart genuinely puts the credit
-- book in a branch manager's hands may grant `credit.view` to that role; the
-- platform does not police a tenant's org chart, it guarantees the capability is
-- only ever reachable through a check (CLAUDE.md §2.9, 02 §"The prohibitions").
-- What IS guarded is the TEMPLATE — by `packages/db/test/rbac-template.test.ts`,
-- which turns red if a future seed edit re-adds the code to the counter-staff or
-- outlet-manager role.
-- ============================================================================

do $$
declare
  t              uuid;
  withdrawn      integer;
  tenant_granted integer;
  total          integer := 0;
begin
  for t in select id from platform.tenant loop
    -- RLS is FORCED on app.* (0002), so cross-tenant DML in a migration reads
    -- and writes nothing until the GUC names a tenant. `is_local => true` keeps
    -- it to this transaction, which is the migration's own.
    perform set_config('app.tenant_id', t::text, true);

    update app.role_permission rp
       set deleted_at = transaction_timestamp(),
           updated_at = transaction_timestamp()
      from app.role r, app.write_log wl
     where rp.tenant_id       = t
       and rp.permission_code = 'credit.view'
       and rp.deleted_at is null
       -- onto a role the TEMPLATE created (provenance, never the name)
       and r.tenant_id        = rp.tenant_id
       and r.id               = rp.role_id
       and r.origin_template_id is not null
       and r.origin_ref in ('role:counter_staff', 'role:outlet_manager', 'role:regional_manager')
       -- and written by the template applier's roles module, not by the tenant
       and wl.tenant_id       = rp.tenant_id
       and wl.id              = rp.write_id
       and wl.origin          = 'SERVER'
       and wl.op              = 'template.apply:roles';
    get diagnostics withdrawn = row_count;
    total := total + withdrawn;

    if withdrawn > 0 then
      raise notice
        '0014: withdrew % template-written credit.view grant(s) from outlet/regional roles on tenant %',
        withdrawn, t;
    end if;

    -- Anything still live on those roles is the tenant's own decision. Report
    -- it loudly; do not touch it.
    select count(*) into tenant_granted
      from app.role_permission rp
      join app.role r
        on r.tenant_id = rp.tenant_id and r.id = rp.role_id
     where rp.tenant_id       = t
       and rp.permission_code = 'credit.view'
       and rp.deleted_at is null
       and r.deleted_at is null
       and r.origin_ref in ('role:counter_staff', 'role:outlet_manager', 'role:regional_manager');

    if tenant_granted > 0 then
      raise warning
        '0014: tenant % still grants credit.view to % template-provenance outlet/regional role(s) — added by the tenant, NOT withdrawn. Those devices hold the credit book; review with the tenant (credit-offline-plan R1.b).',
        t, tenant_granted;
    end if;

    -- Belt and braces. The trigger on app.role_permission has already recomputed
    -- the projection for every row above; this also re-settles a tenant whose
    -- gate was stale for the OTHER reason 0013 names — a grant whose
    -- `effective_to` lapsed with no DML to fire a trigger.
    perform app.refresh_credit_sync_scope(t);
  end loop;

  raise notice '0014: % template-written credit.view grant(s) withdrawn across all tenants', total;
end
$$;

-- The live comment supersedes the body comment inside the function, which is
-- 0013's text and stays as written.
comment on function app.refresh_credit_sync_scope(uuid) is
  'Recompute both credit sync-scope projections for one tenant. Idempotent; ids are stable across runs. NOTE: the body comment describes a role-template defect (credit.view on Outlet manager and Regional manager) that migration 0014 withdrew and packages/db/src/seed/roles.ts no longer ships; credit.view is now an Accounts-and-owner capability in the template. The root-scoped predicate remains the residency gate and is unchanged.';

comment on table app.credit_sync_book_scope is
  'Projection of app.effective_permission for credit.view AT THE TENANT ROOT. The tenant_credit sync bucket''s parameter query reads THIS — a view cannot be published to logical replication, and a token claim cannot be revoked. Membership means the device downloads and keeps the tenant credit book, so the template grants credit.view to Accounts and the owner role only (credit-offline-plan R1.b); a tenant may still grant it elsewhere, deliberately and visibly.';
