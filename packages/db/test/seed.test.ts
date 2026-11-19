/**
 * The "construction-materials-gh" starter template: parsed from
 * docs/source-of-truth (219 SKU rows, 25 outlets), applied as ORDINARY
 * EDITABLE ROWS through the tenant's own RLS context, idempotently
 * (ADR-0006; 01-tenancy §1.6).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseOutlets } from '../src/seed/outlets.js';
import { parseSkus } from '../src/seed/skus.js';
import { applyTemplate, applyTenant1Locations, type ApplyTemplateResult } from '../src/seed/template.js';
import { createTenant, type TestDb } from '../src/testing/harness.js';
import { setupDb } from './util.js';

const T1 = '018f0000-0000-8000-8000-0000000000f1';

let db: TestDb;
let firstApply: ApplyTemplateResult;

beforeAll(async () => {
  db = await setupDb();
  await createTenant(db, { id: T1, slug: 'agyasei-jnr', legalName: 'Agyasei Jnr & Company Limited' });
  firstApply = await db.withTenant(T1, (tx) => applyTemplate(tx, T1));
  await db.withTenant(T1, (tx) => applyTenant1Locations(tx, T1));
});
afterAll(async () => {
  await db.close();
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const res = await db.withTenant(T1, (tx) => tx.query<{ n: string }>(sql, params));
  return Number(res.rows[0]!.n);
}

describe('catalogue template', () => {
  it('seeds exactly 219 products from skus.csv', async () => {
    expect(await count('select count(*)::text as n from app.product')).toBe(219);
  });

  it('per-category product counts match the source CSV', async () => {
    const lines = await parseSkus();
    const expected = new Map<string, number>();
    for (const l of lines) expected.set(l.category, (expected.get(l.category) ?? 0) + 1);

    const res = await db.withTenant(T1, (tx) =>
      tx.query<{ name: string; n: string }>(`
        select top.name, count(p.id)::text as n
        from app.product p
        join app.product_category sub on sub.tenant_id = p.tenant_id and sub.id = p.category_id
        join app.product_category top on top.tenant_id = sub.tenant_id and top.id = sub.parent_id
        group by top.name
      `),
    );
    const actual = new Map(res.rows.map((r) => [r.name, Number(r.n)]));
    expect(actual).toEqual(expected);
    // Spot anchors from the source of truth:
    expect(actual.get('Cement & Binders')).toBe(10);
    expect(actual.get('Hardware & Tools')).toBe(55);
    expect(actual.size).toBe(12);
  });

  it('builds the 12 + 54 category tree', async () => {
    expect(await count('select count(*)::text as n from app.product_category where parent_id is null')).toBe(12);
    expect(await count('select count(*)::text as n from app.product_category where parent_id is not null')).toBe(54);
  });

  it('every product has a stocking-unit product_uom at exactly 1/1', async () => {
    const n = await count(`
      select count(*)::text as n
      from app.product p
      join app.product_uom pu
        on pu.tenant_id = p.tenant_id and pu.product_id = p.id
       and pu.uom_id = p.stocking_uom_id and pu.factor_num = 1 and pu.factor_den = 1
    `);
    expect(n).toBe(219);
  });

  it('seeds the §4.4 rational rebar factors: bars per tonne = EXACTLY 13500/d²', async () => {
    const res = await db.withTenant(T1, (tx) =>
      tx.query<{ sku_code: string; factor_num: string; factor_den: string }>(`
        select p.sku_code, pu.factor_num::text, pu.factor_den::text
        from app.product_uom pu
        join app.product p on p.tenant_id = pu.tenant_id and p.id = pu.product_id
        join app.unit_of_measure u on u.tenant_id = pu.tenant_id and u.id = pu.uom_id
        where u.code = 'TON' and p.name like 'Reinforcement Bar%'
        order by p.sku_code
      `),
    );
    // SKUs 23–28: diameters 8, 10, 12, 16, 20, 25 mm → denominators d².
    expect(res.rows.map((r) => [r.factor_num, r.factor_den])).toEqual([
      ['13500', '64'],   // 8mm  → 210.9375 bars/t — NOT representable as a short decimal
      ['13500', '100'],  // 10mm → 135
      ['13500', '144'],  // 12mm → 93.75
      ['13500', '256'],  // 16mm → 52.734375
      ['13500', '400'],  // 20mm → 33.75
      ['13500', '625'],  // 25mm → 21.6
    ]);
  });

  it('total product_uom rows = 219 stocking + the confirmed dual/pack-break rows', async () => {
    const lines = await parseSkus();
    const expected = 219 + lines.reduce((acc, l) => acc + l.sellingUoms.length, 0);
    expect(await count('select count(*)::text as n from app.product_uom')).toBe(expected);
    // The confirmed duals: 6 rebar + 5 cable rolls + 1 binding wire + 1 hinge pair.
    expect(expected).toBe(219 + 13);
  });

  it('every dual-unit row states a tolerance (the column has no default by design)', async () => {
    const res = await db.withTenant(T1, (tx) =>
      tx.query<{ n: string }>(`
        select count(*)::text as n from app.product_uom
        where factor_num <> 1 or factor_den <> 1
      `),
    );
    expect(Number(res.rows[0]!.n)).toBe(13); // and none of them could have been inserted without tolerance_bp
  });

  it('flags the founder-pending lines instead of inventing factors (§4.16, class C)', () => {
    const skuNos = new Set(firstApply.founderPending.map((f) => f.skuNo));
    for (const classC of [67, 146, 160, 161]) expect(skuNos).toContain(classC);
    // Tiles, aggregates, bolts, masks, sandpaper: second unit pending a factor.
    expect(firstApply.founderPending.length).toBeGreaterThanOrEqual(15);
  });

  it('made-to-order SKU 67 is NON_STOCKED — no phantom stocktake variance', async () => {
    expect(
      await count(`select count(*)::text as n from app.product where sku_code = 'SKU-067' and stock_tracking = 'NON_STOCKED'`),
    ).toBe(1);
  });

  it('seeds location types, movement reasons and the two price lists — but NEVER prices', async () => {
    expect(await count('select count(*)::text as n from app.location_type')).toBe(3);
    expect(await count('select count(*)::text as n from app.movement_reason')).toBe(10);
    expect(await count('select count(*)::text as n from app.price_list')).toBe(2);
    expect(await count('select count(*)::text as n from app.price_list_item')).toBe(0);
  });

  it('seeds five tender methods as editable rows — read by ROLE, the codes are the template’s words', async () => {
    const res = await db.withTenant(T1, (tx) =>
      tx.query<{ code: string; posting_role: string; is_cash: boolean; is_on_account: boolean;
                 requires_reference: boolean; is_active: boolean }>(
        `select code, posting_role, is_cash, is_on_account, requires_reference, is_active
           from app.tender_method order by sort_order`,
      ),
    );
    expect(res.rows).toEqual([
      { code: 'CASH', posting_role: 'TILL_CASH', is_cash: true, is_on_account: false, requires_reference: false, is_active: true },
      { code: 'MOMO', posting_role: 'MOMO_WALLET', is_cash: false, is_on_account: false, requires_reference: true, is_active: true },
      { code: 'BANK_TRANSFER', posting_role: 'BANK', is_cash: false, is_on_account: false, requires_reference: true, is_active: true },
      { code: 'CHEQUE', posting_role: 'BANK', is_cash: false, is_on_account: false, requires_reference: true, is_active: true },
      { code: 'ON_ACCOUNT', posting_role: 'AR_TRADE', is_cash: false, is_on_account: true, requires_reference: false, is_active: true },
    ]);
  });

  it('grants the till to every role that sells, and to nobody who does not', async () => {
    const res = await db.withTenant(T1, (tx) =>
      tx.query<{ ref: string; code: string }>(
        `select r.origin_ref as ref, rp.permission_code as code
           from app.role_permission rp join app.role r on r.id = rp.role_id
          where rp.permission_code like 'cash.session.%' and rp.deleted_at is null
          order by 1, 2`,
      ),
    );
    const byRole = new Map<string, string[]>();
    for (const r of res.rows) byRole.set(r.ref, [...(byRole.get(r.ref) ?? []), r.code]);
    for (const ref of ['role:counter_staff', 'role:outlet_manager', 'role:regional_manager']) {
      expect(byRole.get(ref)).toEqual(['cash.session.close', 'cash.session.open']);
    }
    // Accounts records nothing at the counter — segregation of duties.
    expect(byRole.has('role:accounts')).toBe(false);
  });

  it('applies IDEMPOTENTLY: a second run inserts nothing and updates nothing', async () => {
    const before = await db.withTenant(T1, (tx) =>
      tx.query<{ t: string; n: string }>(`
        select 'product' as t, count(*)::text as n from app.product
        union all select 'product_uom', count(*)::text from app.product_uom
        union all select 'category', count(*)::text from app.product_category
        union all select 'uom', count(*)::text from app.unit_of_measure
        union all select 'write_log', count(*)::text from app.write_log
        order by t
      `),
    );
    // A tenant edit survives the re-run — the applier never UPDATEs (01 §1.6).
    await db.asAdmin((tx) =>
      tx.query(
        `update app.product set name = 'RENAMED BY TENANT' where tenant_id = $1 and sku_code = 'SKU-001'`,
        [T1],
      ),
    );
    await db.withTenant(T1, (tx) => applyTemplate(tx, T1));
    const after = await db.withTenant(T1, (tx) =>
      tx.query<{ t: string; n: string }>(`
        select 'product' as t, count(*)::text as n from app.product
        union all select 'product_uom', count(*)::text from app.product_uom
        union all select 'category', count(*)::text from app.product_category
        union all select 'uom', count(*)::text from app.unit_of_measure
        union all select 'write_log', count(*)::text from app.write_log
        order by t
      `),
    );
    expect(after.rows).toEqual(before.rows);
    const renamed = await db.withTenant(T1, (tx) =>
      tx.query<{ name: string }>(`select name from app.product where sku_code = 'SKU-001'`),
    );
    expect(renamed.rows[0]!.name).toBe('RENAMED BY TENANT'); // no live inheritance
  });

  it('refuses a tenant in the wrong jurisdiction', async () => {
    await db.asAdmin((tx) =>
      tx.query(`insert into platform.jurisdiction (code, name, currency_code, currency_symbol, minor_units_per_major)
                values ('NG', 'Nigeria', 'NGN', '₦', 100) on conflict do nothing`),
    );
    const tNg = '018f0000-0000-8000-8000-00000000000e';
    await createTenant(db, { id: tNg, slug: 'lagos-distro', jurisdictionCode: 'NG' });
    await expect(db.withTenant(tNg, (tx) => applyTemplate(tx, tNg))).rejects.toThrow(/jurisdiction/i);
  });
});

describe('tenant #1 locations (onboarding input, NOT template content)', () => {
  it('excludes the capex line: 26 CSV rows → 25 outlets', async () => {
    const plan = await parseOutlets();
    expect(plan.outlets).toHaveLength(25);
    expect(plan.excluded).toHaveLength(1);
    expect(plan.excluded[0]!.name).toMatch(/Initial Fleet/);
  });

  it('builds 1 root + 6 region GROUPs + 25 OUTLETs + 25 per-location TRANSIT nodes', async () => {
    const res = await db.withTenant(T1, (tx) =>
      tx.query<{ kind: string; n: string }>(
        'select kind, count(*)::text as n from app.location group by kind order by kind',
      ),
    );
    const byKind = new Map(res.rows.map((r) => [r.kind, Number(r.n)]));
    expect(byKind.get('GROUP')).toBe(7); // root + 6 regions
    expect(byKind.get('OUTLET')).toBe(25);
    expect(byKind.get('TRANSIT')).toBe(25); // one durable node per stock-holding location (04 §4.7.3)
  });

  it('is idempotent too', async () => {
    const before = await count('select count(*)::text as n from app.location');
    await db.withTenant(T1, (tx) => applyTenant1Locations(tx, T1));
    expect(await count('select count(*)::text as n from app.location')).toBe(before);
  });
});
