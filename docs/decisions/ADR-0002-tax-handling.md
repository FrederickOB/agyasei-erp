# ADR-0002 — VAT and levies: computed at the POS, configured as data

**Status:** Accepted · **Date:** 2026-08-20 · **Affects:** Phase 1, Phase 3

## Context
The brief does not mention VAT. The financial model marks it *"informational only,
output-neutral"* at 15%. But FY1 revenue of GH₵2,640,000 sits far above Ghana's VAT registration
threshold, so the POS will be issuing statutory invoices from the first day of trading. Shipping
a POS that cannot produce a compliant invoice would fail on day one.

The brief's own reasoning about payroll applies here with equal force: statutory rates change
with legislation and must not live unmaintained inside custom software.

## Decision
The POS **computes** VAT and the associated levies (NHIL, GETFund, COVID-19 Health Recovery) per
line, and receipts carry the fields the Ghana Revenue Authority requires.

**Every rate lives in an effective-dated tax table** — `(tax_code, rate, effective_from,
effective_to)` — editable by an administrator with the Accounts role. **No rate is ever a
constant in source code.** A historical transaction always reprices against the table row that
was in effect on its transaction date, never today's row.

Each SKU carries a tax code. Tax-inclusive vs. tax-exclusive pricing is explicit per price list.

## Consequences
- Legislative rate changes are an admin edit, not a deployment.
- Reprinting or auditing an old receipt reproduces the original tax lines exactly.
- Tax configuration joins the chart of accounts at the §2.7 human-review gate — the accountant
  confirms registration status and the correct rate set **before** Phase 1 go-live.
- `compliance-gatekeeper` owns the gate; `ledger-engineer` owns the GL treatment of output tax.

## Alternatives considered
- **Capture only, compute externally**: lowest risk, but leaves the counter unable to issue a
  compliant invoice. Rejected.
- **Defer to Phase 3**: means early receipts are not statutory invoices. Rejected.
- **Hard-coded 15%**: rejected on the same grounds as hard-coded PAYE.
