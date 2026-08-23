/**
 * What the customer hands over, computed at the counter with the radio off.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INVARIANT THIS FILE EXISTS FOR.
 * ═══════════════════════════════════════════════════════════════════════════
 *   breakdown.netMinor + Σ breakdown.taxes[].taxMinor === grossMinor
 * EXACTLY, for every cart, every composition and every minor-unit scale — and
 * on a tax-INCLUSIVE list `grossMinor` is the shelf price extended by the
 * quantity, to the minor unit. A shelf price is what the customer hands over;
 * a till that shows a different number from the price on the shelf is worse
 * than one that refuses.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A PRICE LIST'S `is_tax_inclusive` ACTUALLY CHANGES.
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE thing: which side of the identity the extended unit price sits on.
 *
 *   inclusive  — the extension IS the gross. The net and the component
 *                amounts are recovered by de-grossing (§4.13 row 6), which
 *                inverts the pack's declared composition and is emphatically
 *                not a single division: two regimes of one jurisdiction can
 *                differ only in `base_kind`/`base_includes`, with no rate
 *                changing, and produce different effective fractions.
 *   exclusive  — the extension IS the net. The component amounts are composed
 *                forward (§4.13 row 5) and the gross is their sum plus it.
 *
 * Both directions run through `@erp/money`, which owns the arithmetic and the
 * residual rule; nothing here rounds, divides or holds a rate.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SERVER IS STILL THE PRICING AUTHORITY.
 * ═══════════════════════════════════════════════════════════════════════════
 * This figure is for the person standing at the counter and for the receipt
 * they walk out with. It travels as `clientTotalMinor` — the contract's
 * stale-price-list DETECTOR — and the server reprices from the list and the
 * rate rows in force on the business date and writes its own number
 * regardless. A divergence is REPORTED, never obeyed and never swallowed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHEN THIS DEVICE CANNOT STATE THE SPLIT.
 * ═══════════════════════════════════════════════════════════════════════════
 * `breakdown` is `null` — not a zero tax line, which would be a filing claim
 * this device has no basis for. The total still stands, because on either kind
 * of list the extension is a figure the list's own convention defines. The
 * counter is never blocked on the client's own tax arithmetic (§8.5: never
 * block the counter), and the server's repriced figure settles it.
 */
import {
  DEFAULT_ROUNDING,
  MoneyError,
  add,
  composeTaxFromNet,
  extractTaxFromGross,
  lineNetMinor,
  taxRoundingLevel,
  type RoundingMode,
  type TaxComponent,
  type TaxComposition,
  type TaxLine,
} from '@erp/money';
import type { CartLineRow } from '../queries/cart';

/**
 * What the cart is priced against: the list's own convention and the pack rows
 * in force on the sale's business date. Both are DATA — one from the tenant's
 * `price_list` row, one from the jurisdiction pack (`tax-components.ts`).
 */
export interface CartPricingBasis {
  readonly isTaxInclusive: boolean;
  readonly components: readonly TaxComponent[];
}

/**
 * The neutral basis: a tax-exclusive list and no pack rows. It is what a
 * local-only device (the offline rehearsal) prices against, and it makes
 * `grossMinor` the plain extension — the behaviour every caller had before
 * inclusive lists could be rung at all.
 */
export const UNTAXED_BASIS: CartPricingBasis = { isTaxInclusive: false, components: [] };

export interface CartPricing {
  /** What the customer hands over. Always meaningful. */
  readonly grossMinor: bigint;
  /** The list's own convention, carried so the UI can label the total. */
  readonly isTaxInclusive: boolean;
  /**
   * Net and component amounts, or `null` when this device cannot state them.
   * When present, `breakdown.grossMinor === grossMinor`, exactly.
   */
  readonly breakdown: TaxComposition | null;
}

/**
 * Extended line amount, rounded ONCE on the extended amount (§4.13 via
 * `@erp/money`). It is expressed in the LIST'S convention: gross on an
 * inclusive list, net on an exclusive one. Which one it is is not knowable
 * from a cart line alone, which is exactly why the basis is a separate
 * argument everywhere below.
 */
export function lineTotalMinor(line: CartLineRow): bigint {
  return lineNetMinor(line.qtyScaled, line.qtyScale, line.unitPriceE4, 'half-up');
}

/** Exact bigint sum of the extended line amounts. */
export function extendedTotalMinor(lines: readonly CartLineRow[]): bigint {
  let sum = 0n;
  for (const line of lines) sum = add(sum, lineTotalMinor(line));
  return sum;
}

/**
 * The mode the NET is rounded at when de-grossing.
 *
 * §4.13 row 6 does not assign this boundary a mode, so it has to be stated
 * rather than defaulted silently (ADR-0004). The rule, in full:
 *
 *   · every component declaring the same `rounding_mode` ⇒ that is the pack's
 *     stated mode for this treatment, and the net uses it;
 *   · components disagreeing ⇒ the pack has stated no single mode here, so the
 *     platform's named default stands (`DEFAULT_ROUNDING`), explicitly, rather
 *     than one component's mode being promoted over another's by position.
 *
 * It changes the answer ONLY when the gross has no forward preimage, and never
 * changes `grossMinor` — so the figure the customer pays, and the figure the
 * server compares against, are the same under either arm.
 */
export function netRoundingModeFor(components: readonly TaxComponent[]): RoundingMode {
  const first = components[0];
  if (first === undefined) return DEFAULT_ROUNDING;
  return components.every((c) => c.roundingMode === first.roundingMode)
    ? first.roundingMode
    : DEFAULT_ROUNDING;
}

/**
 * Document totals from per-line compositions: the SUM of the once-rounded line
 * amounts, per component, in pack order (§4.13 row 5 — the document total is
 * never recomputed against the document base).
 */
function mergeTaxLines(perLine: readonly (readonly TaxLine[])[]): TaxLine[] {
  const order: string[] = [];
  const totals = new Map<string, { base: bigint; computed: bigint; residual: bigint; tax: bigint }>();
  for (const lines of perLine) {
    for (const line of lines) {
      let acc = totals.get(line.code);
      if (acc === undefined) {
        acc = { base: 0n, computed: 0n, residual: 0n, tax: 0n };
        totals.set(line.code, acc);
        order.push(line.code);
      }
      acc.base += line.baseMinor;
      acc.computed += line.computedMinor;
      acc.residual += line.residualMinor;
      acc.tax += line.taxMinor;
    }
  }
  return order.map((code) => {
    const acc = totals.get(code)!;
    return {
      code,
      baseMinor: acc.base,
      computedMinor: acc.computed,
      residualMinor: acc.residual,
      taxMinor: acc.tax,
    };
  });
}

function composeOne(
  amountMinor: bigint,
  basis: CartPricingBasis,
  netMode: RoundingMode,
): TaxComposition {
  return basis.isTaxInclusive
    ? extractTaxFromGross(amountMinor, basis.components, netMode)
    : composeTaxFromNet(amountMinor, basis.components);
}

/**
 * Price a cart.
 *
 * `rounding_level` selects the CALL SITE, not the arithmetic (§7.2.4): `'line'`
 * composes once per line and foots the document from the rounded line amounts;
 * `'document'` composes once over the document amount. `@erp/money` refuses a
 * set that mixes the two, because such a set has no coherent call site.
 */
export function priceCart(
  lines: readonly CartLineRow[],
  basis: CartPricingBasis = UNTAXED_BASIS,
): CartPricing {
  const extended = extendedTotalMinor(lines);
  if (basis.components.length === 0) {
    return { grossMinor: extended, isTaxInclusive: basis.isTaxInclusive, breakdown: null };
  }
  try {
    const netMode = netRoundingModeFor(basis.components);
    if (taxRoundingLevel(basis.components) === 'document') {
      const composition = composeOne(extended, basis, netMode);
      return {
        grossMinor: composition.grossMinor,
        isTaxInclusive: basis.isTaxInclusive,
        breakdown: composition,
      };
    }
    let netMinor = 0n;
    let taxTotalMinor = 0n;
    let grossMinor = 0n;
    const perLine: (readonly TaxLine[])[] = [];
    for (const line of lines) {
      const composition = composeOne(lineTotalMinor(line), basis, netMode);
      netMinor += composition.netMinor;
      taxTotalMinor += composition.taxTotalMinor;
      grossMinor += composition.grossMinor;
      perLine.push(composition.taxes);
    }
    return {
      grossMinor,
      isTaxInclusive: basis.isTaxInclusive,
      breakdown: { netMinor, taxes: mergeTaxLines(perLine), taxTotalMinor, grossMinor },
    };
  } catch (err) {
    // A pack this device cannot compose with is not a reason to stop trading:
    // the counter still knows what the list says, and the server still
    // reprices. The split is reported as unavailable rather than invented.
    if (!(err instanceof MoneyError)) throw err;
    return { grossMinor: extended, isTaxInclusive: basis.isTaxInclusive, breakdown: null };
  }
}

/**
 * Cart total — what the customer hands over.
 *
 * LOCAL DISPLAY AND THE OFFLINE RECEIPT — that is its whole job, plus the
 * `clientTotalMinor` claim the server compares against. It is not, and must
 * never become, the figure `app.sale.total_minor` is written from.
 */
export function cartTotalMinor(
  lines: readonly CartLineRow[],
  basis: CartPricingBasis = UNTAXED_BASIS,
): bigint {
  return priceCart(lines, basis).grossMinor;
}
