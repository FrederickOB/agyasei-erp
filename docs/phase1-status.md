# Phase 1 status — integration & QA report

**Date:** 2026-08-21 (client↔server contract-conformance pass) · **Author:** QA engineer
**Verdict:** the whole workspace installs, builds, typechecks and passes — **388 tests, 39 files,
0 failures** — `tools/lint-money.mjs` is clean, and `pnpm --filter @erp/sync-drills drill` passes
**6/6 drills against the real stack** — real Postgres 16, real self-hosted PowerSync, real API,
real `@powersync/node` devices with their own sqlite files, plus the new D6 which runs the **PWA's
own code** over a real socket. Nothing mocked.

Acceptance criteria **1, 2, 4 and 5 are demonstrated, not asserted** — measured numbers in §5.
Criterion 3 remains tested-at-API-level with the Q4 human gate outstanding. This is still not a
Phase 1 sign-off: the remaining gaps are in §6, and the `product-manager` owns the gate decision.

---

## 0. Read this before trusting the drill suite again

**A green drill suite has now failed, twice, to notice that the PWA could not talk to the API at
all.** Not "had a subtle bug" — could not complete a single sale.

| Bug | What was broken | What the drills said | Why they missed it |
|---|---|---|---|
| **CORS** | Every browser call to the API failed at preflight. The PWA could not reach the server. | 5/5 PASS | Each drill device is an `@powersync/node` client. Node has no browser origin, so no drill ever sent a cross-origin request. |
| **Sale payload shape** | `buildSalePayload` emitted `{kind, sale_id, price_list_id, total_minor, tender:{…}, lines:[{seq, qty_scaled, unit_price_e4, …}]}`; the API's `.strict()` schema required `{locationId, priceListCode, receiptNo, businessDate, tender:'CASH'\|'CREDIT', lines:[{productId, qty}]}`. **Every** uploaded sale was `BAD_REQUEST`. | 5/5 PASS | `packages/sync-drills/src/context.ts` built its own API-shaped JSON. The client's real payload had never been handed to the server's real schema at any level — unit, integration or drill. |

One root cause, stated once: **both sides were only ever tested against a third thing that agreed
with neither of them.** The drills are a genuine demonstration of the *sync* path — partition,
convergence, idempotency, isolation — and those results stand. They were never evidence about the
*client* path, and this document previously implied otherwise.

What changed, so the next one is caught:

- **`packages/contracts`** — one declaration per client↔server payload, imported by `apps/api`
  (which parses) and `apps/web` (which builds). A shape disagreement is now a `tsc` error.
- **`packages/wire-conformance`** — the only package that can import both trees. Its tests drive
  the PWA's real `checkout()` → real outbox → real transport, with a browser `Origin`, at the real
  Fastify routes and real tRPC routers on a real Postgres, and assert the rows land. Runs on every
  `pnpm test`, no docker.
- **Drill D6** — the same journey over a real socket against the deployed stack, so the failures an
  in-process harness cannot see (CORS preflight, a dev server on stale code, seed data that does
  not match the contract) are caught too. One of each, from now on.
- **A pin on the client's write surface.** `apps/web` can upload exactly one kind today
  (`sale.create`). `outbox-surface.test.ts` fails the moment a second appears without a test that
  drives *its* real builder against *its* real parser.

Both mutation-tested before being believed: drifting the client payload turns
`sale-client-to-api.test.ts` red (4 failures), and pointing a router at a private schema instead of
the shared one turns the registry assertion red.

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

### `packages/contracts` — 80 tests (3 files), build + typecheck clean
**The one client↔server wire contract.** zod only, so it bundles into the browser build of the
PWA; a test asserts that by scanning every source file for a non-zod import, so browser safety is
enforced rather than promised. Both `apps/api` and `apps/web` import it, which is what makes a
shape disagreement a compile error instead of a `BAD_REQUEST` at a till in Techiman.

- `wire.ts` — scaled-integer primitives (`zScaledInt*`), `zUuid`, `zBusinessDate`, `zClaimedHlc`,
  the mutation envelope, `wire()`. Money and quantity cross as decimal **strings** and become
  `bigint` at the boundary (ADR-0004); every input object is `.strict()`, so a forged `tenant_id`
  fails loudly (CLAUDE.md §2.1).
- `sale.ts` · `inventory.ts` · `credit.ts` — the four uploadable mutation inputs. The last three
  were private to `apps/api/src/routers/` until this pass: no PWA builder exists for them yet, and
  that is exactly why they are declared here now, before someone writes one against a schema they
  cannot import.
- `device-ops.ts` — kind → schema registry, `satisfies Record<DeviceOpKind, ZodType>`, so adding an
  uploadable op without a shared declaration is a **compile** error.
- `upload.ts` — the `/sync/upload` envelope and the batch cap, one constant for both sides.
- `sync-token.ts` — the `/sync/token` **response**, the other payload that had no shared
  declaration. Not `.strict()` (a new server field must not break old devices); `endpoint` is
  optional because the client ignores it, and the API's actual response is asserted against the
  live route instead.

- `sale` (41) — the known-good payload, the bug's payload kept verbatim so a regression to it fails
  here, the pricing-authority refusals (`unitPriceE4`/`lineTotalMinor`/`totalMinor` rejected),
  tenant-identity refusals, money/quantity discipline past float64 range
- `wire` (17) — primitives, HLC wire projection, envelope, browser-bundle safety
- `device-ops` (22) — the registry is exhaustive; every registered schema requires the idempotency
  key and refuses all three spellings of tenant identity; movement/credit money as strings; no
  `SALE` movement kind and no `FEE` entry kind on the device surface; the `/sync/token` shape

### `packages/wire-conformance` — 27 tests (2 files), typecheck clean
**A probe package whose only job is to prove the two sides agree.** No production code imports it.
It exists because it is the only place that can import `apps/web`'s sources *and* `apps/api`'s:
the PWA resolves modules as a bundler would and its imports carry no file extensions, which
`apps/api`'s `NodeNext` compilation cannot follow, so neither app can import the other.

- `sale-client-to-api` (19) — the test that would have caught the bug. Real local SQLite on the
  device's own schema → real `createCart`/`addProductToCart`/`checkout` → real outbox → real
  `httpUploadTransport` with a browser `Origin` → real Fastify `/sync/upload` with CORS configured
  → real tRPC router → real Postgres (PGlite, RLS on). Asserts the ack is `applied`; that the sale,
  its line, its tax lines and its stock movement landed under the verified tenant at the device's
  location; that the total is an exact bigint identity and is the **server's** figure, not the
  till's; that the divergence is reported back in `write_log.response_body` as decimal strings;
  that a replay acks `duplicate` with no second effect. Negative controls: the old hand-rolled
  payload and a client-asserted `unitPriceE4` are both rejected `BAD_REQUEST`, classified
  *definitive* by the client's own `classifyRejection`, with nothing written. Also drives the PWA's
  real `CredentialCache` against the live `/sync/token`, and asserts the browser **preflight** for
  the exact request the transport makes (POST, `authorization` + `content-type`, from the PWA's
  origin) is approved while an arbitrary origin is not — bug #1 of this class, asserted for this
  request rather than in general.
- `outbox-surface` (8) — the audit, as a test: the client's write vocabulary is pinned; every
  registry kind is really dispatched (an empty payload must be `BAD_REQUEST`, never
  `UNKNOWN_KIND`); an unknown kind is per-op `UNKNOWN_KIND` without taking the batch with it; one
  contract-shaped payload per kind is accepted end to end; the batch cap is enforced on both sides.

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

### `apps/api` — 58 tests (10 files), typecheck clean
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

### `apps/web` — 121 tests (15 files), build (Vite + PWA) + typecheck clean
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
`pnpm --filter @erp/sync-drills drill` runs the **six** Phase 1 drills against the
**real stack** (auto-spawns the API on :3001 if absent, tears it down after).
D1–D5: each "device" is an `@powersync/node` client with its own sqlite file and
its own tokens; writes go solely outbox → `POST /sync/upload`; the drill connector
**throws** if a PowerSync crud batch ever appears (download-only, enforced).
Report: `docs/sync-drill-report.md`, regenerated every run. Typecheck clean; the
drills are the tests (hard assertions, non-zero exit on any failure).

**What D1–D5 are and are not evidence of — see §0.** They demonstrate the *sync*
path with real partitions and real convergence, and those results stand. They are
not evidence about the *client* path: their payloads came from
`src/context.ts`, not from `apps/web`, and their transport is a Node client with
no browser origin. Two closures this pass:

- **D6 — "the PWA's own payload, end to end"** runs `apps/web`'s real counter path
  (local SQLite → cart → `checkout()` → outbox → `httpUploadTransport`) over a real
  socket with a browser `Origin` at the API on :3001, then reads Postgres to prove
  the sale, its line, its tax lines and its stock movements landed with the
  **server's** prices, and that a byte-identical re-POST is `duplicate` with no
  second effect. It lives in `@erp/wire-conformance` (the only package that can
  import both trees) and is invoked as a child process so it appears in the report
  with the rest. Runnable alone:
  `pnpm --filter @erp/wire-conformance drill:live`.
- **D1–D5's own payloads are now contract-typed.** `saleOp`/`movementOp`/
  `openAccountOp` in `src/context.ts` returned `Record<string, unknown>`; they now
  return `Omit<CreateSaleInput, keyof MutationEnvelope>` and friends from
  `@erp/contracts`, so a drill payload that stops matching the contract is a
  compile error. That closes "the drills invented their own shape" — though a
  drill agreeing with the contract still does not prove the PWA does, which is
  why D6 exists as well.

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

Added in the client↔server contract-conformance pass (2026-08-21):

8. **Every sale the PWA uploaded was rejected `BAD_REQUEST`** — the client and the
   API had been built in parallel with no shared declaration and agreed on nothing
   (§0). Fixed structurally, not by patching one payload: `packages/contracts`
   holds the one declaration, `apps/web` builds a value annotated with it, and the
   API's routers parse with the same objects. **`.strict()` was NOT loosened** —
   its refusal of `unit_price_e4` / `line_total_minor` / `total_minor` is the
   mechanism that keeps pricing authority on the server (CLAUDE.md §2.5). Three
   contract tests assert those keys stay rejected, and the conformance suite proves
   it against the live route: a payload identical to a good one except for an added
   `unitPriceE4` is answered `BAD_REQUEST` and nothing is written.
9. **Three of the four uploadable mutation schemas were still private to
   `apps/api`** (`stock.record_movement`, `credit.open_account`,
   `credit.record_entry`) — the same latent condition, one op away from repeating.
   Moved into `@erp/contracts` and registered in `device-ops.ts`, where the
   `satisfies Record<DeviceOpKind, ZodType>` clause makes an unregistered
   uploadable op a compile error and a conformance test asserts each router really
   parses with the registered object. Behaviour unchanged: the schemas moved
   verbatim.
10. **`GET /sync/token` had no shared declaration either** — the API assembled
    `{token, expires_at, endpoint}` by hand and the PWA picked those keys out of an
    `unknown` by hand. A rename would have broken every device's download path
    silently, on reconnect, in the field, with a green suite. Both sides now use
    `syncTokenResponse`; the client's failure message names the offending path
    instead of saying "missing token/expires_at".
11. **`apps/web/tests/helpers/fixtures.ts` — `seedProduct` gained an optional `id`.**
    Purely additive, so the conformance suite can seed the device catalogue with the
    **server's** real product ids. No existing behaviour or assertion changed.

Assertion integrity for this pass: every pre-existing suite kept its exact test
count (contracts 58, money 56, db 46, api 58, web 121 — unchanged before and
after). The +49 is entirely new files: `packages/contracts/test/device-ops.test.ts`
(22) and the two `packages/wire-conformance` suites (27). Nothing was weakened,
skipped or deleted; there is no `.only`/`.skip`/`.todo` anywhere.

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
pnpm test                   # all suites (388 tests; PGlite suites take ~30s)
pnpm lint:money             # ADR-0004 money-type lint

# Per package (dependency order contracts → money → db → api → web → conformance):
pnpm --filter @erp/contracts test    # zod only; no db, no network, no wasm
pnpm --filter @erp/money test
pnpm --filter @erp/db test           # hermetic — real DDL on PGlite, no external Postgres
pnpm --filter @erp/api test          # same harness, drives the tRPC routers + sync routes
pnpm --filter @erp/web test          # real SQLite via node:sqlite + jsdom for components
pnpm --filter @erp/wire-conformance test   # the PWA's real payload vs the API's real parser

# The real stack + acceptance drills (reproducible from nothing):
pnpm stack:reset                    # docker down -v → up → migrate → seed 2 tenants
pnpm --filter @erp/sync-drills drill  # 6 drills; spawns the API on :3001 if absent
pnpm --filter @erp/wire-conformance drill:live   # D6 alone, against the running stack
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

All figures are from the runs on 2026-08-21: **6/6 drills PASS**, full log in
`docs/sync-drill-report.md` (D1–D5 first measured on a clean-slate `stack:reset`
run; D6 added in the contract-conformance pass and run against the same stack). The run was performed twice from a clean slate on
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

**Not an acceptance criterion, but the one the last two bugs lived in — the client
path (D6 + `@erp/wire-conformance`).** A sale rung up through the PWA's own
`checkout()` and shipped by the PWA's own transport, from a browser origin, over a
real socket: acked `applied` in 44ms; one `app.sale`, one `app.sale_line`, three
`app.sale_tax_line` and one `app.stock_movement` (`qty_delta = -3`, `source_kind
= SALE`) at the token's location; total **9,001 = 7,500 − 0 + 1,501** as an exact
bigint identity; the till's own figure of 29,700 (a deliberately stale local price)
was **not** written but **was** reported back as
`priceCheck {matches:false, deltaMinor:"-20699"}` — the stale-price-list detector
working, with money as decimal strings inside jsonb. Byte-identical re-POST →
`duplicate`, one sale, one movement. Repeatable: 27 in-process conformance tests on
every `pnpm test`, plus D6 in the drill report.

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
6. **Receipt-number regression is undetected, and it wedges the queue.** Found by
   running D6 twice. `03-offline-sync` §3.7.5 requires that a device reporting a
   `consumed_upto` regression has the remainder of its block burned, a fresh block
   issued, and a **severity-1 review opened naming the overlap range** (conflict
   class #14); §3.9 lists "wipe a device's local DB mid-block, reissue" as a named
   drill. None of that exists. There is no `sequence_block` table server-side and
   no allocation endpoint — every block today is self-issued by the device
   (`apps/web/src/data/sequence.ts` says so in its own seam note). What happens
   instead: the second sale carrying a repeated receipt number is answered
   `INTERNAL_SERVER_ERROR: duplicate key value violates unique constraint
   "sale_receipt_uq"`, and the client's §3.3.4 taxonomy
   (`classifyRejection`) classes `INTERNAL_SERVER_ERROR` as **retryable** — so the
   op is retried forever and the outlet's queue never drains. Reproduce: run
   `pnpm --filter @erp/wire-conformance drill:live` with a fixed `deviceNode`
   instead of the per-run random one.

   **Not fixed here, deliberately.** The two cheap patches are both wrong: mapping
   the constraint violation to `BAD_REQUEST` would dead-letter a real sale (the
   loss path §3.3.4 exists to avoid), and silently renumbering would hand a
   customer a receipt number a different customer already holds. The correct fix is
   the mechanism §3.7.5 specifies — server-side blocks, regression detection on
   reconnect, and the review queue — which is a work-package for `sync-architect`,
   not a patch. Recorded here rather than papered over.

7. **Three of the four uploadable ops have no client at all.** `sale.create` is now
   proven end to end from the PWA's own code. `stock.record_movement`,
   `credit.open_account` and `credit.record_entry` are reachable on `/sync/upload`
   and are exercised with contract-shaped payloads (`outbox-surface.test.ts`), but
   **no PWA builder exists for them**, so there is nothing on the client to test
   and the counter cannot record a stock adjustment or a credit transaction
   offline. The declarations are now shared, and `outbox-surface.test.ts` fails the
   moment `apps/web` grows a second uploadable kind without a conformance test for
   it — but until those builders are written, "the write path works" means the sale
   path works.

8. **The conformance suite proves shape and effect, not the counter's UI.** It
   drives `checkout()` and the outbox directly; nothing in it renders a React
   component or clicks a button, and no test in this repository drives the PWA in a
   real browser. A regression in the counter screen that never reaches
   `checkout()` would still pass everything green above. Playwright against the
   built PWA is the missing layer, and it belongs with the real-device trial (#5).

9. Smaller but real: auth is a dev-grade HS256 flow (shared dev secret, static
   bearer in the PWA env) — the real login/credential flow is §8.2 work;
   `pnpm build` warns at ~600 kB main bundle (code-split before pilot).

None of these gaps is hidden in a passing test suite: everything green above is
green because the thing it tests genuinely works in the tested environment, and
everything not yet demonstrable is listed here. §0 is the standing correction to
the habit that produced the last two bugs — a green suite is evidence about the
paths it actually traverses and about nothing else.
