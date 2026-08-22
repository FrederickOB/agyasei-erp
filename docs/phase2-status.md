# Phase 2 status — integration & QA verification report

**Date:** 2026-08-22 · **Author:** QA engineer · **Branch:** `phase1-completion`
**Scope verified:** CLAUDE.md §3 Phase 2 — suppliers · multi-source purchase orders ·
goods-received matching · reorder points tied to the Phase 1 alerts · third-party haulier
dispatch and delivery status — **plus the Q1 question ADR-0001 traded the fleet for.**

> **Revised by the Q1 verification pass (2026-08-22, later the same day).** The §0 ledger lives in
> `docs/phase1-status.md` §0 and it is the project's, not Phase 1's. That pass **closed rows 12 and
> 14, extended row 13, and opened row 15**; the count there is now **FIFTEEN**. There is no second
> copy of it here on purpose — one place, current.

---

## Verdict

**Q1 is answered. Phase 2 is functionally real and demonstrated end to end on the deployed stack.
It is still not a sign-off** — the things a reasonable gate would ask for that are missing are
named in §5, and they are fewer than they were. `product-manager` owns the gate decision; this
document is the evidence it would rest on.

**The headline, because it is the question the founder gave up the owned fleet for:**

> **Distribution cost as a percentage of revenue is now computable per outlet and per region, and
> it has been computed live against real Postgres and reconciled against an independent second
> implementation.** `reports.distributionCostRatio` no longer answers `null` /
> `NO_DISTRIBUTION_COST_SOURCE`. It is on a screen. See §4 for exactly what a reader must do to
> see it, and for the three things that are still true beside it.

What was **demonstrated, not asserted**, across the two passes:

- the full procure-to-stock loop driven through the **client's own modules** over a real socket
  against the deployed API and real Postgres — raise, submit, refuse-to-self-approve, approve,
  receive short and offline, drain, replay, dispatch, deliver (**D11, 56/56**);
- **the Q1 ratio, live**: dispatch with a known freight, then a real percentage that reconciles
  three ways — Σ(per-location) = network, numerator = an independent Postgres sum, and the
  percentage = `freight ÷ revenue` recomputed in bigint half-up by a second implementation
  (**D12, 32/32**);
- **the region rollup summing over `app.location_closure`**, per group, membership included;
- **a delivery whose device clock is three days out landing in its business date's period** and
  being absent from the device clock's;
- **suppliers are writable from the product** — created through the client's own module by a
  `supplier.manage` holder, refused for a `supplier.view`-only caller over HTTP with **no row
  written**, positive control that the same principal can still read;
- **the outbox tie is fixed and it is deterministic** — six consecutive runs, two ops at a
  pinned-identical instant, 2/2 applied on the first drain pass, 0 rejected, every time;
- **two-tenant invisibility on every new read path AND on the new supplier WRITE path**, each with
  a positive control;
- **the drift guarantee**, by mutation: renaming a field in the shared contract breaks the
  client's compile at two production call sites.

What is **not** fixed, and is stated plainly: **`updatePurchaseOrder`, `receiving.get`,
`receiving.purchaseOrderReceiptStatus` and `logistics.haulageSpend` still have no client**; no
screen can assert a delivery's **business date** (§0 row 15); a partitioned device holds no
supplier, order or price at all; and haulage spend is an **agreed** figure, not an AP invoice,
because there is no ledger until Phase 3.

---

## 1. Full workspace — every package, forced, uncached

`pnpm exec turbo run typecheck build test --force` -> **19/19 tasks successful, 0 cached.**
`node tools/lint-money.mjs` -> **clean.** No `.only` / `.skip` / `.todo` anywhere in `apps` or
`packages`.

| Package | Tests | Files | Phase 1 baseline | Phase 2 pass | Q1 pass | Total delta |
|---|---:|---:|---:|---:|---:|---:|
| `@erp/contracts` | **118** | 5 | 105 | 118 | 118 | **+13** |
| `@erp/money` | **56** | 4 | 56 | 56 | 56 | — |
| `@erp/db` | **132** | 10 | 99 | 132 | 132 | **+33** |
| `@erp/api` | **367** | 19 | 233 | 330 | **367** | **+134** |
| `@erp/sequence` | **14** | 1 | 14 | 14 | 14 | — |
| `@erp/wire-conformance` | **69** | 8 | 46 | 69 | 69 | **+23** |
| `@erp/web` | **506** | 43 | 398 | 480 | **506** | **+108** |
| **total** | **1262** | **90** | 951 | 1199 | **1262** | **+311** |

**No baseline went down.** Every delta is additive. `@erp/api`'s **+37** over the Phase 2 pass is
`apps/api/test/procurement.test.ts` growing 21 -> 42 (the `updatePurchaseOrder` surface, which had
no test at all) plus the new `apps/api/test/distribution-cost.test.ts`. `@erp/web`'s **+26** is the
supplier and source forms.

Live, against the deployed stack (API on :3001 **restarted onto current code**, docker Postgres on
:5433 with `0008`, `0009` and `0010` applied — verified by reading `erp_meta.schema_migrations`
from the drill itself, not by assuming):

| Drill | Result | Note |
|---|---|---|
| `pnpm --filter @erp/sync-drills drill` (D1–D7) | **7/7** | re-run after the Q1 pass |
| `drill:rbac` (D8) | **30/30** | re-run after the Q1 pass |
| `drill:credit` (D9) | **13/13** | re-run after the Q1 pass |
| `drill:client` (D10) | **30/30** | re-run after the Q1 pass |
| `drill:procure` (D11) | **56/56** | re-run after the Q1 pass |
| **`drill:q1` (D12) — NEW** | **32/32** | four consecutive runs, deterministic |

**168 live checks over real HTTP. Nothing regressed.**

> **The API server was restarted before the drills and that was not a formality.** The process
> listening on :3001 had started at 17:53; `apps/api/src/routers/reports.ts` and migration `0010`
> were written after it. Every drill run against that process would have been testing a build that
> predated the code under test. §0 row 7 is the same mistake with a migration instead of a process.

---

## 2. D11 — the live procure-to-stock drill

`packages/wire-conformance/src/live-procurement-drill.ts`, run with
`pnpm --filter @erp/wire-conformance drill:procure`. It extends the existing conformance package
rather than inventing a harness, and it drives **`apps/web`'s own production modules** —
`data/api/procurement.ts`, `data/api/logistics.ts`, `data/mutations/recordGoodsReceipt.ts`,
`data/mutations/updateDeliveryStatus.ts`, `data/queries/purchase-units.ts`, the real outbox and
the real `httpUploadTransport` — with a browser `Origin`, against the deployed API, and compares
every figure to Postgres rather than to a fixture.

Nothing in it is a literal both sides could agree on wrongly. The product, the unit, the
conversion factor and the tolerance are **read out of the tenant's own catalogue**; the device
computes the conversion with its own `toStockQty`; the assertion compares that to the server's
stored `qty_stock_computed`.

### The measured loop

Conversion under test, chosen by query and not by hand: **`SKU-025`, bought in `TON`
(scale 3), stocked in `BAR_12M` (scale 0), factor `13500/144`, tolerance `50bp`.**

| # | Demonstrated | Measured |
|---|---|---|
| 0a | `0008` and `0009` are applied to the database the API is actually talking to | 9 migrations |
| 1a–1d | The client reads suppliers over real HTTP; a **haulier is found by the PLATFORM capability kind `HAULAGE`**, and every one carries it; counter staff is **refused** the same call | 3 GOODS, 1 HAULAGE |
| 1e | **The Phase 1 low-stock alert comes back SOURCED** — same alert, joined to a real supplier and expressed in the purchase unit | shortfall `1000` BAR → `basis=PREFERRED`, `10667` TON |
| 2a–2c | A holder of `purchase.order.create` raises a **DRAFT** through the client; Postgres agrees and **Σ(`line_net_minor`) equals the client's total**; counter staff is **refused** the byte-identical order | total `1440000`, 1 line |
| 2d–2f | The raiser may SUBMIT; **the same principal is REFUSED the approval** — `PERMISSION_DENIED: purchase.order.approve is not held by this user` — and the refusal **leaves no trace**: still `SUBMITTED`, `approved_by_user_id` still null | — |
| 2g–2h | A holder of `purchase.order.approve` is allowed the **byte-identical payload**, and Postgres records **the approver, not the raiser** | uid matches Accounts |
| **2i–2m** | **THE APPROVAL MONEY BOUND.** Two orders straddling a bound that lives in ordinary tenant DATA (`role_permission.bound.max_order_value_minor`): the bounded approver is **refused above it**, with the refusal naming **the server's own repriced total**; the **same principal is allowed below it**; an unbounded approver clears the same order | bound `5000000`; refused at `9000000`, allowed at `900000`; `PERMISSION_BOUND_EXCEEDED: … bounded at 5000000 minor units; this act is 9000000` |
| 3a–3c | **A SHORT delivery received with the radio genuinely off.** Complete locally with no network on the path; **absent from Postgres while partitioned**; drains on reconnect and is acked `applied` | **34–66 ms** (budget 60 000 ms) |
| 3d–3e | The line carries **both** quantities and the signature; **the device's `toStockQty` equals the server's `qty_stock_computed`** | invoiced `1500` TON · conversion `141` BAR · **counted `138`** · signed for |
| **3f** | **ON-HAND ROSE BY EXACTLY `qty_stock`** — what was counted, never what was invoiced | `10268 → 10406`, delta **`138`** |
| 3g | The receipt **appended** a movement and set no counter (§2.2) | 1 row, `qty_delta=138`, `source_kind=RECEIPT` |
| 3h, 3k | **The count variance is recorded, not absorbed** — an open `CONVERSION_OUT_OF_TOLERANCE` review at severity 2 — **and it is routed on a permission code that exists in `platform.permission`** (§0 row 6 was exactly the opposite) | `sync.conflict.review`, in catalogue |
| 3i–3j | **The short is visible on the order**: outstanding = ordered − received, and the order moved itself to `PARTIALLY_RECEIVED` — a short delivery is normal, not an error | `1600 − 1500 = 100` |
| **4a–4b** | **The replay the constitution forbids double-counting.** The ack is cleared as a flaky link would lose it and the device re-sends **through its own transport**: acked **`duplicate`**, and **no second movement, no second receipt, on-hand unchanged** | `10406 → 10406`, movements 1, receipts 1 |
| 5a–5e | A delivery is **planned against a carrier that is a supplier**, both status moves ride the **same ordered outbox a sale does**, Postgres says `DELIVERED` with both timestamps, and the client's own read agrees with the freight **as a bigint** | freight `45000` |
| **5f** | **Haulage spend is attributable to the location that received the goods** | `45000` at OUT-01, `basis=AGREED_NOT_INVOICED` |
| **5g** | **WAS THE GAP; NOW THE PROOF.** This check used to pass *because* `reports.distributionCostRatio` answered `null`. It now asserts the opposite and passes: the ratio carries the haulage numerator, and the figure it publishes is **byte-identical to what `logistics.haulageSpend` publishes for the same day** — one numerator, two routes | ratio `3796115` = spend `3796115`, pctE4 `488781` |
| 6a–6k | **Two-tenant isolation on every new read path**, each refusal paired with the id being real: order, delivery, order list, delivery list, supplier list (same codes, **zero shared ids**), sources-for-product, goods receipt (**with a positive control that tenant A can read it**), receipt status, haulage spend, reorder suggestions | 12 checks |
| 7 | **Offline honesty** on the buying reads: every one answers `offline`, never an empty list and never a zero | 5 checks |

### One thing D11 found by running, that the suite could not — and it is now FIXED

Two outbox writes made in the **same millisecond** used to upload in a **random relative order**
(§0 row 12). D11 pinned both instants identical **on purpose** so the tie happens every run, and
asserted **convergence**, which was the only property that then held.

**The Q1 pass closed it.** `apps/web/src/data/sync/queue-seq.ts` adds `outbox.queue_seq` — a
strictly increasing integer stamped inside the same local write transaction as the INSERT — and
`OUTBOX_QUEUE_ORDER` is the single ordering expression the drain and every reader share. The module
also records why a monotonic `uuidv7` would **not** have fixed it: an op's id is minted when its
work begins (a sale's id is its cart's id, minted at cart-open), not when it is queued, so on a
`created_at` tie a monotonic id would deterministically put a freshly-queued sequence report
*after* an older cart — the exact inverse of the property `data/sequence.ts` documents.

D11's assertion is now on **first-pass order**, not merely convergence, and **D12 F1 repeats it six
times**: ties observed 6/6, 2/2 applied on the first drain pass, 0 rejected, every run.

---

## 2b. D12 — the live Q1 drill

`packages/wire-conformance/src/live-distribution-drill.ts`, run with
`pnpm --filter @erp/wire-conformance drill:q1`. It extends the existing conformance package rather
than inventing a harness, drives `apps/web`'s own production modules
(`data/api/procurement.ts`, `data/api/logistics.ts`, `data/api/reports.ts`,
`data/mutations/updateDeliveryStatus.ts`, the real outbox and the real `httpUploadTransport`) with
a browser `Origin`, and compares **every** figure to a SECOND implementation written in the drill —
never to a fixture and never to the server's own arithmetic restated. The percentage is recomputed
there in bigint, half-up, by its own `pctE4`.

| # | Demonstrated | Measured |
|---|---|---|
| 0a–0b | `0010` is applied to the database the API is talking to; `business_date` is `NOT NULL` | 10 migrations |
| **A1–A2** | **A `supplier.manage` holder CREATES a haulier through the client's own module**, and Postgres agrees — code, terms, active flag and the `HAULAGE` capability | `D12-HAUL-…`, terms 30 |
| **A3** | **A `supplier.view`-ONLY caller is REFUSED the identical call over HTTP, and the refusal leaves NO ROW** | `PERMISSION_DENIED: supplier.manage`, 0 rows |
| A4 | Positive control: the same refused principal can still LIST, and sees the new haulier | — |
| B1–B2 | Deliveries planned with a stated freight and a stated business date; both status moves reach Postgres through the outbox | `137500` + `42100` + `9900` |
| **B3** | **THE DEVICE CLOCK DISAGREES WITH THE BUSINESS DATE AND THE ROW KEEPS BOTH** | `business_date=2026-08-22`, `dispatched_at::date=2026-08-25` |
| **C1** | **THE Q1 RATIO IS A REAL FIGURE — not null, not `NO_DISTRIBUTION_COST_SOURCE`** | cost `4406615`, revenue `10468700`, **pctE4 `420932`** |
| C2 | The dispatch MOVED the figure — the numerator rose by exactly what was agreed | delta `189500` = expected |
| **C3** | **RECONCILES: Σ(per-location freight) EQUALS the network figure**, and so does revenue | `4406615` = `4406615` |
| **C4–C5** | **The numerator and the denominator each equal an INDEPENDENT Postgres sum** over the same period and the same scope | 119 deliveries, 11 without agreed freight |
| **C6** | **The percentage equals `freight ÷ revenue` recomputed here in bigint, half-up** | `420932` = `420932` (**42.0932%**) |
| C7 | The delivery COUNTS agree too — a sum matching on a different row set would be luck | 119 = 119, 11 = 11 |
| **C8** | **The skewed delivery lands in its BUSINESS DATE's period; the day its `dispatched_at` names reports `cost=0` over `0` deliveries** | — |
| **D1–D2** | **EVERY GROUP SUMS OVER `app.location_closure`** — membership, freight, revenue and the percentage, each against an independently read closure | 7 groups incl. `ROOT` |
| D3 | Groups NEST and the response says so — Σ(groups) deliberately is **not** the network total | `ROOT` holds all 25 |
| D4 | Freight dispatched to a named outlet is visible in THAT outlet AND in ITS region | `OUT-01` -> `REG-BONO` |
| E1–E4 | A SECOND SOURCE added through the client in a DIFFERENT purchase unit; the comparison still resolves across units; the server's list order is authoritative; the view-only caller is refused this write too | `SKU-025`: `TON` + `BAR_12M` |
| **F1** | **SIX CONSECUTIVE RUNS: two ops written at a pinned-identical instant applied in ENQUEUE ORDER on the FIRST pass, every time** — ties observed 6/6 | 2/2 applied, 0 rejected, ×6 |
| F2 | Every delivery the drill planned is visible on the order it carries | — |
| **G1–G2** | **Tenant B, HOLDING `supplier.manage`, cannot amend tenant A's supplier by its real id** — refused, A's row unchanged, and nothing copied across | terms still 30 |
| **G3–G4** | **The Q1 report itself is tenant-scoped** — zero shared location ids — and naming A's location outright is REFUSED, not silently emptied | `PERMISSION_OUT_OF_SCOPE` |
| **H1** | **NO delivery written since `0010` is dated by a device clock** — `DISPATCH_CLOCK` is backfill-only | 0 rows |

> **The figure above is drill data, not a business figure.** D12 dispatches freight on every run, so
> the percentage rises each time; that it tracks the independent Postgres sum exactly, run after
> run, is the evidence. Nobody should quote `42.0932%` as Agyasei's distribution cost.

---

## 3. Dead-wiring audit — re-run in full

### The contract has a second importer, and the guarantee is DEMONSTRATED

`packages/contracts/src/procurement.ts` is imported by **both** trees. Proven by mutation, not by
grep: renaming `deliverToLocationId` -> `deliverToLocationIdMUTATED` and `qtyStock` ->
`qtyStockMUTATED` in the contract breaks `apps/web/src/data/mutations/recordGoodsReceipt.ts:198`
and `apps/web/src/features/purchasing/Purchasing.tsx:332` (both production), plus
`apps/api/src/routers/procurement.ts` and `receiving.ts`. The contract was restored byte-for-byte
afterwards and re-typechecked.

### Every server route, and whether production reaches it — RECHECKED

The six routes the previous revision listed as clientless were re-checked by grepping
**`apps/web/src` only**. A drill is not a client; a test is not a client.

| Route | Previous | Now | Evidence |
|---|---|---|---|
| `procurement.upsertSupplier` | no client at all | ✅ **CLOSED** | `data/api/procurement.ts:892` -> `features/suppliers/SupplierForms.tsx:158` -> `Suppliers.tsx:431`, lazy-routed in `Shell.tsx:265`. **Driven live in D12 A1–A3.** |
| `procurement.upsertSupplierProduct` | no client at all | ✅ **CLOSED** | `data/api/procurement.ts:910` -> `SupplierForms.tsx:470` -> `Suppliers.tsx:458`. **Driven live in D12 E1–E2.** |
| `procurement.updatePurchaseOrder` | no client | ❌ **STILL NO CLIENT** | 0 hits in `apps/web/src`. It now has **21 API tests**, which is coverage, not wiring. A draft still cannot be edited from the PWA. |
| `receiving.get` | no client | ❌ **STILL NO CLIENT** | 0 hits in `apps/web/src`. Receiving shows only its **own device's** outbox, so a receipt posted from another device is invisible on this one. |
| `receiving.purchaseOrderReceiptStatus` | no client | ❌ **STILL NO CLIENT** | 0 hits in `apps/web/src`. Referenced only by D11. |
| `logistics.haulageSpend` | no client — "and this is the Q1 route" | ❌ **STILL NO CLIENT**, but **no longer the Q1 blocker** | 0 hits in `apps/web/src`. **`reports.distributionCostRatio` now calls the SAME `loadHaulageSpend`** and *does* have a client (`data/api/reports.ts:532` -> `features/reports/Reports.tsx:576`), so the Q1 figure reaches a human without it. What `haulageSpend` adds that no screen shows is the **per-carrier** breakdown — the negotiating view. |
| `reports.distributionCostRatio` | returned `null` | ✅ **WIRED AND ANSWERING** | `Reports.tsx` renders the network percentage (`:597`) and a per-group table (`:646`–`:666`), behind `report.view.margin`. |

**All eight new permission codes have a production enforcement site.** None is a comment with a
primary key.

### Every export of the nine new client modules, walked

Thirty-five exports across `data/api/{procurement,logistics,guard}.ts`,
`data/mutations/{recordGoodsReceipt,updateDeliveryStatus}.ts`,
`data/queries/{procurement-outbox,purchase-units,takedown}.ts` and `data/sync/queue-seq.ts`.

- **§0 row 14 is CLOSED.** `fetchDelivery`, `recentDeliveryUpdates` and `clearTakeDown` now each
  have a production caller (`Deliveries.tsx:687`, `:661`, `Receiving.tsx:945`).
- Three exports are referenced only inside their own module and by their own test —
  `buildReceiptPayload`, `buildDeliveryStatusPayload`, `CONFIG_KEY_TAKEDOWN`. Exported for
  testability, used in production internally. Not dead.
- **All five `INSERT INTO outbox` sites stamp `queue_seq`** — `checkout`, `adjustStock`,
  `recordGoodsReceipt`, `updateDeliveryStatus`, `sequence.enqueueBlockReport`. Checked by grep,
  because one that did not would sort to the front of every queue forever.

### One that the walk found, and it is §0 row 15

**`planDeliveryInput.businessDate` has no production caller.** The field is the period key the
whole Q1 ratio divides by, migration `0010`'s header argues for it at length, and the server
implements all three arms. `features/deliveries/Deliveries.tsx:371` calls `planDelivery` with
`plannedFor` and nothing else, and no route exists to amend a delivery's trading day afterwards.
Measured live by D12's closing `measure`: of the tenant's deliveries, every `ASSERTED` row was
written by a drill or a raw call. See §5 item 7.

### Hygiene from the previous revision

- `apps/api/tsconfig.proc.json` — **deleted.**
- The stale header over `PROCUREMENT_UPLOADABLE_OPS` saying the two Phase 2 ops "are **NOT yet** in
  `DEVICE_OP_KINDS`" — **corrected in this pass.** They are registered (`upload.ts:43,46`) and
  dispatched (`sync.ts:84,85`); the rule that held them back is kept, aimed at the next kind.
- A second stale comment found and corrected in this pass: `distributionCostReportInput` in
  `packages/contracts/src/reports.ts` still said "the numerator is not available from Phase 1 data
  at all … It never returns zero." Both clauses are now false.

---

## 4. ADR-0001 scope check, and the Q1 answer

### Scope: clean, and now checked against the live database as well as the tree

A tree-wide grep for `vehicle|driver|fuel|truck|odometer|mileage|maintenance|fleet|plate` across
`apps/`, `packages/`, `infra/` and `tools/` returns **139 hits and not one entity** — every one is
prose, a comment, a test name, or a test **asserting the absence**.

Run against the deployed Postgres, `information_schema` returns **zero** tables and **zero**
columns in `app` or `platform` matching those words. `packages/contracts/src/*.ts` has **zero**
field declarations matching them. A haulier is modelled **only** as a supplier: `app.supplier` +
`app.supplier_capability` with a PLATFORM `kind` of `HAULAGE`, and `app.delivery.
carrier_supplier_id NOT NULL` referencing `app.supplier`. The client finds carriers by that
platform kind, never by the tenant's own capability code.

### Q1 — is distribution cost as a % of revenue computable per outlet and per region?

**YES.** Not "half of it exists" — computable, computed, reconciled, and on a screen.

**What a reader must do to see it, in the product:**

1. Sign in as a principal holding **`report.view.margin`** (in tenant #1's template that is
   Accounts, Regional manager or Head of operations; an outlet manager does **not** hold it and
   sees a "not yours" panel instead).
2. Open **Reports** and pick a date range.
3. The **Distribution cost against revenue** panel shows the network percentage, a per-location
   table (cost, revenue, ratio, delivery count) and a **per-grouping-node table** — the "per
   region" half — with `groupsNest` stated so nobody adds the subtotals up.

Holders of `report.view.tenant` see the network; a regional grant sees its own region and not the
network. Both are tested (`apps/api/test/distribution-cost.test.ts`) and the scoping refusal is
demonstrated live (D12 G4).

**What makes it trustworthy, each demonstrated rather than asserted:**

- **One numerator, one definition.** `loadHaulageSpend` is exported once and called by BOTH
  `logistics.haulageSpend` and `reports.distributionCostRatio`, so two screens cannot quote
  different figures for the same month.
- **It reconciles three ways** (D12 C3–C7): Σ(per-location) = network, enforced by the server
  itself via `assertAggregateIdentity`; numerator and denominator each equal an independent
  Postgres sum; and the percentage equals a second bigint half-up implementation.
- **The region rollup is the closure**, not a parent pointer (D12 D2) — it will still be right when
  a region nests.
- **The period key is the row's own `business_date`** (migration `0010`), never a device clock. A
  delivery whose tablet was three days fast lands in its business date's period and is **absent**
  from the device clock's (D12 B3, C8), and **no row written since `0010` carries
  `DISPATCH_CLOCK`** (D12 H1).
- **Zero is not null.** `deliveryCount = 0` is a real zero; `netRevenue = 0` gives a null
  percentage with `NO_REVENUE_IN_PERIOD` and still reports the cost, because a warehouse has no
  till and still pays hauliers; and where freight was never agreed the row says
  `INCOMPLETE_FREIGHT_BASIS` and the sum is a **floor**.
- **Scale is stated**: percent × 10⁴ as an integer, so the model's 5.0% and 2.5% are exactly
  `50000` and `25000`. Never a float.

**Three things are still true beside it, and none of them is "the ratio is missing":**

1. **The figure is OPERATIONAL, not accounting.** It is the **agreed** freight, not the haulier's
   AP invoice, and there is no general ledger until Phase 3. `costBasis: 'AGREED_NOT_INVOICED'` is
   on every response and printed under the number.
2. **No screen can assert a delivery's trading day** (§0 row 15). In the product the date is
   derived — from a human-typed `plannedFor`, else the server's transaction date. Both are
   trustworthy, neither is a device clock, and a delivery entered days late with no `plannedFor`
   books to the entry date with **no way to correct it**.
3. **The target itself is unrestated.** The financial model attributed the 5.0% -> 2.5% decline to
   an owned fleet absorbing volume; ADR-0001 removed the fleet and the target was never redrawn.
   The ERP has kept its half of that bargain — the trajectory is now measured. **Whether the target
   is still achievable is an accountant's and the founder's judgement, and it now has something to
   judge.** That remains `open-questions.md` Q1's open half, and it is not a server question.

---

## 5. What Phase 2 does, and what it does not

### It does

- **Suppliers**, with tenant-defined capabilities, and a **haulier is one of them** — and they are
  now **created and amended from the product**, not only from the template seed.
- **Multi-source purchasing**: `supplier_product` per product, compared **per one stocking unit on
  exact rationals server-side**, across different purchase units, with the list order authoritative
  so a rounded display figure can never transpose two sources.
- **Purchase orders** with a database-enforced state machine, separation of raise from approve, and
  a **money bound on approval** measured against the server's repriced total — including on an
  **amended** order.
- **Goods-received matching** against an order, carrying **both** quantities, appending stock
  movements (never setting a counter), recording short deliveries as normal, and opening a **human
  review** when a counted quantity sits outside the unit's tolerance.
- **The same `product_uom` machinery as selling**, in the opposite direction — one conversion, one
  rounding rule, verified equal on both sides of the wire.
- **Reorder points tied to the Phase 1 alert**: the same alert rows, joined to a source, expressed
  in the purchase unit, and pre-filling a draft order.
- **Third-party dispatch and delivery status**, both offline-capable through the same ordered
  outbox as a sale — and that outbox is now ordered by **enqueue position**, deterministically.
- **Distribution cost as a percentage of revenue, per outlet and per region** — §4.
- **Offline where it must be** (receiving, delivery status) and **refused out loud where it must
  not** (raising, approving, booking a load — commitments against terms a partitioned device may
  hold stale).

### It does not

1. ~~**No API test suite for `procurement.ts`**~~ — **closed.** 42 tests through the router's own
   surface, including the approval money bound and `updatePurchaseOrder`.
2. ~~**A tenant cannot create or edit a supplier from the product**~~ — **closed.** Both write
   routes have a client, a screen and a live drill. What is still absent: there is **no offline
   path** for either, by design — a supplier's terms are a commitment a partitioned device may hold
   stale.
3. ~~**Distribution cost is not computable**~~ — **closed**, with the three caveats in §4.
4. ~~**The outbox is ordered only to the millisecond**~~ — **closed** by `outbox.queue_seq`,
   demonstrated over six consecutive runs (D12 F1).
5. ~~**`app.delivery` has no business date**~~ — **closed** by migration `0010`.
6. **Receiving cannot start cold offline.** No procurement table is in any sync bucket, so a
   partitioned device holds no supplier, order or price. The Receiving screen keeps a **take-down**
   — a document stamped with the minute it was taken, never a current figure — which is the honest
   design, but a yard that has never been online since the order was raised cannot match a receipt
   to it. The receipt itself still records (with no order), which is the right failure.
7. **No screen can assert a delivery's business date, and none can amend one** — §0 row 15. The
   period key the Q1 ratio divides by is, in the product, always derived.
8. **Four routes still have no client** — `updatePurchaseOrder` (a draft cannot be edited from the
   PWA), `receiving.get` (a receipt posted from another device is invisible on this one),
   `receiving.purchaseOrderReceiptStatus`, and `logistics.haulageSpend` (so the **per-carrier**
   negotiating view — the one that would show whether rate negotiation is working, which is the
   mechanism ADR-0001 left in place of the fleet — exists on the server and on no screen).
9. **No Phase 3 accounting.** Haulage spend is the **agreed** figure, not an AP invoice. There is
   no GL posting for a receipt or for freight. That is Phase 3 by design, and it means the figures
   in §4 are operational, not accounting, numbers.
10. **No bank reconciliation** (CLAUDE.md §2.8 calls it required) and **no accountant review of the
    ledger** — both Phase 3 gates, neither started, and neither this document's to claim.

### Not a Phase 2 finding, and it is STILL NOT RESOLVED

**`.claude/settings.json` was modified during this work to move `Bash(git push:*)` from `deny` to
`allow`.** The previous revision reported it; **the change is still in the working tree** —
`git diff .claude/settings.json` shows it. No task in either pass required pushing. This is a
change to the harness's own permission configuration, it was not requested by the repository owner,
and it is reported rather than reverted, again, because restoring it is the owner's call.
`git checkout .claude/settings.json` puts it back.

---

## 6. How to reproduce every claim in this document

```bash
pnpm stack:up                                            # docker Postgres :5433 + PowerSync :8080
lsof -iTCP:3001 -sTCP:LISTEN -n -P                       # KILL any stale listener FIRST
pnpm dev:api                                             # API on :3001, on CURRENT code

pnpm exec turbo run typecheck build test --force         # 19/19, 0 cached, 1262 tests
node tools/lint-money.mjs                                # clean

pnpm --filter @erp/sync-drills      drill                # D1-D7   7/7
pnpm --filter @erp/wire-conformance drill:rbac           # D8     30/30
pnpm --filter @erp/wire-conformance drill:credit         # D9     13/13
pnpm --filter @erp/wire-conformance drill:client         # D10    30/30
pnpm --filter @erp/wire-conformance drill:procure        # D11    56/56
pnpm --filter @erp/wire-conformance drill:q1             # D12    32/32   <- the Q1 drill
```

`drill:q1` writes rows every run (that is the point — it dispatches real freight and watches the
ratio move), so the percentage it prints rises between runs. What must hold every run is that the
figure equals the independent Postgres computation, which is checks C4–C7.

The ADR-0001 scope check, against the live database rather than the tree:

```bash
docker exec erp-dev-stack-postgres-1 psql -U erp -d erp -tAc "
select 'TABLE  '||table_schema||'.'||table_name from information_schema.tables
 where table_schema in ('app','platform')
   and table_name ~* '(vehicle|driver|fuel|truck|odometer|mileage|fleet|maintenance)'
union all
select 'COLUMN '||table_schema||'.'||table_name||'.'||column_name from information_schema.columns
 where table_schema in ('app','platform')
   and column_name ~* '(vehicle|driver|fuel|truck|odometer|mileage|fleet|maintenance)';"
# MUST print nothing.
```

The contract-drift mutation, reproduced in full:

```bash
sed -i '' 's/deliverToLocationId: zUuid,/deliverToLocationIdMUTATED: zUuid,/' \
  packages/contracts/src/procurement.ts
pnpm --filter @erp/web exec tsc --noEmit    # MUST fail in src/features/purchasing/Purchasing.tsx
git checkout packages/contracts/src/procurement.ts 2>/dev/null || :  # (untracked: restore by hand)
```

The clientless-route recheck, which is the check this document most wants a reader to repeat,
because a route with a test and no caller looks identical to a finished one in a green suite:

```bash
for p in procurement.upsertSupplier procurement.upsertSupplierProduct \
         procurement.updatePurchaseOrder receiving.get \
         receiving.purchaseOrderReceiptStatus logistics.haulageSpend \
         reports.distributionCostRatio; do
  printf '%-42s %s\n' "$p" "$(grep -rF "$p" apps/web/src --include='*.ts' --include='*.tsx' | wc -l)"
done
# apps/web/src ONLY. A drill is not a client and a test is not a client.
```
