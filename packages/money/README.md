# @erp/money

The platform's single money module. ADR-0004 in code: **money is `bigint` minor
units, in Postgres and in TypeScript, and nothing else**. The minor-unit scale is
a jurisdiction-pack value (ADR-0007) — 2 for GHS, but 0/3/4 exist and nothing
here assumes 100. There is no built-in currency registry; the pack supplies the
`CurrencySpec`.

## Surface

| Export | What |
|---|---|
| `MinorUnits`, `RateE4`, `BasisPoints` | `bigint` aliases with meaning: minor units; price scaled ×10⁴ (`10000n` = 1.0); basis points (`1500n` = 15%) |
| `CurrencySpec` | `{ code, symbol, scale }`, scale 0–4, always from the jurisdiction pack |
| `RoundingMode`, `DEFAULT_ROUNDING` | `'half-even'` (default, still passed explicitly) · `'half-up'` (ties away from zero) · `'down'` (toward zero) · `'up'` (away from zero) |
| `add / sub / negate / abs / compare` | exact bigint arithmetic with runtime type guards |
| `divRound(n, d, mode)` | the single rounding site — every helper rounds once, here |
| `mulDiv(amount, num, den, mode)` | general rational multiply, rounded once (unit conversions via `factor_num/factor_den`) |
| `mulRateE4(amount, rateE4, mode)` | amount × e4 rate (unit prices, WAC). `rateE4 = 10000n` is the identity |
| `mulBps(amount, bps, mode)` | amount × basis points (tax components, facility fee, margins) |
| `lineNetMinor(qtyScaled, qtyScale, unitPriceE4, mode)` | §4.13 row 3 verbatim: extended line amount, rounded once on the extension |
| `allocate(total, weights)` | largest-remainder split that sums back exactly (rule below) |
| `TaxComponent` | one pack row of §7.2.4: `{ code, rateBp, baseKind, baseIncludes, roundingLevel, roundingMode }` |
| `assertTaxComponents(components)` | fail-closed validation of a component set (empty set, duplicate code, negative rate, cycle, forward reference) |
| `taxRoundingLevel(components)` | the set's uniform `rounding_level` — chooses the CALL SITE (per line, or once per document) |
| `composeTaxFromNet(netMinor, components)` | **forward**, §4.13 row 5: net → tax lines → gross |
| `extractTaxFromGross(grossMinor, components, netRoundingMode)` | **inverse**, §4.13 row 6: a tax-INCLUSIVE shelf price → net + tax lines (rule below) |
| `effectiveTaxFraction(components)` | the set's exact gross-up rational, derived from composition — never a constant |
| `format / parse` | canonical decimal string ↔ minor units, exact and round-tripping; `parse` rejects floats, exponents, and precision beyond scale |
| `serializeMoney / deserializeMoney` | JSON boundary: minor units as a decimal **string**, never a JSON number (a JSON number is a float64 in every consumer) |
| `MoneyError` | the only failure type; nothing returns NaN/Infinity/silently-wrong |

Every monetary parameter is runtime-asserted to be `bigint`, so a `number`
smuggled through `any` throws instead of drifting. `number` appears only for
digit counts and loop indices.

## The allocation rule (normative)

`allocate(total, weights)` with `S = Σ weights ≠ 0`:

1. Bucket *i*'s exact share is the rational `total × wᵢ / S`.
2. Each bucket gets `floor(exact share)` (toward −∞), so the leftover is always
   `0 ≤ r < buckets` single minor units, for any sign of total or weights.
3. The `r` units go one each to buckets ordered by **largest fractional
   remainder**, ties to the **larger weight** (§4.13 row 4's "highest-value
   line"), then the **lower index** (document order; list ageing buckets
   oldest-first to satisfy row 7's "remainder to the oldest bucket").

Consequences, all tested: zero weights receive exactly `0n`; negative totals
work unchanged; mixed-sign weights are proportional; `S = 0` and empty weight
vectors throw.

## The tax rule (normative)

Rates and base composition are pack **data** (ADR-0002, ADR-0007). This module
holds no rate, no code, no country and no date; it inverts whatever composition
it is handed. Ghana's two regimes differ only in composition — levies and VAT on
the same net (effective 20%) versus VAT on a base that already includes the
levies (effective 21.9%), with **no rate changing** — and both arrive here as
rows.

**Forward** (`composeTaxFromNet`, tax-exclusive list) — for each component *c* in
pack order: `base_c = net + Σ(tax_j : j ∈ base_includes_c)`, then
`tax_c = ROUND(base_c × rate_bp_c / 10000)` at *c*'s own mode, rounded once.
A `base_includes` member absent from the set contributes nothing (the dated
`GH.COVID`-after-repeal case); a member the pack orders *later* throws.

**Inverse** (`extractTaxFromGross`, tax-inclusive shelf price) — the invariant is
`net + Σ tax === gross`, **exactly, for every input**:

1. Candidate net `= ROUND(gross × D / (D + N))` at the caller's explicit
   `netRoundingMode`, with `N/D` from `effectiveTaxFraction` — derived from the
   component set and its base composition, never from a single rate.
2. **The exact inverse wins.** The forward map is strictly increasing (rates are
   ≥ 0), so a gross has at most one net that reproduces it. That net is found by
   bracket-and-binary-search and returned, with tax lines bit-for-bit identical
   to `composeTaxFromNet`'s. **The same sale priced from the net and from the
   shelf gross therefore agree exactly.**
3. **Residual placement**, only when the forward map *skips* the gross (with a
   20% set, net 3 grosses to 3 and net 4 to 5 — a shelf price of 4 has no
   preimage). The residual `gross − net − Σ tax_c` is handed out one minor unit
   at a time by `allocate` across the components, weighted by
   `|base_c| × rate_bp_c` — each component's exact pre-rounding claim. So it
   lands on the **largest claim (in practice the highest-rate component, VAT)**,
   ties to **pack order**.

Consequences, all tested: a zero-**rate** component always reports exactly `0n`;
the residual never re-enters a cascade base (`TaxLine` reports `computedMinor`
and `residualMinor` separately, and a re-verifying server compares against
`computedMinor`); `extractTaxFromGross(-g)` is the exact negation of
`extractTaxFromGross(g)`, so a refund returns what the sale took; and the
minor-unit scale is never read, at any scale 0–4.

## Q8 seam

This module computes tax **amounts** (`mulBps` over pack `rate_bp` rows, with
`base_kind = 'net' | 'net_plus'` composition driven by the caller from
effective-dated `tax_rate` data). It contains **no** e-VAT invoice issuance or
clearance surface — Q8 (`docs/open-questions.md`) is unresolved. See the marked
seam comment in `src/index.ts`.
