/**
 * The Phase 2 wire contract, checked against the rules of this package.
 *
 * Two of these tests are ordinary shape tests. The rest exist because of §0 of
 * `docs/phase1-status.md`: eleven times a written path was never executed, and
 * the single root cause was that both sides were only ever tested against a
 * third thing that agreed with neither. So the assertions here are about the
 * properties that let that happen — money crossing as a number, an object that
 * strips rather than rejects an unknown key, and a device op registered
 * against a schema nothing else uses.
 */
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATUSES,
  DEVICE_OP_KINDS,
  PROCUREMENT_UPLOADABLE_OPS,
  PURCHASE_ORDER_STATUSES,
  changePurchaseOrderStatusInput,
  createPurchaseOrderInput,
  deviceOpContracts,
  goodsReceiptLineInput,
  planDeliveryInput,
  recordGoodsReceiptInput,
  updateDeliveryStatusInput,
  upsertSupplierInput,
} from '../src/index.js';

const KEY = '018f3a1e-0000-7000-8000-000000000001';
const ID = (n: number) => `018f3a1e-0000-7000-8000-${String(n).padStart(12, '0')}`;

function receiptPayload(over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: KEY,
    supplierId: ID(1),
    locationId: ID(2),
    businessDate: '2026-08-21',
    lines: [
      {
        lineNo: 1,
        productId: ID(3),
        uomId: ID(4),
        qtyReceived: '2500',
        qtyStock: '234',
        unitCostE4: '4500000',
      },
    ],
    ...over,
  };
}

describe('money and quantity never cross as JS numbers (ADR-0004)', () => {
  it('a receipt line refuses a numeric quantity and a numeric cost', () => {
    const numericQty = receiptPayload({
      lines: [
        { lineNo: 1, productId: ID(3), uomId: ID(4), qtyReceived: 2500, qtyStock: '234', unitCostE4: '1' },
      ],
    });
    expect(recordGoodsReceiptInput.safeParse(numericQty).success).toBe(false);

    const numericCost = receiptPayload({
      lines: [
        { lineNo: 1, productId: ID(3), uomId: ID(4), qtyReceived: '2500', qtyStock: '234', unitCostE4: 45 },
      ],
    });
    expect(recordGoodsReceiptInput.safeParse(numericCost).success).toBe(false);
  });

  it('a decimal string becomes a bigint, and a magnitude no float64 holds survives it', () => {
    // 400 tonnes at scale 3 is 400_000_000 scaled units; the interesting case
    // is one past 2^53, which a JSON number silently rounds.
    const big = '9007199254740993';
    const parsed = recordGoodsReceiptInput.parse(
      receiptPayload({
        lines: [
          { lineNo: 1, productId: ID(3), uomId: ID(4), qtyReceived: big, qtyStock: '1', unitCostE4: '0' },
        ],
      }),
    );
    expect(parsed.lines[0]!.qtyReceived).toBe(9007199254740993n);
    expect(typeof parsed.lines[0]!.qtyReceived).toBe('bigint');
  });

  it('freight cost crosses as a string too — a delivery is a money document', () => {
    const plan = {
      idempotencyKey: KEY,
      sourceKind: 'PURCHASE_ORDER',
      sourceId: ID(9),
      carrierSupplierId: ID(8),
      freightCostMinor: '150000',
    };
    expect(planDeliveryInput.parse(plan).freightCostMinor).toBe(150000n);
    expect(planDeliveryInput.safeParse({ ...plan, freightCostMinor: 150000 }).success).toBe(false);
  });
});

describe('tenant identity is never an input (CLAUDE.md §2.1)', () => {
  it('every strict object REJECTS a forged tenant key rather than stripping it', () => {
    const forged = { tenant_id: ID(99), tenantId: ID(99), tid: ID(99) };
    expect(recordGoodsReceiptInput.safeParse({ ...receiptPayload(), ...forged }).success).toBe(false);
    expect(
      upsertSupplierInput.safeParse({
        idempotencyKey: KEY,
        code: 'X',
        name: 'X',
        paymentTermsDays: 0,
        ...forged,
      }).success,
    ).toBe(false);
    expect(
      createPurchaseOrderInput.safeParse({
        idempotencyKey: KEY,
        supplierId: ID(1),
        deliverToLocationId: ID(2),
        orderDate: '2026-08-21',
        lines: [{ lineNo: 1, productId: ID(3), uomId: ID(4), qtyOrdered: '10', unitPriceE4: '1' }],
        ...forged,
      }).success,
    ).toBe(false);
  });

  it('a supplier cannot state its own currency — that is the pack’s (CLAUDE.md §2.5)', () => {
    expect(
      upsertSupplierInput.safeParse({
        idempotencyKey: KEY,
        code: 'X',
        name: 'X',
        paymentTermsDays: 30,
        currencyCode: 'USD',
      }).success,
    ).toBe(false);
  });
});

describe('a receipt records two quantities, and short deliveries are not errors', () => {
  it('accepts qtyReceived and qtyStock that do not agree — neither is derived', () => {
    const parsed = goodsReceiptLineInput.parse({
      lineNo: 1,
      productId: ID(3),
      uomId: ID(4),
      // 2.5 t invoiced, 234 bars in the yard: what was invoiced and what
      // entered are two facts (04 §4.10).
      qtyReceived: '2500',
      qtyStock: '234',
      unitCostE4: '4500000',
      confirmConversion: true,
    });
    expect(parsed.qtyReceived).toBe(2500n);
    expect(parsed.qtyStock).toBe(234n);
  });

  it('a client cannot state an extended amount — the server owns every total', () => {
    expect(
      goodsReceiptLineInput.safeParse({
        lineNo: 1,
        productId: ID(3),
        uomId: ID(4),
        qtyReceived: '1',
        qtyStock: '1',
        unitCostE4: '1',
        lineNetMinor: '1',
      }).success,
    ).toBe(false);
  });
});

describe('status changes carry their reason where a blank one is unanswerable', () => {
  it('cancelling a purchase order requires a reason', () => {
    const base = { idempotencyKey: KEY, purchaseOrderId: ID(5) };
    expect(
      changePurchaseOrderStatusInput.safeParse({ ...base, toStatus: 'CANCELLED' }).success,
    ).toBe(false);
    expect(
      changePurchaseOrderStatusInput.safeParse({
        ...base,
        toStatus: 'CANCELLED',
        reason: 'supplier cannot deliver',
      }).success,
    ).toBe(true);
    // …and an ordinary move does not.
    expect(changePurchaseOrderStatusInput.safeParse({ ...base, toStatus: 'APPROVED' }).success).toBe(
      true,
    );
  });

  it('a failed delivery requires a reason', () => {
    const base = { idempotencyKey: KEY, deliveryId: ID(6) };
    expect(updateDeliveryStatusInput.safeParse({ ...base, toStatus: 'FAILED' }).success).toBe(false);
    expect(
      updateDeliveryStatusInput.safeParse({ ...base, toStatus: 'FAILED', reason: 'site closed' })
        .success,
    ).toBe(true);
  });
});

describe('no fleet, and no tenant vocabulary, in the contract (ADR-0001, §2.9)', () => {
  it('a delivery names a carrier and nothing about a truck', () => {
    const fleetish = [
      'vehicleId',
      'vehicle',
      'driverId',
      'driverName',
      'registration',
      'plateNumber',
      'fuelLitres',
      'odometer',
    ];
    for (const key of fleetish) {
      expect(
        planDeliveryInput.safeParse({
          idempotencyKey: KEY,
          sourceKind: 'SALE',
          sourceId: ID(9),
          carrierSupplierId: ID(8),
          [key]: 'anything',
        }).success,
        `planDeliveryInput accepted '${key}' — ADR-0001 permits dispatch and tracking only`,
      ).toBe(false);
    }
  });

  it('the status vocabularies are platform words, and the tenant’s are absent', () => {
    // No supplier code, no capability code, no role name, no SKU shape.
    const source = JSON.stringify([PURCHASE_ORDER_STATUSES, DELIVERY_STATUSES]);
    for (const tenantWord of ['GHACEM', 'DANGOTE', 'CIMAF', 'FLAGSHIP', 'RDC', 'MICRO']) {
      expect(source).not.toContain(tenantWord);
    }
    expect(PURCHASE_ORDER_STATUSES).toContain('CLOSED'); // how a short delivery ends
    expect(DELIVERY_STATUSES).toContain('FAILED');
  });
});

describe('the device-uploadable subset stays honest', () => {
  it('names the two ops that must work offline, each against ONE schema object', () => {
    expect(Object.keys(PROCUREMENT_UPLOADABLE_OPS).sort()).toEqual([
      'goods.record_receipt',
      'logistics.update_delivery_status',
    ]);
    expect(PROCUREMENT_UPLOADABLE_OPS['goods.record_receipt']).toBe(recordGoodsReceiptInput);
    expect(PROCUREMENT_UPLOADABLE_OPS['logistics.update_delivery_status']).toBe(
      updateDeliveryStatusInput,
    );
  });

  it('a registered procurement kind must use THE schema declared here, never a copy', () => {
    // Non-vacuous the moment a later agent registers one: registering
    // `goods.record_receipt` against a privately redeclared schema — the exact
    // shape of the sale-payload bug — turns this red. Until then it asserts
    // the honest thing: nothing procurement-shaped is registered yet, so no
    // kind can be dispatched-in-name-only.
    for (const [kind, schema] of Object.entries(PROCUREMENT_UPLOADABLE_OPS)) {
      if ((DEVICE_OP_KINDS as readonly string[]).includes(kind)) {
        expect(
          (deviceOpContracts as Record<string, unknown>)[kind],
          `'${kind}' is registered against a different schema object than PROCUREMENT_UPLOADABLE_OPS declares`,
        ).toBe(schema);
      }
    }
    const registeredProcurement = (DEVICE_OP_KINDS as readonly string[]).filter(
      (k) => k.startsWith('goods.') || k.startsWith('logistics.') || k.startsWith('purchase.'),
    );
    for (const kind of registeredProcurement) {
      expect(
        Object.keys(PROCUREMENT_UPLOADABLE_OPS),
        `'${kind}' is uploadable but is not declared in PROCUREMENT_UPLOADABLE_OPS — declare it there with its schema, or it is a shape only one side has seen`,
      ).toContain(kind);
    }
  });
});
