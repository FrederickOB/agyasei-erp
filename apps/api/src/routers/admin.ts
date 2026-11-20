/**
 * BACK-OFFICE ADMINISTRATION — users, role assignments, roles, devices.
 * (02-security §2.4 bounds and escalation, §2.5 scope and the device ceiling,
 *  §2.6 audit, §2.7 enrolment and revocation; CLAUDE.md §2.6.)
 *
 * Laptop-first, tablet-usable screens drive this; every write is online, goes
 * through the ONE idempotent pipeline, and writes an `app.identity_event`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ESCALATION RULE (§2.4 rules 3 and 4) — the reason this file is careful
 * ─────────────────────────────────────────────────────────────────────────
 * A granter may hand out only what they hold, where they hold it, no looser:
 *
 *   · ASSIGN role R at scope S  → the granter holds EVERY permission in R at
 *     EVERY location under S, with a bound at least as permissive as R's. For
 *     the owner role that is the whole catalogue — so only someone who already
 *     holds everything can make someone else an owner.
 *   · EDIT role R's permission set → the same check, against every live
 *     assignment of R, for every permission the edit ADDS or LOOSENS.
 *   · Assignment is its own capability (`admin.assignment.manage`), so holding
 *     `admin.user.manage` alone — creating accounts — cannot grant anything.
 *
 * Nothing here reads a role NAME (CLAUDE.md §2.9). The owner role is found by
 * its `is_owner` flag, which is a capability statement, never a name.
 *
 * WHERE: admin acts are NOT location writes in the device sense, so none of
 * these procedures uses `at: 'input'` (which would also demand the location be
 * inside this DEVICE's ceiling — a back-office laptop has an empty ceiling by
 * design). The capability is checked at the right node inside each handler.
 */
import { TRPCError } from '@trpc/server';
import {
  PERMISSION_CODES,
  boundAt,
  deterministicUuid,
  uuidv7,
  type Bound,
} from '@erp/db';
import {
  assignRoleInput,
  createRoleInput,
  createUserInput,
  deleteRoleInput,
  endAssignmentInput,
  issueEnrolmentCodeInput,
  revokeDeviceInput,
  setDeviceScopeInput,
  setDeviceStatusInput,
  setUserStatusInput,
  updateRoleInput,
  updateUserInput,
} from '@erp/contracts';
import type { Queryable } from '../db.js';
import { recordIdentityEvent } from '../identity/audit.js';
import {
  ENROLMENT_CODE_TTL_S,
  displayEnrolmentCode,
  generateEnrolmentCode,
  hashEnrolmentCode,
} from '../identity/enrolment-code.js';
import { runIdempotent, type JsonValue } from '../pipeline.js';
import { DENY, permissionState, type PermissionState } from '../permissions.js';
import { router, tenantProcedure, type Context } from '../trpc.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function forbid(prefix: string, message: string): never {
  throw new TRPCError({ code: 'FORBIDDEN', message: `${prefix}: ${message}` });
}

const ESCALATION = 'PERMISSION_ESCALATION';

/** Holds `code` at EVERY root node — the tenant-wide form. */
function holdsTenantWide(state: PermissionState, code: string): boolean {
  return state.rootLocationIds.length > 0 && state.rootLocationIds.every((r) => state.holdsAt(code, r));
}

/** `code` at `locationId`, or tenant-wide when the act has no location. */
function requireAtOrTenant(state: PermissionState, code: string, locationId: string | null): void {
  if (locationId === null) state.requireTenantWide(code);
  else state.requireAt(code, locationId);
}

function parseIntish(v: string | number | boolean | undefined): bigint | null {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}

/**
 * Is the granter's bound at least as permissive as the one being handed out?
 * Absent bound = unbounded = the most permissive value there is (mergeBounds'
 * semantics). A member the granter is not constrained on is fine; a member the
 * granter IS constrained on must be ≥ for integers and equal otherwise.
 */
function boundCovers(granter: Bound | null, granted: Bound | null | undefined): boolean {
  if (granter === null) return true;
  if (granted === null || granted === undefined) return false; // handing out unbounded from a bounded hold
  for (const [key, mine] of Object.entries(granter)) {
    const theirs = granted[key];
    if (theirs === undefined) return false; // they would be unconstrained where I am not
    const a = parseIntish(mine);
    const b = parseIntish(theirs);
    if (a !== null && b !== null) {
      if (b > a) return false;
    } else if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
      return false;
    }
  }
  return true;
}

interface GrantedPermission {
  code: string;
  bound: Bound | null;
}

async function descendantsOf(tx: Queryable, nodeId: string): Promise<string[]> {
  const r = await tx.query<{ descendant_id: string }>(
    `select descendant_id from app.location_closure where ancestor_id = $1`,
    [nodeId],
  );
  return r.rows.map((x) => x.descendant_id);
}

async function rolePermissions(tx: Queryable, roleId: string): Promise<{ isOwner: boolean; perms: GrantedPermission[] }> {
  const role = await tx.query<{ is_owner: boolean }>(
    `select is_owner from app.role where id = $1 and deleted_at is null`,
    [roleId],
  );
  const row = role.rows[0];
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such role' });
  if (row.is_owner) {
    // The owner role holds the WHOLE catalogue by construction.
    return { isOwner: true, perms: PERMISSION_CODES.map((code) => ({ code, bound: null })) };
  }
  const perms = await tx.query<{ permission_code: string; bound: Bound | null }>(
    `select permission_code, bound from app.role_permission where role_id = $1 and deleted_at is null`,
    [roleId],
  );
  return { isOwner: false, perms: perms.rows.map((p) => ({ code: p.permission_code, bound: p.bound })) };
}

/** §2.4 rule 3: the granter must cover `perms` at every location in `locations`. */
function assertCovers(state: PermissionState, perms: readonly GrantedPermission[], locations: readonly string[]): void {
  for (const p of perms) {
    for (const loc of locations) {
      if (!state.holdsAt(p.code, loc)) {
        forbid(ESCALATION, `you cannot grant ${p.code} at a location where you do not hold it yourself`);
      }
      const mine = boundAt(state.effective, p.code as never, loc);
      if (!boundCovers(mine, p.bound)) {
        forbid(ESCALATION, `you cannot grant ${p.code} with a looser bound than your own`);
      }
    }
  }
}

type AdminCtx = Context & {
  identity: NonNullable<Context['identity']>;
  permissions: PermissionState;
};

function pipelineDeps(ctx: AdminCtx) {
  return { runner: ctx.deps.runner, clock: ctx.deps.clock };
}

function envelope(op: string, input: { idempotencyKey: string; claimedHlc?: string | undefined; clientWallAt?: string | undefined }) {
  return { op, idempotencyKey: input.idempotencyKey, claimedHlc: input.claimedHlc, clientWallAt: input.clientWallAt };
}

const audit = (ctx: AdminCtx, tx: Queryable, writeId: string, e: Omit<Parameters<typeof recordIdentityEvent>[2], 'tenantId' | 'writeId' | 'eventClass' | 'actorKind' | 'actorUserId' | 'actorDeviceId'>) =>
  recordIdentityEvent(tx, ctx.deps.clock, {
    tenantId: ctx.identity.tenantId,
    writeId,
    eventClass: 'write',
    actorKind: 'user',
    actorUserId: ctx.identity.userId,
    actorDeviceId: ctx.identity.deviceId,
    ...e,
  });

/** Any of the admin capabilities, anywhere — the gate on the reference reads. */
function requireSomeAdmin(state: PermissionState): void {
  const any = [
    'admin.user.manage',
    'admin.assignment.manage',
    'admin.role.manage',
    'admin.device.enrol',
    'admin.device.revoke',
    'admin.device.scope.manage',
  ].some((c) => state.holdsAnywhere(c));
  if (!any) forbid(DENY.notHeld, 'no administration capability is held');
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/**
 * The base: permissions resolved from the DATABASE (never the token), the
 * caller required to hold SOME administration capability, and the snapshot
 * handed to the handler — which then asks for the exact capability it needs,
 * at the exact node it needs it, synchronously against that snapshot.
 */
const adminProcedure = tenantProcedure.use(async ({ ctx, next }) => {
  const state = await permissionState({ ...ctx, identity: ctx.identity! });
  requireSomeAdmin(state);
  return next({ ctx: { ...ctx, identity: ctx.identity!, permissions: state } });
});

export const adminRouter = router({
  // ======================================================================
  // Reference reads for the screens
  // ======================================================================

  /** The platform catalogue — what a role may be composed from. */
  catalogue: adminProcedure.query(async ({ ctx }) => {
    return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
      const r = await tx.query<{
        code: string;
        domain: string;
        description: string;
        is_sensitive: boolean;
        offline_mode: string;
        bound_schema: unknown;
      }>(
        `select code, domain, description, is_sensitive, offline_mode, bound_schema
           from platform.permission order by domain, code`,
      );
      return r.rows.map((p) => ({
        code: p.code,
        domain: p.domain,
        description: p.description,
        isSensitive: p.is_sensitive,
        offlineMode: p.offline_mode,
        boundSchema: p.bound_schema === null ? null : JSON.stringify(p.bound_schema),
      }));
    });
  }),

  /** The tenant's location tree, for scope pickers. */
  locations: adminProcedure.query(async ({ ctx }) => {
    return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
      const r = await tx.query<{ id: string; code: string; name: string; kind: string; parent_id: string | null }>(
        `select id, code, name, kind, parent_id from app.location
          where deleted_at is null order by code`,
      );
      return r.rows.map((l) => ({ id: l.id, code: l.code, name: l.name, kind: l.kind, parentId: l.parent_id }));
    });
  }),

  // ======================================================================
  // Users and assignments
  // ======================================================================

  users: router({
    list: adminProcedure.query(async ({ ctx }) => {
      const state = ctx.permissions;
      if (!holdsTenantWide(state, 'admin.user.manage') && !state.holdsAnywhere('admin.assignment.manage')) {
        forbid(DENY.notHeld, 'admin.user.manage or admin.assignment.manage is required');
      }
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const users = await tx.query<{
          id: string;
          username: string;
          display_name: string;
          status: string;
          subject_ref: string | null;
        }>(
          `select id, username, display_name, status, subject_ref
             from app.user_account where deleted_at is null order by display_name, username`,
        );
        const assignments = await tx.query<{
          id: string;
          user_id: string;
          role_id: string;
          role_name: string;
          is_owner: boolean;
          scope_location_id: string;
          scope_name: string;
          effective_from: string;
          effective_to: string | null;
          live: boolean;
        }>(
          `select a.id, a.user_id, a.role_id, r.name as role_name, r.is_owner,
                  a.scope_location_id, l.name as scope_name,
                  a.effective_from::text, a.effective_to::text,
                  (a.effective_from <= transaction_timestamp()
                     and (a.effective_to is null or a.effective_to > transaction_timestamp())) as live
             from app.user_role_assignment a
             join app.role r on r.tenant_id = a.tenant_id and r.id = a.role_id
             join app.location l on l.tenant_id = a.tenant_id and l.id = a.scope_location_id
            where a.deleted_at is null
            order by a.effective_from desc`,
        );
        const sessions = await tx.query<{ user_id: string; n: number }>(
          `select user_id, count(*)::int as n from app.device_session
            where revoked_at is null and expires_at > transaction_timestamp() group by user_id`,
        );
        const openSessions = new Map(sessions.rows.map((s) => [s.user_id, s.n] as const));
        return users.rows.map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.display_name,
          status: u.status,
          linkedToIdentityProvider: u.subject_ref !== null,
          subjectRef: u.subject_ref,
          openSessions: openSessions.get(u.id) ?? 0,
          assignments: assignments.rows
            .filter((a) => a.user_id === u.id)
            .map((a) => ({
              id: a.id,
              roleId: a.role_id,
              roleName: a.role_name,
              isOwnerRole: a.is_owner,
              scopeLocationId: a.scope_location_id,
              scopeName: a.scope_name,
              effectiveFrom: a.effective_from,
              effectiveTo: a.effective_to,
              live: a.live,
            })),
        }));
      });
    }),

    create: adminProcedure.input(createUserInput).mutation(async ({ ctx, input }) => {
      ctx.permissions.requireTenantWide('admin.user.manage');
      const issuer = ctx.identityService?.oidcIssuer() ?? null;
      if (input.subjectRef !== undefined && issuer === null) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'no identity provider is configured on this server, so a user cannot be linked to one',
        });
      }
      const result = await runIdempotent<JsonValue>(
        pipelineDeps(ctx),
        ctx.identity,
        envelope('admin.user.create', input),
        input,
        async (tx) => {
          const clash = await tx.query(
            `select 1 from app.user_account where username = $1 and deleted_at is null`,
            [input.username],
          );
          if (clash.rows.length > 0) throw new TRPCError({ code: 'CONFLICT', message: `username ${input.username} is taken` });
          if (input.subjectRef !== undefined) {
            const linked = await tx.query(
              `select 1 from app.user_account where subject_issuer = $1 and subject_ref = $2 and deleted_at is null`,
              [issuer, input.subjectRef],
            );
            if (linked.rows.length > 0) {
              throw new TRPCError({ code: 'CONFLICT', message: 'that sign-in identity is already linked to a user here' });
            }
          }
          const userId = deterministicUuid(input.idempotencyKey, 'user');
          return {
            response: { userId },
            apply: async (atx) => {
              await atx.query(
                `insert into app.user_account
                   (tenant_id, id, write_id, hlc, username, display_name, status, subject_issuer, subject_ref)
                 values ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8)`,
                [
                  ctx.identity.tenantId, userId, input.idempotencyKey, ctx.deps.clock.next(),
                  input.username, input.displayName,
                  input.subjectRef === undefined ? null : issuer,
                  input.subjectRef ?? null,
                ],
              );
              await audit(ctx, atx, input.idempotencyKey, {
                action: 'user.create',
                permissionUsed: 'admin.user.manage',
                subjectTable: 'user_account',
                subjectId: userId,
                after: { username: input.username, displayName: input.displayName, linked: input.subjectRef !== undefined },
              });
            },
          };
        },
      );
      return result.response as { userId: string };
    }),

    update: adminProcedure.input(updateUserInput).mutation(async ({ ctx, input }) => {
      ctx.permissions.requireTenantWide('admin.user.manage');
      const issuer = ctx.identityService?.oidcIssuer() ?? null;
      if (input.subjectRef !== undefined && input.subjectRef !== null && issuer === null) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no identity provider is configured on this server' });
      }
      await runIdempotent<JsonValue>(pipelineDeps(ctx), ctx.identity, envelope('admin.user.update', input), input, async (tx) => {
        const found = await tx.query<{ display_name: string; subject_ref: string | null }>(
          `select display_name, subject_ref from app.user_account where id = $1 and deleted_at is null`,
          [input.userId],
        );
        const before = found.rows[0];
        if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such user' });
        if (input.subjectRef) {
          const linked = await tx.query(
            `select 1 from app.user_account
              where subject_issuer = $1 and subject_ref = $2 and deleted_at is null and id <> $3`,
            [issuer, input.subjectRef, input.userId],
          );
          if (linked.rows.length > 0) {
            throw new TRPCError({ code: 'CONFLICT', message: 'that sign-in identity is already linked to another user here' });
          }
        }
        return {
          response: { userId: input.userId },
          apply: async (atx) => {
            await atx.query(
              `update app.user_account
                  set display_name = coalesce($2, display_name),
                      subject_issuer = case when $3::boolean then $4 else subject_issuer end,
                      subject_ref    = case when $3::boolean then $5 else subject_ref end,
                      write_id = $6, hlc = $7, updated_at = transaction_timestamp()
                where id = $1`,
              [
                input.userId,
                input.displayName ?? null,
                input.subjectRef !== undefined,
                input.subjectRef === null || input.subjectRef === undefined ? null : issuer,
                input.subjectRef ?? null,
                input.idempotencyKey,
                ctx.deps.clock.next(),
              ],
            );
            if (input.subjectRef !== undefined) {
              // Re-linking the sign-in identity ends every session the old
              // identity opened — a credential change never leaves a door open.
              await atx.query(
                `update app.device_session set revoked_at = transaction_timestamp(), revoked_reason = 'admin',
                        updated_at = transaction_timestamp()
                  where user_id = $1 and revoked_at is null`,
                [input.userId],
              );
            }
            await audit(ctx, atx, input.idempotencyKey, {
              action: 'user.update',
              permissionUsed: 'admin.user.manage',
              subjectTable: 'user_account',
              subjectId: input.userId,
              before: { displayName: before.display_name, linked: before.subject_ref !== null },
              after: {
                displayName: input.displayName ?? before.display_name,
                linked: input.subjectRef === undefined ? before.subject_ref !== null : input.subjectRef !== null,
              },
            });
          },
        };
      });
      return { userId: input.userId };
    }),

    /**
     * Suspend / disable / reactivate. Disabling is what removes a person from
     * every device: their sessions are revoked now, and the sync projections
     * (0024) drop them on the next checkpoint. Recovering an IdP account never
     * re-grants roles (§2.2) — that is this act, done deliberately.
     */
    setStatus: adminProcedure.input(setUserStatusInput).mutation(async ({ ctx, input }) => {
      ctx.permissions.requireTenantWide('admin.user.manage');
      if (input.userId === ctx.identity.userId) {
        forbid(DENY.notHeld, 'you cannot change your own account status');
      }
      await runIdempotent<JsonValue>(pipelineDeps(ctx), ctx.identity, envelope('admin.user.set_status', input), input, async (tx) => {
        const found = await tx.query<{ status: string }>(
          `select status from app.user_account where id = $1 and deleted_at is null`,
          [input.userId],
        );
        const before = found.rows[0];
        if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such user' });
        return {
          response: { userId: input.userId, status: input.status },
          apply: async (atx) => {
            await atx.query(
              `update app.user_account set status = $2, write_id = $3, hlc = $4,
                      updated_at = transaction_timestamp()
                where id = $1`,
              [input.userId, input.status, input.idempotencyKey, ctx.deps.clock.next()],
            );
            if (input.status !== 'ACTIVE') {
              await atx.query(
                `update app.device_session set revoked_at = transaction_timestamp(), revoked_reason = 'user_disabled',
                        updated_at = transaction_timestamp()
                  where user_id = $1 and revoked_at is null`,
                [input.userId],
              );
            }
            await audit(ctx, atx, input.idempotencyKey, {
              action: 'user.set_status',
              permissionUsed: 'admin.user.manage',
              subjectTable: 'user_account',
              subjectId: input.userId,
              before: { status: before.status },
              after: { status: input.status },
              reasonNote: input.reason,
            });
          },
        };
      });
      return { userId: input.userId, status: input.status };
    }),

    assignRole: adminProcedure.input(assignRoleInput).mutation(async ({ ctx, input }) => {
      const state = ctx.permissions;
      state.requireAt('admin.assignment.manage', input.scopeLocationId);
      const result = await runIdempotent<JsonValue>(
        pipelineDeps(ctx),
        ctx.identity,
        envelope('admin.assignment.grant', input),
        input,
        async (tx) => {
          const user = await tx.query(`select 1 from app.user_account where id = $1 and deleted_at is null`, [input.userId]);
          if (user.rows.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such user' });
          const scope = await descendantsOf(tx, input.scopeLocationId);
          if (scope.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such location' });
          const { perms, isOwner } = await rolePermissions(tx, input.roleId);
          // §2.4 rule 3 — the whole role, everywhere under the node.
          assertCovers(state, perms, scope);
          const assignmentId = deterministicUuid(input.idempotencyKey, 'assignment');
          return {
            response: { assignmentId },
            apply: async (atx) => {
              await atx.query(
                `insert into app.user_role_assignment
                   (tenant_id, id, write_id, hlc, user_id, role_id, scope_location_id, effective_from, effective_to)
                 values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, transaction_timestamp()), $9::timestamptz)`,
                [
                  ctx.identity.tenantId, assignmentId, input.idempotencyKey, ctx.deps.clock.next(),
                  input.userId, input.roleId, input.scopeLocationId,
                  input.effectiveFrom ?? null, input.effectiveTo ?? null,
                ],
              );
              await audit(ctx, atx, input.idempotencyKey, {
                action: 'assignment.grant',
                permissionUsed: 'admin.assignment.manage',
                subjectTable: 'user_role_assignment',
                subjectId: assignmentId,
                after: {
                  userId: input.userId,
                  roleId: input.roleId,
                  ownerRole: isOwner,
                  scopeLocationId: input.scopeLocationId,
                  effectiveFrom: input.effectiveFrom ?? null,
                  effectiveTo: input.effectiveTo ?? null,
                },
              });
            },
          };
        },
      );
      return result.response as { assignmentId: string };
    }),

    endAssignment: adminProcedure.input(endAssignmentInput).mutation(async ({ ctx, input }) => {
      const state = ctx.permissions;
      await runIdempotent<JsonValue>(pipelineDeps(ctx), ctx.identity, envelope('admin.assignment.end', input), input, async (tx) => {
        const found = await tx.query<{ role_id: string; scope_location_id: string; user_id: string; effective_to: string | null }>(
          `select role_id, scope_location_id, user_id, effective_to::text from app.user_role_assignment
            where id = $1 and deleted_at is null`,
          [input.assignmentId],
        );
        const a = found.rows[0];
        if (!a) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such assignment' });
        state.requireAt('admin.assignment.manage', a.scope_location_id);
        // Ending is symmetric with granting: a regional administrator cannot
        // end the founder's root assignment, because they could not grant it.
        assertCovers(state, (await rolePermissions(tx, a.role_id)).perms, await descendantsOf(tx, a.scope_location_id));
        return {
          response: { assignmentId: input.assignmentId },
          apply: async (atx) => {
            await atx.query(
              `update app.user_role_assignment
                  set effective_to = greatest(effective_from + interval '1 millisecond',
                                              coalesce($2::timestamptz, transaction_timestamp())),
                      write_id = $3, hlc = $4, updated_at = transaction_timestamp()
                where id = $1`,
              [input.assignmentId, input.effectiveTo ?? null, input.idempotencyKey, ctx.deps.clock.next()],
            );
            await audit(ctx, atx, input.idempotencyKey, {
              action: 'assignment.end',
              permissionUsed: 'admin.assignment.manage',
              subjectTable: 'user_role_assignment',
              subjectId: input.assignmentId,
              before: { effectiveTo: a.effective_to },
              after: { effectiveTo: input.effectiveTo ?? 'now', userId: a.user_id },
            });
          },
        };
      });
      return { assignmentId: input.assignmentId };
    }),
  }),

  // ======================================================================
  // Roles — tenant-editable permission sets (§2.4)
  // ======================================================================

  roles: router({
    list: adminProcedure.query(async ({ ctx }) => {
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const roles = await tx.query<{ id: string; name: string; description: string; is_owner: boolean; live_assignments: number }>(
          `select r.id, r.name, r.description, r.is_owner,
                  (select count(*)::int from app.user_role_assignment a
                    where a.role_id = r.id and a.deleted_at is null
                      and (a.effective_to is null or a.effective_to > transaction_timestamp())) as live_assignments
             from app.role r where r.deleted_at is null order by r.is_owner desc, r.name`,
        );
        const perms = await tx.query<{ role_id: string; permission_code: string; bound: Bound | null }>(
          `select role_id, permission_code, bound from app.role_permission where deleted_at is null
            order by permission_code`,
        );
        return roles.rows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          isOwner: r.is_owner,
          liveAssignments: r.live_assignments,
          /** The owner role holds the whole catalogue by construction — no rows. */
          permissions: r.is_owner
            ? []
            : perms.rows
                .filter((p) => p.role_id === r.id)
                .map((p) => ({ code: p.permission_code, bound: p.bound === null ? null : JSON.stringify(p.bound) })),
        }));
      });
    }),

    create: adminProcedure.input(createRoleInput).mutation(async ({ ctx, input }) => {
      ctx.permissions.requireTenantWide('admin.role.manage');
      const result = await runIdempotent<JsonValue>(pipelineDeps(ctx), ctx.identity, envelope('admin.role.create', input), input, async (tx) => {
        await validateCodes(tx, input.permissions.map((p) => p.code));
        const clash = await tx.query(`select 1 from app.role where name = $1 and deleted_at is null`, [input.name]);
        if (clash.rows.length > 0) throw new TRPCError({ code: 'CONFLICT', message: `a role named ${input.name} exists` });
        const roleId = deterministicUuid(input.idempotencyKey, 'role');
        return {
          response: { roleId },
          apply: async (atx) => {
            await atx.query(
              `insert into app.role (tenant_id, id, write_id, hlc, name, description, is_owner)
               values ($1,$2,$3,$4,$5,$6,false)`,
              [ctx.identity.tenantId, roleId, input.idempotencyKey, ctx.deps.clock.next(), input.name, input.description ?? ''],
            );
            for (const p of dedupe(input.permissions)) {
              await atx.query(
                `insert into app.role_permission (tenant_id, id, write_id, hlc, role_id, permission_code, bound)
                 values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
                [
                  ctx.identity.tenantId, deterministicUuid(roleId, p.code, input.idempotencyKey),
                  input.idempotencyKey, ctx.deps.clock.next(), roleId, p.code,
                  p.bound ? JSON.stringify(p.bound) : null,
                ],
              );
            }
            await audit(ctx, atx, input.idempotencyKey, {
              action: 'role.create',
              permissionUsed: 'admin.role.manage',
              subjectTable: 'role',
              subjectId: roleId,
              after: { name: input.name, permissions: dedupe(input.permissions).map((p) => p.code) },
            });
          },
        };
      });
      return result.response as { roleId: string };
    }),

    update: adminProcedure.input(updateRoleInput).mutation(async ({ ctx, input }) => {
      const state = ctx.permissions;
      state.requireTenantWide('admin.role.manage');
      await runIdempotent<JsonValue>(pipelineDeps(ctx), ctx.identity, envelope('admin.role.update', input), input, async (tx) => {
        const found = await tx.query<{ name: string; is_owner: boolean }>(
          `select name, is_owner from app.role where id = $1 and deleted_at is null`,
          [input.roleId],
        );
        const role = found.rows[0];
        if (!role) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such role' });
        if (role.is_owner && input.permissions !== undefined) {
          forbid(ESCALATION, 'the owner role holds the whole catalogue by construction and has no editable permission set');
        }
        if (input.name !== undefined && input.name !== role.name) {
          const clash = await tx.query(`select 1 from app.role where name = $1 and deleted_at is null and id <> $2`, [input.name, input.roleId]);
          if (clash.rows.length > 0) throw new TRPCError({ code: 'CONFLICT', message: `a role named ${input.name} exists` });
        }
        const current = (await rolePermissions(tx, input.roleId)).perms;
        let added: GrantedPermission[] = [];
        let removed: string[] = [];
        if (input.permissions !== undefined) {
          const wanted = dedupe(input.permissions);
          await validateCodes(tx, wanted.map((p) => p.code));
          const before = new Map(current.map((p) => [p.code, p.bound] as const));
          // ADDED or LOOSENED (any bound change counts — the check decides).
          added = wanted
            .filter((p) => !before.has(p.code) || JSON.stringify(before.get(p.code)) !== JSON.stringify(p.bound ?? null))
            .map((p) => ({ code: p.code, bound: (p.bound ?? null) as Bound | null }));
          removed = current.filter((p) => !wanted.some((w) => w.code === p.code)).map((p) => p.code);
          // §2.4 rule 3 against EVERY live assignment of this role.
          const scopes = await tx.query<{ scope_location_id: string }>(
            `select distinct scope_location_id from app.user_role_assignment
              where role_id = $1 and deleted_at is null
                and (effective_to is null or effective_to > transaction_timestamp())`,
            [input.roleId],
          );
          for (const s of scopes.rows) assertCovers(state, added, await descendantsOf(tx, s.scope_location_id));
        }
        return {
          response: { roleId: input.roleId },
          apply: async (atx) => {
            await atx.query(
              `update app.role set name = coalesce($2, name), description = coalesce($3, description),
                      write_id = $4, hlc = $5, updated_at = transaction_timestamp()
                where id = $1`,
              [input.roleId, input.name ?? null, input.description ?? null, input.idempotencyKey, ctx.deps.clock.next()],
            );
            if (input.permissions !== undefined) {
              const codes = new Set([...removed, ...added.map((a) => a.code)]);
              if (codes.size > 0) {
                await atx.query(
                  `update app.role_permission set deleted_at = transaction_timestamp(), write_id = $3, hlc = $4,
                          updated_at = transaction_timestamp()
                    where role_id = $1 and permission_code = any($2::text[]) and deleted_at is null`,
                  [input.roleId, [...codes], input.idempotencyKey, ctx.deps.clock.next()],
                );
              }
              for (const p of added) {
                await atx.query(
                  `insert into app.role_permission (tenant_id, id, write_id, hlc, role_id, permission_code, bound)
                   values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
                  [
                    ctx.identity.tenantId, deterministicUuid(input.roleId, p.code, input.idempotencyKey),
                    input.idempotencyKey, ctx.deps.clock.next(), input.roleId, p.code,
                    p.bound ? JSON.stringify(p.bound) : null,
                  ],
                );
              }
            }
            await audit(ctx, atx, input.idempotencyKey, {
              action: 'role.update',
              permissionUsed: 'admin.role.manage',
              subjectTable: 'role',
              subjectId: input.roleId,
              before: { name: role.name, permissions: current.map((p) => p.code) },
              after: {
                name: input.name ?? role.name,
                added: added.map((a) => a.code),
                removed,
              },
            });
          },
        };
      });
      return { roleId: input.roleId };
    }),

    delete: adminProcedure.input(deleteRoleInput).mutation(async ({ ctx, input }) => {
      ctx.permissions.requireTenantWide('admin.role.manage');
      await runIdempotent<JsonValue>(pipelineDeps(ctx), ctx.identity, envelope('admin.role.delete', input), input, async (tx) => {
        const found = await tx.query<{ name: string; is_owner: boolean }>(
          `select name, is_owner from app.role where id = $1 and deleted_at is null`,
          [input.roleId],
        );
        const role = found.rows[0];
        if (!role) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such role' });
        if (role.is_owner) forbid(ESCALATION, 'the owner role cannot be deleted');
        const live = await tx.query(
          `select 1 from app.user_role_assignment where role_id = $1 and deleted_at is null
              and (effective_to is null or effective_to > transaction_timestamp()) limit 1`,
          [input.roleId],
        );
        if (live.rows.length > 0) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'end every assignment of this role before deleting it' });
        }
        return {
          response: { roleId: input.roleId },
          apply: async (atx) => {
            await atx.query(
              `update app.role set deleted_at = transaction_timestamp(), write_id = $2, hlc = $3,
                      updated_at = transaction_timestamp() where id = $1`,
              [input.roleId, input.idempotencyKey, ctx.deps.clock.next()],
            );
            await audit(ctx, atx, input.idempotencyKey, {
              action: 'role.delete',
              permissionUsed: 'admin.role.manage',
              subjectTable: 'role',
              subjectId: input.roleId,
              before: { name: role.name },
            });
          },
        };
      });
      return { roleId: input.roleId };
    }),
  }),

  // ======================================================================
  // Devices (§2.7)
  // ======================================================================

  devices: router({
    /**
     * Devices the caller may administer: all of them with the capability
     * tenant-wide, otherwise those whose ceiling touches a location where the
     * caller holds enrol or revoke.
     */
    list: adminProcedure.query(async ({ ctx }) => {
      const state = ctx.permissions;
      const caps = ['admin.device.enrol', 'admin.device.revoke', 'admin.device.scope.manage'];
      const wide = caps.some((c) => holdsTenantWide(state, c));
      const held = new Set(caps.flatMap((c) => state.locationsFor(c)));
      if (!wide && held.size === 0) forbid(DENY.notHeld, 'a device administration capability is required');
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const devices = await tx.query<{
          id: string;
          label: string;
          form_factor: string;
          status: string;
          retired_reason: string | null;
          retired_at: string | null;
          enrolled_at: string;
          last_authenticated_at: string | null;
          last_seen_at: string | null;
          app_version: string | null;
          open_sessions: number;
        }>(
          `select d.id, d.label, d.form_factor, d.status, d.retired_reason, d.retired_at::text,
                  d.enrolled_at::text, d.last_authenticated_at::text, d.last_seen_at::text, d.app_version,
                  (select count(*)::int from app.device_session s
                    where s.device_id = d.id and s.revoked_at is null
                      and s.expires_at > transaction_timestamp()) as open_sessions
             from app.device d order by d.status, d.label`,
        );
        const scope = await tx.query<{ device_id: string; location_id: string; name: string }>(
          `select dls.device_id, dls.location_id, l.name
             from app.device_location_scope dls
             join app.location l on l.tenant_id = dls.tenant_id and l.id = dls.location_id
            where dls.deleted_at is null`,
        );
        return devices.rows
          .map((d) => ({
            id: d.id,
            label: d.label,
            formFactor: d.form_factor,
            status: d.status,
            retiredReason: d.retired_reason,
            retiredAt: d.retired_at,
            enrolledAt: d.enrolled_at,
            lastAuthenticatedAt: d.last_authenticated_at,
            lastSeenAt: d.last_seen_at,
            appVersion: d.app_version,
            openSessions: d.open_sessions,
            locations: scope.rows.filter((s) => s.device_id === d.id).map((s) => ({ id: s.location_id, name: s.name })),
          }))
          .filter((d) => wide || d.locations.some((l) => held.has(l.id)));
      });
    }),

    /** Codes issued recently — never the plaintext, which exists only once. */
    codes: adminProcedure.query(async ({ ctx }) => {
      const state = ctx.permissions;
      if (!state.holdsAnywhere('admin.device.enrol')) forbid(DENY.notHeld, 'admin.device.enrol is required');
      return ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) => {
        const r = await tx.query<{
          id: string;
          label: string;
          form_factor: string;
          location_id: string | null;
          expires_at: string;
          consumed_at: string | null;
          outcome: string | null;
          device_id: string | null;
          created_at: string;
        }>(
          `select id, label, form_factor, location_id, expires_at::text, consumed_at::text, outcome, device_id,
                  created_at::text
             from app.device_enrolment_code
            where created_at > transaction_timestamp() - interval '7 days'
            order by created_at desc limit 100`,
        );
        return r.rows
          .filter((c) => (c.location_id === null ? holdsTenantWide(state, 'admin.device.enrol') : state.holdsAt('admin.device.enrol', c.location_id)))
          .map((c) => ({
            id: c.id,
            label: c.label,
            formFactor: c.form_factor,
            locationId: c.location_id,
            expiresAt: c.expires_at,
            consumedAt: c.consumed_at,
            outcome: c.outcome,
            deviceId: c.device_id,
            createdAt: c.created_at,
          }));
      });
    }),

    /**
     * Issue a one-time enrolment code (§2.7): 8 Crockford base32 characters,
     * 15-minute TTL, single use, bound to this tenant and the location named.
     * The plaintext is returned ONCE, in this response, and stored nowhere.
     */
    issueCode: adminProcedure.input(issueEnrolmentCodeInput).mutation(async ({ ctx, input }) => {
      requireAtOrTenant(ctx.permissions, 'admin.device.enrol', input.locationId);
      // A replay of this request must not hand out a second code — and cannot
      // hand back the first, which was never stored. So the code is derived
      // from nothing replayable: a replay returns the code id and expiry with
      // the plaintext withheld, and the screen says to issue a fresh one.
      const code = generateEnrolmentCode();
      const codeHash = hashEnrolmentCode(code);
      const result = await runIdempotent<JsonValue>(
        pipelineDeps(ctx),
        ctx.identity,
        envelope('admin.device.issue_code', input),
        input,
        async (tx) => {
          if (input.locationId !== null) {
            const loc = await tx.query<{ kind: string }>(
              `select kind from app.location where id = $1 and deleted_at is null and is_active`,
              [input.locationId],
            );
            if (!loc.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such active location' });
            if (loc.rows[0].kind === 'TRANSIT') {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'a device is never homed at a TRANSIT node — choose its outlet' });
            }
          }
          const codeId = deterministicUuid(input.idempotencyKey, 'enrolment_code');
          const expires = await tx.query<{ at: string }>(
            `select (transaction_timestamp() + ($1 || ' seconds')::interval)::text as at`,
            [String(ENROLMENT_CODE_TTL_S)],
          );
          const expiresAt = expires.rows[0]!.at;
          return {
            response: { codeId, expiresAt },
            apply: async (atx) => {
              await atx.query(
                `insert into app.device_enrolment_code
                   (tenant_id, id, write_id, hlc, code_hash, location_id, label, form_factor, issued_by, expires_at)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)`,
                [
                  ctx.identity.tenantId, codeId, input.idempotencyKey, ctx.deps.clock.next(), codeHash,
                  input.locationId, input.label, input.formFactor, ctx.identity.userId, expiresAt,
                ],
              );
              await atx.query(`select platform.publish_enrolment_code($1, $2)`, [codeHash, codeId]);
              await audit(ctx, atx, input.idempotencyKey, {
                action: 'enrolment_code.issue',
                permissionUsed: 'admin.device.enrol',
                subjectTable: 'device_enrolment_code',
                subjectId: codeId,
                after: { label: input.label, formFactor: input.formFactor, locationId: input.locationId, expiresAt },
              });
            },
          };
        },
      );
      const response = result.response as { codeId: string; expiresAt: string };
      return {
        codeId: response.codeId,
        expiresAt: response.expiresAt,
        /** Null on a replay: the plaintext existed once and was not stored. */
        code: result.replayed ? null : displayEnrolmentCode(code),
      };
    }),

    /**
     * Revoke (retire) a device. Terminal. `stolen` closes the drain window to
     * zero — wipe on contact. Every session on the device is revoked now; the
     * sync projections drop the device in this same transaction (0024), which
     * is what stops the stream (§2.7 mechanism 1); the API answers 423 from the
     * next request (mechanism 2).
     */
    revoke: adminProcedure.input(revokeDeviceInput).mutation(async ({ ctx, input }) => {
      await deviceAct(ctx, input.deviceId, 'admin.device.revoke');
      await runIdempotent<JsonValue>(pipelineDeps(ctx), ctx.identity, envelope('admin.device.revoke', input), input, async (tx) => {
        const found = await tx.query<{ status: string; label: string }>(`select status, label from app.device where id = $1`, [input.deviceId]);
        const d = found.rows[0];
        if (!d) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such device' });
        if (d.status === 'retired') throw new TRPCError({ code: 'CONFLICT', message: 'that device is already revoked' });
        return {
          response: { deviceId: input.deviceId, status: 'retired' },
          apply: async (atx) => {
            await atx.query(
              `update app.device set status = 'retired', retired_reason = $2, retired_by = $3,
                      retired_at = transaction_timestamp(), write_id = $4, hlc = $5,
                      updated_at = transaction_timestamp()
                where id = $1`,
              [input.deviceId, input.reason, ctx.identity.userId, input.idempotencyKey, ctx.deps.clock.next()],
            );
            await atx.query(
              `update app.device_session set revoked_at = transaction_timestamp(), revoked_reason = 'device_retired',
                      updated_at = transaction_timestamp()
                where device_id = $1 and revoked_at is null`,
              [input.deviceId],
            );
            await audit(ctx, atx, input.idempotencyKey, {
              action: 'device.revoke',
              permissionUsed: 'admin.device.revoke',
              subjectTable: 'device',
              subjectId: input.deviceId,
              before: { status: d.status, label: d.label },
              after: { status: 'retired' },
              reasonCode: input.reason,
              reasonNote: input.note ?? null,
            });
          },
        };
      });
      ctx.identityService?.forgetDevice(ctx.identity.tenantId, input.deviceId);
      return { deviceId: input.deviceId, status: 'retired' as const };
    }),

    setStatus: adminProcedure.input(setDeviceStatusInput).mutation(async ({ ctx, input }) => {
      await deviceAct(ctx, input.deviceId, 'admin.device.revoke');
      await runIdempotent<JsonValue>(pipelineDeps(ctx), ctx.identity, envelope('admin.device.set_status', input), input, async (tx) => {
        const found = await tx.query<{ status: string }>(`select status from app.device where id = $1`, [input.deviceId]);
        const d = found.rows[0];
        if (!d) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such device' });
        if (d.status === 'retired') throw new TRPCError({ code: 'CONFLICT', message: 'a revoked device stays revoked — enrol it again' });
        return {
          response: { deviceId: input.deviceId, status: input.status },
          apply: async (atx) => {
            await atx.query(
              `update app.device set status = $2, write_id = $3, hlc = $4, updated_at = transaction_timestamp()
                where id = $1`,
              [input.deviceId, input.status, input.idempotencyKey, ctx.deps.clock.next()],
            );
            await audit(ctx, atx, input.idempotencyKey, {
              action: 'device.set_status',
              permissionUsed: 'admin.device.revoke',
              subjectTable: 'device',
              subjectId: input.deviceId,
              before: { status: d.status },
              after: { status: input.status },
              reasonNote: input.note ?? null,
            });
          },
        };
      });
      ctx.identityService?.forgetDevice(ctx.identity.tenantId, input.deviceId);
      return { deviceId: input.deviceId, status: input.status };
    }),

    /**
     * Replace a device's ceiling (§2.5). Widening is an audited act on the
     * security report; the caller needs admin.device.scope.manage at every
     * location added AND removed.
     */
    setScope: adminProcedure.input(setDeviceScopeInput).mutation(async ({ ctx, input }) => {
      const state = ctx.permissions;
      await runIdempotent<JsonValue>(pipelineDeps(ctx), ctx.identity, envelope('admin.device.set_scope', input), input, async (tx) => {
        const found = await tx.query<{ status: string }>(`select status from app.device where id = $1`, [input.deviceId]);
        if (!found.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such device' });
        if (found.rows[0].status === 'retired') throw new TRPCError({ code: 'CONFLICT', message: 'a revoked device has no scope to change' });
        const current = (
          await tx.query<{ location_id: string }>(
            `select location_id from app.device_location_scope where device_id = $1 and deleted_at is null`,
            [input.deviceId],
          )
        ).rows.map((r) => r.location_id);
        const wanted = [...new Set(input.locationIds)];
        const added = wanted.filter((l) => !current.includes(l));
        const removed = current.filter((l) => !wanted.includes(l));
        for (const loc of [...added, ...removed]) state.requireAt('admin.device.scope.manage', loc);
        if (added.length > 0) {
          const known = await tx.query<{ id: string; kind: string }>(
            `select id, kind from app.location where id = any($1::uuid[]) and deleted_at is null`,
            [added],
          );
          if (known.rows.length !== added.length) throw new TRPCError({ code: 'NOT_FOUND', message: 'a location does not exist' });
          if (known.rows.some((k) => k.kind === 'TRANSIT')) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'a TRANSIT node comes with its outlet — scope the outlet' });
          }
        }
        return {
          response: { deviceId: input.deviceId, added, removed },
          apply: async (atx) => {
            if (removed.length > 0) {
              await atx.query(
                `update app.device_location_scope
                    set deleted_at = transaction_timestamp(), removed_by = $3, write_id = $4, hlc = $5,
                        updated_at = transaction_timestamp()
                  where device_id = $1 and location_id = any($2::uuid[]) and deleted_at is null`,
                [input.deviceId, removed, ctx.identity.userId, input.idempotencyKey, ctx.deps.clock.next()],
              );
            }
            for (const loc of added) {
              await atx.query(
                `insert into app.device_location_scope (tenant_id, id, write_id, hlc, device_id, location_id, added_by)
                 values ($1,$2,$3,$4,$5,$6,$7)`,
                [
                  ctx.identity.tenantId, uuidv7(), input.idempotencyKey, ctx.deps.clock.next(),
                  input.deviceId, loc, ctx.identity.userId,
                ],
              );
            }
            await audit(ctx, atx, input.idempotencyKey, {
              action: 'device.set_scope',
              permissionUsed: 'admin.device.scope.manage',
              subjectTable: 'device',
              subjectId: input.deviceId,
              before: { locationIds: current },
              after: { locationIds: wanted, added, removed },
            });
          },
        };
      });
      ctx.identityService?.forgetDevice(ctx.identity.tenantId, input.deviceId);
      return { deviceId: input.deviceId };
    }),
  }),
});

/** The caller must hold `code` at EVERY location in the device's ceiling (tenant-wide if it has none). */
async function deviceAct(ctx: AdminCtx, deviceId: string, code: string): Promise<void> {
  const locs = await ctx.deps.runner.withTenant(ctx.identity.tenantId, async (tx) =>
    (
      await tx.query<{ location_id: string }>(
        `select location_id from app.device_location_scope where device_id = $1 and deleted_at is null`,
        [deviceId],
      )
    ).rows.map((r) => r.location_id),
  );
  if (locs.length === 0) ctx.permissions.requireTenantWide(code);
  else for (const l of locs) ctx.permissions.requireAt(code, l);
}

function dedupe<T extends { code: string }>(perms: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const p of perms) seen.set(p.code, p);
  return [...seen.values()];
}

/** Every code must be in platform.permission — a tenant composes, never mints (0005 header). */
async function validateCodes(tx: Queryable, codes: readonly string[]): Promise<void> {
  if (codes.length === 0) return;
  const known = await tx.query<{ code: string }>(`select code from platform.permission where code = any($1::text[])`, [[...new Set(codes)]]);
  const set = new Set(known.rows.map((k) => k.code));
  const unknown = [...new Set(codes)].filter((c) => !set.has(c));
  if (unknown.length > 0) {
    forbid(DENY.unknownCode, `not in the platform catalogue: ${unknown.join(', ')}`);
  }
}
