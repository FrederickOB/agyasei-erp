/**
 * Cash-up (08 §8.2a): expected, counted and the variance are all on screen
 * BEFORE the close is confirmed — a person sees "short by 5.00" while they can
 * still recount, not after it is recorded.
 */
import { test, expect } from './support/device';
import { expectNoHorizontalScroll, expectNotClipped, expectTouchTargets, formFactor } from './support/layout';

test('expected vs counted vs variance, shown before confirm', async ({ device, page }) => {
  const where = test.info().project.name;
  await device.open();
  if (formFactor(where) === 'laptop') await device.goToCounter();
  await device.openTill('200.00');

  // One cash sale of 185.00, so the drawer should hold 385.00.
  await device.addProduct('Binder grade A 50kg bag', 2);
  await device.addProduct('Sawn timber 2" x 3" x 12ft');
  await device.takePayment.click();
  // Read the amount due before "Exact", as a cashier does: a tap still being
  // written when the panel opened lands a moment later and moves it.
  await expect(device.payment.locator('.tender-total')).toHaveText(/185\.00/);
  await device.payment.getByRole('button', { name: 'Exact' }).click();
  await device.completeSale.click();
  await page.getByRole('dialog', { name: 'Receipt' }).getByRole('button', { name: /close/i }).first().click();
  await device.receipt.getByRole('button', { name: /new sale/i }).click();

  await device.tillBar.getByRole('button', { name: 'Cash up' }).click();
  const cashup = page.getByRole('region', { name: 'Cash up the till' });
  await expect(cashup).toBeVisible();
  const expected = cashup.locator('.total-row').filter({ hasText: 'Expected in the drawer' });
  await expect(expected).toContainText(/385\.00/);
  await expect(cashup.locator('.total-row').filter({ hasText: 'Opening float' })).toContainText(/200\.00/);

  const variance = cashup.locator('.till-variance');
  const close = cashup.getByRole('button', { name: 'Close the till' });
  await expect(variance).toContainText('Variance');
  await expect(close).toBeDisabled();

  await cashup.getByLabel('Counted cash in the drawer').fill('380.00');
  await expect(variance).toContainText('Short');
  await expect(variance).toContainText(/5\.00/);
  await expect(variance).toHaveClass(/short/);
  // Shown, and not yet recorded: the button is live and nothing has closed.
  await expect(close).toBeEnabled();
  await expect(device.tillBar).toHaveCount(0);

  await expectNoHorizontalScroll(page, `${where}: cash-up`);
  await expectNotClipped(variance, `${where}: variance`);
  await expectNotClipped(expected, `${where}: expected`);
  await expectNotClipped(close, `${where}: close button`);
  if (formFactor(where) !== 'laptop') {
    await expectTouchTargets(cashup.getByRole('button'), `${where}: cash-up actions`);
    await expectTouchTargets(cashup.locator('input'), `${where}: cash-up inputs`);
  }

  // Over is told apart from short by words and shape, not colour alone.
  await cashup.getByLabel('Counted cash in the drawer').fill('390.00');
  await expect(variance).toContainText('Over');
  await cashup.getByLabel('Counted cash in the drawer').fill('380.00');

  await close.click();
  const closed = page.getByRole('region', { name: 'Till closed' });
  await expect(closed).toBeVisible();
  await expect(closed.locator('.till-variance')).toContainText('Short');
  await expect(closed.locator('.till-variance')).toContainText(/5\.00/);
  await closed.getByRole('button', { name: 'Done' }).click();
  // No till open: the counter is the open-till screen again.
  await expect(page.getByRole('region', { name: 'Open the till' })).toBeVisible();
});
