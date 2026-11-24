/**
 * THE COST BASIS — weighted-average cost per (location, product) from the
 * stock ledger, shared by the reports (`routers/reports.ts` inventory days and
 * margin) and the management P&L sheet (`routers/expenses.ts`).
 *
 * One module, so the two screens that quote a cost of goods sold can never
 * disagree about what one is: SALE outflows net of SALE_RETURN inflows, at the
 * weighted average of the location's own COSTED INBOUND movements, rounded
 * once per figure with an explicit mode (ADR-0004). Moved here verbatim from
 * reports.ts; its tests (test/reports.test.ts) pin the behaviour.
 */
import { divRound } from '@erp/money';

/**
 * Per (location, product) ledger aggregates, in the STOCKING unit.
 *
 * `in_qty_cost_e4` is Σ(qty_delta × unit_cost_e4) over costed inbound
 * movements. It is accumulated as `numeric` INSIDE THE QUERY and nowhere else:
 * numeric here is an arbitrary-precision INTEGER accumulator that cannot
 * overflow the way bigint would on a large receipt history (a 400-tonne
 * delivery at scale 3 is 4×10⁸ scaled units, and cost_e4 adds four more
 * digits). It is exact, it is never rounded, it never becomes a column, and
 * it is converted to `bigint` the instant it reaches TypeScript — every
 * division below happens in `@erp/money` with an explicit mode (ADR-0004).
 *
 * COGS counts SALE outflows net of SALE_RETURN inflows and NOTHING ELSE. A
 * TRANSFER_OUT is stock moving between two of the tenant's own locations, not
 * goods sold; counting it would create cost of sales out of thin air at the
 * sending outlet and understate it at the receiving one. WRITE_OFF is a loss,
 * not a cost of sale, and belongs on its own line when the GL arrives
 * (Phase 3).
 *
 * Parameters: $1 location ids (uuid[]), $2 / $3 the inclusive business-date
 * range the PERIOD figures cover. The cost basis itself spans all time.
 */
export const COST_BASIS_SQL = `
  select m.location_id,
         m.product_id,
         max(u.qty_scale)                                    as qty_scale,
         coalesce(sum(m.qty_delta)
                    filter (where m.qty_delta > 0 and m.unit_cost_e4 is not null),
                  0)::bigint::text                           as costed_in_qty,
         coalesce(sum(m.qty_delta::numeric * m.unit_cost_e4::numeric)
                    filter (where m.qty_delta > 0 and m.unit_cost_e4 is not null),
                  0)::text                                   as in_qty_cost_e4,
         coalesce(sum(m.qty_delta), 0)::bigint::text          as on_hand_qty,
         coalesce(-sum(m.qty_delta) filter (where m.source_kind = 'SALE'), 0)::bigint::text
                                                             as sold_qty,
         coalesce(sum(m.qty_delta) filter (where m.source_kind = 'SALE_RETURN'), 0)::bigint::text
                                                             as returned_qty,
         coalesce(-sum(m.qty_delta) filter (where m.source_kind = 'SALE'
                                              and m.business_date between $2::date and $3::date), 0)::bigint::text
                                                             as period_sold_qty,
         coalesce(sum(m.qty_delta) filter (where m.source_kind = 'SALE_RETURN'
                                              and m.business_date between $2::date and $3::date), 0)::bigint::text
                                                             as period_returned_qty
    from app.stock_movement m
    join app.product p on p.tenant_id = m.tenant_id and p.id = m.product_id
    join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
   where m.location_id = any($1::uuid[])
   group by m.location_id, m.product_id
`;

export interface CostBasisRow {
  location_id: string;
  product_id: string;
  qty_scale: number;
  costed_in_qty: string;
  in_qty_cost_e4: string;
  on_hand_qty: string;
  period_sold_qty: string;
  period_returned_qty: string;
}

export interface LocationCostBasis {
  /** Value of stock on the shelf at weighted-average cost, minor units. */
  onHandValueMinor: bigint;
  /** Cost of goods sold in the period, minor units. */
  cogsMinor: bigint;
  /** Products with movement but no costed receipt behind it. */
  missingBasisCount: number;
  /** Products contributing a cost figure. */
  costedProductCount: number; // lint-money-ignore — a count of products, not minor units
}

/** Quantity sold in the period, NET of returns (goods that came back were not sold). */
export function periodSoldNet(row: CostBasisRow): bigint {
  return BigInt(row.period_sold_qty) - BigInt(row.period_returned_qty);
}

/**
 * Value a (location, product)'s stock and its period sales at weighted-average
 * cost, rounding ONCE per figure.
 *
 * value(qty) = Σ(qty_in × cost_e4) × qty / (Σ qty_in × 10^scale × 10⁴)
 *
 * Composed as one rational rather than as (compute a WAC, then multiply) so
 * there is exactly one rounding per reported amount instead of two, and no
 * intermediate rounding to accumulate.
 */
export function valueAt(row: CostBasisRow, qty: bigint): bigint {
  const costedInQty = BigInt(row.costed_in_qty);
  if (costedInQty === 0n || qty === 0n) return 0n;
  const numerator = BigInt(row.in_qty_cost_e4) * qty;
  const denominator = costedInQty * 10n ** BigInt(row.qty_scale + 4);
  return divRound(numerator, denominator, 'half-up');
}

export function costBasisByLocation(rows: CostBasisRow[]): Map<string, LocationCostBasis> {
  const out = new Map<string, LocationCostBasis>();
  for (const row of rows) {
    let entry = out.get(row.location_id);
    if (!entry) {
      entry = {
        onHandValueMinor: 0n,
        cogsMinor: 0n,
        missingBasisCount: 0,
        costedProductCount: 0,
      };
      out.set(row.location_id, entry);
    }
    const onHand = BigInt(row.on_hand_qty);
    // Net of returns: goods that came back were not sold.
    const soldNet = periodSoldNet(row);
    const costedInQty = BigInt(row.costed_in_qty);

    if (costedInQty === 0n) {
      // Movement exists, no receipt ever carried a cost. Counted, never
      // guessed at: a zero here would understate COGS and inflate both
      // margin and inventory days, and all three would look plausible.
      if (onHand !== 0n || soldNet !== 0n) entry.missingBasisCount += 1;
      continue;
    }
    entry.costedProductCount += 1;
    entry.onHandValueMinor += valueAt(row, onHand > 0n ? onHand : 0n);
    entry.cogsMinor += valueAt(row, soldNet > 0n ? soldNet : 0n);
  }
  return out;
}

/**
 * The FALLBACK cost of a quantity at a STATED cost per stocking unit
 * (`app.product_cost.cost_e4`, migration 0032: minor units per ONE stocking
 * unit × 10⁴), for a product that has sold at a location with no costed
 * inbound movement behind it. Rounded once, half-up:
 *
 *   cost(qty) = qty × cost_e4 / 10^(qty_scale + 4)
 */
export function valueAtStatedCost(qty: bigint, qtyScale: number, costE4: bigint): bigint {
  if (qty === 0n || costE4 === 0n) return 0n;
  return divRound(qty * costE4, 10n ** BigInt(qtyScale + 4), 'half-up');
}
