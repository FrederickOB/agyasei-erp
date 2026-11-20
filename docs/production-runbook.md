# Production runbook — provisioning, deploy, jobs, monitoring, backups, rollback

**Owner: the founder** (every provisioning step starts with an account or a payment only you can
make). **Status: written 18 November 2026; nothing provisioned.** Go-live: 1 January 2027.

Implements `09-infrastructure-and-rollout.md` §9.1–§9.9 on the stack chosen in `ADR-0003`
amendment A2: **Supabase (London, `eu-west-2`) for Postgres; Fly.io (London, `lhr`) for the API,
the scheduled-job worker, the PowerSync sync service (its own app) and the PWA.**

> **The latency trade-off, stated (§9.1).** No major cloud has a West Africa region. London is
> roughly 90–130 ms from Accra on a fixed line and **150–300 ms from an outlet on mobile data**.
> That lands on sync convergence and HQ reporting freshness, **never on the counter**: a sale is
> written to the device's own database with no network on its path. Data residency (Q13) can still
> invalidate any EU choice.

---

## 0. What runs where, and three decisions

| Piece | Where | Image / command | Credential |
|---|---|---|---|
| Postgres (the books) | Supabase project, London, **PITR on** | — | `postgres` = the migrator |
| API | Fly app `…-api`, process `api`, ≥ 2 machines | `infra/docker/api.Dockerfile` → `node dist/bin/main.js` | `erp_api` via the **transaction pooler** |
| Migrations | Fly `release_command` (before every API deploy) | same image → `node dist/bin/migrate.js` | `postgres`, **direct** |
| Scheduled jobs | Fly app `…-api`, process `worker`, **1 machine** | same image → `node dist/bin/jobs.js loop` | `erp_jobs` |
| Sync service | Fly app `…-powersync`, 1 machine | `infra/docker/powersync.Dockerfile` (pinned digest, sync rules baked in) | `powersync_repl` **direct**; `powersync_storage` |
| PowerSync bucket storage | database `powersync_storage` in the **same** Supabase project | — | `powersync_storage` |
| PWA | Fly app `…-web` | `infra/docker/web.Dockerfile` (nginx, unprivileged) | none |

**Bucket storage: a separate database in the same Supabase project.** Zero extra vendors, zero
extra cost, same backups, ~1 ms from the sync service. The cost: storage writes share the books'
CPU, disk and WAL. At pilot volume that is noise. **Move it** (a second Supabase project, or Fly
Managed Postgres) when the second tenant goes live, when storage WAL shows up in the slot-lag
alerts, or when the database CPU passes 50 % at trading peak. Moving it is a full re-replication
and a fleet re-download (≤ 30 MB per device, §9.6) — do it in a maintenance window, announced.
Rejected for now: a second Supabase project (≈ doubles the database bill for derived data that can
be rebuilt) and Fly Postgres (another operator surface to patch and back up, for the same).

**Build: an esbuild bundle, not `tsc`.** The workspace packages export TypeScript source; a `tsc`
build would need every package to grow a `dist/` and dual exports. esbuild is already in the graph,
type checking stays `tsc --noEmit` in CI, and the runtime image is Node plus four files plus the
migrations — no `node_modules`, no pnpm, no source.

**Scheduler: a `worker` process in the API app, scheduling from the database.** Not Fly scheduled
machines: those are created once with an image and are **not** updated by `fly deploy`, so the
jobs would silently drift from the schema they run against; and their finest cadence is hourly.
The worker wakes every minute, asks `platform.job_run` what is due, runs each job under its own
advisory lock, records the outcome, and pings an external heartbeat (the monitor's own monitor).

---

## 1. Provisioning, in order

Each step names what proves it is done. Do not skip ahead: step 6's verification is what turns
"Supabase passes §9.1" from an assumption into a fact.

### 1.1 Supabase project
1. Create the project in **London (`eu-west-2`)**. Compute **Small or larger** (PITR requires it).
2. **Enable the PITR add-on.** Daily backups are not enough (§9.5: RPO ≤ 5 min). Retention
   **7 days at launch, 30 days from Phase 3** when the GL becomes the system of record.
3. Database settings → **download the SSL certificate** (Supabase's own CA). It becomes the
   `DATABASE_CA_CERT` / `PS_PG_CA_CERT` secret; TLS is verified, never merely encrypted.
4. Note the **direct** host (`db.<ref>.supabase.co:5432`) and the **pooler** host
   (`aws-0-eu-west-2.pooler.supabase.com`, port **6543** = transaction mode, **5432** = session).
   The direct host is **IPv6-only** unless the IPv4 add-on is bought: check from a Fly machine in
   step 1.4 (`fly ssh console -a …-api -C "nc -zv6 db.<ref>.supabase.co 5432"`). The sync service
   **must** use the direct host (logical replication does not pass through the pooler); if IPv6
   fails, buy the IPv4 add-on.

### 1.2 Roles (once; re-runnable)
1. In the SQL editor, run **`infra/supabase/roles.sql`**. It creates `app_user`, `erp_api`,
   `erp_jobs`, `erp_operator`, `powersync_repl`, `powersync_storage`, sets session timeouts, and
   **stops with an error** if any role has more privilege than the isolation model allows.
2. Then, **each on its own** (not as one script — `CREATE DATABASE` refuses a transaction):
   ```sql
   create database powersync_storage;
   grant connect, create on database powersync_storage to powersync_storage;
   ```
3. Set passwords **from psql**, which hashes them client-side so the plaintext never reaches the
   server or its logs: `psql "<direct URL as postgres>"` then `\password erp_api`, and the same for
   `erp_jobs`, `powersync_repl`, `powersync_storage` (and `erp_operator` only when needed). Use
   generated passwords (`openssl rand -base64 32`), stored in a password manager, nowhere else.

Table grants are **not** a provisioning step: every `db:migrate` converges them (and the
PowerSync publication) after migrating, so privileges never lag the schema.

### 1.3 Connection strings

| Secret | Role | Host : port | Mode |
|---|---|---|---|
| `MIGRATE_DATABASE_URL` | `postgres` | direct `:5432` (or session pooler `:5432`) | session — DDL, locks |
| `DATABASE_URL` | `erp_api.<ref>` | pooler `:6543` | **transaction** — `SET LOCAL` verified in 1.6 |
| `JOBS_DATABASE_URL` | `erp_jobs.<ref>` | pooler `:5432` | session (transaction also works) |
| `OPERATOR_DATABASE_URL` | `erp_operator.<ref>` | pooler `:6543` | **set only while provisioning a tenant** |
| `PS_DATA_SOURCE_URI` | `powersync_repl` | **direct** `:5432`, db `postgres` | replication |
| `PS_STORAGE_URI` | `powersync_storage` | **direct** `:5432`, db `powersync_storage` | — |

Pooler usernames carry the project ref (`erp_api.<ref>`); direct ones do not. Never put
`sslmode` in these URLs — TLS is set by `DATABASE_SSL_MODE` / the PowerSync config.

### 1.4 Fly apps
```sh
fly apps create <name>-api        # then put the names into infra/fly/*.toml (app = …)
fly apps create <name>-powersync
fly apps create <name>-web
```
Set `POWERSYNC_URL` and `CORS_ORIGINS` in `infra/fly/api.toml` and `CSP_CONNECT_SRC` in
`infra/fly/web.toml` to the real hostnames (`fly certs add` for custom domains).

### 1.5 Secrets, then deploy — API first, then sync, then web
Set the secrets in §2, then from the **repository root**:
```sh
fly deploy . --config infra/fly/api.toml --dockerfile infra/docker/api.Dockerfile \
  --build-arg ERP_BUILD=$(git rev-parse --short HEAD)
fly scale count api=2 worker=1 --config infra/fly/api.toml
fly deploy . --config infra/fly/powersync.toml --dockerfile infra/docker/powersync.Dockerfile
fly deploy . --config infra/fly/web.toml --dockerfile infra/docker/web.Dockerfile \
  --build-arg VITE_API_URL=https://<api host> --build-arg VITE_POWERSYNC_URL=https://<sync host> \
  --build-arg BUILD_ID=$(git rev-parse --short HEAD)
```
The API deploy's `release_command` migrates the empty database, converges grants and **creates
the `powersync` publication** — which is why it goes first: the sync service needs the publication.

### 1.6 Verify every §9.1 filter
From a checkout, with the direct and pooler URLs in your environment (never on the command line):
```sh
pnpm install --frozen-lockfile && pnpm --filter @erp/api build
MIGRATE_DATABASE_URL=… API_DATABASE_URL=… JOBS_DATABASE_URL=… \
POWERSYNC_REPLICATION_URL=… POWERSYNC_STORAGE_URL=… \
DATABASE_SSL_MODE=verify-full DATABASE_CA_CERT="$(cat prod-ca-2021.crt)" \
SUPABASE_ACCESS_TOKEN=… SUPABASE_PROJECT_REF=… \
  node apps/api/dist/bin/ops.js verify
```
Every line must be `PASS`, except `MANUAL` lines, which you resolve **and write into §9 below**.
What it checks: TLS; Postgres ≥ 15; `wal_level = logical`, free slots, and that `powersync_repl`
can **create and drop a real logical slot**; the publication; no application role is superuser
or `bypassrls`; as `app_user` with no tenant, row security is active and **zero rows are visible**;
`SET LOCAL ROLE` and the tenant GUC **hold inside, and do not survive, 12 concurrent pooled
transactions**; `pg_stat_statements`; `auto_explain` (WARN if unreadable); migrations at head with
checksums; the §1.3 catalogue assertion; PITR and region via the Supabase management API; the
storage database is separate. **MANUAL, always:** a written RTO from Supabase, and log export.

The same checks run in CI on every PR against a real Postgres 16 with a non-superuser migrator
(`infra/scripts/release-smoke.sh`).

### 1.7 Alerting — before any device is enrolled
1. **`ALERT_WEBHOOK_URL`** — any endpoint that accepts a JSON POST: the body has a `text` line per
   alert (chat-webhook compatible) and a structured `alerts` array (for routing by severity). Your
   choice of SMS gateway / email relay / paging service sits behind it. Alerts carry ids and counts,
   never names or amounts.
2. **`JOBS_HEARTBEAT_URL`** — a dead-man's switch (healthchecks.io, Better Stack heartbeats, …)
   expecting a ping **every 5 minutes** (the worker pings every minute; allow 10 minutes' grace).
   It is the only thing that notices if the worker itself dies.
3. **Prove it** (§9.7.1 Stage 0: "confirmed by an actual test message"): `fly ssh console -a
   …-api -C "node dist/bin/jobs.js run ops.sync_health"` — before the sync service holds its slot
   this pages `replication_slot_missing`. Confirm the page arrived on the phone that will carry it.

### 1.8 First restore drill
Stage 0 requires a restore drill passed within 30 days of the first sale. §7 below.

### 1.9 Provisioning tenant #1
Set `OPERATOR_DATABASE_URL` (give `erp_operator` a password first), deploy, provision through the
operator plane, then **unset it and redeploy** — the operator plane is off in normal running.
Activation stays blocked until every tax rate in force is confirmed by a practitioner (`CLAUDE.md`
§2.8; Q8).

---

## 2. Secrets

`fly secrets set NAME=value -a <app>` — or, to keep values out of shell history,
`fly secrets import -a <app>` reading `NAME=value` lines from a file you delete afterwards.
Multi-line PEM: either import it, or replace newlines with `\n` (the apps restore them).

| Secret | App | What | Rotation |
|---|---|---|---|
| `DATABASE_URL` | api | `erp_api` via transaction pooler | 90 days (§9.9) |
| `MIGRATE_DATABASE_URL` | api | `postgres`, direct — used by `release_command` only | 90 days |
| `JOBS_DATABASE_URL` | api | `erp_jobs` | 90 days |
| `OPERATOR_DATABASE_URL` | api | `erp_operator` — **only while provisioning** | unset after use |
| `DATABASE_CA_CERT` | api | Supabase CA (PEM) | when Supabase rotates it |
| `ERP_TOKEN_ISSUER` | api | our token `iss`, e.g. `https://<api app>.fly.dev/` (exact match) | — |
| `ERP_PUBLIC_URL` | api | the API's public base URL (DPoP `htu`); required behind Fly's proxy | — |
| `ERP_SIGNING_JWKS` | api | PRIVATE ES256 JWKS for access and sync tokens: `node infra/scripts/gen-identity-keys.mjs signing-YYYY-MM`. First key signs, all verify; public halves served at `/.well-known/jwks.json` | new key first, old key kept until its tokens expire (15 min) |
| `ERP_LEASE_JWKS` | api | PRIVATE ES256 JWKS for the offline lease — a **separate** ring (refused if it shares a kid) | annually, two-key overlap (02 §2.7) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | api | the managed OIDC provider (ADR-0003 A4): public client, PKCE, redirect `https://<pwa>/auth/callback`, CORS allowed on its token endpoint | with the provider |
| `ALERT_WEBHOOK_URL` | api | alert sink | as the provider requires |
| `JOBS_HEARTBEAT_URL` | api | dead-man's switch | — |
| `PS_DATA_SOURCE_URI` | powersync | `powersync_repl`, **direct** | 90 days |
| `PS_STORAGE_URI` | powersync | `powersync_storage`, direct | 90 days |
| `PS_PG_CA_CERT` | powersync | Supabase CA (PEM) | — |
| `PS_JWKS_URI` | powersync | `https://<api app>.fly.dev/.well-known/jwks.json` — the PUBLIC URL (`block_local_jwks` stays on, so a Fly-private address is refused) | — |
| `PS_ADMIN_API_TOKEN` | powersync | diagnostics API token, ≥ 32 random chars | 90 days |

**There is no shared secret in production.** The HS256 dev path (`DEV_JWT_SECRET`, the static
`VITE_API_TOKEN`) exists only outside `NODE_ENV=production`; with it set, the API refuses to start,
and without the four identity values above it refuses too — the release smoke checks both.
`RATE_LIMIT_PATHS` defaults to `/sync/token,/auth,/enrol`, which covers sign-in, refresh and
enrolment. Scope refresh runs every 60 s (`sync.scope_refresh`).

**Never in the repository, never in CI.** CI holds no production secret and deploys nothing; a
stolen CI token is worth nothing against production.

---

## 3. Deploying a change

1. **Merge to `main` only when CI is green** (typecheck, the three mandatory test categories, both
   lints, the build, the real-Postgres release smoke, the three images).
2. **API**: `fly deploy` as in 1.5. The `release_command` migrates first; **any refusal aborts the
   deploy with the old machines serving.** It refuses when: an applied migration file was edited
   (checksum); the database holds migrations this build does not know (see §4 Case C); two
   branches have both migrated (never unlockable); another deploy holds the migration lock for
   over five minutes. Every DDL statement runs with `lock_timeout = 3s` and is retried with backoff
   rather than queueing behind a report and stalling every tenant (§9.3.2).
3. New machines must pass `/readyz` (database reachable, every migration this build expects
   applied) before taking traffic.
4. **Sync service** only when its image changed. A **sync-rules change is a fleet-wide bucket
   rebuild** (Rule 9.3-D): never in the same deploy as a schema change; batched into the
   maintenance window (21:00–23:00 UTC for tenant #1, §9.3.5); byte cost announced first.
5. **Web**: every web deploy is **fleet-wide** (see §4 Case A). Devices activate it at their next
   safe point (cart empty, no sale in flight).

The rules that are never bent: **expand → migrate → contract**, one phase per release; a schema
change and the client change that depends on it never ship together (Rule 9.3-B); a contraction
only after drainage is proven by query (Rule 9.3-C) — which needs `app.device_sync_state`, not yet
built, so **no contraction may ship before it is**.

---

## 4. Rollback (§9.8) — for someone stressed

**Triggers.** Automatic (roll back first, tell people after): **R1** money is wrong · **R2** a
write is lost · **R3** another tenant's data is visible. Judgement: **R4** a counter cannot trade
for 15 min · **R5** sync stopped platform-wide or the review queue grows for 2 h · **R6** a credit
limit fails open. **Who decides: the engineer on call, alone, now.** The founder may call it any
time. Anything else is a defect: fix forward.

**First five minutes, every time:**
1. **Tell the outlet to switch to the paper receipt book.** Cash continues; credit only within the
   per-customer cap, otherwise phone Accounts.
2. **Do not wipe, reset or re-enrol any device.** The pending writes may be the only copy.
3. **Write down the time and the running versions:** `fly releases -a …-api`, `-a …-powersync`,
   `-a …-web`.

**Case A — the web client.** Redeploy the previous web image:
`fly releases -a …-web --image` → `fly deploy --image <previous image ref> --config infra/fly/web.toml`.
`/release.json` names that image's build, so devices move to it at their next safe point; their
local data and pending writes are untouched. To **hold** the fleet on what it runs while you
decide, `fly secrets set RELEASE_BUILD_ID=<build devices run now> -a …-web` (fleet-wide — per-ring
pinning, Requirement 9.7-A, is not built).

**Case B — the API, no migration in the bad release.**
`fly deploy --image <previous api image ref> --config infra/fly/api.toml`. The release step finds
nothing to apply and passes. Roll the sync service back **only if implicated** — it may re-key
buckets and cost every device a re-sync. Watch `ops.sync_health` and the upload error rate return
to normal.

**Case C — a migration was applied.** If it was an **expand** (added objects only), the previous
API tolerates it by design. Redeploy the previous image **with the decision recorded**:
`fly deploy --image <previous> --config infra/fly/api.toml --env ERP_MIGRATE_ALLOW_DB_AHEAD=true`
(the migrator otherwise refuses: "database is AHEAD of this build"). Leave the added object in
place until the next window. If it was a **contraction**, you cannot un-drop a column: go to §7.4
(restore to scratch and re-import through the write path, or a full PITR restore).

**Writes made on the bad version.** Writes that reached the server stay; anything computed wrong
is corrected by a **reversing entry, never an in-place update**. Finding them: `app.write_log`
rows with `received_at` inside the bad release's window (from `fly releases`). The per-write
`client_build`/`server_build` columns (Requirement 9.8-A) are **not built** — until they are,
the time window is the only provenance, and it is coarse.

**Afterwards:** incident record now, blameless write-up in 48 h, the pilot's 14-day clocks restart,
the fix ships through the normal sequence.

---

## 5. Scheduled jobs

| Job | Every | Does | Alerts |
|---|---|---|---|
| `ledger.posting_sweep` | 1 h | settled sales → journal entries, as a fixed system actor; tenants with no ledger calendar skipped | failures via `job_failed`; open exceptions via `sync_health` |
| `sync.scope_refresh` | 60 s | recomputes the credit and device sync-scope projections per tenant, so a grant that lapsed with no DML — or a retired device — leaves the sync gate within a minute (02 §2.5; phase2-gate §5.2 D8) | `job_failed` |
| `ops.table_digest` | 1 h | §9.5-A digests of money/credit tables into `app.table_digest` (35-day retention) | `job_failed` |
| `ops.table_digest_full` | 1 day | §9.5-A digests of every tenant table | `job_failed` |
| `ops.lost_write_control` | 1 day | every receipt number a device reports issuing must be on a sale the server holds | **page** `lost_writes` |
| `ops.sync_health` | 15 min | the §9.4 signals below | see §6 |

- **By hand:** `fly ssh console -a …-api -C "node dist/bin/jobs.js run <job>"` — same lock as the
  worker, so it never double-runs. `node dist/bin/jobs.js list` shows the registry.
- **History:** `select job_name, status, started_at, duration_ms, summary, error from
  platform.job_run order by started_at desc limit 50;` Summaries are counts and tenant ids.
- **Adding a job** (e.g. the identity package's sync-scope refresh): `defineJob` from `@erp/ops`,
  added to the array in `apps/api/src/jobs.ts`. Idempotent; tenant data only through
  `ctx.runner.withTenant`; counts and ids out. Its lock, bookkeeping, failure alert and staleness
  monitoring come with registration.
- **A failed job pages once** and announces itself resolved when it next succeeds. A job that has
  not succeeded for three intervals pages `job_stale`. A dead worker stops the heartbeat.

---

## 6. Monitoring (§9.4) — what is measured, honestly

`fly ssh console -a …-api -C "node dist/bin/ops.js signals"` prints the live snapshot and the
alerts it would raise. Cross-tenant output is the operator's view (ids and counts, assembled from
per-tenant reads under RLS) — it is never served to a tenant and has no public endpoint.

| §9.4 signal | Status | Pages? |
|---|---|---|
| Replication slot lag / WAL retained | **Built** (`pg_replication_slots`): missing slot pages; > 2 GiB retained pages; no consumer is a ticket | Yes |
| Sync lag per device ("dark device") | **Proxy**: last *accepted write* per device from `app.write_log`, measured in **trading time** (platform default Mon–Sat 07:00–19:00, each location's own timezone). Quiet outside trading hours, never resolved by nightfall | Yes, in trading hours |
| Connected but not draining | **Absent** — needs `app.device_sync_state` (not built) | — |
| Lost-write reconciliation | **Proxy**: `app.device_write_watermark` **does not exist** and devices do not report write counts. The daily control reconciles each device's reported receipt-number high-water mark (`app.sequence_block.consumed_upto`) against the sales the server holds. Catches a lost or rejected *sale*; blind to writes that consume no number | Yes |
| Human review queue | **Built**: severity-1 pages; past-escalation > 24 h and depth > 25 are tickets | Sev-1 |
| Posting exceptions | **Built**: open > 24 h is a ticket (a period cannot close over them) | Ticket |
| Drill recency / scratch lifetime | **Built**: no drill or > 100 days is a ticket; scratch alive > 72 h pages | Scratch |
| Job staleness / worker death | **Built**: `job_stale` pages; heartbeat stops if the worker dies | Yes |
| Failed sync attempts by reason, version spread, per-tenant query cost, bytes per outlet | **Absent** (need device telemetry / statement tagging) | — |

Thresholds are environment variables on the API app (`packages/ops/src/config.ts`), platform
defaults until the tenant-owned `app.location_sync_expectation` exists. **Alerts route to one
webhook** (yours); §9.4's per-tenant routing to the tenant's own ops contact needs that table too.

---

## 7. Backups and restore drills (§9.5)

### 7.1 Backups
- **Operational backup = Supabase PITR** (RPO minutes). Nothing to run; it must be **on** (1.6
  checks it).
- **Logical dump = a second, provider-independent copy**, and the cheapest complete drill:
  ```sh
  PG_BIN_DIR=/opt/homebrew/opt/postgresql@17/bin   # pg_dump >= the server's major version
  BACKUP_DATABASE_URL="<postgres, direct>" DATABASE_SSL_MODE=verify-full DATABASE_CA_CERT="…" \
    node apps/api/dist/bin/ops.js backup --out ./backups
  ```
  It opens one `REPEATABLE READ` snapshot, computes the **manifest** inside it — per tenant, under
  that tenant's RLS: every table's row count and digests, and the trial balance by account and
  location in minor units — then runs `pg_dump --snapshot` of schemas `app`, `platform`, `erp_meta`
  on that same snapshot. Output: `erp-<time>.dump` + `erp-<time>.manifest.json`, mode 0600.
- **Where it may live:** encrypted object storage with a retention lock (30 days), in the EU.
  **Never** a laptop's Downloads folder, a chat attachment, or a CI artefact: it is every tenant's
  books. Delete local copies after upload.
- **Statutory archive is not this** (§9.5): the per-tenant export to immutable storage is the
  `compliance-gatekeeper`'s retention rule and is not built.

### 7.2 Restore drill — quarterly, and before the pilot's Stage 0
```sh
SCRATCH_ADMIN_URL="<maintenance URL on a SCRATCH server>" RECORD_DATABASE_URL="<postgres, prod>" \
  node apps/api/dist/bin/ops.js drill --manifest backups/erp-<time>.manifest.json \
  --started-at "<when you decided to start>" --record --operator "<your name>"
```
It verifies the dump's checksum, restores into a **new** `erp_drill_<stamp>` database (never over
anything), runs the §1.3 catalogue assertion, recomputes the manifest per tenant and compares it
**exactly** — catalogue, migrations, platform counts, every tenant's per-table counts and digests,
every tenant's trial balance to the minor unit — stops the RTO-server stopwatch, **drops the
scratch database**, and records the drill in `platform.restore_drill`. Exit 0 only if everything
matched. A scratch server is production-tier (§9.2): a separate Supabase project or a locked-down
local Postgres ≥ the source's major version; never staging, never shared.

Rehearsed locally on 18 November 2026 against a Postgres 16 with a non-superuser migrator:
two tenants matched, recorded, scratch destroyed; a deliberately tampered manifest **failed**,
naming tenant, table and counts. CI's manual `drills` workflow repeats it against the dev stack.

**Not exercised by this drill** (§9.5 step 6 — do them by hand on the first full drill, with the
sync service and a test device pointed at scratch, and record them): re-creating the replication
slot, re-initialising the sync service, and the sequence-counter fast-forward.

### 7.3 Point-in-time restore (a real incident)
Follow §9.5's eight steps. Concretely here:
1. **Decide; start the stopwatch; announce a sync pause.** Counters keep trading offline.
2. **Supabase → Database → Backups → PITR**: restore to time T (in place, or to a new project and
   repoint secrets).
3. **The sync service's storage is now AHEAD of the database — treat it as corrupt.** Stop it
   (`fly scale count 0 -a …-powersync`), empty `powersync_storage` (`drop schema powersync cascade`
   as `powersync_storage`), drop the old slot if it survived (`select pg_drop_replication_slot(…)`),
   then `fly scale count 1`: it re-snapshots and rebuilds every bucket. **Fleet-wide re-download.**
4. **Fast-forward the sequence counters before accepting any write** (§9.5 step 4). **NOT
   AUTOMATED** — a manual, reviewed SQL procedure per (tenant, location, key) is required and does
   not exist yet. Skipping it risks duplicate statutory invoice numbers.
5. `node dist/bin/migrate.js` (expect "nothing to apply"), `ops.js verify`, then compare each
   tenant's trial balance as at T (`trialBalanceLines(tx, T)` in `@erp/ops`) with the last good
   figures.
6. Forced re-upload window, staggered — needs client support (devices keep their write log 35
   days, §9.5) that the PWA does not yet implement. **Gap.**
7. Work the conflict storm as its own batch. 8. Resume; publish RTO-server and RTO-fleet.

### 7.4 One tenant's data, without rewinding everyone
Restore to scratch (7.2 with `--keep`), extract that tenant's rows, re-import **through the normal
write path** with deterministic write ids, verify the tenant's trial balance, **drop scratch and
record `scratch_destroyed_at`**.

---

## 8. What you must do by hand — the checklist

- [ ] Supabase project in London, Small+ compute, **PITR add-on on**, CA certificate downloaded.
- [ ] Decide IPv4 add-on after testing IPv6 from Fly (1.1 step 4).
- [ ] Run `infra/supabase/roles.sql`; create `powersync_storage`; set passwords with `\password`.
- [ ] Create three Fly apps in `lhr`; put names and hostnames into `infra/fly/*.toml`; commit.
- [ ] Set every secret in §2 (identity placeholders once that package lands).
- [ ] Deploy API → sync → web; `fly scale count api=2 worker=1`.
- [ ] Run `ops.js verify` — all PASS; resolve every MANUAL and record it in §9.
- [ ] Choose and configure the alert webhook and the heartbeat; prove a page reaches the phone.
- [ ] Choose encrypted EU object storage for logical dumps; take the first dump; **pass the first
      restore drill** (Stage 0) and record it.
- [ ] Ask Supabase support for the **RTO in writing**.
- [ ] Field-trial the CSP (report-only) on the real tablets, then enforce it.
- [ ] Turn on GitHub branch protection: `ci / workspace` and `ci / images` required on `main`.

---

## 9. Provider facts — fill in at provisioning (MANUAL items from `ops.js verify`)

| Fact | Value | Source / date |
|---|---|---|
| Supabase plan and compute size | | |
| PITR enabled, retention | | |
| **RTO (zone failure / failover), in writing** | | |
| Region | `eu-west-2` expected | |
| Direct-host IPv6 from Fly works / IPv4 add-on bought | | |
| Postgres log export: where | | |
| `auto_explain` available | | |
| Fly app names and hostnames | | |

---

## 10. Known gaps (each is somebody's next work, not a footnote)

1. **`app.device_sync_state` / `app.device_write_watermark` do not exist.** Dark-device and
   lost-write monitoring run on proxies (§6); "connected but not draining" is unmonitored; the
   contraction gate (Rule 9.3-C) cannot be evaluated, so **no contraction may ship**.
2. **Per-ring release pinning (Requirement 9.7-A) is not built**: every web release is fleet-wide;
   the flagship cannot run a build ahead of the micro-outlets yet. Required before outlet #2.
3. **Sequence-counter fast-forward after a PITR** (§9.5 step 4) has no tooling.
4. **Forced re-upload after a restore** needs device-side write-log retention (35 days).
5. **Build provenance on writes** (`write_log.client_build/server_build`, Requirement 9.8-A).
6. **Per-tenant query cost** (SQLCommenter tags + log export) and **per-tenant alert routing**.
7. **Identity**: the HS256 shared secrets are interim until the identity package lands.
8. **`-- non-transactional` migrations** (for `CREATE INDEX CONCURRENTLY`) are not supported by
   the runner; the first such migration must add it.
9. **Logical dumps are run by hand**; a scheduled dump-to-bucket job awaits the bucket choice.
10. **Request compression** for sync uploads (Rule 9.1-A(b)) is the sync layer's, not the edge's.
