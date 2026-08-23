-- ============================================================================
-- 0010_delivery_business_date.sql — `app.delivery` gets a trading day.
--
-- NUMBERED 0010, NOT 0009. The task that commissioned this file called it
-- `0009_delivery_business_date.sql`; `0009_procurement_permissions.sql` had
-- already been written and applied. A migration is a historical fact, not a
-- document (0009's own header says so), so the number moved and the file did
-- not. Nothing here edits 0008 or 0009.
--
-- ---------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------
-- ADR-0001 removed the owned fleet and promised, in exchange, that haulage
-- spend would be MEASURABLE as a percentage of revenue per outlet and per
-- region — that is the whole of what `open-questions.md` Q1 is waiting on.
-- A percentage is a numerator and a denominator OVER THE SAME PERIOD, and
-- until now the two sides were dated by different rules:
--
--   · revenue  — `app.sale.business_date`, the human-asserted trading day;
--   · haulage  — `coalesce(planned_for, dispatched_at::date, created_at::date)`
--                computed in the query, whose second term is a DEVICE clock.
--
-- 03 §3.4.2 says a device clock is untrusted for ordering and for attribution.
-- A till two hours fast at 23:55 does not move a sale into tomorrow, and a
-- haulier's tablet must not move GH-denominated freight across a month end.
-- Worse, the fallback was silent: nothing on the row said which of the three
-- rules had dated it, so a period total could not be audited after the fact.
--
-- The fix is a column, not a cleverer `coalesce`, because attribution is a
-- FACT ABOUT THE ROW and it must stop changing when someone edits a query.
--
-- ---------------------------------------------------------------------------
-- WHAT IT IS
-- ---------------------------------------------------------------------------
-- `business_date` is the trading day the haulage is attributed to — the same
-- kind of value as `app.sale.business_date` and `app.goods_receipt.business_date`,
-- declared the same way they are: `date not null`, no default, no trigger, and
-- validated on the wire by `zBusinessDate`. `dispatched_at` and `delivered_at`
-- keep their meaning exactly: device observations, for display and forensics.
--
-- `business_date_derived_from` records HOW the row got its date, so the
-- honesty the router used to publish per query is now a property of the row:
--
--   NULL             the writer asserted the trading day outright;
--   'PLANNED_FOR'    taken from the human-asserted planned date;
--   'DISPATCH_CLOCK' taken from a device clock — BACKFILL ONLY (see below);
--   'ROW_CREATED'    taken from the server's own transaction date.
--
-- Only 'DISPATCH_CLOCK' is untrusted. `logistics.haulageSpend` reports the
-- counts per basis so a period built partly on backfilled rows can never be
-- read as one that was asserted throughout.
-- ============================================================================

alter table app.delivery
  add column business_date date,
  add column business_date_derived_from text
    constraint delivery_business_date_derived_from_known
      check (business_date_derived_from is null
             or business_date_derived_from in ('PLANNED_FOR', 'DISPATCH_CLOCK', 'ROW_CREATED'));

-- ---------------------------------------------------------------------------
-- THE BACKFILL RULE, STATED RATHER THAN IMPLIED
-- ---------------------------------------------------------------------------
-- Rows written before this migration have no asserted trading day and one
-- cannot be invented for them. They are dated by EXACTLY the fallback the
-- router used to compute at read time — `planned_for`, then `dispatched_at`,
-- then `created_at` — so no figure any human has already seen changes value
-- on the day this migration runs. What changes is that the basis is now
-- WRITTEN DOWN and frozen: from here on the date of a historical delivery
-- cannot drift because someone reorders a `coalesce`.
--
-- `created_at` is a server timestamp, so the 'ROW_CREATED' arm is trustworthy.
-- The 'DISPATCH_CLOCK' arm is not, and it is labelled precisely so that the
-- report can say how much of a period rests on it.
--
-- This runs unconditionally over every row including soft-deleted ones: a
-- NOT NULL column cannot have exceptions, and a cancelled delivery still
-- belongs to a day.
update app.delivery
   set business_date = coalesce(planned_for, dispatched_at::date, created_at::date),
       business_date_derived_from =
         case when planned_for   is not null then 'PLANNED_FOR'
              when dispatched_at is not null then 'DISPATCH_CLOCK'
              else 'ROW_CREATED' end
 where business_date is null;

alter table app.delivery
  alter column business_date set not null;

-- Period aggregation leads with tenant_id (CLAUDE.md §2.1) and then with the
-- column every distribution-cost query now filters on. The carrier tail makes
-- the per-haulier negotiating view an index scan rather than a re-sort.
create index delivery_business_date_ix
  on app.delivery (tenant_id, business_date, carrier_supplier_id);

comment on column app.delivery.business_date is
  'The trading day this delivery''s haulage is attributed to — the accounting fact, and the period key distribution cost as a % of revenue is computed on (ADR-0001, open-questions Q1). Never derived from a device clock (03 §3.4.2); dispatched_at and delivered_at remain device observations for display and forensics.';
comment on column app.delivery.business_date_derived_from is
  'How business_date was obtained: NULL = asserted by the writer, PLANNED_FOR = taken from the human-asserted planned date, ROW_CREATED = taken from the server transaction date, DISPATCH_CLOCK = taken from an untrusted device clock and set ONLY by migration 0010''s backfill of pre-0010 rows.';
