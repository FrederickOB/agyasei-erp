/**
 * Server-side truth: direct queries against the REAL dev-stack Postgres.
 *
 * Every tenant-scoped read/write here runs as `app_user` with the tenant GUC
 * set inside one transaction — RLS genuinely applies, the same shape as the
 * API's TenantRunner and the bootstrap's withTenant. The admin connection is
 * used ONLY for cross-checks that deliberately bypass tenant scoping is NOT
 * offered: predictions for D5 are tenant-scoped by construction.
 */
import pg from 'pg';
import { createHlcClock, hlcNodeFromName, uuidv7, sha256Hex, type HlcClock } from '@erp/db';
import { DATABASE_URL } from './env.js';

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export class ServerDb {
  private pool: pg.Pool;
  private clock: HlcClock;

  constructor() {
    this.pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    this.clock = createHlcClock(hlcNodeFromName('sync-drills-seed'));
  }

  /** Run fn as app_user with the tenant GUC set — RLS applies for real. */
  async withTenant<T>(tenantId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_user');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await fn({
        query: async (sql, params) => {
          const r = await client.query(sql, params as unknown[]);
          return { rows: r.rows };
        },
      });
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** A STOCKED, sellable product whose default sell unit is its stocking
   *  unit at qty_scale 0 (the same pick rule the API tests use). */
  async pickProduct(tenantId: string): Promise<{ id: string; skuCode: string; uomId: string }> {
    return this.withTenant(tenantId, async (tx) => {
      const res = await tx.query<{ id: string; sku_code: string; uom_id: string }>(
        `select p.id, p.sku_code, pu.uom_id
           from app.product p
           join app.product_uom pu
             on pu.tenant_id = p.tenant_id and pu.product_id = p.id
            and pu.is_default_sell and pu.deleted_at is null
           join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = pu.uom_id
          where p.deleted_at is null and p.is_sellable and p.stock_tracking = 'STOCKED'
            and u.qty_scale = 0 and pu.uom_id = p.stocking_uom_id
          order by p.sku_code limit 1`,
      );
      const row = res.rows[0];
      if (!row) throw new Error(`no stocked qty_scale-0 product for tenant ${tenantId}`);
      return { id: row.id, skuCode: row.sku_code, uomId: row.uom_id };
    });
  }

  /**
   * Seed a WHOLESALE price for a product (dev seed — there is deliberately
   * no price mutation API yet, so this mirrors apps/api/test/util.ts
   * seedWholesalePrice: a SERVER-origin write_log row first, then the item,
   * all under the tenant's own RLS context). Idempotent across drill runs.
   */
  async seedWholesalePrice(tenantId: string, productId: string, unitPriceE4: bigint): Promise<void> {
    await this.withTenant(tenantId, async (tx) => {
      const list = await tx.query<{ id: string }>(
        `select id from app.price_list where code = 'WHOLESALE' and deleted_at is null`,
      );
      const listId = list.rows[0]?.id;
      if (!listId) throw new Error('WHOLESALE price list missing — template not applied?');
      const uom = await tx.query<{ uom_id: string }>(
        `select uom_id from app.product_uom
          where product_id = $1 and is_default_sell and deleted_at is null`,
        [productId],
      );
      const uomId = uom.rows[0]?.uom_id;
      if (!uomId) throw new Error('product has no default sell unit');
      const existing = await tx.query(
        `select 1 from app.price_list_item
          where price_list_id = $1 and product_id = $2 and uom_id = $3 and deleted_at is null`,
        [listId, productId, uomId],
      );
      if (existing.rows.length > 0) return;

      const writeId = uuidv7();
      await tx.query(
        `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
         values ($1, $2, 'SERVER', $3, 'sync-drills.price_seed', 1, decode($4, 'hex'))`,
        [tenantId, writeId, this.clock.next(), sha256Hex(`sync-drills:price:${tenantId}:${productId}`)],
      );
      await tx.query(
        `insert into app.price_list_item
           (tenant_id, id, write_id, hlc, price_list_id, product_id, uom_id,
            unit_price_e4, min_qty, effective_from)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 0, '2026-08-01'::date)`,
        [tenantId, uuidv7(), writeId, this.clock.next(), listId, productId, uomId, unitPriceE4.toString(10)],
      );
    });
  }

  async locationByCode(tenantId: string, code: string): Promise<string> {
    return this.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `select id from app.location where code = $1 and deleted_at is null`,
        [code],
      );
      const id = r.rows[0]?.id;
      if (!id) throw new Error(`location ${code} not found for tenant ${tenantId}`);
      return id;
    });
  }

  /** Derived on-hand: SUM(qty_delta) over the movement ledger — never a counter. */
  async onHand(tenantId: string, locationId: string, productId: string): Promise<bigint> {
    return this.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ s: string | null }>(
        `select coalesce(sum(qty_delta), 0)::text as s
           from app.stock_movement
          where location_id = $1 and product_id = $2 and deleted_at is null`,
        [locationId, productId],
      );
      return BigInt(r.rows[0]?.s ?? '0');
    });
  }

  async saleOnServer(tenantId: string, saleId: string): Promise<boolean> {
    return this.withTenant(tenantId, async (tx) => {
      const r = await tx.query(`select 1 from app.sale where id = $1`, [saleId]);
      return r.rows.length > 0;
    });
  }

  /** write_log rows for a set of idempotency keys: [key, count] pairs. */
  async writeLogCounts(tenantId: string, keys: string[]): Promise<Map<string, number>> {
    return this.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ id: string; n: string }>(
        `select id, count(*)::text as n from app.write_log
          where id = any($1::uuid[]) group by id`,
        [keys],
      );
      const m = new Map<string, number>();
      for (const k of keys) m.set(k, 0);
      for (const row of r.rows) m.set(row.id, Number(row.n));
      return m;
    });
  }

  async countScoped(tenantId: string, sql: string, params: unknown[] = []): Promise<number> {
    return this.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ n: string }>(sql, params);
      return Number(r.rows[0]?.n ?? '0');
    });
  }

  /**
   * What the sync rules PREDICT a device of (tenant, location) holds, per
   * client table — tenant-scoped queries mirroring each bucket definition in
   * infra/powersync/sync_rules.yaml exactly (including its interim notes).
   */
  async predictDeviceRows(tenantId: string, locationId: string): Promise<Record<string, number>> {
    const refTables = [
      'location', 'location_type', 'unit_of_measure', 'product_category',
      'product', 'product_uom', 'price_list', 'price_list_item', 'movement_reason',
    ];
    const out: Record<string, number> = {};
    for (const t of refTables) {
      out[t] = await this.countScoped(
        tenantId,
        `select count(*)::text as n from app."${t}" where deleted_at is null`,
      );
    }
    out['customer'] = await this.countScoped(
      tenantId,
      `select count(*)::text as n from app.customer where deleted_at is null`,
    );
    out['stock_movement'] = await this.countScoped(
      tenantId,
      `select count(*)::text as n from app.stock_movement
        where location_id = $1 and archived_at is null`,
      [locationId],
    );
    out['sale'] = await this.countScoped(
      tenantId,
      `select count(*)::text as n from app.sale where location_id = $1`,
      [locationId],
    );
    // Interim tenant-scoped buckets (sync_rules.yaml note c): whole tenant.
    out['sale_line'] = await this.countScoped(
      tenantId,
      `select count(*)::text as n from app.sale_line`,
    );
    out['sale_tax_line'] = await this.countScoped(
      tenantId,
      `select count(*)::text as n from app.sale_tax_line`,
    );
    // Jurisdiction pack: platform reference rows for the TENANT's pack —
    // derived from the tenant, exactly like the parameter query.
    const jur = await this.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ code: string }>(
        `select jurisdiction_code as code from platform.tenant where id = app.current_tenant()`,
      );
      const code = r.rows[0]?.code;
      if (!code) throw new Error('tenant jurisdiction unresolved');
      const j = await tx.query<{ n: string }>(
        `select count(*)::text as n from platform.jurisdiction where code = $1`, [code]);
      const tc = await tx.query<{ n: string }>(
        `select count(*)::text as n from platform.tax_code where jurisdiction_code = $1`, [code]);
      const tr = await tx.query<{ n: string }>(
        `select count(*)::text as n from platform.tax_rate where jurisdiction_code = $1`, [code]);
      return { j: Number(j.rows[0]?.n), tc: Number(tc.rows[0]?.n), tr: Number(tr.rows[0]?.n) };
    });
    out['jurisdiction'] = jur.j;
    out['tax_code'] = jur.tc;
    out['tax_rate'] = jur.tr;
    return out;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
