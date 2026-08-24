# Phase 3 status — Track A complete, Track B blocked on Q6

**Date:** 2026-08-24 · **Constitution:** CLAUDE.md §3 Phase 3 — native double-entry GL enforced at
the database level · templated multi-location chart of accounts · P&L and balance sheet by location
and consolidated · staff records · payroll **data capture only** (§2.4) · bank reconciliation.

The split comes from `docs/phase2-gate.md` §4.3: **mechanism** (Track A — what a ledger *is*, and
what the database refuses) may be built against test-invented accounts; **content** (Track B — a
chart of accounts, a mapping bound to a named account, a costing method, an opening balance, a
GL-bearing tenant reaching `active`) may not pass its first commit without a named, qualified
accountant recorded per `05-general-ledger.md` §5.12. No accountant is named
(`open-questions.md` Q6).

---

## Track A — COMPLETE

| Piece | Where | Proof |
|---|---|---|
| Journal: balance enforced twice, per location, immutable, `ENABLE ALWAYS` | migration `0015` | 25 tests; per-location mutation → exactly 1 red |
| Posting roles (38, platform) + tenant mapping + type/control/postable trigger | migration `0016` | 19 tests; specificity mutation exposed and fixed a vacuous test |
| Posting rules 1–7b, 9 as pure functions; obligation-location rule | `posting/rules.ts` | 23 tests, 4 property-based; shipped-defect mutation → 2 red |
| Engine: settled document → entry or `posting_exception`; never rejects a document | `posting/engine.ts` | 10 tests; silent-failure mutation → 2 red |
| Statements: TB / P&L / BS, consolidated ≡ Σ locations asserted | `posting/statements.ts` | 14 tests; mis-attribution mutation → statement red, **TB stays green** |
| Payroll capture; §2.4 as lint + trigger + validator | migration `0017`, `tools/lint-payroll.mjs` | 20 tests; vacuity checks found 2 real lint bugs |
| Bank & momo reconciliation; conservative matcher; close gate | migration `0018` | 16 tests; 3 mutations, all caught |
| G-5: every Q4 policy decision honoured or refused | `credit-policy.ts` | 13 tests; defect-reinstatement mutation → 9 red |
| G-1: activation gate on unconfirmed tax rates; dev stack shows it | `provisioning.ts`, bootstrap | 8 tests incl. the pinned unread-status test |
| **Read surface: `ledger.*` router, `gl.view`, Books screen** | migration `0019`, `routers/ledger.ts`, `features/books/` | 12 API + 7 UI tests; guard-swap mutation → 3 red incl. discriminator; live 200/403 on a fresh stack |

**Totals:** 1,760 tests / 118 files, 0 failures. Both lints clean. 19 migrations apply from
nothing; the fresh stack holds **zero accounts, zero mappings, zero journal entries, zero cash
accounts** — the safe side of the §4.3 boundary is still pristine, demonstrated on every
`stack:reset`.

## Deliberately absent (and why that is the design)

- **No `gl_balance` rollup** — §5.9.1's own correction: as designed it was stale-but-authoritative.
  Reads go to the lines until a transactionally-maintained rollup is built.
- **No unsynced-documents close condition** — the sync layer's question; a check that returned
  true unconditionally would be worse than a named absence (`reconciliation/reconcile.ts`).
- **No manual-journal route, no `gl.post` capability** — arrives with Track B, with its own review.
- **Nothing reads `platform.tenant.status` outside provisioning** — pinned by a test that fails
  the day it grows a consumer, so the decision is taken deliberately.

## Track B — BLOCKED, and what unblocks it

One act: **name the accountant (Q6)** — `docs/outreach-drafts.md`, draft 1. Then, with them:
chart of accounts + `report_line_key` layout · account mappings (the completeness gate is built:
`mappingGaps()`) · costing method (Q16) · opening balances (Q20 — shaped by Q21's answer) ·
facility-fee account & tax treatment (Q4/Q18, G-3) · §2.8's **one full month of generated
statements** — a calendar month that starts only after they exist.
