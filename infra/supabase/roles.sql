-- ============================================================================
-- infra/supabase/roles.sql — the platform's login roles. IDEMPOTENT.
--
-- Run as the project's `postgres` role (Supabase SQL editor, or psql on the
-- DIRECT connection). Safe to re-run at any time: it creates what is missing
-- and re-asserts the attributes that matter on what exists.
--
-- NO PASSWORDS HERE. Set each one afterwards from psql with `\password <role>`
-- — psql hashes it (SCRAM) client-side, so the plaintext never reaches the
-- server, its logs, or this repository. docs/production-runbook.md §2.
--
-- Grants on tables are NOT here: `db:migrate` converges them after every
-- migration (packages/ops/src/converge.ts), so privileges never lag the
-- schema. This file only makes the roles exist with the right attributes.
--
--   app_user          NOLOGIN, NOBYPASSRLS — the role every tenant-data
--                     statement runs as (migration 0001 also creates it).
--   erp_api           the API, via the transaction pooler.
--   erp_jobs          the scheduled-job worker.
--   erp_operator      the API's operator plane (tenant lifecycle). Give it a
--                     password only while an operator needs it.
--   powersync_repl    the sync service's replication connection (DIRECT
--                     connection only — logical replication does not pass
--                     through the pooler). BYPASSRLS because its initial
--                     snapshot is a plain SELECT under forced RLS; the sync
--                     rules are the isolation boundary on the far side.
--   powersync_storage the sync service's bucket storage, in its own database.
-- ============================================================================

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'erp_api') then
    create role erp_api login noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'erp_jobs') then
    create role erp_jobs login noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'erp_operator') then
    create role erp_operator login noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'powersync_repl') then
    create role powersync_repl login replication bypassrls noinherit nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'powersync_storage') then
    create role powersync_storage login noinherit nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
  end if;
end
$roles$;

-- The attributes the isolation model depends on, CHECKED rather than
-- re-asserted: the project's `postgres` is not a superuser and may not even
-- restate NOSUPERUSER. A role that pre-existed with more privilege than it
-- should have stops this script here, by name.
do $check$
declare bad text;
begin
  select string_agg(rolname || case when rolsuper then ' (superuser)' else '' end
                            || case when rolbypassrls then ' (bypassrls)' else '' end
                            || case when rolinherit then ' (inherit)' else '' end, ', ')
    into bad
    from pg_roles
   where rolname in ('app_user', 'erp_api', 'erp_jobs', 'erp_operator', 'powersync_storage')
     and (rolsuper or rolbypassrls or rolinherit);
  if bad is not null then
    raise exception 'roles with more privilege than the isolation model allows: %. Recreate them.', bad;
  end if;
  select string_agg(rolname, ', ') into bad from pg_roles where rolname = 'app_user' and rolcanlogin;
  if bad is not null then
    raise exception 'app_user must be NOLOGIN';
  end if;
end
$check$;

-- Session defaults. A runaway statement or an abandoned transaction on a
-- pooled connection is bounded server-side, whatever the client forgets.
alter role erp_api      set statement_timeout = '30s';
alter role erp_api      set idle_in_transaction_session_timeout = '60s';
alter role erp_api      set lock_timeout = '10s';
alter role erp_operator set statement_timeout = '60s';
alter role erp_jobs     set statement_timeout = '15min';
alter role erp_jobs     set idle_in_transaction_session_timeout = '30min';

-- Membership: every login role that touches tenant data does so ONLY by
-- `SET LOCAL ROLE app_user` (NOINHERIT: no ambient privileges). The migrator
-- (whoever runs this — `postgres`) joins too, so the backup manifest can
-- compute each tenant's figures under that tenant's RLS. db:migrate also
-- converges these.
grant app_user to erp_api;
grant app_user to erp_jobs;
-- On Postgres 16+ the role that CREATED app_user holds ADMIN membership
-- WITHOUT the SET option, so it must grant itself SET explicitly; a plain
-- membership check would say "already a member" and SET ROLE would still fail.
do $self$
begin
  if current_setting('server_version_num')::int >= 160000 then
    if not pg_has_role(current_user, 'app_user', 'SET') then
      execute format('grant app_user to %I with set true', current_user);
    end if;
  elsif not pg_has_role(current_user, 'app_user', 'MEMBER') then
    execute format('grant app_user to %I', current_user);
  end if;
end
$self$;

-- The sync service's bucket storage lives in its OWN database — run these two
-- statements on their own, OUTSIDE a transaction (the SQL editor runs a
-- script as one transaction; CREATE DATABASE refuses that):
--
--   create database powersync_storage;
--   grant connect, create on database powersync_storage to powersync_storage;
