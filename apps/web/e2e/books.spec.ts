/**
 * Books → P&L sheet, in a real browser at every size: the management P&L
 * renders from the server's answers, says plainly that it is not the
 * ledger, names the product with no cost, and the expense form opens — and
 * nothing scrolls sideways on the way.
 */
import { test, expect } from './support/device';
import { FIXTURE_CAPABILITIES, permissionsFor } from './support/api-fixtures';
import { expectNoHorizontalScroll } from './support/layout';
import identity from './support/identity.json' with { type: 'json' };

const OUT1 = identity.locationId;
const figures = (over: Record<string, unknown> = {}) => ({
  netSalesMinor: '0', cogsMinor: '0', cogsAtStatedCostMinor: '0', cogsComplete: true, missingCostCount: 0,
  grossProfitMinor: '0', grossMarginPctE4: null, expenses: [], totalExpensesMinor: '0', netProfitMinor: '0',
  ...over,
});

const SHEET = (input: unknown) => {
  const r = (input ?? {}) as { from?: string; to?: string };
  return {
    from: r.from ?? '2026-11-01',
    to: r.to ?? '2026-11-30',
    currencyCode: 'XTS',
    basis: 'MANAGEMENT',
    note: 'Management figures from your sales, costs and recorded expenses — not the audited ledger.',
    scope: { network: true, locationCount: 1 },
    wholeBusinessIncluded: true,
    consolidated: figures({
      netSalesMinor: '12550000', cogsMinor: '9120000', cogsAtStatedCostMinor: '1250000', cogsComplete: false, missingCostCount: 1,
      grossProfitMinor: '3430000', grossMarginPctE4: '273307',
      expenses: [
        { categoryId: 'c1', categoryName: 'Rent', amountMinor: '1500000' },
        { categoryId: 'c2', categoryName: 'Electricity', amountMinor: '320000' },
        { categoryId: 'c3', categoryName: 'Fuel and transport', amountMinor: '185050' },
      ],
      totalExpensesMinor: '2005050', netProfitMinor: '1424950',
    }),
    wholeBusiness: { expenses: [], totalExpensesMinor: '0' },
    locations: [
      {
        locationId: OUT1, locationCode: 'OUT-1', locationName: 'Test outlet one', kind: 'OUTLET',
        ...figures({
          netSalesMinor: '12550000', cogsMinor: '9120000', cogsAtStatedCostMinor: '1250000', cogsComplete: false, missingCostCount: 1,
          grossProfitMinor: '3430000', grossMarginPctE4: '273307',
          expenses: [
            { categoryId: 'c1', categoryName: 'Rent', amountMinor: '1500000' },
            { categoryId: 'c2', categoryName: 'Electricity', amountMinor: '320000' },
            { categoryId: 'c3', categoryName: 'Fuel and transport', amountMinor: '185050' },
          ],
          totalExpensesMinor: '2005050', netProfitMinor: '1424950',
        }),
      },
    ],
    missingCost: [
      {
        productId: 'p9', skuCode: 'P-00009', productName: 'Binding wire 25kg roll', uomCode: 'roll', qtyScale: 0, qtySold: '4',
        byLocation: [{ locationId: OUT1, qtySold: '4' }],
      },
    ],
    method: 'Sales are ex-tax, after discounts, net of voids and returns.',
  };
};

test('books: the P&L sheet renders, and the expense form opens', async ({ device, page, api }) => {
  const where = test.info().project.name;
  api.answer('session.permissions', permissionsFor([...FIXTURE_CAPABILITIES, 'gl.view', 'expense.record']));
  api.answer('expenses.profitSheet', SHEET);
  api.answer('expenses.list', (input) => {
    const r = (input ?? {}) as { from?: string; to?: string };
    return {
      from: r.from ?? '2026-11-01',
      to: r.to ?? '2026-11-30',
      wholeBusinessIncluded: true,
      expenses: [
        {
          expenseId: 'e1', expenseDate: '2026-11-05', locationId: OUT1, locationCode: 'OUT-1', locationName: 'Test outlet one',
          categoryId: 'c1', categoryName: 'Rent', amountMinor: '1500000', currencyCode: 'XTS', paidFrom: 'BANK',
          payee: 'Landlord', reference: 'NOV-RENT', note: null, recordedBy: identity.userId, recordedByName: 'Fixture Manager',
          recordedAt: '2026-11-05T10:00:00.000Z', voided: false, voidReason: null, voidedByName: null, voidedAt: null,
        },
      ],
    };
  });
  api.answer('expenses.categories', () => ({
    categories: [
      { categoryId: 'c1', code: null, name: 'Rent', sortOrder: 0, isActive: true },
      { categoryId: 'c2', code: null, name: 'Electricity', sortOrder: 0, isActive: true },
    ],
  }));
  api.answer('ledger.postingExceptions', () => ({ openCount: 0, exceptions: [] }));

  await device.open();
  await device.goToOffice();
  await page.getByRole('navigation', { name: 'Office' }).getByRole('button', { name: 'Books' }).click();
  const main = page.locator('.office-main');
  await expect(main.getByText(/not the audited ledger/).first()).toBeVisible();
  await expect(main.getByText('Binding wire 25kg roll').first()).toBeVisible();
  await expect(main.getByText('Fuel and transport').first()).toBeVisible();
  await expectNoHorizontalScroll(page, `${where}: P&L sheet`);
  if (process.env['E2E_SHOTS']) await page.screenshot({ path: `${process.env['E2E_SHOTS']}/books-pl-${where}.png`, fullPage: true });

  await main.getByRole('button', { name: /Record expense/ }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoHorizontalScroll(page, `${where}: expense form`);
  if (process.env['E2E_SHOTS']) await page.screenshot({ path: `${process.env['E2E_SHOTS']}/books-expense-${where}.png`, fullPage: false });
  expect(api.unhandled).toEqual([]);
});
