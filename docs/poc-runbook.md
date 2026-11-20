# POC runbook — the whole stack on free tiers, with a demo company

**Owner: the founder.** Written 20 November 2026 for a zero-budget proof of concept. Every step
that needs an account or a password is yours; everything else is in the repository on branch
`poc/free-tier`.

> **Demo data only.** No free database here has point-in-time recovery, so this environment
> cannot meet "a sale is never lost" (CLAUDE.md §2.2; 09 §9.5 RPO ≤ 5 min). It must never hold
> tenant #1's real trading. The demo company is never activated: its Ghana tax rates stay
> unconfirmed (§2.8, Q8), and `poc:setup` refuses any database holding an active tenant.

## Deviation record (CLAUDE.md §4)

This environment departs from ADR-0003 A2 (Supabase + Fly.io, London) for one reason: there is no
hosting budget (founder, 20 November 2026), and Fly.io has had no free tier for new accounts since
October 2024. **The production plan is unchanged** — `docs/production-runbook.md`, `infra/fly/` and
the self-hosted PowerSync image are untouched and remain the go-live path.

| Piece                     | Production (ADR-0003 A2)                                 | This POC                                                                     | What is given up                                                                                                     |
| ------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Postgres                  | Supabase London, Small compute, **PITR**                 | Supabase **Free**                                                            | PITR and backups; 500 MB; pauses after 7 idle days                                                                   |
| Sync service              | Self-hosted PowerSync on Fly, rules baked into the image | **PowerSync Cloud Free**                                                     | Rules deployed by paste, not by image; 50 concurrent devices; instance removed after 7 days with no device connected |
| API + worker + migrations | Fly: `api` ×2, `worker` ×1, `release_command`            | **One Render Free container** (`combined.js`)                                | Sleeps after 15 idle min (kept awake by an uptime check); one instance; a worker crash restarts the API too          |
| PWA                       | nginx on Fly                                             | **Render static site**                                                       | `release.json` is a build file, not runtime-set                                                                      |
| Region                    | London                                                   | Supabase London · Render **Frankfurt** (Render has no London) · PowerSync EU | ~15 ms between API and database                                                                                      |
| Sign-in                   | Managed OIDC, EU                                         | **Zitadel Cloud Free** (100 daily active users)                              | —                                                                                                                    |

The tenant isolation boundary is the same file in both: `infra/powersync/sync_rules.yaml`, pasted
whole into PowerSync Cloud, plus the same RLS and the same roles.

---

## 0. Before you start

Push the branch so Render can build it: `git push -u origin poc/free-tier`.

Keep every password, key and connection string in a password manager. None goes into the
repository, a chat, or a shell history (where a command needs one, it is read with `read -rs`).

The hostnames below assume Render gives you `erp-poc-api.onrender.com` and
`erp-poc-web.onrender.com`. If it adds a suffix, use what it gives you everywhere.

## 1. Supabase — the database

1. Use a project in **London** (`eu-west-2`). Note its **project ref** and the database password you

   set at creation (that is the `postgres` user's).
2. **SQL editor** → paste all of `infra/supabase/roles.sql` → Run. It creates the roles and stops

   with an error if any has more privilege than the isolation model allows. (Skip its last comment
    block about `powersync_storage` — PowerSync Cloud keeps its own storage.)
3. **Passwords**, from your Mac — psql hashes them locally, so the plaintext never reaches the server.

   Copy the **Session pooler** host from Supabase's _Connect_ dialog (`aws-…pooler.supabase.com`):
4. **Database settings → SSL** → download the certificate. Save it outside the repo, e.g.

   `~/erp-poc/supabase-ca.crt`.
5. Your four connection strings (the pooler is IPv4, so Render and your Mac can both reach it):

| Name                   | User             | Host : port                                       |
| ---------------------- | ---------------- | ------------------------------------------------- |
| `DATABASE_URL`         | `erp_api.<ref>`  | `<pooler-host>:6543` (transaction)                |
| `MIGRATE_DATABASE_URL` | `postgres.<ref>` | `<pooler-host>:5432` (session)                    |
| `JOBS_DATABASE_URL`    | `erp_jobs.<ref>` | `<pooler-host>:5432` (session)                    |
| PowerSync (step 6)     | `powersync_repl` | `db.<ref>.supabase.co:5432` — the **direct** host |

Each is `postgresql://<user>:<password>@<host>:<port>/postgres`, with **no** `sslmode` parameter
(TLS is set by `DATABASE_SSL_MODE=verify-full` and the certificate).

## 2. Zitadel — sign-in

1. **Projects → Create** "ERP POC" → **New application** → type **User Agent**, authentication

   **PKCE**.
    Redirect URI `https://agyasei-erp-web.onrender.com/auth/callback`; post-logout URI
    `https://agyasei-erp-web.onrender.com/`. Note the **Client ID**.
2. **Issuer**: open `https://<your-instance-domain>/.well-known/openid-configuration` and copy

   `issuer` exactly — that string is `OIDC_ISSUER`.
3. **Signing algorithm.** The API accepts ES256 and EdDSA by default (02-security §2.2). Open

   `https://<your-instance-domain>/oauth/v2/keys`: if the active key says `"alg":"ES256"`, you are
    done. If it says `RS256`, either create and activate an **ECDSA P-256 web key** in Zitadel
    (wait 5 minutes after creating it before activating), or — **POC only** — add
    `OIDC_ID_TOKEN_ALGS=RS256` to the API on Render. That is a deviation from §2.2 and must not
    reach production.
4. **Users →** your user → copy its **User ID**. That is your `sub`, used in step 8.

## 3. Identity keys

From the repository:

```sh
node infra/scripts/gen-identity-keys.mjs signing-2026-11   # → ERP_SIGNING_JWKS
node infra/scripts/gen-identity-keys.mjs lease-2026-11     # → ERP_LEASE_JWKS
```

Each prints one line of JSON — a private key. Paste each straight into Render (step 5) and your
password manager; don't save it as a file in the repo.

## 4. PowerSync — create the instance (connect it later)

Create a project and an instance in an **EU** region. Copy the **instance URL**
(`https://<id>.powersync.journeyapps.com`) — that is `POWERSYNC_URL` / `VITE_POWERSYNC_URL`. Don't
connect the database yet: its publication is created by the API's first deploy.

## 5. Render — the API and the app

**New → Blueprint** → connect the GitHub repository → branch `poc/free-tier`. Render reads
`render.yaml` and asks for each value marked `sync: false`:

| Service     | Variable                                                    | Value                                                         |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| erp-poc-api | `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `JOBS_DATABASE_URL` | step 1.5                                                      |
|             | `DATABASE_CA_CERT`                                          | the certificate's whole text (Render takes multi-line values) |
|             | `POWERSYNC_URL`                                             | step 4                                                        |
|             | `CORS_ORIGINS`                                              | `https://erp-poc-web.onrender.com`                            |
|             | `ERP_TOKEN_ISSUER`                                          | `https://erp-poc-api.onrender.com/`                           |
|             | `ERP_PUBLIC_URL`                                            | `https://erp-poc-api.onrender.com` (no trailing slash)        |
|             | `ERP_SIGNING_JWKS`, `ERP_LEASE_JWKS`                        | step 3                                                        |
|             | `OIDC_ISSUER`, `OIDC_CLIENT_ID`                             | step 2                                                        |
| erp-poc-web | `VITE_API_URL`                                              | `https://erp-poc-api.onrender.com`                            |
|             | `VITE_POWERSYNC_URL`                                        | step 4                                                        |

The API's first deploy migrates the empty database, converges the grants and creates the
`powersync` publication; a failed migration fails the deploy before anything serves. **Done when**
`https://erp-poc-api.onrender.com/readyz` answers `{"ready":true}`.

## 6. PowerSync — connect, authenticate, deploy the rules (the IPv6 test)

1. **Database connection:** host `db.<ref>.supabase.co`, port `5432`, database `postgres`, user

   `powersync_repl` and its password, SSL **verify-full** (PowerSync already trusts Supabase's CA).
    Press **Test connection**.
    _If this fails, stop here._ A free Supabase project's direct host is IPv6-only; PowerSync
    publishes an IPv6 range, but its docs don't promise this case. The fallback is a different free
    Postgres reachable over IPv4 — a decision to take together, not to improvise.
2. **Client auth:** JWKS URI `https://erp-poc-api.onrender.com/.well-known/jwks.json`; audience

   `erp-sync`. If a "Supabase Auth" option is offered, leave it **off**.
3. **Sync rules:** paste the **whole** of `infra/powersync/sync_rules.yaml`, validate, deploy. Do not

   edit it in the dashboard — it is the tenant isolation boundary (03 §3.2), reviewed by two people
    (§3.9). A change is made in the repository and pasted again.
4. **Done when** the instance shows replication active (initial snapshot complete).

## 7. Keep it awake, and know when it breaks

1. **UptimeRobot** (free): an HTTP monitor on `https://erp-poc-api.onrender.com/readyz` every

   5 minutes. It keeps the free container from sleeping (it sleeps after 15 idle minutes, and the
    first request then waits about a minute) and tells you when the API is down.
2. **healthchecks.io** (free): a check with period 5 min, grace 10 min. Add its ping URL to the API

   on Render as `JOBS_HEARTBEAT_URL`. It is the only thing that notices if the worker dies.
3. _Optional:_ a Slack incoming-webhook URL as `ALERT_WEBHOOK_URL` — the alert body's `text` field

   is Slack's format.

## 8. Create the demo company and bring its first device online

From your Mac, in the repository:

```sh
read -rs PGPASS   # the postgres password; nothing is echoed or saved
export MIGRATE_DATABASE_URL="postgresql://postgres.<ref>:$PGPASS@<pooler-host>:5432/postgres"
export DATABASE_CA_CERT_FILE=~/erp-poc/supabase-ca.crt
export OIDC_ISSUER='<exactly as in step 2.2>'
export POC_ADMIN_SUBJECT='<your Zitadel user ID>'
export POC_ADMIN_NAME='<your name>'
pnpm poc:setup
```

It creates **Demo Building Supplies Ltd** (rename with `POC_COMPANY_NAME`): the construction
template, three demo outlets (Main Store, Depot, Roadside Shop), demo prices, the unreviewed draft
chart of accounts, and **you** as its first administrator. It prints a **first-device enrolment
code**, valid for **15 minutes**.

Within those 15 minutes: open `https://erp-poc-web.onrender.com` on the laptop or tablet, type the
code under **Enrolment code**, then sign in with your Zitadel account.

- **Missed the 15 minutes?** Run `pnpm poc:setup` again. Until a device has enrolled, the same
founder gets a fresh code and the old one is cancelled. After that it refuses: from then on,
codes come from the app.
- **To show that two companies can't see each other** (Phase 1 acceptance #5), also set
`POC_SECOND_ADMIN_SUBJECT` to a second Zitadel user's ID: a second company, _Second Demo
Traders Ltd_, gets its own founder and code.
- The first device is homed at Main Store by default. `POC_FIRST_DEVICE_AT=head-office` homes it
nowhere instead: it syncs nothing and works online, like a back-office laptop.

Then, in the app, as that administrator: **Devices** → issue codes for each tablet (pick its
outlet); **People** → add staff, linked to their Zitadel user IDs; load opening stock; trade.

## 9. Living with the free tiers

- **Weekly:** open the app on at least one device. PowerSync Free removes an instance that no device
has connected to for 7 days. Re-creating it (step 4 and step 6) costs every device a full re-sync —
not data: buckets are rebuilt from Postgres, and writes go through the API, never PowerSync.
- **If PowerSync is removed or disconnected for good,** its replication slot keeps WAL on a small free
disk, and Supabase makes a full database read-only. `ops.sync_health` pages at 256 MB retained
(`SLOT_RETAINED_GIB=0.25`). To release it: SQL editor →
`select slot_name, active from pg_replication_slots;` →
`select pg_drop_replication_slot('<the inactive powersync slot>');`.
- **Render's 750 free hours** cover one always-on service. Keep `erp-poc-api` the only free web
service on the account (static sites don't count).
- **Supabase pauses** a free project after 7 days without activity; the worker queries it every
minute, which should count — if the project is ever paused, restore it from the dashboard.

## 10. Taking it down

Delete the Render services, the PowerSync instance and the Supabase project. Nothing else holds
data. Devices keep their local copy until the app is uninstalled or the site data is cleared.
