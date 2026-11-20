/**
 * Environment for the operations entry points (migrate, jobs, ops CLI).
 * zod-validated: a misconfigured worker refuses to start and says which
 * variable is wrong — without ever echoing a value, because half of these
 * are credentials.
 */
import { z } from 'zod';
import type { BuiltinJobsConfig } from './jobs/builtin.js';
import { parseTradingWindow } from './monitoring/trading-hours.js';
import type { SslMode } from './db.js';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const pgUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// or postgresql:// URL');

const sslMode = z.enum(['disable', 'require', 'verify-full']);

/** Production-safe default: verify-full unless explicitly told otherwise. */
export function defaultSslMode(env: NodeJS.ProcessEnv): SslMode {
  return env['NODE_ENV'] === 'production' ? 'verify-full' : 'disable';
}

export const dbEnvSchema = z.object({
  DATABASE_SSL_MODE: sslMode.optional(),
  /** PEM text of the database CA (Supabase: Database settings → SSL certificate). */
  DATABASE_CA_CERT: z.string().optional(),
});

export function sslFromEnv(env: NodeJS.ProcessEnv): { sslMode: SslMode; caCert: string | undefined } {
  const parsed = dbEnvSchema.parse(env);
  const mode = parsed.DATABASE_SSL_MODE ?? defaultSslMode(env);
  if (env['NODE_ENV'] === 'production' && mode === 'disable') {
    throw new ConfigError(['DATABASE_SSL_MODE=disable is refused in production']);
  }
  // Fly secrets are single-line friendly when the PEM's newlines are escaped.
  const ca = parsed.DATABASE_CA_CERT?.replace(/\\n/g, '\n');
  return { sslMode: mode, caCert: ca && ca.trim().length > 0 ? ca : undefined };
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`configuration invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Parse, reporting variable NAMES and rules only — never the offending value. */
export function parseEnv<S extends z.ZodTypeAny>(schema: S, env: NodeJS.ProcessEnv): z.infer<S> {
  const r = schema.safeParse(env);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return r.data;
}

export const migrateEnvSchema = z.object({
  /** Direct (or session-mode) connection as the migrator. Never the transaction pooler. */
  MIGRATE_DATABASE_URL: pgUrl,
  ERP_MIGRATE_ALLOW_DB_AHEAD: bool.default('false'),
  MIGRATIONS_DIR: z.string().optional(),
  ERP_BUILD: z.string().optional(),
});

export const jobsEnvSchema = z.object({
  /** erp_jobs credentials. Session pooler or direct; transaction pooler also works (locks are xact-scoped). */
  JOBS_DATABASE_URL: pgUrl,
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  /** Dead-man's switch pinged after every scheduler tick (healthchecks.io / Better Stack heartbeat). */
  JOBS_HEARTBEAT_URL: z.string().url().optional(),
  ALERT_ENVIRONMENT: z.string().default('production'),
  ALERT_REPEAT_HOURS: z.coerce.number().positive().default(4),
  JOBS_TICK_SECONDS: z.coerce.number().int().min(10).default(60),

  // §9.4 thresholds. Platform defaults; the per-location expectation table
  // that should replace the trading window does not exist yet.
  TRADING_DAYS: z.string().default('1-6'),
  TRADING_OPEN: z.string().default('07:00'),
  TRADING_CLOSE: z.string().default('19:00'),
  DARK_DEVICE_AFTER_HOURS: z.coerce.number().positive().default(4),
  DEVICE_LOOKBACK_DAYS: z.coerce.number().int().positive().default(35),
  REVIEW_OVERDUE_HOURS: z.coerce.number().positive().default(24),
  REVIEW_DEPTH_THRESHOLD: z.coerce.number().int().positive().default(25),
  POSTING_EXCEPTION_AGE_HOURS: z.coerce.number().positive().default(24),
  SLOT_RETAINED_GIB: z.coerce.number().positive().default(2),
  EXPECT_LOGICAL_SLOT: bool.default('true'),
  DRILL_MAX_AGE_DAYS: z.coerce.number().int().positive().default(100),
  SCRATCH_MAX_AGE_HOURS: z.coerce.number().positive().default(72),
  JOB_STALE_FACTOR: z.coerce.number().positive().default(3),
  DIGEST_RETENTION_DAYS: z.coerce.number().int().positive().default(35),
  LOST_WRITE_LOOKBACK_DAYS: z.coerce.number().int().positive().default(35),
  ERP_BUILD: z.string().optional(),
});

export type JobsEnv = z.infer<typeof jobsEnvSchema>;

export function builtinJobsConfig(env: JobsEnv): BuiltinJobsConfig {
  const H = 3_600_000;
  return {
    thresholds: {
      tradingWindow: parseTradingWindow(env.TRADING_DAYS, env.TRADING_OPEN, env.TRADING_CLOSE),
      darkAfterMs: env.DARK_DEVICE_AFTER_HOURS * H,
      reviewOverdueMs: env.REVIEW_OVERDUE_HOURS * H,
      reviewDepth: env.REVIEW_DEPTH_THRESHOLD,
      postingExceptionAgeMs: env.POSTING_EXCEPTION_AGE_HOURS * H,
      slotRetainedBytes: BigInt(Math.round(env.SLOT_RETAINED_GIB * 1024)) * 1048576n,
      expectLogicalSlot: env.EXPECT_LOGICAL_SLOT,
      drillMaxAgeDays: env.DRILL_MAX_AGE_DAYS,
      scratchMaxAgeHours: env.SCRATCH_MAX_AGE_HOURS,
      jobStaleFactor: env.JOB_STALE_FACTOR,
    },
    deviceLookbackDays: env.DEVICE_LOOKBACK_DAYS,
    digestRetentionDays: env.DIGEST_RETENTION_DAYS,
    lostWriteLookbackDays: env.LOST_WRITE_LOOKBACK_DAYS,
  };
}
