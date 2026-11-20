/**
 * Requirement 9.5-A — per-tenant, per-table digests.
 *
 * Computed INSIDE a tenant's RLS context (the caller's transaction has already
 * done `SET LOCAL ROLE app_user` and set the tenant GUC), so a digest can only
 * ever describe rows that tenant owns. Nothing here names a tenant.
 *
 * THE DIGEST. For each table: the row count, and two order-independent
 * multiset hashes — one over the primary key, one over the full row image.
 * Each is four 32-bit lanes of md5(...), each lane summed over every row.
 * Summation makes it:
 *   - streaming: one pass, O(1) memory, whatever the table size;
 *   - order-independent: identical however the rows are physically laid out,
 *     which is precisely what a restore changes;
 *   - exact: the sums are integers; there is no rounding anywhere.
 * It detects loss, duplication and corruption. It is not adversarially
 * collision-resistant and does not need to be: nothing here authenticates.
 *
 * `sum(int4)` is `bigint` in Postgres, so no `numeric` is involved; 2^31 per
 * row times even a hundred million rows stays far inside int8.
 */
import type { Queryable } from './db.js';

export interface TableDigest {
  readonly tableName: string;
  readonly rowCount: bigint;
  readonly pkDigest: string;
  readonly rowDigest: string;
}

/**
 * Tables whose digest is refreshed hourly (§9.5-A: "hourly for tables in the
 * money and credit path, daily for the rest"). PLATFORM table names — no
 * tenant vocabulary. A name that does not exist in this schema is skipped.
 */
export const MONEY_PATH_TABLES: readonly string[] = [
  'write_log',
  'sale',
  'sale_line',
  'sale_tax_line',
  'sale_return',
  'sale_return_line',
  'sale_return_refund',
  'stock_movement',
  'customer_account',
  'credit_entry',
  'credit_limit_version',
  'credit_status_change',
  'credit_position_snapshot',
  'credit_position_bucket',
  'sequence_block',
  'journal_entry',
  'journal_line',
  'posting_exception',
  'payroll_entry',
  'bank_statement_line',
  'reconciliation_match',
];

/** Never digested: the digest table itself (it would describe its own writes). */
const EXCLUDED = new Set(['table_digest']);

const NAME = /^[a-z_][a-z0-9_]*$/;

function q(ident: string): string {
  if (!NAME.test(ident)) throw new Error(`refusing to quote unexpected identifier ${JSON.stringify(ident)}`);
  return `"${ident}"`;
}

/** Every tenant-owned base table in `app`, from the catalogue, with its primary key. */
export async function listTenantTables(tx: Queryable): Promise<{ name: string; pk: string[] }[]> {
  const res = await tx.query<{ relname: string; pk: string[] | null }>(`
    select c.relname,
           (select array_agg(a.attname::text order by k.ord)
              from pg_index i
              cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
             where i.indrelid = c.oid and i.indisprimary) as pk
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'app' and c.relkind in ('r', 'p')
       and has_table_privilege(c.oid, 'select')
       and exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
     order by c.relname`);
  return res.rows
    .filter((r) => !EXCLUDED.has(r.relname) && NAME.test(r.relname))
    .map((r) => ({ name: r.relname, pk: (r.pk ?? []).filter((c) => NAME.test(c)) }));
}

function lanes(expr: string, prefix: string): string {
  return [1, 9, 17, 25]
    .map((off, i) => `coalesce(sum(('x' || substr(md5(${expr}), ${off}, 8))::bit(32)::int), 0)::text as ${prefix}${i}`)
    .join(',\n           ');
}

/** The one digest statement for a table. Exported so tests can pin its shape. */
export function digestSql(table: string, pk: readonly string[]): string {
  const pkExpr = pk.length > 0 ? `row(${pk.map((c) => `t.${q(c)}`).join(', ')})::text` : 't::text';
  return `
    select count(*)::text as row_count,
           ${lanes(pkExpr, 'p')},
           ${lanes('t::text', 'r')}
      from app.${q(table)} t`;
}

const LANE = 2n ** 32n;

/** Fold four summed lanes into a fixed-width hex digest. */
export function foldLanes(sums: readonly string[]): string {
  return sums
    .map((s) => {
      const v = ((BigInt(s) % LANE) + LANE) % LANE;
      return v.toString(16).padStart(8, '0');
    })
    .join('');
}

/**
 * Pin every setting that changes how a row renders as text, so a digest
 * computed in one session equals the digest of the same rows in any other —
 * a restore drill compares across clusters whose defaults may differ.
 */
export async function normalizeRenderingSettings(tx: Queryable): Promise<void> {
  await tx.query(`select set_config('timezone', 'UTC', true),
                         set_config('datestyle', 'ISO, YMD', true),
                         set_config('intervalstyle', 'postgres', true),
                         set_config('bytea_output', 'hex', true),
                         set_config('extra_float_digits', '1', true)`);
}

/** Digest the given tables (default: all) as the CURRENT tenant context sees them. */
export async function digestTables(
  tx: Queryable,
  only?: readonly string[],
): Promise<TableDigest[]> {
  await normalizeRenderingSettings(tx);
  const all = await listTenantTables(tx);
  const wanted = only ? new Set(only) : null;
  const out: TableDigest[] = [];
  for (const t of all) {
    if (wanted && !wanted.has(t.name)) continue;
    const res = await tx.query<Record<string, string>>(digestSql(t.name, t.pk));
    const r = res.rows[0];
    if (!r) continue;
    out.push({
      tableName: t.name,
      rowCount: BigInt(r['row_count'] ?? '0'),
      pkDigest: foldLanes([r['p0']!, r['p1']!, r['p2']!, r['p3']!]),
      rowDigest: foldLanes([r['r0']!, r['r1']!, r['r2']!, r['r3']!]),
    });
  }
  return out;
}
