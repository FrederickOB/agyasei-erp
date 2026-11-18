/**
 * Permission codes and effective-permission RESOLUTION.
 *
 * (docs/architecture/sections/02-security-and-access-control.md §2.4/§2.5;
 *  CLAUDE.md §2.6.)
 *
 * Three rules this module exists to make structural:
 *
 * 1. **A permission is a capability AT A PLACE.** Never a bare capability.
 *    Every answer here is keyed on (code, locationId), because a user who
 *    holds `stock.adjust` at the Techiman yard must not silently hold it at
 *    Wenchi. That is the obvious trap in a multi-role, multi-scope model and
 *    it is closed by construction: the resolution view expands each grant
 *    over its scope subtree and nothing collapses the location away.
 *
 * 2. **Evaluation is additive and there are no deny rules.** The result is a
 *    union of grants; the most permissive bound wins. Deny rules make
 *    evaluation order-dependent and turn "why can this person not do X?" into
 *    a debugging session. A permission a role should not have is ABSENT.
 *
 * 3. **Nothing branches on a role NAME.** `app.role.name` is the tenant's
 *    word for the tenant's job. It is not read here, and it is not read
 *    anywhere on the platform. The two hard prohibitions in the brief are
 *    enforced by the counter role not HOLDING `sale.override_price` or
 *    `credit.limit.change` — data a tenant can inspect, audit and change,
 *    not a special case we ship.
 *
 * Money in a bound is a DECIMAL STRING parsed with BigInt(): a bigint inside
 * jsonb becomes a float64 the instant JSON.parse touches it, and ADR-0004 is
 * categorical about `number` and money.
 */

/** The minimal query surface. Satisfied by the test harness and by the API. */
export interface PermissionQueryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

// ---------------------------------------------------------------------------
// The catalogue, mirrored from migration 0005. platform.permission is the
// source of truth; this list is the typed handle application code uses so a
// typo is a compile error rather than a permission that silently never
// matches. assertCatalogueMatches() below proves the two agree.
// ---------------------------------------------------------------------------

export const PERMISSION_CODES = [
  'sale.record',
  'sale.record.credit',
  'sale.override_price',
  'sale.discount.apply',
  'sale.void',
  'sale.view',
  'sale.receipt.reprint',

  'stock.view',
  'stock.adjust',
  'stock.transfer',
  'stock.transfer.receive',
  'stock.receive',
  'stock.count.perform',
  'stock.reorder.manage',

  'catalogue.view',
  'catalogue.manage',
  'catalogue.price_list.manage',

  'customer.view',
  'customer.manage',

  'credit.view',
  'credit.account.manage',
  'credit.limit.change',
  'credit.entry.record',
  'credit.fee.accrue',
  'credit.policy.manage',

  'gl.view',
  'report.view.location',
  'report.view.tenant',
  'report.view.margin',

  'payroll.register.export',
  'payroll.register.import',

  'admin.user.manage',
  'admin.role.manage',
  'admin.location.manage',
  'admin.device.enrol',
  'admin.device.revoke',
  'admin.template.apply',
  // Migration 0023 (02 §2.4): the device ceiling, and assignment as its own
  // capability so a user-manager cannot hand themselves the owner role.
  'admin.device.scope.manage',
  'admin.assignment.manage',

  'sync.conflict.review',

  // Phase 2 — procurement and logistics (migration 0009). `goods.receive` is
  // deliberately NOT `purchase.order.approve`: one person holding both can
  // fabricate a receipt against an order they invented, and both the ledger
  // and accounts payable would believe it.
  'supplier.view',
  'supplier.manage',

  'purchase.order.view',
  'purchase.order.create',
  'purchase.order.approve',

  'goods.receive',

  'logistics.delivery.view',
  'logistics.dispatch.manage',
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

/**
 * The two capabilities the brief names explicitly. They are listed here as
 * TEST ANCHORS and audit targets — never as a branch. No code path asks "is
 * this one of the prohibited permissions?"; the platform only ever asks
 * "does this user hold this code at this location?".
 */
export const BRIEF_RESTRICTED_PERMISSIONS = [
  'sale.override_price',
  'credit.limit.change',
] as const satisfies readonly PermissionCode[];

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** A bound object as stored in role_permission.bound. Money members are strings. */
export type Bound = Readonly<Record<string, string | number | boolean>>;

/** null means UNBOUNDED, which is the most permissive value there is. */
export type MaybeBound = Bound | null;

function asBigInt(v: string | number | boolean): bigint | null {
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}

/**
 * Merge two bounds, most permissive wins (02 §2.4).
 *
 * - null (unbounded) beats everything.
 * - A key present in only ONE bound is dropped: the other grant does not
 *   constrain that dimension at all, so the union must not either.
 * - A key present in both takes the larger integer value. Non-integer values
 *   that differ are kept only when equal — an unmergeable bound is treated as
 *   the intersection of what both agree on, never as a guess.
 */
export function mergeBounds(a: MaybeBound, b: MaybeBound): MaybeBound {
  if (a === null || b === null) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(a)) {
    if (!(key in b)) continue;
    const av = a[key]!;
    const bv = b[key]!;
    const ai = asBigInt(av);
    const bi = asBigInt(bv);
    if (ai !== null && bi !== null) {
      const bigger = ai >= bi ? av : bv;
      out[key] = bigger;
    } else if (av === bv) {
      out[key] = av;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** One row of app.effective_permission: a capability, at a place, from a grant. */
export interface EffectivePermissionRow {
  permissionCode: string;
  /** A concrete location the capability applies at (a closure descendant). */
  locationId: string;
  /** The node the grant was actually made at. */
  scopeLocationId: string;
  /** Hops from the scope node down to locationId; 0 = the scope node itself. */
  scopeDepth: number;
  /** app.user_role_assignment.id — what audit_event.grant_id records. */
  grantId: string;
  roleId: string;
  bound: MaybeBound;
  viaOwnerRole: boolean;
}

/** The union of every grant for one (code, location) pair. */
export interface ResolvedGrant {
  permissionCode: string;
  locationId: string;
  /** Merged, most-permissive bound. null = unbounded. */
  bound: MaybeBound;
  /** The scope nodes that produced this, for "why does Kofi have this?". */
  scopeLocationIds: readonly string[];
  /** The assignments that produced it — the audit trail's grant ids. */
  grantIds: readonly string[];
}

export interface EffectivePermissions {
  userId: string;
  /** Every row, unaggregated. */
  rows: readonly EffectivePermissionRow[];
  /** code → locationId → the resolved union. */
  byCode: ReadonlyMap<string, ReadonlyMap<string, ResolvedGrant>>;
}

const EFFECTIVE_PERMISSION_SQL = `
  select permission_code, location_id, scope_location_id, scope_depth,
         grant_id, role_id, bound, via_owner_role
    from app.effective_permission
   where user_id = $1
`;

/**
 * Resolve every permission this user holds, and WHERE each one applies.
 *
 * Runs inside the caller's transaction, so the tenant GUC is already set and
 * RLS scopes the read: a user id from another tenant resolves to nothing,
 * even if the id is guessed correctly. The tenant is never a parameter here —
 * it comes from the transaction's verified context, never from a payload
 * (CLAUDE.md §2.1).
 *
 * Correct for a user holding SEVERAL roles at SEVERAL scopes: permissions are
 * unioned per location, and a grant made at one location contributes nothing
 * at another.
 */
export async function effectivePermissions(
  tx: PermissionQueryable,
  userId: string,
): Promise<EffectivePermissions> {
  const res = await tx.query<{
    permission_code: string;
    location_id: string;
    scope_location_id: string;
    scope_depth: number;
    grant_id: string;
    role_id: string;
    bound: MaybeBound;
    via_owner_role: boolean;
  }>(EFFECTIVE_PERMISSION_SQL, [userId]);

  const rows: EffectivePermissionRow[] = res.rows.map((r) => ({
    permissionCode: r.permission_code,
    locationId: r.location_id,
    scopeLocationId: r.scope_location_id,
    scopeDepth: Number(r.scope_depth),
    grantId: r.grant_id,
    roleId: r.role_id,
    bound: r.bound ?? null,
    viaOwnerRole: r.via_owner_role,
  }));

  const byCode = new Map<string, Map<string, ResolvedGrant>>();
  for (const row of rows) {
    let byLocation = byCode.get(row.permissionCode);
    if (!byLocation) {
      byLocation = new Map<string, ResolvedGrant>();
      byCode.set(row.permissionCode, byLocation);
    }
    const existing = byLocation.get(row.locationId);
    if (!existing) {
      byLocation.set(row.locationId, {
        permissionCode: row.permissionCode,
        locationId: row.locationId,
        bound: row.bound,
        scopeLocationIds: [row.scopeLocationId],
        grantIds: [row.grantId],
      });
      continue;
    }
    byLocation.set(row.locationId, {
      permissionCode: existing.permissionCode,
      locationId: existing.locationId,
      bound: mergeBounds(existing.bound, row.bound),
      scopeLocationIds: existing.scopeLocationIds.includes(row.scopeLocationId)
        ? existing.scopeLocationIds
        : [...existing.scopeLocationIds, row.scopeLocationId],
      grantIds: existing.grantIds.includes(row.grantId)
        ? existing.grantIds
        : [...existing.grantIds, row.grantId],
    });
  }

  return { userId, rows, byCode };
}

/** Does this user hold `code` AT `locationId`? The only question most callers ask. */
export function hasPermissionAt(
  ep: EffectivePermissions,
  code: string,
  locationId: string,
): boolean {
  return ep.byCode.get(code)?.has(locationId) ?? false;
}

/**
 * Does this user hold `code` at ANY location? For capabilities with no
 * location in the request at all (a tenant-wide export). Deliberately a
 * SEPARATE function, so a caller that has a location and forgets to pass it
 * cannot get a wider answer by accident.
 */
export function hasPermissionAnywhere(ep: EffectivePermissions, code: string): boolean {
  return (ep.byCode.get(code)?.size ?? 0) > 0;
}

/** Every location this user holds `code` at. */
export function locationsFor(ep: EffectivePermissions, code: string): string[] {
  return [...(ep.byCode.get(code)?.keys() ?? [])].sort();
}

/** Every permission code this user holds at `locationId`. */
export function permissionCodesAt(ep: EffectivePermissions, locationId: string): string[] {
  const out: string[] = [];
  for (const [code, byLocation] of ep.byCode) {
    if (byLocation.has(locationId)) out.push(code);
  }
  return out.sort();
}

/** The merged bound for `code` at `locationId`; null = unbounded or absent. */
export function boundAt(
  ep: EffectivePermissions,
  code: string,
  locationId: string,
): MaybeBound {
  return ep.byCode.get(code)?.get(locationId)?.bound ?? null;
}

export type Decision =
  | { allow: true; bound: MaybeBound; grantIds: readonly string[] }
  | { allow: false; reason: 'no_permission' | 'out_of_scope' | 'bound_exceeded' };

/**
 * The whole decision in one call: does this user hold `code` at this
 * location, and — if the capability is bounded by an order value — is the
 * amount inside the bound?
 *
 * `amountMinor` is a bigint in the currency's minor unit (ADR-0004). The
 * bound member is a decimal string for the same reason.
 *
 * `out_of_scope` is distinguished from `no_permission` because they mean
 * different things to a human: one is "not here", the other is "not at all".
 */
export function authorize(
  ep: EffectivePermissions,
  code: string,
  target: { locationId: string; amountMinor?: bigint },
): Decision {
  const byLocation = ep.byCode.get(code);
  if (!byLocation || byLocation.size === 0) return { allow: false, reason: 'no_permission' };
  const grant = byLocation.get(target.locationId);
  if (!grant) return { allow: false, reason: 'out_of_scope' };

  if (target.amountMinor !== undefined && grant.bound) {
    const raw = grant.bound['max_order_value_minor'];
    if (raw !== undefined) {
      const max = asBigInt(raw);
      if (max === null || target.amountMinor > max) {
        return { allow: false, reason: 'bound_exceeded' };
      }
    }
  }
  return { allow: true, bound: grant.bound, grantIds: grant.grantIds };
}

/**
 * Reconcile PERMISSION_CODES against platform.permission. The migration is
 * the source of truth; this catches a code added to one and not the other,
 * which would otherwise show up as a check that can never pass.
 */
export async function catalogueDrift(
  tx: PermissionQueryable,
): Promise<{ missingInDb: string[]; missingInCode: string[] }> {
  const res = await tx.query<{ code: string }>('select code from platform.permission');
  const inDb = new Set(res.rows.map((r) => r.code));
  const inCode = new Set<string>(PERMISSION_CODES);
  return {
    missingInDb: [...inCode].filter((c) => !inDb.has(c)).sort(),
    missingInCode: [...inDb].filter((c) => !inCode.has(c)).sort(),
  };
}
