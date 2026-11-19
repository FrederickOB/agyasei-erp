-- ============================================================================
-- 0031 — OPENING STOCK, LOADED ONCE FROM A FILE (open-questions Q20)
--
-- Q21 is answered (no trading before go-live), so Q20 collapses to its small
-- version: opening balances are opening STOCK, plus whatever capital and bank
-- position the accountant determines. This file is the STOCK half and only
-- that. NOTHING HERE POSTS TO THE GENERAL LEDGER: the GL opening balance is
-- the accountant's (Track B, phase2-gate §4.3 (d)), and an `OPENING` movement
-- carries no journal consequence anywhere in this system — no sweep reads it.
--
-- WHAT A ROW IS: one `app.stock_movement` with source_kind 'OPENING' and
-- source_id = the import's id, a positive scaled-integer quantity in the
-- product's STOCKING unit at that unit's own scale, and — when the file gives
-- one — `unit_cost_e4` for the later costing decision (Q16). Storing a cost is
-- not choosing a costing method; nothing reads it as one.
--
-- ONCE, AND ONLY ONCE: `content_sha256` is unique per tenant, so the same file
-- uploaded twice (a second browser tab, a re-click after a timeout, a fresh
-- idempotency key) lands the stock once and answers the second time with the
-- first import. A (location, product) that already holds ANY opening movement
-- is refused by the import (apps/api/src/routers/opening-stock.ts): a second
-- opening is a correction, which is `stock.adjust`'s job, not a re-import.
-- ============================================================================

insert into platform.permission
  (code, domain, description, is_sensitive, requires_fresh_authorization, bound_schema, offline_mode)
values
  ('stock.opening.import', 'stock',
   'Load opening stock for many locations from a file, once per location and product, before trading starts.',
   -- Sensitive: it sets the stock every later count, margin and alert is
   -- measured against. Fresh: an HQ act against a live server, never a
   -- queued offline write.
   true, true, null, 'never')
on conflict (code) do nothing;

create table app.opening_stock_import (
  tenant_id       uuid        not null references platform.tenant (id),
  id              uuid        not null,
  write_id        uuid        not null,
  hlc             app.hlc     not null,
  created_at      timestamptz not null default transaction_timestamp(),
  updated_at      timestamptz not null default transaction_timestamp(),
  deleted_at      timestamptz,
  content_sha256  text        not null,   -- of the normalised rows, not the raw bytes
  file_name       text,
  as_of_date      date        not null,   -- the business date every movement carries
  row_count       integer     not null,
  location_count  integer     not null,
  product_count   integer     not null,
  imported_by     uuid        not null,   -- from the verified token
  constraint osi_deleted_never check (deleted_at is null),
  constraint osi_hash_shape check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint osi_counts check (row_count > 0 and location_count > 0 and product_count > 0),
  constraint osi_file_name_shape check (file_name is null or length(file_name) between 1 and 200),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
create unique index opening_stock_import_content_uq on app.opening_stock_import (tenant_id, content_sha256);
select app.apply_tenant_rls('app.opening_stock_import');
revoke update, delete on app.opening_stock_import from app_user;
create trigger opening_stock_import_append_only
  before update or delete on app.opening_stock_import
  for each row execute function app.forbid_mutation();

comment on table app.opening_stock_import is
  'One bulk load of opening STOCK (Q20). Its rows are app.stock_movement OPENING rows with source_id = this id. Posts nothing to the GL (0031).';

-- The import's movements are found by (source_kind, source_id) through the
-- existing stock_movement_source_ix; the once-per-pair check reads this:
create index stock_movement_opening_ix on app.stock_movement (tenant_id, location_id, product_id)
  where source_kind = 'OPENING';
