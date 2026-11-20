/**
 * The back office (the laptop's room, ADR-0003 A1): the dashboard and reports
 * render from the server's answers, and the admin screens — People, Devices,
 * Roles — render the fixture lists. Run at every size: the office is a laptop
 * room first, but a phone is "either room" and must not scroll sideways.
 *
 * Each screen is asserted to have rendered from REAL answers: the fixture
 * names appear, nothing says it could not read a reply, and every procedure
 * the page asked for had a fixture (api.unhandled is empty).
 */
import { test, expect } from './support/device';
import { expectNoHorizontalScroll } from './support/layout';

const UNREADABLE = /could not read|could not answer|would not answer|not part of what you are allowed/i;

test('dashboard and reports render from the server’s answers', async ({ device, page, api }) => {
  const where = test.info().project.name;
  await device.open();
  await device.goToOffice();
  const main = page.locator('.office-main');

  // The dashboard composes tiles from what the session holds.
  await expect(main.getByText('Test outlet one').first()).toBeVisible();
  await expect(main.locator('svg').first()).toBeVisible(); // a chart drew
  await expect(main).not.toContainText(UNREADABLE);
  await expect(main.locator('[aria-busy="true"]')).toHaveCount(0);
  await expectNoHorizontalScroll(page, `${where}: dashboard`);

  await page.getByRole('navigation', { name: 'Office' }).getByRole('button', { name: 'Reports' }).click();
  await expect(main.getByText('Test outlet two').first()).toBeVisible();
  await expect(main).not.toContainText(UNREADABLE);
  await expect(main.locator('[aria-busy="true"]')).toHaveCount(0);
  await expectNoHorizontalScroll(page, `${where}: reports`);

  expect([...new Set(api.calls.map((c) => c.path))]).toEqual(
    expect.arrayContaining(['reports.salesByDay', 'reports.salesByLocation', 'reports.cashPosition']),
  );
  expect(api.unhandled).toEqual([]);
});

for (const [tab, heading, expected] of [
  ['People', 'People', ['Fixture Manager With A Rather Long Display Name', 'Fixture Cashier']],
  ['Devices', 'Devices', ['Counter tablet 1', 'Back-office laptop']],
  ['Roles', 'Roles', ['Counter manager', 'Counter']],
] as const) {
  test(`admin: ${tab} renders the server’s list`, async ({ device, page, api }) => {
    const where = test.info().project.name;
    await device.open();
    await device.goToOffice();
    await page.getByRole('navigation', { name: 'Office' }).getByRole('button', { name: tab }).click();
    const screen = page.getByRole('region', { name: heading });
    await expect(screen.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    for (const text of expected) await expect(screen.getByText(text, { exact: true }).first()).toBeVisible();
    await expect(screen).not.toContainText(UNREADABLE);
    await expectNoHorizontalScroll(page, `${where}: admin ${tab}`);
    expect(api.unhandled).toEqual([]);
  });
}
