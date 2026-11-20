/**
 * Cross-location reporting, from the client side (Phase 1 acceptance
 * criterion 4: "HQ sees near-real-time stock and sales across every connected
 * location in one view").
 *
 * ---------------------------------------------------------------------------
 * THE POINT OF THIS FILE IS THE FIRST IMPORT LINE
 * ---------------------------------------------------------------------------
 * `packages/contracts/src/reports.ts` had exactly one importer — the server.
 * A contract with one side is a comment. Every request below is built against
 * the shared declaration AND validated with it before it leaves the device,
 * so a disagreement between what this screen sends and what `apps/api` parses
 * is a `tsc` error here, and a malformed range is refused at the counter
 * rather than as a BAD_REQUEST hours later.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS THE SCREENS MUST NOT FLATTEN
 * ---------------------------------------------------------------------------
 * 1. **`scope.network` is not decoration.** The server resolves which
 *    locations a caller may see from `app.effective_permission` on every
 *    request. A holder of `report.view.tenant` at every root gets
 *    `network: true` and a total that really is the business's; an outlet
 *    manager gets `network: false` and a true total OF THEIR OWN OUTLETS. The
 *    two look identical as figures and mean completely different things, so
 *    the screen must label them differently — `ReportScope` carries the flag
 *    all the way to the component for exactly that reason.
 * 2. **`null` is UNAVAILABLE, never zero.** `inventoryDays` withholds a ratio
 *    built on an incomplete cost basis; `distributionCostRatio` has no
 *    numerator in Phase 1 at all. A zero distribution cost reads as 0.0%
 *    against a 5.0% target and looks like the best logistics operation in the
 *    region. The mappers keep `null` as `null` and the screens render an
 *    absence.
 *
 * Every money and quantity field is a decimal string on the wire and a
 * `bigint` from the moment it is mapped (ADR-0004). No `Number` appears in
 * this file except for counts of rows and days.
 */
import {
  cashPositionReportInput,
  salesByDayReportInput,
  type SalesByDayReportInput,
  distributionCostReportInput,
  inventoryDaysReportInput,
  salesReportInput,
  stockReportInput,
  type SalesReportInput,
  type StockReportInput,
} from '@erp/contracts';
import {
  apiQuery,
  asArray,
  asBoolean,
  asCount,
  asOptionalScaled,
  asOptionalString,
  asRecord,
  asScaled,
  asString,
  invalidRequest,
  type ApiCallOptions,
  type ApiResult,
} from './client';

// ---------------------------------------------------------------------------
// Shapes the screens read
// ---------------------------------------------------------------------------

export interface ReportScope {
  /**
   * TRUE only when this total is the whole tenant's. False means "every
   * location this caller may see, and no more" — a real total of a part.
   */
  readonly network: boolean;
  readonly locationCount: number;
}

export interface LocationHeader {
  readonly locationId: string;
  readonly locationCode: string;
  readonly locationName: string;
}

export interface SalesFigures {
  /** A count of sale documents — a whole number, carried as a string. */
  readonly saleCount: bigint;
  readonly subtotalNetMinor: bigint;
  readonly discountMinor: bigint;
  /** Ex-tax revenue after discounts — the gross-margin denominator. */
  readonly netRevenueMinor: bigint;
  readonly taxTotalMinor: bigint;
  /** What the customer owed, tax included. */
  readonly totalMinor: bigint;
}

export interface SalesByLocationReport {
  readonly from: string;
  readonly to: string;
  readonly days: number;
  readonly scope: ReportScope;
  readonly locations: readonly (LocationHeader & SalesFigures)[];
  readonly total: SalesFigures;
}

export interface SalesDay extends SalesFigures {
  /** The business date at the tills, `YYYY-MM-DD`. */
  readonly date: string;
}

/**
 * Sales by business day. Every day of the range is present; a day with no
 * trade is a ZERO row. The screen draws it as a dip to nothing, never a gap.
 */
export interface SalesByDayReport {
  readonly from: string;
  readonly to: string;
  readonly days: number;
  readonly scope: ReportScope;
  readonly series: readonly SalesDay[];
  readonly total: SalesFigures;
}

/** One of the tenant's tender methods, totalled. The NAME is tenant data. */
export interface CashPositionTender {
  readonly methodId: string;
  readonly name: string;
  readonly isCash: boolean;
  readonly isOnAccount: boolean;
  readonly amountMinor: bigint;
  readonly saleCount: bigint;
}

/** The cash-up view of one location's tills in the period (08 §8.2a). */
export interface CashPositionTills {
  readonly opened: bigint;
  readonly closed: bigint;
  readonly counted: bigint;
  readonly autoClosed: bigint;
  readonly openedOffline: bigint;
  /** Σ (counted − expected). SIGNED: negative is short. */
  readonly varianceMinor: bigint;
  /** Tills whose count did not match to the minor unit. */
  readonly offCount: bigint;
  readonly bankedMinor: bigint;
}

export interface CashPositionLine extends LocationHeader {
  readonly immediateTenderMinor: bigint;
  readonly immediateSaleCount: bigint;
  readonly creditTenderMinor: bigint;
  readonly creditSaleCount: bigint;
  readonly billedTotalMinor: bigint;
  readonly tenders: readonly CashPositionTender[];
  readonly tills: CashPositionTills;
}

export interface CashPositionReport {
  readonly from: string;
  readonly to: string;
  readonly scope: ReportScope;
  readonly locations: readonly CashPositionLine[];
  readonly total: {
    readonly immediateTenderMinor: bigint;
    readonly creditTenderMinor: bigint;
    readonly billedTotalMinor: bigint;
    readonly tenders: readonly CashPositionTender[];
  };
  /** Payments against credit accounts, tenant-wide — they have no location. */
  readonly unattributed: { readonly creditReceiptsMinor: bigint; readonly reason: string };
  /** The server's own statements about what this figure is NOT. Shown, always. */
  readonly caveats: readonly string[];
}

export interface StockLine {
  readonly productId: string;
  readonly skuCode: string;
  readonly productName: string;
  /** Scaled integer in the STOCKING unit. Never a float, never converted here. */
  readonly qtyOnHand: bigint;
  readonly qtyScale: number;
  readonly uomCode: string;
}

export interface StockOnHandReport {
  readonly scope: ReportScope;
  readonly locations: readonly (LocationHeader & { readonly lines: readonly StockLine[] })[];
  readonly networkByProduct: readonly StockLine[];
}

export interface InventoryDaysLine extends LocationHeader {
  readonly netRevenueMinor: bigint;
  readonly stockAtCostMinor: bigint | null;
  readonly cogsMinor: bigint | null;
  /** Days of cover × 10⁴. Null when it cannot be computed honestly. */
  readonly inventoryDaysE4: bigint | null;
  /** Gross margin percent × 10⁴. Null when it cannot be computed honestly. */
  readonly grossMarginPctE4: bigint | null;
  /** The server's reason code when a figure is withheld. */
  readonly unavailable: string | null;
  /**
   * COUNTS OF PRODUCTS, not amounts — how many SKUs with movement at this
   * location have never had a costed receipt behind them, and how many have.
   * They are why a ratio above may be `null`. lint-money-ignore: the word
   * "cost" is in the name of a count, and ADR-0004 governs magnitudes.
   */
  readonly productsMissingCostBasis: number; // lint-money-ignore: a count of products
  readonly productsWithCostBasis: number; // lint-money-ignore: a count of products
}

export interface InventoryDaysReport {
  readonly from: string;
  readonly to: string;
  readonly days: number;
  readonly scope: ReportScope;
  readonly locations: readonly InventoryDaysLine[];
  readonly total: {
    readonly netRevenueMinor: bigint;
    readonly stockAtCostMinor: bigint | null;
    readonly cogsMinor: bigint | null;
    readonly inventoryDaysE4: bigint | null;
    readonly grossMarginPctE4: bigint | null;
    readonly unavailable: string | null;
  };
  readonly method: string;
}

/**
 * One line of the ADR-0001 ratio.
 *
 * `deliveryCount` is what separates a ZERO from a GAP, and it is the reason
 * the two counts are on the wire at all. A location with no deliveries in the
 * period genuinely cost nothing to serve — 0.0% is a fact. A location whose
 * deliveries went out with no agreed freight has a sum that is a FLOOR, and
 * the server flags it `INCOMPLETE_FREIGHT_BASIS` so a partial basis can never
 * be read as a complete one. Rendering the two the same way would hand the
 * founder a percentage nobody could act on.
 */
export interface DistributionCostLine {
  readonly netRevenueMinor: bigint;
  /** Σ agreed freight. A zero here is a real zero; see `deliveryCount`. */
  readonly distributionCostMinor: bigint | null;
  /** Percent × 10⁴: 5.0% is 50000. Null when there is no revenue to divide by. */
  readonly distributionCostPctE4: bigint | null;
  /** Deliveries in the period. 0 means nothing moved, not "no data". */
  readonly deliveryCount: number;
  /** Above zero, the cost is a floor and the ratio is understated. */
  readonly deliveriesWithNoAgreedFreight: number;
  readonly unavailable: string | null;
}

/**
 * How each delivery in the period was DATED. Published because three of the
 * four bases are weaker than the first and a percentage computed across a
 * period boundary inherits whichever it used: `asserted` is the human's own
 * business date, and the rest are fallbacks ending in a device clock.
 */
export interface DistributionPeriodBasis {
  readonly datedByAssertion: number;
  readonly datedByPlannedFor: number;
  readonly datedByDispatchClock: number;
  readonly datedByRowCreated: number;
  readonly note: string;
}

export interface DistributionCostReport {
  readonly from: string;
  readonly to: string;
  readonly scope: ReportScope;
  readonly locations: readonly (LocationHeader & DistributionCostLine)[];
  readonly groups: readonly ({
    readonly groupId: string;
    readonly groupCode: string;
    readonly groupName: string;
    readonly locationCount: number;
  } & DistributionCostLine)[];
  /** Groups NEST, so their subtotals deliberately do not sum to the total. */
  readonly groupsNest: boolean;
  readonly total: DistributionCostLine;
  /** What the numerator IS — the AGREED freight, not a haulier's AP invoice. */
  readonly costBasis: string;
  readonly periodBasis: DistributionPeriodBasis;
  readonly unavailableReason: string;
  readonly method: string;
}

// ---------------------------------------------------------------------------
// Mappers — wire strings become bigint here and nowhere else
// ---------------------------------------------------------------------------

function mapScope(value: unknown, what: string): ReportScope {
  const s = asRecord(value, what);
  return {
    network: asBoolean(s['network'], `${what}.network`),
    locationCount: asCount(s['locationCount'], `${what}.locationCount`),
  };
}

function mapHeader(row: Record<string, unknown>, what: string): LocationHeader {
  return {
    locationId: asString(row['locationId'], `${what}.locationId`),
    locationCode: asString(row['locationCode'], `${what}.locationCode`),
    locationName: asString(row['locationName'], `${what}.locationName`),
  };
}

function mapSalesFigures(row: Record<string, unknown>, what: string): SalesFigures {
  return {
    saleCount: asScaled(row['saleCount'], `${what}.saleCount`),
    subtotalNetMinor: asScaled(row['subtotalNetMinor'], `${what}.subtotalNetMinor`),
    discountMinor: asScaled(row['discountMinor'], `${what}.discountMinor`),
    netRevenueMinor: asScaled(row['netRevenueMinor'], `${what}.netRevenueMinor`),
    taxTotalMinor: asScaled(row['taxTotalMinor'], `${what}.taxTotalMinor`),
    totalMinor: asScaled(row['totalMinor'], `${what}.totalMinor`),
  };
}

function mapSalesByLocation(json: unknown): SalesByLocationReport {
  const root = asRecord(json, 'reports.salesByLocation');
  return {
    from: asString(root['from'], 'from'),
    to: asString(root['to'], 'to'),
    days: asCount(root['days'], 'days'),
    scope: mapScope(root['scope'], 'scope'),
    locations: asArray(root['locations'], 'locations').map((entry, i) => {
      const row = asRecord(entry, `locations[${String(i)}]`);
      return { ...mapHeader(row, `locations[${String(i)}]`), ...mapSalesFigures(row, `locations[${String(i)}]`) };
    }),
    total: mapSalesFigures(asRecord(root['total'], 'total'), 'total'),
  };
}

function mapSalesByDay(json: unknown): SalesByDayReport {
  const root = asRecord(json, 'reports.salesByDay');
  return {
    from: asString(root['from'], 'from'),
    to: asString(root['to'], 'to'),
    days: asCount(root['days'], 'days'),
    scope: mapScope(root['scope'], 'scope'),
    series: asArray(root['series'], 'series').map((entry, i) => {
      const what = `series[${String(i)}]`;
      const row = asRecord(entry, what);
      return { date: asString(row['date'], `${what}.date`), ...mapSalesFigures(row, what) };
    }),
    total: mapSalesFigures(asRecord(root['total'], 'total'), 'total'),
  };
}

function mapTenders(value: unknown, what: string): CashPositionTender[] {
  return asArray(value, what).map((entry, i) => {
    const w = `${what}[${String(i)}]`;
    const t = asRecord(entry, w);
    return {
      methodId: asString(t['methodId'], `${w}.methodId`),
      name: asString(t['name'], `${w}.name`),
      isCash: asBoolean(t['isCash'], `${w}.isCash`),
      isOnAccount: asBoolean(t['isOnAccount'], `${w}.isOnAccount`),
      amountMinor: asScaled(t['amountMinor'], `${w}.amountMinor`),
      saleCount: asScaled(t['saleCount'], `${w}.saleCount`),
    };
  });
}

function mapTills(value: unknown, what: string): CashPositionTills {
  const t = asRecord(value, what);
  const n = (k: string) => asScaled(t[k], `${what}.${k}`);
  return {
    opened: n('opened'),
    closed: n('closed'),
    counted: n('counted'),
    autoClosed: n('autoClosed'),
    openedOffline: n('openedOffline'),
    varianceMinor: n('varianceMinor'),
    offCount: n('offCount'),
    bankedMinor: n('bankedMinor'),
  };
}

function mapCashPosition(json: unknown): CashPositionReport {
  const root = asRecord(json, 'reports.cashPosition');
  const total = asRecord(root['total'], 'total');
  const unattributed = asRecord(root['unattributed'], 'unattributed');
  return {
    from: asString(root['from'], 'from'),
    to: asString(root['to'], 'to'),
    scope: mapScope(root['scope'], 'scope'),
    locations: asArray(root['locations'], 'locations').map((entry, i) => {
      const what = `locations[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        ...mapHeader(row, what),
        immediateTenderMinor: asScaled(row['immediateTenderMinor'], `${what}.immediateTenderMinor`),
        immediateSaleCount: asScaled(row['immediateSaleCount'], `${what}.immediateSaleCount`),
        creditTenderMinor: asScaled(row['creditTenderMinor'], `${what}.creditTenderMinor`),
        creditSaleCount: asScaled(row['creditSaleCount'], `${what}.creditSaleCount`),
        billedTotalMinor: asScaled(row['billedTotalMinor'], `${what}.billedTotalMinor`),
        tenders: mapTenders(row['tenders'], `${what}.tenders`),
        tills: mapTills(row['tills'], `${what}.tills`),
      };
    }),
    total: {
      immediateTenderMinor: asScaled(total['immediateTenderMinor'], 'total.immediateTenderMinor'),
      creditTenderMinor: asScaled(total['creditTenderMinor'], 'total.creditTenderMinor'),
      billedTotalMinor: asScaled(total['billedTotalMinor'], 'total.billedTotalMinor'),
      tenders: mapTenders(total['tenders'], 'total.tenders'),
    },
    unattributed: {
      creditReceiptsMinor: asScaled(
        unattributed['creditReceiptsMinor'],
        'unattributed.creditReceiptsMinor',
      ),
      reason: asString(unattributed['reason'], 'unattributed.reason'),
    },
    caveats: asArray(root['caveats'], 'caveats').map((c, i) => asString(c, `caveats[${String(i)}]`)),
  };
}

function mapStockLine(entry: unknown, what: string): StockLine {
  const row = asRecord(entry, what);
  return {
    productId: asString(row['productId'], `${what}.productId`),
    skuCode: asString(row['skuCode'], `${what}.skuCode`),
    productName: asString(row['productName'], `${what}.productName`),
    qtyOnHand: asScaled(row['qtyOnHand'], `${what}.qtyOnHand`),
    qtyScale: asCount(row['qtyScale'], `${what}.qtyScale`),
    uomCode: asString(row['uomCode'], `${what}.uomCode`),
  };
}

function mapStockOnHand(json: unknown): StockOnHandReport {
  const root = asRecord(json, 'reports.stockOnHand');
  return {
    scope: mapScope(root['scope'], 'scope'),
    locations: asArray(root['locations'], 'locations').map((entry, i) => {
      const what = `locations[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        ...mapHeader(row, what),
        lines: asArray(row['lines'], `${what}.lines`).map((l, j) =>
          mapStockLine(l, `${what}.lines[${String(j)}]`),
        ),
      };
    }),
    networkByProduct: asArray(root['networkByProduct'], 'networkByProduct').map((e, i) =>
      mapStockLine(e, `networkByProduct[${String(i)}]`),
    ),
  };
}

function mapInventoryDaysLine(row: Record<string, unknown>, what: string): Omit<InventoryDaysLine, keyof LocationHeader> {
  return {
    netRevenueMinor: asScaled(row['netRevenueMinor'], `${what}.netRevenueMinor`),
    stockAtCostMinor: asOptionalScaled(row['stockAtCostMinor'], `${what}.stockAtCostMinor`),
    cogsMinor: asOptionalScaled(row['cogsMinor'], `${what}.cogsMinor`),
    inventoryDaysE4: asOptionalScaled(row['inventoryDaysE4'], `${what}.inventoryDaysE4`),
    grossMarginPctE4: asOptionalScaled(row['grossMarginPctE4'], `${what}.grossMarginPctE4`),
    unavailable: asOptionalString(row['unavailable'], `${what}.unavailable`),
    productsMissingCostBasis: asCount(
      row['productsMissingCostBasis'],
      `${what}.productsMissingCostBasis`,
    ),
    productsWithCostBasis: asCount(row['productsWithCostBasis'], `${what}.productsWithCostBasis`),
  };
}

function mapInventoryDays(json: unknown): InventoryDaysReport {
  const root = asRecord(json, 'reports.inventoryDays');
  const total = asRecord(root['total'], 'total');
  return {
    from: asString(root['from'], 'from'),
    to: asString(root['to'], 'to'),
    days: asCount(root['days'], 'days'),
    scope: mapScope(root['scope'], 'scope'),
    locations: asArray(root['locations'], 'locations').map((entry, i) => {
      const what = `locations[${String(i)}]`;
      const row = asRecord(entry, what);
      return { ...mapHeader(row, what), ...mapInventoryDaysLine(row, what) };
    }),
    total: {
      netRevenueMinor: asScaled(total['netRevenueMinor'], 'total.netRevenueMinor'),
      stockAtCostMinor: asOptionalScaled(total['stockAtCostMinor'], 'total.stockAtCostMinor'),
      cogsMinor: asOptionalScaled(total['cogsMinor'], 'total.cogsMinor'),
      inventoryDaysE4: asOptionalScaled(total['inventoryDaysE4'], 'total.inventoryDaysE4'),
      grossMarginPctE4: asOptionalScaled(total['grossMarginPctE4'], 'total.grossMarginPctE4'),
      unavailable: asOptionalString(total['unavailable'], 'total.unavailable'),
    },
    method: asString(root['method'], 'method'),
  };
}

function mapDistributionLine(row: Record<string, unknown>, what: string): DistributionCostLine {
  return {
    netRevenueMinor: asScaled(row['netRevenueMinor'], `${what}.netRevenueMinor`),
    distributionCostMinor: asOptionalScaled(
      row['distributionCostMinor'],
      `${what}.distributionCostMinor`,
    ),
    distributionCostPctE4: asOptionalScaled(
      row['distributionCostPctE4'],
      `${what}.distributionCostPctE4`,
    ),
    deliveryCount: asCount(row['deliveryCount'], `${what}.deliveryCount`),
    deliveriesWithNoAgreedFreight: asCount(
      row['deliveriesWithNoAgreedFreight'],
      `${what}.deliveriesWithNoAgreedFreight`,
    ),
    unavailable: asOptionalString(row['unavailable'], `${what}.unavailable`),
  };
}

function mapPeriodBasis(row: Record<string, unknown>): DistributionPeriodBasis {
  return {
    datedByAssertion: asCount(row['datedByAssertion'], 'periodBasis.datedByAssertion'),
    datedByPlannedFor: asCount(row['datedByPlannedFor'], 'periodBasis.datedByPlannedFor'),
    datedByDispatchClock: asCount(row['datedByDispatchClock'], 'periodBasis.datedByDispatchClock'),
    datedByRowCreated: asCount(row['datedByRowCreated'], 'periodBasis.datedByRowCreated'),
    note: asString(row['note'], 'periodBasis.note'),
  };
}

function mapDistributionCost(json: unknown): DistributionCostReport {
  const root = asRecord(json, 'reports.distributionCostRatio');
  return {
    from: asString(root['from'], 'from'),
    to: asString(root['to'], 'to'),
    scope: mapScope(root['scope'], 'scope'),
    locations: asArray(root['locations'], 'locations').map((entry, i) => {
      const what = `locations[${String(i)}]`;
      const row = asRecord(entry, what);
      return { ...mapHeader(row, what), ...mapDistributionLine(row, what) };
    }),
    groups: asArray(root['groups'], 'groups').map((entry, i) => {
      const what = `groups[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        groupId: asString(row['groupId'], `${what}.groupId`),
        groupCode: asString(row['groupCode'], `${what}.groupCode`),
        groupName: asString(row['groupName'], `${what}.groupName`),
        locationCount: asCount(row['locationCount'], `${what}.locationCount`),
        ...mapDistributionLine(row, what),
      };
    }),
    groupsNest: asBoolean(root['groupsNest'], 'groupsNest'),
    total: mapDistributionLine(asRecord(root['total'], 'total'), 'total'),
    costBasis: asString(root['costBasis'], 'costBasis'),
    periodBasis: mapPeriodBasis(asRecord(root['periodBasis'], 'periodBasis')),
    unavailableReason: asString(root['unavailableReason'], 'unavailableReason'),
    method: asString(root['method'], 'method'),
  };
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

/**
 * A zod `safeParse` result, read structurally.
 *
 * `zod` is not a direct dependency of this app — it arrives through
 * `@erp/contracts`, whose whole job is to be the one declaration both sides
 * import. Reaching past it for zod's own types would create a second
 * dependency on the validator's shape; reading the result structurally keeps
 * the coupling where it belongs, on the SCHEMAS.
 */
interface SafeParseLike {
  readonly success: boolean;
  readonly error?: unknown;
}

function issuesOf(error: unknown): string[] {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return ['the request did not satisfy the shared contract'];
  return issues.map((raw) => {
    const issue = raw as { path?: unknown; message?: unknown };
    const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
    const message = typeof issue.message === 'string' ? issue.message : 'invalid';
    return `${path.length > 0 ? path : '(root)'}: ${message}`;
  });
}

/**
 * Prove the request against the SHARED contract, then send it.
 *
 * The parsed OUTPUT is deliberately discarded: several contract fields
 * transform on parse (a decimal string becomes a `bigint`), and the wire
 * wants the input spelling. This is the same discipline
 * `data/sync/transport.ts` applies to an upload envelope — validate the thing
 * you are about to send, send the thing you validated.
 */
async function guarded<TIn, TOut>(
  schema: { safeParse: (v: unknown) => SafeParseLike },
  path: string,
  input: TIn,
  map: (json: unknown) => TOut,
  options: ApiCallOptions,
): Promise<ApiResult<TOut>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return invalidRequest(path, issuesOf(parsed.error));
  return apiQuery(path, input, map, options);
}

export function fetchSalesByLocation(
  input: SalesReportInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<SalesByLocationReport>> {
  return guarded(salesReportInput, 'reports.salesByLocation', input, mapSalesByLocation, options);
}

export function fetchSalesByDay(
  input: SalesByDayReportInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<SalesByDayReport>> {
  return guarded(salesByDayReportInput, 'reports.salesByDay', input, mapSalesByDay, options);
}

export function fetchCashPosition(
  input: SalesReportInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<CashPositionReport>> {
  return guarded(cashPositionReportInput, 'reports.cashPosition', input, mapCashPosition, options);
}

export function fetchStockOnHand(
  input: StockReportInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<StockOnHandReport>> {
  return guarded(stockReportInput, 'reports.stockOnHand', input, mapStockOnHand, options);
}

export function fetchInventoryDays(
  input: SalesReportInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<InventoryDaysReport>> {
  return guarded(inventoryDaysReportInput, 'reports.inventoryDays', input, mapInventoryDays, options);
}

export function fetchDistributionCost(
  input: SalesReportInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<DistributionCostReport>> {
  return guarded(
    distributionCostReportInput,
    'reports.distributionCostRatio',
    input,
    mapDistributionCost,
    options,
  );
}
