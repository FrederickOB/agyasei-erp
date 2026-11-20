# Phase 2 gate — written verdict

**Gate:** Phase 2 — Procurement & supply chain · **Date:** 2026-08-23
**Conducted by:** `product-manager` · **Test evidence:** `qa-engineer` (§2)
**Code under gate:** commit `9ed8f50` ("Let tenant #1 actually trade: tax-inclusive pricing, and
credit off manager devices"), branch `tax-inclusive-pricing`, PR #11.

> **A correction to the brief this gate was called with.** PR #11 is **merged**. `origin/main` is
> at `3d87210`, whose second parent is `9ed8f50`. The *local* `main` in this working copy is one
> merge behind at `fe53019`, which is what made the branch look unmerged. The gate is against the
> code that is now on `origin/main`. Nothing about the verdict turns on this, but a gate that
> misreports which tree it graded is not worth much, so it is stated first.

**What this document is.** Per `CLAUDE.md` §3 a phase ends with a **working, demoable system** —
not "code complete", not "tests pass". This is the written verdict: what was demonstrated, what
was asserted, what moved, what is missing, and whether Phase 3 may begin.

**What I personally did, so the weight of each claim is legible.** I read the constitution, the
seven ADRs, `docs/open-questions.md`, `docs/phase2-status.md`, `docs/phase1-status.md` (§0, §0a,
§5, §6), `docs/q8-evat-practitioner-brief.md`, and the `/phase-gate` command text. I then verified
a specific set of structural claims **against the source rather than against the report** — those
are marked "verified here" below and carry a file path. I did **not** execute the drill suite;
the live figures in this document are `qa-engineer`'s, recorded in §2 and cross-read from
`docs/phase1-status.md` §5 and `docs/phase2-status.md`. Where I rely on someone else's execution
I say so.

---

## 0. The criteria this gate grades against

**Phase 2 has no numbered acceptance list.** The five numbered criteria in `CLAUDE.md` §3 are
**Phase 1's** and grading Phase 2 against them would be a category error — they say nothing about
a purchase order and everything about a sale. Phase 2's criteria therefore have to be *derived*,
and derived in the open, so that a reader can disagree with the derivation rather than only with
the verdict.

They come from two places.

**Source 1 — the Phase 2 paragraph, `CLAUDE.md` §3:**

> **Phase 2 — Procurement & supply chain.** Suppliers, multi-source purchase orders ·
> goods-received matching · reorder points tied to Phase 1 alerts · third-party haulier dispatch
> and delivery status (**dispatch and tracking only — no fleet or vehicle management**, `ADR-0001`).

**Source 2 — what `ADR-0001` promised in exchange for the owned fleet.** This one matters more than
it looks. The founder's financial model carries GH₵300,000 of FY1 fleet capex, GH₵150,000 per
additional truck, and a margin lever attributing the 5.0% → 2.5% distribution-cost decline to an
owned fleet absorbing volume. `ADR-0001` deleted all of it. The consideration it offered in return
was a measurement:

> "The ERP will measure distribution cost as % of revenue per outlet and per region so the real
> trajectory is visible."

That is not a nice-to-have inside Phase 2. It is the price of the decision, and a Phase 2 gate that
did not grade it would be signing off on a bargain half-kept.

**The cross-cutting constraints apply to Phase 2 as they apply to every phase** — offline-first
(§2.2), tenant isolation (§2.1), integer minor units and scaled quantities (§2.3), tenant-editable
roles and location scoping (§2.6), the three mandatory test categories (§2.7), no branching on
tenant identity (§2.9). These are not separate criteria; they are conditions on all of them, and
P2-8 makes the isolation one explicit because §2.1 calls the failure unrecoverable.

### The eight criteria

| # | Criterion | Source |
|---|---|---|
| **P2-1** | **Suppliers are the tenant's own data, created and edited from the product.** A holder of the supplier-management permission creates a supplier — including one carrying a haulage capability — from a screen a person can open. A view-only caller is refused the identical call and **no row is written**. A positive control proves the refused caller is not simply broken. | §3 "Suppliers" |
| **P2-2** | **A multi-source purchase order is raised, approved by someone other than the raiser, and priced correctly across purchase units.** Two sources for the same SKU quoting in *different* purchase units are comparable on one common basis; the order total equals Σ(line net) in integer minor units; approval is separated from raising and is bounded by a money limit measured against the **server's own repriced total**, not the client's claim. | §3 "multi-source purchase orders" · §2.3 · §2.6 |
| **P2-3** | **Goods received are matched against the order and stock rises by what was counted.** A receipt carries **both** the invoiced and the counted quantity, converts through the same UoM machinery selling uses, **appends** a stock movement rather than setting a counter, moves the order to partially-received on a short delivery, and opens a **human review** — never a silent absorption — when the count falls outside the unit's tolerance. | §3 "goods-received matching" · §2.2 · §2.3 |
| **P2-4** | **Procurement works offline and never double-counts.** A goods receipt and a delivery-status move both complete with the device genuinely partitioned, are **absent from the server while partitioned**, drain on reconnect inside Phase 1's 60-second budget, and a verbatim replay is acked `duplicate` with no second effect. Every write carries an idempotency key and a logical timestamp. | §2.2 |
| **P2-5** | **A reorder point drives a purchase, and a tenant can set one.** A Phase 1 low-stock alert comes back joined to a real supplier and expressed in the **purchase** unit, and pre-fills a draft order. The thresholds that produce those alerts are settable by the tenant from the product. | §3 "reorder points tied to Phase 1 alerts" |
| **P2-6** | **Third-party dispatch and delivery status — and no fleet, anywhere.** A delivery is planned against a carrier that is modelled **only** as a supplier; both status moves ride the same ordered outbox a sale does; and the live database contains **zero** vehicle, driver, fuel, odometer, mileage or maintenance tables or columns. | §3 · `ADR-0001` |
| **P2-7** | **`ADR-0001`'s exchange is honoured: distribution cost as a percentage of revenue, per outlet and per region.** A real percentage — not `null`, not a sentinel — as a scaled integer, per location and per grouping node rolled up over the tenant's own location hierarchy, keyed to a **business date and never a device clock**, reconciling against an independent computation, visible on a screen behind a permission, and **labelled with what it is and is not**. | `ADR-0001` consequences · Q1 |
| **P2-8** | **Every Phase 2 read *and write* path is tenant-scoped, demonstrated with positive controls.** Not "no leak observed" — an exact refusal against a **real** id belonging to the other tenant, paired in the same run with the same query succeeding for its rightful owner. | §2.1 · §2.7(3) |

---

## 1. What was demonstrated

**The standard.** `CLAUDE.md` §3 criterion 2 demands the two-device conflict case be
"**demonstrated, not asserted**". I have applied that wording to all eight criteria above, and
I have applied it to the *evidence* as well as to the feature: a claim is demonstrated when
something was **driven through the product's own production modules, over a real socket, against
a real Postgres, and checked against a figure computed independently of the thing under test**.
A claim backed by a unit test that constructs its own input is *asserted*, however many of them
there are. This project has an eighteen-row ledger (`docs/phase1-status.md` §0) recording exactly
what happens when that distinction is not policed, and the most recent row was opened **the day
before this gate**.

**The headline: Phase 2's evidence quality is the best on this project, and materially better
than most gates ever see.** Three live drills — D11 (56/56), D12 (32/32), D13 (47/47) — drive
`apps/web`'s own production modules (`data/api/procurement.ts`, `data/api/logistics.ts`,
`data/api/receiving.ts`, `data/api/reports.ts`, `data/mutations/recordGoodsReceipt.ts`,
`data/mutations/updateDeliveryStatus.ts`, the real outbox, the real `httpUploadTransport`) with a
browser `Origin` against the deployed API, and compare **every** figure to an independent Postgres
computation or to a second implementation written inside the drill. That is the right shape of
evidence and I want to say so before I start finding fault.

**And it was re-run from nothing.** `docs/phase1-status.md` §5 records a full re-run on
**2026-08-23** from a destroyed docker volume with no hand edits at any point: `stack:reset` →
sync drills 8/8 → D11 56/56, D12 32/32, D13 47/47 alongside the rest. This matters more than the
counts, because of the finding immediately below.

### 1.0 The finding that had to come first — Phase 2's drills were, until yesterday, green against a database nobody could rebuild

`docs/phase1-status.md` §0 **row 18**, opened 2026-08-23:

D11, D12 and D13 all open by selecting a product bought in a unit that is **not** its stocking
unit. `applyTemplate` authors thirteen converting `product_uom` rows per tenant and sets
`can_sell` on every one and **`can_buy` on none** — deliberately; `packages/db/src/seed/template.ts`
calls the buying direction "a further authoring step the founder confirms". Nothing in the
bootstrap performed that step. On a stack built from nothing, all three drills **abort at their
first precondition and execute zero checks** — not one failed check, *no* checks.

So the 56/56, 32/32 and 47/47 in `docs/phase2-status.md` — the document this gate was pointed at
— were, at the time that document was written, results from an accumulated developer database
carrying a hand-made row. Closed by `infra/scripts/dev-purchase-units.ts`, which enables `can_buy`
on rows the template already authored and **invents no conversion factor** (a guessed factor is a
physical claim about the goods and would make D11 green on a wrong receipt). Re-verified from a
destroyed volume, as above.

**Two consequences for this gate, and they pull in opposite directions.**

1. **The evidence now stands.** The re-run is real and it is the thing that makes §1.1–§1.8
   gradeable at all. Without it I would be grading a report.
2. **`docs/phase2-status.md` is stale and should not be read as current.** It is dated 2026-08-22,
   authored on branch `phase1-completion`, and contains no trace of row 18. Its §1 claim that the
   stack is "reproducible from nothing" was false for three of eleven live drills when it was
   written. The substance has since been repaired; the document has not. **Action: `phase2-status.md`
   needs a dated header pointing at row 18 and at the 2026-08-23 re-run, or it will be quoted
   later by someone who does not know.** This is bookkeeping, not a blocker, and it is recorded
   as such.

### 1.1 P2-1 — Suppliers created and edited from the product · **DEMONSTRATED**

**What was shown:** a `supplier.manage` holder creates a haulier through the client's own
`data/api/procurement.ts` module over real HTTP, and Postgres agrees on code, payment terms,
active flag and the `HAULAGE` capability (D12 A1–A2). A **`supplier.view`-only caller is refused
the identical call and the refusal leaves zero rows** (D12 A3) — the refusal is checked at the
database, not inferred from the HTTP status. A positive control in the same run proves the refused
principal can still list suppliers and can see the new haulier (D12 A4). A second source in a
different purchase unit is added through the same path, and the view-only caller is refused that
write too (D12 E1–E4).

**Verified here, independently:** `procurement.upsertSupplier` and `upsertSupplierProduct` have
production call sites in `apps/web/src` — `data/api/procurement.ts` → `features/suppliers/
SupplierForms.tsx` → `Suppliers.tsx`, lazily routed in `Shell.tsx`. A route with a test and no
caller looks identical to a finished one in a green suite, and this project has five ledger rows
proving it; the call sites are real.

**Named residue, not a failure:** there is **no offline path** for either supplier write, by
design and stated — a supplier's terms are a commitment a partitioned device may hold stale.
I accept that reasoning.

**Grade: MET.**

### 1.2 P2-2 — Multi-source purchase orders · **MET AS A MECHANISM; NOT OPERABLE ON THE PILOT TENANT'S OWN CATALOGUE**

This is the criterion where the gate has to be careful, because the demonstration is genuinely
excellent and the thing demonstrated is not yet reachable by tenant #1.

**What was shown, and it is strong.** A `purchase.order.create` holder raises a DRAFT through the
client; Postgres agrees and **Σ(`line_net_minor`) equals the client's total** as an exact bigint
identity; counter staff is refused the byte-identical order (D11 2a–2c). The raiser may submit and
is then **refused the approval of their own order** — `PERMISSION_DENIED: purchase.order.approve
is not held by this user` — and the refusal **leaves no trace**: still `SUBMITTED`,
`approved_by_user_id` still null (D11 2d–2f). A different principal holding the capability is
allowed the byte-identical payload and Postgres records **the approver, not the raiser** (2g–2h).

**The approval money bound is the best single check in Phase 2** (D11 2i–2m). Two orders straddle
a bound that lives in ordinary tenant **data** (`role_permission.bound.max_order_value_minor`, not
a constant): the bounded approver is refused above it with the refusal naming **the server's own
repriced total**, the same principal is allowed below it, and an unbounded approver clears the
same order. `PERMISSION_BOUND_EXCEEDED: … bounded at 5000000 minor units; this act is 9000000`.
That is §2.6 working as designed — composable permissions in tenant-editable roles, with the money
bound as data — and §2.3 working as designed, because the bound is measured against a total the
server recomputed rather than one a client supplied.

Amendment is covered too: `updatePurchaseOrder` corrects one line, restates another verbatim and
adds a third, with the untouched line's **exact agreed rate** read back from
`app.purchase_order_line`; the amendment is then **refused on a SUBMITTED order and the rows are
re-counted to prove nothing was written** (D13 A1–A10). The bound is re-measured against the
*amended* total.

**Now the part that is not met.** "Multi-source" across *different purchase units* — a contractor's
tonne against a self-builder's 12m length, which is Q7's whole subject — is demonstrated only
because a **development fixture** enables it. Verified here, against the source rather than the
report:

- `packages/db/src/seed/template.ts:443–448` — the template authors converting `product_uom` rows
  with `can_buy = false`, and says why: buying cement by the tonne "is a further authoring step
  the founder confirms".
- `infra/scripts/dev-purchase-units.ts` — a script under `infra/`, run by the dev bootstrap, is
  the **only** thing in the repository that sets `can_buy` on a converting row.
- `apps/api/src/routers/catalogue.ts:105` — the catalogue router exposes `list`, `search` and
  `detail`. **There is no write procedure.** A tree-wide search finds no route that creates a
  product, a unit of measure, or a `product_uom` row, and no `can_buy` write anywhere in
  `apps/web/src`.

**So on a production tenant, `select count(*) from app.product_uom where can_buy and factor_num <>
factor_den` is zero, and there is no surface in the product that can make it non-zero.** A tenant
can buy in the stocking unit — the template authors that one buyable, so ordinary multi-supplier
purchasing works — but the cross-unit comparison that Phase 2's own summary leads with is reachable
only by a hand-run script against the database.

**A second, quieter half of the same problem.** `packages/db/src/seed/template.ts:468` seeds every
cement supply record with the note `[NEEDS-FOUNDER: no lead time and no price — the plan states
neither. A guessed lead time drives the order-up-to arithmetic; a zero price reads as free.]`, and
`packages/db/migrations/0008_procurement.sql:293–296` declares `last_price_e4` **NULL until we have
paid anything — a zero here would read as "free"**. So the shipped template's sources carry no
price and no lead time.

**I want to be explicit that this is the honest pattern, not a defect.** The code refuses to invent
a conversion factor, refuses to invent a price, refuses to invent a lead time, and the compared
source carries `priceComparable: boolean` and `priceUnavailableReason: string | null` with
"THE COMPARABLE FIGURE: per ONE STOCKING unit, ×10⁴. **Null when unpriced**"
(`apps/api/src/routers/procurement.ts`). Nothing here is silently wrong. But the criterion asks
whether a tenant can raise a multi-source purchase order and compare sources, and today tenant #1
cannot compare anything, because there is nothing to compare and no way to enter it.

**REVISION CHECK, after §2 — I verified whether §2's finding 1 reaches this criterion. It does
not, and the reason is worth recording.** The zero-total sale exploit works through
`saleLineInput.lineDiscountMinor`. I checked the purchase-order contract directly:
`purchaseOrderLineInput` (`packages/contracts/src/procurement.ts:198–209`) is `.strict()` and carries
`lineNo`, `productId`, `uomId`, `qtyOrdered`, `unitPriceE4`, `notes` — **no discount field of any
kind**, and `lineDiscountMinor` appears in exactly one file in the whole contracts package,
`sale.ts:72`. The approval bound is measured against Σ(lines) recomputed by the server from the
supplied prices, and there is no second field that can move that total after the fact. **P2-2's
money bound holds.** It is the sale path, not the purchase path, that is open.

**Grade: MECHANISM MET AND WELL DEMONSTRATED; TENANT OPERABILITY NOT MET.** Carried to §5 and to
open questions Q7 and Q9.

### 1.3 P2-3 — Goods-received matching · **REVISED AFTER §2. DETECTION DEMONSTRATED; THE §2.2 REVIEW REQUIREMENT FAILS**

**What was shown** (D11 3a–3k, D13 B1–B10): a **short** delivery is received — invoiced `1500` TON,
converted to `141` BAR, **counted `138`** and signed for. The line carries **both** quantities and
the signature. The device's own `toStockQty` equals the server's stored `qty_stock_computed` — the
product, the unit, the conversion factor and the tolerance are all **read out of the tenant's own
catalogue by query**, so neither side is asserting a literal the other could agree with wrongly.

**On-hand rose by exactly `qty_stock`** — `10268 → 10406`, delta **138** — which is what was
*counted*, never what was *invoiced*. That is the sharp check: a system that trusted the supplier's
invoice would have moved 141. The receipt **appended** a movement (`qty_delta=138`,
`source_kind=RECEIPT`) and set no counter, which is §2.2's requirement.

**The count variance is recorded, not absorbed**: an open `CONVERSION_OUT_OF_TOLERANCE` review at
severity 2, **routed on a permission code that exists in `platform.permission`** (`sync.conflict.
review`) — and that last clause is doing real work, because §0's sequence-review row is the same
mistake with a permission code that existed nowhere, so every severity-1 review landed in a queue
no user could ever read.

The short is visible on the order — outstanding = ordered − received (`1600 − 1500 = 100`) and the
order moved itself to `PARTIALLY_RECEIVED`. D13 B1–B10 re-checks partial receipt outstanding against
an **independent SQL** `qty_ordered − Σ(qty_received)`, and asserts untouched lines are outstanding
*in full* rather than absent — which is the check that fails if a partial receipt is modelled as a
replacement rather than an append.

**REVISION, after §2 — and it changes the grade.** I originally graded this MET, and the sentence I
was most pleased with was *"the count variance is recorded, not absorbed — an open
`CONVERSION_OUT_OF_TOLERANCE` review, routed on a permission code that exists."* Every clause of
that is true. **And the review can never be seen by anyone.**

`qa-engineer` verified against the live container what no status document records: **the human
review queue is write-only.** No router reads `conflict_review` — checked against a runtime
introspection of all 49 procedures. No sync bucket carries it. No screen, no badge, zero references
anywhere in `apps/web/src`. No resolver, no claim path, no scheduler despite `escalate_at` and
`escalation_level` being written. The live database holds **6 review rows, all `open`, 0 ever
claimed, 0 ever resolved** — including 2 `CONVERSION_OUT_OF_TOLERANCE` rows, which are *this
criterion's* rows.

**§2.2 is categorical:** *"Every conflict that cannot be resolved automatically goes to a human
review queue. Never silently overwritten."* The purpose of that clause is that a **human sees it**.
A row in a table with no reader is not a review queue; it is a log nobody has ever opened. The
receiving path detects the tolerance breach correctly, preserves both figures with provenance, and
files it somewhere that has never once been read.

**I was wrong to grade this MET on the strength of the detection alone, and the mistake is
instructive: I graded the half that had evidence.** The write side had a live drill behind it; the
read side had nothing behind it *because there is nothing there*, and absence produces no failing
check to notice.

**Grade: MATCHING AND DETECTION — MET, and well demonstrated. §2.2's REVIEW REQUIREMENT — NOT MET.**
The variance is recorded rather than absorbed, which is genuinely better than silence; it does not
reach a human, which is what the constitution requires.

### 1.4 P2-4 — Offline and idempotent · **REVISED AFTER §2. WRITE PATH AND IDEMPOTENCY DEMONSTRATED; OFFLINE RECEIVING AS A YARD CAPABILITY IS NOT**

**What was shown:** a goods receipt completes **with the radio genuinely off** — no network on the
path — and is **absent from Postgres while partitioned**, which is the check that makes the rest
mean anything. It drains on reconnect and is acked `applied` in **34–66 ms against a 60,000 ms
budget** (D11 3a–3c). Both delivery status moves ride the same ordered outbox a sale does
(D11 5a–5e). All four new reads plus both new writes answer **`offline`** with the socket dead —
never an empty list, never a zero read as a total, and **nothing queued for a promise made to a
haulier** (D13 E1–E5).

**Replay:** the ack is cleared as a flaky link would lose it, and the device re-sends **through its
own transport**. Acked **`duplicate`**; **no second movement, no second receipt, on-hand unchanged**
(`10406 → 10406`) (D11 4a–4b). That is §2.2's "never silently double-counted", demonstrated rather
than argued.

**A real defect was found by running and it is now closed.** Two outbox writes made in the same
millisecond used to upload in a **random relative order** (§0 row 12) — observed live as
`PLANNED → DELIVERED is not a legal delivery transition`. Closed by `outbox.queue_seq`, a strictly
increasing integer stamped inside the same local write transaction as the INSERT, with
`OUTBOX_QUEUE_ORDER` as the single ordering expression the drain and every reader share. **All five
`INSERT INTO outbox` sites stamp it** — checked by grep, because one that did not would sort to the
front of every queue forever. Demonstrated over **six consecutive runs** with both instants pinned
identical on purpose: tie observed 6/6, 2/2 applied on the **first** drain pass, 0 rejected, every
time (D12 F1). The module also records why a monotonic `uuidv7` would *not* have fixed it. That is
a good fix and a better write-up.

**One material offline gap, correctly named by the team and not hidden:** **receiving cannot start
cold offline.** No procurement table is in any sync bucket, so a partitioned device holds no
supplier, no order and no price. The Receiving screen keeps a **take-down** — a document stamped
with the minute it was taken, never presented as a current figure — which is the honest design; but
a yard that has never been online since the order was raised **cannot match a receipt to it**. The
receipt still records, with no order attached, which is the right failure rather than a refusal.

Against §2.2 — "every location must trade fully offline for hours or days" — this is a partial. It
is a *bounded* partial: the destructive outcomes (loss, double-count, corruption) are all excluded,
and what remains is a matching capability that degrades. I grade it met for Phase 2's scope and
carry the cold-start gap to §5.

**REVISION, after §2 — two corrections, and the second changes the grade.**

**Correction 1: I quoted a budget that is not a budget.** I wrote "acked `applied` in **34–66 ms
against a 60,000 ms budget**". `qa-engineer` found that the `(budget 60000ms)` text in D10 and D11
is emitted by `measure()` — **a print statement, not an assertion**. Those drills cannot fail on
time. Only **D1** hard-asserts the 60-second criterion. The 34–66 ms measurement is real; the word
"budget" beside it implied a check that does not exist, and I repeated the implication.

**Correction 2, and it is the substantive one: D11's "partitioned device" holds data a real
partitioned device could never have.** `qa-engineer` confirmed **0 of 10 procurement tables are in
any PowerSync bucket** — `supplier`, `supplier_capability_type`, `supplier_capability`,
`supplier_product`, `purchase_order`, `purchase_order_line`, `goods_receipt`, `goods_receipt_line`,
`delivery`, `reorder_point`, none of them. D11 then builds its offline receipt from
`purchase_order_line.id` and `supplier_id` values read **straight out of Postgres** via `scoped(...)`
and seeds the device catalogue with `seedProduct`/`seedPurchaseUnit`.

So the drill demonstrates that **a receipt composed from ids the device already has will survive a
partition and drain correctly** — which is a real and valuable property, and it is the *write path*.
It does **not** demonstrate that a yard can receive goods offline, because the ids are exactly what
a genuinely partitioned yard would not possess. The take-down mitigation that is supposed to cover
this is exercised by **no live drill at all** — only by in-process unit tests in
`apps/web/tests/receiving-ui.test.tsx`.

I named the cold-start gap in my original grade and then graded around it. §2's evidence shows it is
larger than the status document frames it, and that the demonstration I relied on **assumes the gap
away rather than closing it**. This is `docs/phase1-status.md` §0's one root cause again, in the
harness rather than the product: the drill supplied a precondition the field does not.

**A third consequence, which neither status document states.** Because no procurement table syncs, a
device can write `goods.record_receipt` and then **never read back what it wrote** — there is no
local `goods_receipt` or `delivery` table, and `data/queries/procurement-outbox.ts` reconstructs the
yard's view by re-parsing the *queued outbox payload*. Once acked, the receipt exists on that device
only as a historical payload, and **a second device at the same yard sees nothing at all.**

**Grade: PARTITION-SURVIVAL, ORDERING AND IDEMPOTENCY — MET, and the `queue_seq` work is excellent.
OFFLINE RECEIVING AS A YARD CAPABILITY — NOT DEMONSTRATED.** Against §2.2's "every location must
trade fully offline for hours or days", procurement does not.

### 1.5 P2-5 — Reorder points tied to Phase 1 alerts · **HALF DEMONSTRATED**

**What was shown, and it is the right shape** (D11 1e): the **Phase 1 low-stock alert comes back
SOURCED** — the same alert rows, joined to a real supplier, expressed in the **purchase** unit, and
pre-filling a draft order. Shortfall `1000` BAR → `basis=PREFERRED`, `10667` TON. That is precisely
"tied to Phase 1 alerts" rather than a second parallel alert system, and it is the correct answer.

**What is not shown, and it is not a small thing.** From `docs/phase1-status.md` §6 item 15, and
consistent with what I verified in the route sweep:

- `applyReorderPoints` correctly seeds nothing at template time (a threshold only means something
  where the ledger already shows stock), and `infra/scripts/bootstrap.ts` never calls
  `ensureReorderPoints` afterwards. **A freshly provisioned tenant has zero thresholds and a
  permanently empty alert list** until a human calls the route.
- **`inventory.ensureReorderPoints` has no button.** It is the one Phase 2 route with no production
  call site. A manager cannot ask the product to seed thresholds for a location that has started
  trading; thresholds are set one at a time through `inventory.setReorderPoint`, which *is* wired.
- The level `ensureReorderPoints` would seed is `REORDER_FRACTION_BP` = 25% of opening stock,
  flagged `needsFounderReview` and labelled `[NEEDS-FOUNDER]` in the row's own notes.

So the chain "stock falls → alert fires → alert names a supplier and a purchase unit → draft order"
is demonstrated end to end, and the **first link has no origin** on a real tenant. For 25 locations
against a 219-SKU catalogue, setting thresholds one at a time is not a workflow.

I note with approval that the 25%-of-opening-stock figure is labelled a founder guess rather than
presented as a system default. That is the honest pattern. But an unbuttoned route plus an unseeded
table is a capability that exists in the router and not in the product.

**Grade: THE TIE IS DEMONSTRATED; THE THRESHOLDS HAVE NO PRACTICAL ORIGIN.** Carried to §5.

### 1.6 P2-6 — Dispatch and tracking, and no fleet · **DEMONSTRATED, INCLUDING THE NEGATIVE**

**The negative is the part I care about**, because `ADR-0001` is a scope decision and scope
decisions decay quietly. It was checked two ways and both are the right ways:

- A tree-wide search for `vehicle|driver|fuel|truck|odometer|mileage|maintenance|fleet|plate`
  across `apps/`, `packages/`, `infra/` and `tools/` returns 139 hits and **not one entity** —
  every one is prose, a comment, a test name, or a test **asserting the absence**.
- Run against the **deployed Postgres**, `information_schema` returns **zero** tables and **zero**
  columns in `app` or `platform` matching those words, and `packages/contracts/src/*.ts` has zero
  matching field declarations.

Checking the live database rather than only the tree is the correct instinct — a migration can add
a column the source tree does not obviously name.

**The positive:** a haulier is modelled **only** as a supplier — `app.supplier` +
`app.supplier_capability` with a **platform** `kind` of `HAULAGE`, and `app.delivery.
carrier_supplier_id NOT NULL` referencing `app.supplier`. The client finds carriers by the platform
kind, never by the tenant's own capability code, which is §2.9 respected at the point it is easiest
to breach. A delivery is planned against a carrier that is a supplier, both status moves reach
Postgres through the outbox, Postgres says `DELIVERED` with both timestamps, and the client's own
read agrees with the freight **as a bigint** (D11 5a–5f).

**Grade: MET.**

### 1.7 P2-7 — `ADR-0001`'s exchange: distribution cost as % of revenue · **REVISED AFTER §2. THE FIGURE IS DEMONSTRATED; ITS GUARD IS UNEXERCISED AND ITS DENOMINATOR IS CONTAMINATED**

This is the criterion the founder gave up an owned fleet for, and it is answered.

**What was shown** (D12 C1–C8, D1–D4): `reports.distributionCostRatio` returns a real figure — not
`null`, not `NO_DISTRIBUTION_COST_SOURCE`. Numerator `app.delivery.freight_cost_minor`, denominator
ex-tax after-discount revenue, both dated by the same business date, scaled as **percent × 10⁴ as an
integer** so the model's 5.0% and 2.5% are exactly `50000` and `25000`. Never a float — §2.3 held at
the reporting boundary, which is where it is most often dropped.

**It reconciles three ways, and that is why I accept it:**
- Σ(per-location) = network, enforced by the server itself via `assertAggregateIdentity`;
- numerator and denominator each equal an **independent Postgres sum** over the same period and
  scope (119 deliveries, 11 without agreed freight), with the **delivery counts** matched too —
  a sum matching on a different row set would be luck;
- the percentage equals `freight ÷ revenue` recomputed in **bigint, half-up, by a second
  implementation written inside the drill**.

**One numerator, one definition:** `loadHaulageSpend` is exported once and called by **both**
`logistics.haulageSpend` and `reports.distributionCostRatio`, so two screens cannot quote different
figures for the same month. D11 5g asserts they are byte-identical for the same day. This is the
kind of structural choice that prevents a class of dispute rather than a single bug.

**The region rollup is the closure, not a parent pointer** (D12 D1–D2) — every group sums over
`app.location_closure`, against an independently read closure, and the response states `groupsNest`
so nobody adds the subtotals up. It will still be right when a region nests.

**The period key is the row's own business date, never a device clock.** A delivery whose tablet is
three days fast lands in its business date's period and is **absent** from the device clock's day
(D12 B3, C8), and **no row written since migration `0010` carries `DISPATCH_CLOCK`** (D12 H1) — an
invariant asserted over the whole table rather than over the drill's own rows. §0 row 15 (no screen
could assert a business date) is closed and the closure is demonstrated with three deliberately
distinct dates so no fallback arm can pass by coincidence (D13 D1–D12).

**Zero is not null.** `deliveryCount = 0` is a real zero; `netRevenue = 0` gives a null percentage
with `NO_REVENUE_IN_PERIOD` and **still reports the cost**, because a warehouse has no till and
still pays hauliers; and where freight was never agreed the row says `INCOMPLETE_FREIGHT_BASIS` and
the sum is declared a **floor**, not a total. That distinction is the difference between a report
and a misleading report.

**And it is qualified rather than oversold.** `costBasis: 'AGREED_NOT_INVOICED'` is on every
response and printed under the number. The figure is the **agreed** freight, not the haulier's AP
invoice, because there is no general ledger until Phase 3. Whether that makes it comparable to the
model's 5.0% target is a question for §3 and for the accountant, not for me — but the software says
what it is, which is the whole of its obligation here.

**REVISION, after §2 — two qualifications, neither of which unmakes the figure.**

**Qualification 1: the guard behind the reconciliation has never been shown to fire.**
`assertAggregateIdentity` (`apps/api/src/routers/reports.ts:106`) is what I cited as the server
*enforcing* Σ(per-location) = network. Its own comment says it exists "so that the day somebody adds
a predicate to one query and forgets the other, the report stops rather than lies." `qa-engineer`
found **zero tests reference it or `REPORT_IDENTITY_VIOLATION`.** The reconciliation checks confirm
the identity *holds*; nothing confirms the guard *detects it breaking*. That is a different claim,
and it is the one the guard exists to support. Same pattern as §4.1's finding across the whole money
path: every fail-closed control on this project is unexercised.

**Qualification 2, and it is more serious: the denominator is contaminated.** The ratio divides by
ex-tax **after-discount** revenue. §2's finding 1 (below, and revised into §1.9c) shows
`lineDiscountMinor` is authorised by nothing — counter staff can discount a line to zero. Any
unauthorised discount reduces the denominator, which **inflates the distribution-cost percentage**.
So the number that `ADR-0001` traded the fleet for is arithmetically sound, reconciled three ways,
and sits on a revenue figure that any counter-staff device can move at will. The reconciliation
checks would not notice, because they reconcile the figure against itself computed a second way —
both computations read the same contaminated `sale` rows.

**Neither qualification is a defect in the ratio.** The numerator, the scaling, the closure rollup,
the business-date keying and the `INCOMPLETE_FREIGHT_BASIS` honesty all stand and are the best
reporting work on the project. What is qualified is how much a founder should trust the *level* of
the number before the sale path is authorised.

**Grade: MET — `ADR-0001`'s engineering half is delivered.** With the guard unexercised and the
denominator resting on an unauthorised discount field. Its financial half is Q1 and remains a
human's.

### 1.8 P2-8 — Tenant isolation across Phase 2 · **REVISED AFTER §2. DEMONSTRATED IN THE DRILLS; NOT FULLY COVERED IN THE SUITE**

**What was shown:** two-tenant refusal on **every new read path** — order, delivery, order list,
delivery list, supplier list (same codes, **zero shared ids**), sources-for-product, goods receipt,
receipt status, haulage spend, reorder suggestions — each paired with a positive control that the
rightful tenant *can* read the same row (D11 6a–6k, 12 checks).

**And on the write path, which is the newer and sharper case** (D12 G1–G4): tenant B, **holding
`supplier.manage`**, cannot amend tenant A's supplier by its real id. Refused; A's row unchanged
(terms still 30); nothing copied across. The Q1 report itself is tenant-scoped with zero shared
location ids, and naming A's location outright is **refused (`PERMISSION_OUT_OF_SCOPE`), not
silently emptied** — which is the correct behaviour, because a silent empty result is
indistinguishable from a true zero and teaches a user to trust it.

Holding the capability and still being refused is the check that matters: it separates "this
caller lacks permission" from "this row is not yours", and only the second is tenant isolation.

**REVISION, after §2 — the drills are as good as I said; the regression suite is not.**

I closed this grade by deferring the coverage question to §2. §2 answers it, and the answer changes
what "demonstrated" is worth here.

- **`procurement.reorderSuggestions` — a Phase 2 read path — has no automated two-tenant test.** It
  is covered by D11's live block and by nothing that runs in an ordinary `pnpm test`.
- **`reports.stockOnHand` is vacuous in the shape this repository has caught before**: the isolation
  assertion loops over the result asserting no id belongs to tenant B, with **no
  `expect(length).toBeGreaterThan(0)`. An empty report passes.** `reports.inventoryDays` and
  `reports.cashPosition` are refusal-only — nothing asserts the *aggregate* excludes the other
  tenant, which is the only thing that matters for a report.
- `reports.distributionCostRatio` — **P2-7's own route** — carries a weaker version of the same
  shape, mitigated by marker assertions above it.

**The distinction that matters, and it is not pedantic.** Phase 2's isolation evidence lives
overwhelmingly in **live drills that require docker**. The evidence is excellent — exact refusals
against real foreign ids, paired positive controls, raw-sqlite byte greps. But §2.7 asks for
**tests**, and the reason is regression: a drill nobody runs on a Tuesday afternoon does not stop a
predicate being dropped. §2.1 calls this failure class unrecoverable.

**Grade: MET AS DEMONSTRATED IN THE DRILLS; NOT ADEQUATELY COVERED AS A REGRESSION PROPERTY.** No
live leak was found anywhere, by anyone, at any layer — the exposure is future regression, not a
present breach.

### 1.9 The process finding: **no gate in this project has ever been signed**

This is the finding I least expected to make and the one I am most obliged to record.

**Phase 0 was never approved — or its approval was never recorded, which for a gate is the same
thing.** `docs/architecture/README.md:3` still reads, today:

> **Status: DRAFT, awaiting explicit human approval. The build stops here.**

`CLAUDE.md` §3 could not be more direct: "Phase 0 — Architecture document. This comes first and
**nothing else starts until it is approved**… **Stop after this document and wait for explicit
approval.**" There is no approval record in `docs/`, none in the architecture document's own status
line, and none in any commit message. Phase 1 was built. Phase 2 was built. The document that says
"the build stops here" is still marked DRAFT.

**And the architecture document anticipated exactly this.** Its §8 states that approval "**does not
authorise Phase 2 or Phase 3** — those have their own gates", and it names the sequencing that
"must happen before money is spent or a schema is frozen":

> 1. **Week 1–3 — the hardware trial.** Receipt printing, hardware-backed key storage and storage
>    eviction, on the exact tablets and printers under consideration. **Before printers are bought.**
> 2. **Week 1 — start Q8.** "The GRA e-invoicing engagement has the longest lead time of anything
>    in Phase 1 and it determines the POS document model. **It cannot start later.**"

**Both of those are Week 1 items. Neither has happened.** There are fourteen migrations, two phases
of application code, 1,295+ tests and thirteen live drills — and no receipt has been printed on a
real printer, and the Q8 engagement has not begun. The two tasks the architecture document singled
out as *the ones that cannot wait* are precisely the two that waited.

I am not going to pretend this can be repaired retrospectively. What I can do is refuse to compound
it, and that is what §6 does.

### 1.9b Phase 1 was also never signed off, and the cost of that is measurable

`CLAUDE.md` §3: "**sign-off required between each**". **Phase 1 has never been signed off.**
`docs/phase1-status.md` §5 grades Phase 1 criterion 3 as **still not signed off** as of 2026-08-23,
and §6 carries live blockers including a `NEEDS-HUMAN` gate (Q4), a receipt-printing spike blocked
on a hardware decision, and a real-device trial that has not happened. Phase 2 was nevertheless
built, and this gate is being run on it.

I am recording that as a breach rather than waiving it, and I am recording its **cost**, because
the cost is not hypothetical and it is unusually well documented here:

> Phase 2 built a procurement and receiving layer on top of a pricing layer that **could not ring
> the pilot tenant's own retail sale**. Tenant #1's best-ranked price list is `RETAIL`,
> `is_tax_inclusive = true`; `sales.createSale` answered `PRECONDITION_FAILED: tax-inclusive price
> lists are not yet supported`; and `infra/scripts/dev-prices.ts` flipped the list to exclusive on
> every `pnpm stack:reset`, so **eleven live drills ran green over a launch blocker against a
> configuration no tenant runs** (`docs/phase1-status.md` §6 item 12, §0 row 18).

That was closed on 2026-08-23 — the flip is **deleted, not made opt-in** — and D17 (32/32) now
demonstrates the pilot ringing a retail sale on its real configuration, mutation-tested twice.
But it went undetected across the entire Phase 2 build, and a Phase 1 gate is exactly the event
that would have caught it, because a Phase 1 gate asks "show me the pilot taking a sale" and no
amount of Phase 2 progress asks that question.

**This is the single most useful lesson available at this gate, and it is not a criticism of the
engineering — which found it, wrote it up in full, and deleted the fixture rather than flagging it
off. It is a criticism of the sequencing, which is mine to own.**

### 1.9c A Phase 1 breach that lands on this gate: counter staff can ring a sale for zero

This is not a Phase 2 criterion and I am recording it in §1 anyway, because a Phase 2 gate that
noticed it and filed it elsewhere would be doing the thing this role exists to prevent.

`qa-engineer` probed rather than read, and rang four sales against the live API as a **counter-staff**
principal whose `session.permissions` returns nine codes, **neither of which is
`sale.override_price` nor `sale.discount.apply`**:

| `lineDiscountMinor` sent | HTTP | Written |
|---|---|---|
| `0` (control) | 200 | `net=10000 disc=0 total=12000` |
| `100` | 200 | `net=10000 disc=83 total=11900` |
| `11999` | 200 | `net=10000 disc=9999 **total=1**` |
| **`12000`** | **200** | `net=10000 disc=10000 **total=0**` |
| `12001` | 400 | `line discount exceeds line amount` |

**A counter-staff device gave the goods away for nothing, and the server priced it, wrote it and
returned 200.** The only ceiling is **arithmetic** — discount ≤ line amount — not **authorisation**.
`sale.override_price` has zero references in `apps/api/src`. `sale.discount.apply`, which tenant #1's
template authored with `bound = {"max_bps": 300}`, is enforced nowhere; the 3% ceiling the template
author carefully wrote down does not exist at runtime.

**Three things follow, and each corrects something previously written down as safe.**

1. **`CLAUDE.md` §2.6 is breached on its first named example.** It says outlet staff have "**no**
   pricing overrides". A 100% discount is a pricing override by any commercial definition — it is
   precisely the shrinkage route a POS exists to close.
2. **`docs/phase1-status.md` §6 item 2 is false as written.** It states: *"`createSale` never accepts
   a price… So the brief's first hard prohibition holds **structurally** today."* The first clause is
   true and the conclusion does not follow. The server does always price, and D6's
   `server=19081 till=29700` proves the till's claim is discarded — that structural guarantee is real
   and excellent. **The discount is a separate field that bypasses it**, and the status document's
   confidence rests on having examined only the price field.
3. **It reaches Phase 2 in two places.** It contaminates P2-7's revenue denominator (§1.7). And it
   makes the credit bound porous: `sale.record.credit` is bounded against the **server's repriced
   total**, which is the correct design — but that total is now movable by an unauthorised field, so
   an outlet manager bounded at 500,000 can release 2,000,000 of goods on credit by discounting to
   400,000. The bound bounds the *invoice*, not the *goods*.

**What is not compromised, stated so the finding is not over-read.** The server-side pricing
authority holds. The credit-limit half of §2.6 is properly enforced and properly demonstrated —
counter staff and outlet managers are both refused `credit.account.manage`, a till claiming
`clientTotalMinor: "1"` is still refused, and revocation takes effect on the next request rather
than at token expiry. The RBAC primitives themselves are correct and tested; `rbac.test.ts:370–377`
exercises `requireWithinBound` properly. **No sale path calls them**, and `rbac.test.ts:336` carries
a comment conceding the wiring is absent — so this was known somewhere in the tree and never
surfaced to a gate.

---

## 2. Test coverage in the mandatory categories

**Evidence: `docs/phase2-gate-evidence.md` (`qa-engineer`, 1,319 lines).** It graded against all
three constitutional categories. I have lifted its figures and formed my own judgement on what they
mean for the gate.

### 2.1 A discrepancy in the gate command itself, flagged rather than followed

`.claude/commands/phase-gate.md` instructs this section to cover "**the two mandatory categories**
— money-touching code and sync/conflict logic (`CLAUDE.md` §2.6)".

**That is wrong on both counts and I have not followed it.**

- The constitution defines **three** mandatory categories, not two, and they are at **§2.7**, not
  §2.6. §2.6 is access control. The third category is: "**Any read path that could cross a tenant
  boundary.** Every read gets a test proving a second tenant's data is invisible."
- The third category is not a minor omission. `ADR-0005` records that cross-tenant leakage "becomes
  a third mandatory test category alongside money and sync" precisely because the failure is
  **unrecoverable** — once data has synced to a device it cannot be recalled. A gate command that
  drops it from its own checklist is the exact erosion this role exists to prevent.
- Note also that `ADR-0005`'s consequences section itself cites "`CLAUDE.md` §2.6" for the three
  categories, so the stale cross-reference has propagated to at least two files.

**I have graded against the constitution: three categories.** Both documents should be corrected —
the command text to say "three mandatory categories (§2.7)", and `ADR-0005`'s citation to point at
§2.7. Recorded as a gate action, owner `product-manager`.

**`qa-engineer` reached the same conclusion independently**, from the same command text, and put it
at §0 of its own report before anything else — noting that *"anyone working from the two-category
wording would have skipped the only category whose failure mode cannot be undone."* Two reviewers
independently refusing the same bad instruction is the outcome the process is supposed to produce.
The instruction is still wrong in the file.

### 2.2 The headline figures

| | Figure |
|---|---|
| `pnpm exec turbo run typecheck build test --force` | **19/19 tasks, 0 cached** |
| Static suite | **1,554 tests / 104 files · 0 failed · 0 skipped · 0 todo** |
| Live drills | **12 drills, 345 checks** over real HTTP |
| `node tools/lint-money.mjs` | clean |
| `.only` / `.skip` / `.todo` | zero, anywhere in `apps` or `packages` |
| Migrations | **14 on disk, 14 applied** |

**Two corrections to the record that come with those figures.**

- **`docs/phase2-status.md`'s table (1,295 tests / 90 files) is a stale baseline.** The current
  figure is 1,554 / 104. This is the second time in this gate that document has been found behind
  the tree (§1.0). It should be superseded rather than patched.
- **Five drills appear in no status document at all.** `qa-engineer` enumerated the drill scripts
  from `package.json` rather than from any prose list and found **12**, where the status documents
  describe 7. A capability whose evidence exists but is undocumented is a capability the next gate
  will not know it has.

**Environment provenance was checked before anything was trusted, and both traps were real.** The
process listening on `:3001` **predated `HEAD` by 20 minutes** and was restarted onto current code —
this is `docs/phase1-status.md` §0 row 7's exact failure and it was live again. And the `ssh` process
on `:5433` turned out to be Colima's port-forward multiplexer rather than a foreign database; it was
proven to be the same database as the container by matching `system_identifier`
**7677344657172918306** and by writing a row through the API and reading it back inside the container
with `docker exec`. **I regard this as the single best piece of work in the evidence pack**, because
every figure downstream of it would otherwise be unattributable.

### 2.3 Category 1 — money

**The best-tested code in this repository is here, and it should be said first.** `packages/money`
carries 116 tests: property-based with 2,000 generated runs on the extract/compose round-trip,
scale-agnostic across scales 0–4, sign-symmetric, with hand-computed golden values and deliberate
boundary work. The auditor found **no tautologies, no self-comparisons, and no test that
re-implements the arithmetic under test** — it compares against independently stated goldens. No
float or `numeric` money column exists in any of the 14 migrations, verified by reading all 14
rather than by trusting the linter. No hard-coded minor-unit scale anywhere. Ageing bucket edges are
tested at 0/30/31/60/61/90/91 individually. Inter-location transfers correctly create no network
revenue, and COGS counts SALE outflow only — both inter-outlet inflation risks covered.

**The gap is one layer up, and it has a single consistent shape:**

> **Every fail-closed control and every mismatch-detector on the money path is unexercised. The code
> whose entire job is to catch a money bug in production has never been shown to catch anything.**

| Uncovered | Why it matters |
|---|---|
| **`recomputeCheck` — 12 mismatch branches, 0 exercised.** Every assertion in the repo is `expect(check.mismatches).toEqual([])` (×3) | **An implementation returning `{mismatches: []}` unconditionally would pass the entire suite.** This is the price-drift audit tool. `comparePriceCheck` *does* have a negative control — so the standard exists in this codebase and this fails it |
| **`assertAggregateIdentity` / `REPORT_IDENTITY_VIOLATION` — zero references** | The guard behind P2-7's Σ=network claim (§1.7) |
| **`assertPackPriceable`, `assertLineRounding` — refusal paths never fired** | A sale on a date with no rate rows in force should be refused rather than 500. Nothing proves it is |
| **`netRoundingModeFor` duplicated in `apps/api/src/tax.ts:270` and `apps/web/src/data/pricing/cart-pricing.ts:128`, with no test pinning the copies together** | The code names its own hazard — *"ONE RULE, TWO PLACES… these two functions must be changed together"* — and nothing enforces it. **The cheapest high-value missing test on this branch** |
| **`valueAt` — weighted-average cost → COGS → gross margin** | Indirect coverage only, with a `divRound(…, 'half-up')` whose boundary is asserted nowhere. Feeds two of the founder's tracked metrics |
| `days30`, `floorDivRem`, `roundingModeOf`'s silent `'down'` fallback | Public money surface, no direct tests |

**Two things that look like assurance and are not, both proved by mutation rather than argued:**

- **`tools/lint-money.mjs` is clean and demonstrably blind.** It fires on `totalMinor: number` — and
  **not** on `revenue`, `margin`, `freight`, `qty`, `discount` or `commission` typed as `number`, nor
  on any second declaration on the same line, because the regex is non-global. It is 47 lines and two
  regexes. **A clean `lint-money` should stop being cited as evidence**; cite
  `packages/db/test/conformance.test.ts:126` instead, which checks the database.
- **`apps/web/tests/tax-inclusive-pricing.test.ts` — 663 lines, 24 tests, the newest work on this
  branch — passed 24/24 with half-up rounding corrupted to truncation.** The money suite caught it
  with 18 failures and the API tax suite with 2; this file caught nothing, because its assertions are
  self-consistency invariants (`net + tax === gross`) that hold under *any* rounding rule. **It proves
  round-tripping, not the split.** That bears directly on §1: D17 is this branch's headline evidence,
  and the client-side half of it is weaker than its test count suggests.
- A third, smaller one already folded into §1.4: **`(budget 60000ms)` in D10 and D11 is a print
  statement.** Only D1 hard-asserts the 60-second criterion.

**Not covered at all: any reconciliation to `docs/source-of-truth/financial-model-targets.md`.** Zero
test references. There is also **no fiscal-year concept anywhere** — nothing reasons about 1 Aug–31
Jul; reports take explicit `from`/`to`. Nothing is wrong today, but "the reports tie to the model" is
currently unevidenced, which is §3.4's point arriving from the other direction.

**A §2.8 item found inside category 1:** `priceInclusive`'s two-extraction discount rule
(`apps/api/src/routers/sales.ts:203`) carries its own note — *"NEEDS A HUMAN (CLAUDE.md §2.8): an
accountant should confirm this… it is the one place where the figure stored is not the figure
typed."* That review has not happened. Added to §4.1's gate list.

**Category 1 verdict: PASS on the arithmetic, FAIL on the controls.** Nothing that computes money is
untested. Nothing that *guards* money has been shown to work.

### 2.4 Category 2 — sync and conflict

**Strong where it has been exercised.** Partition, drain, verbatim replay and idempotency are
demonstrated across six wire kinds; `outbox.queue_seq` is proven deterministic over six consecutive
runs with pinned-identical instants; clock skew on `occurredAt` is tested with a three-day-fast
tablet; the `claimed_hlc` ±24h clamp is tested.

**Four gaps, and the first two are structural rather than thin.**

1. **The human review queue is write-only** — §1.3. Six rows, all open, none ever claimed or
   resolved, nothing capable of claiming or resolving one. **This is a direct breach of §2.2**, and
   it is the finding I would put first in the whole gate.
2. **§2.2's canonical hard case is untested.** The constitution names it explicitly: *"two locations
   editing the same customer's credit limit while both offline."* `credit.setLimit` is **online-only**
   — not in `DEVICE_OP_KINDS`, not in `WIRE_KINDS` — so a device physically cannot queue one. The
   mechanism is a compare-and-set refusing a stale claim with `CONFLICT: LIMIT_VERSION_STALE`, and it
   **opens no `conflict_review` row**. The only test is one caller making two sequential in-process
   calls against PGlite: no devices, no locations, no partition, no network. **The refusal semantics
   are tested; the scenario the constitution names is foreclosed by design and never demonstrated.**
   Foreclosing it is a defensible choice — but it is a choice, it is nowhere written down as an ADR,
   and a gate should not record the constitution's named hard case as covered when it is avoided.
   *Latent hazard worth one pinning test:* `LIMIT_VERSION_STALE` is prefixed `CONFLICT`, which
   `classifyRejection` maps to **retryable** — if `setLimit` ever became device-uploadable, the
   client would resend the same stale claim every 30 seconds forever.
3. **`credit.open_account` is an accepted server op with zero coverage** — no offline, replay or
   conflict test, alone among the seven wire kinds. Unreachable from the PWA today, so latent. The
   concrete hazard: `customer_account_customer_uq` is unique on `(tenant_id, customer_id)`, so two
   partitioned clients opening an account for the same customer produce a duplicate-key
   `INTERNAL_SERVER_ERROR`, which `classifyRejection` treats as **retryable** — **the queue wedges
   forever.**
4. **`businessDate` is client-claimed, authoritative, unbounded and untested for skew** — unlike
   `claimed_hlc` (clamped ±24h and tested) and `occurredAt` (tested). §1.7 relies on this field being
   the period key.

**And one finding that belongs to no category and matters anyway.** Five tables are synced to every
device and **read by nothing in the PWA**: `stock_movement`, `sale`, `sale_line`, `sale_tax_line`,
`credit_limit_version` — 0 readers each. **There is no offline on-hand lookup anywhere**, despite
§2.6 granting outlet staff "POS **and stock lookups**". The structural test
`sync-rules-to-device.test.ts` checks declaration in both directions and has no check for "a synced
table nothing reads", so this is invisible to the suite. It also means **D1 and D2 assert against
tables no PWA screen reads** — the sync path is proven, the counter's use of it is not.

**Category 2 verdict: PASS on convergence and idempotency, FAIL on conflict resolution.** §2.2 has
two halves — conflicts must not be silently overwritten, *and* they must reach a human. The first
holds. The second does not exist.

### 2.5 Category 3 — tenant-boundary read paths

**This is the category §2.1 calls unrecoverable, and it is the one Phase 1 criterion 5 states must be
demonstrated at *every* read path.**

Of **28 query procedures**, enumerated by runtime introspection rather than by reading:

| | Count | Which |
|---|---:|---|
| Real, non-vacuous two-tenant test | **19** | — |
| **Partial** — refusal-only; nothing asserts the aggregate excludes the other tenant | **3** | `reports.inventoryDays`, `reports.cashPosition`, `reports.stockOnHand` |
| **Vacuous** | **1** | `catalogue.detail` |
| **No automated two-tenant test at all** | **5** | `procurement.reorderSuggestions`, `sales.get`, `sales.recomputeCheck`, `credit.previewFacilityFee`, `session.permissions` |

**`catalogue.detail` is vacuous in the exact way this repository has caught before.** The test asserts
a foreign id and a nonexistent id both throw `NOT_FOUND` with identical messages — and
`catalogue.detail` appears exactly once in the entire repository outside its own router definition,
**inside that throwing branch**. There is no positive control anywhere that the route ever returns a
product. **A stub that unconditionally threw `NOT_FOUND` would pass it.** (A live probe confirms the
route works, so the route is fine and the test is worthless.)

**`reports.stockOnHand` is the `[].every()` shape**: a loop asserting no returned id belongs to
tenant B, with no assertion that anything was returned. **An empty report passes.**

**The structural backstop is excellent in `app` and absent in `platform`.** All 45 `app.*` tables:
RLS enabled *and forced*, `tenant_id` present, one policy each, tenant-leading index, **zero gaps** —
and an unpredicated query as `app_user` with no GUC set returns 0 rows and no error, which is §2.1's
"fails closed" holding exactly as designed. **Six `platform.*` tables have RLS off and not forced**,
and as `app_user` with tenant A's GUC set, `select * from platform.tenant` returns **both tenants'
legal names** and `platform.tenant_database` returns the other tenant's `dsn_ref` and
`sync_service_ref`. Not reachable through any current tRPC query — both readers predicate correctly —
so **not a live breach**. But `packages/db/test/conformance.test.ts:61` filters
`where n.nspname = 'app'`, placing the entire platform schema outside the structural check. One
forgotten predicate in a future resolver leaks the tenant registry.

**The strongest isolation evidence in the repository is real and I do not want it lost in this
list:** D5 and D8 inspect **raw sqlite device files and their `-wal` sidecars**, assert exact
per-table counts against a tenant-scoped server prediction, byte-grep for the other tenant's uuid,
customer name and balance string, pair every zero with a live positive control, and are
mutation-tested — removing the `credit.view` gate turns D8 red, and removing a tenant predicate is
refused outright by PowerSync's own validator, which halts replication rather than serving an
unscoped bucket. That is the boundary §2.1 says actually matters, and it is held well.

**Category 3 verdict: FAIL as Phase 1 criterion 5 is written.** "Demonstrated at every read path" is
not true of 6 of 28 procedures, and one of the six is proven by a test that cannot fail. **No live
leak was found by anyone at any layer** — the exposure is regression on an unrecoverable property,
not a present breach. That distinction is real and it is not a reason to pass the criterion.

### 2.6 What could not be verified at all

Recorded because a gate should distinguish "tested and fine" from "nobody looked":

- **The PWA on real Android hardware — no coverage of any kind, and no harness exists.** Not thin
  coverage: zero. OPFS persistence, service-worker update, wasm workers, touch behaviour, sync under
  field latency.
- Whether the six untested read paths leak under other data shapes.
- The >500-op backlog drain stall — assessed by reading code only.
- Reproducibility from a clean `stack:reset` **in this run** (the 2026-08-23 clean-slate re-run in
  `docs/phase1-status.md` §5 is the standing evidence for that, and it is one day old).

### 2.7 Summary of the three categories

| Category (§2.7) | Verdict |
|---|---|
| **1 — money** | **PASS on arithmetic, FAIL on controls.** The best-tested code in the repo sits under a layer of fail-closed guards that have never fired |
| **2 — sync & conflict** | **PASS on convergence and idempotency, FAIL on conflict resolution.** §2.2's review queue has no reader; its canonical hard case is untested |
| **3 — tenant boundary** | **FAIL as criterion 5 is written.** 19 of 28 genuinely covered; 1 vacuous, 5 untested, 3 partial; `platform.*` outside the structural backstop |

**§2.7 says nothing in these categories is "done" without tests.** On that wording, parts of all
three categories are not done.

---

## 3. Open questions

**I own `docs/open-questions.md`.** Two rules govern what follows. First, **no `NEEDS-HUMAN` item
is closed by an agent** — not by me, not by anyone I delegate to; the most I may do is record that
the software's posture toward it is honest. Second, the question that actually matters at a gate is
not "how many are open" but **"is any missing human being routed around?"**

### 3.1 The workaround hunt

The failure mode I am hunting: **engineering routing around a missing human by shipping a default
that is silently wrong.** The honest pattern already exists in this codebase and it is the
benchmark —

> `accrueFacilityFee` answers **HTTP 412 `FEE_POLICY_UNCONFIRMED`** and the account carries **zero**
> `FEE` entries. It refuses to post rather than guessing a rate.

Every `NEEDS-HUMAN` and human-owned item is graded on that scale:

- **(a) refuses to act** — the honest pattern;
- **(b) acts on a clearly-labelled provisional value the user can see** — acceptable;
- **(c) acts on a silent default a user would not know was a guess** — **a gate finding**.

**Result: there is a category (c) item, and it is the most important finding in this gate.** It is
recorded at §3.1.2. Before that, the long list of places where the honest pattern *does* hold —
because the contrast is the point, and because "we looked and found nothing" is worthless without
saying where you looked.

> **A note on how this was found, because it is the same lesson as §0's.** My own first pass
> through the documents concluded that no category (c) item existed. The documents say the gate
> holds. `compliance-gatekeeper` then read the **code** rather than the documents and found that
> the gate is written into the schema, described in a comment, referenced in `open-questions.md`
> — and **never read by anything**. That is §0's one root cause with a new noun: the third thing
> everyone agreed with was a column comment. A gate that reviewed only the reports would have
> signed this off.

### 3.1.1 Where the honest pattern holds

| Where a silent default would have been easiest | What is actually there | Grade |
|---|---|---|
| The facility fee rate (Q4, Q18) | 412 `FEE_POLICY_UNCONFIRMED`, zero `FEE` rows; the CoA template ships the fee account's tax code **unset**; `previewFacilityFee` returns `provisional=true`, `label="provisional — not chargeable"` | **(a)** |
| A supplier's price, where none has been paid (P2-2) | `last_price_e4` is **NULL**, and `packages/db/migrations/0008_procurement.sql:293–296` says why in its own comment: *"NULL until we have paid anything — a zero here would read as free."* The compared source carries `priceComparable: boolean` and `priceUnavailableReason` | **(a)/(b)** |
| A supplier's lead time | NULL, with the template note `[NEEDS-FOUNDER: … A guessed lead time drives the order-up-to arithmetic]` | **(a)/(b)** |
| A unit conversion factor (Q7, Q9) | `infra/scripts/dev-purchase-units.ts` enables a direction on a factor the template already authored and **invents no factor**, stating that a guessed factor "would make D11 green on a wrong receipt" | **(a)** |
| A reorder threshold (P2-5) | Seeded level is labelled `needsFounderReview` and `[NEEDS-FOUNDER]` in the row's own notes; onboarding seeds **nothing** | **(b)** |
| Freight with no agreed figure (Q1, P2-7) | Row flagged `INCOMPLETE_FREIGHT_BASIS`; the sum is declared a **floor**, not a total; `costBasis: 'AGREED_NOT_INVOICED'` printed under the number | **(b)** |
| Inventory days / gross margin with an uncosted receipt | Returns **`null` with `INCOMPLETE_COST_BASIS`** and a count, rather than a partial figure | **(a)** |
| Revenue with no sales in the period | Null percentage with `NO_REVENUE_IN_PERIOD`, **and the cost still reported** — because a warehouse has no till and still pays hauliers | **(b)** |
| A low-stock list a partitioned device cannot fetch | Distinguishes *"this device could not check"* from *"no thresholds set here yet — this is not a report that stock is healthy"* from *"nothing is below threshold"*, all three mutation-tested | **(b)** |
| A tenant's target curve on the Reports screen | **Absent, deliberately.** `apps/web/src/features/reports/Reports.tsx:502–517` refuses to draw the 5.0% → 2.5% line, citing §2.9 and `ADR-0006` by name; `apps/web/tests/reports-ui.test.tsx:632` asserts `queryByText(/target/i)` is null | **(a)** |
| A tax rate | Effective-dated rows; a sale dated 2025-06-15 reprices against the regime in force **then** (net 14,766, `GH.COVID` present) while today's reprices against today's (net 15,000) — same gross, different net, so no constant divisor is hiding anywhere. Mutation-tested: forcing today's rates for a back-dated sale turns four checks red | **(a)** |

**The one place the pattern is *inverted* — and it is a finding.** `infra/scripts/dev-prices.ts`
used to flip tenant #1's tax-inclusive `RETAIL` list to exclusive on every reset. It announced
itself loudly on every run and was written up in `§6 item 12` — and it still hid a launch blocker
for the whole of Phase 1, because **announced is not tested**. It is now deleted rather than made
opt-in, and the structural replacement is D17 checks A1/A2, which read `price_list.is_tax_inclusive`
out of Postgres and fail if anything ever flips it back.

I am recording this because it generalises into a rule this project should keep: **a development
fixture that changes tenant *configuration* invalidates every test above it.** Not a fixture that
supplies test *data* — one that changes what the tenant *is*. There is no lint for that today.

### 3.1.2 GATE FINDING G-1 — the VAT path fails **open** while the fee path fails **closed**

This is the workaround. It does not look like one, which is why it survived.

**The gate exists in the schema.** `platform.tax_rate` carries `confirmed_by` and `confirmed_at`,
and `packages/db/migrations/0001_platform.sql:140–144` comments them:

> *"The §2.8 gate, in the schema… NULL = `[UNCONFIRMED]`."*

Every seeded Ghana rate row has both **NULL** by design (`packages/db/src/seed/ghana.ts:5–8`), and
every `legal_reference` ends `[UNCONFIRMED]`. That is correct and deliberate: nobody has confirmed
these rates, and the schema says so.

**Nothing reads them.** `taxComponentsInForce` selects `id, tax_code, rate_bp, base_kind,
base_includes, rounding_level, rounding_mode` and **stops** (`apps/api/src/tax.ts:89–95`). The two
confirmation columns are synced to the device (`apps/web/src/data/schema.ts:234–235`) and read by
nothing on either side. And `provisioning.createTenant` writes `status='active',
activated_at=now()` immediately (`apps/api/src/routers/provisioning.ts:56–61`), so the
`'provisioning'` lifecycle state that exists in the schema is never occupied by any tenant.

**The net effect.** The POS computes, displays, stores and prints VAT 15% + NHIL 2.5% +
GETFund 2.5% on every line — derived from a software team's reading of published web pages on
**20 August 2026**, by people the practitioner brief itself describes as having "no professional
standing to interpret them" — and **no screen, no receipt, no API response field, no report and no
gate says so anywhere.** A cashier handing over a receipt, and a founder reading a margin report,
would both reasonably believe those figures are settled. They are marked `[UNCONFIRMED]` in a
column nobody queries.

**Why this is the finding and not just a bug.** Set it beside the pattern this project is rightly
proud of:

| | Facility fee | Sales tax |
|---|---|---|
| Financial exposure | Unmodelled upside; roughly nothing at risk today | **Every sale.** GH₵2,640,000 of FY1 revenue |
| Statutory? | Commercial policy, possibly regulated | **Statutory, remitted to the GRA** |
| Human confirmation | Absent | Absent |
| Behaviour | **Refuses to post. HTTP 412 `FEE_POLICY_UNCONFIRMED`, zero rows** | **Posts silently, on every line, all day** |

**That is exactly backwards.** The strictness was applied where the risk is smallest and omitted
where it is largest. §2.5 is not the reason — §2.5 is satisfied, the rates *are* effective-dated
data and there is no jurisdiction branch anywhere. §2.8 is the reason: it makes a professional's
confirmation blocking, and on this path the block was written down and never wired.

**`qa-engineer` reached this finding independently** — 7 of 7 Ghana rate rows carry
`confirmed_by = NULL` — and adds one thing I had missed, which makes it worse rather than better:

> **This branch degrades the only natural detection mechanism.** §2.4 justifies treating tax
> differently from payroll on the grounds that *"a stale VAT rate is visibly wrong on a receipt
> today"*. Tax-**inclusive** pricing means the customer pays the shelf price whatever the rate is. A
> wrong rate is therefore **invisible at the till** — it misstates only the net/tax split, i.e. the
> figure remitted to the GRA. The self-correcting property the constitution relies on to permit
> computing tax at all **has just been removed from the pilot's own price list**, and nothing was
> added in its place.

That is not an argument against tax-inclusive pricing, which tenant #1 needs and which is well built.
It is an argument that the confirmation gate stopped being optional the moment inclusive pricing
landed.

**The fix is small, and it is the same shape the codebase already has.** Land `createTenant` on
`status = 'provisioning'`, and make activation require every `tax_rate` row in the tenant's
jurisdiction with an open effective range to carry a non-null `confirmed_by`. Refuse with
`HTTP 412 TAX_RATES_UNCONFIRMED` — the same vocabulary as `FEE_POLICY_UNCONFIRMED`, so the product
has one refusal idiom. **Nothing about the build changes. The documented gate simply becomes an
enforced one.**

### 3.1.3 GATE FINDING G-2 — the 219-SKU catalogue asserts standard-rating, and the product tax code cannot change the answer

Two halves, and the second is worse than the first.

**First:** `packages/db/src/seed/template.ts:275` seeds `'GH.VAT.STD'` for all 219 SKUs, with **no
`[NEEDS-FOUNDER]` or `[UNCONFIRMED]` marker** — unlike the reorder points (`template.ts:799`) and
the supplier payment terms (`packages/db/src/seed/suppliers.ts:78`), both of which carry one. So a
tax treatment asserted for the whole catalogue is the one template value that does *not* announce
itself as a guess, in a template whose author was otherwise scrupulous about exactly that.

**Second, and this is the sharp half:** the product's tax code is only a **presence** check.
`apps/api/src/routers/sales.ts:373–378` verifies the product's code has *some* rate in force, and
then `apps/api/src/tax.ts:14–19` applies **every tax code in the jurisdiction with a rate row in
force** to the line, regardless of what the product's own code says. **Marking a SKU zero-rated or
exempt would change nothing.**

This is honestly disclosed in a code comment — *"Phase 1 component-set rule… revisited when the
pack grows a `kind` column"* — and invisible everywhere else. The consequence: **if any part of a
construction-materials catalogue is not standard-rated, the POS overcharges the customer from day
one and no tenant configuration can stop it.**

**And the question is not in the practitioner brief.** §A3.5 asks about invoice *field lists*, not
about which supplies are standard-rated, zero-rated or exempt. **That question must be added before
the brief is sent.** It is a few lines of drafting and it is the difference between a brief that
answers the overcharging risk and one that does not.

### 3.1.4 GATE FINDING G-3 — confirming Q4 opens the fee gate with Q18 still unanswered

`open-questions.md` Q18 asserts that "the CoA template ships the fee account's tax code **unset**
and the accrual refuses to post until it is set." **That is not what the code does.** There is no
chart of accounts and there is no tax-code field. `CreditPolicy`
(`apps/api/src/credit-policy.ts:23–40`) has fields for D-1..D-3, grace and ageing, and **no field
for the fee's tax code (Q18) and none for which account it posts to**. `confirm(tenantId, by,
note)` stamps `confirmedBy`/`confirmedAt`/`confirmationNote` and nothing else, and the gate
condition is simply `policy.confirmedAt === null`.

So an Accounts user who confirms the fee *structure* opens fee posting **while its tax treatment
has nowhere to live and has not been asked**. Harmless today, because there is no GL and no tax
line on a fee entry — and precisely wrong-shaped for Phase 3, which is when it stops being
harmless. Cheap to fix now: add `feeTaxCode` and `feeAccountRef` to `CreditPolicy` and require all
of them at the gate.

**Related:** the policy store is **in-memory** (`credit-policy.ts:60–78`), so a confirmation cannot
be durably recorded and resets to unconfirmed on restart. That fails in the safe direction, but it
means "an accountant confirmed this" is not yet a persistable fact — and `app.credit_policy` does
not exist. This is already Phase 1 §6 item 5; the gate re-states it because a human confirmation
you cannot store is a human confirmation you will have to ask for twice.

### 3.1.5 GATE FINDING G-4 — two documents over-claim to the one professional we cannot afford to lose

- `docs/architecture/sections/07-jurisdiction-and-compliance.md:878–880` states that required
  invoice fields are "in the **applied** `document_field_requirement` table and therefore on the
  tablet." **No such table exists.** The migrations contain six `platform.*` tables —
  `jurisdiction`, `tenant`, `tenant_database`, `tax_code`, `tax_rate`, `permission` — and no
  `pack_*` tables at all.
- `docs/q8-evat-practitioner-brief.md:62–72` then tells the practitioner: *"Our system has columns
  waiting for exactly this: … `pack_document_field.source`."* **It does not.**

**Correct both before the brief is sent.** A practitioner who marks up a field list on the
understanding that it loads into a table, and later discovers it does not, is the one relationship
this project cannot afford to spend credibility on — and Q8 is already the longest pole in the
build.

### 3.1.6 GATE FINDING G-5 — a configuration surface that accepts the accountant's answer and ignores it

Found by `qa-engineer` in the money audit, and it is the sharpest instance of the pattern this whole
section hunts — sharper than G-1, because G-1 merely fails to ask a human, while this one **asks,
records the answer, and then does something else**.

`apps/api/src/credit-policy.ts:25,27,31` declares `feeBasis`, `feeCompounds` and `feeDayCount`.
All three are declared, all three are defaulted, and **all three are read by no code**.
`computeFeeAccruals` reads only `feeGraceDays`.

**So if the Q4 accountant confirms `actual_365` at the §2.8 gate, the system records `actual_365`
and silently accrues 30E/360 anyway.** The fee figure would be wrong, the configuration screen would
show the right answer, and the accountant's own confirmation would be the evidence that it was right.

This is the failure mode in its purest form: not "we guessed because nobody told us", but **"we were
told, we wrote it down, and the code never looked."** A silent default at least leaves the user
uninformed; this leaves them actively misinformed by their own confirmed setting.

Not testable today, because `confirm()` cannot set those fields (G-3). **Fix G-3 and G-5 together —
they are the same defect seen from two ends: the confirmation object does not carry everything the
gate needs, and the accrual does not read everything the confirmation object carries.**

### 3.1.7 Two smaller (c) items, recorded for completeness

- **Q13.** `apps/api/src/routers/provisioning.ts:66` writes the literal
  `'secret://clusters/eu-west-1-shared/dsn'` for every tenant. No residency attribute is recorded
  anywhere and **nothing marks the placement as unconfirmed** — so the one question that could
  invalidate `ADR-0003` outright leaves no trace in the data it governs.
- **Q14.** `app.credit_entry_window_days(p_tenant)` is `language sql stable as $$ select 400 $$`
  (`0013_credit_offline_visibility.sql:313–314`) — documented as a "tenant knob" that **no tenant
  can turn**, governing how many days of a customer's ledger a tablet retains. Small, and exactly
  the shape §2.9 warns about.

**Everything else came back clean, and the checks were real.** No jurisdiction branch anywhere: a
repo-wide search for `country ===`, `jurisdiction ===`, `=== 'GH'` and `countryCode` returns three
hits, all comments or tests *asserting the absence*. No hard-coded tax rate in production source —
every rate literal is a test fixture or the seed data file; `platform.tax_rate` has a `daterange`
with an anti-overlap constraint trigger and `apps/api/src/tax.ts` resolves by
`effective @> business_date` with `current_date` appearing nowhere. No defaulted retention window.
No float touching money.

### 3.2 Item by item

Status key: `OPEN` · `DECIDED` · `NEEDS-HUMAN`. **Moved** means something changed since the item
was last written, not that it is closed.

| # | Status | Blocks | Moved at this gate? | Assessment |
|---|---|---|---|---|
| **Q1** fleet contradiction | `DECIDED` (eng) / `NEEDS-HUMAN` (financial) | Phase 2 planning | **YES — engineering half delivered *and independently re-verified from a destroyed volume*** | The ratio is real, reconciled three ways, per outlet and per region over `location_closure`, business-date keyed, on a screen behind `report.view.margin`. §1.7. **The financial half is untouched and is not mine to touch**: the 5.0% → 2.5% target was never restated after the fleet was removed, and the GH₵300,000 FY1 capex line was never split. **New at this gate:** the figure is an *agreed-freight, no-GL* number and the target is an *owned-fleet accounting* number — so a founder placing them side by side today is not comparing like with like. The software says so on the response; nobody has yet said it to the founder. **Escalated.** |
| **Q2** DSO vs the 15-day assumption | `OPEN` | Phase 1 credit (soft) | **YES — for the worse** | **DSO is measured nowhere.** Not by a report, not by a route. Per-account `exposure` and `ageing` exist and are correct; there is **no network-wide receivables rollup**. `docs/credit-client-plan.md` §4 G5 scoped a receivables read as a Phase 1 **SHOULD** and it has now carried unfixed through the whole of Phase 2. A correct method is already designed (`06-customer-credit.md` §6.9 countback, which works out that the naive `AR ÷ average revenue × days` misstates by up to 71% on a growth ramp) and **it does not need the GL**. This is the reporting requirement most directly tied to the plan's single most important funding milestone — the FY3 cash trough — and it is the one nobody built. **Escalated to a named Phase 2 carry-forward.** |
| **Q3** plan contradicts itself | `DECIDED` | nothing | no | Financial model is canonical. No action. |
| **Q4** facility fee 2–3%/month | `NEEDS-HUMAN` | Phase 1 credit go-live | no | Unchanged and correctly gated (§3.1). **The blocking fact is that no accountant exists to ask.** Twenty-two days past the pilot's stated launch date, this is no longer a scheduling item. |
| **Q5** VAT is in scope in practice | `DECIDED` | Phase 1 POS | **YES — materially** | `ADR-0002`'s core claim is now **demonstrated live and mutation-tested**: a historical transaction reprices against the rate row in force on its transaction date, with the levy composition inverted from the pack rather than divided by a constant. That is the strongest evidence on the project that §2.5 holds. **What has not moved, and is now a gate finding:** nobody has confirmed the tenant's registration status, the rate set, the base composition or which supplies are standard-rated — and **the gate that was supposed to hold the line is unenforced** (**G-1**, §3.1.2) while the catalogue asserts standard-rating for all 219 SKUs in a way no configuration could override (**G-2**, §3.1.3). The mechanism is proven; the data in it is a software team's reading of a website, and nothing says so. |
| **Q6** Phase 3 reviewing accountant not named | `NEEDS-HUMAN` | Phase 3 **go-live** | **RAISED HERE, AS THE ITEM ITSELF INSTRUCTS** | The item says in its own words: "`product-manager` raises this at the Phase 2 gate **at the latest**." I am discharging that now. See §4 and §6 — and note that I am proposing the item's *blocks* field be widened from "Phase 3 go-live" to "Phase 3 **design**", because that is what the item's own body argues for and what its `blocks` field understates. |
| **Q7** fractional quantities & dual units | `OPEN` | Phase 0 data model | **YES — partly answered, and newly load-bearing** | Sub-problems 1 and 3 are **answered and built**: scaled integers with documented scale, exact rational conversion factors, one machinery for buying and selling verified equal on both sides of the wire. Sub-problem 2 — dual units of sale — is built as a *model* and is **unusable**: converting `product_uom` rows ship `can_buy = false`, only a dev script flips them, and no route authors one (§1.2). **The founder input this item asks for — how goods are actually sold at the counter, and the kg-per-12m-length factor per rebar diameter — is now blocking Phase 2 operability, not just the Phase 0 data model.** `blocks` field should be updated. |
| **Q8** Ghana e-VAT is a clearance regime | `NEEDS-HUMAN` | Phase 1 POS **design** | no — and this is the sharpest edge of the overrun | The practitioner brief was compiled 21 Aug 2026 and is **waiting for a practitioner who has not been engaged**. It asks the founder to write the real intended first-trading date into it and **that line is still blank**. See §4 and §6. |
| **Q9** trip-load capacity has no home | `OPEN` | catalogue template authoring | **YES — Phase 2 built the place the answer would live** | `ADR-0001` deleted the entity that would carry a truck capacity; Phase 2 has now built `app.supplier` + `app.supplier_capability` with a platform `HAULAGE` kind, which is exactly the "number on a supplier's rate card" the item proposes as the non-fleet home for it. The founder's decision is now cheap to implement and still unmade. Blocks the class-A conversion for SKUs 11–14, so the catalogue template still cannot ship complete. |
| **Q10** cement shelf life vs no lot tracking | `OPEN` | Phase 1 inventory design | **YES — for the worse** | Unanswered, and **Phase 2 made it more expensive**. Goods receipts now append `stock_movement` rows with no lot, batch or expiry. The item's own warning — "adding `lot_id` to a live movement ledger means every historical row has an unknown lot" — is accruing rows in the pilot's own dev data and would accrue real ones from day one of trading. Ten cement SKUs are the traffic-builders and OPC has a ~3-month working shelf life in Ghanaian humidity. **This item is deteriorating with time and should be decided before Phase 3, not during it.** |
| **Q11** "secured against contractor deposits" | `OPEN` | Phase 1 credit | no | Unchanged. `security_deposit_minor` is still a column with a number in it and no held-funds ledger, no GL liability account, no claim procedure. Directly relevant to Phase 3, since the liability account is a Phase 3 artefact — this should be on the accountant's list the day one is named. |
| **Q12** pilot and outlet opening are the same day | `NEEDS-HUMAN` | Phase 1 pilot readability | **OVERTAKEN BY EVENTS — must be rewritten** | The item recommends a 2–4 week dry run **before 1 August 2026**. That date is 22 days past. The item as written can no longer be actioned and its recommendation is now free rather than costly: there is no longer a date to protect. Rewritten at §6. |
| **Q13** Ghana data residency never asked | `NEEDS-HUMAN` | Phase 1 go-live | no — and it gets cheaper to resolve and more expensive to be wrong about, every day | "The single input that could invalidate `ADR-0003`'s hosting decision outright, and it costs one conversation to resolve." It has cost zero conversations so far. Unlike Q8 this needs no GRA process — one Ghanaian counsel, one call. **It is the cheapest unresolved item on the list and it has the largest blast radius if the answer is unwelcome. Ask it before Phase 3 build**, because a residency answer that lands against `ADR-0003` after a GL exists moves a whole company's books rather than a config value. §3.1.6 records that nothing in the data even marks the placement as unconfirmed. |
| **Q14** suspension / offboarding / deletion windows | `NEEDS-HUMAN` | first paying tenant (not pilot) | no | Unchanged, and correctly not blocking the pilot. Note a confusion to avoid: `credit.setStatus` (suspending a *customer's credit account*) landed this month and is **not** this item, which is about suspending a *tenant*. `platform.tenant.status` carries `suspended`/`offboarding`/`offboarded`/`abandoned` and **nothing in `apps/api/src` reads it**, so there is no 7/14/30-day behaviour, silent or otherwise — the honest state. One exception at §3.1.6 (the 400-day device retention window). |
| **Q15** is the model's revenue VAT-inclusive or exclusive? | `NEEDS-HUMAN` | first budget-vs-actual report | **YES — sharpened** | Tax-inclusive price lists now work, and `ADR-0002` makes ledger revenue unambiguously net of tax. So the question is no longer theoretical: if the model's GH₵2,640,000 is gross, actual revenue lands materially below target from month one and the gross-margin **denominator** differs. The item states the FY1 difference as **>GH₵300,000** against a curve tracked to three decimals. **`grossMarginPctE4` is computed and correct against ERP data and cannot yet be validly placed beside 19.325%.** Ask alongside Q17. |
| **Q16** costing method | `NEEDS-HUMAN` | Phase 1 POS (COGS from the first sale) | no | Unchanged and now directly in Phase 3's path. It also has a live Phase 2 face I had not seen stated: `reports.inventoryDays` uses **period-end** stock rather than average stock, and the router's own comment says a defensible average needs a costing engine that belongs with the GL. So the inventory-days figure carries a stated simplification *on top of* an unresolved method. |
| **Q17** do staff-cost baselines include employer social security? | `OPEN` | `staff_cost` variance reporting | no | Phase 3, confirmed: no payroll or staff module exists anywhere in `apps/` or `packages/`. Worth noting the inputs are missing too, not just the report — `packages/db/src/seed/outlets.ts:23–63` parses only `outletId`, `name`, `region`, `tier`, `fyOpened` from `outlets.csv`; the staff-cost, rent and capex columns are never parsed or seeded. |
| **Q18** is the facility fee a taxable supply? | `NEEDS-HUMAN` | Phase 1 credit go-live | **YES — the item's own description of the code is wrong** | This item claims "the CoA template ships the fee account's tax code **unset** and the accrual refuses to post until it is set." **There is no CoA and no tax-code field** — see **G-3**, §3.1.4. Confirming Q4 would open fee posting with Q18 unasked. Harmless today, wrong-shaped for Phase 3. **The item text must be corrected**, because an open question that misdescribes its own safeguard is worse than one that admits it has none. |
| **Q19** who may exclude a dark device from a period close? | `OPEN` | Phase 3 period close; policy agreed in Phase 1 | no | **This is a Phase 3 *design* input and it is unanswered.** A period cannot be locked while any location may hold unsynced documents dated on or before period end, and a server cannot distinguish "nothing pending" from "400 sales in the outbox" — a dead tablet is silent either way. The engineering answer (device attestation; an unattested device blocks the close and is named) is settled. The human half — who may say "close without it", at what age, and what the close record must state — is not, and it writes off money. **Must be answered before Phase 3 builds period close.** |
| **Q20** opening balances | `OPEN` | Phase 1 go-live | **YES — for the worse, and this is the one I most want read** | Still no opening-balance mechanism at all: no `source_kind`, no posting rule, no equity plug, no gate that the opening trial balance ties to the subledgers per location. It is **the first thing that posts**, so it is Phase 1 work that has been carried into a Phase 2 gate. **And the passage of the launch date has changed its shape**: the cut-off date is no longer a clean 1 August 2026. See Q21 below, which I am opening because of it. |

### 3.3 One new item, opened at this gate

**Q21 — Has tenant #1 traded since 1 August 2026 without the ERP?** · `NEEDS-HUMAN`
**Blocks:** Q20's cut-off date, the rollout plan, and any claim about pilot success criteria ·
**Owner:** founder

`CLAUDE.md` states the Techiman flagship opens 1 August 2026. Today is 23 August 2026 and no phase
is signed off. **Nobody in this repository has asked whether the outlet opened anyway.** The two
answers lead to materially different projects and neither has been planned for:

- **If it did not open** — the launch date simply moves, Q12's dry-run recommendation becomes free
  rather than costly, and Q20's cut-off is whatever the new date is.
- **If it opened and has been trading on paper or on another system** — then there is now a period
  of real trading with no system of record; Q20's opening balances are no longer an opening
  snapshot but a **reconstruction** from manual records with a moving cut-off; every "14-day
  success clock" in the rollout plan is measuring something that already started; and the
  statutory-invoice question in Q8 is not prospective, it is **retrospective**.

This costs one question to the founder and it changes the shape of Phase 3's first deliverable.
**It is the first thing I would ask.**

### 3.4 Reconciliation against the financial model

Every reporting requirement should trace to a number the founder is tracking. Here is the honest
state of that trace. (Analysis by `business-data-analyst`; figures cite
`docs/source-of-truth/financial-model-targets.md`.)

| Model figure | Producible today? | Computed & reconciled, or just implemented? | Comparable to the target? |
|---|---|---|---|
| **Distribution cost % of revenue, 5.0% → 2.5%**, per outlet and region | **Yes** | **Computed and reconciled three independent ways** (D12) | **No** — agreed freight vs. an owned-fleet accounting cost, and the target was never restated (Q1) |
| **Inventory days, 45 → 28** | **Yes** — `reports.inventoryDays` | Implemented; fails closed with `INCOMPLETE_COST_BASIS` rather than reporting a partial | **Not yet** — Q16 (costing method) unresolved, plus a stated period-end-vs-average-stock simplification |
| **Gross margin, 19.325% → 24.500%** | **Yes** — `grossMarginPctE4` on the same route | Implemented, same fail-closed behaviour | **No** — Q15. If the model's revenue is gross, the FY1 difference is **>GH₵300,000** against a curve tracked to three decimals |
| **DSO vs the 15-day assumption** | **NO** | Not built at all | n/a — **the gap** (Q2) |
| **Revenue per outlet vs the 40%/70%/100% ramp** | **Partly** — raw per-outlet revenue yes; the ramp comparison no | `fyOpened` is parsed from the CSV and **never persisted onto `app.location`**; no steady-state revenue column exists | No |
| **Contractor repeat-purchase rate (>60% by Year 5)** | **No** — nothing computes it; the underlying data exists | — | Low urgency: tracked from Year 2 |
| **Staff cost per tier (216,000 / 108,000 / 43,200)** | **No** | No payroll or staff module exists | Phase 3, correctly |
| **Marketing 2.0%, admin/utilities/insurance 3.0% opex ratios** | **No** | No expense ledger outside inventory/COGS | Phase 3, correctly — genuinely needs the GL |

**Two conclusions from that table, and the second is the one I want acted on.**

**First: the platform is clean on §2.9 and `ADR-0006`.** None of the model's figures appears as a
constant in application code. The Reports screen *refuses* to draw the target curve and says why in
its own source, with a test asserting the absence. That is the correct instinct and it is rare.

**Second: that correctness is precisely why the founder still cannot see whether the plan is
working.** The alternative to hard-coding a target was building a generic targets layer, and the
generic targets layer was not built. `ADR-0006`'s own consequence table promises it — *"Financial-
model targets (margin curve, inventory days) → **Generic targets / budget vs actual feature**"* —
and the architecture document parks it inside §5, the General Ledger, i.e. Phase 3.

**I am pushing back on that placement.** The three operational metrics above are already computed
and reconciled without a ledger. What is missing between them and a budget-vs-actual view is thin:
a per-tenant `target` table keyed by metric and fiscal period, seeded from the tenant's own
template, and a delta on a screen. It does not need the GL. Neither does the DSO countback report,
whose method is already designed.

**These two — a network-wide DSO/receivables report and a generic targets layer — are the pieces I
would pull forward, and §5 records them as such.** They are the difference between an ERP that
records the business and one that answers the question the founder built it to answer.

---

## 4. Human review gates (§2.8)

**These are blocking and no agent may waive them — including me.** Nothing in this section closes
any of them. What this section does is something more useful and more difficult: it separates
precisely what a missing human **blocks** from what they do not, because a gate that blocks
everything is indistinguishable from a gate nobody obeys.

### 4.1 Status of each gate

| Gate | Constitution | Blocks | Status at 2026-08-23 |
|---|---|---|---|
| A qualified accountant reviews the chart of accounts, the double-entry logic and **at least one full month of generated statements** against manual expectations | §2.8 | A tenant's **ledger going live** — and, per Q6's own argument, Phase 3 **content design** | **NOT STARTED. No accountant is named.** Cannot start: it has no subject yet, because no chart of accounts exists |
| A qualified local professional confirms the jurisdiction pack | §2.8, `ADR-0007` | A tenant in that jurisdiction going live | **NOT STARTED. No practitioner engaged.** The brief is written, dated 21 Aug 2026, and has been waiting 2 days with a blank date field in it |
| Bank reconciliation (system cash vs. bank and mobile-money statement) exists as a feature | §2.8 — "**required**" | Nothing yet; it is Phase 3 scope | **NOT BUILT.** Correctly deferred, and named here so it is not forgotten: §2.8 calls it "where undetected errors in a home-grown GL surface first" |
| The accountant confirms VAT registration status and the correct rate set | `ADR-0002`, Q5 | Phase 1 **go-live** | **NOT STARTED — and, per G-1, the software does not currently enforce this gate at all** |
| The accountant/legal confirms the facility fee's structure (Q4) and whether it is a taxable supply (Q18) | Q4, Q18 | Phase 1 credit go-live | **NOT STARTED.** The Q4 half is properly enforced in code; the Q18 half has nowhere to be recorded (G-3) |

**The founder has none of these people.** That is a plain fact stated by the repository owner and I
am not going to dress it up. It is also not a moral failing — engaging a tax practitioner and a
reviewing accountant is exactly the kind of task that slips while software is visibly progressing.
What follows is an attempt to make the cost of the slip legible.

### 4.2 The consequential judgement: can Phase 3 **build** begin with the **go-live** gate held open?

I want the reasoning visible rather than the conclusion, because reasonable people will land
differently and the next reader should be able to check my working.

**The argument that it can.** §2.8's wording is precise: "**Before a tenant's ledger goes live**,
a qualified accountant reviews…". It gates an *event* — the moment the GL becomes a real company's
books — not the existence of code. And this is not a lawyer's reading, because most of Phase 3's
genuine difficulty lives in invariants no accountant will change: debits equal credits; balancing
enforced per entry *and* per location; immutability with reversal rather than edit; `tenant_id` on
every journal line; RLS; statements derived from lines rather than from a parallel summary table.
A reviewing accountant **confirms** those. They do not **choose** them. Building them now and
gating activation is exactly the split this codebase already runs on the facility fee — mechanism
built, parameters configurable, **posting refused** until a named human confirms.

**The argument that it cannot, which is stronger than it first appears.** The §2.8 gate is about
**content**, and a chart of accounts is content that **fossilises on the first posting**. The
architecture document says so in its own words
(`docs/architecture/sections/05-general-ledger.md:1441–1444`):

> "Q6 should be closed before Phase 3 **design** begins, not before Phase 3 ships. A chart of
> accounts reviewed at design time costs a conversation; one reviewed after a month of live posting
> costs a **restatement**."

Q6 in `open-questions.md` says the same thing, and the brief this project came from is emphatic
about it. So "we'll find a reviewer before we flip the switch" does **not** satisfy the constraint.

**My resolution.** Both arguments are right about different things, and the split falls exactly on
the mechanism/content line. **Phase 3 build may begin, in a bounded form, and the bound is not a
date or a phase — it is a commit.**

**Safe to build with no accountant named** (an unreviewed decision here costs nothing, because
there is no decision):

- the journal schema — accounts, journal entries, journal lines — with **balance enforced by a
  database-level constraint trigger**, append-only triggers, and tenant RLS;
- the posting-rule **engine** (document + mapping → balanced lines), unit-tested against accounts
  the *test* invents;
- trial balance, P&L and balance-sheet **derivation** from lines, with the report-line key left as
  an unmapped column;
- **payroll capture, export and re-import machinery** with the bureau columns nullable and
  DEFAULT-less (§4.4);
- **bank and mobile-money reconciliation** import and matching, which never edits the ledger — and
  which §2.8 requires in its own right;
- period-close mechanics and device attestation — Q19's *engineering* half.

**Not safe to build** (each bakes in an unreviewed accounting decision that is expensive to undo):

| Activity | The decision being fossilised | Blocked on |
|---|---|---|
| Authoring a chart-of-accounts module in the template — account codes, names, types, report-line keys | The tenant's actual books | **Q6** |
| Binding any posting rule to a **named account** | Revenue vs. contra; shrinkage above or below gross profit; output-tax liability treatment | **Q6** |
| Selecting a costing method for GL COGS | Moving weighted average vs. period weighted average with a close-time true-up. Changing this after postings is a **restatement**, not a migration | **Q16** |
| The fee's GL treatment — which account, inside or outside revenue, and its tax code | Revenue recognition, and whether the fee is a taxable supply | **Q4 / Q18** |
| Any opening-balance loader, opening `source_kind`, or equity plug | Cut-off date, who prepares, who signs. **This is the first thing that posts** | **Q20 / Q21** |

### 4.3 The commit-point — the sentence this gate exists to produce

> **Phase 3 build may proceed up to and including X:** the GL **mechanism** — the journal and
> account schema with database-enforced balancing and immutability, the posting-rule engine,
> statement derivation, payroll capture/export/re-import, and bank reconciliation — all exercised
> against accounts and mappings **invented by tests**, with **zero seeded accounts and zero bound
> rules**.
>
> **It may not proceed past Y** — the first commit that writes accounting **content**. Concretely,
> any of: **(a)** a chart-of-accounts module in `packages/db/src/seed/template.ts`; **(b)** any row
> binding a posting rule to a named account; **(c)** any code that selects a costing method rather
> than reading it from a tenant policy column; **(d)** any opening-balance path; **(e)** any
> assignment of the facility fee to an account or a tax code; **(f)** any tenant with a GL reaching
> `platform.tenant.status = 'active'` —
>
> **…without a named, qualified accountant recorded in the sign-off artefact specified at
> `docs/architecture/sections/05-general-ledger.md:1436–1439`: name, professional body and
> registration number, date, and the commit hash of the chart of accounts, mapping and posting
> rules as reviewed.**

**A useful property of that boundary: the safe side is currently pristine.** There is no journal,
account or chart-of-accounts table in any of the fourteen migrations. Phase 3 starts from the
cleanest possible position on this constraint, and the only way to lose it is to author content
before the reviewer exists. That is worth protecting deliberately rather than by luck.

#### REVISED after §2 — two preconditions the commit-point did not previously carry

When I drafted §4.3 I had only the status documents. §2's evidence adds two findings that bear
directly on whether even the bounded Track A holds, and I am revising rather than leaving a stale
boundary next to contradicting evidence.

**Precondition 1 — the sale path must be authorised before the ledger posts from it (§1.9c).**
Phase 3's GL derives its revenue, COGS and output-tax postings from `app.sale`. Today a counter-staff
device can write a sale with `total_minor = 0` and the server will accept it. A double-entry ledger
built on that path would be **perfectly balanced and faithfully wrong** — every entry reconciling,
every statement tying, and the underlying trade fabricable by anyone holding a till. The GL's whole
value is that it is the system of record; a system of record over an unauthorised money path records
fiction with great precision. Worse, once postings exist they are immutable-with-reversal by design,
so discovering this after Phase 3 means a **restatement**, not a fix.

> **`lineDiscountMinor` must be authorised — gated on `sale.discount.apply` and bounded by its
> existing `max_bps`, with a negative test and a live probe — before any GL posting rule reads
> `app.sale`.** This is small work: the RBAC primitives exist and are correct
> (`rbac.test.ts:370–377`); nothing calls them from the sale path.

**Precondition 2 — the review queue must have a reader before period close is designed (§2.4).**
Q19's period close depends on knowing that no unresolved conflict is outstanding for the period. That
question is unanswerable against a table nothing can read, and a close that ignored open reviews
would silently lock a period over unreconciled differences — which is exactly the class of error
§2.8 says bank reconciliation exists to surface. Building close mechanics on a write-only queue means
building the mechanism twice.

> **`conflict_review` needs a router, a screen and a resolve path before Phase 3 designs period
> close.** It does not need to be finished first; it needs to exist, because the close's contract
> with it is the design question.

**Restated commit-point, superseding the box above where they differ:**

> **Phase 3 build may proceed up to and including X** — the GL mechanism as described above, against
> test-invented accounts, with zero seeded accounts and zero bound rules — **and only once (i) the
> sale path's discount field is authorised, and (ii) `conflict_review` has a read and resolve
> surface.**
>
> **It may not proceed past Y** — the first commit writing accounting **content**, per (a)–(f) above
> — **without a named, qualified accountant recorded in the sign-off artefact at
> `docs/architecture/sections/05-general-ledger.md:1436–1439`.**

Neither precondition is large. Both are cheaper now than after a ledger exists, which is the same
argument Q6 makes about the chart of accounts and the same argument `ADR-0006` makes about
generalising before there is production data. **This project's recurring lesson is that the window
to fix a foundation closes when something is built on it.**

### 4.4 The payroll boundary, forward-looking (§2.4)

Phase 3 contains payroll **capture**. §2.4 is categorical and I am attaching the boundary to this
gate so the Phase 3 PRD inherits it rather than rediscovering it.

**A Phase 3 payroll spec must NOT contain:** PAYE or income-tax brackets, bands, thresholds,
reliefs or allowances in *any* form — constant, config file, database table, JSON, spreadsheet
import, feature flag or environment variable; social-security rates, employee or employer,
including tier splits, ceilings and floors; **any effective-dated withholding table**; any
expression deriving a bureau figure from a rate, a percentage, a bracket, another column, a prior
period, an average, a "sensible default" or a zero; any **estimate, preview, provisional or
what-if net pay or deduction**; a blank column labelled "PAYE" on the exported register; payroll
withholding logic in any jurisdiction pack; net pay as a computed column, generated column, view
or column DEFAULT.

**It MAY contain** — so the rule is not misread as "no payroll": hours, days, shifts, roles and
location assignment; base pay; overtime at a **tenant-set** multiplier; commission derived from the
tenant's own sales at a **tenant-set** rate; allowances from a **tenant-set** schedule; gross pay
as the sum of those; and — because §2.4 says recording is not calculating — **the employer
social-security expense account, liability account and posting line**, carrying the figure the
bureau returns. Omitting that account would understate staff cost against the model's per-tier
baselines.

**Two things to have ready, because they will be argued.**

1. **Someone will propose putting the PAYE bands in an effective-dated table "like the VAT rates".
   Reject it.** §2.4 anticipates exactly this and settles it: a stale VAT rate is visibly wrong on
   a receipt handed to a customer today and gets noticed within hours; a stale PAYE figure fails
   **silently** until a filing deadline and surfaces as an under-remittance with penalties.
   Configurability does not fix the second problem, because nothing in the system will ever tell
   anyone the table has gone out of date. The rule is categorical, not a rule against hard-coding.
2. **The deliberate asymmetry with the facility fee.** A provisional *fee* preview is permitted
   because the fee is the tenant's own commercial policy. A provisional *PAYE* figure is not,
   because a preview is precisely how a wrong statutory number gets copied onto a filing.

**Acceptance criteria for the re-import — attach these to the Phase 3 PRD.** Bureau figures land in
nullable, DEFAULT-less `bureau_*` columns in integer minor units, each pointing at a
`payroll_bureau_import` row recording who imported, when, source filename, content hash and the
bureau's reference. A `BEFORE UPDATE` trigger rejects any change to a `bureau_*` column outside an
import transaction — the same shape as the existing `customer_account_terms_projection_only`
trigger, and proven the same way, by attempting the UPDATE directly in SQL and being refused. A CI
lint beside `tools/lint-money.mjs` rejects any write to a `bureau_*` column outside the import
module and any assignment from an expression involving a rate, percentage or bracket —
**mutation-tested**, so that inserting `bureau_employee_tax_minor = gross_pay_minor * 15 / 100`
turns the build red. The exported register carries **no deduction columns at all**, asserted by a
test on the exact header set. Re-import **validates and rejects; it never fills in** — it checks
the identity `gross + adjustments − deductions = bureau_net_pay` per employee and ties the totals,
and rejects the whole file naming failing rows rather than part-importing. *The system may verify
an identity; it may never solve for an unknown.* Net pay is the bureau's column, never computed;
with it NULL the period cannot post and the UI reads "not yet returned by the bureau" — not a zero,
and not gross. A period cannot reach `posted` while any bureau figure is NULL: a CHECK constraint
plus `HTTP 412 PAYROLL_BUREAU_FIGURES_MISSING` writing zero journal lines — deliberately the same
idiom as `FEE_POLICY_UNCONFIRMED`. The payroll permission catalogue stays at exactly export and
import, with a test asserting it; no compute permission is ever added, and **its absence is the
enforcement**. Every payroll read path gets a §2.7(3) test. And a tree sweep — the same shape as
the `ADR-0001` fleet sweep that worked so well at §1.6 — asserts the prohibited vocabulary appears
nowhere in production source, every hit being prose, a comment, or a test asserting absence.

### 4.5 Q8, and the two clocks

**What is built, and it is the right posture.** Full per-line computation of VAT + NHIL + GETFund
from effective-dated pack rows in **both** directions — forward from a net, and inverted out of a
tax-inclusive shelf price — with each component pinned to the exact rate row used, on an
append-only tax-line table. Plus device-side receipt numbering, with a mid-block wipe detected and
reviewed.

**What is deliberately not built, and is guarded by a test:** any issuance, clearance, SDC, QR,
signature or fiscal-invoice-number surface. A regression test fails if that vocabulary appears. The
receipt screen says **"Sale recorded"**, not "Tax Invoice". **Nothing in the product claims to be a
VAT invoice.** That is exactly right and it should be held deliberately rather than by inertia.

**The sharp edge.** If sub-question A3.4 comes back "the GRA originates the invoice number", then
the pre-allocated receipt-number block mechanism — built, tested against a real stack, proven
through a device wipe, and one of the better pieces of engineering on this project — is **worthless
for tax invoices**, and the proforma-then-invoice-on-reconnect branch is forced regardless of every
other answer. That is a real risk of rework and it is the reason Q8 was always described as
blocking POS *design*, not just go-live.

**The framing the founder needs: there are two clocks, and they must not be discussed as one item.**

- **Short clock — G2a/G2b/G2c.** Registration status, the correct rate set, base composition,
  rounding level, the required field list. **One practitioner, a few hours, from their own
  knowledge.** Entirely within reach, and it is what unblocks G-1 and G-2 above.
- **Long clock — G2d.** The clearance regime: CIS onboarding, JUAT, the permitted offline window,
  whether the GRA originates the number, whether releases need Commissioner-General pre-approval.
  **Weeks-to-months, through the GRA, and not on our calendar.**

If these are treated as one engagement, the short clock will be held hostage to the long one and
the rate set will still be unconfirmed when it is needed. **Ask for the short answers first and in
writing.**

**The most consequential unfilled field in this repository is a blank line.**
`docs/q8-evat-practitioner-brief.md:51` still reads:

> *"Founder: before sending this, write the real intended first-trading date here → `____________`"*

The practitioner cannot triage without it, and 1 August 2026 — the date the brief was written
against — is now in the past.

**One thing I will not do.** I am not going to state whether there is a lawful interim posture for
trading. That *is* the question in the brief, and answering it here would be precisely the
substitution of an agent for a professional that §2.8 exists to prevent. What I can record as fact
is that the system currently issues no document claiming statutory status, so it makes no false
claim today; that the proforma-then-invoice-on-reconnect posture is the brief's own Branch 2 and is
a candidate rather than a blessed answer; that it costs several weeks of build for the document
model plus a commercial decision on how the later invoice reaches the customer (a channel, a
per-message cost, a consent model, a failure path, and a phone number the counter does not
currently collect); and that **returns have no settling document under either branch, because
there is no credit note in the system at all, and nobody has costed one.**

---

## 5. Deferred scope

**The rule I am applying.** Scope creep in an ERP is how a three-phase build becomes a three-year
build. When something falls outside the current phase the answer is normally "yes, and it goes in
the backlog for phase N" — not "no", and not silent acceptance. Everything below is placed
somewhere, with a reason, and nothing is left as an unowned intention.

### 5.1 Carried forward from Phase 2 — small, and should land before pilot go-live

| # | What | Why it was deferred | Where it goes |
|---|---|---|---|
| D1 | **`inventory.ensureReorderPoints` has no button**, and onboarding seeds no thresholds | Seeding is idempotent and additive; it was run at bootstrap and nobody noticed no screen calls it | **Phase 2 carry-forward.** Without it a 25-location, 219-SKU tenant sets thresholds one at a time. Small work; it makes P2-5's first link real |
| D2 | **A delivery's business date, once written, cannot be corrected** — `updateDeliveryStatusInput` carries none and there is no `logistics.update` | The screen states the consequence at the point of entry rather than letting somebody discover it later, which is the right interim | **Phase 2 carry-forward.** The period key of the Q1 ratio should be correctable by someone with a permission, with the correction recorded |
| D3 | `sales.get` and `sales.recomputeCheck` have no client | The counter reads its own sales from local SQLite, so neither is a hole in the offline story | **Backlog.** Nothing in the product opens a sale the server holds — an audit gap rather than an operational one |

### 5.2 Carried forward from Phase 2 — larger, and genuinely deferred

| # | What | Why | Where it goes |
|---|---|---|---|
| D4 | **Receiving cannot start cold offline.** No procurement table is in any sync bucket; a partitioned device holds no supplier, order or price | The take-down document is the honest interim, and the receipt still records with no order attached — the right failure | **Phase 3**, alongside the sync-rule work in D7. Against §2.2 this is a real partial and it is named as one |
| D5 | **No surface authors a purchase unit, a conversion factor, a supplier price or a lead time** (§1.2) | The template deliberately refuses to guess a physical constant | **Blocked on Q7 and Q9, then Phase 3 catalogue management.** The founder input is the long pole, not the code |
| D6 | **The counter's offline credit allowance has a channel, a gate and a test, and no rows.** `app.credit_allowance` is empty by design until the cap-lease derivation exists | The narrower read is the right design; the derivation is real work | **Phase 1 residue**, and it is why Phase 1 criterion 3 is still unsigned |
| D7 | **CLOSED 2026-11-19 (PR #30):** every parameter query reads the device-keyed projections (0024); verified live by D5/D8 (`docs/go-live-status.md` §5). *Original:* **Sync rules still scope from the token claim** for `location_ops`, `tenant_reference` and `tenant_sale_lines_interim`. Only the two credit buckets are table-driven | Migration `0013` built the projection shape; copying it to the rest is mechanical | **Phase 3.** §2.6 says sync rules *are* the authorization boundary, so this is a partially-retrofitted constraint, not a feature request |
| D8 | **CLOSED 2026-11-19 (PRs #28, #30):** `sync.scope_refresh` runs every 60 s in the production worker. *Original:* **There is no nightly job at all.** `app.refresh_credit_sync_scope_all()` runs only by hand, so a grant whose `effective_to` is a future instant lapses with **no DML to fire a trigger** and leaves a stale row in the sync gate | Nobody owned scheduling | **Phase 3 / `devops-engineer`.** This one is security-adjacent: a stale gate row keeps a credit book on a device after the grant has lapsed |
| D9 | **Conflict class #20 `credit_sale_after_suspension` diverges from the design.** A credit sale from a device that was dark during a suspension is **refused and retried** (delayed, not lost) where `credit-offline-plan` R4.4 rules it should be **accepted and flagged** | The current behaviour is better than discarding and worse than the plan's; the exposure is bounded by a role bound rather than by a per-customer cap | **Phase 3 / `credit-engineer`.** Pinned by D16 E3/E4 so building R4.4 turns them red and forces item and drill to move together |

### 5.3 Pulled *forward*, against the current plan

These two are currently parked in Phase 3 by the architecture document. I am moving them, and §3.4
carries the argument.

| # | What | Currently | Moving to | Why |
|---|---|---|---|---|
| **D10** | **A network-wide DSO / receivables report** (`06-customer-credit.md` §6.9 countback) | scoped a Phase 1 "SHOULD", never built; a GL-flavoured version sits in Phase 3 | **Phase 2 carry-forward** | It needs no ledger — only an aggregation over `credit_entry` and `sale`, which exist. It measures the assumption behind the plan's most important funding milestone (Q2) |
| **D11** | **A generic targets / budget-vs-actual layer** — a per-tenant `target` table keyed by metric and fiscal period, seeded from the tenant's template, with the delta on a screen | promised by `ADR-0006`, parked inside the GL section | **First slice of Phase 3, ahead of the GL** | The metrics it would compare against are already computed and reconciled. Without it the platform's §2.9 cleanliness is exactly why the founder cannot see the plan |

Two small enablers ride with D11: **`fyOpened` is parsed from `outlets.csv` and never persisted
onto `app.location`**, and there is no steady-state-revenue column — so the 40%/70%/100% outlet
ramp cannot be compared even though per-outlet revenue is available.

### 5.4 Phase 1 residue that this gate does not have the standing to defer

These belong to a gate that has not been run. They are listed so that they are not lost between
gates, and §6 treats them as what they are — preconditions, not backlog.

- **Receipt printing has never been proven on hardware.** `ADR-0003` is explicit that
  `pos-ux-specialist` must prove it on representative hardware **during Phase 1, not at pilot**,
  and that failure "is the one finding that would justify revisiting the native-Android option" —
  i.e. an architecture reversal. It is blocked on a printer-hardware decision that has not been
  made. **Twenty-two days after the stated launch date, no receipt has ever been printed.**
- **The real-device trial has not happened.** OPFS persistence, service-worker update, wasm workers,
  touch behaviour and sync under field latency on a low-end Android tablet are exercised by
  nothing. The 60-second budget was met at p95 **212 ms on localhost**; the field number is the one
  that matters and it does not exist.
- **No test drives the PWA in a real browser.** Component coverage in jsdom is now real; Playwright
  against the built PWA belongs with the trial above.
- **Auth is a dev-grade HS256 flow** — shared dev secret, static bearer in the PWA env. The real
  credential flow is unbuilt. This cannot go to a pilot.
- **~600 kB main bundle**, to be code-split before pilot — small, but it lands on the exact devices
  §4 of the constitution names.

### 5.5 Out of scope, and staying that way

Recorded so the boundary is visible at every gate rather than argued at each one:

- **No fleet or vehicle management** — `ADR-0001`. Verified absent from the tree *and* the live
  database at this gate (§1.6).
- **No statutory payroll calculation, in any jurisdiction** — §2.4. Phase 3 contains payroll
  **capture** only, and no jurisdiction pack ever carries withholding logic. A configurable
  withholding table is prohibited too; the rule is categorical.
- **No multi-jurisdiction tenants and no FX in the ledger** — `ADR-0007`.
- **No third-party accounting SaaS.** This platform is the system of record.
- **No bespoke Agyasei features.** Nothing exists because one tenant asked and no other tenant
  could configure it. §3.4 records that this held under real pressure at the Reports screen.

### 5.6 Closed, and not to be raised again

**`.claude/settings.json` — `Bash(git push:*)` moved from `deny` to `allow`. CLOSED.**

`docs/phase2-status.md` §5 flags this as an unrequested change to the agent harness's own
permission configuration. It has since been established that **the change was made by the
repository owner themselves, deliberately, so that pushing would work.** It is the owner's
configuration and the owner's call.

It has now been raised by agents twice. **It is closed. It is not a security finding and it should
not appear in a future gate.** Recorded here explicitly so the next reviewer finds this line
instead of re-opening it a third time.

---

## 6. Verdict

### 6.1 First: the launch date has passed, and it must be formally restated

**The facts, stated plainly because they have not been stated anywhere else in this repository.**

`CLAUDE.md` §1 says tenant #1 launches in Techiman on **1 August 2026**. Today is **23 August
2026**. That date is **22 days gone**, and:

- **no phase of this build is signed off** — Phase 0's own document still reads "DRAFT, awaiting
  explicit human approval. The build stops here" (§1.9);
- **no receipt has ever been printed on a real printer**, and the printer hardware decision has not
  been made — this was a Week 1–3 item "before printers are bought";
- **the Q8 engagement has not begun**, and it was a Week 1 item explicitly marked "it cannot start
  later";
- **no accountant is named**, so the §2.8 ledger gate has no subject;
- **nobody has asked whether the outlet opened anyway** (Q21, opened at this gate).

This is no longer a schedule risk to be managed. **It is a live overrun**, and the character of the
human-gate problem changes with it: a missing accountant twelve weeks before launch is a task on a
plan; a missing accountant three weeks *after* launch is a project without a date.

**The founder must set a new date. That decision is theirs and I will not make it. What is mine is
to put the dependency chain in front of them so the decision is made deliberately rather than by
default** — because the current state is not "1 August slipped", it is "there is no date at all,
and no mechanism producing one."

#### The chain that determines the earliest defensible first-trading date

| | Link | Duration | Whose calendar? | Started? |
|---|---|---|---|---|
| **A** | **Founder decisions.** Fill in the blank date at `q8-evat-practitioner-brief.md:51` · answer **Q21** · name an accountant (**Q6**) · engage a tax practitioner · decide printer hardware · supply conversion factors (**Q7**, **Q9**) · decide lot tracking (**Q10**) · decide deposits (**Q11**) · set the dark-device close policy (**Q19**) · set the opening-balance cut-off and signatory (**Q20**) | **Days** | **Ours** | **No** |
| **B** | **Short-clock professional answers.** Registration status, the rate set, base composition, rounding level, required invoice fields, and — newly — **which supplies are standard-rated** (§3.1.3). Unblocks findings **G-1** and **G-2** | **Days to ~2 weeks** once engaged | Ours to start | **No** |
| **C** | **Long-clock GRA answers (Q8 / gate G2d).** CIS onboarding, JUAT, the permitted offline window, whether the GRA originates the invoice number, whether releases need Commissioner-General pre-approval | **Weeks to months** | **Not ours** | **No** |
| **D** | **Build forced by C, if the clearance branch is confirmed.** A proforma/delivery-note document model, a state machine, print templates, and a delivery channel for the later invoice — plus a credit note, which does not exist under *either* branch and which nobody has costed | **Weeks** | Ours | n/a |
| **E** | **Phase 1 residue that cannot go to a pilot**: the real credential flow (auth is a dev-grade shared secret today), the hardware trial, the real low-end-Android trial, code-splitting | **Weeks**, and the hardware trial cannot start until A decides printers | Ours | **No** |
| **F** | **Phase 3 build → chart-of-accounts content → statements** (see §4.3 for where the hard stop sits) | Weeks | Ours, **after Q6** | Not started |
| **G** | **§2.8's accountant review: "at least one full month of generated statements"** | **≥ 1 calendar month, after F** | Ours + accountant | Cannot start |

#### Link G deserves its own paragraph, because I do not think it has been costed

§2.8 requires that, before a tenant's ledger goes live, a qualified accountant reviews the chart of
accounts, the double-entry logic **and at least one full month of generated statements against
manual expectations**.

**Read that as a scheduling constraint and it contains a circularity nobody has resolved.** If the
"full month of statements" must come from real trading, then the ledger is live before it has been
approved — which is exactly what the gate forbids. So it must come from a **dry run**: a month of
representative activity through the real system, with the GL on, producing real statements against
which manual expectations can be checked.

**That converts Q12's "2–4 week dry-run window" from a recommendation into a hard dependency, and
lengthens it.** A dry run long enough to satisfy §2.8 is **at least one full month with the ledger
running**, not two weeks of counter practice. Nobody has planned for that, and it sits at the very
end of the chain, after Phase 3 and after Q6.

**This is the single most useful thing in this section for the founder:** the binding constraint on
go-live is probably not Phase 3's build time. It is **C** (a queue we do not control) and **G**
(a calendar month that cannot be compressed and cannot start until an accountant exists). Both are
started by decisions that cost days and have not been made.

#### My recommendation to the founder — and it is a recommendation, not a decision

1. **Formally restate the launch date, in writing, in `CLAUDE.md`.** A date that has passed and
   still sits in the constitution is worse than no date, because every document that quotes it —
   including the practitioner brief — inherits the error. If the new date is not yet knowable, say
   **"to be set on receipt of the Q8 short-clock answers"** and record that. An honest placeholder
   beats a false certainty.
2. **This week, spend the days in link A.** Six of those ten items are single decisions or single
   emails. Q6 in particular costs one email and unblocks the entire Phase 3 content track.
3. **Split the Q8 engagement into two clocks (§4.5) and ask for the short one first, in writing.**
   Otherwise the rate set will still be unconfirmed when it is needed.
4. **Reclassify the current period explicitly.** If Techiman is trading (Q21), say so and treat the
   ERP work as a *system-of-record catch-up* with a reconstructed opening balance — a different
   project with a different first deliverable. If it is not trading, say that too, and take the
   dry-run window Q12 asked for, which is now free.

### 6.2 The verdict

### 6.2.1 Phase 2 — **SIGNED OFF on its own scope**, with residue named

**Phase 2's engineering did what Phase 2 was asked to do, and demonstrated it to a standard higher
than any other phase of this project has reached.** Suppliers are writable from the product with
refusals that write no row. A purchase order is raised, amended, and approved by someone other than
the raiser, under a money bound measured against the server's own repriced total and living in
ordinary tenant data. Goods are received in the supplier's unit and stock rises by what was
**counted**, not what was invoiced. A haulier is a supplier and there is no fleet — verified against
the live database, not just the tree. `ADR-0001`'s exchange is honoured: distribution cost as a
percentage of revenue exists, per outlet and per region, reconciled three independent ways.

**That is a real phase and I am signing it.** With this residue, carried and owned:

| | Carried | Where |
|---|---|---|
| Multi-source across purchase units is not operable on the pilot's own catalogue | Blocked on Q7/Q9 (founder), then a catalogue-authoring surface | §1.2, §5.2 D5 |
| Reorder thresholds have no practical origin | `ensureReorderPoints` needs a button | §1.5, §5.1 D1 |
| Offline receiving is a write path, not a yard capability | 0/10 procurement tables in any bucket; the take-down is exercised by no drill | §1.4, §5.2 D4 |
| Tolerance breaches reach a queue nobody can read | §2.2 breach; blocks Phase 3 period close | §1.3, §2.4 |
| The Q1 ratio's guard is unexercised and its denominator is contaminated | Fix the sale path; test `assertAggregateIdentity` | §1.7 |
| One Phase 2 read path has no automated two-tenant test | `procurement.reorderSuggestions` | §1.8, §2.5 |

**What I am explicitly *not* doing by signing this:** I am not certifying that Phase 2 is fit for a
pilot, and I am not closing Phase 1. Phase 2's scope was built and demonstrated. That is the only
question a Phase 2 gate is entitled to answer.

### 6.2.2 Phase 3 — **NOT CLEARED as a whole. Track A conditionally cleared; Track B blocked.**

**Track B — accounting content — is BLOCKED, and no agent can unblock it.** Chart-of-accounts
authoring, any posting rule bound to a named account, costing-method selection, opening balances, the
fee's account and tax code, and any GL-bearing tenant reaching `status = 'active'`. Blocked on **Q6**
(no accountant named), with **Q16**, **Q20**, **Q4/Q18** and **Q21** as inputs that person needs.
This is §2.8 and it is not mine to waive.

**Track A — the policy-neutral GL mechanism — is CLEARED TO START, conditional on two things landing
first**, per the revised commit-point at §4.3:

1. **`lineDiscountMinor` is authorised** — gated on `sale.discount.apply`, bounded by its existing
   `max_bps`, with a negative test and a live probe. A ledger must not be built over a money path
   any till can zero.
2. **`conflict_review` gains a read and resolve surface** — a router, a screen, a resolve path.
   Period close cannot be designed against a queue with no reader.

Neither is large. Both are cheaper now than after a ledger exists.

### 6.2.3 The thing this gate is really telling you

Three separate reviewers, working independently, converged on one pattern this week:

- **G-1**: the tax confirmation gate is written into the schema, described in a comment, cited in an
  open question — and **read by nothing**.
- **G-5**: the fee's day-count basis is declared, defaulted, confirmable — and **read by nothing**.
- **§2.4**: the review queue is written to, escalated, provenance-preserved — and **read by nothing**.
- **§2.3**: `assertAggregateIdentity`, `recomputeCheck`, `assertPackPriceable` — guards that exist,
  are commented, are cited in status documents — and have **never fired**.
- **§2.5**: `catalogue.detail`'s isolation test, which **cannot fail**.
- **§1.9**: `docs/architecture/README.md`, which still says *"the build stops here"* — and **nothing
  stopped**.

**This project's defect class is not bad code. It is unread code that everyone believes is working
because it was written down.** `docs/phase1-status.md` §0 has been recording versions of this for
eighteen rows and calls it *"both sides were only ever tested against a third thing that agreed with
neither."* The mature form of that lesson, which this gate is the first to be able to state, is
narrower and more useful:

> **A control is not a control until something has been shown to depend on it. A gate is not a gate
> until something has been refused by it. Write the negative test, or do not claim the guarantee.**

That is a cheap discipline and it would have caught G-1, G-5, the review queue, all four money
guards and the vacuous isolation test — every one of them, at the time each was written.

### 6.2.4 What is missing, precisely

**Blocking Phase 3 Track A (engineering, small, days):**
1. Authorise `lineDiscountMinor` on `sale.discount.apply` with its `max_bps` bound; negative test and
   live probe.
2. Give `conflict_review` a router, a screen and a resolve path.

**Blocking Phase 3 Track B (human, and only the founder can start these):**
3. **Name the reviewing accountant (Q6).** One email. It unblocks the entire content track and it was
   due before Phase 3 design began.
4. Answer **Q16** (costing method), **Q20** (opening-balance cut-off, preparer, signatory),
   **Q4/Q18** (fee structure and tax treatment) — all for the same person.
5. Answer **Q21** — has Techiman traded since 1 August? It changes Q20's shape.

**Blocking pilot go-live (not Phase 3 build), in rough order of lead time:**
6. **Engage the tax practitioner and split the engagement into two clocks (§4.5).** Ask for the short
   clock in writing first. Fill in the blank date at `q8-evat-practitioner-brief.md:51`, and add the
   standard-rating question (G-2) before sending. Correct the two documents that promise a
   `pack_document_field` table which does not exist (G-4).
7. **Enforce the tax confirmation gate (G-1)** — `createTenant` lands on `'provisioning'`; activation
   requires non-null `confirmed_by` on every in-force rate; refuse with
   `HTTP 412 TAX_RATES_UNCONFIRMED`.
8. **Fix G-3/G-5 together** — `CreditPolicy` carries `feeTaxCode` and `feeAccountRef`, the gate
   requires them, and `computeFeeAccruals` reads what the confirmation records.
9. **Ask Q13** (data residency). One conversation. Largest blast radius of anything unresolved.
10. **Decide printer hardware and run the hardware trial** — Week 1–3 of Phase 1 per the architecture
    document, never done, and `ADR-0003` says a failure here justifies revisiting the whole client
    architecture.
11. **Real low-end Android trial and a Playwright harness** — currently **zero** coverage, no harness
    of any kind.
12. Real credential flow (auth is a dev-grade shared secret), code-splitting.

**Blocking a claim that criterion 5 holds:**
13. Non-vacuous tests for `catalogue.detail`, `reports.stockOnHand`, `reports.inventoryDays`,
    `reports.cashPosition`, and the five untested procedures; RLS forced on the six `platform.*`
    tables and `conformance.test.ts:61` widened past `nspname = 'app'`.

**Blocking nothing, owed to the record:**
14. Correct `.claude/commands/phase-gate.md` ("three mandatory categories (§2.7)") and `ADR-0005`'s
    §2.6 citation. Supersede `docs/phase2-status.md`, now twice found stale. Document the five
    undocumented drills.

### 6.2.5 The one decision I am putting in front of the founder

**Restate the launch date, in writing, in `CLAUDE.md` (§6.1).** It is 22 days past, no phase is
signed off, Phase 0's own document still says the build stops there, and the two tasks that document
marked as unable to wait — the hardware trial and the Q8 engagement — are the two that never started.
Every document quoting 1 August 2026, including the brief we are about to send a professional,
inherits an error.

**The binding constraint on go-live is probably not Phase 3's build time.** It is the GRA queue,
which is not on our calendar, and §2.8's full calendar month of generated statements, which cannot be
compressed and cannot start until an accountant exists. Both are started by decisions that cost days
and have not been made.

That date is the founder's to set. Putting it in front of them is mine, and this is me doing it.

---

## 7. Addendum — the Track A conditions, closed (2026-08-23, same day)

The verdict above is left exactly as signed. This records what happened next, because a gate whose
conditions are quietly satisfied somewhere else is a gate nobody can audit.

### 7.1 Condition 1 — `lineDiscountMinor` is authorised · CLOSED

`sales.createSale` now measures the steepest line discount in basis points of that line's own
extended amount and calls
`ctx.permissions.requireWithinBound('sale.discount.apply', locationId, 'max_bps', bps)` — beside the
credit bound, against the server's own repriced figures, inside the same transaction, so a refusal
rolls back the sale, its stock movements and its credit entry together.

Four decisions worth recording, because each was a choice and not the only option:

- **Per line, never per document.** A full write-off on one line of ten averages to 10% across the
  document and would pass a 3% document-wide cap while giving that line away.
- **Only when a discount was actually taken.** An undiscounted sale requires no discount capability.
  Requiring it on every sale would have taken the counter down rather than secured it, and there is
  an explicit test holding that — `apps/web` sends `lineDiscountMinor: '0'` on every sale today.
- **Measured from the TYPED discount over the extended price**, not from the stored
  `discountMinor` — which `priceInclusive()` has already re-denominated into the net terms the
  ledger stores. The quotient is the fraction the operator negotiated whichever way the price list
  is composed.
- **Rounded UP.** A discount fractionally over the bound is refused rather than truncated under it.

**Evidence.** `apps/api/test/sales-rbac.test.ts`, 43 → 55 tests. Includes the bypass stated as a
test: a credit sale discounted beneath the `sale.record.credit` money bound is refused by the
discount bound, and no row lands — the two controls compose rather than substitute.
**Mutation-tested twice:** disabling the check turns 7 red; changing the rounding from up to down
turns the fractional-boundary test red on its own, which is the only case that separates the two.

### 7.2 Condition 2 — the review queue has a reader · CLOSED

`apps/api/src/routers/review.ts` (`list` · `get` · `claim` · `resolve`), mounted; contracts in
`packages/contracts/src/review.ts`; client in `apps/web/src/data/api/review.ts`; screen at
`apps/web/src/features/review/Review.tsx`, on the nav behind `sync.conflict.review` — which the
template gives to a regional manager and to Accounts, and withholds from the counter and from an
outlet manager.

Three decisions worth recording:

- **Two conditions to see a row, not one.** Holding `sync.conflict.review` gets you into the queue;
  seeing a given row also requires holding **that row's own `required_permission` at one of that
  row's own locations**. That column is migration 0006's routing mechanism and it was previously
  read by nothing. It is plain text with no FK, so an unrecognised code **denies**.
- **`hiddenCount` is rendered, never swallowed.** "Nothing is waiting on you" and "there are items
  nobody at your level may touch" are different sentences, and conflating them is how a queue stops
  being worked — which is the exact defect this closes.
- **Resolving RECORDS a decision; it does not write the value back.** The server returns
  `entityRewritten: false` and the screen says so in as many words. The three live classes have no
  safe generic write-back — a printed receipt number cannot be un-printed, a received quantity has
  already moved stock — and a generic "apply this jsonb to that table" route would be an
  arbitrary-write primitive reachable over HTTP. Per-class write-back arrives with the class that
  needs it, §2.2's credit-limit case first.
- **No offline path, deliberately.** Not in `DEVICE_OP_KINDS`, no sync bucket. Deciding which of two
  divergent facts is true is precisely what a partitioned device could not do — that is why the row
  exists.

**Evidence.** `apps/api/test/review.test.ts` (17) and `apps/web/tests/review-ui.test.tsx` (9). Every
review in the API tests is opened by the **real writer** — a device that loses its local database and
re-reports, conflict class #14 — so what is under test is the whole loop, not an inserted fixture.
**Mutation-tested:** removing the claim conflict and the resolve-twice refusal turns 4 red; hiding
`hiddenCount` and the no-write-back caveat turns 2 of the screen tests red.

### 7.3 Item 6's document work · DONE, except the date

`q8-evat-practitioner-brief.md`: **G-4 corrected** (the `pack_document_field` promise removed);
**G-2 added** as A3.10, the standard-rating question, which also states plainly that our per-item
tax code is not currently consulted so marking an item zero-rated would change nothing today; and
the enforcement claim corrected — an earlier draft told the practitioner the software refuses to go
live until their name is on the row, **which is true of the fee path and false of the tax path**
(G-1). The brief now says so rather than letting a professional assume a control that is not there.

**The blank date is still blank.** It is the founder's to fill, and §6.1 stands.

Outreach drafts for both people are at `docs/outreach-drafts.md`. Neither has been sent.

### 7.4 What this addendum does NOT change

**G-1 is still open.** The tax confirmation gate is not enforced; 7 of 7 Ghana rate rows still carry
`confirmed_by = NULL` and `tax.ts` still does not read the column. Item 7 of §6.2.4 stands exactly
as written, and it is a **pilot go-live** blocker, not a Track A one.

**Track B is still blocked on Q6.** Nothing here touches it, and nothing here may be read as
touching it.

**Full suite after these changes:** 1,592 tests / 106 files, 0 failures (from 1,554 / 104). Money
lint clean. All twelve live drills re-run against an API restarted onto this code: sync-drills 8/8,
D6 16/16, D8 30/30, D9 13/13, D10 30/30, D11 56/56, D12 32/32, D13 47/47, D15 33/33, D16 37/37,
D17 32/32, credit-client 19/19.

---

> **FOUNDER SIGN-OFF RECORDED 2026-08-25** — Frederick Ofori-Boadu signed Phase 2 on this
> document's evidence. See `docs/phase2-signoff.md`, which also records what the signature does
> NOT cover: the §2.8 accountant gate, Phase 0 and Phase 1, and this document's §5 residue.
>
> The founder also restated the launch date to **1 January 2027** and answered **Q21: the outlet
> has not traded.** §6.1 of this document asked for exactly those two things; both are now
> settled, and the opening-balance problem it warned about is a clean cut-over rather than a
> reconstruction.

**Signed:** `product-manager`, 2026-08-23.
**Phase 2: signed off on scope.** **Phase 3 Track A: cleared subject to items 1–2.**
**Phase 3 Track B: blocked on Q6.** **Pilot go-live: blocked, and no agent may say otherwise.**
