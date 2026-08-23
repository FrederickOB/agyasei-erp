-- ============================================================================
-- 0013_credit_offline_visibility.sql — the credit book becomes SYNCABLE, and
-- the sync rules that carry it become table-driven rather than claim-driven.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- `app.credit_entry` and `app.customer_account` are in NO sync bucket, so a
-- partitioned device knows nothing about what any customer owes. The screen is
-- honest about it — and honesty is not visibility. Phase 1 acceptance
-- criterion 3 requires a customer's balance, ageing and facility fee to be
-- VISIBLE AND CORRECT, and in an offline-first product that is missing code.
--
-- `infra/powersync/sync_rules.yaml` note (b) states the reason the bucket was
-- omitted: *"the permission tables §3.2.2 gates them on do not exist, so the
-- fail-closed choice is no bucket, not an ungated one."* Those tables landed in
-- 0005 — as VIEWS (`app.effective_permission`, `app.user_location_scope`).
--
-- ---------------------------------------------------------------------------
-- WHY A VIEW CANNOT BE THE GATE, AND WHAT REPLACES IT
-- ---------------------------------------------------------------------------
-- PowerSync evaluates a parameter query against data it has REPLICATED, and
-- Postgres logical replication publishes TABLES only — `create publication ...
-- for table <view>` is refused by the server. So the two views cannot be the
-- gate however much we would like them to be.
--
-- The answer is not to fall back to a token claim. A claim is minted once and
-- lives for the life of the token; the whole point of `credit.view` gating the
-- credit book is that REVOKING it must empty the device. So this migration adds
-- two narrow, server-maintained PROJECTIONS of those views — real tables, so
-- they replicate — and the sync rules read those:
--
--   app.credit_sync_book_scope     (tenant_id, user_id)               credit.view
--   app.credit_sync_location_scope (tenant_id, user_id, location_id)  sale.record.credit
--
-- They are derived, never written by a device or by application SQL: one
-- function computes them from the views, and triggers on every table those
-- views read keep them current. A row that is not in the projection is a row
-- the device never receives — no grant, no row, no bucket, zero data.
--
-- THE ONE HONEST LIMIT, STATED SO NOBODY DISCOVERS IT LATER. A role assignment
-- is effective-dated (`effective_from` / `effective_to`), so a grant can lapse
-- with no DML to fire a trigger. The projection is therefore refreshed on every
-- write to the underlying tables (immediate — this is how ordinary revocation
-- works: `deleted_at`, or `effective_to = now()`, are both UPDATEs) AND swept by
-- `app.refresh_credit_sync_scope_all()`, which the same nightly job that runs
-- the archival window calls. The residual exposure is a grant whose
-- `effective_to` was set to a FUTURE instant, which lingers on a device until
-- the next sweep. That is bounded by the sweep interval and by the PowerSync
-- token TTL, and it is written here rather than discovered in an incident.
--
-- ---------------------------------------------------------------------------
-- WHAT A DEVICE MAY HOLD — TWO AUDIENCES, TWO SLICES, NEITHER IS "THE BOOK"
-- (docs/credit-offline-plan.md R1)
-- ---------------------------------------------------------------------------
-- ACCOUNTS / HQ (`credit.view`, keyed by tenant): the live book, BOUNDED —
--   `credit_entry` windowed per row on `archived_at` exactly as `stock_movement`
--   is (§3.2.4), plus one server-derived `credit_position_snapshot` per account
--   and its `credit_position_bucket` vector. The window is what makes the
--   snapshot necessary rather than optional: Σ(local entries) ≠ balance BY
--   CONSTRUCTION once entries fall out of the window, so a device that summed
--   its own log would produce a confidently wrong number that gets more wrong
--   the longer the account has existed. The snapshot carries the balance and
--   `opening_before_window_minor` so the two always reconcile.
--
-- COUNTER (`sale.record.credit`, keyed by tenant+location): `credit_allowance`
--   ONLY — what this one outlet may lend today, and a hold flag. No limit, no
--   balance, no ageing, no entry, no history. The table and its bucket are
--   created here and the table is DELIBERATELY EMPTY: an allowance row exists
--   only where a live `credit_account_location_cap` LEASE exists (06 §6.7), and
--   the lease machinery is not built. An empty projection is the fail-closed
--   state — the channel and its gate exist and are tested; nothing flows until
--   there is something a lease says may flow.
--
-- A stolen accounts tablet holds this tenant's live book for the window. That
-- is a real exposure, and it is the reason `credit.view` must never appear in
-- the counter-staff or outlet-manager template roles.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE
-- ---------------------------------------------------------------------------
-- · No `credit_policy` table — 0005-era gap, and `apps/api/src/credit-policy.ts`
--   still holds the Q4 gate. `app.credit_ageing_band` below carries ONLY the
--   ageing bucket bounds, which are not part of the Q4 fee decision and which
--   the projection cannot be written without. It folds into `credit_policy`
--   when that migration lands.
-- · No fee accrual detail, no allocation rows, no `conflict_review_context` —
--   none of it reaches a device at any permission (R1).
-- · Nothing here edits an earlier migration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. THE SYNC WINDOW ON THE CREDIT LOG
--
-- `archived_at` is the per-row window (§3.2.4). It is per-row and never a
-- bucket parameter, because a bucket's identity is its definition PLUS its
-- parameter values: advancing a window that lives in the key creates a
-- DIFFERENT bucket and re-downloads the whole window to every device in the
-- fleet on the same night. `stock_movement` learned this already; the credit
-- log gets the same shape and the same trigger function.
-- ----------------------------------------------------------------------------
alter table app.credit_entry add column archived_at timestamptz;

comment on column app.credit_entry.archived_at is
  'Sync window (§3.2.4). Non-null = out of the device window; the row stays authoritative on the server and its amount is folded into credit_position_snapshot.opening_before_window_minor. The ONE permitted UPDATE to this table.';

-- 0004 made this table append-only with app.forbid_mutation(), which refuses
-- the archival mark too. Swap it for the guard `stock_movement` already uses:
-- archived_at (and updated_at) may move, every other column still raises. The
-- REVOKE from 0004 stays in force and is untouched.
drop trigger credit_entry_append_only on app.credit_entry;
create trigger credit_entry_append_only
  before update or delete on app.credit_entry
  for each row execute function app.forbid_mutation_except_archive();

create index credit_entry_live_ix
  on app.credit_entry (tenant_id, account_id, business_date)
  where archived_at is null;

-- ----------------------------------------------------------------------------
-- 2. THE GATE — server-maintained projections of the 0005 permission views
--
-- These carry no business data at all. They answer exactly one question, in a
-- shape logical replication can carry: WHICH USER MAY RECEIVE WHICH CREDIT
-- SLICE. Both are `write_id`-exempt because no client write creates them —
-- they are derived rows in the sense of 04 §4.17.3.
-- ----------------------------------------------------------------------------
create table app.credit_sync_book_scope (
  tenant_id    uuid        not null references platform.tenant (id),
  id           uuid        not null default gen_random_uuid(),
  user_id      uuid        not null,
  refreshed_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id)
);
create unique index credit_sync_book_scope_uq
  on app.credit_sync_book_scope (tenant_id, user_id);
select app.apply_tenant_rls('app.credit_sync_book_scope');

comment on table app.credit_sync_book_scope is
  'Projection of app.effective_permission for credit.view. The tenant_credit sync bucket''s parameter query reads THIS — a view cannot be published to logical replication, and a token claim cannot be revoked.';

create table app.credit_sync_location_scope (
  tenant_id    uuid        not null references platform.tenant (id),
  id           uuid        not null default gen_random_uuid(),
  user_id      uuid        not null,
  location_id  uuid        not null,
  refreshed_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate
);
create unique index credit_sync_location_scope_uq
  on app.credit_sync_location_scope (tenant_id, user_id, location_id);
select app.apply_tenant_rls('app.credit_sync_location_scope');

comment on table app.credit_sync_location_scope is
  'Projection of app.user_location_scope INTERSECTED with app.effective_permission for sale.record.credit at that same location. The location_credit_allowance bucket''s parameter query reads THIS.';

-- The one derivation. Recomputes both projections for ONE tenant, additively
-- then subtractively, so a row's id is stable across refreshes and PowerSync
-- does not see churn where nothing changed.
create function app.refresh_credit_sync_scope(p_tenant uuid) returns void
language plpgsql as $$
begin
  -- `credit.view` AT THE TENANT ROOT, and the extra condition is the whole
  -- point rather than a detail.
  --
  -- 02 §2.5: THE RIGHT TO SEE SOMETHING IS NOT THE RIGHT TO HAVE IT ON YOUR
  -- DEVICE. Reading a customer's position online is a request the server
  -- answers one account at a time and can revoke instantly; holding the book is
  -- 400 days of every credit customer sitting on hardware that gets stolen.
  --
  -- A credit account has NO location (06 §6.5), so the only grant whose SHAPE
  -- matches the data is one that covers the whole tenant. An outlet-scoped
  -- `credit.view` is a grant to read the accounts of customers who trade at
  -- one outlet — which the tenant-keyed bucket cannot express and must
  -- therefore not serve. Root-scoped only, and the narrowing is here in the
  -- RESIDENCY gate rather than in the API's read gate, which is unchanged.
  --
  -- NOT YET SUFFICIENT, and saying so is the point: the shipped template grants
  -- `credit.view` to Outlet manager and Regional manager (R1.b says it must be
  -- in neither), and the dev seed assigns most principals at ROOT for
  -- convenience. Until the template is corrected, an outlet manager assigned at
  -- the root receives the book. That is a role-template defect, tracked as such;
  -- this predicate is what makes the fix a one-line change with a test already
  -- written against it (packages/db/test/credit-position.test.ts).
  insert into app.credit_sync_book_scope (tenant_id, user_id)
  select distinct ep.tenant_id, ep.user_id
    from app.effective_permission ep
    join app.location root
      on root.tenant_id = ep.tenant_id
     and root.id        = ep.scope_location_id
     and root.parent_id is null
   where ep.tenant_id = p_tenant
     and ep.permission_code = 'credit.view'
  on conflict (tenant_id, user_id) do nothing;

  delete from app.credit_sync_book_scope s
   where s.tenant_id = p_tenant
     and not exists (
       select 1
         from app.effective_permission ep
         join app.location root
           on root.tenant_id = ep.tenant_id
          and root.id        = ep.scope_location_id
          and root.parent_id is null
        where ep.tenant_id = s.tenant_id
          and ep.user_id = s.user_id
          and ep.permission_code = 'credit.view');

  insert into app.credit_sync_location_scope (tenant_id, user_id, location_id)
  select distinct uls.tenant_id, uls.user_id, uls.location_id
    from app.user_location_scope uls
    join app.effective_permission ep
      on ep.tenant_id       = uls.tenant_id
     and ep.user_id         = uls.user_id
     and ep.location_id     = uls.location_id
     and ep.permission_code = 'sale.record.credit'
   where uls.tenant_id = p_tenant
  on conflict (tenant_id, user_id, location_id) do nothing;

  delete from app.credit_sync_location_scope s
   where s.tenant_id = p_tenant
     and not exists (
       select 1
         from app.user_location_scope uls
         join app.effective_permission ep
           on ep.tenant_id       = uls.tenant_id
          and ep.user_id         = uls.user_id
          and ep.location_id     = uls.location_id
          and ep.permission_code = 'sale.record.credit'
        where uls.tenant_id  = s.tenant_id
          and uls.user_id    = s.user_id
          and uls.location_id = s.location_id);
end
$$;

comment on function app.refresh_credit_sync_scope(uuid) is
  'Recompute both credit sync-scope projections for one tenant. Idempotent; ids are stable across runs.';

-- The sweep the effective-dating hole needs. Called by the same nightly job
-- that advances the archival window; also safe to call by hand.
create function app.refresh_credit_sync_scope_all() returns void
language plpgsql as $$
declare t uuid;
begin
  for t in select id from platform.tenant loop
    perform app.refresh_credit_sync_scope(t);
  end loop;
end
$$;

create function app.credit_sync_scope_touch() returns trigger
language plpgsql as $$
begin
  perform app.refresh_credit_sync_scope(coalesce(new.tenant_id, old.tenant_id));
  return null;
end
$$;

create trigger credit_sync_scope_on_assignment
  after insert or update or delete on app.user_role_assignment
  for each row execute function app.credit_sync_scope_touch();

create trigger credit_sync_scope_on_role_permission
  after insert or update or delete on app.role_permission
  for each row execute function app.credit_sync_scope_touch();

create trigger credit_sync_scope_on_user_account
  after insert or update or delete on app.user_account
  for each row execute function app.credit_sync_scope_touch();

create trigger credit_sync_scope_on_role
  after insert or update or delete on app.role
  for each row execute function app.credit_sync_scope_touch();

create trigger credit_sync_scope_on_location_closure
  after insert or update or delete on app.location_closure
  for each row execute function app.credit_sync_scope_touch();

-- ----------------------------------------------------------------------------
-- 3. AGEING BANDS — the tenant's own boundaries, as CONFIGURATION
--
-- The bounds are per tenant and editable; nothing branches on which tenant it
-- is (CLAUDE.md §2.9). They live apart from the Q4 fee decisions on purpose:
-- an ageing boundary is not a fee rule, the projection cannot be written
-- without it, and holding it hostage to a human sign-off that is about
-- something else would be the wrong kind of caution. Folds into
-- `app.credit_policy` when that migration lands.
-- ----------------------------------------------------------------------------
create table app.credit_ageing_band (
  tenant_id  uuid     not null references platform.tenant (id),
  id         uuid     not null default gen_random_uuid(),
  upper_days smallint not null check (upper_days > 0),
  primary key (tenant_id, id)
);
create unique index credit_ageing_band_uq on app.credit_ageing_band (tenant_id, upper_days);
select app.apply_tenant_rls('app.credit_ageing_band');

-- No rows configured = the template default the API's provisional policy
-- already carries ({30, 60, 90}). A DEFAULT, not a branch: any tenant may
-- insert its own bands and this function stops returning the default for it.
create function app.credit_ageing_bounds(p_tenant uuid) returns smallint[]
language sql stable as $$
  select coalesce(
    (select array_agg(upper_days order by upper_days)
       from app.credit_ageing_band where tenant_id = p_tenant),
    array[30, 60, 90]::smallint[])
$$;

-- How many days of entry log a device may hold (R1.b). Tenant knob, default
-- 400 days; folds into credit_policy with the bands.
create function app.credit_entry_window_days(p_tenant uuid) returns integer
language sql stable as $$ select 400 $$;

-- ----------------------------------------------------------------------------
-- 4. THE SERVER-DERIVED POSITION — what makes a WINDOWED log safe to hold
--
-- Σ(entries on the device) ≠ balance once anything has been archived, so the
-- balance is SYNCED AND AUTHORITATIVE and the device never sums its own log.
-- `opening_before_window_minor` is the archived remainder, so the two always
-- reconcile: opening + Σ(live entries) = balance, exactly, in bigint.
--
-- The bucket vector is the tenant's ageing, rendered server-side against the
-- bands above. A device may not compute it: the band edges are policy and
-- policy is not on the device.
--
-- These rows are derived, not written: no write_id, no client path.
-- ----------------------------------------------------------------------------
create table app.credit_position_snapshot (
  tenant_id                   uuid            not null references platform.tenant (id),
  id                          uuid            not null default gen_random_uuid(),
  account_id                  uuid            not null,
  customer_id                 uuid            not null,
  status                      text            not null,
  terms_days                  smallint        not null,
  credit_limit_minor          app.money_minor not null,
  limit_version_id            uuid,
  -- Σ over EVERY entry, archived included. The authority.
  balance_minor               app.money_minor not null,
  -- Σ excluding FEE entries — the trade receivable a limit is measured against.
  trade_exposure_minor        app.money_minor not null,
  -- limit − trade exposure. May be NEGATIVE: an account already over its limit.
  available_minor             app.money_minor not null,
  on_account_credit_minor     app.money_minor not null,
  fee_outstanding_minor       app.money_minor not null,
  -- Σ over entries the device does NOT hold, so opening + Σ(local) = balance.
  opening_before_window_minor app.money_minor not null,
  aged_by                     text            not null default 'days_past_due',
  -- Non-null once a qualified human has confirmed the tenant's fee policy
  -- (06 §6.4.5). NULL ⇒ every fee figure is provisional and says so.
  fee_confirmed_at            timestamptz,
  entry_window_days           integer         not null,
  as_of                       date            not null,
  -- The HLC THROUGH WHICH this was evaluated: the greatest server-stamped HLC
  -- among the entries included. Never a wall clock, never a device clock — the
  -- till's causal `local_deduction` (06 §6.5) compares its own ack_hlc against
  -- exactly this value, and two server-generated HLCs is the only comparison
  -- that is meaningful.
  as_of_hlc                   app.hlc         not null,
  computed_at                 timestamptz     not null default transaction_timestamp(),
  primary key (tenant_id, id)
);
create unique index credit_position_snapshot_account_uq
  on app.credit_position_snapshot (tenant_id, account_id);
select app.apply_tenant_rls('app.credit_position_snapshot');

create table app.credit_position_bucket (
  tenant_id    uuid            not null references platform.tenant (id),
  id           uuid            not null default gen_random_uuid(),
  account_id   uuid            not null,
  seq          smallint        not null,
  label        text            not null,
  from_dpd     integer,                  -- NULL = unbounded below ('current')
  to_dpd       integer,                  -- NULL = unbounded above (the tail)
  amount_minor app.money_minor not null,
  as_of        date            not null,
  as_of_hlc    app.hlc         not null,
  primary key (tenant_id, id)
);
create unique index credit_position_bucket_uq
  on app.credit_position_bucket (tenant_id, account_id, seq);
select app.apply_tenant_rls('app.credit_position_bucket');

comment on table app.credit_position_bucket is
  'The ageing vector, rendered server-side against the tenant''s own bands. Σ(buckets) − on_account_credit + fee_outstanding = balance, and the client checks that identity with the SAME function it checks the online answer with (checkAgreement). A drift between this projection and the API''s ageing route surfaces as "these do not add up", never as a wrong headline.';

-- ----------------------------------------------------------------------------
-- 5. THE COUNTER'S SLICE — a bounded allowance, never the account (06 §6.5)
--
-- One row per (location, customer): what THIS outlet may lend TODAY. No limit,
-- no balance, no ageing, no entry, no payment history — a stolen counter tablet
-- discloses what one outlet may lend to the customers who trade there, and
-- nothing about customers who trade elsewhere.
--
-- DELIBERATELY UNPOPULATED. A row exists only where a live
-- `credit_account_location_cap` lease exists (06 §6.7) or the customer traded
-- on credit at this location inside the residency window; neither the lease
-- table nor the refusal record is built. The table, its bucket and its gate
-- land now so the channel is testable and fails closed; the derivation lands
-- with §6.7. Inventing a cap here — "the account limit", say — would put the
-- one number §6.5 forbids onto the one device it forbids it on.
-- ----------------------------------------------------------------------------
create table app.credit_allowance (
  tenant_id             uuid            not null references platform.tenant (id),
  id                    uuid            not null default gen_random_uuid(),
  location_id           uuid            not null,
  customer_id           uuid            not null,
  cap_minor             app.money_minor not null check (cap_minor >= 0),
  headroom_minor        app.money_minor not null check (headroom_minor >= 0),
  offline_ceiling_minor app.money_minor,
  credit_hold           boolean         not null default false,
  cap_valid_until       timestamptz     not null,
  cap_version_id        uuid            not null,
  snapshot_as_of        timestamptz     not null,
  snapshot_as_of_hlc    app.hlc         not null,
  primary key (tenant_id, id),
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, customer_id) references app.customer (tenant_id, id)
    deferrable initially immediate
);
create unique index credit_allowance_uq
  on app.credit_allowance (tenant_id, location_id, customer_id);
select app.apply_tenant_rls('app.credit_allowance');

comment on table app.credit_allowance is
  'Server-derived, per (location, customer). headroom = max(0, min(cap, limit − trade_exposure)) as at snapshot_as_of_hlc. The till subtracts its own causal local_deduction from this and NEVER computes a balance (06 §6.5).';

-- ----------------------------------------------------------------------------
-- 6. THE POSITION DERIVATION
--
-- Mirrors `apps/api/src/routers/credit.ts` `ageing` exactly: payments and
-- adjustments carrying `applies_to_id` reduce that charge; those without it are
-- ON-ACCOUNT credit and belong to NO bucket; FEE entries are receivable kept
-- apart from trade AR (06 §6.4.4); a charge whose outstanding has gone to zero
-- or below leaves the buckets entirely.
--
-- It does NOT assert the reconciliation identity and that is deliberate. An
-- over-applied charge legitimately breaks Σ(buckets) − on_account + fee =
-- balance, and the client's `checkAgreement` — the SAME function it runs
-- against the online answer — renders that as "these do not add up" rather than
-- a headline with a breakdown under it that disagrees. Raising here would turn
-- a visible disagreement into a failed projection and a device with no figures.
-- ----------------------------------------------------------------------------
create function app.refresh_credit_position(
  p_tenant uuid, p_account uuid, p_as_of date default null
) returns void
language plpgsql as $$
declare
  v_as_of  date;
  v_bounds smallint[];
  v_hlc    app.hlc;
  v_window integer;
  v_acct   record;
  v_bands  integer;
begin
  select ca.id, ca.customer_id, ca.status, ca.terms_days, ca.credit_limit_minor, ca.hlc
    into v_acct
    from app.customer_account ca
   where ca.tenant_id = p_tenant and ca.id = p_account and ca.deleted_at is null;

  if not found then
    delete from app.credit_position_bucket   where tenant_id = p_tenant and account_id = p_account;
    delete from app.credit_position_snapshot where tenant_id = p_tenant and account_id = p_account;
    return;
  end if;

  v_as_of  := coalesce(p_as_of, transaction_timestamp()::date);
  v_bounds := app.credit_ageing_bounds(p_tenant);
  v_window := app.credit_entry_window_days(p_tenant);
  v_bands  := coalesce(array_length(v_bounds, 1), 0);

  -- The HLC THROUGH WHICH this was evaluated: the greatest server-stamped HLC
  -- among the entries included, falling back to the account's own. Never a
  -- clock reading — this value is compared against `ack_hlc` on a device.
  select coalesce(max(e.hlc), v_acct.hlc) into v_hlc
    from app.credit_entry e
   where e.tenant_id = p_tenant and e.account_id = p_account
     and e.business_date <= v_as_of;

  with entries as (
    select e.id, e.kind, e.amount_minor, e.due_date, e.applies_to_id
      from app.credit_entry e
     where e.tenant_id = p_tenant and e.account_id = p_account
       and e.business_date <= v_as_of
  ), applied as (
    select applies_to_id as charge_id, sum(amount_minor)::bigint as applied_minor
      from entries
     where kind not in ('FEE', 'CHARGE') and applies_to_id is not null
     group by 1
  ), aged as (
    select (e.amount_minor + coalesce(a.applied_minor, 0))::bigint as outstanding_minor,
           case when e.due_date is null then 0 else (v_as_of - e.due_date) end as dpd
      from entries e
      left join applied a on a.charge_id = e.id
     where e.kind = 'CHARGE'
       and (e.amount_minor + coalesce(a.applied_minor, 0)) > 0
  ), bands as (
    select 0::smallint as seq, 'current'::text as label,
           null::integer as from_dpd, 0::integer as to_dpd
    union all
    select i::smallint,
           (coalesce(v_bounds[i - 1], 0) + 1)::text || '-' || v_bounds[i]::text,
           (coalesce(v_bounds[i - 1], 0) + 1)::integer,
           v_bounds[i]::integer
      from generate_subscripts(v_bounds, 1) as i
    union all
    select (v_bands + 1)::smallint,
           v_bounds[v_bands]::text || '+',
           (v_bounds[v_bands] + 1)::integer,
           null::integer
  )
  insert into app.credit_position_bucket
    (tenant_id, account_id, seq, label, from_dpd, to_dpd, amount_minor, as_of, as_of_hlc)
  select p_tenant, p_account, b.seq, b.label, b.from_dpd, b.to_dpd,
         coalesce(sum(a.outstanding_minor), 0)::bigint, v_as_of, v_hlc
    from bands b
    left join aged a
      on (b.from_dpd is null or a.dpd >= b.from_dpd)
     and (b.to_dpd   is null or a.dpd <= b.to_dpd)
   group by b.seq, b.label, b.from_dpd, b.to_dpd
  on conflict (tenant_id, account_id, seq) do update
    set label = excluded.label, from_dpd = excluded.from_dpd, to_dpd = excluded.to_dpd,
        amount_minor = excluded.amount_minor, as_of = excluded.as_of,
        as_of_hlc = excluded.as_of_hlc;

  -- A shortened band list must not leave an orphan bucket carrying money.
  delete from app.credit_position_bucket
   where tenant_id = p_tenant and account_id = p_account and seq > v_bands + 1;

  insert into app.credit_position_snapshot (
    tenant_id, id, account_id, customer_id, status, terms_days, credit_limit_minor,
    limit_version_id, balance_minor, trade_exposure_minor, available_minor,
    on_account_credit_minor, fee_outstanding_minor, opening_before_window_minor,
    fee_confirmed_at, entry_window_days, as_of, as_of_hlc, computed_at)
  select p_tenant,
         gen_random_uuid(),
         p_account,
         v_acct.customer_id,
         v_acct.status,
         v_acct.terms_days,
         v_acct.credit_limit_minor,
         (select v.id from app.credit_limit_version v
           where v.tenant_id = p_tenant and v.credit_account_id = p_account
             and v.state = 'accepted'
           order by v.effective_from desc, v.hlc desc limit 1),
         coalesce(sum(e.amount_minor), 0)::bigint,
         coalesce(sum(e.amount_minor) filter (where e.kind <> 'FEE'), 0)::bigint,
         v_acct.credit_limit_minor
           - coalesce(sum(e.amount_minor) filter (where e.kind <> 'FEE'), 0)::bigint,
         -coalesce(sum(e.amount_minor) filter (
             where e.kind not in ('FEE', 'CHARGE') and e.applies_to_id is null), 0)::bigint,
         coalesce(sum(e.amount_minor) filter (where e.kind = 'FEE'), 0)::bigint,
         coalesce(sum(e.amount_minor) filter (where e.archived_at is not null), 0)::bigint,
         null,
         v_window,
         v_as_of,
         v_hlc,
         transaction_timestamp()
    from app.credit_entry e
   where e.tenant_id = p_tenant and e.account_id = p_account
     and e.business_date <= v_as_of
  on conflict (tenant_id, account_id) do update
    set status                      = excluded.status,
        terms_days                  = excluded.terms_days,
        credit_limit_minor          = excluded.credit_limit_minor,
        limit_version_id            = excluded.limit_version_id,
        balance_minor               = excluded.balance_minor,
        trade_exposure_minor        = excluded.trade_exposure_minor,
        available_minor             = excluded.available_minor,
        on_account_credit_minor     = excluded.on_account_credit_minor,
        fee_outstanding_minor       = excluded.fee_outstanding_minor,
        opening_before_window_minor = excluded.opening_before_window_minor,
        entry_window_days           = excluded.entry_window_days,
        as_of                       = excluded.as_of,
        as_of_hlc                   = excluded.as_of_hlc,
        computed_at                 = excluded.computed_at;
end
$$;

-- Two functions rather than one with a `tg_table_name` switch: PL/pgSQL
-- resolves record fields at plan time, so a single body naming both
-- `new.account_id` and `new.id` fails on whichever table lacks the column.
create function app.credit_position_touch_entry() returns trigger
language plpgsql as $$
begin
  perform app.refresh_credit_position(
    coalesce(new.tenant_id, old.tenant_id),
    coalesce(new.account_id, old.account_id));
  return null;
end
$$;

create function app.credit_position_touch_account() returns trigger
language plpgsql as $$
begin
  perform app.refresh_credit_position(
    coalesce(new.tenant_id, old.tenant_id),
    coalesce(new.id, old.id));
  return null;
end
$$;

create trigger credit_position_on_entry
  after insert or update on app.credit_entry
  for each row execute function app.credit_position_touch_entry();

create trigger credit_position_on_account
  after insert or update on app.customer_account
  for each row execute function app.credit_position_touch_account();

-- Date rollover moves days-past-due with no DML at all. The nightly job that
-- advances the archival window calls this too.
create function app.refresh_credit_positions_all(p_as_of date default null) returns void
language plpgsql as $$
declare r record;
begin
  for r in select tenant_id, id from app.customer_account where deleted_at is null loop
    perform app.refresh_credit_position(r.tenant_id, r.id, p_as_of);
  end loop;
end
$$;

-- ----------------------------------------------------------------------------
-- 7. ACCOUNT RESIDENCY — the same per-row window, one layer up
--
-- R1.b keeps ACTIVE and SUSPENDED accounts on an accounts device, plus CLOSED
-- accounts whose last entry is still inside the entry window; a long-closed
-- account is on nobody's tablet. A PowerSync data query reads ONE table and
-- cannot join, so that rule has to be expressible as a column — and it must be
-- a PER-ROW mark, never a bucket parameter, for the reason §3.2.4 gives.
--
-- Same shape and same nightly job as `credit_entry.archived_at`: a CLOSED
-- account whose entries have all archived out gets marked, leaves every device
-- on the next sync, and stays authoritative on the server. Nothing marks it
-- yet; until the job runs, an account header is resident from the day it opens,
-- which is the safe direction (identity and terms, never history).
-- ----------------------------------------------------------------------------
alter table app.customer_account add column archived_at timestamptz;

comment on column app.customer_account.archived_at is
  'Sync residency (R1.b, §3.2.4). Non-null = off every device; set only for a CLOSED account whose entries have all left the window. Per-row, never a bucket key.';

create index customer_account_resident_ix
  on app.customer_account (tenant_id, status)
  where deleted_at is null and archived_at is null;

-- ----------------------------------------------------------------------------
-- 8. BACKFILL — the triggers above only fire on FUTURE writes
--
-- Every grant and every credit entry that already exists predates this
-- migration, so without these two calls a tenant that was provisioned
-- yesterday would have an empty gate (nobody syncs anything — fail-closed, but
-- also useless) and no positions at all. Both functions are idempotent.
-- ----------------------------------------------------------------------------
select app.refresh_credit_sync_scope_all();
select app.refresh_credit_positions_all();
