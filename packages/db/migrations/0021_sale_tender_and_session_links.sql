-- ============================================================================
-- 0021 — HOW A SALE WAS SETTLED, AND WHICH TILL IT WAS RUNG IN
--
-- 04 §4.8 `sale_tender`; 04 §4.8a / 03 §3.4.2 `sale.cash_session_id`; the
-- §4.8a note on stock_movement migration 0004 left in place ("cash_session_id
-- lands with the POS migration").
--
-- Before this file a sale had no tender at all. Settlement was INFERRED: a
-- sale was on credit exactly when a CHARGE credit_entry named it, and
-- everything else was "cash" — mobile money, bank transfers and cheques
-- included, which is most of what a Ghanaian counter actually takes. The
-- sweep, the cash-position report and the posting rules all carried that
-- inference. From here on it is RECORDED, one row per way the customer paid,
-- and the identities that make the record trustworthy are enforced in 0022.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. app.sale_tender — one row per way a sale was paid (04 §4.8).
--
-- `amount_minor` is the SERVER's figure: Σ amount_minor = sale.total_minor is
-- an identity (0022), and the server is the pricing authority, so when a
-- device priced against a stale list the server reconciles the split onto its
-- own total by a stated rule and keeps what the device said in
-- `claimed_minor` (apps/api/src/tender.ts). NULL there means "exactly as the
-- device tendered it", which is the normal case. A reconciled split also
-- opens a review — the server never silently rewrites how money moved.
--
-- `amount_minor` may be ZERO, for one reason only: a reconciliation that took
-- a line to nothing still has to keep the line, because the line carries a
-- reference (a momo transaction id) and a claimed amount that are evidence.
-- A device never sends a zero-amount line of its own accord.
--
-- `location_id` is denormalised from the sale so a sync bucket can carry the
-- row (a data query reads one table — 03 §3.2.3), and 0022 asserts it agrees.
-- ----------------------------------------------------------------------------
create table app.sale_tender (
  tenant_id     uuid        not null references platform.tenant (id),
  id            uuid        not null,
  write_id      uuid        not null,
  hlc           app.hlc     not null,
  created_at    timestamptz not null default transaction_timestamp(),
  updated_at    timestamptz not null default transaction_timestamp(),
  deleted_at    timestamptz,
  sale_id       uuid        not null,
  seq           smallint    not null,
  method_id     uuid        not null,
  amount_minor  app.money_minor not null,
  claimed_minor app.money_minor,      -- what the device said, when the server reconciled it
  reference     text,                 -- momo transaction id, bank ref, cheque number
  tendered_at   timestamptz not null, -- device clock. UNTRUSTED. Display only.
  location_id   uuid        not null, -- denormalised for the sync bucket; asserted equal in 0022
  constraint st_deleted_never check (deleted_at is null),
  constraint st_seq check (seq >= 1),
  constraint st_amount_nonneg check (amount_minor >= 0),
  constraint st_claimed_nonneg check (claimed_minor is null or claimed_minor >= 0),
  -- A claim equal to the stored figure is not a reconciliation; store NULL.
  constraint st_claimed_differs check (claimed_minor is null or claimed_minor <> amount_minor),
  constraint st_reference_shape check (reference is null or length(reference) between 1 and 64),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, sale_id) references app.sale (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, method_id) references app.tender_method (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate
);
create unique index sale_tender_uq on app.sale_tender (tenant_id, sale_id, seq);
create index sale_tender_location_ix on app.sale_tender (tenant_id, location_id, method_id);
select app.apply_tenant_rls('app.sale_tender');

revoke update, delete on app.sale_tender from app_user;
create trigger sale_tender_append_only
  before update or delete on app.sale_tender
  for each row execute function app.forbid_mutation();

comment on column app.sale_tender.amount_minor is
  'The server''s figure. Σ over a sale = sale.total_minor (0022). Minor units of the sale''s currency.';
comment on column app.sale_tender.claimed_minor is
  'What the device tendered, kept ONLY when the server reconciled the split onto its own repriced total. NULL = as tendered.';

-- A method that asks for a reference gets one. The counter enforces it first,
-- where the customer is still standing; this is the backstop for any other
-- writer. Checked against the method row AS IT IS NOW — a method edited to
-- require a reference does not invalidate history, because history is never
-- re-inserted.
create function app.sale_tender_reference_required() returns trigger
language plpgsql as $$
begin
  if new.reference is null and exists (
    select 1 from app.tender_method m
     where m.tenant_id = new.tenant_id and m.id = new.method_id and m.requires_reference
  ) then
    raise exception 'app.sale_tender: tender method % requires a reference (a transaction id, a cheque number) and none was given',
      new.method_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger sale_tender_reference_required
  before insert on app.sale_tender
  for each row execute function app.sale_tender_reference_required();


-- ----------------------------------------------------------------------------
-- 2. The session on the sale and on the sale's stock movements.
--
-- `cash_session_id` is required for every sale written from here on and
-- deliberately NOT for the ones already written: those were rung before a
-- till could be opened, and inventing a session for them — opened by nobody,
-- with a float nobody counted — would be fabricating a control record after
-- the fact. So the requirement is a CHECK added NOT VALID: Postgres enforces
-- it on every new row and does not re-examine existing ones. Both tables are
-- append-only, so an existing row can never be rewritten into violation.
-- ----------------------------------------------------------------------------
alter table app.sale add column cash_session_id uuid;
alter table app.sale add constraint sale_cash_session_fk
  foreign key (tenant_id, cash_session_id) references app.cash_session (tenant_id, id)
  deferrable initially immediate;
alter table app.sale add constraint sale_cash_session_required
  check (cash_session_id is not null) not valid;
create index sale_cash_session_ix on app.sale (tenant_id, cash_session_id);

comment on column app.sale.cash_session_id is
  'The till this sale was rung in (04 §4.8a). business_date is the session''s. Required for every sale since 0021 (CHECK NOT VALID: sales rung before tills existed are not re-attributed).';

alter table app.stock_movement add column cash_session_id uuid;
alter table app.stock_movement add constraint sm_cash_session_fk
  foreign key (tenant_id, cash_session_id) references app.cash_session (tenant_id, id)
  deferrable initially immediate;
-- A movement that a SALE caused carries the sale's session; nothing else does.
alter table app.stock_movement add constraint sm_sale_needs_session
  check (source_kind <> 'SALE' or cash_session_id is not null) not valid;
alter table app.stock_movement add constraint sm_session_only_for_sales
  check (cash_session_id is null or source_kind in ('SALE', 'SALE_RETURN'));

-- The one permitted UPDATE on stock_movement is archived_at
-- (app.forbid_mutation_except_archive); adding a column does not widen it.


-- ----------------------------------------------------------------------------
-- 3. BACKFILL — every sale already written gets the tender rows the identity
-- in 0022 will require of it.
--
-- The settlement of a pre-0021 sale is exactly what every reader of it has
-- always derived: the CHARGE credit entries that name it are ON ACCOUNT, and
-- the rest of its total was settled at the counter. That is not a guess
-- introduced here; it is the definition the sweep, the cash-position report
-- and the posting rules used until this migration, now written down once.
--
-- The tender methods those rows point at are created per tenant, ONLY for a
-- tenant that has sales to backfill, INACTIVE (no device will offer them) and
-- named for what they are. They deliberately do not reuse any template's codes:
-- a template is tenant data the platform does not know (CLAUDE.md §2.9), and a
-- later template application must not collide with a migration's rows.
-- ----------------------------------------------------------------------------
do $$
declare
  t           record;
  v_write     uuid;
  v_hlc       text;
  v_cash      uuid;
  v_account   uuid;
begin
  -- Tenant by tenant, WITH the tenant context set: every app table is FORCE
  -- ROW LEVEL SECURITY, so a migration role that is the tables' owner but not
  -- a superuser (a managed cluster's admin, typically) sees nothing at all
  -- without it, and the backfill would silently do nothing. platform.tenant
  -- carries no RLS and is the honest list to iterate.
  for t in select id as tenant_id from platform.tenant order by id
  loop
    perform set_config('app.tenant_id', t.tenant_id::text, true);
    if not exists (
      select 1 from app.sale s
       where s.tenant_id = t.tenant_id
         and not exists (select 1 from app.sale_tender st
                          where st.tenant_id = s.tenant_id and st.sale_id = s.id)
    ) then
      continue;
    end if;

    -- One SERVER-origin unit of work per tenant for the whole backfill: the
    -- rows below need a write spine, and "migration 0021" is the honest one.
    v_write := md5(t.tenant_id::text || ':migration:0021:sale_tender_backfill')::uuid;
    v_hlc := lpad((floor(extract(epoch from clock_timestamp()) * 1000))::bigint::text, 13, '0')
             || '-00000-' || md5('migration-0021');
    insert into app.write_log
      (tenant_id, id, origin, hlc, op, schema_version, request_hash)
    values
      (t.tenant_id, v_write, 'SERVER', v_hlc, 'migration.0021:sale_tender_backfill', 1,
       decode(md5('migration.0021:' || t.tenant_id::text), 'hex'))
    on conflict (tenant_id, id) do nothing;

    v_cash    := md5(t.tenant_id::text || ':migration:0021:tender:counter')::uuid;
    v_account := md5(t.tenant_id::text || ':migration:0021:tender:account')::uuid;

    insert into app.tender_method
      (tenant_id, id, write_id, hlc, code, name, posting_role, requires_reference,
       is_active, sort_order)
    values
      (t.tenant_id, v_cash, v_write, v_hlc, 'PRE-0021-COUNTER',
       'Settled at the counter (recorded before tender methods)', 'TILL_CASH', false, false, 900),
      (t.tenant_id, v_account, v_write, v_hlc, 'PRE-0021-ACCOUNT',
       'On account (recorded before tender methods)', 'AR_TRADE', false, false, 901)
    on conflict (tenant_id, id) do nothing;

    -- On account: exactly the CHARGE(s) that name the sale.
    insert into app.sale_tender
      (tenant_id, id, write_id, hlc, sale_id, seq, method_id, amount_minor,
       reference, tendered_at, location_id)
    select s.tenant_id,
           md5(s.tenant_id::text || ':migration:0021:tender:' || s.id::text || ':account')::uuid,
           v_write, v_hlc, s.id, 1, v_account, c.charged, null, s.occurred_at, s.location_id
      from app.sale s
      join lateral (
        select sum(ce.amount_minor)::bigint as charged
          from app.credit_entry ce
         where ce.tenant_id = s.tenant_id and ce.source_kind = 'SALE'
           and ce.source_id = s.id and ce.kind = 'CHARGE'
      ) c on c.charged is not null and c.charged > 0
     where s.tenant_id = t.tenant_id
       and not exists (select 1 from app.sale_tender st
                        where st.tenant_id = s.tenant_id and st.sale_id = s.id);

    -- At the counter: whatever of the total the account did not carry.
    insert into app.sale_tender
      (tenant_id, id, write_id, hlc, sale_id, seq, method_id, amount_minor,
       reference, tendered_at, location_id)
    select s.tenant_id,
           md5(s.tenant_id::text || ':migration:0021:tender:' || s.id::text || ':counter')::uuid,
           v_write, v_hlc, s.id,
           case when a.charged > 0 then 2 else 1 end,
           v_cash, s.total_minor - a.charged, null, s.occurred_at, s.location_id
      from app.sale s
      join lateral (
        select coalesce(sum(ce.amount_minor), 0)::bigint as charged
          from app.credit_entry ce
         where ce.tenant_id = s.tenant_id and ce.source_kind = 'SALE'
           and ce.source_id = s.id and ce.kind = 'CHARGE'
      ) a on true
     where s.tenant_id = t.tenant_id
       and s.total_minor - a.charged > 0
       and not exists (select 1 from app.sale_tender st
                        where st.tenant_id = s.tenant_id and st.sale_id = s.id
                          and st.method_id = v_cash);
  end loop;
  perform set_config('app.tenant_id', '', true);
end
$$;
