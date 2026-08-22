-- ============================================================================
-- 0008_procurement.sql — Phase 2's buying spine: suppliers and what they can
-- do for you, multi-source supply, purchase orders as a state machine, goods
-- receipts matched against those orders, and third-party delivery tracking.
--
-- (docs/architecture/sections/04-data-model.md §4.10; ADR-0001; CLAUDE.md §3
--  Phase 2 scope. Hand-written SQL is THE source of truth; src/schema.ts
--  MIRRORS this DDL and the conformance suite reconciles the two.)
--
-- ---------------------------------------------------------------------------
-- ADR-0001 IS ABSOLUTE: DISPATCH AND TRACKING ONLY. THERE IS NO FLEET.
-- ---------------------------------------------------------------------------
-- There is no vehicle table here, no driver, no fuel, no maintenance
-- schedule, and there never will be one in this system. A haulier is a
-- SUPPLIER carrying a HAULAGE capability: it issues invoices and is paid on
-- terms, which is a supplier in every way the books care about, and it puts
-- haulage spend in AP where distribution cost as a percentage of revenue can
-- actually be measured — which is what ADR-0001 promises and what
-- open-questions Q1 depends on now that Lever 3's owned-fleet mechanism is
-- gone. `delivery.carrier_supplier_id` is the carrier abstraction ADR-0001
-- names as the attachment point if owned vehicles ever appear.
--
-- ---------------------------------------------------------------------------
-- UNITS GO THROUGH THE SAME product_uom MACHINERY AS SELLING (§4.10)
-- ---------------------------------------------------------------------------
-- Cement bought by the tonne and sold by the 50 kg bag is the same conversion
-- problem as rebar stocked by the 12 m bar and sold by the tonne, in the
-- opposite direction. Solving it twice would be absurd and the two solutions
-- would drift. So a purchase unit is a `product_uom` row with `can_buy` —
-- enforced by trigger, not intended by comment — and every document line
-- snapshots the rational factor it converted with, exactly as `sale_line`
-- does (04 §4.4.1/§4.4.4).
--
-- ---------------------------------------------------------------------------
-- STOCK IS AN APPEND-ONLY MOVEMENT LEDGER
-- ---------------------------------------------------------------------------
-- Nothing in this migration stores a quantity on hand. A goods receipt APPENDS
-- `app.stock_movement` rows with source_kind='RECEIPT'; it never sets a
-- counter (04 §4.7.1; CLAUDE.md §2.2). That is what lets a yard in Bawku
-- receive cement while partitioned and converge on reconnect in any arrival
-- order. `app.purchase_order_line_status` derives what is still outstanding
-- by summing receipt lines — it caches nothing.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE
-- ---------------------------------------------------------------------------
-- No supplier invoice, no AP ageing, no three-way match to an invoice, no GL
-- posting. Those are Phase 3 (`ledger-engineer`). `goods_receipt` carries
-- `supplier_invoice_ref` as an opaque reference so the document the yard held
-- in its hand is recorded, and that is the whole of it.
--
-- No `qty_on_hand` anywhere. No vehicle. No statutory anything.
-- ============================================================================


-- ============================================================================
-- 1. app.supplier — the counterparty.
--
-- One table for everyone the tenant buys FROM or pays to CARRY something,
-- because the books do not distinguish them: both issue invoices, both are
-- paid on terms, both belong in AP. What they can do for you is
-- `supplier_capability` below.
--
-- `payment_terms_days` is per supplier and is ORDINARY EDITABLE DATA — the
-- tenant negotiates it. No platform default of 30, because a default that
-- nobody chose looks like a term that somebody agreed.
-- ============================================================================
create table app.supplier (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,

  code       text        not null,
  name       text        not null,

  -- Days from invoice to due. A cash-on-delivery supplier is 0, which is a
  -- real term and not a missing value.
  payment_terms_days smallint not null check (payment_terms_days >= 0),

  -- Snapshot of the currency this supplier is invoiced in. A tenant belongs
  -- to exactly one jurisdiction and FX in the ledger is out of scope
  -- (CLAUDE.md §2.5), so the trigger below refuses anything but the tenant's
  -- own pack currency. The column exists (rather than being implied) because
  -- the day FX arrives, the value it needs is already recorded per row rather
  -- than back-filled from an assumption.
  currency_code char(3) not null,

  contact_name  text,
  contact_phone text,
  contact_email text,
  address_text  text,
  notes         text,

  is_active  boolean not null default true,

  -- Template provenance (0003 header): advisory only. NO business logic may
  -- ever read origin_ref — that is tenant identity by another name (§2.9).
  origin_template_id text,
  origin_ref         text,

  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
create unique index supplier_code_uq on app.supplier (tenant_id, code)
  where deleted_at is null;
create unique index supplier_origin_uq
  on app.supplier (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
create index supplier_active_ix on app.supplier (tenant_id, is_active, code)
  where deleted_at is null;
select app.apply_tenant_rls('app.supplier');

comment on table app.supplier is
  'Everyone the tenant buys from or pays to carry goods. A haulier is a supplier with a HAULAGE capability, never a separate party type and never a vehicle (ADR-0001).';

-- The currency guard. An unenforced comment is how a second currency gets
-- into a single-currency ledger and is not noticed until a reconciliation.
create function app.assert_supplier_currency() returns trigger
language plpgsql as $$
declare
  pack_currency char(3);
begin
  select j.currency_code into pack_currency
    from platform.tenant t
    join platform.jurisdiction j on j.code = t.jurisdiction_code
   where t.id = new.tenant_id;

  if pack_currency is null then
    raise exception 'supplier %: tenant % has no resolvable jurisdiction pack', new.id, new.tenant_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.currency_code <> pack_currency then
    raise exception
      'supplier %: currency % is not this tenant''s pack currency % — a tenant belongs to exactly one jurisdiction and FX in the ledger is out of scope (CLAUDE.md §2.5)',
      new.id, new.currency_code, pack_currency
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger supplier_currency_matches_pack
  before insert or update of currency_code on app.supplier
  for each row execute function app.assert_supplier_currency();


-- ============================================================================
-- 2. app.supplier_capability_type / app.supplier_capability
--
-- ---------------------------------------------------------------------------
-- THE SPLIT HERE IS EXACTLY location_type / location.kind (04 §4.3)
-- ---------------------------------------------------------------------------
-- `supplier_capability_type.code` and `.name` are TENANT VOCABULARY. A tenant
-- may define "Cement supply", "Steel supply", "Trucking" and "River barge" if
-- that is how it thinks. NO PLATFORM CODE EVER READS THAT CODE — reading it
-- would be `if (type.code === 'HAULAGE')`, which is the same defect as
-- `if (tenant === 'agyasei')` (ADR-0006, CLAUDE.md §2.9).
--
-- `supplier_capability_type.kind` is PLATFORM STRUCTURE, a closed enum,
-- because the platform genuinely branches on it: a delivery's carrier must be
-- able to HAUL, and ADR-0001's promise that distribution cost is measurable
-- requires the platform to tell haulage spend from cement spend. Two rows in
-- the template, four in some other tenant, two platform kinds either way.
--
-- Multi-capability is the normal case, not an edge: a regional cement
-- distributor that also runs trucks holds two rows here, and both are true at
-- once.
-- ============================================================================
create table app.supplier_capability_type (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,

  -- TENANT vocabulary. Never branched on.
  code text not null,
  name text not null,

  -- PLATFORM structure. The only thing platform code may read.
  kind text not null check (kind in ('GOODS', 'HAULAGE')),

  origin_template_id text,
  origin_ref         text,

  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
create unique index supplier_capability_type_code_uq
  on app.supplier_capability_type (tenant_id, code) where deleted_at is null;
create unique index supplier_capability_type_origin_uq
  on app.supplier_capability_type (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
create index supplier_capability_type_kind_ix
  on app.supplier_capability_type (tenant_id, kind) where deleted_at is null;
select app.apply_tenant_rls('app.supplier_capability_type');

comment on column app.supplier_capability_type.code is
  'TENANT vocabulary — the tenant''s own word. No platform code reads it (ADR-0006).';
comment on column app.supplier_capability_type.kind is
  'PLATFORM structure, closed enum. The only column platform code may branch on — a carrier must be able to HAUL, and haulage spend must be separable to measure distribution cost (ADR-0001, Q1).';

create table app.supplier_capability (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,

  supplier_id        uuid not null,
  capability_type_id uuid not null,
  notes              text,

  origin_template_id text,
  origin_ref         text,

  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, supplier_id) references app.supplier (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, capability_type_id)
    references app.supplier_capability_type (tenant_id, id)
    deferrable initially immediate
);
create unique index supplier_capability_uq
  on app.supplier_capability (tenant_id, supplier_id, capability_type_id)
  where deleted_at is null;
create index supplier_capability_type_ix
  on app.supplier_capability (tenant_id, capability_type_id, supplier_id)
  where deleted_at is null;
create unique index supplier_capability_origin_uq
  on app.supplier_capability (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
select app.apply_tenant_rls('app.supplier_capability');

comment on table app.supplier_capability is
  'What a supplier can do for this tenant. Several rows per supplier is the normal case: one party may both sell goods and haul them.';


-- ============================================================================
-- 3. app.supplier_product — MULTI-SOURCE (§4.10).
--
-- One row per (supplier, product): the same SKU sourced from GHACEM, Dangote
-- and CIMAF is three rows, which is the whole point — the business plan's
-- Lever 2 is negotiating leverage from multi-sourcing, and it needs the
-- alternatives to be data rather than a memory.
--
-- `purchase_uom_id` REUSES THE product_uom MACHINERY. It must be a live
-- `product_uom` row for this product with `can_buy` set — enforced by the
-- constraint trigger below, because a purchase unit that is not a declared
-- unit of the product has no conversion factor, and a receipt against it
-- could not be converted into the stocking unit the ledger is denominated in.
--
-- `last_price_e4` is minor units PER ONE PURCHASE UNIT × 10⁴ (app.rate_e4,
-- 04 §4.2.1). It is a decision-support figure — what we last paid — and it is
-- NOT the price of any particular order: the order line snapshots its own.
-- ============================================================================
create table app.supplier_product (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,

  supplier_id uuid not null,
  product_id  uuid not null,

  -- The supplier's own code for this thing, as printed on their invoice.
  supplier_sku text,

  -- The unit this supplier sells in. A product_uom row with can_buy.
  purchase_uom_id uuid not null,

  -- Calendar days from order to expected delivery. Read by Phase 2's
  -- order-up-to arithmetic alongside app.reorder_point.lead_time_days
  -- (migration 0007), which is the same number recorded per location.
  lead_time_days smallint check (lead_time_days >= 0),

  -- What we last paid, per ONE purchase unit, × 10⁴. NULL until we have paid
  -- anything — a zero here would read as "free".
  last_price_e4 app.rate_e4 check (last_price_e4 >= 0),
  last_price_on date,

  -- At most one preferred source per product (partial unique index below).
  -- "Preferred" is a default, never a restriction: ordering from a
  -- non-preferred source is an ordinary act needing no extra permission.
  is_preferred boolean not null default false,

  is_active boolean not null default true,
  notes     text,

  origin_template_id text,
  origin_ref         text,

  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, supplier_id) references app.supplier (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, product_id) references app.product (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, purchase_uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate
);
create unique index supplier_product_uq
  on app.supplier_product (tenant_id, supplier_id, product_id) where deleted_at is null;
-- "Who can supply this?" — the multi-source access path.
create index supplier_product_product_ix
  on app.supplier_product (tenant_id, product_id, supplier_id) where deleted_at is null;
-- Exactly one preferred source per product. Two would make "order from the
-- usual place" ambiguous, and an ambiguous default is a phone call.
create unique index supplier_product_preferred_uq
  on app.supplier_product (tenant_id, product_id)
  where is_preferred and deleted_at is null;
create unique index supplier_product_origin_uq
  on app.supplier_product (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
select app.apply_tenant_rls('app.supplier_product');

comment on column app.supplier_product.purchase_uom_id is
  'The unit this supplier sells in. MUST be a live app.product_uom row for this product with can_buy — the same machinery selling uses, in the opposite direction (§4.10). Enforced by supplier_product_buyable_uom.';
comment on column app.supplier_product.last_price_e4 is
  'Minor units per ONE purchase unit × 10^4 (app.rate_e4). Decision support, not a contracted price — the order line snapshots its own.';

create function app.assert_supplier_product_purchase_uom() returns trigger
language plpgsql as $$
declare
  buyable boolean;
begin
  select true into buyable
    from app.product_uom pu
   where pu.tenant_id = new.tenant_id
     and pu.product_id = new.product_id
     and pu.uom_id = new.purchase_uom_id
     and pu.can_buy
     and pu.deleted_at is null;

  if buyable is not true then
    raise exception
      'supplier_product %: uom % is not a buyable unit of product % — a purchase unit must be a live product_uom row with can_buy, so a receipt in it has a conversion factor into the stocking unit (§4.10, 04 §4.4.1)',
      new.id, new.purchase_uom_id, new.product_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create constraint trigger supplier_product_buyable_uom
  after insert or update of product_id, purchase_uom_id on app.supplier_product
  for each row execute function app.assert_supplier_product_purchase_uom();


-- ============================================================================
-- 4. app.purchase_order — A STATE MACHINE, AND THE TRANSITIONS ARE ENFORCED.
--
-- ---------------------------------------------------------------------------
-- THE STATES
-- ---------------------------------------------------------------------------
--   DRAFT               being written. Lines may be added, changed, removed.
--                       The ONLY status a purchase order may be INSERTED at.
--   SUBMITTED           finished and sent for approval. Lines are frozen.
--   APPROVED            authorised. Goods may now be received against it.
--   PARTIALLY_RECEIVED  some but not all of it has arrived.
--   RECEIVED            all of it has arrived.
--   CANCELLED           abandoned BEFORE anything was received. Terminal.
--   CLOSED              no more is expected. Terminal. This is how a SHORT
--                       DELIVERY ends: short deliveries are normal, not an
--                       error, and "we are not waiting for the other four
--                       tonnes" has to be sayable.
--
-- ---------------------------------------------------------------------------
-- THE LEGAL TRANSITIONS — the canonical statement is
-- app.purchase_order_legal_transitions(), and the trigger enforces it.
-- ---------------------------------------------------------------------------
--   DRAFT              -> SUBMITTED | CANCELLED
--   SUBMITTED          -> APPROVED | DRAFT (returned for amendment) | CANCELLED
--   APPROVED           -> PARTIALLY_RECEIVED | RECEIVED | CLOSED | CANCELLED
--   PARTIALLY_RECEIVED -> RECEIVED | CLOSED
--   RECEIVED           -> CLOSED
--   CANCELLED          -> (terminal)
--   CLOSED             -> (terminal)
--
-- Read what is ABSENT, because that is where the control is:
--
--   * NOTHING RETURNS TO DRAFT ONCE GOODS HAVE BEEN RECEIVED. A purchase
--     order that can go RECEIVED -> DRAFT is a hole in the audit trail: the
--     lines become editable again and the order can be retro-fitted to
--     whatever turned up, which is precisely the fabrication a purchase order
--     exists to prevent. SUBMITTED -> DRAFT is the one backward edge, and it
--     is safe because nothing has been received against a SUBMITTED order —
--     the goods_receipt guard refuses that outright.
--   * CANCELLED IS UNREACHABLE ONCE ANYTHING HAS BEEN RECEIVED. Cancelling an
--     order whose goods are in the yard would orphan the receipt. Short and
--     abandoned deliveries end at CLOSED, which keeps the receipts attached.
--   * APPROVED IS UNREACHABLE FROM DRAFT. Approval is a distinct act by a
--     distinct capability (0009: purchase.order.create vs
--     purchase.order.approve), and it must leave a record — the trigger
--     refuses APPROVED without approved_by_user_id and approved_at.
--
-- The function is exposed rather than inlined so the API can serve the legal
-- next steps to a client and a screen can grey out the buttons from the
-- server's own answer instead of a second, drifting copy of this list.
-- ============================================================================
create function app.purchase_order_legal_transitions()
returns table (from_status text, to_status text)
language sql immutable parallel safe as $$
  select * from (values
    ('DRAFT'::text,        'SUBMITTED'::text),
    ('DRAFT',              'CANCELLED'),
    ('SUBMITTED',          'APPROVED'),
    ('SUBMITTED',          'DRAFT'),
    ('SUBMITTED',          'CANCELLED'),
    ('APPROVED',           'PARTIALLY_RECEIVED'),
    ('APPROVED',           'RECEIVED'),
    ('APPROVED',           'CLOSED'),
    ('APPROVED',           'CANCELLED'),
    ('PARTIALLY_RECEIVED', 'RECEIVED'),
    ('PARTIALLY_RECEIVED', 'CLOSED'),
    ('RECEIVED',           'CLOSED')
  ) as t (from_status, to_status)
$$;

comment on function app.purchase_order_legal_transitions() is
  'THE canonical purchase-order state machine. Nothing returns to DRAFT once goods have been received; CANCELLED is unreachable after any receipt; CLOSED is how a short delivery ends.';

create function app.purchase_order_transition_allowed(p_from text, p_to text)
returns boolean language sql stable parallel safe as $$
  select exists (
    select 1 from app.purchase_order_legal_transitions() t
     where t.from_status = p_from and t.to_status = p_to
  )
$$;

create table app.purchase_order (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,

  supplier_id             uuid not null,
  -- Where the goods are to arrive. Must be a stock-holding location: an
  -- order delivered to a GROUP node has nowhere to land.
  deliver_to_location_id  uuid not null,

  -- Human-facing document number. NULLABLE, and that is deliberate: a
  -- network-wide sequence is exactly the coordination two offline outlets
  -- cannot do (03 §3.7.5, 04 §4.3). A tenant that wants numbered orders seeds
  -- an app.sequence_counter under its own sequence_key and allocates blocks
  -- the same way receipts do; until it does, the UUID is identity and the
  -- order has no number rather than a number two devices both minted.
  order_no text,

  status text not null default 'DRAFT' check (status in
    ('DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED',
     'RECEIVED', 'CANCELLED', 'CLOSED')),

  -- The trading day the order was raised, and the day it is expected.
  order_date  date not null,
  expected_at date,

  -- Snapshots from the jurisdiction pack, exactly as app.sale carries them:
  -- a historical document reads correctly ten years later without joining to
  -- a definition that may have been superseded. NEVER assume 100.
  currency_code char(3) not null,
  money_scale   bigint  not null,

  -- Who authorised it, and when. Required at APPROVED by the trigger: an
  -- approval with nobody's name on it is not an approval.
  submitted_at        timestamptz,
  approved_at         timestamptz,
  approved_by_user_id uuid,
  closed_at           timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text,

  notes text,

  origin_template_id text,
  origin_ref         text,

  -- A draft may be thrown away. Anything that has been submitted must be
  -- CANCELLED or CLOSED, never quietly hidden — a soft-deleted APPROVED order
  -- with receipts against it is the divergence 04 §4.2.4 describes, where one
  -- report loses a document another report still sums.
  constraint po_soft_delete_draft_only check (deleted_at is null or status = 'DRAFT'),

  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, supplier_id) references app.supplier (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, deliver_to_location_id) references app.location (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, approved_by_user_id) references app.user_account (tenant_id, id)
    deferrable initially immediate
);
create unique index purchase_order_no_uq
  on app.purchase_order (tenant_id, order_no)
  where order_no is not null and deleted_at is null;
create index purchase_order_supplier_ix
  on app.purchase_order (tenant_id, supplier_id, order_date);
create index purchase_order_location_ix
  on app.purchase_order (tenant_id, deliver_to_location_id, status, order_date);
create index purchase_order_open_ix
  on app.purchase_order (tenant_id, status, expected_at);
create unique index purchase_order_origin_uq
  on app.purchase_order (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
select app.apply_tenant_rls('app.purchase_order');

comment on column app.purchase_order.status is
  'State machine; legal transitions are app.purchase_order_legal_transitions() and are enforced by trigger. Inserts must be DRAFT.';
comment on column app.purchase_order.money_scale is
  'Snapshot of the pack''s minor_units_per_major. NEVER assume 100 (CLAUDE.md §2.3).';

-- ----------------------------------------------------------------------------
-- app.purchase_order_line
--
-- Mirrors app.sale_line's shape on purpose (04 §4.4.4). Two quantities and a
-- snapshotted rational factor, because what is PRICED and what will ENTER THE
-- YARD are different facts in different units:
--
--   qty_ordered       in the supplier's unit (uom_id) — what is being bought
--                     and what the price applies to.
--   qty_ordered_stock in the product's stocking unit — what the yard expects,
--                     and the denomination app.stock_movement and
--                     app.reorder_point are in.
--   factor_num/den    the conversion AS AT THE ORDER. Correcting a factor
--                     tomorrow must not restate a historical document.
-- ----------------------------------------------------------------------------
create table app.purchase_order_line (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,

  purchase_order_id uuid     not null,
  line_no           smallint not null check (line_no > 0),
  product_id        uuid     not null,

  -- what is PRICED, in the supplier's unit
  uom_id        uuid        not null,
  qty_scale     smallint    not null,
  qty_ordered   app.qty     not null check (qty_ordered > 0),
  unit_price_e4 app.rate_e4 not null check (unit_price_e4 >= 0),

  -- what the yard expects, in the stocking unit
  stocking_uom_id   uuid     not null,
  qty_stock_scale   smallint not null,
  qty_ordered_stock app.qty  not null check (qty_ordered_stock > 0),
  factor_num        bigint   not null check (factor_num > 0),
  factor_den        bigint   not null check (factor_den > 0),

  -- The extended amount, in minor units. A rate becomes an amount exactly
  -- once (04 §4.13) and this is that point for a purchase order; the rounding
  -- rule is the API's and it is stated there, not implied here.
  line_net_minor app.money_minor not null check (line_net_minor >= 0),

  notes text,

  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, purchase_order_id) references app.purchase_order (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, product_id) references app.product (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, stocking_uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate
);
create unique index purchase_order_line_uq
  on app.purchase_order_line (tenant_id, purchase_order_id, line_no)
  where deleted_at is null;
create index purchase_order_line_product_ix
  on app.purchase_order_line (tenant_id, product_id, purchase_order_id);
select app.apply_tenant_rls('app.purchase_order_line');

-- ----------------------------------------------------------------------------
-- The state-machine trigger, and the freeze that gives it teeth.
--
-- A transition table nobody enforces is a diagram. Three things are checked:
-- the transition is legal; an order cannot leave DRAFT empty; and an APPROVED
-- order names its approver. Plus: once an order leaves DRAFT, the commercial
-- terms are frozen — changing the supplier or the delivery destination of an
-- approved order is the same fabrication as editing its lines.
-- ----------------------------------------------------------------------------
create function app.assert_purchase_order_transition() returns trigger
language plpgsql as $$
declare
  live_lines integer;
  loc_kind   text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' then
      raise exception
        'purchase_order %: may only be created as DRAFT, not % — approval is a separate act by a separate capability and it must leave a record (0009 purchase.order.approve)',
        new.id, new.status
        using errcode = 'check_violation';
    end if;

    select l.kind into loc_kind
      from app.location l
     where l.tenant_id = new.tenant_id and l.id = new.deliver_to_location_id;
    if loc_kind is null or loc_kind not in ('OUTLET', 'WAREHOUSE') then
      raise exception
        'purchase_order %: deliver-to location % is kind % — goods can only be ordered to a location that holds stock',
        new.id, new.deliver_to_location_id, coalesce(loc_kind, '<missing>')
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Terms are frozen once the order has left DRAFT.
  if old.status <> 'DRAFT' and (
       new.supplier_id            is distinct from old.supplier_id
    or new.deliver_to_location_id is distinct from old.deliver_to_location_id
    or new.currency_code          is distinct from old.currency_code
    or new.money_scale            is distinct from old.money_scale
    or new.order_date             is distinct from old.order_date
  ) then
    raise exception
      'purchase_order %: the supplier, destination, currency and order date are frozen once the order leaves DRAFT (it is %) — a change there is a different order, not an edit',
      new.id, old.status
      using errcode = 'check_violation';
  end if;

  if new.status is not distinct from old.status then
    return new;
  end if;

  if not app.purchase_order_transition_allowed(old.status, new.status) then
    raise exception
      'purchase_order %: % -> % is not a legal transition. The state machine is app.purchase_order_legal_transitions(); nothing returns to DRAFT once goods have been received, and CANCELLED is unreachable after any receipt',
      new.id, old.status, new.status
      using errcode = 'check_violation';
  end if;

  if old.status = 'DRAFT' then
    select count(*) into live_lines
      from app.purchase_order_line pol
     where pol.tenant_id = new.tenant_id
       and pol.purchase_order_id = new.id
       and pol.deleted_at is null;
    if live_lines = 0 then
      raise exception
        'purchase_order %: cannot leave DRAFT with no lines — an order for nothing is not an order',
        new.id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.status = 'APPROVED'
     and (new.approved_by_user_id is null or new.approved_at is null) then
    raise exception
      'purchase_order %: APPROVED requires approved_by_user_id and approved_at — an approval with nobody''s name on it is not an approval',
      new.id
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

create trigger purchase_order_state_machine
  before insert or update on app.purchase_order
  for each row execute function app.assert_purchase_order_transition();

-- Lines are editable only while the order is DRAFT. This is the other half of
-- the audit control: freezing the status without freezing the lines would let
-- an approved order be retro-fitted to whatever arrived. A soft delete is an
-- UPDATE and is refused by the same rule.
create function app.assert_purchase_order_line_draft_only() returns trigger
language plpgsql as $$
declare
  t_id      uuid;
  po_id     uuid;
  po_status text;
begin
  if tg_op = 'DELETE' then
    t_id := old.tenant_id; po_id := old.purchase_order_id;
  else
    t_id := new.tenant_id; po_id := new.purchase_order_id;
  end if;

  select po.status into po_status
    from app.purchase_order po
   where po.tenant_id = t_id and po.id = po_id;

  if po_status is null then
    raise exception 'purchase_order_line: purchase order % is not visible in this tenant', po_id
      using errcode = 'foreign_key_violation';
  end if;

  if po_status <> 'DRAFT' then
    raise exception
      'purchase_order_line: purchase order % is % — lines may only be added, changed or removed while the order is DRAFT. Correcting an issued order means cancelling or closing it and raising another',
      po_id, po_status
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger purchase_order_line_draft_only
  before insert or update or delete on app.purchase_order_line
  for each row execute function app.assert_purchase_order_line_draft_only();


-- ============================================================================
-- 5. app.goods_receipt / app.goods_receipt_line — GOODS-RECEIVED MATCHING.
--
-- ---------------------------------------------------------------------------
-- TWO QUANTITIES, BECAUSE SHORT DELIVERIES ARE NORMAL (§4.10)
-- ---------------------------------------------------------------------------
--   qty_received  in the SUPPLIER's unit. What the waybill says, what the
--                 invoice will be raised for.
--   qty_stock     in the STOCKING unit. What actually entered the yard, and
--                 the ONLY figure app.stock_movement sees.
--
-- They are recorded independently and neither is derived from the other. Ten
-- tonnes ordered, nine and a half delivered, and 190 bags counted off the
-- truck are three separate facts, and the system that quietly reconciles them
-- for you is the system that hides the loss.
--
-- `qty_stock_computed` is what the snapshotted conversion factor says
-- `qty_received` should have become. Where they differ, a human confirmed the
-- difference and their id is on the row (04 §4.4.4) — the CHECK is a plain
-- column comparison rather than a function call in a constraint, which is
-- exactly the shape §4.4.4 asks for.
--
-- A receipt is a DOCUMENT: append-only, never soft-deleted (04 §4.2.4).
-- Corrections are compensating movements (RETURN_TO_SUPPLIER, COUNT_ADJUST),
-- never edits.
-- ============================================================================
create table app.goods_receipt (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,

  -- NULLABLE. A receipt with no order happens — an emergency collection, a
  -- returned delivery, an opening consignment — and recording it honestly
  -- with no order beats inventing an order to satisfy a NOT NULL. The API may
  -- require one by policy; the schema records what happened.
  purchase_order_id uuid,
  supplier_id       uuid not null,
  location_id       uuid not null,

  -- The trading day the goods landed. This is the accounting fact.
  business_date date not null,
  -- Device time. UNTRUSTED (03 §3.4.2). Display and forensics only.
  received_at   timestamptz not null,

  -- The paper that came with the truck. Opaque references, never parsed.
  supplier_delivery_note_ref text,
  supplier_invoice_ref       text,

  received_by_user_id uuid,
  notes text,

  constraint gr_deleted_never check (deleted_at is null),

  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, purchase_order_id) references app.purchase_order (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, supplier_id) references app.supplier (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, received_by_user_id) references app.user_account (tenant_id, id)
    deferrable initially immediate
);
create index goods_receipt_order_ix
  on app.goods_receipt (tenant_id, purchase_order_id);
create index goods_receipt_location_ix
  on app.goods_receipt (tenant_id, location_id, business_date);
create index goods_receipt_supplier_ix
  on app.goods_receipt (tenant_id, supplier_id, business_date);
select app.apply_tenant_rls('app.goods_receipt');

revoke update, delete on app.goods_receipt from app_user;
create trigger goods_receipt_append_only
  before update or delete on app.goods_receipt
  for each row execute function app.forbid_mutation();

comment on column app.goods_receipt.business_date is
  'The trading day the goods landed — the accounting fact. Never derived from a device clock (03 §3.4.2).';

create table app.goods_receipt_line (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,

  goods_receipt_id      uuid     not null,
  line_no               smallint not null check (line_no > 0),
  -- NULL when nothing on the order matches this line: an unordered extra on
  -- the truck is a fact, and refusing to record it does not make it go away.
  purchase_order_line_id uuid,
  product_id            uuid     not null,

  -- what was INVOICED, in the supplier's unit
  uom_id             uuid     not null,
  qty_received_scale smallint not null,
  qty_received       app.qty  not null check (qty_received > 0),

  -- what ENTERED THE YARD, in the stocking unit. The only figure the movement
  -- ledger sees.
  stocking_uom_id    uuid     not null,
  qty_stock_scale    smallint not null,
  qty_stock          app.qty  not null check (qty_stock > 0),
  -- What the snapshotted factor says qty_stock should have been.
  qty_stock_computed app.qty  not null check (qty_stock_computed > 0),
  factor_num         bigint   not null check (factor_num > 0),
  factor_den         bigint   not null check (factor_den > 0),
  -- Who signed for a difference between the two (04 §4.4.4).
  conversion_confirmed_by uuid,

  -- Cost as invoiced, per ONE PURCHASE unit, × 10⁴.
  unit_cost_e4       app.rate_e4 not null check (unit_cost_e4 >= 0),
  -- The same cost per ONE STOCKING unit, × 10⁴ — derived once, here, and
  -- copied onto app.stock_movement.unit_cost_e4 where the weighted-average
  -- cost replay reads it (04 §4.7.4). Deriving it again at read time would be
  -- a second rounding of the same figure.
  stock_unit_cost_e4 app.rate_e4 not null check (stock_unit_cost_e4 >= 0),
  -- The extended amount, in minor units.
  line_net_minor     app.money_minor not null check (line_net_minor >= 0),

  notes text,

  constraint grl_deleted_never check (deleted_at is null),
  -- §4.4.4, expressed as a plain column comparison: a quantity that differs
  -- from the computed conversion needs a human's id against it.
  constraint grl_conversion_confirmed check (
    qty_stock = qty_stock_computed or conversion_confirmed_by is not null
  ),

  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, goods_receipt_id) references app.goods_receipt (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, purchase_order_line_id)
    references app.purchase_order_line (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, product_id) references app.product (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, stocking_uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, conversion_confirmed_by) references app.user_account (tenant_id, id)
    deferrable initially immediate
);
create unique index goods_receipt_line_uq
  on app.goods_receipt_line (tenant_id, goods_receipt_id, line_no);
create index goods_receipt_line_order_line_ix
  on app.goods_receipt_line (tenant_id, purchase_order_line_id);
create index goods_receipt_line_product_ix
  on app.goods_receipt_line (tenant_id, product_id, goods_receipt_id);
select app.apply_tenant_rls('app.goods_receipt_line');

revoke update, delete on app.goods_receipt_line from app_user;
create trigger goods_receipt_line_append_only
  before update or delete on app.goods_receipt_line
  for each row execute function app.forbid_mutation();

comment on column app.goods_receipt_line.qty_received is
  'What the supplier invoiced, in THEIR unit. Independent of qty_stock — short deliveries are normal, not an error (§4.10).';
comment on column app.goods_receipt_line.qty_stock is
  'What entered the yard, in the STOCKING unit. The only figure app.stock_movement sees.';

-- ----------------------------------------------------------------------------
-- The matching guards.
--
-- Receiving is where a fabricated document does its damage, so the shape of a
-- receipt is checked rather than trusted:
--   * goods may only be received against an APPROVED or PARTIALLY_RECEIVED
--     order — never against a draft or a submitted one, which is what would
--     let a receipt precede its own authorisation;
--   * the receipt's supplier must be the order's supplier;
--   * goods land only where stock is held;
--   * a matched line must belong to the receipt's own order, name the same
--     product, and be denominated in the SAME unit at the SAME scale — which
--     is what makes summing received against ordered an honest comparison
--     rather than a sum of tonnes and bags.
-- ----------------------------------------------------------------------------
create function app.assert_goods_receipt_matches_order() returns trigger
language plpgsql as $$
declare
  loc_kind    text;
  po_supplier uuid;
  po_status   text;
begin
  select l.kind into loc_kind
    from app.location l
   where l.tenant_id = new.tenant_id and l.id = new.location_id;
  if loc_kind is null or loc_kind not in ('OUTLET', 'WAREHOUSE') then
    raise exception
      'goods_receipt %: location % is kind % — goods can only be received where stock is held',
      new.id, new.location_id, coalesce(loc_kind, '<missing>')
      using errcode = 'check_violation';
  end if;

  if new.purchase_order_id is not null then
    select po.supplier_id, po.status into po_supplier, po_status
      from app.purchase_order po
     where po.tenant_id = new.tenant_id and po.id = new.purchase_order_id;

    if po_status is null then
      raise exception 'goods_receipt %: purchase order % is not visible in this tenant',
        new.id, new.purchase_order_id
        using errcode = 'foreign_key_violation';
    end if;

    if po_supplier <> new.supplier_id then
      raise exception
        'goods_receipt %: supplier % is not the supplier % on order % — a receipt names the party that delivered it',
        new.id, new.supplier_id, po_supplier, new.purchase_order_id
        using errcode = 'check_violation';
    end if;

    if po_status not in ('APPROVED', 'PARTIALLY_RECEIVED') then
      raise exception
        'goods_receipt %: purchase order % is % — goods may only be received against an APPROVED or PARTIALLY_RECEIVED order. Approving an order and receiving its goods are separate acts held by separate capabilities (purchase.order.approve, goods.receive)',
        new.id, new.purchase_order_id, po_status
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end
$$;

create constraint trigger goods_receipt_matches_order
  after insert on app.goods_receipt
  for each row execute function app.assert_goods_receipt_matches_order();

create function app.assert_goods_receipt_line_match() returns trigger
language plpgsql as $$
declare
  receipt_order  uuid;
  stocking_uom   uuid;
  stocking_scale smallint;
  purchase_scale smallint;
  pol_order      uuid;
  pol_product    uuid;
  pol_uom        uuid;
  pol_scale      smallint;
begin
  -- The receipt line's stocking unit must be the PRODUCT's stocking unit, at
  -- its scale: the movement ledger is denominated there and nowhere else
  -- (04 §4.4.3). The same guard app.reorder_point carries, for the same
  -- reason — otherwise one mis-entered row compares tonnes against bars.
  select p.stocking_uom_id, u.qty_scale into stocking_uom, stocking_scale
    from app.product p
    join app.unit_of_measure u
      on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
   where p.tenant_id = new.tenant_id and p.id = new.product_id;

  if stocking_uom is null then
    raise exception 'goods_receipt_line %: product % has no resolvable stocking unit',
      new.id, new.product_id
      using errcode = 'foreign_key_violation';
  end if;
  if new.stocking_uom_id <> stocking_uom or new.qty_stock_scale <> stocking_scale then
    raise exception
      'goods_receipt_line %: qty_stock must be denominated in the product''s stocking unit % at scale % (got % at scale %)',
      new.id, stocking_uom, stocking_scale, new.stocking_uom_id, new.qty_stock_scale
      using errcode = 'check_violation';
  end if;

  -- The received quantity's scale must be the purchase unit's own scale.
  select u.qty_scale into purchase_scale
    from app.unit_of_measure u
   where u.tenant_id = new.tenant_id and u.id = new.uom_id;
  if purchase_scale is null then
    raise exception 'goods_receipt_line %: unit % is not visible in this tenant', new.id, new.uom_id
      using errcode = 'foreign_key_violation';
  end if;
  if new.qty_received_scale <> purchase_scale then
    raise exception
      'goods_receipt_line %: qty_received_scale % is not unit %''s scale % — the two would differ by a power of ten',
      new.id, new.qty_received_scale, new.uom_id, purchase_scale
      using errcode = 'check_violation';
  end if;

  select gr.purchase_order_id into receipt_order
    from app.goods_receipt gr
   where gr.tenant_id = new.tenant_id and gr.id = new.goods_receipt_id;

  if new.purchase_order_line_id is null then
    return new;
  end if;

  if receipt_order is null then
    raise exception
      'goods_receipt_line %: the receipt has no purchase order, so it cannot match order line %',
      new.id, new.purchase_order_line_id
      using errcode = 'check_violation';
  end if;

  select pol.purchase_order_id, pol.product_id, pol.uom_id, pol.qty_scale
    into pol_order, pol_product, pol_uom, pol_scale
    from app.purchase_order_line pol
   where pol.tenant_id = new.tenant_id and pol.id = new.purchase_order_line_id;

  if pol_order is null then
    raise exception 'goods_receipt_line %: order line % is not visible in this tenant',
      new.id, new.purchase_order_line_id
      using errcode = 'foreign_key_violation';
  end if;
  if pol_order <> receipt_order then
    raise exception
      'goods_receipt_line %: order line % belongs to order %, not to this receipt''s order %',
      new.id, new.purchase_order_line_id, pol_order, receipt_order
      using errcode = 'check_violation';
  end if;
  if pol_product <> new.product_id then
    raise exception
      'goods_receipt_line %: order line % is for product %, this line is for product %',
      new.id, new.purchase_order_line_id, pol_product, new.product_id
      using errcode = 'check_violation';
  end if;
  if pol_uom <> new.uom_id or pol_scale <> new.qty_received_scale then
    raise exception
      'goods_receipt_line %: order line % is denominated in unit % at scale %, this line in unit % at scale % — received cannot be summed against ordered across two units',
      new.id, new.purchase_order_line_id, pol_uom, pol_scale, new.uom_id, new.qty_received_scale
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

create constraint trigger goods_receipt_line_matches
  after insert on app.goods_receipt_line
  for each row execute function app.assert_goods_receipt_line_match();

-- ----------------------------------------------------------------------------
-- app.purchase_order_line_status — what is still outstanding, DERIVED.
--
-- security_invoker so RLS is evaluated as the querying role, not the view
-- owner (04 §4.2.5) — the same rule app.stock_on_hand and app.reorder_status
-- follow.
--
-- qty_received sums the receipt lines matched to this order line. The
-- matching trigger above guarantees every one of them is in the SAME unit at
-- the SAME scale as the order line, so this is a sum of like with like and
-- qty_outstanding is a difference of two integers needing no conversion and
-- no rounding.
--
-- qty_outstanding may be NEGATIVE (an over-delivery) and it is not clamped:
-- clamping would hide the over-delivery, which is the one an invoice will be
-- raised for.
-- ----------------------------------------------------------------------------
create view app.purchase_order_line_status
  with (security_invoker = true) as
select pol.tenant_id,
       pol.purchase_order_id,
       pol.id            as purchase_order_line_id,
       pol.line_no,
       pol.product_id,
       pol.uom_id,
       pol.qty_scale,
       pol.qty_ordered,
       coalesce(sum(grl.qty_received), 0)::bigint as qty_received,
       (pol.qty_ordered - coalesce(sum(grl.qty_received), 0))::bigint as qty_outstanding,
       pol.stocking_uom_id,
       pol.qty_stock_scale,
       pol.qty_ordered_stock,
       coalesce(sum(grl.qty_stock), 0)::bigint as qty_stock_received,
       (coalesce(sum(grl.qty_received), 0) >= pol.qty_ordered) as is_fully_received,
       count(grl.id)::bigint as receipt_line_count
  from app.purchase_order_line pol
  left join app.goods_receipt_line grl
    on grl.tenant_id = pol.tenant_id
   and grl.purchase_order_line_id = pol.id
 where pol.deleted_at is null
 group by pol.tenant_id, pol.purchase_order_id, pol.id, pol.line_no, pol.product_id,
          pol.uom_id, pol.qty_scale, pol.qty_ordered,
          pol.stocking_uom_id, pol.qty_stock_scale, pol.qty_ordered_stock;

comment on view app.purchase_order_line_status is
  'Ordered vs received per order line, DERIVED by summing matched receipt lines — never a stored counter. Both sides are in the order line''s unit at its scale, guaranteed by the matching trigger. qty_outstanding is signed: an over-delivery shows as negative rather than being clamped away.';


-- ============================================================================
-- 6. app.delivery — THIRD-PARTY DISPATCH AND STATUS. NO FLEET (ADR-0001).
--
-- A delivery attaches a CARRIER to a document that has to move: an inbound
-- purchase order, or an outbound sale to a customer's site. The carrier is a
-- supplier holding a HAULAGE capability — enforced by trigger — which is what
-- puts the freight in AP and makes distribution cost as a percentage of
-- revenue a query rather than an estimate.
--
-- `source_kind` is PLATFORM document vocabulary, closed and enumerated, like
-- app.stock_movement.source_kind. `source_id` carries no foreign key because
-- it is polymorphic; the trigger checks the referent exists in this tenant,
-- per kind. STOCK_TRANSFER is deliberately ABSENT from the enum:
-- app.stock_transfer (04 §4.7.3) does not exist yet, and an enum value
-- pointing at no table is a value nothing can enforce. It is added by the
-- migration that adds the table.
--
-- ---------------------------------------------------------------------------
-- THE DELIVERY STATE MACHINE — app.delivery_legal_transitions()
-- ---------------------------------------------------------------------------
--   PLANNED    -> DISPATCHED | CANCELLED
--   DISPATCHED -> IN_TRANSIT | DELIVERED | FAILED
--   IN_TRANSIT -> DELIVERED | FAILED
--   FAILED     -> DISPATCHED (re-attempted) | CANCELLED
--   DELIVERED  -> (terminal)
--   CANCELLED  -> (terminal)
--
-- DELIVERED is terminal for the same reason RECEIVED does not return to
-- DRAFT: a delivery that can be un-delivered is a status nobody can rely on
-- when a customer telephones.
-- ============================================================================
create function app.delivery_legal_transitions()
returns table (from_status text, to_status text)
language sql immutable parallel safe as $$
  select * from (values
    ('PLANNED'::text,    'DISPATCHED'::text),
    ('PLANNED',    'CANCELLED'),
    ('DISPATCHED', 'IN_TRANSIT'),
    ('DISPATCHED', 'DELIVERED'),
    ('DISPATCHED', 'FAILED'),
    ('IN_TRANSIT', 'DELIVERED'),
    ('IN_TRANSIT', 'FAILED'),
    ('FAILED',     'DISPATCHED'),
    ('FAILED',     'CANCELLED')
  ) as t (from_status, to_status)
$$;

create function app.delivery_transition_allowed(p_from text, p_to text)
returns boolean language sql stable parallel safe as $$
  select exists (
    select 1 from app.delivery_legal_transitions() t
     where t.from_status = p_from and t.to_status = p_to
  )
$$;

create table app.delivery (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,

  -- PLATFORM document vocabulary. Polymorphic; checked per kind by trigger.
  source_kind text not null check (source_kind in ('PURCHASE_ORDER', 'SALE')),
  source_id   uuid not null,

  -- ADR-0001's carrier abstraction, and the attachment point if owned
  -- vehicles ever appear. NOT NULL: if a delivery exists, somebody carried
  -- it, and naming them is what makes the cost of carrying measurable.
  carrier_supplier_id uuid not null,
  carrier_reference   text,           -- the haulier's own waybill number

  -- Endpoints. Either may be NULL because either may not be a location we
  -- own: a cement plant is not a location, and neither is a building site.
  from_location_id uuid,
  to_location_id   uuid,
  to_address_text  text,

  status text not null default 'PLANNED' check (status in
    ('PLANNED', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED')),

  planned_for   date,
  dispatched_at timestamptz,
  delivered_at  timestamptz,
  failed_reason text,

  -- The agreed freight, in minor units, with its pack snapshot. This is the
  -- QUOTED figure; the authoritative one is the haulier's AP invoice in
  -- Phase 3. Recorded here so distribution cost is visible from the day
  -- deliveries start, which is what ADR-0001 owes open-questions Q1.
  freight_cost_minor app.money_minor check (freight_cost_minor >= 0),
  currency_code      char(3) not null,
  money_scale        bigint  not null,

  notes text,

  -- A planned delivery may be abandoned. Once it has been dispatched it is
  -- CANCELLED or FAILED, never quietly hidden.
  constraint delivery_soft_delete_planned_only
    check (deleted_at is null or status = 'PLANNED'),
  constraint delivery_dispatched_at_present
    check (status not in ('DISPATCHED', 'IN_TRANSIT', 'DELIVERED') or dispatched_at is not null),
  constraint delivery_delivered_at_present
    check (status <> 'DELIVERED' or delivered_at is not null),

  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, carrier_supplier_id) references app.supplier (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, from_location_id) references app.location (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, to_location_id) references app.location (tenant_id, id)
    deferrable initially immediate
);
create index delivery_source_ix on app.delivery (tenant_id, source_kind, source_id);
create index delivery_open_ix   on app.delivery (tenant_id, status, planned_for);
create index delivery_carrier_ix
  on app.delivery (tenant_id, carrier_supplier_id, dispatched_at);
select app.apply_tenant_rls('app.delivery');

comment on table app.delivery is
  'Third-party dispatch and delivery status. ADR-0001: there is no vehicle, driver, fuel or maintenance entity anywhere in this system. carrier_supplier_id is the carrier abstraction owned vehicles would attach to.';
comment on column app.delivery.freight_cost_minor is
  'The AGREED freight, minor units. The authoritative figure is the haulier''s AP invoice (Phase 3); this exists so distribution cost as a % of revenue is measurable from day one (ADR-0001, Q1).';

create function app.assert_delivery() returns trigger
language plpgsql as $$
declare
  hauls  boolean;
  exists_source boolean;
begin
  -- The carrier must be able to haul. Read `kind`, never the tenant's own
  -- word for it (ADR-0006): a tenant may call its haulage capability
  -- "Trucking" and this must keep working.
  select true into hauls
    from app.supplier_capability sc
    join app.supplier_capability_type sct
      on sct.tenant_id = sc.tenant_id and sct.id = sc.capability_type_id
   where sc.tenant_id = new.tenant_id
     and sc.supplier_id = new.carrier_supplier_id
     and sc.deleted_at is null
     and sct.deleted_at is null
     and sct.kind = 'HAULAGE'
   limit 1;

  if hauls is not true then
    raise exception
      'delivery %: supplier % carries no HAULAGE capability — a carrier is a supplier that hauls (ADR-0001); give it a capability of kind HAULAGE, or name a carrier that has one',
      new.id, new.carrier_supplier_id
      using errcode = 'check_violation';
  end if;

  -- Polymorphic referent, checked per kind. No FK is possible; a missing
  -- referent is still refused.
  if new.source_kind = 'PURCHASE_ORDER' then
    select true into exists_source from app.purchase_order po
      where po.tenant_id = new.tenant_id and po.id = new.source_id;
  elsif new.source_kind = 'SALE' then
    select true into exists_source from app.sale s
      where s.tenant_id = new.tenant_id and s.id = new.source_id;
  end if;

  if exists_source is not true then
    raise exception 'delivery %: no % with id % is visible in this tenant',
      new.id, new.source_kind, new.source_id
      using errcode = 'foreign_key_violation';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'PLANNED' then
      raise exception
        'delivery %: may only be created as PLANNED, not % — a delivery is planned before it moves',
        new.id, new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.source_kind is distinct from old.source_kind
     or new.source_id is distinct from old.source_id then
    raise exception
      'delivery %: the document a delivery carries is frozen — re-pointing it at another order or sale is a different delivery',
      new.id
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status
     and not app.delivery_transition_allowed(old.status, new.status) then
    raise exception
      'delivery %: % -> % is not a legal transition. The state machine is app.delivery_legal_transitions(); DELIVERED and CANCELLED are terminal',
      new.id, old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

create trigger delivery_state_machine
  before insert or update on app.delivery
  for each row execute function app.assert_delivery();
