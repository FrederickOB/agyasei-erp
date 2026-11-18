-- ============================================================================
-- 0027 — the `platform` schema gets a backstop: every table classified,
-- tenant-keyed rows behind FORCED row-level security, reference data
-- read-only to the application.
--
-- WHY THIS MIGRATION EXISTS
-- The Phase 2 gate (docs/phase2-gate-evidence.md §4.4.3) found every `app.*`
-- table RLS-enabled and forced, and every `platform.*` table neither — while
-- 0001's default privileges hand app_user SELECT on all of them. Running as
-- app_user WITH TENANT A'S GUC SET, `select * from platform.tenant` returned
-- both tenants' legal names, and `platform.tenant_database` returned the other
-- tenant's dsn_ref and sync_service_ref. No resolver reached it (the two that
-- read platform.tenant predicate on app.current_tenant()), so it was not a
-- breach; it was a schema with no backstop, where ONE forgotten predicate in a
-- future resolver leaks the tenant registry. CLAUDE.md §2.1: "RLS is the
-- backstop … so a forgotten predicate fails closed instead of leaking."
--
-- THE CLASSIFICATION — one decision per table, and the reason for it.
-- `packages/db/test/conformance.test.ts` holds the same list and fails on any
-- platform table that is not in it, so a new platform table cannot arrive
-- unclassified.
--
--   platform.tenant          TENANT-IDENTIFYING. One row per customer of the
--                            platform: slug, legal name, lifecycle state. A
--                            tenant may read ITS OWN row (sales.ts, logistics.ts,
--                            the posting engine and the template applier all
--                            ask "what is my jurisdiction?") and nothing else.
--                            -> RLS enabled + FORCED, SELECT policy
--                               `id = app.current_tenant()`. No write grant.
--
--   platform.tenant_database TENANT-IDENTIFYING, and an operator secret
--                            pointer (dsn_ref / sync_service_ref). No
--                            application path reads it: placement is resolved
--                            by the operator plane BEFORE a tenant context
--                            exists. -> app_user loses every privilege on it,
--                            AND RLS is enabled + FORCED with the canonical
--                            `tenant_id = app.current_tenant()` policy, so the
--                            day somebody re-grants SELECT (say, so a resolver
--                            can read its own placement) the grant is confined
--                            to the caller's own row rather than the registry.
--                            Two independent controls; either alone holds.
--
--   platform.jurisdiction    GLOBAL REFERENCE DATA (jurisdiction packs,
--   platform.tax_code        ADR-0007). Statutory facts about a country — the
--   platform.tax_rate        currency, its minor-unit divisor, tax codes and
--                            effective-dated rates. Owned by the platform, the
--                            same for every tenant in that jurisdiction, and
--                            carrying no tenant_id. Scoping them by tenant
--                            would protect nothing (a VAT rate is public law)
--                            and would break the jurisdiction_pack sync bucket's
--                            premise. -> app_user may SELECT and nothing else.
--                            Pack publication is an operator path.
--
--   platform.permission      GLOBAL REFERENCE DATA (the capability catalogue,
--   platform.posting_role_catalog  0005 / 0016). Platform vocabulary a tenant
--                            composes and never mints. -> SELECT only.
--
-- WHAT KEEPS WORKING, AND WHY
--  * The operator plane (`apps/api/src/routers/provisioning.ts` — createTenant,
--    activateTenant, activationReadiness) runs through AdminRunner, which is
--    NOT app_user: the migration/owner role, superuser in PGlite and in the dev
--    stack. FORCE binds the table owner too, so in a deployed environment the
--    operator credential MUST carry BYPASSRLS — 02-security §2.3 already
--    specifies `app_migrate` as BYPASSRLS, and that is the role this plane
--    needs. A non-bypass owner would see zero tenants and provisioning would
--    fail CLOSED (loud), never leak.
--  * The PowerSync replication role (`powersync_repl`) is BYPASSRLS (infra/
--    postgres/init/01-powersync-roles.sql), and logical replication does not
--    evaluate RLS anyway — the jurisdiction_pack bucket's parameter query over
--    platform.tenant is unaffected. Sync rules remain the control on that path
--    (01-tenancy "What none of this covers").
--  * Foreign keys from app.* to platform.tenant(id) are checked by referential
--    integrity, which bypasses row security by design — inserts keep working.
--  * Trigger functions that read `platform.tenant where t.id = new.tenant_id`
--    (0003, 0008, 0015) run as app_user inside the writing tenant's context;
--    a write that passes app.* RLS has new.tenant_id = app.current_tenant(),
--    so the row they need is exactly the row the policy admits.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- platform.tenant — own row only.
-- ---------------------------------------------------------------------------
alter table platform.tenant enable row level security;
alter table platform.tenant force row level security;

create policy tenant_self on platform.tenant
  for select
  using (id = app.current_tenant());

-- 0001 granted SELECT through default privileges and nothing else; stated
-- explicitly so the absence of a write grant is a decision, not an accident.
revoke insert, update, delete, truncate, references, trigger on platform.tenant from app_user;
grant select on platform.tenant to app_user;

comment on table platform.tenant is
  'Tenant registry. TENANT-IDENTIFYING: RLS forced, app_user reads only its own row (0027). The operator plane runs as a BYPASSRLS role.';

-- ---------------------------------------------------------------------------
-- platform.tenant_database — no application access at all, and RLS behind it.
-- ---------------------------------------------------------------------------
alter table platform.tenant_database enable row level security;
alter table platform.tenant_database force row level security;

create policy tenant_isolation on platform.tenant_database
  for select
  using (tenant_id = app.current_tenant());

revoke all on platform.tenant_database from app_user;

comment on table platform.tenant_database is
  'Tenant placement (secret-store pointers). OPERATOR-ONLY: app_user holds no privilege; RLS forced with the canonical tenant predicate as the second control (0027).';

-- ---------------------------------------------------------------------------
-- Global reference data — read-only to the application.
-- ---------------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger
  on platform.jurisdiction, platform.tax_code, platform.tax_rate,
     platform.permission, platform.posting_role_catalog
  from app_user;
grant select
  on platform.jurisdiction, platform.tax_code, platform.tax_rate,
     platform.permission, platform.posting_role_catalog
  to app_user;
