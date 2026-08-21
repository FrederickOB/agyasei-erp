# Phase 1 status — integration & QA report

**Date:** 2026-08-21 (clean-slate verification pass) · **Author:** QA engineer
**Verdict:** the whole workspace installs, builds, typechecks and passes — **234 tests, 30 files,
0 failures** — `tools/lint-money.mjs` is clean, and the Phase 1 sync stack now **reproduces from
nothing**: `pnpm stack:reset` (docker volume destroyed, migrations + seed from scratch) followed by
`pnpm --filter @erp/sync-drills drill` passes **5/5 drills against the real stack** — real
Postgres 16, real self-hosted PowerSync, real API, real `@powersync/node` devices with their own
sqlite files. Nothing mocked, run twice from a destroyed volume on the final tree.

Acceptance criteria **1, 2, 4 and 5 are now demonstrated, not asserted** — measured numbers in §5.
Criterion 3 remains tested-at-API-level with the Q4 human gate outstanding. This is still not a
Phase 1 sign-off: the remaining gaps are in §6, and the `product-manager` owns the gate decision.

---

## 1. What exists and works

### The dev sync stack (`infra/`) — reproducible from nothing
- **Postgres 16** (`postgres:16-alpine`, docker): `localhost:5433`, db `erp`, user `erp`,
  password `erp_dev` (dev only), `wal_level=logical`. Named volume; `pg_isready` healthcheck.
- **PowerSync service** (`journeyapps/powersync-service:1.24.0`, pinned, self-hosted open
  edition): `http://localhost:8080`, **download-only** — its `sync_rules.yaml` buckets are the
  tenant boundary; it never accepts an upload.
- **API dev server**: `http://localhost:3001` (`pnpm --filter @erp/api dev:stack`).
- **One dev HS256 secret** (`DEV_JWT_SECRET`, default `dev-secret-change-me`) shared by
  API-issued tokens and the service's JWT validation — the service's `PS_JWT_K` is derived
  (base64url) by `infra/scripts/stack.mjs`, never hand-typed. PowerSync client tokens: aud
  `powersync`, claim `tid` (tenant uuid) — sync rules read tid **from the token only**, never
  from client parameters. All documented in `env.example` files; no real secrets committed.
- `pnpm stack:up | stack:down | stack:reset` — reset is `down -v` → up (healthcheck-gated) →
  4 migrations → `powersync` publication (18 tables) → two dev tenants seeded from the
  construction-materials-gh template → PowerSync up.

### `packages/money` — 56 tests (4 files), build + typecheck clean
The platform's single money module (ADR-0004). `bigint` minor units with runtime
guards rejecting `number` on every monetary parameter; `CurrencySpec` supplied by
the jurisdiction pack (scale 0–4, **no assumed 100**, no built-in registry);
explicit `RoundingMode` on every call; one `divRound` site so every operation
rounds exactly once; largest-remainder `allocate` with a documented deterministic
tie rule.

- `arith` (19) — exact bigint identities, single-rounding property tests (fast-check)
- `allocate` (14) — allocations sum back to the original, remainder placement rules
- `format` (13) — parse/format round-trips at the presentation boundary only
- `golden-vat` (10) — golden-file VAT lines against hand-computed figures

### `packages/db` — 46 tests (5 files), typecheck clean
Schema source of truth. Four hand-written SQL migrations (Drizzle mirrors, never
generates); the test harness runs the **identical DDL** on hermetic PGlite
(a real Postgres in WASM), so RLS, constraints and triggers under test are the
real ones. The same migrations are what `stack:reset` applies to the real
Postgres 16 — one DDL, two harnesses.

- One write registry: `app.write_log`, idempotency key unique **per tenant**.
- Server-stamped HLC domain; client clock stored as untrusted `claimed_hlc`.
- Stock is an append-only movement ledger; on-hand is `SUM(qty_delta)`, derived.
- Money/qty/rate domains are `bigint` (`app.money_minor`, `app.qty`, `app.rate_e4`);
  fee rates `app.bp` (integer basis points).
- Effective-dated `platform.tax_rate` with `base_kind` semantics and an
  overlap-forbidding constraint.
- Every app table is defined through the `tenantTable()` factory (18 tables +
  `write_log` explicitly registered): `tenant_id`, UUIDv7 `id`, write-spine FK,
  HLC and soft-delete columns are injected structurally — omitting them is
  impossible, not a convention.

- `conformance` (6) — interrogates `pg_catalog` on the migrated schema: every app
  table has `tenant_id`, RLS **enabled and forced**, a tenant-leading PK, the
  write spine; database and mirror registry must agree exactly
- `isolation` (10) — second tenant provisioned; its rows are absent from every
  read path under the first tenant's RLS context
- `write-log` (7) — idempotent replay, per-tenant key scoping, HLC stamping
- `tax` (8) — effective-dated repricing at regime boundaries
- `seed` (15) — the "Construction materials distribution — Ghana" template applies
  as ordinary editable rows (ADR-0006); templates never seed prices

### `apps/api` — 44 tests (8 files), typecheck clean
Fastify + tRPC write path, now with the sync seam wired. Verified-token identity
(`tid` is the **only** source of tenant identity; roles are opaque tenant-defined
strings, never branched on), one idempotent pipeline over `app.write_log` with
server-stamped HLC, tax engine honouring `base_kind`/`base_includes`, five tRPC
routers (provisioning, catalogue, sales, inventory, credit), and two plain
Fastify sync routes beside the tRPC mount (`src/sync.ts`):

- `GET /sync/token` — exchanges the API bearer for a short-lived PowerSync client
  token (aud `powersync`, `tid` from the **verified** session — never a request field)
- `POST /sync/upload` — bearer = API JWT; ops dispatch to the EXISTING tRPC
  mutations, so every upload flows through the same idempotent `write_log`
  pipeline. The sync service itself is download-only; this is the one write path.

The Q8 seam is marked in `src/routers/sales.ts` and the migrations: sale capture
and tax computation exist; **no** invoice issuance/clearance fields.

- `write-pipeline` (3) / `idempotency` (5) — same key + same payload replays the
  stored response; same key + different payload is rejected; keys scoped per tenant
- `credit` (14) — exposure is Σ(entries) (derived, API ≡ database), 30E/360
  fee accrual with delta posting and truncation forgone in the customer's favour,
  ageing buckets, and the Q4 gate: **accrual refuses to post until a human with
  the Accounts role confirms the five fee decisions** (fails loudly, previews
  labelled provisional)
- `tax-boundary` (4) — sales on either side of a rate boundary reprice against
  the row in force on their business date
- `money-property` (1 test, 16 random carts × multi-line) — Σ(line nets) − Σ(discounts)
  + Σ(tax components) === sale total as **exact bigint identity**, asserted in the
  response, in the stored rows, and response ≡ rows; seeded PRNG so failures reproduce
- `isolation` (6) — every router read path proven empty under a second tenant
- `sync-token` (5) — refuses unauthenticated calls; tid only from the verified session
- `sync-upload` (6) — ordered batch processing, per-op ack (`applied`/`duplicate`/
  rejection), idempotent replay through the one pipeline

### `apps/web` — 88 tests (13 files), build (Vite + PWA) + typecheck clean
Installable PWA shell and POS skeleton, now with the full sync connector
(`src/data/sync/`: `credentials.ts`, `upload.ts`, `transport.ts`, `runtime.ts`,
wired through `src/data/powersync.ts`). `fetchCredentials` exchanges the dev API
bearer at `GET /sync/token` for the short-lived PowerSync token (cached, refreshed
before expiry); `uploadData` drains the local-only outbox to `POST /sync/upload`
and completes a batch **only on a per-key server ack**. Local-only mode (no sync
env) still works with zero backend. Tests run the real SQL on real SQLite
(`node:sqlite`) built from the same schema definition, with fault injection
proving checkout is a single ACID transaction.

- `checkout` (6) · `sync-status` (10) · `search` (8) · `badges-and-quantities` (7)
- `ids-and-clocks` (7) · `version-gate` (6) · `status-bar` (3) · `money-display` (5)
- `sync-credentials` (7) · `sync-upload` (13) · `sync-transport` (6) · `sync-runtime` (6)
- `no-hardcoded-vocabulary` (4) — greps the built app for tenant #1 vocabulary
  used as logic

### `packages/sync-drills` — the executable acceptance demonstrations
`pnpm --filter @erp/sync-drills drill` runs the five Phase 1 drills against the
**real stack** (auto-spawns the API on :3001 if absent, tears it down after).
Each "device" is an `@powersync/node` client with its own sqlite file and its own
tokens; writes go solely outbox → `POST /sync/upload`; the drill connector
**throws** if a PowerSync crud batch ever appears (download-only, enforced).
Report: `docs/sync-drill-report.md`, regenerated every run. Typecheck clean; the
drills are the tests (hard assertions, non-zero exit on any failure).

### Cross-cutting checks performed at integration
- `node tools/lint-money.mjs` — clean (two annotated non-amount false positives
  in sync-drills, see §2).
- Grep sweeps beyond the lint: no `z.number()` on money fields, no `Number()`/
  `parseFloat`/`toFixed` on monetary identifiers, no `Math.round/floor/ceil` on money.
- Currency symbols (`GHS`, `GH₵`) appear only in the Ghana jurisdiction seed and
  in doc comments/examples — never in logic.
- Tenant #1 vocabulary (Flagship/RDC/contractor/Agyasei) appears only in seed
  data — no code branches on it, including everything under `infra/`. No
  `country === 'GH'` style branch anywhere.
- `infra/powersync/sync_rules.yaml` audited line by line: **all 17 data queries
  repeat the tenant predicate** — 14 tenant-owned-table queries carry
  `tenant_id = bucket.tenant_id`, the 3 `platform.*` jurisdiction queries key on
  a `jurisdiction_code` derived server-side from the token's tid.
  `request.parameters()` appears **only in the comments prohibiting it**; every
  bucket parameter comes from `request.jwt()`.
- No PAYE/SSNIT/withholding computation exists anywhere; the only hits are the
  migration comment prohibiting it (§2.4).
- Assertion-integrity check for this pass: every test file named in the previous
  revision of this document still exists with its **exact previous per-file test
  count**; the deltas are purely additive (api +11 across 2 new files, web +32
  across 4 new files). No `.only`/`.skip`/`.todo` anywhere.

---

## 2. Fixed during integration

1. **`apps/api/test/money-property.test.ts` — test bug, generator produced invalid
   carts.** The random cart generator drew line discounts up to 9 minor units on
   lines whose net could be ~1 minor unit, and the API — correctly — rejects a
   discount exceeding the line net rather than silently clamping money. Fixed the
   **generator**, not the assertion and not the server.
2. **`apps/web/src/data/powersync.ts` — compile error.** `ReturnType<typeof column.text>`
   is invalid; replaced with the library's exported `ColumnsType`.
3. **`apps/api` credit fee rate typed as `number`** — now selected `::text` and
   carried as `bigint` into the (already-bigint) accrual arithmetic.
4. Two annotated `lint-money-ignore`s for genuine non-amounts (`feeGraceDays`,
   test helper `feeBp`).
5. Re-ran the full workspace install after an interrupted earlier `pnpm install`.

Added in the clean-slate verification pass (2026-08-21):

6. **`apps/web` typecheck + build broken by peer re-resolution.** Adding
   `@erp/sync-drills` (which depends on `@powersync/common@^2.1.0`) caused pnpm to
   re-resolve `apps/web`'s `@powersync/web@1.39.1` against `common@2.1.0` —
   violating its declared peer range `^1.57.3` and producing 7 type errors in
   `src/data/powersync.ts` (`init`/`connect`/`writeTransaction`/`registerListener`
   missing) plus a failing Vite build. Fix: pin `"@powersync/common": "^1.57.3"`
   explicitly in `apps/web/package.json` so its instance resolves against the
   correct peer. Full workspace typecheck/build/test green afterwards, and the
   clean-slate drill re-run on the final tree.
7. **Two money-lint false positives in `packages/sync-drills`** annotated with the
   established `lint-money-ignore` convention: `d1.ts` `totals` (elapsed
   milliseconds), `d4.ts` `creditEntries` (a `count(*)` row count). Neither is a
   monetary amount; no assertion changed.

---

## 3. Deferred — and why

| Deferred | Why |
|---|---|
| **Q8 document model** (Ghana e-VAT invoice issuance/clearance) | `docs/open-questions.md` Q8 is `NEEDS-HUMAN`: Ghana runs a *clearance* regime and the commissioning decision hasn't been made. Sale **capture** and tax computation are built; issuance is a marked seam (`0004_app_trade.sql`, `sales.ts`, `checkout.ts`) so the capture model survives either answer. Building clearance fields now would bake in a guess. |
| **Receipt-printing spike** | Needs the physical thermal printer decision (Bluetooth ESC/POS vs. USB) and real hardware; nothing in the current data model blocks it. |
| **Real device trial** | Requires representative low-end Android tablets. The stack and drills exist now; what remains untested is OPFS persistence, worker behaviour and performance on target hardware. |
| **`app.credit_policy` migration + Q4 confirmation** | The per-tenant credit policy (Q4's five fee decisions) lives behind an in-memory store seam in `apps/api/src/credit-policy.ts` with the same fields, gate and defaults as the designed effective-dated table. Default state is UNCONFIRMED → the accrual fails closed. Moving it into a migration is straightforward; the accountant's confirmation of the five decisions is the blocking human gate. |
| **RBAC permission matrix** | Roles are opaque tenant-editable strings and location scoping is enforced on every mutation, but the composable permission→action mapping (§2.6) is not yet implemented or tested. The sync rules carry documented **interim fail-closed mechanisms** until it lands: location scope from the signed `location_id` token claim (set server-side, never a client parameter; no claim → zero rows) instead of `user_location_scope`; the credit book **not synced at all** rather than ungated; `sale_line`/`sale_tax_line` in a tenant-scoped interim bucket pending the §3.11.10 denormalisation migration (tenant isolation intact, location narrowing not yet). Must land before the pilot. |

(The previous revision's "PowerSync cloud wiring" deferral is **done** — see §1 and §5.)

---

## 4. How to run everything

Prereqs: Node ≥ 20, pnpm 9 (`corepack enable`), Docker.

```sh
pnpm install                # from the repo root
pnpm build                  # turbo: tsc for @erp/money, Vite+PWA for @erp/web
pnpm typecheck              # all packages
pnpm test                   # all suites (234 tests; PGlite suites take ~30s)
pnpm lint:money             # ADR-0004 money-type lint

# Per package (dependency order money → db → api → web):
pnpm --filter @erp/money test
pnpm --filter @erp/db test          # hermetic — real DDL on PGlite, no external Postgres
pnpm --filter @erp/api test         # same harness, drives the tRPC routers + sync routes
pnpm --filter @erp/web test         # real SQLite via node:sqlite + jsdom for components

# The real stack + acceptance drills (reproducible from nothing):
pnpm stack:reset                    # docker down -v → up → migrate → seed 2 tenants
pnpm --filter @erp/sync-drills drill  # 5 drills; spawns the API on :3001 if absent
pnpm --filter @erp/api dev:stack    # API dev server on :3001 (for manual use)

# POS dev server:
pnpm --filter @erp/web dev          # local-only with no env; set the three VITE_
                                    # vars from apps/web/env.example for sync mode
```

Fixed dev contract: Postgres 16 in docker at `localhost:5433` (db/user `erp`,
password `erp_dev`, `wal_level=logical`) — **not** any host Postgres on 5432;
PowerSync at `http://localhost:8080`; API at `http://localhost:3001`;
`DEV_JWT_SECRET` (default `dev-secret-change-me`) shared by API and service.

Notes: `@erp/db` and `@erp/api` run from TypeScript source (no build step). If a
vitest process ever hangs at exit, it is PGlite/wasm teardown: the api config pins
`pool: 'forks'`.

---

## 5. Acceptance criteria — demonstrated, with the measured numbers

All figures are from the final clean-slate run (2026-08-21, `stack:reset` from a
destroyed docker volume, then `drill`): **5/5 drills PASS**, full log in
`docs/sync-drill-report.md`. The run was performed twice from a clean slate on
2026-08-21; both passed. Localhost latencies are of course optimistic versus
field conditions — what the drills prove is *correctness* of the offline→sync
path and that the 60s budget is met with enormous headroom in the lab; the
real-device trial (§3) is where field latency gets measured.

1. **Airplane-mode sale syncs < 60s of reconnection — DEMONSTRATED (D1).**
   5 iterations: a real partition each time (the drill asserts the sale is
   *absent* from the server while offline), then reconnect → sale on the server
   in 209–212ms, **p95 212ms against the 60,000ms budget**, and visible on a
   *second device* ~204ms later. All 5 sales present on the originating device
   afterwards.

2. **Two offline devices, same SKU, reconcile — DEMONSTRATED (D2).**
   Both devices partitioned; 4 movements recorded against the same SKU
   (0 reached the server while partitioned). On reconnect: all 4 on the server
   in 4ms; server on-hand = baseline 490 + Σdeltas 105 = **595, exact**; both
   devices converge to 595 (A1 203ms, A2 0ms after the server had all
   movements); the two devices' movement ledgers are **byte-identical row for
   row** (10 rows); `write_log` holds exactly one row per op key and exactly one
   `stock_movement` per op — no loss, no duplication. Convergence is by
   construction (append-only ledger, derived on-hand), and D4 proves the
   idempotency backstop: **verbatim replay of all 7 acked batches (9 ops) → 9/9
   acked `duplicate`, zero new effects, state byte-identical**.

3. **Credit balance, ageing and facility fee across outlets — TESTED, NOT YET
   FULLY DEMONSTRATED.** The maths (exposure = Σ(entries) derived identically in
   API and database, 30E/360 accrual, delta posting, truncation in the
   customer's favour, ageing buckets) is covered by 14 API tests including mixed
   cash/credit — but (a) no accountant has confirmed the Q4 fee decisions, so
   the gate correctly refuses to post and every fee figure is provisional;
   (b) the policy store is in-memory pending its migration; (c) the credit book
   is deliberately **not synced** to devices until the RBAC permission tables
   exist (fail-closed), so the cross-outlet credit view is online-only today.
   This is the one criterion still short of "demonstrated".

4. **HQ post-sync view across locations — DEMONSTRATED (D3).** After a second
   location's device (OUT-03) flushed its outbox (2 ops, 34ms, acks `applied`),
   one HQ query over **57 locations returned in 4ms** with sales visible across
   both trading locations; per-location Σ(sales) = tenant-wide total **42,000
   minor units as an exact bigint identity**; HQ on-hand per location
   (OUT-01 = 595, OUT-03 = 26) equals each location's independent ledger sum.

5. **Second tenant invisible — DEMONSTRATED AT EVERY LAYER INCLUDING SYNC (D5).**
   Previously proven at the database (RLS, 10 tests) and API (6 tests) layers;
   now proven where §2.1 says the boundary actually is — the sync layer — by
   inspecting the **raw sqlite files** of two devices belonging to different
   tenants (both provisioned from the same template, both non-vacuously holding
   data): tenant B's device holds 576 synced rows across 19 physical tables with
   **zero** rows carrying tenant A's `tenant_id` and tenant A's uuid appearing
   **nowhere** in the file; symmetrically, tenant A's device (664 rows) holds
   zero of tenant B. Row counts equal the tenant-scoped predictions exactly, so
   the buckets are neither leaking nor silently empty. Caveat honestly: the
   sync-rule location scoping is the interim token-claim mechanism and the
   credit book is not synced (§3) — the *tenant* boundary is fully demonstrated;
   the *role/location* narrowing awaits the RBAC matrix.

---

## 6. Remaining gaps before Phase 1 sign-off

1. **RBAC permission matrix** — the composable permission→action mapping
   (outlet staff cannot override a price or touch a credit limit), the
   `user_location_scope`/`user_effective_permission` tables, and the sync-rule
   swap from the interim token-claim location scope to table-driven scoping,
   plus the §3.11.10 `sale_line` denormalisation so lines join the per-location
   bucket. Sync rules are the authorization boundary and cannot be retrofitted.
2. **Credit policy migration + Q4 human gate** — move the in-memory
   `credit-policy` store into the effective-dated `app.credit_policy` migration,
   and obtain the accountant's confirmation of the five fee decisions. Until
   then every fee figure is provisional and the accrual fails closed.
3. **Q8 document model** — Ghana e-VAT invoice issuance/clearance decision
   (`NEEDS-HUMAN`); the capture-side seam is built and marked.
4. **Receipt-printing spike** — blocked on the thermal-printer hardware decision.
5. **Real-device trial** — representative low-end Android tablets against this
   stack: OPFS persistence, worker behaviour, sync performance under field
   latency (the 60s budget was met at p95 212ms on localhost; the field number
   is the one that matters).
6. Smaller but real: auth is a dev-grade HS256 flow (shared dev secret, static
   bearer in the PWA env) — the real login/credential flow is §8.2 work;
   `pnpm build` warns at ~600 kB main bundle (code-split before pilot).

None of these gaps is hidden in a passing test suite: everything green above is
green because the thing it tests genuinely works in the tested environment, and
everything not yet demonstrable is listed here.
