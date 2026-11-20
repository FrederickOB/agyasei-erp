-- ============================================================================
-- 0025 — row security on the identity ROUTE tables, and the sweep's honest
-- caller (integration of identity (0023/0024) with platform RLS (0027)).
--
-- platform.enrolment_code_route and platform.device_key_route map a code hash
-- or a device-key thumbprint to its tenant BEFORE any tenant context exists —
-- that is their whole job. They carry tenant_id, so the conformance rule
-- (packages/db/test/conformance.test.ts rule 12) applies without exception:
-- RLS enabled AND forced, the canonical policy only. app_user holds no
-- privilege on either (0023) and reaches them only through four SECURITY
-- DEFINER functions:
--
--   publish_enrolment_code, register_device_key  — run WITH the tenant GUC set
--     by withTenant, so the canonical WITH CHECK admits exactly the caller's
--     own tenant's rows. A forged tenant cannot be written.
--   claim_enrolment_code, resolve_device_key     — the PRE-TENANT lookups. They
--     work because the functions' owner (the migrator) bypasses RLS — Supabase's
--     `postgres`, and the release smoke's stand-in. If the owner ever cannot,
--     they find nothing and sign-in fails CLOSED (no enrolment, no device
--     token), never open. `ops verify` checks the owner (identity.route_owner).
--
-- What forcing buys: the day someone grants app_user SELECT on a route table
-- "to debug enrolment", it still yields only the caller's own tenant's rows
-- instead of an index of every tenant's devices.
-- ============================================================================

alter table platform.enrolment_code_route enable row level security;
alter table platform.enrolment_code_route force row level security;
create policy tenant_isolation on platform.enrolment_code_route
  using (tenant_id = app.current_tenant())
  with check (tenant_id = app.current_tenant());

alter table platform.device_key_route enable row level security;
alter table platform.device_key_route force row level security;
create policy tenant_isolation on platform.device_key_route
  using (tenant_id = app.current_tenant())
  with check (tenant_id = app.current_tenant());

-- 0027 forced RLS on platform.tenant (app_user sees only its own row), so the
-- all-tenant sweep below can no longer enumerate tenants as app_user — which
-- is correct: an application session must not list tenants. The scheduled
-- reconciler (packages/ops sync.scope_refresh) runs the PER-TENANT functions
-- inside each tenant's own context instead. The comment is corrected so no
-- one schedules the sweep as app_user and believes it ran.
comment on function app.refresh_sync_scope_all() is
  'Operator/owner tool: refresh the credit and device sync projections for every tenant. As app_user it sees no tenants (platform.tenant is RLS-forced, 0027) and refreshes nothing — the scheduled reconciler is packages/ops sync.scope_refresh, which calls app.refresh_credit_sync_scope and app.refresh_device_sync_scope per tenant, every 60 s (02 §2.5).';
