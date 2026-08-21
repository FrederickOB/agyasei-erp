#!/usr/bin/env node
/**
 * Dev sync-stack driver: `pnpm stack:up | stack:down | stack:reset`.
 *
 * Exists for two reasons:
 *   1. PS_JWT_K (the PowerSync HS256 verification key) must be the base64url
 *      encoding of DEV_JWT_SECRET — derived here, never hand-typed, so the
 *      API's token signing and the service's validation can never drift.
 *   2. Ordering: PowerSync needs the `powersync` publication (created by the
 *      bootstrap, after migrations) — so up is postgres → bootstrap → powersync,
 *      each step gated on healthchecks (--wait), everything streamed.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const infraDir = dirname(fileURLToPath(new URL('.', import.meta.url)));
const repoRoot = join(infraDir, '..');
const composeFile = join(infraDir, 'docker-compose.yml');

const devJwtSecret = process.env.DEV_JWT_SECRET ?? 'dev-secret-change-me';
const env = {
  ...process.env,
  PS_JWT_K: Buffer.from(devJwtSecret, 'utf8').toString('base64url'),
};

function run(cmd, args, opts = {}) {
  console.log(`[stack] $ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: repoRoot,
    env,
    ...opts,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    console.error(`[stack] step failed (exit ${res.status}) — aborting`);
    process.exit(res.status ?? 1);
  }
}

const compose = (...args) => run('docker', ['compose', '-f', composeFile, ...args]);

function up() {
  compose('up', '-d', '--wait', 'postgres');
  run('pnpm', ['exec', 'tsx', join(infraDir, 'scripts', 'bootstrap.ts')]);
  compose('up', '-d', '--wait', 'powersync');
  console.log('[stack] up: postgres localhost:5433, powersync http://localhost:8080');
}

const cmd = process.argv[2];
switch (cmd) {
  case 'up':
    up();
    break;
  case 'down':
    compose('down');
    break;
  case 'reset':
    compose('down', '-v');
    up();
    break;
  default:
    console.error('usage: stack.mjs <up|down|reset>');
    process.exit(2);
}
