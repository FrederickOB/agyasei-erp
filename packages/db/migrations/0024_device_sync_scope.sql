-- ============================================================================
-- 0024_device_sync_scope.sql — the sync rules stop trusting a claim.
--
-- (02-security §2.3 Contract 1, §2.5 the device ceiling, §2.7 revocation
--  mechanism 1; docs/phase2-gate.md §5.2 D7; docs/phase1-status.md §6 item 4.)
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- `location_ops` keyed its bucket on the token's `location_id` claim, and
-- `tenant_reference`, `tenant_customers`, `tenant_sale_lines_interim` and
-- `jurisdiction_pack` on `tid` alone. So:
--
--   · a claim minted at 09:00 kept a device syncing an outlet after its user's
--     assignment ended at 09:05, for the life of the token and every token
--     after it — CLAUDE.md §2.6 says sync rules ARE the authorization
--     boundary, and this one was enforcing a claim rather than the database;
--   · NOTHING in any parameter query knew what a device was. A revoked
--     tablet's stream ran until its token expired, and kept being re-issued
--     tokens by any path that did not check — revocation mechanism 1 of §2.7,
--     "the mechanism that actually works", did not exist;
--   · the device ceiling of §2.5 (user scope ∩ device scope) was prose.
--
-- ---------------------------------------------------------------------------
-- THE SHAPE OF THE FIX — 0013's, copied, because it is the only one that works
-- ---------------------------------------------------------------------------
-- §2.3 writes Contract 1 as a JOIN in the parameter query. PowerSync parameter
-- queries read ONE table — no joins, no aliases (phase1-status §6 item 4
-- records the service refusing an alias outright) — and logical replication
-- cannot publish a view. So the join is done HERE, server-side, into two
-- narrow trigger-maintained projections, and each parameter query is a
-- single-table equality lookup on (tid, did, sub):
--
--   app.device_sync_grant           (tenant, device, user)  — one row per pair
--       that may sync AT ALL: device ACTIVE, user ACTIVE with a live assignment,
--       and a NON-EMPTY intersection of the two scopes. Carries the
--       jurisdiction code (for jurisdiction_pack) and whether the pair may hold
--       the credit BOOK (0013's credit_sync_book_scope, intersected).
--   app.device_sync_location_scope  (tenant, device, user, location) — the
--       intersection itself, one row per syncable location, plus whether that
--       location's credit ALLOWANCE may come down (0013's
--       credit_sync_location_scope, intersected).
--
-- Every bucket's parameter query reads one of these two tables and filters on
-- the token's `did` AND `sub` AND `tid`. A retired or suspended device has NO
-- rows, so every parameter query returns zero rows, so there are no buckets,
-- so the stream carries nothing — without the sync service knowing what
-- revocation is (§2.7 mechanism 1). The same is true of a disabled user, an
-- ended assignment, and a device whose scope was narrowed away.
--
-- "Syncable" locations are OUTLET, WAREHOUSE and TRANSIT (§2.5's table): a
-- GROUP node holds no stock and takes no sales. Both scopes expand down the
-- closure, so a device at Techiman is also at Techiman's TRANSIT node.
--
-- A device with an EMPTY ceiling — the back-office laptop of §2.5 — has no
-- grant row at all and syncs nothing, not even the catalogue. That is §2.5's
-- stated behaviour, and the reason a laptop works online.
--
-- ---------------------------------------------------------------------------
-- EFFECTIVE DATING — the one residual, and the plain function that closes it
-- ---------------------------------------------------------------------------
-- Statement triggers on every table either projection reads recompute the
-- affected tenant immediately, so revocation by DML (retire a device, disable
-- a user, end an assignment NOW) empties the device on its next checkpoint. An
-- assignment whose effective_to was set to a FUTURE instant lapses with no DML;
-- `app.refresh_sync_scope_all()` sweeps it, together with 0013's credit
-- projections, for every tenant. §2.5 puts that reconciler on a 60-second beat;
-- scheduling it is the production package's job and this file only provides
-- the function.
-- ============================================================================

create table app.device_sync_grant (
  tenant_id         uuid        not null references platform.tenant (id),
  id                uuid        not null default gen_random_uuid(),
  device_id         uuid        not null,
  user_id           uuid        not null,
  jurisdiction_code text        not null,
  -- 'book' when the user is in credit_sync_book_scope; 'none' otherwise. TEXT,
  -- not boolean: a sync-rule parameter query compares it to a string literal,
  -- and PowerSync carries Postgres booleans as integers.
  credit_book       text        not null default 'none' check (credit_book in ('book', 'none')),
  refreshed_at      timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id)
);
create unique index device_sync_grant_uq
  on app.device_sync_grant (tenant_id, device_id, user_id);
select app.apply_tenant_rls('app.device_sync_grant');

comment on table app.device_sync_grant is
  'Projection: (device, user) pairs that may sync at all — active device, active user, non-empty user∩device scope. Every tenant-keyed sync bucket''s parameter query reads THIS (02 §2.3 Contract 1).';

create table app.device_sync_location_scope (
  tenant_id        uuid        not null references platform.tenant (id),
  id               uuid        not null default gen_random_uuid(),
  device_id        uuid        not null,
  user_id          uuid        not null,
  location_id      uuid        not null,
  -- 'allowance' when (user, location) is in credit_sync_location_scope.
  credit_allowance text        not null default 'none' check (credit_allowance in ('allowance', 'none')),
  refreshed_at     timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate
);
create unique index device_sync_location_scope_uq
  on app.device_sync_location_scope (tenant_id, device_id, user_id, location_id);
select app.apply_tenant_rls('app.device_sync_location_scope');

comment on table app.device_sync_location_scope is
  'Projection: user_location_scope ∩ device_location_scope (closure-expanded, syncable kinds only), over ACTIVE devices. Every location-keyed sync bucket''s parameter query reads THIS (02 §2.5).';

-- ----------------------------------------------------------------------------
-- The one derivation. Additive then subtractive, ids stable across runs, so
-- PowerSync sees no churn where nothing changed (0013's discipline).
-- ----------------------------------------------------------------------------
create function app.refresh_device_sync_scope(p_tenant uuid) returns void
language plpgsql as $$
begin
  -- ---- the location intersection ------------------------------------------
  with dev_scope as (
    select distinct dls.tenant_id, dls.device_id, lc.descendant_id as location_id
      from app.device_location_scope dls
      join app.device d
        on d.tenant_id = dls.tenant_id and d.id = dls.device_id
       and d.status = 'active' and d.deleted_at is null
      join app.location_closure lc
        on lc.tenant_id = dls.tenant_id and lc.ancestor_id = dls.location_id
      join app.location l
        on l.tenant_id = lc.tenant_id and l.id = lc.descendant_id
       and l.deleted_at is null and l.kind in ('OUTLET', 'WAREHOUSE', 'TRANSIT')
     where dls.tenant_id = p_tenant and dls.deleted_at is null
  ), want as (
    select ds.tenant_id, ds.device_id, uls.user_id, ds.location_id,
           case when exists (
                  select 1 from app.credit_sync_location_scope cls
                   where cls.tenant_id = ds.tenant_id and cls.user_id = uls.user_id
                     and cls.location_id = ds.location_id)
                then 'allowance' else 'none' end as credit_allowance
      from dev_scope ds
      join app.user_location_scope uls
        on uls.tenant_id = ds.tenant_id and uls.location_id = ds.location_id
  )
  insert into app.device_sync_location_scope
    (tenant_id, device_id, user_id, location_id, credit_allowance)
  select tenant_id, device_id, user_id, location_id, credit_allowance from want
  on conflict (tenant_id, device_id, user_id, location_id)
  do update set credit_allowance = excluded.credit_allowance,
                refreshed_at     = transaction_timestamp()
   where app.device_sync_location_scope.credit_allowance is distinct from excluded.credit_allowance;

  delete from app.device_sync_location_scope s
   where s.tenant_id = p_tenant
     and not exists (
       select 1
         from app.device_location_scope dls
         join app.device d
           on d.tenant_id = dls.tenant_id and d.id = dls.device_id
          and d.status = 'active' and d.deleted_at is null
         join app.location_closure lc
           on lc.tenant_id = dls.tenant_id and lc.ancestor_id = dls.location_id
         join app.location l
           on l.tenant_id = lc.tenant_id and l.id = lc.descendant_id
          and l.deleted_at is null and l.kind in ('OUTLET', 'WAREHOUSE', 'TRANSIT')
         join app.user_location_scope uls
           on uls.tenant_id = dls.tenant_id and uls.location_id = lc.descendant_id
        where dls.tenant_id = s.tenant_id
          and dls.deleted_at is null
          and dls.device_id = s.device_id
          and uls.user_id = s.user_id
          and lc.descendant_id = s.location_id);

  -- ---- the pair grant, derived from the intersection ------------------------
  insert into app.device_sync_grant (tenant_id, device_id, user_id, jurisdiction_code, credit_book)
  select distinct s.tenant_id, s.device_id, s.user_id, t.jurisdiction_code,
         case when exists (
                select 1 from app.credit_sync_book_scope b
                 where b.tenant_id = s.tenant_id and b.user_id = s.user_id)
              then 'book' else 'none' end
    from app.device_sync_location_scope s
    join platform.tenant t on t.id = s.tenant_id
   where s.tenant_id = p_tenant
  on conflict (tenant_id, device_id, user_id)
  do update set credit_book       = excluded.credit_book,
                jurisdiction_code = excluded.jurisdiction_code,
                refreshed_at      = transaction_timestamp()
   where app.device_sync_grant.credit_book is distinct from excluded.credit_book
      or app.device_sync_grant.jurisdiction_code is distinct from excluded.jurisdiction_code;

  delete from app.device_sync_grant g
   where g.tenant_id = p_tenant
     and not exists (
       select 1 from app.device_sync_location_scope s
        where s.tenant_id = g.tenant_id and s.device_id = g.device_id and s.user_id = g.user_id);
end
$$;

comment on function app.refresh_device_sync_scope(uuid) is
  'Recompute both device sync projections for one tenant. Idempotent; ids stable across runs. Reads 0013''s credit projections, and is re-run whenever they change.';

-- ----------------------------------------------------------------------------
-- THE SWEEP — a plain function, scheduled by the production package (§2.5's
-- 60-second reconciler). Sets the tenant GUC itself for each tenant, so it is
-- correct whether it runs as the owner or as app_user under forced RLS — the
-- earlier `refresh_credit_sync_scope_all()` silently did nothing as app_user,
-- because with no GUC every row it needed was invisible to it.
-- Credit first, then devices: the device projection reads the credit one.
-- ----------------------------------------------------------------------------
create function app.refresh_sync_scope_all() returns integer
language plpgsql as $$
declare
  t uuid;
  n integer := 0;
  prior text := current_setting('app.tenant_id', true);
begin
  for t in select id from platform.tenant order by id loop
    perform set_config('app.tenant_id', t::text, true);
    perform app.refresh_credit_sync_scope(t);
    perform app.refresh_device_sync_scope(t);
    n := n + 1;
  end loop;
  perform set_config('app.tenant_id', coalesce(prior, ''), true);
  return n;
end
$$;

comment on function app.refresh_sync_scope_all() is
  'The reconciler: refresh 0013''s credit projections and the device projections for every tenant. Closes the effective-dating hole (a future-dated effective_to lapses with no DML). Schedule it — 02 §2.5 says every 60 s.';

-- ----------------------------------------------------------------------------
-- Triggers. Statement-level with transition tables (0005's closure pattern):
-- one recompute per tenant per statement, not per row.
-- ----------------------------------------------------------------------------
create function app.device_sync_scope_touch() returns trigger
language plpgsql as $$
declare
  t uuid;
begin
  if tg_op = 'INSERT' then
    for t in select distinct tenant_id from new_rows loop
      perform app.refresh_device_sync_scope(t);
    end loop;
  elsif tg_op = 'UPDATE' and tg_table_name = 'device' then
    -- app.device is also touched for bookkeeping (last_authenticated_at,
    -- drain_opened_at). Only a change that can alter what the device may hold
    -- — its status — is worth a recompute.
    for t in select distinct n.tenant_id
               from new_rows n
               join old_rows o on o.tenant_id = n.tenant_id and o.id = n.id
              where n.status is distinct from o.status loop
      perform app.refresh_device_sync_scope(t);
    end loop;
  elsif tg_op = 'UPDATE' then
    for t in select distinct tenant_id from new_rows
             union select distinct tenant_id from old_rows loop
      perform app.refresh_device_sync_scope(t);
    end loop;
  else
    for t in select distinct tenant_id from old_rows loop
      perform app.refresh_device_sync_scope(t);
    end loop;
  end if;
  return null;
end
$$;

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'device', 'device_location_scope', 'user_role_assignment', 'user_account',
    'role', 'role_permission', 'location_closure',
    -- 0013's projections: when THEY change (a credit.view grant revoked), the
    -- device projection's credit columns must follow, whichever trigger ran first.
    'credit_sync_book_scope', 'credit_sync_location_scope'
  ] loop
    execute format(
      'create trigger device_sync_scope_ins after insert on app.%I '
      'referencing new table as new_rows for each statement '
      'execute function app.device_sync_scope_touch()', tbl);
    execute format(
      'create trigger device_sync_scope_upd after update on app.%I '
      'referencing new table as new_rows old table as old_rows for each statement '
      'execute function app.device_sync_scope_touch()', tbl);
    execute format(
      'create trigger device_sync_scope_del after delete on app.%I '
      'referencing old table as old_rows for each statement '
      'execute function app.device_sync_scope_touch()', tbl);
  end loop;
end
$$;
