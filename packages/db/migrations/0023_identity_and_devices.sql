-- ============================================================================
-- 0023_identity_and_devices.sql — who signs in, on what, and how it stops.
--
-- (02-security-and-access-control §2.2 identity, §2.5 the device ceiling,
--  §2.6 audit, §2.7 enrolment / revocation / the offline session;
--  ADR-0003 amendment A1 (device targets) and A4 (managed OIDC sign-in).)
--
-- Hand-written SQL is THE schema. src/schema.ts MIRRORS it.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION ADDS
-- ---------------------------------------------------------------------------
--   platform.permission.offline_mode   the ONE machine-readable source of which
--                                      capabilities survive the offline lease's
--                                      restricted horizon (§2.4, §2.7)
--   two admin capabilities             admin.device.scope.manage,
--                                      admin.assignment.manage (§2.4 rule 4)
--   app.user_account.subject_*         the pointer into the identity provider.
--                                      No password material here, ever (§2.2)
--   app.device                         the ONE device registry (§2.7, §9.10)
--   app.device_location_scope          the device CEILING — a real term in the
--                                      sync parameter query, not a column with
--                                      a promise attached (§2.5)
--   app.device_enrolment_code          one-time, 15-minute, hashed (§2.7)
--   app.device_session                 per USER per DEVICE (`sid`, §2.2) with a
--                                      rotating refresh credential
--   app.identity_event                 append-only audit of every act above
--   platform.enrolment_code_route      } the two lookups that must happen
--   platform.device_key_route          } BEFORE a tenant context exists
--
-- ---------------------------------------------------------------------------
-- THE TWO PLATFORM TABLES, AND WHY THEY ARE NOT IN `app`
-- ---------------------------------------------------------------------------
-- Every other identity question is asked INSIDE a tenant's RLS context, with
-- the tenant taken from a token we signed. Two cannot be:
--
--   1. A device redeeming an enrolment code has no token at all. The CODE is
--      its credential, so the tenant must be derived from the code.
--   2. A device presenting its key (a DPoP proof) to sign a user in or to
--      refresh has no tenant-bearing token yet. The KEY is its credential, so
--      the tenant must be derived from the key.
--
-- In both cases the tenant comes from a credential the server can check — never
-- from a field the client typed — which is the §2.1 rule restated for the two
-- moments before a token exists. An `app` table cannot answer either question:
-- RLS is forced and the canonical policy needs a tenant to compare against.
-- A SECURITY DEFINER lookup over an `app` table would have to run as a
-- BYPASSRLS owner, and Supabase's migration role is not guaranteed to be one.
--
-- So each lookup is a NARROW platform route: a hash or a key thumbprint →
-- (tenant_id, row id). No business data, no names, nothing a tenant owns.
-- `app_user` has NO direct privilege on either table (default privileges
-- granted it SELECT on platform; revoked below) and reaches them only through
-- four SECURITY DEFINER functions that answer exactly one key at a time. The
-- two that WRITE a route take the tenant from `app.current_tenant()` — the GUC
-- the runner set from the verified token — and never from a parameter.
--
-- Like every migration touching `platform`, this one is human-reviewed (0001).
-- ============================================================================


-- ============================================================================
-- 1. platform.permission.offline_mode (§2.4)
--
-- Three values, one meaning each:
--   never               needs a live server. Unavailable the moment the link drops.
--   until_lease_expiry  works offline from 0 → full_until; stops in restricted mode.
--   always              works for the lease's whole life, restricted mode included.
--
-- DEFAULT 'never' — fail closed. A capability a later migration adds without
-- deciding its offline behaviour is excluded from restricted mode until
-- somebody decides otherwise, rather than silently surviving it.
-- ============================================================================
alter table platform.permission
  add column offline_mode text not null default 'never'
  constraint permission_offline_mode_vocab
  check (offline_mode in ('never', 'until_lease_expiry', 'always'));

comment on column platform.permission.offline_mode is
  'never | until_lease_expiry | always — the single machine-readable source of what survives the offline lease''s restricted horizon (02 §2.4, §2.7).';

-- `always`: the outlet keeps taking money and answering "do we have it?" —
-- cash sales at the resolved list price, stock and price lookups, reprints.
update platform.permission
   set offline_mode = 'always'
 where code in ('sale.record', 'sale.view', 'sale.receipt.reprint',
                'stock.view', 'catalogue.view', 'customer.view');

-- `until_lease_expiry`: every write that rides the offline outbox and takes a
-- RISK — credit, adjustments, transfers, receipts, deliveries. They stop at
-- full_until: "the outlet keeps taking money; it stops taking risk" (§2.7).
update platform.permission
   set offline_mode = 'until_lease_expiry'
 where code in ('sale.record.credit', 'sale.discount.apply', 'sale.void',
                'stock.adjust', 'stock.transfer', 'stock.transfer.receive',
                'stock.receive', 'stock.count.perform',
                'customer.manage', 'credit.entry.record',
                'goods.receive', 'logistics.delivery.view', 'logistics.dispatch.manage');

-- Everything flagged requires_fresh_authorization stays `never` (the default
-- above): a price override and a credit-limit change are re-checked against a
-- live server, which is what that flag always meant. Asserted, not assumed:
do $$
begin
  if exists (select 1 from platform.permission
              where requires_fresh_authorization and offline_mode <> 'never') then
    raise exception 'a requires_fresh_authorization capability was given an offline mode';
  end if;
end
$$;

-- The two capabilities §2.4 names that the 0005 catalogue lacked.
insert into platform.permission
  (code, domain, description, is_sensitive, requires_fresh_authorization, bound_schema, offline_mode)
values
  ('admin.device.scope.manage', 'admin',
   'Widen, narrow or move a device''s location scope — which locations it may hold on its disk.',
   true, false, null, 'never'),
  ('admin.assignment.manage', 'admin',
   'Assign a role to a user at a scope node, or end an assignment. Never wider than the granter holds.',
   true, false, null, 'never')
on conflict (code) do nothing;


-- ============================================================================
-- 2. app.user_account — the pointer into the identity provider (§2.2, §4.11)
--
-- (subject_issuer, subject_ref) is the IdP's `iss` and `sub`. A `sub` is only
-- unique WITHIN an issuer, so both are stored; neither is ever a tenant claim.
-- The tenant a user belongs to is THIS ROW's tenant_id — never anything in the
-- id_token, where an IdP administrator could edit it.
--
-- Nullable: a user created before their IdP account exists (or a dev
-- principal) simply cannot sign in through the IdP. NOT a default-open path —
-- no subject, no login.
-- ============================================================================
alter table app.user_account
  add column subject_issuer text,
  add column subject_ref    text;

alter table app.user_account
  add constraint user_account_subject_pairs
  check ((subject_issuer is null) = (subject_ref is null));

create unique index user_account_subject_uq
  on app.user_account (tenant_id, subject_issuer, subject_ref)
  where subject_ref is not null and deleted_at is null;

comment on column app.user_account.subject_ref is
  'The identity provider''s `sub` for this user, under subject_issuer. An opaque pointer — no password, TOTP seed or recovery code ever lives in this schema (02 §2.2).';


-- ============================================================================
-- 3. app.device — THE device registry (§2.7)
--
-- One status vocabulary, shared with §3.11.4: active | suspended | retired.
-- `retired` is terminal and carries a reason; `stolen` closes the drain window
-- to zero (§2.7 "drain before wipe").
--
-- form_factor follows ADR-0003 A1 — tablet primary, laptop and phone
-- secondary. §2.7's 'browser' value is what A1 calls a laptop: "a laptop is
-- enrolled like any other device". It is DESCRIPTIVE ONLY — nothing on the
-- platform authorises on it; what a device may hold is device_location_scope.
--
-- public_jwk is the WebCrypto export of the device's P-256 public key; the
-- private half is non-extractable and never leaves the device. jkt is its
-- RFC 7638 thumbprint, bound into every access token as cnf.jkt.
-- ============================================================================
create table app.device (
  tenant_id             uuid        not null references platform.tenant (id),
  id                    uuid        not null,
  write_id              uuid        not null,
  hlc                   app.hlc     not null,
  created_at            timestamptz not null default transaction_timestamp(),
  updated_at            timestamptz not null default transaction_timestamp(),
  deleted_at            timestamptz,
  label                 text        not null check (length(label) between 1 and 80),
  form_factor           text        not null check (form_factor in ('tablet', 'phone', 'laptop')),
  public_jwk            jsonb       not null,
  jkt                   text        not null check (jkt ~ '^[A-Za-z0-9_-]{43}$'),
  status                text        not null default 'active'
                        check (status in ('active', 'suspended', 'retired')),
  retired_reason        text
                        check (retired_reason in ('lost', 'stolen', 'damaged', 'decommissioned', 'replaced')),
  retired_by            uuid,
  retired_at            timestamptz,
  -- First contact after retirement: the 423 that starts the device's drain
  -- clock. NULL until the device is heard from (§2.7 step 5).
  drain_opened_at       timestamptz,
  enrolled_by           uuid        not null,
  enrolled_at           timestamptz not null default transaction_timestamp(),
  enrolment_code_id     uuid,
  last_authenticated_at timestamptz,
  last_seen_at          timestamptz,
  app_version           text,
  primary key (tenant_id, id),
  constraint device_retirement_shape check (
    (status = 'retired') = (retired_at is not null)
    and (status = 'retired') = (retired_reason is not null)
    and (status = 'retired') = (retired_by is not null)),
  constraint device_never_deleted check (deleted_at is null),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, enrolled_by) references app.user_account (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, retired_by) references app.user_account (tenant_id, id)
    deferrable initially immediate
);
create unique index device_jkt_uq on app.device (tenant_id, jkt);
create index device_status_ix on app.device (tenant_id, status);
select app.apply_tenant_rls('app.device');

comment on table app.device is
  'The one device registry (02 §2.7). A device is identified by its key: jkt is bound into every token as cnf.jkt. Retired is terminal.';

-- A device's key is its identity, and retirement is final. Re-enrolling a
-- found tablet is a NEW device with a new key, never a resurrection — the
-- old row is what the audit trail and the period-close exclusion point at.
create function app.device_guard() returns trigger
language plpgsql as $$
begin
  if new.jkt is distinct from old.jkt or new.public_jwk is distinct from old.public_jwk then
    raise exception 'app.device %: a device''s key is its identity and cannot be changed — enrol a new device', old.id;
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'app.device %: retirement is terminal — enrol the device again as a new device', old.id;
  end if;
  if old.status = 'retired' and (new.retired_reason is distinct from old.retired_reason
                                 or new.retired_at is distinct from old.retired_at
                                 or new.retired_by is distinct from old.retired_by) then
    raise exception 'app.device %: the retirement record is immutable', old.id;
  end if;
  return new;
end
$$;

create trigger device_guard
  before update on app.device
  for each row execute function app.device_guard();

revoke delete on app.device from app_user;


-- ============================================================================
-- 4. app.device_location_scope — THE DEVICE CEILING (§2.5)
--
-- "The right to see something is not the right to have it on your device."
-- The effective sync scope is user_location_scope ∩ (this, expanded down the
-- closure). Seeded with ONE row from the enrolment code's location; never
-- widened by any permission grant; widening is admin.device.scope.manage and
-- audited. A device with NO rows — a back-office laptop — syncs nothing.
--
-- A row may name a GROUP node (a regional manager's own tablet); it expands
-- through app.location_closure exactly as an assignment's scope node does.
-- ============================================================================
create table app.device_location_scope (
  tenant_id   uuid        not null references platform.tenant (id),
  id          uuid        not null,
  write_id    uuid        not null,
  hlc         app.hlc     not null,
  created_at  timestamptz not null default transaction_timestamp(),
  updated_at  timestamptz not null default transaction_timestamp(),
  deleted_at  timestamptz,
  device_id   uuid        not null,
  location_id uuid        not null,
  added_by    uuid        not null,
  removed_by  uuid,
  primary key (tenant_id, id),
  constraint dls_removal_pairs check ((deleted_at is null) = (removed_by is null)),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, device_id) references app.device (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate
);
create unique index device_location_scope_uq
  on app.device_location_scope (tenant_id, device_id, location_id)
  where deleted_at is null;
create index device_location_scope_location_ix
  on app.device_location_scope (tenant_id, location_id);
select app.apply_tenant_rls('app.device_location_scope');
revoke delete on app.device_location_scope from app_user;

comment on table app.device_location_scope is
  'The device ceiling (02 §2.5). Effective sync scope = user_location_scope ∩ this (closure-expanded). Removal is a soft delete with removed_by — never a DELETE.';


-- ============================================================================
-- 5. app.device_enrolment_code (§2.7)
--
-- 8 Crockford base32 characters (40 bits, CSPRNG), single use, 15-minute TTL,
-- bound to the tenant and (optionally) a location. The CODE IS NEVER STORED —
-- only its SHA-256, here and in the platform route.
--
-- `location_id` NULL is deliberate and visible: a code that enrols a device
-- with an EMPTY device scope — the head-office laptop of §2.5 that "syncs
-- nothing at all" and works online.
--
-- consumed_at is set on the FIRST redemption attempt that names this code,
-- whether or not the enrolment then succeeds (§2.7).
-- ============================================================================
create table app.device_enrolment_code (
  tenant_id   uuid        not null references platform.tenant (id),
  id          uuid        not null,
  write_id    uuid        not null,
  hlc         app.hlc     not null,
  created_at  timestamptz not null default transaction_timestamp(),
  updated_at  timestamptz not null default transaction_timestamp(),
  deleted_at  timestamptz,
  code_hash   bytea       not null check (length(code_hash) = 32),
  location_id uuid,
  label       text        not null check (length(label) between 1 and 80),
  form_factor text        not null check (form_factor in ('tablet', 'phone', 'laptop')),
  issued_by   uuid        not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  outcome     text        check (outcome in ('enrolled', 'refused', 'cancelled')),
  device_id   uuid,
  primary key (tenant_id, id),
  constraint enrolment_code_ttl check (expires_at <= created_at + interval '15 minutes'),
  constraint enrolment_code_outcome_pairs check ((consumed_at is null) = (outcome is null)),
  constraint enrolment_code_device_pairs check ((outcome = 'enrolled') = (device_id is not null)),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, issued_by) references app.user_account (tenant_id, id)
    deferrable initially immediate
);
create unique index device_enrolment_code_hash_uq
  on app.device_enrolment_code (tenant_id, code_hash);
create index device_enrolment_code_issued_ix
  on app.device_enrolment_code (tenant_id, created_at);
select app.apply_tenant_rls('app.device_enrolment_code');
revoke delete on app.device_enrolment_code from app_user;


-- ============================================================================
-- 6. app.device_session — per USER per DEVICE (§2.2: `sid`, never equal to did)
--
-- A shared counter tablet has one device and several sessions. The refresh
-- credential is device-key-bound (every refresh carries a DPoP proof from the
-- enrolled key) and ROTATES on every use: the previous secret's hash is kept
-- so presenting it again is detected as REUSE, which revokes the session —
-- the standard defence against a copied refresh credential.
--
-- WRITE_ID_EXEMPT (src/tenant-table.ts), for the same reason as the GL: this
-- is server-authored security state, rotated every ~15 minutes per signed-in
-- clerk, in no sync rule, written by no device. A write_log row per refresh
-- would be a write spine for something that is not a unit of business work.
-- ============================================================================
create table app.device_session (
  tenant_id          uuid        not null references platform.tenant (id),
  id                 uuid        not null,   -- the token's `sid`
  created_at         timestamptz not null default transaction_timestamp(),
  updated_at         timestamptz not null default transaction_timestamp(),
  device_id          uuid        not null,
  user_id            uuid        not null,
  refresh_hash       bytea       not null check (length(refresh_hash) = 32),
  refresh_prev_hash  bytea       check (length(refresh_prev_hash) = 32),
  refresh_count      integer     not null default 0 check (refresh_count >= 0),
  last_refreshed_at  timestamptz,
  expires_at         timestamptz not null,
  revoked_at         timestamptz,
  revoked_reason     text check (revoked_reason in
                       ('signed_out', 'refresh_reuse', 'device_retired', 'user_disabled', 'admin')),
  primary key (tenant_id, id),
  constraint device_session_revocation_pairs check ((revoked_at is null) = (revoked_reason is null)),
  foreign key (tenant_id, device_id) references app.device (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, user_id) references app.user_account (tenant_id, id)
    deferrable initially immediate
);
create index device_session_device_ix on app.device_session (tenant_id, device_id, user_id);
select app.apply_tenant_rls('app.device_session');
revoke delete on app.device_session from app_user;


-- ============================================================================
-- 7. app.identity_event — append-only audit of identity and device acts (§2.6)
--
-- Every enrolment-code issue and redemption (successful or not), enrolment,
-- revocation, scope change, user and assignment change, role change, and
-- refresh-credential reuse writes one row. Shaped as a subset of §2.6's
-- `audit_event` with the same column names, so it folds into that table when
-- it lands rather than being reconciled with it.
--
-- hlc is SERVER-STAMPED (§3.4.1); nothing here is a device clock.
-- ============================================================================
create table app.identity_event (
  tenant_id          uuid        not null references platform.tenant (id),
  id                 uuid        not null,
  write_id           uuid        not null,
  hlc                app.hlc     not null,
  event_class        text        not null check (event_class in ('write', 'denial')),
  actor_kind         text        not null check (actor_kind in ('user', 'device', 'system')),
  actor_user_id      uuid,
  actor_device_id    uuid,
  action             text        not null check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  permission_used    text        references platform.permission (code),
  subject_table      text        not null,
  subject_id         uuid,
  before             jsonb,
  after              jsonb,
  reason_code        text,
  reason_note        text,
  server_received_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
create index identity_event_subject_ix on app.identity_event (tenant_id, subject_table, subject_id, id);
create index identity_event_actor_ix on app.identity_event (tenant_id, actor_user_id, id);
create index identity_event_time_ix on app.identity_event (tenant_id, server_received_at);
select app.apply_tenant_rls('app.identity_event');

revoke update, delete, truncate on app.identity_event from app_user;
create trigger identity_event_append_only
  before update or delete on app.identity_event
  for each row execute function app.forbid_mutation();


-- ============================================================================
-- 8. The two pre-tenant routes (see the header)
-- ============================================================================
create table platform.enrolment_code_route (
  code_hash  bytea       primary key check (length(code_hash) = 32),
  tenant_id  uuid        not null references platform.tenant (id),
  code_id    uuid        not null,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  created_at timestamptz not null default transaction_timestamp()
);

create table platform.device_key_route (
  jkt        text        primary key check (jkt ~ '^[A-Za-z0-9_-]{43}$'),
  tenant_id  uuid        not null references platform.tenant (id),
  device_id  uuid        not null,
  created_at timestamptz not null default transaction_timestamp()
);

-- 0001's default privileges granted app_user SELECT on every platform table.
-- Not these: a route table readable by the application role is an index of
-- every tenant's devices, and a SHA-256 of a 40-bit code is brute-forceable
-- offline. The functions below are the only way in.
revoke all on platform.enrolment_code_route from app_user;
revoke all on platform.device_key_route from app_user;

comment on table platform.enrolment_code_route is
  'Pre-tenant route: SHA-256(enrolment code) → (tenant, code row). No direct app_user privilege; reached only via platform.claim_enrolment_code().';
comment on table platform.device_key_route is
  'Pre-tenant route: device key thumbprint → (tenant, device). No direct app_user privilege; reached only via platform.resolve_device_key().';

-- Publish a route for a code the CURRENT tenant just issued. The tenant is the
-- GUC — the verified token's tid — never a parameter.
create function platform.publish_enrolment_code(p_code_hash bytea, p_code_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, platform, app
as $$
declare
  v_tenant  uuid := app.current_tenant();
  v_expires timestamptz;
begin
  if v_tenant is null then
    raise exception 'publish_enrolment_code: no tenant context';
  end if;
  select c.expires_at into v_expires
    from app.device_enrolment_code c
   where c.tenant_id = v_tenant and c.id = p_code_id and c.code_hash = p_code_hash
     and c.consumed_at is null;
  if v_expires is null then
    raise exception 'publish_enrolment_code: no unconsumed code % in the current tenant', p_code_id;
  end if;
  insert into platform.enrolment_code_route (code_hash, tenant_id, code_id, expires_at)
  values (p_code_hash, v_tenant, p_code_id, v_expires);
end
$$;

-- Claim a code by its hash. Burns the route on the FIRST claim whatever
-- happens next (§2.7: "invalidated on first redemption attempt whether or not
-- it succeeds"), and reports whether this was that first claim, so a retry of
-- the SAME request can be told apart from a second device trying the code.
create function platform.claim_enrolment_code(p_code_hash bytea)
returns table (tenant_id uuid, code_id uuid, expires_at timestamptz, first_claim boolean)
language plpgsql security definer
set search_path = pg_catalog, platform
as $$
begin
  return query
  with prior as (
    select r.code_hash, r.claimed_at as was
      from platform.enrolment_code_route r
     where r.code_hash = p_code_hash
       for update
  ), upd as (
    update platform.enrolment_code_route r
       set claimed_at = coalesce(r.claimed_at, transaction_timestamp())
      from prior
     where r.code_hash = prior.code_hash
    returning r.tenant_id, r.code_id, r.expires_at, prior.was
  )
  select upd.tenant_id, upd.code_id, upd.expires_at, (upd.was is null) from upd;
end
$$;

-- Register the key route for a device the CURRENT tenant just enrolled.
create function platform.register_device_key(p_jkt text, p_device_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, platform, app
as $$
declare
  v_tenant uuid := app.current_tenant();
begin
  if v_tenant is null then
    raise exception 'register_device_key: no tenant context';
  end if;
  if not exists (select 1 from app.device d
                  where d.tenant_id = v_tenant and d.id = p_device_id and d.jkt = p_jkt) then
    raise exception 'register_device_key: device % with that key is not in the current tenant', p_device_id;
  end if;
  insert into platform.device_key_route (jkt, tenant_id, device_id)
  values (p_jkt, v_tenant, p_device_id);
end
$$;

-- Resolve a PROVEN key thumbprint to its tenant and device. The caller has
-- already verified a DPoP proof signed by the key whose thumbprint this is;
-- this function only routes. Status is NOT decided here — the caller reads
-- app.device under the resolved tenant's RLS and decides there.
create function platform.resolve_device_key(p_jkt text)
returns table (tenant_id uuid, device_id uuid)
language sql stable security definer
set search_path = pg_catalog, platform
as $$
  select r.tenant_id, r.device_id from platform.device_key_route r where r.jkt = p_jkt
$$;

revoke all on function platform.publish_enrolment_code(bytea, uuid) from public;
revoke all on function platform.claim_enrolment_code(bytea) from public;
revoke all on function platform.register_device_key(text, uuid) from public;
revoke all on function platform.resolve_device_key(text) from public;
grant execute on function platform.publish_enrolment_code(bytea, uuid) to app_user;
grant execute on function platform.claim_enrolment_code(bytea) to app_user;
grant execute on function platform.register_device_key(text, uuid) to app_user;
grant execute on function platform.resolve_device_key(text) to app_user;
