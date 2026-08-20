# Project Constitution

A **multi-tenant ERP product** for multi-outlet wholesale and retail distribution businesses
operating in low-connectivity markets.

**Agyasei Jnr & Company Limited is tenant #1** — the pilot customer and the source of the first
starter template. It is *not* the product's model. Anything specific to Agyasei is tenant
configuration, never platform behaviour (`ADR-0006`).

Read this file before doing anything. The rules in §2 are not defaults to be weighed against
convenience — they are constraints. If a task appears to require breaking one, stop and say so.

---

## 1. What this is

**The product** — one platform, many tenants. Each tenant is a distribution business running
some number of locations, selling a catalogue it owns, on credit terms it sets, keeping its books
in a chart of accounts it can edit, under one jurisdiction's tax rules.

**The market condition that shapes everything** — outlets trade in places where connectivity is
unreliable for hours or days at a time. Offline operation is not a feature; it is the reason this
product exists rather than any conventional cloud ERP.

**Tenant #1 (the pilot)** — Agyasei Jnr & Company Limited, an integrated hardware and cement
wholesale/retail chain launching in Techiman, Bono Region, Ghana on **1 August 2026**, growing to
25 outlets across six regions over ten years. Their three-tier network (1 Flagship, 6 Regional
Distribution Centres, 18 Community Micro-Outlets), 219-SKU construction catalogue, five roles and
chart of accounts ship as the **"Construction materials distribution — Ghana"** template.
Reference data: `docs/source-of-truth/`.

---

## 2. Non-negotiable constraints

### 2.1 Tenant isolation
A leak across tenants exposes one company's books, margins and customer credit positions to
another, and — because data syncs to devices — it is **unrecoverable**. Treat it accordingly.

- **`tenant_id` on every tenant-owned row.** Every index that matters leads with it.
- **`tenant_id` is never accepted from a client payload.** It comes from the verified token,
  server-side, on every write. A client-supplied tenant ID is an attack, not an input.
- **RLS is the backstop.** Application queries scope by tenant *and* row-level security enforces
  it, so a forgotten predicate fails closed instead of leaking.
- **Sync rules carry the boundary.** A device syncs `tenant_id = token.tenant_id`, intersected
  with the user's role and location scope. This is where data actually leaves the server.
- Idempotency-key uniqueness is scoped per tenant, never global.

See `ADR-0005`. Enforce this structurally — a shared base definition or codegen that makes
omitting `tenant_id` impossible — not by convention.

### 2.2 Offline-first is the architecture, not a feature
Every location must trade fully offline for hours or days, then sync cleanly. A sale, a stock
adjustment, or a credit transaction must **never** be lost, **never** be silently double-counted,
and **never** corrupt another location's — or another tenant's — data during sync.

- **Do not hand-roll a sync or conflict-resolution protocol.** Use a proven Postgres-backed
  offline-sync layer — PowerSync is the primary recommendation; ElectricSQL or an equivalent
  mature framework is acceptable *only* with a written justification in the architecture document.
- **Every write carries a client-generated idempotency key and a logical timestamp.** No exceptions.
- **Every conflict that cannot be resolved automatically goes to a human review queue.** Never
  silently overwritten. The canonical hard case: two locations editing the same customer's credit
  limit while both offline.

### 2.3 Money is integer minor units
All monetary amounts are stored and computed as **integers in the currency's minor unit**
(Ghana: pesewas, 100 to the cedi). The **scale is a jurisdiction-pack value** — never assume 100.

**Never floats. Never `number` for money in TypeScript. Never `float`/`double`/`real`/`numeric`
in Postgres.** Use `bigint` in both — one canonical type across both layers. (`numeric` is exact
and so not a correctness hazard in the database, but it is still non-conforming: pairing it with
a `number` in TypeScript drifts anyway, and a second permitted money type is a second thing every
reviewer must reason about.)

**Quantities too.** Many goods sell by weight, length or area — 59 of tenant #1's 219 SKUs do.
Quantity is a scaled integer with its scale documented, never a float. Rounding is explicit and
stated at every boundary; never implicit. See `ADR-0004`.

### 2.4 No statutory payroll calculation, ever
The system records hours, roles, gross pay and commissions, and produces a payroll register.
It **must not** contain PAYE brackets, social-security rates, or any statutory withholding logic
— **in any jurisdiction**. These change with legislation and must not live unmaintained inside
custom software.

The flow is: **capture → export register to the accountant/bureau → they compute deductions →
their figures are re-imported into clearly marked fields → net pay is entered, not calculated.**

**Recording is not calculating.** The GL still needs an account and a posting line for the
**employer** social-security contribution — it is a company expense. Posting the figure the
bureau returns is recording. Deriving it from a rate is not.

**A configurable withholding table is still prohibited.** This rule is categorical, not a rule
against hard-coding. The tax treatment in §2.5 is not a precedent — a stale VAT rate is visibly
wrong on a receipt today; a stale PAYE figure fails silently until a filing deadline.

No jurisdiction pack ever contains payroll withholding logic. If asked to add statutory payroll
calculation, refuse and point to this rule.

### 2.5 Statutory behaviour is a jurisdiction pack
Sales tax is computed per line, but **every rate lives in an effective-dated table**, and the
whole statutory surface — currency and minor-unit scale, tax codes and rates, invoice and receipt
requirements, statutory report formats — is a **per-tenant jurisdiction pack** (`ADR-0007`).

A tenant belongs to exactly one jurisdiction. **No `if (country === 'GH')` anywhere** — if code
branches on jurisdiction, the pack is under-specified. Fix the pack, not the caller. A historical
transaction always reprices against the rate row in effect on its transaction date.

Ghana is the only pack built and tested. Multi-jurisdiction tenants and FX in the ledger are out
of scope.

### 2.6 Access control from day one
Permissions are composable and grouped into **tenant-editable roles** — never a hard-coded role
enum. Scoping is by tenant *and* location. Built into the first schema, never bolted on.

Tenant #1's five roles ship as a template: outlet staff (POS and stock lookups, **no** pricing
overrides, **no** credit limit changes) · outlet manager (+ stock adjustments, local reporting,
credit sales to a limit) · regional manager (+ their region, haulier coordination) · head of
operations (full network override) · accounts (credit, AP/AR, GL review, payroll register).

**Sync rules are the authorization boundary.** A device downloads only what its tenant, role and
location scope permit. This cannot be retrofitted.

### 2.7 Tests before "done" — three mandatory categories
Nothing in these categories is "done" without tests, and the tests are written with the code:
1. **Any function that touches money** — totals, credit balances, fees, margins, tax lines,
   payroll figures, GL postings.
2. **Any sync or conflict-resolution logic.**
3. **Any read path that could cross a tenant boundary.** Every read gets a test proving a second
   tenant's data is invisible.

### 2.8 Human review gates are blocking
- **Before a tenant's ledger goes live**, a qualified accountant reviews the chart of accounts,
  the double-entry logic, and at least one full month of generated statements against manual
  expectations. Never "done" on an agent's say-so.
- **Before a tenant in a new jurisdiction goes live**, a qualified local professional confirms
  the jurisdiction pack.
- Bank reconciliation (system cash vs. bank and mobile-money statement) is a **required** feature
  — it is where undetected errors in a home-grown GL surface first.

### 2.9 Nothing branches on tenant identity
If a behaviour differs between tenants it is **configuration**, not a conditional. No code path
reads "is this Agyasei?" or "is this the construction template?". A template is seed data applied
once at onboarding to create ordinary editable rows (`ADR-0006`).

### 2.10 Source-of-truth precedence for tenant #1
**Financial model > business plan prose.** The plan contradicts itself in seven places; the model
is canonical. Figures: `docs/source-of-truth/financial-model-targets.md`. Contradictions:
`docs/open-questions.md`. Read it before quoting any number.

---

## 3. Build phases — sign-off required between each

**Phase 0 — Architecture document. This comes first and nothing else starts until it is approved.**
Tenancy model, data model, sync approach + justification, conflict detection and surfacing,
chart-of-accounts templating and posting rules, jurisdiction-pack design, and a rollout plan
(pilot tenant and location, success criteria, rollback plan).
**Stop after this document and wait for explicit approval.**

**Phase 1 — Core operations** (pilot: tenant #1's Techiman flagship). Tenant provisioning and
template application · POS with retail and wholesale pricing, cash and credit sales, receipt
printing · inventory by location and SKU, transfers, adjustments with reason codes, low-stock
alerts · customer credit with limits, terms, ageing, and facility fee tracked explicitly ·
cross-location HQ reporting · offline operation and sync for all of it, tested under real
conditions.

**Phase 2 — Procurement & supply chain.** Suppliers, multi-source purchase orders · goods-received
matching · reorder points tied to Phase 1 alerts · third-party haulier dispatch and delivery
status (**dispatch and tracking only — no fleet or vehicle management**, `ADR-0001`).

**Phase 3 — HR, payroll & accounting.** Native double-entry GL enforced at the database level,
templated multi-location chart of accounts, P&L and balance sheet by location and consolidated ·
staff records and assignments · payroll **data capture only** per §2.4 · bank reconciliation.
No third-party accounting SaaS — this platform is the system of record.

Each phase ends with a **working, demoable system**, not just committed code.

### Phase 1 acceptance — what "done" actually means
1. A sale completes at the pilot location with the device in airplane mode, and syncs correctly
   within **60 seconds** of reconnection.
2. Two devices independently record stock movements against the same SKU while both offline, and
   reconcile correctly (or flag for review) on sync — **demonstrated, not asserted**.
3. A customer's credit balance, ageing and facility fee are all visible and correct after a mix
   of cash and credit sales across multiple locations.
4. HQ sees near-real-time (post-sync) stock and sales across every connected location in one view.
5. A second tenant, provisioned from a different template, is fully invisible to tenant #1 —
   **demonstrated at every read path**, not asserted.

---

## 4. Stack

- **Backend** — Node.js + TypeScript, Postgres, REST or tRPC.
- **Client** — React, installable **PWA**. Targets **low-end Android tablets and phones**. Do not
  assume iOS or desktop. Local SQLite via the sync layer.
- **Hosting** — managed Postgres in an **EU region** (`eu-west`). No major cloud has a West Africa
  region; EU is the pragmatic latency choice for Ghana (~90–130ms). The architecture document must
  state this trade-off explicitly. See `ADR-0003`.
- **Testing** — mandatory per §2.7.

Deviating from any of the above requires an explicit, written justification in the architecture
document — flag it, do not do it quietly.

---

## 5. The team

Five leads, each able to delegate to specialists (`.claude/agents/`):

| Lead | Delegates to |
|---|---|
| `product-manager` | `business-data-analyst`, `compliance-gatekeeper` |
| `software-engineer` | `sync-architect`, `ledger-engineer`, `credit-engineer`, `rbac-security-engineer`, `tenant-platform-engineer` |
| `frontend-engineer` | `pos-ux-specialist` |
| `devops-engineer` | — |
| `qa-engineer` | `money-test-engineer`, `sync-test-engineer`, `tenant-isolation-test-engineer` |

Specialists cannot spawn further agents.
Commands: `/phase-gate`, `/sync-drill`, `/money-audit`, `/tenant-isolation-audit`, `/reconcile-model`.

---

## 6. Reference files

| Path | What |
|---|---|
| `docs/architecture/` | The Phase 0 architecture document |
| `docs/decisions/` | Architecture decision records (ADR-0001 … ADR-0007) |
| `docs/open-questions.md` | **Unresolved contradictions. Read before quoting figures.** |
| `docs/source-of-truth/business-plan.md` | Tenant #1's business plan extract |
| `docs/source-of-truth/financial-model-targets.md` | **Canonical** figures for tenant #1 |
| `docs/source-of-truth/outlets.csv` | Tenant #1's 25 locations |
| `docs/source-of-truth/skus.csv` | Tenant #1's 219 SKUs — the catalogue template |

Everything under `source-of-truth/` describes **tenant #1**, not the platform.
