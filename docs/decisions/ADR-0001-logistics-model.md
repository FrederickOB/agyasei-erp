# ADR-0001 — Logistics: third-party hauliers only

**Status:** Accepted · **Date:** 2026-08-20 · **Affects:** Phase 2

## Context
The Claude Code brief and business plan §7.2 directly contradict each other on whether the
company owns vehicles. The brief says asset-light, no owned fleet, hauliers only — and cites
§7.2 as its source. §7.2 actually describes an owned fleet growing 2 → 8 trucks. The financial
model backs §7.2, carrying GH₵300,000 of FY1 fleet-and-systems capex, GH₵150,000 per additional
truck, and a margin lever (Lever 3) that attributes the 5.0% → 2.5% distribution-cost decline to
the owned fleet absorbing volume.

## Decision
**The ERP models third-party hauliers only.** Phase 2 builds haulier contracts, delivery
scheduling and delivery-status tracking. There are **no** vehicle, driver, fuel or maintenance
entities.

A carrier is a contracted haulier. If owned vehicles are ever introduced, the carrier abstraction
is where they attach.

## Consequences
- Phase 2 is materially smaller: dispatch and tracking, not fleet operations.
- No vehicle lifecycle, servicing schedules, driver rostering or fuel reconciliation to build.
- **The financial model's Lever 3 now lacks a mechanism.** A 5.0% → 2.5% decline in distribution
  cost has to come from negotiated haulier rates and load consolidation instead. The ERP will
  measure distribution cost as % of revenue per outlet and per region so the real trajectory is
  visible, but whether the target is still achievable is an accountant's judgement — logged as
  `open-questions.md` Q1.
- The GH₵300,000 FY1 "Initial Fleet + HQ/ERP Systems" capex line needs splitting; only the
  ERP/POS portion survives this decision.

## Alternatives considered
- **Owned fleet** (matching plan + model): larger Phase 2, and contradicts the brief's explicit
  instruction. Rejected.
- **Hybrid carrier abstraction built now, fleet added later**: modest extra design cost, closes
  the contradiction safely. Rejected in favour of the simpler option, but the carrier abstraction
  above preserves the upgrade path at near-zero cost.
