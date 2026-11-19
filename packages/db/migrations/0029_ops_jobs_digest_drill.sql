-- ============================================================================
-- 0029_ops_jobs_digest_drill.sql — production operations bookkeeping.
--
-- Four tables the go-live work package needs and nothing else in the schema
-- provides (docs/production-runbook.md; 09-infrastructure §9.4, §9.5):
--
--   platform.job_run        one row per scheduled-job attempt — the scheduler's
--                           memory (when did this job last succeed?) and the
--                           audit trail of every unattended thing the platform
--                           did. Summaries carry COUNTS AND IDS ONLY.
--   platform.ops_alert      open/resolved state per alert key, so a standing
--                           problem pages once and then repeats on a schedule,
--                           and its resolution is announced — rather than
--                           re-paging every fifteen minutes until the pager is
--                           muted.
--   platform.restore_drill  §9.5's drill record, verbatim in intent: a drill
--                           that is not written down did not happen, and a
--                           scratch copy of every tenant's books that is not
--                           recorded as destroyed is still alive (§9.2).
--   app.table_digest        Requirement 9.5-A: per tenant, per table — row
--                           count and digests — INSIDE the backup, so a
--                           restored cluster carries its own record of what it
--                           used to contain.
--
-- Platform tables here hold no tenant business data: a job summary or an
-- alert names a tenant by id and says how many, never what. They are still
-- revoked from app_user explicitly, because 0001's default privileges grant
-- SELECT on every platform table to the application role and no tenant-facing
-- path has any business reading the operator's job history.
--
-- Every migration touching `platform` gets a named human reviewer (09 §9.3.2).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- platform.job_run
-- ----------------------------------------------------------------------------
create table platform.job_run (
  id          uuid        primary key,
  job_name    text        not null check (job_name ~ '^[a-z][a-z0-9_.]{0,63}$'),
  status      text        not null check (status in
                ('running',     -- in flight (or the runner died: see 'abandoned')
                 'succeeded',   -- ran, found nothing that needs a human
                 'degraded',    -- ran to completion AND found something that does
                 'failed',      -- threw; the error column says what
                 'abandoned')), -- a 'running' row whose runner is gone, closed by
                                -- the next runner to take the job's lock
  started_at  timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  duration_ms integer     check (duration_ms is null or duration_ms >= 0),
  -- Which process ran it (Fly machine id / hostname) and which build. Build
  -- provenance for jobs is the same argument as Requirement 9.8-A for writes:
  -- "what did release X do unattended?" must be a query.
  runner      text        not null,
  build       text,
  -- COUNTS AND IDS ONLY. Never a payload, never a name, never an amount.
  summary     jsonb       not null default '{}'::jsonb,
  error       text,
  constraint job_run_finished_pair check ((status = 'running') = (finished_at is null))
);

create index job_run_name_started_ix on platform.job_run (job_name, started_at desc);

comment on table platform.job_run is
  'One row per scheduled-job attempt (docs/production-runbook.md). The due-scheduler reads it; summaries carry counts and tenant ids only, never tenant data.';

-- ----------------------------------------------------------------------------
-- platform.ops_alert
-- ----------------------------------------------------------------------------
create table platform.ops_alert (
  key           text        primary key,          -- e.g. 'dark_device:<tenant>:<device>'
  source_job    text        not null,
  kind          text        not null,
  severity      text        not null check (severity in ('page', 'ticket')),
  -- WHICH tenant the alert is ABOUT — not the tenant that owns the row. This
  -- is operator telemetry: app_user holds no privilege on it at all, and the
  -- writer (erp_jobs) is deliberately NOBYPASSRLS, so the canonical tenant
  -- policy would silently stop alerting. The column is therefore not named
  -- tenant_id: in this schema that name means "owned by, and RLS-forced on"
  -- (packages/db/test/conformance.test.ts rule 12), and nothing is exempt.
  subject_tenant_id uuid    references platform.tenant (id),
  summary       text        not null,             -- ids and counts only
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at  timestamptz not null default clock_timestamp(),
  last_sent_at  timestamptz,
  send_count    integer     not null default 0 check (send_count >= 0),
  resolved_at   timestamptz
);

create index ops_alert_open_ix on platform.ops_alert (source_job) where resolved_at is null;

comment on table platform.ops_alert is
  'Alert lifecycle per key: first seen, last sent, resolved. Lets a standing problem page once and repeat on a schedule instead of every evaluation.';

-- ----------------------------------------------------------------------------
-- platform.restore_drill — 09 §9.5, with the method and manifest recorded.
-- ----------------------------------------------------------------------------
create table platform.restore_drill (
  id                             uuid        primary key,
  ran_at                         timestamptz not null,
  operator                       text        not null,
  method                         text        not null check (method in ('logical_dump', 'pitr')),
  restore_target                 timestamptz not null,  -- dump snapshot time / PITR target
  source_manifest_sha256         text,                  -- the manifest the restore was compared against
  rto_server_seconds             integer     not null check (rto_server_seconds >= 0),
  rto_fleet_seconds              integer     check (rto_fleet_seconds is null or rto_fleet_seconds >= 0),
  catalogue_assertion_passed     boolean     not null,
  digests_matched                boolean     not null,
  trial_balance_matched_tenants  uuid[]      not null,
  trial_balance_failed_tenants   uuid[]      not null,
  slot_and_sync_reinit_exercised boolean     not null default false,
  sequence_fastforward_exercised boolean     not null default false,
  scratch_destroyed_at           timestamptz,
  notes                          text
);

create index restore_drill_ran_at_ix on platform.restore_drill (ran_at desc);

comment on table platform.restore_drill is
  '09 §9.5. Newest row older than 100 days is a control failure; a scratch_destroyed_at that stays NULL past 72 hours pages (§9.2).';

revoke all on platform.job_run       from app_user;
revoke all on platform.ops_alert     from app_user;
revoke all on platform.restore_drill from app_user;

-- ----------------------------------------------------------------------------
-- app.table_digest — Requirement 9.5-A.
--
-- Tenant-derived, so it lives in `app` under forced RLS like every other row
-- computed from a tenant's data; the digest job writes it AS app_user inside
-- the tenant's own context, so it can only ever digest — and record — what
-- that tenant can see.
--
-- SERVER-DERIVED, NEVER SYNCED: no device authors a digest and no sync rule
-- names this table, so it carries no write spine (WRITE_ID_EXEMPT, the same
-- category as the ledger and the credit projections).
--
-- The digests are ORDER-INDEPENDENT multiset hashes: four 32-bit lanes of
-- md5(row image), each summed. Computable in one streaming pass with O(1)
-- memory over any table size, identical however the rows are physically
-- ordered — which is exactly what a restore changes. Not adversarially
-- collision-resistant, and not meant to be: this detects corruption and
-- loss, it does not authenticate.
-- ----------------------------------------------------------------------------
create table app.table_digest (
  tenant_id   uuid        not null references platform.tenant (id),
  id          uuid        not null,
  as_of       timestamptz not null,
  table_name  text        not null check (table_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  row_count   bigint      not null check (row_count >= 0),
  pk_digest   text        not null,
  row_digest  text        not null,
  job_run_id  uuid,
  created_at  timestamptz not null default transaction_timestamp(),
  updated_at  timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, id)
);

create index table_digest_lookup_ix on app.table_digest (tenant_id, table_name, as_of desc);

select app.apply_tenant_rls('app.table_digest');

comment on table app.table_digest is
  'Requirement 9.5-A: per-tenant, per-table row count and order-independent digests, recorded by the scheduled digest job. Inside the backup by design. Server-derived; never synced.';
