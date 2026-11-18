-- ============================================================================
-- 0022 — THE SALE DOCUMENT'S IDENTITIES, ENFORCED AT COMMIT
--
-- 04 §4.8: "One deferred constraint trigger, declared on all four tables,
-- asserts the document identities." Until now a sale had one header CHECK
-- (`total = subtotal − discount + tax`) that was only INTERNALLY consistent:
-- nothing asserted the header agreed with its own lines, its tax lines, how
-- it was paid, or the receivable it raised. Each identity below closes a way
-- for the books to balance while being wrong.
--
--   1. subtotal_net_minor  = Σ sale_line.line_net_minor
--   2. discount_minor      = Σ sale_line.line_discount_minor
--   3. tax_total_minor     = Σ sale_line.tax_minor
--      and every line's tax_minor = Σ its sale_tax_line.tax_minor
--   4. total_minor         = Σ sale_tender.amount_minor — and this FIRES EVEN
--      AT ZERO TENDERS, because it is declared on `sale` itself. A trigger
--      declared only on sale_tender never runs for a sale that arrives with no
--      tender rows at all: revenue and cash with no counterparty, undetected.
--      That was the first draft's bug, and the reason for the declaration on
--      all five tables rather than one.
--   5. Σ on-account tender = Σ CHARGE credit_entry naming the sale. Without it
--      AR could be charged 500 pesewas against a 500,000-pesewa tender and
--      every other constraint in the schema would pass.
--   6. an on-account tender names a customer;
--   7. every tender row's location is the sale's location (it is denormalised
--      for the sync bucket — a denormalised copy that is not checked drifts);
--   8. the session the sale was rung in is at the sale's location and its
--      business date IS the sale's business date (03 §3.4.2: the date comes
--      from the session, not from a device clock).
--
-- DEFERRABLE INITIALLY DEFERRED: a sale is written header-first and its
-- children after, in one transaction. The identities can only be judged at
-- COMMIT, when the document is whole — 05 §5.2.3's Mechanism B, the same one
-- the journal uses.
--
-- WHAT IS DELIBERATELY NOT ASSERTED HERE
--   · Voiding documents (`voids_sale_id is not null`). There is no void route
--     yet, and a void's own identity — what it reverses, how its tenders
--     refund — is the next work package's to define, against this tender
--     model. They are exempted BY NAME below so the omission is visible.
--   · Sales written before 0021. Nothing re-fires for them (these triggers
--     run on INSERT only, and every table here is append-only); 0021's
--     backfill wrote their tenders to satisfy identity 4 and 5 by construction.
-- ============================================================================

create function app.assert_sale_consistent(p_tenant uuid, p_sale uuid) returns void
language plpgsql as $$
declare
  s            record;
  v_net        bigint;
  v_disc       bigint;
  v_tax        bigint;
  v_bad_lines  integer;
  v_tendered   bigint;
  v_on_account bigint;
  v_bad_loc    integer;
  v_charged    bigint;
  v_session    record;
begin
  select * into s from app.sale where tenant_id = p_tenant and id = p_sale;
  if not found then
    -- A child naming a sale that does not exist is the foreign key's to
    -- refuse, not this function's.
    return;
  end if;
  if s.voids_sale_id is not null then
    return; -- see the header: a voiding document's identity is not defined yet
  end if;

  select coalesce(sum(line_net_minor), 0)::bigint,
         coalesce(sum(line_discount_minor), 0)::bigint,
         coalesce(sum(tax_minor), 0)::bigint
    into v_net, v_disc, v_tax
    from app.sale_line
   where tenant_id = p_tenant and sale_id = p_sale;

  if v_net <> s.subtotal_net_minor then
    raise exception 'SALE0001: sale % subtotal_net_minor % <> Σ line_net_minor %',
      p_sale, s.subtotal_net_minor, v_net using errcode = 'check_violation';
  end if;
  if v_disc <> s.discount_minor then
    raise exception 'SALE0002: sale % discount_minor % <> Σ line_discount_minor %',
      p_sale, s.discount_minor, v_disc using errcode = 'check_violation';
  end if;
  if v_tax <> s.tax_total_minor then
    raise exception 'SALE0003: sale % tax_total_minor % <> Σ line tax_minor %',
      p_sale, s.tax_total_minor, v_tax using errcode = 'check_violation';
  end if;

  select count(*) into v_bad_lines
    from app.sale_line l
   where l.tenant_id = p_tenant and l.sale_id = p_sale
     and l.tax_minor <> coalesce((
           select sum(t.tax_minor)::bigint from app.sale_tax_line t
            where t.tenant_id = l.tenant_id and t.sale_line_id = l.id), 0);
  if v_bad_lines > 0 then
    raise exception 'SALE0004: sale % has % line(s) whose tax_minor <> Σ of their tax lines',
      p_sale, v_bad_lines using errcode = 'check_violation';
  end if;

  select coalesce(sum(st.amount_minor), 0)::bigint,
         coalesce(sum(st.amount_minor) filter (where m.is_on_account), 0)::bigint,
         count(*) filter (where st.location_id <> s.location_id)
    into v_tendered, v_on_account, v_bad_loc
    from app.sale_tender st
    join app.tender_method m on m.tenant_id = st.tenant_id and m.id = st.method_id
   where st.tenant_id = p_tenant and st.sale_id = p_sale;

  if v_tendered <> s.total_minor then
    raise exception 'SALE0005: sale % total_minor % <> Σ sale_tender.amount_minor % — every pesewa of a sale is settled somehow, and exactly once',
      p_sale, s.total_minor, v_tendered using errcode = 'check_violation';
  end if;
  if v_bad_loc > 0 then
    raise exception 'SALE0006: sale % has % tender row(s) at a location other than the sale''s',
      p_sale, v_bad_loc using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount_minor), 0)::bigint into v_charged
    from app.credit_entry
   where tenant_id = p_tenant and source_kind = 'SALE' and source_id = p_sale and kind = 'CHARGE';
  if v_on_account <> v_charged then
    raise exception 'SALE0007: sale % put % on account but charged the customer % — the on-account tender and its CHARGE must agree',
      p_sale, v_on_account, v_charged using errcode = 'check_violation';
  end if;
  if v_on_account > 0 and s.customer_id is null then
    raise exception 'SALE0008: sale % puts % on account with no customer named', p_sale, v_on_account
      using errcode = 'check_violation';
  end if;

  if s.cash_session_id is not null then
    select location_id, business_date into v_session
      from app.cash_session where tenant_id = p_tenant and id = s.cash_session_id;
    if found and (v_session.location_id <> s.location_id
                  or v_session.business_date <> s.business_date) then
      raise exception 'SALE0009: sale % is dated % at location % but was rung in a session for % at %',
        p_sale, s.business_date, s.location_id, v_session.business_date, v_session.location_id
        using errcode = 'check_violation';
    end if;
  end if;
end
$$;

-- One trigger function for all five tables. A CHILD row whose sale header was
-- inserted in this SAME transaction skips the check: the header's own firing
-- runs it at commit over the whole document, so re-running it once per line
-- would cost O(lines²) and buy nothing. A child added in a LATER transaction —
-- the only way to corrupt an append-only document after the fact — does not
-- match that test and is checked. (xmin is the inserting transaction's 32-bit
-- id; a header inserted inside a savepoint carries the sub-transaction's id,
-- which merely means the redundant check runs. The skip can only ever be too
-- cautious, never too permissive.)
create function app.sale_consistency_trigger() returns trigger
language plpgsql as $$
declare
  v_sale uuid;
  v_same_tx boolean;
begin
  if tg_table_name = 'sale' then
    perform app.assert_sale_consistent(new.tenant_id, new.id);
    return null;
  elsif tg_table_name = 'credit_entry' then
    if new.source_kind is distinct from 'SALE' or new.source_id is null then
      return null;
    end if;
    v_sale := new.source_id;
  else
    v_sale := new.sale_id;
  end if;

  select (s.xmin::text::bigint = (txid_current() % 4294967296)) into v_same_tx
    from app.sale s where s.tenant_id = new.tenant_id and s.id = v_sale;
  if coalesce(v_same_tx, false) then
    return null;
  end if;
  perform app.assert_sale_consistent(new.tenant_id, v_sale);
  return null;
end
$$;

create constraint trigger sale_consistent
  after insert on app.sale
  deferrable initially deferred
  for each row execute function app.sale_consistency_trigger();

create constraint trigger sale_line_consistent
  after insert on app.sale_line
  deferrable initially deferred
  for each row execute function app.sale_consistency_trigger();

create constraint trigger sale_tax_line_consistent
  after insert on app.sale_tax_line
  deferrable initially deferred
  for each row execute function app.sale_consistency_trigger();

create constraint trigger sale_tender_consistent
  after insert on app.sale_tender
  deferrable initially deferred
  for each row execute function app.sale_consistency_trigger();

create constraint trigger credit_entry_sale_consistent
  after insert on app.credit_entry
  deferrable initially deferred
  for each row execute function app.sale_consistency_trigger();

create index sale_tax_line_sale_ix on app.sale_tax_line (tenant_id, sale_id);
create index credit_entry_source_ix on app.credit_entry (tenant_id, source_kind, source_id);


-- ----------------------------------------------------------------------------
-- A sale's stock movement is in the sale's session, at the session's place,
-- on the session's date — immediate, not deferred: the session row is written
-- before any sale that names it, so there is nothing to wait for.
-- ----------------------------------------------------------------------------
create function app.stock_movement_session_agrees() returns trigger
language plpgsql as $$
declare
  v record;
begin
  if new.cash_session_id is null then
    return new;
  end if;
  select location_id, business_date into v
    from app.cash_session where tenant_id = new.tenant_id and id = new.cash_session_id;
  if found and (v.location_id <> new.location_id or v.business_date <> new.business_date) then
    raise exception 'stock_movement %: dated % at % but its session is for % at %',
      new.id, new.business_date, new.location_id, v.business_date, v.location_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger stock_movement_session_agrees
  before insert on app.stock_movement
  for each row execute function app.stock_movement_session_agrees();
