/**
 * The install and update story (§8.11, ADR-0003): the reason this is a PWA.
 *
 *   · the web manifest is valid and Chromium judges the app installable;
 *   · the service worker registers, precaches the build (SQLite wasm included)
 *     and controls the next load;
 *   · a new deploy WAITS — and the "update ready" chip does not activate it
 *     while a sale is in progress, nor when the release gate says to stay, nor
 *     when the gate cannot be reached; it activates at a safe point when the
 *     gate names a different build.
 */
import { test, expect } from './support/device';
import { BuildServer } from './support/build-server';
import { expectNoHorizontalScroll, expectNotClipped, expectTouchTargets, formFactor } from './support/layout';

test('the manifest is valid and Chromium judges the app installable', async ({ device, page }) => {
  await device.open();
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const res = await page.request.get(href!);
  expect(res.ok()).toBe(true);
  const manifest = (await res.json()) as Record<string, unknown>;
  expect(manifest['name']).toBeTruthy();
  expect(manifest['short_name']).toBeTruthy();
  expect(manifest['display']).toBe('standalone');
  expect(manifest['start_url']).toBe('/');
  const icons = manifest['icons'] as { src: string; sizes: string; type: string }[];
  expect(icons.length).toBeGreaterThan(0);
  for (const icon of icons) {
    expect(icon.sizes).toBeTruthy();
    const got = await page.request.get(icon.src);
    expect(got.ok(), `icon ${icon.src}`).toBe(true);
    expect(got.headers()['content-type']).toContain(icon.type);
  }

  // Chromium's own verdict, over the DevTools protocol.
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state ?? null))
    .toBe('activated');
  const cdp = await page.context().newCDPSession(page);
  const parsed = (await cdp.send('Page.getAppManifest')) as { errors: { message: string; critical: number }[] };
  expect(parsed.errors.filter((e) => e.critical === 1), 'critical manifest errors').toEqual([]);
  const installability = (await cdp.send('Page.getInstallabilityErrors')) as {
    installabilityErrors: { errorId: string }[];
  };
  // A Playwright context is an off-the-record profile; that one is the harness, not the app.
  const errors = installability.installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito');
  expect(errors, 'installability errors').toEqual([]);
});

test('the service worker precaches the build and controls the next load', async ({ device, page }) => {
  await device.open();
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    return { scope: r.scope, state: r.active?.state ?? null };
  });
  expect(new URL(reg.scope).pathname).toBe('/');
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state ?? null))
    .toBe('activated');
  const precached = await page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
    }
    return out;
  });
  expect(precached.some((p) => p.endsWith('.wasm')), 'SQLite wasm is in the atomic precache').toBe(true);
  expect(precached.some((p) => p === '/index.html')).toBe(true);
  // §8.11: the gate itself is never cached.
  expect(precached).not.toContain('/release.json');

  await page.reload();
  await device.waitForShell();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
});

test('an update waits, and never activates under a sale in progress', async ({ device, page }) => {
  const where = test.info().project.name;
  const server = await BuildServer.start();
  try {
    await page.goto(`${server.url}/`);
    await device.waitForShell();
    await expect
      .poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state ?? null))
      .toBe('activated');
    await page.reload();
    await device.waitForShell();
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    if (formFactor(where) === 'laptop') await device.goToCounter();
    await device.openTill('100.00');
    await device.addProduct('PVC elbow 50mm');
    await device.expectCartLines(1);

    // A deploy lands: a byte-different worker, and the gate names the new build.
    server.bumpServiceWorker();
    server.setRelease({ build_id: 'e2e-next', min_client_schema: 1, max_client_schema: 1 });
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())?.update();
    });
    const chip = page.getByRole('button', { name: /Update ready/ }).locator('visible=true').first();
    await expect(chip).toBeVisible({ timeout: 60_000 });
    const waiting = () => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting !== null);
    expect(await waiting()).toBe(true);

    // The chip is chrome a cashier has to be able to hit, and it must fit.
    await expectNoHorizontalScroll(page, `${where}: status bar with the update chip`);
    await expectNotClipped(chip, `${where}: update chip`);
    if (formFactor(where) !== 'laptop') await expectTouchTargets(chip, `${where}: update chip`);

    // Mid-sale: tapping it defers. Same page, same worker, still waiting.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>)['__e2e_same_page__'] = true;
    });
    await chip.click();
    await page.waitForTimeout(2_000);
    expect(await waiting()).toBe(true);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)['__e2e_same_page__'])).toBe(true);

    // Finish the sale: the cart is empty, a safe point.
    await device.takePayment.click();
    await device.payment.getByRole('button', { name: 'Exact' }).click();
    await device.completeSale.click();
    await page.getByRole('dialog', { name: 'Receipt' }).getByRole('button', { name: /close/i }).first().click();
    await device.receipt.getByRole('button', { name: /new sale/i }).click();
    await device.expectCartLines(0);

    // The gate says "stay on the build you have": defer, even at a safe point.
    server.setRelease({ build_id: 'e2e', min_client_schema: 1, max_client_schema: 1 });
    await chip.click();
    await page.waitForTimeout(2_000);
    expect(await waiting()).toBe(true);

    // The gate cannot be reached: defer. Never activate blind.
    server.setRelease(null);
    await chip.click();
    await page.waitForTimeout(2_000);
    expect(await waiting()).toBe(true);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)['__e2e_same_page__'])).toBe(true);

    // Safe point and a sanctioned build: it activates and the page reloads into it.
    server.setRelease({ build_id: 'e2e-next', min_client_schema: 1, max_client_schema: 1 });
    await chip.click();
    await expect
      .poll(
        () =>
          page
            .evaluate(() => (window as unknown as Record<string, unknown>)['__e2e_same_page__'] ?? null)
            .catch(() => 'navigating'),
        { timeout: 30_000 },
      )
      .toBeNull();
    await device.waitForShell();
    await expect.poll(waiting).toBe(false);
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    // The till and its sale survived the update: they live in SQLite, not the page.
    if (formFactor(where) === 'laptop') await device.goToCounter();
    await expect(device.tillBar).toBeVisible();
  } finally {
    await server.close();
  }
});
