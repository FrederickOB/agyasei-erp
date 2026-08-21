/**
 * PROVISIONING A PRINCIPAL — the step between "a template was applied" and
 * "somebody can actually do something".
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE HAD TO EXIST, AND WHAT ITS ABSENCE COST
 * ═════════════════════════════════════════════════════════════════════════
 * `applyTemplate` seeds a tenant's ROLES and their permission composition,
 * and deliberately seeds no users and no assignments: who works for this
 * tenant, and at which node of their tree, is onboarding input rather than
 * template content (01 §1.6). That separation is right.
 *
 * What it means in practice is blunter than it sounds. The moment the API
 * began resolving permissions from `app.effective_permission` on every
 * write, a freshly-bootstrapped tenant had FIVE roles and ZERO assignments —
 * so every principal on the dev stack, every drill device, and every token
 * `infra/scripts/dev-token.mjs` mints was refused at the first guarded
 * route. The whole Phase 1 acceptance drill suite died at warm-up with
 * `FORBIDDEN: PERMISSION_DENIED: stock.adjust is not held by this user`,
 * while 535 unit tests stayed green — because the API test harness quietly
 * grants every identity the owner role by default.
 *
 * There is no `admin.user.manage` endpoint yet, so there is no production
 * caller to point at. This helper is the shape that endpoint will have:
 * write-spine row first, then the account, then the assignment at a scope
 * node, all inside the caller's tenant RLS context. Fixtures use it today;
 * the onboarding handler calls it tomorrow, and the SQL only ever gets
 * written once.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT THIS DOES NOT DO
 * ═════════════════════════════════════════════════════════════════════════
 * No password, no PIN, no key material — those belong to the auth service
 * and the device (02 §2.7), and `app.user_account` has no column for them.
 * This establishes IDENTITY and AUTHORITY, nothing else.
 *
 * It also does not decide WHICH role anyone should hold. `roleRef` is
 * template provenance (`app.role.origin_ref`), never `app.role.name` — the
 * name is the tenant's word for the tenant's job and no code, fixture code
 * included, may key off it (CLAUDE.md §2.9).
 */
import { createHlcClock, hlcNodeFromName } from '../hlc.js';
import { deterministicUuid, sha256Hex } from '../ids.js';
import type { Queryable } from '../testing/harness.js';

const PROVISION_NS = 'onboarding-principal';
const hlcClock = createHlcClock(hlcNodeFromName(PROVISION_NS));

export interface ProvisionPrincipalInput {
  /** The token's `uid` claim. Caller-chosen so a fixture can be deterministic. */
  userId: string;
  /** Tenant-unique login handle. Defaults to a handle derived from `userId`. */
  username?: string;
  displayName?: string;
  /**
   * Template provenance of the role to grant — 'counter_staff',
   * 'outlet_manager', 'regional_manager', 'head_of_operations', 'accounts'.
   * Resolved against `app.role.origin_ref`, NEVER against `app.role.name`.
   *
   * Omit to grant whichever role the tenant marks `is_owner`.
   */
  roleRef?: string;
  /**
   * The node the role is held AT. Grants expand DOWN the closure, so a leaf
   * gives one location and the root gives the whole tenant. Defaults to the
   * tenant's root node.
   */
  scopeLocationId?: string;
}

export interface ProvisionedPrincipal {
  userId: string;
  roleId: string;
  scopeLocationId: string;
  /** `app.user_role_assignment.id` — what an audit row's grant_id names. */
  assignmentId: string;
  /** Every location the grant reaches, via the closure. The token's `locs`. */
  locationIds: string[];
}

async function writeSpineRow(tx: Queryable, tenantId: string, ref: string): Promise<string> {
  const writeId = deterministicUuid(tenantId, PROVISION_NS, 'write', ref);
  await tx.query(
    `insert into app.write_log
       (tenant_id, id, origin, hlc, claimed_hlc, device_id, user_id, location_id,
        op, schema_version, request_hash, response_body)
     values ($1, $2, 'SERVER', $3, null, null, null, null,
             'onboarding.provision_principal', 1, decode($4, 'hex'), null)
     on conflict (tenant_id, id) do nothing`,
    [tenantId, writeId, hlcClock.next(), sha256Hex(`${PROVISION_NS}:${tenantId}:${ref}`)],
  );
  return writeId;
}

/** The tenant's root location node — the only one with no parent. */
export async function rootLocationId(tx: Queryable, _tenantId: string): Promise<string> {
  const res = await tx.query<{ id: string }>(
    `select id from app.location where parent_id is null and deleted_at is null
     order by code limit 1`,
  );
  const id = res.rows[0]?.id;
  if (!id) {
    throw new Error(
      'tenant has no root location node — apply the location tree before provisioning a principal',
    );
  }
  return id;
}

/**
 * Resolve a role by TEMPLATE PROVENANCE, or the owner role when `roleRef` is
 * omitted. Never by name.
 */
async function resolveRoleId(tx: Queryable, roleRef: string | undefined): Promise<string> {
  if (roleRef === undefined) {
    const owner = await tx.query<{ id: string }>(
      `select id from app.role where is_owner and deleted_at is null order by id limit 1`,
    );
    const id = owner.rows[0]?.id;
    if (!id) throw new Error('tenant has no owner role — was the template applied?');
    return id;
  }
  const res = await tx.query<{ id: string }>(
    `select id from app.role where origin_ref = $1 and deleted_at is null`,
    [`role:${roleRef}`],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error(`no template role '${roleRef}' — was the template applied?`);
  return id;
}

/**
 * Create (or find) the user account and grant it one role at one scope node.
 *
 * Idempotent: re-running produces the same account and the same assignment,
 * so a bootstrap script and a drill harness can both call it without
 * coordinating. Runs entirely inside the caller's transaction, which is
 * expected to already carry the tenant RLS context.
 */
export async function provisionPrincipal(
  tx: Queryable,
  tenantId: string,
  input: ProvisionPrincipalInput,
): Promise<ProvisionedPrincipal> {
  const { userId } = input;
  const scopeLocationId = input.scopeLocationId ?? (await rootLocationId(tx, tenantId));
  const roleId = await resolveRoleId(tx, input.roleRef);

  const existingUser = await tx.query<{ id: string }>(
    `select id from app.user_account where id = $1`,
    [userId],
  );
  if (!existingUser.rows[0]) {
    const writeId = await writeSpineRow(tx, tenantId, `user:${userId}`);
    await tx.query(
      `insert into app.user_account
         (tenant_id, id, write_id, hlc, username, display_name, status)
       values ($1, $2, $3, $4, $5, $6, 'ACTIVE')
       on conflict (tenant_id, id) do nothing`,
      [
        tenantId,
        userId,
        writeId,
        hlcClock.next(),
        input.username ?? `u-${userId}`,
        input.displayName ?? 'Provisioned principal',
      ],
    );
  }

  const existingGrant = await tx.query<{ id: string }>(
    `select id from app.user_role_assignment
      where user_id = $1 and role_id = $2 and scope_location_id = $3 and deleted_at is null`,
    [userId, roleId, scopeLocationId],
  );
  let assignmentId = existingGrant.rows[0]?.id;
  if (!assignmentId) {
    const ref = `grant:${userId}:${roleId}:${scopeLocationId}`;
    const writeId = await writeSpineRow(tx, tenantId, ref);
    assignmentId = deterministicUuid(tenantId, PROVISION_NS, ref);
    await tx.query(
      `insert into app.user_role_assignment
         (tenant_id, id, write_id, hlc, user_id, role_id, scope_location_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (tenant_id, id) do nothing`,
      [tenantId, assignmentId, writeId, hlcClock.next(), userId, roleId, scopeLocationId],
    );
  }

  // The closure answers "where does this grant actually reach?" — the same
  // expansion app.effective_permission does, and the right value for a
  // token's `locs` claim.
  const reach = await tx.query<{ descendant_id: string }>(
    `select descendant_id from app.location_closure where ancestor_id = $1 order by depth`,
    [scopeLocationId],
  );

  return {
    userId,
    roleId,
    scopeLocationId,
    assignmentId,
    locationIds: reach.rows.map((r) => r.descendant_id),
  };
}
