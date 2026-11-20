/**
 * Production configuration for the API, validated with zod at start-up.
 *
 * A missing or unsafe value stops the process before it listens, with the
 * VARIABLE NAME and the rule — never the value, because most of these are
 * credentials and start-up errors end up in log aggregators.
 *
 * The auth secrets here are INTERIM. The identity work package replaces the
 * HS256 shared secret with signing keys and an OIDC relying party (ADR-0003
 * A4); its variables are listed as placeholders in
 * docs/production-runbook.md. Until then the rules below at least refuse the
 * dev default and anything short enough to guess.
 */
import { z } from 'zod';
import { ConfigError, parseEnv, sslFromEnv, type SslMode } from '@erp/ops';

const DEV_SECRET = 'dev-secret-change-me';

const csv = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const pgUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// or postgresql:// URL');

const secret = z
  .string()
  .min(32, 'must be at least 32 characters (generate with: openssl rand -base64 48)')
  .refine((v) => v !== DEV_SECRET, 'is the development default');

const apiEnvSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),

  /** erp_api through the TRANSACTION pooler (Supavisor :6543). */
  DATABASE_URL: pgUrl,
  /** erp_operator — set only while an operator needs tenant lifecycle; unset disables the operator plane. */
  OPERATOR_DATABASE_URL: pgUrl.optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // No client-side statement timeout: it travels as a connection STARTUP
  // parameter, which transaction poolers commonly refuse. The bound is the
  // role's own default (infra/supabase/roles.sql: erp_api 30s), applied by
  // the server whatever sits in between.

  AUTH_JWT_SECRET: secret,
  POWERSYNC_JWT_SECRET: secret,
  POWERSYNC_URL: z.string().url(),
  POWERSYNC_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),

  CORS_ORIGINS: z.string().min(1).transform(csv),

  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
  /** POST /sync/upload: up to 500 ops per batch (MAX_UPLOAD_BATCH). */
  UPLOAD_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(8_388_608),

  RATE_LIMIT_PATHS: z.string().default('/sync/token,/auth,/enrol').transform(csv),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(20_000),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  MIGRATIONS_DIR: z.string().optional(),
  ERP_BUILD: z.string().optional(),
});

export type ApiConfig = z.infer<typeof apiEnvSchema> & {
  readonly sslMode: SslMode;
  readonly caCert: string | undefined;
};

export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const cfg = parseEnv(apiEnvSchema, env);
  const problems: string[] = [];
  const prod = cfg.NODE_ENV === 'production';

  if (cfg.AUTH_JWT_SECRET === cfg.POWERSYNC_JWT_SECRET) {
    problems.push('POWERSYNC_JWT_SECRET: must differ from AUTH_JWT_SECRET (a sync token must not verify as an API session)');
  }
  for (const origin of cfg.CORS_ORIGINS) {
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      problems.push(`CORS_ORIGINS: an entry is not a URL`);
      continue;
    }
    if (origin === '*' || u.origin !== origin) problems.push('CORS_ORIGINS: entries must be bare origins (scheme://host[:port]), never * or a path');
    if (prod && u.protocol !== 'https:') problems.push('CORS_ORIGINS: production origins must be https');
  }
  if (prod && new URL(cfg.POWERSYNC_URL).protocol !== 'https:') {
    problems.push('POWERSYNC_URL: must be https in production');
  }
  let ssl: { sslMode: SslMode; caCert: string | undefined };
  try {
    ssl = sslFromEnv(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      problems.push(...err.problems);
      ssl = { sslMode: 'disable', caCert: undefined };
    } else throw err;
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return { ...cfg, ...ssl };
}
