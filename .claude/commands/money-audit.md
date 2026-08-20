---
description: Find every money-touching function and verify it is tested and type-safe
---

Audit money-handling code across the Agyasei ERP using the `money-test-engineer` agent.

**1. Enumerate the surface.** Find everything that touches a monetary value — sale totals, credit
balances, facility fees, margins, tax lines, payroll figures, GL postings. Look beyond the
obvious: report aggregations, CSV exports, discount helpers and rounding utilities are money code
too, and are usually the ones nobody labelled as financial.

**2. Check type discipline** (`ADR-0004`). Report every violation as a defect, not a style note:
- Postgres columns holding money that are `float`, `double precision`, `real`, `money` **or
  `numeric`**. They must be `bigint` pesewas.
- Quantity columns stored as floats — 59 SKUs sell by weight, length or area, so quantities are
  scaled integers too.
- TypeScript monetary values typed `number` instead of `bigint`.
- Any place a monetary value round-trips through a float.
- Percentages (margin, the 2–3%/month facility fee, tax rates) stored as floats rather than
  basis points or scaled integers.

**3. Check coverage.** Anything on the list from step 1 without tests is a gap — the first
mandatory test category is not optional (`CLAUDE.md` §2.6). Report specifically what is uncovered.

**4. Check the invariants hold**, over generated inputs, not just examples:
- Line totals sum to the transaction total, exactly.
- Allocations across buckets sum back to the original — no pesewa created or lost, and the
  remainder pesewa lands somewhere documented.
- Every journal entry balances; a reversal plus its original nets to exactly zero.
- Consolidated figures equal the sum of per-outlet figures.
- Inter-outlet stock transfers do not inflate consolidated revenue.

**5. Check the boundaries** — zero, one pesewa, very large amounts; the fiscal year boundary
(**1 August – 31 July**, never calendar years); ageing bucket edges at exactly 30, 31 and 60 days;
facility fee accrual across a month boundary and on a mid-month invoice.

**6. Check for hard-coded statutory rates.** Any hard-coded tax rate is a defect (`ADR-0002`).
Any PAYE bracket, SSNIT rate or withholding logic is a hard violation (`CLAUDE.md` §2.3) — report
it immediately and escalate to `compliance-gatekeeper`.

For each finding: file, line, why it matters, and what it should be instead.
