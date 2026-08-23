# Running locally

Verified end to end on 21 Aug 2026 — every command below was run against this tree.

## Prerequisites

Node ≥ 20 (tested on 25.2.1) · pnpm 9 · Docker Desktop **running**.

```bash
pnpm install
```

---

## Two modes

**Local-only** — the PWA with zero backend. Fastest way to look at the counter UI, and an honest
offline rehearsal: same local schema, same outbox, dev seed data. No Docker needed.

**Full stack** — Postgres + PowerSync + API + PWA, with real sync. Needed for anything touching
sync, tenancy, tax or credit.

---

## Local-only (one command)

```bash
pnpm dev:web
```

Open http://localhost:5173. With `apps/web/.env.local` absent, the app runs local-only by design.

---

## Full stack

### 1. Start the infrastructure

```bash
pnpm stack:up
```

Postgres 16 (`wal_level=logical`) on **:5433** — *not* the host's Postgres 14 on 5432 — and the
self-hosted PowerSync service on **:8080**. Both healthchecked; the command waits for healthy.

First run also migrates, creates the replication publication and seeds two tenants:

| Tenant | Slug | Purpose |
|---|---|---|
| A | `agyasei-jnr` | Agyasei Jnr & Company Limited — 25 locations, 219 SKUs |
| B | `kumasi-builders` | Kumasi Builders Supply Ltd — the second tenant isolation is proven against |

To wipe and reseed from nothing: `pnpm stack:reset`.

### 2. Start the API

```bash
pnpm dev:api
```

Fastify on **http://localhost:3001**. Runs bare on documented defaults — see `apps/api/env.example`
if you need to override `DATABASE_URL`, `API_PORT` or `DEV_JWT_SECRET`.

### 3. Point the web app at it

The PWA needs a dev bearer token. Mint one and write the env file:

```bash
pnpm dev:token --env > apps/web/.env.local
```

Then:

```bash
pnpm dev:web
```

http://localhost:5173 now syncs: downloads stream from PowerSync, and checkout writes drain through
`POST /sync/upload`, completing only on a per-key server ack.

### What a working till looks like

On first load the device provisions itself and then shows the counter. If it stops on a full-screen
setup message instead, that message names which of the three questions is unanswered — where this
device is, which price list it sells from, what it prices in — and none of them is a guess the app
is allowed to make (`apps/web/src/data/session/`). Expect, for tenant A at `OUT-01`:

| | |
|---|---|
| Location | `OUT-01 Techiman Flagship`, from the token's `locs` claim |
| Price list | `RETAIL` — the tenant's own lowest-priority list covering this counter today |
| Currency | `GH₵`, 2 minor digits — read from the jurisdiction pack, never assumed |
| Catalogue | 219 products, priced, searchable by name, category or local alias |

The prices are **dev fixtures** seeded by the bootstrap, not tenant data: a template seeds price
list structure and deliberately no prices, so a freshly-bootstrapped stack has a catalogue nothing
can be rung from. See `infra/scripts/dev-prices.ts`. It supplies prices and **nothing else**: the
counter list ships tax-INCLUSIVE and stays that way, so the dev stack runs the same price-list
configuration a real tenant does and a shelf price is de-grossed at the till and on the server.

---

## The dev token

```bash
pnpm dev:token                       # tenant A, Techiman Flagship, outlet_manager
pnpm dev:token --tenant B            # the second tenant
pnpm dev:token --location OUT-03     # a different outlet (OUT-01 … OUT-25)
pnpm dev:token --role outlet_staff   # lower privilege
pnpm dev:token --env                 # ready-to-paste .env.local
```

Prints the token on **stdout** and context on stderr, so `$(pnpm -s dev:token)` captures cleanly.

**Dev only.** HS256, signed with `DEV_JWT_SECRET` (default `dev-secret-change-me`) — the same
secret the PowerSync service validates against. The API exchanges it at `GET /sync/token` for a
short-lived PowerSync client token. Tenant identity (`tid`) always comes from the verified token,
never from the client. Never commit a minted token; `.env.local` is gitignored.

To see the exchange:

```bash
curl -s -H "Authorization: Bearer $(pnpm -s dev:token)" http://localhost:3001/sync/token
```

Returns `{token, expires_at, endpoint}`. Without the header it returns **401** — the isolation
boundary starts here.

---

## Ports

| Service | Port | Health |
|---|---|---|
| Web (Vite) | 5173 | http://localhost:5173 |
| API (Fastify) | 3001 | `GET /sync/token` → 401 unauthenticated |
| PowerSync | 8080 | `GET /probes/liveness` → 200 |
| Postgres | 5433 | `pg_isready -h localhost -p 5433 -U erp` |

---

## Tests and drills

```bash
pnpm test                              # 388 tests, 39 files, all packages
pnpm lint:money                        # ADR-0004 enforcement
pnpm --filter @erp/sync-drills drill   # the 7 acceptance drills (needs the stack up)
pnpm --filter @erp/wire-conformance drill:live   # D6 alone: the PWA's own payload, live
```

The drills start their own devices and are the proof behind
[`sync-drill-report.md`](sync-drill-report.md) — real partitions, real per-device SQLite, nothing
mocked.

**D1–D5 are evidence about the sync path, not the client path.** Their payloads come from the
drills' own helpers and their transport is a Node client with no browser origin, which is how both
the CORS bug and the sale-payload bug passed a green 5/5. D6 and `packages/wire-conformance` drive
`apps/web`'s real code instead — see `docs/phase1-status.md` §0.

---

## Troubleshooting

**`required variable PS_JWT_K is missing`** — you ran `docker compose` directly. Use `pnpm stack:up`;
the wrapper derives service env from `DEV_JWT_SECRET`.

**`UNAUTHORIZED: missing or invalid bearer token`** — the token expired (12h default) or was minted
against a different `DEV_JWT_SECRET`. Mint a fresh one.

**API cannot reach Postgres** — you may be hitting the host's Postgres 14 on 5432. The stack is on
**5433**. Check `docker ps` shows both containers healthy.

**Web shows no data** — with no `.env.local` that is correct (local-only mode). For sync mode,
confirm all three `VITE_` values are set and the API is up.

**A till that refuses because its price list "uses prices that already include tax"** — this no
longer happens, and if you see it you are on a build from before 2026-08-23. Tax-inclusive shelf
prices are de-grossed at the till (`apps/web/src/data/pricing/`) and on the server
(`apps/api/src/tax.ts`), against the jurisdiction pack's declared composition. The bootstrap no
longer flips the counter list to tax-exclusive either — the dev stack runs the same configuration
a real tenant does. `pnpm --filter @erp/wire-conformance drill:inclusive` proves it end to end.

**A till stuck on "still receiving its price lists"** — that gate clears itself when the tenant's
`price_list` rows arrive, so a device that sits on it forever is not downloading. Historically the
cause was local: builds before this fix ran the dev seed against the synced tables in sync mode,
which parks a row in PowerSync's write queue, and its sync core will not apply ANY downloaded
checkpoint while that queue is non-empty. The current build seeds no synced table in sync mode,
empties a stray queue if it finds one, and clears the synced half of a device that an older build
already froze — all on the next load, keeping the outbox. Watch the browser console for `[sync]`
lines. If the gate persists, check the stream itself reaches the device: the service is up
(`curl localhost:8080/probes/liveness`) and `GET /sync/token` returns a token.

**Stale or odd data** — `pnpm stack:reset` rebuilds from nothing.
