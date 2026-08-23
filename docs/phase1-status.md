# Phase 1 status — integration & QA report

**Date:** 2026-08-22 (independent QA verification of the CREDIT ACCOUNT client
— opening an account, changing a limit, recording a repayment) · **Author:**
QA engineer

> **This revision (the credit-client verification pass).** `credit.openAccount`
> and `credit.recordEntry` had no client at all; they now do, and this pass
> verified it rather than accepting the build report. Three results worth the
> headline:
>
> - **The capability is real and reachable.** Three forms behind operable
>   controls under the `credit` nav entry, every production call site traced to
>   a button a person can press — §6 item 10.
> - **The arithmetic holds against an independent computation.** Balance
>   re-derived in SQL by the drill: **1,300,000**, matching the API exactly;
>   Σ(ageing buckets) equals it; the paid-down invoice ages separately from the
>   untouched one.
> - **Ledger row 16 does not recur here, and that is mutation-tested rather
>   than asserted.** The whole credit read surface is `meta`-free; injecting one
>   raw `Date` turns the sweep red on a `200` response.
>
> **Criterion 3 is reassessed and still NOT signed off** (§5). Balance and
> ageing are met; the facility fee is gated on a human decision (Q4); and
> "visible" is met online but **not** offline — which in an offline-first
> product is missing code, not a formality.

> **What changed in this revision.** The reporting, low-stock, stock-adjustment
> and credit routes finally have a CLIENT — §6 items 10, 13 and 14 of the
> previous revision. Three things were verified rather than assumed:
>
> 1. **`packages/contracts/src/reports.ts` now has a SECOND IMPORTER, and the
>    drift guarantee is demonstrated, not asserted.** `apps/web/src/data/api/reports.ts`
>    imports the five report schemas from the contract. Renaming `from` to
>    `fromDate` in the contract breaks `apps/web`'s compile at **four production
>    call sites in `Reports.tsx`**. That guarantee did not exist last revision.
> 2. **A new live drill, D10 (`drill:client`), 30/30 over real HTTP** — the
>    client's OWN api modules against the deployed API, with the client's
>    figures compared to Postgres rather than to a fixture.
> 3. **The three offline-honesty rules were mutation-tested.** Each was broken
>    deliberately; each turned the right test red. Details in §0a.
>
> **Two new §0 ledger rows (10 and 11)**, both found by running things rather
> than by the suite — one of them a suite that had silently EXPIRED.

**Verdict from the previous revision (the merge pass), kept for the record:**
two independent work-packages are now one tree. From `origin/main`:
the `@erp/contracts` shared wire contract, RBAC enforcement resolved per request
from the database, device price-list provisioning, and the wire-conformance
suite. From PR #4: receipt-number regression detection — server-allocated
blocks, burn-and-reissue on reconnect, the conflict-review queue, and the
collision landing path that stops the outbox wedging.

**Verification for the CREDIT-CLIENT pass (2026-08-22, latest).** The whole
workspace builds, typechecks (**12/12** turbo tasks) and every suite passes.
Re-run with `--force`, **0 cached of 19 tasks**, so these are measured and not
replayed from a turbo cache:

| Package | Tests | Files | Baseline | Δ |
|---|---:|---:|---:|---:|
| `@erp/contracts` | **118** | 5 | 118 | — |
| `@erp/money` | **56** | 4 | 56 | — |
| `@erp/sequence` | **14** | 1 | 14 | — |
| `@erp/db` | **132** | 10 | 132 | — |
| `@erp/api` | **380** | 19 | 367 | **+13** (`credit.test.ts`, `setLimit`/`accountForCustomer`) |
| `@erp/wire-conformance` | **90** | 9 | 72 | **+18** (`credit-client-to-api` 18) |
| **non-web total** | **790** | **48** | 759 | **+31** |
| `@erp/web` | **556** | 44 | 536 | **+20** (`credit-repayment`, `credit-ui`, `credit-api`) |

**1,346 tests, 92 files, 0 failures** (was 1,295). **No baseline went down**;
every delta is additive, and there is no `.only`/`.skip`/`.todo` anywhere.
`node tools/lint-money.mjs` is clean. The vocabulary conformance test walks the
whole of `apps/web/src` recursively, so it covers all ten new feature files;
an independent grep for a currency glyph or tenant #1 vocabulary across
`features/`, `data/api/`, `data/queries/` and `data/mutations/adjustStock.ts`
returns nothing.

Live, against the deployed stack (API on :3001, docker Postgres on :5433) —
**all re-run in this pass, on an API restarted from THIS tree after killing a
stale listener on :3001**, because a dev server on older code is how this
project has been fooled before:

| Drill | Result | What it covers |
|---|---|---|
| `sync-drills` D1–D7 | **7/7** | partition, convergence, idempotency, isolation, receipt-number regression |
| `drill:rbac` (D8) | **30/30** | every refusal paired with a positive control |
| `drill:credit` (D9) | **13/13** | criterion 3 at two outlets |
| `drill:client` (D10) | **30/30** | the client's own api modules vs Postgres |
| `drill:procure` (D11) | **56/56** | procurement, the approval money bound |
| `drill:q1` (D12) | **32/32** | distribution cost, the trading-day assertion |
| `drill:counter` (D13) | **47/47** | the counter clients |
| `drill:credit-client` (D14) | **18/18** | the credit client, as built |
| **`drill:credit-verify` (D15)** | **33/33** | **NEW — independent QA verification of the credit client** |

**259 live checks over real HTTP, 0 failures.** Nothing regressed. D15 is this
pass's own drill and deliberately shares no assertions with D14: it re-derives
every figure in SQL, sweeps the credit read surface for a superjson `meta`
envelope (ledger row 16), and pairs every refusal with a positive control.
`node tools/lint-money.mjs` is clean.

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

**A green suite has now failed SIXTEEN times to notice that a written path had never been executed,
or had never been executed under the conditions the field imposes — and once, a green suite silently
STOPPED BEING GREEN for a reason unconnected to anything it tests.**

> **This ledger is the project's, not Phase 1's, and it lives here — one place, current.**
> Rows 12–14 were added by the **Phase 2 verification pass (2026-08-22)**; row 15 by the **Q1
> verification pass (2026-08-22, later the same day)**; **row 16 by the wiring-verification pass
> (2026-08-22, later still)**. The Phase 2 report is `docs/phase2-status.md`, which points here
> rather than keeping a second copy.
> **Rows 12, 13, 14 and 15 are now CLOSED and are marked so in place — the row stays, because the
> ledger is a record of how the suite failed, not a to-do list. Row 16 is CLOSED in the same pass
> that opened it, and it is the most instructive row in the table: the capability was WIRED to a
> screen, the route answered `200`, and the PWA still could not read a word of the reply.**
>
> **The credit-client verification pass (2026-08-22, latest) added NO row, and that is a finding
> rather than a silence.** It looked for one in the three places this table says to look, and
> reports what it found: (a) an import-graph walk over every export of the new credit client —
> **no dead export**, the three with no outside caller are composed by `fetchCreditPosition`;
> (b) a **row-16 meta-envelope sweep of the whole credit read surface** — clean, and
> *mutation-tested* so the clean result means something (§5 criterion 3); (c) every figure
> re-derived in SQL by the drill instead of re-read from the API — agreeing exactly. The count
> stays at **sixteen**. The one defect this pass did find was in the verification apparatus, not
> the product: a D12 summary line narrating a fact that row 15 had already closed — recorded at
> §6 item 10, deliberately not given a row, because no capability was broken.
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
| **The conformance suite EXPIRED (this pass)** | `packages/wire-conformance/test/sale-client-to-api.test.ts` — the file whose whole job is to catch the client-payload bug class — went from **19/19 green to 12/19 red with no code change**. Every till instant in it was a hard-coded literal (`'2026-08-21T09:00:00.000Z'`). `apps/api/src/pipeline.ts` clamps a claimed HLC at ±24h of the server clock and refuses beyond it with `CONFLICT: CLOCK_RESYNC_REQUIRED` **before the payload is ever parsed**. At 25.67h old the suite began failing on the clock. | 19/19 PASS, the day before | Nothing was wrong with the code and nothing tested the test. This is the ledger's inverse: not an unexecuted path, but a guard that stops guarding on a calendar boundary, with a red message pointing at the clock instead of at the payload — and the tempting repair is to relax the very assertion that catches the bug. Found by running the full suite, not by reading. |
| **The client's api layer could not be conformance-tested at all (this pass)** | `apps/web/src/data/api/client.ts` reads `import.meta.env`. `packages/wire-conformance` — the ONLY package that may import both trees, and therefore the only place the new client reads can be driven against the real API — declared `"types": ["node"]`, so importing that module was a `tsc` error. Every new client read path (`reports.*`, `inventory.lowStock`, `credit.*`) was structurally unreachable from the one harness that could prove it. | green: `pnpm typecheck` passed 12/12, because nothing tried to import it | The module compiled fine inside `apps/web`, which declares `vite/client`. Nothing failed until this pass actually attempted the import. A layer that cannot be reached by the conformance package is a layer that will only ever be tested against itself — which is this table's one root cause, stated below. |
| **The outbox is ordered to the MILLISECOND, and no further (Phase 2 pass) — CLOSED by the Q1 pass** | `readPendingOps` is `ORDER BY created_at ASC, id ASC`. `created_at` is an ISO string at millisecond resolution, and `apps/web/src/lib/uuidv7.ts` has **no monotonic counter inside a millisecond** — bytes 6..15 are pure randomness. Two outbox writes made in the same millisecond therefore upload in a **random relative order**. Observed live: two delivery status moves (`PLANNED→DISPATCHED`, `DISPATCHED→DELIVERED`) recorded back to back, and the second arriving first: `CONFLICT: PLANNED -> DELIVERED is not a legal delivery transition`. `classifyRejection` calls that retryable, so the op stays pending and lands on the next drain — **nothing is lost, and it self-heals** — but "strictly in queue order" (upload.ts) and "a cursor report queued before a batch of sales must reach the server before those sales do" (upload.ts, contracts/upload.ts) are properties the comments assert and the code does not have. | `delivery-client-to-api.test.ts` green, 43 tests | The conformance test stamps every op with `tillClock(n)` — a controlled clock that hands each write a **distinct** instant. The tie the field produces cannot occur there. This is the table's root cause wearing new clothes: the harness supplies a guarantee the world does not. Found by running D11 three times, not by reading. D11 now pins both instants **identical on purpose** so the tie happens every run, and asserts CONVERGENCE rather than first-pass order. **CLOSED:** `apps/web/src/data/sync/queue-seq.ts` adds `outbox.queue_seq`, a strictly increasing integer stamped inside the same local write transaction as the INSERT, and `OUTBOX_QUEUE_ORDER` is the one ordering expression the drain and every reader share. All five outbox INSERT sites stamp it (`checkout`, `adjustStock`, `recordGoodsReceipt`, `updateDeliveryStatus`, `sequence.enqueueBlockReport`) — verified by grep, not assumed. **Demonstrated live, D12 F1: six consecutive runs, two ops written at a pinned-identical instant (`created_at` tie observed 6/6), applied 2/2 on the FIRST drain pass with 0 rejected every time, delivery DELIVERED every time.** A monotonic uuidv7 would NOT have fixed it and the module says why: an op's id is minted when its work begins (a sale's id is its cart's), not when it is queued. |
| **A 2,009-line money router with no API test suite (Phase 2 pass) — FOUND AND CLOSED** | `apps/api/src/routers/procurement.ts` — ten procedures, every purchase-order price and rounding, and `ctx.permissions.requireWithinAmount('purchase.order.approve', …)`, the money bound that decides who may commit the business to a spend — has **no file in `apps/api/test/`**. Nothing under `apps/api/test/` references `procurement.` at all. The bound had no test **anywhere** in the repository until this pass demonstrated it live (D11 2i–2m). CLAUDE.md §2.7 category 1 says a money function is not done without one. | `@erp/api` 309/309 PASS, `@erp/db` 132/132 PASS | The coverage that exists is beside the router, not on it: `packages/db/test/procurement.test.ts` tests the SCHEMA and the template's separation of duties; `apps/web/tests/procurement-api.test.ts` tests the CLIENT against a mocked `fetch`; `packages/wire-conformance/test/procurement-reads-client-to-api.test.ts` drives the READS only. Three suites around a router, none through it. A count of tests is not a map of what they cover. **Closed in the same pass:** `apps/api/test/procurement.test.ts`, 21 tests through the router's own surface — the bound above/at/refused-writes-nothing with an unbounded positive control, the bound measured against Σ(lines) that no caller supplies, half-up rounding once per line and never on the sum, separation of duties both directions, the state machine, key idempotency, and six two-tenant read-path checks. It reads the bound out of `role_permission.bound` rather than stating one. **Q1 pass:** the file is now **42 tests** — `updatePurchaseOrder`, which had no client and no test, gained 21 covering the permission at the order's OWN deliver-to location, the DRAFT-only line window, repricing on amendment, the bound measured against the AMENDED total, and two-tenant refusal holding the very same capability. `apps/api/test/distribution-cost.test.ts` (new, 616 lines) does the same for the route that answers Q1, including its own two-tenant block. **The route still has no client** — see row 15's shape and `phase2-status.md` §5. |
| **Three client exports nothing calls (Phase 2 pass) — CLOSED by the Q1 pass** | `fetchDelivery` (`data/api/logistics.ts`), `recentDeliveryUpdates` (`data/queries/procurement-outbox.ts`) and `clearTakeDown` (`data/queries/takedown.ts`) are exported production functions that **no screen calls**. `recentDeliveryUpdates` is referenced only by its own test; `clearTakeDown` by nothing at all. Small, harmless today — and the exact shape of rows 3, 5 and 6 above. | `@erp/web` 480/480 PASS | Same mechanism as the `writeActivePriceListId` row: a unit test imports the module directly, so "does anything call this?" is never asked. Found by an import-graph walk over `apps/**` and `packages/**` excluding tests, not by the suite. **CLOSED:** all three now have a production caller — `fetchDelivery` and `recentDeliveryUpdates` at `features/deliveries/Deliveries.tsx:687` and `:661`, `clearTakeDown` at `features/receiving/Receiving.tsx:945`. Re-walked in the Q1 pass over every export of the nine new client modules: the only remaining unreferenced-outside-their-own-file exports are `buildReceiptPayload`, `buildDeliveryStatusPayload` and `CONFIG_KEY_TAKEDOWN`, each used inside its own module and imported by its own test — exported for testability, not dead. |
| **A period key that no screen can assert (Q1 pass) — CLOSED by the wiring pass** | `planDeliveryInput.businessDate` is the trading day the whole distribution-cost ratio divides revenue by. Migration `0010`'s header argues at length for it: a device clock must never move freight across a month end. The server implements all three arms — `businessDate ?? plannedFor ?? serverDate`, recording `business_date_derived_from` as NULL / `'PLANNED_FOR'` / `'ROW_CREATED'` — and `logistics.haulageSpend` and `reports.distributionCostRatio` both publish the per-basis counts. **No screen in `apps/web` ever sends the field.** `features/deliveries/Deliveries.tsx:371` calls `planDelivery` with `plannedFor` and nothing else, and there is no route to amend a delivery's trading day afterwards: `updateDeliveryStatusInput` does not carry one and no `logistics.update` exists. So in the PRODUCT the primary arm is unreachable and a trading day, once written, is uncorrectable. | `@erp/web` 506/506, `@erp/api` 367/367, `@erp/contracts` 118/118, D11 56/56 — and D12's own B3 PASSES, because the drill supplies the field the product cannot | Exactly rows 3, 5, 6 and 14 again: a contract field, a server implementation and a database column, all correct, all tested against each other, with no production caller between them. The unit tests construct the input themselves, so "does a screen ever build this?" is never asked. Found by driving the field live and then asking who else does — `grep businessDate apps/web/src/features` returns nothing on the delivery path. **Not a wrong number today:** both fallback arms are trustworthy dates (a human-typed `plannedFor`, or the server's transaction date), and D12 H1 pins the invariant that matters — **zero** rows written since `0010` carry `DISPATCH_CLOCK`. The exposure is a delivery entered days late with no `plannedFor`, which silently books to the entry date with no way to correct it. **CLOSED:** `features/deliveries/Deliveries.tsx:377-379` holds the trading day in state, defaults it to the SERVER's own precedence (`plannedFor` when there is one, else today AT THE LOCATION'S timezone — never the tablet's), renders it as an editable date field at `:519-525` with a note at `:527` that says out loud which day the freight will count against and that it cannot be changed afterwards, and sends it **always**, never leaving it to a fallback (`:416`). **Demonstrated live, D13 D1–D12 (47/47):** a load planned through the client with `businessDate` five days back, `plannedFor` two days forward and the entry date today — three distinct days, so no fallback arm can pass by coincidence — lands with `business_date = 2026-08-17` and `business_date_derived_from = NULL` (ASSERTED); the Q1 ratio counts it in the asserted day's period and Postgres confirms it is in NEITHER fallback window; a DISPATCH through the outbox does not move it; and `periodBasis.datedByAssertion` rises while `datedByDispatchClock` stays at zero. |
| **A route that was WIRED, answered `200`, and was still unreadable by the product (wiring pass) — FOUND AND CLOSED** | `receiving.get` selected `gr.received_at` **uncast**. `pg` returns a JS `Date` for a bare `timestamptz`; tRPC's superjson serializer cannot carry a `Date` in plain JSON, so it annotated it in a sibling `meta` block; and `apps/web/src/data/api/client.ts:231-237` **deliberately REFUSES any envelope carrying `meta`** — "response carries an encoding this device cannot apply" — because silently dropping an annotation and rendering the raw value is worse. So the server answered `200 OK` with a correct payload and the screen said it could not read the reply. The row type in the router declared `received_at: string`, which is why `tsc` never objected: **the annotation was the lie, not the code**. Every other timestamp on the wire is cast — `logistics.ts:732-733,1048-1049` does `new Date(x).toISOString()` — so this was one line out of step with a convention the codebase already had. | `@erp/api` **367/367**, `@erp/db` 132/132, `@erp/web` **536/536**, `@erp/wire-conformance` 69/69, D11 56/56, D12 32/32 — **every suite green, and the feature unusable** | The two suites that touch this route **cannot** see it, for opposite reasons. `apps/api/test/receiving.test.ts` (33 tests) calls the router **in process**: nothing is ever serialised, so no `meta` can exist. `apps/web/tests/procurement-api.test.ts` feeds the client's mappers **plain JSON somebody typed**: no `meta` can exist there either. Only a test that crosses the REAL serializer with the REAL mapper can see it — which is precisely what `packages/wire-conformance` is for, and it simply **had no case for either receiving read**. §0's one root cause, exactly: both sides tested against a third thing that agreed with neither. Found by driving the client's own `fetchGoodsReceipt` over a real socket in D13 — check B8 came back `malformed` — not by reading and not by any suite. **CLOSED:** the router casts in SQL (`to_char(... at time zone 'UTC', ...)`), and `receipt-client-to-api.test.ts` grew **three** tests that would have caught it: one asserting the client can DECODE the response and that `receivedAt` is a string, one asserting neither receiving read carries a `meta` key at the route itself, and one on the outstanding arithmetic. **Mutation-tested before being believed** — reverting the one-line cast turns them red with `expected [ 'json', 'meta' ] to not include 'meta'`. **The whole read surface was then swept**: all 25 tRPC read routes were driven live and checked for a `meta` envelope; `receiving.get` was the only one. |

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
- **A pin on the client's write surface.** `apps/web` can upload **six** kinds today
  (`sale.create`, `sequence.sync_block`, `stock.record_movement`, `goods.record_receipt`,
  `logistics.update_delivery_status` and — newest — `credit.record_entry`).
  `outbox-surface.test.ts` fails the moment another appears without a test that drives *its* real
  builder against *its* real parser. **It fired again on this pass**, the moment
  `WIRE_KINDS` grew `stock_movement → 'stock.record_movement'`: the adjustment builder landed and
  the pin went red saying "no test drives the client's own builder against the API's own parser
  for it". The answer was `stock-client-to-api.test.ts` (11 tests), not a wider allow-list — the
  third time in a row the tripwire has been paid for. That file records the movement under a REAL
  partition (the `fetch` REJECTS, as it does on a dead link), proves it is absent from the server
  while offline, drains it on reconnect, and asserts the row in Postgres; plus a byte-identical
  replay acked `duplicate`, a same-key-different-bytes resend REFUSED, and the two refusals that
  would WEDGE the ordered queue (unknown reason code, non-stocked product) — both of which
  `classifyRejection` classes retryable, which is why the builder narrows them away on the device.
- **Drill D8 — `pnpm --filter @erp/wire-conformance drill:rbac`.** Thirteen authorization checks
  over a real socket against the deployed stack: every refusal paired with a positive control on
  the same route with the same payload, so "denied" can never mean "the route is broken for
  everyone". It is the check that would have caught this pass's failure in one run.
- **Drill D10 — `pnpm --filter @erp/wire-conformance drill:client` (30 live checks).** The answer
  to ledger row 11, and to §6 items 13/14 of the previous revision. It drives the CLIENT'S OWN api
  modules — `data/api/reports.ts`, `data/api/inventory.ts`, `data/api/credit.ts`,
  `data/mutations/adjustStock.ts` — against the deployed API over real HTTP from a browser origin,
  and compares the client's figures to **Postgres**, not to a fixture. `apps/web` cannot do this
  itself (it has no `pg` dependency and must not grow one), which is exactly why the comparison
  belongs in the one package that may import both trees.
- **The conformance suite's device clock is now derived from `Date.now()`.** `tillClock(offset)`
  plus `assertWithinSkewWindow`, which raises a message naming the failure — *"a literal here
  expires the day after it is written"* — rather than letting the server answer
  `CLOCK_RESYNC_REQUIRED` and leaving the next reader to guess. Ledger row 10 cannot recur
  silently.
- **`packages/wire-conformance` declares `vite` and `"types": ["node", "vite/client"]`.** Same
  range `apps/web` declares, deliberately: a local ambient shim for `import.meta.env` would have
  been the third thing agreeing with neither side, which is this table's one root cause.
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

## 0a. Offline honesty — the rule most easily broken quietly, mutation-tested

Reporting, low stock, reorder thresholds and credit are served by the API over HTTP.
`app.credit_entry` and `app.reorder_point` are in **no sync bucket**, so a partitioned device
genuinely cannot know these things. The rule is that the UI says so plainly, and **never** shows a
stale figure as current or an empty list that reads as "nothing is low": a wrong balance shown
confidently at a counter is worse than no balance.

The client honours this by construction. `data/api/client.ts` models nine distinct kinds of "no",
`useApiQuery` has exactly three states and **discards the previous answer before every re-run**, and
`ServerUnavailable` is the only rendering of a failure — there is no fourth state showing an old
answer. There is **no cache of any money figure anywhere in the feature**: the only cache in the
client's api layer is `session.permissions`, keyed to the token's `uid`, and it exists to grey out
a button, never to authorise (D10 checks 1e/2b/4f prove the server refuses regardless).

Claiming that is not the same as demonstrating it, so each of the three rules was **broken
deliberately and the suite re-run**. All three mutations were reverted; the tree is clean.

| Mutation injected | Result | Verdict |
|---|---|---|
| `LowStock.tsx`: collapse the "no thresholds configured" branch into the reassuring "nothing is below its threshold" one | **2 tests red** (`says NO THRESHOLDS have been set, and does not say stock is healthy`; `tells counter staff who can set one`) | has teeth |
| `use-api-query.ts`: keep the last good answer when a refresh fails, and stop clearing state on re-run | **1 test red** (`never shows a previously fetched balance after the connection drops`) | has teeth |
| `Reports.tsx`: render a failed panel's children anyway (the zero/empty table instead of the reason) | **2 tests red** (`says unavailable offline on every panel, and renders no table at all`; `explains a refusal from the server in the server's own words`) | has teeth |

One honest correction to method, recorded because it nearly produced a false finding. The **first**
mutation of `useApiQuery` — keeping the previous answer only in the resolution branch — did **not**
turn anything red, and read like a missing test. It is an **equivalent mutant**: the guarantee is
held earlier and more strongly than the module's own comment claims, by the eager
`setState({status:'loading'})` at the top of the effect, which clears the answer *before* the
request is even sent. The resolution branch can never observe a `ready` state. Only after mutating
**both** halves did the right test fail. A weaker analysis would have reported "the stale-balance
rule is untested" and been wrong.

Confirmed live as well — D10 check group 5: with the radio genuinely off (the `fetch` rejects), a
report, a stock-on-hand read, the low-stock alert and a credit balance each answer `offline`, and
none of them returns data.

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

### What the CLIENT drill demonstrates (`drill:client`, **30/30** over HTTP) — NEW

`packages/wire-conformance/src/live-operations-drill.ts` (**D10**) is the answer to §6 items 10, 13
and 14 of the previous revision, and to §0 ledger row 11. Every check drives a **production module
of `apps/web`** — not a fixture, not a hand-written request — against the deployed API on :3001,
over real HTTP, carrying a browser `Origin`, and compares the answer to rows read straight out of
Postgres under the tenant's own RLS context.

| # | Demonstrated | Measured |
|---|---|---|
| 1a–1d | **REPORTING HAS A CLIENT.** The manager's own `fetchSalesByLocation` returns a report over real HTTP; the client's Σ(per-location revenue) **equals `sum(app.sale.total_minor)` from Postgres as an exact bigint identity**, and equals the client's own network total | `client=4830365 postgres=4830365` over **25 locations / 25 sales**; `network=false` — a true total of what that caller may see, labelled as such |
| 1e–1f | Counter staff **REFUSED** the same report with the same payload, and the refusal carries **no figures** — a reason, never a table of zeroes | `403 forbidden`, detail `PERMISSION_DENIED: report.view.location is not held by this user` |
| 2a–2b | The client's `setReorderPoint` writes a threshold over real HTTP; counter staff is **refused** the identical write | manager allowed, counter `forbidden` |
| 2c–2g | **THE LOW-STOCK LIST IS NON-EMPTY.** The threshold is deliberately set *above* the ledger's on-hand so the alert must fire — an empty list would pass vacuously and is also exactly what a broken client returns. The alert's quantity equals the movement ledger's own sum, and coverage reads `configured` so the screen may say what an empty list would have meant | `alerts=1`, `onHand=749` (ledger 749), `threshold=1749`, `shortfall=1000`, `coverage={"kind":"configured","count":1}` |
| 3a–3e | **A STOCK ADJUSTMENT RECORDED OFFLINE.** The real `recordAdjustment` completes locally with nothing awaiting a socket; with the transport's `fetch` REJECTING it is **absent from the server** and deferred (never rejected — a dead radio is not a refusal); on reconnect it drains, is acked **`applied`**, and the row is in `app.stock_movement` once, with the client's exact bigint | drained in **21ms** against the 60,000ms budget; `qty_delta=-3`, `source_kind=WRITE_OFF`, 1 row, pending back to 0 |
| 4a–4d | **THE CREDIT CLIENT'S FIGURES EQUAL THE SERVER'S.** `fetchExposure` compared to `Σ(app.credit_entry.amount_minor)` read from Postgres, as an exact bigint identity — and non-vacuously, on an account that genuinely owes | `client=765200 postgres=765200` over 3 entries; `available 4234800 = 5000000 − 765200` |
| 4e–4h | Reconciliation is checked by the **client's own `checkAgreement`** — the function the credit screen renders "these reconcile" from — rather than by an identity restated in the drill, which would be the third thing agreeing with neither side. The unapplied payment stays on its **own line**, never netted into a bucket; the facility fee is **provisional and refuses to be chargeable** | `agrees`; `Σbuckets=865200 − onAccount=100000 = balance 765200`; `agedBy=days_past_due`; `label="provisional — not chargeable"` |
| 4f | Counter staff **REFUSED** a credit balance, same payload | `forbidden` |
| 5 | **OFFLINE HONESTY, LIVE.** With the radio genuinely off, a report, a stock-on-hand read, the low-stock alert and a credit balance each answer `offline` — **none returns data**, an empty list or a zero | 4/4 `kind=offline` |

**The contract-importer question, answered by mutation rather than by reading imports.**
`apps/web/src/data/api/reports.ts` imports `salesReportInput`, `cashPositionReportInput`,
`stockReportInput`, `inventoryDaysReportInput` and `distributionCostReportInput` from
`@erp/contracts`, and validates against them *before the request leaves the device*. Renaming
`from` to `fromDate` inside `packages/contracts/src/reports.ts` breaks `apps/web`'s compile at
**four production call sites in `Reports.tsx`** (plus three in its tests). The "a disagreement is a
`tsc` error" guarantee that justifies the contracts package **now exists for these shapes**; last
revision it did not, because there was no second party to disagree.

**One honest qualification.** The report *responses* are still NOT in the contract package.
`apps/web` may not import `apps/api`, so each caller declares the response shape it reads and maps
it field by field — every money and quantity value through `deserializeMoney`, never `Number`, with
an unreadable field becoming a loud `malformed` rather than an `undefined` flowing into a total.
`data/api/client.ts` states this asymmetry in its own header rather than implying the return type is
enforced end to end. D10 is what covers the gap today: it compares the mapped figures to Postgres.
The **credit query inputs** (`exposure`, `ageing`, `previewFacilityFee`) are likewise still private
to `apps/api` — the client validates them with hand-written guards. Only the four uploadable
mutations and the five report inputs are shared declarations. Recorded as §6 item 18.

### Dead surface — exported, never called from production

Listed because "exported and tested" reads as "wired" and is not the same thing. None of these is
a security hole; all of them are API surface a reviewer could mistake for a control.

**Audited mechanically this pass** over the CLIENT tree: every `export const|function|class|enum`
(i.e. every executable entry point — a bare `type`/`interface` export that nothing names is a
declaration, not an unexecuted path) in every changed or added file under `apps/web/src`,
cross-referenced against every non-test file in the repo, counting same-module callers as wiring.

**Result: 88 value exports; 68 reachable from another production module, 19 used only inside their
own module, and exactly ONE with no production caller anywhere.**

- **`snapshotOf` (`apps/web/src/data/api/session.ts`)** — zero call sites, in production or in
  tests. `holdsCapabilityAt` immediately above it is the accessor everything actually uses. Not a
  hole; the same shape as `assertPermission` and `requireKnownCode` below. Delete it or use it.

The 19 self-only exports are all legitimate — `fetchLowStock` and `fetchFeePreview` are called by
`fetchLowStockPicture` and `fetchCreditPosition` in the same file, the six named `adjustStock`
error classes are thrown there and caught by the screen, and `readApiEndpoint`/`DEFAULT_TIMEOUT_MS`
are used by `call()`. They are exported wider than they need to be, which is a tidiness note.

**Every route this pass was about now has a client, and it is exercised:** `reports.*` by
`data/api/reports.ts` (four production call sites in `Reports.tsx`), `inventory.lowStock` /
`reorderPoints` / `setReorderPoint` by `data/api/inventory.ts` (`LowStock.tsx`),
`inventory.recordMovement` by `data/mutations/adjustStock.ts` through the **outbox**
(`StockAdjust.tsx`), and `credit.*` by `data/api/credit.ts` (`Credit.tsx`). All of it is driven
live by D10.

Two residual notes, neither a defect:

- **`inventory.ensureReorderPoints` still has no client** — the one route from the previous
  revision's list that remains uncalled by `apps/web`. See §6 item 15, which is about the same
  gap from the seeding side.
- **Nothing in onboarding calls `ensureReorderPoints`.** `applyReorderPoints` deliberately seeds
  thresholds only where the ledger already shows stock, so applying it at template time correctly
  seeds nothing — and `infra/scripts/bootstrap.ts` never calls it afterwards. A freshly
  provisioned tenant therefore has **zero** reorder points and **zero** low-stock alerts until a
  human calls the route. Correct behaviour, invisible default: verified live, where a clean
  `stack:reset` leaves `app.reorder_point` empty.
- **`app.reorder_point` is STILL not in the PowerSync publication** (18 tables) and appears in no
  sync rule, so **the low-stock alert remains online-only**. That is unchanged by this pass and
  stays §6 item 14. What DID change is that the client now says so plainly instead of showing an
  empty list: `LowStock.tsx` renders three distinct empty states — *"this device could not check"*,
  *"no thresholds have been set here yet — this is not a report that stock is healthy"*, and
  *"nothing is below its threshold"* — and the difference between the first two is mutation-tested
  (§0a) and demonstrated live (D10 2f, and check group 5 with the radio off).
- **`REORDER_FRACTION_BP`** is re-exported from `@erp/db/seed` and used only inside
  `template.ts`. Harmless; noted for symmetry with `requireKnownCode` below.

- **`session.permissions` NOW HAS A CLIENT — resolved this pass.** `data/api/session.ts` +
  `use-permissions.ts` resolve the caller's grants once per session and remember them against the
  token's `uid`. Layer 3 exists: the threshold control is offered to a manager and withheld from
  counter staff (`low-stock-ui.test.tsx`), and the fee-posting control likewise (`credit-ui`).
  **Three properties were checked because getting them wrong is how a courtesy becomes a claimed
  boundary.** (a) `holdsCapabilityAt` returns TRUE while the list is `resolving` or `unknown` — it
  **fails OPEN**, so a device that cannot reach the server offers everything and lets the server
  refuse, rather than looking like a demotion; there is a test saying exactly that. (b) The
  remembered list is keyed to the `uid` and is discarded for a different session — *"never lends
  one person's remembered list to another session"*. (c) It is used **only** to hide: D10 checks
  1e, 2b and 4f prove the server refuses counter staff on the report, the threshold write and the
  credit balance regardless of what any client rendered. It is `usePermissions`, deliberately NOT
  `useApiQuery`, because a navigation tab that vanishes when the radio drops is worse than one that
  stays — and nothing behind the tab is authorised by its presence.
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

### `packages/wire-conformance` — 46 tests (5 files) + 4 live drills, typecheck clean
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
- **`drill:rbac` (D8, 30 live checks)**, **`drill:credit` (D9, 13 live checks)** and
  **`drill:client` (D10, 30 live checks — NEW)** — not vitest suites; `tsx` scripts against the
  deployed stack. D8 is the authorization matrix (§1a); D9 is acceptance criterion 3 (§5.3); D10
  drives `apps/web`'s OWN api modules and compares their figures to Postgres (§1a). All three mint
  real HS256 bearers for real `provisionPrincipal` principals and assert on real 403s and real
  Postgres rows.
- `stock-client-to-api` (11) — **added this pass**, and the reason `outbox-surface.test.ts`'s pin
  could go green again rather than being widened. The PWA's own `recordAdjustment` →
  `buildMovementPayload` → outbox → `drainOutbox` → `httpUploadTransport` →
  `inventory.recordMovement` → Postgres, with the movement recorded under a **real partition**
  (the transport's `fetch` rejects, as on a dead link), proven absent from the server while
  offline, drained on reconnect and acked `applied`. Also: the device's own bytes replayed acked
  `duplicate`; the same key carrying DIFFERENT bytes REFUSED rather than silently replayed; and
  the two refusals that would wedge the ordered queue (unknown reason code, non-stocked product),
  each shown to be classed *retryable* by the client's own `classifyRejection` — which is why the
  builder narrows both away on the device.
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

### `apps/web` — 398 tests (36 files), build (Vite + PWA) + typecheck clean
**+133 tests across 10 new files this pass**, all of them the client for the server-backed
features: `credit-api` (22), `credit-ui` (18), `stock-adjust` (20), `stock-adjust-ui` (11),
`api-client` (14), `low-stock-ui` (11), `reports-ui` (10), `navigation` (10),
`ratio-and-quantity-input` (9), `session-permissions` (8). Every pre-existing file kept or
increased its count; there is no `.only`/`.skip`/`.todo` anywhere.
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
pnpm test                   # all suites (951 tests, 74 files; PGlite suites take ~30s)
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
pnpm --filter @erp/wire-conformance drill:client # D10 — the CLIENT's own api layer, 30 checks
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

3. **Credit balance, ageing and facility fee across outlets — REASSESSED
   2026-08-22 (QA verification pass), now that a CLIENT exists. Clause by
   clause: BALANCE — met. AGEING — met. FACILITY FEE — visible, correct as a
   provisional figure, and NOT chargeable. "Visible" — met at the Accounts
   desk, NOT met at a partitioned outlet. The criterion is STILL NOT fully
   met, and one of the two reasons is a human decision rather than missing
   code; the other is missing code and is named as such.**

   > **What changed in the reassessment.** The previous revision could only
   > show this criterion at the API. It now has a screen — `features/credit/`
   > — so "visible" can be assessed as a product claim rather than a route
   > claim, and it splits in two: visible **to Accounts, online** (met) and
   > visible **at an outlet that cannot reach the server** (not met, §6 item
   > 14). An offline-first product does not get to count the second as met
   > because the first works.
   >
   > **New evidence this pass, independent of D9 and D14.** `drill:credit-verify`
   > (**D15, 33/33** over real HTTP through the PWA's own modules) re-derives
   > every figure rather than re-reading the API's: balance is compared to
   > `sum(app.credit_entry.amount_minor)` computed by the drill itself in SQL
   > — **1,300,000 = 1,200,000 + 500,000 − 400,000**, API and SQL agreeing
   > exactly — Σ(ageing buckets) = **1,300,000** = the balance across 5
   > buckets, and the paid-down invoice ages **separately** from the other one
   > (`dpd=[15, −45]`, outstanding **800,000** and **500,000**), which is the
   > check that fails if two charges are aged as one lump. The fee gate still
   > answers **HTTP 412 `FEE_POLICY_UNCONFIRMED`** with **zero** `FEE` rows on
   > the account.
   >
   > **Ledger row 16 was swept for and is absent here.** Every credit read the
   > client performs — `accountForCustomer`, `exposure`, `ageing`,
   > `previewFacilityFee` — plus the `openAccount` reply, was driven at raw
   > HTTP and checked for a superjson `meta` envelope: **4/4 reads clean, the
   > mutation reply clean**, and the client's own mappers decode all four. The
   > sweep was **mutation-tested before being believed**: injecting one raw
   > `Date` into `credit.exposure`'s response turned it red with
   > `META AT $.result.data.meta` while the route still answered **200**, and
   > the client refused with row 16's verbatim words — *"response carries an
   > encoding this device cannot apply"*. The sweep runs **unconditionally**,
   > so an arithmetic failure upstream cannot skip it.

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

   **What remains, precisely — revised 2026-08-22.**

   (a) **Q4 is `NEEDS-HUMAN`, and this is the blocking one.** Until a qualified
   accountant confirms the five fee decisions (D-1..D-5), every fee figure is
   provisional and nothing may be billed — §6 item 5, and CLAUDE.md §2.8 makes
   that review a gate, not a formality. What is demonstrated is *"the fee is
   visible, is labelled provisional, and refuses to post"* — **not** *"the fee
   is correct"*. Nobody should read D15's E-checks as the latter.

   (b) The policy store is still in-memory pending its `app.credit_policy`
   migration.

   (c) **These reads are ONLINE-ONLY, and that is the clause a client did not
   fix.** `app.credit_entry` is deliberately absent from every sync bucket
   (fail-closed), so a partitioned outlet cannot see a balance at all. The new
   screen is honest about it — it renders `ServerUnavailable` rather than a
   stale or empty figure, which §0a mutation-tests — but honesty is not
   visibility. In an offline-first product (CLAUDE.md §2.2) "visible" has to
   mean visible from the till during the hours or days the link is down, and
   today it does not. **This is missing code, not a human decision**, and it
   should not be rounded up on the strength of the balance and ageing clauses
   now being solid.

   (d) **Not proven by this pass:** the criterion says *"across multiple
   locations"*. D9 demonstrates that at two outlets (OUT-01 and OUT-03) and
   still stands; **D15 deliberately does not re-prove it** — it is a
   single-account arithmetic and wire-integrity drill, and its 1,300,000 comes
   from two charges at one location. The multi-location evidence for this
   criterion remains D9's, not D15's.

   *Honest verdict:* clauses "balance" and "ageing" are **met**; "facility fee"
   is **gated** on a human; "visible" is **met online and not met offline**.
   Criterion 3 is **NOT** signed off.

4. **HQ post-sync view across locations — DEMONSTRATED (D3), and it NOW HAS A SCREEN
   (D10, 2026-08-22).** The previous revision could show this only at the database and the API;
   `apps/web/src/features/reports/Reports.tsx` is the view. D10 checks 1a–1d drive the client's own
   `fetchSalesByLocation` against the deployed API over real HTTP and assert its Σ(per-location
   revenue) equals `sum(app.sale.total_minor)` from Postgres as an exact bigint identity —
   **4,830,365 across 25 locations over 25 sales** — and that the client's own network total equals
   the same sum. The scope is labelled rather than implied: an outlet manager is told
   `network=false`, a true total of what that caller may see. Counter staff is refused the same
   call with the same payload (`403`, `report.view.location` absent) and gets a reason, never a
   table of zeroes. The original D3 evidence: After a second
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

3. **The credit-limit column has no database-level backstop — CLOSED 2026-08-22.**
   `02-security-and-access-control.md` §2.4 specifies that
   `customer_account.credit_limit_minor` is protected by a column-level `REVOKE` on
   `app_rw` **and a trigger that raises**. Migration `0011_credit_limit_versions.sql` adds the
   trigger: `customer_account_terms_projection_only` raises on any UPDATE to
   `credit_limit_minor`, `terms_days` or `facility_fee_bp_per_month` at
   `pg_trigger_depth() < 2`, so the only writer is the version-apply trigger and application SQL
   is refused whatever privilege it holds. Asserted by `apps/api/test/credit.test.ts` ("THE
   DATABASE REFUSES a direct write to the projected column"), which was **mutation-tested**:
   removing the trigger turns it red.

   The column-level `REVOKE` was deliberately NOT paired with it, and the migration says why —
   it would force the projection function to be `SECURITY DEFINER`, which runs outside the
   row-level security this schema depends on. That trades a tenant-isolation guarantee for a
   privilege one, and the trigger is the stronger half in any case: a `REVOKE` is silent for a
   superuser and the trigger raises for everyone.

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

10. **Uploadable ops without a client: was three, now TWO — REVISED 2026-08-22.**
   `sale.create` was already proven end to end from the PWA's own code.
   **`stock.record_movement` now is too.** `apps/web/src/data/mutations/adjustStock.ts` builds it,
   `WIRE_KINDS` carries it, `StockAdjust.tsx` is the screen, and it is proven twice: hermetically
   by `packages/wire-conformance/test/stock-client-to-api.test.ts` (11 tests, on every `pnpm test`,
   no docker) and live by **D10 checks 3a–3e** — recorded under a real partition, absent from the
   server while offline, drained on reconnect in **21ms**, acked `applied`, one row in
   `app.stock_movement` with the client's exact bigint. The builder was NOT written as an
   `apiMutate`: a stock movement is trade, so it rides the outbox exactly as a sale does, and
   `data/api/client.ts` states in its own header why a trade write must never go over the
   synchronous path.

   The pin earned its keep again: adding the kind to `WIRE_KINDS` turned `outbox-surface.test.ts`
   red until a real client-to-api test existed for it. The allow-list was extended only after the
   test was written, never to make the suite green.

   **`credit.open_account` and `credit.record_entry` had NO CLIENT AT ALL — CLOSED 2026-08-22.**
   The wiring pass swept all 45 mounted procedures against `apps/web/src` and found they had
   neither an outbox path nor a tRPC caller: in the product no screen could open a customer's
   credit account, set or change a limit, or record a repayment. The same shape as §0 rows 3, 5,
   6, 14 and 15 — server capability, contract, permission and tests all present, with no
   production caller between them.

   *What landed.* `features/credit/CreditForms.tsx` (three forms) wired into `Credit.tsx`:
   `openCreditAccount` (`CreditForms.tsx:172`), `setCreditLimit` (`:341`) and `recordRepayment`
   (`:539`), plus `fetchAccountForCustomer` at `Credit.tsx:561`.

   *Three server routes had to land with it, because a client-side workaround would have been
   worse than the gap.* `credit.setLimit` — a limit could be set once at `openAccount` and
   **never changed**, and `credit_limit_minor` appeared in no `UPDATE` in the repository;
   migration `0011_credit_limit_versions.sql` makes it 06 §6.6.1's append-only decision log with
   `supersedes_id` as the compare-and-set, projects onto `customer_account` from a trigger, and
   **closes item 3 below** (the database backstop 02 §2.4 asked for). `credit.accountForCustomer`
   — every credit route is addressed by account and everything a device holds is addressed by
   customer, so the old screen made a person type a UUID. `credit.exposure` also now publishes
   `termsDays` and the accepted `limitVersionId`, which is what a limit form decides against.

   *The offline split, stated.* A repayment is TRADE and rides the outbox (`WIRE_KINDS`
   `credit_payment → credit.record_entry`); opening an account and changing a limit are RISK
   DECISIONS, go over tRPC and are refused out loud (06 §6.6.3(7)). The queued receipt shows what
   was recorded and **never a resulting balance** — the device holds no credit ledger to subtract
   from. Proved hermetically by `packages/wire-conformance/test/credit-client-to-api.test.ts`
   (18 tests, every `pnpm test`) and live by **drill D14** (`drill:credit-client`, 18/18 over real
   HTTP from a browser origin, every figure compared to Postgres).

   *Still not offered, deliberately:* `ADJUSTMENT` and `WRITE_OFF` entries (accounting judgements,
   not trade), and `credit.setStatus` — `customer_account.status` is still enforced by
   `sales.createSale` and **set by nothing**, so an account cannot be suspended. That is the
   remaining credit gap.

   *Independently verified 2026-08-22 (QA pass) — `drill:credit-verify`, D15, 33/33.* The build
   report was **not** taken as evidence; a separate drill was written that shares no assertions
   with D14. What it adds over D14:

   - **A second, independent computation of every figure.** Balance is checked against
     `sum(app.credit_entry.amount_minor)` computed in SQL *by the drill*, never against the API's
     own arithmetic: **API 1,300,000 == SQL 1,300,000**, and that is 1,200,000 + 500,000 − 400,000
     done by hand. Σ(ageing buckets) = **1,300,000** = the balance across 5 buckets. The paid-down
     invoice ages at its own age (**800,000**, `dpd=15`) while the other is untouched
     (**500,000**, `dpd=−45`) — `dpd=[15, −45]`, so the two cannot have been aged as one lump.
   - **The row-16 sweep.** All four credit reads the client uses, plus the `openAccount` reply,
     driven at raw HTTP and checked for a superjson `meta` envelope: **clean**. Mutation-tested —
     one injected `Date` in `credit.exposure` turns it red at `$.result.data.meta` on a **200**
     response while the client refuses with row 16's own words. It runs unconditionally, so an
     upstream failure cannot silence it.
   - **Refusals with positive controls, both directions.** An outlet manager is refused
     `openAccount` (**403**, `credit.account.manage` absent) and the identical payload succeeds for
     the Accounts holder on the same route; the refusal writes **0** rows. Counter staff **and**
     outlet manager are both refused `setLimit`, and the accepted limit is unchanged after both.
     Postgres holds exactly **one** accepted head at 8,000,000/45 days with the superseded version
     **kept** — 2 versions, append-only, as 06 §6.6.1 requires. Nothing branches on a role name.
   - **The fee gate, at the wire.** `accrueFacilityFee` answers **HTTP 412
     `FEE_POLICY_UNCONFIRMED`** (confirmed with a raw `curl`, not only through the client), the
     account carries **0** `FEE` rows, the preview is `provisional=true`
     (`"provisional — not chargeable"`), and the balance does not move.

   *No new §0 ledger instance was found in the credit client.* The import-graph walk that has
   caught this project five times was re-run over every export of `data/api/credit.ts`,
   `data/mutations/recordRepayment.ts` and `features/credit/CreditForms.tsx`: the only exports
   without a caller outside their own module are `fetchExposure`, `fetchAgeing` and
   `fetchFeePreview`, and all three are composed by `fetchCreditPosition`
   (`data/api/credit.ts:406-408`) — exported for testability, not dead. Every form is reachable by
   a person: `Credit.tsx:615` ("Open a credit account"), `:742` ("Change the limit"), and the
   payment form's submit at `CreditForms.tsx:623`, all under the `credit` nav entry
   (`features/shell/Shell.tsx:131`, gated on `CAPABILITY.creditView`, mounted at `:250`).

   *One stale claim was found and fixed, in the verification apparatus rather than the product.*
   `packages/wire-conformance/src/live-distribution-drill.ts:1027` printed, as part of D12's
   summary, *"no apps/web screen sends businessDate on planDelivery today"* — which **ledger row
   15 closed**: `features/deliveries/Deliveries.tsx:416` sends it on every call. A drill that
   narrates a fact it does not check will go stale silently; the line now states what is true and
   points at the row. Not a ledger row of its own — no capability was broken — but worth recording
   that it was output prose, not an assertion, that drifted.
11. **No test drives the PWA in a REAL BROWSER — narrowed, not closed.** The conformance suite
   still drives `checkout()`, `recordAdjustment()` and the outbox directly, and D10 drives the
   client's api modules directly; none of them renders a component. What changed this pass is that
   the *component* layer is now covered in jsdom — `reports-ui` (10), `credit-ui` (18),
   `low-stock-ui` (11), `stock-adjust-ui` (11), `navigation` (10), `counter-ui` (10) — so a screen
   that stopped calling its data layer is now caught. What is still missing is a real browser:
   OPFS, service-worker update, wasm workers and touch behaviour on a low-end Android tablet are
   exercised by nothing. Playwright against the built PWA belongs with the real-device trial (#8).

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

13. **Reporting and alert routes have a client — CLOSED 2026-08-22.** Kept here, with the shape
   of the closure, because the previous revision named two specific risks and both had to be
   discharged rather than assumed.

   *Risk one: a contract with one party.* Discharged, and **demonstrated by mutation, not by
   reading imports**. `apps/web/src/data/api/reports.ts` imports `salesReportInput`,
   `cashPositionReportInput`, `stockReportInput`, `inventoryDaysReportInput` and
   `distributionCostReportInput` from `@erp/contracts` and validates against them before a request
   leaves the device. Renaming `from` to `fromDate` in `packages/contracts/src/reports.ts` breaks
   `apps/web`'s compile at **four production call sites in `Reports.tsx`**. The guarantee exists.
   `lowStockInput` and `setReorderPointInput` are imported the same way by `data/api/inventory.ts`.

   *Risk two: "a second hand-rolled shape", i.e. §0's second row again.* Discharged for the
   REQUEST shapes, which are the ones that produce a `BAD_REQUEST` at a till. **Not** discharged
   for the RESPONSE shapes — see item 18, which is new and states the residue precisely rather
   than letting it read as covered.

   HQ reporting (criterion 4) now has a screen, and D10's 30 live checks compare the client's
   figures to Postgres. `inventory.ensureReorderPoints` is the one route from the original list
   that still has no caller in `apps/web` (item 15 is the same gap from the seeding side).
14. **The low-stock alert and the credit balance are ONLINE-ONLY — STILL OPEN, but now HONEST
   about it.** `app.reorder_point` (migration `0007`) and `app.credit_entry` are in no sync bucket
   and no sync rule, so a partitioned outlet — the condition this product exists for — cannot see
   its own low-stock list or a customer's balance. Phase 1 lists "low-stock alerts" under core
   operations and §2.2 says every location must trade fully offline. Adding
   `app.reorder_point` to `PUBLICATION_TABLES` with a per-location bucket is small; the credit
   book is a deliberate fail-closed choice pending the sync-rule swap (item 4). **The feature gap
   is unchanged.**

   *What DID change is the failure mode, and it is the difference between a gap and a defect.*
   The client now refuses to guess. Nothing caches a money figure; `useApiQuery` discards its
   previous answer before every re-run, so a dropped connection replaces the balance with the
   reason rather than leaving yesterday's number on screen; and `LowStock.tsx` distinguishes *"this
   device could not check"* from *"no thresholds have been set here yet — this is not a report
   that stock is healthy"* from *"nothing is below its threshold"*. All three renderings are
   mutation-tested (§0a: each was deliberately collapsed into the reassuring one, and each turned
   the right test red) and confirmed live with the radio genuinely off (D10 check group 5: report,
   stock-on-hand, low-stock and credit balance all answer `offline`, none returns data).

   So the honest statement is: **a partitioned outlet still cannot see these, and now it is told
   so instead of being shown a zero.** That was the part that could have shipped silently wrong;
   it did not.

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

18. **Report and credit RESPONSE shapes are not in the contract package — NEW.** Request inputs
   are shared and a drift is a `tsc` error (item 13). Responses are not: `apps/web` may not import
   `apps/api`, so each caller in `data/api/*.ts` declares the response shape it reads and maps it
   field by field. The mapping discipline is right — every money and quantity value goes through
   `deserializeMoney`/`BigInt`, never `Number`; a JSON number in a money field becomes a loud
   `malformed` rather than an `undefined` flowing into a total, and there is a test for exactly
   that — but a server that renamed a response field would be caught by **D10 and by nothing
   else**, since D10 needs docker. `data/api/client.ts` states this asymmetry in its own header
   instead of implying end-to-end enforcement, which is the right disclosure; the structural fix is
   a shared response declaration, or an `apps/api`-side test asserting the response against a
   contract object. Also in this class: the credit QUERY inputs (`exposure`, `ageing`,
   `previewFacilityFee`) are still private to `apps/api` and the client validates them with
   hand-written guards.

19. **`readApiEndpoint()` throws rather than returning `null` outside a Vite build — NEW, minor.**
   It reads `import.meta.env.VITE_API_URL`, which is `undefined` in plain Node, so the property
   access raises instead of yielding the intended `not-configured` failure. It never fires in
   production (the PWA is always Vite-built) and never in D10 (which always passes an explicit
   endpoint), so it is a robustness note rather than a bug — recorded because the function's own
   contract says it returns `null` for a device with no server.

None of these gaps is hidden in a passing test suite: everything green above is
green because the thing it tests genuinely works in the tested environment, and
everything not yet demonstrable is listed here. §0 is the standing correction to
the habit that produced the last two bugs — a green suite is evidence about the
paths it actually traverses and about nothing else.
