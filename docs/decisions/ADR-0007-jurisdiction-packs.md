# ADR-0007 — Jurisdiction packs: Ghana first, pluggable by design

**Status:** Accepted · **Date:** 2026-08-20 · **Affects:** Phase 1, Phase 3
**Refines:** `ADR-0002`

## Context
`ADR-0002` established that tax rates are data in an effective-dated table rather than constants
in code. As a multi-tenant product that principle has to extend further: statutory behaviour is
not merely per-*rate*, it is per-*country*. Ghana's VAT, NHIL, GETFund and COVID levies, its
invoice requirements and its currency are one jurisdiction's rules, not the platform's rules.

## Decision
**Ship Ghana only. Design every statutory concern as a per-tenant jurisdiction pack.**

A jurisdiction pack contains:
- **Currency** — code, symbol, and **minor-unit scale** (Ghana: GHS, `GH₵`, 100 pesewas). Money
  remains integer minor units everywhere (`ADR-0004`); the *scale* is what varies.
- **Tax codes and effective-dated rates** — the `(tax_code, rate, effective_from, effective_to)`
  table from `ADR-0002`, per jurisdiction.
- **Invoice and receipt requirements** — required fields, numbering rules, retention.
- **Statutory report formats** — the shape of exports for the local revenue authority.
- **The payroll boundary** — which statutory figures the platform *may never compute*. This is
  jurisdiction-scoped in its detail but **universal in its rule**: no jurisdiction pack ever
  contains payroll withholding logic (`CLAUDE.md` §2.3).

**A tenant belongs to exactly one jurisdiction at launch.** Multi-jurisdiction tenants and FX in
the ledger are explicitly out of scope — FX in a double-entry GL is genuinely hard and there is
no customer asking for it.

## Consequences
- Only the Ghana pack is built and tested. The abstraction costs design time now and no extra
  build; adding Nigeria later is a pack, not a refactor.
- No `if (country === 'GH')` anywhere. If code branches on jurisdiction, the pack is
  under-specified — fix the pack, not the caller.
- Currency scale being a pack value means no code may assume 100 minor units. Some currencies
  have zero or three.
- The human-review gate applies per jurisdiction: a qualified local professional confirms each
  pack before a tenant in that jurisdiction goes live. `compliance-gatekeeper` holds this.

## Alternatives considered
- **Multi-country from day one** — several currencies, several tax regimes, FX in the GL, tested
  up front. Substantially larger scope with no customer demand. Rejected.
- **Ghana hard-coded** — simplest, but every argument in `ADR-0002` about unmaintained statutory
  logic applies, and the first non-Ghanaian customer forces a rewrite. Rejected.
