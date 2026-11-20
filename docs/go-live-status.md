# Go-live status — after the go-live engineering of 18–19 November 2026

**Date:** 19 November 2026 · **Launch:** 1 January 2027 (`CLAUDE.md` §1) · **Owner:** the founder

This is the one page that says where the build stands against go-live. It supersedes nothing: the
phase-status documents (`phase1-status.md`, `phase2-gate.md`, `phase3-status.md`) remain the
detailed records, and `go-live-runbook.md` remains the founder's to-do list. Where this page and
an older document disagree about something that changed on 18–19 November, this page is newer.

---

## 1. Where it stood on 18 November

Strong foundations (isolation, offline sync, exact money, a database-enforced ledger, unusual test
discipline), but not deployable and not complete enough to run a shop: no production environment
or CI, dev-grade shared-secret authentication, no receipt printing, cash/credit as the only
tenders (no mobile money), no till open or cash-up, no voids or returns, never run in a real
browser, and Phase 1 acceptance criterion 5 (a second tenant invisible at *every* read path) not
holding as written.

## 2. What was built — one PR each, stacked, merged in order

| PR | Package | What it delivers |
|---|---|---|
| #25 | Back office + founder decisions | The laptop "office" room and dashboard; ADR-0003 amendment A1–A4 (tablet-first with laptop and phone secondary; Supabase + Fly.io in London; every printer transport; a managed OIDC provider) |
| #26 | Receipt printing | ESC/POS receipts; Bluetooth, USB, serial, Android print-app hand-off, browser/A4 and on-screen routes behind one interface; per-sale print queue; hardware spike mode |
| #27 | Tenant isolation | Forced RLS on the `platform` tables; a route sweep that fails when a read path lacks a two-tenant test; a probe at every query procedure; an explicit tenant predicate on the scope every report is computed over |
| #28 | Production | Production API build, containers, Fly.io configs, Supabase roles, migrations under a lock, the job runner (posting sweep, sync-scope refresh, digests, lost-write control, sync health), backup and restore drill, provider verification, CI, the production runbook |
| #29 | Till and tenders | Till open, cash-up and count variance; tenant-defined tender methods (cash, mobile money, bank transfer, cheque, on account) with references and split payments; posting rules 1, 11, 11b |
| #30 | Identity and devices | Device enrolment; ES256 tokens bound to the device key; OIDC sign-in; per-user PIN on a shared tablet; offline lease (full → restricted → sealed); revocation that uploads before it wipes; People / Devices / Roles admin; sync access driven by tables, not token claims |
| #31 | Voids, returns, opening stock | Voids and partial returns as their own documents, repriced at the original's prices and rates; refunds by method or as a credit note; restock or write-off; bulk opening-stock import (CSV, dry run, all-or-nothing, once only); the reorder-thresholds button |
| #32 | Browser tests | Playwright in Chromium at tablet (portrait and landscape), laptop and phone; offline cold start from the service worker; a live-stack config; CI job |

**Verification at the top of the stack (#32):** `turbo run typecheck test --force` — 22/22 tasks,
**2,409 tests**, 0 failures; money and payroll lints clean; the browser suite **60 passed** (1
skipped by design); the release smoke against a real Postgres 16 (a non-superuser migrator shaped
like Supabase's) passes end to end, including real ES256 keys, a published key set with no private
material, production **refusing to start** without identity configuration, and every scheduled job
running.

## 3. Defects found while integrating the packages — all fixed and verified

These are the reason integration was done by reading each package against the others rather than
by merging and trusting green suites. Every one would have passed its own package's tests.

| Defect | Consequence if shipped | Fixed in |
|---|---|---|
| Receipts printed every sale as **cash** (printing read a field the new sale payload no longer has) | A mobile-money or on-account customer's receipt says they paid cash | #29 |
| Production `main.ts` never built the identity service; it still minted tokens from a shared secret | Production would have run on dev authentication | #30 |
| The device sync projections had **no scheduler**; the credit ones refreshed hourly | A lapsed grant or a retired device stays in the sync gate indefinitely | #30 (`sync.scope_refresh`, every 60 s) |
| Till open/close were `offline_mode = never` | After 72 hours offline no till could open — cash sales stop on the second day | #30 |
| Report scope relied on RLS alone (no application tenant predicate) | Under a broken policy, tenant B's sales enter tenant A's network totals | #27 |
| An ops alert table carried `tenant_id` without row security; forcing the policy would have silenced alerts | Alerts stop, silently | #28 (operator-only class) |
| The print-app package name (editable at the till) was spliced into an `intent:` URL | A crafted value could send the till to another web page | #26 |
| Six web test files failed at random under load | CI that teaches people to re-run red builds | #27 / #29 |
| **In a real browser, every stored receipt lost its lines** (`wa-sqlite` installs `BigInt.prototype.toJSON`) | On-screen receipts, printing and reprints silently empty of items — invisible to jsdom | #32 |
| The phone counter laid out 759 px wide (rendered at 47 % zoom on a 360 px phone) | The secondary device unusable as a till | #32 |
| Closed tills never reached the books: no job ran the till posting sweep | Till banking and cash-over/short never posted in production | #31 |
| HQ reports were gross of voids and returns | The dashboard overstates revenue after any return | #31 |
| `pnpm dev:token` failed on real Postgres (a parameter typed two ways) | The documented local flow, and drill D6, broken | live verification |
| **No production path to a new tenant's first device.** Sign-in needs an enrolled device; a code is issued only by an administrator signed in on one; the dev stack hid it behind the HS256 path production refuses | Tenant #1 could not have brought its first tablet online in production | `poc/free-tier` — `bootstrapFirstAdmin` (`apps/api/src/identity/first-admin.ts`): first administrator + one 15-minute code, only while no device has enrolled; 8 tests incl. two-tenant isolation |

## 4. Phase 1 acceptance criteria — where each stands now

| # | Criterion | State |
|---|---|---|
| 1 | Airplane-mode sale syncs within 60 s of reconnection | **Demonstrated on the integrated stack**: D1 p95 421 ms; and in a real browser, offline sale → reconnect → "Saved" in 824 ms. Localhost only — **the field number on a low-end tablet over a Ghanaian SIM is still missing.** |
| 2 | Two devices, same SKU, both offline, reconcile or flag | **Demonstrated on the integrated stack** (D2): exact convergence, one movement per operation, ledgers byte-identical. |
| 3 | Credit balance, ageing, facility fee correct across outlets | Balance and ageing demonstrated. **Fee still gated on Q4/Q18** (the accountant). |
| 4 | HQ sees post-sync stock and sales across locations | Demonstrated; the office dashboard (#25) adds the laptop view. |
| 5 | Second tenant invisible at every read path | **Holds** — in the suite (#27: every query procedure probed, the sweep fails on a new one without a probe) and live (D5: zero foreign rows or ids in either tenant's device file; D8: the credit surface). |

## 5. Live verification on the integrated stack — 19 November 2026

From nothing: `pnpm stack:reset` at the top of the stack (#32) — 29 migrations, a 33-table
publication, real Postgres 16, the self-hosted PowerSync service loading the integrated sync rules
with no validation error, the API from this tree. Every result below is from that stack.

| Drill | Result |
|---|---|
| Sync drills D1–D8 (`@powersync/node` devices with their own sqlite files) | **8/8** — D1 p95 **421 ms** vs 60 s; D2 exact convergence; D3 replay all-duplicate, zero new effects; D4 HQ query 14 ms over 57 locations; D5 zero foreign rows/ids per device file; D6 the PWA's own payload; D7 wiped-device regression detected and burned; D8 credit surface |
| Live API drills | **329 checks, 0 failures** — RBAC 30, credit 13, D10 30, D11 56, D12 32, D13 47, credit-client 19, credit-verify 33, credit-offline 37, D17 (tax-inclusive) 32 |
| Live browser drill (Chromium, built PWA) | offline sale recorded in 247 ms; reconnect → **"Saved" in 824 ms** |

**Honest notes.** A first run under a load average of 150–240 (two packages building at once)
failed D1/D2/D6/D8 on download timeouts; re-run on a quiet machine they passed — with two fixes, both
outside the product: `dev:token` (above) and D8's prediction, which still used the pre-device-scope
rule while the tablet correctly held *user scope ∩ device scope*. D17 needed its back-dated cart
built after the till switch, because the client rightly refuses a cash-up with a sale in progress.
Not run here: the demo-month drill (long; the §2.8 month already exists), and anything needing real
hardware, a real OIDC provider or real printers.

## 6. Still open — engineering

- **UX:** tapping "Take payment" while the last product tap is still saving can let "Exact" fill
  the previous total; the server refuses the sale, so the books are right, but the screen confuses.
- **Returns:** same-outlet only (by design, stated in #31); a return slip cannot be reprinted after
  the 7-day print queue; the template's GH₵5,000 outlet-manager return bound is a guess for the
  founder to confirm.
- From the package reports, named and deferred: first-login pre-staging; field-level encryption of
  the sensitive set; per-tenant lease length; shared rate-limit stores across API instances;
  per-ring release pinning; counter fast-forward after a point-in-time restore; a per-device
  sync-state table ("connected but not draining" is unmonitored); shared-drawer vs per-device
  drawer choice in the UI; rule 11a (cash in transit).
- **Role-assignment cost:** each assignment recomputes a tenant's credit and device sync
  projections (about a second per insert on the dev stack). Fine for an admin act; worth measuring
  before any bulk user import.

## 7. Still open — only the founder can move these

From `go-live-runbook.md`, in lead-time order: the GRA e-VAT practitioner (Q8, the pole); the
accountant (Q6 — chart of accounts, costing method Q16, opening balances Q20, the facility fee
Q4/Q18, and §2.8's month of statements); data residency (Q13); printers and the spike; a
low-end Android tablet and a local SIM for the field trial; Supabase and Fly.io accounts; the
sign-in provider; an alert destination; the Techiman dry run with the paper drill; and the Phase 0
and Phase 1 signatures. **None of the engineering above removes any of these.**

## 8. Reading of the date

The engineering that was missing on 18 November is now largely built and verified in suites and
on a real Postgres. The binding constraints on 1 January 2027 are the same ones the August gate
named: the GRA engagement (lead time unknown) and the accountant's review (§2.8), neither of which
has started according to this repository. Whether 1 January holds is decided by when those two
start, not by the build.
