# ADR-0006 — Agyasei is tenant #1; their setup ships as a template

**Status:** Accepted · **Date:** 2026-08-20 · **Affects:** all phases

## Context
Everything originally specified for this build was Agyasei's: a three-tier outlet network,
219 construction SKUs, five named roles, a Ghanaian construction-retail chart of accounts,
contractor credit on 30–60 day terms. As a product, none of that can be the platform's model —
another distributor may run branches and warehouses rather than Flagship/RDC/Micro, sell a
different catalogue, and structure its org chart differently.

The window to generalise is now, while there is no production data. Retrofitting multi-tenancy
and configurability into a live ERP holding real books is the migration most likely to go wrong.

## Decision
**The platform ships generic. Agyasei's configuration ships as a starter template.**

| Was hard-coded for Agyasei | Becomes |
|---|---|
| Tier 1 Flagship / Tier 2 RDC / Tier 3 Micro-Outlet | **Locations** with tenant-defined **location types**, each carrying its own assortment and staffing profile |
| The 25-outlet network and its regions | Tenant-defined location hierarchy (region → location), arbitrary depth |
| 219 construction SKUs | Tenant-owned catalogue; the 219 ship as a template |
| Five named roles | Composable **permissions** grouped into tenant-editable **roles**; the five ship as a template |
| Ghanaian construction-retail chart of accounts | CoA **template** a tenant adopts and then edits |
| 30–60 day contractor terms, 2–3%/month facility fee | Per-tenant credit policy; per-account terms and rate |
| GH₵ / Ghana VAT | Jurisdiction pack (`ADR-0007`) |
| Financial-model targets (margin curve, inventory days) | Generic **targets / budget vs actual** feature |

**Templates are seed data, not runtime coupling.** A template is applied once at tenant
onboarding to create ordinary editable rows. The platform must contain **no** code path that
reads "is this the construction template?" or branches on a tenant's identity. If a behaviour
differs between tenants it is configuration, not a conditional.

Agyasei's template ships as **"Construction materials distribution — Ghana"**.

## Consequences
- Onboarding a tenant becomes a first-class product capability: create tenant, apply template,
  create locations, import catalogue, assign roles.
- Agyasei's pilot doubles as the proof the template mechanism works.
- Reporting must be tenant-configurable — the specific targets from Agyasei's financial model
  become one tenant's target set, not the platform's report definitions.
- Some added indirection everywhere. Accepted: the alternative is a rewrite once customer two
  arrives.

## Alternatives considered
- **Build for Agyasei, generalise later** — faster to first delivery, but means retrofitting
  tenancy into a system that is by then the system of record for a real company's books.
  Rejected.
- **Fully generic** (user-defined entities, custom document types) — maximum flexibility, far
  larger build, and a product that is genuinely hard to configure. Rejected as premature.
