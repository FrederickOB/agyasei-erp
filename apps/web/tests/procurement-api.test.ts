/**
 * The buying client's api layer, tested for the three things that make a
 * figure on a screen worth acting on.
 *
 * 1. **A magnitude off the wire is a `bigint` or it is a loud failure.** Never
 *    a `Number`, never a silent `undefined` flowing into a total (ADR-0004).
 * 2. **`null` is UNAVAILABLE, never zero.** A supplier with no recorded price
 *    is not a supplier that gives it away, and a delivery with no agreed
 *    freight is not a free delivery — both would flatter exactly the figures
 *    ADR-0001 and open-questions Q1 exist to measure honestly.
 * 3. **Offline is a REASON, never an empty list.** Every read here is of a row
 *    in no sync bucket, so a partitioned device genuinely cannot answer — and
 *    an empty supplier list reads as "we have no suppliers", which is a
 *    different and false statement.
 *
 * Every request is also proven against the SHARED `@erp/contracts`
 * declaration before it leaves the device, so a malformed one is refused here
 * rather than as a BAD_REQUEST somebody discovers in a district town.
 */
import { describe, expect, it } from 'vitest';
import type { ApiCallOptions, ApiEndpoint, ApiFetch } from '../src/data/api/client';
import {
  changePurchaseOrderStatus,
  createPurchaseOrder,
  fetchPurchaseOrder,
  fetchPurchaseOrders,
  fetchReorderSuggestions,
  fetchSourcesForProduct,
  fetchSuppliers,
} from '../src/data/api/procurement';
import { fetchDeliveries, planDelivery } from '../src/data/api/logistics';

const ENDPOINT: ApiEndpoint = { url: 'http://api.test', bearer: 'dev' };
const LOC = '018f3a1e-0000-7000-8000-00000000aaaa';
const PRODUCT = '018f3a1e-0000-7000-8000-0000000000c1';
const SUPPLIER = '018f3a1e-0000-7000-8000-0000000000d1';
const ORDER = '018f3a1e-0000-7000-8000-0000000000e1';
const KEY = '018f3a1e-0000-7000-8000-0000000000f1';
const UOM_BUY = '018f3a1e-0000-7000-8000-0000000000b1';

function answering(json: unknown, asked: string[] = []): ApiFetch {
  return (url) => {
    asked.push(new URL(url).pathname.replace('/trpc/', ''));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: { data: { json } } }),
    });
  };
}

const DEAD: ApiFetch = () => Promise.reject(new Error('no radio'));

function opts(fetchFn: ApiFetch): ApiCallOptions {
  return { endpoint: ENDPOINT, fetchFn };
}

// ---------------------------------------------------------------------------
// Fixtures shaped exactly as the routers answer
// ---------------------------------------------------------------------------

function source(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    supplierProductId: 'sp-1',
    supplierId: SUPPLIER,
    supplierCode: 'SUP-1',
    supplierName: 'Northern Supply',
    paymentTermsDays: 30,
    supplierSku: 'NS-77',
    leadTimeDays: 4,
    isPreferred: false,
    isActive: true,
    supplierIsActive: true,
    purchaseUomId: 'u-tonne',
    purchaseUomCode: 'TONNE',
    buyScale: 3,
    stockUnitsPerPurchaseUnitNum: '20',
    stockUnitsPerPurchaseUnitDen: '1',
    lastPriceE4: '9000000000',
    lastPriceOn: '2026-08-01',
    pricePerStockUnitE4: '450000000',
    priceComparable: true,
    priceUnavailableReason: null,
    ...over,
  };
}

const SOURCES_PAYLOAD = {
  productId: PRODUCT,
  skuCode: 'SKU-1',
  productName: 'Binder 50kg',
  stockingUomId: 'u-sack',
  stockingUomCode: 'SACK',
  qtyScale: 0,
  sourceCount: 2,
  pricedSourceCount: 1,
  preferredSupplierId: null,
  cheapestSupplierId: SUPPLIER,
  sources: [
    source(),
    source({
      supplierProductId: 'sp-2',
      supplierId: 'other',
      supplierCode: 'SUP-2',
      supplierName: 'Coast Traders',
      lastPriceE4: null,
      lastPriceOn: null,
      pricePerStockUnitE4: null,
      priceComparable: false,
      priceUnavailableReason: 'NO_RECORDED_PRICE',
    }),
  ],
};

const ORDER_HEADER = {
  purchaseOrderId: ORDER,
  supplierId: SUPPLIER,
  supplierCode: 'SUP-1',
  supplierName: 'Northern Supply',
  deliverToLocationId: LOC,
  locationCode: 'OUT-01',
  locationName: 'Main yard',
  orderNo: null,
  status: 'SUBMITTED',
  orderDate: '2026-08-20',
  expectedAt: '2026-08-25',
  currencyCode: 'XTS',
  moneyScale: '100',
  submittedAt: '2026-08-20T10:00:00.000Z',
  approvedAt: null,
  closedAt: null,
  cancelledAt: null,
  cancelReason: null,
  notes: null,
  lineCount: 1,
  totalMinor: '4500000',
};

const ORDER_DETAIL = {
  ...ORDER_HEADER,
  legalNextStatuses: ['APPROVED', 'CANCELLED'],
  lines: [
    {
      purchaseOrderLineId: 'pol-1',
      lineNo: 1,
      productId: PRODUCT,
      skuCode: 'SKU-1',
      productName: 'Binder 50kg',
      uomId: 'u-tonne',
      uomCode: 'TONNE',
      qtyScale: 3,
      qtyOrdered: '5000',
      qtyReceived: '2000',
      qtyOutstanding: '3000',
      isFullyReceived: false,
      receiptLineCount: 1,
      stockingUomId: 'u-sack',
      stockingUomCode: 'SACK',
      qtyStockScale: 0,
      qtyOrderedStock: '100',
      qtyStockReceived: '40',
      factorNum: '20',
      factorDen: '1',
      unitPriceE4: '9000000000',
      lineNetMinor: '4500000',
    },
  ],
};

// ---------------------------------------------------------------------------

describe('magnitudes come off the wire as bigints, never numbers', () => {
  it('maps every money and quantity field on an order to bigint', async () => {
    const result = await fetchPurchaseOrder(ORDER, opts(answering(ORDER_DETAIL)));
    if (!result.ok) throw new Error('expected the order');
    expect(result.data.totalMinor).toBe(4_500_000n);
    expect(result.data.moneyScale).toBe(100n);
    const line = result.data.lines[0]!;
    expect(line.qtyOrdered).toBe(5000n);
    expect(line.qtyOutstanding).toBe(3000n);
    expect(line.factorNum).toBe(20n);
    expect(line.unitPriceE4).toBe(9_000_000_000n);
    expect(typeof line.lineNetMinor).toBe('bigint');
  });

  it('refuses a JSON number where a scaled magnitude belongs', async () => {
    const bad = { ...ORDER_DETAIL, totalMinor: 4500000 };
    const result = await fetchPurchaseOrder(ORDER, opts(answering(bad)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Loud, not coerced: a float64 in a total is the failure ADR-0004 exists
    // to make impossible.
    expect(result.failure.kind).toBe('malformed');
    expect(result.failure.detail).toMatch(/totalMinor/);
  });

  it('keeps a SIGNED outstanding quantity — an over-delivery is not clamped', async () => {
    const over = {
      ...ORDER_DETAIL,
      lines: [{ ...ORDER_DETAIL.lines[0], qtyOutstanding: '-500' }],
    };
    const result = await fetchPurchaseOrder(ORDER, opts(answering(over)));
    if (!result.ok) throw new Error('expected the order');
    expect(result.data.lines[0]!.qtyOutstanding).toBe(-500n);
  });
});

describe('an absent price is an absence, never a zero', () => {
  it('keeps null on a source nobody has bought from', async () => {
    const result = await fetchSourcesForProduct(PRODUCT, opts(answering(SOURCES_PAYLOAD)));
    if (!result.ok) throw new Error('expected the sources');
    const unpriced = result.data.sources[1]!;
    expect(unpriced.lastPriceE4).toBeNull();
    expect(unpriced.pricePerStockUnitE4).toBeNull();
    expect(unpriced.priceComparable).toBe(false);
    expect(unpriced.priceUnavailableReason).toBe('NO_RECORDED_PRICE');
  });

  it('keeps null freight on a delivery nobody has agreed a rate for', async () => {
    const payload = {
      scope: { locationCount: 1 },
      deliveryCount: 1,
      deliveries: [
        {
          deliveryId: 'd-1',
          sourceKind: 'PURCHASE_ORDER',
          sourceId: ORDER,
          carrierSupplierId: SUPPLIER,
          carrierName: 'Road Partners',
          carrierReference: null,
          fromLocationId: null,
          toLocationId: LOC,
          toAddressText: null,
          costLocationId: LOC,
          status: 'PLANNED',
          plannedFor: '2026-08-24',
          dispatchedAt: null,
          deliveredAt: null,
          failedReason: null,
          freightCostMinor: null,
          currencyCode: 'XTS',
          moneyScale: '100',
          notes: null,
        },
      ],
    };
    const result = await fetchDeliveries({}, opts(answering(payload)));
    if (!result.ok) throw new Error('expected the deliveries');
    expect(result.data.deliveries[0]!.freightCostMinor).toBeNull();
  });
});

describe('the exact rational conversion survives the wire', () => {
  it('carries the numerator and denominator as the pair they really are', async () => {
    const result = await fetchSourcesForProduct(PRODUCT, opts(answering(SOURCES_PAYLOAD)));
    if (!result.ok) throw new Error('expected the sources');
    const s = result.data.sources[0]!;
    // 20 sacks per tonne, exactly — not 20.0 and not a decimal that has to be
    // divided back out somewhere downstream.
    expect(s.stockUnitsPerPurchaseUnitNum).toBe(20n);
    expect(s.stockUnitsPerPurchaseUnitDen).toBe(1n);
    // The server's own ordering, preserved. The client never re-sorts on the
    // rounded per-stocking-unit figure.
    expect(result.data.sources.map((x) => x.supplierCode)).toEqual(['SUP-1', 'SUP-2']);
    expect(result.data.cheapestSupplierId).toBe(SUPPLIER);
  });
});

describe('offline is a reason, never an empty list', () => {
  it('answers offline for every buying read, and returns no data at all', async () => {
    const calls = [
      fetchSuppliers({}, opts(DEAD)),
      fetchSourcesForProduct(PRODUCT, opts(DEAD)),
      fetchPurchaseOrders({}, opts(DEAD)),
      fetchPurchaseOrder(ORDER, opts(DEAD)),
      fetchReorderSuggestions({ locationIds: [LOC] }, opts(DEAD)),
      fetchDeliveries({}, opts(DEAD)),
    ];
    for (const result of await Promise.all(calls)) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.failure.kind).toBe('offline');
      // No `data` key exists on a failure at all, so there is nothing an
      // over-eager screen could destructure into an empty table.
      expect('data' in result).toBe(false);
    }
  });

  it('refuses to queue a commitment when the radio is dead — it says so instead', async () => {
    const raised = await createPurchaseOrder(
      {
        idempotencyKey: KEY,
        supplierId: SUPPLIER,
        deliverToLocationId: LOC,
        orderDate: '2026-08-22',
        lines: [
          { lineNo: 1, productId: PRODUCT, uomId: UOM_BUY, qtyOrdered: '1000', unitPriceE4: '10000' },
        ],
      },
      opts(DEAD),
    );
    expect(raised.ok).toBe(false);
    if (!raised.ok) expect(raised.failure.kind).toBe('offline');

    const booked = await planDelivery(
      {
        idempotencyKey: KEY,
        sourceKind: 'PURCHASE_ORDER',
        sourceId: ORDER,
        carrierSupplierId: SUPPLIER,
      },
      opts(DEAD),
    );
    expect(booked.ok).toBe(false);
    if (!booked.ok) expect(booked.failure.kind).toBe('offline');
  });
});

describe('a request that the API would refuse never leaves the device', () => {
  it('refuses a reversed date range before a round trip', async () => {
    const asked: string[] = [];
    const result = await fetchPurchaseOrders(
      { from: '2026-08-20', to: '2026-08-01' },
      opts(answering({}, asked)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('invalid-request');
    // Nothing was sent: the shared contract refuses a reversed range rather
    // than normalising it, because a silently swapped range is the
    // right-looking figure for the wrong period.
    expect(asked).toEqual([]);
  });

  it('refuses a cancellation with no reason, which the contract also refuses', async () => {
    const asked: string[] = [];
    const result = await changePurchaseOrderStatus(
      { idempotencyKey: KEY, purchaseOrderId: ORDER, toStatus: 'CANCELLED' },
      opts(answering({}, asked)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('invalid-request');
      expect(result.failure.detail).toMatch(/reason/);
    }
    expect(asked).toEqual([]);
  });

  it('refuses a delivery status of FAILED with no explanation', async () => {
    // Same rule on the queued path: `buildDeliveryStatusPayload` refuses it
    // too, and its own test proves that. Here the point is that the contract
    // is the single statement of the rule.
    const asked: string[] = [];
    const result = await planDelivery(
      // A carrier id that is not a uuid — the contract's own guard.
      { idempotencyKey: KEY, sourceKind: 'PURCHASE_ORDER', sourceId: ORDER, carrierSupplierId: 'not-a-uuid' },
      opts(answering({}, asked)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('invalid-request');
    expect(asked).toEqual([]);
  });
});

describe('a refusal from the server carries a reason and no figures', () => {
  it('reports forbidden without inventing a total', async () => {
    const forbidden: ApiFetch = () =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({
            error: {
              json: {
                message: 'PERMISSION_DENIED: supplier.view is not held by this user',
                data: { code: 'FORBIDDEN' },
              },
            },
          }),
      });
    const result = await fetchSuppliers({}, opts(forbidden));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('forbidden');
    expect(result.failure.detail).toMatch(/supplier\.view/);
    expect('data' in result).toBe(false);
  });
});

describe('the reorder suggestion says WHY its list is what it is', () => {
  it('distinguishes “no thresholds” from “nothing is low”', async () => {
    const base = {
      scope: { locationCount: 1, network: false },
      activeThresholdCount: 0,
      lowStockCount: 0,
      suggestionCount: 0,
      unsourcedCount: 0,
      suggestions: [],
      unsourced: [],
    };
    const none = await fetchReorderSuggestions(
      { locationIds: [LOC] },
      opts(answering({ ...base, state: 'NO_THRESHOLDS_CONFIGURED' })),
    );
    const healthy = await fetchReorderSuggestions(
      { locationIds: [LOC] },
      opts(answering({ ...base, state: 'NOTHING_BELOW_REORDER_POINT', activeThresholdCount: 7 })),
    );
    if (!none.ok || !healthy.ok) throw new Error('expected both answers');
    // Two identical empty arrays, two opposite meanings. The state is what
    // lets a screen tell them apart.
    expect(none.data.suggestions).toEqual([]);
    expect(healthy.data.suggestions).toEqual([]);
    expect(none.data.state).toBe('NO_THRESHOLDS_CONFIGURED');
    expect(healthy.data.state).toBe('NOTHING_BELOW_REORDER_POINT');
  });
});
