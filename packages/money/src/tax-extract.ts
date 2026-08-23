/**
 * De-grossing a tax-INCLUSIVE price — §4.13 row 6, the inverse of §4.13 row 5.
 *
 * ── THE INVARIANT THIS FILE EXISTS FOR ────────────────────────────────────
 *   netMinor + Σ taxes[].taxMinor === grossMinor
 * EXACTLY, for every gross, every composition, every rounding mode and every
 * minor-unit scale. Not to a tolerance. A shelf price is what the customer
 * hands over; if the parts do not sum to it, either the customer is
 * short-changed or the books do not reconcile.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Extraction is NOT a single division. §4.13 row 6 requires the effective rate
 * to be "derived from the component set and its base composition — **not** from
 * a single rate", because Ghana's own two regimes differ only in composition:
 * levies and VAT on the same net (effective 20%), versus VAT on a base that
 * already includes the levies (effective 21.9%) — with NO rate changing. Both
 * shapes arrive here as data. A constant, or a `if (jurisdiction === …)`, would
 * violate ADR-0002 and ADR-0007.
 */
import { MoneyError } from './errors.js';
import { allocate } from './allocate.js';
import { divRound, floorDivRem } from './rounding.js';
import { assertMinorUnits, assertRoundingMode, type MinorUnits, type RoundingMode } from './types.js';
import {
  assertTaxComponents,
  composeUnchecked,
  type TaxComponent,
  type TaxComposition,
  type TaxLine,
} from './tax.js';

const BP_SCALE = 10_000n;

/**
 * The set's gross-up factor as an EXACT rational: `gross = net × (denominator +
 * numerator) / denominator`. §4.13 row 6's `effective_bp` generalised, because
 * a cascade's effective rate is not always a whole basis point — 3.33% on a
 * base including another 3.33% is 3.440889%, and rounding that to bp before
 * dividing would lose pesewas on large amounts.
 *
 * `denominator` is `10000^(n+1)` for an n-component set, which is exactly the
 * precision needed for every component's multiplier to stay an integer through
 * a full n-deep cascade — so this derivation introduces no rounding at all.
 * Ghana 2026 returns `numerator/denominator = 0.20`; the prior cascade returns
 * `0.219`. Neither figure appears anywhere in this package.
 */
export interface TaxGrossUpFraction {
  readonly numerator: MinorUnits;
  readonly denominator: MinorUnits;
}

function grossUpUnchecked(components: readonly TaxComponent[]): TaxGrossUpFraction {
  const denominator = BP_SCALE ** BigInt(components.length + 1);
  const multipliers = new Map<string, bigint>();
  let numerator = 0n;
  for (const c of components) {
    let baseNum = denominator;
    if (c.baseKind === 'net_plus') {
      for (const inc of c.baseIncludes) baseNum += multipliers.get(inc) ?? 0n;
    }
    const scaled = baseNum * c.rateBp;
    /* c8 ignore next 4 -- unreachable: denominator carries n+1 factors of 10000,
       so every multiplier stays integral; the guard protects a future edit. */
    if (scaled % BP_SCALE !== 0n) {
      throw new MoneyError(`tax component ${c.code}: gross-up multiplier lost precision`);
    }
    const m = scaled / BP_SCALE;
    multipliers.set(c.code, m);
    numerator += m;
  }
  return { numerator, denominator };
}

/** {@link TaxGrossUpFraction} for a validated component set. Exported so a till
 * can display "prices include 20% tax" from pack data instead of a constant. */
export function effectiveTaxFraction(components: readonly TaxComponent[]): TaxGrossUpFraction {
  assertTaxComponents(components);
  return grossUpUnchecked(components);
}

/** The result of de-grossing. Extends {@link TaxComposition}, so a caller that
 * already handles the exclusive path handles this one unchanged. */
export interface TaxExtraction extends TaxComposition {
  /**
   * `true` when `composeTaxFromNet(netMinor, components).grossMinor === grossMinor`
   * — the gross has a forward preimage and this extraction IS its exact inverse,
   * so no residual was placed. `false` means the gross is a value the forward
   * path can never produce (see the module note on skipped grosses).
   */
  readonly roundTrips: boolean;
  /** `gross − net − Σ computed` before placement; `0n` iff `roundTrips`. It is
   * distributed across `taxes[].residualMinor` and never adjusts `netMinor`. */
  readonly residualMinor: MinorUnits;
}

/** The forward gross for a candidate net. Monotone strictly increasing in `n`
 * for non-negative rates, which is what makes the search below exact. */
function grossOf(n: bigint, components: readonly TaxComponent[]): bigint {
  return n + composeUnchecked(n, components).taxTotalMinor;
}

/**
 * De-gross a tax-inclusive amount into its net and its component tax lines.
 *
 * ## The rule, normatively (golden tests pin every clause)
 *
 * 1. **Candidate net** — `ROUND(gross × denominator / (denominator + numerator))`
 *    at `netRoundingMode`, with the fraction from {@link effectiveTaxFraction}.
 *    That is §4.13 row 6's formula with the effective rate derived from the
 *    component set and its base composition, never from a single rate.
 * 2. **Exact inverse first.** `gross(n) = n + Σ tax_c(n)` is strictly increasing
 *    for non-negative rates, so a gross has AT MOST ONE net that reproduces it
 *    forward. This function brackets and binary-searches for that net. When it
 *    exists it is returned, and the tax lines are bit-for-bit what
 *    `composeTaxFromNet` would have produced — so **a sale priced from the net
 *    and the same sale priced from the shelf gross agree exactly**, which is the
 *    whole point of doing this rather than one division.
 * 3. **Residual placement**, only when no such net exists. Because the forward
 *    map is strictly increasing it SKIPS gross values: with a 20% set, net 3
 *    grosses to 3 and net 4 grosses to 5, so a shelf price of 4 has no preimage
 *    at all. Then the candidate net stands and the residual
 *    `gross − net − Σ tax_c` is handed out ONE MINOR UNIT AT A TIME by
 *    largest-remainder {@link allocate} across the components, weighted by
 *    `|base_c| × rate_bp_c` — each component's exact, pre-rounding claim on the
 *    tax. `allocate`'s documented tie rule then applies unchanged: largest
 *    fractional remainder, tie → larger weight, tie → **pack order**.
 *
 * ## WHERE THE REMAINDER LANDS, and why
 *
 * **On the component with the largest exact claim — in practice the highest-rate
 * component, VAT — and on pack order to break a tie.** Weighting by
 * `|base| × rate_bp` rather than by the rounded amounts is deliberate: rounded
 * amounts are all zero on a small line (a 4-pesewa gross at 20% rounds every
 * component to zero), and a zero weight vector would have nowhere to put the
 * unit. The pre-rounding claim is zero only when the component genuinely has no
 * claim, which yields two guarantees worth stating:
 *
 * - **A zero-RATE component always reports exactly `0n`.** Its weight is zero,
 *   `allocate` never hands a zero weight a leftover unit, so a zero-rated line
 *   can never print a non-zero tax figure. That is a filing property, not a
 *   nicety.
 * - **The residual never re-enters a cascade base.** `baseMinor` is computed
 *   from the final net per row 5 and is NOT recomputed after placement; a
 *   residual unit on NHIL does not shift VAT's base. Re-cascading would reopen
 *   the identity this function exists to close. `TaxLine` therefore reports
 *   `computedMinor` (`= ROUND(base × rate)`, re-verifiable) and `residualMinor`
 *   separately, and `taxMinor` is their sum — a re-verifying server must compare
 *   against `computedMinor`, not against `taxMinor`.
 * - **Zero-base fallback, stated rather than hidden:** every base is zero only
 *   when the candidate net is zero (with non-negative rates, `|base_c| ≥ |net|`).
 *   That happens on a sub-minor-unit gross under a very high effective rate —
 *   a 4-pesewa gross at 1000% de-grosses to a net of 0. The claim weights are
 *   then `rate_bp_c` alone, so the whole gross lands on the components as tax,
 *   which is the correct rounding: net 0, tax 4. The alternative — weighting by
 *   an all-zero vector — would have had to invent a rule. The net is never
 *   adjusted by the residual; `Σ rate_bp = 0` implies no residual exists at all,
 *   because a zero-rate set makes the forward map the identity.
 *
 * ## Sign symmetry
 *
 * `extractTaxFromGross(-g, …)` is the EXACT negation of
 * `extractTaxFromGross(g, …)` for every input: the residual is allocated on its
 * magnitude and the sign re-applied, so `allocate`'s floor-based tie handling
 * cannot skew a refund away from the sale it reverses. A full credit note
 * de-grossed from the negated shelf price therefore nets to zero per component.
 * (§7.5 still requires a credit note to INHERIT the invoice's snapshot rather
 * than re-price; this symmetry means the two agree instead of racing.)
 *
 * @param grossMinor       tax-inclusive amount, minor units (may be negative).
 * @param components       the pack rows in force on the business date, in order.
 * @param netRoundingMode  the mode for step 1's division. Explicit, never
 *   defaulted (ADR-0004): the net is its own rounding boundary and §4.13 row 6
 *   does not assign it a mode, so the pack — via the caller — must state one.
 *   It changes the answer ONLY when the gross has no forward preimage.
 */
export function extractTaxFromGross(
  grossMinor: MinorUnits,
  components: readonly TaxComponent[],
  netRoundingMode: RoundingMode,
): TaxExtraction {
  assertMinorUnits(grossMinor, 'grossMinor');
  assertTaxComponents(components);
  assertRoundingMode(netRoundingMode, 'netRoundingMode');

  const { numerator, denominator } = grossUpUnchecked(components);
  const candidate = divRound(grossMinor * denominator, denominator + numerator, netRoundingMode);

  const preimage = findPreimage(grossMinor, candidate, components);
  if (preimage !== null) {
    const { taxes, taxTotalMinor } = composeUnchecked(preimage, components);
    return finish(preimage, taxes, taxTotalMinor, grossMinor, true, 0n);
  }

  const { taxes, taxTotalMinor } = composeUnchecked(candidate, components);
  const residual = grossMinor - candidate - taxTotalMinor;

  let weights = taxes.map((t, i) => (t.baseMinor < 0n ? -t.baseMinor : t.baseMinor) * components[i]!.rateBp);
  if (weights.every((w) => w === 0n)) {
    // Every base is zero — only reachable at a zero candidate net. Fall back to
    // the rate alone, so the gross lands on the components as tax rather than
    // on an all-zero weight vector. See the doc comment.
    weights = components.map((c) => c.rateBp);
  }
  /* c8 ignore next 4 -- unreachable: a set whose rates all sum to zero makes the
     forward map the identity, so a residual cannot exist. Guards a future edit. */
  if (weights.every((w) => w === 0n)) {
    throw new MoneyError('extractTaxFromGross: residual with no component claim');
  }

  const sign = residual < 0n ? -1n : 1n;
  const shares = allocate(residual * sign, weights);
  const placed: TaxLine[] = taxes.map((t, i) => {
    const r = shares[i]! * sign;
    return { ...t, residualMinor: r, taxMinor: t.computedMinor + r };
  });
  return finish(candidate, placed, taxTotalMinor + residual, grossMinor, false, residual);
}

/** Bracket outward from `candidate`, then binary-search the monotone forward
 * map. Returns the unique net whose forward gross is `gross`, or `null` when
 * the forward map skips `gross` entirely. */
function findPreimage(
  gross: bigint,
  candidate: bigint,
  components: readonly TaxComponent[],
): bigint | null {
  const at = (n: bigint): bigint => grossOf(n, components);
  if (at(candidate) === gross) return candidate;

  let lo = candidate;
  let hi = candidate;
  let step = 1n;
  // 128 doublings brackets any bigint a device could hold; the loop is bounded
  // so a non-monotone set (impossible after assertTaxComponents) cannot hang.
  if (at(candidate) < gross) {
    hi = candidate + step;
    for (let i = 0; at(hi) < gross; i++) {
      lo = hi;
      step *= 2n;
      hi += step;
      /* c8 ignore next */
      if (i > 128) throw new MoneyError('extractTaxFromGross: gross-up is not monotone');
    }
  } else {
    lo = candidate - step;
    for (let i = 0; at(lo) > gross; i++) {
      hi = lo;
      step *= 2n;
      lo -= step;
      /* c8 ignore next */
      if (i > 128) throw new MoneyError('extractTaxFromGross: gross-up is not monotone');
    }
  }

  while (hi - lo > 1n) {
    const mid = floorDivRem(lo + hi, 2n).floor;
    const g = at(mid);
    if (g === gross) return mid;
    if (g < gross) lo = mid;
    else hi = mid;
  }
  if (at(lo) === gross) return lo;
  if (at(hi) === gross) return hi;
  return null;
}

function finish(
  netMinor: bigint,
  taxes: readonly TaxLine[],
  taxTotalMinor: bigint,
  grossMinor: bigint,
  roundTrips: boolean,
  residualMinor: bigint,
): TaxExtraction {
  /* c8 ignore next 6 -- the central invariant, asserted rather than assumed.
     Unreachable by construction; it exists so a future edit fails loudly at the
     till instead of shipping a receipt whose parts do not sum to the price. */
  if (netMinor + taxTotalMinor !== grossMinor) {
    throw new MoneyError(
      `extractTaxFromGross: net ${netMinor} + tax ${taxTotalMinor} !== gross ${grossMinor}`,
    );
  }
  return { netMinor, taxes, taxTotalMinor, grossMinor, roundTrips, residualMinor };
}
