/**
 * Browser tests for the PWA — real Chromium, real layout, real service worker,
 * real wasm SQLite — at the three form factors ADR-0003 A1 names:
 *
 *   tablet  (primary — the counter) 800×1280 portrait and 1280×800 landscape
 *   laptop  (secondary — the back office) 1366×768, mouse
 *   phone   (secondary — 360 px is the floor) 360×780
 *
 * Chromium only: Android Chrome IS Chromium, and iOS is not a target.
 *
 *   pnpm --filter @erp/web e2e
 *
 * builds `dist-e2e/` and a production `dist-guard/` (e2e/build.mjs), serves the
 * former with `vite preview` on :4173 (E2E_PORT to move it), and runs every
 * spec under e2e/ at every size. How a device is made ready without the live
 * stack — and why that is honest — is written down in e2e/support/device.ts.
 * The live-stack drill is a separate config: playwright.live.config.ts.
 */
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 4173);
const CI = Boolean(process.env['CI']);

/** Recent Chrome on Android; tablets omit "Mobile", phones carry it. */
const CHROME = 'Chrome/131.0.0.0';
const ANDROID_TABLET_UA = `Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) ${CHROME} Safari/537.36`;
const ANDROID_PHONE_UA = `Mozilla/5.0 (Linux; Android 12; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) ${CHROME} Mobile Safari/537.36`;

type Use = NonNullable<PlaywrightTestConfig['use']>;

const tablet = (width: number, height: number): Use => ({
  viewport: { width, height },
  deviceScaleFactor: 1.5,
  isMobile: true,
  hasTouch: true,
  userAgent: ANDROID_TABLET_UA,
});

export default defineConfig({
  testDir: './e2e',
  // Matched against ABSOLUTE paths; the live drill has its own config.
  testIgnore: ['**/live/**'],
  // Each test is its own browser context: its own OPFS, IndexedDB and service
  // worker registration — a factory-fresh device.
  fullyParallel: true,
  forbidOnly: CI,
  // Each worker runs a Chromium with wasm SQLite and the PowerSync worker.
  // E2E_WORKERS overrides, e.g. 1 on a machine that is already busy.
  workers: Number(process.env['E2E_WORKERS'] ?? (CI ? 2 : 3)),
  retries: CI ? 1 : 0,
  // wasm SQLite and the PowerSync worker start cold in every context; on a
  // loaded CI runner that is seconds, not milliseconds.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-GB',
    timezoneId: 'UTC',
  },
  webServer: {
    command: `pnpm exec vite preview --mode e2e --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !CI,
    timeout: 120_000,
  },
  projects: [
    // Node-only: proves the seam is absent from a production build.
    { name: 'build-guard', testMatch: /build-guard\.spec\.ts$/ },
    { name: 'tablet', testIgnore: /build-guard/, use: tablet(800, 1280) },
    { name: 'tablet-landscape', testIgnore: /build-guard/, use: tablet(1280, 800) },
    {
      name: 'laptop',
      testIgnore: /build-guard/,
      use: { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    },
    {
      name: 'phone',
      testIgnore: /build-guard/,
      use: {
        viewport: { width: 360, height: 780 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent: ANDROID_PHONE_UA,
      },
    },
  ],
});
