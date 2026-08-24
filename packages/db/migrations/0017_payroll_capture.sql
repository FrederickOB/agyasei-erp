-- ============================================================================
-- 0017 — PAYROLL: CAPTURE ONLY
--
-- CLAUDE.md §2.4, which is categorical and not open to a "temporary"
-- exception, an "estimate", or a "preview":
--
--   The system records hours, roles, gross pay and commissions, and produces a
--   payroll register. It MUST NOT contain PAYE brackets, social-security
--   rates, or any statutory withholding logic — IN ANY JURISDICTION.
--
--   capture -> export to the bureau -> they compute -> their figures are
--   re-imported into clearly marked fields -> net pay is ENTERED, not
--   calculated.
--
-- This migration is the schema that makes that boundary ENFORCEABLE rather
-- than merely stated. Three mechanisms, and none of them is a comment:
--
--   1. the `bureau_` prefix, which a CI lint keys off (tools/lint-payroll.mjs)
--   2. a CHECK that a period cannot be complete on a partial return
--   3. a TRIGGER that refuses any write to a bureau_* column that does not
--      arrive with an import created in the same transaction
--
-- ── THE ARGUMENT THIS FILE PRE-EMPTS ──────────────────────────────────────
-- lint-payroll-ignore — names the thing in order to prohibit it
-- Someone will propose an effective-dated PAYE band table by analogy with the
-- tax pack (ADR-0002). Reject it, and never build it. §2.4 prohibits statutory payroll calculation
-- CATEGORICALLY, not merely in hard-coded form: a configurable withholding
-- table is still statutory withholding logic living unmaintained inside custom
-- software, and unlike a stale VAT rate — which is visibly wrong on a receipt
-- handed over today — its failure is silent until a third party discovers an
-- under-remittance months later, at a filing deadline.
--
-- There is deliberately NO rate column, NO bracket table and NO percentage
-- anywhere in this file.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- app.employee — staff records. CAPTURE, and nothing statutory.
--
-- No tax identifier is stored here and none is needed: the register carries
-- the tenant's own employer reference and the bureau matches on its own
-- records. Adding a national ID or a tax number would put statutory identity
-- in a system that has no statutory role.
-- ----------------------------------------------------------------------------
create table app.employee (
  tenant_id       uuid        not null references platform.tenant (id),
  id              uuid        not null,
  write_id        uuid        not null,
  hlc             app.hlc     not null,
  created_at      timestamptz not null default transaction_timestamp(),
  updated_at      timestamptz not null default transaction_timestamp(),
  deleted_at      timestamptz,
  -- The tenant's own staff number. Their word, their format.
  staff_ref       text        not null,
  display_name    text        not null,
  -- Where this person's cost belongs. Payroll posts at the EMPLOYEE's
  -- location, which is why rule 9b needs a clearing pair when someone else
  -- pays them (05 §5.6.2).
  location_id     uuid        not null,
  -- Tenant vocabulary: 'Counter staff', 'Driver'. Nothing branches on it.
  job_title       text,
  started_on      date        not null,
  ended_on        date,
  is_active       boolean     not null default true,
  primary key (tenant_id, id),
  unique (tenant_id, staff_ref),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id),
  constraint emp_dates check (ended_on is null or ended_on >= started_on)
);
select app.apply_tenant_rls('app.employee');
create index employee_by_location on app.employee (tenant_id, location_id, is_active);


-- ----------------------------------------------------------------------------
-- app.pay_period — the unit of the whole cycle.
--
-- `status` walks one way: open -> exported -> returned -> posted -> paid. A
-- period cannot be exported twice, and cannot be posted before the bureau's
-- figures are in.
-- ----------------------------------------------------------------------------
create table app.pay_period (
  tenant_id        uuid        not null references platform.tenant (id),
  id               uuid        not null,
  code             text        not null,
  starts_on        date        not null,
  ends_on          date        not null,
  status           text        not null default 'open',
  exported_at      timestamptz,
  returned_at      timestamptz,
  posted_at        timestamptz,
  paid_at          timestamptz,
  journal_entry_id uuid,
  created_at       timestamptz not null default transaction_timestamp(),
  updated_at       timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  unique (tenant_id, code),
  foreign key (tenant_id, journal_entry_id) references app.journal_entry (tenant_id, id),
  constraint pp_status check (status in ('open','exported','returned','posted','paid')),
  constraint pp_range check (starts_on <= ends_on),
  constraint pp_exported check ((status = 'open') = (exported_at is null)),
  constraint pp_posted check ((posted_at is null) or (journal_entry_id is not null))
);
select app.apply_tenant_rls('app.pay_period');


-- ----------------------------------------------------------------------------
-- app.payroll_bureau_import — one file, one row, and the ONLY authority for a
-- bureau figure.
--
-- Every `bureau_*` value on a payroll entry points at one of these. The
-- trigger below refuses a bureau write whose import row was not created in the
-- same transaction, which is what stops a figure being edited later "just to
-- fix one number" — the exact path by which a system that records starts
-- quietly calculating.
-- ----------------------------------------------------------------------------
create table app.payroll_bureau_import (
  tenant_id     uuid        not null references platform.tenant (id),
  id            uuid        not null,
  pay_period_id uuid        not null,
  -- Who supplied the figures, in the tenant's own words, and what they sent.
  bureau_ref    text        not null,
  file_name     text,
  file_digest   text        not null,
  imported_by   uuid        not null,
  imported_at   timestamptz not null default transaction_timestamp(),
  -- Control totals AS STATED BY THE BUREAU, checked against the sum of the
  -- lines. Stored so a later dispute can be settled against what they sent
  -- rather than against what we computed from it.
  stated_gross_minor            bigint not null,
  stated_employee_tax_minor     bigint not null,
  stated_employee_social_minor  bigint not null,
  stated_other_minor            bigint not null,
  stated_employer_social_minor  bigint not null,
  stated_net_minor              bigint not null,
  created_at    timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id),
  foreign key (tenant_id, pay_period_id) references app.pay_period (tenant_id, id)
);
select app.apply_tenant_rls('app.payroll_bureau_import');


-- ----------------------------------------------------------------------------
-- app.payroll_entry — one employee, one period.
--
-- The column split is the whole design. Above the line, what the SYSTEM
-- captured and may compute (05 §5.8.4: commission from its own sales data at a
-- tenant-set rate, overtime at a tenant-set multiplier, allowances from a
-- tenant-set schedule, and gross as their sum — business policy the tenant
-- owns and can restate at will).
--
-- Below it, what the BUREAU returned. NULL until import. No default, no
-- fallback, no estimate. Their error surfaces at somebody else's filing
-- deadline, which is exactly why this software must not produce them.
-- ----------------------------------------------------------------------------
create table app.payroll_entry (
  tenant_id     uuid        not null references platform.tenant (id),
  pay_period_id uuid        not null,
  employee_id   uuid        not null,
  location_id   uuid        not null,

  -- ── CAPTURED BY THE SYSTEM ──────────────────────────────────────────────
  -- Hours are a SCALED INTEGER with the scale stated, never a float
  -- (ADR-0004). 2 decimal places: 7.50 hours is 750.
  hours_worked_scaled bigint  not null default 0 check (hours_worked_scaled >= 0),
  hours_scale         smallint not null default 2 check (hours_scale between 0 and 4),
  base_pay_minor      bigint  not null default 0 check (base_pay_minor >= 0),
  overtime_minor      bigint  not null default 0 check (overtime_minor >= 0),
  commission_minor    bigint  not null default 0 check (commission_minor >= 0),
  allowances_minor    bigint  not null default 0 check (allowances_minor >= 0),
  gross_pay_minor     bigint  not null default 0 check (gross_pay_minor >= 0),

  -- ── RETURNED BY THE BUREAU ──────────────────────────────────────────────
  bureau_employee_tax_minor     bigint,
  bureau_employee_social_minor  bigint,
  bureau_other_deductions_minor bigint,
  bureau_employer_social_minor  bigint,
  bureau_net_pay_minor          bigint,
  bureau_import_id              uuid,

  created_at    timestamptz not null default transaction_timestamp(),
  updated_at    timestamptz not null default transaction_timestamp(),

  primary key (tenant_id, pay_period_id, employee_id),
  foreign key (tenant_id, pay_period_id) references app.pay_period (tenant_id, id),
  foreign key (tenant_id, employee_id) references app.employee (tenant_id, id),
  foreign key (tenant_id, location_id) references app.location (tenant_id, id),
  foreign key (tenant_id, bureau_import_id) references app.payroll_bureau_import (tenant_id, id),

  -- Gross IS the sum of its parts. The system computes this one and is allowed
  -- to (05 §5.8.4), so the database checks it rather than trusting a caller.
  constraint pe_gross_sums check (
    gross_pay_minor = base_pay_minor + overtime_minor + commission_minor + allowances_minor),

  -- ALL OR NOTHING. A partial return is not a return: a period that posted on
  -- four figures out of five would book a net pay nobody supplied.
  constraint pe_bureau_complete check (
    bureau_import_id is null
    or (bureau_employee_tax_minor     is not null
    and bureau_employee_social_minor  is not null
    and bureau_other_deductions_minor is not null
    and bureau_employer_social_minor  is not null
    and bureau_net_pay_minor          is not null)),

  -- …and a bureau figure without an import is a figure from nowhere.
  constraint pe_bureau_needs_import check (
    bureau_import_id is not null
    or (bureau_employee_tax_minor     is null
    and bureau_employee_social_minor  is null
    and bureau_other_deductions_minor is null
    and bureau_employer_social_minor  is null
    and bureau_net_pay_minor          is null)),

  constraint pe_bureau_non_negative check (
    coalesce(bureau_employee_tax_minor, 0)     >= 0
    and coalesce(bureau_employee_social_minor, 0)  >= 0
    and coalesce(bureau_other_deductions_minor, 0) >= 0
    and coalesce(bureau_employer_social_minor, 0)  >= 0
    and coalesce(bureau_net_pay_minor, 0)          >= 0)
);
select app.apply_tenant_rls('app.payroll_entry');
create index payroll_entry_by_period on app.payroll_entry (tenant_id, pay_period_id);


-- ============================================================================
-- THE TRIGGER THAT MAKES THE BOUNDARY REAL
--
-- §5.8.1: "a BEFORE UPDATE trigger rejects any change to a bureau_* column
-- unless bureau_import_id references a payroll_bureau_import row created in
-- this transaction."
--
-- Without it the columns are merely NAMED after their source. With it, a
-- bureau figure can only enter alongside the file it came from — so there is
-- no path by which somebody edits one later "just to fix a number", which is
-- precisely how a system that records begins to calculate.
--
-- `transaction_timestamp()` is the test rather than `clock_timestamp()`
-- because it is constant across the transaction: the import row and the entry
-- writes share it exactly.
-- ============================================================================
create function app.payroll_bureau_write_guard() returns trigger
language plpgsql as $$
declare
  v_changed boolean;
  v_import_at timestamptz;
begin
  v_changed :=
    new.bureau_employee_tax_minor     is distinct from old.bureau_employee_tax_minor
    or new.bureau_employee_social_minor  is distinct from old.bureau_employee_social_minor
    or new.bureau_other_deductions_minor is distinct from old.bureau_other_deductions_minor
    or new.bureau_employer_social_minor  is distinct from old.bureau_employer_social_minor
    or new.bureau_net_pay_minor          is distinct from old.bureau_net_pay_minor
    or new.bureau_import_id              is distinct from old.bureau_import_id;

  if not v_changed then
    return new;
  end if;

  if new.bureau_import_id is null then
    raise exception
      'PR0001: a bureau figure cannot be cleared or set without an import — §2.4 makes these fields the bureau''s, not ours'
      using errcode = 'integrity_constraint_violation';
  end if;

  select created_at into v_import_at
    from app.payroll_bureau_import
   where tenant_id = new.tenant_id and id = new.bureau_import_id;

  if not found then
    raise exception 'PR0002: bureau_import_id % does not exist', new.bureau_import_id
      using errcode = 'integrity_constraint_violation';
  end if;

  if v_import_at <> transaction_timestamp() then
    raise exception
      'PR0003: bureau figures may only be written in the same transaction as the import that supplied them (import %)',
      new.bureau_import_id
      using errcode = 'integrity_constraint_violation';
  end if;

  return new;
end
$$;

create trigger payroll_entry_bureau_guard
  before update on app.payroll_entry
  for each row execute function app.payroll_bureau_write_guard();
alter table app.payroll_entry enable always trigger payroll_entry_bureau_guard;

-- The same rule on the way in. An INSERT carrying bureau figures must carry
-- its import too, and that import must be this transaction's.
create function app.payroll_bureau_insert_guard() returns trigger
language plpgsql as $$
declare
  v_import_at timestamptz;
begin
  if new.bureau_import_id is null then
    return new;
  end if;
  select created_at into v_import_at
    from app.payroll_bureau_import
   where tenant_id = new.tenant_id and id = new.bureau_import_id;
  if not found or v_import_at <> transaction_timestamp() then
    raise exception
      'PR0003: bureau figures may only be written in the same transaction as the import that supplied them'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger payroll_entry_bureau_insert_guard
  before insert on app.payroll_entry
  for each row execute function app.payroll_bureau_insert_guard();
alter table app.payroll_entry enable always trigger payroll_entry_bureau_insert_guard;


-- ============================================================================
-- WHAT IS DELIBERATELY ABSENT, AND WILL STAY ABSENT
--
--   * No rate, band, bracket, threshold or percentage column, anywhere.
--   * No table a withholding schedule could be configured into.
--   * No default and no fallback on any bureau_* column — a missing figure
--     stays missing and blocks the post, rather than becoming a zero that
--     under-remits silently.
--   * No employee tax identifier: statutory identity belongs with whoever has
--     a statutory role, and this software has none.
--
-- The employer social security contribution IS recorded — it is a company
-- expense with its own expense line and its own payable (rule 9) — and the
-- amount arrives from the bureau like every other figure. Reading §2.4 as "so
-- we don't need an employer social security account" is a misreading: the
-- prohibition is on computing the figure, not on booking it, and omitting the
-- account understates staff costs.
-- ============================================================================
