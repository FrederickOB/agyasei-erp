/**
 * The backup manifest: what a database contained, per tenant, at one
 * snapshot — and the comparison a restore drill makes against it.
 *
 * §9.5 step 5 is "the real check": for EVERY active tenant, the trial balance
 * from the restored copy equals the trial balance from production as at the
 * same instant, to the minor unit of that tenant's own pack. A logical dump
 * makes "the same instant" exact: the manifest is computed inside the very
 * snapshot `pg_dump --snapshot` exports, so source and restore describe the
 * same committed state and every figure must match exactly. Not "close".
 *
 * Every per-tenant figure is computed AS app_user WITH THAT TENANT'S GUC —
 * the same RLS context the application uses — so the manifest can only
 * describe each tenant from inside that tenant's boundary.
 *
 * Amounts are integer minor units carried as decimal strings (bigint in TS).
 * No scale is assumed anywhere: equality of minor units is equality of money
 * whatever the jurisdiction's divisor is.
 */
import { digestTables, normalizeRenderingSettings } from '../digest.js';
import type { Queryable } from '../db.js';

export const MANIFEST_FORMAT = 'erp-backup-manifest/1';

export interface TrialBalanceLine {
  readonly code: string;
  readonly accountId: string;
  readonly locationId: string;
  readonly debitMinor: string;
  readonly creditMinor: string;
}

export interface TenantFigures {
  readonly tables: readonly { tableName: string; rowCount: string; pkDigest: string; rowDigest: string }[];
  readonly trialBalance: {
    readonly lines: readonly TrialBalanceLine[];
    readonly debitMinor: string;
    readonly creditMinor: string;
    readonly balanced: boolean;
  };
}

export interface TenantManifest extends TenantFigures {
  readonly tenantId: string;
}

export interface Manifest {
  readonly format: typeof MANIFEST_FORMAT;
  /** Server clock at the snapshot: the restore target. */
  readonly snapshotAt: string;
  readonly serverVersion: string;
  readonly migrations: readonly string[];
  readonly catalogue: { readonly app: readonly string[]; readonly platform: readonly string[] };
  readonly platformRowCounts: Readonly<Record<string, string>>;
  readonly tenants: readonly TenantManifest[];
}

/**
 * The trial balance by account and location, as the current tenant context
 * sees it. Posted entries only; `postedAtOrBefore` gives the as-of figure the
 * append-only ledger makes computable (used for a PITR comparison).
 */
export async function trialBalanceLines(
  tx: Queryable,
  postedAtOrBefore: string | null = null,
): Promise<TenantFigures['trialBalance']> {
  const res = await tx.query<{
    code: string;
    account_id: string;
    location_id: string;
    debit_minor: string;
    credit_minor: string;
  }>(
    `select a.code, l.account_id::text, l.location_id::text,
            sum(l.debit_minor)::text as debit_minor, sum(l.credit_minor)::text as credit_minor
       from app.journal_line l
       join app.journal_entry e on e.tenant_id = l.tenant_id and e.id = l.journal_entry_id
       join app.gl_account a    on a.tenant_id = l.tenant_id and a.id = l.account_id
      where e.status = 'posted'
        and ($1::timestamptz is null or e.posted_at <= $1::timestamptz)
      group by a.code, l.account_id, l.location_id
      order by a.code, l.location_id`,
    [postedAtOrBefore],
  );
  let dr = 0n;
  let cr = 0n;
  const lines = res.rows.map((r) => {
    dr += BigInt(r.debit_minor);
    cr += BigInt(r.credit_minor);
    return {
      code: r.code,
      accountId: r.account_id,
      locationId: r.location_id,
      debitMinor: r.debit_minor,
      creditMinor: r.credit_minor,
    };
  });
  return { lines, debitMinor: dr.toString(10), creditMinor: cr.toString(10), balanced: dr === cr };
}

/** Run inside ONE tenant's RLS context. */
export async function tenantFigures(tx: Queryable): Promise<TenantFigures> {
  const digests = await digestTables(tx);
  return {
    tables: digests.map((d) => ({
      tableName: d.tableName,
      rowCount: d.rowCount.toString(10),
      pkDigest: d.pkDigest,
      rowDigest: d.rowDigest,
    })),
    trialBalance: await trialBalanceLines(tx),
  };
}

/**
 * Build the manifest inside the caller's open transaction — which must be
 * REPEATABLE READ (one snapshot for everything) and run by a role that is a
 * member of app_user.
 */
export async function buildManifest(tx: Queryable): Promise<Manifest> {
  await normalizeRenderingSettings(tx);
  const head = await tx.query<{ at: string; version: string; has_meta: boolean }>(
    `select to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
            current_setting('server_version') as version,
            to_regclass('erp_meta.schema_migrations') is not null as has_meta`,
  );
  const h = head.rows[0]!;
  const migrations = h.has_meta
    ? (await tx.query<{ filename: string }>(`select filename from erp_meta.schema_migrations order by filename`)).rows.map(
        (r) => r.filename,
      )
    : [];

  const cat = await tx.query<{ nspname: string; relname: string }>(
    `select n.nspname::text, c.relname::text
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('app', 'platform') and c.relkind in ('r', 'p')
      order by n.nspname, c.relname`,
  );
  const app = cat.rows.filter((r) => r.nspname === 'app').map((r) => r.relname);
  const platform = cat.rows.filter((r) => r.nspname === 'platform').map((r) => r.relname);

  const platformRowCounts: Record<string, string> = {};
  for (const t of platform) {
    if (!/^[a-z_][a-z0-9_]*$/.test(t)) continue;
    const r = await tx.query<{ n: string }>(`select count(*)::text as n from platform."${t}"`);
    platformRowCounts[t] = r.rows[0]!.n;
  }

  const tenantIds = (
    await tx.query<{ id: string }>(`select id::text as id from platform.tenant order by id`)
  ).rows.map((r) => r.id);

  const tenants: TenantManifest[] = [];
  for (const tenantId of tenantIds) {
    await tx.query(`set local role app_user`);
    await tx.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    const figures = await tenantFigures(tx);
    await tx.query(`reset role`);
    await tx.query(`select set_config('app.tenant_id', '', true)`);
    tenants.push({ tenantId, ...figures });
  }

  return {
    format: MANIFEST_FORMAT,
    snapshotAt: h.at,
    serverVersion: h.version,
    migrations,
    catalogue: { app, platform },
    platformRowCounts,
    tenants,
  };
}

export interface DrillComparison {
  readonly catalogueMatched: boolean;
  readonly migrationsMatched: boolean;
  readonly platformCountsMatched: boolean;
  readonly digestsMatched: boolean;
  readonly trialBalanceMatchedTenants: readonly string[];
  readonly trialBalanceFailedTenants: readonly string[];
  /** Human-readable differences: table names, tenant ids, counts. No row data. */
  readonly differences: readonly string[];
  readonly passed: boolean;
}

function same<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Compare a restored manifest against the source manifest. Exact, field by field. */
export function compareManifests(source: Manifest, restored: Manifest): DrillComparison {
  const diffs: string[] = [];
  const catalogueMatched = same(source.catalogue.app, restored.catalogue.app) && same(source.catalogue.platform, restored.catalogue.platform);
  if (!catalogueMatched) {
    const missing = [...source.catalogue.app, ...source.catalogue.platform].filter(
      (t) => !restored.catalogue.app.includes(t) && !restored.catalogue.platform.includes(t),
    );
    diffs.push(`catalogue differs; missing from restore: ${missing.join(', ') || '(none — extra tables present)'}`);
  }
  const migrationsMatched = same(source.migrations, restored.migrations);
  if (!migrationsMatched) diffs.push('applied migration list differs');

  let platformCountsMatched = true;
  for (const [t, n] of Object.entries(source.platformRowCounts)) {
    if (restored.platformRowCounts[t] !== n) {
      platformCountsMatched = false;
      diffs.push(`platform.${t}: ${n} rows at source, ${restored.platformRowCounts[t] ?? 'absent'} restored`);
    }
  }

  let digestsMatched = true;
  const matched: string[] = [];
  const failed: string[] = [];
  const restoredTenants = new Map(restored.tenants.map((t) => [t.tenantId, t]));
  for (const s of source.tenants) {
    const r = restoredTenants.get(s.tenantId);
    if (!r) {
      digestsMatched = false;
      failed.push(s.tenantId);
      diffs.push(`tenant ${s.tenantId}: absent from the restore`);
      continue;
    }
    const rt = new Map(r.tables.map((t) => [t.tableName, t]));
    for (const st of s.tables) {
      const x = rt.get(st.tableName);
      if (!x) {
        digestsMatched = false;
        diffs.push(`tenant ${s.tenantId} ${st.tableName}: table absent from the restore`);
      } else if (x.rowCount !== st.rowCount || x.pkDigest !== st.pkDigest || x.rowDigest !== st.rowDigest) {
        digestsMatched = false;
        diffs.push(
          `tenant ${s.tenantId} ${st.tableName}: rows ${st.rowCount} → ${x.rowCount}` +
            (x.pkDigest !== st.pkDigest ? ', key digest differs' : '') +
            (x.rowDigest !== st.rowDigest ? ', row digest differs' : ''),
        );
      }
    }
    const sl = s.trialBalance.lines;
    const rl = r.trialBalance.lines;
    const tbSame =
      s.trialBalance.debitMinor === r.trialBalance.debitMinor &&
      s.trialBalance.creditMinor === r.trialBalance.creditMinor &&
      r.trialBalance.balanced === s.trialBalance.balanced &&
      sl.length === rl.length &&
      sl.every(
        (l, i) =>
          l.accountId === rl[i]!.accountId &&
          l.locationId === rl[i]!.locationId &&
          l.debitMinor === rl[i]!.debitMinor &&
          l.creditMinor === rl[i]!.creditMinor,
      );
    if (tbSame) matched.push(s.tenantId);
    else {
      failed.push(s.tenantId);
      diffs.push(
        `tenant ${s.tenantId}: trial balance differs (Dr ${s.trialBalance.debitMinor}/${r.trialBalance.debitMinor}, ` +
          `Cr ${s.trialBalance.creditMinor}/${r.trialBalance.creditMinor} minor units, source/restore)`,
      );
    }
  }
  for (const r of restored.tenants) {
    if (!source.tenants.some((s) => s.tenantId === r.tenantId)) diffs.push(`tenant ${r.tenantId}: present only in the restore`);
  }

  const passed =
    catalogueMatched && migrationsMatched && platformCountsMatched && digestsMatched && failed.length === 0 && diffs.length === 0;
  return {
    catalogueMatched,
    migrationsMatched,
    platformCountsMatched,
    digestsMatched,
    trialBalanceMatchedTenants: matched,
    trialBalanceFailedTenants: failed,
    differences: diffs,
    passed,
  };
}
