-- ============================================================================
-- 0001_platform.sql — platform schema: tenant registry, database placement,
-- jurisdictions and tax packs.
--
-- Hand-written SQL is THE source of truth for the schema. The Drizzle
-- definitions in src/schema.ts MIRROR this DDL for typed queries; they never
-- generate it. (docs/architecture/sections/01 §1.3, 04 §4.2.)
--
-- `platform` holds data that is NOT tenant-owned. It is exempt, by this
-- explicit list, from the tenant pattern that governs everything in `app`:
--   tenant, tenant_database, jurisdiction, tax_code, tax_rate
-- Every migration touching `platform` is human-reviewed, because this is
-- where a mistake does not fail CI (§1 of 01-tenancy-and-isolation.md).
-- ============================================================================

create schema if not exists platform;
create schema if not exists app;

-- ----------------------------------------------------------------------------
-- Roles.
--
-- app_user is the ONLY role application code ever connects (or SET ROLEs) as.
-- It is nosuperuser and nobypassrls so that row-level security genuinely
-- applies to every query it runs — a superuser or table owner without FORCE
-- would bypass RLS silently (02-security §RLS). Migrations run as the
-- cluster's migration role (superuser in the test harness), which OWNS the
-- tables; FORCE ROW LEVEL SECURITY (applied per-table in later migrations)
-- keeps even the owner honest, and app_user is the belt on top of that.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end
$$;

grant usage on schema platform to app_user;
grant usage on schema app to app_user;

-- Application code may READ platform reference data (jurisdictions, tax
-- rates) but never write it: tenant lifecycle and pack publication are
-- operator paths, not application paths.
alter default privileges in schema platform grant select on tables to app_user;

-- App tables are readable and writable by app_user, ALWAYS through RLS.
-- Append-only tables additionally REVOKE update/delete after creation.
alter default privileges in schema app grant select, insert, update, delete on tables to app_user;

-- ----------------------------------------------------------------------------
-- Jurisdictions (ADR-0007).
--
-- The currency's minor-unit scale is stored as the DIVISOR ITSELF
-- (minor_units_per_major), not a power-of-ten exponent, and is NEVER assumed
-- to be 100 anywhere in code (CLAUDE.md §2.3; 07-jurisdiction §7.2.2 — the
-- ouguiya divides into 5 khoums).
-- ----------------------------------------------------------------------------
create table platform.jurisdiction (
  code                     text        primary key,      -- ISO 3166-1 alpha-2: 'GH'
  name                     text        not null,
  currency_code            char(3)     not null,         -- ISO 4217: 'GHS'
  currency_symbol          text        not null,         -- 'GH₵' — presentation ONLY (ADR-0004)
  minor_units_per_major    bigint      not null check (minor_units_per_major > 0),
  cash_rounding_unit_minor bigint      not null default 1 check (cash_rounding_unit_minor > 0),
  created_at               timestamptz not null default transaction_timestamp()
);

comment on column platform.jurisdiction.minor_units_per_major is
  'The divisor itself (GHS: 100), never an exponent and never assumed. CLAUDE.md §2.3 / ADR-0007.';

-- ----------------------------------------------------------------------------
-- The tenant registry, with lifecycle status (01-tenancy §1.1).
-- jurisdiction_code is set at provisioning and is not editable afterwards:
-- changing it would reprice history against a different tax table (ADR-0002).
-- ----------------------------------------------------------------------------
create table platform.tenant (
  id                uuid        primary key,              -- uuidv7, server-generated
  slug              text        not null unique,          -- 'agyasei-jnr'; URLs, export filenames
  legal_name        text        not null,
  status            text        not null default 'provisioning'
                    check (status in ('provisioning','active','suspended','migrating',
                                      'offboarding','offboarded','abandoned')),
  jurisdiction_code text        not null references platform.jurisdiction (code),
  created_at        timestamptz not null default transaction_timestamp(),
  activated_at      timestamptz,
  suspended_at      timestamptz,
  offboarded_at     timestamptz,
  constraint tenant_active_has_activation
    check (status <> 'active' or activated_at is not null)
);

-- ----------------------------------------------------------------------------
-- Tenant → database placement (ADR-0005): a lookup from day one, even though
-- every tenant currently resolves to the same cluster. dsn_ref is a POINTER
-- INTO THE SECRET STORE, never a DSN. This indirection is what makes
-- promoting a tenant to a dedicated database a scheduled migration rather
-- than a re-architecture.
-- ----------------------------------------------------------------------------
create table platform.tenant_database (
  tenant_id        uuid        primary key references platform.tenant (id),
  dsn_ref          text        not null,
  sync_service_ref text        not null,
  moved_at         timestamptz not null default transaction_timestamp()
);

comment on column platform.tenant_database.dsn_ref is
  'Pointer into the secret store, never a connection string.';

-- ----------------------------------------------------------------------------
-- Tax codes and effective-dated rates (ADR-0002, ADR-0007, 07-jurisdiction §7.2).
--
-- A historical transaction ALWAYS reprices against the rate row in force on
-- its business date: resolve with  effective @> business_date.
-- Rows are never edited in place; a change of law is a new row whose
-- effective range abuts the old one.
-- ----------------------------------------------------------------------------
create table platform.tax_code (
  jurisdiction_code text not null references platform.jurisdiction (code),
  code              text not null,              -- 'GH.VAT.STD', 'GH.NHIL', 'GH.GETFUND', 'GH.COVID'
  name              text not null,
  input_deductible  boolean not null default false,
  primary key (jurisdiction_code, code)
);

create table platform.tax_rate (
  id                uuid      primary key default gen_random_uuid(),
  jurisdiction_code text      not null,
  tax_code          text      not null,
  rate_bp           integer   not null check (rate_bp between 0 and 1000000),
  -- base_kind semantics (07-jurisdiction §7.2.4):
  --   'net'      — the component applies to the net line amount;
  --   'net_plus' — it applies to net PLUS the components named in
  --                base_includes (Ghana pre-2026: VAT on net + NHIL + GETFund + COVID).
  base_kind         text      not null check (base_kind in ('net', 'net_plus')),
  base_includes     text[]    not null default '{}',
  rounding_level    text      not null check (rounding_level in ('line', 'document')),
  rounding_mode     text      not null check (rounding_mode in ('half_up', 'half_even', 'down')),
  effective         daterange not null,
  legal_reference   text      not null,       -- 'Value Added Tax Act, 2025 (Act 1151), s.3'
  -- The §2.8 gate, in the schema: Phase 1 go-live for a tenant is blocked on
  -- every rate row that tenant will use having a non-null confirmed_by
  -- (a qualified local professional). NULL = [UNCONFIRMED].
  confirmed_by      text,
  confirmed_at      timestamptz,
  constraint tax_rate_confirmation_pairs check ((confirmed_by is null) = (confirmed_at is null)),
  constraint tax_rate_base_includes_shape check
    (base_kind = 'net_plus' or base_includes = '{}'),
  foreign key (jurisdiction_code, tax_code)
    references platform.tax_code (jurisdiction_code, code)
);

create index tax_rate_lookup on platform.tax_rate (jurisdiction_code, tax_code);

-- Overlapping effective ranges for the same (jurisdiction, tax_code) would
-- make "the rate in force on date D" ambiguous — the one thing this table
-- exists to answer. The architecture sketch uses EXCLUDE USING gist with
-- btree_gist; a constraint trigger enforces the same invariant without a
-- contrib extension so the hermetic PGlite harness (and any minimal cluster)
-- runs the identical migration. Revisit if/when btree_gist is guaranteed.
create function platform.tax_rate_forbid_overlap() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from platform.tax_rate t
    where t.jurisdiction_code = new.jurisdiction_code
      and t.tax_code          = new.tax_code
      and t.id               <> new.id
      and t.effective        && new.effective
  ) then
    raise exception 'tax_rate: effective range % overlaps an existing row for (%, %)',
      new.effective, new.jurisdiction_code, new.tax_code
      using errcode = 'exclusion_violation';
  end if;
  return new;
end
$$;

create constraint trigger tax_rate_no_overlap
  after insert or update on platform.tax_rate
  for each row execute function platform.tax_rate_forbid_overlap();
