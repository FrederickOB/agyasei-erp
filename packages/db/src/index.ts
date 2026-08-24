/**
 * @erp/db — schema source of truth, tenant machinery, seeds and the
 * isolation test harness.
 *
 * The hand-written SQL in ./migrations is THE schema. src/schema.ts mirrors
 * it for typed queries (Drizzle mirrors, never generates). Everything
 * tenant-owned goes through tenantTable(), which makes omitting tenant_id
 * structurally impossible (CLAUDE.md §2.1, ADR-0005).
 */
export { migrate, MIGRATIONS_DIR, type SqlClient, type MigrateResult } from './migrate.js';
export { tenantTable, registeredAppTableNames, WRITE_ID_EXEMPT, appSchema, platformSchema } from './tenant-table.js';
export * as schema from './schema.js';
export { createHlcClock, hlcNodeFromName, randomHlcNode, HLC_RE, type HlcClock } from './hlc.js';
export { uuidv7, deterministicUuid, sha256Hex } from './ids.js';
export {
  PERMISSION_CODES,
  BRIEF_RESTRICTED_PERMISSIONS,
  effectivePermissions,
  hasPermissionAt,
  hasPermissionAnywhere,
  locationsFor,
  permissionCodesAt,
  boundAt,
  authorize,
  mergeBounds,
  catalogueDrift,
  type PermissionCode,
  type PermissionQueryable,
  type Bound,
  type MaybeBound,
  type EffectivePermissionRow,
  type EffectivePermissions,
  type ResolvedGrant,
  type Decision,
} from './permissions.js';

export {
  MissingMappingError,
  mappingGaps,
  resolveAccount,
  resolveAccounts,
  type CompletenessGap,
  type MappingScope,
  type ResolvedAccount,
} from './posting/mapping.js';

export {
  UnbalancedRuleError,
  assertBalances,
  clearingNets,
  paymentEntry,
  saleEntry,
  stockAdjustmentEntry,
  transferEntry,
  type PaymentDocument,
  type PostingRole,
  type ProposedEntry,
  type ProposedLine,
  type SaleDocument,
  type SaleTaxComponent,
  type StockAdjustmentDocument,
  type TransferDocument,
} from './posting/rules.js';

export {
  POSTING_ERROR,
  postDocument,
  type PostOptions,
  type PostResult,
  type PostingRunner,
} from './posting/engine.js';
