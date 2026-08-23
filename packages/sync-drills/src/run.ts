/**
 * The Phase 1 sync drill harness — `pnpm --filter @erp/sync-drills drill`.
 *
 * Runs D1–D7 in order against the REAL stack (infra/README.md): docker
 * Postgres 16 on :5433, self-hosted PowerSync on :8080, the API dev server
 * on :3001 (reused if already running, spawned otherwise). Writes
 * docs/sync-drill-report.md and exits non-zero if ANY assertion fails.
 */
import { execSync } from 'node:child_process';
import { createContext, warmUp, type DrillContext } from './context.js';
import { ensureApi, assertStackUp } from './apiserver.js';
import { writeReport, DrillResult } from './report.js';
import { runD1 } from './drills/d1.js';
import { runD2 } from './drills/d2.js';
import { runD3 } from './drills/d3.js';
import { runD4 } from './drills/d4.js';
import { runD5 } from './drills/d5.js';
import { runD6 } from './drills/d6.js';
import { runD7 } from './drills/d7.js';
import { runD8 } from './drills/d8.js';
import { API_URL, DATABASE_URL, POWERSYNC_URL } from './env.js';

/** Every drill must run. A missing one is a failure, not a quiet 6/7. */
const DRILL_COUNT = 8;

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return 'unavailable';
  }
}

async function main(): Promise<void> {
  console.log('=== @erp/sync-drills — Phase 1 acceptance drills (real stack) ===');
  await assertStackUp();
  const api = await ensureApi();

  const results: DrillResult[] = [];
  let cx: DrillContext | null = null;
  try {
    cx = await createContext();
    await warmUp(cx);

    const drills: { id: string; title: string; fn: (c: DrillContext) => Promise<DrillResult> }[] = [
      { id: 'D1', title: '60-second sync', fn: runD1 },
      { id: 'D2', title: 'two devices, same SKU', fn: runD2 },
      { id: 'D3', title: 'HQ view', fn: runD3 },
      { id: 'D4', title: 'idempotent retry', fn: runD4 },
      { id: 'D5', title: 'tenant isolation at the sync layer', fn: runD5 },
      { id: 'D6', title: "the PWA's own payload, end to end", fn: runD6 },
      { id: 'D7', title: 'receipt-number regression (wipe mid-block, reissue)', fn: runD7 },
      { id: 'D8', title: 'credit at the sync layer — isolation, permission gate, location slice', fn: runD8 },
    ];
    for (const d of drills) {
      console.log(`\n--- ${d.id}: ${d.title} ---`);
      try {
        results.push(await d.fn(cx));
      } catch (err) {
        // A drill that blows up is a FAILED drill, never a skipped one.
        const r = new DrillResult(d.id, d.title);
        r.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
        console.error(`  [FAIL] ${d.id} aborted:`, r.error);
        results.push(r);
      }
    }
  } finally {
    if (cx) {
      await Promise.allSettled([cx.a1.close(), cx.a2.close(), cx.a3.close(), cx.b1.close()]);
      await cx.server.close();
    }
    await api.stop();
  }

  const environment = [
    `Postgres: \`${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}\` — ${sh(
      `psql "${DATABASE_URL}" -Atc 'select version()'`,
    )}`,
    `PowerSync service: \`${POWERSYNC_URL}\` — image ${sh(
      "docker inspect --format '{{.Config.Image}}' erp-dev-stack-powersync-1",
    )}`,
    `API: \`${API_URL}\` (apps/api dev server, HS256 dev tokens)`,
    `Device SDK: @powersync/node ${sh('node -p \'require("@powersync/node/package.json").version\'')} — one sqlite file per device under packages/sync-drills/.drill-data/`,
    `Node ${process.version} on ${process.platform} ${process.arch}`,
    `Sync rules: infra/powersync/sync_rules.yaml (tenant id from token \`tid\` ONLY); uploads via POST /sync/upload → app.write_log pipeline (download-only sync service)`,
  ];

  const reportPath = writeReport(results, environment);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} drills passed — report: ${reportPath} ===`);
  if (failed.length > 0 || results.length !== DRILL_COUNT) {
    console.error(`FAILED drills: ${failed.map((r) => r.id).join(', ') || '(missing drills)'}`);
    // Report is on disk (sync write); exit hard so lingering sqlite worker
    // threads cannot keep a failed run's process alive.
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('drill harness fatal:', err);
  process.exit(1);
});
