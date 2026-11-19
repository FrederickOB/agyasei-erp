-- ============================================================================
-- 0020 — TENDER METHODS, CASH SESSIONS, AND THE TWO CAPABILITIES OF A TILL
--
-- 04 §4.8 (`tender_method`), 04 §4.8a (`cash_session`), 08 §8.2a (the client
-- half), 03 §3.4.2 (why business_date needs a session at all) and §3.6 class
-- #17 (two claims on one till). Written in 0005's style: platform vocabulary
-- in `platform`, everything a tenant owns in `app` through the tenant pattern.
--
-- ── WHAT IS PLATFORM AND WHAT IS TENANT HERE (CLAUDE.md §2.9, ADR-0006) ────
-- A tender method's CODE and NAME are the tenant's words — "Mobile Money",
-- "MoMo", "Bank Transfer" — and no platform code may read them. What the
-- platform reads is its POSTING ROLE, a value from the platform's own
-- `posting_role_catalog`, and two properties DERIVED from it:
--
--   is_cash        — the money is in the drawer, so cash-up counts it.
--   is_on_account  — the money is the customer's debt, so the sale writes a
--                    credit_entry CHARGE for exactly that amount (enforced in
--                    0022) and needs `sale.record.credit`.
--
-- They are GENERATED, not editable, and that is the point. 05 §5.6.2 rule 11b
-- posts a till count variance against TILL_CASH; a "cash" tender that posted
-- anywhere else would make the drawer count and the ledger disagree by
-- construction, with nothing to detect it. A tenant chooses the role; the
-- platform says what the role means.
--
-- `posting_role`, NOT `gl_account_id` (04 §4.8): a tenant row pointing straight
-- at an account is a second, unchecked mapping channel that bypasses
-- gl_account_mapping and its account-type trigger (05 §5.6.1).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The capabilities. GLOBAL, platform vocabulary — 0005's header says why a
-- tenant composes codes and never mints them.
--
-- Two codes, not one, because the boundary between them is a real one in some
-- tenant's org chart: "anyone at the counter opens the till, a supervisor
-- counts it" is a common control. Tenant #1's template grants both to every
-- role that sells (packages/db/src/seed/roles.ts); that is data, editable.
-- ----------------------------------------------------------------------------
insert into platform.permission
  (code, domain, description, is_sensitive, requires_fresh_authorization, bound_schema)
values
  ('cash.session.open', 'cash',
   'Open a till for a trading day: start a cash session with a counted opening float.',
   false, false, null),
  -- Sensitive: the close FIXES a variance that posts to CASH_OVER_SHORT
  -- (05 §5.6.2 rule 11b) and records what left the drawer for the bank
  -- (rule 11). It is the till's statement of account.
  ('cash.session.close', 'cash',
   'Close a till: count the drawer, record what is taken for banking, and fix the variance.',
   true, false, null)
on conflict (code) do nothing;


-- ----------------------------------------------------------------------------
-- 2. app.tender_method — TENANT-DEFINED, TENANT-NAMED, EDITABLE (04 §4.8).
-- ----------------------------------------------------------------------------
create table app.tender_method (
  tenant_id          uuid        not null references platform.tenant (id),
  id                 uuid        not null,
  write_id           uuid        not null,
  hlc                app.hlc     not null,
  created_at         timestamptz not null default transaction_timestamp(),
  updated_at         timestamptz not null default transaction_timestamp(),
  deleted_at         timestamptz,
  code               text        not null,   -- the tenant's word. Never read by platform code.
  name               text        not null,   -- the tenant's word. Rendered, never branched on.
  posting_role       text        not null references platform.posting_role_catalog (posting_role),
  -- Derived, never typed. See the header.
  is_cash            boolean     not null generated always as (posting_role = 'TILL_CASH') stored,
  is_on_account      boolean     not null generated always as (posting_role = 'AR_TRADE') stored,
  -- A momo transaction id, a bank reference, a cheque number. Tenant policy:
  -- whether a method needs one is the tenant's call, and the counter asks for
  -- it when it does (enforced again at insert in 0021).
  requires_reference boolean     not null default false,
  -- Retired methods stay as referents for the sales that used them. A device
  -- offers only active ones; a sale queued before a method was retired still
  -- lands (CLAUDE.md §2.2: never lost).
  is_active          boolean     not null default true,
  sort_order         smallint    not null default 0,
  origin_template_id text,
  origin_ref         text,
  -- A sale settles through money that moved; these four roles are where money
  -- that moved at a counter can land (05 §5.6.2 rules 1, 2, 4). Anything else
  -- — revenue, a payable, an expense — is a mapping error with a sale on it.
  constraint tm_settlement_role check (
    posting_role in ('TILL_CASH', 'MOMO_WALLET', 'BANK', 'AR_TRADE')),
  constraint tm_code_shape check (length(code) between 1 and 32),
  constraint tm_name_shape check (length(name) between 1 and 80),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
create unique index tender_method_code_uq on app.tender_method (tenant_id, code)
  where deleted_at is null;
create unique index tender_method_origin_uq on app.tender_method (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
select app.apply_tenant_rls('app.tender_method');

comment on table app.tender_method is
  'Tenant-defined ways to settle a sale. code/name are tenant vocabulary and never branched on; posting_role (platform vocabulary) and the flags derived from it are what the platform reads (04 §4.8).';
comment on column app.tender_method.is_cash is
  'GENERATED from posting_role = TILL_CASH: the money is in the drawer and cash-up counts it (05 §5.6.2 rule 11b).';
comment on column app.tender_method.is_on_account is
  'GENERATED from posting_role = AR_TRADE: the sale charges the customer''s account for exactly this amount (0022) and needs sale.record.credit.';


-- ----------------------------------------------------------------------------
-- 3. app.cash_session — the till, opened for one trading day (04 §4.8a).
--
-- WHY THIS EXISTS (08 §8.2a): without a session the device has no trustworthy
-- business date. Every sale and every sale-sourced movement takes its
-- business_date FROM THE SESSION it was rung in (0021, 0022), so a date is
-- always something a named person asserted at a stated time, not whatever a
-- tablet's clock said.
--
-- THE TILL. `device_id` comes from the VERIFIED token, never a payload, and
-- names the drawer a device owns; NULL is a SHARED drawer that any device at
-- the location may ring into. `till_key` folds the two into one comparable
-- value so "one session per till per business date" is a plain unique index.
--
-- CLASS #17 — TWO CLAIMS ON ONE TILL (03 §3.6). Two devices claim the shared
-- drawer while both offline, or a wiped device opens its own till again for a
-- day it already opened. Refusing the second claim is not an option: the
-- device has already rung sales into it, and those sales name it. So the
-- second claim LANDS with `contested_session_id` naming the first, the unique
-- index below covers only uncontested rows, and a review goes to a human
-- (apps/api/src/routers/cash-session.ts). The receipt-collision precedent
-- (0006, class #14) is the same shape for the same reason.
--
-- MUTABILITY. A session is opened, then closed, ONCE. The trigger below
-- permits exactly that transition and freezes everything else; after close
-- nothing about the row may change. The close is the till's document — the
-- count, the banking, the expected figure and the variance are written
-- together and then never again.
-- ----------------------------------------------------------------------------
create table app.cash_session (
  tenant_id             uuid        not null references platform.tenant (id),
  id                    uuid        not null,     -- = the open op's idempotency key
  write_id              uuid        not null,     -- the OPEN's unit of work
  hlc                   app.hlc     not null,     -- the HLC of the write that produced the current value
  created_at            timestamptz not null default transaction_timestamp(),
  updated_at            timestamptz not null default transaction_timestamp(),
  deleted_at            timestamptz,
  location_id           uuid        not null,
  device_id             uuid,                     -- from the token. NULL = shared drawer
  till_key              uuid        not null generated always as
                          (coalesce(device_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  business_date         date        not null,     -- human-asserted at open (03 §3.4.2)
  -- What the SERVER's calendar said at the location when the open landed. The
  -- divergence check (08 §8.2a) compares against this, and the close report
  -- shows it beside the asserted date.
  server_date_at_open   date        not null,
  opened_by             uuid        not null,     -- from the token
  opened_at             timestamptz not null,     -- device clock. UNTRUSTED. Display only.
  opened_offline        boolean     not null,     -- the device could not validate against server time
  opening_float_minor   app.money_minor not null,
  status                text        not null default 'OPEN',
  closed_by             uuid,
  closed_at             timestamptz,              -- device clock. UNTRUSTED. Display only.
  auto_closed           boolean     not null default false,   -- the midnight close (08 §8.2a)
  counted_minor         app.money_minor,          -- the drawer count. NULL until close; NULL on auto-close
  banked_minor          app.money_minor,          -- taken out for the bank at close (rule 11)
  -- SERVER-computed at close and frozen: float + Σ is_cash sale_tender in this
  -- session. The device shows its own figure; `client_expected_minor` keeps it
  -- so a divergence is visible rather than silently preferred either way.
  expected_cash_minor   app.money_minor,
  variance_minor        app.money_minor,          -- counted − expected. Posts by rule 11b.
  client_expected_minor app.money_minor,
  close_write_id        uuid,                     -- the CLOSE's unit of work
  contested_session_id  uuid,                     -- class #17: the session that claimed this till first
  constraint cs_deleted_never check (deleted_at is null),
  constraint cs_status check (status in ('OPEN', 'CLOSED', 'ABANDONED')),
  constraint cs_float_nonneg check (opening_float_minor >= 0),
  constraint cs_counted_nonneg check (counted_minor is null or counted_minor >= 0),
  constraint cs_banked_nonneg check (banked_minor is null or banked_minor >= 0),
  constraint cs_open_shape check (
    status <> 'OPEN' or (
      closed_by is null and closed_at is null and close_write_id is null
      and counted_minor is null and banked_minor is null and expected_cash_minor is null
      and variance_minor is null and client_expected_minor is null and not auto_closed)),
  constraint cs_closed_shape check (
    status = 'OPEN' or (
      closed_by is not null and closed_at is not null and close_write_id is not null
      and expected_cash_minor is not null)),
  -- The midnight close counts nothing: nobody was there to count.
  constraint cs_auto_close_uncounted check (
    not auto_closed or (counted_minor is null and banked_minor is null)),
  -- The variance is a derived figure, stored because it POSTS — and stored
  -- figures that are derived must be checked, or they drift.
  constraint cs_variance_identity check (
    (counted_minor is null) = (variance_minor is null)
    and (counted_minor is null or variance_minor = counted_minor - expected_cash_minor)),
  constraint cs_banked_within_count check (
    banked_minor is null or (counted_minor is not null and banked_minor <= counted_minor)),
  constraint cs_not_self_contested check (contested_session_id is null or contested_session_id <> id),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, close_write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, contested_session_id) references app.cash_session (tenant_id, id)
    deferrable initially immediate
);
-- One session per till per business date — for every claim that is not
-- itself the contested second claim of a #17 race.
create unique index cash_session_till_day_uq
  on app.cash_session (tenant_id, location_id, till_key, business_date)
  where contested_session_id is null;
create index cash_session_location_day_ix
  on app.cash_session (tenant_id, location_id, business_date);
create index cash_session_status_ix
  on app.cash_session (tenant_id, location_id, status);
select app.apply_tenant_rls('app.cash_session');

comment on table app.cash_session is
  'A till opened for one trading day (04 §4.8a). Sales take business_date from it. Opened once, closed once, then frozen. A second claim on one till lands contested (class #17) and goes to review.';
comment on column app.cash_session.opened_at is
  'Device clock at open. UNTRUSTED (03 §3.4.2) — display only, never ordering or reporting.';

-- Opened once, closed once, then nothing. REVOKE is the first line; the
-- trigger survives a careless future GRANT (the 0004 pattern).
revoke delete on app.cash_session from app_user;

create function app.cash_session_guard() returns trigger
language plpgsql as $$
declare
  -- The columns the CLOSE writes. Everything else was asserted at open and
  -- is frozen from the moment it landed. `till_key` is excluded for a
  -- mechanical reason, not a permissive one: a GENERATED column reads NULL in
  -- NEW inside a BEFORE trigger (Postgres computes it afterwards), and it is a
  -- pure function of `device_id`, which IS compared.
  close_cols constant text[] := array[
    'status', 'closed_by', 'closed_at', 'auto_closed', 'counted_minor', 'banked_minor',
    'expected_cash_minor', 'variance_minor', 'client_expected_minor', 'close_write_id',
    'hlc', 'updated_at', 'till_key'];
begin
  if tg_op = 'DELETE' then
    raise exception 'app.cash_session %: a session is a document and is never deleted', old.id;
  end if;
  if old.status <> 'OPEN' then
    raise exception 'app.cash_session %: a % session is final; nothing about it may change',
      old.id, old.status;
  end if;
  if new.status = 'OPEN' then
    raise exception 'app.cash_session %: the only permitted update is the close (OPEN -> CLOSED or ABANDONED)',
      old.id;
  end if;
  if (to_jsonb(new) - close_cols) is distinct from (to_jsonb(old) - close_cols) then
    raise exception 'app.cash_session %: the close may change only the close; what was asserted at open is frozen',
      old.id;
  end if;
  return new;
end
$$;

create trigger cash_session_guard
  before update or delete on app.cash_session
  for each row execute function app.cash_session_guard();
