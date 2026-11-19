/// <reference types="vitest" />
/**
 * Vite build for the installable PWA shell (§8.1, ADR-0003).
 *
 * - `@erp/money` is aliased to its SOURCE so `vite build`, `tsc` and vitest all
 *   work without a prebuilt dist/ (the workspace dependency still resolves at
 *   integration; the alias simply removes the build-order dependency).
 * - The PowerSync web SDK ships wasm + workers; it must be excluded from
 *   optimizeDeps and workers must be ES modules.
 * - Service worker: Workbox via vite-plugin-pwa, `registerType: 'prompt'` and
 *   skipWaiting OFF — a new version never activates under a cashier mid-sale.
 *   Activation is gated by src/sw/version-gate.ts (§8.11; §9 release rings).
 * - `--mode e2e` is the browser-test build (playwright.config.ts), and differs from a
 *   production build in exactly two structural ways:
 *     · it writes to dist-e2e/, never dist/ — the web image copies dist/;
 *     · `import.meta.env.MODE === 'e2e'` compiles in the download seam
 *       (src/e2e/download-seam.ts). In every other mode that branch is dead
 *       code and Rollup drops it with its chunk; e2e/build-guard.spec.ts greps
 *       a production build to prove it, against the e2e build as control.
 *   It also refuses to build unless the API it names is the reserved
 *   `.invalid` fixture origin, so a seam build can never be pointed at a
 *   real server.
 * - `--mode live` is the same production code built for the live-stack drill
 *   (playwright.live.config.ts): no seam, its own dist-live/.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';

const here = path.dirname(fileURLToPath(import.meta.url));
const isVitest = Boolean(process.env['VITEST']);

/** Where each non-default build mode writes. Never `dist/`. */
const OUT_DIRS: Readonly<Record<string, string>> = { e2e: 'dist-e2e', live: 'dist-live' };

function assertE2eTargetsFixtureOrigin(mode: string): void {
  if (mode !== 'e2e') return;
  const api = process.env['VITE_API_URL'] ?? '';
  let host = '';
  try {
    host = new URL(api).hostname;
  } catch {
    host = '';
  }
  if (!host.endsWith('.invalid')) {
    throw new Error(
      `refusing: --mode e2e compiles in the download seam and must name the reserved ` +
        `.invalid fixture origin as VITE_API_URL (got "${api}"). Build it with e2e/build.mjs.`,
    );
  }
}

export default defineConfig(({ mode, isPreview }) => {
  // Serving an existing dist-e2e/ compiles nothing; building or dev-serving does.
  if (isPreview !== true) assertE2eTargetsFixtureOrigin(mode);
  return {
    plugins: [
      react(),
      ...(isVitest
        ? []
        : [
            wasm(),
            topLevelAwait(),
            VitePWA({
              registerType: 'prompt',
              workbox: {
                // §8.11: activation is deliberate. Never auto-claim a live till.
                skipWaiting: false,
                clientsClaim: false,
                globPatterns: ['**/*.{js,css,html,svg,wasm,woff2}'],
                // The SQLite wasm binary must be part of the atomic precache.
                maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
                // The version gate and the sync endpoint are never cached (§8.11).
                runtimeCaching: [
                  { urlPattern: /\/release\.json$/, handler: 'NetworkOnly' },
                ],
                navigateFallbackDenylist: [/^\/release\.json$/],
              },
              manifest: {
                // Product chrome, not tenant vocabulary (§8.9): generic product
                // copy only. Tenant branding arrives as configuration data.
                name: 'Counter',
                short_name: 'Counter',
                description: 'Offline-first point of sale',
                display: 'standalone',
                orientation: 'any',
                start_url: '/',
                background_color: '#f5f4f0',
                theme_color: '#20242b',
                icons: [
                  { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
                ],
              },
            }),
          ]),
    ],
    resolve: {
      alias: {
        // The ONE wire contract (packages/contracts). Aliased to SOURCE for the
        // same reason as @erp/money: `vite build`, `tsc` and vitest all see the
        // definitions the API parses against, with no build-order dependency.
        // zod is the package's only dependency and bundles for the browser.
        '@erp/contracts': path.resolve(here, '../../packages/contracts/src/index.ts'),
        '@erp/money': path.resolve(here, '../../packages/money/src/index.ts'),
      },
    },
    optimizeDeps: {
      exclude: ['@journeyapps/wa-sqlite', '@powersync/web'],
    },
    worker: {
      format: 'es',
      plugins: () => [wasm(), topLevelAwait()],
    },
    define: {
      __BUILD_ID__: JSON.stringify(process.env['BUILD_ID'] ?? 'dev'),
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      outDir: OUT_DIRS[mode] ?? 'dist',
    },
    // The live-stack drill serves its own build on :4176, an origin the dev
    // API's CORS allow-list does not name (it lists :5173). Rather than ask for
    // the API to be restarted mid-drill, the preview server forwards
    // /__live-api to it: the REAL API answers every call, same-origin.
    ...(mode === 'live'
      ? {
          preview: {
            proxy: {
              '/__live-api': {
                target: process.env['E2E_LIVE_API_TARGET'] ?? 'http://localhost:3001',
                changeOrigin: true,
                rewrite: (p: string) => p.replace(/^\/__live-api/, ''),
              },
            },
          },
        }
      : {}),
    test: {
      include: ['tests/**/*.test.{ts,tsx}'],
      // See the file: findBy/waitFor tolerate a loaded parallel runner.
      setupFiles: ['tests/setup/async-timeout.ts'],
      testTimeout: 20_000,
      environment: 'node',
    },
  };
});
