# Go-live runbook — the items between here and a trading pilot, in lead-time order

**Owner: the founder.** Every item below starts with an act only you can perform; the engineering
either exists or is explicitly out of reach until your act happens. Items 1–5 date from
2026-08-24; items 6–9 and the correction at the end were added on **2026-11-19**, when the
go-live engineering landed (PRs #25–#30 and wave 2 — see `docs/go-live-status.md`).

## 1. Q8 — Ghana e-VAT clearance · LONGEST LEAD, NOT STARTED

**Do:** attach `docs/q8-evat-practitioner-brief.md` to draft 2 of `docs/outreach-drafts.md` and
send to a GRA-registered practitioner. **The date is filled in (1 January 2027)** and both
documents are rewritten for the answered Q21 — nothing remains to complete but the recipient. **Nothing on my side
remains** — the brief is corrected (G-2/G-4), states plainly where our own enforcement has and has
not reached, and includes the standard-rating question. The unknown is Certified Invoicing System
lead time, which only the engagement can answer.

## 2. The accountant and §2.8's month of statements · CALENDAR-BOUND

**Do:** send draft 1 of `docs/outreach-drafts.md`. Attach BOTH
`docs/draft-chart-of-accounts.md` (the chart to tear apart) and
`docs/statements-dry-run.md` (**a full month of generated statements, already produced** — 181
sales rung through the real till, swept to the ledger, reconciled four ways).

**The month-long clock has already been run.** §2.8 asks for a month of statements reviewed
against manual expectation; the month exists, is deterministic, and reproduces from an empty
database with two commands. What remains is their review of it, not the waiting.
**Then the dry run works like this** (this is the machinery this repo now has):
1. Their reviewed chart replaces the draft (Track B, their name on the commit — days of work).
2. The dev/staging stack trades normally; `pnpm dev:post-settled` sweeps settled sales to the
   ledger (production gets a scheduler at that point — a recorded gap, currently a visible
   manual act).
3. Each month-end: Books screen — trial balance zero per location, statements agree, posting
   exceptions zero, reconciliation gate green — checked against their manual expectation.
4. One full calendar month of that is the §2.8 gate. **It cannot start before step 1.**

## 3. Receipt printing · HARDWARE DECISION, THEN A SPIKE

**Do:** choose and buy 1–2 candidate thermal printers. Selection criteria (not models — a model
recommendation would be a guess): ESC/POS command set · Bluetooth Classic SPP **and** USB ·
58 or 80mm · sourced locally enough that 25 outlets can be serviced. If an all-in-one Android
POS terminal with a built-in printer is a candidate, buy one of those too.

**Updated 2026-11-19 — the software side is built (PR #26).** Every route exists behind one
interface: Bluetooth (BLE), USB, serial (laptops), an Android print-app hand-off (reaches Classic
Bluetooth and built-in terminal printers), browser printing (A4 at a desk) and the on-screen
receipt. What remains is the measurement: run `docs/printing-spike-protocol.md` with the printers
you buy — the app's **Printer → spike mode** runs the receipts and shows the pass/fail numbers on
screen. GRA-required fields still wait on Q8's answer.

## 4. Real Android field trial · DEVICE + SIM, THEN A PROTOCOL

**Do:** obtain one representative low-end Android tablet and a Ghanaian SIM (the pilot's actual
network). Protocol, in order, recording each result:
1. Install the PWA; confirm OPFS persistence survives a restart and a week of use.
2. Airplane mode → ring 20+ sales → reconnect → **time to fully synced** (the 60s budget was met
   at p95 212ms on localhost; the field number is the one that matters).
3. Repeat on 3G-grade signal, not just 4G.
4. A full day's trading offline; battery and storage observed.
5. The stale-clock case: set the device clock wrong by hours, confirm the resync refusal appears.
**Then** whatever it surfaces is engineering again (that is the point of the trial).

## 5. Q21 — has Techiman been trading? · **ANSWERED 2026-08-25: NO** ✅

**Answered: the outlet has not opened and has made no sale.** Consequences, all favourable:
Q20 is a clean cut-over rather than a reconstruction (no debtors or creditors to bring across);
Q8 stays prospective, so the practitioner advises on a design instead of assessing a liability
already incurred; and the dry run costs nothing but calendar. The launch date is restated to
**1 January 2027** (`CLAUDE.md` §1).

## 6. Production accounts · SUPABASE + FLY.IO (London) · NOT STARTED

**Do:** follow `docs/production-runbook.md` §8 in order — create the Supabase project in London
**with point-in-time recovery switched on**, apply the roles, create the three Fly.io apps, set the
secrets, deploy, then run `ops verify` and record every MANUAL answer. Ask Supabase for its
recovery-time objective **in writing**. Provisional on Q13 (data residency) — ask that question
first; it is one conversation and it can move the whole hosting decision.

## 7. The sign-in provider · ONE ACCOUNT, THEN CONFIGURATION · NOT STARTED

**Do:** choose a managed OIDC provider hosted in the EU (Zitadel, Auth0 EU or a hosted Keycloak all
fit `02-security` §2.2: OIDC with ES256 or EdDSA, per-user TOTP, an admin API). Create a **public
client with PKCE** whose redirect is `https://<pwa>/auth/callback`, allow the PWA's origin on its
token endpoint, require TOTP for Accounts and head-of-operations users, then set `OIDC_ISSUER` and
`OIDC_CLIENT_ID`. Generate the two key rings with `infra/scripts/gen-identity-keys.mjs`. Production
refuses to start without all of it — that is deliberate.

## 8. Alerts that reach a phone · TWO SMALL CHOICES · NOT STARTED

**Do:** choose where alerts go (a webhook into SMS, WhatsApp or e-mail) and a heartbeat service
that pages when the scheduled jobs stop. Then trigger one test alert and confirm it arrives on the
phone that will be with someone during trading hours. Stage 0 (§9.7.1) requires this.

## 9. Dry run at Techiman, with the paper fallback · CALENDAR · NOT STARTED

**Do:** once 6–8 are done and a tablet and printer are in hand: a dry run with the real staff,
real catalogue and practice customers — open the till, sell (cash, mobile money, split, credit),
return an item, cash up — plus one two-hour **paper** drill, because the paper fallback is a
precondition (§9.7.1), not a contingency. Then the Phase 0 and Phase 1 sign-offs, which are yours.

---
*Item 5 is answered. Items 1 and 2 are emails you could send today, with their attachments already
written; item 1 is the pole. Items 3 and 4 are purchases plus protocols already written; 6–8 are
accounts and configuration.*

**Correction (2026-11-19).** This page used to end "None of what remains is code." That was wrong
in August: there was no production environment, no real sign-in, no printing, no mobile-money or
split payments, no till or cash-up, no returns and no CI. Most of that is now built and tested
(`docs/go-live-status.md` lists what, with evidence, and what is still open). What is still not
code is above — and the critical path is still items 1 and 2.
