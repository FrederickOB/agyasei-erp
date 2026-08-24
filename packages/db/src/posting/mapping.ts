/**
 * RESOLVING A POSTING ROLE TO A TENANT'S OWN ACCOUNT.
 *
 * A posting rule is platform code and speaks in ROLES — a cash sale debits
 * `TILL_CASH` and credits `SALES_REVENUE`, for every tenant in every
 * jurisdiction. What a tenant configures is which of ITS accounts each role
 * means (05 §5.6.1). This module is the boundary between those two.
 *
 * ── MOST-SPECIFIC-FIRST ───────────────────────────────────────────────────
 *   product_category  ->  location  ->  tenant default
 *
 * That covers "revenue split by product category" and "a different bank
 * account per region" without a rule editor, which is the whole point: a
 * tenant-editable rule engine is the fastest way to let a non-accountant
 * produce a ledger that books revenue to a liability.
 *
 * ── A MISSING MAPPING IS A HARD FAILURE, NEVER A SUSPENSE ACCOUNT ─────────
 * Falling back to a suspense account turns a configuration error that somebody
 * can fix in a minute into a balance nobody can explain in a year. `resolve`
 * throws `MissingMappingError`, and the posting engine's contract with that is
 * specific and load-bearing: it opens a `posting_exception` and LEAVES THE
 * SETTLED DOCUMENT ALONE. Acceptance and posting are separate; a posting
 * failure never rejects a sale whose goods have left the yard (05 §5.6.1).
 *
 * ── EVERY LOOKUP IS DATED ─────────────────────────────────────────────────
 * By the DOCUMENT's business date, never by today. A sale that arrives after
 * eight days offline must resolve against the mapping that was in force when
 * it happened — the same rule the tax pack follows (ADR-0007), for the same
 * reason: re-pricing history against today's configuration silently restates
 * the past.
 */
import type { Queryable } from '../testing/harness.js';

export interface MappingScope {
  /** The location whose books this line belongs to. */
  readonly locationId: string;
  /** Optional narrower scope — a product category, where the rule has one. */
  readonly productCategoryId?: string | undefined;
}

export interface ResolvedAccount {
  readonly postingRole: string;
  readonly accountId: string;
  /** Which scope actually answered. Recorded so a surprise is diagnosable. */
  readonly scopeKind: 'tenant' | 'location' | 'product_category';
  readonly mappingSetVersion: number;
}

/**
 * No mapping in force for this role, at this scope, on this date.
 *
 * Carries everything the exception row needs, because the caller that catches
 * this is opening one and must not have to re-derive the context.
 */
export class MissingMappingError extends Error {
  readonly code = 'GL_MAPPING_MISSING';
  constructor(
    readonly postingRole: string,
    readonly scope: MappingScope,
    readonly businessDate: string,
  ) {
    super(
      `no account is mapped for posting role ${postingRole} at location ${scope.locationId}` +
        `${scope.productCategoryId === undefined ? '' : ` (category ${scope.productCategoryId})`}` +
        ` on ${businessDate}`,
    );
    this.name = 'MissingMappingError';
  }
}

/**
 * ONE query, ordered by specificity, taking the first row.
 *
 * Deliberately not three round trips with fallbacks in TypeScript: the
 * ordering IS the rule, and expressing it in SQL keeps it in one place where
 * the index (`gl_account_mapping_resolve`) can serve it. `effective_from
 * desc` breaks a tie between two versions of the same scope in favour of the
 * later one, which is what "effective-dated" means.
 */
const RESOLVE_SQL = `
  select account_id, scope_kind, mapping_set_version
    from app.gl_account_mapping
   where posting_role = $1
     and effective_from <= $2::date
     and (effective_to is null or effective_to > $2::date)
     and (
       (scope_kind = 'product_category' and scope_id = $3::uuid)
       or (scope_kind = 'location' and scope_id = $4::uuid)
       or scope_kind = 'tenant'
     )
   order by case scope_kind
              when 'product_category' then 0
              when 'location'         then 1
              else 2
            end,
            effective_from desc
   limit 1
`;

export async function resolveAccount(
  tx: Queryable,
  postingRole: string,
  scope: MappingScope,
  businessDate: string,
): Promise<ResolvedAccount> {
  const res = await tx.query<{
    account_id: string;
    scope_kind: 'tenant' | 'location' | 'product_category';
    mapping_set_version: number;
  }>(RESOLVE_SQL, [
    postingRole,
    businessDate,
    scope.productCategoryId ?? null,
    scope.locationId,
  ]);
  const row = res.rows[0];
  if (row === undefined) throw new MissingMappingError(postingRole, scope, businessDate);
  return {
    postingRole,
    accountId: row.account_id,
    scopeKind: row.scope_kind,
    mappingSetVersion: row.mapping_set_version,
  };
}

/**
 * Resolve every role a rule needs, and report ALL the missing ones at once.
 *
 * A rule that failed on the first missing role would send an operator round
 * the loop once per role — fix COGS, retry, discover INVENTORY is missing,
 * fix it, retry. The exception is worth more if it names the whole set.
 */
export async function resolveAccounts(
  tx: Queryable,
  roles: readonly { role: string; scope: MappingScope }[],
  businessDate: string,
): Promise<{ resolved: Map<string, ResolvedAccount>; missing: MissingMappingError[] }> {
  const resolved = new Map<string, ResolvedAccount>();
  const missing: MissingMappingError[] = [];
  for (const { role, scope } of roles) {
    try {
      resolved.set(role, await resolveAccount(tx, role, scope, businessDate));
    } catch (err) {
      if (err instanceof MissingMappingError) missing.push(err);
      else throw err;
    }
  }
  return { resolved, missing };
}

export interface CompletenessGap {
  readonly postingRole: string;
  readonly requiredAccountType: string;
  readonly requiredWhenFeature: string | null;
}

/**
 * THE ONBOARDING GATE: which required roles this tenant has not mapped.
 *
 * Scoped to the roles the tenant's ENABLED FEATURES require. A cash-only
 * tenant is never asked to map `AR_TRADE`, and a tenant with no credit product
 * is never asked to map the facility-fee accounts — an unconditional check did
 * exactly that, which is why `required_when_feature` exists.
 *
 * This must pass before a tenant's first posting. It is deliberately a
 * QUESTION this module answers and not a thing it enforces: enforcement is the
 * provisioning path's, and it belongs beside the §2.8 accountant sign-off
 * rather than buried in a resolver.
 */
export async function mappingGaps(
  tx: Queryable,
  features: readonly string[],
  businessDate: string,
): Promise<CompletenessGap[]> {
  const res = await tx.query<{
    posting_role: string;
    required_account_type: string;
    required_when_feature: string | null;
  }>(
    `select c.posting_role, c.required_account_type, c.required_when_feature
       from platform.posting_role_catalog c
      where (c.required_when_feature is null or c.required_when_feature = any($1::text[]))
        and not exists (
          select 1 from app.gl_account_mapping m
           where m.posting_role = c.posting_role
             and m.effective_from <= $2::date
             and (m.effective_to is null or m.effective_to > $2::date)
        )
      order by c.posting_role`,
    [[...features], businessDate],
  );
  return res.rows.map((r) => ({
    postingRole: r.posting_role,
    requiredAccountType: r.required_account_type,
    requiredWhenFeature: r.required_when_feature,
  }));
}
