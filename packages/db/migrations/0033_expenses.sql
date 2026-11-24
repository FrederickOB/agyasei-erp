-- ============================================================================
-- 0033 — BUSINESS EXPENSES, RECORDED AS OPERATIONAL DOCUMENTS
--
-- The founder's ask: "add expenses too and calculate our actual P&L". The
-- general ledger exists (0015/0016) but its CONTENT — the chart of accounts,
-- account mappings, a costing method, any manual journal — is Track B, and
-- Track B is BLOCKED until a named qualified accountant exists (CLAUDE.md
-- §2.8; open-questions Q6, Q16; docs/phase3-status.md "Deliberately absent").
--
-- So an expense here is an OPERATIONAL RECORD, exactly as payroll capture is
-- (CLAUDE.md §2.4): what was paid, when, where, to whom, from which pot. It is
-- NOT a journal entry. NOTHING IN THIS FILE, AND NOTHING THAT WRITES THESE
-- TABLES, INSERTS INTO app.journal_entry / app.journal_line, NAMES AN ACCOUNT,
-- OR ADDS A POSTING RULE. No posting sweep reads them. When the accountant's
-- chart exists, mapping an expense category to an account is a Track B
-- decision with its own review; until then these rows feed only the
-- MANAGEMENT P&L sheet (apps/api/src/routers/expenses.ts `profitSheet`), whose
-- copy says plainly that it is not the audited ledger.
--
-- THREE TABLES:
--
--  · app.expense_category — the tenant's own words for what it spends on
--    (rent, fuel, electricity, …). Ordinary, editable tenant rows. The
--    migration seeds NONE: a platform migration never writes tenant content
--    (ADR-0006). Categories are created on first use, from the expense form,
--    and a name is matched case-insensitively so "Fuel" and "fuel" are one.
--
--  · app.expense — one settled payment. IMMUTABLE: append-only, never deleted
--    (deleted_at is always null). Money is `app.money_minor` (bigint) in the
--    currency's minor unit, with the currency code and minor-unit scale
--    SNAPSHOTTED from the tenant's jurisdiction pack at the moment of
--    recording — exactly as app.sale does (0004) — so the row reads the same
--    after any pack change. Never assume 100 (CLAUDE.md §2.3).
--    `location_id` NULL means "the whole business" (head-office rent, the
--    accountant's fee): attributable to no single outlet, and reported only
--    in the consolidated figure, never apportioned.
--
--  · app.expense_void — the correction. An expense recorded wrongly is VOIDED
--    (with a reason, by a named person) and recorded again; it is never
--    edited. Void status is DERIVED from the existence of this row, like a
--    sale's (0030). One void per expense, enforced by a unique index.
--
-- Server-only, deliberately: none of these is in a device sync bucket. An
-- expense is an office act against a live server (offline_mode 'never').
-- ============================================================================

insert into platform.permission
  (code, domain, description, is_sensitive, requires_fresh_authorization, bound_schema, offline_mode)
values
  ('expense.record', 'expense',
   'Record a business expense (rent, utilities, fuel, …) at a location or for the whole business, and void one recorded in error.',
   -- Not sensitive and not fresh: it moves no stock, sets no price and posts
   -- nothing to the ledger. Never offline: an office act against a live
   -- server, and the expense tables are in no sync bucket.
   false, false, null, 'never')
on conflict (code) do nothing;


-- ----------------------------------------------------------------------------
-- 1. app.expense_category — tenant vocabulary, editable.
-- ----------------------------------------------------------------------------
create table app.expense_category (
  tenant_id   uuid        not null references platform.tenant (id),
  id          uuid        not null,
  write_id    uuid        not null,
  hlc         app.hlc     not null,
  created_at  timestamptz not null default transaction_timestamp(),
  updated_at  timestamptz not null default transaction_timestamp(),
  deleted_at  timestamptz,
  -- The tenant's own short code, optional (an accountant may want one later).
  -- NULL for a category created from the expense form. The NAME is the key.
  code        text,
  name        text        not null,
  sort_order  integer     not null default 0,
  is_active   boolean     not null default true,
  constraint ec_name_shape check (length(btrim(name)) between 1 and 80 and name = btrim(name)),
  constraint ec_code_shape check (code is null or length(btrim(code)) between 1 and 40),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
-- "Fuel" and "fuel" are one category, among the live rows.
create unique index expense_category_name_uq
  on app.expense_category (tenant_id, lower(name)) where deleted_at is null;
select app.apply_tenant_rls('app.expense_category');

comment on table app.expense_category is
  'The tenant''s own expense categories (0033). Tenant data, created on first use; no migration seeds any. Unique on lower(name) among live rows.';


-- ----------------------------------------------------------------------------
-- 2. app.expense — one settled payment. Append-only.
-- ----------------------------------------------------------------------------
create table app.expense (
  tenant_id      uuid        not null references platform.tenant (id),
  id             uuid        not null,
  write_id       uuid        not null,
  hlc            app.hlc     not null,
  created_at     timestamptz not null default transaction_timestamp(),
  updated_at     timestamptz not null default transaction_timestamp(),
  deleted_at     timestamptz,
  location_id    uuid,                     -- NULL = the whole business
  category_id    uuid        not null,
  expense_date   date        not null,     -- the business date it was paid
  amount_minor   app.money_minor not null, -- minor units of currency_code
  currency_code  char(3)     not null,     -- snapshot from the pack
  money_scale    bigint      not null,     -- snapshot of minor_units_per_major. NEVER assume 100.
  paid_from      text        not null,     -- platform vocabulary
  payee          text,
  reference      text,
  note           text,
  recorded_by    uuid        not null,     -- from the verified token
  constraint ex_deleted_never check (deleted_at is null),
  constraint ex_amount_positive check (amount_minor > 0),
  constraint ex_scale_positive check (money_scale > 0),
  constraint ex_paid_from check (paid_from in ('CASH', 'BANK', 'MOBILE_MONEY', 'OTHER')),
  constraint ex_payee_shape check (payee is null or length(btrim(payee)) between 1 and 120),
  constraint ex_reference_shape check (reference is null or length(btrim(reference)) between 1 and 80),
  constraint ex_note_shape check (note is null or length(btrim(note)) between 1 and 500),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, category_id) references app.expense_category (tenant_id, id)
    deferrable initially immediate
);
create index expense_date_ix on app.expense (tenant_id, expense_date);
create index expense_location_date_ix on app.expense (tenant_id, location_id, expense_date);
create index expense_category_ix on app.expense (tenant_id, category_id);
select app.apply_tenant_rls('app.expense');
revoke update, delete on app.expense from app_user;
create trigger expense_append_only
  before update or delete on app.expense
  for each row execute function app.forbid_mutation();

comment on table app.expense is
  'A settled business expense (0033). Operational record, NOT a journal entry: posts nothing to the GL. Immutable; a correction is app.expense_void + a new expense. location_id NULL = the whole business.';


-- ----------------------------------------------------------------------------
-- 3. app.expense_void — the correction document. Append-only, one per expense.
-- ----------------------------------------------------------------------------
create table app.expense_void (
  tenant_id   uuid        not null references platform.tenant (id),
  id          uuid        not null,
  write_id    uuid        not null,
  hlc         app.hlc     not null,
  created_at  timestamptz not null default transaction_timestamp(),
  updated_at  timestamptz not null default transaction_timestamp(),
  deleted_at  timestamptz,
  expense_id  uuid        not null,
  reason      text        not null,
  voided_by   uuid        not null,     -- from the verified token
  constraint exv_deleted_never check (deleted_at is null),
  constraint exv_reason_shape check (length(btrim(reason)) between 1 and 200),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, expense_id) references app.expense (tenant_id, id)
    deferrable initially immediate
);
create unique index expense_void_expense_uq on app.expense_void (tenant_id, expense_id);
select app.apply_tenant_rls('app.expense_void');
revoke update, delete on app.expense_void from app_user;
create trigger expense_void_append_only
  before update or delete on app.expense_void
  for each row execute function app.forbid_mutation();

comment on table app.expense_void is
  'Voids one app.expense (0033). is_voided := EXISTS (expense_void WHERE expense_id = expense.id). A void is never undone; record the expense again.';
