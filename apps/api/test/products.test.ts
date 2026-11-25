/**
 * THE PRODUCT LIST FROM A FILE, AND REMOVING THE CATALOGUE (migration 0032).
 *
 * Real routers, real migrations, RLS as `app_user`. The categories CLAUDE.md
 * §2.7 makes mandatory: prices and costs are exact (minor units × 10⁴, parsed
 * from text, never a float, never assuming 100); the commit is idempotent;
 * and the tenant boundary holds on every read path here. Every refusal is
 * paired with a positive control.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toCsv } from '@erp/contracts';
import { uuidv7 } from '@erp/db';
import type { VerifiedIdentity } from '../src/auth.js';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantA: string;
let tenantB: string;
let owner: VerifiedIdentity;
type Caller = ReturnType<ApiHarness['callerFor']>;
let a: Caller;
let b: Caller;
/** The tenant's OWN first-priority and second price list names, read back, never assumed. */
let firstList: { id: string; name: string };
let secondList: { id: string; name: string };
let unitName: string;
let templateName: string;

async function q<T>(tenant: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return h.db.withTenant(tenant, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function liveCount(tenant: string): Promise<number> {
  const r = await q<{ n: string }>(tenant, `select count(*)::text n from app.product where deleted_at is null`);
  return Number(r[0]!.n);
}

function file(...rows: string[][]): string {
  return toCsv([
    ['Product name *', 'Category *', 'Unit *', `Price: ${firstList.name}`, `Price: ${secondList.name}`, 'Cost price', 'Supplier', 'Product code', 'Tax', 'Notes'],
    ...rows,
  ]);
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('products-a');
  tenantB = await h.provisionTenant('products-b');
  await h.applyTemplate(tenantA, true);
  await h.applyTemplate(tenantB, true);
  owner = await h.identityFor(tenantA, {});
  a = h.callerFor(owner);
  b = h.callerFor(await h.identityFor(tenantB, {}));
  const setup = await a.products.importSetup();
  firstList = setup.priceLists[0]!;
  secondList = setup.priceLists[1]!;
  unitName = setup.units.find((u) => u.qtyScale === 0)!.name;
  templateName = (await q<{ name: string }>(tenantA, `select name from app.product where deleted_at is null order by sku_code limit 1`))[0]!.name;
}, 240_000);

afterAll(async () => {
  await h?.close();
});

describe('importSetup: what the template is built from', () => {
  it('reads the tenant’s own lists, units, tax codes and the tax its catalogue uses most', async () => {
    const s = await a.products.importSetup();
    expect(s.priceLists.length).toBeGreaterThanOrEqual(2);
    expect(s.units.length).toBeGreaterThan(0);
    expect(s.taxCodes.length).toBeGreaterThan(0);
    expect(s.defaultTaxCode).not.toBeNull();
    expect(s.taxCodes.map((t) => t.code)).toContain(s.defaultTaxCode);
    expect(s.productCount).toBe(await liveCount(tenantA));
    // The divisor comes from the pack, as a string — never assumed.
    expect(s.minorUnitsPerMajor).toMatch(/^\d+$/);
  });

  it('is gated on catalogue.manage — Accounts (no catalogue.manage) is refused', async () => {
    const accounts = h.callerFor(await h.principal(tenantA, { roleRef: 'accounts' }));
    await expect(accounts.products.importSetup()).rejects.toThrow(/catalogue\.manage/);
    await expect(accounts.products.list()).rejects.toThrow(/catalogue\.manage/);
    await expect(accounts.products.previewImport({ csv: file(['X', 'Y', unitName, '1', '', '', '', '', '', '']) })).rejects.toThrow(
      /catalogue\.manage/,
    );
    await expect(
      accounts.products.commitImport({ idempotencyKey: uuidv7(), csv: file(['X', 'Y', unitName, '1', '', '', '', '', '', '']) }),
    ).rejects.toThrow(/catalogue\.manage/);
    // Positive control: the owner, same reads.
    expect((await a.products.importSetup()).productCount).toBeGreaterThan(0);
  });
});

describe('previewImport: every row’s verdict, nothing written', () => {
  it('sorts rows into ready, duplicate and problem — and writes nothing', async () => {
    const before = await liveCount(tenantA);
    const p = await a.products.previewImport({
      fileName: 'list.csv',
      csv: file(
        ['Blue paint 4L', 'Paint & finishes', unitName, '1,250.50', '1100', '980.125', 'Acme Paints', '', '', 'Interior'],
        [templateName, 'Paint & finishes', unitName, '10', '', '', '', '', '', ''], // already in the catalogue
        ['blue  PAINT 4l', 'Paint & finishes', unitName, '10', '', '', '', '', '', ''], // same name, other spelling
        ['Mystery item', 'Paint & finishes', 'furlong', '10', '', '', '', '', '', ''],
        ['Free item', 'Paint & finishes', unitName, '', '', '', '', '', '', ''],
        ['Odd price', 'Paint & finishes', unitName, '10.1234567', '', '', '', '', '', ''],
        ['Bad price', 'Paint & finishes', unitName, 'GH 10', '', '', '', '', '', ''],
        ['Taxed oddly', 'Paint & finishes', unitName, '10', '', '', '', '', 'NOT-A-TAX', ''],
        ['', 'Paint & finishes', unitName, '10', '', '', '', '', '', ''],
      ),
    });
    expect(p.fileError).toBeNull();
    expect(p.rows.map((r) => [r.lineNo, r.status, r.issues])).toEqual([
      [2, 'ready', []],
      [3, 'duplicate', ['DUPLICATE_NAME']],
      [4, 'duplicate', ['DUPLICATE_IN_FILE']],
      [5, 'problem', ['UNKNOWN_UNIT']],
      [6, 'problem', ['NO_PRICE']],
      [7, 'problem', ['PRICE_TOO_PRECISE']],
      [8, 'problem', ['BAD_PRICE']],
      [9, 'problem', ['UNKNOWN_TAX_CODE']],
      [10, 'problem', ['MISSING_NAME']],
    ]);
    expect(p.summary).toMatchObject({ rowCount: 9, readyCount: 1, duplicateCount: 2, problemCount: 6 });
    expect(p.summary!.newCategories).toEqual(['Paint & finishes']);
    expect(p.summary!.newSuppliers).toEqual(['Acme Paints']);
    // Exact: 1,250.50 → 125050 minor units → × 10⁴; 980.125 keeps its third decimal.
    expect(p.rows[0]!.prices).toEqual([
      { priceListId: firstList.id, priceListName: firstList.name, priceE4: '1250500000' },
      { priceListId: secondList.id, priceListName: secondList.name, priceE4: '1100000000' },
    ]);
    expect(p.rows[0]!.costE4).toBe('980125000');
    expect(await liveCount(tenantA)).toBe(before);
  });

  it('names a price column that matches none of the tenant’s lists, instead of dropping it', async () => {
    const p = await a.products.previewImport({
      csv: toCsv([['Product name', 'Category', 'Unit', 'Price: Nobody’s list'], ['X', 'Y', unitName, '1']]),
    });
    expect(p.fileError).toMatch(/does not name one of your price lists/);
    expect(p.rows).toEqual([]);
  });

  it('a bare “Price” column is the tenant’s first-priority list', async () => {
    const p = await a.products.previewImport({
      csv: toCsv([['Name', 'Category', 'Unit', 'Price', 'Colour'], ['Lone item', 'Misc', unitName, '5', 'red']]),
    });
    expect(p.priceColumns).toEqual([{ priceListId: firstList.id, name: firstList.name }]);
    expect(p.ignoredColumns).toEqual(['Colour']);
    expect(p.rows[0]!.status).toBe('ready');
  });
});

describe('commitImport: the good rows land, exactly, once', () => {
  it('creates ready rows with their prices, cost, unit and supplier; hands back the rest', async () => {
    const before = await liveCount(tenantA);
    const key = uuidv7();
    const csv = file(
      ['Red paint 4L', 'Paints (import)', unitName, '1,250.50', '1100', '980.125', 'Brushworks Ltd', '', '', 'Gloss'],
      ['Green paint 4L', 'paints (IMPORT)', unitName, '99.99', '', '', 'brushworks ltd', 'GRN-4', '', ''],
      [templateName, 'Paints (import)', unitName, '10', '', '', '', '', '', ''],
      ['Broken', 'Paints (import)', 'furlong', '10', '', '', '', '', '', ''],
    );
    const r = await a.products.commitImport({ idempotencyKey: key, fileName: 'paints.csv', csv });
    expect(r).toMatchObject({ importId: key, rowCount: 4, importedCount: 2, rejectedCount: 2, createdCategoryCount: 1, createdSupplierCount: 1 });
    expect(r.rejected).toEqual([
      { lineNo: 4, issues: ['DUPLICATE_NAME'] },
      { lineNo: 5, issues: ['UNKNOWN_UNIT'] },
    ]);
    expect(r.created[1]).toEqual({ lineNo: 3, code: 'GRN-4' });
    expect(r.created[0]!.code).toMatch(/^P-\d{5}$/);
    expect(await liveCount(tenantA)).toBe(before + 2);

    const rows = await q<{
      name: string; sku: string; category: string; uom_default: boolean; tol: number; num: string; den: string;
      price_first: string | null; price_second: string | null; cost: string | null; supplier: string | null; preferred: boolean | null;
      write_id: string;
    }>(
      tenantA,
      `select p.name, p.sku_code sku, c.name category, pu.is_default_sell uom_default, pu.tolerance_bp tol,
              pu.factor_num::text num, pu.factor_den::text den,
              (select unit_price_e4::text from app.price_list_item i where i.product_id = p.id and i.price_list_id = $1) price_first,
              (select unit_price_e4::text from app.price_list_item i where i.product_id = p.id and i.price_list_id = $2) price_second,
              pc.cost_e4::text cost, s.name supplier, sp.is_preferred preferred, p.write_id
         from app.product p
         join app.product_category c on c.id = p.category_id
         join app.product_uom pu on pu.product_id = p.id
         left join app.product_cost pc on pc.product_id = p.id
         left join app.supplier_product sp on sp.product_id = p.id
         left join app.supplier s on s.id = sp.supplier_id
        where p.write_id = $3 order by p.name`,
      [firstList.id, secondList.id, key],
    );
    expect(rows).toEqual([
      {
        name: 'Green paint 4L', sku: 'GRN-4', category: 'Paints (import)', uom_default: true, tol: 0, num: '1', den: '1',
        price_first: '99990000', price_second: null, cost: null, supplier: 'Brushworks Ltd', preferred: true, write_id: key,
      },
      {
        name: 'Red paint 4L', sku: r.created[0]!.code, category: 'Paints (import)', uom_default: true, tol: 0, num: '1', den: '1',
        price_first: '1250500000', price_second: '1100000000', cost: '980125000', supplier: 'Brushworks Ltd', preferred: true, write_id: key,
      },
    ]);
    // One category and one supplier, however many rows named them, in whatever case.
    expect(await q(tenantA, `select 1 from app.product_category where lower(name) = 'paints (import)'`)).toHaveLength(1);
    expect(await q(tenantA, `select 1 from app.supplier where lower(name) = 'brushworks ltd'`)).toHaveLength(1);
    expect(await q(tenantA, `select imported_count, rejected_count, file_name from app.catalogue_import where id = $1`, [key])).toEqual([
      { imported_count: 2, rejected_count: 2, file_name: 'paints.csv' },
    ]);

    // The same key replays the stored answer and creates nothing more.
    expect(await a.products.commitImport({ idempotencyKey: key, fileName: 'paints.csv', csv })).toEqual(r);
    expect(await liveCount(tenantA)).toBe(before + 2);
    // The same rows under a NEW key are now duplicates of what landed.
    const again = await a.products.commitImport({ idempotencyKey: uuidv7(), csv });
    expect(again.importedCount).toBe(0);
    expect(again.rejected.map((x) => x.issues[0])).toEqual(['DUPLICATE_NAME', 'DUPLICATE_CODE', 'DUPLICATE_NAME', 'UNKNOWN_UNIT']);
    expect(await liveCount(tenantA)).toBe(before + 2);
  });

  it('a created product is ready for the counter: default selling unit, price in force today', async () => {
    const list = await a.products.list();
    const red = list.products.find((p) => p.name === 'Red paint 4L')!;
    expect(red.prices).toEqual(
      expect.arrayContaining([
        { priceListId: firstList.id, priceE4: '1250500000' },
        { priceListId: secondList.id, priceE4: '1100000000' },
      ]),
    );
    expect(red).toMatchObject({ costE4: '980125000', supplier: 'Brushworks Ltd', category: 'Paints (import)', sellable: true });
  });

  it('an “On sale: No” row loads switched off; a value that is neither yes nor no is refused by name', async () => {
    const csv = toCsv([
      ['Product name', 'Category', 'Unit', 'Price', 'On sale'],
      ['Shelved varnish', 'Paints (import)', unitName, '10', 'No'],
      ['Ready varnish', 'Paints (import)', unitName, '10', 'Yes'],
      ['Unsure varnish', 'Paints (import)', unitName, '10', 'perhaps'],
    ]);
    const preview = await a.products.previewImport({ csv });
    expect(preview.rows.map((r) => [r.name, r.onSale, r.status])).toEqual([
      ['Shelved varnish', false, 'ready'],
      ['Ready varnish', true, 'ready'],
      ['Unsure varnish', true, 'problem'],
    ]);
    const r = await a.products.commitImport({ idempotencyKey: uuidv7(), csv });
    expect(r.rejected).toEqual([{ lineNo: 4, issues: ['BAD_ON_SALE'] }]);
    const list = (await a.products.list()).products;
    expect(list.find((p) => p.name === 'Shelved varnish')).toMatchObject({ sellable: false });
    expect(list.find((p) => p.name === 'Ready varnish')).toMatchObject({ sellable: true });
  });
});

describe('removeAll: archive, confirmed against the count that was shown', () => {
  it('refuses a stale count and removes nothing; the right count archives products and what hangs off them', async () => {
    const n = await liveCount(tenantA);
    const bBefore = await liveCount(tenantB);
    await expect(a.products.removeAll({ idempotencyKey: uuidv7(), expectedCount: n - 1 })).rejects.toThrow(/CATALOGUE_CHANGED/);
    expect(await liveCount(tenantA)).toBe(n);

    const r = await a.products.removeAll({ idempotencyKey: uuidv7(), expectedCount: n });
    expect(r).toEqual({ archivedCount: n });
    expect(await liveCount(tenantA)).toBe(0);
    for (const table of ['product_uom', 'price_list_item', 'product_cost', 'supplier_product']) {
      const live = await q(tenantA, `select 1 from app.${table} where deleted_at is null and product_id is not null`);
      expect(live, table).toEqual([]);
    }
    // Archived, never deleted: history keeps its foreign keys.
    expect(Number((await q<{ n: string }>(tenantA, `select count(*)::text n from app.product`))[0]!.n)).toBeGreaterThanOrEqual(n);
    // The other tenant's catalogue is untouched.
    expect(await liveCount(tenantB)).toBe(bBefore);
    // And the names are free again: the same product can be loaded fresh.
    const back = await a.products.commitImport({
      idempotencyKey: uuidv7(),
      csv: file(['Red paint 4L', 'Paints (import)', unitName, '1250.50', '', '', '', '', '', '']),
    });
    expect(back.importedCount).toBe(1);
  });

  it('is gated on catalogue.manage — an outlet manager is refused and nothing moves', async () => {
    const outlet = await h.firstOutlet(tenantB);
    const manager = h.callerFor(await h.principal(tenantB, { roleRef: 'outlet_manager', scopeLocationId: outlet.id }));
    const n = await liveCount(tenantB);
    await expect(manager.products.removeAll({ idempotencyKey: uuidv7(), expectedCount: n })).rejects.toThrow(/catalogue\.manage/);
    expect(await liveCount(tenantB)).toBe(n);
  });
});

describe('tenant isolation on every products read', () => {
  it('[isolation:products.list] tenant B’s products never appear in A’s catalogue, and A’s count is exactly A’s', async () => {
    await b.products.commitImport({
      idempotencyKey: uuidv7(),
      csv: file(['Only-in-B widget', 'B-only category', unitName, '7', '', '3', 'B-only supplier', 'B-ONLY-1', '', '']),
    });
    // Privileged, explicit-predicate read: B really holds the row.
    const bHolds = await q(tenantB, `select 1 from app.product where tenant_id = $1 and name = 'Only-in-B widget'`, [tenantB]);
    expect(bHolds).toHaveLength(1);
    const listA = await a.products.list();
    expect(listA.products.length).toBe(await liveCount(tenantA));
    expect(listA.products.length).toBeGreaterThan(0);
    const json = JSON.stringify(listA);
    for (const leak of ['Only-in-B widget', 'B-ONLY-1', 'B-only supplier', 'B-only category', tenantB]) {
      expect(json).not.toContain(leak);
    }
  });

  it('[isolation:products.importSetup] B’s categories and suppliers are not offered to A', async () => {
    const s = await a.products.importSetup();
    expect(s.categories).not.toContain('B-only category');
    expect(s.suppliers).not.toContain('B-only supplier');
    expect(s.productCount).toBe(await liveCount(tenantA));
    expect(JSON.stringify(s)).not.toContain(tenantB);
  });

  it('a name that exists only in B is not a duplicate in A — each tenant’s catalogue is its own', async () => {
    const p = await a.products.previewImport({ csv: file(['Only-in-B widget', 'Misc', unitName, '1', '', '', '', 'B-ONLY-1', '', '']) });
    expect(p.rows[0]!.status).toBe('ready');
  });
});
