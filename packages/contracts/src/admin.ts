/**
 * The back-office administration wire: users, role assignments, roles and
 * their permission sets, devices and their enrolment codes (02 §2.4, §2.5,
 * §2.7). Laptop-first screens, tablet-usable — every input is a CONFIGURATION
 * write made online, never a trade write, and every one carries the mutation
 * envelope so a double-tap on a slow link is a replay, not a second act.
 *
 * Rules carried here, so they are compile errors rather than review comments:
 *   · no tenant field anywhere — the tenant is the caller's verified token;
 *   · no password, PIN or TOTP field — the IdP holds credentials (§2.2); a
 *     user is linked to an IdP SUBJECT, never given a secret here;
 *   · role NAMES are tenant data and travel as free text, never as an enum;
 *     permission CODES are platform vocabulary and are validated server-side
 *     against platform.permission, never trusted from here.
 */
import { z } from 'zod';
import { DEVICE_FORM_FACTORS, DEVICE_RETIRED_REASONS } from './identity.js';
import { mutationEnvelope, zUuid } from './wire.js';

const isoInstant = z.string().datetime({ offset: true });
const permissionCode = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

// ---- users -----------------------------------------------------------------

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DISABLED'] as const;

export const createUserInput = z
  .object({
    ...mutationEnvelope,
    username: z.string().trim().min(2).max(64).regex(/^[a-z0-9._-]+$/i),
    displayName: z.string().trim().min(1).max(120),
    /** The IdP subject this user signs in as. Optional: link later. */
    subjectRef: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
export type CreateUserInput = z.input<typeof createUserInput>;

export const updateUserInput = z
  .object({
    ...mutationEnvelope,
    userId: zUuid,
    displayName: z.string().trim().min(1).max(120).optional(),
    /** Link, re-link (null = unlink) the IdP subject. */
    subjectRef: z.string().trim().min(1).max(255).nullable().optional(),
  })
  .strict();
export type UpdateUserInput = z.input<typeof updateUserInput>;

export const setUserStatusInput = z
  .object({
    ...mutationEnvelope,
    userId: zUuid,
    status: z.enum(USER_STATUSES),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type SetUserStatusInput = z.input<typeof setUserStatusInput>;

export const assignRoleInput = z
  .object({
    ...mutationEnvelope,
    userId: zUuid,
    roleId: zUuid,
    /** Any node in the tenant's location tree — an outlet, a region, the root. */
    scopeLocationId: zUuid,
    effectiveFrom: isoInstant.optional(),
    effectiveTo: isoInstant.nullable().optional(),
  })
  .strict();
export type AssignRoleInput = z.input<typeof assignRoleInput>;

export const endAssignmentInput = z
  .object({
    ...mutationEnvelope,
    assignmentId: zUuid,
    /** Default: now. A future instant schedules the end (swept by the reconciler). */
    effectiveTo: isoInstant.optional(),
  })
  .strict();
export type EndAssignmentInput = z.input<typeof endAssignmentInput>;

// ---- roles -----------------------------------------------------------------

/** A bound is tenant data: money members are DECIMAL STRINGS (ADR-0004). */
export const roleBound = z.record(z.union([z.string(), z.number().int(), z.boolean()]));

export const rolePermissionInput = z
  .object({ code: permissionCode, bound: roleBound.nullable().optional() })
  .strict();

export const createRoleInput = z
  .object({
    ...mutationEnvelope,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    permissions: z.array(rolePermissionInput).max(200),
  })
  .strict();
export type CreateRoleInput = z.input<typeof createRoleInput>;

export const updateRoleInput = z
  .object({
    ...mutationEnvelope,
    roleId: zUuid,
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    /** When present, REPLACES the role's permission set. */
    permissions: z.array(rolePermissionInput).max(200).optional(),
  })
  .strict();
export type UpdateRoleInput = z.input<typeof updateRoleInput>;

export const deleteRoleInput = z.object({ ...mutationEnvelope, roleId: zUuid }).strict();
export type DeleteRoleInput = z.input<typeof deleteRoleInput>;

// ---- devices ---------------------------------------------------------------

export const issueEnrolmentCodeInput = z
  .object({
    ...mutationEnvelope,
    label: z.string().trim().min(1).max(80),
    formFactor: z.enum(DEVICE_FORM_FACTORS),
    /**
     * The device's home location — seeds its ceiling. NULL is deliberate and
     * visible: a back-office laptop with an EMPTY ceiling, which syncs nothing
     * and works online (02 §2.5).
     */
    locationId: zUuid.nullable(),
  })
  .strict();
export type IssueEnrolmentCodeInput = z.input<typeof issueEnrolmentCodeInput>;

export const revokeDeviceInput = z
  .object({
    ...mutationEnvelope,
    deviceId: zUuid,
    reason: z.enum(DEVICE_RETIRED_REASONS),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type RevokeDeviceInput = z.input<typeof revokeDeviceInput>;

export const setDeviceStatusInput = z
  .object({
    ...mutationEnvelope,
    deviceId: zUuid,
    /** Suspend is reversible; retirement is `revoke`, and terminal. */
    status: z.enum(['active', 'suspended']),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type SetDeviceStatusInput = z.input<typeof setDeviceStatusInput>;

export const setDeviceScopeInput = z
  .object({
    ...mutationEnvelope,
    deviceId: zUuid,
    /** REPLACES the device's ceiling. Empty = syncs nothing. */
    locationIds: z.array(zUuid).max(50),
  })
  .strict();
export type SetDeviceScopeInput = z.input<typeof setDeviceScopeInput>;
