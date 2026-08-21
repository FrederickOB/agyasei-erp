-- Runs ONCE, at first init of the erp_pg_data volume, as the erp superuser.
-- Dev-only passwords; they mirror infra/.env.example. Never reuse outside dev.
--
-- powersync_repl    — the PowerSync service's replication connection into the
--                     erp database. REPLICATION for the logical slot, BYPASSRLS
--                     for the initial table snapshot (per PowerSync docs).
--                     Its SELECT grants are applied by infra/scripts/bootstrap.ts
--                     AFTER migrations create the schemas.
-- powersync_storage — owner of the powersync_storage database, where the
--                     service keeps its sync-bucket state (its own `powersync`
--                     schema inside that database). Kept OUT of the erp
--                     database entirely.

create role powersync_repl with replication bypassrls login password 'powersync_dev';
create role powersync_storage with login password 'powersync_dev';
create database powersync_storage owner powersync_storage;
