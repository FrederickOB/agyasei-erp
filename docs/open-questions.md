# Open Questions

Contradictions and gaps found while reviewing the brief, the business plan and the financial
model. **These are live.** The `product-manager` agent owns this file and must carry each item
into the phase it blocks. Nothing here is resolved by engineering judgement alone.

Status: `OPEN` · `DECIDED` (an ADR exists) · `NEEDS-HUMAN` (requires a professional, not an agent)

---

## Q1 — The fleet contradiction · `DECIDED` (engineering) / `NEEDS-HUMAN` (financial)
**Blocks:** Phase 2 planning · **Owner:** founder + accountant

The brief says distribution is asset-light — *"no owned vehicle fleet. All inter-outlet and
customer delivery runs through contracted third-party hauliers"*, and attributes this to
*"Section 7.2 of the business plan."*

**Business plan §7.2 says the opposite:** *"The company launches with 2 owned trucks and adds one
additional truck with every RDC opened (6 RDCs by Year 7, including Kumasi), reaching a fleet of
8 trucks by Year 10."*

The financial model sides with the plan, not the brief:
- `Assumptions`: `Initial Fleet + ERP/HQ Systems (FY1, 2 trucks) = GH₵300,000`
- `Assumptions`: `Additional Truck per RDC Opened = GH₵150,000`
- `Outlet Rollout` row 21: *"Capex-only line: 2 trucks + ERP/POS system at HQ launch"*
- Margin **Lever 3** credits the *owned fleet* for distribution cost falling 5.0% → 2.5% of revenue

**Engineering decision:** hauliers only — `ADR-0001`. No vehicle, driver, fuel or maintenance
entities. Phase 2 builds dispatch and tracking.

**What still needs a human:** with no owned fleet, the 5.0% → 2.5% distribution-cost decline has
no mechanism behind it. It must come from negotiated haulier rates and load consolidation instead,
or the margin bridge weakens and FY10 gross margin of 24.5% is optimistic. The GH₵300,000 FY1
capex line also needs splitting — how much was ERP/POS and how much was trucks? Only the ERP
portion survives this decision. **This is an accountant's call, not an engineer's.**

**ENGINEERING'S HALF IS NOW DELIVERED (2026-08-22).** `ADR-0001` promised that in exchange for the
fleet the ERP would *"measure distribution cost as % of revenue per outlet and per region so the
real trajectory is visible."* It does. `reports.distributionCostRatio` answers a real percentage —
numerator `app.delivery.freight_cost_minor`, denominator ex-tax after-discount revenue, both dated
by the same human-asserted business date (migration `0010`), scaled as percent × 10⁴ so `50000` is
5.0% and `25000` is 2.5% exactly — per location, and per grouping node rolled up over
`app.location_closure`. It is on the Reports screen behind `report.view.margin`.

Verified live against the deployed API and real Postgres, reconciled against an independent second
computation: `docs/phase2-status.md` §2b and §4; drill `pnpm --filter @erp/wire-conformance
drill:q1`.

**Two caveats the accountant must carry into the judgement:** the figure is the **agreed** freight,
not the haulier's AP invoice (there is no GL until Phase 3, so it is an operational number); and
where freight was never agreed the row reports `INCOMPLETE_FREIGHT_BASIS` and its sum is a
**floor**, not a total.

**The financial half is unchanged and still `NEEDS-HUMAN`:** the 5.0% → 2.5% target was never
restated after the fleet was removed. What has changed is that there is now a measured trajectory
to compare it against.

---

## Q2 — Receivables days understated · `OPEN`
**Blocks:** Phase 1 credit design (soft) · **Owner:** accountant

The model assumes **15 days** receivables. Contractor terms are **30–60 days**. If contractor
credit scales as the strategy intends, actual DSO lands well above 15 and the FY3 cash trough
of GH₵(1,393,958) deepens — the trough is the plan's single most important funding milestone.

The ERP will measure real DSO from day one. `business-data-analyst` surfaces actual vs. the
15-day assumption in every reporting cycle so this is caught early rather than discovered.

**PHASE 2 GATE (2026-08-23) — this item moved for the worse and is escalated.** *"The ERP will
measure real DSO from day one"* is not true and never has been. **DSO is measured nowhere** — not
by a report, not by a route. Per-account `credit.exposure` and `credit.ageing` exist and are
correct, and there is **no network-wide receivables rollup at all**. `docs/credit-client-plan.md`
§4 G5 scoped a receivables read as a Phase 1 **SHOULD**; it has now carried unfixed through the
whole of Phase 2.

A correct method is already designed — `docs/architecture/sections/06-customer-credit.md` §6.9
works out that the naive `AR ÷ average revenue × days` is dimensionally wrong on a growth ramp
(misstating by up to 71% in its own worked example) and specifies a **countback** instead — and
**it needs no general ledger**, only an aggregation over `credit_entry` and `sale`, both of which
exist today. This is the reporting requirement tied most directly to the FY3 cash trough, which is
the plan's single most important funding milestone, and it is the one nobody built.
**Carried as `docs/phase2-gate.md` §5.3 item D10, pulled forward into Phase 2 carry-forward.**

---

## Q3 — The business plan contradicts itself · `DECIDED`
**Blocks:** nothing · **Owner:** `product-manager`

| Figure | Plan prose | Model (canonical) |
|---|---|---|
| Gross margin FY1 → FY10 | 18.8% → 23.6% (§9) | **19.3% → 24.5%** |
| Net profit turns positive | FY4 (§9.1) | **FY3** (§11.2, §12.1 agree) |
| Cash trough | GH₵(1,501,082) (Exec. Summary) | **GH₵(1,393,958)** (§11.4) |
| Trough year | FY5 (§10 risk table) | **FY3** |
| Bridge facility | ≥1.5M (Exec, §12.1) / ≥1.4M (§11.4) / ~1.3M (§10) | Sized to the FY3 trough |
| Outlet mix | 1 / 5 / 14 = 20 (§3.1) | **1 / 6 / 18 = 25** (§6.1 + `Outlet Rollout`) |
| Flagship break-even revenue | GH₵2,880,000 vs "FY1 revenue GH₵2,400,000" (§9.1) | FY1 revenue is **2,640,000** |

**Resolution:** the financial model is canonical (`CLAUDE.md` §2.8). §3.1's 20-outlet table is
stale — it predates the Kumasi cluster. Quote `financial-model-targets.md`, never the prose.

---

## Q4 — Credit facility fee: is 2–3%/month chargeable as structured? · `NEEDS-HUMAN`
**Blocks:** Phase 1 credit go-live · **Owner:** accountant / legal

The brief is right that the fee should be captured as real revenue — the model deliberately
excludes it as unmodelled upside, and the business's own analysis calls it the single
highest-value quick win.

**But 2–3%/month is an effective 26.8%–42.6% annually.** Whether that is best structured as a
credit facility fee, a price differential between cash and credit terms, or something that
attracts lending/moneylending regulation in Ghana is a question for the same professional who
reviews the chart of accounts.

The ERP will compute and track it either way — `credit-engineer` builds the mechanism with the
rate configurable, and the GL treatment (fee income vs. revenue) is confirmed at the §2.7 gate.
**No agent answers this question.** `compliance-gatekeeper` keeps it on the gate list.

**PHASE 2 GATE (2026-08-23) — before this question is answered, fix the thing that would ignore the
answer.** The accrual's refusal to post without confirmation is exemplary and is the pattern the
whole project is measured against. **What sits behind the gate is not ready to receive the answer:**

- `apps/api/src/credit-policy.ts:25,27,31` declares `feeBasis`, `feeCompounds` and `feeDayCount`.
  All three are declared, defaulted, and **read by no code** — `computeFeeAccruals` reads only
  `feeGraceDays`. **If the accountant confirms `actual_365`, the system records `actual_365` and
  silently accrues 30E/360 anyway** (gate finding G-5).
- `CreditPolicy` has no field for the fee's tax code (**Q18**) or its account, and `confirm()` opens
  the gate on D-1..D-5 alone — so confirming this question would open fee posting with Q18 unasked
  (gate finding G-3).
- The policy store is **in-memory**, so the confirmation is not durably recordable and resets on
  restart.

**Fix all three before the accountant is asked**, otherwise their answer is captured into fields
nothing reads. A gate that accepts a professional's answer and ignores it is worse than one that
never asked — it converts an open question into a false assurance carrying that professional's name.

---

## Q5 — VAT was out of scope in the brief but cannot be in practice · `DECIDED`
**Blocks:** Phase 1 POS · **Owner:** accountant confirms registration status

The brief does not mention VAT. The financial model marks it *"informational only,
output-neutral."* But FY1 revenue of GH₵2,640,000 is far above the registration threshold, so
the POS will be issuing statutory invoices from the first day of trading.

**Decision:** `ADR-0002` — computed at the POS, rates in an effective-dated table, never
hard-coded. The accountant confirms registration status and the correct rate set before Phase 1
go-live; `compliance-gatekeeper` holds the gate.

**PHASE 2 GATE (2026-08-23) — the mechanism is proven and THE GATE IS NOT ENFORCED.** Two findings,
both in `docs/phase2-gate.md` §3.1.

*Moved, and strongly.* `ADR-0002`'s core claim is now demonstrated live and mutation-tested: a sale
dated 2025-06-15 reprices against the regime in force **then** (net 14,766, `GH.COVID` present,
VAT on a `net_plus` base) while the same shelf price today reprices against today's (net 15,000).
Same gross, different net — no constant divisor produces both. Effective dating works.

*Not moved, and now a gate finding (**G-1**).* `platform.tax_rate` carries `confirmed_by` and
`confirmed_at`, commented in the migration as *"The §2.8 gate, in the schema… NULL =
[UNCONFIRMED]"*. Every seeded Ghana row has both NULL and every `legal_reference` ends
`[UNCONFIRMED]` — correctly, because nobody has confirmed them. **But nothing reads those columns.**
`taxComponentsInForce` (`apps/api/src/tax.ts:89-95`) does not select them; the device syncs them and
queries them nowhere; and `provisioning.createTenant` writes `status='active'` immediately, so the
`'provisioning'` lifecycle state is never occupied.

The POS therefore computes, prints and stores VAT + NHIL + GETFund on every line from a software
team's reading of published web pages, and **no screen, receipt, API field or gate says so.** The
facility fee — unmodelled upside — refuses to post without a human. The sales tax — every sale,
GH₵2,640,000 of FY1 revenue, statutory and remitted — posts silently. **That is backwards.**

*A second finding (**G-2**).* All 219 SKUs are seeded `GH.VAT.STD` with **no `[NEEDS-FOUNDER]`
marker**, unlike the reorder points and supplier terms which both carry one; and the product's tax
code is only a **presence** check — `apps/api/src/tax.ts:14-19` applies every jurisdiction tax code
in force to the line regardless, so **marking a SKU zero-rated or exempt would change nothing**. If
any part of a construction-materials catalogue is not standard-rated, the POS overcharges from day
one and no tenant configuration can stop it. **"Which supplies are standard-rated?" is not in the
practitioner brief and must be added to it before it is sent.**

---

## Q6 — Phase 3 reviewing accountant is not yet named · `NEEDS-HUMAN`
**Blocks:** Phase 3 **design and content**, and Phase 3 go-live · **Owner:** founder

The brief flags this as `[FILL IN]` and is emphatic about *why* it matters: the chart of accounts
should be reviewed **from the start**, not retrofitted after Phase 3 is built. Naming this person
before Phase 3 design begins is materially cheaper than naming them after.

`product-manager` raises this at the Phase 2 gate at the latest.

**RAISED AT THE PHASE 2 GATE, 2026-08-23, as this item instructed — and the `blocks` field has been
widened to match the item's own argument.** It previously read "Phase 3 go-live", which understated
it: the body of this item argues that the chart of accounts must be reviewed *from the start, not
retrofitted after Phase 3 is built*, and that is a statement about **design**, not about go-live.
A named accountant is therefore a precondition for authoring Phase 3's accounting **content** —
chart-of-accounts template, posting rules, costing method (Q16), the fee's GL treatment (Q4/Q18),
opening balances (Q20) — and not merely for switching a ledger on.

**No accountant exists.** The founder has stated they do not yet have one. This item is now the
principal constraint on Phase 3 and it is not a software task. See `docs/phase2-gate.md` §4 and §6.

---

## Q7 — Fractional quantities and dual units of sale · `OPEN`
**Blocks:** Phase 0 data model · **and, since the Phase 2 gate, Phase 2 *operability*** ·
**Owner:** `software-engineer` + founder

**27% of the catalogue (59 of 219 SKUs) does not sell in whole units.** This surfaced while
probing the money-representation rule and it is a genuine data-model question, not a hypothetical.

Three distinct problems, easily conflated:

**1. Fractional quantities.** Sand and quarry dust sell by the ton, binding wire by the kg,
cabling by the metre. A quantity of 2.5 tons is exactly as float-hazardous as a price. Quantities
must be scaled integers with the scale stated in the column type and comment (`ADR-0004`).

**2. Dual units of sale on the same SKU.** The stock list carries these verbatim:
- `Length (12m) / Ton` — all six rebar sizes
- `Roll / kg` — binding wire · `Roll / Meter` — cabling
- `Ton / Trip load` — sand, quarry dust, both gravel grades
- `Sqm / Piece` — paving blocks · `Sqm / Box` — tiles

A contractor buys rebar by the ton; a self-builder buys three 12m lengths. **Same SKU, two units,
two prices, one stock balance.** The ERP needs a stocking unit, one or more selling units, and a
conversion factor between them — and the conversion for rebar is a real physical constant that
varies by bar diameter. Getting this wrong means stock that never reconciles.

**3. Sub-pesewa unit pricing.** A per-kg or per-metre price may not land on a whole pesewa. The
answer is still an integer — a scaled integer with the scale documented — never a float. But the
scale has to be chosen deliberately, and the rounding point (per unit, or per line total?) stated.

**Decide this in the architecture document.** It touches the SKU model, the stock movement ledger,
the POS selling flow and the GL posting. Retrofitting a unit-conversion layer into a live stock
ledger is the kind of migration that goes wrong quietly.

**What needs the founder, not an engineer:** confirmation of how these are actually sold at the
counter today, and the conversion factors (kg per 12m length, per rebar diameter).

**PHASE 2 GATE (2026-08-23) — partly answered, and the unanswered part is now blocking a shipped
capability.** Sub-problems **1** (fractional quantities) and **3** (sub-pesewa unit pricing) are
answered and built: scaled integers with the scale in the column type and comment, exact rational
conversion factors, one `product_uom` machinery used in both the buying and the selling direction
and verified equal on both sides of the wire.

**Sub-problem 2 — dual units of sale — is built as a model and is unusable.** `applyTemplate`
authors thirteen converting `product_uom` rows per tenant and sets `can_buy = false` on every one,
deliberately (`packages/db/src/seed/template.ts:443-448` calls the buying direction *"a further
authoring step the founder confirms"*). **No route in the product performs that step** — the
catalogue router (`apps/api/src/routers/catalogue.ts:105`) exposes `list`, `search` and `detail`
and no write procedure at all, and the only thing in the repository that sets `can_buy` on a
converting row is a development script, `infra/scripts/dev-purchase-units.ts`.

So on a production tenant, `select count(*) from app.product_uom where can_buy and factor_num <>
factor_den` is **zero**, and cross-unit multi-source purchasing — a headline Phase 2 capability,
demonstrated live and correctly — **cannot be reached by tenant #1**. The founder input this item
asks for is now the long pole on a shipped feature, not a data-model question.

The refusal to guess is correct and should not be undone: a conversion factor is a physical claim
about the goods, and a guessed one would make a green receipt drill certify a wrong receipt.

---

## Q8 — Ghana's e-VAT invoicing is a *clearance* regime · `NEEDS-HUMAN`
**Blocks:** Phase 1 POS **design**, not just go-live · **Owner:** GRA, engaged via a registered tax
practitioner · **Raised by:** §7.4.4, §3.7.5, §3.10 Concern 3

On the sources read (20 Aug 2026), an invoice is not a valid VAT invoice until the GRA returns a
clearance/SDC code, a QR code and a digital signature. That collides head-on with `CLAUDE.md` §2.2's
requirement to trade fully offline for days, and `ADR-0002` ("receipts carry the fields the GRA
requires") does not acknowledge it because **some required fields are not locally derivable.**

If GRA must originate the number, the counter cannot issue a VAT invoice offline. It must issue a
**proforma or delivery note offline and the VAT invoice on reconnect** — a different counter
workflow, a different document model, and different customer expectations. That is not a code tweak.

Four sub-questions, all with months of lead time: Certified Invoicing System onboarding; the Joint
User Acceptance Testing timeline; **the permitted offline window and its rules**; and an unconfirmed
claim that software changes require Commissioner-General pre-approval — which, if true, constrains
the PWA deployment pipeline itself (`ADR-0003`, §9.7.2 release rings).

**This is the single item most likely to move the 1 August 2026 launch date.** It is gate `G2d`
(§7.7). Start it now.

---

## Q9 — Trip-load capacity has no home after `ADR-0001` · `OPEN`
**Blocks:** catalogue template authoring (Phase 1) · **Owner:** founder · **Raised by:** §4.16

Four aggregate SKUs (sand, quarry dust, two gravel grades) are priced by "trip load". A trip is a
truck capacity, and `ADR-0001` deleted the entity that would carry one. Either the haulier contract
carries a nominal `vehicle_class` capacity — **which is not fleet management**, it is a number on a
supplier's rate card — or trip-load sales are priced ad hoc per delivery and the conversion factor
is a fiction. Without an answer the class-A conversion for SKUs 11–14 cannot be authored, so the
catalogue template cannot ship complete.

**PHASE 2 GATE (2026-08-23) — the home now exists; the decision does not.** Phase 2 built
`app.supplier` + `app.supplier_capability` with a **platform** capability kind of `HAULAGE`, and
`app.delivery.carrier_supplier_id NOT NULL` referencing a supplier. That is exactly the shape this
item proposed as the non-fleet home for a nominal capacity: a number on a supplier's rate card.
Implementing the founder's answer is now cheap. The answer is still unmade, and SKUs 11–14 still
cannot be authored, so the catalogue template still does not ship complete.

---

## Q10 — Cement shelf life versus no lot tracking · `OPEN`
**Blocks:** Phase 1 inventory design · **Owner:** founder · **Raised by:** §4.16

Ten cement SKUs are the traffic-builders. OPC has a real ~3-month working shelf life in Ghanaian
humidity, and the data model has no lot, batch or expiry tracking. Either FIFO is a yard practice we
deliberately do not systematise, or lot tracking is a Phase 1 gap. **It needs deciding now**: adding
`lot_id` to a live movement ledger means every historical row has an unknown lot.

**PHASE 2 GATE (2026-08-23) — this item is deteriorating and should be decided before Phase 3
begins.** Phase 2 added a second writer to the movement ledger: a goods receipt now appends
`app.stock_movement` rows with `source_kind = RECEIPT`, and none of them carries a lot, batch or
expiry. Every day this stays undecided adds rows whose lot can never be known retrospectively, and
the receipt path is precisely where a lot would be *captured* if one were ever tracked. The cost of
the decision does not stay flat — it rises with row count, and it starts rising in earnest on the
first day of real trading.

---

## Q11 — "Secured against contractor deposits" is designed nowhere · `OPEN`
**Blocks:** Phase 1 credit — any claim that the book is secured · **Owner:** founder + accountant
**Raised by:** §6.11 Concern 1

The business plan names deposits as the security behind credit limits (§10 risk table) and §6
reports a deposit coverage ratio against a `security_deposit_minor` column **with nothing behind
it.** A real deposit needs a held-funds ledger, a GL liability account it cannot be swept out of, a
claim procedure, and rules for a defaulting customer who holds one. None is in scope.

Either deposits genuinely secure the credit book — in which case this is a **Phase 1 dependency of
credit**, not a Phase 3 nicety — or the word "secured" comes out of the risk table. Until then every
"secured" claim about this credit book is a column with a number typed into it.

---

## Q12 — The pilot and the outlet opening are the same day · `NEEDS-HUMAN`
**Blocks:** Phase 1 pilot readability · **Owner:** founder · **Raised by:** §9.11 C1

Techiman flagship opens 1 August 2026 and the ERP goes live the same morning. New outlet, new staff,
new software: when something goes wrong nobody will be able to separate a software defect from a
staff learning curve — which is the one question the pilot exists to answer.

**Recommendation: a 2–4 week dry-run window before trading opens** — real catalogue, real prices,
real hardware, staff practising against synthetic customers, no revenue at risk. If the date is
immovable, that must be an explicit decision with the first week reclassified as training and the
14-day success clocks starting after it.

**PHASE 2 GATE (2026-08-23) — OVERTAKEN BY EVENTS. This item can no longer be actioned as written
and is reframed.** It recommends a dry-run window *before 1 August 2026*. That date is **22 days
past** and no phase of the build is signed off.

The recommendation has not become wrong — it has become **free**. There is no longer a launch date
to protect, so the 2–4 week dry run costs nothing but the willingness to schedule it. What the item
now needs from the founder is not a trade-off but two facts:

1. **A restated first-trading date**, set deliberately rather than by default. `docs/phase2-gate.md`
   §6 sets out the dependency chain that determines the earliest defensible one.
2. **An answer to Q21** — whether the outlet opened and traded anyway. If it did, this item's
   premise is inverted: the software would not be arriving *with* a new outlet, it would be
   arriving *into* one already running, which is a different and in some ways easier pilot — and it
   makes Q20's opening balances a reconstruction rather than a snapshot.

---

## Q13 — Ghana data residency has not been asked · `NEEDS-HUMAN`
**Blocks:** Phase 1 go-live · **Owner:** `compliance-gatekeeper` + Ghanaian counsel
**Raised by:** §9.11 C6

Hosting a Ghanaian company's books in Ireland may carry registration or cross-border transfer
conditions under the Data Protection Act 2012 (Act 843), and EU hosting brings the operator within
EU data-protection law regardless of where the customer is. **This is the single input that could
invalidate `ADR-0003`'s hosting decision outright**, and it costs one conversation to resolve.

---

## Q14 — Suspension, offboarding and deletion windows are commercial, not engineering · `NEEDS-HUMAN`
**Blocks:** first paying tenant (not the pilot) · **Owner:** founder + whoever owns contracts
**Raised by:** §1.10 C3, C4; §9.11 C7

Three numbers with no owner: how long a suspended tenant's token keeps working (7 days proposed),
how long we keep accepting their unsynced uploads (14 days), and when a device seals itself (30
days). They determine how long a non-paying customer keeps a readable copy of their books and how
much trade we guarantee to accept from someone we have suspended. The columns exist either way.

Two adjacent legal questions: **backup retention versus a deletion promise** — we can prove the
primary database is clean but cannot expunge point-in-time backups without destroying every other
tenant's recovery point, and whether the honest "aging-out date" satisfies a regulator is a legal
question; and **device retirement**, which writes off whatever `pending_writes_estimate` says and is
therefore a business decision with money attached.

---

## Q15 — Is the model's revenue VAT-inclusive or VAT-exclusive? · `NEEDS-HUMAN`
**Blocks:** the first budget-vs-actual report · **Owner:** founder + accountant · **Raised by:**
§5.10.2 (`GL-Q1`)

The financial model marks VAT *"informational only, output-neutral"* at 15%, which reads as
pass-through and therefore exclusive — but it does not say so. `ADR-0002` makes the ledger's
`revenue` unambiguously **net of all tax components**, because output tax is a liability. If the
model's GH₵2,640,000 is gross, actual revenue comes in materially below target from month one and
the gross-margin denominator differs. **At 15% plus levies that is a >GH₵300,000 FY1 difference**
against a target curve tracked to three decimal places.

**PHASE 2 GATE (2026-08-23) — sharpened, and now measurable rather than theoretical.** Tax-inclusive
price lists work end to end, so tenant #1's counter prices in whichever direction its own list
declares while the ledger's revenue stays net of all tax components. `reports.inventoryDays`
publishes `grossMarginPctE4` and it is **computed correctly against ERP data today** — so the only
thing standing between the founder and a valid margin-vs-target comparison is this question.

Ask it in the same email as **Q17**: both are for the founder plus whoever built the model, and both
move a reporting baseline materially. It blocks neither Phase 3 build nor Phase 3 go-live — build
the variance report with the baseline as a tenant-editable figure carrying an explicit `basis` flag,
and gate nothing on it.

---

## Q16 — Costing method, and what a late offline document does to COGS · `NEEDS-HUMAN`
**Blocks:** Phase 1 POS (COGS posts from the first sale) · **Owner:** accountant · **Raised by:**
§5.1 #9 (`GL-Q2`)

Moving weighted average, or period weighted average with a close-time true-up? The engineering
mechanism is settled — the stock ledger's replayed valuation is canonical, the GL never
retro-restates a posted entry, and a period-close revaluation entry ties them — but **which method
the tenant's books use is an accounting policy decision.** It matters because a tablet syncing
Monday's goods receipt on Thursday moves Tuesday's reported margin, and this business tracks blended
gross margin to three decimals.

---

## Q17 — Do the per-tier staff-cost baselines include employer social security? · `OPEN`
**Blocks:** `staff_cost` variance reporting · **Owner:** founder + accountant · **Raised by:**
§5.10.2 (`GL-Q3`)

The model's 216,000 / 108,000 / 43,200 per-tier baselines do not say whether they are gross pay only.
The ledger's `PL_STAFF` includes the employer contribution, because it is a real company cost the GL
must carry (§2.4 — recording is not calculating). If the baselines are gross-only, actual staff cost
exceeds target from month one for a reason that is not overspending. Ask alongside Q15.

---

## Q18 — Is the credit facility fee a taxable supply? · `NEEDS-HUMAN`
**Blocks:** Phase 1 credit go-live · **Owner:** the Q4 accountant · **Raised by:** §6.11, §7.4.5

A sub-question of Q4 that Q4 does not currently ask, and a jurisdiction-pack value nobody has
listed. It is a distinct question from "how should the fee be structured" and needs its own answer.

**CORRECTED AT THE PHASE 2 GATE (2026-08-23).** This item previously claimed: *"The CoA template
ships the fee account's tax code **unset** and the accrual refuses to post until it is set, so this
gates go-live rather than the build."* **That is not what the code does.** There is no chart of
accounts and there is no tax-code field anywhere. `CreditPolicy`
(`apps/api/src/credit-policy.ts:23-40`) carries D-1..D-3, grace and ageing, and **no field for the
fee's tax code or for which account it posts to**; `confirm()` stamps only
`confirmedBy`/`confirmedAt`/`confirmationNote`; and the gate condition is simply
`policy.confirmedAt === null`, with a message naming D-1..D-5.

**So an Accounts user confirming the fee *structure* (Q4) would open fee posting while Q18 has
nowhere to be recorded and has not been asked.** Harmless today, because there is no GL and no tax
line on a fee entry — and exactly wrong-shaped for Phase 3, which is when it stops being harmless.

Cheap to fix now, and it should be fixed before Q4 is answered rather than after: add
`feeTaxCode` and `feeAccountRef` to `CreditPolicy` and require all of them at the gate. Related:
the policy store is **in-memory**, so a confirmation cannot be durably recorded and resets to
unconfirmed on restart — safe direction, but "an accountant confirmed this" is not yet a
persistable fact.

An open question that misdescribes its own safeguard is worse than one that admits it has none,
which is why this correction is recorded in place rather than quietly edited away.

---

## Q19 — Who may exclude a dark device from a period close? · `OPEN`
**Blocks:** Phase 3 period close; the policy should be agreed in Phase 1 · **Owner:** founder, then
standard onboarding policy · **Raised by:** §3.11.4, §5.14.6 finding 7

A period cannot be locked while any location may still hold unsynced documents dated on or before
the period end, and **a server cannot distinguish "device has nothing pending" from "device has 400
sales in its outbox"** — a dead tablet is silent either way. The engineering answer is device
attestation: an unattested device blocks the close and is named.

The residual question is human. Somebody must be able to say "that tablet is at the bottom of a
gutter in Bawku, close the period without it" — and that act writes off whatever the device was
holding. Who is entitled to say it, at what age, and what does the close record have to state? Our
proposal: a **tenant administrator**, never a platform operator, with the excluded device and its
last-reported outstanding count printed on the close.

**PHASE 2 GATE (2026-08-23) — this item now has an engineering precondition that did not exist when
it was written.** A period close must be able to establish that no unresolved conflict is outstanding
for the period. **`app.conflict_review` has no reader**: no router among 49 procedures, no sync
bucket, no screen, no resolve path, no scheduler — verified against the live container, which holds
**6 rows, all `open`, 0 ever claimed or resolved**. That question is unanswerable today, and a close
that ignored open reviews would silently lock a period over unreconciled differences — the exact
class of error §2.8 says bank reconciliation exists to surface.

**The queue needs a read and resolve surface before period close is designed**, not before it ships:
the close's contract with the review queue *is* the design question. Recorded as a precondition on
Phase 3 Track A in `docs/phase2-gate.md` §4.3.

---

## Q20 — Opening balances · `OPEN`
**Blocks:** Phase 1 go-live · **Owner:** founder + accountant · **Raised by:** §5.14.6 finding 27

**UPDATED 2026-08-25 (Q21 answered: no trading).** Tenant #1 now goes live on **1 January 2027**,
and because the outlet has never traded there are **no debtors and no creditors to bring across** —
opening balances reduce to opening STOCK plus whatever capital and bank position the accountant
determines. That is the small version of this question, and it is still the accountant's.

The original text follows.

Tenant #1 goes live on 1 August 2026 with existing stock, debtors and creditors, and the ledger
design contains **no opening-balance mechanism at all** — no `source_kind`, no posting rule, no
equity plug, no gate that the opening trial balance ties to the subledgers per location. It was
mentioned once in passing as "a bulk load of 10,000 lines".

This is the **first thing that posts**, so it is Phase 1 work, not Phase 3. What is needed from a
human: the cut-off date, who prepares the opening figures, and who signs that they are right.

**PHASE 2 GATE (2026-08-23) — the cut-off date is no longer a known quantity.** This item assumes a
clean cut-off at 1 August 2026. That date is 22 days past and no phase is signed off, so the
cut-off is now whatever Q21 turns out to be. If the outlet has been trading, opening balances are a
**reconstruction from manual records with a moving cut-off**, not an opening snapshot — a
materially different and larger piece of work, and one that needs the accountant who does not yet
exist (Q6). Answer Q21 before scoping this.

---

## Q21 — Has tenant #1 traded since 1 August 2026 without the ERP? · **ANSWERED 2026-08-25: NO**

> **Founder, 25 August 2026: the outlet has not opened and no sale has been made.** The launch date
> is restated to **1 January 2027** (`CLAUDE.md` §1).
>
> **This is the good answer, and it collapses three problems at once:**
> - **Q20 becomes a clean cut-over, not a reconstruction.** Opening balances are a snapshot taken
>   on a chosen date before 1 January 2027, not an archaeology of paper records against a moving
>   cut-off. Still needs the accountant, but it is now the small version of the job.
> - **Q8 stays prospective.** No invoice has been issued under an unconfirmed treatment, so the
>   practitioner is being asked to advise on a design rather than to assess a liability already
>   incurred. That is a materially cheaper conversation and a materially better one to be having.
> - **Q12's dry-run window is free.** There is no live trading to interrupt, so a parallel run
>   before go-live costs nothing but calendar — and the calendar just gained four months.
>
> The original text is kept below as the record of the question that was asked.

---

### The question as it was raised


**Blocks:** Q20's cut-off date · the rollout plan · any claim about pilot success criteria ·
**Owner:** founder · **Raised by:** the Phase 2 gate, `docs/phase2-gate.md` §3.3

`CLAUDE.md` states the Techiman flagship opens **1 August 2026**. Today is **23 August 2026** and
no phase of the build is signed off. **Nobody in this repository has asked whether the outlet
opened anyway.** Every rollout document, every success clock and every opening-balance assumption
is written as though the software will arrive on the same morning the doors first open, and that is
now either wrong or unverified.

The two answers lead to materially different projects:

**If the outlet did not open** — the launch date simply moves. Q12's dry-run recommendation becomes
free rather than costly, Q20's cut-off is whatever the restated date is, and the pilot is still the
clean experiment it was designed to be.

**If it opened and has been trading on paper, on a spreadsheet or on another system** — then:
- there is a live period of real trading with **no system of record**, and it is growing daily;
- **Q20 changes shape entirely**: opening balances become a reconstruction from manual records
  against a moving cut-off, not a snapshot — bigger work, and work that needs the Q6 accountant;
- every "14-day success clock" in the rollout plan is measuring something that already started;
- **Q8 becomes retrospective, not prospective.** Invoices have already been issued to customers by
  some means, and whatever their statutory status is, it is already a fact rather than a design
  decision;
- Q12's premise inverts: the software would be arriving *into* a running outlet rather than *with*
  a new one — in some ways an easier pilot, because a software defect is then separable from a
  staff learning curve, which is the one thing Q12 said the pilot could not do.

**This costs one question and it changes the scope of Phase 3's first deliverable. It should be the
first thing asked at this gate.**
