# Phase 2 gate — test evidence

**Date:** 2026-08-23 · **Author:** QA engineer · **Branch:** `tax-inclusive-pricing` (PR #11, unmerged)
**Tree gated:** `9ed8f50` "Let tenant #1 actually trade: tax-inclusive pricing, and credit off manager devices"

> **This document is evidence, not a verdict.** `product-manager` owns the gate decision
> (`docs/phase2-gate.md`). My job is the substrate it rests on, and the only thing that makes it
> worth anything is that the unflattering parts are in it. Where coverage is thin I have said so
> in the same voice as where it is strong. **§7 "What I could not verify" is non-empty and is the
> section to read second, after §4.**

---

## 0. A discrepancy in the instruction that triggered this gate

The slash command that started this run says the mandatory test categories are **"the two
mandatory categories (§2.6)"**. Both halves of that are wrong against the constitution as it
stands in this tree:

- The section is **§2.7**, not §2.6. §2.6 is *Access control from day one*.
- There are **three** categories, not two. §2.7 reads:
  1. any function that touches money;
  2. any sync or conflict-resolution logic;
  3. **any read path that could cross a tenant boundary** — *"Every read gets a test proving a
     second tenant's data is invisible."*

Category 3 was added when this became a product (`CLAUDE.md` §2.7, and §2.1 for why: a leak is
**unrecoverable** once rows reach a device). **I have gated against all three.** Anyone working
from the two-category wording would have skipped the only category whose failure mode cannot be
undone. The command text should be corrected.

---

## 0.5 Summary — the figures and the findings, for lifting

**Green, and honestly green:** 19/19 turbo tasks (0 cached) · **1554 tests / 104 files** · 0 failed ·
0 skipped · 0 todo · `lint-money` clean · **12/12 drills, 345 live checks over real HTTP**, all
against a freshly restarted API and a database I proved is the container.

**The five findings a gate decision should turn on**, in the order I would rank them:

| # | Finding | Severity | Where |
|---|---|---|---|
| 1 | **Counter staff can ring a sale for `total = 0`.** `lineDiscountMinor` is authorised by nothing; `sale.discount.apply` (`max_bps: 300`) and `sale.override_price` are enforced **nowhere**. Directly contradicts §2.6. **Demonstrated live — four HTTP 200s.** | **HIGH — demonstrated** | §5.2 |
| 2 | **The human review queue is write-only.** No router, no bucket, no screen, no resolver, no escalation job. **6 rows in the live DB, all `open`, 0 ever claimed or resolved.** §2.2 requires conflicts reach a human. They reach a table nobody can open. | **HIGH — verified** | §4.3.3 |
| 3 | **Criterion 5 fails as written.** Of 28 query procedures: 19 covered, 3 partial, **1 vacuous, 5 with no two-tenant test.** Plus `platform.*` — 6 tables, RLS **off and not forced**, `app_user` can read the whole tenant registry. No live leak found; the exposure is regression, on an unrecoverable property. | **HIGH** | §4.4 |
| 4 | **Every fail-closed control and mismatch-detector on the money path is unexercised.** `recomputeCheck` (12 branches, all assertions `toEqual([])`), `assertAggregateIdentity`, `assertPackPriceable`. The code whose job is to catch a money bug has never been shown to catch anything. | **MEDIUM-HIGH** | §4.1 |
| 5 | **No procurement table is in any PowerSync bucket** (confirmed: 0 of 10), and **the take-down that substitutes for it is exercised by no live drill** — D11 hands its "partitioned" device ids straight out of Postgres. Offline receiving is demonstrated as a *write path*, not as something a real yard could do. | **MEDIUM** | §4.3.1 |

**Two things that look like assurance and are not:**

- `node tools/lint-money.mjs` is clean, but **mutation-proved blind** to `revenue`, `margin`,
  `freight`, `qty`, `discount`, `commission` typed as `number`, and to any second declaration on a
  line (§8.1). Cite `packages/db/test/conformance.test.ts:126` instead.
- The `(budget 60000ms)` text in D10 and D11 is a **print statement**, not an assertion (§8.4). Only
  D1 hard-asserts the 60-second criterion.

**Phase 1 regression:** criteria **1, 2, 3, 4 hold** (re-run today, 8/8). **Criterion 5 does not
hold as written** — see #3.

**Zero coverage areas, stated plainly:** PWA on real Android hardware (§7) · the §2.2 canonical
credit-limit conflict (§4.3.4) · `credit.open_account` offline/replay/conflict (§4.3.5) ·
`businessDate` clock skew (§4.3.6) · any reconciliation to
`financial-model-targets.md` (§4.1) · **7 of 7 Ghana tax rates are `confirmed_by = NULL`** and the
§2.8 professional review has not happened (§9.5).

---

## 1. Environment provenance — two traps, both resolved before any drill ran

Nothing below is worth reading unless the code under test is the code that ran and the database
read back is the database written to. This repo's own history (`docs/phase1-status.md` §0 row 7,
§0 row 16) is largely a record of that assumption failing. Both traps were live in this session.

### 1.1 Trap 1 — the stale API process. CONFIRMED PRESENT, resolved by restart.

A `node` process was listening on `:3001` when I arrived:

```
PID 94777   started Sun Aug 23 21:39:23 2026   tsx src/dev.ts
```

I did not trust it and did not merely restart it on faith — I measured whether it was stale:

```bash
find apps packages infra tools -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.sql' \
  -o -name '*.mjs' -o -name '*.json' -o -name '*.yaml' \) \
  -newermt '2026-08-23 21:39:23' -not -path '*/node_modules/*' -not -path '*/dist/*'
# -> packages/wire-conformance/src/live-credit-client-drill.ts   (and nothing else)
```

**Finding:** exactly one source file post-dated that process, and it is a drill harness, not
server code. So PID 94777 was *probably* serving current code. "Probably" is not evidence, and
the HEAD commit itself was authored at `21:59:39Z` — **twenty minutes after the process started**.
I killed it and restarted regardless:

```
PID 43223   Server listening at http://127.0.0.1:3001
            db postgresql://erp:***@localhost:5433/erp
```

**Every drill figure in this document was produced against PID 43223**, started from the current
working tree after the restart. Nothing here was measured against the process I found running.

### 1.2 Trap 2 — what is actually on `:5433`. RESOLVED; the surprise is benign.

`lsof` reports an **`ssh`** process holding the port, which is exactly what a tunnel to some other
database would look like:

```
ssh   58624  mac  11u  IPv4  TCP *:5433 (LISTEN)
ssh   58624  mac  13u  IPv4  TCP *:8080 (LISTEN)
```

`docker ps` simultaneously claims `0.0.0.0:5433->5432/tcp` for `erp-dev-stack-postgres-1`. Both
cannot own the port, so one explanation had to be wrong.

**The explanation:** PID 58624 is `ssh: /Users/mac/.colima/_lima/colima/ssh.sock [mux]`. The
Docker host here is **Colima/Lima**, which publishes container ports to the macOS host over an SSH
port-forward. The `ssh` listener *is* the Docker port publish. It is not a rogue tunnel.

**I did not stop at the plausible explanation.** Three independent confirmations:

| Probe | Via host `127.0.0.1:5433` | Via `docker exec` **inside** the container |
|---|---|---|
| `version()` | PostgreSQL 16.15 aarch64-unknown-linux-musl, Alpine gcc 15.2.0 | *identical* |
| `pg_control_system().system_identifier` | **7677344657172918306** | **7677344657172918306** |
| `pg_postmaster_start_time()` | 2026-08-23 21:38:18.994821+00 | *identical* |
| `data_directory` | /var/lib/postgresql/data | *identical* |

A shared `system_identifier` is conclusive — it is stamped into a cluster at `initdb` and cannot
coincide across two clusters.

**Then the write-through proof, which is the one that actually matters**, because it ties the
*API* to that cluster rather than tying my `psql` to it. I wrote a stock movement over real HTTP
through the restarted API and read the row back inside the container:

```bash
# over the wire, to the API on :3001
POST /trpc/inventory.recordMovement  ->  HTTP 200
  { "movementId":"31dcc3e2-8b0d-8fad-b28d-fcc7a61082b7", "qtyDelta":"7",
    "sourceKind":"COUNT_ADJUST", "uomCode":"BAG", "qtyScale":0 }

# read back INSIDE the container, not through the tunnel
docker exec erp-dev-stack-postgres-1 psql -U erp -d erp -tAc \
 "select sm.id, sm.qty_delta, sm.source_kind, r.code, sm.tenant_id
    from app.stock_movement sm join app.movement_reason r on r.id = sm.reason_id
   where sm.id = '31dcc3e2-8b0d-8fad-b28d-fcc7a61082b7'"
-> 31dcc3e2-… | qty_delta=7 | kind=COUNT_ADJUST | reason=COUNT_VARIANCE
                | tenant=01911111-1111-7111-8111-111111111111
```

**The API, the host port and the container are one database.** Every "reconciled against
Postgres" claim below therefore reconciles against the database the product actually wrote to.

> **Artefact left behind, declared:** that proof wrote one real row —
> `app.stock_movement 31dcc3e2-8b0d-8fad-b28d-fcc7a61082b7`, `qty_delta = +7 BAG` at OUT-01 in
> tenant A, reason `COUNT_VARIANCE`. It is dev-stack data, in the same class as the rows every
> drill writes on every run, but it is mine and it is named here rather than left for somebody to
> find.

### 1.3 Migrations actually applied

Read from `erp_meta.schema_migrations` **inside the container**, not from the tunnel and not from
a doc:

```
0001_platform  0002_app_foundation  0003_app_org_catalogue  0004_app_trade
0005_rbac_permissions  0006_app_sequence_and_review  0007_reorder_points
0008_procurement  0009_procurement_permissions  0010_delivery_business_date
0011_credit_limit_versions  0012_credit_account_status
0013_credit_offline_visibility  0014_credit_view_template_correction
```

**14 applied, 14 on disk in `packages/db/migrations/`, exact one-to-one match.** No drift.
(`docs/phase2-status.md` describes a stack "with migrations through `0010`" — that was true when
it was written and is now four migrations out of date.)

---

## 2. Headline counts — lift these straight out

### 2.1 Static suite

`pnpm exec turbo run typecheck build test --force`

**19/19 tasks successful · 0 cached · 1m35.674s · exit 0**

| Package | Tests | Files | `phase2-status.md` baseline | Delta |
|---|---:|---:|---:|---:|
| `@erp/contracts` | 118 | 5 | 118 | — |
| `@erp/money` | **116** | 8 | 56 | **+60** |
| `@erp/db` | **152** | 11 | 132 | **+20** |
| `@erp/api` | **408** | 20 | 367 | **+41** |
| `@erp/sequence` | 14 | 1 | 14 | — |
| `@erp/wire-conformance` | **95** | 10 | 72 | **+23** |
| `@erp/web` | **651** | 49 | 536 | **+115** |
| **Total** | **1554** | **104** | 1295 / 90 | **+259 / +14** |

**0 failed · 0 skipped · 0 todo.** No package went backwards.

### 2.2 Hygiene

| Check | Command | Result |
|---|---|---|
| Money typing | `node tools/lint-money.mjs` | `money lint: clean` (exit 0) |
| No focused/disabled tests | grep for `.only` `.skip` `.todo` `xit` `fit` `xdescribe` `fdescribe` `skipIf` `runIf` across `apps/` + `packages/` | **0 matches** |

Both of these are **mutation-tested in §6** — neither is taken on trust.

### 2.3 Live drills — enumerated from `package.json`, not from any document

I enumerated the drill scripts mechanically from `packages/sync-drills/package.json` and
`packages/wire-conformance/package.json`. **This immediately falsified the documented list.**
`docs/phase2-status.md` §6 lists **7** drills; there are **12** scripts, and the sync-drills
package now runs **8** internal drills, not the 7 that document names.

All twelve were run against PID 43223 and the confirmed container. **All twelve exit 0.**

| # | Drill | Command (`pnpm --filter …`) | Result |
|---|---|---|---|
| D1–D8 | sync acceptance | `@erp/sync-drills drill` | **8/8 drills** |
| D6 | PWA payload over a real socket | `@erp/wire-conformance drill:live` | **16/16** |
| D8 | RBAC over real HTTP | `… drill:rbac` | **30/30** |
| D9 | credit | `… drill:credit` | **13/13** |
| D14 | credit client | `… drill:credit-client` | **19/19** |
| D10 | counter operations | `… drill:client` | **30/30** |
| D11 | procure-to-stock | `… drill:procure` | **56/56** |
| D12 | Q1 distribution cost | `… drill:q1` | **32/32** |
| D13 | newly-wired surfaces | `… drill:counter` | **47/47** |
| D15 | credit verify | `… drill:credit-verify` | **33/33** |
| D16 | credit offline | `… drill:credit-offline` | **37/37** |
| D17 | **tax-inclusive pricing (new)** | `… drill:inclusive` | **32/32** |

**345 individual live checks over real HTTP across the eleven wire-conformance/ops drills, plus
the 8 sync-acceptance drills.** Zero failures.

> **Five drills exist that `docs/phase2-status.md` does not mention at all** — `drill:live`,
> `drill:credit-client`, `drill:credit-verify`, `drill:credit-offline`, `drill:inclusive`. Four of
> those five carry the credit and tax-inclusive work that landed after that document was written.
> This is the concrete instance of why the instruction said to enumerate rather than trust: a
> reader following §6 of that document would have run 7 of 12 and believed they had run all.

---

## 3. Demonstrated vs asserted, per Phase 2 capability

**The standard I applied.** `CLAUDE.md` §3 criterion 2 says the two-device conflict case must be
*"demonstrated, not asserted"*. I have held **everything** to that bar:

- **DEMONSTRATED** = driven over the real wire (real HTTP / a real `@powersync/node` device with a
  real partition) against the real Postgres container, **with the figure reconciled against
  something that is not the code under test** — an independent SQL sum, a second implementation,
  or a hand-computed golden value.
- **ASSERTED** = a green test. Including a very good green test. A unit test tells you a function
  does what its author thought; it does not tell you the feature works in a yard in Techiman.

This split is the most useful thing in this document. It is deliberately harsh.

### 3.1 Suppliers

| Behaviour | Status | Evidence |
|---|---|---|
| A tenant can **create** a supplier from the product | **DEMONSTRATED** | D12 A1–A2: a `supplier.manage` holder creates haulier `D12-HAUL-DB90F3` through `apps/web`'s own `data/api/procurement.ts` over real HTTP; Postgres confirms code, `terms=30`, `active=true` and the `HAULAGE` capability |
| The write is **refused** without the capability, leaving no row | **DEMONSTRATED** | D12 A3: a `supplier.view`-only caller refused over HTTP, `rowsWritten=0` — the negative has a *measured* row count, not just a 403 |
| Positive control (the refusal is not the route being broken) | **DEMONSTRATED** | D12 A4: same refused principal still lists suppliers and sees the new haulier |
| A haulier is modelled **only** as a supplier (ADR-0001) | **DEMONSTRATED** | `information_schema` on the live container returns **zero** tables and **zero** columns matching `vehicle\|driver\|fuel\|truck\|odometer\|mileage\|fleet\|maintenance` in `app` or `platform` |
| Supplier **offline** behaviour | **NOT APPLICABLE — and see §4.2** | There is deliberately no offline path for a supplier write. But a partitioned device holds **no supplier row at all**, which is a larger fact than "no offline write" |

### 3.2 Multi-source purchase orders

| Behaviour | Status | Evidence |
|---|---|---|
| Raise a DRAFT; Σ(`line_net_minor`) equals the client's total | **DEMONSTRATED** | D11 2a–2c, reconciled against Postgres, with counter staff refused the byte-identical order |
| Raiser may submit but is **refused their own approval** | **DEMONSTRATED** | D11 2d–2f: `PERMISSION_DENIED: purchase.order.approve`; the refusal leaves the row `SUBMITTED` with `approved_by_user_id` still null — the *absence of a trace* is measured |
| The **approval money bound**, held in ordinary tenant data | **DEMONSTRATED** | D11 2i–2m: `role_permission.bound.max_order_value_minor = 5000000`; refused at `9000000`, allowed at `900000`, unbounded approver clears the same order. The refusal names **the server's own repriced total**, so a lying client cannot buy its way under the bound |
| Multi-source comparison **across different purchase units** | **DEMONSTRATED** | D12 E1–E4: `SKU-023` with 3 sources across 2 distinct units (`TON`, `BAR_12M`), all comparable, server-ordered by `pricePerStockUnitE4` so display rounding cannot transpose two sources |
| Amend a DRAFT (`updatePurchaseOrder`) | **DEMONSTRATED** | D13 A1–A10: quantity corrected, a line restated verbatim at its **exact agreed rate**, a line added; then refused on a SUBMITTED order with the rows **re-counted** to prove nothing was written |
| Order **offline** | **CORRECTLY REFUSED, and demonstrated** | Raising/approving are commitments against terms a partitioned device may hold stale; they are not in `WIRE_KINDS`. D13 E1–E5 shows every such call answering `offline` rather than queueing a promise |

### 3.3 Goods-received matching

| Behaviour | Status | Evidence |
|---|---|---|
| Receive **with the radio genuinely off**, then drain | **DEMONSTRATED** | D11 3a–3c: complete locally with no network on the path, **absent from Postgres while partitioned** (the partition is verified, not assumed), drains on reconnect acked `applied` in **34 ms** against a 60 000 ms budget |
| The device's conversion equals the server's | **DEMONSTRATED** | D11 3d–3e: `SKU-023`, bought `TON` (scale 3), stocked `BAR_12M` (scale 0), factor `13500/64`; device `toStockQty` == server `qty_stock_computed` |
| On-hand rises by **what was counted**, never what was invoiced | **DEMONSTRATED** | D11 3f: invoiced 1500 TON → conversion says 316 BAR → **counted 313**; on-hand `503 → 816`, delta **313** |
| The receipt **appends** a movement, never sets a counter | **DEMONSTRATED** | D11 3g: 1 row, `qty_delta=313`, `source_kind=RECEIPT` |
| Count variance is **recorded, not absorbed** | **DEMONSTRATED** | D11 3h/3k: an open `CONVERSION_OUT_OF_TOLERANCE` review at severity 2, routed on a permission code that **exists in `platform.permission`** |
| A short delivery is normal, not an error | **DEMONSTRATED** | D11 3i–3j: outstanding = ordered − received; order moves to `PARTIALLY_RECEIVED` |
| **Replay does not double-count** (§2.2) | **DEMONSTRATED** | D11 4a–4b: ack cleared as a flaky link would lose it, device re-sends **through its own transport**, acked `duplicate`, no second movement, no second receipt, on-hand unchanged |
| Partial receipt reconciled line by line | **DEMONSTRATED** | D13 B1–B10: outstanding per line against an **independent SQL** `qty_ordered − Σ(qty_received)`; untouched lines outstanding in full rather than absent |

### 3.4 Reorder points tied to the Phase 1 alerts

| Behaviour | Status | Evidence |
|---|---|---|
| The **same Phase 1 alert row**, joined to a real supplier, expressed in the purchase unit | **DEMONSTRATED** | D11 1e: `shortfall=1000` BAR → `basis=PREFERRED`, `source=CIMAF`, `qtyToOrder=4741 TON`; `suggestions=2`, `unsourced=0` |
| The alert is non-vacuous and threshold-driven | **DEMONSTRATED** | D10 2c–2g and D8 10b–10c: threshold set to 1278 against a **measured** on-hand of 1178; alert list asserted `>= 1` precisely so an empty list cannot pass |
| RBAC on the threshold write | **DEMONSTRATED** | D8 10a/10b/10d/10e: counter staff refused, outlet manager allowed, Accounts refused (`stock.view` absent at every scope), manager refused **out of scope** |
| **Seeding thresholds for a whole location** (`inventory.ensureReorderPoints`) | **ASSERTED ONLY — no client** | See §4.1. API tests exist; **no screen calls it**, so this is untested as a product behaviour |

### 3.5 Third-party haulier dispatch and delivery status

| Behaviour | Status | Evidence |
|---|---|---|
| Plan against a carrier that is a supplier; both status moves ride the **same ordered outbox a sale does** | **DEMONSTRATED** | D11 5a–5e; D12 B1–B2 (`OUT-01:137500 + OUT-22:42100 + OUT-01:9900`, freight intact through the outbox) |
| Haulage spend attributable to the **receiving location** | **DEMONSTRATED** | D11 5f; D13 C1–C9 resolves every carrier to a real `app.supplier` row **by name** and matches per-carrier spend, load count and unpriced-load count row by row |
| **Business date survives a wrong device clock** | **DEMONSTRATED** | D12 B3: `business_date=2026-08-23` while `dispatched_at::date=2026-08-26`, `derived_from=ASSERTED`. D12 C8: the freight lands in the business date's period and the device-clock day reports it absent |
| No row is dated by a device clock since `0010` | **DEMONSTRATED** | D12 H1: rows created after `2026-08-23 21:38:24+00` carrying `DISPATCH_CLOCK` = **0** |
| The product itself asserts the trading day | **DEMONSTRATED** | D13 D1–D12: three deliberately distinct days (entry today, `plannedFor` +2, `businessDate` −5) so no fallback arm can pass by coincidence; `business_date_derived_from` is **NULL** |
| **Correcting a business date after the fact** | **IMPOSSIBLE — confirmed, see §4.2** | There is no `logistics.update`, and `updateDeliveryStatusInput` carries no business date |

### 3.6 The Q1 distribution-cost ratio (what ADR-0001 traded the owned fleet for)

**Status: DEMONSTRATED**, and it is the best-evidenced figure in the system. Fresh from D12 on
this branch:

```
cost 475015 minor · revenue 4550182 minor · pctE4 104395  (= 10.4395% of revenue)
```

It reconciles **four** ways, none of which is the server restating its own arithmetic:

| # | Check | Fresh measurement |
|---|---|---|
| C3 | Σ(per-location) == network, for freight **and** revenue | `475015 == 475015`; `4550182 == 4550182` |
| C4 | Numerator == an **independent Postgres sum** over the same period and scope | `postgres=475015 api=475015`, 14 deliveries, 0 without freight |
| C5 | Denominator == an independent Postgres sum of `(subtotal_net − discount)` | `postgres=4550182 api=4550182` |
| C6 | Percentage == `freight ÷ revenue` **recomputed in the drill** in bigint, half-up | `computedHere=104395 api=104395` |
| C7 | Delivery **counts** agree (a sum matching on a different row set would be luck) | `apiCount=14 pgCount=14` |
| C2 | The figure **moves** when freight is dispatched, by exactly the agreed amount | `285515 → 475015`, delta `189500` |
| D2 | Region rollup sums over `app.location_closure`, not a parent pointer | `REG-BONO(n=6, 8.589%)`, `REG-ASHANTI(n=5, no revenue)` |
| D3 | Groups **nest**, and the response says so | `groupsNest=true`, `Σgroups=950030` deliberately ≠ the network total |

**Scale is stated and integral:** percent × 10⁴, so the financial model's FY1 **5.0%** and FY10
**2.5%** targets (`docs/source-of-truth/financial-model-targets.md` line 66) are exactly `50000`
and `25000`. Never a float.

**Three things remain true beside it and none of them is "the ratio is missing":**

1. It is the **agreed** freight, not an AP invoice — `costBasis: 'AGREED_NOT_INVOICED'` rides on
   every response. There is no GL until Phase 3. This is an *operational* number, not an
   accounting one, and it must not be quoted as one.
2. The **target** was never redrawn after ADR-0001 removed the fleet. The 5.0% → 2.5% decline was
   attributed to an owned fleet absorbing volume. The ERP has kept its half of the bargain — the
   trajectory is now measured. Whether the target is still achievable is a founder-and-accountant
   judgement, not a server question. (`docs/open-questions.md` Q1.)
3. **Do not quote `10.4395%` as Agyasei's distribution cost.** D12 dispatches real freight on every
   run, so the figure rises each run. What is evidence is that it tracks the independent Postgres
   sum exactly, run after run — not the value itself.

### 3.7 Tax-inclusive pricing (this branch's payload — not a Phase 2 capability, but it landed on top of one)

| Behaviour | Status | Evidence |
|---|---|---|
| The customer pays the **shelf price**, not shelf + tax again | **DEMONSTRATED** | D17 B3, C1: stored total == shelf × qty, exactly |
| `net + Σ(tax lines) == total`, re-summed **in SQL** from `sale_tax_line` | **DEMONSTRATED** | D17 C2–C4 |
| The client's split equals the server's, **component by component** | **DEMONSTRATED (with a caveat below)** | D17 D1–D3 |
| A **back-dated** sale reprices against the regime in force *then* | **DEMONSTRATED** | D17 E1–E8: the old composition cascades onto a base above the net, today's does not; **same shelf price, different net**; the till reaches the same back-dated split as the server |
| Replay idempotency on the tax path | **DEMONSTRATED** | D17 G1–G2: byte-identical re-POST acked `duplicate`, no second sale, no second tax line |
| The de-grossing **arithmetic** is pinned to hand-computed values | **DEMONSTRATED** | `packages/money/test/tax-extract-golden.test.ts` — 54 assertions, computed by hand and written out so a reviewing accountant can follow them without running anything |

> **Caveat on D17 D1–D3, and it matters.** `apps/web` and `apps/api` **both** import `@erp/money`.
> Their agreement is therefore two callers of *one* implementation agreeing, not two independent
> implementations agreeing. It proves the wire and the composition selection; it does **not**
> independently verify the arithmetic. The independent verification is the golden file and the
> property tests in `packages/money`, which is the right place for it — but the claim "client and
> server agree" should not be read as a cross-check of the maths.

---

## 4. What is UNCOVERED

**This is the section that matters.** What passes is easy to report and easy to over-read. Below
is what a reader should assume is *not* protected. All of it was found by sweeping the tree
mechanically — a runtime router introspection, a bucket audit, an export walk — not by reading
what the status documents claim.

### 4.0 The route sweep, re-run from the router itself

`appRouter._def.procedures` introspected at runtime: **49 procedures (28 queries, 21 mutations)**.
`docs/phase2-status.md` swept **45**. Four routes have appeared since and were outside that sweep.

Each was grepped against **`apps/web/src` only** — a drill is not a client, a test is not a client
— then routes reached through the outbox were resolved via `WIRE_KINDS` → `DEVICE_OP_KINDS`.

**Six device op kinds** are wired end to end: `sale.create`, `stock.record_movement`,
`sequence.sync_block`, `goods.record_receipt`, `logistics.update_delivery_status`, and
`credit.record_entry` (wire kind `credit_payment`).

**Routes with no client at all, after resolving wire kinds — 8:**

| Route | Assessment |
|---|---|
| `catalogue.list` · `catalogue.detail` · `catalogue.search` | **By design.** The device holds the catalogue locally via the `tenant_reference` bucket; the counter reads SQLite, not HTTP. |
| `provisioning.createTenant` · `applyTemplate` · `ensureSequenceCounters` | **By design.** Onboarding operations run by `pnpm stack:up`, not app surface. |
| **`inventory.ensureReorderPoints`** | **CONFIRMED GAP.** Suspect confirmed. A manager cannot ask the product to seed thresholds for a location that has started trading. Thresholds can only be set one at a time via `inventory.setReorderPoint`. |
| **`inventory.onHand`** | **NEW FINDING, not in any status document.** No call site in `apps/web/src` at all — the only mention is a comment in `StockAdjust.tsx` explaining why that screen does *not* show on-hand. **No screen in the product asks the server what is on hand at a location.** `reports.stockOnHand` covers the reporting view; the operational lookup does not exist. |
| `sales.get` · `sales.recomputeCheck` | Counter reads its own sales from local SQLite, so not an offline hole — but nothing in the product opens a sale the server holds, and **nothing runs the price-drift probe.** See §4.1. |

**Corrections to `docs/phase2-status.md` §3, which is now stale:**
`credit.openAccount` **is** wired (`apps/web/src/data/api/credit.ts:624`), as are `credit.setLimit`,
`credit.setStatus` and `credit.accountForCustomer`; `credit.recordEntry` is reached through the
outbox as `credit_payment`. That document's headline claim — *"no screen can open a customer's
credit account, set a limit, or record a repayment"* — was true when written and is **false now**.
D14/D15/D16 (19/19, 33/33, 37/37) drive all of it live.

### 4.1 §2.7 category 1 — money-touching code with no test

Delegated to `money-test-engineer` as a read-only audit. **The de-grossing arithmetic in
`packages/money` is the best-tested code in this repository** — 116 tests, property-based (2,000
generated runs on the extract/compose round-trip), scale-agnostic across scales 0–4, sign-symmetric,
with hand-computed golden values and deliberate boundary work. I want that said plainly before the
gaps, because the gaps are all one layer up.

**The pattern in the gaps is consistent and worth naming: every fail-closed control and every
mismatch-detector on the money path is unexercised. The code whose whole job is to catch a money
bug in production has never been shown to catch anything.**

| # | Uncovered | Where | Why it matters |
|---|---|---|---|
| 1 | **`recomputeCheck` — 12 mismatch branches, 0 exercised** | `apps/api/src/routers/sales.ts:896` | Every assertion in the repo is `expect(check.mismatches).toEqual([])` (×3). **An implementation returning `{mismatches: []}` unconditionally would pass the entire suite.** This is the price-drift audit tool. Contrast `comparePriceCheck`, which *does* have a negative control (`price-check.test.ts:86`) — that is the standard this fails. Compounded by the route having **no client** (§4.0). |
| 2 | **Pack fail-closed refusals never fired** | `apps/api/src/tax.ts:201` `assertPackPriceable`, `:165` `assertLineRounding` | These exist so a counter sees "this pack cannot price today" rather than a 500. The happy path runs on every sale; **the refusal path has no test.** A sale on a business date with no rate rows in force should be refused — nothing proves it is. |
| 3 | **`assertAggregateIdentity` — the report guard that never fires** | `apps/api/src/routers/reports.ts:106` | Its own comment says it exists "so that the day somebody adds a predicate to one query and forgets the other, the report stops rather than lies." **Zero tests reference it or `REPORT_IDENTITY_VIOLATION`.** The reconciliation tests confirm the identity holds; none confirms the guard detects it breaking. This is the guard behind the Q1 ratio's Σ=network claim. |
| 4 | **`netRoundingModeFor` duplicated, with no test pinning the copies together** | `apps/api/src/tax.ts:270` **and** `apps/web/src/data/pricing/cart-pricing.ts:128` | The code *identifies its own hazard*: "ONE RULE, TWO PLACES, DELIBERATELY IDENTICAL… The duplication is the defect risk… these two functions must be changed together." **There is no test that pins them to agree.** Both have zero direct test references. Cheapest high-value missing test on this branch. |
| 5 | **Credit policy fields read nowhere** | `apps/api/src/credit-policy.ts:25,27,31` | `feeBasis`, `feeCompounds`, `feeDayCount` are declared, defaulted, and **read by no code**. `computeFeeAccruals` reads only `feeGraceDays`. If the accountant confirms `actual_365` at the §2.8 gate, the system silently accrues 30E/360 anyway. **A configuration surface that lies.** Not testable today because `confirm()` cannot set them. |
| 6 | **`mergeTaxLines` per-component document figures** | `apps/web/src/data/pricing/cart-pricing.ts:141` | No web test asserts `residualMinor`, `computedMinor` or `baseMinor` at document level. A bug accumulating into the wrong component bucket, or dropping residuals, is not caught client-side. |
| 7 | **`roundingModeOf` silent fallback** | `apps/api/src/routers/sales.ts:1113` | An unrecognised stored mode silently becomes `'down'`, where the *write* path throws. Protected today only by a DB check constraint; **no test pins the three-way correspondence**, so widening the constraint would silently misreprice history with nothing going red. |
| 8 | `days30` (30E/360 day count) | `apps/api/src/credit-policy.ts:87` | No direct test. 31st→31st, negatives and year boundaries unpinned. |
| 9 | `floorDivRem` | `packages/money/src/rounding.ts:61` | Public money API, exported, zero direct tests. It is what makes `allocate` correct for negative totals. |
| 10 | `valueAt` — weighted-average cost → COGS → gross margin | `apps/api/src/routers/reports.ts:334` | Indirect only. A single-rational WAC valuation with a `divRound(…, 'half-up')` whose rounding boundary is asserted nowhere. The one I would most want unit-tested. |

**Fourteen further money functions are covered only indirectly** — including `extractLineTaxes`
(the server-side de-grossing entry point), `priceInclusive` (the two-extraction discount rule),
`taxComponentsInForce`, `computeFeeAccruals`, `loadHaulageSpend` and `readPricingBasis`. A break in
any of them turns something red, but three layers up as a wrong sale total, not at the arithmetic.

**Latent, not live — stated as such.** `cart-basis.ts` calls a counter-display vs recorded-sale
divergence "the worst kind of bug at a counter: quiet, and only discovered at cash-up." The two
callers resolve the basis through different arities of `resolveCartPriceList` (3 args vs 4 with an
override). They agree today only because the UI never passes an override. **No test asserts
`priceCart(...).grossMinor === checkout(...).totalMinor` for the same cart.**

**§2.8 review outstanding on a money rule:** `priceInclusive`'s two-extraction discount rule
(`sales.ts:203`) carries its own note — *"NEEDS A HUMAN (CLAUDE.md §2.8): an accountant should
confirm this… it is the one place where the figure stored is not the figure typed."* That review
has not happened.

**No test reconciles any computed figure to `docs/source-of-truth/financial-model-targets.md`.**
Zero references from any test. There is also **no fiscal-year concept anywhere** in the codebase —
nothing reasons about 1 Aug–31 Jul; reports take explicit `from`/`to`. Nothing is wrong today, but
"reports tie to the model" is currently unevidenced.

#### What `tools/lint-money.mjs` does not catch — and I proved it by mutation

The linter passes. It is 47 lines and two regexes, and it is much weaker than a green result
suggests. **I mutation-tested it (§6.1) rather than reading it and guessing.** Confirmed blind spots:

- **Return types are invisible** — `function totalMinor(): number` cannot match, because the
  character before `:` is `)`.
- **One match per line.** The regex is non-global, so in `{ id: number; totalMinor: number }` only
  `id` is examined and the money field is never seen. **Demonstrated red→green in §6.1.**
- **The money-word list has large holes** — `margin`, `discount`, `revenue`, `freight`, `spend`,
  `commission`, `payment`, `charge`, `wage`, `salary`, `qty`/`quantity`, `tender`, `value` are all
  absent. **Demonstrated in §6.1: six such fields typed `number` pass clean.** Note `qty` — §2.3
  requires quantities be scaled integers too, and the linter cannot see a float quantity at all.
- `tax_` requires an underscore, so camelCase `taxRateBp: number` slips through.
- **`Number(...)` coercion is invisible** (case-sensitive regex).
- **It never inspects SQL embedded in `.ts` template literals** — which is where essentially all
  query SQL in this codebase lives. A `::float8` cast or an `avg()` inside `tx.query()` is unchecked.
- SQL column rule only fires when the column *name* contains a money word: `rate_bp numeric`,
  `margin numeric`, `qty_scaled real` all pass clean.
- It walks only `packages/` and `apps/` — **not `infra/`**, which holds `dev-prices.ts` and
  `dev-purchase-units.ts`.

**The real guard is elsewhere and is much better:** `packages/db/test/conformance.test.ts:126`
queries `pg_attribute` and resolves domains to their base type, so "a domain over float8 cannot
hide". **Cite that at the gate, not the linter.** Two caveats: it is scoped
`where n.nspname = 'app'`, so **`platform.tax_rate` and `platform.jurisdiction` — the rate rows and
the currency minor-unit scale — sit outside it**; and it is itself an `expect(rows).toEqual([])`
with no negative control.

#### Money tests that are vacuous or near-vacuous

1. `expect(check.mismatches).toEqual([])` ×3 (`tax-inclusive.test.ts:327`, `:402`,
   `tax-boundary.test.ts:108`) — the most consequential.
2. `expect(res.rows).toEqual([])` in the no-float conformance test — sound query, no negative control.
3. `assertAggregateIdentity` / `REPORT_IDENTITY_VIOLATION` — zero references.
4. `expect(preview.accruals).toEqual([])` (`credit.test.ts:311`) — passes when accrual correctly
   stops *and* when `computeFeeAccruals` returned `[]` for the wrong reason.

**Worth stating plainly:** the auditor found **no** tautologies, self-comparisons, or tests that
re-implement the arithmetic under test. The money package compares against independently-stated
golden values, not a second copy of the implementation.

#### Where money coverage is genuinely good

Ageing bucket edges are tested at days 0/30/31/60/61/90/91 individually. Reconciliation identities
are real, including **inter-location transfers create no network revenue** and **COGS counts SALE
outflow only** — both inter-outlet inflation risks are covered. Gross margin and inventory days are
integer-E4 and **withheld as `null`, never zero**, where the cost basis is incomplete. No
hard-coded minor-unit scale exists anywhere. No float/numeric money column exists in any of the 14
migrations — verified by reading all 14 regardless of column name, not via the linter.

### 4.2 Phase 3 categories: nothing tested because nothing is built

No general ledger, journal-entry or posting table exists. Payroll exists only as two permission
codes. §2.7's "GL postings" and "payroll figures" therefore have **zero coverage because they have
zero surface** — correct for Phase 2, but the Phase 3 gate will need debits-equals-credits and
reversal-nets-to-zero properties and none of that scaffolding exists. **No bank reconciliation**
(§2.8 calls it required) and **no accountant review of the ledger** — both Phase 3 gates, neither
started.

### 4.3 §2.7 category 2 — sync and conflict paths with no test

Delegated to `sync-test-engineer` as a read-only audit; the three most serious findings I then
verified myself against the live container. **The partitions in D1/D2/D6/D7/D8 are real** — a
separate `@powersync/node` client per device, its own sqlite file, its own token, and
`powersync.disconnect()` actually severing the stream. That discipline is better than most. The
gaps below are elsewhere.

#### 4.3.1 The bucket audit — suspect CONFIRMED, exactly

`infra/powersync/sync_rules.yaml` defines **7 buckets covering exactly 23 tables**, against 50 base
tables in `app` + `platform`. The container mounts the repo file read-only, so there is no
deployed-vs-repo drift.

**In a bucket (23):** `tenant_reference` (9: `location`, `location_type`, `unit_of_measure`,
`product_category`, `product`, `product_uom`, `price_list`, `price_list_item`, `movement_reason`) ·
`jurisdiction_pack` (3: `platform.jurisdiction`, `platform.tax_code`, `platform.tax_rate`) ·
`tenant_customers` (1) · `location_ops` (2: `stock_movement`, `sale`) · `tenant_credit` (5) ·
`location_credit_allowance` (1) · `tenant_sale_lines_interim` (2).

**NOT in any bucket — the complete procurement list (10):** `supplier`,
`supplier_capability_type`, `supplier_capability`, `supplier_product`, `purchase_order`,
`purchase_order_line`, `goods_receipt`, `goods_receipt_line`, `delivery`, `reorder_point`.

**Zero procurement tables in any bucket.** Also absent: `conflict_review`, `sequence_counter`,
`role`, `role_permission`, `user_account`, `location_closure`, `write_log`.

Consequences, and the fourth is the one nobody has stated:

1. A partitioned device can **write** `goods.record_receipt` and
   `logistics.update_delivery_status` but can **never read back what it wrote** — there is no local
   `goods_receipt` or `delivery` table. `data/queries/procurement-outbox.ts` reconstructs the yard's
   view by re-parsing the *queued outbox payload*. Once acked, the receipt exists on that device
   only as a historical payload, and **a second device at the same yard sees nothing.**
2. A device that never took a take-down while online **cannot record a receipt against an order at
   all** — it holds no `purchase_order_line.id` and no `supplier_id` to name.
3. Reorder points and low-stock alerts are **online-only** (`features/stock/LowStock.tsx` reads via
   `useApiQuery`).
4. **The take-down mitigation is not exercised by any live drill.** D11 builds its offline receipt
   from ids read **straight out of Postgres** via `scoped(...)`, and seeds the device catalogue with
   `seedProduct`/`seedPurchaseUnit`. **The drill's "partitioned device" therefore holds procurement
   reference data that a real partitioned device could never have obtained.** D11's offline
   receiving demonstration is real as far as the *write path* goes, and is **not** a demonstration
   that a real yard can receive goods offline. The take-down is covered only by in-process unit
   tests (`apps/web/tests/receiving-ui.test.tsx`).

#### 4.3.2 Synced tables that nothing reads — a new finding

Mechanical count of `FROM|JOIN <table>` across `apps/web/src`:

| Synced to every device | PWA readers |
|---|---:|
| `stock_movement` | **0** |
| `sale` | **0** |
| `sale_line` | **0** |
| `sale_tax_line` | **0** |
| `credit_limit_version` | **0** |

The device downloads every stock movement and every sale, line and tax line for its location, and
**no query in the PWA reads any of them** (`queries/sales.ts` reads the *outbox* only). **There is
no offline on-hand lookup anywhere**, despite §2.6 granting outlet staff "POS **and stock lookups**".
`packages/wire-conformance/test/sync-rules-to-device.test.ts` checks table *declaration* in both
directions but has no check for "a synced table nothing reads", so this is invisible to the suite.
This bears directly on Phase 1 criteria 1 and 2 — see §5.

#### 4.3.3 The human review queue is WRITE-ONLY — I verified this myself

**This is the most serious structural gap in this document and it appears in no status doc.**

§2.2 is categorical: *"Every conflict that cannot be resolved automatically goes to a human review
queue. Never silently overwritten."* Rows do reach the queue. **No human can ever see them.**

- Only three paths open a review — sequence-block regression, receipt-number collision, conversion
  out of tolerance. All three are tested, and the receiving one has a genuine non-vacuity guard.
- **There is no review router.** `appRouter` mounts 11 routers; **none of the 49 procedures reads
  `conflict_review`.** Verified against my own runtime route introspection.
- **There is no review bucket** (deliberate, documented).
- **There is no online read either** — no tRPC route, no PWA screen, no badge. Verified by grep:
  zero references to `conflict_review` anywhere in `apps/web/src`.

Live container, read by me:

```
CONVERSION_OUT_OF_TOLERANCE        | open | 2
RECEIPT_NUMBER_COLLISION           | open | 2
SEQUENCE_CONSUMED_UPTO_REGRESSION  | open | 2
-> 0 resolved of 6 total; claimed = 0
```

**Every review row ever created is still open. None has ever been claimed or resolved, because
nothing can claim or resolve one.** `escalate_at` and `escalation_level` are written and **no
scheduler exists anywhere in the repo** — no cron, no worker, no job.

To be fair to the design: both versions and both authors *are* preserved (`proposals` jsonb carries
per-party provenance with money as strings), and `pending_state`/`pending_value` are written
correctly. The detection half is sound. The **resolution half does not exist**, so there is no test
of a review "behaving sensibly while pending" because there is no surface on which it behaves.

**Also missing: the negative.** D2 does **not** assert that zero reviews were opened after
two-device stock convergence, so "automatic convergence does not flood the queue" is inferred, not
demonstrated. (The credit-offline drill *does* assert zero reviews of a class — so the pattern
exists and is simply not applied in D2.) Cheap to add.

#### 4.3.4 The canonical credit-limit conflict — NOT tested as §2.2 specifies

§2.2 names the hard case: *"two locations editing the same customer's credit limit while both
offline."*

- `credit.setLimit` is **online-only** — not in `DEVICE_OP_KINDS`, not in `WIRE_KINDS`. A device
  physically cannot queue a limit change.
- The mechanism is a **compare-and-set** on `supersedesId`; a stale claim is refused
  `CONFLICT: LIMIT_VERSION_STALE`. **No `conflict_review` row is opened.**
- The only test is `apps/api/test/credit.test.ts:409`. It is **one caller, two sequential
  in-process calls against PGlite. No devices, no locations, no partition, no network.** The
  comment "two people, each holding the same version" is narrative, not mechanism.

**Verdict: the refusal semantics are tested; the scenario the constitution names is not**, because
the code deliberately forecloses it. That is a defensible design choice — but the gate should record
that §2.2's canonical hard case has **no partition test, no two-device test and no review-queue
test**, rather than assume it is covered.

Latent hazard, worth one pinning test: `LIMIT_VERSION_STALE` is prefixed `CONFLICT`, which
`classifyRejection` maps to **retryable**. If `setLimit` ever became device-uploadable, the client
would resend the same stale `supersedesId` every 30 seconds **forever**. Nothing asserts `setLimit`
stays off the outbox beyond the `WIRE_KINDS` pin.

#### 4.3.5 `credit.open_account` — the one wire kind with no coverage at all

| Wire kind | offline→drain | replay | conflict |
|---|:--:|:--:|:--:|
| `sale.create` · `stock.record_movement` · `credit.record_entry` · `sequence.sync_block` · `goods.record_receipt` · `logistics.update_delivery_status` | all ✅ | all ✅ | all ✅ |
| **`credit.open_account`** | ❌ **none** | ❌ **none** | ❌ **none** |

It is accepted by `/sync/upload` and dispatched by `DEVICE_OPS`, but the PWA never queues it.
Concrete untested hazard: `customer_account_customer_uq` is unique on `(tenant_id, customer_id)`, so
two partitioned clients opening an account for the same customer produce a duplicate-key
`INTERNAL_SERVER_ERROR`, which `classifyRejection` treats as **retryable** — **the queue wedges
forever.** Latent rather than live (unreachable from the PWA today), but it is an accepted server op
with zero coverage.

#### 4.3.6 `businessDate` — client-claimed, authoritative, unbounded, untested for skew

| Client-claimed value | Trusted? | Bounded? | Skew-tested? |
|---|---|---|---|
| `claimed_hlc` | no — forensics only | ±24h clamp (`pipeline.ts:79`) | ✅ |
| `occurredAt` (delivery) | no | n/a | ✅ D12 B3 (3-day-fast tablet) |
| `effectiveFrom` (setLimit) | yes | no future-dating | ✅ |
| **`businessDate`** | **YES — authoritative for tax repricing, ageing and period** | **format only** | ❌ **NO** |

`zBusinessDate` validates the *format* and nothing else. The client derives it from the device
clock in the location timezone. **A tablet three days fast posts a sale dated three days in the
future, and the server accepts it and reprices tax against the rate row in force on that date.**
Nothing anywhere refuses an out-of-range business date. The ±24h HLC clamp does **not** cover this:
`claimed_hlc` is optional, so an op without one bypasses the clamp entirely and can still carry any
`businessDate`.

This is directly adjacent to this branch's subject. Tax-inclusive pricing makes the business date
*more* load-bearing, not less: it selects the composition that determines the net/tax split of the
price the customer already paid.

Also: **no drill anywhere runs a fleet with disagreeing clocks.** Every device in
`packages/sync-drills/src/device.ts` builds its claim from `Date.now()`. The skew tests that exist
are single-process, sequential, hand-built claims.

#### 4.3.7 Further sync gaps with no test

- **A backlog over 500 ops stops draining after one pass — this looks like a live bug, not just a
  coverage gap.** `readPendingOps` caps at `MAX_UPLOAD_BATCH` (500); `SyncRuntime.drainNow`
  reschedules only on `report.deferred > 0 || !report.transportOk`. A device with 600 pending ops
  drains 500 (deferred = 0, transportOk = true), **schedules nothing, and the remaining 100 sit**
  until the next local write or reconnect. For a district outlet offline for days and reconnecting
  after close, that is a queue that stops mid-drain. `sync-upload.test.ts:266` asserts "the rest
  stay pending"; **nothing asserts another pass follows.**
- **No client/server schema-version negotiation exists.** `schema_version` is a hard-coded literal
  `1`. "Converge, or fail loudly and refuse to write" after a long offline has nothing behind it.
- **The receipt-number regression path is unreachable as shipped.** `data/powersync.ts:239` says so
  itself: *"KNOWN GAP … nothing yet ENQUEUES the report on reconnect."* D7 and the conformance test
  queue it by hand. The wipe/reinstall defence is demonstrated in drills and **cannot fire in the
  product.**
- **Partial batch + lost response** (server applies ops 1–3 of 5, connection dies, client resends
  all 5) is structurally safe but never demonstrated. Worth one test given `sequence.sync_block`
  must precede its sales.
- **Storage exhaustion on a low-end Android tablet** — a real field condition, zero coverage.

#### 4.3.8 A check that cannot fail — found and confirmed by reading the harness

The auditor found **no vacuous verifier in the sync suite proper**, and the non-vacuity discipline
is genuinely good (`DrillResult.pass` requires `checks.length > 0`; D8 enforces that every zero has
a same-run positive control returning N > 0). One exception, which I verified myself:

```ts
// live-operations-drill.ts:467  and  live-procurement-drill.ts:759
measure(`offline goods receipt drained on reconnect in ${elapsed}ms (budget 60000ms)`);

function measure(line: string): void { measurements.push(line); console.log(...); }   // :98
```

**`measure()` has no pass/fail.** It pushes a string and prints it. **The "budget 60000ms" in D10
and D11 is decorative — those two drills do not assert the 60-second criterion at all**, whatever
the elapsed time. In drill output it reads exactly like a criterion.

**D1 does it correctly** and is the reason criterion 1 still stands:
`r.check('p95 < 60s', p < LIMIT_MS, …)` plus a per-iteration hard `total < LIMIT_MS`.

I have quoted the 34 ms and 22 ms figures in §3 as measurements, which is what they are. **They are
not assertions.** If receiving ever took 90 seconds to drain, D11 would still print PASS.

### 4.4 §2.7 category 3 — read paths with no second-tenant test

Delegated to `tenant-isolation-test-engineer`. This is the category whose failure mode §2.1 calls
**unrecoverable**, so I have reported it at full resolution.

#### 4.4.1 The honest count

**28 query procedures** (from my own runtime introspection of `appRouter._def.procedures`):

| Isolation coverage | Count | Which |
|---|---:|---|
| Real, non-vacuous two-tenant test | **19** | — |
| **Partial** — refusal-only; nothing asserts the *aggregate* excludes the other tenant | **3** | `reports.inventoryDays`, `reports.cashPosition`, `reports.stockOnHand` |
| **Vacuous** | **1** | `catalogue.detail` |
| **No automated two-tenant test at all** | **5** | `procurement.reorderSuggestions`, `sales.get`, `sales.recomputeCheck`, `credit.previewFacilityFee`, `session.permissions` |

Also enumerated: **7 PowerSync buckets**, **3 non-tRPC HTTP routes** (`POST /sync/upload`,
`GET /sync/token`, `GET /healthz`), and **zero export/download paths** — there is no CSV, no PDF and
no `Content-Disposition` anywhere in the tree, so that sub-category is **empty, not covered**.

#### 4.4.2 Vacuous isolation tests — confirmed, and one is the exact shape this repo has caught before

- **`catalogue.detail` — genuinely vacuous.** `apps/api/test/isolation.test.ts:69-88` asserts a
  foreign id and a nonexistent id both throw `NOT_FOUND` with identical messages. **`catalogue.detail`
  appears exactly once in the whole repository outside its own router definition — at
  `isolation.test.ts:77`, inside the throwing branch.** There is no positive control anywhere that
  the route ever returns a product. **A stub that unconditionally threw `NOT_FOUND` would pass.**
  (A live probe confirms the route does work — so the route is fine and the test is worthless.)
- **`reports.stockOnHand` — the `[].every()` shape, again.** `apps/api/test/reports.test.ts:710-712`
  loops over `stockA.locations` and `stockA.networkByProduct` asserting each id is not tenant B's,
  with **no `expect(...length).toBeGreaterThan(0)` in the block. An empty report passes.** This is
  precisely the failure class the brief warned me about, still present.
- `reports.distributionCostRatio` — weaker version of the same at `distribution-cost.test.ts:605-608`;
  mitigated by `777777` marker assertions above it, so lower severity.
- The `99000000` marker collision **is fixed** — the marker is now `96431907`, chosen to end in a
  non-zero digit so it cannot collide with a dev `unit_price_e4`
  (`packages/sync-drills/src/drills/d8.ts:30-42`).

#### 4.4.3 The structural backstop — excellent in `app`, ABSENT in `platform`

Verified against the **live container**, not PGlite:

- **All 45 `app.*` tables:** `relrowsecurity = t`, `relforcerowsecurity = t`, `tenant_id` present,
  exactly one policy each, tenant-leading index. **Zero gaps.** No unique index anywhere in `app`
  fails to lead with `tenant_id`, so no uniqueness error can act as a cross-tenant existence oracle.
- **Fails closed:** an unpredicated query as `app_user` (`nosuperuser`, `nobypassrls`) with **no GUC
  set returns 0 rows and no error**. With tenant A's GUC set, `count(distinct tenant_id) = 1`.

**The gap is `platform.*` — six tables with RLS OFF and NOT FORCED, all readable by `app_user`:**

```
platform.jurisdiction |f|f     platform.tenant          |f|f
platform.permission   |f|f     platform.tenant_database |f|f   (has tenant_id, no RLS)
platform.tax_code     |f|f     platform.tax_rate        |f|f
```

Running as `app_user` **with tenant A's GUC set**:

```
select * from platform.tenant;           -> 2 rows: agyasei-jnr AND kumasi-builders (legal names)
select * from platform.tenant_database;  -> 2 rows, incl. the other tenant's dsn_ref and
                                            sync_service_ref
```

**Not currently reachable through any tRPC query** — both readers (`sales.ts:129` `loadJurisdiction`,
`logistics.ts:98` `loadPackMoney`) predicate on `app.current_tenant()`. So this is **not a live
breach**. But §2.1 says *"RLS is the backstop… so a forgotten predicate fails closed instead of
leaking"*, and **for the platform schema there is no backstop and no test**:
`packages/db/test/conformance.test.ts:61` filters `where n.nspname = 'app'`, putting the entire
platform schema outside the structural check. One forgotten predicate in a future resolver leaks the
**tenant registry** — every customer's legal name and database reference.

#### 4.4.4 Views, idempotency keys, error oracles

- **Views: clean.** Five views in `app`, **all `security_invoker = true`**; zero materialized views.
  Migration `0014_credit_view_template_correction.sql` **creates no view** despite its name — it is a
  `DO` block withdrawing `credit.view` grants plus two `COMMENT ON` statements. The "new view
  silently bypasses RLS" risk does not materialise on this branch.
- **Idempotency keys are per-tenant, and tested at both layers.** `app.write_log` is
  `PRIMARY KEY (tenant_id, id)` — the only unique index on the table. Covered by
  `packages/db/test/write-log.test.ts:61` and `apps/api/test/idempotency.test.ts:117-141`. Solid.
- **Client-supplied `tenant_id` is closed everywhere probed.** All 30 exported contract `ZodObject`s
  are strict; all 9 `ZodEffects` wrappers behaviourally rejected `tenant_id` / `tenantId` / `tid`.
  Live probes returned `BAD_REQUEST unrecognized_keys` on six routes. *Caveat:* the strictness tests
  are hand-listed subsets, not enumerated from module exports — **a new schema without `.strict()`
  would slip through.**
- **Token tampering fails closed on all four variants** — tampered `tid`, re-signed with the wrong
  secret, `alg=none`, expired: 401 at both `/trpc` and `/sync/token`.
- **No existence oracle found.** Foreign vs nonexistent ids are byte-identical on every path probed,
  including `sales.get`, `sales.recomputeCheck`, `credit.previewFacilityFee`, `catalogue.detail`,
  `inventory.onHand`, `procurement.suppliersForProduct` and `reports.salesByLocation`.
- **Unrelated but worth one line:** `apps/api/src/trpc.ts:37-41` `errorFormatter` is a pass-through
  `return shape`, so error responses carry **full stack traces with absolute filesystem paths**. Not
  a tenant leak; it becomes information disclosure if `NODE_ENV` is ever not `production` in a
  deployed environment. I saw this myself in the very first 400 response I triggered.

#### 4.4.5 Sync-layer isolation — the strongest evidence in the repository

| Bucket | Device-level proof |
|---|---|
| `tenant_reference` · `tenant_customers` · `location_ops` · `tenant_sale_lines_interim` | **D5** — raw sqlite bytes |
| `tenant_credit` · `location_credit_allowance` | **D8** |
| **`jurisdiction_pack`** | **UNTESTED** — both fixture tenants are `jurisdiction_code = GH`, so the two devices legitimately receive identical rows and the check cannot distinguish. `platform.jurisdiction/tax_code/tax_rate` carry no `tenant_id`, so D5's sweep is trivially satisfied. Low severity (Ghana is the only pack) but **not demonstrated** |

D5 and D8 are excellent and I re-ran both today (8/8). D5 goes past row counts to a **byte grep over
the sqlite file and its `-wal` sidecar**: `0 foreign rows` and *"tenant B's uuid appears NOWHERE in
the file's stored rows"*, with explicit non-vacuity controls on both sides (tenant A device: 1501
rows on disk, all 23 synced tables matching a server-side prediction; tenant B device: 1048). D8
additionally proves grant→fill, revoke→empty, and a **forged-`tid` token receiving zero rows in every
credit bucket** with a same-run positive control showing the honest `tid` held rows.

**Structural gap:** there is **no test asserting every `data:` query in `sync_rules.yaml` carries
`WHERE tenant_id = bucket.tenant_id`**, and none asserting no parameter query uses
`request.parameters()`. `sync-rules-to-device.test.ts` checks table/column agreement only. A new
bucket with a forgotten tenant predicate is caught **only** by D5's uuid sweep, and **only when
someone runs the drill** — and no CI or `pnpm test` path runs the drills.

#### 4.4.6 This branch's own change has no cross-tenant test

`sales.ts` (+329) and `tax.ts` (+206) rewrote price-list resolution. **`sales.ts:327-333` and
`:402-410` query `app.price_list` and `app.price_list_item` with no tenant predicate at all — RLS is
the sole control.** That is the correct pattern and RLS is verified enabled and forced. But
`apps/api/test/tax-inclusive.test.ts` provisions **one** tenant, `sales.recomputeCheck` has no
two-tenant test, and `live-inclusive-pricing-drill.ts` **contains no reference to tenant B at all**.

**The branch's headline change rests entirely on an untested backstop.**

Client-side, `apps/web/tests/device-price-list.test.ts:753-777` concedes in its own comment that its
refusal is "by scope and effective window — never by comparing tenant ids". The client filter is
literally `tenant_id IS NOT NULL` (`device-price-list.ts:164`) — **zero tenant discrimination**. The
real control there is the sync rules, and D5 proves those.

---

## 5. RBAC — a demonstrated failure, found by probing rather than reading

RBAC is not one of the three mandatory categories; it is mine under the general strategy, and my
brief singles out *"particularly that outlet staff genuinely **cannot** override a price or change a
credit limit."* I probed it live rather than reading the role table.

### 5.1 Credit limits — outlet staff genuinely cannot. Demonstrated.

D8 2a/2b: counter staff **and** the outlet manager are both refused
`credit.account.manage`; only Accounts holds it, at the tenant root. D8 8a: counter staff are bounded
at `0` for `sale.record.credit`, so any credit sale exceeds it, **with a positive control (8b) that
the identical cart succeeds for CASH** — the refusal is the bound, not a broken route. D8 8f: a till
claiming `clientTotalMinor: "1"` is still refused, because the bound reads the **server's** repriced
total. **This half of §2.6 is properly enforced and properly demonstrated.**

### 5.2 Price overrides — outlet staff CAN, in effect. **DEMONSTRATED FAILURE.**

Two permission codes exist in `platform.permission`:

| Code | Granted in tenant #1's template | Enforced in any router |
|---|---|---|
| `sale.override_price` | **nobody** | **nowhere** — zero references in `apps/api/src` |
| `sale.discount.apply` | Outlet manager, Regional manager — `bound = {"max_bps": 300}` | **nowhere** — zero references in `apps/api/src/routers/*.ts` |

`session.permissions` for a live counter-staff principal returns nine codes, and **neither of these
is among them**:

```
catalogue.view · customer.view · logistics.delivery.view · sale.receipt.reprint
sale.record · sale.record.credit · sale.view · stock.transfer.receive · stock.view
```

Yet `saleLineInput.lineDiscountMinor` is an ordinary `zScaledIntNonNeg` field on every line, and
**nothing authorises it.** I rang four sales as that counter-staff principal against the live API:

| `lineDiscountMinor` sent | HTTP | Result written |
|---|---|---|
| `0` (control) | **200** | `net=10000 disc=0 total=12000` |
| `100` | **200** | `net=10000 disc=83 total=11900` |
| `11999` | **200** | `net=10000 disc=9999 **total=1**` |
| **`12000`** | **200** | `net=10000 disc=10000 **total=0**` |
| `12001` | 400 | `line discount exceeds line amount` |

**A counter-staff device gave the goods away for nothing — `total_minor = 0` — and the server
accepted it, priced it, wrote it and returned 200.**

The only ceiling is **arithmetic** (`discount <= line amount`), not **authorisation**. The
`max_bps: 300` bound the template authored — 3% — is enforced nowhere. The RBAC primitives are
tested at the state level (`rbac.test.ts:370-377` exercises `requireWithinBound` correctly), but **no
sale path ever calls them**, and `rbac.test.ts:336` carries a comment conceding the wiring is absent.

**Assessment.** §2.6 says outlet staff have *"**no** pricing overrides"*. A 100% discount is a
pricing override by any commercial definition — it is the shrinkage route a POS exists to close.
This is not a hypothetical: it is four HTTP 200s against the current build.

I want to be precise about what is and is not compromised. The **server always prices** — D6 shows
`server=19081 till=29700`, the till's claim discarded and the divergence reported. That structural
guarantee holds and is excellent. **The discount is a separate field that bypasses it.**

*(Artefacts declared: this probe wrote four real sales at OUT-01 in tenant A —
`QA-DISC-ctl-…`, `QA-DISC-small-…`, `QA-D2-almost-…`, `QA-D2-full-…`. Dev-stack data, named here
rather than left to be found.)*

### 5.3 The rest of RBAC is strong

D8's 30/30 covers the role × action matrix over real HTTP with a positive control beside every
refusal: closure expansion from a single regional grant (4a–4c), segregation of duties for Accounts
(5a), **revocation refusing the same unexpired token on the next request** (6a — the decision is a
database read per request, never a token claim), and a forged `role` claim in a counter-staff grant
being ignored (7a–7b). `apps/api/test/rbac.test.ts` and `sales-rbac.test.ts` cover the full role
matrix including `head_of_operations`.

**One coverage note:** `head_of_operations` is the tenant's `is_owner` role — 0 explicit grants,
because `is_owner` is the one structural flag the platform reads. It is covered by in-process API
tests but **appears in no live drill**, so the single role that bypasses the entire permission
catalogue is asserted, never demonstrated over real HTTP.

---

## 6. Phase 1 regression — do the five acceptance criteria still hold on this branch?

Phase 1 acceptance is a **standing guarantee**, not a one-time event. Phase 2 and the tax-inclusive
work have landed on top of it. I re-ran the sync acceptance suite on this branch — **8/8 drills,
generated 2026-08-23T22:25:49Z against PID 43223** — rather than citing the committed report.

> *Note: `pnpm --filter @erp/sync-drills drill` **rewrites `docs/sync-drill-report.md`** as a side
> effect. My run regenerated it (88 insertions / 88 deletions — every one a timing or a row count,
> no structural change). I reverted the file to keep the tree clean per instruction, and quote the
> fresh figures below. The committed report and my run agree on every PASS.*

### Criterion 1 — airplane-mode sale, syncing within 60 s. **HOLDS.**

`packages/sync-drills/src/drills/d1.ts`. **Real partition:** `powersync.disconnect()` severs the
stream, with a proper negative control (*"sale must NOT be on the server while offline"*) that
`continue`s the iteration if it fires. 5 iterations, a per-iteration hard `total < 60_000`, and a
hard `r.check('p95 < 60s', …)`.

Fresh: iterations 212 / 209 / 424 / 221 / 209 ms; **p95 = 424 ms against a 60 000 ms limit.**
Genuinely asserted, not merely measured.

> **Honesty caveat.** D1's device-visibility half asserts `select id from sale where id = ?` on
> device A2. Per §4.3.2, **no production code reads the local `sale` table.** D1 proves the sync
> layer delivered the row; it does **not** prove any screen could show it. The criterion as written
> ("syncs correctly") is met. The operational reading ("the other till sees it") is true only via
> the online API.

### Criterion 2 — two devices, same SKU, both offline, reconciling. **HOLDS — strongest test in the repo.**

`d2.ts`. **Real partition on both devices**, separate sqlite files, separate tokens, with a
pre-check that nothing reached the server while partitioned. Assertions are on **correctness**, not
mere agreement:

| Check | Fresh measurement |
|---|---|
| No movement reached the server while partitioned | `actual=0 expected=0` |
| Server on-hand = baseline + Σdeltas, exact bigint | `1076 + 105 = 1181` |
| Device A1 local on-hand == server | `1181 == 1181` |
| Device A2 local on-hand == server | `1181 == 1181` |
| A1 and A2 movement ledgers identical **row for row** | 38 rows each, byte-identical |
| Converged ledgers non-empty (non-vacuity) | 38 rows |
| `write_log` rows per op key — no loss, no duplication | `[1,1,1,1]` |
| Exactly one `stock_movement` per op | `4 == 4` |

Two caveats, both stated rather than buried: **(a)** it does **not** assert that zero
`conflict_review` rows were opened, so "converges automatically without flooding the queue" is
inferred, not demonstrated — and per §4.3.3 nobody could read those rows anyway; **(b)** the
converged `stock_movement` state it asserts on is a table **no PWA screen reads**.

Note also what this criterion does and does not exercise. Stock movements are **append-only signed
deltas**, so they commute — this demonstrates *convergence*, which is what the criterion asks for.
It is **not** a demonstration of conflict *resolution*. The genuinely hard case §2.2 names — two
locations editing one credit limit while both offline — is **§4.3.4, and it is not tested.**

### Criterion 3 — credit balance, ageing and facility fee after mixed cash and credit across outlets. **HOLDS, with the fee explicitly GATED.**

D9 (13/13), D14 (19/19), D15 (33/33), D16 (37/37). Fresh:

- Exposure is the exact bigint sum of two credit sales rung at **two different outlets**:
  `865200 = 370800 (OUT-01) + 494400 (OUT-03)`.
- **Cash sales at the same counters create no exposure** — `370800` of cash trade is absent from the
  balance. (This is the "mixed cash and credit" half, asserted directly.)
- `availableMinor = limit − exposure` exactly: `4134800 = 5000000 − 865200`.
- The API figure equals `Σ(app.credit_entry)` read straight from Postgres — **derived, never a
  counter**: `865200 === 865200` over 2 entries, across 2 distinct sale locations on **one
  tenant-level account**.
- `Σ(ageing buckets) == balance` exactly; both invoices aged by **days past due** from their own due
  date; the same account read one day after the sale is `current` — ageing moves with the as-of date.
- A payment clears its own invoice and leaves the other aged where it was.

**The facility fee is visible and correct, and deliberately refuses to post.** It is labelled
`provisional — not chargeable`; posting fails closed with
`HTTP 412 FEE_POLICY_UNCONFIRMED` pending the Q4 human decision, and the account carries **zero**
FEE entries so no customer can be billed a guess. **That is the right behaviour**, and the criterion
should be read as "visible and correct" rather than "chargeable". See also §4.1 item 5 — the fee's
`feeBasis` / `feeCompounds` / `feeDayCount` config fields are **read by no code**, so whatever the
accountant confirms at the §2.8 gate, the system will accrue 30E/360 regardless.

### Criterion 4 — HQ sees post-sync stock and sales across every connected location in one view. **HOLDS.**

D3 fresh: `Σ(per-location sales) == tenant-wide total` as an exact bigint (`3066230`); HQ's on-hand
equals an **independent ledger sum** at both OUT-01 (`1181`) and OUT-03 (`51`); sales visible across
≥ 2 locations in one view. D10 1a–1d widens it: the client's own report returns **25 locations**,
`Σ(per-location) == network total` (`5478236`), and the report is asserted **non-vacuous**.

*Precision:* D3 demonstrates the cross-location mechanism over the **2 locations that had trade in
that run**, not all 25; D10 demonstrates the 25-location rollup. Together the criterion is met. No
single check asserts "every one of 25 outlets, each with trade".

### Criterion 5 — a second tenant fully invisible, demonstrated at EVERY read path. **DOES NOT HOLD AS WRITTEN.**

**At the sync layer it holds, and the evidence is the best in the repository** (§4.4.5): D5's byte
grep over the sqlite file and its `-wal` sidecar, 0 foreign rows, tenant B's uuid appearing nowhere,
with non-vacuity controls on both sides; D8's forged-`tid` token receiving zero rows in every credit
bucket.

**At the API layer it does not.** Of 28 query procedures: 19 covered, 3 partial, 1 vacuous, **5 with
no two-tenant test at all** (§4.4.1). "Demonstrated at **every** read path" is therefore false as
written.

**Important qualification, and it is why I call this a regression exposure rather than a breach:**
all nine untested and partial paths were **probed live** and **no actual leak was found** — foreign
ids answer identically to nonexistent ids, and tenant A's aggregates contained only tenant A's 25
locations against tenant B's 1. **The present state is not a breach.** The exposure is that nine
read paths' isolation is held **only by RLS and by nobody's test**, on a property §2.1 calls
unrecoverable. Add a query today and nothing turns red.

---

## 7. PWA behaviour on low-end Android — NO COVERAGE AT ALL

`CLAUDE.md` §4 requires an installable PWA **targeting low-end Android tablets and phones**. My
brief puts this in my remit. I swept for it:

- **No Playwright, no Puppeteer, no WebDriver, no BrowserStack, no device lab, no Lighthouse** —
  zero references in `package.json`, `apps/web/package.json` or `turbo.json`.
- `apps/web` vitest runs `environment: 'node'`; **14 test files** opt into **jsdom** via a docblock
  for React component tests.
- **jsdom is not a browser.** It has no service worker, no real IndexedDB/OPFS, no wasm SQLite under
  memory pressure, no touch, no repaint cost, no CPU throttle.

**Consequently there is no evidence of any kind — automated or recorded-manual — that the PWA
installs, runs, prints a receipt, or survives a day's trading on the target hardware.** Specific
untested behaviours that only appear on a real low-end device:

- Service-worker install/update under `registerType: 'prompt'`, and `src/sw/version-gate.ts`
  refusing to activate under a cashier mid-sale (§8.11).
- wasm SQLite memory footprint with 219 SKUs plus a location's full `stock_movement` and `sale`
  history — note §4.3.2: the device downloads all of it and **reads none of it**, so the storage
  cost is being paid for no functional benefit.
- **Storage exhaustion with a pending outbox** — a real field condition, called out independently by
  the sync audit, with zero coverage.
- Receipt printing on Android.
- Touch ergonomics and repaint cost at the counter.

I am not asserting these are broken. I am stating plainly that **nothing in this repository would
tell us if they were.**

---

## 8. Mutation checks — proving the checks I lean on can actually fail

This project has repeatedly caught its own verifiers being vacuous (an `[].every()` over an empty
array; a leak marker `99000000` colliding with a real column). **A check that cannot be made to fail
is not evidence.** I broke three of the checks I rely on most and confirmed each went red — and, in
one case, confirmed exactly where it stays green when it should not.

### 8.1 `tools/lint-money.mjs` — fires, but has demonstrated blind spots

Injected into `packages/money/src/index.ts`, run, then restored byte-for-byte.

| # | Injected | Result | Verdict |
|---|---|---|---|
| **M1a** | `interface P { totalMinor: number }` | **exit 1** — `'totalMinor' typed as number` | **The linter is not vacuous. It fires.** |
| **M1b** | `{ revenue: number; margin: number; freight: number; qty: number; discount: number; commission: number }` | **`money lint: clean`, exit 0** | **BLIND SPOT.** Six money-and-quantity fields typed `number`, all invisible. Note `qty` — §2.3 requires scaled-integer quantities and the linter cannot see a float quantity at all |
| **M1c** | `{ id: number; totalMinor: number }` — two decls, money one **second** | **`money lint: clean`, exit 0** | **BLIND SPOT.** The regex is non-global; only the first declaration per line is examined |

**Conclusion: `money lint: clean` in §2.2 is a true statement about a weak check.** The real
structural guard is `packages/db/test/conformance.test.ts:126` (queries `pg_attribute`, resolves
domains to base types) — **cite that at the gate, not the linter** — and note it is scoped to `app`,
excluding `platform.tax_rate` and `platform.jurisdiction`.

### 8.2 The money suite — fires hard, and localises where the tax coverage is thin

Mutated `packages/money/src/rounding.ts`, `case 'half-up'` from
`return twiceAbsR >= d ? away : q;` to `return q;` — i.e. **half-up silently truncates**, the classic
lost-pesewa bug. Restored afterwards; the suite re-verified green at 116/116.

| Suite | Under mutation | Reading |
|---|---|---|
| `@erp/money` (116) | **5 files failed, 18 tests failed** | Strong. The golden and property tests bite |
| `@erp/api` `tax-inclusive.test.ts` (9) | **1 file failed, 2 tests failed** | The API tax tests pin real values |
| **`@erp/web` `tax-inclusive-pricing.test.ts` (24)** | **24 passed — ALL GREEN** | **See below** |
| `@erp/web` full suite (651) | **5 files failed, 10 tests failed** | The web suite as a whole does catch it |

**The interesting result is the third row, and it is a genuine finding.** The 663-line,
24-test `apps/web/tests/tax-inclusive-pricing.test.ts` — the largest new client-side test file on
this branch — **passes unchanged when half-up rounding is corrupted to truncation.**

I checked that this was not an artefact of stale build resolution: `apps/web/vite.config.ts:73`
aliases `@erp/money` to **source**, so the suite genuinely ran against the mutated code.

The cause is in its assertion style. Its arithmetic assertions are **self-consistency invariants**:

```
expect(breakdown.netMinor + taxSum).toBe(gross);
expect(taxSum).toBe(breakdown.taxTotalMinor);
expect(breakdown.grossMinor).toBe(gross);
```

Those hold under **any** rounding mode — truncate the split and the residual placement re-balances,
so `net + tax === gross` still passes. **The file proves the de-grossing round-trips; it does not
pin the split.** It cannot tell a correct de-gross from a wrong-but-balanced one. The catch comes
from `counter-ui.test.tsx` and `checkout.test.ts` instead.

This is not a claim that the feature is broken — the value *is* pinned, in
`packages/money/test/tax-extract-golden.test.ts` (54 hand-computed assertions) and in the API tests.
It is a claim that **this specific file is weaker than its size suggests**, and that anyone reading
"24 new tax-inclusive tests" as coverage of the split should not.

### 8.3 My own `.only` / `.skip` / `.todo` sweep — fires on all three forms

Appended `it.only(…)`, `it.skip(…)` and `it.todo(…)` to `apps/web/tests/cart-recovery.test.ts`, then
re-ran my §2.2 sweep. **All three were caught**, with file and line; the sweep exits 0 (matches
found) instead of 1. Restored.

The clean result in §2.2 is therefore real, not an artefact of a grep that never matches.

### 8.4 A check I found that CANNOT be made to fail — §4.3.8

Reported above and repeated here because it belongs in this section:
`measure(\`… (budget 60000ms)\`)` in `live-operations-drill.ts:467` and
`live-procurement-drill.ts:759` is a **print statement with no pass/fail**. The 60-second budget is
**not asserted** in D10 or D11. **D1 does assert it correctly**, which is what keeps criterion 1
standing.

---

## 9. What I could not verify

Non-empty, and deliberately so.

1. **Whether the untested read paths leak under conditions I did not probe.** Nine API read paths
   (§4.4.1) have no automated two-tenant test. I probed them live and found no leak — but a live
   probe with two seeded tenants is a spot check, not a proof. I cannot tell you they are safe under
   a different data shape, a wider grant, or a future predicate change.
2. **Whether the `platform.*` RLS gap is reachable by any path I did not enumerate.** I verified the
   two known readers predicate on `app.current_tenant()`. I did not audit every possible future or
   dynamic query. What I can say: there is **no backstop and no test** there.
3. **The `>500-op backlog stops draining` finding is a code-reading conclusion, not a demonstrated
   failure.** It looks like a live bug and it is cheap to test, but I did not queue 600 ops on a
   real device and watch the drain stall. **Nobody should record it as demonstrated until somebody
   does that.**
4. **Anything about real hardware.** §7 — no device, no emulator, no browser automation exists in
   this repo, so I have zero evidence about install, service-worker update, receipt printing,
   storage exhaustion or performance on a low-end Android tablet. This is the largest single
   unevidenced area in the gate and it is unevidenced in *both* directions.
5. **Whether the Ghana tax rates are correct.** Verified in the live container: **7 of 7 rows in
   `platform.tax_rate` have `confirmed_by = NULL`** — every rate, base composition and commencement
   date is `[UNCONFIRMED]` pending the §2.5/§2.8 qualified-local-professional review, which **has
   not happened**. The de-grossing *arithmetic* over a declared composition is excellently tested;
   **the composition itself is unreviewed.**
   **This branch changes the risk profile of that gap and the change is not obviously appreciated.**
   §2.4 argues a stale VAT rate is tolerable because it is *"visibly wrong on a receipt today"*.
   Under **tax-inclusive** pricing that argument weakens sharply: the customer pays the shelf price
   either way, so a wrong rate is **invisible at the till** and misstates only the net/tax split —
   i.e. the amount owed to GRA. It fails silently, which is precisely the property §2.4 uses to
   *prohibit* payroll withholding logic. I am not calling this a violation; I am flagging that the
   reasoning which made unconfirmed rates acceptable is weaker after this branch than before it.
6. **Whether the drills are reproducible from a clean database.** Every drill I ran executed against
   a stack seeded ~40 minutes earlier and already carrying prior drill data. Several drills are
   order-dependent on their own prior runs (D12's ratio rises every run by design). **I did not run
   `pnpm stack:reset` and re-run from nothing**, so I cannot certify a green result on a virgin
   database.
7. **Whether anything regressed that has no test.** This is the honest limit of the whole exercise.
   1554 tests and 345 live checks are green; §4 is a list of things they would not have caught.
8. **The two accountant/professional gates (§2.8).** No qualified accountant has reviewed the chart
   of accounts or the double-entry logic (there is no GL to review yet), and no qualified Ghanaian
   professional has confirmed the jurisdiction pack. **Neither is mine to sign and neither has
   happened.** `priceInclusive`'s two-extraction discount rule carries its own explicit
   "NEEDS A HUMAN (§2.8)" note and is unreviewed.
9. **`docs/phase2-status.md` is stale in at least five specific ways** (drill list, migration level,
   route count, the `credit.openAccount` claim, test counts). I corrected each where I found it, but
   I did not line-by-line re-verify that whole document, so other stale claims may remain.

### One thing outside my scope that I am obliged to repeat

`docs/phase2-status.md` §5 records that `.claude/settings.json` was changed to move
`Bash(git push:*)` from `deny` to `allow`, and that the change is **committed** (`f92ea44`), not a
working-tree diff. I confirmed it is still committed on this branch. It was not requested by the
repository owner. It is **not mine to revert** — a permission change is the owner's call in both
directions — but a gate document is the right place for it to be visible.

---

## 10. How to reproduce every figure in this document

```bash
# 1. Confirm what is actually on the ports BEFORE trusting anything
lsof -nP -iTCP:3001 -sTCP:LISTEN          # note the PID and its start time
lsof -nP -iTCP:5433                       # 'ssh' here is Colima's port-forward mux, not a rogue tunnel

# 2. Prove the host port and the container are ONE database
PGPASSWORD=erp_dev psql -h 127.0.0.1 -p 5433 -U erp -d erp \
  -tAc "select system_identifier from pg_control_system()"
docker exec erp-dev-stack-postgres-1 psql -U erp -d erp \
  -tAc "select system_identifier from pg_control_system()"
# MUST be identical. Here: 7677344657172918306

# 3. Migrations, read INSIDE the container
docker exec erp-dev-stack-postgres-1 psql -U erp -d erp \
  -tAc "select filename from erp_meta.schema_migrations order by filename"   # 14 rows

# 4. RESTART THE API ONTO CURRENT CODE. Not a formality — see §1.1
kill <pid-from-step-1>; pnpm dev:api

# 5. Static
pnpm exec turbo run typecheck build test --force    # 19/19, 0 cached, 1554 tests, 104 files
node tools/lint-money.mjs                           # clean — but see §8.1 before believing it
grep -rnE "\b(it|test|describe|suite|bench)\.(only|skip|todo|skipIf|runIf)\b|\bxit\(|\bfit\(" \
  apps/ packages/ --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v '/dist/'
# MUST print nothing.

# 6. EVERY drill — enumerate them, do not trust a list
node -e "for (const p of ['packages/sync-drills','packages/wire-conformance'])
  console.log(p, Object.keys(require('./'+p+'/package.json').scripts))"
pnpm --filter @erp/sync-drills      drill              # D1-D8   8/8
pnpm --filter @erp/wire-conformance drill:live         # D6     16/16
pnpm --filter @erp/wire-conformance drill:rbac         # D8     30/30
pnpm --filter @erp/wire-conformance drill:credit       # D9     13/13
pnpm --filter @erp/wire-conformance drill:credit-client# D14    19/19
pnpm --filter @erp/wire-conformance drill:client       # D10    30/30
pnpm --filter @erp/wire-conformance drill:procure      # D11    56/56
pnpm --filter @erp/wire-conformance drill:q1           # D12    32/32
pnpm --filter @erp/wire-conformance drill:counter      # D13    47/47
pnpm --filter @erp/wire-conformance drill:credit-verify# D15    33/33
pnpm --filter @erp/wire-conformance drill:credit-offline# D16   37/37
pnpm --filter @erp/wire-conformance drill:inclusive    # D17    32/32
# NOTE: `drill` rewrites docs/sync-drill-report.md. Revert it if the tree must stay clean.
```

**The route sweep, from the router itself rather than from memory:**

```bash
pnpm exec tsx -e "
const { appRouter } = await import('file://\$PWD/apps/api/src/routers/index.ts');
const p = appRouter._def.procedures;
for (const k of Object.keys(p).sort()) console.log(p[k]._def.type, k);
"   # 49 procedures: 28 queries, 21 mutations
```

**The RLS backstop, on the live database (§4.4.3):**

```bash
docker exec erp-dev-stack-postgres-1 psql -U erp -d erp -tAc "
select n.nspname||'.'||c.relname||' rls='||c.relrowsecurity||' forced='||c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname in ('app','platform') and c.relkind='r' order by 1;"
# app.*      -> all t/t   (45 tables)
# platform.* -> all f/f   (6 tables)  <- the gap
```

**The review queue, which is write-only (§4.3.3):**

```bash
docker exec erp-dev-stack-postgres-1 psql -U erp -d erp -tAc "
select conflict_class||' | '||status||' | '||count(*) from app.conflict_review
 group by 1,2 order by 1;
select count(*) filter (where resolved_at is not null)||' resolved of '||count(*)
  from app.conflict_review;"
# 6 rows, all 'open'. 0 resolved. 0 claimed. No route or screen reads this table.
```

**The RBAC discount failure (§5.2) — the one to reproduce first:**

```bash
TK=$(pnpm -s dev:token --role counter_staff)
curl -s -H "authorization: Bearer $TK" \
  "http://127.0.0.1:3001/trpc/session.permissions?input=%7B%22json%22%3A%7B%7D%7D" \
  | grep -c 'sale.discount.apply'        # 0 — the principal does not hold it

# then POST sales.createSale as that principal with
#   lines: [{ productId: <SKU-001>, qty: '2', lineDiscountMinor: '12000' }]
# -> HTTP 200, total_minor = 0.
```

**The mutation checks (§8), each restore the file afterwards:**

```bash
# 8.1 — the linter fires, and where it does not
printf '\nexport interface P { totalMinor: number }\n' >> packages/money/src/index.ts
node tools/lint-money.mjs            # exit 1  <- fires
git checkout packages/money/src/index.ts
printf '\nexport interface P { revenue: number; qty: number }\n' >> packages/money/src/index.ts
node tools/lint-money.mjs            # exit 0  <- BLIND SPOT
git checkout packages/money/src/index.ts

# 8.2 — corrupt half-up to truncation
#   packages/money/src/rounding.ts, case 'half-up':
#   replace  return twiceAbsR >= d ? away : q;   with   return q;
pnpm --filter @erp/money exec vitest run   # 18 failed / 116  <- fires
pnpm --filter @erp/web exec vitest run tests/tax-inclusive-pricing.test.ts
                                           # 24 PASSED       <- the finding in §8.2
git checkout packages/money/src/rounding.ts
```
