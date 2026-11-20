#!/usr/bin/env node
/**
 * The PWA's build on a STATIC host — Render's static site in render.yaml
 * (`erp-poc-web`, docs/poc-runbook.md). The static twin of
 * infra/docker/web.Dockerfile: the same refusals, the same build, and the
 * same /release.json — written here as a FILE, because there is no nginx to
 * render it at request time.
 *
 *   VITE_API_URL=… VITE_POWERSYNC_URL=… node infra/render/build-web.mjs
 *
 * /release.json is the §8.11 version gate: it names the build that devices may
 * activate. A static host serves the one this build wrote, so a release is
 * fleet-wide (as on Fly today), and holding the fleet back is a redeploy of the
 * previous commit. Render serves it with `Cache-Control: no-store` (render.yaml).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

function fail(msg) {
  process.stderr.write(`refusing: ${msg}\n`);
  process.exit(1);
}

if (process.env.VITE_API_TOKEN) fail('VITE_API_TOKEN must never be baked into a production bundle');
for (const k of ['VITE_API_URL', 'VITE_POWERSYNC_URL']) {
  if (!process.env[k]) fail(`${k} is required (set it on the static site — docs/poc-runbook.md)`);
}

// Render provides the commit being built; BUILD_ID wins when set by hand.
const buildId = (process.env.BUILD_ID || process.env.RENDER_GIT_COMMIT || 'unknown').slice(0, 12);

// The repository's own pinned pnpm, run through npx: no global install, no
// corepack shims to write into a read-only toolchain.
const pnpmVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager;
if (!/^pnpm@\d+\.\d+\.\d+$/.test(pnpmVersion ?? '')) fail('package.json packageManager must pin pnpm');
const pnpm = (args, env = {}) =>
  execFileSync('npx', ['--yes', pnpmVersion, ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true', ...env } });

pnpm(['install', '--frozen-lockfile', '--filter', '@erp/web...']);
pnpm(['--filter', '@erp/web^...', 'run', '--if-present', 'build']);
pnpm(['--filter', '@erp/web', 'run', 'build'], { BUILD_ID: buildId });

const dist = join(root, 'apps/web/dist');
writeFileSync(
  join(dist, 'release.json'),
  `${JSON.stringify({ build_id: buildId, min_client_schema: 1, max_client_schema: 1, cohort: 'fleet' })}\n`,
);

// No source maps on a public host (the image deletes them too).
(function strip(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) strip(p);
    else if (name.endsWith('.map')) rmSync(p);
  }
})(dist);

process.stdout.write(`PWA built for a static host: build ${buildId}, release.json written\n`);
