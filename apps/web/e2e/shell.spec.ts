/**
 * The shell loads, and lands in the room its form factor is for (ADR-0003 A1):
 * the counter on a tablet and a phone, the office on a laptop. A choice is
 * remembered across a reload.
 */
import { test, expect } from './support/device';
import { expectNoHorizontalScroll, expectTouchTargets, formFactor } from './support/layout';

test('lands in the room its form factor is for, and remembers a choice', async ({ device, page, api }) => {
  await device.open();
  const ff = formFactor(test.info().project.name);

  if (ff === 'laptop') {
    await expect(page.getByRole('navigation', { name: 'Office' })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Office' }).getByRole('button', { name: 'Dashboard' }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(device.counterRoom).toBeHidden();
  } else {
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    // The counter IS the open-till screen until a till is open (08 §8.2a).
    await expect(page.getByRole('region', { name: 'Open the till' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Office' })).toHaveCount(0);
  }
  // The persistent status is there in either room, calm, and says offline.
  await expect(device.status).toContainText('Offline');
  await expectNoHorizontalScroll(page, `${ff} landing`);

  // Walk to the other room and back: the choice outlives a reload.
  if (ff === 'laptop') {
    await device.goToCounter();
    await page.reload();
    await device.waitForShell();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Office' })).toHaveCount(0);
  } else {
    await device.goToOffice();
    await page.reload();
    await device.waitForShell();
    await expect(page.getByRole('navigation', { name: 'Office' })).toBeVisible();
  }
  expect(api.unhandled).toEqual([]);
});

test('the counter room’s navigation is thumb-sized on touch devices', async ({ device, page }) => {
  const ff = formFactor(test.info().project.name);
  test.skip(ff === 'laptop', 'mouse device');
  await device.open();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible();
  await expectTouchTargets(nav.getByRole('button'), 'view switch');
  await expectTouchTargets(page.getByRole('button', { name: 'Open the office' }), 'office door');
  await expectNoHorizontalScroll(page, 'counter navigation');
});
