/**
 * SERVER-SIDE PERMISSION ENFORCEMENT — layer 2 of the three in
 * `docs/architecture/sections/02-security-and-access-control.md` §2.3, and
 * the only one of the three that runs in this package.
 *
 * Layer 1 (sync rules) decides what a device ever receives. Layer 3 (hiding
 * buttons) is not a control. THIS layer re-derives every decision when the
 * write arrives, from the database, and it is what makes the two hard
 * prohibitions in the brief real rather than cosmetic (02 §2.4).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FOUR RULES THIS MODULE EXISTS TO MAKE STRUCTURAL
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. **Permissions are resolved from the DATABASE, never from the token.**
 *    The token carries `{tid, uid, role, locs}`. `role` is an OPAQUE LABEL
 *    the platform never branches on (CLAUDE.md §2.9), and no permission
 *    claim is read from the token at all. A token minted at 09:00 and a
 *    revocation at 09:05 must not leave a 15-minute hole, so the answer is
 *    re-derived per request from `app.effective_permission`, keyed on the
 *    verified `uid` inside the verified `tid`'s RLS context. Cost: one
 *    query per request. Bought: revocation that takes effect now.
 *
 * 2. **A permission is a capability AT A PLACE.** `holdsAt(code, location)`
 *    is the normal question; `holdsAnywhere` is a deliberately separate,
 *    deliberately wordier function so that a caller which HAS a location and
 *    forgets to pass it cannot silently get the wider answer.
 *
 * 3. **Fail closed, everywhere.** An unknown permission code, an unresolvable
 *    user, an empty permission set, a tenant with no location tree, a
 *    missing location on a location-bearing write — every one of them
 *    DENIES. There is no path through this file that reaches `allow` by
 *    accident; every allow is a positive row in the database.
 *
 * 4. **Nothing here reads a role name.** Not `role`, not `app.role.name`.
 *    The only structural flag is `is_owner`, and that is resolved inside the
 *    `app.effective_permission` view as "holds the whole catalogue", never
 *    as a name (02 §2.4).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TRANSACTION DISCIPLINE — read this before calling anything here
 * ─────────────────────────────────────────────────────────────────────────
 * Resolution opens its OWN `withTenant` transaction. It must therefore never
 * be called from INSIDE another one — i.e. never from inside a
 * `runIdempotent` plan/apply callback. On a pooled production runner that
 * would take a second connection while holding the first; on the hermetic
 * PGlite harness (one connection, serialized transactions) it deadlocks
 * outright. The shape that makes this impossible to get wrong is
 * `permissionProcedure()` in `trpc.ts`: the middleware resolves ONCE, before
 * the handler runs, and every further check inside the handler — including
 * ones that need a figure only the pipeline can compute, such as a credit
 * bound against a server-repriced total — is a SYNCHRONOUS call against that
 * already-resolved snapshot.
 *
 * The snapshot is scoped to ONE REQUEST and nothing longer. It is not a
 * process cache, has no TTL and no invalidation, because it does not outlive
 * the request that built it.
 */
import { TRPCError } from '@trpc/server';
import {
  PERMISSION_CODES,
  authorize,
  boundAt,
  effectivePermissions,
  hasPermissionAnywhere,
  hasPermissionAt,
  locationsFor,
  permissionCodesAt,
  type EffectivePermissions,
  type PermissionCode,
} from '@erp/db';
import type { VerifiedIdentity } from './auth.js';
import type { TenantRunner } from './db.js';

/**
 * The catalogue as a lookup. `platform.permission` is the source of truth and
 * `@erp/db`'s PERMISSION_CODES mirrors it (proven by `catalogueDrift()` in
 * that package's suite), so a code that is not in here is a code no grant can
 * ever carry — which is exactly why an unknown code must DENY rather than
 * throw a 500 that some outer handler might turn into something softer.
 */
const CATALOGUE: ReadonlySet<string> = new Set<string>(PERMISSION_CODES);

/** Stable, greppable prefixes. Tests assert on these, logs are filtered on them. */
export const DENY = {
  unknownCode: 'UNKNOWN_PERMISSION_CODE',
  notHeld: 'PERMISSION_DENIED',
  outOfScope: 'PERMISSION_OUT_OF_SCOPE',
  boundExceeded: 'PERMISSION_BOUND_EXCEEDED',
  noTenantScope: 'PERMISSION_NO_TENANT_SCOPE',
} as const;

function forbid(prefix: string, message: string): never {
  throw new TRPCError({ code: 'FORBIDDEN', message: `${prefix}: ${message}` });
}

/**
 * Narrow a string to a catalogue code, or DENY.
 *
 * A typo'd code must never be able to authorise anything. The dangerous
 * failure is not "throws" — it is a check that silently matches nothing on
 * the deny side and is then written as `if (!has(code)) deny()` somewhere
 * that inverts. Refusing here removes the possibility.
 */
export function requireKnownCode(code: string): PermissionCode {
  if (!CATALOGUE.has(code)) {
    forbid(DENY.unknownCode, `'${code}' is not a permission in platform.permission`);
  }
  return code as PermissionCode;
}

export function isKnownCode(code: string): code is PermissionCode {
  return CATALOGUE.has(code);
}

/** The minimum a caller must carry for permission resolution. */
export interface PermissionCtx {
  deps: { runner: TenantRunner };
  identity: VerifiedIdentity;
  /** Present when permissionProcedure() already resolved it for this request. */
  permissions?: PermissionState | undefined;
}

/**
 * One request's answer to "what may this user do, and where?", plus the
 * tenant's root location node(s) — needed for capabilities that act on
 * TENANT-WIDE objects (see requireTenantWide).
 */
export interface PermissionState {
  readonly userId: string;
  readonly effective: EffectivePermissions;
  /** app.location rows with no parent. Normally exactly one. */
  readonly rootLocationIds: readonly string[];

  holdsAt(code: string, locationId: string): boolean;
  holdsAnywhere(code: string): boolean;

  /** Assert `code` at `locationId`. The normal check. */
  requireAt(code: string, locationId: string): void;
  /**
   * Assert `code` at SOME location. Only for acts with no location in them
   * at all; never as a fallback when a location was available.
   */
  requireAnywhere(code: string): void;
  /**
   * Assert `code` over the WHOLE tenant — held at every root node of the
   * location tree. For objects that have no location (a customer's credit
   * account belongs to the tenant, not to an outlet): a grant made at the
   * Techiman leaf expands DOWN the closure and therefore never covers the
   * root, so leaf-scoped authority cannot reach a tenant-wide object.
   */
  requireTenantWide(code: string): void;
  /**
   * Assert `code` at `locationId` AND that `amountMinor` is inside the
   * merged `max_order_value_minor` bound (02 §2.4 — "credit sales up to a
   * set limit" is a bound, not a column and not a role name).
   */
  requireWithinAmount(code: string, locationId: string, amountMinor: bigint): void;
  /**
   * The general bound check: `value` must not exceed the integer bound
   * member `key`. An absent bound, or an absent key inside it, means that
   * dimension is unconstrained — the same semantics mergeBounds() uses when
   * it unions two grants (@erp/db permissions.ts).
   */
  requireWithinBound(code: string, locationId: string, key: string, value: bigint): void;

  /** Every location the caller holds `code` at. */
  locationsFor(code: string): string[];
  /** Every code the caller holds at `locationId`. For the UX affordance. */
  codesAt(locationId: string): string[];
}

function parseBoundInt(raw: string | number | boolean | undefined): bigint | null {
  if (raw === undefined) return null;
  if (typeof raw === 'number') return Number.isInteger(raw) ? BigInt(raw) : null;
  // Money in a bound is a DECIMAL STRING: a bigint inside jsonb becomes a
  // float64 the instant JSON.parse touches it (ADR-0004).
  if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return BigInt(raw);
  return null;
}

function makeState(
  userId: string,
  effective: EffectivePermissions,
  rootLocationIds: readonly string[],
): PermissionState {
  const state: PermissionState = {
    userId,
    effective,
    rootLocationIds,

    holdsAt: (code, locationId) =>
      isKnownCode(code) && hasPermissionAt(effective, code, locationId),
    holdsAnywhere: (code) => isKnownCode(code) && hasPermissionAnywhere(effective, code),

    requireAt(code, locationId) {
      const known = requireKnownCode(code);
      if (!locationId) {
        forbid(DENY.outOfScope, `${known} requires a location and none was supplied`);
      }
      if (hasPermissionAt(effective, known, locationId)) return;
      if (hasPermissionAnywhere(effective, known)) {
        forbid(
          DENY.outOfScope,
          `${known} is held, but not at location ${locationId} — a permission granted at one ` +
            `location does not act at another`,
        );
      }
      forbid(DENY.notHeld, `${known} is not held by this user`);
    },

    requireAnywhere(code) {
      const known = requireKnownCode(code);
      if (!hasPermissionAnywhere(effective, known)) {
        forbid(DENY.notHeld, `${known} is not held by this user`);
      }
    },

    requireTenantWide(code) {
      const known = requireKnownCode(code);
      if (rootLocationIds.length === 0) {
        // No tree, no root, no tenant-wide authority. Fail closed: the
        // alternative is "everyone is tenant-wide until onboarding finishes".
        forbid(
          DENY.noTenantScope,
          `${known} acts on a tenant-wide object, but this tenant has no location tree to be ` +
            `tenant-wide over`,
        );
      }
      const missing = rootLocationIds.filter((root) => !hasPermissionAt(effective, known, root));
      if (missing.length === 0) return;
      if (hasPermissionAnywhere(effective, known)) {
        forbid(
          DENY.outOfScope,
          `${known} is held at ${locationsFor(effective, known).length} location(s) but not over ` +
            `the whole tenant — this act has no location of its own, so it needs authority at ` +
            `the root of the location tree`,
        );
      }
      forbid(DENY.notHeld, `${known} is not held by this user`);
    },

    requireWithinAmount(code, locationId, amountMinor) {
      const known = requireKnownCode(code);
      const decision = authorize(effective, known, { locationId, amountMinor });
      if (decision.allow) return;
      if (decision.reason === 'bound_exceeded') {
        const bound = boundAt(effective, known, locationId);
        const max = parseBoundInt(bound?.['max_order_value_minor']);
        forbid(
          DENY.boundExceeded,
          `${known} at ${locationId} is bounded at ${max === null ? 'an unusable value' : max.toString(10)} ` +
            `minor units; this act is ${amountMinor.toString(10)}`,
        );
      }
      state.requireAt(known, locationId); // produces the precise not-held / out-of-scope message
      forbid(DENY.notHeld, `${known} is not held by this user`); // unreachable; belt and braces
    },

    requireWithinBound(code, locationId, key, value) {
      const known = requireKnownCode(code);
      state.requireAt(known, locationId);
      const bound = boundAt(effective, known, locationId);
      if (bound === null) return; // unbounded — the most permissive value there is
      const raw = bound[key];
      if (raw === undefined) return; // this dimension is not constrained by any grant
      const max = parseBoundInt(raw);
      if (max === null) {
        // A bound we cannot parse constrains rather than waves through.
        forbid(
          DENY.boundExceeded,
          `${known} at ${locationId} carries an unreadable bound for ${key}`,
        );
      }
      if (value > max) {
        forbid(
          DENY.boundExceeded,
          `${known} at ${locationId} is bounded at ${key}=${max.toString(10)}; this act is ${value.toString(10)}`,
        );
      }
    },

    locationsFor: (code) => (isKnownCode(code) ? locationsFor(effective, code) : []),
    codesAt: (locationId) => permissionCodesAt(effective, locationId),
  };
  return state;
}

const ROOT_LOCATION_SQL = `
  select id from app.location where parent_id is null and deleted_at is null order by id
`;

/**
 * Resolve one request's permission state from the database.
 *
 * Runs in ONE `withTenant` transaction: `SET LOCAL ROLE app_user` +
 * `app.tenant_id` from the VERIFIED token, so RLS scopes both reads. A user
 * id belonging to another tenant resolves to nothing even if the uuid is
 * guessed correctly — the tenant is never a parameter, it is the context.
 *
 * MUST NOT be called from inside another withTenant (see the header).
 */
export async function loadPermissionState(ctx: PermissionCtx): Promise<PermissionState> {
  const { tenantId, userId } = ctx.identity;
  return ctx.deps.runner.withTenant(tenantId, async (tx) => {
    const effective = await effectivePermissions(tx, userId);
    const roots = await tx.query<{ id: string }>(ROOT_LOCATION_SQL);
    return makeState(userId, effective, roots.rows.map((r) => r.id));
  });
}

/**
 * Per-request memoisation.
 *
 * Keyed on the CONTEXT OBJECT ITSELF, so the entry dies with the request and
 * cannot be shared between two of them — a cache keyed on `(tenantId,
 * userId)` would be a revocation hole with a lifetime nobody documented.
 * tRPC middlewares spread-copy the context, so a miss across a middleware
 * boundary is possible and costs one extra query; an over-cache across
 * requests is not possible at all. That asymmetry is the point.
 */
const perRequest = new WeakMap<object, Promise<PermissionState>>();

export function permissionState(ctx: PermissionCtx): Promise<PermissionState> {
  // Already resolved by permissionProcedure() for THIS request — the common
  // path, and the one that keeps a second check inside a handler free.
  if (ctx.permissions) return Promise.resolve(ctx.permissions);
  const cached = perRequest.get(ctx);
  if (cached) return cached;
  const pending = loadPermissionState(ctx);
  perRequest.set(ctx, pending);
  return pending;
}

/**
 * The one-call form: does this caller hold `code`, and — when the act names
 * a location — hold it THERE?
 *
 * Prefer `permissionProcedure()` in trpc.ts, which declares the requirement
 * on the procedure so a router cannot forget to ask. This exists for the
 * checks that a declaration cannot express: a second capability inside a
 * handler, or a conditional one (setting a credit limit while opening an
 * account). Omitting `locationId` asserts only that the capability is held
 * SOMEWHERE in the tenant — never pass undefined for an act that has a
 * location.
 */
export async function assertPermission(
  ctx: PermissionCtx,
  code: string,
  locationId?: string,
): Promise<PermissionState> {
  const state = await permissionState(ctx);
  if (locationId === undefined) state.requireAnywhere(code);
  else state.requireAt(code, locationId);
  return state;
}
