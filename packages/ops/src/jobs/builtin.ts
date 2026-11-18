/**
 * The platform's scheduled jobs. Each is idempotent, works tenant by tenant
 * under that tenant's RLS, and reports counts and ids.
 *
 *   ledger.posting_sweep         hourly   settled sales → journal entries
 *   credit.sync_scope_refresh    hourly   lapse effective-dated credit grants off devices
 *   ops.table_digest             hourly   §9.5-A digests, money and credit path
 *   ops.table_digest_full        daily    §9.5-A digests, every table
 *   ops.lost_write_control       daily    receipt-number continuity (§9.4's nearest equivalent)
 *   ops.sync_health              15 min   the §9.4 pilot signals → alerts
 */
import { deterministicUuid, sweepSettledSales, uuidv7 } from '@erp/db';
import type { AlertSignal } from '../alerts.js';
import { digestTables, MONEY_PATH_TABLES } from '../digest.js';
import { receiptContinuity } from '../monitoring/receipt-continuity.js';
import { collectSignals, evaluateSignals, type Thresholds } from '../monitoring/signals.js';
import { defineJob, forEachTenant, type JobDefinition, type SummaryValue } from './registry.js';

/**
 * Who the ledger records as having posted a swept entry: a fixed, derivable
 * system actor — never a person who did not do it. Recorded in
 * journal_entry.created_by.
 */
export const POSTING_SWEEP_ACTOR = deterministicUuid('erp-platform', 'system-actor', 'ledger.posting_sweep');

/** The rule set every current caller of the sweep stamps (05 §5.2.2). */
export const POSTING_RULE_VERSION = 1;

const SWEEP_BATCH = 500;
const SWEEP_MAX_PASSES = 20;

function failures(failed: Map<string, { code: string | null; message: string }>): SummaryValue {
  return [...failed.entries()].map(([tenantId, e]) => ({ tenant_id: tenantId, sqlstate: e.code, error: e.message }));
}

export function postingSweepJob(): JobDefinition {
  return defineJob({
    name: 'ledger.posting_sweep',
    description: 'Post settled sales that have no journal entry (05 §5.6.1). Tenants without a ledger calendar are skipped.',
    intervalSeconds: 3600,
    async run(ctx) {
      let skipped = 0;
      const perTenant: Record<string, SummaryValue> = {};
      let exceptions = 0;
      const { failed } = await forEachTenant(ctx, async (tenantId) => {
        // Configuration, not identity: a tenant whose ledger has no fiscal
        // calendar has not set its books up, and sweeping it would open one
        // GL_NO_PERIOD exception per sale. Skipped, and counted.
        const hasLedger = await ctx.runner.withTenant(tenantId, async (tx) => {
          const r = await tx.query<{ ok: boolean }>(`select exists (select 1 from app.fiscal_year) as ok`);
          return r.rows[0]?.ok === true;
        });
        if (!hasLedger) {
          skipped += 1;
          return;
        }
        const t = { examined: 0, posted: 0, duplicates: 0, exceptions: 0, passes: 0 };
        for (let pass = 0; pass < SWEEP_MAX_PASSES && !ctx.signal.aborted; pass += 1) {
          const r = await sweepSettledSales(ctx.runner, {
            tenantId,
            postedBy: POSTING_SWEEP_ACTOR,
            postingRuleVersion: POSTING_RULE_VERSION,
            limit: SWEEP_BATCH,
          });
          t.passes += 1;
          t.examined += r.examined;
          t.posted += r.posted;
          t.duplicates += r.duplicates;
          t.exceptions += r.exceptions;
          // A full batch that posted something may have more behind it; a
          // batch that posted nothing is re-reading the same failing sales.
          if (r.examined < SWEEP_BATCH || r.posted === 0) break;
        }
        exceptions += t.exceptions;
        perTenant[tenantId] = t;
      });
      return {
        degraded: exceptions > 0 || failed.size > 0,
        summary: { tenants: perTenant, skipped_no_ledger: skipped, exceptions, failed: failures(failed) },
      };
    },
  });
}

export function creditSyncScopeJob(): JobDefinition {
  return defineJob({
    name: 'credit.sync_scope_refresh',
    description:
      "Recompute the credit sync-scope projections, so a grant whose effective_to has passed leaves the device's book (phase2-gate §5.2 D8).",
    intervalSeconds: 3600,
    async run(ctx) {
      const perTenant: Record<string, SummaryValue> = {};
      const { failed } = await forEachTenant(ctx, async (tenantId) => {
        // app.refresh_credit_sync_scope_all() loops over every tenant and so
        // needs a role that bypasses RLS. The per-tenant function, run inside
        // the tenant's own context as app_user, is the same work with RLS on.
        const counts = await ctx.runner.withTenant(tenantId, async (tx) => {
          const count = async () =>
            (
              await tx.query<{ book: number; loc: number }>(
                `select (select count(*) from app.credit_sync_book_scope)::int as book,
                        (select count(*) from app.credit_sync_location_scope)::int as loc`,
              )
            ).rows[0]!;
          const before = await count();
          await tx.query(`select app.refresh_credit_sync_scope($1::uuid)`, [tenantId]);
          const after = await count();
          return { book_before: before.book, book_after: after.book, location_before: before.loc, location_after: after.loc };
        });
        perTenant[tenantId] = counts;
      });
      return { degraded: failed.size > 0, summary: { tenants: perTenant, failed: failures(failed) } };
    },
  });
}

export function tableDigestJob(opts: {
  name: string;
  scope: 'money' | 'all';
  intervalSeconds: number;
  retentionDays: number;
}): JobDefinition {
  return defineJob({
    name: opts.name,
    description:
      opts.scope === 'money'
        ? 'Requirement 9.5-A: per-tenant digests of the money and credit path tables.'
        : 'Requirement 9.5-A: per-tenant digests of every tenant-owned table.',
    intervalSeconds: opts.intervalSeconds,
    async run(ctx) {
      const perTenant: Record<string, SummaryValue> = {};
      const { failed } = await forEachTenant(ctx, async (tenantId) => {
        const written = await ctx.runner.withTenant(tenantId, async (tx) => {
          const digests = await digestTables(tx, opts.scope === 'money' ? MONEY_PATH_TABLES : undefined);
          for (const d of digests) {
            await tx.query(
              `insert into app.table_digest
                 (tenant_id, id, as_of, table_name, row_count, pk_digest, row_digest, job_run_id)
               values ($1, $2, transaction_timestamp(), $3, $4::bigint, $5, $6, $7)`,
              [tenantId, uuidv7(), d.tableName, d.rowCount.toString(10), d.pkDigest, d.rowDigest, ctx.jobRunId],
            );
          }
          const pruned = await tx.query<{ n: number }>(
            `with gone as (
               delete from app.table_digest
                where as_of < transaction_timestamp() - make_interval(days => $1::int)
                returning 1)
             select count(*)::int as n from gone`,
            [opts.retentionDays],
          );
          return { tables: digests.length, pruned: pruned.rows[0]?.n ?? 0 };
        });
        perTenant[tenantId] = written;
      });
      return { degraded: failed.size > 0, summary: { tenants: perTenant, failed: failures(failed) } };
    },
  });
}

export function lostWriteControlJob(opts: { lookbackDays: number }): JobDefinition {
  return defineJob({
    name: 'ops.lost_write_control',
    description:
      'Daily: every receipt number a device reports having issued must be on a sale the server holds (nearest equivalent of §9.4 lost-write reconciliation).',
    intervalSeconds: 86_400,
    async run(ctx) {
      const alerts: AlertSignal[] = [];
      const perTenant: Record<string, SummaryValue> = {};
      const { failed } = await forEachTenant(ctx, async (tenantId) => {
        const r = await ctx.runner.withTenant(tenantId, (tx) =>
          receiptContinuity(tx, { lookbackDays: opts.lookbackDays }),
        );
        perTenant[tenantId] = {
          blocks_checked: r.blocksChecked,
          clean_groups: r.clean,
          discrepancies: r.findings.length,
          unverifiable_keys: [...r.unverifiableKeys],
        };
        for (const f of r.findings) {
          alerts.push({
            key: `lost_writes:${tenantId}:${f.deviceId}:${f.sequenceKey}`,
            kind: 'lost_writes',
            severity: 'page',
            tenantId,
            summary:
              `tenant ${tenantId} location ${f.locationId} device ${f.deviceId}: reported ${f.issued} ` +
              `${f.sequenceKey} number(s) issued, ${f.missing} not on any sale the server holds ` +
              `(first missing n=${f.missingSample.slice(0, 3).join(',')}). A printed receipt with no sale ` +
              `in the books until explained (§2.2; rollback trigger R2 if confirmed).`,
          });
        }
      });
      const watermark = await ctx.ops.query<{ present: boolean }>(
        `select to_regclass('app.device_write_watermark') is not null as present`,
      );
      return {
        degraded: alerts.length > 0 || failed.size > 0,
        alerts,
        summary: {
          tenants: perTenant,
          discrepancies: alerts.length,
          device_write_watermark_present: watermark.rows[0]?.present === true,
          failed: failures(failed),
        },
      };
    },
  });
}

export function syncHealthJob(opts: { thresholds: Omit<Thresholds, 'selfJob'>; deviceLookbackDays: number }): JobDefinition {
  const name = 'ops.sync_health';
  return defineJob({
    name,
    description: 'The §9.4 pilot signals: replication slot, dark devices, review queue, posting exceptions, drills, job staleness.',
    intervalSeconds: 900,
    async run(ctx) {
      const tenants = await ctx.tenants();
      const snapshot = await collectSignals({
        runner: ctx.runner,
        ops: ctx.ops,
        tenants,
        registered: ctx.registered,
        deviceLookbackDays: opts.deviceLookbackDays,
      });
      const alerts = evaluateSignals(snapshot, { ...opts.thresholds, selfJob: name }, ctx.now());
      return {
        degraded: alerts.some((a) => !a.quiet),
        alerts,
        summary: {
          tenants: tenants.length,
          devices_known: snapshot.devices.length,
          alerts_open: alerts.length,
          alerts_by_kind: alerts.reduce<Record<string, number>>((acc, a) => {
            acc[a.kind] = (acc[a.kind] ?? 0) + 1;
            return acc;
          }, {}),
          replication_slots: snapshot.slots === null ? null : snapshot.slots.length,
          device_write_watermark_present: snapshot.watermarkTablePresent,
          failed_tenants: snapshot.failedTenants.length,
        },
      };
    },
  });
}

export interface BuiltinJobsConfig {
  readonly thresholds: Omit<Thresholds, 'selfJob'>;
  readonly deviceLookbackDays: number;
  readonly digestRetentionDays: number;
  readonly lostWriteLookbackDays: number;
}

export function builtinJobs(cfg: BuiltinJobsConfig): JobDefinition[] {
  return [
    postingSweepJob(),
    creditSyncScopeJob(),
    tableDigestJob({ name: 'ops.table_digest', scope: 'money', intervalSeconds: 3600, retentionDays: cfg.digestRetentionDays }),
    tableDigestJob({ name: 'ops.table_digest_full', scope: 'all', intervalSeconds: 86_400, retentionDays: cfg.digestRetentionDays }),
    lostWriteControlJob({ lookbackDays: cfg.lostWriteLookbackDays }),
    syncHealthJob({ thresholds: cfg.thresholds, deviceLookbackDays: cfg.deviceLookbackDays }),
  ];
}
