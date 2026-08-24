-- ============================================================================
-- 0015 — THE GENERAL LEDGER: MECHANISM ONLY
--
-- Phase 3, Track A (docs/phase2-gate.md §4.3). This migration creates the
-- journal, the account table and the period calendar, and enforces balance and
-- immutability in the database. It SEEDS NOTHING.
--
-- ── THE BOUNDARY THIS FILE SITS ON, AND WHY IT MATTERS ────────────────────
-- CLAUDE.md §2.8 makes an accountant's review of the chart of accounts, the
-- double-entry logic and a full month of statements BLOCKING before a tenant's
-- ledger goes live. No accountant is named (open-questions Q6). The Phase 2
-- gate therefore split Phase 3 in two, and this file is deliberately entirely
-- on the safe side of that line:
--
--   MECHANISM (here)         — what a journal IS, and what the database will
--                              refuse. Exercised against accounts invented by
--                              tests.
--   CONTENT (NOT here)       — a chart of accounts, a posting rule bound to a
--                              named account, a costing method, an opening
--                              balance, the facility fee's account or tax
--                              code, or any GL-bearing tenant reaching
--                              `status = 'active'`.
--
-- There are ZERO account rows and ZERO mapping rows in this migration, and
-- nothing here may be extended to add them. The accountant's sign-off artefact
-- is specified at `docs/architecture/sections/05-general-ledger.md` §5.12.
--
-- ── WHY THESE TABLES CARRY NO write_id / hlc ──────────────────────────────
-- Every synced table in this schema carries `write_id` and `hlc` because a
-- device authored it and the row had to be ordered against other devices'.
-- THE GL IS SERVER-SIDE ONLY (05 §5.2.6): no journal table is in any sync
-- rule, no device may write one, and every entry is derived by this server
-- from a document that already carries its own write id and logical clock.
-- Copying them here would imply a device provenance that does not exist.
-- `source_kind` + `source_id` + `idempotency_key` carry the provenance that
-- does.
--
-- ── AND NO deleted_at ─────────────────────────────────────────────────────
-- A ledger is not soft-deleted. A posted entry is immutable and a correction
-- is a reversing entry (§5.3). There is no column to set, which is stronger
-- than a column nobody is supposed to set.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- app.fiscal_year — tenant configuration. NOTHING assumes January.
--
-- Tenant #1's year runs 1 August – 31 July. That is a row, not a constant, and
-- no code may branch on it (CLAUDE.md §2.9).
-- ----------------------------------------------------------------------------
create table app.fiscal_year (
  tenant_id  uuid        not null references platform.tenant (id),
  fy_code    text        not null,
  starts_on  date        not null,
  ends_on    date        not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, fy_code),
  constraint fy_range check (starts_on <= ends_on)
);
select app.apply_tenant_rls('app.fiscal_year');

create function app.fiscal_year_forbid_overlap() returns trigger
language plpgsql as $$
begin
  -- Two fiscal years covering the same day makes "which year is this document
  -- in" ambiguous — the question the calendar exists to answer. EXCLUDE USING
  -- gist would say this in one line but needs btree_gist, which the hermetic
  -- PGlite harness does not have; migration 0001 set the precedent of a
  -- constraint trigger so that every environment runs the identical file.
  if exists (
    select 1 from app.fiscal_year f
     where f.tenant_id = new.tenant_id
       and f.fy_code  <> new.fy_code
       and daterange(f.starts_on, f.ends_on, '[]')
        && daterange(new.starts_on, new.ends_on, '[]')
  ) then
    raise exception 'GL0010: fiscal year % overlaps an existing year for this tenant', new.fy_code
      using errcode = 'exclusion_violation';
  end if;
  return new;
end
$$;
create trigger fiscal_year_no_overlap
  before insert or update on app.fiscal_year
  for each row execute function app.fiscal_year_forbid_overlap();


-- ----------------------------------------------------------------------------
-- app.accounting_period — the periods that TILE a fiscal year.
--
-- `reopened_by` / `reopen_reason` exist because §5.9.4's "recorded reason" had
-- nowhere to live. A period reopened with no reason recorded is a period
-- reopened by nobody.
-- ----------------------------------------------------------------------------
create table app.accounting_period (
  tenant_id     uuid        not null references platform.tenant (id),
  id            uuid        not null,
  fy_code       text        not null,
  seq           int         not null check (seq >= 1),
  starts_on     date        not null,
  ends_on       date        not null,
  status        text        not null default 'open',
  closed_at     timestamptz,
  closed_by     uuid,
  reopened_at   timestamptz,
  reopened_by   uuid,
  reopen_reason text,
  created_at    timestamptz not null default transaction_timestamp(),
  updated_at    timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  unique (tenant_id, fy_code, seq),
  foreign key (tenant_id, fy_code) references app.fiscal_year (tenant_id, fy_code),
  constraint ap_status check (status in ('open', 'closed', 'locked')),
  constraint ap_range  check (starts_on <= ends_on),
  constraint ap_closed check ((status = 'open') = (closed_at is null)),
  constraint ap_closed_by check ((closed_at is null) = (closed_by is null)),
  constraint ap_reopen check (
    reopened_at is null or (reopened_by is not null and reopen_reason is not null))
);
select app.apply_tenant_rls('app.accounting_period');

create index accounting_period_by_date
  on app.accounting_period (tenant_id, starts_on, ends_on);

create function app.accounting_period_forbid_overlap() returns trigger
language plpgsql as $$
declare
  v_fy record;
begin
  if exists (
    select 1 from app.accounting_period p
     where p.tenant_id = new.tenant_id
       and p.id       <> new.id
       and daterange(p.starts_on, p.ends_on, '[]')
        && daterange(new.starts_on, new.ends_on, '[]')
  ) then
    raise exception 'GL0011: accounting period % overlaps an existing period', new.seq
      using errcode = 'exclusion_violation';
  end if;

  -- A period outside its own fiscal year would put a document in a year the
  -- entry number is not gapless within (§5.2.5).
  select starts_on, ends_on into v_fy
    from app.fiscal_year
   where tenant_id = new.tenant_id and fy_code = new.fy_code;
  if new.starts_on < v_fy.starts_on or new.ends_on > v_fy.ends_on then
    raise exception 'GL0012: period % (% .. %) falls outside fiscal year % (% .. %)',
      new.seq, new.starts_on, new.ends_on, new.fy_code, v_fy.starts_on, v_fy.ends_on
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;
create trigger accounting_period_no_overlap
  before insert or update on app.accounting_period
  for each row execute function app.accounting_period_forbid_overlap();


-- ----------------------------------------------------------------------------
-- app.gl_account — the chart of accounts. STRUCTURE ONLY; no rows here.
--
-- `is_postable` is load-bearing rather than advisory: `journal_line` carries a
-- composite FK to (tenant_id, id, is_postable) with a CHECK that the flag is
-- true, so a rollup account cannot receive a line. The pleasing side-effect is
-- that flipping a POSTED-TO account to non-postable fails on the FK — you
-- cannot turn an account with history into a header (§5.4.2).
-- ----------------------------------------------------------------------------
create table app.gl_account (
  tenant_id             uuid        not null references platform.tenant (id),
  id                    uuid        not null,
  code                  text        not null,
  name                  text        not null,
  account_type          text        not null,
  normal_balance        char(1)     not null,
  parent_account_id     uuid,
  is_postable           boolean     not null,
  requires_counterparty text,
  control_account_kind  text,
  report_line_key       text        not null,
  is_active             boolean     not null default true,
  closed_at             date,
  -- Provenance only. NO code reads this to decide anything — that would be
  -- tenant identity by another name (CLAUDE.md §2.9).
  template_ref          text,
  created_at            timestamptz not null default transaction_timestamp(),
  updated_at            timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  unique (tenant_id, code),
  unique (tenant_id, id, is_postable),
  foreign key (tenant_id, parent_account_id) references app.gl_account (tenant_id, id),
  constraint ga_type check (account_type in ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
  -- Normal balance is DERIVED from type and stored for reporting. Storing it
  -- without this check is how a chart ends up with an income account whose
  -- normal balance is debit and a P&L with a sign error nobody can find.
  constraint ga_normal check (
    normal_balance = case when account_type in ('ASSET','EXPENSE') then 'D' else 'C' end),
  constraint ga_counterparty check (
    requires_counterparty is null
    or requires_counterparty in ('customer','supplier','employee')),
  constraint ga_control check (
    control_account_kind is null
    or control_account_kind in ('AR','AP','INVENTORY','BANK','MOMO','TILL')),
  constraint ga_no_self_parent check (parent_account_id is distinct from id)
);
select app.apply_tenant_rls('app.gl_account');

create index gl_account_by_parent on app.gl_account (tenant_id, parent_account_id);
create index gl_account_by_type on app.gl_account (tenant_id, account_type, code);


-- ----------------------------------------------------------------------------
-- app.gl_counter — the gapless entry number, per (tenant, fiscal year).
--
-- Gapless is affordable HERE and nowhere else in this system: a journal entry
-- is allocated SERVER-SIDE inside the posting transaction, under a row lock.
-- Receipt numbers cannot be gapless because a device allocates them offline
-- (03 §3.7.1); an entry number never leaves the server, so the coordination
-- that makes gapless impossible there is simply present here.
-- ----------------------------------------------------------------------------
create table app.gl_counter (
  tenant_id  uuid        not null references platform.tenant (id),
  fy_code    text        not null,
  next_no    bigint      not null default 1 check (next_no >= 1),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, fy_code),
  foreign key (tenant_id, fy_code) references app.fiscal_year (tenant_id, fy_code)
);
select app.apply_tenant_rls('app.gl_counter');

-- Only ever forward. A counter that can rewind reissues an entry number, and
-- an auditor reading two entries with the same number has no way to tell which
-- is which.
create function app.gl_counter_monotonic() returns trigger
language plpgsql as $$
begin
  if new.next_no < old.next_no then
    raise exception 'GL0013: gl_counter for % may not rewind (% -> %)',
      old.fy_code, old.next_no, new.next_no
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;
create trigger gl_counter_no_rewind
  before update on app.gl_counter
  for each row execute function app.gl_counter_monotonic();


-- ----------------------------------------------------------------------------
-- app.journal_entry — the header.
--
-- A `draft` entry is not the ledger; it is an entry being assembled. The
-- balance CHECK below gates the draft -> posted transition, which is the exact
-- moment balance becomes meaningful. Because lines are written while the entry
-- is draft and posting is a single UPDATE, no deferral is needed on the fast
-- path (§5.2.3 mechanism A).
-- ----------------------------------------------------------------------------
create table app.journal_entry (
  tenant_id            uuid        not null references platform.tenant (id),
  id                   uuid        not null,
  entry_no             bigint      not null check (entry_no >= 1),
  period_id            uuid        not null,
  fy_code              text        not null,
  document_date        date        not null,
  posted_at            timestamptz,
  status               text        not null default 'draft',
  source_kind          text        not null,
  source_id            uuid,
  idempotency_key      text        not null,
  -- An auditor asking "why did this sale post like that in March" needs the
  -- rule set as it stood in March, not as it stands today. Two integers buy
  -- that, and they are cheaper than reconstructing it from git.
  posting_rule_version int         not null,
  mapping_set_version  int         not null,
  is_late_arrival      boolean     not null default false,
  memo                 text,
  created_by           uuid        not null,
  reverses_entry_id    uuid,
  reversed_by_entry_id uuid,

  -- Derived, maintained by trigger from journal_line. See the WARNING on
  -- mechanism B below: these can lie, which is why they are not the only
  -- thing standing between this table and an unbalanced ledger.
  debit_total_minor    bigint      not null default 0 check (debit_total_minor >= 0),
  credit_total_minor   bigint      not null default 0 check (credit_total_minor >= 0),
  line_count           int         not null default 0 check (line_count >= 0),

  created_at           timestamptz not null default transaction_timestamp(),
  updated_at           timestamptz not null default transaction_timestamp(),

  primary key (tenant_id, id),
  unique (tenant_id, source_kind, idempotency_key),
  -- Gapless WITHIN a fiscal year. `unique (tenant_id, entry_no)` would collide
  -- on FY2's entry 1 the moment the counter resets annually.
  unique (tenant_id, fy_code, entry_no),
  foreign key (tenant_id, period_id) references app.accounting_period (tenant_id, id),
  foreign key (tenant_id, fy_code) references app.fiscal_year (tenant_id, fy_code),
  foreign key (tenant_id, reverses_entry_id) references app.journal_entry (tenant_id, id),
  foreign key (tenant_id, reversed_by_entry_id) references app.journal_entry (tenant_id, id),
  constraint je_status check (status in ('draft','posted')),
  constraint je_posted_balanced check (
    status = 'draft'
    or (line_count >= 2
        and debit_total_minor = credit_total_minor
        and debit_total_minor > 0)
  ),
  constraint je_posted_has_time check ((status = 'draft') = (posted_at is null)),
  constraint je_no_self_reversal check (reverses_entry_id is distinct from id)
);
select app.apply_tenant_rls('app.journal_entry');

-- One reversal per entry, ever. Reversing a reversal twice is how a ledger
-- ends up with three entries and no agreed answer.
create unique index je_one_reversal
  on app.journal_entry (tenant_id, reverses_entry_id)
  where reverses_entry_id is not null;

-- One entry per source document, ever — the double-posting §5.2.4 claims to
-- prevent. Without this, two entries may reference the same document under
-- different idempotency keys and both post. Reversals are excluded because a
-- reversal legitimately names the same source as the entry it reverses.
create unique index je_one_per_source
  on app.journal_entry (tenant_id, source_kind, source_id)
  where source_id is not null and reverses_entry_id is null;

create index je_by_period on app.journal_entry (tenant_id, period_id, status);
create index je_by_document_date on app.journal_entry (tenant_id, document_date);


-- ----------------------------------------------------------------------------
-- app.journal_line — where double entry actually lives.
--
-- Two non-negative columns, exactly one non-zero. Not a signed amount: sign
-- convention is implicit, three-sided transactions degrade into "the amount
-- plus some other columns", and there is nothing for the database to balance
-- (§5.2.1).
-- ----------------------------------------------------------------------------
create table app.journal_line (
  tenant_id         uuid        not null references platform.tenant (id),
  journal_entry_id  uuid        not null,
  line_no           int         not null check (line_no >= 1),
  account_id        uuid        not null,
  -- Carried so the composite FK below can force it true. Not a copy anyone
  -- reads; a key the database checks (§5.4.2).
  account_postable  boolean     not null default true,
  -- THE DIMENSION, and it is NOT NULL. An entry balances per location, so a
  -- line with no location has nothing to balance against (§5.5.2).
  location_id       uuid        not null,
  debit_minor       bigint      not null default 0,
  credit_minor      bigint      not null default 0,
  currency_code     char(3)     not null,
  counterparty_kind text,
  counterparty_id   uuid,
  product_id        uuid,
  source_line_id    uuid,
  memo              text,
  created_at        timestamptz not null default transaction_timestamp(),

  primary key (tenant_id, journal_entry_id, line_no),
  foreign key (tenant_id, journal_entry_id)
    references app.journal_entry (tenant_id, id) on delete cascade,
  foreign key (tenant_id, account_id, account_postable)
    references app.gl_account (tenant_id, id, is_postable),
  foreign key (tenant_id, location_id) references app.location (tenant_id, id),
  -- Rejects both-zero AND both-non-zero. A zero line carries no information;
  -- if a tax component computes to nil the rule emits no line rather than a
  -- zero one, which keeps sum(debit) - sum(credit) meaningful with no FILTER
  -- clause anywhere in the reporting layer.
  constraint jl_one_side     check ((debit_minor = 0) <> (credit_minor = 0)),
  constraint jl_non_negative check (debit_minor >= 0 and credit_minor >= 0),
  constraint jl_postable     check (account_postable),
  constraint jl_counterparty check (
    counterparty_kind is null
    or (counterparty_kind in ('customer','supplier','employee') and counterparty_id is not null))
);
select app.apply_tenant_rls('app.journal_line');

create index jl_by_account on app.journal_line (tenant_id, account_id, journal_entry_id);
create index jl_by_location on app.journal_line (tenant_id, location_id, account_id);
create index jl_by_counterparty on app.journal_line (tenant_id, counterparty_kind, counterparty_id)
  where counterparty_id is not null;


-- ============================================================================
-- BALANCE, ENFORCED TWICE
--
-- The brief asks for "a deferred constraint, a trigger, or a check on a
-- derived aggregate". One clarification first, because it is the thing
-- everyone reaches for and it does not exist: **a deferred CHECK constraint is
-- not a Postgres feature.** Only UNIQUE, PRIMARY KEY, FOREIGN KEY and EXCLUDE
-- accept DEFERRABLE. What is available is CREATE CONSTRAINT TRIGGER ...
-- DEFERRABLE INITIALLY DEFERRED, which is a different object.
--
-- So both are built, and they fail differently on purpose.
-- ============================================================================

-- ── MECHANISM A: maintain the header aggregates the CHECK reads. ───────────
create function app.gl_sync_entry_totals() returns trigger
language plpgsql as $$
declare
  v_tenant uuid;
  v_entry  uuid;
begin
  if tg_op = 'DELETE' then
    v_tenant := old.tenant_id; v_entry := old.journal_entry_id;
  else
    v_tenant := new.tenant_id; v_entry := new.journal_entry_id;
  end if;

  update app.journal_entry e
     set debit_total_minor  = coalesce(s.d, 0),
         credit_total_minor = coalesce(s.c, 0),
         line_count         = coalesce(s.n, 0),
         updated_at         = transaction_timestamp()
    from (select sum(debit_minor) d, sum(credit_minor) c, count(*) n
            from app.journal_line
           where tenant_id = v_tenant and journal_entry_id = v_entry) s
   where e.tenant_id = v_tenant and e.id = v_entry;

  return null;
end
$$;

create trigger journal_line_sync_totals
  after insert or update or delete on app.journal_line
  for each row execute function app.gl_sync_entry_totals();


-- ── MECHANISM B: recompute from the lines at COMMIT. ───────────────────────
--
-- WHY A SECOND MECHANISM AT ALL. Mechanism A's CHECK tests a DERIVED column,
-- and derived columns can lie. A direct `UPDATE journal_entry SET
-- debit_total_minor = ...` by a superuser, a migration run under
-- `session_replication_role = replica` (which disables ordinary triggers), or
-- a bug in the maintaining trigger all produce a header that satisfies the
-- CHECK while the lines beneath it do not balance. A CONSTRAINT trigger still
-- fires under `replica` when declared, and it recomputes rather than trusting.
--
-- It also enforces the thing the header cannot see at all: balance PER
-- LOCATION (§5.5.3). An entry whose debits and credits agree in total but not
-- within each location produces a consolidated balance sheet that balances and
-- per-location ones that do not — which is the whole point of the dimension.
create function app.gl_assert_entry_balanced() returns trigger
language plpgsql as $$
declare
  v_tenant uuid;
  v_entry  uuid;
  v_status text;
  v_bad    record;
begin
  if tg_op = 'DELETE' then
    v_tenant := old.tenant_id; v_entry := old.journal_entry_id;
  else
    v_tenant := new.tenant_id; v_entry := new.journal_entry_id;
  end if;

  select e.status into v_status
    from app.journal_entry e
   where e.tenant_id = v_tenant and e.id = v_entry;

  -- THE PARENT IS GONE.
  --
  -- §5.2.3 says to fail closed here, reasoning that a cascading DELETE of a
  -- POSTED entry leaves no parent at COMMIT and an early `return null` would
  -- pass silently. **That rule cannot work in a DEFERRED trigger, and building
  -- it proved it.** Two reasons, the second of which is decisive:
  --
  --   1. A draft parent and a posted parent are indistinguishable once gone —
  --      both are simply absent — so failing closed also makes it impossible
  --      to DISCARD A DRAFT, which is an ordinary thing to do.
  --   2. A deferred constraint trigger queues an event per affected row at
  --      STATEMENT time and fires them all at COMMIT. Inserting two lines and
  --      then discarding their draft entry in the same transaction leaves two
  --      queued INSERT events whose parent is gone by the time they run. So
  --      the absence is not even correlated with the operation: restricting
  --      the pass to `tg_op = 'DELETE'` still fails on the INSERT events from
  --      the same transaction.
  --
  -- The guard belongs on the operation being guarded, where the parent's
  -- status is still readable. `journal_entry_immutable` (BEFORE DELETE)
  -- refuses to delete a posted entry at all (GL0020), and it is declared
  -- ENABLE ALWAYS at the foot of this file, so it survives
  -- `session_replication_role = replica` — the only way the cascade this rule
  -- feared could ever start. With that closed at its source, an absent parent
  -- here means the entry was discarded while still a draft, and there is
  -- nothing left to assert about it.
  if not found then
    return null;
  end if;

  -- A draft is not the ledger. It is allowed to be in progress.
  if v_status = 'draft' then
    return null;
  end if;

  for v_bad in
    select l.location_id,
           sum(l.debit_minor)  as dr,
           sum(l.credit_minor) as cr
      from app.journal_line l
     where l.tenant_id = v_tenant and l.journal_entry_id = v_entry
     group by l.location_id
    having sum(l.debit_minor) <> sum(l.credit_minor)
  loop
    raise exception 'GL0001: entry % unbalanced at location % (Dr % / Cr %)',
      v_entry, v_bad.location_id, v_bad.dr, v_bad.cr
      using errcode = 'integrity_constraint_violation';
  end loop;

  perform 1
     from app.journal_entry e
     join (select sum(debit_minor) d, sum(credit_minor) c, count(*) n
             from app.journal_line
            where tenant_id = v_tenant and journal_entry_id = v_entry) s on true
    where e.tenant_id = v_tenant and e.id = v_entry
      and (e.debit_total_minor, e.credit_total_minor, e.line_count)
          is distinct from (s.d, s.c, s.n::int);
  if found then
    raise exception 'GL0002: entry % header totals do not match its lines', v_entry
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end
$$;

create constraint trigger journal_line_balanced
  after insert or update or delete on app.journal_line
  deferrable initially deferred
  for each row execute function app.gl_assert_entry_balanced();

-- The entry-side entry point for the same assertion. `gl_assert_entry_balanced`
-- reads its target off a journal_line row; this reads it off the entry itself
-- and then does the identical work, so there is one balance rule and not two.
create function app.gl_assert_posted_entry() returns trigger
language plpgsql as $$
declare
  v_bad record;
begin
  for v_bad in
    select l.location_id,
           sum(l.debit_minor)  as dr,
           sum(l.credit_minor) as cr
      from app.journal_line l
     where l.tenant_id = new.tenant_id and l.journal_entry_id = new.id
     group by l.location_id
    having sum(l.debit_minor) <> sum(l.credit_minor)
  loop
    raise exception 'GL0001: entry % unbalanced at location % (Dr % / Cr %)',
      new.id, v_bad.location_id, v_bad.dr, v_bad.cr
      using errcode = 'integrity_constraint_violation';
  end loop;

  perform 1
     from (select sum(debit_minor) d, sum(credit_minor) c, count(*) n
             from app.journal_line
            where tenant_id = new.tenant_id and journal_entry_id = new.id) s
    where (new.debit_total_minor, new.credit_total_minor, new.line_count)
          is distinct from (s.d, s.c, s.n::int);
  if found then
    raise exception 'GL0002: entry % header totals do not match its lines', new.id
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end
$$;

-- The same assertion, fired when the ENTRY moves to posted. Without this, an
-- entry posted in a transaction that touched no line since its lines were
-- written would never be re-checked by mechanism B at all.
create constraint trigger journal_entry_balanced
  after update on app.journal_entry
  deferrable initially deferred
  for each row
  when (new.status = 'posted')
  execute function app.gl_assert_posted_entry();


-- ── One currency per tenant, asserted rather than assumed. ─────────────────
--
-- ADR-0007 gives a tenant exactly one jurisdiction and puts FX out of scope,
-- so `currency_code` is redundant today. It is carried anyway because
-- retrofitting a currency column into a POPULATED ledger is far worse than
-- carrying a constrained one — and a genuine multi-currency ledger needs
-- transaction + functional amounts and a rate per line, which is a different
-- schema, not a nullable extra column.
create function app.gl_assert_line_currency() returns trigger
language plpgsql as $$
declare
  v_currency char(3);
begin
  select j.currency_code into v_currency
    from platform.tenant t
    join platform.jurisdiction j on j.code = t.jurisdiction_code
   where t.id = new.tenant_id;

  if v_currency is null then
    raise exception 'GL0004: tenant % has no jurisdiction pack, so no ledger currency', new.tenant_id
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.currency_code <> v_currency then
    raise exception 'GL0005: line currency % is not this tenant''s ledger currency %',
      new.currency_code, v_currency
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger journal_line_currency
  before insert or update on app.journal_line
  for each row execute function app.gl_assert_line_currency();


-- ============================================================================
-- IMMUTABILITY (§5.3)
--
-- "No fix the typo." A posted entry is a fact that was true; a correction is a
-- reversing entry plus a replacement, and both stay in the audit trail.
--
-- Enforced by TRIGGER here. The privilege half — REVOKE UPDATE, DELETE on the
-- journal tables from the application role — belongs with the role grants and
-- is applied there; the trigger is written first because a REVOKE is silent
-- for a superuser and a trigger raises for everyone.
-- ============================================================================

create function app.gl_entry_immutable() returns trigger
language plpgsql as $$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' then
      raise exception 'GL0020: posted entry % cannot be deleted — reverse it instead', old.id
        using errcode = 'integrity_constraint_violation';
    end if;
    return old;
  end if;

  -- draft -> posted is the one transition that writes. Everything it is
  -- allowed to touch is named here; anything else is refused.
  if old.status = 'draft' then
    if new.status = 'posted' and new.posted_at is not null then
      return new;
    end if;
    if new.status = 'draft' then
      return new;
    end if;
    raise exception 'GL0021: entry % may only move from draft to posted, and must carry posted_at', old.id
      using errcode = 'integrity_constraint_violation';
  end if;

  -- Already posted. The ONLY permitted change is recording that a reversal was
  -- written against it — which the reversing entry does, once, on its way in.
  v_before := to_jsonb(old) - 'reversed_by_entry_id' - 'updated_at';
  v_after  := to_jsonb(new) - 'reversed_by_entry_id' - 'updated_at';
  if v_before is distinct from v_after then
    raise exception
      'GL0022: posted entry % is immutable — corrections are reversing entries, never edits', old.id
      using errcode = 'integrity_constraint_violation';
  end if;
  if old.reversed_by_entry_id is not null
     and new.reversed_by_entry_id is distinct from old.reversed_by_entry_id then
    raise exception 'GL0023: entry % is already reversed by %', old.id, old.reversed_by_entry_id
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger journal_entry_immutable
  before update or delete on app.journal_entry
  for each row execute function app.gl_entry_immutable();


create function app.gl_line_immutable() returns trigger
language plpgsql as $$
declare
  v_status text;
  v_entry  uuid;
begin
  v_entry := case when tg_op = 'DELETE' then old.journal_entry_id else new.journal_entry_id end;

  select status into v_status
    from app.journal_entry
   where tenant_id = case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end
     and id = v_entry;

  -- The parent is already gone: this is the ON DELETE CASCADE from a DRAFT
  -- entry being discarded, which is legitimate. A posted entry cannot be
  -- deleted at all (GL0020), so no cascade can reach a posted line.
  if not found then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if v_status = 'posted' then
    raise exception
      'GL0024: lines of posted entry % are immutable — corrections are reversing entries', v_entry
      using errcode = 'integrity_constraint_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create trigger journal_line_immutable
  before update or delete on app.journal_line
  for each row execute function app.gl_line_immutable();


-- ============================================================================
-- WHAT IS DELIBERATELY NOT IN THIS FILE
--
--   * No gl_account rows. Not one. The chart of accounts is CONTENT and it is
--     blocked on the §2.8 accountant review (open-questions Q6).
--   * No posting rules and no account mappings.
--   * No fiscal year or period rows for any tenant — a tenant's calendar is a
--     decision, and 1 August is tenant #1's, not the platform's.
--   * No opening balances.
--   * Nothing in `packages/db/src/seed/template.ts`.
--
-- Migration 0015 makes a ledger POSSIBLE. It does not make one.
-- ============================================================================


-- ============================================================================
-- SURVIVING `session_replication_role = replica`
--
-- That setting exists so a replica can apply changes without re-firing
-- triggers, and it is also how a careless migration or a restore silences
-- every guard in this file at once. `ENABLE ALWAYS` is what makes a trigger
-- fire in that mode too.
--
-- These five are the ledger's guarantees. They are not conveniences that a
-- maintenance window may switch off:
--
--   * a posted entry is immutable and cannot be deleted
--   * a posted line is immutable
--   * an entry balances, per location, against its own lines
--
-- The aggregate-maintaining trigger is deliberately NOT `ALWAYS`: it is a
-- convenience that keeps a derived column current, and mechanism B recomputes
-- from the lines rather than trusting it. If it is ever silenced, the ledger
-- fails loudly at COMMIT instead of quietly carrying a header that lies.
-- ============================================================================
alter table app.journal_entry enable always trigger journal_entry_immutable;
alter table app.journal_line  enable always trigger journal_line_immutable;
alter table app.journal_line  enable always trigger journal_line_balanced;
alter table app.journal_entry enable always trigger journal_entry_balanced;
alter table app.journal_line  enable always trigger journal_line_currency;
