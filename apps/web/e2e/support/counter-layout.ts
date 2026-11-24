/**
 * The counter's layout contract at each step of a sale, at every size.
 * One function per step so a flow can check the screen it is actually on.
 */
import { expect, test } from '@playwright/test';
import type { Device } from './device';
import { expectNoHorizontalScroll, expectNotClipped, expectTouchTargets, formFactor } from './layout';

/** Touch targets are measured on the touch form factors only. */
function touch(): boolean {
  return formFactor(test.info().project.name) !== 'laptop';
}

export async function checkOpenTill(device: Device, where: string): Promise<void> {
  const { page } = device;
  await expectNoHorizontalScroll(page, `${where}: open till`);
  const screen = page.getByRole('region', { name: 'Open the till' });
  await expectNotClipped(screen.locator('.till-date'), `${where}: the till's date`);
  await expectNotClipped(screen.getByRole('button', { name: 'Open the till' }), `${where}: open-till button`);
  if (touch()) {
    await expectTouchTargets(screen.getByRole('button', { name: 'Open the till' }), `${where}: open-till button`);
    await expectTouchTargets(screen.getByLabel(/Opening float/), `${where}: float input`);
  }
}

/**
 * "Take payment" is on screen wherever the catalogue is scrolled to — and with
 * a bar above the app, as the signed-in device path renders one (AuthGate's
 * session bar: "name · Lock / switch"). Two bugs this guards:
 *   - the bar once sat inside a pane an entrance animation had left
 *     transformed, so `position: fixed` pinned it to the pane, not the screen;
 *   - the register then locked the SHELL to the screen's height, ignoring the
 *     session bar above it, which pushed the dock under the pilot tablet's
 *     taskbar. These tests use the dev path, which has no session bar, so one
 *     is stood in for here, at the same place in the page.
 */
export async function expectPayInView(device: Device, where: string): Promise<void> {
  const { page } = device;
  const scrollTo = (end: boolean) =>
    page.evaluate((toEnd) => {
      const grid = document.querySelector('.catalogue-scroll');
      if (grid !== null) grid.scrollTop = toEnd ? grid.scrollHeight : 0;
      window.scrollTo(0, toEnd ? document.documentElement.scrollHeight : 0);
    }, end);
  const viewport = page.viewportSize();
  const check = async (with_: string): Promise<void> => {
    // At the top (where the misplaced bar sat below the fold under a long
    // catalogue) and at the very end.
    for (const end of [false, true]) {
      await scrollTo(end);
      const box = await device.takePayment.boundingBox();
      const at = `${where}: take-payment ${with_}, catalogue scrolled to the ${end ? 'end' : 'top'}`;
      expect(box, `${at} has a box`).not.toBeNull();
      if (box !== null && viewport !== null) {
        expect(box.y, `${at}: top on screen`).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height, `${at}: bottom on screen`).toBeLessThanOrEqual(viewport.height + 1);
      }
    }
  };
  await check('as the dev path renders it');
  await page.evaluate(() => {
    const bar = document.createElement('div');
    bar.id = 'e2e-session-bar';
    bar.className = 'session-bar';
    bar.style.minHeight = '64px';
    bar.textContent = 'Stand-in session bar';
    document.getElementById('root')?.prepend(bar);
  });
  try {
    await check('under a session bar');
  } finally {
    await page.evaluate(() => document.getElementById('e2e-session-bar')?.remove());
    await scrollTo(false);
  }
}

export async function checkCart(device: Device, where: string): Promise<void> {
  const { page } = device;
  await expectNoHorizontalScroll(page, `${where}: cart`);
  await expectPayInView(device, where);
  await expectNotClipped(device.tillBar, `${where}: till bar`);
  await expectNotClipped(device.tillBar.getByRole('button', { name: 'Cash up' }), `${where}: cash-up button`);
  await expectNotClipped(device.takePayment, `${where}: take-payment button`);
  if (touch()) {
    await expectTouchTargets(page.getByRole('list', { name: 'Products' }).getByRole('button'), `${where}: product cards`);
    await expectTouchTargets(page.getByRole('group', { name: 'Filter by category' }).getByRole('button'), `${where}: category chips`);
    await expectTouchTargets(device.takePayment, `${where}: take payment`);
    await expectTouchTargets(device.tillBar.getByRole('button', { name: 'Cash up' }), `${where}: cash up`);
    const cartLines = page.locator('.cart-panel:visible .cart-line-controls button');
    if ((await cartLines.count()) > 0) await expectTouchTargets(cartLines, `${where}: cart line controls`);
    const summary = page.locator('.cart-bar-summary');
    if (await summary.isVisible()) await expectTouchTargets(summary, `${where}: cart summary`);
  }
}

export async function checkTender(device: Device, where: string): Promise<void> {
  const { page, payment } = device;
  await expectNoHorizontalScroll(page, `${where}: tender`);
  await expectNotClipped(payment.locator('.tender-total'), `${where}: amount due`);
  await expectNotClipped(device.completeSale, `${where}: complete-sale button`);
  if (touch()) {
    await expectTouchTargets(payment.getByRole('group', { name: 'Payment method' }).getByRole('button'), `${where}: payment methods`);
    const quick = payment.getByRole('group', { name: 'Quick amounts' }).getByRole('button');
    if ((await quick.count()) > 0) await expectTouchTargets(quick, `${where}: quick amounts`);
    await expectTouchTargets(payment.locator('input'), `${where}: tender inputs`);
    await expectTouchTargets(device.completeSale, `${where}: complete sale`);
    await expectTouchTargets(payment.getByRole('button', { name: 'Back to cart' }), `${where}: back to cart`);
    await expectTouchTargets(payment.getByRole('button', { name: 'Split the payment' }), `${where}: split`);
  }
}

export async function checkReceipt(device: Device, where: string): Promise<void> {
  const { page } = device;
  await expectNoHorizontalScroll(page, `${where}: receipt`);
  await expectNotClipped(device.receipt.locator('.receipt-number'), `${where}: receipt number`);
  if (touch()) {
    await expectTouchTargets(device.receipt.getByRole('button'), `${where}: receipt actions`);
  }
  await expect(device.receipt).toBeVisible();
}
