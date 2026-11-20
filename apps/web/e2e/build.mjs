#!/usr/bin/env node
/**
 * Builds what the browser tests run against (playwright.config.ts).
 *
 *   dist-e2e/    `--mode e2e`: the production code plus ONE compile-time
 *                branch, the download seam (src/e2e/download-seam.ts). Dev
 *                bearer path, API = the reserved `.invalid` fixture origin
 *                (answered only by Playwright routes), PowerSync = a closed
 *                local port, so the sync service is genuinely unreachable.
 *   dist-guard/  a PRODUCTION build exactly as the web image makes it — device
 *                path, no token, mode `production` — for build-guard.spec.ts
 *                to grep for the seam. Skipped with --e2e-only.
 *
 *   E2E_SKIP_BUILD=1   reuse whatever is already built (fast local iteration;
 *                      never in CI).
 *
 * The dev bearer baked into dist-e2e is a FIXTURE: unsigned, naming fixture
 * ids, accepted by nothing but the test's own routes. The web image refuses to
 * build with any VITE_API_TOKEN at all (infra/docker/web.Dockerfile).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const identity = JSON.parse(readFileSync(path.join(appDir, 'e2e/support/identity.json'), 'utf8'));

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * The claims the client reads from a dev bearer: `uid` (whose cached
 * capabilities), `locs` (which counter this is — data/session/bearer-claims.ts)
 * and `tid` (carried for the server, which never takes it from the client).
 */
export function fixtureBearer() {
  return [
    b64url({ alg: 'HS256', typ: 'JWT' }),
    b64url({
      sub: identity.userId,
      uid: identity.userId,
      tid: identity.tenantId,
      locs: [identity.locationId],
      role: 'e2e-fixture',
      iat: 1_700_000_000,
      exp: 4_102_444_800,
    }),
    'e2e-fixture-not-a-signature',
  ].join('.');
}

const ENV_KEYS = ['VITE_API_URL', 'VITE_POWERSYNC_URL', 'VITE_API_TOKEN', 'BUILD_ID'];

async function buildWith(label, mode, env) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const started = Date.now();
  await build({ root: appDir, mode, logLevel: 'warn' });
  console.log(`[e2e build] ${label} (${mode}) in ${Math.round((Date.now() - started) / 1000)}s`);
}

const skip = process.env.E2E_SKIP_BUILD === '1';
const e2eOnly = process.argv.includes('--e2e-only');

if (skip && existsSync(path.join(appDir, 'dist-e2e/index.html'))) {
  console.log('[e2e build] E2E_SKIP_BUILD=1 — reusing dist-e2e/ and dist-guard/');
} else {
  await buildWith('seam build -> dist-e2e/', 'e2e', {
    VITE_API_URL: identity.apiOrigin,
    VITE_POWERSYNC_URL: identity.powersyncUrl,
    VITE_API_TOKEN: fixtureBearer(),
    BUILD_ID: identity.buildId,
  });
  if (!e2eOnly) {
    // Production mode writes dist/ by default; the guard build must not clobber
    // a developer's dist/, so it is the one place an outDir is passed in.
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, {
      VITE_API_URL: 'https://api.guard.invalid',
      VITE_POWERSYNC_URL: 'https://sync.guard.invalid',
      BUILD_ID: 'guard',
    });
    const started = Date.now();
    await build({ root: appDir, mode: 'production', logLevel: 'warn', build: { outDir: 'dist-guard' } });
    console.log(`[e2e build] production guard build -> dist-guard/ in ${Math.round((Date.now() - started) / 1000)}s`);
  }
}
