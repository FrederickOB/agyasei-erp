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

## Amendment — 18 November 2026 (founder decisions)

Four decisions taken by the founder in the working session of 18 November 2026. Each changes a
line above; the original text is kept as the record of what was decided first.

### A1. Device targets: tablet primary, laptop and phone secondary

| Form factor | Role | Room (`features/office/room.ts`) | Budget |
|---|---|---|---|
| **Android tablet** | **Primary.** The counter, receiving, stock. | Counter | §8.10's low-end envelope, unchanged — this is still the device every budget is set against |
| **Laptop** (Chrome/Edge, Windows/macOS/ChromeOS) | Secondary. HQ, accounts, regional managers: the back office, reports, books, admin | Office | Desktop Chrome; installable as a PWA. Must never be *required* for an outlet to trade |
| **Android phone** | Secondary. A manager away from the counter: approvals, lookups, reports; an emergency till | Either | 360 px wide minimum. Every counter flow must be completable one-handed at that width |

What this changes:
- "Not desktop-first" becomes "**tablet-first, desktop-supported**". A laptop is a supported
  device, not a tolerated one: it is enrolled like any other device (§2.7), and every back-office
  screen is designed at laptop width first.
- **iOS is still not a target.** Nothing here adds Safari.
- **Printing gains a laptop path.** Desktop Chrome has Web Serial and WebUSB, and the OS print
  dialog is fast enough for A4 invoices at a desk — the slow-queue objection in §8.8 is a counter
  objection.
- Browser tests run at three viewports — tablet, laptop, phone — not one.

### A2. Hosting: Supabase (EU) for Postgres; Fly.io for the API and the sync service

Both in **London** (Supabase `eu-west-2`, Fly `lhr`), co-located, inside the `eu-west` latency
envelope this ADR already accepts. Still **provisional on `open-questions.md` Q13** (data
residency), which can invalidate any EU choice.

Supabase must still pass every vendor filter in `09-infrastructure-and-rollout.md` §9.1, checked
at provisioning rather than assumed: logical replication with user-managed slots; **PITR — a paid
add-on, which must be enabled, not left at daily backups**; an application role created without
`bypassrls`; transaction-mode pooling that preserves `SET LOCAL`; `pg_stat_statements`; and a
written RTO. The sync service runs as its own Fly app so its version is pinned and rolled back
independently of the API (§9.1, §9.8).

### A3. Printing: build every transport, decide the hardware after measuring

The outlets may use any of: a Bluetooth thermal printer beside a tablet, an Android POS terminal
with a built-in printer, or a USB/OS-driver printer at a desk. §8.8's `ReceiptTransport`
interface is built with all of them behind it, and the §8.8 spike chooses among them on measured
results. Built-in printers on Android POS terminals are usually Classic/serial devices, which a
PWA can reach only through a print-bridge app — §8.8's `companion-bridge` concession, now with a
named reason to exist.

### A4. Sign-in: a managed OIDC provider, integrated provider-generically

As `02-security-and-access-control.md` §2.2 specifies: no password material in our schema. The
platform is a standard OIDC relying party, so the provider (Zitadel, Auth0 EU, Keycloak, …) is
configuration chosen at provisioning, constrained by §2.2's list.

## Alternatives considered
- **Native Android**: better peripheral access, worse update story across 25 outlets. Held in
  reserve pending the receipt-printing finding above.
- **Self-hosted VPS**: cheaper, possibly closer, but puts backups, patching and failover on a
  team that does not yet exist. Rejected for launch; revisit at scale.
