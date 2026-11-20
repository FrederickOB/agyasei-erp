/**
 * The database surface the API needs, expressed as interfaces so the same
 * routers run against the production pool wrapper and the hermetic PGlite
 * harness (`@erp/db/testing` — whose TestDb satisfies TenantRunner directly).
 *
 * TenantRunner.withTenant is the ONLY way application code touches tenant
 * data: one transaction, `SET LOCAL ROLE app_user`, and
 * `set_config('app.tenant_id', <tid from the VERIFIED TOKEN>, true)` — so RLS
 * genuinely applies to every statement (ADR-0005; 02-security). The tenant id
 * parameter is supplied by the auth context from the JWT `tid` claim and
 * NEVER from any client payload.
 */

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface TenantRunner {
  withTenant<T>(tenantId: string, fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Operator-plane access (platform.* writes: tenant lifecycle). Application
 * roles cannot write platform tables; provisioning goes through this seam,
 * which in production is a separate operator credential — never app_user.
 */
export interface AdminRunner {
  run<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Adapt the @erp/db test harness (or any object with asAdmin) to AdminRunner. */
export function adminRunnerFrom(db: {
  asAdmin<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}): AdminRunner {
  return { run: (fn) => db.asAdmin(fn) };
}

/**
 * The ONE path that runs as app_user with NO tenant context (02-security §2.2;
 * migration 0023). It exists for exactly two lookups that happen before any
 * token exists — an enrolment code, and a device key — and it can reach
 * nothing else: with no `app.tenant_id` GUC every RLS predicate is NULL, and
 * the two route tables are reachable only through their SECURITY DEFINER
 * functions. Never use it to touch an `app` table.
 */
export interface PreTenantRunner {
  withoutTenant<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Adapt the @erp/db test harness to PreTenantRunner. */
export function preTenantRunnerFrom(db: {
  asAppUserWithoutTenant<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}): PreTenantRunner {
  return { withoutTenant: (fn) => db.asAppUserWithoutTenant(fn) };
}
