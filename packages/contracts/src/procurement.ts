/**
 * The Phase 2 wire contracts — suppliers, purchase orders, goods receipts and
 * third-party deliveries.
 *
 * ONE declaration, imported by `apps/api` (which parses) and by whatever
 * client is written next (which builds), so a disagreement between the two is
 * a `tsc` error rather than a BAD_REQUEST from a yard with no connectivity and
 * no developer nearby. Everything §0 of `docs/phase1-status.md` records
 * happened because a payload shape lived on one side of the wire only; these
 * are written before either side exists precisely so that cannot happen again.
 *
 * The rules of this package apply without exception (see `index.ts`):
 *   * zod only — this file is bundled into the browser build of the PWA;
 *   * money and quantities cross as decimal STRINGS of scaled integer units
 *     and become `bigint` here (CLAUDE.md §2.3, ADR-0004). A JSON number is a
 *     float64 in every consumer and never carries a magnitude;
 *   * every object is `.strict()` — unknown keys are REJECTED, not stripped;
 *   * no tenant identity in any spelling, ever (CLAUDE.md §2.1);
 *   * no tenant vocabulary. There is no supplier code, no capability code and
 *     no role name in this file. `capabilityTypeId` is a uuid into the
 *     tenant's own `supplier_capability_type` rows, because GOODS and HAULAGE
 *     are the tenant's words for its own taxonomy (CLAUDE.md §2.9).
 *
 * ---------------------------------------------------------------------------
 * ADR-0001: THERE IS NO VEHICLE HERE
 * ---------------------------------------------------------------------------
 * A delivery names a CARRIER, and a carrier is a supplier holding a capability
 * of kind HAULAGE. There is no vehicle, driver, fuel or maintenance field in
 * this contract and there must never be one. If a field appears that describes
 * a truck rather than a counterparty, the scope has been left.
 *
 * ---------------------------------------------------------------------------
 * WHY QUANTITIES COME IN PAIRS
 * ---------------------------------------------------------------------------
 * What a supplier invoices and what enters the yard are two facts in two
 * units, and short deliveries are NORMAL (04 §4.10). So a receipt line carries
 * `qtyReceived` in the supplier's unit AND `qtyStock` in the product's
 * stocking unit, and neither is derived from the other on the wire. The server
 * computes what the conversion says `qtyStock` should have been, and a
 * difference needs a human's confirmation (04 §4.4.4) — which is why
 * `confirmConversion` is on the line and is not a nicety.
 *
 * ---------------------------------------------------------------------------
 * PRICES AND COSTS ARE THE CLIENT'S TO STATE; TOTALS ARE NOT
 * ---------------------------------------------------------------------------
 * A purchase price is negotiated with a supplier and is not derivable from
 * anything the server holds, so `unitPriceE4` crosses the wire. Extended
 * amounts do NOT: the server computes every `line_net_minor` with the one
 * documented rounding rule (04 §4.13), because two implementations of the same
 * rounding is how the same order acquires two totals.
 */
import { z } from 'zod';
import {
  mutationEnvelope,
  zBusinessDate,
  zScaledIntNonNeg,
  zScaledIntPos,
  zUuid,
} from './wire.js';

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

/**
 * The PLATFORM half of a supplier capability, and the only half any code may
 * branch on. The tenant's own `code`/`name` for the capability are its
 * vocabulary and appear nowhere in this contract (ADR-0006 — the same split
 * as `location.kind` versus `location_type.code`).
 *
 * GOODS — sells things. HAULAGE — carries things. A party may be both, and a
 * regional cement distributor that also runs trucks usually is.
 */
export const SUPPLIER_CAPABILITY_KINDS = ['GOODS', 'HAULAGE'] as const;
export type SupplierCapabilityKind = (typeof SUPPLIER_CAPABILITY_KINDS)[number];

/**
 * Create or amend a supplier.
 *
 * There is no `currencyCode` here on purpose: currency and minor-unit scale
 * belong to the tenant's jurisdiction pack (CLAUDE.md §2.5) and the server
 * stamps them. A client that could state a currency could state the wrong one.
 */
export const upsertSupplierInput = z
  .object({
    ...mutationEnvelope,
    /** Omit to create; supply to amend. */
    supplierId: zUuid.optional(),
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    /** Days from invoice to due. 0 is cash on delivery — a real term. */
    paymentTermsDays: z.number().int().min(0).max(365),
    contactName: z.string().max(200).optional(),
    contactPhone: z.string().max(64).optional(),
    contactEmail: z.string().max(320).optional(),
    addressText: z.string().max(1000).optional(),
    notes: z.string().max(1000).optional(),
    isActive: z.boolean().optional(),
    /**
     * The capabilities this supplier holds, as ids into the TENANT's own
     * `supplier_capability_type` rows. Supplying the list REPLACES it, which
     * is what makes "this haulier now also sells sand" one call rather than a
     * diff the client has to compute. Omit to leave it alone.
     */
    capabilityTypeIds: z.array(zUuid).max(32).optional(),
  })
  .strict();

/**
 * Declare that a supplier can supply a product, in a stated unit
 * — the multi-source row (04 §4.10). The same SKU from three manufacturers is
 * three of these, which is what makes the plan's negotiating leverage data.
 *
 * `purchaseUomId` MUST be a unit the product declares as buyable
 * (`product_uom.can_buy`) — the same machinery selling uses, in the opposite
 * direction. The server refuses anything else, because a purchase unit with no
 * conversion factor cannot become the stocking unit the ledger is denominated
 * in.
 */
export const upsertSupplierProductInput = z
  .object({
    ...mutationEnvelope,
    supplierId: zUuid,
    productId: zUuid,
    purchaseUomId: zUuid,
    supplierSku: z.string().max(64).optional(),
    leadTimeDays: z.number().int().min(0).max(3650).optional(),
    /**
     * What we last paid, per ONE purchase unit, × 10⁴ (minor units).
     * Decision support, never a contracted price: an order line snapshots its
     * own. Omitted rather than zeroed when unknown — a zero reads as free.
     */
    lastPriceE4: zScaledIntNonNeg.optional(),
    lastPriceOn: zBusinessDate.optional(),
    /** At most one preferred source per product; setting this clears the other. */
    isPreferred: z.boolean().optional(),
    isActive: z.boolean().optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();

/** Which suppliers can supply this product, and on what terms. */
export const suppliersForProductInput = z
  .object({ productId: zUuid, includeInactive: z.boolean().optional() })
  .strict();

/** List suppliers, optionally narrowed to one platform capability kind. */
export const listSuppliersInput = z
  .object({
    kind: z.enum(SUPPLIER_CAPABILITY_KINDS).optional(),
    includeInactive: z.boolean().optional(),
    search: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

/**
 * The purchase-order state machine, mirrored for the client. THE CANONICAL
 * STATEMENT IS IN THE DATABASE — `app.purchase_order_legal_transitions()`,
 * enforced by trigger on every UPDATE. This list exists so a screen can name a
 * status; the legal NEXT statuses should be read from the server rather than
 * re-derived here, because a second copy of a transition table is a second
 * copy that drifts.
 *
 *   DRAFT               being written; lines editable; the only insertable status
 *   SUBMITTED           sent for approval; lines frozen
 *   APPROVED            authorised; goods may now be received against it
 *   PARTIALLY_RECEIVED  some of it has arrived
 *   RECEIVED            all of it has arrived
 *   CANCELLED           abandoned before anything was received (terminal)
 *   CLOSED              no more is expected (terminal) — how a SHORT DELIVERY ends
 */
export const PURCHASE_ORDER_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED',
  'CLOSED',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

/**
 * A line on a new or amended order.
 *
 * `qtyOrdered` is in `uomId`, the SUPPLIER's unit, as a decimal string of
 * scaled integer units — 2.5 tonnes at scale 3 is "2500". The server resolves
 * the conversion into the stocking unit from `product_uom`, snapshots the
 * rational factor onto the line, and computes the extended amount. The client
 * states what it is buying and what it agreed to pay; it does not state
 * totals.
 */
export const purchaseOrderLineInput = z
  .object({
    lineNo: z.number().int().min(1).max(9999),
    productId: zUuid,
    /** The supplier's unit. Must be a buyable unit of the product. */
    uomId: zUuid,
    qtyOrdered: zScaledIntPos,
    /** Agreed price per ONE purchase unit, × 10⁴ (minor units). */
    unitPriceE4: zScaledIntNonNeg,
    notes: z.string().max(1000).optional(),
  })
  .strict();

/**
 * Raise a purchase order. It is created as a DRAFT — always, and the database
 * refuses anything else. Approving is a separate act by a separate capability
 * (`purchase.order.approve`), which is the standard control against a
 * fabricated receipt and the reason the two are not one call.
 *
 * `orderNo` is absent deliberately: a network-wide document number is
 * coordination two offline outlets cannot do (03 §3.7.5), so a tenant that
 * wants numbered orders allocates from a sequence block exactly as receipts
 * do, and the server assigns it. A client-chosen number is a collision.
 */
export const createPurchaseOrderInput = z
  .object({
    ...mutationEnvelope,
    supplierId: zUuid,
    /** Where the goods are to arrive. Must be a location that holds stock. */
    deliverToLocationId: zUuid,
    orderDate: zBusinessDate,
    expectedAt: zBusinessDate.optional(),
    notes: z.string().max(1000).optional(),
    lines: z.array(purchaseOrderLineInput).min(1).max(500),
  })
  .strict();

/** Replace a DRAFT order's lines and header fields. Refused once submitted. */
export const updatePurchaseOrderInput = z
  .object({
    ...mutationEnvelope,
    purchaseOrderId: zUuid,
    expectedAt: zBusinessDate.optional(),
    notes: z.string().max(1000).optional(),
    /** Supplying the array REPLACES every line. Omit to leave them alone. */
    lines: z.array(purchaseOrderLineInput).min(1).max(500).optional(),
  })
  .strict();

/**
 * Move an order along its state machine.
 *
 * Deliberately ONE mutation rather than submit/approve/cancel/close verbs: the
 * legality of a move is decided by the database's transition table, and four
 * endpoints would be four places to forget to consult it. The CAPABILITY still
 * differs per target status — the server derives it from `toStatus` — so
 * approving remains a permission that raising an order does not carry.
 *
 * `reason` is required for CANCELLED: an order abandoned with no explanation
 * is an audit question nobody can answer six months later.
 */
export const changePurchaseOrderStatusInput = z
  .object({
    ...mutationEnvelope,
    purchaseOrderId: zUuid,
    toStatus: z.enum(PURCHASE_ORDER_STATUSES),
    reason: z.string().max(1000).optional(),
  })
  .strict()
  .refine((v) => v.toStatus !== 'CANCELLED' || (v.reason ?? '').trim().length > 0, {
    message: 'cancelling an order requires a reason',
    path: ['reason'],
  });

/** Read one order with its lines and what remains outstanding on each. */
export const purchaseOrderInput = z.object({ purchaseOrderId: zUuid }).strict();

/** List orders, narrowed. `locationIds` NARROWS and never widens scope. */
export const listPurchaseOrdersInput = z
  .object({
    locationIds: z.array(zUuid).min(1).max(500).optional(),
    supplierId: zUuid.optional(),
    statuses: z.array(z.enum(PURCHASE_ORDER_STATUSES)).min(1).max(7).optional(),
    from: zBusinessDate.optional(),
    to: zBusinessDate.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: 'from must not be after to',
    path: ['from'],
  });

// ---------------------------------------------------------------------------
// Goods receipts
// ---------------------------------------------------------------------------

/**
 * One line of a receipt. THE TWO QUANTITIES ARE THE POINT.
 *
 *   qtyReceived  what the supplier invoiced, in THEIR unit (`uomId`)
 *   qtyStock     what actually entered the yard, in the product's STOCKING
 *                unit — the only figure the movement ledger will see
 *
 * They are stated independently. Ten tonnes ordered, nine and a half
 * delivered, 190 bags counted off the truck are three facts, and the system
 * that quietly reconciles them for you is the system that hides the loss.
 * SHORT DELIVERIES ARE NORMAL and produce no error.
 *
 * The server computes what the snapshotted conversion says `qtyStock` should
 * have been. If the two differ, `confirmConversion` must be true — the yard
 * looked at the pile and signed for the difference (04 §4.4.4) — and the
 * server records who confirmed it. A silent default here would make the
 * system quietly wrong 234 times out of 235.
 */
export const goodsReceiptLineInput = z
  .object({
    lineNo: z.number().int().min(1).max(9999),
    /** Match to a line of the receipt's own order. Omit for an unordered extra. */
    purchaseOrderLineId: zUuid.optional(),
    productId: zUuid,
    /** The supplier's unit; must be a buyable unit of the product. */
    uomId: zUuid,
    /** What was invoiced, in the supplier's unit. */
    qtyReceived: zScaledIntPos,
    /** What entered the yard, in the product's STOCKING unit. */
    qtyStock: zScaledIntPos,
    /** Cost as invoiced, per ONE purchase unit, × 10⁴ (minor units). */
    unitCostE4: zScaledIntNonNeg,
    /** Required when qtyStock differs from the computed conversion. */
    confirmConversion: z.boolean().optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();

/**
 * Post a goods receipt.
 *
 * `purchaseOrderId` is optional because a receipt with no order genuinely
 * happens — an emergency collection, a returned delivery — and recording it
 * honestly beats inventing an order to satisfy a required field. Where there
 * IS an order, the server refuses the receipt unless that order is APPROVED or
 * PARTIALLY_RECEIVED and its supplier matches: a receipt cannot precede its
 * own authorisation.
 *
 * `businessDate` is the human-asserted trading day (03 §3.4.2), never a device
 * clock — it is the accounting fact and a tablet whose clock is a month out
 * must not post goods into the wrong period.
 *
 * Posting this APPENDS `stock_movement` rows; it never sets a counter
 * (CLAUDE.md §2.2).
 */
export const recordGoodsReceiptInput = z
  .object({
    ...mutationEnvelope,
    purchaseOrderId: zUuid.optional(),
    supplierId: zUuid,
    /** Where the goods landed. Must be a location that holds stock. */
    locationId: zUuid,
    businessDate: zBusinessDate,
    /** Device time. UNTRUSTED; display and forensics only. */
    receivedAt: z.string().datetime({ offset: true }).optional(),
    supplierDeliveryNoteRef: z.string().max(128).optional(),
    supplierInvoiceRef: z.string().max(128).optional(),
    notes: z.string().max(1000).optional(),
    lines: z.array(goodsReceiptLineInput).min(1).max(500),
  })
  .strict();

/** Read one receipt with its lines. */
export const goodsReceiptInput = z.object({ goodsReceiptId: zUuid }).strict();

/** Ordered versus received, per line, for one order. */
export const purchaseOrderReceiptStatusInput = z
  .object({ purchaseOrderId: zUuid })
  .strict();

// ---------------------------------------------------------------------------
// Logistics — dispatch and delivery status (ADR-0001). NO FLEET.
// ---------------------------------------------------------------------------

/**
 * The documents a delivery can carry. PLATFORM vocabulary, closed, like
 * `stock_movement.sourceKind`.
 *
 * STOCK_TRANSFER is absent because `app.stock_transfer` (04 §4.7.3) does not
 * exist yet, and a value pointing at no table is a value nothing can enforce.
 * It arrives with that table, in the same change.
 */
export const DELIVERY_SOURCE_KINDS = ['PURCHASE_ORDER', 'SALE'] as const;
export type DeliverySourceKind = (typeof DELIVERY_SOURCE_KINDS)[number];

/**
 * The delivery state machine, mirrored for the client. Canonical statement:
 * `app.delivery_legal_transitions()`, enforced by trigger.
 *
 *   PLANNED    -> DISPATCHED | CANCELLED
 *   DISPATCHED -> IN_TRANSIT | DELIVERED | FAILED
 *   IN_TRANSIT -> DELIVERED | FAILED
 *   FAILED     -> DISPATCHED (re-attempted) | CANCELLED
 *   DELIVERED, CANCELLED are terminal — a delivery that can be un-delivered is
 *   a status nobody can rely on when a customer telephones.
 */
export const DELIVERY_STATUSES = [
  'PLANNED',
  'DISPATCHED',
  'IN_TRANSIT',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * The same machine as data, so a CLIENT can offer only the moves that exist.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DATABASE IS STILL CANONICAL. THIS IS NOT A SECOND OPINION.
 * ═══════════════════════════════════════════════════════════════════════════
 * `app.delivery_legal_transitions()` is the statement of record and a trigger
 * enforces it on every UPDATE. A purchase order's client reads its legal next
 * steps from the SERVER (`purchaseOrder.legalNextStatuses`) and should keep
 * doing so; a delivery's cannot, because a status update is a DEVICE-UPLOADABLE
 * operation (see `PROCUREMENT_UPLOADABLE_OPS`) recorded by whoever hears from
 * the driver, and a partitioned device has nobody to ask.
 *
 * A device that offered an illegal move would queue a write the server answers
 * `CONFLICT` to — which the outbox classes RETRYABLE, so it would be retried
 * for ever and surface only as a queue that stopped draining. Offering the
 * right moves is therefore load-bearing, not cosmetic.
 *
 * The duplication is closed the only way duplication can be: the two are
 * compared against each other rather than each against its own idea of the
 * truth. `packages/wire-conformance/test/delivery-client-to-api.test.ts`
 * reads `app.delivery_legal_transitions()` out of a real Postgres and asserts
 * it equals this table exactly, so a migration that changes one and not the
 * other is a red test rather than a wedged outbox in a district town.
 *
 * DELIVERED and CANCELLED are terminal: a delivery that can be un-delivered is
 * a status nobody can rely on when a customer telephones.
 */
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  PLANNED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['IN_TRANSIT', 'DELIVERED', 'FAILED'],
  IN_TRANSIT: ['DELIVERED', 'FAILED'],
  FAILED: ['DISPATCHED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** The moves a delivery in `from` may legally make. Empty means terminal. */
export function legalDeliveryNextStatuses(from: string): readonly DeliveryStatus[] {
  return Object.prototype.hasOwnProperty.call(DELIVERY_TRANSITIONS, from)
    ? DELIVERY_TRANSITIONS[from as DeliveryStatus]
    : [];
}

/**
 * Plan a delivery against a document, with a carrier.
 *
 * `carrierSupplierId` is a SUPPLIER holding a HAULAGE capability. That is the
 * whole of ADR-0001's carrier abstraction: there is no vehicle field here, no
 * driver, no registration number, and if one appears the scope has been left.
 * The server refuses a carrier that holds no HAULAGE-kind capability.
 *
 * `freightCostMinor` is the AGREED freight in minor units. It is what makes
 * distribution cost as a percentage of revenue measurable from the first
 * delivery (ADR-0001, open-questions Q1); the authoritative figure is the
 * haulier's invoice in Phase 3.
 */
export const planDeliveryInput = z
  .object({
    ...mutationEnvelope,
    sourceKind: z.enum(DELIVERY_SOURCE_KINDS),
    sourceId: zUuid,
    carrierSupplierId: zUuid,
    carrierReference: z.string().max(128).optional(),
    fromLocationId: zUuid.optional(),
    /** A customer's site is not a location we own — hence the free text. */
    toLocationId: zUuid.optional(),
    toAddressText: z.string().max(1000).optional(),
    plannedFor: zBusinessDate.optional(),
    /**
     * The trading day this delivery's haulage is attributed to (migration
     * 0010) — the period key `reports.distributionCostRatio` divides by
     * revenue over. Optional on the WIRE and NOT NULL in the database: when
     * it is absent the server falls back to `plannedFor` and then to its OWN
     * transaction date, and records which of the three it used on the row.
     * Never a device clock (03 §3.4.2) — `planDelivery` is an online-only
     * commitment, so the server's date is a real date and not a guess about
     * how long a tablet was in a queue.
     */
    businessDate: zBusinessDate.optional(),
    freightCostMinor: zScaledIntNonNeg.optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();

/**
 * Move a delivery along its state machine.
 *
 * One mutation, for the same reason the purchase order has one: legality lives
 * in the database's transition table and several verbs would be several places
 * to forget it.
 *
 * `occurredAt` is when the thing happened as observed by whoever recorded it.
 * It is stamped onto `dispatched_at` or `delivered_at` and is display
 * information, not an ordering key — causal order is the server-stamped HLC.
 */
export const updateDeliveryStatusInput = z
  .object({
    ...mutationEnvelope,
    deliveryId: zUuid,
    toStatus: z.enum(DELIVERY_STATUSES),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    carrierReference: z.string().max(128).optional(),
    /** Required for FAILED: "it did not arrive" is not a delivery record. */
    reason: z.string().max(1000).optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict()
  .refine((v) => v.toStatus !== 'FAILED' || (v.reason ?? '').trim().length > 0, {
    message: 'a failed delivery requires a reason',
    path: ['reason'],
  });

/** List deliveries, narrowed. `locationIds` NARROWS and never widens scope. */
export const listDeliveriesInput = z
  .object({
    sourceKind: z.enum(DELIVERY_SOURCE_KINDS).optional(),
    sourceId: zUuid.optional(),
    carrierSupplierId: zUuid.optional(),
    statuses: z.array(z.enum(DELIVERY_STATUSES)).min(1).max(6).optional(),
    locationIds: z.array(zUuid).min(1).max(500).optional(),
    from: zBusinessDate.optional(),
    to: zBusinessDate.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: 'from must not be after to',
    path: ['from'],
  });

/** Read one delivery. */
export const deliveryInput = z.object({ deliveryId: zUuid }).strict();

// ---------------------------------------------------------------------------
// The device-uploadable subset — READ THIS BEFORE WIRING A ROUTE
// ---------------------------------------------------------------------------

/**
 * The two Phase 2 operations that MUST become device-uploadable, mapped to the
 * schema each must use, and the reason each one has to work offline.
 *
 * BOTH ARE NOW REGISTERED in `DEVICE_OP_KINDS`/`deviceOpContracts` and
 * dispatched by `apps/api/src/sync.ts` (`goods.record_receipt` ->
 * `receiving.recordReceipt`, `logistics.update_delivery_status` ->
 * `logistics.updateStatus`). The rule below is why they were held back until
 * their handlers existed, and it still governs the NEXT kind: a kind
 * registered there must be dispatched to a real mutation, and
 * `packages/wire-conformance/test/outbox-surface.test.ts` proves per kind that
 * the server really routes it. Registering a kind whose handler does not exist
 * yet would put a green tick on a path that answers UNKNOWN_KIND at a till —
 * the exact class of bug §0 of `docs/phase1-status.md` is a ledger of.
 *
 * SO: THE AGENT THAT LANDS THE HANDLER REGISTERS THE KIND, IN THE SAME CHANGE.
 * Add the entry to `DEVICE_OP_KINDS` (upload.ts) and `deviceOpContracts`
 * (device-ops.ts) using THE SCHEMA OBJECT NAMED HERE — not a copy, not a
 * near-identical redeclaration — wire `DEVICE_OPS` in `apps/api/src/sync.ts`,
 * and write the client-builder-to-API-parser conformance test that
 * `outbox-surface.test.ts` will then demand. `procurement.test.ts` in this
 * package fails if a procurement kind is ever registered against any schema
 * other than the one below.
 *
 * Why these two and not the purchase-order operations: receiving is done in a
 * yard, and yards in Bawku are offline for days — the goods are physically
 * there and refusing to record them teaches staff to write it on paper. A
 * delivery status is updated by whoever hears from the driver, wherever they
 * are. Raising and approving a purchase order, by contrast, is a commitment
 * made against supplier terms and an approval bound that the device may hold a
 * stale copy of; it stays online until somebody has a concrete reason it must
 * not.
 */
export const PROCUREMENT_UPLOADABLE_OPS = {
  'goods.record_receipt': recordGoodsReceiptInput,
  'logistics.update_delivery_status': updateDeliveryStatusInput,
} as const;

export type ProcurementUploadableOpKind = keyof typeof PROCUREMENT_UPLOADABLE_OPS;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpsertSupplierInput = z.input<typeof upsertSupplierInput>;
export type UpsertSupplierParsed = z.output<typeof upsertSupplierInput>;
export type UpsertSupplierProductInput = z.input<typeof upsertSupplierProductInput>;
export type UpsertSupplierProductParsed = z.output<typeof upsertSupplierProductInput>;
export type ListSuppliersInput = z.input<typeof listSuppliersInput>;
export type SuppliersForProductInput = z.input<typeof suppliersForProductInput>;

export type PurchaseOrderLineInput = z.input<typeof purchaseOrderLineInput>;
export type PurchaseOrderLineParsed = z.output<typeof purchaseOrderLineInput>;
export type CreatePurchaseOrderInput = z.input<typeof createPurchaseOrderInput>;
export type CreatePurchaseOrderParsed = z.output<typeof createPurchaseOrderInput>;
export type UpdatePurchaseOrderInput = z.input<typeof updatePurchaseOrderInput>;
export type UpdatePurchaseOrderParsed = z.output<typeof updatePurchaseOrderInput>;
export type ChangePurchaseOrderStatusInput = z.input<typeof changePurchaseOrderStatusInput>;
export type ChangePurchaseOrderStatusParsed = z.output<typeof changePurchaseOrderStatusInput>;
export type ListPurchaseOrdersInput = z.input<typeof listPurchaseOrdersInput>;

export type GoodsReceiptLineInput = z.input<typeof goodsReceiptLineInput>;
export type GoodsReceiptLineParsed = z.output<typeof goodsReceiptLineInput>;
export type RecordGoodsReceiptInput = z.input<typeof recordGoodsReceiptInput>;
export type RecordGoodsReceiptParsed = z.output<typeof recordGoodsReceiptInput>;

export type PlanDeliveryInput = z.input<typeof planDeliveryInput>;
export type PlanDeliveryParsed = z.output<typeof planDeliveryInput>;
export type UpdateDeliveryStatusInput = z.input<typeof updateDeliveryStatusInput>;
export type UpdateDeliveryStatusParsed = z.output<typeof updateDeliveryStatusInput>;
export type ListDeliveriesInput = z.input<typeof listDeliveriesInput>;
