/**
 * Shared test harness: real Postgres (PGlite) via @erp/db's testing
 * harness, the Ghana pack seeded, and the API exercised through its actual
 * surface — verified JWTs, tRPC callers, the idempotent pipeline. Nothing
 * here shortcuts RLS: every tenant-scoped statement runs as app_user with
 * the tenant GUC set by the harness's withTenant.
 */
import { createHlcClock, hlcNodeFromName, uuidv7 } from '@erp/db';
import { seedGhanaJurisdiction } from '@erp/db/seed';
import { createTestDb, type Queryable, type TestDb } from '@erp/db/testing';
import { signDevToken, verifyToken, type VerifiedIdentity } from '../src/auth.js';
import { createMemoryPolicyStore, type CreditPolicyStore } from '../src/credit-policy.js';
import { adminRunnerFrom } from '../src/db.js';
import { appRouter } from '../src/routers/index.js';
import { createCallerFactory, type ApiDeps, type Context } from '../src/trpc.js';

export const JWT_SECRET = 'test-secret-not-for-production';

const makeCaller = createCallerFactory(appRouter);

/**
 * How a test identity is provisioned in the RBAC tables.
 *
 * `'owner'` (the default) gives the identity a user account and the tenant's
 * OWNER role at the root of its location tree, so a test written about
 * pricing, idempotency or tax is not implicitly also a test about
 * authorisation. Every test that IS about authorisation asks for `'none'`
 * and builds the exact principal it means (see `principal()` below).
 */
export type IdentityGrant = 'owner' | 'none';

export interface IdentityOptions {
  locs?: string[];
  /** The token's opaque `role` label. The platform never branches on it. */
  role?: string;
  operator?: boolean;
  uid?: string;
  dev?: string;
  grant?: IdentityGrant;
}

/** A principal built from one of the template's roles, at one scope node. */
export interface PrincipalOptions {
  /** Template role provenance ref: 'counter_staff', 'accounts', … */
  roleRef: string;
  /** Node the role is held at. Defaults to the tenant root. */
  scopeLocationId?: string;
  /** Token `locs`. Defaults to the scope node's closure descendants. */
  locs?: string[];
  uid?: string;
}

export interface ApiHarness {
  db: TestDb;
  deps: ApiDeps;
  policyStore: CreditPolicyStore;
  /** Build a verified identity by actually signing and verifying a JWT. */
  identityFor(tenantId: string, opts?: IdentityOptions): Promise<VerifiedIdentity>;
  callerFor(identity: VerifiedIdentity): ReturnType<typeof makeCaller>;
  /** The tenant's root location node, creating one if the tenant has none. */
  rootLocation(tenantId: string): Promise<string>;
  /** Give `userId` the tenant's owner role at the root. Idempotent. */
  grantOwner(tenantId: string, userId: string): Promise<void>;
  /**
   * Give `userId` a TEMPLATE role at a scope node, returning the assignment
   * id (`app.user_role_assignment.id` — what an audit row's grant_id names).
   */
  grantRole(
    tenantId: string,
    userId: string,
    roleRef: string,
    scopeLocationId: string,
  ): Promise<string>;
  /** A verified identity holding exactly one template role at one node. */
  principal(tenantId: string, opts: PrincipalOptions): Promise<VerifiedIdentity>;
  /** Soft-delete every role assignment this user holds. The revocation path. */
  revokeAssignments(tenantId: string, userId: string): Promise<void>;
  /** Remove one permission code from a template role. Tenant-editable data. */
  revokePermissionFromRole(tenantId: string, roleRef: string, code: string): Promise<void>;
  /** Locations by `app.location.code` — 'ROOT', 'REG-BONO', 'OUT-01', … */
  locationByCode(tenantId: string, code: string): Promise<string>;
  /** The first `n` OUTLET leaves, ordered by code. */
  outlets(tenantId: string, n: number): Promise<{ id: string; code: string }[]>;
  /** Provision an ACTIVE tenant through the API's operator plane. */
  provisionTenant(slug: string): Promise<string>;
  /** Apply the construction-materials-gh template (and pilot locations). */
  applyTemplate(tenantId: string, includePilotLocations?: boolean): Promise<void>;
  firstOutlet(tenantId: string): Promise<{ id: string; code: string }>;
  /** A STOCKED, sellable product whose default sell unit is its stocking unit. */
  pickProduct(tenantId: string): Promise<{
    id: string;
    skuCode: string;
    uomId: string;
    uomCode: string;
    qtyScale: number;
  }>;
  /** Seed a WHOLESALE (tax-exclusive) price for a product's default sell unit. */
  seedWholesalePrice(
    tenantId: string,
    productId: string,
    unitPriceE4: bigint,
    effectiveFrom?: string,
  ): Promise<void>;
  close(): Promise<void>;
}

export async function createApiHarness(): Promise<ApiHarness> {
  const db = await createTestDb();
  await db.asAdmin((tx) => seedGhanaJurisdiction(tx));

  const policyStore = createMemoryPolicyStore();
  const deps: ApiDeps = {
    runner: db,
    admin: adminRunnerFrom(db),
    clock: createHlcClock(hlcNodeFromName('api-test-node')),
    policyStore,
  };

  // -------------------------------------------------------------------------
  // RBAC fixtures
  //
  // Permissions are resolved SERVER-SIDE from app.user_role_assignment on
  // every request (apps/api/src/permissions.ts), so a signed token on its own
  // authorises nothing at all. These helpers put the rows in place, through
  // the tenant's own RLS context, exactly as an onboarding flow would.
  // -------------------------------------------------------------------------

  async function writeMarker(tx: Queryable, tenantId: string, op: string): Promise<string> {
    return serverWrite(tx, tenantId, op);
  }

  async function rootLocation(tenantId: string): Promise<string> {
    return db.withTenant(tenantId, async (tx) => {
      const found = await tx.query<{ id: string }>(
        `select id from app.location where parent_id is null and deleted_at is null
         order by code limit 1`,
      );
      if (found.rows[0]) return found.rows[0].id;
      // A tenant whose template was applied without the pilot location tree
      // still needs a node to hold a tenant-wide grant at. Onboarding would
      // create one; here the harness does.
      const id = uuidv7();
      const writeId = await writeMarker(tx, tenantId, 'test.harness_root_location');
      await tx.query(
        `insert into app.location
           (tenant_id, id, write_id, hlc, code, name, kind, parent_id, is_active, timezone)
         values ($1,$2,$3,$4,'HARNESS-ROOT','Harness root','GROUP',null,true,'Africa/Accra')`,
        [tenantId, id, writeId, deps.clock.next()],
      );
      return id;
    });
  }

  async function ensureUserAccount(tenantId: string, userId: string): Promise<void> {
    await db.withTenant(tenantId, async (tx) => {
      const found = await tx.query<{ id: string }>(
        `select id from app.user_account where id = $1`,
        [userId],
      );
      if (found.rows[0]) return;
      const writeId = await writeMarker(tx, tenantId, 'test.harness_user');
      await tx.query(
        `insert into app.user_account
           (tenant_id, id, write_id, hlc, username, display_name, status)
         values ($1,$2,$3,$4,$5,$6,'ACTIVE')`,
        [tenantId, userId, writeId, deps.clock.next(), `u-${userId}`, 'Test user'],
      );
    });
  }

  async function ownerRoleId(tenantId: string): Promise<string> {
    return db.withTenant(tenantId, async (tx) => {
      const found = await tx.query<{ id: string }>(
        `select id from app.role where is_owner and deleted_at is null limit 1`,
      );
      if (found.rows[0]) return found.rows[0].id;
      const id = uuidv7();
      const writeId = await writeMarker(tx, tenantId, 'test.harness_owner_role');
      await tx.query(
        `insert into app.role (tenant_id, id, write_id, hlc, name, description, is_owner)
         values ($1,$2,$3,$4,'Owner (harness)','Holds the whole catalogue by construction',true)`,
        [tenantId, id, writeId, deps.clock.next()],
      );
      return id;
    });
  }

  async function assign(
    tenantId: string,
    userId: string,
    roleId: string,
    scopeLocationId: string,
  ): Promise<string> {
    await ensureUserAccount(tenantId, userId);
    return db.withTenant(tenantId, async (tx) => {
      const existing = await tx.query<{ id: string }>(
        `select id from app.user_role_assignment
         where user_id = $1 and role_id = $2 and scope_location_id = $3 and deleted_at is null`,
        [userId, roleId, scopeLocationId],
      );
      if (existing.rows[0]) return existing.rows[0].id;
      const id = uuidv7();
      const writeId = await writeMarker(tx, tenantId, 'test.harness_role_assignment');
      await tx.query(
        `insert into app.user_role_assignment
           (tenant_id, id, write_id, hlc, user_id, role_id, scope_location_id)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [tenantId, id, writeId, deps.clock.next(), userId, roleId, scopeLocationId],
      );
      return id;
    });
  }

  async function grantOwner(tenantId: string, userId: string): Promise<void> {
    const root = await rootLocation(tenantId);
    const roleId = await ownerRoleId(tenantId);
    await assign(tenantId, userId, roleId, root);
  }

  /**
   * Roles are found by ORIGIN_REF, never by name. `app.role.name` is the
   * tenant's word for the tenant's job and no code — test code included —
   * should key off it; origin_ref is template provenance and stable.
   */
  async function roleIdByRef(tenantId: string, roleRef: string): Promise<string> {
    return db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{ id: string }>(
        `select id from app.role where origin_ref = $1 and deleted_at is null`,
        [`role:${roleRef}`],
      );
      const id = res.rows[0]?.id;
      if (!id) throw new Error(`no template role '${roleRef}' — was the template applied?`);
      return id;
    });
  }

  async function grantRole(
    tenantId: string,
    userId: string,
    roleRef: string,
    scopeLocationId: string,
  ): Promise<string> {
    return assign(tenantId, userId, await roleIdByRef(tenantId, roleRef), scopeLocationId);
  }

  async function scopeDescendants(tenantId: string, scopeLocationId: string): Promise<string[]> {
    return db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{ descendant_id: string }>(
        `select descendant_id from app.location_closure where ancestor_id = $1 order by depth`,
        [scopeLocationId],
      );
      return res.rows.map((r) => r.descendant_id);
    });
  }

  async function principal(tenantId: string, opts: PrincipalOptions): Promise<VerifiedIdentity> {
    const uid = opts.uid ?? uuidv7();
    const scope = opts.scopeLocationId ?? (await rootLocation(tenantId));
    await grantRole(tenantId, uid, opts.roleRef, scope);
    const locs = opts.locs ?? (await scopeDescendants(tenantId, scope));
    return identityFor(tenantId, {
      uid,
      locs,
      // A deliberately WRONG-LOOKING label: nothing on the platform reads it,
      // and a test passing here would prove the opposite of what it claims.
      role: 'opaque-label-nothing-branches-on',
      grant: 'none',
    });
  }

  async function revokeAssignments(tenantId: string, userId: string): Promise<void> {
    await db.withTenant(tenantId, async (tx) => {
      await tx.query(
        `update app.user_role_assignment
            set deleted_at = transaction_timestamp()
          where user_id = $1 and deleted_at is null`,
        [userId],
      );
    });
  }

  async function revokePermissionFromRole(
    tenantId: string,
    roleRef: string,
    code: string,
  ): Promise<void> {
    const roleId = await roleIdByRef(tenantId, roleRef);
    await db.withTenant(tenantId, async (tx) => {
      await tx.query(
        `update app.role_permission
            set deleted_at = transaction_timestamp()
          where role_id = $1 and permission_code = $2 and deleted_at is null`,
        [roleId, code],
      );
    });
  }

  async function locationByCode(tenantId: string, code: string): Promise<string> {
    return db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{ id: string }>(
        `select id from app.location where code = $1 and deleted_at is null`,
        [code],
      );
      const id = res.rows[0]?.id;
      if (!id) throw new Error(`no location with code ${code}`);
      return id;
    });
  }

  async function outlets(tenantId: string, n: number): Promise<{ id: string; code: string }[]> {
    return db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{ id: string; code: string }>(
        `select id, code from app.location
         where kind = 'OUTLET' and deleted_at is null
         order by code limit $1`,
        [n],
      );
      if (res.rows.length < n) throw new Error(`tenant has fewer than ${n} outlets`);
      return res.rows;
    });
  }

  async function identityFor(
    tenantId: string,
    opts: IdentityOptions = {},
  ): Promise<VerifiedIdentity> {
    const uid = opts.uid ?? uuidv7();
    // Default: a fully-authorised principal, so a test about anything OTHER
    // than authorisation does not silently become a test about it. Tests that
    // are about authorisation pass grant: 'none' and build their own.
    if (!opts.operator && (opts.grant ?? 'owner') === 'owner') {
      await grantOwner(tenantId, uid);
    }
    const token = await signDevToken(JWT_SECRET, {
      tid: tenantId,
      uid,
      role: opts.role ?? 'outlet-staff',
      locs: opts.locs ?? [],
      ...(opts.dev ? { dev: opts.dev } : {}),
      ...(opts.operator ? { platform_operator: true } : {}),
    });
    return verifyToken(JWT_SECRET, token);
  }

  function callerFor(identity: VerifiedIdentity) {
    const ctx: Context = { deps, identity };
    return makeCaller(ctx);
  }

  async function provisionTenant(slug: string): Promise<string> {
    const tenantId = uuidv7();
    const operator = await identityFor(tenantId, { operator: true, role: 'operator' });
    const res = await callerFor(operator).provisioning.createTenant({
      tenantId,
      slug,
      legalName: `${slug} Ltd`,
      jurisdictionCode: 'GH',
    });
    return res.tenantId;
  }

  async function applyTemplateHere(tenantId: string, includePilotLocations = true): Promise<void> {
    // grant: 'none' — the template is what CREATES the tenant's roles and its
    // location tree, so there is nothing to be granted at yet. Onboarding is
    // the bootstrap edge of the RBAC model and provisioning.applyTemplate is
    // deliberately not permission-gated for exactly that reason.
    const identity = await identityFor(tenantId, { role: 'onboarding', grant: 'none' });
    await callerFor(identity).provisioning.applyTemplate({
      template: 'construction-materials-gh',
      includePilotLocations,
    });
  }

  async function firstOutlet(tenantId: string): Promise<{ id: string; code: string }> {
    return db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{ id: string; code: string }>(
        `select id, code from app.location
         where kind = 'OUTLET' and is_active and deleted_at is null
         order by code limit 1`,
      );
      if (!res.rows[0]) throw new Error('no outlet — was the template applied with pilot locations?');
      return res.rows[0];
    });
  }

  async function pickProduct(tenantId: string) {
    return db.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{
        id: string;
        sku_code: string;
        uom_id: string;
        uom_code: string;
        qty_scale: number;
      }>(
        `select p.id, p.sku_code, u.id as uom_id, u.code as uom_code, u.qty_scale
         from app.product p
         join app.product_uom pu
           on pu.tenant_id = p.tenant_id and pu.product_id = p.id and pu.is_default_sell
          and pu.deleted_at is null
         join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = pu.uom_id
         where p.deleted_at is null and p.is_sellable and p.stock_tracking = 'STOCKED'
           and u.qty_scale = 0
         order by p.sku_code limit 1`,
      );
      if (!res.rows[0]) throw new Error('no stocked product found');
      const r = res.rows[0];
      return { id: r.id, skuCode: r.sku_code, uomId: r.uom_id, uomCode: r.uom_code, qtyScale: r.qty_scale };
    });
  }

  async function serverWrite(tx: Queryable, tenantId: string, op: string): Promise<string> {
    const id = uuidv7();
    await tx.query(
      `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
       values ($1, $2, 'SERVER', $3, $4, 1, decode('00', 'hex'))`,
      [tenantId, id, deps.clock.next(), op],
    );
    return id;
  }

  async function seedWholesalePrice(
    tenantId: string,
    productId: string,
    unitPriceE4: bigint,
    effectiveFrom = '2019-01-01',
  ): Promise<void> {
    await db.withTenant(tenantId, async (tx) => {
      const writeId = await serverWrite(tx, tenantId, 'test.price_seed');
      const list = await tx.query<{ id: string }>(
        `select id from app.price_list where code = 'WHOLESALE' and deleted_at is null`,
      );
      if (!list.rows[0]) throw new Error('WHOLESALE price list missing — template not applied?');
      // The template seeds the WHOLESALE price LIST from 2026-08-01 (tenant
      // #1's launch). Tax-boundary and money-property tests sell on earlier
      // business dates, so widen the tenant-owned list's validity back to the
      // item's start — ordinary tenant configuration, done under the tenant's
      // own RLS context (price_list is editable; only ledgers are append-only).
      await tx.query(
        `update app.price_list set effective_from = least(effective_from, $1::date) where id = $2`,
        [effectiveFrom, list.rows[0].id],
      );
      const uom = await tx.query<{ uom_id: string }>(
        `select uom_id from app.product_uom
         where product_id = $1 and is_default_sell and deleted_at is null`,
        [productId],
      );
      if (!uom.rows[0]) throw new Error('product has no default sell unit');
      await tx.query(
        `insert into app.price_list_item
           (tenant_id, id, write_id, hlc, price_list_id, product_id, uom_id,
            unit_price_e4, min_qty, effective_from)
         values ($1,$2,$3,$4,$5,$6,$7,$8,0,$9::date)`,
        [
          tenantId,
          uuidv7(),
          writeId,
          deps.clock.next(),
          list.rows[0].id,
          productId,
          uom.rows[0].uom_id,
          unitPriceE4.toString(10),
          effectiveFrom,
        ],
      );
    });
  }

  return {
    db,
    deps,
    policyStore,
    identityFor,
    callerFor,
    provisionTenant,
    applyTemplate: applyTemplateHere,
    firstOutlet,
    pickProduct,
    seedWholesalePrice,
    rootLocation,
    grantOwner,
    grantRole,
    principal,
    revokeAssignments,
    revokePermissionFromRole,
    locationByCode,
    outlets,
    close: () => db.close(),
  };
}

/** Deterministic PRNG (mulberry32) for reproducible property tests. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
