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
  MAX_TENDER_LINES,
  TENDER_SETTLEMENTS,
  comparePriceCheck,
  createSaleInput,
  saleLineInput,
  saleTenderInput,
  type CreateSaleInput,
  type CreateSaleParsed,
  type PriceCheck,
  type SaleLineInput,
  type SaleLineParsed,
  type SaleTenderInput,
  type SaleTenderParsed,
  type TenderSettlement,
} from './sale.js';

export {
  CASH_DRAWERS,
  CASH_SESSION_DATE_TOLERANCE_DAYS,
  cashSessionOpenCheckInput,
  closeCashSessionInput,
  openCashSessionInput,
  type CashDrawer,
  type CashSessionOpenCheck,
  type CashSessionOpenCheckInput,
  type CloseCashSessionInput,
  type CloseCashSessionParsed,
  type OpenCashSessionInput,
  type OpenCashSessionParsed,
} from './cash-session.js';

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
  MAX_RETURN_LINES,
  RETURN_DISPOSITIONS,
  SALE_RETURN_KINDS,
  createSaleReturnInput,
  saleReturnLineInput,
  saleReturnRefundInput,
  type CreateSaleReturnInput,
  type CreateSaleReturnParsed,
  type ReturnDisposition,
  type SaleReturnKind,
  type SaleReturnLineInput,
} from './sale-return.js';

export {
  OPENING_ROW_ISSUES,
  OPENING_STOCK_MAX_CHARS,
  OPENING_STOCK_MAX_ROWS,
  canonicalOpeningRows,
  commitOpeningStockInput,
  parseOpeningStockCsv,
  parseScaledDecimal,
  previewOpeningStockInput,
  splitCsvLine,
  type CommitOpeningStockInput,
  type OpeningRowIssue,
  type ParsedOpeningFile,
  type ParsedOpeningRow,
  type PreviewOpeningStockInput,
} from './opening-stock.js';

export {
  cashPositionReportInput,
  distributionCostReportInput,
  inventoryDaysReportInput,
  lowStockInput,
  salesByDayReportInput,
  salesReportInput,
  stockReportInput,
  type LowStockInput,
  type LowStockParsed,
  type SalesByDayReportInput,
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

export {
  REVIEW_CHOICES,
  REVIEW_STATUSES,
  claimReviewInput,
  getReviewInput,
  listReviewsInput,
  resolveReviewInput,
  type ClaimReviewInput,
  type ClaimReviewParsed,
  type GetReviewInput,
  type ListReviewsInput,
  type ResolveReviewInput,
  type ResolveReviewParsed,
  type ReviewChoice,
  type ReviewStatus,
} from './review.js';

export {
  ACCOUNT_TYPES,
  listPostingExceptionsInput,
  statementQueryInput,
  type AccountTypeWire,
  type ListPostingExceptionsInput,
  type StatementQueryInput,
} from './ledger.js';

export {
  DEVICE_FORM_FACTORS,
  DEVICE_RETIRED_REASONS,
  LEASE_DEFAULT_FULL_S,
  LEASE_DEFAULT_GRACE_S,
  LEASE_MAX_FULL_S,
  OFFLINE_MODES,
  authConfigResponse,
  deviceRevokedBody,
  drainAbandonedRequest,
  drainAck,
  drainResponse,
  enrolRequest,
  enrolResponse,
  leaseClaims,
  leaseEnvelope,
  publicEcJwk,
  refreshRequest,
  sessionRequest,
  sessionResponse,
  type AuthConfigResponse,
  type DeviceFormFactor,
  type DeviceRetiredReason,
  type DeviceRevokedBody,
  type DrainResponse,
  type EnrolRequest,
  type EnrolResponse,
  type LeaseClaims,
  type LeaseEnvelope,
  type OfflineMode,
  type PublicEcJwk,
  type RefreshRequest,
  type SessionRequest,
  type SessionResponse,
} from './identity.js';

export {
  USER_STATUSES,
  assignRoleInput,
  createRoleInput,
  createUserInput,
  deleteRoleInput,
  endAssignmentInput,
  issueEnrolmentCodeInput,
  revokeDeviceInput,
  roleBound,
  rolePermissionInput,
  setDeviceScopeInput,
  setDeviceStatusInput,
  setUserStatusInput,
  updateRoleInput,
  updateUserInput,
  type AssignRoleInput,
  type CreateRoleInput,
  type CreateUserInput,
  type DeleteRoleInput,
  type EndAssignmentInput,
  type IssueEnrolmentCodeInput,
  type RevokeDeviceInput,
  type SetDeviceScopeInput,
  type SetDeviceStatusInput,
  type SetUserStatusInput,
  type UpdateRoleInput,
  type UpdateUserInput,
} from './admin.js';
