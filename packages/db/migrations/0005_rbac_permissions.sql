-- ============================================================================
-- 0005_rbac_permissions.sql — composable permissions, tenant-owned roles,
-- the location closure tree, and effective-permission resolution.
--
-- (docs/architecture/sections/02-security-and-access-control.md §2.4/§2.5;
--  CLAUDE.md §2.6; ADR-0006.)
--
-- Hand-written SQL is THE source of truth. src/schema.ts MIRRORS this DDL.
--
-- ---------------------------------------------------------------------------
-- THE DECISION THIS MIGRATION HANGS ON: WHERE THE PERMISSION CATALOGUE LIVES
-- ---------------------------------------------------------------------------
-- `permission` is the platform's vocabulary of atomic capabilities — the set
-- of things the SOFTWARE can do. It is created here as `platform.permission`:
-- GLOBAL, one row per code, no tenant_id. Deliberately, and for four reasons:
--
--   1. A permission code is a SERVER-SIDE CHECK, not a label. `sale.record`
--      means something only because a handler calls authorize(..., 'sale.record').
--      A tenant-scoped catalogue would let a tenant mint 'sale.super_record',
--      grant it to a role, and see it resolve — a permission that grants
--      nothing while LOOKING like a control. That is worse than no control at
--      all. The platform decides what actions exist; the tenant decides who
--      does them (02 §2.4, "the seam is deliberate").
--   2. It is not tenant-owned DATA. Nothing about it is editable, exportable
--      or deletable with a tenant. Copying 35 identical rows into every
--      tenant buys nothing and guarantees drift in the descriptions.
--   3. Adding a capability is a PLATFORM MIGRATION (this file), reviewed by a
--      human, exactly like adding the endpoint that checks it. Tenant-scoped
--      rows would make "does this deployment know about credit.limit.change?"
--      a per-tenant question with N answers.
--   4. `app` has NO tenant-less table and never will: 0002's header and the
--      conformance suite make `tenant_id` + FORCED RLS unexemptible for every
--      relation in that schema. A tenant-less catalogue in `app` would force a
--      hole in the one rule that has no safe exception. `platform` is where
--      the explicit, human-reviewed, non-tenant allow-list already lives
--      (0001 header; 02 §2.3 lists `permission` on it by name).
--
-- Everything that is tenant-OWNED — the roles, their composition, the users,
-- the assignments, the location closure — is in `app`, through the tenant
-- pattern, with RLS enabled AND forced. No exceptions.
--
-- ---------------------------------------------------------------------------
-- THE TWO HARD PROHIBITIONS ARE DATA, NOT CODE
-- ---------------------------------------------------------------------------
-- "Counter staff get no price overrides and no credit-limit changes" is
-- enforced by the counter role simply NOT HOLDING `sale.override_price` or
-- `credit.limit.change`. There is no role enum, no `is_counter_staff` column,
-- and nothing anywhere reads `app.role.name` — it is a tenant's word for a
-- tenant's job (CLAUDE.md §2.9). Another tenant may legitimately let their
-- counter staff discount; that is a row they add, not a patch we ship.
-- ============================================================================


-- ============================================================================
-- 1. platform.permission — the catalogue. GLOBAL. See the header.
-- ============================================================================
create table platform.permission (
  code         text primary key,             -- 'sale.override_price'
  domain       text not null,                -- leading segment; grouping for UI only
  description  text not null,

  -- Always audited; GRANTING it is itself an audited event (02 §2.4).
  is_sensitive boolean not null default false,

  -- Cannot be exercised on a stale offline session: the check must be
  -- re-run against a live server (02 §2.5, §2.7).
  requires_fresh_authorization boolean not null default false,

  -- JSON-schema-ish shape for role_permission.bound, or NULL for an
  -- unbounded capability. MONEY INSIDE jsonb IS A DECIMAL STRING, never a
  -- JSON number: JSON.parse turns a number into a float64 and ADR-0004 is
  -- categorical. Rates are integer basis points.
  bound_schema jsonb,

  created_at   timestamptz not null default transaction_timestamp(),

  constraint permission_code_shape check (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  constraint permission_domain_is_prefix check (code like domain || '.%')
);

comment on table platform.permission is
  'Platform vocabulary of atomic capabilities. GLOBAL (no tenant_id) by design — see the 0005 header. Tenants compose these into their own roles; they never mint codes.';

grant select on platform.permission to app_user;

-- ----------------------------------------------------------------------------
-- The catalogue itself. Codes are NEUTRAL: no tenant #1 vocabulary
-- ("outlet", "flagship", "RDC", "contractor") appears in any code, because a
-- code is platform surface and a tenant's org chart is not.
--
-- Granularity rule (02 §2.4): a permission exists where a role boundary
-- plausibly falls in SOME tenant's org chart, and nowhere else.
-- ----------------------------------------------------------------------------
insert into platform.permission
  (code, domain, description, is_sensitive, requires_fresh_authorization, bound_schema)
values
  -- sale ---------------------------------------------------------------------
  ('sale.record', 'sale',
   'Record a sale settled immediately (cash or mobile money).', false, false, null),
  ('sale.record.credit', 'sale',
   'Record a sale settled on a customer credit account, up to a bounded order value.',
   false, false,
   '{"max_order_value_minor":"decimal string, minor units","currency":"ISO 4217"}'::jsonb),
  ('sale.override_price', 'sale',
   'Replace the price the server resolved from the price list with a stated one.',
   true, true, null),
  ('sale.discount.apply', 'sale',
   'Apply a discount to a sale, capped at a bounded number of basis points.',
   false, false, '{"max_bps":"integer basis points"}'::jsonb),
  ('sale.void', 'sale',
   'Void a recorded sale by issuing the compensating document.', true, false, null),
  ('sale.view', 'sale',
   'Read sale documents and their lines.', false, false, null),
  ('sale.receipt.reprint', 'sale',
   'Reprint a receipt for an existing sale.', false, false, null),

  -- stock --------------------------------------------------------------------
  ('stock.view', 'stock',
   'Read stock on hand and movement history.', false, false, null),
  ('stock.adjust', 'stock',
   'Write a stock adjustment or write-off against a reason code.', true, false, null),
  ('stock.transfer', 'stock',
   'Dispatch stock out of a location towards another location.', false, false, null),
  ('stock.transfer.receive', 'stock',
   'Receive an inbound stock transfer at the destination.', false, false, null),
  ('stock.receive', 'stock',
   'Receive purchased goods, or post an opening stock balance.', false, false, null),
  ('stock.count.perform', 'stock',
   'Perform a physical stock count and submit the variance.', false, false, null),

  -- catalogue ----------------------------------------------------------------
  ('catalogue.view', 'catalogue',
   'Read the product catalogue, units of measure and effective prices.', false, false, null),
  ('catalogue.manage', 'catalogue',
   'Create and edit products, categories, units of measure and conversions.', false, false, null),
  ('catalogue.price_list.manage', 'catalogue',
   'Create and edit price lists and their prices — the other route to a price change.',
   true, false, null),

  -- customer -----------------------------------------------------------------
  ('customer.view', 'customer',
   'Read customer records.', false, false, null),
  ('customer.manage', 'customer',
   'Create and edit customer records.', false, false, null),

  -- credit -------------------------------------------------------------------
  ('credit.view', 'credit',
   'Read credit exposure, ageing and account terms.', false, false, null),
  ('credit.account.manage', 'credit',
   'Open, hold, close a credit account and set its terms.', true, false, null),
  ('credit.limit.change', 'credit',
   'Change a customer credit limit.', true, true, null),
  ('credit.entry.record', 'credit',
   'Record a credit ledger entry (charge, payment, adjustment).', false, false, null),
  ('credit.fee.accrue', 'credit',
   'Post facility-fee accruals to credit accounts.', true, false, null),
  ('credit.policy.manage', 'credit',
   'Set the tenant credit and facility-fee policy.', true, false, null),

  -- report -------------------------------------------------------------------
  ('report.view.location', 'report',
   'Read operational reports for the locations in the grant scope.', false, false, null),
  ('report.view.tenant', 'report',
   'Read consolidated reports across the whole tenant. Connected activity only.',
   false, true, null),
  ('report.view.margin', 'report',
   'Read cost prices, margins and profitability.', true, false, null),

  -- payroll — CAPTURE AND EXPORT ONLY. There is no computation to permit,
  -- because no statutory withholding logic exists anywhere in this system
  -- and never will (CLAUDE.md §2.4).
  ('payroll.register.export', 'payroll',
   'Export the payroll register for the accountant or bureau.', true, false, null),
  ('payroll.register.import', 'payroll',
   'Import the figures the bureau returned into the marked fields.', true, false, null),

  -- admin --------------------------------------------------------------------
  ('admin.user.manage', 'admin',
   'Create users and assign roles at a scope no wider than the granter holds.', true, false, null),
  ('admin.role.manage', 'admin',
   'Create and edit roles and their permission composition.', true, false, null),
  ('admin.location.manage', 'admin',
   'Create and edit locations and the location hierarchy.', true, false, null),
  ('admin.device.enrol', 'admin',
   'Enrol a device against a location.', false, false, null),
  ('admin.device.revoke', 'admin',
   'Revoke an enrolled device.', true, false, null),
  ('admin.template.apply', 'admin',
   'Apply a starter template to this tenant at onboarding.', true, false, null),

  -- sync ---------------------------------------------------------------------
  ('sync.conflict.review', 'sync',
   'Review and resolve quarantined or conflicting writes.', false, false, null)
on conflict (code) do nothing;


-- ============================================================================
-- 2. app.location_closure — the transitive closure of app.location.parent_id.
--
-- Scope is A NODE IN THE TENANT'S OWN TREE, never an outlet id (02 §2.5).
-- The adjacency list on app.location is the truth; this table is the derived
-- lookup, because the sync service's bucket-parameter query resolves a user's
-- locations on every reconnect and cannot run a recursive CTE. A hierarchy
-- only the API can resolve is a hierarchy the SYNC boundary cannot enforce —
-- which puts it on the wrong side of the most important control.
--
-- Includes the depth-0 self row, so a grant at a leaf resolves to exactly
-- that leaf and a grant at a region resolves to the region and everything
-- under it. Adding the FY3 regional manager is then an INSERT, not a
-- migration of the authorization model on top of live books.
-- ============================================================================
create table app.location_closure (
  tenant_id     uuid        not null references platform.tenant (id),
  id            uuid        not null,
  write_id      uuid        not null,
  hlc           app.hlc     not null,
  created_at    timestamptz not null default transaction_timestamp(),
  updated_at    timestamptz not null default transaction_timestamp(),
  deleted_at    timestamptz,
  ancestor_id   uuid        not null,
  descendant_id uuid        not null,
  depth         integer     not null check (depth >= 0),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  -- Derived rows: when the node goes, its closure rows go with it, and the
  -- rebuild trigger below restores consistency for what remains.
  foreign key (tenant_id, ancestor_id) references app.location (tenant_id, id)
    on delete cascade deferrable initially immediate,
  foreign key (tenant_id, descendant_id) references app.location (tenant_id, id)
    on delete cascade deferrable initially immediate
);
create unique index location_closure_uq
  on app.location_closure (tenant_id, ancestor_id, descendant_id);
create index location_closure_desc_ix
  on app.location_closure (tenant_id, descendant_id, ancestor_id);
select app.apply_tenant_rls('app.location_closure');

comment on table app.location_closure is
  'Derived transitive closure of app.location.parent_id, including the depth-0 self row. Truth is the adjacency list; this exists so the sync boundary can resolve scope without a recursive CTE (02 §2.5).';

-- Deterministic row id so a rebuild does not churn ids for unchanged edges.
create function app.location_closure_id(p_tenant uuid, p_ancestor uuid, p_descendant uuid)
returns uuid language sql immutable parallel safe as $$
  select md5(p_tenant::text || ':' || p_ancestor::text || ':' || p_descendant::text)::uuid
$$;

-- Rebuild one tenant's closure from the adjacency list. Cheap: the tree is
-- almost static and tenant #1's is 57 nodes. write_id/hlc are inherited from
-- the DESCENDANT's row — the closure row exists because that node exists, so
-- it belongs to the same unit of work (04 §4.2.2 write spine).
create function app.rebuild_location_closure(p_tenant uuid) returns void
language plpgsql as $$
begin
  delete from app.location_closure where tenant_id = p_tenant;

  insert into app.location_closure
    (tenant_id, id, write_id, hlc, ancestor_id, descendant_id, depth)
  with recursive walk as (
    select l.tenant_id, l.id as ancestor_id, l.id as descendant_id,
           0 as depth, l.write_id, l.hlc
      from app.location l
     where l.tenant_id = p_tenant and l.deleted_at is null
    union all
    select w.tenant_id, w.ancestor_id, c.id, w.depth + 1, c.write_id, c.hlc
      from walk w
      join app.location c
        on c.tenant_id = w.tenant_id
       and c.parent_id = w.descendant_id
       and c.deleted_at is null
  )
  select w.tenant_id,
         app.location_closure_id(w.tenant_id, w.ancestor_id, w.descendant_id),
         w.write_id, w.hlc, w.ancestor_id, w.descendant_id, w.depth
    from walk w;
end
$$;

-- Statement-level, using transition tables: one rebuild per statement, not
-- one per row, so the template applier's batched location inserts stay cheap.
create function app.location_closure_sync() returns trigger
language plpgsql as $$
declare
  t uuid;
begin
  if tg_op = 'INSERT' then
    for t in select distinct tenant_id from new_location loop
      perform app.rebuild_location_closure(t);
    end loop;
  elsif tg_op = 'UPDATE' then
    for t in select distinct tenant_id from new_location
             union select distinct tenant_id from old_location loop
      perform app.rebuild_location_closure(t);
    end loop;
  else
    for t in select distinct tenant_id from old_location loop
      perform app.rebuild_location_closure(t);
    end loop;
  end if;
  return null;
end
$$;

create trigger location_closure_after_insert
  after insert on app.location
  referencing new table as new_location
  for each statement execute function app.location_closure_sync();

create trigger location_closure_after_update
  after update on app.location
  referencing new table as new_location old table as old_location
  for each statement execute function app.location_closure_sync();

create trigger location_closure_after_delete
  after delete on app.location
  referencing old table as old_location
  for each statement execute function app.location_closure_sync();

-- Backfill for locations that already exist (this migration may land after
-- a tenant has been onboarded).
do $$
declare
  t uuid;
begin
  for t in select distinct tenant_id from app.location loop
    perform app.rebuild_location_closure(t);
  end loop;
end
$$;


-- ============================================================================
-- 3. app.role — TENANT-OWNED, TENANT-NAMED, EDITABLE.
--
-- `name` is the tenant's word for one of the tenant's jobs. NO PLATFORM CODE
-- EVER READS IT. Tenant #1's five roles are template seed data (ADR-0006),
-- indistinguishable afterwards from a role the tenant typed in itself.
--
-- `is_owner` is the ONE flag the platform reads, and it is a capability
-- statement, not a name: the role that holds the whole catalogue by
-- construction, so a tenant always has an escalation path that is visible
-- and audited rather than a back door we keep (02 §2.4).
-- ============================================================================
create table app.role (
  tenant_id   uuid        not null references platform.tenant (id),
  id          uuid        not null,
  write_id    uuid        not null,
  hlc         app.hlc     not null,
  created_at  timestamptz not null default transaction_timestamp(),
  updated_at  timestamptz not null default transaction_timestamp(),
  deleted_at  timestamptz,
  name        text        not null,
  description text        not null default '',
  is_owner    boolean     not null default false,
  origin_template_id text,
  origin_ref         text,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
create unique index role_name_uq on app.role (tenant_id, name) where deleted_at is null;
create unique index role_origin_uq on app.role (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
-- Exactly one owner role per tenant — structural, not procedural.
create unique index role_owner_uq on app.role (tenant_id) where is_owner and deleted_at is null;
select app.apply_tenant_rls('app.role');

comment on column app.role.name is
  'The TENANT''s word for one of the TENANT''s jobs. No platform code reads it, ever (CLAUDE.md §2.9).';

-- The owner role is the visible escalation path, so it cannot be quietly
-- removed. Deleting it would leave a tenant with no way back into its own
-- system (02 §2.4).
create function app.forbid_owner_role_removal() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.is_owner then
      raise exception 'app.role %: the owner role cannot be deleted', old.id;
    end if;
    return old;
  end if;
  if old.is_owner and new.deleted_at is not null then
    raise exception 'app.role %: the owner role cannot be soft-deleted', old.id;
  end if;
  return new;
end
$$;

create trigger role_owner_protected
  before update or delete on app.role
  for each row execute function app.forbid_owner_role_removal();


-- ============================================================================
-- 4. app.role_permission — the composition. This IS the access-control
-- decision, expressed as rows a tenant administrator can add and remove.
--
-- Additive only. There are NO deny rules: evaluation is a union of grants,
-- so it is order-independent and "why can this person not do X?" is a SELECT
-- rather than a debugging session. A permission a role should not have is
-- simply ABSENT — which is exactly how the two hard prohibitions land.
-- ============================================================================
create table app.role_permission (
  tenant_id       uuid        not null references platform.tenant (id),
  id              uuid        not null,
  write_id        uuid        not null,
  hlc             app.hlc     not null,
  created_at      timestamptz not null default transaction_timestamp(),
  updated_at      timestamptz not null default transaction_timestamp(),
  deleted_at      timestamptz,
  role_id         uuid        not null,
  permission_code text        not null references platform.permission (code),
  -- Validated against platform.permission.bound_schema by the application.
  -- Money inside is a DECIMAL STRING (ADR-0004); rates are integer bp.
  bound           jsonb,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, role_id) references app.role (tenant_id, id)
    deferrable initially immediate
);
create unique index role_permission_uq
  on app.role_permission (tenant_id, role_id, permission_code) where deleted_at is null;
create index role_permission_role_ix on app.role_permission (tenant_id, role_id);
select app.apply_tenant_rls('app.role_permission');


-- ============================================================================
-- 5. app.user_account — the login identity the token's `uid` claim names.
--
-- Separate from app.staff: staff is the HR record (who works here), a user
-- account is a credential holder (who signs in). Most people are both; a
-- bureau integration user is only the second, and a yard hand paid weekly is
-- only the first. Linked, not merged.
-- ============================================================================
create table app.user_account (
  tenant_id    uuid        not null references platform.tenant (id),
  id           uuid        not null,          -- the token's `uid`
  write_id     uuid        not null,
  hlc          app.hlc     not null,
  created_at   timestamptz not null default transaction_timestamp(),
  updated_at   timestamptz not null default transaction_timestamp(),
  deleted_at   timestamptz,
  username     text        not null,          -- tenant-unique login handle
  display_name text        not null,
  staff_id     uuid,                          -- optional link to the HR record
  status       text        not null default 'ACTIVE'
               check (status in ('ACTIVE','SUSPENDED','DISABLED')),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, staff_id) references app.staff (tenant_id, id)
    deferrable initially immediate
);
create unique index user_account_username_uq on app.user_account (tenant_id, username)
  where deleted_at is null;
create index user_account_staff_ix on app.user_account (tenant_id, staff_id);
select app.apply_tenant_rls('app.user_account');

comment on table app.user_account is
  'Login identity for the token uid claim. No password material, no PIN, no key: those belong to the auth service and the device (02 §2.7).';


-- ============================================================================
-- 6. app.user_role_assignment — a user holds a ROLE at a SCOPE NODE.
--
-- Effective-dated, because "who could have done this on 14 March?" must be
-- answerable from data rather than reconstructed from memory: revoking a role
-- next month must not erase why an act was permitted last month (02 §2.6,
-- audit_event.grant_id points at a row in this table).
--
-- A user may hold SEVERAL roles at SEVERAL scopes. Resolution is the union of
-- grants PER LOCATION — a permission granted at one location does not leak to
-- another, which is the whole reason scope is a column here and not a claim
-- in the token.
-- ============================================================================
create table app.user_role_assignment (
  tenant_id         uuid        not null references platform.tenant (id),
  id                uuid        not null,     -- audit_event.grant_id
  write_id          uuid        not null,
  hlc               app.hlc     not null,
  created_at        timestamptz not null default transaction_timestamp(),
  updated_at        timestamptz not null default transaction_timestamp(),
  deleted_at        timestamptz,
  user_id           uuid        not null,
  role_id           uuid        not null,
  scope_location_id uuid        not null,     -- ANY node in the tree, at any depth
  effective_from    timestamptz not null default transaction_timestamp(),
  effective_to      timestamptz,              -- NULL = open
  primary key (tenant_id, id),
  constraint ura_effective_order check (effective_to is null or effective_to > effective_from),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, user_id) references app.user_account (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, role_id) references app.role (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, scope_location_id) references app.location (tenant_id, id)
    deferrable initially immediate
);
create unique index user_role_assignment_uq
  on app.user_role_assignment (tenant_id, user_id, role_id, scope_location_id, effective_from)
  where deleted_at is null;
create index user_role_assignment_user_ix
  on app.user_role_assignment (tenant_id, user_id, scope_location_id);
create index user_role_assignment_role_ix
  on app.user_role_assignment (tenant_id, role_id);
select app.apply_tenant_rls('app.user_role_assignment');


-- ============================================================================
-- 7. RESOLUTION.
--
-- app.effective_permission is the answer to "what may this user do, WHERE?".
-- One row per (user, permission code, location) — a permission is never a
-- bare capability, it is always a capability AT A PLACE.
--
-- security_invoker = true so RLS is evaluated as the CALLER, not the view
-- owner: a view is otherwise a documented way to launder a tenant boundary.
--
-- Two arms:
--   (a) permissions composed onto the role, expanded over the scope subtree;
--   (b) the owner role, which holds the WHOLE catalogue by construction, so a
--       capability added by a later platform migration is held immediately
--       and does not need a backfill into every tenant.
-- ============================================================================
create view app.effective_permission with (security_invoker = true) as
select ura.tenant_id,
       ura.user_id,
       rp.permission_code,
       lc.descendant_id       as location_id,
       ura.scope_location_id,
       lc.depth               as scope_depth,
       ura.id                 as grant_id,
       ura.role_id,
       rp.bound,
       false                  as via_owner_role
  from app.user_role_assignment ura
  join app.user_account ua
    on ua.tenant_id = ura.tenant_id and ua.id = ura.user_id
   and ua.deleted_at is null and ua.status = 'ACTIVE'
  join app.role r
    on r.tenant_id = ura.tenant_id and r.id = ura.role_id and r.deleted_at is null
  join app.role_permission rp
    on rp.tenant_id = ura.tenant_id and rp.role_id = ura.role_id and rp.deleted_at is null
  join app.location_closure lc
    on lc.tenant_id = ura.tenant_id and lc.ancestor_id = ura.scope_location_id
 where ura.deleted_at is null
   and ura.effective_from <= transaction_timestamp()
   and (ura.effective_to is null or ura.effective_to > transaction_timestamp())
union all
select ura.tenant_id,
       ura.user_id,
       p.code,
       lc.descendant_id,
       ura.scope_location_id,
       lc.depth,
       ura.id,
       ura.role_id,
       null::jsonb,
       true
  from app.user_role_assignment ura
  join app.user_account ua
    on ua.tenant_id = ura.tenant_id and ua.id = ura.user_id
   and ua.deleted_at is null and ua.status = 'ACTIVE'
  join app.role r
    on r.tenant_id = ura.tenant_id and r.id = ura.role_id and r.deleted_at is null
   and r.is_owner
  join app.location_closure lc
    on lc.tenant_id = ura.tenant_id and lc.ancestor_id = ura.scope_location_id
  cross join platform.permission p
 where ura.deleted_at is null
   and ura.effective_from <= transaction_timestamp()
   and (ura.effective_to is null or ura.effective_to > transaction_timestamp());

comment on view app.effective_permission is
  'One row per (user, permission code, location). A permission is a capability AT A PLACE — never a bare capability (02 §2.5).';

-- The flattened "which locations does this user touch at all" answer. This is
-- the SYNC boundary's question, and it is strictly narrower than "what may
-- this user read": the right to see something is not the right to have it on
-- a tablet that can be stolen (02 §2.5).
create view app.user_location_scope with (security_invoker = true) as
select distinct
       ura.tenant_id,
       ura.user_id,
       lc.descendant_id as location_id
  from app.user_role_assignment ura
  join app.user_account ua
    on ua.tenant_id = ura.tenant_id and ua.id = ura.user_id
   and ua.deleted_at is null and ua.status = 'ACTIVE'
  join app.location_closure lc
    on lc.tenant_id = ura.tenant_id and lc.ancestor_id = ura.scope_location_id
 where ura.deleted_at is null
   and ura.effective_from <= transaction_timestamp()
   and (ura.effective_to is null or ura.effective_to > transaction_timestamp());
