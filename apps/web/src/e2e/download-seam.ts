/**
 * ═══════════════════════════════════════════════════════════════════════════
 * E2E ONLY — compiled into `vite build --mode e2e` and into nothing else.
 * ═══════════════════════════════════════════════════════════════════════════
 * main.tsx imports this behind `import.meta.env.MODE === 'e2e'`. Vite replaces
 * that expression with a string literal at build time, so in every other mode
 * the branch is dead code and Rollup drops it together with this chunk.
 * `e2e/build-guard.spec.ts` builds production and greps every emitted file for
 * `E2E_SEAM_MARKER` — and greps the e2e build for the same marker, so a grep
 * that could never have found anything is not mistaken for a pass. The e2e
 * build itself refuses to name any API but the reserved `.invalid` origin
 * (vite.config.ts), and writes to `dist-e2e/`, which no image copies.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT STANDS IN FOR — A POWERSYNC DOWNLOAD, AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 * In the browser tests the sync service is genuinely unreachable — that IS
 * the offline case. So the rows a device would have downloaded are written the
 * way the sync client writes them: into PowerSync's own backing table,
 * `ps_data__<table>`, as `(id, JSON)`, each carrying the `tenant_id` every
 * synced row carries. Consequences, all deliberate:
 *
 *   · Nothing enters `ps_crud`, so there is no upload-queue head and no
 *     download freeze (data/sync/crud-guard.ts). Checked after every apply and
 *     refused loudly, because a seam that froze the device would make every
 *     test downstream of it a test of the freeze.
 *   · Every gate and projection runs UNMODIFIED over these rows: the location
 *     from the token's `locs` claim, price-list provisioning (`tenant_id IS NOT
 *     NULL`, in force today), the currency from the jurisdiction pack, the
 *     catalogue join. If those reject the fixture, the test fails — the seam
 *     never writes `local_config` to get past a gate.
 *   · LOCAL-ONLY TABLES ARE REFUSED: till, cart, outbox, sequence blocks, the
 *     print queue, device configuration. Those are what the tests exercise, so
 *     the real UI has to produce every one of them.
 *
 * The rows come from the test (`window.__erp_e2e_download__`, installed by
 * `e2e/support/device.ts` before the page's scripts run), so this file holds
 * no data and no vocabulary of anyone's.
 */
import type { LocalDb } from '../data/db';
import { LOCAL_TABLES } from '../data/schema';

/** What `e2e/build-guard.spec.ts` greps for. Present in an e2e build, nowhere else. */
export const E2E_SEAM_MARKER = 'erp-e2e-download-seam:v1';

const FIXTURE_GLOBAL = '__erp_e2e_download__';
const REPORT_GLOBAL = '__erp_e2e_seam__';

type Cell = string | number | null;
type FixtureRow = Readonly<Record<string, Cell>>;

/** The tables that arrive over the sync stream, by name. */
const SYNCED = new Map(LOCAL_TABLES.filter((t) => !t.localOnly).map((t) => [t.name, t]));
const LOCAL_ONLY = new Set(LOCAL_TABLES.filter((t) => t.localOnly).map((t) => t.name));

function refuse(why: string): never {
  throw new Error(`[e2e download seam] ${why}`);
}

function readFixture(raw: unknown): ReadonlyMap<string, readonly FixtureRow[]> {
  if (typeof raw !== 'object' || raw === null) refuse('the fixture is not an object');
  const tables = (raw as Record<string, unknown>)['tables'];
  if (typeof tables !== 'object' || tables === null) refuse('the fixture has no `tables`');
  const out = new Map<string, readonly FixtureRow[]>();
  for (const [name, rows] of Object.entries(tables as Record<string, unknown>)) {
    if (LOCAL_ONLY.has(name)) {
      refuse(`"${name}" is local-only — the UI under test must produce it, not the seam`);
    }
    const def = SYNCED.get(name);
    if (def === undefined) refuse(`"${name}" is not a synced table in data/schema.ts`);
    if (!Array.isArray(rows)) refuse(`"${name}" is not a list of rows`);
    const known = new Map(def.columns.map((c) => [c.name, c.type]));
    for (const row of rows as unknown[]) {
      if (typeof row !== 'object' || row === null) refuse(`a "${name}" row is not an object`);
      const r = row as Record<string, unknown>;
      if (typeof r['id'] !== 'string' || r['id'].length === 0) refuse(`a "${name}" row has no id`);
      for (const [col, value] of Object.entries(r)) {
        if (col === 'id') continue;
        const type = known.get(col);
        if (type === undefined) refuse(`"${name}.${col}" is not a column the device schema has`);
        if (value === null) continue;
        if (type === 'text' && typeof value !== 'string') refuse(`"${name}.${col}" must be text`);
        if (
          type === 'integer' &&
          !(typeof value === 'number' && Number.isSafeInteger(value)) &&
          !(typeof value === 'string' && /^-?\d+$/.test(value))
        ) {
          // Integers wider than a double ride as decimal strings, exactly as
          // money does on the wire (ADR-0004); SQLite's CAST reads both.
          refuse(`"${name}.${col}" must be an integer or a decimal string of one`);
        }
      }
    }
    out.set(name, rows as FixtureRow[]);
  }
  return out;
}

/**
 * Apply the test's download, once per device: `INSERT OR IGNORE`, so a reload
 * (the offline test reloads from the service worker) changes nothing.
 */
export async function applyE2eDownload(db: LocalDb): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  const applied: Record<string, number> = {};
  w[REPORT_GLOBAL] = { marker: E2E_SEAM_MARKER, applied };

  const raw = w[FIXTURE_GLOBAL];
  // No fixture: a device that has downloaded nothing. Also a real state.
  if (raw === undefined) return;
  const tables = readFixture(raw);

  await db.writeTransaction(async (tx) => {
    for (const [name, rows] of tables) {
      for (const row of rows) {
        const { id, ...data } = row;
        await tx.execute(`INSERT OR IGNORE INTO "ps_data__${name}" (id, data) VALUES (?, ?)`, [
          id as string,
          JSON.stringify(data),
        ]);
      }
      applied[name] = rows.length;
    }
  });

  const queued = await db.getAll('SELECT count(*) AS n FROM ps_crud');
  if (Number(queued[0]?.['n'] ?? 0) !== 0) {
    refuse('the download reached PowerSync’s upload queue (ps_crud); it would freeze every download');
  }
  db.changes.notify();
}
