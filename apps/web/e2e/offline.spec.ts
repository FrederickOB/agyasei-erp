/**
 * Airplane mode after the first load (Phase 1 acceptance 1, the device half):
 * the app comes back up from the service worker with no network at all —
 * shell, wasm SQLite, the PowerSync worker — the till opens offline and says
 * so, a cash sale completes, and the queue is visible in the status bar.
 * Reconnecting drains it and the record turns "Saved".
 *
 * The server here is the fixture (api-mock.ts), so the time printed is the
 * client's half only: reconnect → drain → ack → badge. The live-stack config
 * (playwright.live.config.ts) measures the same path against the real API.
 */
import { Device, test, expect } from './support/device';
import { BuildServer } from './support/build-server';
import { expectNoHorizontalScroll, expectNotClipped, formFactor } from './support/layout';

test('starts cold offline from the service worker, sells, queues, then drains on reconnect', async ({
  device: first,
  context,
  api,
}) => {
  const where = test.info().project.name;
  // Its own origin server, so the test can take the network away from EVERY
  // thread: `setOffline` covers pages, but the PowerSync shared worker kept
  // fetching from `vite preview` — a mutation that dropped the SQLite wasm
  // from the precache still passed. A closed server cannot be reached by anyone.
  const server = await BuildServer.start();
  await first.page.goto(`${server.url}/`);
  await first.waitForShell();

  // First load installs the worker and precaches the build (SQLite wasm included).
  await expect
    .poll(() => first.page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state ?? null), {
      timeout: 60_000,
    })
    .toBe('activated');

  // A COLD start with no network — the tablet switched back on in a dead
  // zone. A reload is not enough either: it re-attaches to the shared worker
  // that is still running with SQLite instantiated. Closing the only page
  // lets the workers end; the next page boots everything from the cache.
  await first.setOffline(true);
  await server.close();
  await first.page.close();
  await new Promise((r) => setTimeout(r, 1_500));
  const page = await context.newPage();
  const device = new Device(page, api);
  await page.goto(`${server.url}/`);
  await device.waitForShell();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  // Served by the worker, not the network: this page is controlled.
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

  if (formFactor(where) === 'laptop') await device.goToCounter();
  await device.openTill('150.00');
  // The pre-open check could not reach the server; the till opened anyway and
  // carries the flag the close report and reconciliation read (§8.2a).
  await expect(device.tillBar).toContainText('opened offline');

  await device.addProduct('Ribbed bar 12mm x 12m length');
  await device.takePayment.click();
  await expect(device.payment.locator('.tender-total')).toHaveText(/185\.00/);
  await device.payment.getByRole('button', { name: 'Exact' }).click();
  await device.completeSale.click();
  await page.getByRole('dialog', { name: 'Receipt' }).getByRole('button', { name: /close/i }).first().click();
  await expect(device.receipt.locator('.sync-badge')).toHaveText('Waiting to send');

  // The queue is in the permanent status bar, in words, never as an error.
  await expect(device.status).toHaveText(/Offline · 2 records waiting/);
  await expect(device.status).not.toContainText(/error/i);
  await expectNoHorizontalScroll(page, `${where}: offline receipt`);
  await expectNotClipped(device.status, `${where}: status bar`);

  // Reconnect: the radio comes back and the server accepts.
  api.uploadMode = 'ack';
  const reconnectedAt = Date.now();
  await device.setOffline(false);
  await expect(device.receipt.locator('.sync-badge')).toHaveText('Saved', { timeout: 60_000 });
  const ms = Date.now() - reconnectedAt;
  await expect(device.status).toHaveText(/nothing waiting/);
  console.log(`[${where}] reconnect → "Saved" (fixture server): ${ms} ms`);
  test.info().annotations.push({ type: 'time-to-saved-ms', description: String(ms) });
  expect(ms).toBeLessThan(60_000);
});
