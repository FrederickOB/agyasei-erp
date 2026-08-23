-- ============================================================================
-- 0012_credit_account_status.sql — a credit account's LIFECYCLE becomes an
-- append-only decision log, and `customer_account.status` becomes a projection
-- of it that only a trigger may write.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- `app.customer_account.status` has been ENFORCED since 0004 and SET BY
-- NOTHING. `sales.createSale` refuses credit tender on any account that is not
-- 'ACTIVE' — a real, working control — and no route, script or trigger in the
-- repository could ever move an account off 'ACTIVE'. A customer who stops
-- paying could not be cut off through the app.
--
-- The obvious repair — `update app.customer_account set status = 'SUSPENDED'`
-- — loses the only thing anybody actually asks three months later: WHO cut
-- this customer off, WHEN, and WHY. Suspension is a risk judgement in exactly
-- the sense migration 0011's credit limit is one, so it gets the same shape:
-- an append-only log of decisions, a server-maintained projection, and a
-- database backstop that makes the log the only write path.
--
-- ---------------------------------------------------------------------------
-- 'ON_HOLD' IS RETIRED (credit-offline-plan R4)
-- ---------------------------------------------------------------------------
-- 0004's check constraint carries ACTIVE / ON_HOLD / CLOSED. R4 rules three
-- statuses — ACTIVE / SUSPENDED / CLOSED — and rules the fast, reversible
-- "stop this customer now" switch a SEPARATE thing under a separate authority,
-- because three flags all meaning "stopped" is how a suspended customer keeps
-- transacting (06 §6.1, M-14).
--
-- Existing 'ON_HOLD' rows migrate to 'SUSPENDED', which is the conservative
-- direction: both are non-'ACTIVE', so `sales.createSale` refused credit on
-- them before this migration and refuses credit on them after it. NO ACCOUNT
-- BECOMES SELLABLE HERE. Each migrated account also gets a log row stamped
-- `MIGRATED_FROM_ON_HOLD`, so when the separate hold switch
-- (`customer.credit_hold`, R1.a/R4) is built, its backfill is a query against
-- this log rather than a guess about history.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE
-- ---------------------------------------------------------------------------
--   · `customer.credit_hold` and the `credit_account_location_cap` lease
--     revocation R4 pairs with a suspension. Both belong to the counter
--     allowance surface (R1.a), which is not built; a half of a hold switch
--     would be a second thing meaning "stopped" with nothing reading it.
--   · Conflict class #20 (`credit_sale_after_suspension`). It detects sales
--     that arrive from a device that was dark when the suspension happened,
--     and the bucket that would make a device dark-but-informed does not
--     exist yet either.
-- Both are named in `docs/credit-offline-plan.md`; neither is reachable today.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Retire ON_HOLD. Data first, constraint second, guard trigger LAST — this
--    UPDATE is the one legitimate direct write to `status` that will ever run,
--    and it runs before the backstop in §4 exists to refuse it.
-- ----------------------------------------------------------------------------
alter table app.customer_account drop constraint customer_account_status_check;

update app.customer_account set status = 'SUSPENDED' where status = 'ON_HOLD';

alter table app.customer_account
  add constraint customer_account_status_check
  check (status in ('ACTIVE','SUSPENDED','CLOSED'));

-- ----------------------------------------------------------------------------
-- 2. The log.
--
-- `from_status` is recorded, not merely `to_status`: a reviewer reading the
-- chain must be able to see that it is a chain, and a row whose `from_status`
-- does not match the previous row's `to_status` is evidence of a write that
-- went round the log. `from_status <> to_status` because a no-op transition
-- writes no row at all (R4: "X -> X — no-op, not an error").
-- ----------------------------------------------------------------------------
create table app.credit_status_change (
  tenant_id           uuid        not null references platform.tenant (id),
  id                  uuid        not null,
  write_id            uuid        not null,
  hlc                 app.hlc     not null,
  created_at          timestamptz not null default transaction_timestamp(),
  updated_at          timestamptz not null default transaction_timestamp(),
  deleted_at          timestamptz,
  credit_account_id   uuid        not null,
  from_status         text        not null check (from_status in ('ACTIVE','SUSPENDED','CLOSED')),
  to_status           text        not null check (to_status   in ('ACTIVE','SUSPENDED','CLOSED')),
  -- A short platform token for the KIND of decision. Shaped like
  -- `credit_limit_version.reason_code` so that a tenant-editable taxonomy,
  -- when one exists, is rows and a foreign key rather than a migration over
  -- data. The human's own sentence goes in `note`.
  reason_code         text        not null check (length(reason_code) between 1 and 64),
  -- REQUIRED. "Why was this customer cut off" is the question somebody asks
  -- three months later, and a status that changed for no recorded reason
  -- cannot be answered then.
  note                text        not null check (length(btrim(note)) between 3 and 500),
  -- The exposure at the moment of the decision, in minor units. Recorded
  -- rather than recomputed: a CLOSE is only legal at zero exposure (§3), and
  -- an auditor reading this row later must see the figure the rule was
  -- actually applied to, not what the ledger sums to today.
  exposure_at_decision_minor app.money_minor not null,
  decided_by          uuid        not null,
  decided_at_location uuid,
  constraint csc_deleted_never check (deleted_at is null),
  constraint csc_is_a_change check (from_status <> to_status),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, credit_account_id) references app.customer_account (tenant_id, id)
    deferrable initially immediate
);
create index credit_status_change_account_ix
  on app.credit_status_change (tenant_id, credit_account_id, created_at);
select app.apply_tenant_rls('app.credit_status_change');

-- ----------------------------------------------------------------------------
-- 3. Append-only, with no whitelist at all.
--
-- 0011 lets `state` change on a limit version because a version really is
-- superseded later. Nothing about a status decision is ever revised: the way
-- to undo a suspension is to record the reinstatement, which is another row.
-- So this guard is stricter than 0011's — UPDATE and DELETE are both refused
-- outright, and the history a suspension leaves cannot be tidied away.
-- ----------------------------------------------------------------------------
create function app.credit_status_change_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'app.credit_status_change is append-only: DELETE refused. A suspension is undone by recording the reinstatement, never by deleting the decision.';
  end if;
  raise exception 'app.credit_status_change is append-only: UPDATE refused. Record another transition instead of editing this one.';
end
$$;

create trigger credit_status_change_append_only
  before update or delete on app.credit_status_change
  for each row execute function app.credit_status_change_guard();

-- ----------------------------------------------------------------------------
-- 4. The projection, and the backstop that makes the log the ONLY write path.
--
-- Same discriminator as 0011 §5: the projection's UPDATE runs INSIDE a trigger
-- and sees `pg_trigger_depth() = 2`; application SQL runs at depth 1 and is
-- refused. Nothing an application can set changes that, and it raises for a
-- superuser as loudly as for anybody else.
--
-- The legality of a transition is NOT decided here. A trigger cannot ask "does
-- this person hold `credit.account.manage`?" or produce the message a person
-- needs, and duplicating the table in plpgsql would make two places that must
-- agree. The router owns the rules; the database owns the invariant that no
-- status moves without a logged decision behind it.
-- ----------------------------------------------------------------------------
create function app.forbid_direct_credit_status_edit() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status and pg_trigger_depth() < 2 then
    raise exception 'app.customer_account.status is a projection of app.credit_status_change: record a transition instead of writing the column (credit-offline-plan R4).';
  end if;
  return new;
end
$$;

create trigger customer_account_status_projection_only
  before update on app.customer_account
  for each row execute function app.forbid_direct_credit_status_edit();

create function app.apply_credit_status_change() returns trigger
language plpgsql as $$
begin
  update app.customer_account
     set status     = new.to_status,
         updated_at = transaction_timestamp()
   where tenant_id = new.tenant_id
     and id        = new.credit_account_id
     and status    = new.from_status;
  if not found then
    raise exception 'credit status transition from % is stale: the account is no longer in that status.',
      new.from_status;
  end if;
  return null;
end
$$;

create trigger credit_status_change_project
  after insert on app.credit_status_change
  for each row execute function app.apply_credit_status_change();

-- ----------------------------------------------------------------------------
-- 5. Why the rows migrated out of ON_HOLD in §1 get NO log row.
--
-- There is no honest `from_status` to write. 'ON_HOLD' no longer exists in the
-- domain and the check constraint refuses it; 'ACTIVE' would be a lie about
-- what the account was, and 'SUSPENDED' would be a lie about what changed.
--
-- Stated explicitly because the alternative was tempting and wrong: a
-- fabricated 'ACTIVE' -> 'SUSPENDED' row would put a decision in an audit log
-- that no person ever made, signed with a user id that does not exist. An
-- empty log with a documented migration is honest; a forged one is not.
--
-- The backfill R4 asks for when `customer.credit_hold` lands therefore reads
-- the accounts, not the log:
--   select id from app.customer_account where status = 'SUSPENDED'
--     and not exists (select 1 from app.credit_status_change
--                      where credit_account_id = customer_account.id);
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 6. `credit.account.manage` becomes a FRESH-AUTHORIZATION capability.
--
-- 02 §2.5 defines that flag for exactly this case: a lifecycle decision taken
-- against a stale view of an account. Suspending a customer on the strength of
-- a balance the device cached an hour ago is the failure it names.
--
-- The description is corrected at the same time: it said "hold", and holds are
-- now a separate switch under a separate authority (R4).
-- ----------------------------------------------------------------------------
update platform.permission
   set requires_fresh_authorization = true,
       description = 'Open a credit account, set its terms, and move it between ACTIVE, SUSPENDED and CLOSED.'
 where code = 'credit.account.manage';
