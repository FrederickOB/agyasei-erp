/**
 * @erp/ops — production operations. See docs/production-runbook.md.
 */
export {
  createPgOps,
  pgPoolConfig,
  redactUrl,
  runnerIdentity,
  buildIdentity,
  listTenantIds,
  type LockOutcome,
  type LockProvider,
  type OpsDb,
  type PgConnectOptions,
  type PgOps,
  type Queryable,
  type SslMode,
  type TenantRunner,
} from './db.js';
export {
  listMigrationFiles,
  migrationState,
  migrateProduction,
  isLockTimeout,
  MigrationRefused,
  type MigrationFile,
  type MigrationState,
  type MigrateProductionOptions,
  type MigrateProductionResult,
} from './migrations.js';
export {
  POWERSYNC_PUBLICATION,
  POWERSYNC_PUBLICATION_TABLES,
  convergeGrants,
  convergePublication,
  grantsSql,
  type PublicationResult,
} from './converge.js';
export { digestTables, digestSql, foldLanes, listTenantTables, MONEY_PATH_TABLES, normalizeRenderingSettings, type TableDigest } from './digest.js';
export { catalogueViolations } from './catalogue.js';
export {
  reconcileAlerts,
  markSent,
  renderAlertLine,
  webhookSink,
  logSink,
  type AlertNotification,
  type AlertSignal,
  type AlertSink,
  type Severity,
} from './alerts.js';
export { jsonLogger, safeError, silentLogger, type Logger, type LogFields } from './log.js';
export {
  defineJob,
  forEachTenant,
  JobRegistry,
  type JobContext,
  type JobDefinition,
  type JobResult,
  type SummaryValue,
} from './jobs/registry.js';
export { runJob, runLoop, dueJobs, urlHeartbeat, FAILURE_RETRY_SECONDS, type RunnerDeps, type RunOutcome, type RunStatus } from './jobs/runner.js';
export {
  builtinJobs,
  postingSweepJob,
  creditSyncScopeJob,
  tableDigestJob,
  lostWriteControlJob,
  syncHealthJob,
  POSTING_SWEEP_ACTOR,
  POSTING_RULE_VERSION,
  type BuiltinJobsConfig,
} from './jobs/builtin.js';
export {
  collectSignals,
  evaluateSignals,
  type SignalSnapshot,
  type Thresholds,
  type DeviceActivity,
  type ReviewQueueState,
  type PostingExceptionState,
  type ReplicationSlotState,
} from './monitoring/signals.js';
export { receiptContinuity, type ContinuityFinding, type ContinuityResult } from './monitoring/receipt-continuity.js';
export { isTrading, parseTradingWindow, safeTimezone, tradingMsBetween, type TradingWindow } from './monitoring/trading-hours.js';
export {
  buildManifest,
  compareManifests,
  tenantFigures,
  trialBalanceLines,
  MANIFEST_FORMAT,
  type Manifest,
  type TenantManifest,
  type DrillComparison,
} from './backup/manifest.js';
export { logicalDump, sha256File, BACKUP_FORMAT, DUMP_SCHEMAS, type BackupRecord, type DumpResult } from './backup/dump.js';
export { restoreDrill, recordDrill, type DrillOptions, type DrillReport } from './backup/drill.js';
export { verifyProvisioning, renderChecks, type CheckResult, type CheckStatus, type VerifyInputs } from './verify.js';
export {
  ConfigError,
  parseEnv,
  sslFromEnv,
  defaultSslMode,
  migrateEnvSchema,
  jobsEnvSchema,
  builtinJobsConfig,
  type JobsEnv,
} from './config.js';
