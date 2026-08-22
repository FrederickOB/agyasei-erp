# Phase 1 status — integration & QA report

**Date:** 2026-08-21 (verification pass over the sale-path guard, cross-location
reporting and low-stock alerts) · **Author:** QA engineer

> **What changed in this revision.** The sale path is now permission-guarded and
> **the credit bound is demonstrated over real HTTP** — §6 item 1, the single
> most important line in the previous revision, is CLOSED. Cross-location
> reporting (`reports.*`) and the low-stock alert (`inventory.lowStock` +
> reorder points, migration `0007`) landed and are guarded. Acceptance
> criterion 3 moved from "tested, not demonstrated" to **balance and ageing
> DEMONSTRATED live, facility fee still gated on Q4** (§5). One new bug was
> found — by running the drills, not by the suite — and is ledgered as §0 row 9.

**Verdict from the previous revision (the merge pass), kept for the record:**
two independent work-packages are now one tree. From `origin/main`:
the `@erp/contracts` shared wire contract, RBAC enforcement resolved per request
from the database, device price-list provisioning, and the wire-conformance
suite. From PR #4: receipt-number regression detection — server-allocated
blocks, burn-and-reissue on reconnect, the conflict-review queue, and the
collision landing path that stops the outbox wedging.

**Verification for THIS pass (2026-08-21, clean slate).** The whole workspace
builds and typechecks (12/12 turbo tasks) and every suite passes:

| Package | Tests | Files | Previous | Δ |
|---|---:|---:|---:|---:|
| `@erp/contracts` | **105** | 4 | 80 | +25 (`reports.test.ts`) |
| `@erp/money` | **56** | 4 | 56 | — |
| `@erp/sequence` | **14** | 1 | 14 | — |
| `@erp/db` | **99** | 9 | 99 | — |
| `@erp/api` | **233** | 15 | 143 | +90 (`sales-rbac` 44, `reports` 26, `reorder-points` 16, +4 in existing files) |
| `@erp/wire-conformance` | **35** | 4 | 35 | — |
| **non-web total** | **542** | **37** | 427 | **+115** |
| `@erp/web` *(another session's tree — observed, not owned)* | 265 | 26 | 189 | +76 |

**807 tests, 63 files, 0 failures.** No baseline went down; every delta is
additive. `node tools/lint-money.mjs` is clean.

Live, against the real stack from a destroyed docker volume (`pnpm stack:reset`
→ 7 migrations → seed → API on :3001): **D1–D7 7/7**, **D8 (RBAC) 30/30**,
**D9 (credit) 13/13** — 50 live checks over real HTTP.

**The previous revision's post-merge figures, kept for the record:** *616 tests, 51 files, 0
failures* across seven packages — `tools/lint-money.mjs` is clean, and `pnpm stack:reset` (docker
volume destroyed, six migrations + seed from scratch) followed by
`pnpm --filter @erp/sync-drills drill` passes **7/7 drills against the real
stack**: real Postgres 16, real self-hosted PowerSync, real API, real
`@powersync/node` devices with their own sqlite files. D6 (the PWA's own
payload) and D7 (receipt-number regression, with a genuine sqlite-file wipe)
both pass in the same tree, which is the thing neither branch could show on its
own. Per-package figures below are post-merge counts.

Acceptance criteria **1, 2, 4 and 5 are demonstrated, not asserted** — measured numbers in §5.
**Criterion 3 is now demonstrated for balance and ageing** (D9, live, across two outlets); its
facility-fee clause remains gated on the Q4 human decision and the criterion is therefore **not
fully met** — stated precisely in §5.3.

**Access control is now enforced on the sale path, including the credit bound.** A counter clerk
bounded at `max_order_value_minor: "0"` is refused a credit sale over real HTTP, and an outlet
manager is allowed under `"500000"` and refused over it, measured against the SERVER's repriced
total. That was §6 item 1 of the previous revision and it is closed; the evidence is D8 checks
8a–8g. This is still **not** a Phase 1 sign-off: the remaining gaps are in §6, and the
`product-manager` owns the gate decision.

---

## 0. Read this before trusting the drill suite again

**A green suite has now failed NINE times to notice that a written path had never been executed.**
The count is kept here deliberately, and it goes up, because the pattern is the project's most
reliable defect source: code is written, unit-tested against a harness that agrees with it, and
never once run against the real stack.

| Bug | What was broken | What the drills said | Why they missed it |
|---|---|---|---|
| **CORS** | Every browser call to the API failed at preflight. The PWA could not reach the server. | 5/5 PASS | Each drill device is an `@powersync/node` client. Node has no browser origin, so no drill ever sent a cross-origin request. |
| **Sale payload shape** | `buildSalePayload` emitted `{kind, sale_id, price_list_id, total_minor, tender:{…}, lines:[{seq, qty_scaled, unit_price_e4, …}]}`; the API's `.strict()` schema required `{locationId, priceListCode, receiptNo, businessDate, tender:'CASH'\|'CREDIT', lines:[{productId, qty}]}`. **Every** uploaded sale was `BAD_REQUEST`. | 5/5 PASS | `packages/sync-drills/src/context.ts` built its own API-shaped JSON. The client's real payload had never been handed to the server's real schema at any level — unit, integration or drill. |
| **Device enrolment** | The device provisioned itself from values that no longer came from the session. | green | No test drove enrolment from a real token. |
| **Price list** | The device's price-list selection and the server's resolution disagreed. | green | Both sides tested against a fixture, neither against the other. |
| **Device price list** | `writeActivePriceListId` was written and never called from anywhere. The only writer of `local_config.price_list_id` was the dev seed, which points it at a placeholder list coded `DEFAULT`. Tenant #1's lists are `RETAIL` and `WHOLESALE`, so in sync mode every sale went up as `priceListCode: 'DEFAULT'` and the API answered `PRECONDITION_FAILED: no price list DEFAULT in force` — **recorded at the counter, rejected at upload**, which is the worst of the three outcomes because the till believed it had sold. | green | Identical shape to the device-enrolment row two above it, and missed the same way: `tests/helpers/fixtures.ts` provisions a device with `priceListCode: 'DEFAULT'` and seeds a matching list, so every unit test agreed with the client about a code the server has never heard of. `tests/live-upload.smoke.ts` *did* hit the real API — with `order by priority desc`, which quietly selects the one list the API can price, so it never exercised what a device would actually choose. |
| **Currency spec** | The currency the client assumed and the one the server used were never compared. | green | No shared declaration existed to compare them against. |
| **Sequence reporting (this merge)** | Two halves of PR #4 were written and reachable by nothing. (a) `apps/web/src/data/sequence.ts`'s whole reconnect half — `buildBlockReport`, `enqueueBlockReport`, adoption — was imported by its own unit test and by **no production module**: `powersync.ts` drained the outbox with no `onResult`, and `checkout` allocated numbers through a different function entirely. (b) the review it opens routed on `required_permission = 'sequence.review'`, a code absent from `platform.permission`; the column has no FK, so nothing complained and **no user could ever have held it** — every severity-1 receipt-number review would have landed in a queue nobody could read. | its own suite: green | The unit test imported the module directly, so "does anything call this?" was never asked; and the permission string was asserted against itself (`expect(required_permission).toBe('sequence.review')`) rather than against the catalogue. |
| **RBAC enforcement (this pass)** | Permission checks were added to the API's stock and credit routes with **535 unit tests green**. On the live stack: migration `0005` had never been applied, so `app.effective_permission` did not exist; `applyTemplate` seeds roles but deliberately seeds **no users and no role assignments**, so every tenant had 5 roles and **0 grants**; and every drill device mints a fresh random `uid`. The result: **the entire Phase 1 acceptance drill suite died at warm-up** with `FORBIDDEN: PERMISSION_DENIED: stock.adjust is not held by this user`, and `pnpm dev:token` produced a bearer that no guarded route would accept. | 535/535 PASS | `apps/api/test/util.ts` grants every test identity the **owner role by default** (`identityFor(..., grant: 'owner')`). Every API test therefore ran as a principal holding the whole catalogue, so no test could observe that no real principal existed. The drills would have caught it in one run — they were not run, because they need docker. |
| **`sequence.syncBlock` guard (this pass)** | `sequence.syncBlock` was correctly tightened from "scope only" to `sale.record` at the request's location. **`apps/api/test/sequence-regression.test.ts` went from 20 tests to 26, all green.** On the live stack the entire receipt-number regression drill died at its first call: `FORBIDDEN: PERMISSION_DENIED: sale.record is not held by this user`. D7 builds its own device (`device-a6`) inside `runD7` rather than in the shared `context.ts`, and the context's provisioning loop covers only `a1/a2/a3/b1` — so A6 was the one device in the repository whose principal had never been granted anything. It worked for as long as the route required no capability. | 26/26 PASS, and D1–D6 PASS in the same run | The API harness grants every test identity the **owner role** (`identityFor(..., grant: 'owner')`), so no unit test can observe a principal with no grant. It is §0's RBAC row again, one layer down: the harness default is still the third thing that agrees with neither the drill's seed data nor the live stack. Caught in one drill run; the fix is one line in `d7.ts`. |

One root cause, stated once: **both sides were only ever tested against a third thing that agreed
with neither of them** — a fixture, a harness default, or a hand-written payload. The RBAC entry is
the same shape wearing different clothes: the harness's `grant: 'owner'` default *is* the third
thing that agreed with neither the seed data nor the live stack. The drills are a genuine demonstration of the *sync* path — partition,
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
- **A pin on the client's write surface.** `apps/web` can upload two kinds today
  (`sale.create` and `sequence.sync_block`). `outbox-surface.test.ts` fails the moment another
  appears without a test that drives *its* real builder against *its* real parser — and it did
  fail, on this merge, the moment the sequence report joined the vocabulary. The answer was
  `sequence-client-to-api.test.ts`, not a wider allow-list.
- **Drill D8 — `pnpm --filter @erp/wire-conformance drill:rbac`.** Thirteen authorization checks
  over a real socket against the deployed stack: every refusal paired with a positive control on
  the same route with the same payload, so "denied" can never mean "the route is broken for
  everyone". It is the check that would have caught this pass's failure in one run.
- **`provisionPrincipal` (`packages/db/src/seed/principals.ts`) and the bootstrap's dev
  principals.** A tenant with roles and no grants is a correctly-seeded tenant that nobody can use.
  `pnpm stack:up` now provisions one principal per template role on each dev tenant, and
  `pnpm dev:token --role <ref>` mints for a **real provisioned principal** — looking the user up by
  `app.user_account.username` and failing loudly with "run pnpm stack:up" when it is absent, rather
  than minting a bearer that belongs to nobody.

Both mutation-tested before being believed: drifting the client payload turns
`sale-client-to-api.test.ts` red (4 failures), and pointing a router at a private schema instead of
the shared one turns the registry assertion red.

---

## 1a. Access control — what is enforced, and what is not

**Read the second table first.** The first one is the good news and the second one is the reason
this is not a sign-off.

### The model (`packages/db` — migration `0005_rbac_permissions.sql`, 99 tests)

- **`platform.permission`** — 36 atomic capability codes, GLOBAL, no `tenant_id`. A tenant composes
  them; it cannot mint one. (A tenant-scoped catalogue would let a tenant invent
  `sale.super_record`, grant it, watch it resolve, and hold a permission that guards nothing.)
- **`app.role` / `app.role_permission` / `app.user_role_assignment`** — tenant-owned, RLS-forced.
  A role is a tenant's word for a tenant's job; **nothing in the platform reads `app.role.name`**,
  and the only structural flag is `is_owner`, which means "holds the whole catalogue by
  construction" rather than any name.
- **`app.location_closure`** — the scope tree. A grant is made at a NODE and expands DOWN. The FY3
  regional manager is two INSERTs, not a migration.
- **`app.effective_permission`** (`security_invoker`) — one row per *(user, code, location)*. A
  permission is never a bare capability; it is always a capability **at a place**.
- **The two hard prohibitions are the ABSENCE of rows**, not a branch: the counter role simply does
  not carry `sale.override_price` or `credit.limit.change`. Verified live — see D8 check 7, where a
  counter-staff principal carrying `role: "head_of_operations"` in its own server-signed token is
  refused exactly as before.

### Enforcement, per route — the honest table

`assertPermission` / `requiresPermission` / `permissionProcedure` resolve the answer **from the
database on every request**, keyed on the token's verified `uid` inside the token's `tid` RLS
context. No permission claim is read from the token, and `role` is never touched.

| Route | Mutating? | Guarded? | Capability |
|---|---|---|---|
| `inventory.recordMovement` | yes | **YES** | derived from `sourceKind` → `stock.adjust` / `stock.receive` / `stock.transfer` / `stock.transfer.receive` / `stock.count.perform`, at the request's location |
| `inventory.onHand` | no | **YES** | `stock.view` at the location asked about |
| `credit.openAccount` | yes | **YES** | `credit.account.manage` tenant-wide, **plus `credit.limit.change`** when the limit is non-zero |
| `credit.recordEntry` | yes | **YES** | `credit.entry.record` tenant-wide |
| `credit.accrueFacilityFee` | yes | **YES** | `credit.fee.accrue` tenant-wide |
| `credit.exposure` / `ageing` / `previewFacilityFee` | no | **YES** | `credit.view` |
| `session.permissions` | no | n/a | reads only the caller's own grants; a UX affordance, explicitly not a control |
| **`sales.createSale`** | **yes** | **YES** | derived from `tender` via the TypeScript-total `SALE_PERMISSION` map → `sale.record` (CASH) / `sale.record.credit` (CREDIT), at the request's location. A credit sale is checked **twice**: the middleware for the capability, then `ctx.permissions.requireWithinAmount('sale.record.credit', locationId, total)` inside the plan against the **server's repriced total** — never `clientTotalMinor`. Demonstrated live: D8 8a–8g |
| `sales.get` / `sales.recomputeCheck` | no | **YES** | `sale.view`, in two steps: `at: 'any'` on the procedure, then `requireAt('sale.view', sale.locationId)` once the row's location is known |
| **`sequence.syncBlock`** | **yes** | **YES** | `sale.record` at the request's location. A block is the stock of numbers a till spends printing documents it is authorised to produce, so the right to be handed one is the right to produce them — no new code, no migration, no template edit. Deliberately **not** derived from `sequenceKey`, which is tenant vocabulary (CLAUDE.md §2.9). It narrows WHO, never WHEN: a wiped device that can still ring a sale can always confess. **This guard broke drill D7 — see §0 row 9.** |
| `inventory.setReorderPoint` | yes | **YES** | `stock.reorder.manage` at the location. Demonstrated live: D8 10a/10b |
| `inventory.ensureReorderPoints` | yes | **YES** | `stock.reorder.manage` at the location |
| `inventory.reorderPoints` | no | **YES** | `stock.view` at the location |
| **`inventory.lowStock`** | no | **YES** | `stock.view`, `at: 'any'`, then the location set resolved per request by `./scope.ts` and intersected with the request's. Guarded by `stock.view` rather than a reporting capability **on purpose**: the person who has to tell a customer "we're out" should see it coming. Demonstrated live: D8 10c/10d/10e |
| `reports.salesByLocation` / `stockOnHand` / `cashPosition` | no | **YES** | `report.view.location`, `at: 'any'`; `report.view.tenant` **widens** to the network when held at every root. A widener, not an alternative — a role composed with the tenant code alone is refused at the door. Demonstrated live: D8 9a/9b/9c |
| `reports.inventoryDays` / `distributionCost` | no | **YES** | `report.view.margin` — a strictly narrower audience, so an outlet manager sees their takings and not what the goods cost. Demonstrated live: D8 9d/9e |
| `catalogue.list` / `search` / `detail` | no | ❌ no | `catalogue.view` exists and is never checked |
| `provisioning.applyTemplate` | yes | ❌ no | `admin.template.apply` exists and is never checked. Defensible — this is the bootstrap edge that *creates* the roles there would be something to check against — but it is a mutation any valid tenant bearer can call. |
| `provisioning.createTenant` | yes | operator | platform-operator plane, not tenant RBAC |

**Catalogue wiring: 19 of 37 codes now have a production enforcement site** (was 11 of 36;
`stock.reorder.manage` is the code migration `0007` adds). The other 18 are declared and never
checked. Most remain honest placeholders for endpoints that do not exist yet (`payroll.*`,
`admin.user.manage`, `admin.role.manage`, `admin.location.manage`, `admin.device.*`,
`catalogue.manage`, `catalogue.price_list.manage`, `credit.policy.manage`, `sale.void`,
`sale.receipt.reprint`, `sale.discount.apply`). **Three still correspond to endpoints that DO
exist and are unguarded:** `catalogue.view` (`catalogue.list`/`search`/`detail`),
`admin.template.apply` (`provisioning.applyTemplate`), and `customer.view`/`customer.manage`
(reachable through `credit.openAccount`'s `newCustomer`). `sale.override_price` guards nothing
because no override path exists — see §6 item 2, which is the good kind of unwired. A permission
code that nothing checks is not a control; it is a comment with a primary key.

### What the live drill demonstrates (`drill:rbac`, **30/30** over HTTP on :3001)

Every refusal is paired with a positive control on the same route with the same payload. Checks
1–7 are unchanged from the previous revision; **8–10 are new in this pass** and are the reason
§6 item 1 could be closed.

| # | Demonstrated |
|---|---|
| 1 | Counter staff **denied** `stock.adjust`; outlet manager **allowed**, same counter, same payload |
| 2 | Counter staff **and the outlet manager** denied a credit account with a GH₵50,000 limit; **Accounts allowed** — the prohibition is the missing capability, not a policed role name |
| 3 | Manager holding `stock.adjust` at OUT-01 **denied at OUT-04** — a capability is a capability *at a place* |
| 4 | Regional manager granted **once at REG-BONO** acts at OUT-01 **and** OUT-03, and still not at OUT-04 — the closure tree, demonstrated today for an FY3 role |
| 5 | Accounts, at the tenant **root** — the widest scope there is — **denied** a stock adjustment. Scope is not authority |
| 6 | Revoking the grant refuses **the same unexpired token** on the very next request — the decision is a database read per request, never a token claim |
| 7 | A counter-staff principal whose token says `role: "head_of_operations"` is refused identically — nothing branches on that string (CLAUDE.md §2.9) |
| **8** | **THE CREDIT BOUND.** Counter staff, bounded `max_order_value_minor: "0"`, **refused** a CREDIT sale — and **allowed** the byte-identical cart for CASH, so the refusal is provably the bound and not a broken route. Outlet manager **allowed** at a server-priced 494,400 (≤ 500,000) and **refused** at 618,000, same role, same customer, same counter. The refusal message names **618000**, the server's own repriced total. Re-sent with `clientTotalMinor: "1"` it is refused against 618000 again — a till cannot talk its way under its own bound. Neither refused sale left an `app.sale` row: the whole transaction rolls back |
| **9** | **REPORTING.** Counter staff **refused** `reports.salesByLocation` (`report.view.location` absent); outlet manager **allowed** and told `network=false` over 1 location — a true total of what that caller may see, labelled as such; Accounts **allowed** with `network=true` over 25 — the widener held at the root. Outlet manager **refused** `reports.inventoryDays`, Accounts **allowed** — cost and margin are a narrower audience than takings |
| **10** | **LOW STOCK.** Counter staff **refused** `inventory.setReorderPoint`; outlet manager **allowed**. Counter staff then **allowed** `inventory.lowStock` at their own outlet with a **non-empty** list (a vacuous empty list would prove nothing, so the check asserts ≥ 1 alert). Accounts **refused** — no `stock.view` at any scope, root included. The manager **refused** when narrowing the alert to an outlet outside their scope |

### What the credit drill demonstrates (`drill:credit`, **13/13** over HTTP) — NEW

`packages/wire-conformance/src/live-credit-drill.ts` (**D9**) is acceptance criterion 3, live.
Cash and credit sales rung at **two different outlets** by one regional-manager principal granted
once at REG-BONO; then the real read paths are asked what the customer owes. Measured figures in
§5.3. It carries its own honest verdict in the machine-readable result, so a report generator
cannot summarise it as a plain green tick: `facilityFee: "GATED — Q4 unconfirmed"`.

### Dead surface — exported, never called from production

Listed because "exported and tested" reads as "wired" and is not the same thing. None of these is
a security hole; all of them are API surface a reviewer could mistake for a control.

**Audited mechanically this pass** (`export const|function|type|interface` in every changed or
added non-test file, cross-referenced against every non-test file in the repo). Result: **every
new exported entry point of this pass reaches production code.** `reportsRouter` is mounted in
`routers/index.ts`; all five report schemas and `lowStockInput` are `.input()` of a live route;
`setReorderPointInput` likewise; `resolveLocationScope` is called by six routes across two
routers; `resolveGroupRollup` by one; `salePermission`/`SALE_PERMISSION` by `createSale`'s
middleware; `applyReorderPoints` by `inventory.ensureReorderPoints`. Nothing new is test-only.
Four residual notes, none of them defects:

- **The new routes have no CLIENT.** `reports.*`, `inventory.lowStock`, `inventory.reorderPoints`,
  `inventory.setReorderPoint` and `inventory.ensureReorderPoints` are reachable over HTTP and
  proven live (D8 checks 9 and 10), but `apps/web` calls **none** of them — grep confirms zero
  references. So `packages/contracts/src/reports.ts` is today a contract with **one** party: the
  "a disagreement is a `tsc` error" guarantee that justifies the package does not yet exist for
  these shapes, because there is no second importer to disagree. That is the HQ-reporting client
  work-package (§6 item 13), not a fault in what landed.
- **Nothing in onboarding calls `ensureReorderPoints`.** `applyReorderPoints` deliberately seeds
  thresholds only where the ledger already shows stock, so applying it at template time correctly
  seeds nothing — and `infra/scripts/bootstrap.ts` never calls it afterwards. A freshly
  provisioned tenant therefore has **zero** reorder points and **zero** low-stock alerts until a
  human calls the route. Correct behaviour, invisible default: verified live, where a clean
  `stack:reset` leaves `app.reorder_point` empty.
- **`app.reorder_point` is not in the PowerSync publication** (18 tables) and appears in no sync
  rule, so **the low-stock alert is online-only**. In an offline-first product that is a real
  limitation of the feature, not of its code — recorded as §6 item 14.
- **`REORDER_FRACTION_BP`** is re-exported from `@erp/db/seed` and used only inside
  `template.ts`. Harmless; noted for symmetry with `requireKnownCode` below.

- **`session.permissions` has no client.** The route works (verified live: a counter-staff bearer
  gets its 8 codes across 57 locations, including the `max_order_value_minor: "0"` bound). **The
  PWA never calls it.** So layer 3 — greying out the button a clerk must not press — does not exist
  yet: a clerk fills in the form and is refused *after* the customer has walked out. The
  architecture is explicit that layer 3 protects nothing, so this costs usability rather than
  safety, but the file's own header describes a behaviour the product does not have.
- **`assertPermission`** (`apps/api/src/permissions.ts`, re-exported from `trpc.ts` and
  `index.ts`) — **zero call sites**, in production or in tests. Every in-handler check written so
  far uses the synchronous `ctx.permissions.requireTenantWide(…)` against the middleware's
  snapshot, which is the better shape (it cannot open a transaction inside `runIdempotent`).
  Either delete it or use it; leaving both forms invites the wrong one.
- **`requireKnownCode`** — publicly re-exported, used only inside its own module.
- **`catalogueDrift`** and **`BRIEF_RESTRICTED_PERMISSIONS`** (`@erp/db`) — test-only. That is
  their stated purpose (drift detection and a test anchor), so this is a note, not a finding.

### Not yet done at the sync boundary

`app.user_location_scope` exists and is correct, but **`infra/powersync/sync_rules.yaml` still
scopes buckets from the token's `locs` claim, not from the table.** CLAUDE.md §2.6 is explicit that
sync rules are the authorization boundary, so until that swap lands, layer 1 is enforcing a *token
claim* while layer 2 enforces the *database*. They agree today because `dev-token.mjs` builds
`locs` from the same closure — but agreeing by construction is not the same as being one control.
That file is owned by another session this pass and was deliberately not touched; the swap is
tracked as §6 item 1.

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
  5 migrations → `powersync` publication (18 tables) → two dev tenants seeded from the
  construction-materials-gh template → **one dev principal per template role on each
  tenant** → PowerSync up. That last step is not optional: permissions are resolved
  from the database per request, and a tenant with roles but no assignments is a
  tenant nobody can use (§0).

### `packages/contracts` — 105 tests (4 files), build + typecheck clean
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
- `reports` (25) — **added by this pass.** `reports.ts` declares the five reporting inputs and
  `lowStockInput`; `inventory.ts` gains `setReorderPointInput`. The tests pin the rules that matter:
  every one is `.strict()` and refuses all three spellings of a tenant identity (CLAUDE.md §2.1);
  `locationIds` NARROWS and is capped; a reversed date range is REFUSED rather than normalised (a
  silent swap turns an operator's typo into a confidently wrong report); `stockReportInput` carries
  no date range at all, because on-hand is a position and an `asOf` that replays the ledger does not
  exist yet; and `setReorderPointInput` carries **no `uomCode`** — the threshold is denominated in
  the product's stocking unit, resolved server-side, so "reorder at 10" cannot mean bars to one
  caller and tonnes to the next (04 §4.4.1)
- `device-ops` (22) — the registry is exhaustive; every registered schema requires the idempotency
  key and refuses all three spellings of tenant identity; movement/credit money as strings; no
  `SALE` movement kind and no `FEE` entry kind on the device surface; the `/sync/token` shape

### `packages/wire-conformance` — 35 tests (4 files) + 2 live drills, typecheck clean
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
- `session-scope` (4) — the device reads the *same* location scope the API enforces, out of a real
  API-signed token: one location, many locations in the same order, and an empty claim scoping the
  device nowhere. The fourth pins the rule that matters — the client reads the claim **without
  verifying it**, and that is all it is trusted for; enforcement is the server's.
- **`drill:rbac` (D8, 30 live checks)** and **`drill:credit` (D9, 13 live checks)** — not vitest
  suites; `tsx` scripts against the deployed stack. D8 is the authorization matrix (§1a); D9 is
  acceptance criterion 3 (§5.3). Both mint real HS256 bearers for real `provisionPrincipal`
  principals and assert on real 403s and real Postgres rows.
- `sequence-client-to-api` (4) — **added by this merge**, and the reason §0's *Sequence reporting*
  ledger row could be closed rather than merely noted. PR #4's reconnect half was reachable from its own unit
  test and from no production module; the only way to prove it is wired is to drive the PWA's own
  `buildBlockReport` → outbox → `httpUploadTransport` → `sequence.syncBlock` → Postgres. Asserts
  the router parses the PWA's payload with the *same* `syncBlockInput` object the contract exports
  (identity, not shape-alike); that a real server block is carried back through the outbox result
  and the till then prints from it; and that a wiped cursor is detected on reconnect — old block
  `REGRESSION_BURN`ed, fresh block strictly above it, severity-1 review opened. The review's
  `required_permission` is asserted against the **catalogue** (`sync.conflict.review`), not against
  itself — the assertion PR #4 lacked, which is why its invented `sequence.review` code went
  unnoticed.

### `packages/sequence` — 14 tests (1 file), build + typecheck clean
**Receipt-number rendering and block arithmetic, shared by server and till so a number cannot be
formatted two ways.** Arrived with PR #4. Pure and dependency-free — which is what lets both the
Node server and the browser till import the one implementation.

- `format` (14) — three groups. **`renderNumber`**: the §3.7.5 template; a second tenant's format
  is *another value, not another code path* (§2.9 as an executable assertion); an unknown
  placeholder or a missing `{n}` slot raises at the counter rather than on a printed receipt; a
  number exceeding the declared width raises instead of silently wrapping; and it carries exactly
  past 2^53 — a receipt number is `bigint`, never a float64. **Emergency form**: the
  device-derived suffix, plus a discriminator so two emergency numbers from one device stay
  distinct — this is what lets a collision be stored on a unique number while `receipt_no_claimed`
  keeps the number the customer is actually holding. **Block arithmetic**: a block spans
  `[start, start+size-1]`, issues from the start, and is *spent* rather than wrapped at the end;
  replacement is requested by **days of observed throughput**, falling back to 20% only when the
  till has no history.

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

### `packages/db` — 99 tests (9 files), typecheck clean
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
- Human-facing document numbers are server-allocated blocks (migration 0005,
  03 §3.7.5): `sequence_counter` (row-locked, never synced, never rewinds),
  `sequence_block` (one live block per device by partial unique index; ranges
  never overlap at a location; `consumed_upto` **cannot regress** — the trigger
  refuses it), and `conflict_review` / `conflict_review_location` for the
  severity-1 queue. `sale.receipt_no_claimed` preserves what a customer's paper
  says when a collision forces the emergency form.
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

### `apps/api` — 233 tests (15 files), typecheck clean
Fastify + tRPC write path, now with the sync seam wired. Verified-token identity
(`tid` is the **only** source of tenant identity; roles are opaque tenant-defined
strings, never branched on), one idempotent pipeline over `app.write_log` with
server-stamped HLC, tax engine honouring `base_kind`/`base_includes`, seven tRPC
routers (provisioning, session, catalogue, sales, inventory, credit, sequence),
and two
plain Fastify sync routes beside the tRPC mount (`src/sync.ts`):

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
- `sales-rbac` (44) — **added by this pass.** The sale path's guard: the capability follows the
  TENDER through a TypeScript-total map (adding a tender without deciding its capability is a
  compile error), an unrecognised tender denies rather than defaulting to the weaker code, the
  credit bound is measured against the server's repriced total and not `clientTotalMinor`, and a
  refused credit sale leaves no sale, no stock movement and no credit entry
- `reports` (26) — **added by this pass.** Σ(per-location) = the independently aggregated total as
  an exact bigint identity (checked at runtime by the router itself, not only in the test);
  inter-location transfers inflate neither revenue nor COGS; the scope is the intersection and a
  requested out-of-scope location is REFUSED, never silently dropped; an empty scope DENIES rather
  than returning an empty report, because "you may see nothing" and "nothing happened" must not
  look alike; tenant isolation on every new read path
- `reorder-points` (16) — **added by this pass.** Migration `0007`: the threshold's unit is the
  product's stocking unit and the constraint trigger refuses a row that drifts from it; `is_low` is
  derived from the movement ledger, never a counter; a tenant-tuned threshold is never overwritten
  by a re-seed
- `sequence-regression` (26, was 20) — 03 §3.7.5 / conflict class #14: server block
  allocation from the tenant's own format (a location with no counter row is
  refused, never defaulted), the three regression shapes
  (`LOST_CURSOR`, `CONSUMED_UPTO_REGRESSION`, `UNKNOWN_BLOCK`), burn + reissue +
  severity-1 review naming the overlap range, stale reports deduplicated, the
  database refusing a regression directly, the collision landing path, and
  tenant isolation across all four new read paths

### `apps/web` — 265 tests (26 files), build (Vite + PWA) + typecheck clean
**Owned by another session during this pass and deliberately not touched.** Counts observed on
2026-08-21; the per-file breakdown below is the previous revision's and is now stale.
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
- `sequence` (13) — the till half of §3.7.5: numbers issued with no network on
  the path, cursor advancing in the *same* transaction that mints the number,
  exhaustion falling to the emergency form rather than stopping trading, a wiped
  device reporting "I hold nothing" truthfully, and adoption of a replacement
  block after a burn

### `packages/sync-drills` — the executable acceptance demonstrations
`pnpm --filter @erp/sync-drills drill` runs the **seven** Phase 1 drills against the
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
| **RBAC permission matrix** | *(Largely landed — 19 of 37 codes now have an enforcement site, and the sale path's bound is demonstrated live. What remains is the SYNC-RULE half.)* Roles are opaque tenant-editable strings and location scoping is enforced on every mutation. The sync rules carry documented **interim fail-closed mechanisms** until it lands: location scope from the signed `location_id` token claim (set server-side, never a client parameter; no claim → zero rows) instead of `user_location_scope`; the credit book **not synced at all** rather than ungated; `sale_line`/`sale_tax_line` in a tenant-scoped interim bucket pending the §3.11.10 denormalisation migration (tenant isolation intact, location narrowing not yet). Must land before the pilot. |

(The previous revision's "PowerSync cloud wiring" deferral is **done** — see §1 and §5.)

---

## 4. How to run everything

Prereqs: Node ≥ 20, pnpm 9 (`corepack enable`), Docker.

```sh
pnpm install                # from the repo root
pnpm build                  # turbo: tsc for @erp/money, Vite+PWA for @erp/web
pnpm typecheck              # all packages
pnpm test                   # all suites (807 tests, 63 files; PGlite suites take ~30s)
pnpm lint:money             # ADR-0004 money-type lint

# Per package (dependency order contracts → money → sequence → db → api → web → conformance):
pnpm --filter @erp/contracts test    # zod only; no db, no network, no wasm
pnpm --filter @erp/money test
pnpm --filter @erp/sequence test     # pure receipt-number rendering + block arithmetic
pnpm --filter @erp/db test           # hermetic — real DDL on PGlite, no external Postgres
pnpm --filter @erp/api test          # same harness, drives the tRPC routers + sync routes
pnpm --filter @erp/web test          # real SQLite via node:sqlite + jsdom for components
pnpm --filter @erp/wire-conformance test   # the PWA's real payload vs the API's real parser

# The real stack + acceptance drills (reproducible from nothing):
pnpm stack:reset                    # docker down -v → up → migrate → seed 2 tenants
pnpm --filter @erp/sync-drills drill  # 7 drills; spawns the API on :3001 if absent
pnpm --filter @erp/wire-conformance drill:live   # D6 alone, against the running stack
pnpm --filter @erp/wire-conformance drill:rbac   # D8 — 30 authorization checks over real HTTP
pnpm --filter @erp/wire-conformance drill:credit # D9 — acceptance criterion 3, 13 checks
pnpm dev:token --role counter_staff  # a bearer for a REAL provisioned principal;
                                    # refs: counter_staff, outlet_manager,
                                    # regional_manager, accounts, head_of_operations
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

All figures are from the POST-MERGE clean-slate run (2026-08-21,
`pnpm stack:reset` from a destroyed docker volume, then `drill`): **7/7 drills
PASS**, full log in `docs/sync-drill-report.md`. Both drills that neither branch
could run together are in it — D6 (the PWA's own payload end to end) and D7
(receipt-number regression, wipe mid-block, reissue). The run was performed
twice from a clean slate on
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

3. **Credit balance, ageing and facility fee across outlets — BALANCE AND
   AGEING DEMONSTRATED (D9); FACILITY FEE GATED. The criterion is NOT fully
   met, and the reason is a human decision, not missing code.**

   `pnpm --filter @erp/wire-conformance drill:credit` — **13/13 over real
   HTTP**, clean slate. One regional-manager principal granted **once** at
   REG-BONO rings four sales through the real router: at **OUT-01** cash
   247,200 + credit 370,800; at **OUT-03** cash 123,600 + credit 494,400.
   Then the real read paths are asked what the customer owes.

   *Balance — demonstrated.* `credit.exposure` answers **865,200 = 370,800 +
   494,400** as an exact bigint identity: the two credit sales, rung at two
   different outlets, both landing on the ONE tenant-level account. The
   **370,800 of cash trade at the same two counters is absent** — the check
   that a report which totalled *sales* instead of *entries* would fail, and
   that a suite ringing only credit sales could never catch.
   `availableMinor` = **4,134,800 = 5,000,000 − 865,200**. And it is
   **derived**: Σ(`app.credit_entry.amount_minor`) read straight out of
   Postgres equals the API's figure over 2 entries, tracing back to sales at
   **2 distinct locations**.

   *Ageing — demonstrated.* At 16 days past a 30-day due date both charges age
   as **separate invoices** (`dpd=[16, 16]`, bucket `1-30`,
   `agedBy=days_past_due`) and **Σ(buckets) = 865,200 = the balance, exactly**
   across 5 buckets. The same account read one day after the sale is
   `current` (`dpd=[-29, -29]`) — ageing moves with the as-of date, not with
   the clock. A payment applied to the **OUT-01** charge clears that invoice
   and leaves OUT-03 aged where it was (1 invoice, outstanding **494,400**),
   with balance and buckets both falling by exactly the amount paid and still
   agreeing. That last check is the sharp one: if the two outlets' sales were
   aged as one lump it would move both or neither.

   *Facility fee — VISIBLE, PROVISIONAL, AND CORRECTLY REFUSING TO POST.*
   `previewFacilityFee` answers in shadow mode with
   `provisional=true`, `label="provisional — not chargeable"`,
   `totalDeltaMinor=5273` over 1 accrual. `accrueFacilityFee` answers
   **HTTP 412 `FEE_POLICY_UNCONFIRMED`** and the account carries **zero**
   `FEE` entries. The gate holding is the correct behaviour and a silent
   posting would be the bug — so what is demonstrated is *"the fee is visible
   and refuses to be chargeable"*, **not** *"the fee is correct"*.

   **What remains, precisely.** (a) **Q4 is `NEEDS-HUMAN`**: until a qualified
   accountant confirms the five fee decisions (D-1..D-5), every fee figure is
   provisional and nothing may be billed — §6 item 5. (b) The policy store is
   still in-memory pending its `app.credit_policy` migration. (c) **These reads
   are ONLINE.** `app.credit_entry` is deliberately absent from every sync
   bucket (fail-closed), so a partitioned outlet cannot see a balance at all —
   and in an offline-first product "visible" has to mean visible from the till.
   The criterion's first two clauses are demonstrated; the third is gated and
   the offline half of "visible" is not built.

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

1. **THE SALE PATH — CLOSED 2026-08-21.** Kept here, at the top, because it was the previous
   revision's single most important gap and because the shape of the fix is the record.

   *What was wrong.* `sales.createSale` was a bare `tenantProcedure`. Any valid tenant bearer
   could record a cash or credit sale at any location in its `locs` claim, with no capability
   check and **no enforcement of the `sale.record.credit` bound**. The template's "credit sales up
   to a limit" (counter staff `"0"`, outlet manager `"500000"`, regional `"2000000"`) was data
   nothing read. A counter clerk could open unbounded credit exposure.

   *What landed.* `.use(requiresPermission({ code: salePermission, at: 'input' }))`, declared
   **after** `.input()` so both the location and the derived capability come from a payload zod
   has already validated. The capability follows the **tender** — platform vocabulary, a closed
   `z.enum(['CASH','CREDIT'])` in `@erp/contracts` — through
   `SALE_PERMISSION: Record<SaleTender, PermissionCode>`, which is TypeScript-total over the
   contract's union: adding a tender without deciding its capability is a **compile error**, not a
   sale that silently needs nothing. `salePermission()` returns `undefined` for anything
   unrecognised and the middleware turns that into a refusal — never a default, never the weaker
   code. Inside the plan, once the pipeline has repriced,
   `ctx.permissions.requireWithinAmount('sale.record.credit', input.locationId, total)` checks the
   bound **against the server's own total**, synchronously against the snapshot the middleware
   already resolved (so it opens no second transaction inside `runIdempotent`). `sales.get` and
   `sales.recomputeCheck` take `sale.view` in two steps.

   *How it is known to work.* Not by the 44 new unit tests — those would have passed against a
   harness that grants `owner` by default, which is how this project has been fooled eight times.
   By **D8 checks 8a–8g over real HTTP**: counter staff refused a credit sale and allowed the
   identical cart for cash; outlet manager allowed at 494,400 and refused at 618,000; the refusal
   naming **618000**, the server's figure; the same cart re-sent claiming `clientTotalMinor: "1"`
   refused against 618000 again; and neither refused sale leaving an `app.sale` row behind.

   *Still open in the same package:* `provisioning.applyTemplate` needs a decision recorded either
   way about `admin.template.apply`, and `catalogue.*` still never checks `catalogue.view`.

2. **Price override has no path — and therefore no check.** The good news, stated
   precisely so nobody mistakes it for the item above: `createSale` never accepts a
   price. A line carries `productId` and `qty`; the server resolves the unit price
   from the tenant's price list. There is no override object, no
   `UPDATE sale_line SET unit_price` endpoint, and D6 already proves the server's
   figure wins over the till's claim (`server=9001 till=29700`). So the brief's
   *first* hard prohibition holds **structurally** today. `sale.override_price`
   exists in the catalogue guarding nothing, and the moment an override field is
   added it must be wired to it — that is the one place a future change silently
   breaks a guarantee that currently holds for free.

3. **The credit-limit column has no database-level backstop.**
   `02-security-and-access-control.md` §2.4 specifies that
   `customer_account.credit_limit_minor` is protected by a column-level `REVOKE` on
   `app_rw` **and a trigger that raises**. Neither exists. Today the only writer is
   `credit.openAccount`, which *is* gated on `credit.limit.change` (verified live,
   D8 check 2) — so the prohibition holds, but it holds on one application check
   with no defence in depth underneath it. A second writer added later would
   silently bypass it.

4. **Sync rules still scope from the token claim, not `app.user_location_scope`.**
   CLAUDE.md §2.6: sync rules are the authorization boundary. The table exists and
   is correct; `infra/powersync/sync_rules.yaml` does not yet read it, and that file
   was owned by another session this pass. Also outstanding from the original entry:
   the §3.11.10 `sale_line` denormalisation so lines join the per-location bucket.
5. **Credit policy migration + Q4 human gate** — move the in-memory
   `credit-policy` store into the effective-dated `app.credit_policy` migration,
   and obtain the accountant's confirmation of the five fee decisions. Until
   then every fee figure is provisional and the accrual fails closed.
6. **Q8 document model** — Ghana e-VAT invoice issuance/clearance decision
   (`NEEDS-HUMAN`); the capture-side seam is built and marked.
7. **Receipt-printing spike** — blocked on the thermal-printer hardware decision.
8. **Real-device trial** — representative low-end Android tablets against this
   stack: OPFS persistence, worker behaviour, sync performance under field
   latency (the 60s budget was met at p95 212ms on localhost; the field number
   is the one that matters).
9. **Receipt-number regression (03 §3.7.5, conflict class #14) — CLOSED
   2026-08-21.** Owner: `sync-architect`. Recorded here as the gap; this is
   what landed.

   *The defect.* Every block was self-issued by the device, so a device whose
   local database was wiped mid-block (OPFS eviction, PWA reinstall on the same
   enrolled device) restarted its cursor and reissued numbers it had already
   printed. `sale_receipt_uq` rejected the second sale with a raw
   `INTERNAL_SERVER_ERROR: duplicate key value violates unique constraint`,
   which `classifyRejection()` in `apps/web/src/data/sync/upload.ts` classes
   RETRYABLE — so the op retried forever, the outlet's outbox never drained,
   and the till went dark for uploads while looking merely "stuck".
   Reproduced before the fix by uploading two sales carrying the same
   `receiptNo` under different idempotency keys.

   *Neither cheap answer was taken.* Mapping the constraint violation to
   `BAD_REQUEST` dead-letters a real sale with the cash already in the till —
   the loss path §3.3.4 exists to prevent. Renumbering silently hands a
   customer a number another customer already holds and tells nobody.
   `classifyRejection()` is therefore **unchanged**: the fix is upstream, and
   nothing on the drain path became more willing to discard a write.

   *What landed.* Migration `0006_app_sequence_and_review.sql` adds
   `app.sequence_counter` (server-side, row-locked, never synced, cannot
   rewind), `app.sequence_block` (one live block per device; ranges never
   overlap at a location; a trigger **refuses** a `consumed_upto` regression,
   so the application cannot paper over one), `app.conflict_review` +
   `app.conflict_review_location`, and `app.sale.receipt_no_claimed`.
   `sequence.syncBlock` (`apps/api/src/routers/sequence.ts`) is the reconnect
   conversation: it detects the regression, burns the remainder of the block,
   issues a fresh one and opens a **severity-1** review naming the overlap
   range. A collision that already happened lands under §3.7.5's emergency
   form with the printed number preserved and its own severity-1 review, so
   the outbox drains. `packages/sequence` renders numbers for the server, the
   device and the drills from ONE implementation. Drill **D7** proves the whole
   path against the real stack with a genuine sqlite-file wipe. (It was written
   as D6 and renumbered on merge: D6 is the drill that runs the PWA's OWN
   payload end to end, and neither drill covers the other's hole.)

   *Two deliberate scope limits, both stated rather than hidden.* (a) §3.7.5's
   low-water **reserve block** (ask at 20% / a few days' throughput and hold a
   spare) is not implemented: a device holds exactly one live block, and a
   block that runs out mid-partition falls to the emergency form, which is the
   behaviour §3.7.5 already specifies for that case. The reserve makes it
   rarer; it does not affect regression detection. (b) `conflict_review` is
   §3.6.2's shape minus the `conflict_classes` registry, the escalation-step
   chain and the notification channels — those arrive with the credit-limit
   classes. The RBAC permission tables that route the queue DO now exist
   (migration `0005_rbac_permissions.sql`), so `required_permission` is the
   catalogued `sync.conflict.review` rather than the uncatalogued
   `sequence.review` this work-package invented for itself; until the queue's
   own read path lands, reviews are read online (fail-closed) and `escalate_at`
   is a flat 24h. (c) **The reconnect report has no trigger in the shipped
   PWA.** Adoption is wired — `powersync.ts` drains with
   `onResult: sequenceResultHandler(db)`, so an acked report becomes the block
   the counter prints from — but nothing yet calls `enqueueBlockReport` when
   the radio comes back, so in the app as shipped no report is queued. Both
   halves ARE exercised end to end by
   `packages/wire-conformance/test/sequence-client-to-api.test.ts` (hermetic,
   every `pnpm test`) and by drill D7 (real stack, real socket, real wipe); what
   is missing is the counter-side trigger, which belongs with the reconnect UX.
   Until it lands, a device that is wiped keeps trading on self-issued,
   device-tagged numbers — visibly exceptional and un-collidable — and the
   server learns about it on the first report anyone queues. Listed here rather
   than left to be discovered: this is exactly the shape of §0's ledger.

10. **Three of the five uploadable ops have no client at all.** `sale.create` is now
   proven end to end from the PWA's own code. `stock.record_movement`,
   `credit.open_account` and `credit.record_entry` are reachable on `/sync/upload`
   and are exercised with contract-shaped payloads (`outbox-surface.test.ts`), but
   **no PWA builder exists for them**, so there is nothing on the client to test
   and the counter cannot record a stock adjustment or a credit transaction
   offline. The declarations are now shared, and `outbox-surface.test.ts` fails the
   moment `apps/web` grows a second uploadable kind without a conformance test for
   it — but until those builders are written, "the write path works" means the sale
   path works.

11. **The conformance suite proves shape and effect, not the counter's UI.** It
   drives `checkout()` and the outbox directly; nothing in it renders a React
   component or clicks a button, and no test in this repository drives the PWA in a
   real browser. A regression in the counter screen that never reaches
   `checkout()` would still pass everything green above. Playwright against the
   built PWA is the missing layer, and it belongs with the real-device trial (#5).

12. **Tenant #1's best-ranked price list is tax-inclusive, and nothing can ring
   it.** Surfaced by wiring device price-list provisioning (§0, row 5). The device
   now resolves its default from the tenant's own configuration —
   `price_list.priority` ("low wins"), `.location_id`, effective window — which for
   tenant #1 settles on `RETAIL` (priority 10, `is_tax_inclusive = true`). Neither
   side can price it: `sales.createSale` answers `PRECONDITION_FAILED:
   tax-inclusive price lists are not yet supported`, and the counter's own
   `lineNetMinor` (@erp/money) has no tax-extraction path either, so its local
   total would be wrong too.

   The client therefore **refuses at the till** with that reason rather than
   binding the list (`status: 'unsupported'`,
   `apps/web/src/data/session/device-price-list.ts`). Falling through to
   `WHOLESALE` was rejected deliberately: it would charge every walk-in customer
   off a list the tenant did not choose for them, silently, all day.

   **The dev stack no longer reproduces this, and that is worth knowing.**
   `infra/scripts/bootstrap.ts` now flips `RETAIL` to tax-EXCLUSIVE after
   seeding and says so loudly on every run
   (`DEV FIXTURE: made RETAIL tax-EXCLUSIVE so a counter can ring them.
   Neither the client nor sales.createSale can price a tax-inclusive list yet;
   the shipped template is unchanged`). The shipped template
   (`packages/db/src/seed/template.ts`, `inclusive: true`) really is unchanged,
   so the blocker is intact for a real tenant — but **no drill can rediscover
   it**, because every live drill runs against a stack where the condition has
   been fixtured away. It is announced rather than hidden, which is the right
   call; recorded here so nobody reads "7/7 drills pass" as evidence that
   tenant #1 can ring a retail sale. It cannot.

   Verified on the live stack in the previous pass: a device provisioned from a real
   `dev-token` bearer resolves `RETAIL` and blocks; with `RETAIL` out of scope it
   resolves `WHOLESALE`, ships `priceListCode: 'WHOLESALE'`, and the API **applies**
   the sale (`PLVERIFY-651564`, server-priced 5000 net + 1000 tax = 6000). So the
   provisioning path is proven end-to-end; **exact tax extraction from inclusive
   shelf prices is the blocking work-package** before tenant #1 can ring a retail
   sale at all. It is the POS pricing package, and it is a Phase 1 blocker, not a
   deferral.

13. **The new reporting and alert routes have NO CLIENT.** `reports.salesByLocation`,
   `stockOnHand`, `cashPosition`, `inventoryDays`, `distributionCost` and `inventory.lowStock` /
   `reorderPoints` / `setReorderPoint` / `ensureReorderPoints` all work and are all guarded —
   proven live in D8 checks 9 and 10 — and **`apps/web` calls none of them**. HQ reporting
   (criterion 4) is demonstrated at the database and the API; there is no screen. Two consequences
   worth naming rather than discovering: `packages/contracts/src/reports.ts` currently has ONE
   importer, so the "a shape disagreement is a `tsc` error" guarantee that justifies the contracts
   package does not yet apply to these shapes; and the moment a client is written it must be
   written against those exports, not against a second hand-rolled shape — which is precisely how
   §0's second row happened. `apps/web` was owned by another session during this pass and was
   deliberately not touched.

14. **The low-stock alert is ONLINE-ONLY.** `app.reorder_point` (migration `0007`) is not in the
   PowerSync publication (18 tables) and appears in no sync rule, so a partitioned outlet — the
   condition this product exists for — cannot see its own low-stock list. Phase 1 lists "low-stock
   alerts" under core operations and §2.2 says every location must trade fully offline. Adding the
   table to `PUBLICATION_TABLES` and a per-location bucket is small; it is listed because it was
   not done, not because it is hard.

15. **Nothing in onboarding seeds a reorder point.** `applyReorderPoints` correctly seeds nothing
   at template time (thresholds exist only where the ledger already shows stock) and
   `infra/scripts/bootstrap.ts` never calls `ensureReorderPoints` afterwards. A freshly provisioned
   tenant therefore has zero thresholds and an always-empty alert list until a human calls the
   route — verified on a clean `stack:reset`, where `app.reorder_point` is empty. The seeded level
   is also `REORDER_FRACTION_BP` = 25% of opening stock, flagged `needsFounderReview` and labelled
   `[NEEDS-FOUNDER]` in the row's own notes, which is honest but means the pilot's first alert list
   is a template guess until the founder tunes it.

16. **One unexplained authorization refusal, observed once, not reproduced.** During a clean-slate
   run in the sequence *reset → sync drills → RBAC drill*, `inventory.recordMovement` answered
   `403 PERMISSION_DENIED: stock.receive is not held by this user` for a freshly provisioned
   outlet-manager principal that demonstrably held the code — the same principal had succeeded on
   six earlier calls in the same run, and `app.effective_permission` for that user id showed
   `stock.receive` at 2 locations afterwards. It did not recur in four subsequent runs of the same
   sequence, and a deliberate probe of **144 concurrent guarded writes** as one principal produced
   **zero** spurious denials, so there is no evidence of a pooled-connection GUC leak. Recorded
   rather than dropped: an authorization check that answers "not held" for a principal who holds it
   is the wrong direction to hand-wave, and the next person to see it should find this note rather
   than start from nothing.

17. Smaller but real: auth is a dev-grade HS256 flow (shared dev secret, static
   bearer in the PWA env) — the real login/credential flow is §8.2 work;
   `pnpm build` warns at ~600 kB main bundle (code-split before pilot).

None of these gaps is hidden in a passing test suite: everything green above is
green because the thing it tests genuinely works in the tested environment, and
everything not yet demonstrable is listed here. §0 is the standing correction to
the habit that produced the last two bugs — a green suite is evidence about the
paths it actually traverses and about nothing else.
