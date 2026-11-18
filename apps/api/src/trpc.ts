/**
 * tRPC v11 wiring: superjson transformer, per-request context carrying the
 * VERIFIED identity and the server dependencies, and the two procedure
 * bases every router builds on.
 *
 * tenantProcedure — requires a verified tenant token. ctx.identity.tenantId
 * comes from the JWT `tid` claim and is the ONLY tenant id any statement
 * ever sees. There is deliberately no way for a resolver to pass a
 * different one: TenantRunner.withTenant takes it from the context.
 *
 * operatorProcedure — the platform operator plane (provisioning). Not
 * tenant RBAC; requires the platform_operator claim AND an AdminRunner
 * configured on the server.
 */
import { TRPCError, initTRPC } from '@trpc/server';
import superjson from 'superjson';
import type { HlcClock, PermissionCode } from '@erp/db';
import type { VerifiedIdentity } from './auth.js';
import type { CreditPolicyStore } from './credit-policy.js';
import type { AdminRunner, TenantRunner } from './db.js';
import type { IdentityService } from './identity/service.js';
import { DENY, permissionState, type PermissionState } from './permissions.js';

export interface ApiDeps {
  runner: TenantRunner;
  admin?: AdminRunner | undefined;
  clock: HlcClock;
  policyStore: CreditPolicyStore;
}

export interface Context {
  deps: ApiDeps;
  identity: VerifiedIdentity | null;
  /** The production identity service, when configured — the admin routers
   *  use it to drop cached revocation answers the moment a device is revoked. */
  identityService?: IdentityService | undefined;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape }) {
    return shape;
  },
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

export const publicProcedure = t.procedure;

export const tenantProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.identity) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' });
  }
  return next({ ctx: { ...ctx, identity: ctx.identity } });
});

export const operatorProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.identity) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' });
  }
  if (!ctx.identity.platformOperator || !ctx.deps.admin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'platform operator plane required' });
  }
  return next({ ctx: { ...ctx, identity: ctx.identity, admin: ctx.deps.admin } });
});

/**
 * Location scoping for mutations (CLAUDE.md §2.6): a write naming a
 * location the token is not scoped to is refused. Fail closed — an empty
 * locs claim can write nowhere.
 *
 * This is the COARSE check, and it is deliberately not the only one. `locs`
 * is a claim in a token that was minted at some point in the past; the
 * authoritative answer to "may this user act here?" is resolved per request
 * from `app.effective_permission` — see assertPermission below. Both run:
 * the token narrows what a stolen session can reach, the database decides
 * what the user may do.
 */
export function assertLocationInScope(identity: VerifiedIdentity, locationId: string): void {
  if (!identity.locationIds.includes(locationId)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'location is outside this token’s scope',
    });
  }
}

/**
 * Does this caller hold `code` — and, when the act names a place, hold it
 * THERE? Resolved from the database on every call (never from the token),
 * refuses with FORBIDDEN otherwise.
 *
 * Re-exported here so it sits beside assertLocationInScope, which is where a
 * router author looks. The implementation and the reasoning are in
 * `./permissions.ts`.
 */
export { assertPermission, requireKnownCode, DENY } from './permissions.js';
export type { PermissionState } from './permissions.js';

/**
 * Where a required capability must be held.
 *
 *  - `'input'`   the location named by the request itself — a stock movement
 *                at a yard, a sale at a counter. The strict form: a grant at
 *                Techiman does not act at Wenchi.
 *  - `'tenant'`  the act has NO location of its own because its subject
 *                belongs to the tenant rather than to an outlet (a customer's
 *                credit account). Requires the capability at the ROOT of the
 *                location tree — and because grants expand DOWN the closure,
 *                leaf-scoped authority can never reach it.
 *  - `'any'`     a read affordance: the capability is held somewhere in the
 *                tenant. Never use this for a write, and never as a fallback
 *                when the request did carry a location.
 */
export type PermissionScope = 'input' | 'tenant' | 'any';

export interface PermissionRequirement {
  /**
   * The capability this procedure requires. A function derives it from the
   * request's OWN declared intent — e.g. `sourceKind`, a PLATFORM document
   * vocabulary. Never derive a permission from tenant vocabulary (a
   * `reasonCode`, a role name): that would make the platform branch on a
   * tenant's words (CLAUDE.md §2.9). An unrecognised result denies.
   */
  code: PermissionCode | ((raw: Record<string, unknown>) => string | undefined);
  at: PermissionScope;
  /** Raw-input field naming the location when `at: 'input'`. */
  locationField?: string;
}

/**
 * Declare a procedure's permission requirement ONCE, on the procedure —
 * never as a call at the top of a handler that the author of the 40th router
 * can forget and no reviewer can see is missing.
 *
 * Two positions, and the difference matters:
 *
 * ```ts
 * // (a) the requirement reads the request — put it AFTER .input(), so the
 * //     location and the derived code come from a VALIDATED payload and a
 * //     malformed one is BAD_REQUEST rather than a misleading FORBIDDEN.
 * recordMovement: tenantProcedure
 *   .input(recordMovementInput)
 *   .use(requiresPermission({ code: movementPermission, at: 'input' }))
 *   .mutation(...)
 *
 * // (b) the requirement reads nothing — permissionProcedure() is the base.
 * openAccount: permissionProcedure({ code: 'credit.account.manage', at: 'tenant' })
 *   .input(openAccountInput)
 *   .mutation(...)
 * ```
 *
 * Either way the middleware does three things:
 *   1. resolves the caller's effective permissions FROM THE DATABASE — once,
 *      for this request, never from the token;
 *   2. enforces the declared requirement, failing closed on an unknown code,
 *      an unresolvable user, an empty permission set, or a missing location;
 *   3. hands the resolved snapshot to the handler as `ctx.permissions`, so a
 *      second check inside the handler — one that needs a figure only the
 *      pipeline can compute, such as a credit bound against a server-repriced
 *      total — is a SYNCHRONOUS call against an already-open answer, and
 *      never a transaction opened inside another transaction.
 */
export function requiresPermission(requirement: PermissionRequirement) {
  return t.middleware(async ({ ctx, type, input, getRawInput, next }) => {
    if (!ctx.identity) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' });
    }
    const identity = ctx.identity;
    const state = await permissionState({ ...ctx, identity });

    // `input` is the PARSED payload when this middleware sits after .input();
    // before it, tRPC leaves it undefined and the raw body is all there is.
    let payload: Record<string, unknown> = {};
    if (typeof requirement.code === 'function' || requirement.at === 'input') {
      const got = input !== undefined ? input : await getRawInput();
      if (got !== null && typeof got === 'object') payload = got as Record<string, unknown>;
    }

    const code =
      typeof requirement.code === 'function' ? requirement.code(payload) : requirement.code;
    if (typeof code !== 'string' || code.length === 0) {
      // The request declared an intent this procedure has no capability for.
      // Deny — never fall back to a weaker code, and never to a wider one.
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `${DENY.unknownCode}: this request maps to no permission in the catalogue`,
      });
    }

    switch (requirement.at) {
      case 'input': {
        const field = requirement.locationField ?? 'locationId';
        const locationId = payload[field];
        if (typeof locationId !== 'string' || locationId.length === 0) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `${DENY.outOfScope}: ${code} acts at a location and the request names none`,
          });
        }
        state.requireAt(code, locationId);
        // Belt and braces on the WRITE path: the database says this user may
        // act there, the token says this session may reach there. Both.
        //
        // Not on the read path, and the asymmetry is deliberate. `locs` is a
        // DEVICE scope — which counter this tablet is standing at — so
        // requiring it for a read would refuse a head-office browser session
        // that legitimately holds the capability across the network and is
        // scoped to no counter at all (02 §2.5: the right to see something is
        // not the right to have it on a tablet). The database answer above is
        // the control for both.
        if (type === 'mutation') assertLocationInScope(identity, locationId);
        break;
      }
      case 'tenant':
        state.requireTenantWide(code);
        break;
      case 'any':
        state.requireAnywhere(code);
        break;
    }

    return next({ ctx: { ...ctx, identity, permissions: state } });
  });
}

/** `tenantProcedure` with a permission requirement that reads no input. */
export function permissionProcedure(requirement: PermissionRequirement) {
  return tenantProcedure.use(requiresPermission(requirement));
}
