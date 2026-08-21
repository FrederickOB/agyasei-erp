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

export interface ApiHarness {
  db: TestDb;
  deps: ApiDeps;
  policyStore: CreditPolicyStore;
  /** Build a verified identity by actually signing and verifying a JWT. */
  identityFor(
    tenantId: string,
    opts?: { locs?: string[]; role?: string; operator?: boolean; uid?: string; dev?: string },
  ): Promise<VerifiedIdentity>;
  callerFor(identity: VerifiedIdentity): ReturnType<typeof makeCaller>;
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

  async function identityFor(
    tenantId: string,
    opts: { locs?: string[]; role?: string; operator?: boolean; uid?: string; dev?: string } = {},
  ): Promise<VerifiedIdentity> {
    const token = await signDevToken(JWT_SECRET, {
      tid: tenantId,
      uid: opts.uid ?? uuidv7(),
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
    const identity = await identityFor(tenantId, { role: 'onboarding' });
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
