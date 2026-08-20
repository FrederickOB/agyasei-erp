# Phase 0 — Architecture Document

**Status: DRAFT, awaiting explicit human approval. The build stops here.**

**Version:** 1.0 (post-review) · **Date:** 2026-08-20 · **Owner:** `product-manager`
**Constitution:** [`CLAUDE.md`](../../CLAUDE.md) — outranks everything in this document
**Decisions:** [`docs/decisions/`](../decisions/) · **Open items:** [`docs/open-questions.md`](../open-questions.md)

---

## 1. What this is, and what happens next

`CLAUDE.md` §3 requires an architecture document **before any application code exists**, and then
requires the build to stop and wait. This is that document. It is nine specialist sections plus this
spine, and it covers what the constitution asks for: the tenancy model, the data model, the sync
approach *with its written justification*, conflict detection and human surfacing, chart-of-accounts
templating and posting rules, jurisdiction-pack design, and a rollout plan with a pilot, success
criteria and a rollback.

**Nothing here is code.** There are no `.ts`, `.sql` or `.json` files in this deliverable. The DDL,
YAML and type signatures inside the sections are illustrative — they exist so the design is concrete
enough to be argued with, and several of them were argued with successfully (§9 below).

**What approval means is in §8.** In short: approving this authorises Phase 1 to begin, at one
location, against the five acceptance criteria in `CLAUDE.md` §3. It does not authorise Phase 2, and
it does not close any question marked `NEEDS-HUMAN`.

**Honest framing before you read further.** Three of the nine sections were put through an
adversarial review. That review produced 84 findings, of which **none were rejected as wrong** — six
were blocking defects that would have lost real sales or misstated real books. The sections were
then revised. The uncomfortable inference is the one worth stating: *the other six sections have not
been reviewed to that standard, and there is no reason to think their defect density is lower.*
Section 9 of this README says what to do about that.

---

## 2. Executive summary

*Written to be read by the founder as well as by an engineer. Where a term is unavoidable it is
explained once.*

### Two constraints shape everything

**One: this is a product with many tenants, and a leak between them is unrecoverable.** Agyasei Jnr
& Company Limited is tenant #1 and the pilot, not the customer we are building *for*. Other
distribution businesses will run on the same platform, and their books, margins and customer credit
positions sit in the same database. If tenant A's data ever reaches tenant B, we cannot take it
back — and because data syncs down to tablets in district towns, "take it back" would mean reaching
onto hardware we do not control. So tenant separation is not a feature with a test; it is a property
the schema is built to make **impossible to forget**. Every table carries a `tenant_id`. Every table
is emitted by one factory that also emits the database's own row-level security policy. A foreign
key from one tenant's row to another tenant's row is not a bug that gets caught in review — it is a
constraint violation the database refuses to write. A CI check reads the live catalogue and fails
the build if any table deviates.

**Two: outlets trade where the network is not.** A community outlet in Bawku may be offline for
hours or days. Offline operation is not a feature of this system; it is the reason this system
exists rather than any conventional cloud ERP. Everything follows from that. Sales are written to a
database *on the tablet* and queued; the counter never waits for a server. Nothing is ordered by the
tablet's clock, because tablet clocks in the field are wrong — sometimes by years. Stock is not a
number that gets overwritten; it is a list of movements that add up, so two outlets that both sold
the last three bags while partitioned produce two rows that sum correctly instead of one write
destroying the other. And where two people genuinely disagree — the canonical case is two managers
setting different credit limits for the same contractor while both offline — the system does not
pick a winner. It reverts to the last value both of them agreed on, gates the till at that value,
and puts the decision in front of a named human with the customer's balance and payment history
attached.

### How the pieces fit

A **PWA** — a web app installed on the tablet like an app — holds a local SQLite database and talks
to **PowerSync**, which streams down only the rows this device is entitled to and holds up a durable
queue of writes going back. Writes do **not** go through PowerSync; they go to our own Node API,
which stamps the tenant from the signed token, deduplicates, detects conflicts and writes to
Postgres. That split is the whole reason PowerSync was chosen over the alternatives: it takes the
two problems that are genuinely hard to get right under partition (which rows reach which device;
a write queue that survives a week and an app upgrade) and leaves us the one we must own anyway
(what a write *means*).

**Money is never a decimal.** Every amount is an integer count of pesewas, in `bigint`, in both the
database and TypeScript. Quantities too — 2.5 tonnes of sand is as dangerous as GH₵2.50 if it is a
float. Unit prices get their own scale, because GH₵2.375 per metre is a real shelf price. Every
point where an exact number becomes an inexact one is enumerated, with the rule and where the
leftover pesewa lands.

**The ledger is real double-entry, enforced by Postgres, not by our code.** Entries balance — and
they balance *per location*, not merely in total, which costs two extra lines on every
cross-location transaction and is what makes a per-outlet balance sheet something other than
fiction. Posted entries cannot be edited; corrections are reversing entries. Tax is a liability, not
revenue. VAT rates live in a dated table, so reprinting a receipt from before a rate change
reproduces the original figures.

**Statutory payroll is not computed, in any jurisdiction, ever.** The system captures hours, gross
pay and commission, exports a register, and imports the bureau's figures into clearly-marked fields.
The database enforces it: a statutory figure cannot exist without an import that produced it. This
is categorical — a *configurable* withholding table is still prohibited, because a stale VAT rate is
visibly wrong on a receipt handed over today, while a stale PAYE figure is silent until someone
else's filing deadline.

### What this design does not solve

Three things, stated here rather than discovered in month four.

**A customer's credit limit cannot be enforced across the network while outlets are offline.** Two
outlets can each sell within their local allowance and jointly exceed the limit. Nothing fixes that;
it is arithmetic. What the design does is bound the exposure (each location gets a capped
allowance), record every breach with each device's belief at the time, and refuse to let the till
claim a check it did not make. **True maximum offline exposure is the sum of the location caps, not
the customer's limit** — and choosing those caps is a risk decision for the business, not a default
we get to pick.

**A device offline for D days can place a transaction anywhere within those D days.** The business
date comes from a human opening the till, which is better than the tablet's clock and is now
constrained to one calendar day with an auto-close — but it is still a human input. We can detect
anomalies; we cannot prevent it. Whether that is tolerable at a statutory period end is an
accountant's call (Q-SEC-2).

**Ghana may not permit an offline invoice at all.** This is the largest unresolved risk in the
document and it is §5 below.

---

## 3. The decisions, consolidated

Seven ADRs, already accepted, not reopened by this document. Each links to the full record.

| ADR | Decided | Main consequence |
|---|---|---|
| [0001](../decisions/ADR-0001-logistics-model.md) — Logistics | **Third-party hauliers only.** No vehicle, driver, fuel or maintenance entities. A carrier is a contracted haulier. | Phase 2 is materially smaller. But the financial model's Lever 3 credited an *owned fleet* for distribution cost falling 5.0% → 2.5%, so **that target now has no mechanism behind it** (Q1). Hauliers become suppliers with a HAULAGE capability, which puts the spend in AP where the metric can actually be measured. |
| [0002](../decisions/ADR-0002-tax-handling.md) — Tax | **VAT and levies computed at the POS**, every rate in an effective-dated table, never a constant. | A rate change is an admin edit, not a deployment; an old receipt reprints exactly. **Refined by §7:** the tuple `(tax_code, rate, effective_from, effective_to)` cannot represent what Ghana did on 1 Jan 2026 — the *base* changed and no rate did — so it needs `base_kind`, `base_includes`, `rounding_level`, `rounding_mode`. That refinement should be written into the ADR. |
| [0003](../decisions/ADR-0003-hosting-and-client.md) — Client & hosting | **Installable PWA** on low-end Android; **managed Postgres in `eu-west`**. | One artefact updates 25 outlets with no app-store round trip — which matters when a tax fix must reach every counter today. Costs: receipt printing is the known weak point, and §8 and §9 add **two more** — no hardware-backed key storage, and no encryption story for the local database. All three go into one Phase 1 hardware trial so the native-Android question is reopened once or not at all. Latency is 150–300 ms in practice, not the 90–130 ms fixed-line figure. |
| [0004](../decisions/ADR-0004-money-representation.md) — Money | **Integer minor units**, `bigint` in Postgres and TypeScript. Never float, never `numeric`, never `number`. | Arithmetic is exact and totals reconcile. Quantities get the same discipline. **One gap:** the ADR does not name a *rate* scale, and unit prices genuinely need sub-pesewa precision; §4 introduces `rate_e4` consistently with the ADR's own treatment of percentages. **The ADR should gain one line saying so** rather than leaving the next reviewer to decide whether §4.6 is a violation. |
| [0005](../decisions/ADR-0005-multi-tenancy.md) — Multi-tenancy | **Shared schema, `tenant_id` everywhere, RLS, tenant-scoped sync rules.** Tenant → database mapping exists from day one. | Cheapest to operate; one migration, one sync service. But isolation now depends on discipline, so it is enforced structurally. **Narrowed by §1, §2 and §4:** *RLS does not apply to logical replication*, which is how the sync service reads Postgres — so on the one path where data leaves the server for a stealable device, there is **one layer, not two**. See risk 2. |
| [0006](../decisions/ADR-0006-product-vs-tenant-configuration.md) — Product vs tenant | **The platform ships generic; Agyasei's setup ships as a template.** Applied once at onboarding to create ordinary editable rows. No code path reads a tenant's identity. | Onboarding becomes a first-class capability, and the pilot doubles as proof the template mechanism works. The review found four places where tenant #1's vocabulary had leaked into platform logic anyway — an escalation chain of role names, "this is Ghana" as a notification rule, a hard-coded receipt format, and Ghanaian payroll columns in platform DDL. All four are fixed. The leak is subtle and recurring; it needs a standing line on the review checklist. |
| [0007](../decisions/ADR-0007-jurisdiction-packs.md) — Jurisdiction | **Ghana only, pluggable by design.** A tenant belongs to exactly one jurisdiction; FX in the ledger is out of scope. | Adding Nigeria later is a pack, not a refactor — *if* the pack is complete. §7 gives the decision procedure for when someone is tempted to write `if (country === 'GH')`, plus a CI "smoke pack" (a fictional jurisdiction with 1000 minor units and one tax code) which should **be** the second tenant that Phase 1 acceptance criterion 5 already requires. |

---

## 4. Reader's guide

Nine sections. Read §1 and §3 first if you read only two — they carry the two constraints everything
else follows from.

| § | Section | Covers | Read it if you are |
|---|---|---|---|
| 1 | [Tenancy and isolation](sections/01-tenancy-and-isolation.md) | Tenant lifecycle and suspension as timestamp-driven decay; the three layers that make `tenant_id` unforgettable; tenant → database placement; templates and why there is no live inheritance; export and deletion on a shared schema; onboarding | deciding whether this is safe to run as a multi-tenant product |
| 2 | [Security and access control](sections/02-security-and-access-control.md) | The token; composable tenant-owned permissions; location scope via a closure tree; the two hard prohibitions (no price override, no credit-limit change at counter level); device enrolment, revocation, and the offline session lease | reviewing who can see and do what, and what a stolen tablet is worth |
| 3 | [Offline-first sync](sections/03-offline-sync.md) | **The framework choice and its written justification** (PowerSync, with ElectricSQL, Zero, Couchbase, Ditto and Firestore compared and rejected); sync rules as the isolation boundary; idempotency; hybrid logical clocks; a 19-row conflict taxonomy; the human review queue | an engineer — this is the section most likely to be wrong in a way nobody notices for six months |
| 4 | [Core data model](sections/04-data-model.md) | The universal row; **the resolution of Q7** (dual units of sale, rational conversion factors, `13500/d²` bars per tonne); catalogue, pricing, the stock movement ledger, sales, credit and payroll spine; every rounding point enumerated | implementing anything, or checking that rebar sold by the tonne will reconcile |
| 5 | [General ledger](sections/05-general-ledger.md) | Double-entry enforced in Postgres twice; **per-location balancing**; immutability and reversal; the chart of accounts as a template; every posting rule with worked amounts; bank and mobile-money reconciliation; the payroll boundary; budget vs actual | the reviewing accountant — this is the section §2.8 requires you to sign |
| 6 | [Customer credit](sections/06-customer-credit.md) | Policy / account / entry; exposure derived from an append-only log; ageing by days-past-due; the facility fee's engineering settled and its five revenue-recognition decisions gated on a human; both offline conflict cases | assessing the credit book, or answering Q4 |
| 7 | [Jurisdiction and compliance](sections/07-jurisdiction-and-compliance.md) | The pack as a two-layer applied artefact; currency scale traps; **why a reprint reads a snapshot, never a rate lookup**; the Ghana pack; the e-invoicing clearance collision; the payroll boundary argued two ways; nine named human gates | a tax professional, or anyone who thinks jurisdiction is a country rather than a country *and a date* |
| 8 | [Client architecture](sections/08-client-architecture.md) | Three hard launch gates; local-only cart tables; money read as `CAST(col AS TEXT)` → `BigInt()`; **four offline states, not two**; the counter flow; the receipt-printing spike with numeric pass criteria; performance budget | building the app, or buying the hardware |
| 9 | [Infrastructure and rollout](sections/09-infrastructure-and-rollout.md) | Hosting and the latency trade-off stated in full; environments; **expand–migrate–contract migrations against a device fleet that may be weeks behind**; monitoring a location that emits nothing when it is dark; backups and restore drills; the pilot, release rings and the rollback runbook | operating this, or deciding whether the pilot plan is honest |

---

## 5. Cross-cutting risks

Ranked by what happens if we are wrong. Each says why it is hard and what the design actually does —
including, twice, "nothing yet".

### R1 — Ghana's e-VAT invoicing may make offline invoice issuance impossible as designed
**Severity: highest. Mitigation: none. Blocks Phase 1 POS *design*, not just go-live.**

On the sources §7 read, an invoice is not a valid VAT invoice until the GRA returns a clearance
code, a QR code and a digital signature. **That collides head-on with the constitution's requirement
to trade fully offline for days**, and `ADR-0002` does not acknowledge it because some required
fields are not locally derivable.

Why it is hard: it is not a technical problem we can engineer around. If GRA must originate the
number, the counter issues a proforma or delivery note offline and the VAT invoice on reconnect —
a different document model, a different workflow, different customer expectations. There is also an
unconfirmed claim that software changes need Commissioner-General pre-approval, which would
constrain the PWA deployment pipeline itself.

What the design does: nothing yet, deliberately. §7 documents the collision, splits "the accountant
confirms the Ghana pack" into four gates with different owners and lead times, and marks `G2d` as
the item with months of lead time. **This is `Q8` and it is the item most likely to move the
1 August 2026 launch.**

### R2 — On the sync path, tenant isolation has one layer, not two
**Severity: unrecoverable if it fails. Mitigation: strong but singular.**

`ADR-0005` and `CLAUDE.md` §2.1 both present RLS as the backstop that makes a forgotten predicate
fail closed. For application queries that is exactly right. **For logical replication — which is how
the sync service reads Postgres — it is false.** Postgres publication row filters cannot help,
because a filter is static and cannot reference a per-connection tenant. So on the one path where
data actually leaves the server for a device that can be stolen, the sync rules are the whole
control, and they are configuration.

What the design does: the tenant claim comes only from the signed JWT and `request.parameters()` is
banned by a CI lint rule; every data query repeats the tenant predicate even when the bucket key
implies it; rules are generated from the same tenant contract as the RLS policy; and a **two-tenant
device-level leak test** runs in CI on every rule change. Those controls are load-bearing, not
belt-and-braces. **If they are ever allowed to be flaky or skipped, this has no backstop at all** —
which is why §2 asks for that sentence to be added to `ADR-0005` rather than left in a section.

### R3 — The tablet is the weakest link, in two independent ways
**Severity: high (data loss) and high (disclosure). Mitigation: partial. Both go into one Phase 1 trial.**

**Eviction.** The PWA's local SQLite lives in OPFS under a browser storage quota. A browser under
storage pressure may delete it — taking unsynced sales with it. No sync engine can defend a queue
the browser deletes. Mitigations: request persistent storage at install and **refuse the counter
role on a device that does not have it**; monitor quota headroom; keep the sync window tight. Those
are real but partial, and the honest position is that it must be tested on representative low-end
hardware.

**Encryption at rest.** There is no supported encryption story for WASM SQLite over OPFS, and any
key the PWA could hold lives in the same origin storage as the data — theatre, not protection. RLS
protects nothing already on a device, and an offline device cannot be remotely wiped. Mitigations:
data minimisation (the credit book is not on a till — only a bounded per-location allowance), an app
lock with a short idle timeout, local-database destruction after N failed unlocks or an unrenewable
token, and Android Enterprise managed devices with enforced screen lock and full-disk encryption.
That last one is a procurement decision, not an engineering one.

§8 argues encryption is the larger long-term risk and §9 agrees; both still back the PWA. **It
should be a recorded, accepted risk with a named owner, not a security-review discovery.**

### R4 — Receipt printing may not work on a PWA
**Severity: blocks the counter. Mitigation: a scheduled spike that gates procurement.**

Web Bluetooth is BLE GATT only and **cannot reach the SPP thermal printers that dominate this
market.** `ADR-0003` already names printing as the PWA's weak point; §8 makes it precise, with four
named findings that would reopen the decision.

What the design does: the printing spike is the **first work in Phase 1**, before printers are
bought, with numeric pass criteria (≥99% of sales print on the first attempt) and a supported-printer
procurement list as its output. The client is structured so the answer can change without a rewrite.

### R5 — Network-wide credit limits are unenforceable while outlets trade offline
**Severity: real money. Mitigation: bounded and surfaced, never prevented.**

Two offline locations can each sell within the limit and jointly exceed it. This is arithmetic, not
a defect.

What the design does: per-location caps issued as **leases** (a reduction takes effect only when the
holding location acknowledges it, so the same headroom is not lent twice); an offline single-sale
ceiling; every breach recorded as an exception carrying each device's believed-available figure; and
`credit_limit_check` persisted on the sale so the UI can never claim a check it did not make.
Staleness-decayed headroom was considered and rejected as unexplainable at a counter.

**The residual is honest and must be understood by the business: maximum offline exposure is
Σ(caps).** Choosing those numbers is Q4's accountant, not us. And software does not collect money —
what is needed alongside the exception queue is a commercial policy: who calls the customer, what
happens to the manager who authorised it, at what exposure the account gets held.

### R6 — The pilot is unreadable as scheduled
**Severity: costs us the one thing the pilot is for. Mitigation: proposed, needs a founder decision.**

Techiman flagship opens 1 August 2026 and the ERP goes live the same morning. New outlet, new staff,
new software — when something goes wrong nobody can separate a defect from a learning curve.
Recommendation: a **2–4 week dry-run before trading opens**. If the date is immovable, say so
explicitly, reclassify week one as training, and start the 14-day success clocks after it. `Q12`.

### R7 — Shared schema means some changes cannot be canaried at all
**Severity: all tenants at once. Mitigation: move the risk into the application layer.**

Two artefacts are global: the sync rules are **one document for the whole service**, and a DDL
change lands for every tenant simultaneously. A bad sync-rule deploy is an all-tenant event, and a
rule change may force affected buckets to re-download — a fleet-wide re-sync over 2G is an outage,
not a deploy, and it is currently **unverified** whether ours behaves that way.

What the design does: expand–migrate–contract with a negotiated `schema_contract` version and a
180-day support floor, so the *application* can be canaried through release rings even though the
DDL cannot; `lock_timeout=3s` so an `ALTER` behind a long report does not stall every tenant at
once; writes below the minimum contract quarantined rather than dropped; two reviewers and a green
two-tenant isolation test on every sync-rule change; deploys out of trading hours with a verified
rollback. **Measuring the re-download cost is Phase 1 work before the release cadence is fixed.**

### R8 — The GL does not sync, which is a named narrowing of the constitution
**Severity: moderate. Mitigation: adequate for outlets, thin for HQ.**

`CLAUDE.md` §2.2 says offline operation is the architecture; §5 carves the ledger out of it. Devices
sync documents and the server posts them, for three good reasons — a device cannot see period
status, the gapless counter or another location's cost; a posting-rule change must take effect for
the whole tenant at once; and it removes the most sensitive dataset from every device.

The mitigation — a read-only, per-location report snapshot that *does* sync — is genuinely adequate
for an outlet manager checking yesterday's margin and genuinely inadequate for an Accounts user
working through a multi-day outage at HQ. If HQ connectivity is worse than assumed, the answer is
redundancy at HQ, not a syncable ledger.

### R9 — The business date is a validated human input, not a proof
**Severity: a misstated statutory period. Mitigation: constrained, but detection not prevention.**

A device offline for D days can place a transaction anywhere within those D days. The design moved
the risk off the tablet's clock and onto a human-opened cash session, then constrained the session:
one calendar day maximum, auto-close at local midnight, validation against server time when online,
refusal to open into a closed period. That is much better than a clock. It is not a proof.

Whether it is tolerable at a statutory period end is an accountant's call (`Q-SEC-2`), and if it is
not, the answer is a **shorter maximum offline lease near period end** — a business trade, not an
engineering one.

### R10 — Reported margin moves after the fact
**Severity: confusing rather than wrong. Mitigation: designed, and it must be explained to the reader.**

Weighted-average cost is recomputed by replaying the movement ledger, so a tablet syncing Monday's
goods receipt on Thursday **restates Tuesday's margin**. That is correct behaviour for an
offline-first system and it is the only costing method that converges. But this business tracks
blended gross margin to three decimals against a 19.325% → 24.5% target curve.

What the design does: the subledger's replayed valuation is canonical, the GL never retro-restates a
posted entry, and the two are tied by a period-close revaluation entry plus a nightly
`Σ(qty × WAC) = GL INVENTORY` assertion. Every margin report carries an as-at marker. **`Q16` asks
the accountant to confirm the method**; what is settled is that the books and the stock ledger stay
tied whichever method is chosen.

### R11 — Nine specialists wrote one document and it diverged
**Severity: would have produced a schema nobody agreed on. Mitigation: a Phase 0 exit condition.**

The review found three competing idempotency registries, two conflict queues, two sequence-block
tables, two definitions of the logical clock (one of which was not a total order), two incompatible
costing models, and two locations for in-transit stock. Each duplicate was weaker than the original,
and several were real defects rather than naming drift.

Every one is now resolved to a single owner, listed in `§3.11.9`, `§4.17.2` and `§5.14.2`. **The
naming and ownership reconciliation is an exit condition for Phase 0, not a Phase 1 cleanup** — the
sync rules file *is* the isolation boundary, and until this pass it was written against a schema
that did not exist.

### R12 — Vendor dependency on PowerSync
**Severity: bounded. Mitigation: structural, and cheap to maintain.**

A commercial dependency with a source-available core, on the critical path of every device.

What the design does: **writes never traverse the sync layer**, so no business rule is expressed in
vendor terms. The exit cost is the sync rules (~300 lines of declarative config with a test suite
already written against it) plus the client data-access layer — weeks, not a rewrite. Two standing
rules keep it that way: all local reads go through a thin repository layer, and no domain logic ever
goes into a sync rule. Self-hosting stays live as a pressure valve, proven once before the pilot
rather than first attempted under duress.

---

## 6. Open questions that block progress

Twenty items, reconciled from `docs/open-questions.md` and everything the nine sections surfaced.
**Items marked `NEEDS-HUMAN` are never closed by an agent — not by me, not by anyone I delegate to.**

### Blocking Phase 1

| # | Question | Who | Why it cannot wait |
|---|---|---|---|
| **[Q8](../open-questions.md)** | **Ghana e-VAT: is it a clearance regime, and what is the permitted offline window?** | **`NEEDS-HUMAN`** — GRA, via a registered tax practitioner | Determines the POS **document model**. Months of lead time (CIS onboarding, JUAT). Most likely single cause of a launch-date slip. |
| **[Q20](../open-questions.md)** | **Opening balances** — cut-off date, who prepares them, who signs them | `NEEDS-HUMAN` — founder + accountant | Tenant #1 goes live with existing stock, debtors and creditors. This is the **first thing that posts**, and the design had no mechanism for it at all until this review. |
| [Q5](../open-questions.md) | VAT registration status and the correct rate set | `NEEDS-HUMAN` — accountant | Gate `G2a`/`G2b`. The mechanism is decided (`ADR-0002`); the facts are not. |
| [Q7](../open-questions.md) | Conversion factors, and the four mis-specified catalogue lines | founder | **Mechanism resolved** by §4.4. The *numbers* are not: bars per 12m length by diameter, metres per cable roll, m² per tile box, blocks per m². A template that ships wrong factors is a remediation case on day one. |
| [Q9](../open-questions.md) | Trip-load capacity for four aggregate SKUs | founder | `ADR-0001` deleted the entity that would carry a truck capacity. A figure on a haulier's rate card is not fleet management — but without it the conversion cannot be authored. |
| [Q10](../open-questions.md) | Cement shelf life vs no lot tracking | founder | Adding `lot_id` to a live movement ledger means every historical row has an unknown lot. Decide before, not after. |
| [Q11](../open-questions.md) | Are contractor deposits real security, or does the word come out? | `NEEDS-HUMAN` — founder + accountant | There is no deposit ledger, no GL liability account and no claim procedure anywhere in scope. Every "secured" claim about this credit book is currently an unbacked column. |
| [Q4](../open-questions.md) + [Q18](../open-questions.md) | Facility fee: how is 2–3%/month structured, and is it a taxable supply? | `NEEDS-HUMAN` — accountant **and** a Ghanaian lawyer | 2–3%/month is an effective **26.8%–42.6% annually**. Stating that arithmetic is the limit of what an agent may contribute. The mechanism is built with the rate and GL treatment configurable, so this gates **go-live**, not the build — enforced in code: the accrual refuses to post until the policy row is confirmed. |
| [Q12](../open-questions.md) | 2–4 week dry-run before the flagship opens? | `NEEDS-HUMAN` — founder | Otherwise the pilot cannot distinguish a defect from a learning curve. |
| [Q13](../open-questions.md) | Ghana data residency under Act 843 | `NEEDS-HUMAN` — counsel | The one input that could invalidate `ADR-0003`'s hosting decision. Costs one conversation. |
| [Q15](../open-questions.md) | Is the model's revenue VAT-inclusive or exclusive? | `NEEDS-HUMAN` — founder + accountant | A **>GH₵300,000 FY1** difference, and it changes the gross-margin denominator against a curve tracked to three decimals. |
| [Q16](../open-questions.md) | Costing method | `NEEDS-HUMAN` — accountant | COGS posts from the first sale. |
| `Q-SEC-2` | Is the clamped business date tolerable at a statutory period end? | `NEEDS-HUMAN` — accountant, at the §2.8 gate | If not, the answer is a shorter offline lease near period end — a business trade. |
| `Q-A` / `Q-SEC-1` | Supported-printer list, and hardware-backed key storage | `frontend-engineer` + `devops-engineer` | **Must be answered before hardware is purchased.** One trial, three findings (printing, key storage, storage eviction), so the native-Android question is reopened once or not at all. |

### Blocking Phase 2 or Phase 3, but cheapest to resolve now

| # | Question | Who |
|---|---|---|
| [Q6](../open-questions.md) | **The reviewing accountant is still not named.** | `NEEDS-HUMAN` — founder. Raise at the Phase 2 gate at the latest; a chart of accounts reviewed at design time costs a conversation, one reviewed after a month of live posting costs a restatement. |
| [Q1](../open-questions.md) | With no owned fleet, what mechanism delivers distribution cost 5.0% → 2.5%? And how does the GH₵300,000 FY1 capex line split? | `NEEDS-HUMAN` — accountant + founder |
| [Q17](../open-questions.md) | Do the per-tier staff-cost baselines include employer social security? | founder + accountant. Ask alongside Q15. |
| [Q19](../open-questions.md) | Who may exclude a dark device from a period close, and what must the close record state? | founder, then standard onboarding policy |
| [Q14](../open-questions.md) | Suspension, offboarding and deletion windows; backup retention vs a deletion promise; device retirement write-offs | `NEEDS-HUMAN` — founder + contracts + legal |
| [Q2](../open-questions.md) | Receivables days: the model assumes 15, terms are 30–60 | accountant. **Monitoring, not sign-off** — the ERP measures real DSO from day one. §6 notes the 15-day figure is not wrong so much as *unstated*: it encodes an unwritten belief about credit mix, and at 30–45 blended days the FY3 trough moves from GH₵(1,393,958) toward GH₵(1.9M)–(2.4M). |
| `Q-C` / `Q-SEC-4` | The bounded history window — 90 days bounds a stolen device and a 2 GB tablet, but a contractor on 60-day terms plus a dispute puts needed history right at the edge | `sync-architect` + `product-manager`, against tenant #1's real ageing profile, before go-live |
| `Q-D` | An offline-verifiable credential for in-person manager approval | `rbac-security-engineer`. §8 deliberately specified the UX and deferred the mechanism rather than have the client quietly make a security decision. |

[Q3](../open-questions.md) is closed: the financial model is canonical and the plan's prose is
stale in seven places. Quote `financial-model-targets.md`, never the prose.

---

## 7. Rollout — the summary

Full detail in [§9.7 and §9.8](sections/09-infrastructure-and-rollout.md).

**The shape is not what it looks like.** "Staged rollout across 25 locations" implies 25 sites to
convert. There are none. Tenant #1's network *grows by opening outlets* over ten years, so a location
joins on the day it opens and its go-live is one line in an outlet-opening checklist. There are
really two problems: **the pilot** (one location, once) and **release staging across a growing
fleet** (continuous, forever, and the thing that actually consumes attention after month two).

**Pilot: Techiman flagship.** Nine preconditions must all be true before a single sale — the
accountant's review gate, the jurisdiction pack confirmed, **receipt printing proven on the exact
deployed hardware**, a restore drill passed within 30 days, the two-tenant isolation test green at
every read path, devices enrolled and revocation tested end to end, monitoring live with a confirmed
SMS contact, staff trained, and **paper fallback rehearsed**. That last one is a precondition, not a
contingency: if the outlet cannot trade without the software, we will hesitate to roll back a bad
release, and hesitating is how a bad release gets into the books.

**Success criteria — the gate before any second location.** Ten, all objective and time-bound,
checked by a named human at a scheduled review rather than inferred from a dashboard. The ones that
matter most: **zero lost writes over 14 consecutive trading days** (device write-log count
reconciled against server-accepted count daily, zero unexplained discrepancies — not "a few we think
we understand"); airplane-mode sale syncing within 60 seconds **p95 over ≥50 measured instances**,
because one successful demo is not evidence; **cash-up reconciling to the pesewa for 14 consecutive
days**, which is the criterion the business actually trusts and the one that catches money bugs unit
tests pass; every review-queue item resolved within one business day with a recorded reason; ≥99% of
sales printing first time; and the outlet manager operating unassisted for five consecutive days.

**Failing a criterion means the expansion does not happen. It does not mean rollback.** Those are
different decisions with different triggers, and confusing them causes teams either to expand onto a
broken system or to tear down a working one. The clock restarts; the gate stays shut.

**Release rings.** Ring 0 staging + HQ (24 h soak) → **Ring 1 the flagship (72 trading hours)** →
Ring 2 RDCs → Ring 3 micro-outlets. Putting the newest build at the highest-revenue location first
is a real trade, taken deliberately: the founder and support are physically standing there, so a
problem is seen in minutes rather than at month end — and the alternative, a micro-outlet with three
staff and no technical support discovering a bug alone, has no fast feedback path at all. A new
tenant onboards onto Ring 2's stable release, never a canary. **PWAs auto-update by default, which
makes rings decorative unless the client asks a server-controlled endpoint which build it should be
running** — that is a real engineering constraint owned by `frontend-engineer` and it must exist
before the second location does.

**Rollback.** A runbook written to be executed by someone stressed, at a counter, possibly on their
phone: short sentences, numbered steps, no deliberation. Three separate procedures by change type
(client release, server release, schema change), because they are not the same operation. The parts
usually left out are specified: **what happens to writes made on the bad version**, how the location
keeps trading while it is happening (the rehearsed paper fallback), and who decides. The hard
constraint behind all of it: an in-place database restore **silently loses writes devices believe
were acknowledged**, so any restore requires a forced re-upload window and a 35-day client write-log
retention to make that possible.

---

## 8. What approval means

You are being asked to approve **a design, not an implementation**, and specifically these things:

1. **The seven ADRs stand** (§3), with three amendments noted: `ADR-0002` gains the tax-base fields
   §7 identified, `ADR-0004` gains one line naming the rate scale, and `ADR-0005` gains one sentence
   narrowing "RLS is the backstop" to exclude the replication path.
2. **PowerSync is the sync layer**, with the justification in §3.1 accepted — including that writes
   go through our own API rather than through the sync engine, and that the exit path is weeks
   rather than a rewrite.
3. **The mechanisms in §5's risk list are the mitigations we are relying on**, including the two
   places where the answer is currently "nothing yet" (R1 Ghana e-invoicing; the residual in R5
   offline credit exposure).
4. **The pilot is Techiman flagship**, with the ten success criteria in §7 as the gate before any
   second location, and the nine preconditions as blocking.
5. **The open questions in §6 are the real list**, and the ones marked `NEEDS-HUMAN` will be
   answered by the named humans rather than closed by an agent.

**What approval does not mean.** It does not authorise Phase 2 or Phase 3 — those have their own
gates. It does not close Q4, Q6, Q8 or any other `NEEDS-HUMAN` item. And it does not certify that
the design is correct; three of nine sections have been adversarially reviewed and six have not.

### What happens on approval

Phase 1 begins, at the pilot location, against the acceptance criteria in `CLAUDE.md` §3. The
sequencing that matters, because two of these must happen before money is spent or a schema is
frozen:

1. **Week 1–3 — the hardware trial.** Receipt printing, hardware-backed key storage, and storage
   eviction, on the exact tablets and printers under consideration. **Before printers are bought.**
   Output: a supported-printer procurement list and a recorded decision on `ADR-0003`.
2. **Week 1 — start Q8.** The GRA e-invoicing engagement has the longest lead time of anything in
   Phase 1 and it determines the POS document model. It cannot start later.
3. **Phase 0 exit conditions, before the first migration:** the naming and ownership reconciliation
   in R11, and the PowerSync capability verification in `§3.11.8` — both are cheap now and expensive
   once there is a schema and a fleet.
4. **Then Phase 1 proper**, ending in a *working, demoable system* — not "code complete", not "tests
   pass". A demo.

### Phase 1 acceptance, restated

Verbatim from `CLAUDE.md` §3, because these are what "done" means and two of them carry an explicit
instruction about how they are proved:

1. A sale completes with the device in airplane mode and syncs correctly within **60 seconds** of
   reconnection.
2. Two devices independently record stock movements against the same SKU while both offline, and
   reconcile correctly (or flag for review) — **demonstrated, not asserted**.
3. A customer's credit balance, ageing and facility fee are visible and correct after a mix of cash
   and credit sales across multiple locations.
4. HQ sees near-real-time stock and sales across every connected location in one view.
5. A second tenant, provisioned from a different template, is fully invisible to tenant #1 —
   **demonstrated at every read path**, not asserted.

On criterion 5: §7's CI "smoke pack" — a fictional jurisdiction with 1000 minor units per major
unit, one tax code and document-level rounding — **should be** that second tenant. It proves tenant
isolation and jurisdiction pluggability with one fixture, and it makes the currency-scale assumption
fail loudly the first time someone divides by 100.

---

## 9. On the adversarial review, and what it means for the six sections that had none

Sections [3](sections/03-offline-sync.md), [4](sections/04-data-model.md) and
[5](sections/05-general-ledger.md) were reviewed adversarially and revised. Each now carries a
disposition appendix (`§3.11`, `§4.17`, `§5.14`) recording every finding and what changed; where an
appendix and the body of its section differ, the appendix governs.

**Eighty-four findings. None rejected as wrong.** Six were blocking. The ones worth naming, because
they show the failure mode rather than the individual bugs:

- **§3 claimed credit limits "never leave the server" while §6 required the number at the counter.**
  Two approved sections of one document disagreed about what is on the tablet. Resolved by a new
  bucket that gives the till a *bounded local allowance* rather than the account.
- **§3's error handling treated every conflict as poison.** A `4xx` was "definitive", so the
  canonical credit-limit conflict — the flagship example of the entire section — would have been
  dropped from the queue into device-local storage and shown the operator *"1 record could not be
  sent."* Resolved by an explicit response taxonomy and a durable server-side dead-letter.
- **§4 had three idempotency registries with three different keys**, one of which produced a
  silently dropped sale and a foreign-key violation that would have quarantined a tendered,
  printed, cash-collected transaction. Resolved to one.
- **§5's reversal moved the original out of every statement query**, so a reversal changed the P&L
  by −X rather than 0 and retroactively restated a period already shown to a lender — **while both
  of that section's own listed invariants stayed green.**
- **§4 and §5 asserted incompatible costing models**, so inventory value and the GL would have
  diverged monotonically by design with no reconciliation anywhere and neither section owning it.

Three observations that generalise, and that the remaining six sections should be read against:

**Overclaiming is the recurring defect.** "Structurally impossible", "the number never leaves the
server", "a tablet cannot post to the wrong period", "there are seven rounding points and no
others" — each was a strong claim with insufficient machinery underneath, and each stopped the next
reader from checking. Every such claim in the three reviewed sections has been made true or
withdrawn.

**An invariant asserted over the storage layer does not test the reporting layer.** §5's trial
balance summed to zero throughout the reversal defect, because a reversal is self-balancing. Tests
that a user would describe in terms of a *statement* now render the statement.

**Sections written in parallel diverge in ways that look like naming and are not.** Two definitions
of the logical clock, one of which was not a total order and would have made cost of goods sold
non-reproducible. That is R11, and it is why reconciliation is a Phase 0 exit condition.

**Recommendation to the approver.** Either commission the same review for sections 1, 2, 6, 7, 8 and
9 before Phase 1 code begins, or accept explicitly that they carry an unmeasured defect density and
budget for finding those defects during Phase 1 instead — which is more expensive, but is a
legitimate choice if the launch date is immovable. **What is not legitimate is assuming they are
clean because they read well.** So did the other three.
