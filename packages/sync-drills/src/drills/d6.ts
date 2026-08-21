/**
 * D6 — THE CLIENT'S OWN PAYLOAD, END TO END.
 *
 * D1–D5 were green for weeks while every sale the PWA uploaded was rejected
 * BAD_REQUEST, because every drill above builds its payload from
 * `src/context.ts` — the drills' own idea of the API's shape, agreed with the
 * server and with nobody else. The PWA's actual `buildSalePayload` output had
 * never been handed to the API in any test at any level. The CORS bug before
 * it slipped through the same hole from the other side: `@powersync/node` has
 * no browser origin, so no drill ever exercised a cross-origin request.
 *
 * So D6 does not use `DrillDevice` at all. It runs `apps/web`'s REAL counter
 * path — real local SQLite, real cart, real `checkout()`, real outbox, real
 * `httpUploadTransport` — over a real socket with a browser `Origin` header,
 * and then reads Postgres to prove the sale, its lines, its tax lines and its
 * stock movements actually landed with the SERVER's prices.
 *
 * It lives in `@erp/wire-conformance` (the only package that can import both
 * `apps/web` and `apps/api` — this one resolves modules as NodeNext and the
 * PWA's sources do not carry file extensions) and is invoked here as a child
 * process so its result appears in docs/sync-drill-report.md alongside the
 * rest. The same journey also runs hermetically on every `pnpm test`, in
 * `packages/wire-conformance/test/sale-client-to-api.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DrillContext } from '../context.js';
import { DrillResult } from '../report.js';
import { API_URL, DATABASE_URL } from '../env.js';

interface LiveCheck {
  name: string;
  pass: boolean;
  detail: string;
}
interface LiveResult {
  checks: LiveCheck[];
  measurements: string[];
  error?: string;
}

const MARKER = '__DRILL_RESULT__ ';

function parseResult(stdout: string): LiveResult | null {
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(MARKER));
  if (line === undefined) return null;
  try {
    return JSON.parse(line.slice(MARKER.length)) as LiveResult;
  } catch {
    return null;
  }
}

export async function runD6(_cx: DrillContext): Promise<DrillResult> {
  const r = new DrillResult('D6', "The PWA's own payload, over a real socket, into Postgres");

  const pkgDir = fileURLToPath(new URL('../../../wire-conformance/', import.meta.url));
  const tsx = fileURLToPath(new URL('../../../wire-conformance/node_modules/.bin/tsx', import.meta.url));
  const proc = spawnSync(tsx, ['src/live-client-drill.ts'], {
    cwd: pkgDir,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, API_URL, DATABASE_URL },
  });

  const stdout = proc.stdout ?? '';
  if (proc.stderr) process.stderr.write(proc.stderr);
  const live = parseResult(stdout);

  if (live === null) {
    // No parseable result is a FAILED drill, never a skipped one.
    r.error =
      `@erp/wire-conformance drill:live produced no result line ` +
      `(exit ${String(proc.status)}${proc.error ? `, ${proc.error.message}` : ''}).\n${stdout.slice(-2000)}`;
    r.check('the live client drill ran', false, `exit=${String(proc.status)}`);
    return r;
  }

  for (const m of live.measurements) r.measure(m);
  for (const c of live.checks) r.check(c.name, c.pass, c.detail);
  if (live.error !== undefined) r.error = live.error;
  // A drill that reports no checks at all has demonstrated nothing.
  if (live.checks.length === 0) {
    r.check('the live client drill produced assertions', false, 'no checks reported');
  }
  return r;
}
