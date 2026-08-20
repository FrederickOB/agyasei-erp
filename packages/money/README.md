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

## Q8 seam

This module computes tax **amounts** (`mulBps` over pack `rate_bp` rows, with
`base_kind = 'net' | 'net_plus'` composition driven by the caller from
effective-dated `tax_rate` data). It contains **no** e-VAT invoice issuance or
clearance surface — Q8 (`docs/open-questions.md`) is unresolved. See the marked
seam comment in `src/index.ts`.
