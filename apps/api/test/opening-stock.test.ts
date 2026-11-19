/**
 * OPENING STOCK FROM A FILE — work package R, item 2 (migration 0031; Q20).
 *
 * Real routers, real migrations, RLS as `app_user`. Categories (CLAUDE.md
 * §2.7): quantities are exact scaled integers (a float would lose them); the
 * import is idempotent twice over (same key replays, same CONTENT under a new
 * key loads nothing); nothing reaches the GL; and the tenant boundary holds —
 * a second tenant's identical file is its own, and its rows are invisible.
 * Every refusal is paired with a positive control.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import type { VerifiedIdentity } from '../src/auth.js';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantA: string;
let tenantB: string;
let outletA: { id: string; code: string };
let outlet2A: { id: string; code: string };
let skuA: string;
let skuB: string;
let owner: VerifiedIdentity;
type Caller = ReturnType<ApiHarness['callerFor']>;
let a: Caller;
const AS_OF = '2026-12-31';

async function q<T>(tenant: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return h.db.withTenant(tenant, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function openingRows(tenant: string) {
  return q<{ loc: string; prod: string; qty: string; cost: string | null; day: string; src: string }>(
    tenant,
    `select location_id loc, product_id prod, qty_delta::text qty, unit_cost_e4::text cost,
            business_date::text as day, source_id as src
       from app.stock_movement where source_kind = 'OPENING' order by qty_delta`,
  );
}

const csv = (...rows: string[]) => ['sku_code,location_code,quantity,unit_cost_minor', ...rows].join('\n');

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('opening-a');
  tenantB = await h.provisionTenant('opening-b');
  await h.applyTemplate(tenantA, true);
  await h.applyTemplate(tenantB, true);
  [outletA, outlet2A] = (await h.outlets(tenantA, 2)) as [{ id: string; code: string }, { id: string; code: string }];
  // Two stocked products; their codes come from the template, so tenant B holds the SAME codes.
  const picked = await q<{ sku_code: string }>(
    tenantA,
    `select p.sku_code from app.product p
       join app.unit_of_measure u on u.tenant_id = p.tenant_id and u.id = p.stocking_uom_id
      where p.deleted_at is null and p.stock_tracking = 'STOCKED' and u.qty_scale = 0
      order by p.sku_code limit 2`,
  );
  skuA = picked[0]!.sku_code;
  skuB = picked[1]!.sku_code;
  owner = await h.identityFor(tenantA, { locs: [outletA.id] });
  a = h.callerFor(owner);
}, 240_000);

afterAll(async () => {
  await h?.close();
});

describe('preview: every row’s verdict, nothing written', () => {
  it('names each problem by row and writes nothing', async () => {
    const before = await openingRows(tenantA);
    const p = await a.openingStock.preview({
      asOfDate: AS_OF,
      csv: csv(
        `${skuA},${outletA.code},40,5500`,
        `NO-SUCH-SKU,${outletA.code},1,`,
        `${skuB},NOWHERE,1,`,
        `${skuB},${outletA.code},1.5,`,
        `${skuB},${outlet2A.code},abc,`,
        `${skuA},${outletA.code},2,`,
      ),
    });
    expect(p.fileError).toBeNull();
    expect(p.rows.map((r) => [r.lineNo, r.issues])).toEqual([
      [2, []],
      [3, ['UNKNOWN_SKU']],
      [4, ['UNKNOWN_LOCATION']],
      [5, ['BAD_QUANTITY_SCALE']],
      [6, ['BAD_QUANTITY']],
      [7, ['DUPLICATE_ROW']],
    ]);
    expect(p.rows[0]).toMatchObject({ qtyScaled: '40', qtyScale: 0, unitCostMinor: '5500' });
    expect(p.summary).toMatchObject({ rowCount: 6, goodCount: 1, badCount: 5 });
    expect(await openingRows(tenantA)).toEqual(before);
  });

  it('is gated on stock.opening.import — an outlet manager (stock.receive, not this) is refused', async () => {
    const manager = h.callerFor(await h.principal(tenantA, { roleRef: 'outlet_manager', scopeLocationId: outletA.id }));
    const file = { asOfDate: AS_OF, csv: csv(`${skuA},${outletA.code},1,`) };
    await expect(manager.openingStock.preview(file)).rejects.toThrow(/stock\.opening\.import/);
    await expect(manager.openingStock.commit({ ...file, idempotencyKey: uuidv7() })).rejects.toThrow(/stock\.opening\.import/);
    expect(await openingRows(tenantA)).toEqual([]);
    // Positive control: the owner, same file.
    expect((await a.openingStock.preview(file)).summary).toMatchObject({ goodCount: 1 });
  });
});

describe('commit: all or nothing, exact, once, and never the GL', () => {
  it('a file with any bad row loads nothing', async () => {
    await expect(
      a.openingStock.commit({
        idempotencyKey: uuidv7(), asOfDate: AS_OF,
        csv: csv(`${skuA},${outletA.code},40,`, `${skuB},${outletA.code},0.5,`),
      }),
    ).rejects.toThrow(/1 row\(s\) cannot be loaded, so nothing was: line 3 BAD_QUANTITY_SCALE/);
    expect(await openingRows(tenantA)).toEqual([]);
    expect(await q(tenantA, `select 1 from app.opening_stock_import`)).toEqual([]);
  });

  it('a clean file lands as OPENING movements at the stated date, exact, with cost kept for Q16', async () => {
    const key = uuidv7();
    const file = { asOfDate: AS_OF, fileName: 'opening.csv', csv: csv(`${skuA},${outletA.code},40,5500`, `${skuB},${outlet2A.code},12,`) };
    const r = await a.openingStock.commit({ ...file, idempotencyKey: key });
    expect(r).toMatchObject({ importId: key, alreadyImported: false, rowCount: 2, movementCount: 2, locationCount: 2, productCount: 2 });
    const rows = await openingRows(tenantA);
    expect(rows.map((x) => [x.qty, x.cost, x.day, x.src])).toEqual([
      ['12', null, AS_OF, key],
      ['40', '55000000', AS_OF, key], // 5500 minor × 10⁴ — the e4 cost column
    ]);
    // NOTHING reaches the general ledger.
    expect(await q(tenantA, `select 1 from app.journal_entry where source_id = $1`, [key])).toEqual([]);
    expect(await q(tenantA, `select 1 from app.journal_entry`)).toEqual([]);
    // The audit trail: who, and the write that did it.
    const header = await q<{ by: string; hash: string }>(tenantA,
      `select imported_by as by, content_sha256 as hash from app.opening_stock_import where id = $1`, [key]);
    expect(header[0]!.by).toBe(owner.userId);
    const marker = await q<{ op: string; user_id: string }>(tenantA, `select op, user_id from app.write_log where id = $1`, [key]);
    expect(marker).toEqual([{ op: 'stock.opening_import', user_id: owner.userId }]);

    // The same key again: the stored answer, verbatim, and no second effect.
    expect(await a.openingStock.commit({ ...file, idempotencyKey: key })).toEqual(r);
    // The same CONTENT under a NEW key, rows re-ordered: recognised, nothing loads.
    const again = await a.openingStock.commit({
      idempotencyKey: uuidv7(), asOfDate: AS_OF,
      csv: csv(`${skuB},${outlet2A.code},12,`, `${skuA},${outletA.code},40,5500`),
    });
    expect(again).toMatchObject({ importId: key, alreadyImported: true, movementCount: 0 });
    expect((await openingRows(tenantA)).length).toBe(2);

    // A different file that would open an already-opened pair again is refused row by row.
    const twice = await a.openingStock.preview({ asOfDate: AS_OF, csv: csv(`${skuA},${outletA.code},41,`) });
    expect(twice.rows[0]!.issues).toEqual(['ALREADY_OPENED']);
    await expect(
      a.openingStock.commit({ idempotencyKey: uuidv7(), asOfDate: AS_OF, csv: csv(`${skuA},${outletA.code},41,`) }),
    ).rejects.toThrow(/ALREADY_OPENED/);
    expect((await openingRows(tenantA)).length).toBe(2);
  });
});

describe('the tenant boundary [opening stock]', () => {
  it('tenant B’s identical file is B’s own; B’s rows and B-only codes are invisible to A', async () => {
    const outletB = (await h.outlets(tenantB, 1))[0]!;
    const ownerB = h.callerFor(await h.identityFor(tenantB, { locs: [outletB.id] }));
    // B creates a SKU code A does not have.
    await h.db.withTenant(tenantB, async (tx) => {
      await tx.query(`update app.product set sku_code = 'B-ONLY-SKU' where sku_code = $1`, [skuB]);
    });
    const shared = csv(`${skuA},${outletB.code},7,`);
    const b = await ownerB.openingStock.commit({ idempotencyKey: uuidv7(), asOfDate: AS_OF, csv: shared });
    expect(b.alreadyImported).toBe(false);

    // A sees its own state only: the same CONTENT is not "already imported"
    // (the hash is per tenant), and B's opening does not make A's pair opened.
    const sameCodes = outletB.code === outletA.code ? shared : csv(`${skuA},${outletB.code},7,`);
    const pA = await a.openingStock.preview({ asOfDate: AS_OF, csv: sameCodes });
    expect(pA.previous).toBeNull();
    // B's private code answers exactly as a code nobody has.
    const probe = await a.openingStock.preview({
      asOfDate: AS_OF, csv: csv(`B-ONLY-SKU,${outletA.code},1,`, `NOBODY-HAS-THIS,${outletA.code},1,`),
    });
    expect(probe.rows.map((r) => r.issues)).toEqual([['UNKNOWN_SKU'], ['UNKNOWN_SKU']]);
    // B's movements are invisible under A's RLS, present under B's (positive control).
    expect((await q(tenantA, `select 1 from app.stock_movement where source_id = $1`, [b.importId])).length).toBe(0);
    expect((await q(tenantB, `select 1 from app.stock_movement where source_id = $1`, [b.importId])).length).toBe(1);
  });
});
