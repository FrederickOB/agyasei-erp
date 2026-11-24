/**
 * A sale, end to end, in a real browser: open the till → add products →
 * tender → the on-screen receipt (printing transport `none`, the default) →
 * the sale in Sales with its per-record sending state. Cash, and a split of
 * mobile money (with its reference) and cash. Every step's layout is checked
 * on the screen it is actually on.
 *
 * Uploads are unreachable here unless a test says otherwise, so every record
 * honestly stays "Waiting to send" — and the last test turns the server's acks
 * on and watches the same record become "Saved".
 */
import { test, expect } from './support/device';
import { checkCart, checkOpenTill, checkReceipt, checkTender } from './support/counter-layout';
import { formFactor } from './support/layout';

const CEMENTISH = 'Binder grade A 50kg bag'; // 85.00
const TIMBER = 'Sawn timber 2" x 3" x 12ft'; // 15.00

async function toCounterWithTill(device: import('./support/device').Device, where: string): Promise<void> {
  await device.open();
  if (formFactor(test.info().project.name) === 'laptop') await device.goToCounter();
  await checkOpenTill(device, where);
  await device.openTill('200.00');
}

test('cash: till, cart, tender, on-screen receipt, then in Sales waiting to send', async ({ device, page, api }) => {
  const where = test.info().project.name;
  await toCounterWithTill(device, where);
  // The open was asked of the server first, and it said yes (OpenTill.tsx).
  expect(api.calls.map((c) => c.path)).toContain('cashSession.openCheck');
  await expect(device.tillBar).not.toContainText('opened offline');
  // The empty counter with its whole catalogue on screen, before the first tap.
  await expect(device.product(CEMENTISH)).toBeVisible();
  await checkCart(device, `${where} empty`);

  await device.addProduct(CEMENTISH, 2);
  await device.addProduct(TIMBER);
  await device.expectCartLines(2);
  await checkCart(device, where);

  await device.takePayment.click();
  await expect(device.payment.locator('.tender-total')).toHaveText(/185\.00/);
  await checkTender(device, where);
  // Not ready until somebody says what was handed over.
  await expect(device.completeSale).toBeDisabled();
  await device.payment.getByLabel('Cash received').fill('200.00');
  await expect(device.payment.locator('.tender-change-value')).toHaveText(/15\.00/);
  await device.completeSale.click();

  // The no-printer route: the on-screen receipt opens by itself and IS the receipt.
  const sheet = page.getByRole('dialog', { name: 'Receipt' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(CEMENTISH.slice(0, 20));
  await expect(sheet).toContainText(/185\.00/);
  // What was handed over is on the receipt, as well as what went back.
  await expect(sheet).toContainText(/Cash received\s+\S*200\.00/);
  await expect(sheet).toContainText(/Change\s+\S*15\.00/);
  await sheet.getByRole('button', { name: /close/i }).first().click();
  await expect(sheet).toBeHidden();

  await expect(device.receipt).toContainText(/185\.00/);
  // And on the completion screen: the change first, out of the cash received.
  await expect(device.receipt.locator('.receipt-change')).toContainText('Change to give');
  await expect(device.receipt.locator('.receipt-change-value')).toHaveText(/15\.00/);
  await expect(device.receipt.locator('.receipt-received-value')).toHaveText(/200\.00/);
  await expect(device.receipt.locator('.sync-badge')).toHaveText('Waiting to send');
  const number = (await device.receipt.locator('.receipt-number').innerText()).trim();
  expect(number.length).toBeGreaterThan(0);
  await checkReceipt(device, where);

  // Two writes queued, both the device's: the till's open, and the sale.
  await expect(device.status).toHaveText(/Offline · 2 records waiting/);

  await device.receipt.getByRole('button', { name: /new sale/i }).click();
  await device.expectCartLines(0);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sales' }).click();
  const row = page.getByRole('list', { name: 'Recent sales' }).getByRole('listitem').filter({ hasText: number });
  await expect(row).toContainText(/185\.00/);
  await expect(row.locator('.sync-badge')).toHaveText('Waiting to send');
  expect(api.unhandled).toEqual([]);
});

test('split: mobile money with a reference, cash takes the rest', async ({ device, page }) => {
  const where = test.info().project.name;
  await toCounterWithTill(device, where);
  await device.addProduct(CEMENTISH, 2);
  await device.addProduct(TIMBER);
  await device.takePayment.click();

  await device.payment.getByRole('button', { name: 'Split the payment' }).click();
  const first = device.payment.getByRole('group', { name: 'Payment 1' });
  const second = device.payment.getByRole('group', { name: 'Payment 2' });
  await first.getByRole('group', { name: 'Payment method' }).getByRole('button', { name: 'Mobile money' }).click();
  await first.getByLabel('Amount').fill('100.00');
  // A method that needs a reference is not complete without one.
  await expect(device.completeSale).toBeDisabled();
  await first.getByLabel(/Reference/).fill('MM-778812');
  await expect(second.locator('.tender-rest')).toContainText(/85\.00/);
  await second.getByRole('button', { name: 'Exact' }).click();
  await checkTender(device, `${where} split`);
  await expect(device.completeSale).toBeEnabled();
  await device.completeSale.click();

  const sheet = page.getByRole('dialog', { name: 'Receipt' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: /close/i }).first().click();

  const tenders = device.receipt.locator('.receipt-tender');
  await expect(tenders).toHaveCount(2);
  await expect(tenders.filter({ hasText: 'Mobile money' })).toContainText(/100\.00/);
  await expect(tenders.filter({ hasText: 'Mobile money' })).toContainText('MM-778812');
  await expect(tenders.filter({ hasText: 'Cash' })).toContainText(/85\.00/);
  await checkReceipt(device, `${where} split`);
});

test('a queued sale becomes "Saved" when the server acks it', async ({ device, page, api }) => {
  await toCounterWithTill(device, test.info().project.name);
  await device.addProduct(TIMBER);
  await device.takePayment.click();
  await device.payment.getByRole('button', { name: 'Exact' }).click();
  await device.completeSale.click();
  await page.getByRole('dialog', { name: 'Receipt' }).getByRole('button', { name: /close/i }).first().click();
  await expect(device.receipt.locator('.sync-badge')).toHaveText('Waiting to send');

  // The server comes back and accepts. The runtime retries on its own timer
  // or on the next local change; a new sale is the local change here.
  api.uploadMode = 'ack';
  await device.receipt.getByRole('button', { name: /new sale/i }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sales' }).click();
  const badge = page.getByRole('list', { name: 'Recent sales' }).locator('.sync-badge').first();
  await expect(badge).toHaveText('Saved', { timeout: 45_000 });
  await expect(device.status).toHaveText(/nothing waiting/);

  // What went up: the till's open and the sale, each under its own key, and
  // never a tenant id — that comes from the verified token, server-side.
  expect(api.uploads.map((u) => u.kind)).toEqual(expect.arrayContaining(['cash_session.open']));
  expect(api.uploads.length).toBeGreaterThanOrEqual(2);
  expect(new Set(api.uploads.map((u) => u.idempotency_key)).size).toBe(api.uploads.length);
  expect(JSON.stringify(api.uploads)).not.toMatch(/tenant_?id/i);
});
