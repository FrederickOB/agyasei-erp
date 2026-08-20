# ADR-0003 — Client is a PWA; backend is managed Postgres in an EU region

**Status:** Accepted (hosting provisional — revisit in the architecture document)
**Date:** 2026-08-20 · **Affects:** all phases

## Context
The brief left both as `[FILL IN]`, recommending a PWA as the simpler, lower-maintenance default.
Outlets run low-end Android tablets and phones at retail counters across six Ghanaian regions,
several with unreliable connectivity.

## Decision
**Client:** an installable **PWA** built in React, with local SQLite via the sync layer.
Target hardware is low-end Android. Not iOS, not desktop-first.

**Backend:** managed Postgres in an **EU region** (`eu-west`), plus the sync service.

## Consequences
- One deployable artefact updates all 25 outlets — no app-store round trip, which matters when a
  pricing or tax fix has to reach every counter the same day.
- **Thermal receipt printing is the PWA's weakest point.** Web Bluetooth and WebUSB coverage on
  low-end Android is uneven. `pos-ux-specialist` must prove receipt printing on representative
  hardware **during Phase 1**, not at pilot. If it cannot be made reliable, that is the one finding
  that would justify revisiting the native-Android option.
- **No major cloud provider has a West Africa region.** EU is the pragmatic choice for Ghana at
  roughly 90–130ms. This is a trade-off, not a settled fact: the architecture document must state
  it explicitly and check whether a provider with African presence has become viable.
- Offline-first design means latency is mostly invisible at the counter — reads are local. Latency
  affects sync convergence and HQ reporting freshness, not the speed of taking a sale.

## Alternatives considered
- **Native Android**: better peripheral access, worse update story across 25 outlets. Held in
  reserve pending the receipt-printing finding above.
- **Self-hosted VPS**: cheaper, possibly closer, but puts backups, patching and failover on a
  team that does not yet exist. Rejected for launch; revisit at scale.
