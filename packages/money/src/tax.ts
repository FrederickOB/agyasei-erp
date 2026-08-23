/**
 * Multi-component tax composition — the FORWARD direction (§4.13 row 5).
 *
 * A jurisdiction pack declares an ordered set of components, each with a
 * `rate_bp`, a `base_kind`, an ordered `base_includes`, a `rounding_level` and
 * a `rounding_mode` (§7.2.4 `pack_tax_rate`). This module owns the arithmetic
 * of that declaration and nothing else: it holds no rate, no code, no country
 * and no date. Rates and base composition are pack DATA (ADR-0002, ADR-0007);
 * a constant here would be a violation.
 *
 * The inverse direction — a tax-INCLUSIVE shelf price, de-grossed back to a net
 * and its component lines (§4.13 row 6) — is `./tax-extract.js`, which drives
 * this module. The two share one composition core on purpose: the same sale
 * must not depend on which direction it was computed from.
 */
import { MoneyError } from './errors.js';
import { mulBps } from './arith.js';
import {
  assertMinorUnits,
  assertRoundingMode,
  type BasisPoints,
  type MinorUnits,
  type RoundingMode,
} from './types.js';

/** §7.2.4 `base_kind`: the component applies to the net, or to net plus the
 * already-computed amounts of the components its `base_includes` names. */
export type TaxBaseKind = 'net' | 'net_plus';

/** §7.2.4 `rounding_level`: whether the pack rounds each component once per
 * LINE or once per DOCUMENT. It selects the CALL SITE, not the arithmetic —
 * see {@link taxRoundingLevel}. */
export type TaxRoundingLevel = 'line' | 'document';

/**
 * One component of a tax treatment, in force on the transaction's business
 * date. Field-for-field the pack row of §7.2.4 (`pack_tax_rate` plus its
 * `pack_tax_rate_base_include` children, already ordered by `seq`).
 *
 * `code` is whatever the caller uses to identify a component and to resolve
 * `baseIncludes` against — the server passes `tax_code`. This module only
 * requires that codes are unique within one call and that `baseIncludes`
 * names codes that appear EARLIER in the array (the pack's declared order).
 */
export interface TaxComponent {
  readonly code: string;
  /** Basis points. 15% = `1500n`. Must be ≥ 0 — see {@link assertTaxComponents}. */
  readonly rateBp: BasisPoints;
  readonly baseKind: TaxBaseKind;
  /** Codes folded into this component's base; empty unless `baseKind` is `'net_plus'`. */
  readonly baseIncludes: readonly string[];
  readonly roundingLevel: TaxRoundingLevel;
  readonly roundingMode: RoundingMode;
}

/**
 * One computed component amount.
 *
 * The three amounts are kept separate so an auditor — or a re-verifying
 * server — can check the arithmetic rather than trust it:
 * `computedMinor = ROUND(baseMinor × rateBp / 10000)` at the component's mode,
 * and `taxMinor = computedMinor + residualMinor`. On the forward path
 * `residualMinor` is always `0n`; only de-grossing can place a residual, and
 * §4.13 row 6 requires it to land somewhere visible rather than be absorbed.
 */
export interface TaxLine {
  readonly code: string;
  readonly baseMinor: MinorUnits;
  readonly computedMinor: MinorUnits;
  readonly residualMinor: MinorUnits;
  readonly taxMinor: MinorUnits;
}

/** A priced line or document: `netMinor + taxTotalMinor === grossMinor`, exactly. */
export interface TaxComposition {
  readonly netMinor: MinorUnits;
  readonly taxes: readonly TaxLine[];
  readonly taxTotalMinor: MinorUnits;
  readonly grossMinor: MinorUnits;
}

/**
 * Validates a component set and returns it. Throws {@link MoneyError} on every
 * shape a pack must never present at a till — §7.2.4's coverage rule is
 * fail-closed, and so is this.
 *
 * Refused, each for a stated reason:
 * - **empty set** — an untaxed supply is a ZERO-RATE component in the pack, not
 *   an absent component set. An empty array is a lookup that returned nothing,
 *   i.e. a coverage gap, and a gap must not silently price at 0% tax.
 * - **duplicate `code`** — `baseIncludes` would resolve ambiguously.
 * - **negative `rateBp`** — a negative rate makes the gross-up non-monotone, so
 *   de-grossing has no unique inverse. No pack expresses a rebate this way.
 * - **`baseIncludes` on a `'net'` component** — the pack declared a base that
 *   the `base_kind` then discards. Silently ignoring it is exactly the class of
 *   drift §7.2.4 normalises the child table to prevent.
 * - **`baseIncludes` naming itself or a LATER component** — a cycle or an
 *   evaluation-order error; §7.2.4 rejects both at publish time.
 * - **a mixed `roundingLevel`** — half the set rounds per line and half per
 *   document, so the set has no coherent call site. See {@link taxRoundingLevel}.
 *
 * Deliberately NOT an error: a `baseIncludes` member that is absent from the
 * set entirely. That is the real, dated Ghana case — `GH.COVID` sits in
 * `VAT`'s `base_includes` and has no rate row in force after its repeal — and
 * the pack data governs: an absent member contributes nothing to the base.
 */
export function assertTaxComponents(components: readonly TaxComponent[]): void {
  if (!Array.isArray(components) || components.length === 0) {
    throw new MoneyError(
      'tax components: at least one component is required — an untaxed supply is a ' +
        'zero-RATE component, never an absent component set (§7.2.4 coverage fails closed)',
    );
  }
  const seen = new Set<string>();
  for (let i = 0; i < components.length; i++) {
    const c = components[i]!;
    if (typeof c !== 'object' || c === null) {
      throw new MoneyError(`tax components[${i}]: must be an object`);
    }
    if (typeof c.code !== 'string' || c.code.length === 0) {
      throw new MoneyError(`tax components[${i}]: code must be a non-empty string`);
    }
    if (seen.has(c.code)) {
      throw new MoneyError(`tax components: duplicate component code ${c.code}`);
    }
    assertMinorUnits(c.rateBp, `tax components[${i}].rateBp`);
    if (c.rateBp < 0n) {
      throw new MoneyError(
        `tax component ${c.code}: rate_bp must be ≥ 0; got ${c.rateBp} — a negative rate ` +
          'makes the gross-up non-monotone and de-grossing has no unique inverse',
      );
    }
    if (c.baseKind !== 'net' && c.baseKind !== 'net_plus') {
      throw new MoneyError(`tax component ${c.code}: base_kind must be 'net' or 'net_plus'`);
    }
    if (!Array.isArray(c.baseIncludes)) {
      throw new MoneyError(`tax component ${c.code}: base_includes must be an array`);
    }
    if (c.baseKind === 'net' && c.baseIncludes.length > 0) {
      throw new MoneyError(
        `tax component ${c.code}: base_kind 'net' cannot declare base_includes — ` +
          'the declaration would be silently discarded',
      );
    }
    if (c.roundingLevel !== 'line' && c.roundingLevel !== 'document') {
      throw new MoneyError(`tax component ${c.code}: rounding_level must be 'line' or 'document'`);
    }
    const first = components[0]!;
    if (c.roundingLevel !== first.roundingLevel) {
      throw new MoneyError(
        `tax components: rounding_level is not uniform (${c.code} declares ${c.roundingLevel}, ` +
          `${first.code} declares ${first.roundingLevel}) — there is no single call site for the set`,
      );
    }
    assertRoundingMode(c.roundingMode, `tax component ${c.code}: rounding_mode`);
    for (const inc of c.baseIncludes) {
      if (inc === c.code) {
        throw new MoneyError(`tax component ${c.code}: base_includes names itself (a cycle)`);
      }
      if (!seen.has(inc) && components.some((o) => o.code === inc)) {
        throw new MoneyError(
          `tax component ${c.code}: base_includes names ${inc}, which the pack orders AFTER it — ` +
            'evaluation order is undefined (§7.2.4 acyclicity/order assertion)',
        );
      }
    }
    seen.add(c.code);
  }
}

/**
 * The pack's declared `rounding_level`, asserted to be uniform across the set.
 *
 * `rounding_level` chooses WHERE this module is invoked, not what it computes:
 * `'line'` means call {@link composeTaxFromNet} / `extractTaxFromGross` once per
 * line and sum the rounded line amounts (§4.13 row 5 — the document total is
 * never recomputed from the document net); `'document'` means call it once with
 * the document amount. A set that mixes the two has no coherent call site, so
 * this throws rather than picking one.
 */
export function taxRoundingLevel(components: readonly TaxComponent[]): TaxRoundingLevel {
  assertTaxComponents(components); // uniformity is asserted there, for every entry point
  return components[0]!.roundingLevel;
}

/** The composition core. Assumes {@link assertTaxComponents} has already run. */
export function composeUnchecked(
  netMinor: MinorUnits,
  components: readonly TaxComponent[],
): { readonly taxes: TaxLine[]; readonly taxTotalMinor: bigint } {
  const computed = new Map<string, bigint>();
  const taxes: TaxLine[] = [];
  let total = 0n;
  for (const c of components) {
    let base = netMinor;
    if (c.baseKind === 'net_plus') {
      for (const inc of c.baseIncludes) {
        // Absent member ⇒ contributes nothing. The pack data governs (see
        // assertTaxComponents): GH.COVID after repeal is exactly this case.
        base += computed.get(inc) ?? 0n;
      }
    }
    const tax = mulBps(base, c.rateBp, c.roundingMode);
    computed.set(c.code, tax);
    total += tax;
    taxes.push({ code: c.code, baseMinor: base, computedMinor: tax, residualMinor: 0n, taxMinor: tax });
  }
  return { taxes, taxTotalMinor: total };
}

/**
 * §4.13 row 5, verbatim: for each component *c* in the pack's declared order,
 * `base_c = net + Σ(tax_j : j ∈ base_includes_c)` and
 * `tax_c = ROUND(base_c × rate_bp_c / 10000)` at the component's own
 * `rounding_mode`, rounded ONCE per (line, component).
 *
 * This is the tax-EXCLUSIVE path: the net is known and the gross is derived.
 * `netMinor + taxTotalMinor === grossMinor` holds by construction.
 *
 * Sign-symmetric for every mode and composition: `composeTaxFromNet(-n, …)` is
 * the exact negation of `composeTaxFromNet(n, …)`, which is what lets a full
 * credit note net to zero per component (§7.5).
 */
export function composeTaxFromNet(
  netMinor: MinorUnits,
  components: readonly TaxComponent[],
): TaxComposition {
  assertMinorUnits(netMinor, 'netMinor');
  assertTaxComponents(components);
  const { taxes, taxTotalMinor } = composeUnchecked(netMinor, components);
  return { netMinor, taxes, taxTotalMinor, grossMinor: netMinor + taxTotalMinor };
}
