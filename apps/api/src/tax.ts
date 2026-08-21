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
import { mulBps, type RoundingMode } from '@erp/money';
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

export interface ComputedTaxLine extends TaxComponentRow {
  baseMinor: bigint;
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
  const computed = new Map<string, bigint>();
  const out: ComputedTaxLine[] = [];
  for (const c of components) {
    if (c.roundingLevel !== 'line') {
      // Document-level rounding is pack-selectable platform behaviour that
      // no built pack uses yet; refuse loudly rather than approximate.
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `tax component ${c.taxCode}: rounding_level 'document' is not implemented in Phase 1`,
      });
    }
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
    out.push({ ...c, baseMinor: base, taxMinor: tax });
  }
  return out;
}
