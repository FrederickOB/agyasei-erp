/**
 * `node dist/bin/combined.js` — ONE container doing what Fly's three process
 * groups do (infra/fly/api.toml): migrate, then serve the API and run the
 * scheduled-job worker side by side.
 *
 * It exists for hosts whose free tier has no release step and no separate
 * worker — the POC on Render (docs/poc-runbook.md). Production on Fly keeps
 * release_command / api / worker as separate processes and never runs this.
 *
 *   1. migrate.js first. A non-zero exit stops here, BEFORE anything serves,
 *      so the host keeps the previous deploy — the release_command contract.
 *   2. main.js and `jobs.js loop` as two child processes.
 *   3. If EITHER child exits, stop the other and exit non-zero, so the host
 *      restarts the whole container. A dead worker must not leave a healthy-
 *      looking API behind it: the worker is what refreshes sync scope every
 *      60 s and raises every alert.
 *   4. SIGTERM / SIGINT are forwarded; exit 0 once both children have stopped
 *      (SIGKILL after SHUTDOWN_GRACE_MS + 5 s).
 *
 * Each child gets its own heap cap, sized for a 512 MB instance:
 * COMBINED_API_HEAP_MB (256), COMBINED_WORKER_HEAP_MB (128),
 * COMBINED_MIGRATE_HEAP_MB (128).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

type Name = 'migrate' | 'api' | 'worker';

function log(level: 'info' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), component: 'combined', msg, ...fields })}\n`);
}

function heapMb(variable: string, fallback: number): number {
  const v = Number(process.env[variable] ?? fallback);
  return Number.isInteger(v) && v >= 64 ? v : fallback;
}

interface Child {
  name: Name;
  proc: ChildProcess;
  exit: Promise<{ name: Name; code: number }>;
}

function start(name: Name, file: string, args: string[], heap: number): Child {
  const proc = spawn(
    process.execPath,
    [`--max-old-space-size=${heap}`, fileURLToPath(new URL(`./${file}`, import.meta.url)), ...args],
    { stdio: 'inherit', env: process.env },
  );
  const exit = new Promise<{ name: Name; code: number }>((resolve) => {
    proc.once('exit', (code, signal) => resolve({ name, code: code ?? (signal ? 1 : 0) }));
    proc.once('error', () => resolve({ name, code: 1 }));
  });
  return { name, proc, exit };
}

function running(c: Child): boolean {
  return c.proc.exitCode === null && c.proc.signalCode === null;
}

const graceMs = (Number(process.env['SHUTDOWN_GRACE_MS']) || 20_000) + 5_000;

const migrate = start('migrate', 'migrate.js', [], heapMb('COMBINED_MIGRATE_HEAP_MB', 128));
const migrated = await migrate.exit;
if (migrated.code !== 0) {
  log('error', 'migrations failed or were refused; not serving', { code: migrated.code });
  process.exit(migrated.code);
}

const children: Child[] = [
  start('api', 'main.js', [], heapMb('COMBINED_API_HEAP_MB', 256)),
  start('worker', 'jobs.js', ['loop'], heapMb('COMBINED_WORKER_HEAP_MB', 128)),
];
log('info', 'api and worker started', { pids: children.map((c) => `${c.name}:${c.proc.pid}`) });

let stopping = false;

async function stopAll(exitCode: number): Promise<never> {
  for (const c of children) if (running(c)) c.proc.kill('SIGTERM');
  const force = setTimeout(() => {
    log('error', 'children did not stop within the grace period; killing');
    for (const c of children) if (running(c)) c.proc.kill('SIGKILL');
  }, graceMs);
  force.unref();
  await Promise.all(children.map((c) => c.exit));
  process.exit(exitCode);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    log('info', 'stopping', { signal });
    void stopAll(0);
  });
}

const first = await Promise.race(children.map((c) => c.exit));
if (!stopping) {
  stopping = true;
  log('error', `${first.name} exited; stopping the container so the host restarts it`, { code: first.code });
  await stopAll(first.code === 0 ? 1 : first.code);
}
