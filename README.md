# ERP Platform

A **multi-tenant ERP product** for multi-outlet wholesale and retail distribution businesses
operating in low-connectivity markets.

**Agyasei Jnr & Company Limited is tenant #1** — the pilot customer and the source of the first
starter template. An integrated hardware and cement wholesale/retail chain launching in Techiman,
Bono Region, Ghana on **1 August 2026**, growing to 25 outlets across six regions over ten years.
Their setup ships as the "Construction materials distribution — Ghana" template; it is not the
platform's model.

**Status: pre-build.** No application code exists yet. Per the project brief, the first
deliverable is an architecture document, and the build waits for explicit approval of it.

## Start here

| Read | For |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | The project constitution — business context and the non-negotiable constraints. **Read first.** |
| [`docs/open-questions.md`](docs/open-questions.md) | Unresolved contradictions between the source documents. Read before quoting any figure. |
| [`docs/decisions/`](docs/decisions/) | Architecture decision records |
| [`docs/source-of-truth/`](docs/source-of-truth/) | Business plan, financial-model targets, outlet and SKU data |

## The five constraints that shape everything

1. **Tenant isolation.** A leak across tenants exposes one company's books to another and, because
   data syncs to devices, it is **unrecoverable**. `tenant_id` everywhere, RLS as backstop,
   tenant-scoped sync rules.
2. **Offline-first is the architecture.** Every location trades for hours or days without
   connectivity, then syncs. Nothing may be lost, silently double-counted, or allowed to corrupt
   another location's or tenant's data. No hand-rolled sync protocols.
3. **Money is integer minor units.** Never floats, anywhere. The scale is a jurisdiction value.
4. **No statutory payroll calculation, ever.** Capture, export, re-import. Statutory behaviour is
   a jurisdiction pack, not code.
5. **A human professional gates the ledger and each jurisdiction pack.** Never done on an agent's
   say-so.

## The team

Sixteen agents in [`.claude/agents/`](.claude/agents/) — five leads, each able to delegate to
specialists that carry the rules above:

**Leads** — `product-manager` · `software-engineer` · `frontend-engineer` · `devops-engineer` ·
`qa-engineer`

**Specialists** — `sync-architect` · `ledger-engineer` · `credit-engineer` ·
`rbac-security-engineer` · `tenant-platform-engineer` · `pos-ux-specialist` ·
`money-test-engineer` · `sync-test-engineer` · `tenant-isolation-test-engineer` ·
`compliance-gatekeeper` · `business-data-analyst`

## Commands

| Command | Does |
|---|---|
| `/phase-gate [n]` | Phase-gate checklist and written verdict before sign-off |
| `/sync-drill` | The offline and conflict acceptance scenarios, end to end |
| `/money-audit` | Find every money-touching function; verify tests and type safety |
| `/tenant-isolation-audit` | Prove no read path, sync rule, report or export leaks across tenants |
| `/reconcile-model` | ERP reporting output vs. the financial model's targets |

## Build phases

**Phase 0** — Architecture document. **Stops for approval.**
**Phase 1** — Tenant provisioning and templates, POS, inventory, customer credit, cross-location
reporting, offline sync. Pilot: tenant #1's Techiman flagship.
**Phase 2** — Procurement, purchase orders, goods-received matching, haulier dispatch.
**Phase 3** — Native double-entry GL, staff records, payroll capture, bank reconciliation.

Each phase ends with a working, demoable system and a sign-off gate.

## Source documents

Originals live in `~/Documents/Agyasei/` (business plan, financial model, stock list, investor
deck) and the brief at `~/Downloads/Prompt for Claude Code.docx`. Extracts in
`docs/source-of-truth/` exist so nothing has to re-parse `.docx` and `.xlsx` — use those.
# agyasei-erp


