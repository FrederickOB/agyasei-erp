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

---

## Q2 — Receivables days understated · `OPEN`
**Blocks:** Phase 1 credit design (soft) · **Owner:** accountant

The model assumes **15 days** receivables. Contractor terms are **30–60 days**. If contractor
credit scales as the strategy intends, actual DSO lands well above 15 and the FY3 cash trough
of GH₵(1,393,958) deepens — the trough is the plan's single most important funding milestone.

The ERP will measure real DSO from day one. `business-data-analyst` surfaces actual vs. the
15-day assumption in every reporting cycle so this is caught early rather than discovered.

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

---

## Q5 — VAT was out of scope in the brief but cannot be in practice · `DECIDED`
**Blocks:** Phase 1 POS · **Owner:** accountant confirms registration status

The brief does not mention VAT. The financial model marks it *"informational only,
output-neutral."* But FY1 revenue of GH₵2,640,000 is far above the registration threshold, so
the POS will be issuing statutory invoices from the first day of trading.

**Decision:** `ADR-0002` — computed at the POS, rates in an effective-dated table, never
hard-coded. The accountant confirms registration status and the correct rate set before Phase 1
go-live; `compliance-gatekeeper` holds the gate.

---

## Q6 — Phase 3 reviewing accountant is not yet named · `NEEDS-HUMAN`
**Blocks:** Phase 3 go-live · **Owner:** founder

The brief flags this as `[FILL IN]` and is emphatic about *why* it matters: the chart of accounts
should be reviewed **from the start**, not retrofitted after Phase 3 is built. Naming this person
before Phase 3 design begins is materially cheaper than naming them after.

`product-manager` raises this at the Phase 2 gate at the latest.

---

## Q7 — Fractional quantities and dual units of sale · `OPEN`
**Blocks:** Phase 0 data model · **Owner:** `software-engineer` + founder

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

---

## Q10 — Cement shelf life versus no lot tracking · `OPEN`
**Blocks:** Phase 1 inventory design · **Owner:** founder · **Raised by:** §4.16

Ten cement SKUs are the traffic-builders. OPC has a real ~3-month working shelf life in Ghanaian
humidity, and the data model has no lot, batch or expiry tracking. Either FIFO is a yard practice we
deliberately do not systematise, or lot tracking is a Phase 1 gap. **It needs deciding now**: adding
`lot_id` to a live movement ledger means every historical row has an unknown lot.

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
listed. The CoA template ships the fee account's tax code **unset** and the accrual refuses to post
until it is set, so this gates go-live rather than the build — but it is a distinct question from
"how should the fee be structured" and needs its own answer.

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

---

## Q20 — Opening balances · `OPEN`
**Blocks:** Phase 1 go-live · **Owner:** founder + accountant · **Raised by:** §5.14.6 finding 27

Tenant #1 goes live on 1 August 2026 with existing stock, debtors and creditors, and the ledger
design contains **no opening-balance mechanism at all** — no `source_kind`, no posting rule, no
equity plug, no gate that the opening trial balance ties to the subledgers per location. It was
mentioned once in passing as "a bulk load of 10,000 lines".

This is the **first thing that posts**, so it is Phase 1 work, not Phase 3. What is needed from a
human: the cut-off date, who prepares the opening figures, and who signs that they are right.
