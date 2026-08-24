# Go-live runbook — the items between here and a trading pilot, in lead-time order

**Owner: the founder.** Every item below starts with an act only you can perform; the engineering
either exists or is explicitly out of reach until your act happens. Status is honest as of
2026-08-24.

## 1. Q8 — Ghana e-VAT clearance · LONGEST LEAD, NOT STARTED

**Do:** fill the date blank at `docs/q8-evat-practitioner-brief.md` (marked line), attach it to
draft 2 of `docs/outreach-drafts.md`, send to a GRA-registered practitioner. **Nothing on my side
remains** — the brief is corrected (G-2/G-4), states plainly where our own enforcement has and has
not reached, and includes the standard-rating question. The unknown is Certified Invoicing System
lead time, which only the engagement can answer.

## 2. The accountant and §2.8's month of statements · CALENDAR-BOUND

**Do:** send draft 1 of `docs/outreach-drafts.md`. Attach `docs/draft-chart-of-accounts.md` —
there is now a running draft for them to tear apart rather than a blank page.
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
58 or 80mm · sourced locally enough that 25 outlets can be serviced. **Then** the spike is
engineering: Web Bluetooth/USB from the PWA on the chosen Android hardware, receipt layout from
the sale document, GRA-required fields per Q8's answer. The spike is deliberately not built
against an imagined printer — that is how the wrong hardware gets bought.

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

## 5. Q21 — has Techiman been trading since 1 August? · ONE MINUTE, SHAPES EVERYTHING

Answer it in `docs/open-questions.md`. If **yes**: every trading day deepens the opening-balance
reconstruction (Q20), and the practitioner must be told invoices have been issued under an
unconfirmed treatment — it changes their first question. If **no**: the launch date needs formal
restating (`CLAUDE.md` §6.1 still says 1 August 2026) and Q20 becomes a clean cut-over.

---
*2 and 5 are emails you could send today. 1 is the pole. 3 and 4 are purchases plus protocols
that are already written. None of the five is code.*
