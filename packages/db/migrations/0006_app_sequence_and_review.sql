-- ============================================================================
-- 0006_app_sequence_and_review.sql — human-facing document numbers allocated
-- offline (03 §3.7.5), and the review queue their failure mode reports into
-- (03 §3.6.2, conflict class #14).
--
-- THE PROBLEM THIS CLOSES. Receipt numbers must be human-readable,
-- per-location and allocable with ZERO connectivity. Before this migration
-- every block was self-issued by the device, so a device whose local database
-- was wiped mid-block (OPFS eviction, PWA reinstall on the same enrolled
-- device) restarted its cursor and reissued numbers it had already printed.
-- `sale_receipt_uq` then rejected the second sale with a raw unique violation,
-- which the client's §3.3.4 taxonomy classes RETRYABLE — so the op retried
-- forever, the outbox never drained, and the till went dark for uploads while
-- looking merely "stuck".
--
-- The answer is NOT to dead-letter the sale (that is the loss path §3.3.4
-- exists to prevent) and NOT to renumber silently (that hands a customer a
-- number another customer already holds). It is to make the regression
-- DETECTABLE and REPORTED:
--
--   * blocks are allocated SERVER-SIDE from a row-locked counter, never
--     self-issued, and never reused or reissued after a device reset;
--   * `consumed_upto` is device-local state that is REPORTED, never
--     authoritative — and the database REFUSES to record a regression
--     (sequence_block_monotonic), so the application cannot paper over one;
--   * any regression burns the remainder of the block, issues a fresh one,
--     and opens a SEVERITY-1 conflict_review naming the overlap range.
--
-- Gaps are the deliberate price: you cannot have all three of {globally
-- sequential, gapless, offline-allocable} (§3.7.1). `consumed_upto` is what
-- lets us tell an auditor precisely which numbers were never issued.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- app.sequence_counter — the per-(tenant, location, sequence_key) allocation
-- counter (03 §3.7.5: "the server allocates a block under a row lock on a
-- per-(tenant, location, sequence_key) counter").
--
-- This is a mutable counter, and that is deliberate: it is SERVER-SIDE ONLY,
-- never synced, never device-authored. 04 §4.7 deletes the old
-- `document_number_range` precisely because THAT counter was synced to devices
-- and read back stale. The distinction is the whole point — a counter only one
-- writer can advance, under a lock, is not the coordination §3.7.1 calls
-- unresolvable offline.
--
-- Format lives here as TENANT CONFIGURATION, never as platform code. §3.7.5
-- makes numbering format a jurisdiction-pack value with a tenant override, and
-- ADR-0007 makes invoice numbering rules a pack concern; the pack states the
-- required width and the overflow behaviour. Tenant #1's template ships
-- '{location_code}-{prefix}-{n:06d}' (e.g. SUN-RCT-004312) as ordinary
-- editable rows.
--
-- SEAM: `number_format`/`block_size` defaults belong in the jurisdiction pack
-- once a pack-configuration surface exists (§2.5 work). Until then the
-- template seeds them per counter row. There is deliberately NO platform
-- default and NO fallback: a location with no counter row cannot allocate, and
-- allocation fails closed rather than inventing a format. That is what keeps
-- `if (country = 'GH')` out of the code — the value is data or it is absent.
-- ----------------------------------------------------------------------------
create table app.sequence_counter (
  tenant_id     uuid        not null references platform.tenant (id),
  id            uuid        not null,
  write_id      uuid        not null,
  hlc           app.hlc     not null,
  created_at    timestamptz not null default transaction_timestamp(),
  updated_at    timestamptz not null default transaction_timestamp(),
  deleted_at    timestamptz,
  -- 'RECEIPT' | 'INVOICE' | 'TRANSFER' | 'CREDIT_NOTE' — pack + tenant data,
  -- NOT a hard-coded enum (§3.7.5). No CHECK list, deliberately.
  sequence_key  text        not null check (sequence_key ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  location_id   uuid        not null,
  -- The next block_start to hand out. ONLY ever advances (sequence_counter_
  -- monotonic): a block is never reused, never returned, never reissued.
  next_start    bigint      not null default 1 check (next_start >= 1),
  -- §3.7.5, corrected on review: 500 numbers is 3–4 days at a flagship till,
  -- not "two weeks". Tenant- and location-type-configurable; the template
  -- ships 2000 at Flagship-class locations.
  block_size    integer     not null check (block_size between 1 and 1000000),
  -- Rendered by the DEVICE from these values, so the block boundary is
  -- invisible to a human and a printed receipt is self-describing.
  number_format text        not null,
  number_prefix text        not null check (number_prefix ~ '^[A-Z0-9]{1,8}$'),
  -- Template provenance (0003 header): advisory only. NO business logic may
  -- ever read origin_ref — that is tenant identity by another name (§2.9).
  origin_template_id text,
  origin_ref         text,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate
);
create unique index sequence_counter_uq
  on app.sequence_counter (tenant_id, sequence_key, location_id)
  where deleted_at is null;
create unique index sequence_counter_origin_uq
  on app.sequence_counter (tenant_id, origin_template_id, origin_ref)
  where origin_ref is not null;
select app.apply_tenant_rls('app.sequence_counter');

comment on table app.sequence_counter is
  'Server-side block allocation counter (03 §3.7.5). NEVER synced to a device — a device-readable counter is the defect 04 §4.7 deleted document_number_range for.';
comment on column app.sequence_counter.number_format is
  'Tenant configuration, e.g. {location_code}-{prefix}-{n:06d}. Jurisdiction-pack value with a tenant override (ADR-0007) — never a platform constant, never branched on.';

-- next_start only ever advances. A rewind would reissue a block, which is the
-- one thing §3.7.5 says must never happen.
create function app.forbid_sequence_counter_rewind() returns trigger
language plpgsql as $$
begin
  if new.next_start < old.next_start then
    raise exception
      'app.sequence_counter.next_start cannot rewind (% -> %): a block is never reused, never returned and never reissued (03 §3.7.5).',
      old.next_start, new.next_start;
  end if;
  if new.sequence_key <> old.sequence_key or new.location_id <> old.location_id then
    raise exception 'app.sequence_counter identity (sequence_key, location_id) is immutable.';
  end if;
  return new;
end
$$;
create trigger sequence_counter_monotonic
  before update on app.sequence_counter
  for each row execute function app.forbid_sequence_counter_rewind();

-- ----------------------------------------------------------------------------
-- app.sequence_block — one allocated range, held by one device (03 §3.7.5).
--
-- Keyed (tenant_id, sequence_key, location_id, device_id, block_start) per
-- 04 §4.7's correction of the deleted duplicate: WITH a device_id and WITH a
-- uniqueness constraint, so two devices at one location cannot collide.
--
-- `consumed_upto` is DEVICE-LOCAL STATE THAT IS REPORTED, NEVER AUTHORITATIVE.
-- The device consumes with no network at all; on reconnect it tells the server
-- how far it got. The server's copy is a high-water mark it will not lower.
-- ----------------------------------------------------------------------------
create table app.sequence_block (
  tenant_id     uuid        not null references platform.tenant (id),
  id            uuid        not null,
  write_id      uuid        not null,
  hlc           app.hlc     not null,
  created_at    timestamptz not null default transaction_timestamp(),
  updated_at    timestamptz not null default transaction_timestamp(),
  deleted_at    timestamptz,
  sequence_key  text        not null,
  location_id   uuid        not null,
  device_id     uuid        not null,
  block_start   bigint      not null check (block_start >= 1),
  block_size    integer     not null check (block_size between 1 and 1000000),
  -- Highest number the device reports having ISSUED from this block.
  -- NULL = nothing issued (or nothing reported yet).
  consumed_upto bigint,
  reported_at   timestamptz,
  issued_at     timestamptz not null default transaction_timestamp(),
  -- Set together: a closed block always says WHY it closed.
  exhausted_at  timestamptz,
  closed_reason text check (closed_reason in
                  ('EXHAUSTED',            -- consumed to the last number
                   'REGRESSION_BURN',      -- conflict class #14: remainder destroyed
                   'SUPERSEDED')),         -- replaced while still partly unused
  constraint sequence_block_deleted_never check (deleted_at is null),
  constraint sequence_block_consumed_in_range check (
    consumed_upto is null
    or (consumed_upto >= block_start and consumed_upto <= block_start + block_size - 1)
  ),
  constraint sequence_block_closed_pair check ((exhausted_at is null) = (closed_reason is null)),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate
);

-- Ranges never overlap AT A LOCATION, across every device. This is the
-- structural guarantee that two devices cannot be handed the same numbers.
create unique index sequence_block_range_uq
  on app.sequence_block (tenant_id, sequence_key, location_id, block_start);

-- At most ONE live block per device, so "the device's current block" is a
-- well-defined row. A replacement can only be issued after the incumbent is
-- closed — reissue without burning is impossible, not merely discouraged.
create unique index sequence_block_live_uq
  on app.sequence_block (tenant_id, sequence_key, location_id, device_id)
  where exhausted_at is null;

create index sequence_block_device_ix
  on app.sequence_block (tenant_id, sequence_key, location_id, device_id, block_start);
select app.apply_tenant_rls('app.sequence_block');

comment on column app.sequence_block.consumed_upto is
  'Device-local state that is REPORTED, never authoritative (03 §3.7.5). The server keeps it as a high-water mark and REFUSES any regression — see sequence_block_monotonic.';

-- The structural backstop for conflict class #14. A regression is REFUSED at
-- the database level, so the allocation path cannot quietly write one and call
-- the problem handled: it must burn the block, reissue, and open the review.
create function app.forbid_sequence_block_regression() returns trigger
language plpgsql as $$
begin
  if new.sequence_key  <> old.sequence_key
     or new.location_id <> old.location_id
     or new.device_id   <> old.device_id
     or new.block_start <> old.block_start
     or new.block_size  <> old.block_size then
    raise exception 'app.sequence_block identity and range are immutable once issued (03 §3.7.5).';
  end if;
  if old.consumed_upto is not null
     and (new.consumed_upto is null or new.consumed_upto < old.consumed_upto) then
    raise exception
      'app.sequence_block.consumed_upto cannot regress (% -> %): burn the block, issue a fresh one and open a severity-1 review (03 §3.7.5, conflict class #14).',
      old.consumed_upto, coalesce(new.consumed_upto::text, 'null');
  end if;
  if old.exhausted_at is not null
     and (new.exhausted_at is distinct from old.exhausted_at
          or new.closed_reason is distinct from old.closed_reason) then
    raise exception 'app.sequence_block: a closed block never reopens — a block is never reused (03 §3.7.5).';
  end if;
  return new;
end
$$;
create trigger sequence_block_monotonic
  before update on app.sequence_block
  for each row execute function app.forbid_sequence_block_regression();

revoke delete on app.sequence_block from app_user;
create trigger sequence_block_no_delete
  before delete on app.sequence_block
  for each row execute function app.forbid_mutation();

-- ----------------------------------------------------------------------------
-- app.conflict_review — the human review queue (03 §3.6.2).
--
-- "A review queue nobody works is silent overwriting with extra steps", so
-- this is a product surface, not a dumping ground. Every conflict that cannot
-- be resolved automatically lands here; nothing is ever silently overwritten
-- (CLAUDE.md §2.2).
--
-- SCOPE OF THIS MIGRATION. The columns below are §3.6.2's shape minus the
-- parts that belong to conflict classes not yet built:
--   * `conflict_class` is text, not an FK — the `conflict_classes` registry
--     with its expiry policies and per-class escalation_step chain is §3.6.2
--     work that arrives with the credit-limit classes;
--   * `ancestor_value` is present but unused by class #14 (a receipt-number
--     regression has no last-agreed value — the numbers were printed);
--   * the heavy server-side `conflict_review_context` snapshot is NOT created:
--     §3.6.2 keeps it off devices deliberately, and class #14's whole context
--     is the overlap range, which fits in proposals.
-- Nothing here is shaped so that adding those later is a rewrite.
--
-- MONEY IN JSONB IS MONEY AS A STRING (§3.6.2, ADR-0004): every monetary or
-- quantity value inside proposals/pending_value/ancestor_value/resolution is a
-- decimal STRING. JSON.parse of a bare number yields float64, and this is a
-- path where a human reads a figure and re-enters it.
-- ----------------------------------------------------------------------------
create table app.conflict_review (
  tenant_id           uuid        not null references platform.tenant (id),
  id                  uuid        not null,
  write_id            uuid        not null,
  hlc                 app.hlc     not null,
  created_at          timestamptz not null default transaction_timestamp(),
  updated_at          timestamptz not null default transaction_timestamp(),
  deleted_at          timestamptz,
  conflict_class      text        not null,
  -- 1 blocking .. 4 informational. A receipt-number regression is 1.
  severity            smallint    not null check (severity between 1 and 4),
  entity_table        text        not null,
  entity_id           uuid        not null,
  field_path          text,                       -- NULL = whole row
  ancestor_value      jsonb,                      -- last value both parties agreed on
  proposals           jsonb       not null,       -- provenance per party; money as STRINGS
  pending_state       text        not null check (pending_state in
                        ('ancestor', 'safe_default', 'first_applied')),
  pending_value       jsonb       not null,       -- what the row actually reads right now
  -- Routes the queue by PERMISSION, never by named individual (§3.6.2) —
  -- naming a person is how a queue rots the first time someone takes leave.
  required_permission text        not null,
  status              text        not null default 'open' check (status in
                        ('open', 'claimed', 'resolved', 'auto_resolved', 'expired')),
  claimed_by          uuid,
  claimed_at          timestamptz,
  resolved_by         uuid,
  resolved_at         timestamptz,
  resolution          jsonb,                      -- {choice, value, note}
  opened_at           timestamptz not null default transaction_timestamp(),
  escalate_at         timestamptz not null,
  escalation_level    smallint    not null default 0 check (escalation_level >= 0),
  constraint conflict_review_deleted_never check (deleted_at is null),
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate
);
create index conflict_review_queue_ix
  on app.conflict_review (tenant_id, status, severity, opened_at);
create index conflict_review_entity_ix
  on app.conflict_review (tenant_id, entity_table, entity_id);
select app.apply_tenant_rls('app.conflict_review');

comment on column app.conflict_review.proposals is
  'Provenance per party. Every monetary or quantity value inside is a decimal STRING, never a JSON number (03 §3.6.2, ADR-0004).';

-- §3.6.2, corrected on review: `location_scope uuid[]` was declared and never
-- used, so the queue filtered on permission alone and a sev-1 review reached
-- every eligible holder at all 25 outlets. Scope is NORMALISED so the sync
-- data query can filter on it — array containment is not something to assume a
-- sync engine supports.
create table app.conflict_review_location (
  tenant_id   uuid        not null references platform.tenant (id),
  id          uuid        not null,
  write_id    uuid        not null,
  hlc         app.hlc     not null,
  created_at  timestamptz not null default transaction_timestamp(),
  updated_at  timestamptz not null default transaction_timestamp(),
  deleted_at  timestamptz,
  review_id   uuid        not null,
  location_id uuid        not null,
  primary key (tenant_id, id),
  foreign key (tenant_id, write_id) references app.write_log (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, review_id) references app.conflict_review (tenant_id, id)
    deferrable initially immediate,
  foreign key (tenant_id, location_id) references app.location (tenant_id, id)
    deferrable initially immediate
);
create unique index conflict_review_location_uq
  on app.conflict_review_location (tenant_id, review_id, location_id);
select app.apply_tenant_rls('app.conflict_review_location');

-- ----------------------------------------------------------------------------
-- app.sale.receipt_no_claimed — what the CUSTOMER'S PAPER SAYS, when it
-- differs from what we could store.
--
-- Prevention (above) closes the window, but it cannot close it retroactively:
-- a device that was wiped and kept trading OFFLINE has already printed
-- duplicates before it can report anything. Those sales still have to land.
--
-- `sale_receipt_uq` is not negotiable — two rows must never claim one number.
-- So a colliding sale is recorded under the emergency form §3.7.5 already
-- defines for offline block exhaustion (`SUN-RCT-004999-D3F`, suffix derived
-- from device_id), and `receipt_no_claimed` preserves the number actually
-- printed, with a severity-1 review naming both. The sale is never lost and
-- never silently renumbered: the paper in the customer's hand stays findable.
-- NULL means receipt_no is exactly what was printed, which is the normal case.
-- ----------------------------------------------------------------------------
alter table app.sale add column receipt_no_claimed text;
create index sale_receipt_claimed_ix
  on app.sale (tenant_id, location_id, receipt_no_claimed)
  where receipt_no_claimed is not null;

comment on column app.sale.receipt_no_claimed is
  'The number PRINTED on the customer''s receipt when it could not be stored as receipt_no (a #14 collision). NULL in the normal case. 03 §3.7.5.';
