/**
 * Cross-location HQ reporting (CLAUDE.md §3, Phase 1; acceptance criterion 4:
 * "HQ sees near-real-time stock and sales across every connected location in
 * one view").
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR RULES, AND WHY EACH ONE IS HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **Σ(per-location) = the total, checked at runtime, not just in a test.**
 *    Every route that produces both rows and a total computes them with TWO
 *    SEPARATE aggregates and compares the results before answering. If they
 *    disagree the request fails loudly instead of returning a plausible
 *    number. A report whose parts do not add up to its whole misstates a
 *    book in the most expensive way there is: quietly, in a figure somebody
 *    then acts on. The obvious implementation — sum the rows in TypeScript —
 *    would make the identity true by construction and therefore prove
 *    nothing; this one can actually fail, which is the point.
 *
 * 2. **Everything is derived from the ledgers.** Stock is SUM over
 *    `app.stock_movement`, never a cached counter (CLAUDE.md §2.2), so two
 *    outlets that traded the same SKU while partitioned converge in any
 *    arrival order. Sales are the sale documents themselves. Nothing here
 *    reads a rolled-up total that some other write path was supposed to keep
 *    up to date.
 *
 * 3. **Money and quantities are exact bigints end to end**, crossing the wire
 *    as decimal strings (ADR-0004). No route in this file multiplies,
 *    divides or averages without an explicit rounding mode from `@erp/money`,
 *    and no intermediate is ever a JS number.
 *
 * 4. **Inter-location transfers are not revenue and not cost.** Revenue is
 *    read from `app.sale`, which a transfer never produces — a transfer is
 *    two `app.stock_movement` rows and nothing else — so moving stock from
 *    Techiman to Wenchi cannot inflate the network total no matter how the
 *    dates line up. COGS is likewise restricted to SALE outflows. Both are
 *    asserted in `test/reports.test.ts` rather than left to the reader.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ACCESS: `report.view.location` vs `report.view.tenant`
 * ═══════════════════════════════════════════════════════════════════════════
 * The scope is resolved per request from `app.effective_permission` (never
 * from the token) by `./scope.ts`. `report.view.tenant` is a WIDENER, held at
 * the root of the location tree, not an alternative to
 * `report.view.location`: a role composed with the tenant code alone is
 * refused at the door. That is a deliberate composition rule — the network
 * total is the location report widened, so the wide right presupposes the
 * narrow one — and it is asserted in the permission-matrix tests so it stays
 * a decision rather than becoming an accident.
 *
 * Cost and margin figures sit behind `report.view.margin` instead, resolved
 * the same way: an outlet manager sees their outlet's takings and cannot see
 * what the goods cost.
 */
import { TRPCError } from '@trpc/server';
import {
  distributionCostReportInput,
  inventoryDaysReportInput,
  cashPositionReportInput,
  salesReportInput,
  stockReportInput,
  salesByDayReportInput,
} from '@erp/contracts';
import { divRound } from '@erp/money';
import type { Queryable } from '../db.js';
import { permissionProcedure, router } from '../trpc.js';
import { wire } from '../wire.js';
import {
  HAULAGE_METHOD_NOTE,
  HAULAGE_PERIOD_NOTE,
  loadHaulageSpend,
  type HaulageBucket,
} from './logistics.js';
import { resolveGroupRollup, resolveLocationScope, type ScopedLocation } from './scope.js';

/** Locations that can ring a sale. GROUP nodes have no till (04 §4.3). */
const SELLING_KINDS = ['OUTLET'] as const;
/**
 * Locations the DISTRIBUTION-COST ratio spans: the union of "can ring a sale"
 * and "can bear a haulage cost". A warehouse has no till and still pays
 * hauliers, so scoping this report to selling locations alone would drop
 * inbound freight from the numerator while keeping every cedi in the
 * denominator — a ratio that flatters the business it is supposed to measure.
 */
const DISTRIBUTION_KINDS = ['OUTLET', 'WAREHOUSE'] as const;
/** Locations that can hold stock. TRANSIT is goods in motion — a real place. */
const STOCK_KINDS = ['OUTLET', 'WAREHOUSE', 'TRANSIT'] as const;

/**
 * Inclusive calendar days in a business-date range. Both ends count: a
 * one-day report covers one day, not zero. `number` because it is a count of
 * days, never a magnitude.
 */
function inclusiveDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Rule 1, as a function. Called with two INDEPENDENTLY computed figures.
 *
 * This never fires in a correct server; it exists so that the day somebody
 * adds a predicate to one query and forgets the other, the report stops
 * rather than lies.
 */
function assertAggregateIdentity(
  label: string,
  partsSum: bigint,
  independentTotal: bigint,
): void {
  if (partsSum !== independentTotal) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message:
        `REPORT_IDENTITY_VIOLATION: ${label} — the sum of the per-location rows ` +
        `(${partsSum.toString(10)}) does not equal the independently aggregated total ` +
        `(${independentTotal.toString(10)}). Refusing to answer with a figure that does not add up.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

interface SalesRow {
  location_id: string;
  sale_count: string;
  subtotal_net_minor: string;
  discount_minor: string;
  tax_total_minor: string;
  total_minor: string;
}

/**
 * Sale money is aggregated straight off `app.sale`, whose own
 * `sale_total_identity` CHECK already guarantees, per document, that
 * total = subtotal − discount + tax. Summing exact integers preserves that,
 * so the aggregate identity holds for the same reason the row one does.
 *
 * VOIDS AND RETURNS (0030) are their own documents, `app.sale_return`, with
 * POSITIVE magnitudes; nothing is ever written to the original sale. These
 * figures are NET of them, in the period the void or return happened (its
 * own business date — the till the refund left), which is how the books post
 * them (rule 10 contra-revenue; a void reverses its sale's entry). The sale
 * COUNT counts sales only: a return is not a negative sale.
 */
const SALES_AND_RETURNS_SQL = `
  select s.location_id, s.business_date, 1 as n,
         s.subtotal_net_minor as subtotal, s.discount_minor as discount,
         s.tax_total_minor as tax, s.total_minor as total
    from app.sale s
   where s.location_id = any($1::uuid[])
     and s.business_date between $2::date and $3::date
  union all
  select r.location_id, r.business_date, 0,
         -r.subtotal_net_minor, -r.discount_minor, -r.tax_total_minor, -r.total_minor
    from app.sale_return r
   where r.location_id = any($1::uuid[])
     and r.business_date between $2::date and $3::date
`;

const SALES_BY_LOCATION_SQL = `
  select x.location_id,
         coalesce(sum(x.n), 0)::bigint::text        as sale_count,
         coalesce(sum(x.subtotal), 0)::bigint::text as subtotal_net_minor,
         coalesce(sum(x.discount), 0)::bigint::text as discount_minor,
         coalesce(sum(x.tax), 0)::bigint::text      as tax_total_minor,
         coalesce(sum(x.total), 0)::bigint::text    as total_minor
    from (${SALES_AND_RETURNS_SQL}) x
   group by x.location_id
`;

/** The same predicate, aggregated WITHOUT the grouping. Rule 1's other half. */
const SALES_TOTAL_SQL = `
  select coalesce(sum(x.n), 0)::bigint::text        as sale_count,
         coalesce(sum(x.subtotal), 0)::bigint::text as subtotal_net_minor,
         coalesce(sum(x.discount), 0)::bigint::text as discount_minor,
         coalesce(sum(x.tax), 0)::bigint::text      as tax_total_minor,
         coalesce(sum(x.total), 0)::bigint::text    as total_minor
    from (${SALES_AND_RETURNS_SQL}) x
`;

interface SalesFigures {
  saleCount: bigint;
  subtotalNetMinor: bigint;
  discountMinor: bigint;
  taxTotalMinor: bigint;
  totalMinor: bigint;
}

const ZERO_SALES: SalesFigures = {
  saleCount: 0n,
  subtotalNetMinor: 0n,
  discountMinor: 0n,
  taxTotalMinor: 0n,
  totalMinor: 0n,
};

function salesFrom(row: Omit<SalesRow, 'location_id'>): SalesFigures {
  return {
    saleCount: BigInt(row.sale_count),
    subtotalNetMinor: BigInt(row.subtotal_net_minor),
    discountMinor: BigInt(row.discount_minor),
    taxTotalMinor: BigInt(row.tax_total_minor),
    totalMinor: BigInt(row.total_minor),
  };
}

function addSales(a: SalesFigures, b: SalesFigures): SalesFigures {
  return {
    saleCount: a.saleCount + b.saleCount,
    subtotalNetMinor: a.subtotalNetMinor + b.subtotalNetMinor,
    discountMinor: a.discountMinor + b.discountMinor,
    taxTotalMinor: a.taxTotalMinor + b.taxTotalMinor,
    totalMinor: a.totalMinor + b.totalMinor,
  };
}

function wireSales(f: SalesFigures) {
  return {
    saleCount: wire(f.saleCount),
    /** Ex-tax revenue before discounts. */
    subtotalNetMinor: wire(f.subtotalNetMinor),
    discountMinor: wire(f.discountMinor),
    /** Ex-tax revenue AFTER discounts — the gross-margin denominator. */
    netRevenueMinor: wire(f.subtotalNetMinor - f.discountMinor),
    taxTotalMinor: wire(f.taxTotalMinor),
    /** What the customer owed, tax included. */
    totalMinor: wire(f.totalMinor),
  };
}

async function loadSales(
  tx: Queryable,
  locationIds: readonly string[],
  from: string,
  to: string,
): Promise<{ byLocation: Map<string, SalesFigures>; total: SalesFigures }> {
  const ids = [...locationIds];
  const rows = await tx.query<SalesRow>(SALES_BY_LOCATION_SQL, [ids, from, to]);
  const byLocation = new Map<string, SalesFigures>();
  for (const r of rows.rows) byLocation.set(r.location_id, salesFrom(r));

  const totalRes = await tx.query<Omit<SalesRow, 'location_id'>>(SALES_TOTAL_SQL, [ids, from, to]);
  const total = salesFrom(totalRes.rows[0]!);

  const partsSum = [...byLocation.values()].reduce(addSales, ZERO_SALES);
  assertAggregateIdentity('sales.totalMinor', partsSum.totalMinor, total.totalMinor);
  assertAggregateIdentity('sales.subtotalNetMinor', partsSum.subtotalNetMinor, total.subtotalNetMinor);
  assertAggregateIdentity('sales.discountMinor', partsSum.discountMinor, total.discountMinor);
  assertAggregateIdentity('sales.taxTotalMinor', partsSum.taxTotalMinor, total.taxTotalMinor);
  assertAggregateIdentity('sales.saleCount', partsSum.saleCount, total.saleCount);

  return { byLocation, total };
}

/**
 * The same predicate again, grouped by BUSINESS DAY rather than by location.
 * `business_date` is the trading day the sale was filed under at its
 * location (never the server clock), so a day here is a day on that till.
 */
const SALES_BY_DAY_SQL = `
  select x.business_date::text                      as business_date,
         coalesce(sum(x.n), 0)::bigint::text        as sale_count,
         coalesce(sum(x.subtotal), 0)::bigint::text as subtotal_net_minor,
         coalesce(sum(x.discount), 0)::bigint::text as discount_minor,
         coalesce(sum(x.tax), 0)::bigint::text      as tax_total_minor,
         coalesce(sum(x.total), 0)::bigint::text    as total_minor
    from (${SALES_AND_RETURNS_SQL}) x
   group by x.business_date
   order by x.business_date
`;

interface SalesDayRow extends Omit<SalesRow, 'location_id'> {
  business_date: string;
}

/** Every calendar day of an inclusive range, as `YYYY-MM-DD`. */
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Sales per business day over the range, with Σ(days) = total CHECKED against
 * the independent total query, exactly as `loadSales` checks Σ(locations).
 * A day with no trade is a ZERO row, not a missing one: the dashboard draws
 * a dark Sunday as a dip to nothing, and a missing day would be drawn as a
 * gap that reads as "data not received".
 */
async function loadSalesByDay(
  tx: Queryable,
  locationIds: readonly string[],
  from: string,
  to: string,
): Promise<{ days: { date: string; figures: SalesFigures }[]; total: SalesFigures }> {
  const ids = [...locationIds];
  const rows = await tx.query<SalesDayRow>(SALES_BY_DAY_SQL, [ids, from, to]);
  const byDate = new Map<string, SalesFigures>();
  for (const r of rows.rows) byDate.set(r.business_date.slice(0, 10), salesFrom(r));

  const totalRes = await tx.query<Omit<SalesRow, 'location_id'>>(SALES_TOTAL_SQL, [ids, from, to]);
  const total = salesFrom(totalRes.rows[0]!);

  const days = eachDay(from, to).map((date) => ({ date, figures: byDate.get(date) ?? ZERO_SALES }));
  const partsSum = days.map((d) => d.figures).reduce(addSales, ZERO_SALES);
  assertAggregateIdentity('salesByDay.totalMinor', partsSum.totalMinor, total.totalMinor);
  assertAggregateIdentity('salesByDay.subtotalNetMinor', partsSum.subtotalNetMinor, total.subtotalNetMinor);
  assertAggregateIdentity('salesByDay.discountMinor', partsSum.discountMinor, total.discountMinor);
  assertAggregateIdentity('salesByDay.taxTotalMinor', partsSum.taxTotalMinor, total.taxTotalMinor);
  assertAggregateIdentity('salesByDay.saleCount', partsSum.saleCount, total.saleCount);
  return { days, total };
}

function locationHeader(l: ScopedLocation) {
  return { locationId: l.id, locationCode: l.code, locationName: l.name, kind: l.kind };
}

// ---------------------------------------------------------------------------
// Cost basis — the weighted-average cost that inventory days and margin need
// ---------------------------------------------------------------------------

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
 */
const COST_BASIS_SQL = `
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

interface CostBasisRow {
  location_id: string;
  product_id: string;
  qty_scale: number;
  costed_in_qty: string;
  in_qty_cost_e4: string;
  on_hand_qty: string;
  period_sold_qty: string;
  period_returned_qty: string;
}

interface LocationCostBasis {
  /** Value of stock on the shelf at weighted-average cost, minor units. */
  onHandValueMinor: bigint;
  /** Cost of goods sold in the period, minor units. */
  cogsMinor: bigint;
  /** Products with movement but no costed receipt behind it. */
  missingBasisCount: number;
  /** Products contributing a cost figure. */
  costedProductCount: number; // lint-money-ignore — a count of products, not minor units
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
function valueAt(row: CostBasisRow, qty: bigint): bigint {
  const costedInQty = BigInt(row.costed_in_qty);
  if (costedInQty === 0n || qty === 0n) return 0n;
  const numerator = BigInt(row.in_qty_cost_e4) * qty;
  const denominator = costedInQty * 10n ** BigInt(row.qty_scale + 4);
  return divRound(numerator, denominator, 'half-up');
}

function costBasisByLocation(rows: CostBasisRow[]): Map<string, LocationCostBasis> {
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
    const soldNet = BigInt(row.period_sold_qty) - BigInt(row.period_returned_qty);
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

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/** Read-and-report base: the caller must hold the location report capability. */
const reportProcedure = permissionProcedure({ code: 'report.view.location', at: 'any' });
/** Cost/margin base: a strictly narrower audience (02 §2.4). */
const marginProcedure = permissionProcedure({ code: 'report.view.margin', at: 'any' });

export const reportsRouter = router({
  /**
   * Sales by location, and the total over the same resolved scope.
   *
   * The identity Σ(locations) = total is CHECKED, not assumed — see
   * `assertAggregateIdentity`. `scope.network` says whether "total" means the
   * whole tenant or only what this caller may see; an outlet manager gets a
   * true total of their own outlets and is told it is not the network's.
   */
  salesByLocation: reportProcedure.input(salesReportInput).query(async ({ ctx, input }) => {
    const scope = await resolveLocationScope(ctx, {
      code: 'report.view.location',
      widenCode: 'report.view.tenant',
      requested: input.locationIds,
      kinds: SELLING_KINDS,
    });

    const { byLocation, total } = await ctx.deps.runner.withTenant(
      ctx.identity.tenantId,
      (tx) => loadSales(tx, scope.locationIds, input.from, input.to),
    );

    return {
      from: input.from,
      to: input.to,
      days: inclusiveDays(input.from, input.to),
      scope: { network: scope.network, locationCount: scope.locations.length },
      locations: scope.locations.map((l) => ({
        ...locationHeader(l),
        ...wireSales(byLocation.get(l.id) ?? ZERO_SALES),
      })),
      total: wireSales(total),
    };
  }),

  /**
   * Sales by business day over the same scope — the dashboard's line. Same
   * scope resolution, same range rule, same checked identity, and a zero row
   * for every day the range covers.
   */
  salesByDay: reportProcedure.input(salesByDayReportInput).query(async ({ ctx, input }) => {
    const scope = await resolveLocationScope(ctx, {
      code: 'report.view.location',
      widenCode: 'report.view.tenant',
      requested: input.locationIds,
      kinds: SELLING_KINDS,
    });

    const { days, total } = await ctx.deps.runner.withTenant(
      ctx.identity.tenantId,
      (tx) => loadSalesByDay(tx, scope.locationIds, input.from, input.to),
    );

    return {
      from: input.from,
      to: input.to,
      days: inclusiveDays(input.from, input.to),
      scope: { network: scope.network, locationCount: scope.locations.length },
      series: days.map((d) => ({ date: d.date, ...wireSales(d.figures) })),
      total: wireSales(total),
    };
  }),

  /**
   * Stock on hand by location and SKU, DERIVED from the movement ledger
   * (`app.stock_on_hand` = SUM over `app.stock_movement`). Never a counter.
   *
   * Quantities are scaled integers in each product's STOCKING unit, with the
   * unit and its scale on every row, so the network rollup adds like to like
   * — a SKU sold by the tonne and stocked by the bar is still counted in bars
   * (04 §4.4.3).
   */
  stockOnHand: reportProcedure.input(stockReportInput).query(async ({ ctx, input }) => {
    const scope = await resolveLocationScope(ctx, {
      code: 'report.view.location',
      widenCode: 'report.view.tenant',
      requested: input.locationIds,
      kinds: STOCK_KINDS,
    });

    const rows = await ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
      const res = await tx.query<{
        location_id: string;
        product_id: string;
        sku_code: string;
        product_name: string;
        qty_on_hand: string;
        qty_scale: number;
        uom_code: string;
      }>(
        `select soh.location_id,
                soh.product_id,
                p.sku_code,
                p.name as product_name,
                soh.qty_on_hand::text,
                u.qty_scale,
                u.code as uom_code
           from app.stock_on_hand soh
           join app.product p on p.tenant_id = soh.tenant_id and p.id = soh.product_id
           join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
          where soh.location_id = any($1::uuid[])
            and ($2::uuid[] is null or soh.product_id = any($2::uuid[]))
            and (not $3::boolean or soh.qty_on_hand <> 0)
            and p.deleted_at is null
          order by p.sku_code`,
        [
          [...scope.locationIds],
          input.productIds ? [...input.productIds] : null,
          input.onlyNonZero ?? false,
        ],
      );
      return res.rows;
    });

    const byLocation = new Map<string, typeof rows>();
    const networkByProduct = new Map<
      string,
      { skuCode: string; productName: string; qty: bigint; qtyScale: number; uomCode: string }
    >();
    for (const r of rows) {
      const list = byLocation.get(r.location_id) ?? [];
      list.push(r);
      byLocation.set(r.location_id, list);

      const agg = networkByProduct.get(r.product_id);
      if (agg) agg.qty += BigInt(r.qty_on_hand);
      else
        networkByProduct.set(r.product_id, {
          skuCode: r.sku_code,
          productName: r.product_name,
          qty: BigInt(r.qty_on_hand),
          qtyScale: r.qty_scale,
          uomCode: r.uom_code,
        });
    }

    return {
      scope: { network: scope.network, locationCount: scope.locations.length },
      locations: scope.locations.map((l) => ({
        ...locationHeader(l),
        lines: (byLocation.get(l.id) ?? []).map((r) => ({
          productId: r.product_id,
          skuCode: r.sku_code,
          productName: r.product_name,
          /** Scaled integer in the STOCKING unit — decimal string, never a number. */
          qtyOnHand: r.qty_on_hand,
          qtyScale: r.qty_scale,
          uomCode: r.uom_code,
        })),
      })),
      networkByProduct: [...networkByProduct.entries()]
        .map(([productId, v]) => ({
          productId,
          skuCode: v.skuCode,
          productName: v.productName,
          qtyOnHand: wire(v.qty),
          qtyScale: v.qtyScale,
          uomCode: v.uomCode,
        }))
        .sort((a, b) => (a.skuCode < b.skuCode ? -1 : a.skuCode > b.skuCode ? 1 : 0)),
    };
  }),

  /**
   * Cash position by location, by tender method — and the tills behind it.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * READ THIS BEFORE QUOTING A FIGURE FROM IT — what it is and is not
   * ═════════════════════════════════════════════════════════════════════════
   * It reports what each location TOOK, split by HOW it was paid, from
   * `app.sale_tender` (migration 0021) — one row per way a customer paid, so a
   * sale settled part in cash and part by mobile money counts in both. Until
   * 0021 the split was INFERRED (credit iff a CHARGE named the sale, everything
   * else "immediate") and mobile money was invisible; it is recorded now.
   *
   *  · `immediateTenderMinor` is every tender received at the counter — cash,
   *    mobile money, transfer, cheque; `creditTenderMinor` is what went on
   *    account. Both are sums of TENDERS, and the identity that holds is
   *        immediate + credit = Σ sale.total_minor = billed
   *    per location and in total, because migration 0022 makes Σ tenders =
   *    total for every sale. The router refuses to answer if it ever fails.
   *  · `tenders[]` is the same money by the tenant's own methods. The method's
   *    code and name are tenant data, rendered and never branched on; what the
   *    report reads is `is_cash` / `is_on_account`, platform properties
   *    derived from the method's posting role.
   *  · `tills` is the cash-up view: sessions opened in the range, how many are
   *    closed and counted, and the net count variance. A till whose count
   *    disagrees is a number a person must explain; that is the pilot's
   *    "reconciles to the pesewa" criterion (09 §9.7.1), read off the books'
   *    own source documents.
   *  · Sales recorded before 0021 settle under two inactive methods the
   *    migration created and named as such — history is reported, not hidden.
   *  · Payments RECEIVED against credit accounts have no location:
   *    `app.credit_entry` carries no `location_id`. They are reported once,
   *    tenant-wide, under `unattributed` — never spread across locations on a
   *    guess.
   */
  cashPosition: reportProcedure.input(cashPositionReportInput).query(async ({ ctx, input }) => {
    const scope = await resolveLocationScope(ctx, {
      code: 'report.view.location',
      widenCode: 'report.view.tenant',
      requested: input.locationIds,
      kinds: SELLING_KINDS,
    });

    const result = await ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
      const ids = [...scope.locationIds];
      // One row per (location, method): the recorded tenders of sales whose
      // business date is in range. Money summed in SQL and cast straight back
      // to bigint text — sum(bigint) is numeric and must never surface.
      const byMethod = await tx.query<{
        location_id: string;
        method_id: string;
        code: string;
        name: string;
        posting_role: string;
        is_cash: boolean;
        is_on_account: boolean;
        amount_minor: string;
        sale_count: string;
      }>(
        // NET of refunds (0030): a void's or return's refund leaves through a
        // method and is subtracted from that method, in the period of the
        // return. sale_count counts sales only.
        `select x.location_id, x.method_id, m.code, m.name, m.posting_role,
                m.is_cash, m.is_on_account,
                coalesce(sum(x.amount), 0)::bigint::text as amount_minor,
                count(distinct x.sale_id)::bigint::text  as sale_count
           from (
             select st.tenant_id, st.location_id, st.method_id, st.amount_minor as amount, st.sale_id
               from app.sale_tender st
               join app.sale s on s.tenant_id = st.tenant_id and s.id = st.sale_id
              where st.location_id = any($1::uuid[])
                and s.business_date between $2::date and $3::date
             union all
             select rf.tenant_id, r.location_id, rf.method_id, -rf.amount_minor, null::uuid
               from app.sale_return_refund rf
               join app.sale_return r on r.tenant_id = rf.tenant_id and r.id = rf.return_id
              where r.location_id = any($1::uuid[])
                and r.business_date between $2::date and $3::date
           ) x
           join app.tender_method m on m.tenant_id = x.tenant_id and m.id = x.method_id
          group by x.location_id, x.method_id, m.code, m.name, m.posting_role,
                   m.is_cash, m.is_on_account
          order by x.location_id, m.code`,
        [ids, input.from, input.to],
      );

      // Per-location sale counts by kind of settlement, and the BILLED total
      // from the sale headers — aggregated independently of the tender rows,
      // so the identity below compares two different readings.
      const perLocation = await tx.query<{
        location_id: string;
        billed_minor: string;
        immediate_count: string;
        credit_count: string;
      }>(
        // Billed NET of voids and returns, read off the document headers —
        // still a different reading from the tender rows above.
        `select x.location_id,
                coalesce(sum(x.billed), 0)::bigint::text  as billed_minor,
                coalesce(sum(x.imm), 0)::bigint::text     as immediate_count,
                coalesce(sum(x.cred), 0)::bigint::text    as credit_count
           from (
             select s.location_id, s.total_minor as billed,
                    (exists (select 1 from app.sale_tender st join app.tender_method m
                               on m.tenant_id = st.tenant_id and m.id = st.method_id
                              where st.sale_id = s.id and not m.is_on_account))::int as imm,
                    (exists (select 1 from app.sale_tender st join app.tender_method m
                               on m.tenant_id = st.tenant_id and m.id = st.method_id
                              where st.sale_id = s.id and m.is_on_account))::int as cred
               from app.sale s
              where s.location_id = any($1::uuid[])
                and s.business_date between $2::date and $3::date
             union all
             select r.location_id, -r.total_minor, 0, 0
               from app.sale_return r
              where r.location_id = any($1::uuid[])
                and r.business_date between $2::date and $3::date
           ) x
          group by x.location_id`,
        [ids, input.from, input.to],
      );

      // The tills in range: the cash-up view.
      const tills = await tx.query<{
        location_id: string;
        opened: string;
        closed: string;
        counted: string;
        auto_closed: string;
        opened_offline: string;
        variance_minor: string;
        banked_minor: string;
        off_count: string;
      }>(
        `select location_id,
                count(*)::bigint::text                                          as opened,
                count(*) filter (where status = 'CLOSED')::bigint::text         as closed,
                count(*) filter (where counted_minor is not null)::bigint::text as counted,
                count(*) filter (where auto_closed)::bigint::text               as auto_closed,
                count(*) filter (where opened_offline)::bigint::text            as opened_offline,
                coalesce(sum(variance_minor), 0)::bigint::text                  as variance_minor,
                coalesce(sum(banked_minor), 0)::bigint::text                    as banked_minor,
                count(*) filter (where variance_minor <> 0)::bigint::text       as off_count
           from app.cash_session
          where location_id = any($1::uuid[])
            and business_date between $2::date and $3::date
          group by location_id`,
        [ids, input.from, input.to],
      );

      // Credit RECEIPTS in the period. PAYMENT entries are negative (a payment
      // reduces what the customer owes), so the receipt figure is the negated
      // sum. No location: app.credit_entry has none.
      const receipts = await tx.query<{ receipts_minor: string }>(
        `select coalesce(-sum(amount_minor), 0)::bigint::text as receipts_minor
           from app.credit_entry
          where kind = 'PAYMENT'
            and business_date between $1::date and $2::date`,
        [input.from, input.to],
      );

      return {
        byMethod: byMethod.rows,
        perLocation: perLocation.rows,
        tills: tills.rows,
        receipts: receipts.rows[0]!,
      };
    });

    interface MethodTotal {
      methodId: string;
      code: string;
      name: string;
      postingRole: string;
      isCash: boolean;
      isOnAccount: boolean;
      amount: bigint;
      saleCount: bigint;
    }
    const methodsByLocation = new Map<string, MethodTotal[]>();
    const network = new Map<string, MethodTotal>();
    for (const r of result.byMethod) {
      const row: MethodTotal = {
        methodId: r.method_id,
        code: r.code,
        name: r.name,
        postingRole: r.posting_role,
        isCash: r.is_cash,
        isOnAccount: r.is_on_account,
        amount: BigInt(r.amount_minor),
        saleCount: BigInt(r.sale_count),
      };
      methodsByLocation.set(r.location_id, [...(methodsByLocation.get(r.location_id) ?? []), row]);
      const agg = network.get(r.method_id);
      if (agg) {
        agg.amount += row.amount;
        agg.saleCount += row.saleCount;
      } else {
        network.set(r.method_id, { ...row });
      }
    }
    const sumOf = (rows: readonly MethodTotal[], onAccount: boolean): bigint =>
      rows.filter((m) => m.isOnAccount === onAccount).reduce((a, m) => a + m.amount, 0n);
    const methodDto = (m: MethodTotal) => ({
      methodId: m.methodId,
      code: m.code,
      name: m.name,
      postingRole: m.postingRole,
      isCash: m.isCash,
      isOnAccount: m.isOnAccount,
      amountMinor: wire(m.amount),
      saleCount: wire(m.saleCount),
    });

    const salesByLocation = new Map(result.perLocation.map((r) => [r.location_id, r]));
    const tillsByLocation = new Map(result.tills.map((r) => [r.location_id, r]));

    let totalImmediate = 0n;
    let totalCredit = 0n;
    let totalBilled = 0n;
    const locations = scope.locations.map((l) => {
      const methods = methodsByLocation.get(l.id) ?? [];
      const immediate = sumOf(methods, false);
      const credit = sumOf(methods, true);
      const sales = salesByLocation.get(l.id);
      const billed = sales ? BigInt(sales.billed_minor) : 0n;
      // THE IDENTITY, per location: tenders settle the sale headers exactly.
      assertAggregateIdentity(`cashPosition.tenders(${l.code})`, immediate + credit, billed);
      totalImmediate += immediate;
      totalCredit += credit;
      totalBilled += billed;
      const t = tillsByLocation.get(l.id);
      return {
        ...locationHeader(l),
        /** Received at the counter: cash, mobile money, transfer, cheque. */
        immediateTenderMinor: wire(immediate),
        immediateSaleCount: sales ? sales.immediate_count : '0',
        /** Settled onto a customer account. */
        creditTenderMinor: wire(credit),
        creditSaleCount: sales ? sales.credit_count : '0',
        billedTotalMinor: wire(billed),
        /** The same money by the tenant's own methods. Names are tenant data. */
        tenders: methods.map(methodDto),
        tills: {
          opened: t ? t.opened : '0',
          closed: t ? t.closed : '0',
          counted: t ? t.counted : '0',
          autoClosed: t ? t.auto_closed : '0',
          openedOffline: t ? t.opened_offline : '0',
          /** Σ (counted − expected) over counted tills. Zero means every count reconciled. */
          varianceMinor: t ? t.variance_minor : '0',
          /** Tills whose count did not match to the minor unit. */
          offCount: t ? t.off_count : '0',
          bankedMinor: t ? t.banked_minor : '0',
        },
      };
    });

    // …and in total: Σ locations, and Σ methods, both equal billed.
    const networkMethods = [...network.values()].sort((a, b) =>
      a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
    );
    assertAggregateIdentity(
      'cashPosition.methods',
      networkMethods.reduce((a, m) => a + m.amount, 0n),
      totalImmediate + totalCredit,
    );
    assertAggregateIdentity('cashPosition.billed', totalImmediate + totalCredit, totalBilled);

    return {
      from: input.from,
      to: input.to,
      scope: { network: scope.network, locationCount: scope.locations.length },
      locations,
      total: {
        immediateTenderMinor: wire(totalImmediate),
        creditTenderMinor: wire(totalCredit),
        billedTotalMinor: wire(totalBilled),
        tenders: networkMethods.map(methodDto),
      },
      unattributed: {
        /** Payments received against credit accounts, tenant-wide. */
        creditReceiptsMinor: result.receipts.receipts_minor,
        reason:
          'app.credit_entry carries no location_id, so a payment cannot be attributed to the ' +
          'till that took it. Reported once, tenant-wide, never apportioned.',
      },
      caveats: [
        'Settlement is recorded per tender (app.sale_tender): a split sale counts under each method it used.',
        'The note handed over and the change given are receipt facts kept on the device; the drawer figures are the cash applied.',
        'Sales recorded before tender methods existed appear under two inactive methods named for that.',
      ],
    };
  }),

  /**
   * Inventory days and gross margin per location — brief §7, and the 45 → 28
   * day target curve in `docs/source-of-truth/financial-model-targets.md` §2.
   *
   *   inventory days = stock at cost ÷ (COGS ÷ days in the period)
   *
   * ═════════════════════════════════════════════════════════════════════════
   * WHEN THIS RETURNS null, AND WHY IT NEVER RETURNS A GUESS
   * ═════════════════════════════════════════════════════════════════════════
   * Both figures need a COST, and the only cost the schema records is
   * `stock_movement.unit_cost_e4` on inbound movements — optional, and there
   * is no purchase-order or supplier-invoice path in Phase 1 to make it
   * arrive reliably. Cost is therefore a weighted average of what a location
   * actually paid, computed from its own receipts (04 §4.7.4's WAC intent).
   *
   * If ANY product with movement at a location has no costed receipt behind
   * it, that location's ratios come back `null` with a reason and a count —
   * they are NOT computed from the products that happen to be costed. A
   * partial cost basis understates COGS, which inflates gross margin AND
   * inflates inventory days, and all three numbers would look perfectly
   * reasonable next to the target curve. Failing closed on a financial ratio
   * is the whole point.
   *
   * Not yet derivable, stated rather than approximated: this uses PERIOD-END
   * stock rather than average stock over the period (the ledger supports a
   * point-in-time replay, but a defensible average needs a costing engine and
   * a period model that belong with the GL in Phase 3), and it attributes
   * cost at the location that received the goods, so a transfer moves
   * quantity without moving cost.
   */
  inventoryDays: marginProcedure.input(inventoryDaysReportInput).query(async ({ ctx, input }) => {
    const scope = await resolveLocationScope(ctx, {
      code: 'report.view.margin',
      widenCode: 'report.view.tenant',
      requested: input.locationIds,
      kinds: STOCK_KINDS,
    });
    const days = inclusiveDays(input.from, input.to);

    const { basis, sales } = await ctx.deps.runner.withTenant(
      ctx.identity.tenantId,
      async (tx) => {
        const res = await tx.query<CostBasisRow>(COST_BASIS_SQL, [
          [...scope.locationIds],
          input.from,
          input.to,
        ]);
        const salesData = await loadSales(tx, scope.locationIds, input.from, input.to);
        return { basis: costBasisByLocation(res.rows), sales: salesData };
      },
    );

    const locations = scope.locations.map((l) => {
      const b = basis.get(l.id);
      const s = sales.byLocation.get(l.id) ?? ZERO_SALES;
      const netRevenue = s.subtotalNetMinor - s.discountMinor;
      const onHandValue = b?.onHandValueMinor ?? 0n;
      const cogs = b?.cogsMinor ?? 0n;
      const missing = b?.missingBasisCount ?? 0;

      let unavailable: string | null = null;
      if (missing > 0) unavailable = 'INCOMPLETE_COST_BASIS';
      else if (cogs === 0n) unavailable = 'NO_COGS_IN_PERIOD';

      return {
        ...locationHeader(l),
        netRevenueMinor: wire(netRevenue),
        stockAtCostMinor: unavailable === 'INCOMPLETE_COST_BASIS' ? null : wire(onHandValue),
        cogsMinor: unavailable === 'INCOMPLETE_COST_BASIS' ? null : wire(cogs),
        /** Days of cover × 10⁴ — an integer, never a float (ADR-0004). */
        inventoryDaysE4:
          unavailable === null
            ? wire(divRound(onHandValue * BigInt(days) * 10_000n, cogs, 'half-up'))
            : null,
        /** Gross margin percent × 10⁴: 19.325% is 193250. */
        grossMarginPctE4:
          unavailable === null && netRevenue > 0n
            ? wire(divRound((netRevenue - cogs) * 1_000_000n, netRevenue, 'half-up'))
            : null,
        unavailable,
        productsMissingCostBasis: missing,
        productsWithCostBasis: b?.costedProductCount ?? 0,
      };
    });

    // The network figure is computed from the SAME per-location components,
    // and is withheld entirely if any location in scope lacks a cost basis —
    // a network inventory-days number built from a subset of the network is
    // exactly the kind of confidently wrong figure this file exists to refuse.
    const anyMissing = locations.some((l) => l.productsMissingCostBasis > 0);
    const netStock = [...basis.values()].reduce((a, b) => a + b.onHandValueMinor, 0n);
    const netCogs = [...basis.values()].reduce((a, b) => a + b.cogsMinor, 0n);
    const netRevenue = sales.total.subtotalNetMinor - sales.total.discountMinor;

    return {
      from: input.from,
      to: input.to,
      days,
      scope: { network: scope.network, locationCount: scope.locations.length },
      locations,
      total: {
        netRevenueMinor: wire(netRevenue),
        stockAtCostMinor: anyMissing ? null : wire(netStock),
        cogsMinor: anyMissing ? null : wire(netCogs),
        inventoryDaysE4:
          !anyMissing && netCogs > 0n
            ? wire(divRound(netStock * BigInt(days) * 10_000n, netCogs, 'half-up'))
            : null,
        grossMarginPctE4:
          !anyMissing && netRevenue > 0n
            ? wire(divRound((netRevenue - netCogs) * 1_000_000n, netRevenue, 'half-up'))
            : null,
        unavailable: anyMissing ? 'INCOMPLETE_COST_BASIS' : netCogs === 0n ? 'NO_COGS_IN_PERIOD' : null,
      },
      method:
        'Weighted-average cost from each location’s own costed inbound movements; COGS is SALE ' +
        'outflow net of SALE_RETURN, so an inter-location transfer creates no cost of sales. ' +
        'Period-END stock, not average stock.',
    };
  }),

  /**
   * Distribution & logistics cost as a percentage of revenue, per location and
   * per grouping node — brief §7, and the 5.0% → 2.5% target curve in
   * `docs/source-of-truth/financial-model-targets.md` §2.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * THE RATIO, DEFINED. NUMERATOR, DENOMINATOR, SCALE — ALL THREE, HERE.
   * ═════════════════════════════════════════════════════════════════════════
   *
   *   distributionCostPctE4 = round_half_up(cost × 1 000 000 ÷ netRevenue)
   *
   *   NUMERATOR   `distributionCostMinor` — Σ `app.delivery.freight_cost_minor`
   *               over third-party deliveries (ADR-0001: hauliers only, no
   *               fleet) whose BUSINESS DATE falls in [from, to] and whose
   *               attributed location is in scope. CANCELLED excluded, FAILED
   *               included. Loaded by `loadHaulageSpend` — the SAME function
   *               `logistics.haulageSpend` publishes, so the two cannot
   *               disagree about what moving the goods cost.
   *
   *   DENOMINATOR `netRevenueMinor` — Σ (`sale.subtotal_net_minor` −
   *               `sale.discount_minor`) over sales whose BUSINESS DATE falls
   *               in the same [from, to] at the same locations. Ex-tax and
   *               after discount: tax is the state's money and was never the
   *               business's revenue, and a discount given is revenue not
   *               earned. The identical denominator `grossMarginPctE4` uses.
   *
   *   SCALE       Percent × 10⁴, as an integer: 5.0% is 50000 and 2.5% is
   *               25000, so the model's own two target figures are exactly
   *               representable. Never a float, never a JS number, and the
   *               1 000 000 is 100 (fraction → percent) × 10 000 (the E4).
   *
   *   PERIOD      Both ends inclusive, both sides dated the SAME way: the
   *               human-asserted business date, never a device clock. That
   *               symmetry is why migration 0010 exists — before it, revenue
   *               was dated by `sale.business_date` and haulage by a fallback
   *               ending in `dispatched_at`, so a delivery could be counted
   *               in a month whose revenue excluded the sale it carried.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * ZERO IS NOT NULL, AND "NO DELIVERIES" IS NOT "NO BASIS"
   * ─────────────────────────────────────────────────────────────────────────
   * This route used to answer `null` / `NO_DISTRIBUTION_COST_SOURCE` because
   * nothing recorded the numerator. It now answers a figure, and it keeps the
   * distinction that made the null worth having by publishing counts beside
   * every amount:
   *
   *   · `deliveryCount = 0`  — nothing moved in this period. The cost really
   *     is zero and the percentage really is 0.0%. It is a fact, not a gap.
   *   · `deliveriesWithNoAgreedFreight > 0` — deliveries happened and their
   *     freight was never agreed. The sum is then a FLOOR, not a total, and
   *     the row is flagged `INCOMPLETE_FREIGHT_BASIS` so a partial basis can
   *     never be read as a complete one.
   *   · `netRevenue = 0` — a percentage of nothing is not zero, it is
   *     undefined. `distributionCostPctE4` is null and the row says
   *     `NO_REVENUE_IN_PERIOD`. The cost itself is still reported: a
   *     warehouse has no till and still pays hauliers, and dropping its spend
   *     is how a network ratio ends up understated.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * WHICH LOCATIONS
   * ─────────────────────────────────────────────────────────────────────────
   * OUTLET *and* WAREHOUSE — the union of "can ring a sale" and "can bear a
   * distribution cost". Scoping to selling locations alone would drop inbound
   * freight into a distribution centre from the numerator while leaving every
   * cedi of revenue in the denominator: a ratio that looks better than the
   * business is. Σ(per-location cost) reconciles to the network figure over
   * exactly this set, and the server refuses to answer if it does not.
   *
   * The financial model's own note still applies and is not this server's to
   * settle: it attributed the declining curve to an owned fleet absorbing
   * volume, and ADR-0001 removed the fleet without the target being restated.
   * What changed here is that the trajectory is now MEASURED, which is the
   * half of `open-questions.md` Q1 that was the ERP's to keep.
   */
  distributionCostRatio: marginProcedure
    .input(distributionCostReportInput)
    .query(async ({ ctx, input }) => {
      const scope = await resolveLocationScope(ctx, {
        code: 'report.view.margin',
        widenCode: 'report.view.tenant',
        requested: input.locationIds,
        kinds: DISTRIBUTION_KINDS,
      });

      const { sales, haulage } = await ctx.deps.runner.withTenant(
        ctx.identity.tenantId,
        async (tx) => {
          // Numerator and denominator in ONE transaction, over ONE resolved
          // location set, over ONE date range. A ratio whose halves were read
          // at different instants is two facts presented as one.
          const loadedSales = await loadSales(tx, scope.locationIds, input.from, input.to);
          const loadedHaulage = await loadHaulageSpend(tx, {
            locationIds: scope.locationIds,
            from: input.from,
            to: input.to,
          });
          return { sales: loadedSales, haulage: loadedHaulage };
        },
      );
      const groups = await resolveGroupRollup(ctx, scope);

      const netRevenueOf = (id: string): bigint => {
        const s = sales.byLocation.get(id) ?? ZERO_SALES;
        return s.subtotalNetMinor - s.discountMinor;
      };
      const costOf = (id: string): HaulageBucket =>
        haulage.byLocation.get(id) ?? { freightMinor: 0n, deliveries: 0, withoutFreight: 0 };
      const sumCost = (ids: readonly string[]): HaulageBucket =>
        ids.reduce<HaulageBucket>(
          (acc, id) => {
            const b = costOf(id);
            return {
              freightMinor: acc.freightMinor + b.freightMinor,
              deliveries: acc.deliveries + b.deliveries,
              withoutFreight: acc.withoutFreight + b.withoutFreight,
            };
          },
          { freightMinor: 0n, deliveries: 0, withoutFreight: 0 },
        );

      /**
       * Rule 1 on the numerator, from OUTSIDE the loader: the per-location
       * rows this response publishes must sum to the network figure it
       * publishes. `loadSales` already asserts the same for revenue.
       */
      const perLocationCost = scope.locations.reduce(
        (a, l) => a + costOf(l.id).freightMinor,
        0n,
      );
      assertAggregateIdentity(
        'distributionCost.distributionCostMinor',
        perLocationCost,
        haulage.total.freightMinor,
      );

      /**
       * One line of the report. The percentage is integer arithmetic on
       * bigints all the way down — `divRound` half-up at the single, stated
       * rounding boundary (CLAUDE.md §2.3), and never a float.
       */
      const line = (netRevenue: bigint, cost: HaulageBucket) => ({
        netRevenueMinor: wire(netRevenue),
        /** Zero when nothing moved. Never null now that a source exists. */
        distributionCostMinor: wire(cost.freightMinor),
        /** Percent × 10⁴: 5.0% = 50000. Null only when there is no revenue. */
        distributionCostPctE4:
          netRevenue > 0n
            ? wire(divRound(cost.freightMinor * 1_000_000n, netRevenue, 'half-up'))
            : null,
        /** 0 means nothing moved — the difference between zero and no data. */
        deliveryCount: cost.deliveries,
        deliveriesWithNoAgreedFreight: cost.withoutFreight,
        unavailable:
          cost.withoutFreight > 0
            ? 'INCOMPLETE_FREIGHT_BASIS'
            : netRevenue > 0n
              ? null
              : 'NO_REVENUE_IN_PERIOD',
      });

      const networkRevenue = sales.total.subtotalNetMinor - sales.total.discountMinor;

      return {
        from: input.from,
        to: input.to,
        scope: { network: scope.network, locationCount: scope.locations.length },
        currencyCode: haulage.currencyCode,
        moneyScale: haulage.moneyScale,
        locations: scope.locations.map((l) => ({
          ...locationHeader(l),
          ...line(netRevenueOf(l.id), costOf(l.id)),
        })),
        /**
         * Grouping nodes — a tenant's regions, divisions, or whatever it calls
         * them (04 §4.3: the platform sees a GROUP node, never a "region").
         * These NEST: a location under Bono is also under the root, so these
         * subtotals deliberately do not sum to the network total.
         */
        groups: groups.map((g) => ({
          groupId: g.group.id,
          groupCode: g.group.code,
          groupName: g.group.name,
          locationCount: g.memberIds.length,
          ...line(
            g.memberIds.reduce((a, id) => a + netRevenueOf(id), 0n),
            sumCost(g.memberIds),
          ),
        })),
        groupsNest: true,
        total: line(networkRevenue, haulage.total),
        /** What the numerator IS, said out loud so nobody has to infer it. */
        costBasis: 'AGREED_NOT_INVOICED',
        periodBasis: {
          datedByAssertion: haulage.periodBasis.asserted,
          datedByPlannedFor: haulage.periodBasis.plannedFor,
          datedByDispatchClock: haulage.periodBasis.dispatchClock,
          datedByRowCreated: haulage.periodBasis.rowCreated,
          note: HAULAGE_PERIOD_NOTE,
        },
        /**
         * Kept as a REQUIRED string rather than dropped: it is what the report
         * screen prints under the figure. It no longer explains an absence —
         * it states the limit of what the figure is.
         */
        unavailableReason:
          'Distribution cost is the AGREED freight on third-party deliveries, not the haulier’s ' +
          'AP invoice — there is no general ledger until Phase 3, so this is an operational ' +
          'figure, not an accounting one. Deliveries whose freight was never agreed are counted, ' +
          'not guessed: where deliveriesWithNoAgreedFreight is above zero the sum is a floor and ' +
          'the row says INCOMPLETE_FREIGHT_BASIS. A location with no deliveries reports zero, ' +
          'which is a fact and not a gap.',
        method: HAULAGE_METHOD_NOTE,
      };
    }),
});
