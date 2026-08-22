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
} from '@erp/contracts';
import { divRound } from '@erp/money';
import type { Queryable } from '../db.js';
import { permissionProcedure, router } from '../trpc.js';
import { wire } from '../wire.js';
import { resolveGroupRollup, resolveLocationScope, type ScopedLocation } from './scope.js';

/** Locations that can ring a sale. GROUP nodes have no till (04 §4.3). */
const SELLING_KINDS = ['OUTLET'] as const;
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
 * VOIDS: `app.sale.voids_sale_id` exists and nothing writes it yet — there is
 * no void endpoint in Phase 1 (`sale.void` is catalogued and unimplemented).
 * When voiding lands, the compensating document's sign convention decides
 * whether this aggregate needs a predicate. Written down here, in the query
 * it would affect, so that it is a decision somebody makes rather than an
 * omission somebody discovers.
 */
const SALES_BY_LOCATION_SQL = `
  select s.location_id,
         count(*)::bigint::text                              as sale_count,
         coalesce(sum(s.subtotal_net_minor), 0)::bigint::text as subtotal_net_minor,
         coalesce(sum(s.discount_minor), 0)::bigint::text     as discount_minor,
         coalesce(sum(s.tax_total_minor), 0)::bigint::text    as tax_total_minor,
         coalesce(sum(s.total_minor), 0)::bigint::text        as total_minor
    from app.sale s
   where s.location_id = any($1::uuid[])
     and s.business_date between $2::date and $3::date
   group by s.location_id
`;

/** The same predicate, aggregated WITHOUT the grouping. Rule 1's other half. */
const SALES_TOTAL_SQL = `
  select count(*)::bigint::text                               as sale_count,
         coalesce(sum(s.subtotal_net_minor), 0)::bigint::text  as subtotal_net_minor,
         coalesce(sum(s.discount_minor), 0)::bigint::text      as discount_minor,
         coalesce(sum(s.tax_total_minor), 0)::bigint::text     as tax_total_minor,
         coalesce(sum(s.total_minor), 0)::bigint::text         as total_minor
    from app.sale s
   where s.location_id = any($1::uuid[])
     and s.business_date between $2::date and $3::date
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
   * Cash position by location, by tender.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * READ THIS BEFORE QUOTING A FIGURE FROM IT — what it is and is not
   * ═════════════════════════════════════════════════════════════════════════
   * It reports what each till BILLED, split by how the sale was settled. It
   * is NOT a cash-drawer position, and the difference is not pedantic:
   *
   *  · `app.sale` has NO tender column. Settlement is derived from the credit
   *    ledger — a sale is on credit exactly when a CHARGE entry names it
   *    (`source_kind = 'SALE'`, `source_id = sale.id`), which `sales.ts`
   *    writes for a CREDIT tender and for nothing else. Exact today, and
   *    derived rather than stored, which is why it is stated here.
   *  · Cash TENDERED and change given are not recorded anywhere: the sale
   *    contract refuses them because there is no table to put them in
   *    (`packages/contracts/src/sale.ts`, decision (a)). So this cannot tell
   *    you what is in the drawer, only what should have gone into it.
   *  · There is no cash session, opening float, drop or variance model, so a
   *    till reconciliation cannot be produced at all. That is a Phase 1 gap,
   *    not a limitation of this query.
   *  · Payments RECEIVED against credit accounts have no location:
   *    `app.credit_entry` carries no `location_id`. They are reported once,
   *    tenant-wide, under `unattributed` — never spread across locations on a
   *    guess.
   *
   * Mobile money is not a separate tender in the platform's vocabulary; the
   * wire contract's tender enum is CASH | CREDIT, and `sale.record`'s own
   * catalogue description folds mobile money into immediate settlement.
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
      const settled = `
        select s.location_id,
               s.total_minor,
               exists (
                 select 1 from app.credit_entry ce
                  where ce.source_kind = 'SALE'
                    and ce.source_id = s.id
                    and ce.kind = 'CHARGE'
               ) as on_credit
          from app.sale s
         where s.location_id = any($1::uuid[])
           and s.business_date between $2::date and $3::date
      `;
      const rows = await tx.query<{
        location_id: string;
        immediate_minor: string;
        credit_minor: string;
        immediate_count: string;
        credit_count: string;
      }>(
        `select location_id,
                coalesce(sum(total_minor) filter (where not on_credit), 0)::bigint::text as immediate_minor,
                coalesce(sum(total_minor) filter (where on_credit), 0)::bigint::text     as credit_minor,
                count(*) filter (where not on_credit)::bigint::text                      as immediate_count,
                count(*) filter (where on_credit)::bigint::text                          as credit_count
           from (${settled}) t
          group by location_id`,
        [ids, input.from, input.to],
      );

      // Rule 1: the same predicate, aggregated independently.
      const totalRes = await tx.query<{ immediate_minor: string; credit_minor: string }>(
        `select coalesce(sum(total_minor) filter (where not on_credit), 0)::bigint::text as immediate_minor,
                coalesce(sum(total_minor) filter (where on_credit), 0)::bigint::text     as credit_minor
           from (${settled}) t`,
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

      return { rows: rows.rows, total: totalRes.rows[0]!, receipts: receipts.rows[0]! };
    });

    const byLocation = new Map(result.rows.map((r) => [r.location_id, r]));
    const partsImmediate = result.rows.reduce((a, r) => a + BigInt(r.immediate_minor), 0n);
    const partsCredit = result.rows.reduce((a, r) => a + BigInt(r.credit_minor), 0n);
    const totalImmediate = BigInt(result.total.immediate_minor);
    const totalCredit = BigInt(result.total.credit_minor);
    assertAggregateIdentity('cashPosition.immediateMinor', partsImmediate, totalImmediate);
    assertAggregateIdentity('cashPosition.creditMinor', partsCredit, totalCredit);

    return {
      from: input.from,
      to: input.to,
      scope: { network: scope.network, locationCount: scope.locations.length },
      locations: scope.locations.map((l) => {
        const r = byLocation.get(l.id);
        const immediate = r ? BigInt(r.immediate_minor) : 0n;
        const credit = r ? BigInt(r.credit_minor) : 0n;
        return {
          ...locationHeader(l),
          /** Sales settled at the counter (cash or mobile money). */
          immediateTenderMinor: wire(immediate),
          immediateSaleCount: r ? r.immediate_count : '0',
          /** Sales settled onto a customer credit account — no cash today. */
          creditTenderMinor: wire(credit),
          creditSaleCount: r ? r.credit_count : '0',
          billedTotalMinor: wire(immediate + credit),
        };
      }),
      total: {
        immediateTenderMinor: wire(totalImmediate),
        creditTenderMinor: wire(totalCredit),
        billedTotalMinor: wire(totalImmediate + totalCredit),
      },
      unattributed: {
        /** Payments received against credit accounts, tenant-wide. */
        creditReceiptsMinor: result.receipts.receipts_minor,
        reason:
          'app.credit_entry carries no location_id, so a payment cannot be attributed to the ' +
          'till that took it. Reported once, tenant-wide, never apportioned.',
      },
      caveats: [
        'Derived settlement: app.sale has no tender column; a sale counts as credit exactly when a CHARGE credit_entry names it.',
        'Cash tendered and change are not recorded anywhere, so this is what the till billed, not what is in the drawer.',
        'No cash session, opening float, drop or variance model exists — a till reconciliation cannot be produced.',
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
   * THE NUMERATOR DOES NOT EXIST YET. THIS ROUTE SAYS SO INSTEAD OF GUESSING.
   * ═════════════════════════════════════════════════════════════════════════
   * The denominator — revenue per location and per grouping node — is exact
   * and is returned. The numerator is money the business spent moving goods,
   * and there is no row anywhere in the Phase 1 schema that records it:
   *
   *  · no general ledger and no expense account (Phase 3);
   *  · no purchase order, supplier invoice or freight document (Phase 2);
   *  · no haulier dispatch or delivery record (Phase 2, ADR-0001 — dispatch
   *    and tracking only, and even that is not built);
   *  · `stock_movement.unit_cost_e4` is the cost OF THE GOODS, not of moving
   *    them, and a transfer movement carries no cost at all.
   *
   * So `distributionCostMinor` is `null`, never `0`. That distinction is the
   * entire value of this route: a zero here would read as 0.0% against a 5.0%
   * target and look like the best logistics operation in West Africa. The
   * shape and the permission model are settled now so that when Phase 2's
   * haulier records land there is one place to attach them and a test already
   * asserting that null is not zero.
   *
   * The financial model's own note applies too: it attributes the declining
   * curve to an owned fleet absorbing volume, and ADR-0001 removed the fleet
   * without the target being restated (see finding 1 in the targets file).
   * That is a question for the founder, not a number for this server.
   */
  distributionCostRatio: marginProcedure
    .input(distributionCostReportInput)
    .query(async ({ ctx, input }) => {
      const scope = await resolveLocationScope(ctx, {
        code: 'report.view.margin',
        widenCode: 'report.view.tenant',
        requested: input.locationIds,
        kinds: SELLING_KINDS,
      });

      const { byLocation, total } = await ctx.deps.runner.withTenant(
        ctx.identity.tenantId,
        (tx) => loadSales(tx, scope.locationIds, input.from, input.to),
      );
      const groups = await resolveGroupRollup(ctx, scope);

      const UNAVAILABLE = 'NO_DISTRIBUTION_COST_SOURCE';
      const netRevenueOf = (id: string): bigint => {
        const s = byLocation.get(id) ?? ZERO_SALES;
        return s.subtotalNetMinor - s.discountMinor;
      };

      return {
        from: input.from,
        to: input.to,
        scope: { network: scope.network, locationCount: scope.locations.length },
        locations: scope.locations.map((l) => ({
          ...locationHeader(l),
          netRevenueMinor: wire(netRevenueOf(l.id)),
          distributionCostMinor: null,
          /** Percent × 10⁴ (5.0% = 50000) once a numerator exists. */
          distributionCostPctE4: null,
          unavailable: UNAVAILABLE,
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
          netRevenueMinor: wire(g.memberIds.reduce((a, id) => a + netRevenueOf(id), 0n)),
          distributionCostMinor: null,
          distributionCostPctE4: null,
          unavailable: UNAVAILABLE,
        })),
        groupsNest: true,
        total: {
          netRevenueMinor: wire(total.subtotalNetMinor - total.discountMinor),
          distributionCostMinor: null,
          distributionCostPctE4: null,
          unavailable: UNAVAILABLE,
        },
        unavailableReason:
          'No Phase 1 table records money spent moving goods: there is no general ledger or ' +
          'expense account (Phase 3), no purchase order, supplier invoice or freight document ' +
          '(Phase 2), and no haulier dispatch record (Phase 2, ADR-0001). ' +
          'stock_movement.unit_cost_e4 is the cost of the goods, not of moving them. ' +
          'The revenue denominator above is exact; the cost is null, never zero.',
      };
    }),
});
