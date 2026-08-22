/**
 * Third-party dispatch and delivery status, from the client side.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ADR-0001: DISPATCH AND TRACKING ONLY. THERE IS NO FLEET ANYWHERE HERE.
 * ═══════════════════════════════════════════════════════════════════════════
 * A delivery names a CARRIER, and a carrier is a supplier holding a capability
 * whose PLATFORM kind is HAULAGE — it invoices and is paid on terms, which is
 * a supplier in every way the books care about, and it puts haulage spend in
 * AP where distribution cost as a percentage of revenue can actually be
 * measured. There is no vehicle, no driver, no registration and no fuel field
 * in this module or in any screen that reads it. If one appears, the scope has
 * been left. `carrierSupplierId` is the attachment point if owned vehicles are
 * ever introduced, and it is the only one.
 *
 * ---------------------------------------------------------------------------
 * ONE OF THESE WRITES IS QUEUED AND THE OTHER IS NOT
 * ---------------------------------------------------------------------------
 * `planDelivery` is here, over HTTP, refused out loud when offline: planning a
 * delivery COMMITS the business to a carrier, the server refuses a carrier
 * that holds no haulage capability or has been deactivated, and a device
 * cannot know either of those things while partitioned. It is not in
 * `DEVICE_OP_KINDS` and must not be put there.
 *
 * A STATUS UPDATE IS NOT HERE. It is an outbox write
 * (`data/mutations/updateDeliveryStatus.ts`) because it is recorded by whoever
 * hears from the driver, wherever they are, and the shared contract registers
 * `logistics.update_delivery_status` as device-uploadable for exactly that
 * reason. Adding it to this file would bypass the outbox, bypass idempotent
 * replay, and bypass the surface pin that stops a second write path appearing
 * unnoticed.
 *
 * Money is minor units as a decimal string on the wire and `bigint` here.
 * `freightCostMinor` is NULLABLE and a null is UNKNOWN, never zero: a zero
 * freight reads as a free delivery, and every screen renders the absence.
 */
import {
  deliveryInput,
  listDeliveriesInput,
  planDeliveryInput,
  DELIVERY_STATUSES,
  type DeliverySourceKind,
  type DeliveryStatus,
  type ListDeliveriesInput,
  type PlanDeliveryInput,
} from '@erp/contracts';
import {
  apiMutate,
  apiQuery,
  asArray,
  asBoolean,
  asCount,
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
// Shapes
// ---------------------------------------------------------------------------

export interface Delivery {
  readonly deliveryId: string;
  /** PURCHASE_ORDER or SALE — the document being moved. Platform vocabulary. */
  readonly sourceKind: string;
  readonly sourceId: string;
  /** A SUPPLIER that hauls. Not a truck. */
  readonly carrierSupplierId: string;
  readonly carrierName: string;
  /** The haulier's own reference for the load — their word, not ours. */
  readonly carrierReference: string | null;
  readonly fromLocationId: string | null;
  readonly toLocationId: string | null;
  /** A customer's site is not a location we own — hence the free text. */
  readonly toAddressText: string | null;
  /** Where this delivery's freight is attributable. */
  readonly costLocationId: string | null;
  readonly status: string;
  readonly plannedFor: string | null;
  readonly dispatchedAt: string | null;
  readonly deliveredAt: string | null;
  readonly failedReason: string | null;
  /** AGREED freight. Null is UNKNOWN and never zero (ADR-0001, Q1). */
  readonly freightCostMinor: bigint | null;
  readonly currencyCode: string;
  readonly moneyScale: bigint;
  readonly notes: string | null;
}

export interface DeliveryList {
  readonly locationCount: number;
  readonly deliveryCount: number;
  readonly deliveries: readonly Delivery[];
}

export interface PlannedDelivery {
  readonly deliveryId: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly carrierSupplierId: string;
  readonly costLocationId: string;
  readonly status: string;
  readonly plannedFor: string | null;
  readonly freightCostMinor: bigint | null;
  readonly currencyCode: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapDelivery(entry: unknown, what: string): Delivery {
  const row = asRecord(entry, what);
  return {
    deliveryId: asString(row['deliveryId'], `${what}.deliveryId`),
    sourceKind: asString(row['sourceKind'], `${what}.sourceKind`),
    sourceId: asString(row['sourceId'], `${what}.sourceId`),
    carrierSupplierId: asString(row['carrierSupplierId'], `${what}.carrierSupplierId`),
    carrierName: asString(row['carrierName'], `${what}.carrierName`),
    carrierReference: asOptionalString(row['carrierReference'], `${what}.carrierReference`),
    fromLocationId: asOptionalString(row['fromLocationId'], `${what}.fromLocationId`),
    toLocationId: asOptionalString(row['toLocationId'], `${what}.toLocationId`),
    toAddressText: asOptionalString(row['toAddressText'], `${what}.toAddressText`),
    costLocationId: asOptionalString(row['costLocationId'], `${what}.costLocationId`),
    status: asString(row['status'], `${what}.status`),
    plannedFor: asOptionalString(row['plannedFor'], `${what}.plannedFor`),
    dispatchedAt: asOptionalString(row['dispatchedAt'], `${what}.dispatchedAt`),
    deliveredAt: asOptionalString(row['deliveredAt'], `${what}.deliveredAt`),
    failedReason: asOptionalString(row['failedReason'], `${what}.failedReason`),
    freightCostMinor: asOptionalScaled(row['freightCostMinor'], `${what}.freightCostMinor`),
    currencyCode: asString(row['currencyCode'], `${what}.currencyCode`),
    moneyScale: asScaled(row['moneyScale'], `${what}.moneyScale`),
    notes: asOptionalString(row['notes'], `${what}.notes`),
  };
}

function mapDeliveryList(json: unknown): DeliveryList {
  const root = asRecord(json, 'logistics.list');
  const scope = asRecord(root['scope'], 'scope');
  return {
    locationCount: asCount(scope['locationCount'], 'scope.locationCount'),
    deliveryCount: asCount(root['deliveryCount'], 'deliveryCount'),
    deliveries: asArray(root['deliveries'], 'deliveries').map((d, i) =>
      mapDelivery(d, `deliveries[${String(i)}]`),
    ),
  };
}

function mapPlanned(json: unknown): PlannedDelivery {
  const row = asRecord(json, 'logistics.planDelivery');
  return {
    deliveryId: asString(row['deliveryId'], 'deliveryId'),
    sourceKind: asString(row['sourceKind'], 'sourceKind'),
    sourceId: asString(row['sourceId'], 'sourceId'),
    carrierSupplierId: asString(row['carrierSupplierId'], 'carrierSupplierId'),
    costLocationId: asString(row['costLocationId'], 'costLocationId'),
    status: asString(row['status'], 'status'),
    plannedFor: asOptionalString(row['plannedFor'], 'plannedFor'),
    freightCostMinor: asOptionalScaled(row['freightCostMinor'], 'freightCostMinor'),
    currencyCode: asString(row['currencyCode'], 'currencyCode'),
  };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export function fetchDeliveries(
  input: ListDeliveriesInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<DeliveryList>> {
  const bad = guard(listDeliveriesInput, 'logistics.list', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('logistics.list', input, mapDeliveryList, options);
}

export function fetchDelivery(
  deliveryId: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<Delivery>> {
  const input = { deliveryId };
  const bad = guard(deliveryInput, 'logistics.get', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('logistics.get', input, (json) => mapDelivery(json, 'logistics.get'), options);
}

/**
 * Hand a document to a haulier. ONLINE ONLY, and refused rather than queued.
 *
 * See the header: the server checks that the named supplier actually holds a
 * HAULAGE capability and is still active, and a partitioned device cannot know
 * either. Nothing is queued when this fails, so a screen that shows the
 * refusal is showing the whole truth.
 */
export function planDelivery(
  input: PlanDeliveryInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<PlannedDelivery>> {
  const bad = guard(planDeliveryInput, 'logistics.planDelivery', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate('logistics.planDelivery', input, mapPlanned, options);
}

export { DELIVERY_STATUSES };
export type { DeliverySourceKind, DeliveryStatus };

// ---------------------------------------------------------------------------
// Haulage spend — the NEGOTIATING view
// ---------------------------------------------------------------------------

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE PER-CARRIER SPLIT IS NOT A NICETY
 * ═══════════════════════════════════════════════════════════════════════════
 * ADR-0001 gave up the owned fleet on the argument that third-party haulage
 * rates could be driven down as volume grew. A rate is driven down in a
 * conversation with ONE haulier, holding what that haulier has actually been
 * paid over a period and how many loads it was for. The network ratio is the
 * outcome; this is the lever, and nobody can pull a lever they cannot see.
 *
 * It is also ordinary AP-by-supplier, which is why the carrier is a supplier
 * and not a truck.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FIGURE IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *  · It is the AGREED freight, not a haulier's invoice. The invoice arrives
 *    with AP in Phase 3; the server says so on every answer as `basis`, and
 *    the screen renders that rather than paraphrasing it.
 *  · A load dispatched with no agreed freight contributes NOTHING and is
 *    counted separately, so a carrier's total is a FLOOR whenever
 *    `deliveriesWithNoAgreedFreight` is above zero. A floor read as a total
 *    understates exactly the carrier somebody is about to negotiate with.
 *  · Cancelled loads are excluded by the server, which names the status it
 *    dropped rather than leaving a reader to guess at the difference.
 */
export interface HaulageBucket {
  readonly haulageSpendMinor: bigint;
  readonly deliveryCount: number;
  /** Above zero, the spend is a FLOOR and the screen has to say so. */
  readonly deliveriesWithNoAgreedFreight: number;
  readonly unavailable: string | null;
}

export interface CarrierSpend {
  readonly carrierSupplierId: string;
  readonly carrierName: string;
  readonly haulageSpendMinor: bigint;
  readonly deliveryCount: number;
  readonly deliveriesWithNoAgreedFreight: number;
}

export interface HaulageLocationSpend extends HaulageBucket {
  readonly locationId: string;
  readonly locationCode: string;
  readonly locationName: string;
}

export interface HaulageGroupSpend extends HaulageBucket {
  readonly groupId: string;
  readonly groupCode: string;
  readonly groupName: string;
  readonly locationCount: number;
}

/** How each delivery in the period got its trading day. */
export interface HaulagePeriodBasis {
  readonly datedByAssertion: number;
  readonly datedByPlannedFor: number;
  readonly datedByDispatchClock: number;
  readonly datedByRowCreated: number;
  readonly note: string;
}

export interface HaulageSpendReport {
  readonly from: string | null;
  readonly to: string | null;
  readonly scope: { readonly network: boolean; readonly locationCount: number };
  readonly currencyCode: string;
  readonly moneyScale: bigint;
  readonly locations: readonly HaulageLocationSpend[];
  readonly groups: readonly HaulageGroupSpend[];
  /** Groups NEST, so their subtotals deliberately do not sum to the total. */
  readonly groupsNest: boolean;
  /** THE NEGOTIATING VIEW: what each haulier has been agreed, and for how many loads. */
  readonly carriers: readonly CarrierSpend[];
  readonly total: HaulageBucket;
  /** AGREED_NOT_INVOICED — rendered, never paraphrased. */
  readonly basis: string;
  /** The delivery status the server left out of the sum. */
  readonly excludedStatus: string;
  /** Always false: a capped aggregate is a wrong aggregate. */
  readonly limitApplies: boolean;
  readonly periodBasis: HaulagePeriodBasis;
  readonly method: string;
}

function mapBucket(row: Record<string, unknown>, what: string): HaulageBucket {
  return {
    haulageSpendMinor: asScaled(row['haulageSpendMinor'], `${what}.haulageSpendMinor`),
    deliveryCount: asCount(row['deliveryCount'], `${what}.deliveryCount`),
    deliveriesWithNoAgreedFreight: asCount(
      row['deliveriesWithNoAgreedFreight'],
      `${what}.deliveriesWithNoAgreedFreight`,
    ),
    unavailable: asOptionalString(row['unavailable'], `${what}.unavailable`),
  };
}

function mapHaulageSpend(json: unknown): HaulageSpendReport {
  const root = asRecord(json, 'logistics.haulageSpend');
  const scope = asRecord(root['scope'], 'scope');
  const basis = asRecord(root['periodBasis'], 'periodBasis');
  return {
    from: asOptionalString(root['from'], 'from'),
    to: asOptionalString(root['to'], 'to'),
    scope: {
      network: asBoolean(scope['network'], 'scope.network'),
      locationCount: asCount(scope['locationCount'], 'scope.locationCount'),
    },
    currencyCode: asString(root['currencyCode'], 'currencyCode'),
    moneyScale: asScaled(root['moneyScale'], 'moneyScale'),
    locations: asArray(root['locations'], 'locations').map((entry, i) => {
      const what = `locations[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        locationId: asString(row['locationId'], `${what}.locationId`),
        locationCode: asString(row['locationCode'], `${what}.locationCode`),
        locationName: asString(row['locationName'], `${what}.locationName`),
        ...mapBucket(row, what),
      };
    }),
    groups: asArray(root['groups'], 'groups').map((entry, i) => {
      const what = `groups[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        groupId: asString(row['groupId'], `${what}.groupId`),
        groupCode: asString(row['groupCode'], `${what}.groupCode`),
        groupName: asString(row['groupName'], `${what}.groupName`),
        locationCount: asCount(row['locationCount'], `${what}.locationCount`),
        ...mapBucket(row, what),
      };
    }),
    groupsNest: asBoolean(root['groupsNest'], 'groupsNest'),
    carriers: asArray(root['carriers'], 'carriers').map((entry, i) => {
      const what = `carriers[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        carrierSupplierId: asString(row['carrierSupplierId'], `${what}.carrierSupplierId`),
        carrierName: asString(row['carrierName'], `${what}.carrierName`),
        haulageSpendMinor: asScaled(row['haulageSpendMinor'], `${what}.haulageSpendMinor`),
        deliveryCount: asCount(row['deliveryCount'], `${what}.deliveryCount`),
        deliveriesWithNoAgreedFreight: asCount(
          row['deliveriesWithNoAgreedFreight'],
          `${what}.deliveriesWithNoAgreedFreight`,
        ),
      };
    }),
    total: mapBucket(asRecord(root['total'], 'total'), 'total'),
    basis: asString(root['basis'], 'basis'),
    excludedStatus: asString(root['excludedStatus'], 'excludedStatus'),
    limitApplies: asBoolean(root['limitApplies'], 'limitApplies'),
    periodBasis: {
      datedByAssertion: asCount(basis['datedByAssertion'], 'periodBasis.datedByAssertion'),
      datedByPlannedFor: asCount(basis['datedByPlannedFor'], 'periodBasis.datedByPlannedFor'),
      datedByDispatchClock: asCount(
        basis['datedByDispatchClock'],
        'periodBasis.datedByDispatchClock',
      ),
      datedByRowCreated: asCount(basis['datedByRowCreated'], 'periodBasis.datedByRowCreated'),
      note: asString(basis['note'], 'periodBasis.note'),
    },
    method: asString(root['method'], 'method'),
  };
}

/**
 * Haulage spend over a period, per location, per grouping node and PER
 * CARRIER. Guarded `report.view.margin` by the server, at any location, and
 * widened to the tenant only by `report.view.tenant`.
 *
 * It takes the SAME input the delivery list does — narrowing by carrier or by
 * source is the same narrowing here as there — and `limit` is refused as
 * meaningless on a sum by the server rather than silently capping it.
 */
export function fetchHaulageSpend(
  input: ListDeliveriesInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<HaulageSpendReport>> {
  const bad = guard(listDeliveriesInput, 'logistics.haulageSpend', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('logistics.haulageSpend', input, mapHaulageSpend, options);
}
