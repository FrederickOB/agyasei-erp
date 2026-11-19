/**
 * The printer settings page, at every size. It is per device, reached from the
 * counter's own navigation, and its routes are radio rows a thumb has to hit.
 * Which routes are AVAILABLE depends on the browser's capabilities (Web
 * Bluetooth, Web Serial, WebUSB…), so this asserts the page and its default —
 * the on-screen receipt — not a particular printer.
 */
import { test, expect } from './support/device';
import { expectNoHorizontalScroll, expectTouchTargets, formFactor } from './support/layout';

test('printer settings render, default to the on-screen receipt, and fit', async ({ device, page }) => {
  const where = test.info().project.name;
  await device.open();
  if (formFactor(where) === 'laptop') await device.goToCounter();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Printer' }).click();

  const screen = page.getByRole('region', { name: 'Printer settings' });
  await expect(screen.getByRole('heading', { name: 'Printer on this device' })).toBeVisible();
  const routes = screen.getByRole('radiogroup', { name: 'Printer route' });
  await expect(routes.getByRole('radio').first()).toBeVisible();
  // Nothing configured on a fresh device: the on-screen receipt, which needs no hardware.
  await expect(routes.getByRole('radio', { checked: true })).toHaveValue('none');
  await expect(screen.getByRole('group', { name: 'Paper width' })).toBeVisible();

  await expectNoHorizontalScroll(page, `${where}: printer settings`);
  if (formFactor(where) !== 'laptop') {
    await expectTouchTargets(routes.locator('label.printer-route'), `${where}: printer routes`);
    await expectTouchTargets(screen.getByRole('group', { name: 'Paper width' }).getByRole('button'), `${where}: paper width`);
  }
});
