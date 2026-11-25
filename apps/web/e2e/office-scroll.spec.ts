/**
 * The office scrolls to its last line, at every size.
 *
 * The register locks the page to the screen's height while it is the visible
 * view (app.css, "THE LOCK") so the till and the pay dock never move. Opening
 * the office hides the counter's shell — but the register pane inside it is
 * still the counter's active pane, and a lock that only asked about the pane
 * kept the page locked UNDER the office: on a tablet or a laptop every office
 * tab stopped one screen down, the rest clipped and unreachable.
 *
 * Walked the way a person does it: open the office from the counter, go to a
 * long list, scroll down with the wheel, and the last row must come into view.
 */
import { test, expect } from './support/device';
import { FIXTURE_CAPABILITIES, permissionsFor } from './support/api-fixtures';
import { formFactor } from './support/layout';

const SETUP = {
  currencyCode: 'XTS',
  minorUnitsPerMajor: '100',
  units: [{ code: 'BAG', name: 'Bag', qtyScale: 0 }],
  categories: ['Cement'],
  priceLists: [{ id: 'pl-1', code: 'RTL', name: 'Shop price', isTaxInclusive: true }],
  taxCodes: [{ code: 'T.STD', name: 'Standard' }],
  defaultTaxCode: 'T.STD',
  suppliers: [],
  productCount: 80,
};

const PRODUCTS = Array.from({ length: 80 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0');
  return {
    productId: `0190a0b0-0000-7000-8000-000000000${n}`,
    code: `P-00${n}`,
    name: `Long list product ${n}`,
    category: 'Cement',
    unit: 'Bag',
    costE4: null,
    supplier: null,
    sellable: true,
    createdAt: '2026-11-24T10:00:00.000Z',
    prices: [{ priceListId: 'pl-1', priceE4: '12500000' }],
  };
});

test('office: a long tab scrolls to its last row, opened from the counter', async ({ device, page, api }) => {
  const where = test.info().project.name;
  api.answer('session.permissions', permissionsFor([...FIXTURE_CAPABILITIES, 'catalogue.manage']));
  api.answer('products.importSetup', () => SETUP);
  api.answer('products.list', () => ({ products: PRODUCTS }));

  await device.open();
  // The till open, the register on screen — the state a trading tablet is in.
  // (A laptop opens in the office; it goes to the counter first.)
  if (formFactor(where) === 'laptop') await device.goToCounter();
  await device.openTill();
  await expect(page.locator('.register')).toBeVisible();
  await device.goToOffice();
  await page.getByRole('navigation', { name: 'Office' }).getByRole('button', { name: 'Products' }).click();
  const last = page.getByText('Long list product 080');
  await expect(last).toBeAttached();

  const box = page.viewportSize()!;
  await page.mouse.move(box.width / 2, box.height / 2);
  for (let i = 0; i < 40; i += 1) await page.mouse.wheel(0, 1200);

  const lock = await page.evaluate(() => {
    const root = document.getElementById('root');
    return root === null ? '' : `#root overflow=${getComputedStyle(root).overflow} height=${getComputedStyle(root).height}`;
  });
  await expect(last, `${where}: the office's last row is out of reach (${lock})`).toBeInViewport();
  expect(api.unhandled).toEqual([]);
});
