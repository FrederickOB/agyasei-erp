/**
 * THE SYNC RULES AND THE DEVICE SCHEMA, CHECKED AGAINST EACH OTHER.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS FILE EXISTS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 * `infra/powersync/sync_rules.yaml` ships the credit book from
 * `FROM "app"."customer_account"`. PowerSync names a client table after the
 * SOURCE TABLE in the data query, so those rows arrive at a device with type
 * `customer_account`. `apps/web/src/data/schema.ts` declared the table as
 * `credit_account`.
 *
 * The result, measured on a real device against the real service:
 *
 *     client table `credit_account`    → 0 rows
 *     client table `customer_account`  → 80 rows
 *     ps_untyped                       → 80 customer_account rows
 *
 * `ps_untyped` is where PowerSync parks a row type the client schema does not
 * declare. No query in the PWA can read it. So `loadAccountIdForCustomer`
 * returned `null` for every customer, `loadSyncedCreditPosition` was never
 * reached, and the entire offline credit position — the thing migration 0013
 * and the `tenant_credit` bucket were built to deliver — was silently
 * unavailable on every device.
 *
 * Sixteen unit tests passed throughout, because the node test adapter builds
 * its DDL from the same `LOCAL_TABLES` list and the tests seeded the same
 * wrong name. The client agreed with itself. Nothing compared it to the
 * server. That is this package's whole reason to exist, so the check belongs
 * here and it belongs as a TEST rather than as a drill: it needs no stack, so
 * it runs on every commit.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS CHECKED
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. Every table the rules DELIVER is declared as a synced table on the
 *     device, under exactly that name.
 *  2. Every synced table declared on the device is one the rules can deliver.
 *     A client table nothing fills is a screen that is permanently empty.
 *  3. Every COLUMN a rule selects for a table is declared on that client
 *     table. An undeclared column is dropped on arrival — the same silent
 *     failure one level down.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOCAL_TABLES } from '../../../apps/web/src/data/schema';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RULES = readFileSync(path.join(REPO_ROOT, 'infra/powersync/sync_rules.yaml'), 'utf8');

/**
 * Strip comments, then keep only the `data:` blocks. A `FROM` inside a
 * PARAMETER query names a gate table that is never delivered to a device
 * (`credit_sync_book_scope`, `platform.tenant`), and counting it as delivered
 * would demand a client table for a row type no device ever receives.
 */
function dataBlocks(): string[] {
  const lines = RULES.split('\n').filter((l) => !/^\s*#/.test(l));
  const blocks: string[] = [];
  let inData = false;
  let indent = 0;
  let buf: string[] = [];
  for (const line of lines) {
    const m = /^(\s*)data:\s*$/.exec(line);
    if (m) {
      if (inData) blocks.push(buf.join('\n'));
      inData = true;
      indent = m[1]!.length;
      buf = [];
      continue;
    }
    if (!inData) continue;
    const bodyIndent = /^(\s*)\S/.exec(line);
    if (line.trim() !== '' && bodyIndent && bodyIndent[1]!.length <= indent) {
      blocks.push(buf.join('\n'));
      inData = false;
      buf = [];
      continue;
    }
    buf.push(line);
  }
  if (inData) blocks.push(buf.join('\n'));
  return blocks;
}

interface RuleQuery {
  table: string;
  /** null for `SELECT *` — the whole column set, checked by the schema itself. */
  columns: string[] | null;
}

/** One entry per `- SELECT … FROM "schema"."table"` in a data block. */
function ruleQueries(): RuleQuery[] {
  const out: RuleQuery[] = [];
  for (const block of dataBlocks()) {
    // Each list item starts with `- SELECT`; join its continuation lines.
    const items = block.split(/^\s*-\s+/m).slice(1);
    for (const raw of items) {
      const flat = raw.replace(/\s+/g, ' ').trim();
      const from = /FROM "(?:app|platform)"\."([a-z_]+)"/.exec(flat);
      if (!from) continue;
      const table = from[1]!;
      const select = /^SELECT (.+?) FROM /.exec(flat);
      if (!select) continue;
      const list = select[1]!.trim();
      if (list === '*') {
        out.push({ table, columns: null });
        continue;
      }
      // `a, b, c || ':' || d AS id, e` — take the alias when there is one,
      // otherwise the bare identifier. Anything else is a computed column the
      // client must still declare under its output name.
      const columns = splitTopLevel(list)
        .map((expr) => {
          const alias = /\bAS\s+([a-z_]+)\s*$/i.exec(expr.trim());
          if (alias) return alias[1]!;
          const bare = /^([a-z_]+)$/.exec(expr.trim());
          return bare ? bare[1]! : '';
        })
        .filter((c) => c !== '');
      out.push({ table, columns });
    }
  }
  return out;
}

/** Split a SELECT list on commas that are not inside parentheses. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

/**
 * The one deliberate exception, named with its reason. `stock_snapshot` is a
 * synced-SHAPE table that no bucket fills: only `src/data/seed.ts` writes it,
 * for the dev demo. It predates the credit work and is listed here rather than
 * quietly tolerated, so removing it or giving it a bucket is a visible choice.
 */
const DEVICE_TABLES_WITH_NO_BUCKET = new Set(['stock_snapshot']);

/**
 * Row types a device receives but the PWA deliberately does not hold. Empty
 * today: every bucket the rules define is one a device is meant to read.
 */
const DELIVERED_BUT_NOT_HELD = new Set<string>([]);

const syncedDeviceTables = new Map(
  LOCAL_TABLES.filter((t) => !t.localOnly).map((t) => [
    t.name,
    new Set(t.columns.map((c) => c.name)),
  ]),
);

describe('sync rules ↔ device schema', () => {
  const queries = ruleQueries();

  it('the parser found the rules — every bucket data query, none of the parameter queries', () => {
    expect(queries.length).toBeGreaterThanOrEqual(20);
    const tables = new Set(queries.map((q) => q.table));
    // Delivered.
    expect(tables.has('customer_account')).toBe(true);
    expect(tables.has('credit_position_snapshot')).toBe(true);
    expect(tables.has('credit_allowance')).toBe(true);
    // Gate tables, read ONLY by parameter queries — never delivered.
    expect(tables.has('credit_sync_book_scope')).toBe(false);
    expect(tables.has('credit_sync_location_scope')).toBe(false);
    expect(tables.has('tenant')).toBe(false);
  });

  it('every table the sync rules deliver is declared on the device, under that exact name', () => {
    const missing = [...new Set(queries.map((q) => q.table))]
      .filter((t) => !DELIVERED_BUT_NOT_HELD.has(t))
      .filter((t) => !syncedDeviceTables.has(t))
      .sort();
    expect(missing, `rows of these types would land in ps_untyped, invisible to every query in the PWA: ${missing.join(', ')}`).toEqual([]);
  });

  it('every synced table on the device is one the sync rules can fill', () => {
    const delivered = new Set(queries.map((q) => q.table));
    const orphans = [...syncedDeviceTables.keys()]
      .filter((t) => !delivered.has(t))
      .filter((t) => !DEVICE_TABLES_WITH_NO_BUCKET.has(t))
      .sort();
    expect(orphans, `declared synced but no bucket delivers them — permanently empty on every device: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every column a rule selects is declared on the client table', () => {
    const problems: string[] = [];
    for (const q of queries) {
      if (q.columns === null) continue;
      const declared = syncedDeviceTables.get(q.table);
      if (!declared) continue; // covered by the test above
      for (const col of q.columns) {
        // `id` is PowerSync's own primary key and is never declared.
        if (col === 'id') continue;
        if (!declared.has(col)) problems.push(`${q.table}.${col}`);
      }
    }
    expect(problems, `selected by the rules, undeclared on the device, therefore dropped on arrival: ${problems.join(', ')}`).toEqual([]);
  });

  it('the credit book tables are all held, and the counter slice is a separate table', () => {
    for (const t of [
      'customer_account', 'credit_limit_version', 'credit_entry',
      'credit_position_snapshot', 'credit_position_bucket',
    ]) {
      expect(syncedDeviceTables.has(t), `${t} must be a synced device table`).toBe(true);
    }
    expect(syncedDeviceTables.has('credit_allowance')).toBe(true);
    // The counter's table must NOT carry a balance, a limit or an ageing band:
    // holding one would put the figure 06 §6.5 forbids on the device it
    // forbids it on, whatever the bucket gate says.
    const allowance = syncedDeviceTables.get('credit_allowance')!;
    for (const forbidden of [
      'balance_minor', 'credit_limit_minor', 'trade_exposure_minor',
      'available_minor', 'terms_days', 'amount_minor',
    ]) {
      expect(allowance.has(forbidden), `credit_allowance must not carry ${forbidden}`).toBe(false);
    }
  });
});
