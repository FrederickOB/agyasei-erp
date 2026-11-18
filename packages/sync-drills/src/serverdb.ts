/**
 * Server-side truth: direct queries against the REAL dev-stack Postgres.
 *
 * Every tenant-scoped read/write here runs as `app_user` with the tenant GUC
 * set inside one transaction — RLS genuinely applies, the same shape as the
 * API's TenantRunner and the bootstrap's withTenant. The admin connection is
 * used ONLY for cross-checks that deliberately bypass tenant scoping is NOT
 * offered: predictions for D5 are tenant-scoped by construction.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createHlcClock, hlcNodeFromName, uuidv7, sha256Hex, type HlcClock } from '@erp/db';
import { provisionPrincipal } from '@erp/db/seed';
import { DATABASE_URL } from './env.js';

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/**
 * The shape `@erp/db`'s seed helpers take. Structurally the same query
 * function as `Queryable` above, minus the `pg.QueryResultRow` constraint on
 * the row type — so the two are not assignable and an adapter is honest work
 * rather than a cast that hides a real difference.
 */
interface DbQueryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

function asDbQueryable(tx: Queryable): DbQueryable {
  return {
    query: async <T,>(sql: string, params?: unknown[]) => {
      const r = await tx.query(sql, params);
      return { rows: r.rows as T[] };
    },
  };
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

  /**
   * Give a drill device's user an identity and authority in the tenant.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * WHY THE DRILLS NEED THIS, AND WHY IT GRANTS THE OWNER ROLE
   * ═══════════════════════════════════════════════════════════════════════
   * Each DrillDevice mints a fresh random `uid`. The API resolves permissions
   * per request from `app.effective_permission`, so a signed token belonging
   * to nobody authorises nothing: before this existed, every drill died at
   * warm-up with `FORBIDDEN: PERMISSION_DENIED: stock.adjust is not held by
   * this user`, and the unit suites never noticed because the API test
   * harness grants its identities the owner role by default.
   *
   * The role granted is the tenant's OWNER role, at the tenant ROOT, and that
   * is a deliberate statement about what these drills are for: D1-D6 are
   * about SYNC — partitions, conflict reconciliation, idempotent replay,
   * cross-location visibility, tenant isolation on the device — and an
   * authorisation refusal in the middle of one of them would be noise, not a
   * finding. Who may do what is demonstrated where it belongs: over real HTTP
   * in `@erp/wire-conformance`'s RBAC drill, and in the
   * `packages/db` + `apps/api` permission suites.
   *
   * What this does NOT relax is location scope. The device's token still
   * carries only its OWN `locs`, so `assertLocationInScope` constrains every
   * write exactly as before, and D3's cross-location and D5's cross-tenant
   * assertions are untouched — RLS and the tenant GUC are a different control
   * that no role can widen.
   */
  async provisionDevicePrincipal(tenantId: string, userId: string, name: string): Promise<void> {
    await this.withTenant(tenantId, async (tx) => {
      await provisionPrincipal(asDbQueryable(tx), tenantId, {
        userId,
        // The FULL uid is in the handle on purpose. A device NAME repeats
        // every run while its uid does not, and `user_account.username` is
        // unique per tenant, so a fixed handle turns the second run into a
        // duplicate-key crash instead of a drill result. A uuidv7 PREFIX is
        // not enough either: the leading 8 hex characters are the top 32 bits
        // of a 48-bit millisecond timestamp, so two runs inside the same ~65
        // second window share them — which is exactly how this was found.
        username: `drill-${name}-${userId}`,
        displayName: `Drill device ${name}`,
        // roleRef omitted => the tenant's is_owner role. Never resolved by
        // name; `app.role.name` is the tenant's word and nothing reads it.
      });
    });
  }

  /**
   * Enrol a drill device in `app.device`, with its location as its ceiling.
   *
   * Since migration 0024 every sync bucket is keyed on the token's `did` AND
   * `sub` through `app.device_sync_*`: a token whose device is not an ACTIVE
   * row in `app.device` — or whose user's scope does not meet the device's
   * ceiling — receives NOTHING, which is the point (02 §2.3 Contract 1). So a
   * drill device must be a real enrolled device, exactly as a till is. The key
   * is a placeholder: the drills speak the DEV HS256 path, which carries no
   * proof-of-possession; the DPoP path is proven in apps/api's identity suite.
   *
   * Call AFTER the device's principal is provisioned (enrolled_by is that user).
   */
  async enrolDevice(
    tenantId: string,
    d: { deviceId: string; userId: string; name: string; locationId: string },
  ): Promise<void> {
    const jkt = createHash('sha256').update(`drill-device:${d.deviceId}`).digest('base64url');
    await this.withTenant(tenantId, async (tx) => {
      const writeId = uuidv7();
      await tx.query(
        `insert into app.write_log (tenant_id, id, origin, hlc, device_id, user_id, op, schema_version, request_hash)
         values ($1, $2, 'SERVER', $3, $4, $5, 'drill.enrol_device', 1, decode($6, 'hex'))`,
        [tenantId, writeId, this.clock.next(), d.deviceId, d.userId, sha256Hex(`drill.enrol:${d.deviceId}:${writeId}`)],
      );
      await tx.query(
        `insert into app.device (tenant_id, id, write_id, hlc, label, form_factor, public_jwk, jkt, status, enrolled_by)
         values ($1, $2, $3, $4, $5, 'tablet', '{"kty":"EC","crv":"P-256","drill":true}'::jsonb, $6, 'active', $7)
         on conflict do nothing`,
        [tenantId, d.deviceId, writeId, this.clock.next(), `Drill ${d.name}`.slice(0, 80), jkt, d.userId],
      );
      await tx.query(
        `insert into app.device_location_scope (tenant_id, id, write_id, hlc, device_id, location_id, added_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict do nothing`,
        [tenantId, uuidv7(), writeId, this.clock.next(), d.deviceId, d.locationId, d.userId],
      );
    });
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
  async predictDeviceRows(
    tenantId: string,
    locationId: string,
    userId?: string,
  ): Promise<Record<string, number>> {
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

    // ---- The credit slices (migration 0013) --------------------------------
    // The prediction is derived from THE SAME GATE TABLES the parameter
    // queries read, never from "this device probably has the owner role".
    // No userId supplied => predict the fail-closed state (zero), because a
    // device whose user is unknown to the gate receives no bucket at all.
    const creditTables = [
      'customer_account', 'credit_limit_version', 'credit_entry',
      'credit_position_snapshot', 'credit_position_bucket',
    ];
    const inBook =
      userId === undefined
        ? 0
        : await this.countScoped(
            tenantId,
            `select count(*)::text as n from app.credit_sync_book_scope where user_id = $1`,
            [userId],
          );
    if (inBook > 0) {
      out['customer_account'] = await this.countScoped(
        tenantId,
        `select count(*)::text as n from app.customer_account
          where deleted_at is null and archived_at is null`,
      );
      out['credit_limit_version'] = await this.countScoped(
        tenantId,
        `select count(*)::text as n from app.credit_limit_version`,
      );
      out['credit_entry'] = await this.countScoped(
        tenantId,
        `select count(*)::text as n from app.credit_entry where archived_at is null`,
      );
      out['credit_position_snapshot'] = await this.countScoped(
        tenantId,
        `select count(*)::text as n from app.credit_position_snapshot`,
      );
      out['credit_position_bucket'] = await this.countScoped(
        tenantId,
        `select count(*)::text as n from app.credit_position_bucket`,
      );
    } else {
      for (const t of creditTables) out[t] = 0;
    }

    // The counter's slice is keyed (tenant, location) and gated on
    // sale.record.credit AT THAT LOCATION, intersected with location scope.
    const locScope =
      userId === undefined
        ? []
        : await this.locationScopeFor(tenantId, userId);
    if (locScope.length === 0) {
      out['credit_allowance'] = 0;
    } else {
      out['credit_allowance'] = await this.countScoped(
        tenantId,
        `select count(*)::text as n from app.credit_allowance where location_id = any($1::uuid[])`,
        [locScope],
      );
    }
    return out;
  }

  /** The (tenant, user) rows of the location-scope gate the
   *  `location_credit_allowance` parameter query reads. */
  async locationScopeFor(tenantId: string, userId: string): Promise<string[]> {
    return this.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ location_id: string }>(
        `select location_id from app.credit_sync_location_scope where user_id = $1`,
        [userId],
      );
      return r.rows.map((x) => x.location_id);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // D8 helpers — the credit sync surface (migration 0013)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Provision a device principal holding ONE NAMED TEMPLATE ROLE at ONE scope
   * node — the opposite of `provisionDevicePrincipal`, which grants owner.
   *
   * D8 is about WHO RECEIVES WHAT, so the role and the scope are the variables
   * under test and cannot be widened for convenience. Resolved by template
   * provenance (`app.role.origin_ref`), never by `app.role.name`.
   */
  async provisionRoledPrincipal(
    tenantId: string,
    userId: string,
    name: string,
    roleRef: string,
    scopeLocationId?: string,
  ): Promise<string[]> {
    return this.withTenant(tenantId, async (tx) => {
      const p = await provisionPrincipal(asDbQueryable(tx), tenantId, {
        userId,
        username: `drill-${name}-${userId}`,
        displayName: `Drill device ${name}`,
        roleRef,
        ...(scopeLocationId !== undefined ? { scopeLocationId } : {}),
      });
      return p.locationIds;
    });
  }

  /** Add a second role grant to an existing principal (the R5.3 "grant it in
   *  the same run and the rows appear" step). Returns the assignment id. */
  async grantRole(
    tenantId: string,
    userId: string,
    roleRef: string,
    scopeLocationId?: string,
  ): Promise<void> {
    await this.withTenant(tenantId, async (tx) => {
      await provisionPrincipal(asDbQueryable(tx), tenantId, {
        userId,
        roleRef,
        ...(scopeLocationId !== undefined ? { scopeLocationId } : {}),
      });
    });
  }

  /** Revoke EVERY role assignment a user holds that carries `credit.view`,
   *  by soft-deleting it — the shape a real revocation takes. */
  async revokeCreditView(tenantId: string, userId: string): Promise<number> {
    return this.withTenant(tenantId, async (tx) => {
      const r = await tx.query(
        `update app.user_role_assignment ura
            set deleted_at = now()
          where ura.user_id = $1
            and ura.deleted_at is null
            and exists (
              select 1 from app.role_permission rp
               where rp.tenant_id = ura.tenant_id and rp.role_id = ura.role_id
                 and rp.permission_code = 'credit.view')`,
        [userId],
      );
      return r.rows.length;
    });
  }

  /** Force the projections to recompute (the triggers already do; this is the
   *  nightly sweep, called by hand so a drill never races one). */
  async refreshCreditScope(tenantId: string): Promise<void> {
    await this.withTenant(tenantId, async (tx) => {
      await tx.query(`select app.refresh_credit_sync_scope($1)`, [tenantId]);
    });
  }

  async inBookScope(tenantId: string, userId: string): Promise<boolean> {
    const n = await this.countScoped(
      tenantId,
      `select count(*)::text as n from app.credit_sync_book_scope where user_id = $1`,
      [userId],
    );
    return n > 0;
  }

  /**
   * Seed one `credit_allowance` row.
   *
   * The derivation that WOULD produce these lands with 06 §6.7's cap leases
   * (migration 0013 §5 says so, and leaves the table empty on purpose). The
   * channel and its gate exist now, so the drill supplies the rows itself —
   * otherwise "the OUT-01 device holds zero OUT-03 allowances" is the vacuous
   * assertion R5's non-vacuity rule exists to forbid.
   */
  async seedAllowance(
    tenantId: string,
    locationId: string,
    customerId: string,
    capMinor: bigint,
    headroomMinor: bigint,
  ): Promise<string> {
    return this.withTenant(tenantId, async (tx) => {
      const id = uuidv7();
      await tx.query(
        `insert into app.credit_allowance
           (tenant_id, id, location_id, customer_id, cap_minor, headroom_minor,
            offline_ceiling_minor, credit_hold, cap_valid_until, cap_version_id,
            snapshot_as_of, snapshot_as_of_hlc)
         values ($1, $2, $3, $4, $5, $6, $7, false,
                 now() + interval '7 days', $8, now(), $9)
         on conflict (tenant_id, location_id, customer_id) do update
            set cap_minor = excluded.cap_minor,
                headroom_minor = excluded.headroom_minor`,
        [
          tenantId, id, locationId, customerId,
          capMinor.toString(10), headroomMinor.toString(10),
          headroomMinor.toString(10), uuidv7(), this.clock.next(),
        ],
      );
      return id;
    });
  }

  /** The account row for a customer code, with its server-derived position. */
  async creditPosition(
    tenantId: string,
    customerCode: string,
  ): Promise<{
    accountId: string;
    customerId: string;
    status: string;
    balanceMinor: bigint;
    tradeExposureMinor: bigint;
    feeOutstandingMinor: bigint;
    openingBeforeWindowMinor: bigint;
    buckets: { seq: number; label: string; amountMinor: bigint }[];
  }> {
    return this.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{
        account_id: string; customer_id: string; status: string;
        balance_minor: string; trade_exposure_minor: string;
        fee_outstanding_minor: string; opening_before_window_minor: string;
      }>(
        `select s.account_id, s.customer_id, s.status, s.balance_minor::text,
                s.trade_exposure_minor::text, s.fee_outstanding_minor::text,
                s.opening_before_window_minor::text
           from app.credit_position_snapshot s
           join app.customer c on c.tenant_id = s.tenant_id and c.id = s.customer_id
          where c.code = $1`,
        [customerCode],
      );
      const row = r.rows[0];
      if (!row) throw new Error(`no credit position for customer ${customerCode}`);
      const b = await tx.query<{ seq: number; label: string; amount_minor: string }>(
        `select seq, label, amount_minor::text from app.credit_position_bucket
          where account_id = $1 order by seq`,
        [row.account_id],
      );
      return {
        accountId: row.account_id,
        customerId: row.customer_id,
        status: row.status,
        balanceMinor: BigInt(row.balance_minor),
        tradeExposureMinor: BigInt(row.trade_exposure_minor),
        feeOutstandingMinor: BigInt(row.fee_outstanding_minor),
        openingBeforeWindowMinor: BigInt(row.opening_before_window_minor),
        buckets: b.rows.map((x) => ({
          seq: x.seq, label: x.label, amountMinor: BigInt(x.amount_minor),
        })),
      };
    });
  }

  /** Σ of a tenant's live credit entries — the non-vacuity yardstick. */
  async creditEntryCount(tenantId: string): Promise<number> {
    return this.countScoped(
      tenantId,
      `select count(*)::text as n from app.credit_entry where archived_at is null`,
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
