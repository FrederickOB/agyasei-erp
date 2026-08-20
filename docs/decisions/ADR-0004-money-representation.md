# ADR-0004 — Money is stored as integer minor units

**Status:** Accepted · **Date:** 2026-08-20 · **Affects:** all phases

## Context
This system computes sale totals, contractor credit balances, a 2–3%/month facility fee, margin
figures, tax lines, payroll amounts and double-entry GL postings. It is also the company's system
of record for its books — there is no third-party accounting SaaS behind it to catch drift.

Floating-point money is the most common and most expensive defect class in systems like this.
It compounds silently: a fraction of a pesewa lost per line becomes a trial balance that will not
balance, and in a double-entry ledger an unbalanced posting is not a rounding annoyance — it is a
corrupt book.

## Decision
**All monetary amounts are integers in pesewas** (1 GH₵ = 100 pesewas).

- Postgres: `bigint`. Never `float`, `double precision`, `real`, or `money`.
- **`numeric` is also non-conforming**, and this needs saying because it is the one plausible
  counter-proposal. `numeric` is exact arbitrary-precision decimal, so unlike the float types it
  is not a correctness hazard *in the database*. It is still rejected, for two reasons: the
  node-postgres driver hands `numeric` back as a string that invites a `parseFloat`, and one
  canonical representation across both layers is the whole point — a second permitted money type
  is a second thing every reviewer has to reason about.
- TypeScript: `bigint`. Never `number` for a monetary value.
  Note that `number` is float64, so pairing an exact `numeric` column with a `number` in
  TypeScript is still fatal — the value is exact in the database, drifts the moment it crosses
  into Node, and is written back wrong. The storage type cannot save you; the language type is
  where it dies.
- Currency code `GHS` throughout; `GH₵` for display only.
- Conversion to a decimal string happens **once**, at the presentation boundary.
- Rounding is explicit and stated wherever it occurs — proportional allocations (a discount
  spread across lines, a facility fee across ageing buckets) must state where the remainder
  pesewa lands, and must sum back to the original total.

## Consequences
- Arithmetic is exact. Totals reconcile.
- `money-test-engineer` enforces this: property-based tests assert that allocations sum to the
  original, and a lint rule rejects float types on money fields.
- Percentage inputs (margin %, the 2–3%/month fee, tax rates) are stored as basis points or
  scaled integers, not floats.
- **Quantities need the same discipline.** 59 of the 219 SKUs sell by weight, length, area or
  bulk load — sand by the ton, binding wire by the kg, rebar by the 12m length *or* by the ton.
  A quantity of 2.5 tons is as float-hazardous as a price. Quantities are scaled integers with
  the scale stated in the column type and comment. See `open-questions.md` Q7, which must be
  resolved in the architecture document — not discovered at the counter.
- Any agent asked to "just use a float for now" refuses and cites this ADR.
