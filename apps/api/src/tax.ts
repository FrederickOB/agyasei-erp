/**
 * Tax computation against the effective-dated platform.tax_rate rows
 * (ADR-0002, ADR-0007; 07-jurisdiction §7.2.4). All arithmetic is @erp/money
 * bigint with the row's own rounding mode; `current_date` never appears —
 * every lookup is by the transaction's business date.
 *
 * base_kind semantics, honoured exactly:
 *   'net'      — the component applies to the taxable net line amount;
 *   'net_plus' — it applies to net PLUS the already-computed amounts of the
 *                components named in base_includes (Ghana pre-2026: VAT on
 *                net + NHIL + GETFund + COVID — the cascade that produced an
 *                effective 21.9% without any rate being 21.9%).
 *
 * Phase 1 component-set rule (documented, revisited when the pack grows a
 * `kind` column): every tax code of the tenant's jurisdiction with a rate
 * row in force on the business date participates in the line. The pilot
 * catalogue is entirely standard-rated (template tax_code GH.VAT.STD), so
 * this is exact for tenant #1; exempt/zero-rated treatments arrive as pack
 * data, not as branches here.
 */
import { TRPCError } from '@trpc/server';
import {
  DEFAULT_ROUNDING,
  MoneyError,
  extractTaxFromGross,
  mulBps,
  taxRoundingLevel,
  type RoundingMode,
  type TaxComponent,
} from '@erp/money';
import type { Queryable } from './db.js';

export interface TaxComponentRow {
  taxRateId: string;
  taxCode: string;
  rateBp: bigint;
  baseKind: 'net' | 'net_plus';
  baseIncludes: readonly string[];
  roundingLevel: 'line' | 'document';
  roundingMode: RoundingMode;
  seq: number;
}

/**
 * One computed component amount, in the SAME shape whichever direction it was
 * computed from — forward from a net (row 5) or backward out of a tax-inclusive
 * shelf price (row 6). That sameness is the point: a sale must not be
 * recognisable as having come from one kind of price list rather than the other.
 *
 * The three amounts are kept apart so an auditor can CHECK the arithmetic
 * rather than trust it: `computedMinor = ROUND(baseMinor × rateBp / 10000)` at
 * the component's own mode, and `taxMinor = computedMinor + residualMinor`.
 * `residualMinor` is always `0n` on the forward path; only de-grossing can
 * place one, and §4.13 row 6 requires it to land somewhere visible rather than
 * be absorbed into a base.
 */
export interface ComputedTaxLine extends TaxComponentRow {
  baseMinor: bigint;
  computedMinor: bigint;
  residualMinor: bigint;
  taxMinor: bigint;
}

const MODE_MAP: Record<string, RoundingMode> = {
  half_up: 'half-up',
  half_even: 'half-even',
  down: 'down',
};

/**
 * All components in force for a jurisdiction on a business date, ordered so
 * that 'net' components compute before any 'net_plus' component that folds
 * them into its base. seq is the stored component order (sale_tax_line.seq).
 */
export async function taxComponentsInForce(
  tx: Queryable,
  jurisdictionCode: string,
  businessDate: string,
): Promise<TaxComponentRow[]> {
  const res = await tx.query<{
    id: string;
    tax_code: string;
    rate_bp: string;
    base_kind: 'net' | 'net_plus';
    base_includes: string[];
    rounding_level: 'line' | 'document';
    rounding_mode: string;
  }>(
    `select id, tax_code, rate_bp::text as rate_bp, base_kind, base_includes,
            rounding_level, rounding_mode
     from platform.tax_rate
     where jurisdiction_code = $1
       and effective @> $2::date`,
    [jurisdictionCode, businessDate],
  );
  const rows = res.rows
    .map((r) => {
      const mode = MODE_MAP[r.rounding_mode];
      if (!mode) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `tax_rate ${r.id}: unknown rounding_mode ${r.rounding_mode}`,
        });
      }
      return {
        taxRateId: r.id,
        taxCode: r.tax_code,
        rateBp: BigInt(r.rate_bp),
        baseKind: r.base_kind,
        baseIncludes: r.base_includes,
        roundingLevel: r.rounding_level,
        roundingMode: mode,
        seq: 0,
      } satisfies TaxComponentRow;
    })
    .sort((a, b) =>
      a.baseKind === b.baseKind
        ? a.taxCode < b.taxCode
          ? -1
          : 1
        : a.baseKind === 'net'
          ? -1
          : 1,
    );
  return rows.map((r, i) => ({ ...r, seq: i + 1 }));
}

/**
 * Compute every component amount for one line. taxableNet is the discounted
 * net line amount in minor units. Each component rounds ONCE, at its own
 * declared mode, per §7.2.4's line-level rule; the document tax total is the
 * SUM of the rounded line amounts, never a recompute against the document
 * base.
 */
export function computeLineTaxes(
  taxableNet: bigint,
  components: readonly TaxComponentRow[],
): ComputedTaxLine[] {
  assertLineRounding(components);
  const computed = new Map<string, bigint>();
  const out: ComputedTaxLine[] = [];
  for (const c of components) {
    let base = taxableNet;
    if (c.baseKind === 'net_plus') {
      for (const inc of c.baseIncludes) {
        // A base_includes member with no rate in force (e.g. GH.COVID before
        // 2021-05-01) simply contributes nothing — the pack data governs.
        const t = computed.get(inc);
        if (t !== undefined) base += t;
      }
    }
    const tax = mulBps(base, c.rateBp, c.roundingMode);
    computed.set(c.taxCode, tax);
    out.push({ ...c, baseMinor: base, computedMinor: tax, residualMinor: 0n, taxMinor: tax });
  }
  return out;
}

/**
 * Document-level rounding is pack-selectable platform behaviour that no built
 * pack uses yet. Refuse loudly rather than approximate — on BOTH pricing
 * directions, so the inclusive path cannot quietly acquire a behaviour the
 * exclusive path refuses.
 */
function assertLineRounding(components: readonly TaxComponentRow[]): void {
  for (const c of components) {
    if (c.roundingLevel !== 'line') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `tax component ${c.taxCode}: rounding_level 'document' is not implemented in Phase 1`,
      });
    }
  }
}

/**
 * The pack rows as @erp/money's component set — field for field, nothing
 * derived. `taxCode` is the code `base_includes` resolves against, which is
 * what `platform.tax_rate.base_includes` already stores.
 */
export function toTaxComponents(rows: readonly TaxComponentRow[]): TaxComponent[] {
  return rows.map((r) => ({
    code: r.taxCode,
    rateBp: r.rateBp,
    baseKind: r.baseKind,
    baseIncludes: r.baseIncludes,
    roundingLevel: r.roundingLevel,
    roundingMode: r.roundingMode,
  }));
}

/**
 * FAIL CLOSED AT THE TILL (07 §7.2.4, M12). @erp/money refuses a component set
 * a pack must never present — an empty set, a duplicate code, a negative rate,
 * a `base_includes` cycle or forward reference, a mixed `rounding_level`. Those
 * are `MoneyError`s, which would surface as a 500 and tell the counter nothing.
 * Translate them into one operator-visible refusal naming the DATE and the
 * treatment, so the answer at the counter is "this pack cannot price today",
 * not "server error".
 */
export function assertPackPriceable(
  components: readonly TaxComponentRow[],
  businessDate: string,
): void {
  assertLineRounding(components);
  try {
    taxRoundingLevel(toTaxComponents(components));
  } catch (e) {
    if (e instanceof MoneyError) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          `the tax components in force on ${businessDate} ` +
          `(${components.map((c) => c.taxCode).join(', ') || 'none'}) cannot price a line: ` +
          `${e.message} — the jurisdiction pack must be corrected before this sale can be rung`,
      });
    }
    throw e;
  }
}

/** What {@link extractLineTaxes} returns: row 5's shape, plus the de-grossing
 * facts a caller may want to record — see `residualMinor`. */
export interface ExtractedLineTax {
  /** The de-grossed net. `netMinor + Σ taxes[].taxMinor === grossMinor`, exactly. */
  netMinor: bigint;
  taxes: ComputedTaxLine[];
  taxTotalMinor: bigint;
  /** `gross − net − Σ computed` before placement; `0n` when the gross has an
   * exact forward preimage, i.e. when this extraction IS `composeTaxFromNet`'s
   * inverse. Non-zero is normal, not an error: the forward map skips gross
   * values, so roughly one shelf price in six under a 20% set has no preimage. */
  residualMinor: bigint;
  /** `true` when no residual had to be placed. */
  roundTrips: boolean;
}

/**
 * THE ROUNDING DECISION on the de-grossing path — the net's own mode.
 *
 * §4.13 row 6 fixes the de-grossing FORMULA but assigns the net no rounding
 * mode, and `platform.tax_rate.rounding_mode` is the mode for a COMPONENT's
 * amount, a different boundary that is already honoured per component. So this
 * boundary has to be STATED rather than defaulted silently (ADR-0004). The
 * rule, in full:
 *
 *   · every component declaring the same `rounding_mode` ⇒ that is the pack's
 *     stated mode for this treatment, and the net uses it;
 *   · components disagreeing ⇒ the pack has stated no single mode here, so the
 *     platform's named default stands (`DEFAULT_ROUNDING`), explicitly, rather
 *     than one component's mode being promoted over another's by position.
 *
 * It changes the answer ONLY when the gross has no exact forward preimage —
 * @erp/money searches for the net that reproduces the gross exactly first — and
 * it never changes the gross, so the customer pays the quoted price either way.
 *
 * ONE RULE, TWO PLACES, DELIBERATELY IDENTICAL. The counter computes its own
 * local total while offline (`apps/web/src/data/pricing/cart-pricing.ts`,
 * `netRoundingModeFor`) and the server reprices on arrival; if the two picked
 * different modes they would disagree by a minor unit on exactly the awkward
 * grosses, and every such sale would come back flagged by the price check. The
 * duplication is the defect risk: this belongs in `@erp/money` beside
 * `extractTaxFromGross` so there is one definition, and moving it there is the
 * follow-up. Until then, these two functions must be changed together.
 *
 * Derived from the components INSIDE `extractLineTaxes` rather than passed in,
 * so a sale and its later recompute cannot pick different modes: the components
 * are snapshotted on the sale, so the mode is snapshotted with them.
 */
export function netRoundingModeFor(components: readonly TaxComponentRow[]): RoundingMode {
  const first = components[0];
  if (first === undefined) return DEFAULT_ROUNDING;
  return components.every((c) => c.roundingMode === first.roundingMode)
    ? first.roundingMode
    : DEFAULT_ROUNDING;
}

/**
 * §4.13 row 6 — de-gross a tax-INCLUSIVE extended shelf price into the net and
 * the component tax lines, inverting whatever composition the pack declares.
 *
 * The effective rate is derived by @erp/money from the component set and its
 * base composition, never from a constant and never from a single rate: Ghana's
 * two regimes differ ONLY in composition (levies and VAT on the same net, 20%
 * effective, versus VAT on a base that already includes the levies, 21.9%) with
 * no rate changing. Both shapes arrive here as pack data, on the business
 * date's rows (ADR-0002, ADR-0007).
 *
 * The net's own rounding mode is derived from the same components — see
 * {@link netRoundingModeFor} for the decision and why it is not a parameter.
 */
export function extractLineTaxes(
  grossMinor: bigint,
  components: readonly TaxComponentRow[],
): ExtractedLineTax {
  assertLineRounding(components);
  const ex = extractTaxFromGross(
    grossMinor,
    toTaxComponents(components),
    netRoundingModeFor(components),
  );
  // Same order in, same order out — `toTaxComponents` is a positional map, so
  // index i of the result is index i of the pack rows. Asserted, not assumed.
  const taxes = components.map((c, i) => {
    const t = ex.taxes[i];
    if (!t || t.code !== c.taxCode) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `tax extraction returned component ${t?.code ?? '(none)'} where ${c.taxCode} was expected`,
      });
    }
    return {
      ...c,
      baseMinor: t.baseMinor,
      computedMinor: t.computedMinor,
      residualMinor: t.residualMinor,
      taxMinor: t.taxMinor,
    } satisfies ComputedTaxLine;
  });
  return {
    netMinor: ex.netMinor,
    taxes,
    taxTotalMinor: ex.taxTotalMinor,
    residualMinor: ex.residualMinor,
    roundTrips: ex.roundTrips,
  };
}
