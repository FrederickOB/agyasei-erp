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

export default defineConfig({
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
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['tests/setup-dom-timeouts.ts'],
  },
});
