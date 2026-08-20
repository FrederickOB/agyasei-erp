-- ============================================================================
-- 0004_app_trade.sql — the trading spine: stock movements (append-only
-- ledger), customers and credit (append-only entries), the minimal sale
-- document model, and staff capture.
--
-- Two ledgers live here and both are APPEND-ONLY: on-hand stock and credit
-- balances are DERIVED by summing movements/entries, never stored as mutable
-- counters. That is what makes offline reconciliation possible at all: two
-- outlets that both moved the same SKU while partitioned produce two rows
-- that sum correctly in any arrival order (04 §4.7.1).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- app.stock_movement — the movement ledger (04 §4.7.1).
--
-- qty_delta is a SIGNED scaled integer in the STOCKING unit; its scale is the
-- snapshotted qty_scale (04 §4.4.3): qty_delta -2500 at qty_scale 3 is
-- -2.500 of the unit (e.g. 2.5 t outbound). OUTFLOW IS NEGATIVE, enforced by
-- sm_sign.
--
-- id is the client-generated UUID (idempotent: PK (tenant_id, id) makes a
-- resent movement a conflict, not a duplicate), and write_id ties the row to
-- the unit of work that produced it.
-- ----------------------------------------------------------------------------
create table app.stock_movement (
  tenant_id    uuid        not null references platform.tenant (id),
  id           uuid        not null,       -- client-generated UUIDv7; idempotent identity
  write_id     uuid        not null,
  hlc          app.hlc     not null,       -- server-stamped; replay order for costing (04 §4.7.4)
  created_at   timestamptz not null default transaction_timestamp(),
  updated_at   timestamptz not null default transaction_timestamp(),
  deleted_at   timestamptz,
  location_id  uuid        not null,
  product_id   uuid        not null,
  qty_delta    app.qty     not null check (qty_delta <> 0),  -- SIGNED, stocking units
  qty_scale    smallint    not null,       -- snapshot of the stocking unit's scale
  uom_id       uuid        not null,       -- snapshot of the stocking unit
  reason_id    uuid        not null,       -- app.movement_reason, tenant-editable
  source_kind  text        not null check (source_kind in
                 ('OPENING','SALE','SALE_RETURN','RECEIPT','RETURN_TO_SUPPLIER',
                  'TRANSFER_OUT','TRANSFER_IN','COUNT_ADJUST','WRITE_OFF','CORRECTION')),
  source_id    uuid,
  unit_cost_e4 app.rate_e4,                -- inbound only; issues cost from the running WAC
  occurred_at  timestamptz not null,       -- device time. UNTRUSTED. Display only.
  business_date date       not null,
  reverses_id  uuid,                       -- a correction is a compensating row, never an UPDATE
  archived_at  timestamptz,                -- sync windowing only; the ONE permitted UPDATE
  -- NOTE (§4.8a): cash_session_id lands with the POS migration; sale-sourced
  -- movements will then require it and derive business_date from the session,
  -- never from a device clock.
  constraint sm_deleted_never check (deleted_at is null),   -- ledgers forbid soft delete
  -- The sign convention, stated once and enforced: OUTFLOW IS NEGATIVE.
  constraint sm_sign check (
       (source_kind in ('SALE','TRANSFER_OUT','WRITE_OFF','RETURN_TO_SUPPLIER') and qty_delta < 0)
    or (source_kind in ('OPENING','RECEIPT','SALE_RETURN','TRANSFER_IN')        and qty_delta > 0)
    or (source_kind in ('COUNT_ADJUST','CORRECTION'))       -- genuinely bidirectional
  ),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, product_id) references app.product (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, reason_id) references app.movement_reason (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, reverses_id) references app.stock_movement (tenant_id, id)
    deferrable initially immediate
);
create index stock_movement_replay_ix on app.stock_movement (tenant_id, location_id, product_id, hlc);
create index stock_movement_day_ix    on app.stock_movement (tenant_id, business_date, location_id);
create index stock_movement_source_ix on app.stock_movement (tenant_id, source_kind, source_id);
select app.apply_tenant_rls('app.stock_movement');

comment on column app.stock_movement.qty_delta is
  'Signed scaled integer in the stocking unit; scale is the snapshotted qty_scale (e.g. -2500 at scale 3 = -2.500). Outflow is negative (sm_sign).';

-- Append-only. REVOKE is the control; the trigger survives a careless future
-- GRANT. archived_at is the single permitted UPDATE (sync windowing).
revoke update, delete on app.stock_movement from app_user;
create trigger stock_movement_append_only
  before update or delete on app.stock_movement
  for each row execute function app.forbid_mutation_except_archive();

-- On-hand is DERIVED, never a mutable counter. security_invoker so RLS is
-- evaluated as the querying role, not the view owner (04 §4.2.5).
create view app.stock_on_hand
  with (security_invoker = true) as
select tenant_id, location_id, product_id, sum(qty_delta) as qty_on_hand
from app.stock_movement
group by 1, 2, 3;

-- ----------------------------------------------------------------------------
-- Customers and credit (04 §4.9; interior mechanics belong to credit-engineer).
-- Terms and fee rate are PER ACCOUNT (ADR-0006: per-tenant credit policy,
-- per-account terms and rate). Balance and ageing are DERIVED from
-- credit_entry — same reasoning as stock.
-- ----------------------------------------------------------------------------
create table app.customer (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,
  code       text        not null,
  name       text        not null,
  phone      text,
  is_credit_customer boolean not null default false,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
create unique index customer_code_uq on app.customer (tenant_id, code)
  where deleted_at is null;
select app.apply_tenant_rls('app.customer');

create table app.customer_account (
  tenant_id                 uuid        not null references platform.tenant (id),
  id                        uuid        not null,
  write_id                  uuid        not null,
  hlc                       app.hlc     not null,
  created_at                timestamptz not null default transaction_timestamp(),
  updated_at                timestamptz not null default transaction_timestamp(),
  deleted_at                timestamptz,
  customer_id               uuid        not null,
  credit_limit_minor        app.money_minor not null default 0 check (credit_limit_minor >= 0),
  terms_days                smallint    not null check (terms_days >= 0),      -- per account
  facility_fee_bp_per_month app.bp      not null check (facility_fee_bp_per_month >= 0),
                                        -- tenant #1: 2–3%/month = 200–300 bp. Per account.
  status                    text        not null default 'ACTIVE'
                            check (status in ('ACTIVE','ON_HOLD','CLOSED')),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, customer_id) references app.customer (tenant_id, id)
    deferrable initially immediate
);
create unique index customer_account_customer_uq on app.customer_account (tenant_id, customer_id)
  where deleted_at is null;
select app.apply_tenant_rls('app.customer_account');

-- Append-only credit ledger. Sign convention: DEBIT-TO-CUSTOMER IS POSITIVE
-- (a CHARGE increases what the customer owes; a PAYMENT is negative).
create table app.credit_entry (
  tenant_id     uuid        not null references platform.tenant (id),
  id            uuid        not null,
  write_id      uuid        not null,
  hlc           app.hlc     not null,
  created_at    timestamptz not null default transaction_timestamp(),
  updated_at    timestamptz not null default transaction_timestamp(),
  deleted_at    timestamptz,
  account_id    uuid        not null,
  kind          text        not null check (kind in ('CHARGE','PAYMENT','FEE','ADJUSTMENT','WRITE_OFF')),
  amount_minor  app.money_minor not null check (amount_minor <> 0),   -- SIGNED
  business_date date        not null,
  due_date      date,
  source_kind   text,
  source_id     uuid,
  applies_to_id uuid,                     -- payment → charge matching, for ageing
  constraint ce_deleted_never check (deleted_at is null),
  constraint ce_sign check (
       (kind in ('CHARGE','FEE') and amount_minor > 0)
    or (kind in ('PAYMENT','WRITE_OFF') and amount_minor < 0)
    or (kind = 'ADJUSTMENT')
  ),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, account_id) references app.customer_account (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, applies_to_id) references app.credit_entry (tenant_id, id)
    deferrable initially immediate
);
create index credit_entry_account_ix on app.credit_entry (tenant_id, account_id, business_date);
select app.apply_tenant_rls('app.credit_entry');

revoke update, delete on app.credit_entry from app_user;
create trigger credit_entry_append_only
  before update or delete on app.credit_entry
  for each row execute function app.forbid_mutation();

-- ----------------------------------------------------------------------------
-- app.sale / app.sale_line / app.sale_tax_line — the minimal document model
-- (04 §4.8). A sale SNAPSHOTS everything: price, tax rate row, conversion
-- factor, quantity scales, currency and its minor-unit scale. A sale is a
-- historical fact; nothing about it may change because a factor was
-- corrected, a rate changed, or a price list was reissued.
--
-- ============================================================================
-- Q8 SEAM — Ghana e-VAT clearance (docs/open-questions.md Q8, UNRESOLVED).
-- ============================================================================
-- This model captures the SALE and its TAX COMPUTATION only. It deliberately
-- carries NO invoice issuance or clearance fields: no GRA clearance/SDC code,
-- no QR payload, no digital signature, no fiscal invoice number. If Q8
-- resolves to a clearance regime (invoice valid only once the GRA returns a
-- code), issuance becomes a SEPARATE document — e.g. app.tax_invoice
-- referencing (tenant_id, sale_id) — added in its own migration with its own
-- offline/proforma workflow. DO NOT add clearance columns to these tables;
-- the seam is here so the capture model survives either answer to Q8.
-- ============================================================================
-- ----------------------------------------------------------------------------
create table app.sale (
  tenant_id     uuid        not null references platform.tenant (id),
  id            uuid        not null,
  write_id      uuid        not null,
  hlc           app.hlc     not null,
  created_at    timestamptz not null default transaction_timestamp(),
  updated_at    timestamptz not null default transaction_timestamp(),
  deleted_at    timestamptz,
  location_id   uuid        not null,
  customer_id   uuid,                     -- NULL for walk-in cash
  price_list_id uuid        not null,     -- snapshot of what was resolved
  receipt_no    text        not null,
  business_date date        not null,
  occurred_at   timestamptz not null,     -- device time; untrusted, display only
  voids_sale_id uuid,                     -- set on the VOIDING document; original is immutable
  currency_code char(3)     not null,     -- snapshot from the pack
  money_scale   bigint      not null,     -- snapshot of minor_units_per_major. NEVER assume 100.
  subtotal_net_minor app.money_minor not null,
  discount_minor     app.money_minor not null default 0,
  tax_total_minor    app.money_minor not null,
  total_minor        app.money_minor not null,
  constraint sale_total_identity
    check (total_minor = subtotal_net_minor - discount_minor + tax_total_minor),
  constraint sale_deleted_never check (deleted_at is null),  -- documents are not soft-deletable
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, customer_id) references app.customer (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, price_list_id) references app.price_list (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, voids_sale_id) references app.sale (tenant_id, id)
    deferrable initially immediate
);
create unique index sale_receipt_uq on app.sale (tenant_id, location_id, receipt_no);
create index sale_day_ix on app.sale (tenant_id, location_id, business_date);
select app.apply_tenant_rls('app.sale');

revoke update, delete on app.sale from app_user;
create trigger sale_append_only
  before update or delete on app.sale
  for each row execute function app.forbid_mutation();

create table app.sale_line (
  tenant_id       uuid        not null references platform.tenant (id),
  id              uuid        not null,
  write_id        uuid        not null,
  hlc             app.hlc     not null,
  created_at      timestamptz not null default transaction_timestamp(),
  updated_at      timestamptz not null default transaction_timestamp(),
  deleted_at      timestamptz,
  sale_id         uuid        not null,
  line_no         smallint    not null,
  product_id      uuid        not null,
  -- what was PRICED
  selling_uom_id  uuid        not null,
  qty_sell        app.qty     not null,
  qty_sell_scale  smallint    not null,
  unit_price_e4   app.rate_e4 not null,
  -- what LEFT THE YARD — recorded independently, never derived (04 §4.4.4)
  stocking_uom_id uuid        not null,
  qty_stock       app.qty     not null,
  qty_stock_scale smallint    not null,
  factor_num      bigint      not null check (factor_num > 0),   -- conversion snapshot
  factor_den      bigint      not null check (factor_den > 0),
  -- money
  line_discount_minor app.money_minor not null default 0,
  line_net_minor      app.money_minor not null,
  tax_code            text            not null,
  tax_minor           app.money_minor not null,   -- = Σ sale_tax_line.tax_minor
  constraint sl_deleted_never check (deleted_at is null),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, sale_id) references app.sale (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, product_id) references app.product (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, selling_uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, stocking_uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate
);
create unique index sale_line_uq on app.sale_line (tenant_id, sale_id, line_no);
select app.apply_tenant_rls('app.sale_line');

revoke update, delete on app.sale_line from app_user;
create trigger sale_line_append_only
  before update or delete on app.sale_line
  for each row execute function app.forbid_mutation();

-- One row per (line, tax component): Ghana's VAT, NHIL and GETFund are each
-- shown separately with their own rate, base and amount (04 §4.8 — a single
-- blended rate cannot produce a statutory invoice or a VAT return).
-- tax_rate_id pins the EXACT effective-dated platform.tax_rate row used, so
-- a reprint six months after a rate change reproduces the original document.
create table app.sale_tax_line (
  tenant_id      uuid        not null references platform.tenant (id),
  id             uuid        not null,
  write_id       uuid        not null,
  hlc            app.hlc     not null,
  created_at     timestamptz not null default transaction_timestamp(),
  updated_at     timestamptz not null default transaction_timestamp(),
  deleted_at     timestamptz,
  sale_id        uuid        not null,
  sale_line_id   uuid        not null,
  seq            smallint    not null,       -- component order, from the pack
  tax_code       text        not null,       -- 'GH.VAT.STD', 'GH.NHIL', ...
  rate_bp        app.bp      not null,       -- snapshot: the rate as applied
  base_kind      text        not null check (base_kind in ('net','net_plus')),
  base_includes  text[]      not null default '{}',
  rounding_level text        not null check (rounding_level in ('line','document')),
  rounding_mode  text        not null check (rounding_mode in ('half_up','half_even','down')),
  base_minor     app.money_minor not null,
  tax_minor      app.money_minor not null,
  tax_rate_id    uuid        not null references platform.tax_rate (id),
  constraint stl_deleted_never check (deleted_at is null),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, sale_id) references app.sale (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, sale_line_id) references app.sale_line (tenant_id, id)
    deferrable initially immediate
);
create unique index sale_tax_line_uq on app.sale_tax_line (tenant_id, sale_line_id, seq);
select app.apply_tenant_rls('app.sale_tax_line');

revoke update, delete on app.sale_tax_line from app_user;
create trigger sale_tax_line_append_only
  before update or delete on app.sale_tax_line
  for each row execute function app.forbid_mutation();

-- ----------------------------------------------------------------------------
-- app.staff — CAPTURE ONLY (CLAUDE.md §2.4; 04 §4.11).
--
-- This table records who works here and when. It carries NO statutory
-- columns and NO payroll-calculation inputs: no PAYE bracket, no
-- social-security rate, no withholding table — in any jurisdiction, ever.
-- Statutory figures enter the system only as bureau-imported rows in a later
-- phase (payroll_bureau_figure, keyed by a pack-defined figure_code) and are
-- RECORDED, never derived. If a task appears to require computing a
-- statutory deduction here, refuse and cite CLAUDE.md §2.4.
-- ----------------------------------------------------------------------------
create table app.staff (
  tenant_id       uuid        not null references platform.tenant (id),
  id              uuid        not null,
  write_id        uuid        not null,
  hlc             app.hlc     not null,
  created_at      timestamptz not null default transaction_timestamp(),
  updated_at      timestamptz not null default transaction_timestamp(),
  deleted_at      timestamptz,
  code            text        not null,
  full_name       text        not null,
  phone           text,
  national_id_ref text,                   -- opaque reference; no document images here
  hired_on        date,
  ended_on        date,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
create unique index staff_code_uq on app.staff (tenant_id, code)
  where deleted_at is null;
select app.apply_tenant_rls('app.staff');
