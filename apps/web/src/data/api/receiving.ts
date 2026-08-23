/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT HAS ALREADY BEEN BOOKED IN — the yard's matching reads
 * ═══════════════════════════════════════════════════════════════════════════
 * Two server reads, and both answer one question a yard hand asks before
 * signing anything: *has this already gone in?*
 *
 *  · `receiving.purchaseOrderReceiptStatus` — ordered against received, per
 *    line, for one order, with a SIGNED outstanding figure, plus the receipts
 *    already posted against it.
 *  · `receiving.get` — one of those receipts, opened: what the supplier
 *    invoiced, what was counted, and the deviation between them.
 *
 * ---------------------------------------------------------------------------
 * THE SERVER IS IDEMPOTENT; THE RISK BEING CLOSED HERE IS A HUMAN ONE
 * ---------------------------------------------------------------------------
 * A replayed receipt with the same key is one receipt — the outbox and
 * `runIdempotent` see to that. What neither can prevent is a person signing
 * for the same load TWICE with two different keys, minutes apart, because
 * nothing on the screen told them the first one had landed. That is what these
 * reads are for, and it is why the receipt list is shown beside the
 * outstanding figures rather than on some other screen.
 *
 * ---------------------------------------------------------------------------
 * BOTH ARE SERVER READS AND NEITHER HAS AN OFFLINE ANSWER
 * ---------------------------------------------------------------------------
 * `app.goods_receipt` and `app.purchase_order_line_status` are in no sync
 * bucket, exactly as orders and suppliers are not
 * (`infra/powersync/sync_rules.yaml`). A partitioned device genuinely does not
 * know what another gate booked in this morning, and the only honest thing to
 * do is say so. There is deliberately NO cache of an outstanding quantity in
 * this module: a stale "still outstanding" figure shown to somebody with a
 * truck at the gate is exactly how a load gets received twice.
 *
 * The device's own take-down (`data/queries/takedown.ts`) is the one local
 * copy, it is a DOCUMENT stamped with the minute it was taken, and its
 * outstanding figure is named `qtyOutstandingAtTakeDown` all the way through
 * so it can never be read as this.
 *
 * Every quantity and money value is mapped to `bigint` through `asScaled`,
 * never `Number` — a scaled integer that has been through a float is a
 * quantity nobody can reconcile.
 */
import { goodsReceiptInput, purchaseOrderReceiptStatusInput } from '@erp/contracts';
import {
  apiQuery,
  asArray,
  asBoolean,
  asCount,
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

/** One line of the ordered-versus-received answer, in the ORDER line's unit. */
export interface ReceiptStatusLine {
  readonly purchaseOrderLineId: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly skuCode: string;
  readonly productName: string;
  /** The supplier's unit — what the order was placed in. */
  readonly uomCode: string;
  readonly qtyScale: number;
  readonly qtyOrdered: bigint;
  readonly qtyReceived: bigint;
  /**
   * SIGNED, and deliberately not clamped: a negative is an OVER-delivery.
   * Clamping it away hides the quantity an invoice will be raised for.
   */
  readonly qtyOutstanding: bigint;
  readonly stockingUomCode: string;
  readonly qtyStockScale: number;
  readonly qtyOrderedStock: bigint;
  readonly qtyStockReceived: bigint;
  readonly isFullyReceived: boolean;
  /**
   * How many receipt lines have been matched to this order line so far. It
   * crosses as a decimal string (`count(*)::text`) and stays a `bigint` here:
   * a JSON number would be the one place a count is allowed to be a float.
   */
  readonly receiptLineCount: bigint;
}

/** A receipt already posted against the order — the "has it gone in?" answer. */
export interface PostedReceipt {
  readonly goodsReceiptId: string;
  readonly businessDate: string;
}

export interface PurchaseOrderReceiptStatus {
  readonly purchaseOrderId: string;
  readonly status: string;
  readonly supplierId: string;
  readonly deliverToLocationId: string;
  /** True only when every line is fully received. An empty order is not. */
  readonly isFullyReceived: boolean;
  readonly lines: readonly ReceiptStatusLine[];
  readonly receipts: readonly PostedReceipt[];
}

/** One line of a posted receipt: what was invoiced, and what was counted. */
export interface GoodsReceiptLine {
  readonly goodsReceiptLineId: string;
  readonly lineNo: number;
  readonly purchaseOrderLineId: string | null;
  readonly productId: string;
  readonly skuCode: string;
  readonly productName: string;
  /** The supplier's unit, and what they invoiced in it. */
  readonly uomCode: string;
  readonly qtyReceived: bigint;
  readonly qtyReceivedScale: number;
  /** The stocking unit, and what actually went onto the shelf. */
  readonly stockingUomCode: string;
  readonly qtyStock: bigint;
  /** What the CONVERSION said the invoiced quantity should be. */
  readonly qtyStockComputed: bigint;
  readonly qtyStockScale: number;
  readonly factorNum: bigint;
  readonly factorDen: bigint;
  /** Who asserted the counted figure when it differed from the computed one. */
  readonly conversionConfirmedBy: string | null;
  /** Counted against computed, in basis points. Zero when they agree. */
  readonly deviationBp: bigint;
  readonly unitCostE4: bigint;
  readonly stockUnitCostE4: bigint;
  readonly lineNetMinor: bigint;
  readonly notes: string | null;
}

export interface GoodsReceipt {
  readonly goodsReceiptId: string;
  readonly purchaseOrderId: string | null;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly locationId: string;
  readonly businessDate: string;
  readonly receivedAt: string;
  readonly supplierDeliveryNoteRef: string | null;
  readonly supplierInvoiceRef: string | null;
  readonly receivedByUserId: string | null;
  readonly notes: string | null;
  readonly lines: readonly GoodsReceiptLine[];
}

// ---------------------------------------------------------------------------
// Mappers — a wire string becomes a bigint here and nowhere else
// ---------------------------------------------------------------------------

function mapStatusLine(entry: unknown, what: string): ReceiptStatusLine {
  const row = asRecord(entry, what);
  return {
    purchaseOrderLineId: asString(row['purchaseOrderLineId'], `${what}.purchaseOrderLineId`),
    lineNo: asCount(row['lineNo'], `${what}.lineNo`),
    productId: asString(row['productId'], `${what}.productId`),
    skuCode: asString(row['skuCode'], `${what}.skuCode`),
    productName: asString(row['productName'], `${what}.productName`),
    uomCode: asString(row['uomCode'], `${what}.uomCode`),
    qtyScale: asCount(row['qtyScale'], `${what}.qtyScale`),
    qtyOrdered: asScaled(row['qtyOrdered'], `${what}.qtyOrdered`),
    qtyReceived: asScaled(row['qtyReceived'], `${what}.qtyReceived`),
    qtyOutstanding: asScaled(row['qtyOutstanding'], `${what}.qtyOutstanding`),
    stockingUomCode: asString(row['stockingUomCode'], `${what}.stockingUomCode`),
    qtyStockScale: asCount(row['qtyStockScale'], `${what}.qtyStockScale`),
    qtyOrderedStock: asScaled(row['qtyOrderedStock'], `${what}.qtyOrderedStock`),
    qtyStockReceived: asScaled(row['qtyStockReceived'], `${what}.qtyStockReceived`),
    isFullyReceived: asBoolean(row['isFullyReceived'], `${what}.isFullyReceived`),
    receiptLineCount: asScaled(row['receiptLineCount'], `${what}.receiptLineCount`),
  };
}

function mapReceiptStatus(json: unknown): PurchaseOrderReceiptStatus {
  const root = asRecord(json, 'receiving.purchaseOrderReceiptStatus');
  return {
    purchaseOrderId: asString(root['purchaseOrderId'], 'purchaseOrderId'),
    status: asString(root['status'], 'status'),
    supplierId: asString(root['supplierId'], 'supplierId'),
    deliverToLocationId: asString(root['deliverToLocationId'], 'deliverToLocationId'),
    isFullyReceived: asBoolean(root['isFullyReceived'], 'isFullyReceived'),
    lines: asArray(root['lines'], 'lines').map((l, i) =>
      mapStatusLine(l, `lines[${String(i)}]`),
    ),
    receipts: asArray(root['receipts'], 'receipts').map((r, i) => {
      const what = `receipts[${String(i)}]`;
      const row = asRecord(r, what);
      return {
        goodsReceiptId: asString(row['goodsReceiptId'], `${what}.goodsReceiptId`),
        businessDate: asString(row['businessDate'], `${what}.businessDate`),
      };
    }),
  };
}

function mapReceiptLine(entry: unknown, what: string): GoodsReceiptLine {
  const row = asRecord(entry, what);
  return {
    goodsReceiptLineId: asString(row['goodsReceiptLineId'], `${what}.goodsReceiptLineId`),
    lineNo: asCount(row['lineNo'], `${what}.lineNo`),
    purchaseOrderLineId: asOptionalString(
      row['purchaseOrderLineId'],
      `${what}.purchaseOrderLineId`,
    ),
    productId: asString(row['productId'], `${what}.productId`),
    skuCode: asString(row['skuCode'], `${what}.skuCode`),
    productName: asString(row['productName'], `${what}.productName`),
    uomCode: asString(row['uomCode'], `${what}.uomCode`),
    qtyReceived: asScaled(row['qtyReceived'], `${what}.qtyReceived`),
    qtyReceivedScale: asCount(row['qtyReceivedScale'], `${what}.qtyReceivedScale`),
    stockingUomCode: asString(row['stockingUomCode'], `${what}.stockingUomCode`),
    qtyStock: asScaled(row['qtyStock'], `${what}.qtyStock`),
    qtyStockComputed: asScaled(row['qtyStockComputed'], `${what}.qtyStockComputed`),
    qtyStockScale: asCount(row['qtyStockScale'], `${what}.qtyStockScale`),
    factorNum: asScaled(row['factorNum'], `${what}.factorNum`),
    factorDen: asScaled(row['factorDen'], `${what}.factorDen`),
    conversionConfirmedBy: asOptionalString(
      row['conversionConfirmedBy'],
      `${what}.conversionConfirmedBy`,
    ),
    deviationBp: asScaled(row['deviationBp'], `${what}.deviationBp`),
    unitCostE4: asScaled(row['unitCostE4'], `${what}.unitCostE4`),
    stockUnitCostE4: asScaled(row['stockUnitCostE4'], `${what}.stockUnitCostE4`),
    lineNetMinor: asScaled(row['lineNetMinor'], `${what}.lineNetMinor`),
    notes: asOptionalString(row['notes'], `${what}.notes`),
  };
}

function mapGoodsReceipt(json: unknown): GoodsReceipt {
  const root = asRecord(json, 'receiving.get');
  return {
    goodsReceiptId: asString(root['goodsReceiptId'], 'goodsReceiptId'),
    purchaseOrderId: asOptionalString(root['purchaseOrderId'], 'purchaseOrderId'),
    supplierId: asString(root['supplierId'], 'supplierId'),
    supplierName: asString(root['supplierName'], 'supplierName'),
    locationId: asString(root['locationId'], 'locationId'),
    businessDate: asString(root['businessDate'], 'businessDate'),
    receivedAt: asString(root['receivedAt'], 'receivedAt'),
    supplierDeliveryNoteRef: asOptionalString(
      root['supplierDeliveryNoteRef'],
      'supplierDeliveryNoteRef',
    ),
    supplierInvoiceRef: asOptionalString(root['supplierInvoiceRef'], 'supplierInvoiceRef'),
    receivedByUserId: asOptionalString(root['receivedByUserId'], 'receivedByUserId'),
    notes: asOptionalString(root['notes'], 'notes'),
    lines: asArray(root['lines'], 'lines').map((l, i) => mapReceiptLine(l, `lines[${String(i)}]`)),
  };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * What has been received against one order so far, what is still outstanding,
 * and every receipt already posted against it.
 *
 * Guarded `purchase.order.view` at the ORDER's own deliver-to location by the
 * server — a goods receipt is a purchasing document and the catalogue has no
 * separate receipt-read capability.
 */
export function fetchPurchaseOrderReceiptStatus(
  purchaseOrderId: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<PurchaseOrderReceiptStatus>> {
  const input = { purchaseOrderId };
  const bad = guard(
    purchaseOrderReceiptStatusInput,
    'receiving.purchaseOrderReceiptStatus',
    input,
  );
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('receiving.purchaseOrderReceiptStatus', input, mapReceiptStatus, options);
}

/** One posted receipt, opened: invoiced against counted, line by line. */
export function fetchGoodsReceipt(
  goodsReceiptId: string,
  options: ApiCallOptions = {},
): Promise<ApiResult<GoodsReceipt>> {
  const input = { goodsReceiptId };
  const bad = guard(goodsReceiptInput, 'receiving.get', input);
  if (bad !== null) return Promise.resolve(bad);
  return apiQuery('receiving.get', input, mapGoodsReceipt, options);
}
