/**
 * The reporting wire contract — cross-location HQ reporting (CLAUDE.md §3,
 * Phase 1 acceptance criterion 4).
 *
 * These are QUERIES, not uploadable mutations: they carry no idempotency key
 * and they are deliberately absent from the `device-ops` registry, because a
 * device never uploads a report. They live here for the same reason every
 * other payload does — so the HQ view in `apps/web` and the routers in
 * `apps/api` are built against ONE declaration and a disagreement is a `tsc`
 * error rather than a BAD_REQUEST somebody discovers in Techiman.
 *
 * ---------------------------------------------------------------------------
 * WHAT A REPORT REQUEST MAY AND MAY NOT SAY
 * ---------------------------------------------------------------------------
 * `locationIds` NARROWS; it never widens. The set of locations a caller may
 * see is resolved server-side from `app.effective_permission` on every
 * request, and the request's list is INTERSECTED with it — asking for a
 * location you do not hold the report capability at is refused, not silently
 * dropped, because a total that quietly excluded a location would be a wrong
 * number presented as a right one.
 *
 * There is no `tenantId` here and there never will be (CLAUDE.md §2.1), and
 * `.strict()` makes a forged one fail loudly rather than be ignored.
 *
 * Dates are BUSINESS dates — the human-asserted trading day (03 §3.4.2), the
 * same date every price list and tax rate is looked up as-of. Never a
 * timestamp, and never a device clock: a sale rung at 23:55 on a till whose
 * clock is two hours fast still belongs to the day the operator said it did.
 * Both ends are INCLUSIVE, stated here once so no caller has to guess.
 */
import { z } from 'zod';
import { zBusinessDate, zUuid } from './wire.js';

/** Locations a report may be narrowed to. Absent = everything in scope. */
const zLocationIds = z.array(zUuid).min(1).max(500).optional();

/**
 * Sales by location and network-wide, over an inclusive business-date range.
 *
 * This is also the shape the other three ranged reports alias, so the range
 * rule — both ends required, both inclusive, `to` before `from` REFUSED
 * rather than normalised — is declared exactly once. Silently swapping the
 * ends would turn an operator's typo into a confidently wrong report: the
 * right-looking figure for the wrong period, with nothing on the page to say
 * so.
 *
 * There was briefly a second, standalone `dateRange` export here. It was
 * imported by nothing, and — unlike the inputs below — it was not `.strict()`,
 * so it would have accepted a forged `tenant_id` (CLAUDE.md §2.1) the moment
 * somebody reached for the one that looked more general. Removed rather than
 * left as a trap: exported-and-plausible reads as wired, and is not.
 */
export const salesReportInput = z
  .object({ from: zBusinessDate, to: zBusinessDate, locationIds: zLocationIds })
  .strict()
  .refine((v) => v.from <= v.to, { message: 'from must not be after to', path: ['from'] });

/**
 * Cash position by location, by tender, over an inclusive range.
 *
 * See the router for what this can and cannot answer today: the sale document
 * has no tender column and there is no cash-session table, so it reports what
 * the till BILLED by settlement type, not what is in the drawer.
 */
export const cashPositionReportInput = salesReportInput;

/**
 * Sales by BUSINESS DAY over the same inclusive range, for the change-over-
 * time visual on the back-office dashboard. Same input, same range rule, and
 * the same identity on the way out: Σ(days) equals the range total, checked
 * by the router. Every day in the range is a row — a day with no trade is a
 * zero, so a dark day is drawn as a dip to nothing rather than a gap that
 * looks like missing data. Capped at 400 days: a year's chart, not a dump.
 */
export const salesByDayReportInput = salesReportInput.refine(
  (v) => Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`) <= 399 * 86_400_000,
  { message: 'a by-day report covers at most 400 days', path: ['to'] },
);
export type SalesByDayReportInput = z.input<typeof salesByDayReportInput>;

/**
 * Stock on hand by location and SKU, derived from the movement ledger.
 *
 * No date range: on-hand is a position, not a flow. `asOf` is deliberately
 * absent rather than defaulted — a point-in-time position needs the ledger
 * replayed to a business date, and offering it before it is implemented
 * would hand somebody a "today" figure labelled as a historic one.
 */
export const stockReportInput = z
  .object({
    locationIds: zLocationIds,
    productIds: z.array(zUuid).min(1).max(500).optional(),
    /** Omit zero balances. Default false: a SKU at zero is often the story. */
    onlyNonZero: z.boolean().optional(),
  })
  .strict();

/**
 * Inventory days and gross margin per location (brief §7; the 45 → 28 day
 * target curve in docs/source-of-truth/financial-model-targets.md §2).
 *
 * Both figures need a COST basis, which exists only where inbound movements
 * carried `unitCostE4`. The response says so per location rather than
 * producing a ratio from a partial cost basis — see the router.
 */
export const inventoryDaysReportInput = salesReportInput;

/**
 * Distribution & logistics cost as a percentage of revenue, per location and
 * per grouping node (brief §7; the 5.0% → 2.5% target curve).
 *
 * The numerator now EXISTS: `app.delivery.freight_cost_minor`, summed by
 * `loadHaulageSpend` over the row's own `business_date` (migration 0010), so
 * the route answers a real percentage rather than the `NO_DISTRIBUTION_COST_
 * SOURCE` it used to. A zero is now a real zero — nothing moved — and the
 * response carries `deliveryCount` and `deliveriesWithNoAgreedFreight` beside
 * every amount so a partial basis (`INCOMPLETE_FREIGHT_BASIS`) can never be
 * read as a complete one. Live evidence: `drill:q1`.
 */
export const distributionCostReportInput = salesReportInput;

export type SalesReportInput = z.input<typeof salesReportInput>;
export type SalesReportParsed = z.output<typeof salesReportInput>;
export type StockReportInput = z.input<typeof stockReportInput>;
export type StockReportParsed = z.output<typeof stockReportInput>;

/**
 * Low-stock alert (CLAUDE.md §3, Phase 1). Not a report: an operational
 * question the counter asks, guarded by `stock.view` at the location rather
 * than by a reporting capability, so the person who has to tell a customer
 * "we're out" can see it coming.
 */
export const lowStockInput = z
  .object({
    locationIds: zLocationIds,
    productIds: z.array(zUuid).min(1).max(500).optional(),
    /** Cap the list. The urgency ordering is the router's, not the caller's. */
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export type LowStockInput = z.input<typeof lowStockInput>;
export type LowStockParsed = z.output<typeof lowStockInput>;
