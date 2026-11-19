# infra/ — the local sync stack

The Phase 1 dev environment for offline sync: Postgres 16 with logical
replication, and a self-hosted [PowerSync](https://docs.powersync.com/) service
(open edition) whose **sync rules are the tenant isolation boundary**
(`docs/architecture/sections/03-offline-sync.md` §3.2).

> **Production** lives beside it and is documented in `docs/production-runbook.md`:
> `docker/` (api, powersync, web images), `fly/` (the three Fly apps, the production
> PowerSync config, `secrets.example`), `supabase/roles.sql`, and
> `scripts/release-smoke.sh` (the release path against a real Postgres 16, run by CI).
> The sync rules are ONE file for both: `powersync/sync_rules.yaml`, baked into the
> production image. The publication's table list has ONE home too:
> `packages/ops/src/converge.ts` — extend it there when the rules grow (a test fails
> if you don't).

## What runs where

| Thing | Where | Notes |
|---|---|---|
| Postgres 16 (`postgres:16-alpine`) | `localhost:5433` | db `erp`, user `erp`, password `erp_dev` (dev only). `wal_level=logical`. **Not** the host's Postgres 14 on 5432. In-network name: `postgres:5432`. |
| PowerSync service (`journeyapps/powersync-service:1.24.0`) | `http://localhost:8080` | Download-only: uploads NEVER go through it — every client write goes to the API's `app.write_log` pipeline. Health: `GET /probes/liveness`. |
| PowerSync bucket storage | `powersync_storage` database, same dev cluster | Postgres storage backend (no MongoDB container). The service owns a `powersync` schema inside that database. |
| API dev server | `http://localhost:3001` | Wired by the API integration step; documented here because tokens it issues are what the service validates. |

> **Docker daemon on this dev machine:** Docker Desktop 4.67.0 crash-loops on
> this macOS build (backend dies in "opening tray: starting electron"). The
> working daemon is **colima** (`brew install colima; colima start --cpu 4
> --memory 6 --vm-type vz`; docker context `colima`). Same `docker` /
> `docker compose` CLI; nothing in this directory depends on which daemon runs.
> After a reboot, run `colima start` before `pnpm stack:up`.

## Bring-up / teardown

Always via the repo root scripts (they derive `PS_JWT_K` and order the steps —
PowerSync needs the publication that the bootstrap creates):

```sh
pnpm stack:up      # postgres (healthy) → migrate + publication + seed → powersync (healthy)
pnpm stack:down    # stop containers, keep data
pnpm stack:reset   # down -v (wipe volume) → full up: identical state every time
pnpm stack:bootstrap  # re-run just the idempotent db bootstrap
```

`stack:up` is idempotent; `stack:reset` is the clean-slate path and recreates
the same two tenants with the same ids.

## Auth contract

**Production path (02-security §2.2, §2.7).** A device enrols with a one-time
code (back office → Devices), a person signs in through the identity provider
(provider-generic OIDC), and the API mints an ES256 sync token — `aud
"erp-sync"`, 5 minutes, claims `tid`, `sub`, `did` — which PowerSync verifies
against the API's public keys at `PS_JWKS_URI` (`/.well-known/jwks.json`).

**Dev path.** One HS256 secret — env `DEV_JWT_SECRET`, default
`dev-secret-change-me` — shared by `pnpm dev:token` bearers and the service's
`client_auth` (`aud "powersync"`). `infra/scripts/stack.mjs` derives
`PS_JWT_K = base64url(DEV_JWT_SECRET)`; never set it by hand. The production
PowerSync config carries no `oct` key.

**Either way, every bucket is keyed on `did` + `sub` + `tid` through
`app.device_sync_grant` / `app.device_sync_location_scope` (migration 0024).**
A token whose device is not an ACTIVE row in `app.device`, with a ceiling the
user's scope meets, downloads nothing. `pnpm dev:token` therefore enrols a dev
device per location (placeholder key — the HS256 path has no proof of
possession) and mints with `dev: <device id>`; the drills enrol theirs in
`ServerDb.enrolDevice`.

**Dev identity provider.** `pnpm dev:idp` runs a minimal OIDC provider on
:9400 (no passwords — pick a dev principal). Start the API with
`OIDC_ISSUER=http://localhost:9400 OIDC_CLIENT_ID=erp-pwa-dev` and leave
`VITE_API_TOKEN` empty in the PWA to exercise enrolment → sign-in → PIN.

## Seeded tenants — `infra/dev-tenants.json`

| | id | slug | seeded with |
|---|---|---|---|
| Tenant A | `01911111-1111-7111-8111-111111111111` | `agyasei-jnr` | "Construction materials distribution — Ghana" template + tenant #1's 25-outlet network |
| Tenant B | `01922222-2222-7222-8222-222222222222` | `kumasi-builders` | same template + one hand-seeded location (`MAIN`) |

Both are applied as `app_user` under RLS through the write spine (SERVER-origin
`app.write_log` rows) — the same one write path production uses. Ids are fixed
so `stack:reset` reproduces them exactly.

## Files

- `docker-compose.yml` — the two services, healthchecks, named volume `erp_pg_data`.
- `postgres/init/01-powersync-roles.sql` — first-boot-only: `powersync_repl`
  (replication + snapshot reads), `powersync_storage` role + database.
- `powersync/config.yaml` — replication connection, Postgres bucket storage,
  `client_auth` (inline HS256 JWKS, audience `powersync`), port 8080.
- `powersync/sync_rules.yaml` — **the isolation boundary.** Tenant-first bucket
  definitions; every data query on tenant-owned tables repeats the tenant
  predicate. Review changes like production code (§3.9: two people, CI-gated).
- `scripts/stack.mjs` — up/down/reset driver.
- `scripts/bootstrap.ts` — idempotent migrate + grants + publication + seeds + dev principals
  + dev prices.
- `scripts/dev-prices.ts` — a price for every sellable product, because templates seed price
  list structure and deliberately no prices. Dev fixtures, never tenant data.
- `dev-tenants.json` — generated by the bootstrap; safe to commit (dev ids).

## Verifying the stack

```sh
docker compose -f infra/docker-compose.yml ps            # both healthy
curl -fsS http://localhost:8080/probes/liveness          # 200
psql postgresql://erp:erp_dev@localhost:5433/erp \
  -c "select slot_name, active from pg_replication_slots;"   # powersync-… active=t
docker compose -f infra/docker-compose.yml logs powersync | grep -i "sync rules"
```

An unauthenticated `POST http://localhost:8080/sync/stream` returns 401; with a
valid dev token (HS256, aud `powersync`, `tid` claim) it streams checkpoints.

## Known deviations from §3.2.3 (all fail closed; fix-forward list)

1. **CLOSED by migration 0024 — location scope is table-driven.** Every
   parameter query reads `app.device_sync_grant` or
   `app.device_sync_location_scope`, the trigger-maintained intersection of
   the user's scope and the device's ceiling over ACTIVE devices. A
   future-dated lapse is swept by `app.refresh_sync_scope_all()`, which the
   production package schedules (02 §2.5 says every 60 s).
2. **Credit book: RESOLVED, with one part still empty.** §3.2.2's
   `tenant_credit` and `location_credit_allowance` buckets now exist and are
   gated on the DATABASE, not on a claim. The permission tables landed in 0005
   as VIEWS, and a view cannot be published to logical replication — so
   migration 0013 adds two trigger-maintained projections of them
   (`app.credit_sync_book_scope` for `credit.view`,
   `app.credit_sync_location_scope` for `sale.record.credit` ∩ location scope)
   and the parameter queries read those. Revoking a grant empties the device on
   the next sync. Still empty: `app.credit_allowance` itself — a row exists only
   where a §6.7 cap LEASE exists, and the lease machinery is not built, so the
   counter bucket ships gated and carrying nothing. Remaining hole: a grant
   whose `effective_to` is a future instant lapses with no DML, so
   `app.refresh_credit_sync_scope_all()` must run on the nightly job.
3. **`sale_line`/`sale_tax_line` are tenant-scoped, not location-scoped.**
   §3.11.10 requires denormalised `(tenant_id, location_id)` on both tables so
   they can join `location_ops` (a sync-rules data query cannot join). That
   migration hasn't landed; until it does they sync in
   `tenant_sale_lines_interim` — tenant isolation fully intact, location
   narrowing pending.
4. **No per-row windowing job yet.** `stock_movement.archived_at` is honoured
   by the rules, but the nightly archiver that sets it (§3.2.4) is not built.
   Dev data volumes make this moot locally.
5. **Replication user is dev-grade.** `powersync_repl` has BYPASSRLS +
   SELECT on `app`/`platform` (required by PowerSync for snapshots). Fine in
   compose; production gets a managed secret and network policy.
