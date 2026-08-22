/**
 * Migration 0008 — the procurement schema, proved rather than described.
 *
 * Four things are checked here and each of them is a rule somebody could
 * plausibly get wrong in the next change:
 *
 *   1. CONFORMANCE, table by NAME. `conformance.test.ts` already asserts the
 *      tenant pattern over every app relation generically. This file names the
 *      nine new tables, so a table dropped from the migration — or renamed —
 *      fails here instead of quietly leaving the generic suite still green
 *      over a smaller set.
 *   2. TWO-TENANT ISOLATION on every new table (CLAUDE.md §2.7 category 3).
 *      Every read path gets a test proving a second tenant's data is
 *      invisible, and it runs as app_user with RLS genuinely applying.
 *   3. THE PURCHASE-ORDER STATE MACHINE, legal and illegal, exhaustively —
 *      all 49 ordered pairs, not a hand-picked few, so a transition somebody
 *      adds to the table without meaning to is caught.
 *   4. MULTI-CAPABILITY: a supplier that both sells goods and hauls them, and
 *      the delivery guard that reads the platform `kind` rather than the
 *      tenant's word for it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';
import type { Queryable, TestDb } from '../src/testing/harness.js';
import { makeLocation, makeUser } from './rbac-fixtures.js';
import {
  makeCapabilityTypes,
  makeCatalogue,
  makeDraftOrder,
  makeSupplier,
  setOrderStatus,
  type CatalogueFixture,
} from './procurement-fixtures.js';
import { newWrite, nextHlc, setupDb, setupTwoTenants, TENANT_A, TENANT_B } from './util.js';

/** The nine tables migration 0008 adds. Named, so a rename cannot hide. */
const PROCUREMENT_TABLES = [
  'delivery',
  'goods_receipt',
  'goods_receipt_line',
  'purchase_order',
  'purchase_order_line',
  'supplier',
  'supplier_capability',
  'supplier_capability_type',
  'supplier_product',
] as const;

const PURCHASE_ORDER_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED',
  'CLOSED',
] as const;

let db: TestDb;

/** Per-tenant scenery, built once. */
interface Scene {
  locationId: string;
  groupLocationId: string;
  userId: string;
  catalogue: CatalogueFixture;
  goodsCap: string;
  haulageCap: string;
  goodsSupplierId: string;
  haulierId: string;
  bothSupplierId: string;
}
const scene = new Map<string, Scene>();

async function buildScene(tenantId: string, prefix: string): Promise<void> {
  const built = await db.withTenant(tenantId, async (tx) => {
    const groupLocationId = await makeLocation(tx, tenantId, {
      code: `${prefix}-GRP`,
      kind: 'GROUP',
    });
    const locationId = await makeLocation(tx, tenantId, {
      code: `${prefix}-01`,
      kind: 'OUTLET',
      parentId: groupLocationId,
    });
    const userId = await makeUser(tx, tenantId, `${prefix.toLowerCase()}.buyer`);
    const catalogue = await makeCatalogue(tx, tenantId);
    const caps = await makeCapabilityTypes(tx, tenantId, prefix);
    const goodsSupplierId = await makeSupplier(tx, tenantId, {
      code: `${prefix}-MAKER`,
      capabilityTypeIds: [caps.goods],
    });
    const haulierId = await makeSupplier(tx, tenantId, {
      code: `${prefix}-HAUL`,
      capabilityTypeIds: [caps.haulage],
    });
    // The multi-capability case: one party that sells AND carries.
    const bothSupplierId = await makeSupplier(tx, tenantId, {
      code: `${prefix}-BOTH`,
      capabilityTypeIds: [caps.goods, caps.haulage],
    });
    return {
      locationId,
      groupLocationId,
      userId,
      catalogue,
      goodsCap: caps.goods,
      haulageCap: caps.haulage,
      goodsSupplierId,
      haulierId,
      bothSupplierId,
    };
  });
  scene.set(tenantId, built);
}

const A = () => scene.get(TENANT_A)!;
const B = () => scene.get(TENANT_B)!;

beforeAll(async () => {
  db = await setupDb();
  await setupTwoTenants(db);
  await buildScene(TENANT_A, 'AAA');
  await buildScene(TENANT_B, 'BBB');
});

afterAll(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// 1. Conformance, by name
// ---------------------------------------------------------------------------

describe('every procurement table carries the tenant pattern (04 §4.2.5)', () => {
  it('all nine exist, with tenant_id, ENABLED and FORCED RLS, and the write spine', async () => {
    const res = await db.asAdmin((tx) =>
      tx.query<{
        relname: string;
        has_tenant_id: boolean;
        rls_enabled: boolean;
        rls_forced: boolean;
        has_write_id: boolean;
        has_tenant_leading_index: boolean;
      }>(
        `select c.relname,
                exists (select 1 from pg_attribute a
                        where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
                  as has_tenant_id,
                c.relrowsecurity as rls_enabled,
                c.relforcerowsecurity as rls_forced,
                exists (select 1 from pg_attribute a
                        where a.attrelid = c.oid and a.attname = 'write_id' and not a.attisdropped)
                  as has_write_id,
                exists (select 1 from pg_index i
                        join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
                        where i.indrelid = c.oid and a.attname = 'tenant_id')
                  as has_tenant_leading_index
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relkind = 'r' and c.relname = any($1::text[])
          order by c.relname`,
        [[...PROCUREMENT_TABLES]],
      ),
    );

    expect(res.rows.map((r) => r.relname)).toEqual([...PROCUREMENT_TABLES]);
    for (const row of res.rows) {
      expect(row.has_tenant_id, `${row.relname}: tenant_id`).toBe(true);
      expect(row.rls_enabled, `${row.relname}: RLS enabled`).toBe(true);
      expect(row.rls_forced, `${row.relname}: RLS forced`).toBe(true);
      expect(row.has_write_id, `${row.relname}: write_id`).toBe(true);
      expect(row.has_tenant_leading_index, `${row.relname}: tenant-leading index`).toBe(true);
    }
  });

  it('the derived order-status view runs with security_invoker, not as its owner', async () => {
    const res = await db.asAdmin((tx) =>
      tx.query<{ ok: boolean }>(
        `select coalesce(c.reloptions @> array['security_invoker=true'], false) as ok
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relname = 'purchase_order_line_status'`,
      ),
    );
    expect(res.rows[0]?.ok).toBe(true);
  });

  it('no money or quantity column is a float, and none is numeric (ADR-0004)', async () => {
    const res = await db.asAdmin((tx) =>
      tx.query<{ relname: string; attname: string }>(
        `select c.relname, a.attname
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
           join pg_type t on t.oid = a.atttypid
           join lateral (
             select case when t.typtype = 'd'
                         then (select typname from pg_type where oid = t.typbasetype)
                         else t.typname end as typname
           ) bt on true
          where n.nspname = 'app' and c.relname = any($1::text[])
            and bt.typname in ('float4', 'float8', 'money', 'numeric')`,
        [[...PROCUREMENT_TABLES]],
      ),
    );
    expect(res.rows).toEqual([]);
  });

  it('ADR-0001: no fleet. Nothing in the app schema models a vehicle', async () => {
    // The rule is categorical, so the check is too: no table named for a
    // vehicle, and no column on the logistics tables that describes one.
    const tables = await db.asAdmin((tx) =>
      tx.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relkind in ('r','p','v','m')
            and (c.relname like '%vehicle%' or c.relname like '%truck%'
              or c.relname like '%driver%' or c.relname like '%fuel%')`,
      ),
    );
    expect(tables.rows).toEqual([]);

    const columns = await db.asAdmin((tx) =>
      tx.query<{ relname: string; attname: string }>(
        `select c.relname, a.attname
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
          where n.nspname = 'app' and c.relname = any($1::text[])
            and (a.attname like '%vehicle%' or a.attname like '%driver%'
              or a.attname like '%fuel%' or a.attname like '%odometer%'
              or a.attname like '%registration%')`,
        [[...PROCUREMENT_TABLES]],
      ),
    );
    expect(columns.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Two-tenant isolation, every table
// ---------------------------------------------------------------------------

describe('two-tenant isolation on every procurement table (CLAUDE.md §2.7)', () => {
  beforeAll(async () => {
    // Give both tenants a row in every one of the nine tables, written through
    // their own RLS context — so "invisible" below is a real absence and not
    // an empty table.
    for (const tenantId of [TENANT_A, TENANT_B]) {
      const s = scene.get(tenantId)!;
      await db.withTenant(tenantId, async (tx) => {
        const w = await newWrite(tx, tenantId, 'test.procurement');
        await tx.query(
          `insert into app.supplier_product
             (tenant_id, id, write_id, hlc, supplier_id, product_id, purchase_uom_id, is_preferred)
           values ($1, $2, $3, $4, $5, $6, $7, true)`,
          [
            tenantId,
            uuidv7(),
            w,
            nextHlc(),
            s.goodsSupplierId,
            s.catalogue.productId,
            s.catalogue.purchaseUomId,
          ],
        );

        const order = await makeDraftOrder(tx, tenantId, {
          supplierId: s.goodsSupplierId,
          locationId: s.locationId,
          catalogue: s.catalogue,
        });
        await setOrderStatus(tx, tenantId, order.purchaseOrderId, 'SUBMITTED');
        await setOrderStatus(tx, tenantId, order.purchaseOrderId, 'APPROVED', {
          approvedByUserId: s.userId,
        });

        const receiptId = uuidv7();
        await tx.query(
          `insert into app.goods_receipt
             (tenant_id, id, write_id, hlc, purchase_order_id, supplier_id, location_id,
              business_date, received_at)
           values ($1, $2, $3, $4, $5, $6, $7, '2026-08-22', transaction_timestamp())`,
          [tenantId, receiptId, w, nextHlc(), order.purchaseOrderId, s.goodsSupplierId, s.locationId],
        );
        await tx.query(
          `insert into app.goods_receipt_line
             (tenant_id, id, write_id, hlc, goods_receipt_id, line_no, purchase_order_line_id,
              product_id, uom_id, qty_received_scale, qty_received,
              stocking_uom_id, qty_stock_scale, qty_stock, qty_stock_computed,
              factor_num, factor_den, unit_cost_e4, stock_unit_cost_e4, line_net_minor)
           values ($1, $2, $3, $4, $5, 1, $6, $7, $8, 3, 10000,
                   $9, 0, 937, 937, 13500, 144, 45000000, 480000, 4500000)`,
          [
            tenantId,
            uuidv7(),
            w,
            nextHlc(),
            receiptId,
            order.purchaseOrderLineId,
            s.catalogue.productId,
            s.catalogue.purchaseUomId,
            s.catalogue.stockingUomId,
          ],
        );

        await tx.query(
          `insert into app.delivery
             (tenant_id, id, write_id, hlc, source_kind, source_id, carrier_supplier_id,
              to_location_id, business_date, currency_code, money_scale, freight_cost_minor)
           values ($1, $2, $3, $4, 'PURCHASE_ORDER', $5, $6, $7, date '2026-08-20', 'GHS', 100, 150000)`,
          [tenantId, uuidv7(), w, nextHlc(), order.purchaseOrderId, s.haulierId, s.locationId],
        );
      });
    }
  });

  it('control: both tenants really wrote a row in every table (visible to admin)', async () => {
    for (const table of PROCUREMENT_TABLES) {
      const res = await db.asAdmin((tx) =>
        tx.query<{ tenant_id: string }>(
          `select distinct tenant_id from app.${table} order by tenant_id`,
        ),
      );
      expect(res.rows.map((r) => r.tenant_id).sort(), `${table}`).toEqual(
        [TENANT_A, TENANT_B].sort(),
      );
    }
  });

  it("an UNPREDICATED select under tenant A returns only A's rows — every table", async () => {
    for (const table of PROCUREMENT_TABLES) {
      const res = await db.withTenant(TENANT_A, (tx) =>
        tx.query<{ tenant_id: string }>(`select tenant_id from app.${table}`),
      );
      expect(res.rows.length, `${table}: A has rows`).toBeGreaterThan(0);
      for (const row of res.rows) {
        expect(row.tenant_id, `${table}: leaked a row`).toBe(TENANT_A);
      }
    }
  });

  it("B's rows are invisible to A even when addressed by primary key", async () => {
    for (const table of PROCUREMENT_TABLES) {
      const ids = await db.asAdmin((tx) =>
        tx.query<{ id: string }>(`select id from app.${table} where tenant_id = $1`, [TENANT_B]),
      );
      expect(ids.rows.length).toBeGreaterThan(0);
      const seen = await db.withTenant(TENANT_A, (tx) =>
        tx.query(`select * from app.${table} where id = any($1::uuid[])`, [
          ids.rows.map((r) => r.id),
        ]),
      );
      expect(seen.rows, `${table}: A read B's row by id`).toEqual([]);
    }
  });

  it('the derived order-status view is tenant-scoped too, not just the tables', async () => {
    const a = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ tenant_id: string; qty_received: string }>(
        `select tenant_id, qty_received::text from app.purchase_order_line_status`,
      ),
    );
    expect(a.rows.length).toBeGreaterThan(0);
    expect(a.rows.every((r) => r.tenant_id === TENANT_A)).toBe(true);
    // …and it really is derived: 10.000 t ordered, 10.000 t received.
    expect(a.rows[0]!.qty_received).toBe('10000');

    const none = await db.asAppUserWithoutTenant((tx) =>
      tx.query(`select * from app.purchase_order_line_status`),
    );
    expect(none.rows).toEqual([]); // fails closed with no tenant context
  });

  it("A cannot point a purchase order at B's supplier, even with A's own tenant_id", async () => {
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A, 'test.cross');
        await tx.query(
          `insert into app.purchase_order
             (tenant_id, id, write_id, hlc, supplier_id, deliver_to_location_id,
              order_date, currency_code, money_scale)
           values ($1, $2, $3, $4, $5, $6, '2026-08-21', 'GHS', 100)`,
          [TENANT_A, uuidv7(), w, nextHlc(), B().goodsSupplierId, A().locationId],
        );
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it("A cannot name B's haulier as a carrier", async () => {
    const orderId = await db.asAdmin((tx) =>
      tx
        .query<{ id: string }>(`select id from app.purchase_order where tenant_id = $1 limit 1`, [
          TENANT_A,
        ])
        .then((r) => r.rows[0]!.id),
    );
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A, 'test.cross');
        await tx.query(
          `insert into app.delivery
             (tenant_id, id, write_id, hlc, source_kind, source_id, carrier_supplier_id,
              business_date, currency_code, money_scale)
           values ($1, $2, $3, $4, 'PURCHASE_ORDER', $5, $6, date '2026-08-20', 'GHS', 100)`,
          [TENANT_A, uuidv7(), w, nextHlc(), orderId, B().haulierId],
        );
      }),
    ).rejects.toThrow(/foreign key|HAULAGE/i);
  });
});

// ---------------------------------------------------------------------------
// 3. The purchase-order state machine
// ---------------------------------------------------------------------------

describe('the purchase-order state machine is enforced, not documented', () => {
  /** The transition table this suite expects the database to hold. */
  const EXPECTED_LEGAL: ReadonlyArray<readonly [string, string]> = [
    ['DRAFT', 'SUBMITTED'],
    ['DRAFT', 'CANCELLED'],
    ['SUBMITTED', 'APPROVED'],
    ['SUBMITTED', 'DRAFT'],
    ['SUBMITTED', 'CANCELLED'],
    ['APPROVED', 'PARTIALLY_RECEIVED'],
    ['APPROVED', 'RECEIVED'],
    ['APPROVED', 'CLOSED'],
    ['APPROVED', 'CANCELLED'],
    ['PARTIALLY_RECEIVED', 'RECEIVED'],
    ['PARTIALLY_RECEIVED', 'CLOSED'],
    ['RECEIVED', 'CLOSED'],
  ];

  it('the database holds exactly the expected transition table — all 49 pairs checked', async () => {
    const legal = new Set(EXPECTED_LEGAL.map(([f, t]) => `${f}->${t}`));
    const rows: string[] = [];
    for (const from of PURCHASE_ORDER_STATUSES) {
      for (const to of PURCHASE_ORDER_STATUSES) {
        const res = await db.withTenant(TENANT_A, (tx) =>
          tx.query<{ allowed: boolean }>(
            `select app.purchase_order_transition_allowed($1, $2) as allowed`,
            [from, to],
          ),
        );
        if (res.rows[0]!.allowed) rows.push(`${from}->${to}`);
      }
    }
    expect(rows.sort()).toEqual([...legal].sort());
  });

  it('THE AUDIT HOLE: a RECEIVED order can never go back to DRAFT', async () => {
    const s = A();
    const orderId = await db.withTenant(TENANT_A, async (tx) => {
      const o = await makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      });
      await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'SUBMITTED');
      await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'APPROVED', {
        approvedByUserId: s.userId,
      });
      await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'RECEIVED');
      return o.purchaseOrderId;
    });

    for (const back of ['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED', 'CANCELLED']) {
      await expect(
        db.withTenant(TENANT_A, (tx) => setOrderStatus(tx, TENANT_A, orderId, back)),
        `RECEIVED -> ${back} must be refused`,
      ).rejects.toThrow(/not a legal transition/i);
    }
    // The one legal exit: no more is expected.
    await db.withTenant(TENANT_A, (tx) => setOrderStatus(tx, TENANT_A, orderId, 'CLOSED'));
    const after = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ status: string }>(`select status from app.purchase_order where id = $1`, [orderId]),
    );
    expect(after.rows[0]!.status).toBe('CLOSED');
  });

  it('an order is created as DRAFT and cannot be conjured already approved', async () => {
    const s = A();
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A, 'test.forged_order');
        await tx.query(
          `insert into app.purchase_order
             (tenant_id, id, write_id, hlc, supplier_id, deliver_to_location_id,
              order_date, currency_code, money_scale, status, approved_at, approved_by_user_id)
           values ($1, $2, $3, $4, $5, $6, '2026-08-21', 'GHS', 100, 'APPROVED',
                   transaction_timestamp(), $7)`,
          [TENANT_A, uuidv7(), w, nextHlc(), s.goodsSupplierId, s.locationId, s.userId],
        );
      }),
    ).rejects.toThrow(/may only be created as DRAFT/i);
  });

  it('APPROVED requires a named approver — an approval with nobody on it is refused', async () => {
    const s = A();
    const orderId = await db.withTenant(TENANT_A, async (tx) => {
      const o = await makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      });
      await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'SUBMITTED');
      return o.purchaseOrderId;
    });

    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update app.purchase_order set status = 'APPROVED' where id = $1`, [orderId]),
      ),
    ).rejects.toThrow(/approved_by_user_id/i);

    await db.withTenant(TENANT_A, (tx) =>
      setOrderStatus(tx, TENANT_A, orderId, 'APPROVED', { approvedByUserId: s.userId }),
    );
    const row = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ status: string; approved_by_user_id: string }>(
        `select status, approved_by_user_id from app.purchase_order where id = $1`,
        [orderId],
      ),
    );
    expect(row.rows[0]!.status).toBe('APPROVED');
    expect(row.rows[0]!.approved_by_user_id).toBe(s.userId);
  });

  it('an empty order cannot leave DRAFT, and a submitted order freezes its lines', async () => {
    const s = A();
    const empty = await db.withTenant(TENANT_A, (tx) =>
      makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
        withLine: false,
      }),
    );
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        setOrderStatus(tx, TENANT_A, empty.purchaseOrderId, 'SUBMITTED'),
      ),
    ).rejects.toThrow(/no lines/i);

    const withLine = await db.withTenant(TENANT_A, async (tx) => {
      const o = await makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      });
      await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'SUBMITTED');
      return o;
    });

    // Every way of editing a frozen order's lines is refused, including the
    // quiet one: a soft delete is an UPDATE.
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update app.purchase_order_line set qty_ordered = 1 where id = $1`, [
          withLine.purchaseOrderLineId,
        ]),
      ),
    ).rejects.toThrow(/only be added, changed or removed while the order is DRAFT/i);
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `update app.purchase_order_line set deleted_at = transaction_timestamp() where id = $1`,
          [withLine.purchaseOrderLineId],
        ),
      ),
    ).rejects.toThrow(/DRAFT/i);
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`delete from app.purchase_order_line where id = $1`, [
          withLine.purchaseOrderLineId,
        ]),
      ),
    ).rejects.toThrow(/DRAFT/i);
  });

  it('the commercial terms of an issued order are frozen too, not only its lines', async () => {
    const s = A();
    const orderId = await db.withTenant(TENANT_A, async (tx) => {
      const o = await makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      });
      await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'SUBMITTED');
      return o.purchaseOrderId;
    });
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(`update app.purchase_order set supplier_id = $2 where id = $1`, [
          orderId,
          s.bothSupplierId,
        ]),
      ),
    ).rejects.toThrow(/frozen once the order leaves DRAFT/i);
  });

  it('a draft may be thrown away; anything issued must be cancelled, not hidden', async () => {
    const s = A();
    const draft = await db.withTenant(TENANT_A, (tx) =>
      makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
        withLine: false,
      }),
    );
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(
        `update app.purchase_order set deleted_at = transaction_timestamp() where id = $1`,
        [draft.purchaseOrderId],
      ),
    );

    const issued = await db.withTenant(TENANT_A, async (tx) => {
      const o = await makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      });
      await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'SUBMITTED');
      return o.purchaseOrderId;
    });
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `update app.purchase_order set deleted_at = transaction_timestamp() where id = $1`,
          [issued],
        ),
      ),
    ).rejects.toThrow(/po_soft_delete_draft_only|check/i);
  });

  it('goods cannot be received against an order that has not been approved', async () => {
    const s = A();
    const submitted = await db.withTenant(TENANT_A, async (tx) => {
      const o = await makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      });
      await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'SUBMITTED');
      return o.purchaseOrderId;
    });

    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A, 'test.premature_receipt');
        await tx.query(
          `insert into app.goods_receipt
             (tenant_id, id, write_id, hlc, purchase_order_id, supplier_id, location_id,
              business_date, received_at)
           values ($1, $2, $3, $4, $5, $6, $7, '2026-08-22', transaction_timestamp())`,
          [TENANT_A, uuidv7(), w, nextHlc(), submitted, s.goodsSupplierId, s.locationId],
        );
      }),
    ).rejects.toThrow(/APPROVED or PARTIALLY_RECEIVED/i);
  });

  it('a short delivery is not an error: less arrives than was ordered, and it lands', async () => {
    const s = A();
    const { orderId, lineId } = await db.withTenant(TENANT_A, async (tx) => {
      const o = await makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      });
      await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'SUBMITTED');
      await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'APPROVED', {
        approvedByUserId: s.userId,
      });
      return { orderId: o.purchaseOrderId, lineId: o.purchaseOrderLineId };
    });

    await db.withTenant(TENANT_A, async (tx) => {
      const w = await newWrite(tx, TENANT_A, 'test.short_receipt');
      const receiptId = uuidv7();
      await tx.query(
        `insert into app.goods_receipt
           (tenant_id, id, write_id, hlc, purchase_order_id, supplier_id, location_id,
            business_date, received_at)
         values ($1, $2, $3, $4, $5, $6, $7, '2026-08-22', transaction_timestamp())`,
        [TENANT_A, receiptId, w, nextHlc(), orderId, s.goodsSupplierId, s.locationId],
      );
      // 10.000 t ordered, 6.000 t invoiced, and 561 bars actually counted off
      // the truck rather than the 562.5 the factor computes — so a human
      // signed for the difference (04 §4.4.4).
      await tx.query(
        `insert into app.goods_receipt_line
           (tenant_id, id, write_id, hlc, goods_receipt_id, line_no, purchase_order_line_id,
            product_id, uom_id, qty_received_scale, qty_received,
            stocking_uom_id, qty_stock_scale, qty_stock, qty_stock_computed,
            factor_num, factor_den, unit_cost_e4, stock_unit_cost_e4, line_net_minor,
            conversion_confirmed_by)
         values ($1, $2, $3, $4, $5, 1, $6, $7, $8, 3, 6000,
                 $9, 0, 561, 562, 13500, 144, 45000000, 480000, 2700000, $10)`,
        [
          TENANT_A,
          uuidv7(),
          w,
          nextHlc(),
          receiptId,
          lineId,
          s.catalogue.productId,
          s.catalogue.purchaseUomId,
          s.catalogue.stockingUomId,
          s.userId,
        ],
      );
      await setOrderStatus(tx, TENANT_A, orderId, 'PARTIALLY_RECEIVED');
    });

    const status = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{
        qty_ordered: string;
        qty_received: string;
        qty_outstanding: string;
        qty_stock_received: string;
        is_fully_received: boolean;
      }>(
        `select qty_ordered::text, qty_received::text, qty_outstanding::text,
                qty_stock_received::text, is_fully_received
           from app.purchase_order_line_status where purchase_order_line_id = $1`,
        [lineId],
      ),
    );
    const row = status.rows[0]!;
    expect(row.qty_ordered).toBe('10000'); // 10.000 t
    expect(row.qty_received).toBe('6000'); //  6.000 t
    expect(row.qty_outstanding).toBe('4000'); // 4.000 t still to come
    expect(row.qty_stock_received).toBe('561'); // bars, what the yard counted
    expect(row.is_fully_received).toBe(false);

    // …and "we are not waiting for the other four tonnes" is sayable.
    await db.withTenant(TENANT_A, (tx) => setOrderStatus(tx, TENANT_A, orderId, 'CLOSED'));
  });

  it('a conversion difference with nobody behind it is refused (04 §4.4.4)', async () => {
    const s = A();
    const orderId = await db.withTenant(TENANT_A, async (tx) => {
      const o = await makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      });
      await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'SUBMITTED');
      await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'APPROVED', {
        approvedByUserId: s.userId,
      });
      return o.purchaseOrderId;
    });

    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A, 'test.unconfirmed');
        const receiptId = uuidv7();
        await tx.query(
          `insert into app.goods_receipt
             (tenant_id, id, write_id, hlc, purchase_order_id, supplier_id, location_id,
              business_date, received_at)
           values ($1, $2, $3, $4, $5, $6, $7, '2026-08-22', transaction_timestamp())`,
          [TENANT_A, receiptId, w, nextHlc(), orderId, s.goodsSupplierId, s.locationId],
        );
        await tx.query(
          `insert into app.goods_receipt_line
             (tenant_id, id, write_id, hlc, goods_receipt_id, line_no,
              product_id, uom_id, qty_received_scale, qty_received,
              stocking_uom_id, qty_stock_scale, qty_stock, qty_stock_computed,
              factor_num, factor_den, unit_cost_e4, stock_unit_cost_e4, line_net_minor)
           values ($1, $2, $3, $4, $5, 1, $6, $7, 3, 6000,
                   $8, 0, 561, 562, 13500, 144, 45000000, 480000, 2700000)`,
          [
            TENANT_A,
            uuidv7(),
            w,
            nextHlc(),
            receiptId,
            s.catalogue.productId,
            s.catalogue.purchaseUomId,
            s.catalogue.stockingUomId,
          ],
        );
      }),
    ).rejects.toThrow(/grl_conversion_confirmed|check/i);
  });

  it('a receipt line cannot be matched to another order’s line', async () => {
    const s = A();
    const [first, second] = await db.withTenant(TENANT_A, async (tx) => {
      const a = await makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      });
      const b = await makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      });
      for (const o of [a, b]) {
        await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'SUBMITTED');
        await setOrderStatus(tx, TENANT_A, o.purchaseOrderId, 'APPROVED', {
          approvedByUserId: s.userId,
        });
      }
      return [a, b] as const;
    });

    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A, 'test.mismatch');
        const receiptId = uuidv7();
        await tx.query(
          `insert into app.goods_receipt
             (tenant_id, id, write_id, hlc, purchase_order_id, supplier_id, location_id,
              business_date, received_at)
           values ($1, $2, $3, $4, $5, $6, $7, '2026-08-22', transaction_timestamp())`,
          [TENANT_A, receiptId, w, nextHlc(), first.purchaseOrderId, s.goodsSupplierId, s.locationId],
        );
        await tx.query(
          `insert into app.goods_receipt_line
             (tenant_id, id, write_id, hlc, goods_receipt_id, line_no, purchase_order_line_id,
              product_id, uom_id, qty_received_scale, qty_received,
              stocking_uom_id, qty_stock_scale, qty_stock, qty_stock_computed,
              factor_num, factor_den, unit_cost_e4, stock_unit_cost_e4, line_net_minor)
           values ($1, $2, $3, $4, $5, 1, $6, $7, $8, 3, 1000,
                   $9, 0, 93, 93, 13500, 144, 45000000, 480000, 450000)`,
          [
            TENANT_A,
            uuidv7(),
            w,
            nextHlc(),
            receiptId,
            second.purchaseOrderLineId, // the OTHER order's line
            s.catalogue.productId,
            s.catalogue.purchaseUomId,
            s.catalogue.stockingUomId,
          ],
        );
      }),
    ).rejects.toThrow(/belongs to order/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Capabilities, multi-capability, and the buyable-unit rule
// ---------------------------------------------------------------------------

describe('supplier capabilities: a party may sell AND haul', () => {
  it('one supplier holds both capabilities at once, and both are true', async () => {
    const s = A();
    const res = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ kind: string; code: string }>(
        `select sct.kind, sct.code
           from app.supplier_capability sc
           join app.supplier_capability_type sct
             on sct.tenant_id = sc.tenant_id and sct.id = sc.capability_type_id
          where sc.supplier_id = $1 and sc.deleted_at is null
          order by sct.kind`,
        [s.bothSupplierId],
      ),
    );
    expect(res.rows.map((r) => r.kind)).toEqual(['GOODS', 'HAULAGE']);
    // The tenant's own words are NOT the platform's. Nothing reads these.
    expect(res.rows.map((r) => r.code)).toEqual(['AAA-SELLS', 'AAA-TRUCKS']);
  });

  it('a supplier that both sells and hauls can carry its own goods', async () => {
    const s = A();
    await db.withTenant(TENANT_A, async (tx) => {
      const o = await makeDraftOrder(tx, TENANT_A, {
        supplierId: s.bothSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      });
      const w = await newWrite(tx, TENANT_A, 'test.self_haul');
      await tx.query(
        `insert into app.delivery
           (tenant_id, id, write_id, hlc, source_kind, source_id, carrier_supplier_id,
            to_location_id, business_date, currency_code, money_scale)
         values ($1, $2, $3, $4, 'PURCHASE_ORDER', $5, $6, $7, date '2026-08-20', 'GHS', 100)`,
        [
          TENANT_A,
          uuidv7(),
          w,
          nextHlc(),
          o.purchaseOrderId,
          s.bothSupplierId,
          s.locationId,
        ],
      );
    });
  });

  it('a supplier with no HAULAGE capability cannot be a carrier (ADR-0001)', async () => {
    const s = A();
    const orderId = await db.withTenant(TENANT_A, (tx) =>
      makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      }).then((o) => o.purchaseOrderId),
    );
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A, 'test.bad_carrier');
        await tx.query(
          `insert into app.delivery
             (tenant_id, id, write_id, hlc, source_kind, source_id, carrier_supplier_id,
              business_date, currency_code, money_scale)
           values ($1, $2, $3, $4, 'PURCHASE_ORDER', $5, $6, date '2026-08-20', 'GHS', 100)`,
          [TENANT_A, uuidv7(), w, nextHlc(), orderId, s.goodsSupplierId],
        );
      }),
    ).rejects.toThrow(/HAULAGE/i);
  });

  it('the delivery state machine is enforced: DELIVERED is terminal', async () => {
    const s = A();
    const deliveryId = await db.withTenant(TENANT_A, async (tx) => {
      const o = await makeDraftOrder(tx, TENANT_A, {
        supplierId: s.goodsSupplierId,
        locationId: s.locationId,
        catalogue: s.catalogue,
      });
      const w = await newWrite(tx, TENANT_A, 'test.delivery');
      const id = uuidv7();
      await tx.query(
        `insert into app.delivery
           (tenant_id, id, write_id, hlc, source_kind, source_id, carrier_supplier_id,
            to_location_id, business_date, currency_code, money_scale)
         values ($1, $2, $3, $4, 'PURCHASE_ORDER', $5, $6, $7, date '2026-08-20', 'GHS', 100)`,
        [TENANT_A, id, w, nextHlc(), o.purchaseOrderId, s.haulierId, s.locationId],
      );
      return id;
    });

    // PLANNED -> IN_TRANSIT skips dispatch and is refused.
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `update app.delivery set status = 'IN_TRANSIT', dispatched_at = transaction_timestamp()
            where id = $1`,
          [deliveryId],
        ),
      ),
    ).rejects.toThrow(/not a legal transition/i);

    await db.withTenant(TENANT_A, (tx) =>
      tx.query(
        `update app.delivery set status = 'DISPATCHED', dispatched_at = transaction_timestamp()
          where id = $1`,
        [deliveryId],
      ),
    );
    await db.withTenant(TENANT_A, (tx) =>
      tx.query(
        `update app.delivery set status = 'DELIVERED', delivered_at = transaction_timestamp()
          where id = $1`,
        [deliveryId],
      ),
    );
    for (const back of ['PLANNED', 'DISPATCHED', 'IN_TRANSIT', 'FAILED', 'CANCELLED']) {
      await expect(
        db.withTenant(TENANT_A, (tx) =>
          tx.query(`update app.delivery set status = $2 where id = $1`, [deliveryId, back]),
        ),
        `DELIVERED -> ${back} must be refused`,
      ).rejects.toThrow(/not a legal transition/i);
    }
  });

  it('a purchase unit must be a BUYABLE unit of the product (§4.10, product_uom.can_buy)', async () => {
    const s = A();
    // A second product whose tonne row is explicitly NOT buyable.
    const notBuyable = await db.withTenant(TENANT_A, (tx) =>
      makeCatalogue(tx, TENANT_A, { buyableCanBuy: false }),
    );
    await expect(
      db.withTenant(TENANT_A, async (tx) => {
        const w = await newWrite(tx, TENANT_A, 'test.bad_purchase_uom');
        await tx.query(
          `insert into app.supplier_product
             (tenant_id, id, write_id, hlc, supplier_id, product_id, purchase_uom_id)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            TENANT_A,
            uuidv7(),
            w,
            nextHlc(),
            s.goodsSupplierId,
            notBuyable.productId,
            notBuyable.purchaseUomId,
          ],
        );
      }),
    ).rejects.toThrow(/not a buyable unit/i);

    // …and the same unit on a product that DOES declare it buyable is fine.
    const ok = await db.withTenant(TENANT_A, (tx) => makeCatalogue(tx, TENANT_A));
    await db.withTenant(TENANT_A, async (tx) => {
      const w = await newWrite(tx, TENANT_A, 'test.good_purchase_uom');
      await tx.query(
        `insert into app.supplier_product
           (tenant_id, id, write_id, hlc, supplier_id, product_id, purchase_uom_id)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [TENANT_A, uuidv7(), w, nextHlc(), s.goodsSupplierId, ok.productId, ok.purchaseUomId],
      );
    });
  });

  it('multi-source is many rows with at most ONE preferred per product', async () => {
    const s = A();
    const cat = await db.withTenant(TENANT_A, (tx) => makeCatalogue(tx, TENANT_A));
    const second = await db.withTenant(TENANT_A, (tx) =>
      makeSupplier(tx, TENANT_A, { code: `AAA-ALT-${cat.productId.slice(-4)}`, capabilityTypeIds: [s.goodsCap] }),
    );

    await db.withTenant(TENANT_A, async (tx) => {
      const w = await newWrite(tx, TENANT_A, 'test.multi_source');
      for (const [supplierId, preferred] of [
        [s.goodsSupplierId, true],
        [second, false],
      ] as const) {
        await tx.query(
          `insert into app.supplier_product
             (tenant_id, id, write_id, hlc, supplier_id, product_id, purchase_uom_id, is_preferred)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [TENANT_A, uuidv7(), w, nextHlc(), supplierId, cat.productId, cat.purchaseUomId, preferred],
        );
      }
    });

    const sources = await db.withTenant(TENANT_A, (tx) =>
      tx.query<{ n: string }>(
        `select count(*)::text as n from app.supplier_product where product_id = $1`,
        [cat.productId],
      ),
    );
    expect(Number(sources.rows[0]!.n)).toBe(2);

    // A second preferred source would make "order from the usual place"
    // ambiguous, and an ambiguous default is a phone call.
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        tx.query(
          `update app.supplier_product set is_preferred = true
            where product_id = $1 and supplier_id = $2`,
          [cat.productId, second],
        ),
      ),
    ).rejects.toThrow(/supplier_product_preferred_uq|unique/i);
  });

  it('a supplier cannot be invoiced in a currency the tenant’s pack does not use', async () => {
    await expect(
      db.withTenant(TENANT_A, (tx) =>
        makeSupplier(tx, TENANT_A, { code: 'AAA-USD', currencyCode: 'USD' }),
      ),
    ).rejects.toThrow(/pack currency/i);
  });
});

// ---------------------------------------------------------------------------
// 5. The template's suppliers
// ---------------------------------------------------------------------------

describe("tenant #1's suppliers ship as template data (ADR-0006)", () => {
  const T1 = '018f0000-0000-8000-8000-0000000000c1';
  let templateDb: TestDb;

  beforeAll(async () => {
    const { createTenant } = await import('../src/testing/harness.js');
    const { applyTemplate } = await import('../src/seed/template.js');
    templateDb = await setupDb();
    await createTenant(templateDb, { id: T1, slug: 'agyasei-suppliers' });
    await templateDb.withTenant(T1, (tx: Queryable) => applyTemplate(tx, T1));
  });

  afterAll(async () => {
    await templateDb.close();
  });

  it('seeds the three cement sources the plan names, plus a carrier', async () => {
    const res = await templateDb.withTenant(T1, (tx) =>
      tx.query<{ code: string; kind: string }>(
        `select s.code, sct.kind
           from app.supplier s
           join app.supplier_capability sc
             on sc.tenant_id = s.tenant_id and sc.supplier_id = s.id
           join app.supplier_capability_type sct
             on sct.tenant_id = sc.tenant_id and sct.id = sc.capability_type_id
          order by s.code, sct.kind`,
      ),
    );
    expect(res.rows).toEqual([
      { code: 'CIMAF', kind: 'GOODS' },
      { code: 'DANGOTE', kind: 'GOODS' },
      { code: 'GHACEM', kind: 'GOODS' },
      // ADR-0001: the carrier is a supplier, not a fleet.
      { code: 'HAUL-01', kind: 'HAULAGE' },
    ]);
  });

  it('multi-source is real on day one: every cement SKU has three sources, one preferred', async () => {
    const res = await templateDb.withTenant(T1, (tx) =>
      tx.query<{ product_id: string; n: string; preferred: string }>(
        `select sp.product_id, count(*)::text as n,
                count(*) filter (where sp.is_preferred)::text as preferred
           from app.supplier_product sp
          group by sp.product_id`,
      ),
    );
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      expect(Number(row.n)).toBe(3);
      expect(Number(row.preferred)).toBe(1);
    }
  });

  it('every seeded figure the plan does not state is NULL or flagged, never invented', async () => {
    const guesses = await templateDb.withTenant(T1, (tx) =>
      tx.query<{ lead: number | null; price: string | null; notes: string }>(
        `select sp.lead_time_days as lead, sp.last_price_e4::text as price, sp.notes
           from app.supplier_product sp`,
      ),
    );
    for (const row of guesses.rows) {
      expect(row.lead).toBeNull(); // a guessed lead time drives order quantities
      expect(row.price).toBeNull(); // a zero price reads as free
      expect(row.notes).toContain('[NEEDS-FOUNDER');
    }
    const terms = await templateDb.withTenant(T1, (tx) =>
      tx.query<{ code: string; days: number; notes: string }>(
        `select code, payment_terms_days as days, notes from app.supplier order by code`,
      ),
    );
    for (const row of terms.rows) {
      expect(row.days).toBe(0); // cash on delivery, the conservative reading
      expect(row.notes).toContain('[NEEDS-FOUNDER');
    }
  });

  it('re-applying the template changes nothing', async () => {
    const { applyTemplate } = await import('../src/seed/template.js');
    const snapshot = () =>
      templateDb.withTenant(T1, (tx) =>
        tx.query<{ t: string; n: string }>(`
          select 'supplier' as t, count(*)::text as n from app.supplier
          union all select 'capability', count(*)::text from app.supplier_capability
          union all select 'capability_type', count(*)::text from app.supplier_capability_type
          union all select 'supplier_product', count(*)::text from app.supplier_product
          order by t
        `),
      );
    const before = await snapshot();
    await templateDb.withTenant(T1, (tx: Queryable) => applyTemplate(tx, T1));
    expect((await snapshot()).rows).toEqual(before.rows);
  });

  it('the template grants approving and receiving to DIFFERENT roles', async () => {
    const res = await templateDb.withTenant(T1, (tx) =>
      tx.query<{ origin_ref: string; permission_code: string }>(
        `select r.origin_ref, rp.permission_code
           from app.role_permission rp
           join app.role r on r.tenant_id = rp.tenant_id and r.id = rp.role_id
          where rp.permission_code in ('purchase.order.approve', 'goods.receive')
          order by r.origin_ref, rp.permission_code`,
      ),
    );
    const approvers = res.rows
      .filter((r) => r.permission_code === 'purchase.order.approve')
      .map((r) => r.origin_ref);
    const receivers = res.rows
      .filter((r) => r.permission_code === 'goods.receive')
      .map((r) => r.origin_ref);

    expect(approvers.length).toBeGreaterThan(0);
    expect(receivers.length).toBeGreaterThan(0);
    // THE CONTROL: no non-owner role in the template holds both. One pair of
    // hands that can authorise an order and sign for its goods can fabricate a
    // receipt against an order it invented.
    for (const role of approvers) {
      expect(
        receivers,
        `role ${role} both approves purchase orders and receives goods — that is the fabricated-receipt hole`,
      ).not.toContain(role);
    }
  });
});
