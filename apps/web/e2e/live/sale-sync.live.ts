/**
 * Phase 1 acceptance 1, live: a sale completes with the device offline and
 * syncs within 60 seconds of reconnection. Against the REAL dev stack — see
 * playwright.live.config.ts for how to run it and what it needs.
 *
 * "Synced" means what the counter shows a person: the sale's own badge turns
 * from "Waiting to send" to "Saved", which happens ONLY on the real API's
 * per-key ack (src/data/sync/upload.ts), and the status bar's queue is empty.
 */
import { expect, test } from '@playwright/test';

const API = process.env['E2E_LIVE_API_TARGET'] ?? 'http://localhost:3001';
const SYNC = process.env['E2E_LIVE_POWERSYNC'] ?? 'http://localhost:8080';

test('offline sale → reconnect → synced, with the time measured', async ({ page, context, request }) => {
  // ── Preconditions, said plainly rather than discovered as a timeout ──────
  const health = await request.get(`${API}/healthz`).catch(() => null);
  expect(health?.ok(), `the API is not answering at ${API}/healthz — run pnpm dev:api`).toBe(true);
  const sync = await request.get(SYNC).catch(() => null);
  expect(sync, `nothing is listening at ${SYNC} — run pnpm stack:up`).not.toBeNull();

  const status = page.locator('.status-bar:visible').first();
  await page.goto('/');
  await expect(status, 'the shell did not load').toBeVisible({ timeout: 120_000 });
  await expect(status, 'this build is not on the dev-bearer path').not.toContainText('Local only');

  // First sync: the tenant's catalogue, price list, currency and location
  // stream down. The status turns Online when PowerSync is connected.
  await expect(status, 'PowerSync never connected').toContainText('Online', { timeout: 180_000 });

  const counterNav = page.getByRole('navigation', { name: 'Main' });
  if (!(await counterNav.isVisible())) await page.getByRole('button', { name: /^Open counter/ }).click();
  await counterNav.getByRole('button', { name: /^Counter/ }).click();

  // A fresh browser context is a fresh device: open its till (online — the
  // real server answers the pre-open check).
  const openTill = page.getByRole('region', { name: 'Open the till' });
  if (await openTill.isVisible({ timeout: 30_000 }).catch(() => false)) {
    await expect(openTill.locator('.till-date')).not.toHaveText('…');
    await openTill.getByLabel(/Opening float/).fill('0');
    await openTill.getByRole('button', { name: 'Open the till' }).click();
  }
  await expect(page.locator('.till-bar')).toBeVisible({ timeout: 60_000 });
  const products = page.getByRole('list', { name: 'Products' }).getByRole('button');
  await expect(products.first(), 'no catalogue arrived over the sync stream').toBeVisible({ timeout: 120_000 });
  await expect(status).toHaveText(/Online · all saved/, { timeout: 120_000 });

  // ── Airplane mode, then a cash sale ──────────────────────────────────────
  await context.setOffline(true);
  await products.first().click();
  await page.getByRole('button', { name: 'Take payment' }).locator('visible=true').first().click();
  const payment = page.getByRole('region', { name: 'Payment' });
  await payment.getByRole('button', { name: 'Exact' }).click();
  const offlineStarted = Date.now();
  await payment.getByRole('button', { name: 'Complete sale' }).click();
  const sheet = page.getByRole('dialog', { name: 'Receipt' });
  if (await sheet.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await sheet.getByRole('button', { name: /close/i }).first().click();
  }
  const receipt = page.getByRole('region', { name: 'Sale recorded' });
  const badge = receipt.locator('.sync-badge');
  await expect(badge).toHaveText('Waiting to send');
  const saleMs = Date.now() - offlineStarted;
  const number = (await receipt.locator('.receipt-number').innerText()).trim();

  // ── Reconnect and time it ────────────────────────────────────────────────
  await page.waitForTimeout(3_000); // genuinely offline for a moment, not a blip
  const reconnectedAt = Date.now();
  await context.setOffline(false);
  await expect(badge, 'the sale was not acked by the API within 60 s').toHaveText('Saved', { timeout: 60_000 });
  const syncedMs = Date.now() - reconnectedAt;
  await expect(status).toHaveText(/Online · all saved/, { timeout: 60_000 });

  const line =
    `[live] sale ${number}: recorded offline in ${saleMs} ms; ` +
    `reconnect → "Saved" (API ack) in ${syncedMs} ms (acceptance: < 60000 ms)`;
  console.log(line);
  test.info().annotations.push({ type: 'time-to-synced-ms', description: String(syncedMs) });
  expect(syncedMs).toBeLessThan(60_000);
});
