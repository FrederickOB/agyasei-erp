/**
 * Make sure the real API dev server is serving http://localhost:3001. If it
 * already is (the normal dev loop), reuse it; otherwise spawn
 * `apps/api/src/dev.ts` via tsx as a child process and tear it down when the
 * drills finish. Either way the drills run against the REAL server process
 * over HTTP — never an in-process caller.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { API_URL } from './env.js';

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/healthz`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ApiHandle {
  spawned: boolean;
  stop(): Promise<void>;
}

export async function ensureApi(): Promise<ApiHandle> {
  if (await healthy()) {
    console.log(`[api] reusing running server at ${API_URL}`);
    return { spawned: false, stop: async () => undefined };
  }
  const apiDir = fileURLToPath(new URL('../../../apps/api/', import.meta.url));
  const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
  console.log(`[api] starting dev server (tsx src/dev.ts in apps/api)…`);
  const child: ChildProcess = spawn(tsx, ['src/dev.ts'], {
    cwd: apiDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[api] ${d.toString()}`));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await healthy()) break;
    if (child.exitCode !== null) throw new Error(`API dev server exited with code ${child.exitCode}`);
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('API dev server did not become healthy within 60s');
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('\n[api] healthy');
  return {
    spawned: true,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

export async function assertStackUp(): Promise<void> {
  // PowerSync liveness
  let ps = false;
  try {
    const res = await fetch(`${process.env.POWERSYNC_URL ?? 'http://localhost:8080'}/probes/liveness`, {
      signal: AbortSignal.timeout(3000),
    });
    ps = res.ok;
  } catch {
    ps = false;
  }
  if (!ps) {
    throw new Error(
      'PowerSync service not reachable on :8080 — run `pnpm stack:up` first (infra/README.md).',
    );
  }
}
