/**
 * `@erp/contracts` — the ONE client↔server wire contract.
 *
 * Imported by `apps/api` (which parses) and `apps/web` (which builds), so a
 * disagreement between the two is a compile error rather than a BAD_REQUEST
 * from a till with no connectivity and no developer nearby.
 *
 * Rules for anything added here:
 *
 * 1. **zod only.** This package is bundled into the browser build of the PWA.
 *    No `node:*`, no `pg`, no `fastify`, no `@erp/db`. If a definition cannot
 *    live under that constraint, it is not a wire contract.
 * 2. **Money and quantity cross as decimal STRINGS** of scaled integer units,
 *    transformed to `bigint` at the boundary (CLAUDE.md §2.3, ADR-0004). A
 *    JSON number is a float64 in every consumer and never carries a magnitude.
 * 3. **Every input object is `.strict()`.** Unknown keys are rejected, not
 *    stripped — that is what stops a client asserting a price the server is
 *    the authority for, and what makes a forged `tenant_id` fail loudly.
 * 4. **No tenant identity, ever.** `tenant_id` comes from the verified token,
 *    server-side, on every write (CLAUDE.md §2.1).
 * 5. **No tenant #1 vocabulary.** No location kinds, tax codes, price-list
 *    codes, role names or SKU shapes as enums or constants (CLAUDE.md §2.9).
 *    Those are tenant data, not platform contract.
 */
export {
  HLC_WIRE_RE,
  mutationEnvelope,
  mutationEnvelopeSchema,
  wire,
  zBusinessDate,
  zClaimedHlc,
  zScaledInt,
  zScaledIntNonNeg,
  zScaledIntPos,
  zUuid,
  type MutationEnvelope,
} from './wire.js';

export {
  comparePriceCheck,
  createSaleInput,
  saleLineInput,
  type CreateSaleInput,
  type CreateSaleParsed,
  type PriceCheck,
  type SaleLineInput,
  type SaleLineParsed,
} from './sale.js';

export {
  DIRECT_MOVEMENT_KINDS,
  recordMovementInput,
  setReorderPointInput,
  type DirectMovementKind,
  type RecordMovementInput,
  type RecordMovementParsed,
  type SetReorderPointInput,
  type SetReorderPointParsed,
} from './inventory.js';

export {
  cashPositionReportInput,
  distributionCostReportInput,
  inventoryDaysReportInput,
  lowStockInput,
  salesReportInput,
  stockReportInput,
  type LowStockInput,
  type LowStockParsed,
  type SalesReportInput,
  type SalesReportParsed,
  type StockReportInput,
  type StockReportParsed,
} from './reports.js';

export {
  CREDIT_ACCOUNT_STATUSES,
  CREDIT_ENTRY_KINDS,
  accountForCustomerInput,
  openAccountInput,
  recordEntryInput,
  setLimitInput,
  setStatusInput,
  type AccountForCustomerInput,
  type CreditAccountStatus,
  type CreditEntryKind,
  type OpenAccountInput,
  type OpenAccountParsed,
  type RecordEntryInput,
  type RecordEntryParsed,
  type SetLimitInput,
  type SetLimitParsed,
  type SetStatusInput,
  type SetStatusParsed,
} from './credit.js';

export {
  blockReport,
  syncBlockInput,
  zSeqNumber,
  type BlockReport,
  type SyncBlockInput,
  type SyncBlockParsed,
} from './sequence.js';

export {
  DELIVERY_SOURCE_KINDS,
  DELIVERY_STATUSES,
  DELIVERY_TRANSITIONS,
  PROCUREMENT_UPLOADABLE_OPS,
  PURCHASE_ORDER_STATUSES,
  SUPPLIER_CAPABILITY_KINDS,
  changePurchaseOrderStatusInput,
  createPurchaseOrderInput,
  deliveryInput,
  goodsReceiptInput,
  goodsReceiptLineInput,
  legalDeliveryNextStatuses,
  listDeliveriesInput,
  listPurchaseOrdersInput,
  listSuppliersInput,
  planDeliveryInput,
  purchaseOrderInput,
  purchaseOrderLineInput,
  purchaseOrderReceiptStatusInput,
  recordGoodsReceiptInput,
  suppliersForProductInput,
  updateDeliveryStatusInput,
  updatePurchaseOrderInput,
  upsertSupplierInput,
  upsertSupplierProductInput,
  type ChangePurchaseOrderStatusInput,
  type ChangePurchaseOrderStatusParsed,
  type CreatePurchaseOrderInput,
  type CreatePurchaseOrderParsed,
  type DeliverySourceKind,
  type DeliveryStatus,
  type GoodsReceiptLineInput,
  type GoodsReceiptLineParsed,
  type ListDeliveriesInput,
  type ListPurchaseOrdersInput,
  type ListSuppliersInput,
  type PlanDeliveryInput,
  type PlanDeliveryParsed,
  type ProcurementUploadableOpKind,
  type PurchaseOrderLineInput,
  type PurchaseOrderLineParsed,
  type PurchaseOrderStatus,
  type RecordGoodsReceiptInput,
  type RecordGoodsReceiptParsed,
  type SupplierCapabilityKind,
  type SuppliersForProductInput,
  type UpdateDeliveryStatusInput,
  type UpdateDeliveryStatusParsed,
  type UpdatePurchaseOrderInput,
  type UpdatePurchaseOrderParsed,
  type UpsertSupplierInput,
  type UpsertSupplierParsed,
  type UpsertSupplierProductInput,
  type UpsertSupplierProductParsed,
} from './procurement.js';

export {
  DEVICE_OP_KINDS,
  MAX_UPLOAD_BATCH,
  uploadBodySchema,
  uploadOpSchema,
  type DeviceOpKind,
  type UploadAck,
  type UploadAckStatus,
  type UploadBody,
  type UploadOp,
  type UploadResponseBody,
} from './upload.js';

export {
  contractFor,
  deviceOpContracts,
  type DeviceOpContracts,
} from './device-ops.js';

export {
  syncTokenResponse,
  type SyncTokenResponse,
} from './sync-token.js';
