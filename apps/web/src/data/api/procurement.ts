/**
 * Buying, from the client side — suppliers, multi-source supply, purchase
 * orders and the reorder suggestion that ties them to the Phase 1 alert.
 *
 * ---------------------------------------------------------------------------
 * EVERY READ IN THIS FILE IS A SERVER READ, AND THAT IS NOT AN OVERSIGHT
 * ---------------------------------------------------------------------------
 * `app.supplier`, `app.supplier_product`, `app.purchase_order` and
 * `app.delivery` are in NO sync bucket (`infra/powersync/sync_rules.yaml`).
 * A partitioned device genuinely does not hold who supplies what, what an
 * order says, or what it costs — so it cannot answer any of it, and the only
 * correct thing to do is say so. There is no cache of a price, a total or an
 * outstanding quantity anywhere in this module: a wrong figure shown
 * confidently to somebody about to commit money is worse than no figure.
 *
 * The one thing this tree DOES keep on the device is the receiving take-down
 * (`data/queries/takedown.ts`), and it is kept as a DOCUMENT stamped with the
 * minute it was taken, never as a current figure — see that file's header.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS TYPED, AND WHAT THAT BUYS
 * ---------------------------------------------------------------------------
 * Every request below is built against the SHARED `@erp/contracts`
 * declaration — the same object `apps/api` parses — and validated with it
 * before the request leaves the device. Renaming a field in the contract
 * breaks this file's compile, which is the whole reason the package exists.
 * RESPONSES are not in the contract package (`apps/web` may not import
 * `apps/api`), so each shape is declared here and MAPPED field by field:
 * every money, quantity and rate value through `asScaled` → `bigint`, never
 * `Number`, and an unreadable field becomes a loud `malformed`.
 *
 * ---------------------------------------------------------------------------
 * ADR-0001: THERE IS NO VEHICLE IN THIS TREE
 * ---------------------------------------------------------------------------
 * A haulier is a SUPPLIER holding a capability whose PLATFORM `kind` is
 * HAULAGE. `listSuppliers({kind: 'HAULAGE'})` is how a screen finds the
 * carriers, and it reads that platform kind — never the tenant's own word for
 * haulage, which is its vocabulary (ADR-0006, CLAUDE.md §2.9).
 */
import {
  changePurchaseOrderStatusInput,
  createPurchaseOrderInput,
  listPurchaseOrdersInput,
  listSuppliersInput,
  lowStockInput,
  suppliersForProductInput,
  updatePurchaseOrderInput,
  upsertSupplierInput,
  upsertSupplierProductInput,
  type ChangePurchaseOrderStatusInput,
  type CreatePurchaseOrderInput,
  type ListPurchaseOrdersInput,
  type ListSuppliersInput,
  type LowStockInput,
  type PurchaseOrderStatus,
  type SupplierCapabilityKind,
  type UpdatePurchaseOrderInput,
  type UpsertSupplierInput,
  type UpsertSupplierProductInput,
} from '@erp/contracts';
import {
  apiMutate,
  apiQuery,
  asArray,
  asBoolean,
  asCount,
  asOptionalCount,
  asOptionalScaled,
  asOptionalString,
  asRecord,
  asScaled,
  asString,
  type ApiCallOptions,
  type ApiResult,
} from './client';
import { guard } from './guard';

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

/**
 * One of a supplier's capabilities. `code` and `name` are the TENANT's words
 * for its own taxonomy and are rendered; `kind` is the platform's and is the
 * only half any code here may branch on.
 */
export interface SupplierCapability {
  readonly capabilityTypeId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
}

export interface Supplier {
  readonly supplierId: string;
  readonly code: string;
  readonly name: string;
  readonly paymentTermsDays: number;
  readonly currencyCode: string;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly addressText: string | null;
  readonly notes: string | null;
  readonly isActive: boolean;
  readonly capabilities: readonly SupplierCapability[];
}

export interface SupplierList {
  readonly supplierCount: number;
  readonly suppliers: readonly Supplier[];
  /** The tenant's own capability taxonomy, so a screen can label a kind. */
  readonly capabilityTypes: readonly SupplierCapability[];
}

/**
 * One source for one product, already comparable.
 *
 * `lastPriceE4` is per ONE PURCHASE unit and `pricePerStockUnitE4` is per ONE
 * STOCKING unit — the same product in a common unit, which is the only way
 * two quotes in two units can be ranked. THE SERVER DOES THE RANKING, on
 * exact rationals; `pricePerStockUnitE4` is the rounded figure for display
 * and the list order is authoritative. A screen that re-sorted on the rounded
 * figure could transpose two sources that differ by less than one rounding
 * step, which is precisely the bug the server's cross-multiplied comparison
 * exists to avoid.
 */
export interface ComparedSource {
  readonly supplierProductId: string;
  readonly supplierId: string;
  readonly supplierCode: string;
  readonly supplierName: string;
  readonly paymentTermsDays: number;
  readonly supplierSku: string | null;
  readonly leadTimeDays: number | null;
  readonly isPreferred: boolean;
  readonly isActive: boolean;
  readonly supplierIsActive: boolean;
  readonly purchaseUomId: string;
  readonly purchaseUomCode: string;
  readonly buyScale: number;
  /** Stocking units per ONE purchase unit, exact, as the pair it really is. */
  readonly stockUnitsPerPurchaseUnitNum: bigint;
  readonly stockUnitsPerPurchaseUnitDen: bigint;
  readonly lastPriceE4: bigint | null;
  readonly lastPriceOn: string | null;
  /** THE COMPARABLE FIGURE. Null when this source has never been priced. */
  readonly pricePerStockUnitE4: bigint | null;
  readonly priceComparable: boolean;
  /** Never a zero: a supplier we have not bought from does not give it away. */
  readonly priceUnavailableReason: string | null;
}

export interface ProductSources {
  readonly productId: string;
  readonly skuCode: string;
  readonly productName: string;
  /** Every comparable price is per ONE of THIS unit. */
  readonly stockingUomId: string;
  readonly stockingUomCode: string;
  readonly qtyScale: number;
  readonly sourceCount: number;
  /**
   * How many of those sources have a price on file. A COUNT OF ROWS, not a
   * magnitude — the money-type lint matches on "price" in an identifier and is
   * coarse by design, so the exemption is stated here rather than the field
   * renamed away from the wire's own name. Every actual money value in this
   * file is `bigint` (ADR-0004).
   */
  readonly pricedSourceCount: number; // lint-money-ignore: a count of rows
  readonly preferredSupplierId: string | null;
  /** Cheapest IN THE COMMON UNIT. Null when nothing is priced. */
  readonly cheapestSupplierId: string | null;
  /** Cheapest-first, as the SERVER ordered them. Never re-sorted here. */
  readonly sources: readonly ComparedSource[];
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export interface PurchaseOrderHeader {
  readonly purchaseOrderId: string;
  readonly supplierId: string;
  readonly supplierCode: string;
  readonly supplierName: string;
  readonly deliverToLocationId: string;
  readonly locationCode: string;
  readonly locationName: string;
  readonly orderNo: string | null;
  readonly status: string;
  readonly orderDate: string;
  readonly expectedAt: string | null;
  readonly currencyCode: string;
  /** The pack's minor units per major. NEVER assumed to be 100. */
  readonly moneyScale: bigint;
  readonly submittedAt: string | null;
  readonly approvedAt: string | null;
  readonly closedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  readonly notes: string | null;
  readonly lineCount: number;
  /** Σ(lines), exactly. The order carries no stored total to disagree with. */
  readonly totalMinor: bigint;
}

export interface PurchaseOrderLine {
  readonly purchaseOrderLineId: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly uomId: string;
  readonly uomCode: string;
  readonly qtyScale: number;
  readonly qtyOrdered: bigint;
  readonly qtyReceived: bigint;
  /** SIGNED: a negative is an OVER-delivery, and it is deliberately not clamped. */
  readonly qtyOutstanding: bigint;
  readonly isFullyReceived: boolean;
  readonly receiptLineCount: number;
  readonly stockingUomId: string;
  readonly stockingUomCode: string;
  readonly qtyStockScale: number;
  readonly qtyOrderedStock: bigint;
  readonly qtyStockReceived: bigint;
  /** The conversion SNAPSHOTTED on the line — never re-derived from today's. */
  readonly factorNum: bigint;
  readonly factorDen: bigint;
  readonly unitPriceE4: bigint;
  readonly lineNetMinor: bigint;
  readonly notes: string | null;
}

export interface PurchaseOrderDetail extends PurchaseOrderHeader {
  /**
   * READ FROM THE DATABASE's own transition table, so a screen greys out
   * buttons from the server's answer rather than from a second copy that
   * drifts. An empty list means terminal.
   */
  readonly legalNextStatuses: readonly string[];
  readonly lines: readonly PurchaseOrderLine[];
}

export interface PurchaseOrderScope {
  readonly locationCount: number;
  /** TRUE only when this really is every location the tenant has. */
  readonly network: boolean;
}

export interface PurchaseOrderList {
  readonly scope: PurchaseOrderScope;
  readonly orderCount: number;
  /** Σ over the SAME resolved set the rows came from. */
  readonly totalMinor: bigint;
  readonly orders: readonly PurchaseOrderHeader[];
  readonly locations: readonly {
    readonly locationId: string;
    readonly locationCode: string;
    readonly locationName: string;
  }[];
}

export interface CreatedPurchaseOrder {
  readonly purchaseOrderId: string;
  readonly status: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly deliverToLocationId: string;
  readonly orderDate: string;
  readonly lineCount: number;
  readonly totalMinor: bigint;
}

export interface StatusChange {
  readonly purchaseOrderId: string;
  readonly fromStatus: string;
  readonly status: string;
  readonly lineCount: number;
  /** The figure the approval bound was measured against. Σ(lines), exactly. */
  readonly totalMinor: bigint;
  readonly currencyCode: string;
  readonly cancelReason: string | null;
}

// ---------------------------------------------------------------------------
// Reorder suggestions — the tie to the Phase 1 alert
// ---------------------------------------------------------------------------

/** The Phase 1 alert's own figures, unchanged, in the STOCKING unit. */
export interface LowStockFigures {
  readonly locationId: string;
  readonly reorderPointId: string;
  readonly productId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly qtyOnHand: bigint;
  readonly reorderPointQty: bigint;
  readonly reorderUpToQty: bigint | null;
  readonly shortfallQty: bigint;
  readonly qtyScale: number;
  readonly uomCode: string;
  readonly reorderLeadTimeDays: number | null;
}

export interface ReorderRecommendation {
  /**
   * PREFERRED — a source is flagged preferred.
   * ONLY_SOURCE — exactly one source, so there is nothing to choose.
   * AMBIGUOUS — several, none preferred: a HUMAN chooses. The server refuses
   * to pick the cheapest automatically, because the price it would pick from
   * is decision support that may be a year old.
   */
  readonly basis: string;
  readonly supplierId: string | null;
  readonly supplierCode: string | null;
  readonly supplierName: string | null;
  readonly supplierSku: string | null;
  readonly leadTimeDays: number | null;
  readonly paymentTermsDays: number | null;
  readonly purchaseUomId: string | null;
  readonly purchaseUomCode: string | null;
  readonly buyScale: number | null;
  readonly qtyBasis: string;
  /** In the STOCKING unit — the alert's own shortfall, untouched. */
  readonly qtyToOrderStock: bigint;
  /** In the PURCHASE unit, rounded UP. Null carries a stated reason. */
  readonly qtyToOrder: bigint | null;
  readonly qtyUnavailableReason: string | null;
  /** From what we LAST PAID. An estimate; the order line prices itself. */
  readonly estimatedCostMinor: bigint | null;
  readonly estimateUnavailableReason: string | null;
}

export interface ReorderSuggestion extends LowStockFigures {
  readonly recommendation: ReorderRecommendation;
  readonly alternativeCount: number;
  readonly alternatives: readonly ComparedSource[];
}

export interface UnsourcedLowStockItem extends LowStockFigures {
  readonly reason: string;
}

export interface ReorderSuggestions {
  readonly scope: PurchaseOrderScope;
  /**
   * WHY the list is what it is. An empty `suggestions` array means something
   * different under each of these and a screen must be able to say which:
   *   NO_THRESHOLDS_CONFIGURED    nobody has said what low means here
   *   NOTHING_BELOW_REORDER_POINT thresholds exist; nothing is low
   *   SUGGESTIONS                 there is something to order
   */
  readonly state: string;
  readonly activeThresholdCount: number;
  readonly lowStockCount: number;
  readonly suggestionCount: number;
  readonly unsourcedCount: number;
  readonly suggestions: readonly ReorderSuggestion[];
  /** Low here, and NOBODY is recorded as able to supply it. Never dropped. */
  readonly unsourced: readonly UnsourcedLowStockItem[];
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapCapability(entry: unknown, what: string): SupplierCapability {
  const row = asRecord(entry, what);
  return {
    capabilityTypeId: asString(row['capabilityTypeId'], `${what}.capabilityTypeId`),
    code: asString(row['code'], `${what}.code`),
    name: asString(row['name'], `${what}.name`),
    kind: asString(row['kind'], `${what}.kind`),
  };
}

function mapSupplierList(json: unknown): SupplierList {
  const root = asRecord(json, 'procurement.listSuppliers');
  return {
    supplierCount: asCount(root['supplierCount'], 'supplierCount'),
    suppliers: asArray(root['suppliers'], 'suppliers').map((entry, i) => {
      const what = `suppliers[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        supplierId: asString(row['supplierId'], `${what}.supplierId`),
        code: asString(row['code'], `${what}.code`),
        name: asString(row['name'], `${what}.name`),
        paymentTermsDays: asCount(row['paymentTermsDays'], `${what}.paymentTermsDays`),
        currencyCode: asString(row['currencyCode'], `${what}.currencyCode`),
        contactName: asOptionalString(row['contactName'], `${what}.contactName`),
        contactPhone: asOptionalString(row['contactPhone'], `${what}.contactPhone`),
        contactEmail: asOptionalString(row['contactEmail'], `${what}.contactEmail`),
        addressText: asOptionalString(row['addressText'], `${what}.addressText`),
        notes: asOptionalString(row['notes'], `${what}.notes`),
        isActive: asBoolean(row['isActive'], `${what}.isActive`),
        capabilities: asArray(row['capabilities'], `${what}.capabilities`).map((c, j) =>
          mapCapability(c, `${what}.capabilities[${String(j)}]`),
        ),
      };
    }),
    capabilityTypes: asArray(root['capabilityTypes'], 'capabilityTypes').map((c, i) =>
      mapCapability(c, `capabilityTypes[${String(i)}]`),
    ),
  };
}

function mapComparedSource(entry: unknown, what: string): ComparedSource {
  const row = asRecord(entry, what);
  return {
    supplierProductId: asString(row['supplierProductId'], `${what}.supplierProductId`),
    supplierId: asString(row['supplierId'], `${what}.supplierId`),
    supplierCode: asString(row['supplierCode'], `${what}.supplierCode`),
    supplierName: asString(row['supplierName'], `${what}.supplierName`),
    paymentTermsDays: asCount(row['paymentTermsDays'], `${what}.paymentTermsDays`),
    supplierSku: asOptionalString(row['supplierSku'], `${what}.supplierSku`),
    leadTimeDays: asOptionalCount(row['leadTimeDays'], `${what}.leadTimeDays`),
    isPreferred: asBoolean(row['isPreferred'], `${what}.isPreferred`),
    isActive: asBoolean(row['isActive'], `${what}.isActive`),
    supplierIsActive: asBoolean(row['supplierIsActive'], `${what}.supplierIsActive`),
    purchaseUomId: asString(row['purchaseUomId'], `${what}.purchaseUomId`),
    purchaseUomCode: asString(row['purchaseUomCode'], `${what}.purchaseUomCode`),
    buyScale: asCount(row['buyScale'], `${what}.buyScale`),
    stockUnitsPerPurchaseUnitNum: asScaled(
      row['stockUnitsPerPurchaseUnitNum'],
      `${what}.stockUnitsPerPurchaseUnitNum`,
    ),
    stockUnitsPerPurchaseUnitDen: asScaled(
      row['stockUnitsPerPurchaseUnitDen'],
      `${what}.stockUnitsPerPurchaseUnitDen`,
    ),
    lastPriceE4: asOptionalScaled(row['lastPriceE4'], `${what}.lastPriceE4`),
    lastPriceOn: asOptionalString(row['lastPriceOn'], `${what}.lastPriceOn`),
    pricePerStockUnitE4: asOptionalScaled(
      row['pricePerStockUnitE4'],
      `${what}.pricePerStockUnitE4`,
    ),
    priceComparable: asBoolean(row['priceComparable'], `${what}.priceComparable`),
    priceUnavailableReason: asOptionalString(
      row['priceUnavailableReason'],
      `${what}.priceUnavailableReason`,
    ),
  };
}

function mapProductSources(json: unknown): ProductSources {
  const root = asRecord(json, 'procurement.suppliersForProduct');
  return {
    productId: asString(root['productId'], 'productId'),
    skuCode: asString(root['skuCode'], 'skuCode'),
    productName: asString(root['productName'], 'productName'),
    stockingUomId: asString(root['stockingUomId'], 'stockingUomId'),
    stockingUomCode: asString(root['stockingUomCode'], 'stockingUomCode'),
    qtyScale: asCount(root['qtyScale'], 'qtyScale'),
    sourceCount: asCount(root['sourceCount'], 'sourceCount'),
    pricedSourceCount: asCount(root['pricedSourceCount'], 'pricedSourceCount'),
    preferredSupplierId: asOptionalString(root['preferredSupplierId'], 'preferredSupplierId'),
    cheapestSupplierId: asOptionalString(root['cheapestSupplierId'], 'cheapestSupplierId'),
    sources: asArray(root['sources'], 'sources').map((s, i) =>
      mapComparedSource(s, `sources[${String(i)}]`),
    ),
  };
}

function mapHeader(entry: unknown, what: string): PurchaseOrderHeader {
  const row = asRecord(entry, what);
  return {
    purchaseOrderId: asString(row['purchaseOrderId'], `${what}.purchaseOrderId`),
    supplierId: asString(row['supplierId'], `${what}.supplierId`),
    supplierCode: asString(row['supplierCode'], `${what}.supplierCode`),
    supplierName: asString(row['supplierName'], `${what}.supplierName`),
    deliverToLocationId: asString(row['deliverToLocationId'], `${what}.deliverToLocationId`),
    locationCode: asString(row['locationCode'], `${what}.locationCode`),
    locationName: asString(row['locationName'], `${what}.locationName`),
    orderNo: asOptionalString(row['orderNo'], `${what}.orderNo`),
    status: asString(row['status'], `${what}.status`),
    orderDate: asString(row['orderDate'], `${what}.orderDate`),
    expectedAt: asOptionalString(row['expectedAt'], `${what}.expectedAt`),
    currencyCode: asString(row['currencyCode'], `${what}.currencyCode`),
    moneyScale: asScaled(row['moneyScale'], `${what}.moneyScale`),
    submittedAt: asOptionalString(row['submittedAt'], `${what}.submittedAt`),
    approvedAt: asOptionalString(row['approvedAt'], `${what}.approvedAt`),
    closedAt: asOptionalString(row['closedAt'], `${what}.closedAt`),
    cancelledAt: asOptionalString(row['cancelledAt'], `${what}.cancelledAt`),
    cancelReason: asOptionalString(row['cancelReason'], `${what}.cancelReason`),
    notes: asOptionalString(row['notes'], `${what}.notes`),
    lineCount: asCount(row['lineCount'], `${what}.lineCount`),
    totalMinor: asScaled(row['totalMinor'], `${what}.totalMinor`),
  };
}

function mapOrderList(json: unknown): PurchaseOrderList {
  const root = asRecord(json, 'procurement.listPurchaseOrders');
  const scope = asRecord(root['scope'], 'scope');
  return {
    scope: {
      locationCount: asCount(scope['locationCount'], 'scope.locationCount'),
      network: asBoolean(scope['network'], 'scope.network'),
    },
    orderCount: asCount(root['orderCount'], 'orderCount'),
    totalMinor: asScaled(root['totalMinor'], 'totalMinor'),
    orders: asArray(root['orders'], 'orders').map((o, i) => mapHeader(o, `orders[${String(i)}]`)),
    locations: asArray(root['locations'], 'locations').map((entry, i) => {
      const what = `locations[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        locationId: asString(row['locationId'], `${what}.locationId`),
        locationCode: asString(row['locationCode'], `${what}.locationCode`),
        locationName: asString(row['locationName'], `${what}.locationName`),
      };
    }),
  };
}

function mapOrderDetail(json: unknown): PurchaseOrderDetail {
  const root = asRecord(json, 'procurement.purchaseOrder');
  return {
    ...mapHeader(root, 'purchaseOrder'),
    legalNextStatuses: asArray(root['legalNextStatuses'], 'legalNextStatuses').map((s, i) =>
      asString(s, `legalNextStatuses[${String(i)}]`),
    ),
    lines: asArray(root['lines'], 'lines').map((entry, i) => {
      const what = `lines[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        purchaseOrderLineId: asString(row['purchaseOrderLineId'], `${what}.purchaseOrderLineId`),
        lineNo: asCount(row['lineNo'], `${what}.lineNo`),
        productId: asString(row['productId'], `${what}.productId`),
        skuCode: asString(row['skuCode'], `${what}.skuCode`),
        productName: asString(row['productName'], `${what}.productName`),
        uomId: asString(row['uomId'], `${what}.uomId`),
        uomCode: asString(row['uomCode'], `${what}.uomCode`),
        qtyScale: asCount(row['qtyScale'], `${what}.qtyScale`),
        qtyOrdered: asScaled(row['qtyOrdered'], `${what}.qtyOrdered`),
        qtyReceived: asScaled(row['qtyReceived'], `${what}.qtyReceived`),
        qtyOutstanding: asScaled(row['qtyOutstanding'], `${what}.qtyOutstanding`),
        isFullyReceived: asBoolean(row['isFullyReceived'], `${what}.isFullyReceived`),
        receiptLineCount: asCount(row['receiptLineCount'], `${what}.receiptLineCount`),
        stockingUomId: asString(row['stockingUomId'], `${what}.stockingUomId`),
        stockingUomCode: asString(row['stockingUomCode'], `${what}.stockingUomCode`),
        qtyStockScale: asCount(row['qtyStockScale'], `${what}.qtyStockScale`),
        qtyOrderedStock: asScaled(row['qtyOrderedStock'], `${what}.qtyOrderedStock`),
        qtyStockReceived: asScaled(row['qtyStockReceived'], `${what}.qtyStockReceived`),
        factorNum: asScaled(row['factorNum'], `${what}.factorNum`),
        factorDen: asScaled(row['factorDen'], `${what}.factorDen`),
        unitPriceE4: asScaled(row['unitPriceE4'], `${what}.unitPriceE4`),
        lineNetMinor: asScaled(row['lineNetMinor'], `${what}.lineNetMinor`),
        notes: asOptionalString(row['notes'], `${what}.notes`),
      };
    }),
  };
}

function mapCreated(json: unknown): CreatedPurchaseOrder {
  const row = asRecord(json, 'procurement.createPurchaseOrder');
  return {
    purchaseOrderId: asString(row['purchaseOrderId'], 'purchaseOrderId'),
    status: asString(row['status'], 'status'),
    supplierId: asString(row['supplierId'], 'supplierId'),
    supplierName: asString(row['supplierName'], 'supplierName'),
    deliverToLocationId: asString(row['deliverToLocationId'], 'deliverToLocationId'),
    orderDate: asString(row['orderDate'], 'orderDate'),
    lineCount: asCount(row['lineCount'], 'lineCount'),
    totalMinor: asScaled(row['totalMinor'], 'totalMinor'),
  };
}

function mapStatusChange(json: unknown): StatusChange {
  const row = asRecord(json, 'procurement.changePurchaseOrderStatus');
  return {
    purchaseOrderId: asString(row['purchaseOrderId'], 'purchaseOrderId'),
    fromStatus: asString(row['fromStatus'], 'fromStatus'),
    status: asString(row['status'], 'status'),
    lineCount: asCount(row['lineCount'], 'lineCount'),
    totalMinor: asScaled(row['totalMinor'], 'totalMinor'),
    currencyCode: asString(row['currencyCode'], 'currencyCode'),
    cancelReason: asOptionalString(row['cancelReason'], 'cancelReason'),
  };
}

function mapLowStockFigures(row: Record<string, unknown>, what: string): LowStockFigures {
  return {
    locationId: asString(row['locationId'], `${what}.locationId`),
    reorderPointId: asString(row['reorderPointId'], `${what}.reorderPointId`),
    productId: asString(row['productId'], `${what}.productId`),
    skuCode: asString(row['skuCode'], `${what}.skuCode`),
    productName: asString(row['productName'], `${what}.productName`),
    qtyOnHand: asScaled(row['qtyOnHand'], `${what}.qtyOnHand`),
    reorderPointQty: asScaled(row['reorderPointQty'], `${what}.reorderPointQty`),
    reorderUpToQty: asOptionalScaled(row['reorderUpToQty'], `${what}.reorderUpToQty`),
    shortfallQty: asScaled(row['shortfallQty'], `${what}.shortfallQty`),
    qtyScale: asCount(row['qtyScale'], `${what}.qtyScale`),
    uomCode: asString(row['uomCode'], `${what}.uomCode`),
    reorderLeadTimeDays: asOptionalCount(
      row['reorderLeadTimeDays'],
      `${what}.reorderLeadTimeDays`,
    ),
  };
}

function mapReorderSuggestions(json: unknown): ReorderSuggestions {
  const root = asRecord(json, 'procurement.reorderSuggestions');
  const scope = asRecord(root['scope'], 'scope');
  return {
    scope: {
      locationCount: asCount(scope['locationCount'], 'scope.locationCount'),
      network: asBoolean(scope['network'], 'scope.network'),
    },
    state: asString(root['state'], 'state'),
    activeThresholdCount: asCount(root['activeThresholdCount'], 'activeThresholdCount'),
    lowStockCount: asCount(root['lowStockCount'], 'lowStockCount'),
    suggestionCount: asCount(root['suggestionCount'], 'suggestionCount'),
    unsourcedCount: asCount(root['unsourcedCount'], 'unsourcedCount'),
    suggestions: asArray(root['suggestions'], 'suggestions').map((entry, i) => {
      const what = `suggestions[${String(i)}]`;
      const row = asRecord(entry, what);
      const rec = asRecord(row['recommendation'], `${what}.recommendation`);
      return {
        ...mapLowStockFigures(row, what),
        recommendation: {
          basis: asString(rec['basis'], `${what}.recommendation.basis`),
          supplierId: asOptionalString(rec['supplierId'], `${what}.recommendation.supplierId`),
          supplierCode: asOptionalString(rec['supplierCode'], `${what}.recommendation.supplierCode`),
          supplierName: asOptionalString(rec['supplierName'], `${what}.recommendation.supplierName`),
          supplierSku: asOptionalString(rec['supplierSku'], `${what}.recommendation.supplierSku`),
          leadTimeDays: asOptionalCount(rec['leadTimeDays'], `${what}.recommendation.leadTimeDays`),
          paymentTermsDays: asOptionalCount(
            rec['paymentTermsDays'],
            `${what}.recommendation.paymentTermsDays`,
          ),
          purchaseUomId: asOptionalString(
            rec['purchaseUomId'],
            `${what}.recommendation.purchaseUomId`,
          ),
          purchaseUomCode: asOptionalString(
            rec['purchaseUomCode'],
            `${what}.recommendation.purchaseUomCode`,
          ),
          buyScale: asOptionalCount(rec['buyScale'], `${what}.recommendation.buyScale`),
          qtyBasis: asString(rec['qtyBasis'], `${what}.recommendation.qtyBasis`),
          qtyToOrderStock: asScaled(
            rec['qtyToOrderStock'],
            `${what}.recommendation.qtyToOrderStock`,
          ),
          qtyToOrder: asOptionalScaled(rec['qtyToOrder'], `${what}.recommendation.qtyToOrder`),
          qtyUnavailableReason: asOptionalString(
            rec['qtyUnavailableReason'],
            `${what}.recommendation.qtyUnavailableReason`,
          ),
          estimatedCostMinor: asOptionalScaled(
            rec['estimatedCostMinor'],
            `${what}.recommendation.estimatedCostMinor`,
          ),
          estimateUnavailableReason: asOptionalString(
            rec['estimateUnavailableReason'],
            `${what}.recommendation.estimateUnavailableReason`,
          ),
        },
        alternativeCount: asCount(row['alternativeCount'], `${what}.alternativeCount`),
        alternatives: asArray(row['alternatives'], `${what}.alternatives`).map((a, j) =>
          mapComparedSource(a, `${what}.alternatives[${String(j)}]`),
        ),
      };
    }),
    unsourced: asArray(root['unsourced'], 'unsourced').map((entry, i) => {
      const what = `unsourced[${String(i)}]`;
      const row = asRecord(entry, what);
      return { ...mapLowStockFigures(row, what), reason: asString(row['reason'], `${what}.reason`) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export function fetchSuppliers(
  input: ListSuppliersInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<SupplierList>> {
  const bad = guard(listSuppliersInput, 'procurement.listSuppliers', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('procurement.listSuppliers', input, mapSupplierList, options);
}

/** The carriers, found by the PLATFORM capability kind and never by a code. */
export const HAULAGE: SupplierCapabilityKind = 'HAULAGE';

export function fetchSourcesForProduct(
  productId: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<ProductSources>> {
  const input = { productId };
  const bad = guard(suppliersForProductInput, 'procurement.suppliersForProduct', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('procurement.suppliersForProduct', input, mapProductSources, options);
}

export function fetchPurchaseOrders(
  input: ListPurchaseOrdersInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<PurchaseOrderList>> {
  const bad = guard(listPurchaseOrdersInput, 'procurement.listPurchaseOrders', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('procurement.listPurchaseOrders', input, mapOrderList, options);
}

export function fetchPurchaseOrder(
  purchaseOrderId: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<PurchaseOrderDetail>> {
  return apiQuery('procurement.purchaseOrder', { purchaseOrderId }, mapOrderDetail, options);
}

/**
 * Raise an order. ONLINE ONLY, refused rather than queued when offline.
 *
 * Deliberately NOT an outbox write, and the reason is in the shared contract's
 * own header: raising and approving an order is a COMMITMENT made against
 * supplier terms and an approval bound the device may hold a stale copy of.
 * Receiving is different — the goods are physically in the yard whether or not
 * the tower is up — and that one is queued (`data/mutations/recordGoodsReceipt.ts`).
 *
 * `idempotencyKey` is the CALLER's, minted when the form opens and held across
 * every retry, so a double-tap is one order.
 */
export function createPurchaseOrder(
  input: CreatePurchaseOrderInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<CreatedPurchaseOrder>> {
  const bad = guard(createPurchaseOrderInput, 'procurement.createPurchaseOrder', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate('procurement.createPurchaseOrder', input, mapCreated, options);
}

/**
 * Move an order along its state machine. ONLINE ONLY, for the same reason.
 *
 * ONE call for every transition because the legality of a move lives in the
 * database's own transition table; the CAPABILITY still differs per target —
 * the server derives it from `toStatus`, so approving remains a permission
 * that raising an order does not carry.
 */
export function changePurchaseOrderStatus(
  input: ChangePurchaseOrderStatusInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<StatusChange>> {
  const bad = guard(
    changePurchaseOrderStatusInput,
    'procurement.changePurchaseOrderStatus',
    input,
  );
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate('procurement.changePurchaseOrderStatus', input, mapStatusChange, options);
}

export function fetchReorderSuggestions(
  input: LowStockInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<ReorderSuggestions>> {
  const bad = guard(lowStockInput, 'procurement.reorderSuggestions', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('procurement.reorderSuggestions', input, mapReorderSuggestions, options);
}

/** Re-exported so a screen naming a status cannot invent one. */
export type { PurchaseOrderStatus };

// ---------------------------------------------------------------------------
// Writing a supplier, and a source for a product
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BOTH OF THESE ARE ONLINE-ONLY, AND REFUSED RATHER THAN QUEUED
 * ═══════════════════════════════════════════════════════════════════════════
 * They are guarded `supplier.manage` **at the tenant root** — the one place a
 * supplier's payment terms are the same fact for every outlet — and neither is
 * in `DEVICE_OP_KINDS`. That is deliberate and must stay so:
 *
 *  · a supplier `code` is unique among live suppliers, and the check is a
 *    server-side index. A device that queued a supplier could not know whether
 *    the code it chose was already taken until the queue drained, and the
 *    honest answer to "did that save?" would be "ask again tomorrow";
 *  · `capabilityTypeIds` REPLACES the capability set. Two partitioned devices
 *    replacing the same set is the credit-limit conflict again, on a row that
 *    decides whether a party may be handed a load;
 *  · `isPreferred` on a source clears the incumbent in the same transaction.
 *    Queued, two devices could each believe theirs won.
 *
 * Receiving is queued because the goods are in the yard whether or not the
 * tower is up. A supplier record is not in the yard.
 *
 * `idempotencyKey` is the CALLER's, minted when the form opens and held across
 * every retry, so a double-tap is one supplier and not two.
 */

export interface UpsertedSupplier {
  readonly supplierId: string;
  /** True when this call created the row; false when it amended one. */
  readonly created: boolean;
  readonly code: string;
  readonly name: string;
  readonly paymentTermsDays: number;
  /** The tenant's jurisdiction pack's, never anything this client said. */
  readonly currencyCode: string;
  readonly isActive: boolean;
  readonly capabilityTypeIds: readonly string[];
  /** False when the call left the capability set alone. */
  readonly capabilitiesReplaced: boolean;
}

export interface UpsertedSupplierProduct {
  readonly supplierProductId: string;
  readonly created: boolean;
  readonly supplierId: string;
  readonly productId: string;
  readonly skuCode: string;
  readonly purchaseUomId: string;
  readonly purchaseUomCode: string;
  readonly buyScale: number;
  readonly stockingUomId: string;
  readonly stockingUomCode: string;
  readonly stockUnitsPerPurchaseUnitNum: bigint;
  readonly stockUnitsPerPurchaseUnitDen: bigint;
  readonly supplierSku: string | null;
  readonly leadTimeDays: number | null;
  readonly lastPriceE4: bigint | null;
  readonly lastPriceOn: string | null;
  /** What the server made of it in the COMMON unit. Null with no quote. */
  readonly pricePerStockUnitE4: bigint | null;
  readonly isPreferred: boolean;
  readonly isActive: boolean;
}

function mapUpsertedSupplier(json: unknown): UpsertedSupplier {
  const row = asRecord(json, 'procurement.upsertSupplier');
  return {
    supplierId: asString(row['supplierId'], 'supplierId'),
    created: asBoolean(row['created'], 'created'),
    code: asString(row['code'], 'code'),
    name: asString(row['name'], 'name'),
    paymentTermsDays: asCount(row['paymentTermsDays'], 'paymentTermsDays'),
    currencyCode: asString(row['currencyCode'], 'currencyCode'),
    isActive: asBoolean(row['isActive'], 'isActive'),
    capabilityTypeIds: asArray(row['capabilityTypeIds'], 'capabilityTypeIds').map((v, i) =>
      asString(v, `capabilityTypeIds[${String(i)}]`),
    ),
    capabilitiesReplaced: asBoolean(row['capabilitiesReplaced'], 'capabilitiesReplaced'),
  };
}

function mapUpsertedSupplierProduct(json: unknown): UpsertedSupplierProduct {
  const row = asRecord(json, 'procurement.upsertSupplierProduct');
  return {
    supplierProductId: asString(row['supplierProductId'], 'supplierProductId'),
    created: asBoolean(row['created'], 'created'),
    supplierId: asString(row['supplierId'], 'supplierId'),
    productId: asString(row['productId'], 'productId'),
    skuCode: asString(row['skuCode'], 'skuCode'),
    purchaseUomId: asString(row['purchaseUomId'], 'purchaseUomId'),
    purchaseUomCode: asString(row['purchaseUomCode'], 'purchaseUomCode'),
    buyScale: asCount(row['buyScale'], 'buyScale'),
    stockingUomId: asString(row['stockingUomId'], 'stockingUomId'),
    stockingUomCode: asString(row['stockingUomCode'], 'stockingUomCode'),
    stockUnitsPerPurchaseUnitNum: asScaled(
      row['stockUnitsPerPurchaseUnitNum'],
      'stockUnitsPerPurchaseUnitNum',
    ),
    stockUnitsPerPurchaseUnitDen: asScaled(
      row['stockUnitsPerPurchaseUnitDen'],
      'stockUnitsPerPurchaseUnitDen',
    ),
    supplierSku: asOptionalString(row['supplierSku'], 'supplierSku'),
    leadTimeDays: asOptionalCount(row['leadTimeDays'], 'leadTimeDays'),
    lastPriceE4: asOptionalScaled(row['lastPriceE4'], 'lastPriceE4'),
    lastPriceOn: asOptionalString(row['lastPriceOn'], 'lastPriceOn'),
    pricePerStockUnitE4: asOptionalScaled(row['pricePerStockUnitE4'], 'pricePerStockUnitE4'),
    isPreferred: asBoolean(row['isPreferred'], 'isPreferred'),
    isActive: asBoolean(row['isActive'], 'isActive'),
  };
}

/**
 * Create or amend a supplier.
 *
 * Omit `supplierId` to create; supply it to amend. There is no delete and no
 * `currencyCode`: deactivation is `isActive: false` so every historical order
 * keeps the name of the party it was with, and the currency is the tenant's
 * jurisdiction pack's (CLAUDE.md §2.5) — a client that could state one could
 * state the wrong one.
 */
export function upsertSupplier(
  input: UpsertSupplierInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<UpsertedSupplier>> {
  const bad = guard(upsertSupplierInput, 'procurement.upsertSupplier', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate('procurement.upsertSupplier', input, mapUpsertedSupplier, options);
}

/**
 * Declare that a supplier can supply a product, in a stated purchase unit.
 *
 * `purchaseUomId` must be a unit the product declares as buyable — the server
 * refuses anything else, because a purchase unit with no conversion factor
 * cannot become the stocking unit the ledger is denominated in. The screen
 * offers only buyable units (`data/queries/purchase-units.ts`) so the refusal
 * is a backstop rather than the normal path.
 */
export function upsertSupplierProduct(
  input: UpsertSupplierProductInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<UpsertedSupplierProduct>> {
  const bad = guard(upsertSupplierProductInput, 'procurement.upsertSupplierProduct', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate(
    'procurement.upsertSupplierProduct',
    input,
    mapUpsertedSupplierProduct,
    options,
  );
}

// ---------------------------------------------------------------------------
// Amending an order that has not left DRAFT
// ---------------------------------------------------------------------------

/**
 * One line as the server re-planned it after an amendment. The conversion,
 * the extended amount and the stocking-unit quantity are all recomputed there
 * — this client states what is being bought and what was agreed for it, never
 * a total (the same rule `createPurchaseOrder` follows).
 */
export interface AmendedPurchaseOrderLine {
  readonly lineNo: number;
  readonly productId: string;
  readonly skuCode: string;
  readonly uomId: string;
  readonly uomCode: string;
  readonly qtyScale: number;
  readonly qtyOrdered: bigint;
  readonly unitPriceE4: bigint;
  readonly stockingUomId: string;
  readonly stockingUomCode: string;
  readonly qtyStockScale: number;
  readonly qtyOrderedStock: bigint;
  readonly factorNum: bigint;
  readonly factorDen: bigint;
  readonly lineNetMinor: bigint;
  readonly notes: string | null;
}

export interface AmendedPurchaseOrder {
  readonly purchaseOrderId: string;
  readonly status: string;
  readonly expectedAt: string | null;
  readonly notes: string | null;
  /** FALSE for a header-only amendment — the lines were left exactly as they were. */
  readonly linesReplaced: boolean;
  readonly lineCount: number;
  /** Σ(lines) as the SERVER recomputed them. Never a figure this device sent. */
  readonly totalMinor: bigint;
  /** Null when the lines were not replaced. */
  readonly lines: readonly AmendedPurchaseOrderLine[] | null;
}

function mapAmendedLine(entry: unknown, what: string): AmendedPurchaseOrderLine {
  const row = asRecord(entry, what);
  return {
    lineNo: asCount(row['lineNo'], `${what}.lineNo`),
    productId: asString(row['productId'], `${what}.productId`),
    skuCode: asString(row['skuCode'], `${what}.skuCode`),
    uomId: asString(row['uomId'], `${what}.uomId`),
    uomCode: asString(row['uomCode'], `${what}.uomCode`),
    qtyScale: asCount(row['qtyScale'], `${what}.qtyScale`),
    qtyOrdered: asScaled(row['qtyOrdered'], `${what}.qtyOrdered`),
    unitPriceE4: asScaled(row['unitPriceE4'], `${what}.unitPriceE4`),
    stockingUomId: asString(row['stockingUomId'], `${what}.stockingUomId`),
    stockingUomCode: asString(row['stockingUomCode'], `${what}.stockingUomCode`),
    qtyStockScale: asCount(row['qtyStockScale'], `${what}.qtyStockScale`),
    qtyOrderedStock: asScaled(row['qtyOrderedStock'], `${what}.qtyOrderedStock`),
    factorNum: asScaled(row['factorNum'], `${what}.factorNum`),
    factorDen: asScaled(row['factorDen'], `${what}.factorDen`),
    lineNetMinor: asScaled(row['lineNetMinor'], `${what}.lineNetMinor`),
    notes: asOptionalString(row['notes'], `${what}.notes`),
  };
}

function mapAmended(json: unknown): AmendedPurchaseOrder {
  const row = asRecord(json, 'procurement.updatePurchaseOrder');
  const lines = row['lines'];
  return {
    purchaseOrderId: asString(row['purchaseOrderId'], 'purchaseOrderId'),
    status: asString(row['status'], 'status'),
    expectedAt: asOptionalString(row['expectedAt'], 'expectedAt'),
    notes: asOptionalString(row['notes'], 'notes'),
    linesReplaced: asBoolean(row['linesReplaced'], 'linesReplaced'),
    lineCount: asCount(row['lineCount'], 'lineCount'),
    totalMinor: asScaled(row['totalMinor'], 'totalMinor'),
    lines:
      lines === null || lines === undefined
        ? null
        : asArray(lines, 'lines').map((l, i) => mapAmendedLine(l, `lines[${String(i)}]`)),
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AMEND A DRAFT. ONLINE ONLY, AND THE SERVER REFUSES IT ONCE IT HAS MOVED ON
 * ═══════════════════════════════════════════════════════════════════════════
 * DRAFT is the ONLY status that legally takes an amendment, and that is an
 * audit control rather than a convenience: if an approved order could take a
 * silent line change, an approval would certify nothing — whatever turned up
 * could be written back onto the order afterwards and the receipt would match
 * perfectly. The server refuses every other status with PRECONDITION_FAILED
 * and 0008's trigger refuses a line edit that never reaches the router at all.
 *
 * A caller that offers this control on a non-DRAFT order is offering something
 * the server will refuse; `features/purchasing` therefore reads the status off
 * the server's own answer and offers it on DRAFT alone. Hiding it is still a
 * COURTESY — the boundary is the server's (CLAUDE.md §2.6).
 *
 * `lines` REPLACES every line when supplied and is omitted for a header-only
 * amendment, so an unchanged line keeps the exact rate it was agreed at rather
 * than a value that has been through a text box.
 *
 * `idempotencyKey` is the CALLER's, minted when the form opens and held across
 * every retry: a double-tap is one amendment, not two.
 */
export function updatePurchaseOrder(
  input: UpdatePurchaseOrderInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<AmendedPurchaseOrder>> {
  const bad = guard(updatePurchaseOrderInput, 'procurement.updatePurchaseOrder', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate('procurement.updatePurchaseOrder', input, mapAmended, options);
}
