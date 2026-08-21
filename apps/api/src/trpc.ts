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
import type { HlcClock } from '@erp/db';
import type { VerifiedIdentity } from './auth.js';
import type { CreditPolicyStore } from './credit-policy.js';
import type { AdminRunner, TenantRunner } from './db.js';

export interface ApiDeps {
  runner: TenantRunner;
  admin?: AdminRunner | undefined;
  clock: HlcClock;
  policyStore: CreditPolicyStore;
}

export interface Context {
  deps: ApiDeps;
  identity: VerifiedIdentity | null;
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
 */
export function assertLocationInScope(identity: VerifiedIdentity, locationId: string): void {
  if (!identity.locationIds.includes(locationId)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'location is outside this token’s scope',
    });
  }
}
