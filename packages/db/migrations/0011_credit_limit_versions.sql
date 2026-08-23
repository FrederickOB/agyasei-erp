-- ============================================================================
-- 0011_credit_limit_versions.sql — a credit limit becomes an APPEND-ONLY
-- DECISION LOG, and `customer_account.credit_limit_minor` becomes a projection
-- of it that only a trigger may write.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Until this migration a credit limit could be set exactly once, at
-- `credit.openAccount`, and never changed: `credit_limit_minor` was INSERTed
-- and appeared in no UPDATE anywhere in the repository. CLAUDE.md §3 lists
-- "customer credit with limits, terms, ageing, and facility fee" as a Phase 1
-- pillar, and "limits" that can be typed once and never corrected is not that.
--
-- The obvious repair — `update app.customer_account set credit_limit_minor` —
-- is the one 06 §6.6 rules out by name. A credit limit is a RISK JUDGEMENT.
-- Two people, each having heard something different about the same customer,
-- can decide two different numbers; last-write-wins silently discards one
-- person's judgement and which one it discards depends on arrival order.
-- CLAUDE.md §2.2 names that exact case as the canonical hard one.
--
-- ---------------------------------------------------------------------------
-- WHAT 06 §6.6.1 RULES, IMPLEMENTED HERE
-- ---------------------------------------------------------------------------
--   · `supersedes_id` IS the compare-and-set. A write declares which version
--     its author believed was current. Same detector as §3.6.1's
--     `base_row_hlc`, expressed as data rather than as a predicate.
--   · The log is the authority; `customer_account.credit_limit_minor` is a
--     SERVER-MAINTAINED PROJECTION of the accepted head. §4.9's DDL survives
--     verbatim; what changes is that no application code may write it.
--   · The version history is permanently retained, where `app.row_version`
--     ages out at the tenant's retention floor — so §3.6.1's
--     "unreconstructable ancestor" branch can never fire for a credit limit.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE, AND WHY THAT IS SAFE TODAY
-- ---------------------------------------------------------------------------
-- §6.6.3's fork machinery — both versions to `pending_review`, revert to the
-- ancestor, `conflict_review` routing, the exposure re-check — is NOT built.
-- It cannot be reached, and the reason is structural rather than hopeful:
-- `credit_limit_one_head` permits exactly ONE accepted version per account, so
-- a second concurrent decision is REFUSED at the database rather than accepted
-- into a fork. The refusal carries the version that won, so the author who
-- lost sees the current number and decides again with it in front of them.
--
-- That is §6.6.3(7) — "severity-1 credit resolutions require connectivity" —
-- taken to its conclusion: with no offline path to a limit and no way for two
-- accepted versions to coexist, the fork state has no producer. The day a
-- limit becomes writable offline, whoever builds that path builds §6.6.3's
-- review routing WITH it, in the same change. `limit_state` carries
-- 'pending_review' and 'rejected' already so that change adds rows, not a
-- column.
--
-- `effective_from` may not be future-dated. §6.6.2 permits it and pairs it
-- with "a scheduled server write advances it" — and there is no scheduler, so
-- a future-dated version would sit unapplied while the screen showed the old
-- number as current. Refused out loud rather than accepted and forgotten.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The state a decision is in.
--
-- 'accepted'       — in force, or was until a successor took over.
-- 'superseded'     — a later accepted version supersedes it.
-- 'pending_review' — a fork nobody has resolved. NO PRODUCER TODAY (above).
-- 'rejected'       — a reviewer declined it. Same: no producer today.
-- ----------------------------------------------------------------------------
create type app.limit_state as enum ('accepted', 'pending_review', 'superseded', 'rejected');

create table app.credit_limit_version (
  tenant_id           uuid        not null references platform.tenant (id),
  id                  uuid        not null,
  write_id            uuid        not null,
  hlc                 app.hlc     not null,
  created_at          timestamptz not null default transaction_timestamp(),
  updated_at          timestamptz not null default transaction_timestamp(),
  deleted_at          timestamptz,
  credit_account_id   uuid        not null,
  limit_minor         app.money_minor not null check (limit_minor >= 0),
  terms_days          smallint    not null check (terms_days >= 0 and terms_days <= 365),
  fee_rate_bp         app.bp      not null check (fee_rate_bp >= 0),
  -- A short token for WHY. There is no tenant-editable reason taxonomy for
  -- credit decisions the way `app.movement_reason` is one for stock, so the
  -- application writes a single platform token here and puts the human's own
  -- sentence in `note`. The column is shaped for the taxonomy so that adding
  -- one later is rows and a foreign key, not a second migration over data.
  reason_code         text        not null check (length(reason_code) between 1 and 64),
  note                text,
  -- The version its author believed was current. NULL only for the genesis
  -- version of an account. This IS the compare-and-set (§6.6.1).
  supersedes_id       uuid,
  state               app.limit_state not null,
  decided_by          uuid        not null,
  decided_at_location uuid,
  effective_from      date        not null,
  constraint clv_deleted_never check (deleted_at is null),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, credit_account_id) references app.customer_account (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, supersedes_id) references app.credit_limit_version (tenant_id, id)
    deferrable initially immediate
);
create index credit_limit_version_account_ix
  on app.credit_limit_version (tenant_id, credit_account_id, effective_from);
select app.apply_tenant_rls('app.credit_limit_version');

-- ----------------------------------------------------------------------------
-- 2. The two structural guarantees.
--
-- `credit_limit_one_head` is the one that matters and the one the projection
-- depends on: an account has EXACTLY ONE accepted version, so "the limit in
-- force" is never ambiguous and two concurrent decisions cannot both land.
--
-- `credit_limit_one_accepted_child` is §6.6's own fork detector, kept because
-- it is the constraint that survives if `state` handling is ever loosened.
-- NULLS NOT DISTINCT (PG15+) so two devices both writing the FIRST version of
-- an account collide instead of both being accepted — with the default
-- NULLS DISTINCT the root case failed OPEN (M-12).
-- ----------------------------------------------------------------------------
create unique index credit_limit_one_head
  on app.credit_limit_version (tenant_id, credit_account_id)
  where state = 'accepted';

create unique index credit_limit_one_accepted_child
  on app.credit_limit_version (tenant_id, credit_account_id, supersedes_id)
  nulls not distinct
  where state = 'accepted';

-- ----------------------------------------------------------------------------
-- 3. A version is append-only except for `state` (§6.6.5).
--
-- The whitelist is narrow on purpose: a decision log whose NUMBERS could be
-- edited afterwards would record what somebody wishes had been decided.
-- ----------------------------------------------------------------------------
create function app.credit_limit_version_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'app.credit_limit_version is append-only: DELETE refused. A limit is withdrawn by superseding it, never by deleting the decision.';
  end if;
  if (to_jsonb(new) - 'state' - 'updated_at') <> (to_jsonb(old) - 'state' - 'updated_at') then
    raise exception 'app.credit_limit_version is append-only: only `state` may change. Record a new version instead of editing this one.';
  end if;
  return new;
end
$$;

create trigger credit_limit_version_append_only
  before update or delete on app.credit_limit_version
  for each row execute function app.credit_limit_version_guard();

-- ----------------------------------------------------------------------------
-- 4. Ordering (§6.6.2): `effective_from` is non-decreasing along the chain,
-- and never in the future.
--
-- Non-decreasing is what makes "the accepted version with the greatest
-- effective_from <= D" unique, so the `supersedes_id` chain and the date
-- ordering cannot disagree — which is what left
-- `credit_exposure_exception.limit_in_force_minor` undefined before M-12.
-- ----------------------------------------------------------------------------
create function app.credit_limit_version_dates() returns trigger
language plpgsql as $$
declare
  parent_from date;
begin
  if new.effective_from > current_date then
    raise exception 'a credit limit may not be future-dated: % is after today. The scheduled advance that would apply it does not exist, so the account would keep showing the old limit as current.',
      new.effective_from;
  end if;
  if new.supersedes_id is not null then
    select effective_from into parent_from
      from app.credit_limit_version
     where tenant_id = new.tenant_id and id = new.supersedes_id;
    if parent_from is not null and new.effective_from < parent_from then
      raise exception 'a credit limit may not take effect (%) before the version it replaces (%).',
        new.effective_from, parent_from;
    end if;
  end if;
  return new;
end
$$;

create trigger credit_limit_version_dates
  before insert on app.credit_limit_version
  for each row execute function app.credit_limit_version_dates();

-- ----------------------------------------------------------------------------
-- 5. The projection, and the backstop that makes it the ONLY write path.
--
-- phase1-status §6 item 3 names this gap: 02 §2.4 specifies that
-- `customer_account.credit_limit_minor` is protected at the database level and
-- "neither exists ... the prohibition holds, but it holds on one application
-- check with no defence in depth underneath it."
--
-- What is NOT done here, stated rather than left to be discovered: 02 §2.4
-- also asks for a column-level REVOKE on the writing role. Pairing it with
-- this trigger would force the projection function to be SECURITY DEFINER, and
-- a definer function owned by the schema owner runs OUTSIDE the row-level
-- security this whole schema depends on — trading a tenant-isolation
-- guarantee for a privilege one. The trigger is the stronger half in any case:
-- a REVOKE is silent for a superuser, and this raises for everyone.
--
-- `pg_trigger_depth()` is the discriminator: the projection's UPDATE runs
-- INSIDE a trigger, so the guard sees depth 2. Application SQL runs at depth
-- 1 and is refused. Nothing an application can set changes that.
-- ----------------------------------------------------------------------------
create function app.forbid_direct_credit_terms_edit() returns trigger
language plpgsql as $$
begin
  if (new.credit_limit_minor is distinct from old.credit_limit_minor
      or new.terms_days is distinct from old.terms_days
      or new.facility_fee_bp_per_month is distinct from old.facility_fee_bp_per_month)
     and pg_trigger_depth() < 2 then
    raise exception 'app.customer_account credit terms are a projection of app.credit_limit_version: record a version instead of writing the column (06 §6.6.1).';
  end if;
  return new;
end
$$;

create trigger customer_account_terms_projection_only
  before update on app.customer_account
  for each row execute function app.forbid_direct_credit_terms_edit();

create function app.apply_credit_limit_version() returns trigger
language plpgsql as $$
begin
  if new.state <> 'accepted' then
    return null;
  end if;
  update app.customer_account
     set credit_limit_minor        = new.limit_minor,
         terms_days                = new.terms_days,
         facility_fee_bp_per_month = new.fee_rate_bp,
         updated_at                = transaction_timestamp()
   where tenant_id = new.tenant_id
     and id        = new.credit_account_id;
  return null;
end
$$;

create trigger credit_limit_version_project
  after insert on app.credit_limit_version
  for each row execute function app.apply_credit_limit_version();
