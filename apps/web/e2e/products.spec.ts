/**
 * Products (the catalogue from a spreadsheet), walked in a real browser at
 * every size: the screen renders from the server's answers, a product is
 * switched off from its row, a CSV is chosen, checked and imported, and
 * nothing on the way scrolls sideways — the tables scroll inside their own
 * frames, never the page.
 */
import { test, expect } from './support/device';
import { FIXTURE_CAPABILITIES, permissionsFor } from './support/api-fixtures';
import { expectNoHorizontalScroll } from './support/layout';

const CEMENT = '0190a0b0-0000-7000-8000-0000000000c1';

const SETUP = {
  currencyCode: 'XTS',
  minorUnitsPerMajor: '100',
  units: [{ code: 'BAG', name: 'Bag', qtyScale: 0 }],
  categories: ['Cement'],
  priceLists: [
    { id: 'pl-1', code: 'RTL', name: 'Shop price', isTaxInclusive: true },
    { id: 'pl-2', code: 'TRD', name: 'Trade price', isTaxInclusive: false },
  ],
  taxCodes: [{ code: 'T.STD', name: 'Standard' }],
  defaultTaxCode: 'T.STD',
  suppliers: ['Acme Building Supplies Limited'],
  productCount: 1,
};

const row = (lineNo: number, name: string, status: string, issues: string[]) => ({
  lineNo, name, code: '', category: 'Cement', categoryIsNew: false, unit: 'Bag', supplier: 'Acme Building Supplies Limited',
  supplierIsNew: false, taxCode: 'T.STD', costE4: '9800000',
  prices: [
    { priceListId: 'pl-1', priceListName: 'Shop price', priceE4: '12500000' },
    { priceListId: 'pl-2', priceListName: 'Trade price', priceE4: '11000000' },
  ],
  status, issues,
});

test('products: check a file, import the ready rows', async ({ device, page, api }) => {
  const where = test.info().project.name;
  api.answer('session.permissions', permissionsFor([...FIXTURE_CAPABILITIES, 'catalogue.manage']));
  api.answer('products.importSetup', () => SETUP);
  api.answer('products.list', () => ({
    products: [
      {
        productId: CEMENT, code: 'P-00001', name: 'Portland cement 50kg bag', category: 'Cement', unit: 'Bag',
        costE4: '9800000', supplier: 'Acme Building Supplies Limited', createdAt: '2026-11-24T10:00:00.000Z', sellable: true,
        prices: [{ priceListId: 'pl-1', priceE4: '12500000' }, { priceListId: 'pl-2', priceE4: '11000000' }],
      },
    ],
  }));
  api.answer('products.previewImport', () => ({
    fileError: null,
    ignoredColumns: [],
    priceColumns: [{ priceListId: 'pl-1', name: 'Shop price' }, { priceListId: 'pl-2', name: 'Trade price' }],
    summary: { rowCount: 3, readyCount: 1, duplicateCount: 1, problemCount: 1, newCategories: [], newSuppliers: [] },
    rows: [
      row(2, 'White emulsion paint 20 litre bucket', 'ready', []),
      row(3, 'Portland cement 50kg bag', 'duplicate', ['DUPLICATE_NAME']),
      { ...row(4, 'Mystery', 'problem', ['UNKNOWN_UNIT']), unit: 'furlong' },
    ],
  }));
  api.answer('products.setSellable', () => ({ productId: CEMENT, sellable: false, changed: true }));
  api.answer('products.commitImport', () => ({
    importId: 'k', rowCount: 3, importedCount: 1, rejectedCount: 2, createdCategoryCount: 0, createdSupplierCount: 0,
    rejected: [{ lineNo: 3, issues: ['DUPLICATE_NAME'] }, { lineNo: 4, issues: ['UNKNOWN_UNIT'] }],
    created: [{ lineNo: 2, code: 'P-00002' }],
  }));

  await device.open();
  await device.goToOffice();
  await page.getByRole('navigation', { name: 'Office' }).getByRole('button', { name: 'Products' }).click();
  const screen = page.getByRole('region', { name: 'Products' }).first();
  await expect(screen.getByRole('heading', { level: 1, name: 'Products' })).toBeVisible();
  await expect(screen.getByText('Portland cement 50kg bag')).toBeVisible();
  await expectNoHorizontalScroll(page, `${where}: products`);

  // Switch it off from its row: the server's answer shows, nothing widens.
  const onSale = screen.getByRole('switch', { name: 'On sale: Portland cement 50kg bag' });
  await expect(onSale).toHaveAttribute('aria-checked', 'true');
  await onSale.click();
  await expect(onSale).toHaveAttribute('aria-checked', 'false');
  await expect(screen.getByRole('button', { name: 'Switched off (1)' })).toBeVisible();
  expect(api.calls.filter((c) => c.path === 'products.setSellable')).toHaveLength(1);
  await expectNoHorizontalScroll(page, `${where}: products, one switched off`);

  await page.getByLabel('Product file').setInputFiles({
    name: 'list.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Product name,Category,Unit,Price\nA,Cement,Bag,1\nB,Cement,Bag,2\nC,Cement,furlong,3\n'),
  });
  await expect(screen.getByText('3 rows found.')).toBeVisible();
  await screen.getByRole('button', { name: /Check file/ }).click();
  await expect(screen.getByText('A product with this name already exists')).toBeVisible();
  await expectNoHorizontalScroll(page, `${where}: products preview`);
  if (process.env['E2E_SHOTS']) await page.screenshot({ path: `${process.env['E2E_SHOTS']}/products-preview-${where}.png`, fullPage: true });

  await screen.getByRole('button', { name: /Import 1 product$/ }).click();
  await expect(screen.getByText(/1 product added, 2 skipped/)).toBeVisible();
  if (process.env['E2E_SHOTS']) await page.screenshot({ path: `${process.env['E2E_SHOTS']}/products-done-${where}.png`, fullPage: true });
  expect(api.calls.filter((c) => c.path === 'products.commitImport')).toHaveLength(1);
  expect(api.unhandled).toEqual([]);
});
