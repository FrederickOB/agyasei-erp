/**
 * THE LIVE-STACK DRILL — Phase 1 acceptance 1 in a real browser, against the
 * REAL dev stack: a sale completes with the device offline, and syncs within
 * 60 seconds of reconnection. Measured, printed, and asserted.
 *
 *   pnpm stack:up && pnpm dev:api          # API :3001, PowerSync :8080, Postgres :5433
 *   pnpm --filter @erp/web e2e:live
 *
 * No fixtures and no seam: `dist-live/` is the production code on the
 * dev-bearer path (e2e/live/build-live.mjs). The catalogue, price list,
 * currency and location arrive over the real PowerSync stream; the sale goes
 * up through the real POST /sync/upload and is acked by the real API.
 *
 * Environment (all optional):
 *   E2E_LIVE_TOKEN       dev bearer to use (default: minted with dev:token)
 *   E2E_LIVE_API_TARGET  where /__live-api forwards (default http://localhost:3001)
 *   E2E_LIVE_POWERSYNC   PowerSync URL (default http://localhost:8080)
 *   E2E_LIVE_PORT        preview port (default 4176)
 *
 * Runs ONE test on ONE device (the primary form factor, an Android tablet),
 * serially, with no retries: a drill that passes on its second try has not
 * passed.
 */
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env['E2E_LIVE_PORT'] ?? 4176);

export default defineConfig({
  testDir: './e2e/live',
  testMatch: /\.live\.ts$/,
  workers: 1,
  retries: 0,
  timeout: 6 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: 'test-results/live',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    serviceWorkers: 'allow',
    trace: 'on',
    viewport: { width: 800, height: 1280 },
    deviceScaleFactor: 1.5,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-GB',
  },
  webServer: {
    command: `node e2e/live/build-live.mjs && pnpm exec vite preview --mode live --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 10 * 60_000,
    stdout: 'pipe',
  },
});
