-- ============================================================================
-- 0030 — VOIDS AND RETURNS: A NEW DOCUMENT, NEVER AN EDIT OF THE OLD ONE
--
-- 04 §4.8 ("voids and returns are new documents, and nothing is set on the
-- original"); 03 §3.6 class #5 (a void arriving for a sale already settled
-- elsewhere → severity 1, REVIEW, never auto-resolved); 05 §5.3 ("voiding a
-- sale is not deleting a sale") and §5.6.2 rule 10; 05 §5.14 #23 (a return
-- reverses at the ORIGINAL sale's snapshotted price and tax rate row, never
-- the return's date); 08 §8.7 (a void is a deliberate second step with a
-- reason).
--
-- ── THE ONE DEVIATION FROM 04 §4.8, AND WHY ───────────────────────────────
-- 04 §4.8 sketched the voiding document as another `app.sale` row carrying
-- `voids_sale_id`. It is built here as its own document, `app.sale_return`
-- (kind VOID or RETURN), and `voids_sale_id` is CLOSED below. The principle
-- 04 §4.8 states — a new document, the original immutable, status derived —
-- holds exactly; only the table differs, for four reasons the sketch did not
-- have to face:
--
--   1. A RETURN is partial and can be repeated (two bags today, one next
--      week). A sale row with `voids_sale_id` makes every partial return read
--      as "voided", and the derived status the sketch relies on breaks.
--   2. Every reader of `app.sale` — the posting sweep, the sales and
--      cash-position reports, receipt continuity, the counter's recent-sales
--      list — assumes a sale's figures are non-negative and that its tenders
--      are money IN. `sale_tender.amount_minor >= 0` is a CHECK (0021). A
--      negative sale would have to be special-cased in each, and the one that
--      is missed double-counts.
--   3. 05 §5.6.2 rule 10 posts a return as CONTRA-revenue so gross sales stay
--      recoverable; a negative sale row is negative revenue by construction.
--   4. A refund's identities are not a sale's: the on-account part of a
--      refund is a credit NOTE (a negative ADJUSTMENT applied to the original
--      CHARGE), not a CHARGE.
--
-- Void status is still derived and nothing is written to the original:
--   is_voided := EXISTS (sale_return WHERE kind = 'VOID' AND original_sale_id = sale.id)
--
-- ── SIGN CONVENTION, STATED ONCE ──────────────────────────────────────────
-- Every quantity and money figure on these four tables is a NON-NEGATIVE
-- MAGNITUDE of what is being reversed. Direction is the document's kind, not a
-- sign. (The stock movement it writes is SALE_RETURN, positive by sm_sign.)
--
-- ── CROSS-OUTLET RETURNS ARE NOT ALLOWED (asserted below, SRET0001) ───────
-- A return is taken at the location that made the sale. Three reasons:
--   · offline: the returning till must hold the original's snapshotted lines,
--     and the sync rules give a device its OWN location's sales — another
--     outlet's return would be an online-only exception path on a counter
--     designed to work without one;
--   · the ledger: refund at B against revenue at A needs inter-location
--     clearing pairs on till, revenue, tax, inventory and COGS (05 §5.6.2's
--     control-account rule); rule 10 is written for "original selling
--     location";
--   · the over-return race (class #5) would widen from one outlet's tills to
--     the whole network.
-- Lifting this is a decision with a design behind it, not a predicate edit.
--
-- ── WHAT THE SERVER FIXES, NOT THE DEVICE ────────────────────────────────
-- Figures are re-derived on the server from the ORIGINAL's rows by cumulative
-- pro-rata (`@erp/money` `returnSlice`), so a line returned in any number of
-- pieces reverses exactly what it charged, to the minor unit, at the rate row
-- it was charged at. The device's figures are claims, kept beside the server's
-- where they differ (`claimed_minor`), and a disagreement goes to a person.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The capability. `sale.void` exists (0005) and is `until_lease_expiry`
-- (0023). A RETURN is a different act — later, partial, often by a different
-- person, and with money going back out of a drawer that has been counted —
-- so it gets its own code, BOUNDED by the refund value the SERVER computes.
-- ----------------------------------------------------------------------------
insert into platform.permission
  (code, domain, description, is_sensitive, requires_fresh_authorization, bound_schema, offline_mode)
values
  ('sale.return', 'sale',
   'Take goods back against a recorded sale and refund them at the sale''s own prices, up to a bounded refund value.',
   true, false,
   '{"max_refund_minor":"decimal string, minor units"}'::jsonb,
   -- Takes risk (money leaves a drawer): stops at the lease's full horizon,
   -- like a credit sale and a void (0023's rule).
   'until_lease_expiry')
on conflict (code) do nothing;


-- ----------------------------------------------------------------------------
-- 2. `voids_sale_id` is closed. Nothing has ever written it (0022 exempted it
-- by name "until the next work package defines a void"); this is that
-- package, and a void is an `app.sale_return`. A second way to void is a
-- second thing every reader would have to handle.
-- ----------------------------------------------------------------------------
alter table app.sale add constraint sale_voids_via_return_document
  check (voids_sale_id is null);
-- A till that voids a sale it rang offline names it by the only id it has:
-- the idempotency key, which is the sale's write_id.
create index sale_write_ix on app.sale (tenant_id, write_id);

comment on column app.sale.voids_sale_id is
  'CLOSED by 0030: always NULL. A void is an app.sale_return document (kind VOID); void status is derived from it.';


-- ----------------------------------------------------------------------------
-- 3. app.sale_return — the header.
-- ----------------------------------------------------------------------------
create table app.sale_return (
  tenant_id          uuid        not null references platform.tenant (id),
  id                 uuid        not null,
  write_id           uuid        not null,
  hlc                app.hlc     not null,
  created_at         timestamptz not null default transaction_timestamp(),
  updated_at         timestamptz not null default transaction_timestamp(),
  deleted_at         timestamptz,
  kind               text        not null,
  original_sale_id   uuid        not null,
  location_id        uuid        not null,   -- = the original's (SRET0001)
  cash_session_id    uuid        not null,   -- the till the refund left; business_date is its
  business_date      date        not null,
  occurred_at        timestamptz not null,   -- device clock. UNTRUSTED. Display only.
  customer_id        uuid,                   -- the original's, copied (SRET0003)
  return_no          text        not null,   -- printed on the return slip; same device series as receipts
  return_no_claimed  text,                   -- class #14: what the paper says, when it collided
  reason             text        not null,
  currency_code      char(3)     not null,   -- the ORIGINAL's snapshot
  money_scale        bigint      not null,   -- the ORIGINAL's snapshot. Never assume 100.
  subtotal_net_minor app.money_minor not null,
  discount_minor     app.money_minor not null,
  tax_total_minor    app.money_minor not null,
  total_minor        app.money_minor not null,   -- the refund, all methods together
  constraint sr_kind check (kind in ('VOID', 'RETURN')),
  constraint sr_deleted_never check (deleted_at is null),
  constraint sr_total_identity check (total_minor = subtotal_net_minor - discount_minor + tax_total_minor),
  constraint sr_magnitudes check (
    subtotal_net_minor >= 0 and discount_minor >= 0 and tax_total_minor >= 0 and total_minor >= 0),
  constraint sr_reason_shape check (length(btrim(reason)) between 1 and 200),
  constraint sr_return_no_shape check (length(return_no) between 1 and 80),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, original_sale_id) references app.sale (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, cash_session_id) references app.cash_session (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, customer_id) references app.customer (tenant_id, id)
    deferrable initially immediate
);
create unique index sale_return_no_uq on app.sale_return (tenant_id, location_id, return_no);
create index sale_return_original_ix on app.sale_return (tenant_id, original_sale_id);
create index sale_return_session_ix on app.sale_return (tenant_id, cash_session_id);
create index sale_return_day_ix on app.sale_return (tenant_id, location_id, business_date);
select app.apply_tenant_rls('app.sale_return');
revoke update, delete on app.sale_return from app_user;
create trigger sale_return_append_only
  before update or delete on app.sale_return
  for each row execute function app.forbid_mutation();

comment on table app.sale_return is
  'A void (whole sale, same till) or a return (some lines, some quantity, any later till at the same location). A new document; the original sale is never touched. Figures are non-negative magnitudes of what is reversed (0030).';


-- ----------------------------------------------------------------------------
-- 4. app.sale_return_line — what came back, priced from the original line.
-- ----------------------------------------------------------------------------
create table app.sale_return_line (
  tenant_id             uuid        not null references platform.tenant (id),
  id                    uuid        not null,
  write_id              uuid        not null,
  hlc                   app.hlc     not null,
  created_at            timestamptz not null default transaction_timestamp(),
  updated_at            timestamptz not null default transaction_timestamp(),
  deleted_at            timestamptz,
  return_id             uuid        not null,
  line_no               smallint    not null,
  original_sale_line_id uuid        not null,
  product_id            uuid        not null,
  location_id           uuid        not null,   -- denormalised for the sync bucket; asserted
  -- what came back, in the ORIGINAL's selling unit and scale
  qty_sell              app.qty     not null,
  qty_sell_scale        smallint    not null,
  unit_price_e4         app.rate_e4 not null,   -- the ORIGINAL's snapshot (SRET0011)
  -- what goes back on the shelf (or is written off), in the stocking unit
  stocking_uom_id       uuid        not null,
  qty_stock             app.qty     not null,
  qty_stock_scale       smallint    not null,
  line_net_minor        app.money_minor not null,
  line_discount_minor   app.money_minor not null,
  tax_minor             app.money_minor not null,
  disposition           text        not null,   -- platform vocabulary
  constraint srl_deleted_never check (deleted_at is null),
  constraint srl_line_no check (line_no >= 1),
  constraint srl_qty check (qty_sell > 0 and qty_stock >= 0),
  -- Each figure is a cumulative pro-rata slice of a non-negative original
  -- figure, so each is non-negative by construction. (No per-line
  -- "discount ≤ net": two independently rounded slices of a line discounted
  -- to within a pesewa of nothing can cross by one, and a constraint that a
  -- correct computation can trip would stall a till's queue.)
  constraint srl_magnitudes check (line_net_minor >= 0 and line_discount_minor >= 0 and tax_minor >= 0),
  constraint srl_disposition check (disposition in ('RESTOCK', 'DAMAGED')),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, return_id) references app.sale_return (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, original_sale_line_id) references app.sale_line (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, product_id) references app.product (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, stocking_uom_id) references app.unit_of_measure (tenant_id, id)
    deferrable initially immediate
);
create unique index sale_return_line_uq on app.sale_return_line (tenant_id, return_id, line_no);
create unique index sale_return_line_original_uq
  on app.sale_return_line (tenant_id, return_id, original_sale_line_id);
create index sale_return_line_original_ix on app.sale_return_line (tenant_id, original_sale_line_id);
create index sale_return_line_location_ix on app.sale_return_line (tenant_id, location_id);
select app.apply_tenant_rls('app.sale_return_line');
revoke update, delete on app.sale_return_line from app_user;
create trigger sale_return_line_append_only
  before update or delete on app.sale_return_line
  for each row execute function app.forbid_mutation();


-- ----------------------------------------------------------------------------
-- 5. app.sale_return_tax_line — one per (line, component), pinned to the
-- ORIGINAL's tax line and therefore to the effective-dated rate row the sale
-- was charged at (ADR-0002; 05 §5.14 #23). Asserted, not assumed (SRET0012).
-- ----------------------------------------------------------------------------
create table app.sale_return_tax_line (
  tenant_id            uuid        not null references platform.tenant (id),
  id                   uuid        not null,
  write_id             uuid        not null,
  hlc                  app.hlc     not null,
  created_at           timestamptz not null default transaction_timestamp(),
  updated_at           timestamptz not null default transaction_timestamp(),
  deleted_at           timestamptz,
  return_id            uuid        not null,
  return_line_id       uuid        not null,
  original_tax_line_id uuid        not null,
  location_id          uuid        not null,
  seq                  smallint    not null,
  tax_code             text        not null,
  rate_bp              app.bp      not null,
  base_minor           app.money_minor not null,
  tax_minor            app.money_minor not null,
  tax_rate_id          uuid        not null references platform.tax_rate (id),
  constraint srt_deleted_never check (deleted_at is null),
  constraint srt_magnitudes check (base_minor >= 0 and tax_minor >= 0),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, return_id) references app.sale_return (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, return_line_id) references app.sale_return_line (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, original_tax_line_id) references app.sale_tax_line (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate
);
create unique index sale_return_tax_line_uq on app.sale_return_tax_line (tenant_id, return_line_id, seq);
create index sale_return_tax_line_return_ix on app.sale_return_tax_line (tenant_id, return_id);
create index sale_return_tax_line_location_ix on app.sale_return_tax_line (tenant_id, location_id);
select app.apply_tenant_rls('app.sale_return_tax_line');
revoke update, delete on app.sale_return_tax_line from app_user;
create trigger sale_return_tax_line_append_only
  before update or delete on app.sale_return_tax_line
  for each row execute function app.forbid_mutation();


-- ----------------------------------------------------------------------------
-- 6. app.sale_return_refund — how the money went back. Same shape as
-- sale_tender: the SERVER's figure in amount_minor, the device's kept in
-- claimed_minor only where they differ, zero permitted only as evidence.
-- A cash refund in a session reduces that till's expected cash at close.
-- ----------------------------------------------------------------------------
create table app.sale_return_refund (
  tenant_id     uuid        not null references platform.tenant (id),
  id            uuid        not null,
  write_id      uuid        not null,
  hlc           app.hlc     not null,
  created_at    timestamptz not null default transaction_timestamp(),
  updated_at    timestamptz not null default transaction_timestamp(),
  deleted_at    timestamptz,
  return_id     uuid        not null,
  seq           smallint    not null,
  method_id     uuid        not null,
  amount_minor  app.money_minor not null,
  claimed_minor app.money_minor,
  reference     text,
  refunded_at   timestamptz not null,   -- device clock. UNTRUSTED. Display only.
  location_id   uuid        not null,
  constraint srr_deleted_never check (deleted_at is null),
  constraint srr_seq check (seq >= 1),
  constraint srr_amount_nonneg check (amount_minor >= 0),
  constraint srr_claimed_nonneg check (claimed_minor is null or claimed_minor >= 0),
  constraint srr_claimed_differs check (claimed_minor is null or claimed_minor <> amount_minor),
  constraint srr_reference_shape check (reference is null or length(reference) between 1 and 64),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, return_id) references app.sale_return (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, method_id) references app.tender_method (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate
);
create unique index sale_return_refund_uq on app.sale_return_refund (tenant_id, return_id, seq);
create index sale_return_refund_location_ix on app.sale_return_refund (tenant_id, location_id, method_id);
select app.apply_tenant_rls('app.sale_return_refund');
revoke update, delete on app.sale_return_refund from app_user;
create trigger sale_return_refund_append_only
  before update or delete on app.sale_return_refund
  for each row execute function app.forbid_mutation();

create function app.sale_return_refund_reference_required() returns trigger
language plpgsql as $$
begin
  if new.reference is null and new.amount_minor > 0 and exists (
    select 1 from app.tender_method m
     where m.tenant_id = new.tenant_id and m.id = new.method_id and m.requires_reference
  ) then
    raise exception 'app.sale_return_refund: method % requires a reference for a refund and none was given',
      new.method_id using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger sale_return_refund_reference_required
  before insert on app.sale_return_refund
  for each row execute function app.sale_return_refund_reference_required();


-- ----------------------------------------------------------------------------
-- 7. THE DOCUMENT'S IDENTITIES, AT COMMIT (the 0022 pattern, Mechanism B).
-- Each closes a way for a refund to balance while being wrong.
-- ----------------------------------------------------------------------------
create function app.assert_sale_return_consistent(p_tenant uuid, p_return uuid) returns void
language plpgsql as $$
declare
  r            record;
  s            record;
  v_net        bigint;
  v_disc       bigint;
  v_tax        bigint;
  v_bad        integer;
  v_refunded   bigint;
  v_on_account bigint;
  v_credited   bigint;
  v_session    record;
  v_orig_lines integer;
  v_full_lines integer;
begin
  select * into r from app.sale_return where tenant_id = p_tenant and id = p_return;
  if not found then return; end if;
  select * into s from app.sale where tenant_id = p_tenant and id = r.original_sale_id;
  if not found then return; end if;   -- the FK's to refuse

  if r.location_id <> s.location_id then
    raise exception 'SRET0001: return % is at % but its sale was made at % — returns are taken where the sale was made',
      p_return, r.location_id, s.location_id using errcode = 'check_violation';
  end if;
  if r.currency_code <> s.currency_code or r.money_scale <> s.money_scale then
    raise exception 'SRET0002: return % is not in its sale''s currency snapshot', p_return
      using errcode = 'check_violation';
  end if;
  if r.customer_id is distinct from s.customer_id then
    raise exception 'SRET0003: return % names a different customer from its sale', p_return
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(line_net_minor), 0)::bigint, coalesce(sum(line_discount_minor), 0)::bigint,
         coalesce(sum(tax_minor), 0)::bigint
    into v_net, v_disc, v_tax
    from app.sale_return_line where tenant_id = p_tenant and return_id = p_return;
  if v_net <> r.subtotal_net_minor or v_disc <> r.discount_minor or v_tax <> r.tax_total_minor then
    raise exception 'SRET0004: return % header (net %, discount %, tax %) disagrees with its lines (net %, discount %, tax %)',
      p_return, r.subtotal_net_minor, r.discount_minor, r.tax_total_minor, v_net, v_disc, v_tax
      using errcode = 'check_violation';
  end if;

  select count(*) into v_bad
    from app.sale_return_line l
   where l.tenant_id = p_tenant and l.return_id = p_return
     and l.tax_minor <> coalesce((select sum(t.tax_minor)::bigint from app.sale_return_tax_line t
                                   where t.tenant_id = l.tenant_id and t.return_line_id = l.id), 0);
  if v_bad > 0 then
    raise exception 'SRET0005: return % has % line(s) whose tax_minor <> Σ their tax lines', p_return, v_bad
      using errcode = 'check_violation';
  end if;

  -- Every line reverses a line OF THIS SALE, for the same product, unit,
  -- scale and price, at this document's location.
  select count(*) into v_bad
    from app.sale_return_line l
    left join app.sale_line ol on ol.tenant_id = l.tenant_id and ol.id = l.original_sale_line_id
   where l.tenant_id = p_tenant and l.return_id = p_return
     and (ol.id is null or ol.sale_id <> r.original_sale_id or ol.product_id <> l.product_id
          or ol.qty_sell_scale <> l.qty_sell_scale or ol.unit_price_e4 <> l.unit_price_e4
          or ol.stocking_uom_id <> l.stocking_uom_id or ol.qty_stock_scale <> l.qty_stock_scale
          or l.location_id <> r.location_id);
  if v_bad > 0 then
    raise exception 'SRET0011: return % has % line(s) that do not reverse a line of sale % at its own price, unit and place',
      p_return, v_bad, r.original_sale_id using errcode = 'check_violation';
  end if;

  -- Every tax line reverses a component of the SAME original line at the SAME
  -- rate row (ADR-0002: never today's rate).
  select count(*) into v_bad
    from app.sale_return_tax_line t
    join app.sale_return_line l on l.tenant_id = t.tenant_id and l.id = t.return_line_id
    left join app.sale_tax_line ot on ot.tenant_id = t.tenant_id and ot.id = t.original_tax_line_id
   where t.tenant_id = p_tenant and t.return_id = p_return
     and (ot.id is null or ot.sale_line_id <> l.original_sale_line_id or ot.tax_rate_id <> t.tax_rate_id
          or ot.rate_bp <> t.rate_bp or ot.tax_code <> t.tax_code or t.location_id <> r.location_id
          or l.return_id <> t.return_id);
  if v_bad > 0 then
    raise exception 'SRET0012: return % has % tax line(s) not pinned to its sale''s own rate rows', p_return, v_bad
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(rf.amount_minor), 0)::bigint,
         coalesce(sum(rf.amount_minor) filter (where m.is_on_account), 0)::bigint,
         count(*) filter (where rf.location_id <> r.location_id)
    into v_refunded, v_on_account, v_bad
    from app.sale_return_refund rf
    join app.tender_method m on m.tenant_id = rf.tenant_id and m.id = rf.method_id
   where rf.tenant_id = p_tenant and rf.return_id = p_return;
  if v_refunded <> r.total_minor then
    raise exception 'SRET0006: return % total % <> Σ refunds % — every pesewa reversed goes back exactly once',
      p_return, r.total_minor, v_refunded using errcode = 'check_violation';
  end if;
  if v_bad > 0 then
    raise exception 'SRET0007: return % has % refund row(s) at another location', p_return, v_bad
      using errcode = 'check_violation';
  end if;

  select coalesce(-sum(amount_minor), 0)::bigint into v_credited
    from app.credit_entry
   where tenant_id = p_tenant and source_kind = 'SALE_RETURN' and source_id = p_return;
  if v_on_account <> v_credited then
    raise exception 'SRET0008: return % refunds % on account but credits the customer % — the credit note and the refund must agree',
      p_return, v_on_account, v_credited using errcode = 'check_violation';
  end if;
  if v_on_account > 0 and r.customer_id is null then
    raise exception 'SRET0009: return % credits an account with no customer named', p_return
      using errcode = 'check_violation';
  end if;

  select location_id, business_date into v_session
    from app.cash_session where tenant_id = p_tenant and id = r.cash_session_id;
  if found and (v_session.location_id <> r.location_id or v_session.business_date <> r.business_date) then
    raise exception 'SRET0010: return % is dated % at % but its till is for % at %',
      p_return, r.business_date, r.location_id, v_session.business_date, v_session.location_id
      using errcode = 'check_violation';
  end if;

  -- A VOID is the whole sale, in the till it was rung in, figure for figure.
  if r.kind = 'VOID' then
    if r.cash_session_id is distinct from s.cash_session_id then
      raise exception 'SRET0013: void % is not in the till its sale was rung in — a later refund is a return',
        p_return using errcode = 'check_violation';
    end if;
    select count(*) into v_orig_lines from app.sale_line where tenant_id = p_tenant and sale_id = s.id;
    select count(*) into v_full_lines
      from app.sale_return_line l
      join app.sale_line ol on ol.tenant_id = l.tenant_id and ol.id = l.original_sale_line_id
     where l.tenant_id = p_tenant and l.return_id = p_return and l.qty_sell = ol.qty_sell;
    if v_full_lines <> v_orig_lines
       or r.subtotal_net_minor <> s.subtotal_net_minor or r.discount_minor <> s.discount_minor
       or r.tax_total_minor <> s.tax_total_minor or r.total_minor <> s.total_minor then
      raise exception 'SRET0014: void % does not reverse the whole of sale % exactly', p_return, s.id
        using errcode = 'check_violation';
    end if;
  end if;
end
$$;

-- The 0022 trigger shape: a child whose header was inserted in THIS
-- transaction skips (the header's own firing checks the whole document at
-- commit); a child added in a LATER transaction is checked.
create function app.sale_return_consistency_trigger() returns trigger
language plpgsql as $$
declare
  v_return  uuid;
  v_same_tx boolean;
begin
  if tg_table_name = 'sale_return' then
    perform app.assert_sale_return_consistent(new.tenant_id, new.id);
    return null;
  elsif tg_table_name = 'credit_entry' then
    if new.source_kind is distinct from 'SALE_RETURN' or new.source_id is null then
      return null;
    end if;
    v_return := new.source_id;
  else
    v_return := new.return_id;
  end if;
  select (r.xmin::text::bigint = (txid_current() % 4294967296)) into v_same_tx
    from app.sale_return r where r.tenant_id = new.tenant_id and r.id = v_return;
  if coalesce(v_same_tx, false) then
    return null;
  end if;
  perform app.assert_sale_return_consistent(new.tenant_id, v_return);
  return null;
end
$$;

create constraint trigger sale_return_consistent
  after insert on app.sale_return deferrable initially deferred
  for each row execute function app.sale_return_consistency_trigger();
create constraint trigger sale_return_line_consistent
  after insert on app.sale_return_line deferrable initially deferred
  for each row execute function app.sale_return_consistency_trigger();
create constraint trigger sale_return_tax_line_consistent
  after insert on app.sale_return_tax_line deferrable initially deferred
  for each row execute function app.sale_return_consistency_trigger();
create constraint trigger sale_return_refund_consistent
  after insert on app.sale_return_refund deferrable initially deferred
  for each row execute function app.sale_return_consistency_trigger();
create constraint trigger credit_entry_sale_return_consistent
  after insert on app.credit_entry deferrable initially deferred
  for each row execute function app.sale_return_consistency_trigger();
