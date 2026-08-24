# Practitioner brief — two questions we cannot answer ourselves

**Prepared for:** a Ghana-registered tax practitioner, or a chartered accountant in practice
(ICAG member) — engaged by the founder of Agyasei Jnr & Company Limited
**Prepared by:** `compliance-gatekeeper` (software team) · **Compiled:** 21 August 2026
**Sources behind every factual claim here were read on 20 August 2026 and not since.**

---

## The question, in one sentence

> **May a VAT invoice be issued to a customer at the counter while the device has no connectivity
> to the GRA — and if it may not, what document may lawfully be handed to the customer instead, and
> within what window must the VAT invoice follow?**

Everything else in this document exists to make that question answerable. It is set out in full at
**§A2**, its nine sub-questions at **§A3**, and the two different products the two possible answers
produce at **§A5**. A second, less urgent question — the credit facility fee — is **Brief B**.

---

> ### Read this paragraph before anything else
>
> **Nothing in this document is professional advice, and nobody who wrote it is qualified to give
> any.** Every factual claim about Ghanaian law or GRA practice below is marked `[UNCONFIRMED]`.
> It is a software team's reading of publicly published pages and secondary advisory summaries,
> made by people with no professional standing to interpret them, recorded here **so that a
> qualified person has something specific to correct** — not so that engineering can proceed
> without one. Please treat every `[UNCONFIRMED]` line as a draft assertion to be struck through,
> corrected or confirmed. **We are relying on your answer, not on our reading.**

This document contains **two separate briefs** for one engagement:

| | Brief | Urgency | Who must answer |
|---|---|---|---|
| **A** | **Ghana e-VAT invoicing: can a counter issue a VAT invoice while offline?** | **Critical — blocks software design, not just go-live.** Longest lead time of anything on the project. | You, plus the GRA engaged through you |
| **B** | **Is the 2–3%/month credit facility fee chargeable as structured?** | Blocks credit go-live, not the build | You, possibly with a Ghana-qualified lawyer |

They are in one document because the founder expects to engage one professional for both. **Brief A
is the one that is on fire.** If time is short, answer A and schedule B.

---

## Before you start: one internal contradiction the founder must resolve

Our own project documents state the pilot outlet opens in Techiman on **1 August 2026**. This brief
was compiled on **21 August 2026**. Those cannot both be current. Every lead-time question in
Brief A — "is there enough runway for Certified Invoicing System onboarding?" — depends entirely on
which is right.

**Founder: before sending this, write the real intended first-trading date here → `____________`**

We have not guessed at it and we have not adjusted anything to fit.

**As of 23 August 2026 that date is 22 days in the past and this brief has not been sent.** So the
question is no longer "is there enough runway" — it is either "the outlet has not opened yet and
here is the real date", or "the outlet has been trading since 1 August and we need to know what
that means for invoices already issued". Those are very different conversations and the
practitioner must be told which one this is in the covering note. If it is the second, say so
plainly and first: invoices already issued under an unconfirmed treatment are the practitioner's
most urgent question, not ours.

---

## What we need back, and in what form

So that your answer can be recorded properly and audited later, we need it **in writing, naming the
instrument or prescription it rests on**. Our system has columns waiting for exactly this:

| What you tell us | Where it is recorded |
|---|---|
| The rule, and the Act / regulation / GRA prescription it comes from | `tax_rate.legal_reference` |
| Your name and the date you confirmed it | `tax_rate.confirmed_by`, `tax_rate.confirmed_at` |
| The credit-fee decisions | `credit_policy.fee_confirmed_by`, `fee_confirmed_at`, `fee_confirmation_note` |

**Where that enforcement has actually reached, stated precisely, because an earlier draft of this
brief overstated it.** The credit-facility-fee path genuinely does refuse: with no confirmation on
record the system returns a hard error and posts nothing, so nobody can be billed a fee we guessed
at. The **sales-tax path does not yet** — the `confirmed_by` / `confirmed_at` columns exist and are
empty on every Ghana rate row, and the pricing code does not currently read them, so the rates
below are being applied unconfirmed. That is a defect on our side, it is recorded as one, and it is
being closed. We are telling you rather than letting you assume a control that is not yet there.

Your written answer is what makes those rates confirmed rather than assumed, on every historical
transaction as well as every future one — our rates are effective-dated, so a sale is always
re-priced against the row that was in force on its own transaction date.

A bulleted email is entirely sufficient. We do not need a formal opinion letter unless you think one
is warranted.

---
---

# BRIEF A — Ghana e-VAT invoicing and the offline counter

## A1. What the business is

Agyasei Jnr & Company Limited is a **construction-materials retailer and wholesaler** — cement,
rebar, roofing, sand and quarry aggregates, plumbing and electrical — opening a flagship outlet in
**Techiman, Bono Region**, and growing to 25 outlets across six regions over ten years. It sells at
a **trade counter**: walk-in self-builders paying cash, and contractors buying on 30–60 day credit.
First-year revenue is planned at **GH₵2,640,000**, so it will be VAT-registered and issuing
statutory invoices from its first day of trading. The outlets are in places where **mobile data is
unavailable for hours and sometimes days at a time**, and the till must keep selling throughout.
We are building its point-of-sale and stock system, and that last sentence is the reason the
software exists at all.

## A2. The one question that decides how we build

> ### May a VAT invoice be issued to a customer at the counter while the device has no connectivity to the GRA?
>
> ### And if it may not — what document may lawfully be handed to the customer instead, and within what window must the VAT invoice follow?

Everything else in Brief A is a sub-question of that one. We are not asking whether it is advisable.
We are asking what the rules permit, because the two possible answers produce **two different
products**: one where the counter prints a tax invoice and syncs later, and one where the counter
prints a non-tax document and the tax invoice is issued on reconnect. Those differ in the database,
in the counter workflow, in what the customer is handed and in what the customer is told. We cannot
build both and choose later.

**What we understand today, and want corrected:** on the sources we read (20 Aug 2026), Ghana
operates a **clearance** model — an invoice produced by a taxpayer's own system is not a valid VAT
invoice until the GRA has cleared it and returned a clearance/SDC code, a QR code and a digital
signature `[UNCONFIRMED]`. If that is right as stated, a device with no connectivity cannot produce
a valid VAT invoice, because some mandatory fields do not exist until the GRA supplies them. We may
be wrong about this, or right about the general rule and wrong about the exceptions. **That is the
answer we need.**

**What we are doing while we wait, so you know nothing is stalled on your speed.** We have already
built and tested the part that is identical under every possible answer: the sale is captured, VAT
and the levies are computed per line, and the figures are stored. We have deliberately **not** built
any invoice-issuance, clearance or document-status field, because building them now would bake in a
guess about your answer and cost more to unpick than to write. So your answer unblocks the
**document model** and the go-live — not the whole build. What it blocks absolutely is trading: the
system is built to refuse to go live on any tax path until a named person has confirmed the rates
and rules it uses.

---

## A3. The sub-questions

Each one is stated as we would like it asked. Under each: **why it matters to the software**, and
**what each possible answer would change**. Please answer the ones you can and tell us which need
to go to the GRA.

**If you are short of time, triage them like this.** **A3.8** is the cheapest — we think you can
answer it from your own knowledge in minutes, and it is the only one that changes the arithmetic
rather than the documents. **A3.3, A3.4 and A3.7** are the three that decide what we build. Our
reading is that A3.1, A3.2, A3.3, A3.4, A3.7 and probably A3.9 must go to the GRA; A3.5, A3.6 and
A3.8 may not.

### A3.1 — Certified Invoicing System onboarding, and its lead time · gate `G2d`

> **Ask:** What is the process by which a taxpayer's own point-of-sale software becomes a Certified
> Invoicing System integrated with the Commissioner-General's system? What are the stages, what does
> the GRA require from the taxpayer at each, what does it cost, and **how long does it take in
> practice from first application to permission to trade on it?**

**Why it matters to the software.** We currently have **no place on the project plan for this at
all.** It is not late — it has not started. Our reading is that onboarding involves an application
to the GRA, an API integration and acceptance testing before certification `[UNCONFIRMED]`, which
is a lead time measured in months rather than days. If that is right, it is the longest-lead item
in the entire build and it determines whether the outlet can legally trade on our software on
opening day.

**What each answer changes.**

- **Weeks, self-service, published API spec** → we schedule it inside the current build and it
  becomes an engineering task like any other.
- **Months, with GRA-scheduled testing slots** → it becomes the critical path. Everything else
  reorders around it, and the opening date is set by the GRA's calendar, not ours.
- **Certification is of the *vendor*, not the taxpayer, and a certified third-party product must be
  used** → this changes the product decision, not the schedule. We would need to know whether an
  in-house system can be certified at all, or whether the counter must run an approved vendor's
  invoicing module that our system feeds. That is a build-versus-integrate decision and it is
  better to know now than after.
- **There is an interim or transitional arrangement for newly registering taxpayers** → we need its
  terms and its expiry, because building to a transitional rule that lapses is worse than building
  to the final one.

### A3.2 — Joint User Acceptance Testing · gate `G2d`

> **Ask:** What is the Joint User Acceptance Testing process? Who attends, what is tested, what
> evidence must the taxpayer produce, how far ahead must it be booked, and what happens if it fails
> — is it re-bookable quickly or does it go to the back of a queue?

**Why it matters to the software.** We need to know what we are being tested *against* before we
write the code, not after. A test we cannot see the criteria for is a test we will fail at least
once. If failure means a multi-week rebooking, that risk has to be priced into the opening date.

**What each answer changes.**

- **Published test script / conformance checklist** → we build to it directly and can self-test
  before booking, which removes most of the schedule risk. **This is the single most valuable
  document you could obtain for us.**
- **Live joint session with GRA staff against our running system** → we need to know the
  environment requirements (does it test against production data? a sandbox? our servers or
  theirs?) and we must have a stable build weeks earlier than currently planned.
- **Repeated testing required after each material change** → this compounds with A3.7 below and
  effectively freezes our release process.

### A3.3 — The permitted offline window, and the rules that attach to it · gate `G2d` — **highest value question in this brief**

> **Ask:** Is there a recognised offline or "store-and-forward" mode in the Certified Invoicing
> System rules? If so: (a) what may the counter print and hand over during an outage; (b) **what is
> the maximum permitted period before the transaction must be transmitted to the GRA**; (c) is
> there an obligation to notify the GRA of an outage, and within what period; (d) is the offline
> mode conditional on anything — a prior application, a device certificate, a transaction-value cap,
> a maximum number of offline transactions; and (e) what is the consequence of exceeding the window
> — is the sale invalid, is it a penalty, or is it simply late?

**Why it matters to the software.** This is the **hard architectural parameter** the whole system
turns on. Our product's foundational rule is that a counter trades fully offline for **hours or
days**. If the permitted window is 24 or 48 hours, "days" is outside it, and we must build an
explicit behaviour for what a till does when it has been dark longer than the law allows — which is
a rule we would have to be told, not one we may invent. We currently have no such behaviour, because
we did not know the window existed.

We have read secondary descriptions of an offline mode with a locally generated provisional QR code
and an obligation to notify the GRA of outages within 24 hours `[UNCONFIRMED]`. We have not been
able to confirm this against a primary source and we do not rely on it.

**What each answer changes.**

- **No offline mode at all** → Branch 2 in the decision table. The counter cannot issue a tax
  invoice offline, full stop.
- **Offline permitted, window ≥ 72 hours** → Branch 1. We build as designed and add outage
  notification. This is the outcome that costs us least.
- **Offline permitted, window < our realistic worst-case outage (say 24 hours)** → Branch 1b. We
  build as designed *plus* a hard, visible degradation at the boundary: the till must warn, then
  change what it issues. We need to know **what it must change to**, which is question A2 again.
- **Offline permitted but conditional (value cap, transaction count, prior application)** → each
  condition becomes a rule enforced at the till, and we need it stated precisely enough to code:
  a cap in cedis, a count, a duration.
- **A notification obligation exists** → someone at the business must actually do this during an
  outage. That is a staff procedure, not software, and the founder needs to know it exists. We can
  make the system *tell* a manager the obligation has been triggered; we cannot make it file.

### A3.4 — Must the GRA originate the invoice number? · gate `G2d` — **this decides whether the device may allocate a number at all**

> **Ask:** Is the unique VAT invoice number **issued by the GRA's system**, or is it generated by
> the taxpayer's system and merely validated by the GRA? If the taxpayer generates it: (a) must the
> series be strictly sequential and gapless; (b) may there be a separate series per outlet; (c) may
> a device hold a pre-allocated range of numbers and issue from it while offline; and (d) what is
> the required format or width?

**Why it matters to the software.** We have already built a mechanism where the **server issues a
block of numbers to each till in advance**, and the till consumes from that block with no network
at all — with gaps expected, reported, and a detection routine that catches a device reissuing a
number after its local storage is wiped. That mechanism exists, is tested against a real stack, and
**is worthless if the GRA must originate the number**, because a device that cannot reach the GRA
then cannot produce a number, and therefore cannot produce an invoice.

This question is a subset of A2, but it is the sharpest edge of it and the one an engineer can act
on immediately.

**What each answer changes.**

- **Taxpayer generates, GRA validates; gaps and per-outlet series permitted** → our existing block
  design is correct as built. Nothing changes. Best case.
- **Taxpayer generates, but the series must be gapless** → the block design is wrong. Gapless and
  offline-allocable are **mutually incompatible** when a device can be lost or wiped; we would need
  either a single online allocator (which breaks offline trading) or a documented reconciliation
  procedure for unissued numbers that the GRA accepts. We would need to know which.
- **Taxpayer generates but only one series per taxpayer, not per outlet** → 25 outlets sharing one
  strictly ordered series while offline is not achievable. We would need to know whether an
  outlet-prefixed series is acceptable.
- **The GRA originates the number** → **Branch 2, decisively.** No offline VAT invoice is possible.
  The counter issues a non-tax document and the invoice follows. This single answer would settle
  Brief A on its own.

### A3.5 — Required invoice fields, and which of them the GRA returns · gate `G2c`

> **Ask:** Please mark up the field list below. Which are mandatory, which conditional (and on
> what condition), which optional, which **must not** appear? Which of them are **returned by the
> GRA on clearance** rather than generated by us? Is a customer TIN mandatory on every invoice, or
> only above a threshold or only for registered customers? And what is the correct presentation of
> VAT, NHIL and GETFund — separately stated with each rate and amount, or combined?

**Our current working list — every row `[UNCONFIRMED]`, read 20 Aug 2026:**

*We believe we generate these:* supplier legal name, address and TIN · supplier VAT registration
number · customer name and TIN (conditional — **the condition is exactly what we need confirmed**) ·
unique sequential invoice number · date and time of supply · per line: description, quantity with
unit, unit price, taxable value · **VAT, NHIL and GETFund each shown separately with its rate and
amount** · document totals · currency.

*We believe the GRA returns these, and this is the part that matters:* clearance / SDC code ·
validation timestamp · invoice hash · QR code · digital signature or stamp.

**Why it matters to the software.** The division of that list into "we produce it" and "the GRA
produces it" **is** the offline question. If every mandatory field is locally derivable, an offline
invoice is at least physically possible. If even one is not, it is not — and no amount of
engineering changes that. We store this list as data, not as code, precisely because we expect it to
change on an administrative timescale.

One field-level detail we specifically need: our catalogue sells 59 of 219 items **by weight,
length or area** — sand by the ton, binding wire by the kilogram, cabling by the metre, rebar by
either the 12-metre length or the ton. So a line may read "2.5 tons". We need to know whether
quantity and unit of measure have a prescribed form.

**What each answer changes.** Every field you mark as GRA-returned is a field the counter cannot
print offline, which either pushes us to Branch 2 or requires the offline provision in A3.3 to
supply a provisional substitute. Every field you mark `conditional` needs its condition expressed
as a rule we can evaluate at the till (e.g. "if the customer is VAT-registered", "if the total is at
or above GH₵X"). Anything you mark **must not appear** is worth telling us explicitly — we would
otherwise never think to ask, and printing a prohibited identifier on a consumer receipt is the kind
of error nobody notices for a year.

### A3.6 — Retention · gate `G2c`

> **Ask:** For how long must VAT invoices, credit notes and the underlying transaction records be
> retained? In what form — is an electronic record sufficient, or must a printed copy exist? Must
> the record be held in Ghana, or is storage outside Ghana permitted? Is there a prescribed export
> or archive format the GRA may request?

**Why it matters to the software.** Two reasons, one boring and one not. The boring one: retention
sets our backup and archive policy and our storage costs. The one that is not boring: **our database
is hosted in the European Union**, because no major cloud provider has a West African region. If
Ghanaian VAT records must be retained *in Ghana*, that is not a settings change — it is a different
hosting decision, and it would need to be made before go-live rather than after. We hold this as
reportedly six years `[UNCONFIRMED]` and have confirmed nothing about the location requirement at
all.

**What each answer changes.**

- **Electronic retention, no location requirement** → nothing changes; we set the archive window.
- **Records must be held in Ghana, or a copy must be** → the hosting arrangement changes, or we add
  a Ghana-resident archive replica. Either way it is a decision with cost attached, and it is far
  cheaper before launch than after.
- **A prescribed export format exists** → we build the export now rather than discovering it when
  the GRA asks for one.

*(A related but separate question — whether hosting a Ghanaian company's books in Ireland raises
data-protection obligations under the Data Protection Act 2012 — is for a Ghanaian lawyer, not for
you, and we are tracking it separately. Mentioned only so you know we are not ignoring it.)*

### A3.7 — Do software changes require Commissioner-General pre-approval? · gate `G2d` — **the one that would constrain the deployment pipeline itself**

> **Ask:** Once a Certified Invoicing System is certified, must **any subsequent change** to that
> software be approved by the Commissioner-General before it is deployed? If so: what counts as a
> change requiring approval — any release at all, or only changes affecting invoicing logic? What
> is the approval process and its turnaround? Is there a lighter path for defect fixes and security
> patches?

**Why it matters to the software.** We have read that any change to a taxpayer's invoicing software
must be pre-approved by the Commissioner-General `[UNCONFIRMED]`. We have not confirmed it, and if
it is true as stated it is **structurally serious** — not a compliance checkbox but a constraint on
how the product is built and shipped. Our system is a web app that updates itself on the tills the
way a website does; that is how a security fix reaches 25 outlets in a country where nobody is going
to visit each till. A pre-approval requirement per release changes that model entirely.

**What each answer changes.**

- **No such requirement, or it applies only at initial certification** → our release process is
  unaffected. We proceed as designed.
- **Applies to changes affecting invoicing logic only** → we **separate the invoicing module from
  the rest of the application**, so that a change to stock reporting does not drag the invoicing
  code through an approval cycle. That is an architectural decision that must be made *before* the
  code is written, not retrofitted.
- **Applies to every release, with a multi-week turnaround** → continuous deployment ends. We move
  to scheduled, batched, pre-approved releases, we need an emergency path for security fixes, and
  the founder must understand that a bug found on a Monday may not be fixable until the GRA says so.
  **This must be confirmed before we design the deployment pipeline, not after.**

### A3.8 — Where the tax is rounded, and what base VAT sits on · gate `G2b` — **the cheapest question in this brief**

> **Ask:** With VAT, NHIL and GETFund all applied to the same base, is each tax computed and
> **rounded on every invoice line**, with the document tax total taken as the sum of those rounded
> line amounts — or is the tax computed against the document total and rounded once at the foot?
> Which rounding is required: half up, half to even, or truncation? And separately: are NHIL and
> GETFund **input-deductible** on the VAT return, and is VAT under the current regime computed on a
> base that includes them or excludes them?

**Why it matters to the software.** This is the only question in Brief A that changes the *numbers*
rather than the *documents*, and it is the one you are most likely to be able to answer without
approaching anyone. Our system holds money as whole pesewas and rounds **exactly once**, at a
boundary we must name in configuration — `line` or `document`. With three taxes sharing one base the
two choices give different totals: a pesewa or two per invoice, on every invoice, forever. An
invoice whose printed lines do not foot to its printed total is the kind of defect a contractor
notices before we do, and arguing it afterwards is worse than asking now.

Our current setting is **round at each line, then sum the rounded lines** — on no authority but our
own reading, which is exactly why we are asking. Input-deductibility does not change what is
printed, but it changes the VAT return and the ledger treatment, so getting it wrong is a filing
error rather than a printing one.

**What each answer changes.**

- **Round at the line, sum the lines** → nothing changes; we are already there. We would still like
  it confirmed explicitly rather than by silence.
- **Round at the document** → one configuration value, which the software already supports. No code
  change, but we must be told rather than assume.
- **A different rounding mode (half-even, truncation)** → same, one value.
- **VAT is *not* on the same base as the levies under the current regime** → our effective rate is
  wrong, and **every price and every invoice is wrong from the first day of trading.** That is why
  this also appears as row 3 of the table in A4 rather than being left implicit.

### A3.10 — Which of our goods are standard-rated, and which are not · gate `G2b` — **the question we forgot to ask, and it changes the price of every bag**

> **Ask:** Across a construction-materials range — cement, rebar, roofing sheets, sand and quarry
> aggregates, timber, plumbing and electrical fittings, paints, hand tools — are **all** supplies
> standard-rated under the current Ghanaian regime, or are any of them zero-rated, exempt, or
> subject to a different rate or scheme? We are particularly unsure about **unprocessed quarry
> products (sand, chippings, laterite)** and about any relief attaching to supplies to a
> **VAT-registered contractor** as opposed to a walk-in retail customer.

**Why it matters to the software, and why we are asking it late.** Our catalogue has **219 stock
items and every one of them is currently set to the standard rate.** That was a seed value nobody
ever confirmed, and it did not appear in the first version of this brief — which is the honest
reason it is numbered last. If any category is not standard-rated, then today we are **over-charging
the customer and over-declaring the tax** on every one of those lines.

Two further honesty notes, so you can judge how much weight our answer can carry:

1. Our per-item tax setting is currently **not actually consulted** when a line is priced — the
   system applies whichever rates are in force for the jurisdiction to every line regardless. So
   marking an item zero-rated today would change nothing on the invoice. That is a defect on our
   side and it is being fixed; we mention it because it means we cannot "just configure it" until
   we have, and because you should not assume a control exists that does not.
2. We are **not** asking you to classify 219 items one by one. Categories are enough — "everything
   on this list is standard-rated", or "these categories are not, here is the basis". We will map
   the items ourselves and send the mapping back for a sanity check if you want to see it.

**What each answer changes.**

- **All standard-rated** → we record your confirmation against the rate rows and nothing moves.
  This is the answer we expect, and we would still like it in writing rather than by silence.
- **Some category is zero-rated or exempt** → those items get their own tax code, the pricing path
  starts reading the item's code, and **every price already published for those items is wrong.**
  We would need to know from what date.
- **A relief depends on the customer's status rather than the good** → the tax code has to be
  resolved per sale rather than per item, which is a real change to how a counter rings a sale, and
  we would want to talk it through rather than infer it.

### A3.9 — Returns, cancellations and credit notes · gates `G2c` / `G2d`

> **Ask:** How is a sale reversed under the Certified Invoicing System? (a) Must a credit note
> itself be cleared by the GRA before it is valid, in the same way as an invoice? (b) May a credit
> note be issued at the counter while offline, or does it face the same restriction as an invoice?
> (c) May a cleared invoice be cancelled or voided at all, or must every correction take the form of
> a credit note against it? (d) Is there a period after which a sale may no longer be credited?
> (e) If the original invoice was never successfully cleared, what is the correct treatment of a
> return against it?

**Why it matters to the software.** A builder's merchant takes returns constantly — the wrong
diameter of rebar, cement bought in excess of the pour, roofing sheets found damaged on the truck —
and usually the same day, at the same counter, with the customer standing there. Our system today
records the sale and can reverse the stock, but it has **no credit-note document at all**, because
document issuance is the whole subject of this brief. If a credit note must itself be cleared, then
every restriction in A2 applies twice: during an outage the counter can neither issue the invoice
nor undo it, and a customer returning goods cannot be handed anything that settles the matter. We
would rather learn that now than build a returns workflow that turns out to be unlawful.

We have **no belief to offer here at all** — we did not research it, and we are not guessing.

**What each answer changes.**

- **A credit note is an ordinary document we issue and number ourselves** → we build it alongside
  the invoice on whichever branch A5 selects, and nothing further is needed.
- **A credit note must be cleared, like an invoice** → the returns workflow inherits the whole of
  Branch 2 even if invoicing does not. The counter can take the goods back and record it, but the
  document the customer needs arrives later — and we would need you to tell us what may be handed
  over at the counter in the meantime, exactly as in A2.
- **A cleared invoice may be cancelled within a period** → we need the period as a number of days,
  and cancellation becomes a distinct state in a document's life rather than a credit note.
- **There is a time limit on crediting a sale** → it becomes a rule enforced at the till, and it must
  be stated as a number of days, never as "reasonable".

---

## A4. What we believe today, and how confident we are

Every row is `[UNCONFIRMED]`. The "how we came by it" column is not a confidence in the *law* — it
is a signal to you about where our reading is most likely to be wrong, so you can spend your time
where it pays.

| # | What we currently believe | Status | How we came by it | Date read | If we are wrong |
|---|---|---|---|---|---|
| 1 | VAT standard rate 15% | `[UNCONFIRMED]` | GRA's own published VAT rates page and its notice to VAT-registered taxpayers | 2026-08-20 | Every price and every invoice is wrong from day one |
| 2 | NHIL 2.5%, GETFund 2.5% | `[UNCONFIRMED]` | Same | 2026-08-20 | Same |
| 3 | From 1 Jan 2026 all three apply to the **same base** (net), giving an effective 20% — attributed to the Value Added Tax Act, 2025 (Act 1151) | `[UNCONFIRMED]` | Same | 2026-08-20 | Every invoice total is wrong. This is the single highest-volume arithmetic in the system |
| 4 | Under the **prior** regime VAT was charged on a base that already included the levies, giving an effective 21.9% | `[UNCONFIRMED]` | Secondary summaries | 2026-08-20 | Only affects a future tenant with pre-2026 history. **Not urgent — do not spend time here** |
| 5 | The COVID-19 Health Recovery Levy (Act 1068) is repealed with effect from 1 Jan 2026 | `[UNCONFIRMED]` | Reported, secondary | 2026-08-20 | We would be omitting a levy we must charge |
| 6 | The VAT Flat Rate Scheme is abolished under Act 1151 | `[UNCONFIRMED]` | Reported, secondary | 2026-08-20 | Changes which scheme this business is on |
| 7 | The registration threshold for suppliers of goods rose from GH₵200,000 to GH₵750,000 | `[UNCONFIRMED]` | Reported, secondary | 2026-08-20 | Doesn't change this business's answer — planned revenue is GH₵2,640,000, far above either. **We need the registration status and date, not the threshold** |
| 8 | Act 1151 does **not** enumerate invoice fields; it requires a tax invoice "in the form and with the particulars prescribed by the Commissioner-General", issued through a **Certified Invoicing System** integrated with the Commissioner-General's system | `[UNCONFIRMED]` | Reading of the Act as reported | 2026-08-20 | The field list would come from somewhere else, and we are asking the wrong body |
| 9 | **Ghana operates a clearance model** — an invoice from the taxpayer's own system is not a valid VAT invoice until the GRA clears it and returns a clearance/SDC code, QR code and digital signature | `[UNCONFIRMED]` | Reading of GRA E-VAT material and secondary summaries | 2026-08-20 | **This is the belief the entire brief rests on.** If it is wrong, most of Brief A dissolves and we build as originally designed |
| 10 | An offline mode exists with locally generated provisional QR issuance and an obligation to notify the GRA of outages within 24 hours | `[UNCONFIRMED]` | **Secondary sources only — we could not confirm this and place little weight on it** | 2026-08-20 | Could go either way, and this is exactly why we are asking A3.3 |
| 11 | CIS onboarding involves application to the GRA, API integration and Joint User Acceptance Testing before certification — a lead time in months | `[UNCONFIRMED]` | Secondary | 2026-08-20 | If shorter, we have runway. If longer, the opening date is not ours to set |
| 12 | Any change to a taxpayer's invoicing software must be pre-approved by the Commissioner-General | `[UNCONFIRMED]` | **Secondary, single source, uncorroborated — the weakest claim here and the most consequential if true** | 2026-08-20 | Determines whether we can ship software normally at all |
| 13 | Retention of records is six years | `[UNCONFIRMED]` | Secondary | 2026-08-20 | Archive policy; and see A3.6 on location |
| 14 | **How returns, cancellations and credit notes work under the clearance regime** | **Not researched — we hold no belief at all** | We did not look, and we are not guessing | — | See A3.9. Recorded as a known gap rather than an assumption, so it is not mistaken for something we checked |

**We have verified none of this.** Our knowledge of anything that changed in the three months before
20 August 2026 is incomplete, and Ghana's VAT rates and e-invoicing rules have changed materially
more than once in the recent past. Please correct the table rather than working around it.

---

## A5. The decision table — what the software does for each answer

This is why the question is worth your fee. Each branch is a different product.

| | **Branch 1 — offline invoicing permitted** | **Branch 1b — permitted, but a short window** | **Branch 2 — clearance required before issue** |
|---|---|---|---|
| **The answer that selects it** | Taxpayer generates the number; deferred transmission permitted within a window longer than a realistic outage (≥72h); all mandatory fields locally derivable | As Branch 1, but the window is shorter than our worst-case outage (e.g. 24h) | GRA must clear the invoice, and/or GRA originates the number, before a valid tax invoice exists |
| **What the customer is handed at the counter** | A **VAT invoice**, complete, printed at the till | A VAT invoice — until the window expires, then a non-tax document | A **proforma invoice or delivery note**, clearly marked *not a tax invoice* |
| **When the VAT invoice exists** | At the counter | At the counter, within the window | On reconnect, after GRA clearance |
| **How the customer gets the tax invoice** | They already have it | Mostly at the counter | Printed on next visit / collection, or sent by SMS, WhatsApp or email |
| **Document model** | One document type | One document type plus a fallback | **Two document types**, with a linkage between them, a state machine (issued → submitted → cleared → failed), and a rule for what happens when clearance is *refused* after the customer has left with the goods |
| **Invoice numbering** | Our existing pre-allocated per-device block design stands as built | Stands, plus the fallback series | Block design **does not apply to tax invoices**. The counter numbers only the proforma; the invoice number comes from the GRA |
| **Returns and credit notes** | A credit note is a document like any other: issued and numbered at the counter | As Branch 1, within the window | Depends on A3.9, which we cannot even guess at. If credit notes must be cleared too, **a return during an outage cannot be settled at the counter either** |
| **Counter workflow** | Unchanged | Unchanged plus a visible warning state | **Changed.** Staff must explain to a contractor that the document in their hand is not yet their VAT invoice — a real conversation, 40+ times a day, by staff who are new |
| **Customer expectation** | Normal | Normal | **Materially different**, and it affects a contractor's own input-tax claim. The founder needs to plan for this commercially, not just technically |
| **Build impact** | None — proceed | Small: window enforcement, warning UI, outage notification prompt | **Large.** New document type, new state machine, new print templates, new delivery path, new failure handling, new staff training. Weeks, and it must be decided before POS work continues |
| **What we would need from you in addition** | The window, and the outage-notification rule | The window in hours, and what must be issued past it | The permitted substitute document, what it must and must not say, and the maximum period before the tax invoice must follow |

**Two further branches that cut across all three:**

| | **The number question (A3.4)** | **The deployment question (A3.7)** |
|---|---|---|
| **If the answer is favourable** | Taxpayer generates → our block design is correct, nothing changes | No pre-approval → we ship software normally |
| **If it is not** | GRA originates → **Branch 2 is forced regardless of anything else in this table** | Pre-approval per release → continuous deployment ends; invoicing code must be separated from everything else, and that separation must happen **before** the code is written |

---

## A6. What we are **not** asking

To keep this engagement narrow, cheap and quick to scope, please note what is **out of scope**:

- We are **not** asking you to advise the company on its tax affairs, its structure, or its planning.
- We are **not** asking you to prepare, review or file any return.
- We are **not** asking for an opinion on whether the company should register, or when — only for
  confirmation of its **registration status and registration date** as a matter of fact.
- We are **not** asking you to certify, endorse or take responsibility for our software.
- We are **not** asking you to compute anything. The software computes VAT; we want to know the
  rules it must compute *against*.
- We are **not** asking about payroll. Our system deliberately contains **no** PAYE brackets, no
  SSNIT rates and no withholding logic of any kind, and it never will. It exports a payroll register
  and imports back whatever figures the payroll professional returns. That boundary is fixed and is
  not up for discussion.

**We are asking for the rules.** Which document may be handed to a customer at a counter with no
network, what it must say, and what must follow it. That is the whole of Brief A.

**And three questions we deliberately routed elsewhere** — listed so the founder can see they were
considered rather than forgotten, and so this engagement stays narrow:

| Question | Where it went, and why it is not here |
|---|---|
| Whether hosting a Ghanaian company's books in Ireland raises obligations under the Data Protection Act 2012 (Act 843) | A Ghana-qualified **lawyer**, not you. Tracked internally as `Q13`. Kept out so this stays a tax engagement — though it is adjacent to A3.6, so if you happen to know, say so |
| Whether the business plan's GH₵2,640,000 first-year revenue is stated **gross or net of VAT** | The **founder and whoever prepared the financial model**. Tracked as `Q15`. It moves a reporting baseline, not a rule the software must obey, so it is not worth your fee |
| **Opening balances** at go-live — stock, debtors and creditors carried in on day one, and who signs that they are right | The accountant who will later review the **chart of accounts** — a separate, larger engagement (`Q6`, `Q20`). Mentioned only because the founder may prefer to use the same person, and it is cheaper to say so now |

## A7. Suggested shape of the engagement

1. **You review §A3 and §A4** and mark up what you can answer directly — the rate set, the base,
   the registration facts, the field list. Perhaps an hour.
2. **You tell us which questions must go to the GRA.** Our reading is that A3.1, A3.2, A3.3, A3.4,
   A3.7 and probably A3.9 do; A3.5, A3.6 and A3.8 may not. **A3.8 needs nobody but you**, so please
   do not let it wait behind the GRA.
3. **You approach the GRA on those.** This is the long pole and we would like it started before
   anything else — including before you complete step 1, if that is possible.
4. **You send back a written note** naming the instruments. Bulleted is fine.

We will hand you two extracts from our technical documentation to mark up directly if that is
easier than working from this brief: our encoded rate table and our working invoice-field list
(`docs/architecture/sections/07-jurisdiction-and-compliance.md`, §7.4.1–§7.4.3).

---
---

# BRIEF B — The credit facility fee

Second question, lower urgency, same engagement. This one may need a Ghana-qualified **lawyer**
alongside you; please tell us if you think it does.

## B1. What the business does today

The business sells to contractors on credit — typically 30 to 60 day terms — and intends to charge
**2% to 3% per month** on credit balances. The financial model does not include this fee as revenue
at all; the business treats it as upside. Our software will compute, track and post it, and we have
built the mechanism so that every parameter below is configurable. **We have not chosen any of the
parameters**, and the system is built to refuse to post the fee to the accounts until a named human
confirms them.

## B2. The one question

> ### Is a charge of 2–3% per month on customer credit balances lawfully chargeable by a construction-materials trading company in Ghana as structured — and what is the correct characterisation of it?

Specifically: is it best treated as a **late-payment or facility fee**, as a **price differential
between cash terms and credit terms**, or does it amount to **the extension of credit at interest**
in a way that engages lending, moneylending or consumer-credit regulation and any licensing that
attaches to it?

**The arithmetic we can state, because it is arithmetic and not advice:** compounded monthly,
**2%/month is an effective 26.8% per year and 3%/month is 42.6%** (1.02¹² − 1 and 1.03¹² − 1). Even
simple, uncompounded, it is 24% and 36% per year. We state this only because a monthly percentage
can read as small and an annual one does not, and the person answering should see both. **Whether
that rate is lawful, and under what characterisation, is entirely your question and not ours.**

## B3. The sub-questions

Our software has a configuration switch for each of these, with a **provisional default** so the
mechanism could be tested. The defaults are placeholders chosen by engineers to make code runnable.
**They are not recommendations and should be overridden without hesitation.**

| # | Decision | The options we can implement | Provisional default | Why it is not ours to pick |
|---|---|---|---|---|
| **B-1** | **What the fee accrues on** | (a) the outstanding balance from invoice date · (b) **only the overdue balance**, after terms lapse · (c) the drawn amount or peak exposure | (b) overdue only | This changes what the charge **is**. Accruing from invoice date makes it a charge for the use of money — the reading most likely to engage lending regulation. Accruing only once payment is late makes it a late-payment charge. **This is the core of B2 and the most important row in this table** |
| **B-2** | **Simple or compounding**, and whether an unpaid fee itself attracts fee | simple / compounding; fee-on-fee on or off | simple, no fee-on-fee | Compounding raises the effective rate above the figures in B2 and sharpens the same question. It is also very hard to explain to a contractor at a counter |
| **B-3** | **Day-count**, and what a "month" means for an invoice paid mid-month | 30E/360 pro-rata · actual/365 · whole calendar month with no pro-rating | 30E/360 pro-rata | Whole-month charging means an invoice one day late pays a full month's fee. That is a commercial and possibly a legal posture, not an engineering preference |
| **B-4** | **Posting cadence** | daily · monthly at close · on settlement | accrue daily internally, post monthly at close, plus a final accrual on settlement | Daily postings produce thousands of journal entries a month and an unreadable ledger; monthly means the ledger trails reality intra-month. Which trade-off the accounts want is yours |
| **B-5** | **Which account, and whether the fee sits inside revenue** | fee income within revenue · other income (finance) · offset to finance cost | a separate income account **outside** the revenue line used for gross margin | See below |
| **B-6** | **Is the fee a taxable supply?** *(this is `Q18` and it is a distinct question)* | standard-rated · exempt · outside scope | **deliberately left unset — the system refuses to post the fee until it is set** | Financial services have their own VAT treatment. The fee line carries a tax code like any other line and we will not guess it |
| **B-7** | **Disclosure and contract** | — | none assumed | Is there anything that must be disclosed to the customer, in writing, before or at the point the charge arises? Does the answer differ between a **contractor buying for business** and a **walk-in individual**? We would rather build the disclosure into the document now than add it later |

**On B-5 specifically, because it silently moves a number the whole business plan is built on.** The
financial model tracks blended gross margin to three decimal places (19.325% rising to 24.500%) and
the software is required to report actual margin against that curve. Facility fee income has **no
cost of goods behind it.** Post it inside revenue and reported gross margin rises without a single
extra bag of cement being sold — the margin improvement would look like it was working when it was
not. So whatever you decide about presentation in the statutory accounts, **our margin report will
exclude facility fee income from its revenue denominator and will say so on its face.** We are
telling you what we have done, not asking permission; but if it conflicts with how you want the
accounts presented, tell us and we will carry both.

## B4. What we believe today, and how confident we are

| # | Claim | Status | Note |
|---|---|---|---|
| 1 | 2%/month compounds to 26.8% annually; 3%/month to 42.6% | **Arithmetic, not a claim about law** | Verifiable in one line. Stated so the annual figure is visible |
| 2 | The business intends to charge 2–3%/month | From the business's own plan | The founder should confirm which, and whether it varies by customer |
| 3 | Whether this engages lending or moneylending regulation in Ghana | `[UNCONFIRMED]` — **we have not researched this at all and will not** | Out of our competence entirely. **Flagged, never answered** |
| 4 | Whether the fee is a taxable supply | `[UNCONFIRMED]` — not researched | `Q18`. The tax code ships unset and the accrual refuses to post until you set it |
| 5 | The financial model excludes this fee entirely | Confirmed internally | So whatever is decided, no plan figure moves — this is upside either way |

## B5. The decision table — what the software does

| If the answer is… | What the software does |
|---|---|
| **Late-payment charge, overdue balance only, as structured** | We set B-1 to (b) and ship. This is what the mechanism is already built and tested for. Nothing changes |
| **Chargeable, but only from invoice date / on the outstanding balance** | We set B-1 to (a). One configuration value; no code change. Revenue from the fee rises by a multiple, and the founder should see the new figure before agreeing to it |
| **Chargeable, but the rate must be lower, or capped** | The rate is a configurable value per customer account and per policy. One edit |
| **Better structured as a cash/credit price differential** | **This is a different build.** The charge stops being a fee posted against an invoice and becomes **two prices on the price list** — a cash price and a credit price. That is a pricing change, not an accounting one; it touches what the counter displays and what the customer is quoted. Not huge, but it is not a settings change either. **We would need to know this before the pricing work is finished** |
| **It engages lending or moneylending regulation** | Not a software question. The business either obtains whatever authorisation applies, or restructures the charge, or drops it. We would need to be told which, and we would set the fee rate to zero in the meantime — the mechanism stays, dormant and auditable |
| **The fee is a taxable supply at the standard rate** | We set the fee account's tax code. The accrual then posts. One edit |
| **The fee is exempt or outside the scope of VAT** | Same — one edit, different code. **But we will not guess it**, so this genuinely blocks credit go-live until answered |
| **Disclosure is required (B-7)** | We add it to the printed credit invoice and the statement template. Cheap now, awkward later |

## B6. What we are **not** asking in Brief B

- We are **not** asking whether the business *should* charge the fee, or at what rate. That is a
  commercial decision for the founder.
- We are **not** asking you to model the revenue. The software will report the actual figure.
- We are **not** asking for a view on the customers' side of it.
- We are **not** asking you to draft credit terms or a customer contract — though if you think one
  is needed, saying so is useful.

We are asking: **what is this charge, legally, and what must be true for it to be charged?**

---
---

## Appendix — cross-references, for our own records

| Gate | Question | Blocks | This brief |
|---|---|---|---|
| `G2a` | VAT registration status and date | Phase 1 POS go-live | A3 preamble, A4 row 7 |
| `G2b` | Rate set as encoded: rates, base composition, input-deductibility, **rounding level** | Phase 1 POS go-live | **A3.8**, A4 rows 1–5 |
| `G2c` | Invoice/receipt field list; retention; credit notes | Phase 1 POS go-live | A3.5, A3.6, A3.9 |
| `G2d` | **E-VAT clearance model: CIS onboarding, JUAT, offline window, number origination, software pre-approval** | **Phase 1 POS *design*** | A2, A3.1–A3.4, A3.7 |
| `G3` | Credit facility fee structure | Phase 1 credit go-live | Brief B |
| `Q18` | Is the facility fee a taxable supply | Phase 1 credit go-live | B-6 |

Source documents this brief was compiled from, for anyone checking our working:
`docs/architecture/sections/07-jurisdiction-and-compliance.md` §7.4 (the clearance collision) and
§7.7 (the gate list) · `docs/architecture/sections/03-offline-sync.md` §3.7.5 (offline number
allocation) and §3.10 concern 3 · `docs/architecture/sections/06-customer-credit.md` §6.4 (the five
fee decisions) · `docs/open-questions.md` Q4, Q5, Q8, Q13, Q15, Q18, Q20 · `docs/decisions/ADR-0002` (tax
computed at the POS, rates as effective-dated data) · `docs/decisions/ADR-0007` (jurisdiction packs).

---

## Appendix — a covering note the founder can send as-is

> Dear [name],
>
> I am opening a construction-materials outlet in Techiman and we are building the point-of-sale
> and stock system for it ourselves. Two questions have come up that need a qualified person, and
> my software team has written them up rather than guessing.
>
> **The urgent one:** our outlets will regularly have no internet for hours or days. We need to
> know whether a VAT invoice can be issued to a customer at the counter while the till is offline —
> and if not, what we may hand the customer instead and how long we then have to issue the invoice.
> My team's reading is that Ghana requires the GRA to clear an invoice before it is valid, which
> would mean we have to build the system quite differently. They may be wrong, and they say so.
> Some of this probably has to be asked of the GRA directly, which is why I would like to start now.
>
> **The second one, less urgent:** we intend to charge 2–3% per month on overdue contractor
> accounts and need to know how that should properly be structured and treated.
>
> The attached document sets out both questions in detail, including what my team currently believes
> and how confident they are (not very). There is also one small question in there (§A3.8, about how
> the tax is rounded on an invoice) which they think you can answer in minutes and which they would
> like settled early, because it affects every invoice we will ever print. **We are not asking for tax advice on the company's
> affairs** — only for the rules, so the software is built against the right ones. It should be
> quick to scope.
>
> Please tell me what you need to answer these and what it will cost.
