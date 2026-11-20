#!/usr/bin/env node
/**
 * Builds `dist-live/` for the live-stack drill (playwright.live.config.ts):
 * the production code — NO download seam, `--mode live` — on the dev-bearer
 * path, pointed at the REAL local stack.
 *
 *   API        http://127.0.0.1:4176/__live-api  → forwarded by `vite preview`
 *              to E2E_LIVE_API_TARGET (default http://localhost:3001). Same-
 *              origin on purpose: the dev API's CORS allow-list names :5173
 *              only, and the drill must not need the API restarted.
 *   PowerSync  E2E_LIVE_POWERSYNC (default http://localhost:8080), direct.
 *   Bearer     E2E_LIVE_TOKEN if set, else minted now with `pnpm -s dev:token`
 *              (tenant A, its default location and principal — see
 *              infra/scripts/dev-token.mjs). Never committed, never deployed:
 *              dist-live/ is gitignored and no image copies it.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(appDir, '../..');
const port = Number(process.env.E2E_LIVE_PORT ?? 4176);

let token = process.env.E2E_LIVE_TOKEN ?? '';
if (token.length === 0) {
  token = execFileSync('node', ['infra/scripts/dev-token.mjs'], { cwd: repoRoot, encoding: 'utf8' })
    .trim()
    .split('\n')
    .pop()
    .trim();
}
if (token.split('.').length !== 3) {
  throw new Error('no usable dev bearer: set E2E_LIVE_TOKEN="$(pnpm -s dev:token)" or start the stack');
}

for (const key of ['VITE_API_URL', 'VITE_POWERSYNC_URL', 'VITE_API_TOKEN', 'BUILD_ID']) delete process.env[key];
Object.assign(process.env, {
  VITE_API_URL: `http://127.0.0.1:${port}/__live-api`,
  VITE_POWERSYNC_URL: process.env.E2E_LIVE_POWERSYNC ?? 'http://localhost:8080',
  VITE_API_TOKEN: token,
  BUILD_ID: 'live',
});
const started = Date.now();
await build({ root: appDir, mode: 'live', logLevel: 'warn' });
console.log(`[live build] dist-live/ in ${Math.round((Date.now() - started) / 1000)}s`);
