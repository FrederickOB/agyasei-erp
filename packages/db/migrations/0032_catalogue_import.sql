-- ============================================================================
-- 0032 — THE CATALOGUE FROM A FILE, AND WHAT A PRODUCT COSTS
--
-- Until now the only writer of `app.product` was the onboarding template
-- (seed/template.ts). A tenant whose catalogue is not the template's — which
-- is every tenant but the first, and the first too, once it trades — had no
-- way to bring its own product list in. `apps/api/src/routers/products.ts`
-- is that way: one spreadsheet, every row checked, the good rows created and
-- the bad ones handed back with a reason. Unlike opening stock (0031), a
-- product list is NOT all-or-nothing: a duplicate or a typo on one line says
-- nothing about the line below it, and a person fixing 3 rows of 400 should
-- not have to re-upload 397.
--
-- TWO TABLES:
--
--  · app.product_cost — what ONE stocking unit of a product costs the tenant,
--    as the tenant states it (the "cost price" column of the import). It is
--    the FALLBACK cost for the management P&L sheet when a product has been
--    sold but no costed receipt or opening movement exists yet to give it a
--    weighted-average cost (reports.ts COST_BASIS_SQL). Stating a cost is not
--    choosing a costing method (Q16): nothing posts to the GL from it.
--
--    SERVER-ONLY, deliberately. It is NOT in infra/powersync/sync_rules.yaml:
--    a cost price on every counter tablet is every margin on every counter
--    tablet, and the residency rule (02 §2.5) says the right to sell a thing
--    is not the right to carry what it cost. It is read online, behind
--    `catalogue.manage` or `gl.view`.
--
--  · app.catalogue_import — one row per committed file: who, when, how many
--    rows, how many created, how many refused. Append-only. The products a
--    file created carry `write_id` = this import's id.
--
-- REMOVING PRODUCTS is an archive, never a DELETE: `deleted_at` is set on the
-- product and its units, prices, supplier links and cost, which drops them
-- out of every device's sync bucket (every catalogue query in sync_rules.yaml
-- filters `deleted_at IS NULL`). Sales, returns and stock movements keep
-- their foreign keys to the archived rows; history is never rewritten.
-- ============================================================================

create table app.product_cost (
  tenant_id  uuid        not null references platform.tenant (id),
  id         uuid        not null,
  write_id   uuid        not null,
  hlc        app.hlc     not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  deleted_at timestamptz,
  product_id uuid        not null,
  -- Minor units per ONE stocking unit × 10⁴ (app.rate_e4, like a price). The
  -- extra four digits hold a cost such as 0.125 a piece exactly; it becomes
  -- an amount once, at the rounding of whatever figure uses it.
  cost_e4    app.rate_e4 not null check (cost_e4 >= 0),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, product_id) references app.product (tenant_id, id)
    deferrable initially immediate
);
-- At most one live cost per product. A new cost archives the old row.
create unique index product_cost_product_uq on app.product_cost (tenant_id, product_id)
  where deleted_at is null;
select app.apply_tenant_rls('app.product_cost');

comment on table app.product_cost is
  'The tenant''s stated cost of ONE stocking unit, minor units × 10^4. Fallback cost for the management P&L when no costed receipt exists. Server-only: never synced to a device (0032).';

create table app.catalogue_import (
  tenant_id       uuid        not null references platform.tenant (id),
  id              uuid        not null,
  write_id        uuid        not null,
  hlc             app.hlc     not null,
  created_at      timestamptz not null default transaction_timestamp(),
  updated_at      timestamptz not null default transaction_timestamp(),
  deleted_at      timestamptz,
  content_sha256  text        not null,   -- of the normalised rows, not the raw bytes
  file_name       text,
  row_count       integer     not null,
  imported_count  integer     not null,
  rejected_count  integer     not null,
  imported_by     uuid        not null,   -- from the verified token
  constraint ci_deleted_never check (deleted_at is null),
  constraint ci_hash_shape check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint ci_counts check (
    row_count > 0 and imported_count >= 0 and rejected_count >= 0
    and imported_count + rejected_count = row_count
  ),
  constraint ci_file_name_shape check (file_name is null or length(file_name) between 1 and 200),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
select app.apply_tenant_rls('app.catalogue_import');
revoke update, delete on app.catalogue_import from app_user;
create trigger catalogue_import_append_only
  before update or delete on app.catalogue_import
  for each row execute function app.forbid_mutation();

comment on table app.catalogue_import is
  'One committed product-list file (0032). Products it created carry write_id = this id. Append-only.';
