/**
 * Stock thresholds and the low-stock alert, from the client side.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE SERVER READS AND NOT LOCAL QUERIES
 * ---------------------------------------------------------------------------
 * `app.reorder_point` is in NO sync bucket. It is not an oversight the client
 * can route around: a partitioned device genuinely does not hold the
 * thresholds, so it cannot compute what is low, and any screen that behaved
 * as though it could would be inventing the most consequential figure on it.
 * The alert is asked of the server, and when the server cannot be asked the
 * screen says exactly that.
 *
 * ---------------------------------------------------------------------------
 * THE DISTINCTION THIS FILE EXISTS TO PRESERVE
 * ---------------------------------------------------------------------------
 * `inventory.lowStock` returns an EMPTY list in two completely different
 * worlds:
 *
 *   (a) thresholds are configured here and nothing is at or below one —
 *       "stock is healthy";
 *   (b) no threshold has ever been set at this location — "nothing here CAN
 *       be low, because nobody has said what low means".
 *
 * Reading (b) as (a) is how a stock-out is missed: the screen reassures
 * somebody about a question it never asked. The alert alone cannot tell them
 * apart, so `fetchLowStockPicture` pairs it with `inventory.reorderPoints`
 * for every location in scope and reports, per location, WHICH of the two it
 * is — and says so plainly when it could not find out.
 *
 * All quantities are scaled integers in the product's STOCKING unit, carried
 * as decimal strings and mapped to `bigint` here (ADR-0004). The unit and its
 * scale come from the server with every row and are never assumed.
 */
import { lowStockInput, setReorderPointInput, type LowStockInput, type SetReorderPointInput } from '@erp/contracts';
import {
  apiMutate,
  apiQuery,
  asArray,
  asBoolean,
  asCount,
  asOptionalCount,
  asOptionalScaled,
  asRecord,
  asScaled,
  asString,
  type ApiCallOptions,
  type ApiFailure,
  type ApiResult,
} from './client';
import { guard } from './guard';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface LowStockAlert {
  readonly locationId: string;
  readonly reorderPointId: string;
  readonly productId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly qtyOnHand: bigint;
  readonly reorderPointQty: bigint;
  readonly reorderUpToQty: bigint | null;
  readonly shortfallQty: bigint;
  readonly leadTimeDays: number | null;
  readonly qtyScale: number;
  readonly uomCode: string;
  /**
   * On-hand as basis points of the threshold — the server's URGENCY ORDERING
   * KEY, and nothing else. It is dimensionless so that 40 bars short and 40
   * tonnes short can be ranked against each other; nothing is ever ordered or
   * costed from it. `null` means the threshold is zero ("tell me only when it
   * is actually gone"), and sorts first because that product is gone.
   */
  readonly coverageBp: bigint | null;
}

export interface LowStockLocation {
  readonly locationId: string;
  readonly locationCode: string;
  readonly locationName: string;
  readonly alertCount: number;
}

export interface LowStockReport {
  readonly locationCount: number;
  readonly alertCount: number;
  /** Flat, already in urgency order — the list a manager reads top-down. */
  readonly alerts: readonly LowStockAlert[];
  readonly locations: readonly LowStockLocation[];
}

export interface ReorderPoint {
  readonly reorderPointId: string;
  readonly productId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly reorderPointQty: bigint;
  readonly reorderUpToQty: bigint | null;
  readonly leadTimeDays: number | null;
  readonly qtyOnHand: bigint;
  readonly isLow: boolean;
  /** A switched-off threshold raises no alert but stays on this list. */
  readonly isActive: boolean;
  readonly qtyScale: number;
  readonly uomCode: string;
}

export interface ReorderPointList {
  readonly locationId: string;
  readonly points: readonly ReorderPoint[];
}

export interface SetReorderPointResult {
  readonly reorderPointId: string;
  readonly created: boolean;
  readonly locationId: string;
  readonly productId: string;
  readonly reorderPointQty: bigint;
  readonly reorderUpToQty: bigint | null;
  readonly leadTimeDays: number | null;
  readonly isActive: boolean;
  /** The SERVER'S unit for this product, echoed so the client can label it. */
  readonly qtyScale: number;
  readonly uomCode: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapLowStock(json: unknown): LowStockReport {
  const root = asRecord(json, 'inventory.lowStock');
  const scope = asRecord(root['scope'], 'scope');
  return {
    locationCount: asCount(scope['locationCount'], 'scope.locationCount'),
    alertCount: asCount(root['alertCount'], 'alertCount'),
    alerts: asArray(root['alerts'], 'alerts').map((entry, i) => {
      const what = `alerts[${String(i)}]`;
      const row = asRecord(entry, what);
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
        leadTimeDays: asOptionalCount(row['leadTimeDays'], `${what}.leadTimeDays`),
        qtyScale: asCount(row['qtyScale'], `${what}.qtyScale`),
        uomCode: asString(row['uomCode'], `${what}.uomCode`),
        coverageBp: asOptionalScaled(row['coverageBp'], `${what}.coverageBp`),
      };
    }),
    locations: asArray(root['locations'], 'locations').map((entry, i) => {
      const what = `locations[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        locationId: asString(row['locationId'], `${what}.locationId`),
        locationCode: asString(row['locationCode'], `${what}.locationCode`),
        locationName: asString(row['locationName'], `${what}.locationName`),
        alertCount: asCount(row['alertCount'], `${what}.alertCount`),
      };
    }),
  };
}

function mapReorderPoints(json: unknown): ReorderPointList {
  const root = asRecord(json, 'inventory.reorderPoints');
  return {
    locationId: asString(root['locationId'], 'locationId'),
    points: asArray(root['points'], 'points').map((entry, i) => {
      const what = `points[${String(i)}]`;
      const row = asRecord(entry, what);
      return {
        reorderPointId: asString(row['reorderPointId'], `${what}.reorderPointId`),
        productId: asString(row['productId'], `${what}.productId`),
        skuCode: asString(row['skuCode'], `${what}.skuCode`),
        productName: asString(row['productName'], `${what}.productName`),
        reorderPointQty: asScaled(row['reorderPointQty'], `${what}.reorderPointQty`),
        reorderUpToQty: asOptionalScaled(row['reorderUpToQty'], `${what}.reorderUpToQty`),
        leadTimeDays: asOptionalCount(row['leadTimeDays'], `${what}.leadTimeDays`),
        qtyOnHand: asScaled(row['qtyOnHand'], `${what}.qtyOnHand`),
        isLow: asBoolean(row['isLow'], `${what}.isLow`),
        isActive: asBoolean(row['isActive'], `${what}.isActive`),
        qtyScale: asCount(row['qtyScale'], `${what}.qtyScale`),
        uomCode: asString(row['uomCode'], `${what}.uomCode`),
      };
    }),
  };
}

function mapSetReorderPoint(json: unknown): SetReorderPointResult {
  const row = asRecord(json, 'inventory.setReorderPoint');
  return {
    reorderPointId: asString(row['reorderPointId'], 'reorderPointId'),
    created: asBoolean(row['created'], 'created'),
    locationId: asString(row['locationId'], 'locationId'),
    productId: asString(row['productId'], 'productId'),
    reorderPointQty: asScaled(row['reorderPointQty'], 'reorderPointQty'),
    reorderUpToQty: asOptionalScaled(row['reorderUpToQty'], 'reorderUpToQty'),
    leadTimeDays: asOptionalCount(row['leadTimeDays'], 'leadTimeDays'),
    isActive: asBoolean(row['isActive'], 'isActive'),
    qtyScale: asCount(row['qtyScale'], 'qtyScale'),
    uomCode: asString(row['uomCode'], 'uomCode'),
  };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export function fetchLowStock(
  input: LowStockInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<LowStockReport>> {
  const bad = guard(lowStockInput, 'inventory.lowStock', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('inventory.lowStock', input, mapLowStock, options);
}

export function fetchReorderPoints(
  locationId: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<ReorderPointList>> {
  return apiQuery('inventory.reorderPoints', { locationId }, mapReorderPoints, options);
}

/**
 * Set a threshold. ONLINE ONLY, and refused rather than queued when offline.
 *
 * This is configuration, not trade. A sale is recorded locally and drains
 * through the outbox because a counter must never wait on a socket (§8.2);
 * a reorder threshold changes a row that is in no sync bucket, so there is
 * nothing on the device for a local write to land in and nothing for the
 * counter to be blocked on. It therefore goes straight over tRPC and returns
 * an ordinary failure when it cannot — never a silent queue, and never a
 * second uploadable write kind (see `data/api/client.ts`'s note on
 * `apiMutate`, and `outbox-surface.test.ts`, which pins that surface).
 *
 * `idempotencyKey` is the CALLER'S, minted before the form is filled in and
 * held across retries — the same discipline as the sale id (§8.2). Passing a
 * fresh key per attempt would make a double-tap two writes.
 */
export function setReorderPoint(
  input: SetReorderPointInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<SetReorderPointResult>> {
  const bad = guard(setReorderPointInput, 'inventory.setReorderPoint', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiMutate('inventory.setReorderPoint', input, mapSetReorderPoint, options);
}

export interface EnsuredReorderPoints {
  /** Thresholds created by this run. Zero on a re-run, and zero before stock exists. */
  readonly seeded: number;
  /** True whenever anything was seeded: the level is a template guess a person must review. */
  readonly needsFounderReview: boolean;
}

function mapEnsured(json: unknown): EnsuredReorderPoints {
  const r = asRecord(json, 'inventory.ensureReorderPoints');
  return {
    seeded: asCount(r['seeded'], 'seeded'),
    needsFounderReview: asBoolean(r['needsFounderReview'], 'needsFounderReview'),
  };
}

/**
 * THE BUTTON phase2-gate §5.1 D1 asked for: seed a threshold for every product
 * this location demonstrably holds (from its own ledger — typically its
 * opening stock) that has none yet. Additive and idempotent server-side: a
 * threshold somebody has tuned is never overwritten, so pressing it twice is
 * harmless. Online only, like every threshold write (see `setReorderPoint`).
 */
export function ensureReorderPoints(
  locationId: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<EnsuredReorderPoints>> {
  return apiMutate('inventory.ensureReorderPoints', { locationId }, mapEnsured, options);
}

// ---------------------------------------------------------------------------
// The two questions together — the honest picture
// ---------------------------------------------------------------------------

export type ThresholdCoverage =
  /** Thresholds exist here; the alert list is meaningful. */
  | { readonly kind: 'configured'; readonly count: number }
  /** No threshold has ever been set here. An empty alert list means nothing. */
  | { readonly kind: 'none' }
  /** Could not find out. Reported as such — never assumed to be either one. */
  | { readonly kind: 'unknown'; readonly failure: ApiFailure };

export interface LowStockPicture {
  readonly report: LowStockReport;
  /** Per location in scope, whether a threshold has ever been set there. */
  readonly coverage: ReadonlyMap<string, ThresholdCoverage>;
  /** True when no location in scope has a single threshold configured. */
  readonly noThresholdsAnywhere: boolean;
}

/**
 * The alert, plus enough to know what an empty alert list MEANS.
 *
 * One `inventory.reorderPoints` call per location in scope. That is bounded
 * by the caller's own scope — one outlet for counter staff and an outlet
 * manager, the locations under a region for a regional manager — and it is
 * the same set the screen is about to render, so nothing is fetched that is
 * not shown. If a location's threshold list cannot be fetched, that location
 * is `unknown`, and the screen says so rather than picking the comforting
 * interpretation.
 */
export async function fetchLowStockPicture(
  input: LowStockInput,
  options: ApiCallOptions = {},
): Promise<ApiResult<LowStockPicture>> {
  const alerts = await fetchLowStock(input, options);
  if (!alerts.ok) return alerts;

  const coverage = new Map<string, ThresholdCoverage>();
  const lists = await Promise.all(
    alerts.data.locations.map((l) => fetchReorderPoints(l.locationId, options)),
  );
  alerts.data.locations.forEach((l, i) => {
    const list = lists[i];
    if (list === undefined || !list.ok) {
      coverage.set(l.locationId, {
        kind: 'unknown',
        failure:
          list === undefined || list.ok
            ? {
                kind: 'malformed',
                message: 'This device could not read the threshold list.',
                detail: null,
                status: null,
              }
            : list.failure,
      });
      return;
    }
    coverage.set(
      l.locationId,
      list.data.points.length === 0
        ? { kind: 'none' }
        : { kind: 'configured', count: list.data.points.length },
    );
  });

  const noThresholdsAnywhere =
    coverage.size > 0 && [...coverage.values()].every((c) => c.kind === 'none');

  return {
    ok: true,
    data: { report: alerts.data, coverage, noThresholdsAnywhere },
    fetchedAtMs: alerts.fetchedAtMs,
  };
}
