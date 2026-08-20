-- ============================================================================
-- 0002_app_foundation.sql — the app schema's spine: domains, the tenant
-- isolation machinery, and the ONE write registry (app.write_log).
--
-- Everything in `app` is tenant-owned. No exceptions, no exempt list, no
-- discretion (01-tenancy §1). Every table follows the tenant pattern:
--
--   tenant_id  uuid NOT NULL references platform.tenant(id)   -- never from a client payload
--   id         uuid NOT NULL                                   -- UUIDv7, client-generatable offline
--   primary key (tenant_id, id)                                -- leads with tenant_id
--   ENABLE + FORCE ROW LEVEL SECURITY, policy tenant_isolation
--   composite FKs carrying tenant_id on both sides
--
-- The conformance suite (test/conformance.test.ts) interrogates pg_catalog
-- and fails the build on any app table missing any part of this pattern.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Domains (04-data-model §4.2.1). They exist so a lint rule and a pg_type
-- query have something to grep for; the conformance suite is what actually
-- rejects float/numeric on money.
-- ----------------------------------------------------------------------------

-- An AMOUNT, in the jurisdiction's minor unit. bigint in Postgres AND
-- TypeScript — never float/double/real/numeric/number (ADR-0004).
create domain app.money_minor as bigint;

-- A RATE (unit price, unit cost): minor units × 10^4. Amounts are exact in
-- minor units; rates need sub-minor-unit precision (GH₵2.375/metre is a real
-- shelf price). The single point where a rate becomes an amount is the
-- extended-line rounding rule (04 §4.13 row 3).
create domain app.rate_e4 as bigint;

-- A QUANTITY: scaled integer; the scale comes from the unit of measure and
-- is snapshotted onto every row that stores a qty (04 §4.4.3).
create domain app.qty as bigint;

-- Basis points; 10000 = 100%.
create domain app.bp as integer
  check (value between -1000000 and 1000000);

-- Hybrid logical clock, fixed-width text so LEXICOGRAPHIC ORDER IS CAUSAL
-- ORDER: 13-digit wall ms, 5-digit counter, full 32-hex node (all 128 bits —
-- a truncated node breaks total ordering, 04 §4.2.1). COLLATE "C" is
-- load-bearing: any linguistic collation silently breaks byte ordering.
create domain app.hlc as text collate "C"
  check (value ~ '^[0-9]{13}-[0-9]{5}-[0-9a-f]{32}$');

-- ----------------------------------------------------------------------------
-- The tenant GUC and the canonical RLS predicate (02-security §RLS).
--
-- app.tenant_id is set per transaction (SET LOCAL / set_config(..., true))
-- from the VERIFIED token claim, server-side. It is never read from a request
-- body, header or path parameter. Unset ⇒ current_tenant() returns NULL ⇒
-- every policy predicate is NULL ⇒ zero rows / insert refused: fails closed.
-- ----------------------------------------------------------------------------
create function app.current_tenant() returns uuid
language sql stable parallel safe as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- One helper so the policy text is canonical in exactly one place. The
-- conformance suite asserts every app table's policy expression is EXACTLY
-- this predicate — a policy that exists but reads USING (true) is a leak
-- wearing a seatbelt (04 §4.2.5).
create function app.apply_tenant_rls(tbl regclass) returns void
language plpgsql as $$
begin
  execute format('alter table %s enable row level security', tbl);
  execute format('alter table %s force row level security', tbl);
  execute format(
    'create policy tenant_isolation on %s '
    || 'using (tenant_id = app.current_tenant()) '
    || 'with check (tenant_id = app.current_tenant())',
    tbl);
end
$$;

-- ----------------------------------------------------------------------------
-- Append-only guards. REVOKE is the first line; the trigger survives a
-- future careless GRANT (04 §4.7.1).
-- ----------------------------------------------------------------------------
create function app.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '%.% is append-only: % refused. Corrections are compensating rows, never edits.',
    tg_table_schema, tg_table_name, tg_op;
end
$$;

-- stock_movement permits exactly ONE update: archived_at (sync windowing,
-- 04 §4.7.1). Everything else raises.
create function app.forbid_mutation_except_archive() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'archived_at' - 'updated_at')
       = (to_jsonb(old) - 'archived_at' - 'updated_at') then
    return new;
  end if;
  raise exception '%.% is append-only (archived_at is the one permitted update): % refused.',
    tg_table_schema, tg_table_name, tg_op;
end
$$;

-- ----------------------------------------------------------------------------
-- app.write_log — THE ONE WRITE REGISTRY (04 §4.2.2, §4.17.2).
--
-- `id` IS the idempotency key: a client-generated UUIDv7 naming the unit of
-- work (a sale = header + lines + movements + tender, one write_log row).
-- PRIMARY KEY (tenant_id, id) makes idempotency-key uniqueness PER TENANT,
-- never global (ADR-0005; CLAUDE.md §2.1). Ingest is
-- INSERT ... ON CONFLICT (tenant_id, id) DO NOTHING + replay of
-- response_body — a retry is a no-op, and two tenants may share a key value
-- without colliding.
--
-- hlc is SERVER-STAMPED at ingest (§3.4.1). The device's own clock assertion
-- is stored as claimed_hlc and is UNTRUSTED — forensics, never ordering.
--
-- Every other app table carries write_id with a composite FK back to this
-- table, so omitting the idempotency key is a foreign-key violation, not a
-- code-review comment.
--
-- This table is the referent of that FK, so it is the one app table without
-- a write_id column — the per-assertion exemption is declared in
-- src/schema.ts (WRITE_ID_EXEMPT) and honoured by the conformance suite.
-- It still has tenant_id, RLS enabled AND forced, and a tenant-leading PK:
-- NO table is ever exempt from those (04 §4.2.5).
-- ----------------------------------------------------------------------------
create table app.write_log (
  tenant_id       uuid        not null references platform.tenant (id),
  id              uuid        not null,   -- UUIDv7 from the device. THE idempotency key.
  origin          text        not null check (origin in ('DEVICE', 'SERVER')),
  hlc             app.hlc     not null,   -- server-stamped at ingest
  claimed_hlc     app.hlc,                -- device assertion; UNTRUSTED
  device_id       uuid,                   -- NULL iff origin = 'SERVER'
  user_id         uuid,                   -- NULL only for scheduled server jobs
  location_id     uuid,                   -- from the verified session, NOT the payload
  op              text        not null,   -- 'sale.create', 'stock.adjust', 'template.apply', ...
  schema_version  integer     not null default 1,
  request_hash    bytea       not null,   -- canonical-form hash, computed on the device
  response_body   jsonb,                  -- replayed verbatim on duplicate; pruned at 90 days
  client_wall_at  timestamptz,            -- device clock; untrusted, forensics only
  received_at     timestamptz not null default transaction_timestamp(),
  check (origin = 'SERVER' or (device_id is not null and user_id is not null)),
  primary key (tenant_id, id)             -- per tenant, never global (ADR-0005)
);

comment on table app.write_log is
  'The one write registry. id IS the per-tenant idempotency key; hlc is server-stamped; claimed_hlc is the untrusted device assertion.';

select app.apply_tenant_rls('app.write_log');

-- The registry itself is append-only: a unit of work happened or it did not.
revoke update, delete on app.write_log from app_user;
create trigger write_log_append_only
  before update or delete on app.write_log
  for each row execute function app.forbid_mutation();
