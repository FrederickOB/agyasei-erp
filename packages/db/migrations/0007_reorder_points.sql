-- ============================================================================
-- 0007_reorder_points.sql — the low-stock threshold, per (location, product),
-- and the derived alert view Phase 2's reorder management reads.
--
-- CLAUDE.md §3 puts "low-stock alerts" in Phase 1 and "reorder points tied to
-- Phase 1 alerts" in Phase 2. Those are ONE table, not two: this migration
-- lands the threshold Phase 1 alerts on, shaped so Phase 2's reorder
-- management is additional COLUMNS AND CALLERS on the same rows rather than a
-- second, divergent notion of "how low is low". `reorder_up_to_qty` and
-- `lead_time_days` are here for exactly that reason — Phase 1 does not read
-- them, Phase 2's order-up-to arithmetic does, and a tenant that has already
-- typed its numbers in does not type them again.
--
-- ---------------------------------------------------------------------------
-- THE UNIT PROBLEM — the whole reason this table has a uom_id column
-- ---------------------------------------------------------------------------
-- 59 of tenant #1's 219 SKUs sell by weight, length or area, and some sell in
-- TWO units: 12 m rebar is stocked as countable bars (BAR_12M, scale 0) and
-- sold either by the bar OR by the tonne (TON, scale 3), at EXACTLY 13500/d²
-- bars per tonne (04 §4.4.1).
--
-- "Low stock" must therefore be asked in the STOCKING unit — the one the
-- movement ledger is denominated in (04 §4.4.3: qty_delta is always stocking
-- units with its scale snapshotted) — and never in whichever unit the last
-- customer happened to buy in. A threshold of "10" is meaningless until you
-- know whether it means ten bars or ten tonnes, and those differ by a factor
-- of ninety-three.
--
-- So the threshold carries its OWN unit and scale snapshot, and a constraint
-- trigger refuses any row whose unit is not the product's stocking unit. The
-- comparison in app.reorder_status is then a bare integer comparison between
-- two values that are, structurally, in the same denomination. There is no
-- conversion at read time and therefore no rounding at read time.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT HERE
-- ---------------------------------------------------------------------------
-- No cached "quantity on hand" column. On-hand is SUM(qty_delta) over the
-- append-only ledger (04 §4.7.1) and the alert view derives it that way, so
-- two outlets that both moved the same SKU while partitioned converge in any
-- arrival order. A stored counter would not (CLAUDE.md §2.2).
--
-- No supplier, no order quantity policy, no safety-stock formula. Those are
-- Phase 2 (ADR-0001 scopes procurement out of Phase 1) and they attach to
-- these rows when they arrive.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The capability that guards editing a threshold.
--
-- platform.permission is GLOBAL and additive: a tenant composes codes, it can
-- never mint one (see the 0005 header). Adding one is a migration, and it is
-- mirrored in packages/db/src/permissions.ts — catalogueDrift() in that
-- package's suite fails if the two ever disagree.
--
-- Why a code of its own rather than reusing `stock.adjust`: adjusting stock
-- says what IS on the shelf and is reason-coded and audited; setting a
-- reorder point says when to shout about it. In plenty of org charts the
-- second is a buyer's job and the first is a yard supervisor's, and a
-- permission exists exactly where a role boundary plausibly falls in SOME
-- tenant's org chart (02 §2.4 granularity rule).
-- ----------------------------------------------------------------------------
insert into platform.permission
  (code, domain, description, is_sensitive, requires_fresh_authorization, bound_schema)
values
  ('stock.reorder.manage', 'stock',
   'Set and edit the reorder point (low-stock threshold) for a product at a location.',
   false, false, null)
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- 2. app.reorder_point — tenant-owned configuration, one row per
--    (location, product). SPARSE ON PURPOSE.
--
-- A location has a row for a product only where somebody decided a threshold
-- for it. The alternative — a row per (location × catalogue) at onboarding —
-- would produce 25 × 219 = 5,475 thresholds nobody chose, every one of them
-- breached on day one because on-hand is zero, and a first-morning alert list
-- of five thousand rows is worse than no alert list at all. The template
-- seeder (packages/db/src/seed/template.ts, applyReorderPoints) therefore
-- seeds only where the ledger already shows the location carrying the SKU.
--
-- Ordinary editable rows, not a ledger: UPDATE and soft DELETE are both
-- permitted, so there is no append-only trigger here. What a threshold WAS
-- last month is not an accounting fact.
-- ----------------------------------------------------------------------------
create table app.reorder_point (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,

  location_id uuid not null,
  product_id  uuid not null,

  -- The denomination of every quantity in this row. MUST be the product's
  -- stocking unit — enforced below, not merely intended.
  uom_id     uuid     not null,
  qty_scale  smallint not null,

  -- At or below this, the product is low. Scaled integer in uom_id's scale:
  -- 2500 at qty_scale 3 is 2.500 of the unit (04 §4.4.3, CLAUDE.md §2.3).
  reorder_point_qty app.qty  not null check (reorder_point_qty >= 0),

  -- PHASE 2 SEAM, deliberately nullable and unread by Phase 1: the order-up-to
  -- level and the supplier lead time an order quantity is computed from.
  -- Declared now so the tenant enters its numbers once.
  reorder_up_to_qty app.qty  check (reorder_up_to_qty >= 0),
  lead_time_days    smallint check (lead_time_days >= 0),

  is_active  boolean not null default true,
  notes      text,

  origin_template_id text,
  origin_ref         text,

  -- An order-up-to level below the point at which you order is not a policy,
  -- it is a typo that would order a negative quantity in Phase 2.
  constraint rp_up_to_not_below_point
    check (reorder_up_to_qty is null or reorder_up_to_qty >= reorder_point_qty),

  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, product_id) references app.product (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate
);

-- One live threshold per (location, product). Two would make "is it low?"
-- ambiguous, and an ambiguous alert is an ignored alert.
create unique index reorder_point_uq
  on app.reorder_point (tenant_id, location_id, product_id)
  where deleted_at is null;

-- The access path for both consumers: everything at one location, live rows.
-- Deliberately NOT partial on is_active — the management list must be able to
-- find a threshold somebody switched off, or it could never be switched back
-- on again.
create index reorder_point_location_ix
  on app.reorder_point (tenant_id, location_id, product_id)
  where deleted_at is null;

create unique index reorder_point_origin_uq
  on app.reorder_point (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;

select app.apply_tenant_rls('app.reorder_point');

comment on table app.reorder_point is
  'Tenant-owned low-stock threshold per (location, product), denominated in the product''s STOCKING unit. Phase 1 alerts read reorder_point_qty; Phase 2 reorder management reads reorder_up_to_qty and lead_time_days off the same rows.';
comment on column app.reorder_point.reorder_point_qty is
  'Scaled integer in the stocking unit, scale = qty_scale (2500 at scale 3 is 2.500). At or below this value the product is low. Never a float (ADR-0004).';
comment on column app.reorder_point.uom_id is
  'Snapshot of the product''s stocking unit. A threshold in a SELLING unit would compare a tonne against a bar; the trigger below refuses one.';

-- ----------------------------------------------------------------------------
-- 3. The unit guard.
--
-- Refuses any threshold not denominated in the product's stocking unit, at
-- that unit's scale. This is the structural half of the dual-unit rule: with
-- it, "on hand <= reorder point" is an integer comparison that cannot be
-- wrong; without it, one mis-entered row silently compares tonnes to bars and
-- either screams forever or never fires at all.
--
-- A constraint trigger rather than a CHECK because the answer lives in two
-- other tables. It runs under the caller's RLS context, so it can only ever
-- see the caller's own tenant.
-- ----------------------------------------------------------------------------
create function app.assert_reorder_point_stocking_unit() returns trigger
language plpgsql as $$
declare
  stocking_uom uuid;
  stocking_scale smallint;
begin
  select p.stocking_uom_id, u.qty_scale
    into stocking_uom, stocking_scale
    from app.product p
    join app.unit_of_measure u
      on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
   where p.tenant_id = new.tenant_id and p.id = new.product_id;

  if stocking_uom is null then
    raise exception 'reorder_point %: product % has no resolvable stocking unit',
      new.id, new.product_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.uom_id <> stocking_uom then
    raise exception
      'reorder_point %: uom % is not the stocking unit % for product % — a low-stock threshold is compared against the movement ledger, which is denominated in the stocking unit (04 §4.4.3)',
      new.id, new.uom_id, stocking_uom, new.product_id
      using errcode = 'check_violation';
  end if;

  if new.qty_scale <> stocking_scale then
    raise exception
      'reorder_point %: qty_scale % does not match the stocking unit''s scale % — the threshold and the ledger would differ by a power of ten',
      new.id, new.qty_scale, stocking_scale
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

create constraint trigger reorder_point_in_stocking_unit
  after insert or update of product_id, uom_id, qty_scale on app.reorder_point
  for each row execute function app.assert_reorder_point_stocking_unit();

-- ----------------------------------------------------------------------------
-- 4. app.reorder_status — the low-stock question, derived.
--
-- security_invoker so RLS is evaluated as the querying role, not the view
-- owner (04 §4.2.5) — the same rule app.stock_on_hand follows, and the reason
-- this view can be read straight from a tenant-scoped transaction.
--
-- qty_on_hand comes from app.stock_on_hand, i.e. SUM over the movement
-- ledger. NOT a cached counter, and not the till's idea of what it sold.
--
-- shortfall_qty is what it would take to get back to the order-up-to level
-- (or, when none is set, back to the reorder point itself), floored at zero.
-- It is the urgency key the API orders by, and it is a difference of two
-- integers in ONE unit, so it needs no rounding.
--
-- The view carries `is_active` rather than filtering on it. An alert query
-- adds `and is_active`; the MANAGEMENT list must not, because a threshold
-- somebody switched off has to stay findable or it can never be switched back
-- on. One derivation, two consumers, one place for the arithmetic to live.
-- ----------------------------------------------------------------------------
create view app.reorder_status
  with (security_invoker = true) as
select rp.tenant_id,
       rp.id                    as reorder_point_id,
       rp.location_id,
       rp.product_id,
       rp.uom_id,
       rp.qty_scale,
       rp.reorder_point_qty,
       rp.reorder_up_to_qty,
       rp.lead_time_days,
       rp.is_active,
       coalesce(soh.qty_on_hand, 0)::bigint as qty_on_hand,
       (coalesce(soh.qty_on_hand, 0)::bigint <= rp.reorder_point_qty) as is_low,
       greatest(
         coalesce(rp.reorder_up_to_qty, rp.reorder_point_qty)
           - coalesce(soh.qty_on_hand, 0)::bigint,
         0
       )::bigint as shortfall_qty
  from app.reorder_point rp
  left join app.stock_on_hand soh
    on soh.tenant_id = rp.tenant_id
   and soh.location_id = rp.location_id
   and soh.product_id = rp.product_id
 where rp.deleted_at is null;

comment on view app.reorder_status is
  'Reorder points joined to DERIVED on-hand (SUM over app.stock_movement, never a cached counter). is_low is at-or-below. Both sides are in the stocking unit, so the comparison needs no conversion and no rounding. Carries is_active rather than filtering it: the alert query filters, the management list must not.';
