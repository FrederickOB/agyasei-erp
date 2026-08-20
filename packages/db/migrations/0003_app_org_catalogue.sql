-- ============================================================================
-- 0003_app_org_catalogue.sql — org structure (location types, locations),
-- units of measure, catalogue, pricing.
--
-- Every table here follows the tenant pattern (see 0002). All FKs between
-- tenant-owned tables are COMPOSITE on tenant_id — a row physically cannot
-- reference another tenant's row, with or without RLS (04 §4.2.2). FKs are
-- DEFERRABLE (INITIALLY IMMEDIATE) so the offboarding deletion machinery can
-- run under SET CONSTRAINTS ALL DEFERRED (01 §1.7).
--
-- Rows seeded from a template carry origin_template_id / origin_ref
-- provenance (01 §1.6). The partial unique index on (tenant_id,
-- origin_template_id, origin_ref) IS the template applier's idempotency.
-- NO business logic may ever read origin_ref — that is tenant-identity
-- branching in disguise (CLAUDE.md §2.9).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- app.location_type — TENANT VOCABULARY (ADR-0006).
-- Tenant #1 seeds FLAGSHIP / RDC / MICRO; another tenant creates BRANCH /
-- DEPOT. No platform code ever reads a location_type.code:
-- `if (type.code === 'RDC')` is the same defect as `if (tenant === 'agyasei')`.
-- ----------------------------------------------------------------------------
create table app.location_type (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,
  code       text        not null,
  name       text        not null,
  origin_template_id text,
  origin_ref         text,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
create unique index location_type_code_uq on app.location_type (tenant_id, code)
  where deleted_at is null;
create unique index location_type_origin_uq on app.location_type (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
select app.apply_tenant_rls('app.location_type');

-- ----------------------------------------------------------------------------
-- app.location — PLATFORM STRUCTURE via the closed `kind` enum.
-- kind is what the platform genuinely branches on: does this node sell, hold
-- stock, group others, or represent goods on the road (04 §4.3):
--   OUTLET    — sells and holds stock
--   WAREHOUSE — holds stock, does not sell
--   GROUP     — grouping node (tenant #1's regions); no stock, no sales
--   TRANSIT   — one durable node per stock-holding location; goods in motion
-- The hierarchy is arbitrary-depth via parent_id. Nothing reads depth = 2.
-- ----------------------------------------------------------------------------
create table app.location (
  tenant_id        uuid        not null references platform.tenant (id),
  id               uuid        not null,
  write_id         uuid        not null,
  hlc              app.hlc     not null,
  created_at       timestamptz not null default transaction_timestamp(),
  updated_at       timestamptz not null default transaction_timestamp(),
  deleted_at       timestamptz,
  code             text        not null,
  name             text        not null,
  kind             text        not null check (kind in ('OUTLET','WAREHOUSE','GROUP','TRANSIT')),
  location_type_id uuid,                  -- NULL for GROUP / TRANSIT nodes
  parent_id        uuid,                  -- NULL at the root
  is_active        boolean     not null default true,
  timezone         text        not null,
  origin_template_id text,
  origin_ref         text,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_type_id) references app.location_type (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, parent_id) references app.location (tenant_id, id)
    deferrable initially immediate
);
create unique index location_code_uq on app.location (tenant_id, code)
  where deleted_at is null;
create unique index location_origin_uq on app.location (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
create index location_parent_ix on app.location (tenant_id, parent_id);
select app.apply_tenant_rls('app.location');

-- ----------------------------------------------------------------------------
-- app.unit_of_measure (04 §4.4). qty_scale fixes the scaled-integer
-- denomination of every quantity in this unit: qty value 2500 in a scale-3
-- unit means 2.500. IMMUTABLE once movements reference the unit — changing a
-- scale silently multiplies every historical balance by a power of ten
-- (enforced at the application layer in Phase 1; the per-row qty_scale
-- snapshot is the belt that survives even that).
-- ----------------------------------------------------------------------------
create table app.unit_of_measure (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,
  code       text        not null,        -- 'PIECE','BAG','KG','TON','METRE','SQM','BAR_12M',...
  name       text        not null,
  dimension  text        not null check (dimension in ('COUNT','MASS','LENGTH','AREA','VOLUME')),
  qty_scale  smallint    not null check (qty_scale between 0 and 6),
  origin_template_id text,
  origin_ref         text,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
create unique index uom_code_uq on app.unit_of_measure (tenant_id, code)
  where deleted_at is null;
create unique index uom_origin_uq on app.unit_of_measure (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
select app.apply_tenant_rls('app.unit_of_measure');

comment on column app.unit_of_measure.qty_scale is
  'Scaled-integer denomination: a qty of 2500 at scale 3 is 2.500. Immutable once used; snapshotted onto every movement and line (04 §4.4.3).';

-- ----------------------------------------------------------------------------
-- app.product_category — tenant tree (tenant #1: 12 categories, 54
-- sub-categories, from the template).
-- ----------------------------------------------------------------------------
create table app.product_category (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,
  code       text        not null,
  name       text        not null,
  parent_id  uuid,
  origin_template_id text,
  origin_ref         text,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, parent_id) references app.product_category (tenant_id, id)
    deferrable initially immediate
);
create unique index product_category_code_uq on app.product_category (tenant_id, code)
  where deleted_at is null;
create unique index product_category_origin_uq on app.product_category (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
select app.apply_tenant_rls('app.product_category');

-- ----------------------------------------------------------------------------
-- app.product — the tenant-owned catalogue (ADR-0006: the 219 construction
-- SKUs are a TEMPLATE, not the platform's product list).
--
-- tax_code is mandatory and not defaulted: a SKU without a tax code cannot
-- be sold, because the alternative is a receipt that is quietly not a
-- statutory invoice (04 §4.5). A constraint trigger asserts the code exists
-- in the TENANT'S OWN jurisdiction's pack (04 §4.17.5 finding 21).
-- ----------------------------------------------------------------------------
create table app.product (
  tenant_id       uuid        not null references platform.tenant (id),
  id              uuid        not null,
  write_id        uuid        not null,
  hlc             app.hlc     not null,
  created_at      timestamptz not null default transaction_timestamp(),
  updated_at      timestamptz not null default transaction_timestamp(),
  deleted_at      timestamptz,
  sku_code        text        not null,
  name            text        not null,
  category_id     uuid        not null,
  stocking_uom_id uuid        not null,   -- exactly one; the stock ledger is denominated in this
  tax_code        text        not null,   -- into the jurisdiction pack (ADR-0002 / ADR-0007)
  stock_tracking  text        not null default 'STOCKED'
                  check (stock_tracking in ('STOCKED','NON_STOCKED')),
  is_sellable     boolean     not null default true,
  is_purchasable  boolean     not null default true,
  notes           text,
  origin_template_id text,
  origin_ref         text,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, category_id) references app.product_category (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, stocking_uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate
);
create unique index product_sku_uq on app.product (tenant_id, sku_code)
  where deleted_at is null;
create unique index product_origin_uq on app.product (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
create index product_category_ix on app.product (tenant_id, category_id);
select app.apply_tenant_rls('app.product');

-- The product's tax code must exist in the tenant's own jurisdiction.
create function app.assert_product_tax_code() returns trigger
language plpgsql as $$
declare
  j text;
begin
  select t.jurisdiction_code into j from platform.tenant t where t.id = new.tenant_id;
  if not exists (
    select 1 from platform.tax_code c
    where c.jurisdiction_code = j and c.code = new.tax_code
  ) then
    raise exception 'product %.%: tax_code % is not defined for jurisdiction %',
      new.tenant_id, new.sku_code, new.tax_code, j
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;

create constraint trigger product_tax_code_in_jurisdiction
  after insert or update of tax_code on app.product
  for each row execute function app.assert_product_tax_code();

-- ----------------------------------------------------------------------------
-- app.product_uom — stocking/selling units with RATIONAL conversion factors
-- (04 §4.4). factor_num / factor_den = stocking units per ONE selling unit,
-- in natural units. Rational, never decimal: bars per tonne of rebar is
-- EXACTLY 13500/d² (8mm → 13500/64 = 210.9375 — not representable as a
-- short decimal; exact as a pair of bigints).
--
-- tolerance_bp has NO DEFAULT deliberately: authoring a row without stating
-- a tolerance must fail. A defaulted 0 shipped the pilot with zero tolerance
-- on every dual-unit row and would have stalled every rebar-by-the-tonne
-- sale behind a manager (04 §4.4.4, finding 18).
-- ----------------------------------------------------------------------------
create table app.product_uom (
  tenant_id       uuid        not null references platform.tenant (id),
  id              uuid        not null,
  write_id        uuid        not null,
  hlc             app.hlc     not null,
  created_at      timestamptz not null default transaction_timestamp(),
  updated_at      timestamptz not null default transaction_timestamp(),
  deleted_at      timestamptz,
  product_id      uuid        not null,
  uom_id          uuid        not null,
  factor_num      bigint      not null check (factor_num > 0),
  factor_den      bigint      not null check (factor_den > 0),
  can_sell        boolean     not null default true,
  can_buy         boolean     not null default false,
  is_default_sell boolean     not null default false,
  tolerance_bp    app.bp      not null,   -- NO DEFAULT. See header comment.
  sort_order      smallint    not null default 0,
  origin_template_id text,
  origin_ref         text,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, product_id) references app.product (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate
);
create unique index product_uom_uq on app.product_uom (tenant_id, product_id, uom_id)
  where deleted_at is null;
create unique index product_uom_default_sell_uq on app.product_uom (tenant_id, product_id)
  where is_default_sell and deleted_at is null;
create unique index product_uom_origin_uq on app.product_uom (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
select app.apply_tenant_rls('app.product_uom');

comment on column app.product_uom.factor_num is
  'Rational conversion: factor_num/factor_den stocking units per ONE selling unit, in natural units. Rebar: 13500/d² bars per tonne (04 §4.4.1).';

-- ----------------------------------------------------------------------------
-- app.price_list / app.price_list_item (04 §4.6).
-- Retail and wholesale are TWO ROWS, not an enum — no platform code names
-- either. unit_price_e4 is minor units per selling unit × 10^4 (app.rate_e4);
-- it becomes an amount exactly once, at the extended-line rounding rule.
-- ----------------------------------------------------------------------------
create table app.price_list (
  tenant_id        uuid        not null references platform.tenant (id),
  id               uuid        not null,
  write_id         uuid        not null,
  hlc              app.hlc     not null,
  created_at       timestamptz not null default transaction_timestamp(),
  updated_at       timestamptz not null default transaction_timestamp(),
  deleted_at       timestamptz,
  code             text        not null,
  name             text        not null,
  is_tax_inclusive boolean     not null,
  currency_code    char(3)     not null,
  priority         smallint    not null,     -- resolution order, low wins
  location_id      uuid,                     -- NULL = whole tenant
  effective_from   date        not null,
  effective_to     date,
  origin_template_id text,
  origin_ref         text,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate
);
create unique index price_list_code_uq on app.price_list (tenant_id, code)
  where deleted_at is null;
create unique index price_list_origin_uq on app.price_list (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
select app.apply_tenant_rls('app.price_list');

create table app.price_list_item (
  tenant_id      uuid        not null references platform.tenant (id),
  id             uuid        not null,
  write_id       uuid        not null,
  hlc            app.hlc     not null,
  created_at     timestamptz not null default transaction_timestamp(),
  updated_at     timestamptz not null default transaction_timestamp(),
  deleted_at     timestamptz,
  price_list_id  uuid        not null,
  product_id     uuid        not null,
  uom_id         uuid        not null,      -- price is PER SELLING UNIT (04 §4.6)
  unit_price_e4  app.rate_e4 not null check (unit_price_e4 >= 0),
  min_qty        app.qty     not null default 0,   -- volume break, in the selling unit's scale
  effective_from date        not null,
  effective_to   date,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, price_list_id) references app.price_list (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, product_id) references app.product (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate
);
create unique index price_list_item_uq
  on app.price_list_item (tenant_id, price_list_id, product_id, uom_id, min_qty, effective_from)
  where deleted_at is null;
select app.apply_tenant_rls('app.price_list_item');

comment on column app.price_list_item.unit_price_e4 is
  'Minor units per selling unit × 10^4 (app.rate_e4). Becomes an amount once, at the extended-line rounding (04 §4.13 row 3). Templates never seed prices (01 §1.6).';

-- ----------------------------------------------------------------------------
-- app.movement_reason — tenant-editable reason codes for stock movements
-- (damage, theft, sample, count variance, ...). Seeded by template.
-- ----------------------------------------------------------------------------
create table app.movement_reason (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,
  code       text        not null,
  name       text        not null,
  origin_template_id text,
  origin_ref         text,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
create unique index movement_reason_code_uq on app.movement_reason (tenant_id, code)
  where deleted_at is null;
create unique index movement_reason_origin_uq on app.movement_reason (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
select app.apply_tenant_rls('app.movement_reason');
