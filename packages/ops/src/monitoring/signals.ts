/**
 * The §9.4 signals that matter for the pilot — collected per tenant under
 * RLS, evaluated against thresholds into alerts.
 *
 * WHAT IS MEASURED, AND WHAT IS NOT (stated, because §9.4's own tables do not
 * exist yet):
 *
 *   §9.4 signal                    here
 *   ─────────────────────────────  ──────────────────────────────────────────
 *   replication slot lag / WAL     pg_replication_slots — exactly as specified.
 *   sync lag per device            LAST ACCEPTED WRITE per device, from
 *                                  app.write_log (origin DEVICE). §9.4 reads
 *                                  app.device_sync_state, which does not exist:
 *                                  downloads and handshakes are invisible to
 *                                  this database, so a device that syncs but
 *                                  never sells looks dark. Measured in TRADING
 *                                  time so a closed outlet is not an outage.
 *   connected-but-not-draining     NOT MEASURABLE without device_sync_state.
 *   lost-write reconciliation      see ./receipt-continuity.ts (daily job):
 *                                  app.device_write_watermark does not exist;
 *                                  the receipt-number high-water mark each
 *                                  device reports is the nearest equivalent.
 *   human review queue             app.conflict_review: depth, age, overdue
 *                                  (escalate_at passed), severity-1.
 *   posting exceptions             app.posting_exception, open, by code and age.
 *   drill recency / scratch life   platform.restore_drill.
 *   job staleness                  platform.job_run vs each job's interval.
 *
 * Every per-tenant read runs inside `runner.withTenant` — the snapshot is
 * assembled from per-tenant answers, never from one query across tenants.
 */
import type { AlertSignal } from '../alerts.js';
import type { OpsDb, TenantRunner } from '../db.js';
import { safeError } from '../log.js';
import { isTrading, safeTimezone, tradingMsBetween, type TradingWindow } from './trading-hours.js';

export interface DeviceActivity {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly locationId: string | null;
  readonly timezone: string | null;
  readonly lastWriteAt: string;
  readonly writes24h: number;
}

export interface ReviewQueueState {
  readonly tenantId: string;
  readonly open: number;
  readonly oldestOpenAt: string | null;
  readonly overdue: number;
  readonly oldestOverdueAt: string | null;
  readonly severity1Open: number;
}

export interface PostingExceptionState {
  readonly tenantId: string;
  readonly open: number;
  readonly oldestOpenAt: string | null;
  readonly byCode: Readonly<Record<string, number>>;
}

export interface ReplicationSlotState {
  readonly slotName: string;
  readonly slotType: string;
  readonly active: boolean;
  readonly retainedBytes: string | null;
  readonly lagBytes: string | null;
}

export interface SignalSnapshot {
  readonly collectedAt: string;
  readonly tenants: readonly string[];
  readonly devices: readonly DeviceActivity[];
  readonly reviewQueues: readonly ReviewQueueState[];
  readonly postingExceptions: readonly PostingExceptionState[];
  /** null when the catalogue could not be read (stated, not hidden). */
  readonly slots: readonly ReplicationSlotState[] | null;
  readonly drill: { readonly newestRanAt: string | null; readonly undestroyedScratch: readonly { id: string; ranAt: string }[] } | null;
  readonly jobs: readonly { name: string; intervalSeconds: number; lastSuccessAt: string | null }[];
  readonly failedTenants: readonly { tenantId: string; error: string }[];
  /** §9.4's lost-write table. Reported so its arrival is noticed. */
  readonly watermarkTablePresent: boolean;
}

export interface CollectOptions {
  readonly runner: TenantRunner;
  readonly ops: OpsDb;
  readonly tenants: readonly string[];
  readonly registered?: readonly { name: string; intervalSeconds: number }[];
  /** How far back a device counts as "known". */
  readonly deviceLookbackDays?: number;
}

export async function collectSignals(opts: CollectOptions): Promise<SignalSnapshot> {
  const lookback = opts.deviceLookbackDays ?? 35;
  const devices: DeviceActivity[] = [];
  const reviewQueues: ReviewQueueState[] = [];
  const postingExceptions: PostingExceptionState[] = [];
  const failedTenants: { tenantId: string; error: string }[] = [];

  for (const tenantId of opts.tenants) {
    try {
      await opts.runner.withTenant(tenantId, async (tx) => {
        const dev = await tx.query<{
          device_id: string;
          location_id: string | null;
          last_write_at: string;
          writes_24h: number;
        }>(
          `select w.device_id::text as device_id,
                  (array_agg(w.location_id::text order by w.received_at desc)
                     filter (where w.location_id is not null))[1] as location_id,
                  max(w.received_at)::text as last_write_at,
                  (count(*) filter (where w.received_at > clock_timestamp() - interval '24 hours'))::int as writes_24h
             from app.write_log w
            where w.origin = 'DEVICE'
              and w.device_id is not null
              and w.received_at > clock_timestamp() - make_interval(days => $1::int)
            group by w.device_id
            order by w.device_id`,
          [lookback],
        );
        const locIds = [...new Set(dev.rows.map((r) => r.location_id).filter((x): x is string => x !== null))];
        const tz = new Map<string, string | null>();
        if (locIds.length > 0) {
          const locs = await tx.query<{ id: string; timezone: string | null }>(
            `select id::text as id, timezone from app.location where id = any($1::uuid[])`,
            [locIds],
          );
          for (const l of locs.rows) tz.set(l.id, l.timezone);
        }
        for (const r of dev.rows) {
          devices.push({
            tenantId,
            deviceId: r.device_id,
            locationId: r.location_id,
            timezone: r.location_id ? (tz.get(r.location_id) ?? null) : null,
            lastWriteAt: r.last_write_at,
            writes24h: r.writes_24h,
          });
        }

        const rq = await tx.query<{
          open: number;
          oldest_open_at: string | null;
          overdue: number;
          oldest_overdue_at: string | null;
          sev1: number;
        }>(
          `select (count(*) filter (where status in ('open', 'claimed')))::int as open,
                  (min(opened_at) filter (where status in ('open', 'claimed')))::text as oldest_open_at,
                  (count(*) filter (where status in ('open', 'claimed') and escalate_at <= clock_timestamp()))::int as overdue,
                  (min(opened_at) filter (where status in ('open', 'claimed') and escalate_at <= clock_timestamp()))::text
                    as oldest_overdue_at,
                  (count(*) filter (where status in ('open', 'claimed') and severity = 1))::int as sev1
             from app.conflict_review`,
        );
        const q = rq.rows[0]!;
        reviewQueues.push({
          tenantId,
          open: q.open,
          oldestOpenAt: q.oldest_open_at,
          overdue: q.overdue,
          oldestOverdueAt: q.oldest_overdue_at,
          severity1Open: q.sev1,
        });

        const pe = await tx.query<{ error_code: string; n: number; oldest: string }>(
          `select error_code, count(*)::int as n, min(opened_at)::text as oldest
             from app.posting_exception where resolved_at is null
            group by error_code order by error_code`,
        );
        const byCode: Record<string, number> = {};
        let open = 0;
        let oldest: string | null = null;
        for (const r of pe.rows) {
          byCode[r.error_code] = r.n;
          open += r.n;
          if (oldest === null || Date.parse(r.oldest) < Date.parse(oldest)) oldest = r.oldest;
        }
        postingExceptions.push({ tenantId, open, oldestOpenAt: oldest, byCode });
      });
    } catch (err) {
      failedTenants.push({ tenantId, error: safeError(err).message });
    }
  }

  let slots: ReplicationSlotState[] | null = null;
  try {
    const s = await opts.ops.query<{
      slot_name: string;
      slot_type: string;
      active: boolean;
      retained_bytes: string | null;
      lag_bytes: string | null;
    }>(
      `select slot_name::text, slot_type::text, active,
              pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint::text as retained_bytes,
              pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint::text as lag_bytes
         from pg_replication_slots order by slot_name`,
    );
    slots = s.rows.map((r) => ({
      slotName: r.slot_name,
      slotType: r.slot_type,
      active: r.active,
      retainedBytes: r.retained_bytes,
      lagBytes: r.lag_bytes,
    }));
  } catch {
    slots = null;
  }

  let drill: SignalSnapshot['drill'] = null;
  try {
    const newest = await opts.ops.query<{ newest: string | null }>(
      `select max(ran_at)::text as newest from platform.restore_drill`,
    );
    const alive = await opts.ops.query<{ id: string; ran_at: string }>(
      `select id::text, ran_at::text from platform.restore_drill
        where scratch_destroyed_at is null order by ran_at`,
    );
    drill = {
      newestRanAt: newest.rows[0]?.newest ?? null,
      undestroyedScratch: alive.rows.map((r) => ({ id: r.id, ranAt: r.ran_at })),
    };
  } catch {
    drill = null;
  }

  const registered = opts.registered ?? [];
  let jobs: SignalSnapshot['jobs'] = [];
  if (registered.length > 0) {
    const j = await opts.ops.query<{ job_name: string; last_ok: string | null }>(
      `select job_name,
              (max(started_at) filter (where status in ('succeeded', 'degraded')))::text as last_ok
         from platform.job_run where job_name = any($1::text[]) group by job_name`,
      [registered.map((r) => r.name)],
    );
    const lastOk = new Map(j.rows.map((r) => [r.job_name, r.last_ok]));
    jobs = registered.map((r) => ({ ...r, lastSuccessAt: lastOk.get(r.name) ?? null }));
  }

  const wm = await opts.ops.query<{ present: boolean }>(
    `select to_regclass('app.device_write_watermark') is not null as present`,
  );

  const now = await opts.ops.query<{ now: string }>(`select clock_timestamp()::text as now`);
  return {
    collectedAt: new Date(Date.parse(now.rows[0]!.now)).toISOString(),
    tenants: [...opts.tenants],
    devices,
    reviewQueues,
    postingExceptions,
    slots,
    drill,
    jobs,
    failedTenants,
    watermarkTablePresent: wm.rows[0]?.present === true,
  };
}

export interface Thresholds {
  readonly tradingWindow: TradingWindow;
  /** Trading time without an accepted write before a device is dark (§9.4 floor: 4h). */
  readonly darkAfterMs: number;
  readonly reviewOverdueMs: number;
  readonly reviewDepth: number;
  readonly postingExceptionAgeMs: number;
  /** §9.4: lag > 2 GB pages. */
  readonly slotRetainedBytes: bigint;
  /** In production the sync service must hold a logical slot; its absence pages. */
  readonly expectLogicalSlot: boolean;
  readonly drillMaxAgeDays: number;
  readonly scratchMaxAgeHours: number;
  readonly jobStaleFactor: number;
  /** The job doing the evaluating (excluded from its own staleness check). */
  readonly selfJob?: string;
}

const H = 3_600_000;

function hours(ms: number): string {
  return (ms / H).toFixed(1);
}

/** Pure: snapshot + thresholds + now → the complete current alert set. */
export function evaluateSignals(s: SignalSnapshot, t: Thresholds, now: Date): AlertSignal[] {
  const out: AlertSignal[] = [];
  const nowMs = now.getTime();

  if (s.slots !== null) {
    const logical = s.slots.filter((x) => x.slotType === 'logical');
    if (t.expectLogicalSlot && logical.length === 0) {
      out.push({
        key: 'replication_slot_missing',
        kind: 'replication_slot_missing',
        severity: 'page',
        summary: 'no logical replication slot exists: the sync service is not replicating, devices receive no downloads',
      });
    }
    for (const slot of logical) {
      const retained = slot.retainedBytes === null ? 0n : BigInt(slot.retainedBytes);
      if (retained > t.slotRetainedBytes) {
        out.push({
          key: `replication_wal_retained:${slot.slotName}`,
          kind: 'replication_wal_retained',
          severity: 'page',
          summary: `slot ${slot.slotName} retains ${(Number(retained / 1048576n) / 1024).toFixed(2)} GiB of WAL (threshold ${(Number(t.slotRetainedBytes / 1048576n) / 1024).toFixed(2)} GiB): if the sync service stops consuming, the database disk fills and every tenant stops`,
        });
      }
      if (!slot.active) {
        out.push({
          key: `replication_slot_inactive:${slot.slotName}`,
          kind: 'replication_slot_inactive',
          severity: 'ticket',
          summary: `slot ${slot.slotName} has no consumer connected`,
        });
      }
    }
  }

  for (const d of s.devices) {
    const tz = safeTimezone(d.timezone);
    const last = new Date(Date.parse(d.lastWriteAt));
    const silent = tradingMsBetween(last, now, tz, t.tradingWindow, t.darkAfterMs);
    if (silent > t.darkAfterMs) {
      out.push({
        key: `dark_device:${d.tenantId}:${d.deviceId}`,
        kind: 'dark_device',
        severity: 'page',
        tenantId: d.tenantId,
        summary: `tenant ${d.tenantId} location ${d.locationId ?? 'unknown'} device ${d.deviceId}: no accepted write for more than ${hours(t.darkAfterMs)}h of trading time (last ${last.toISOString()})`,
        quiet: !isTrading(now, tz, t.tradingWindow),
      });
    }
  }

  for (const q of s.reviewQueues) {
    if (q.severity1Open > 0) {
      out.push({
        key: `review_severity1:${q.tenantId}`,
        kind: 'review_severity1',
        severity: 'page',
        tenantId: q.tenantId,
        summary: `tenant ${q.tenantId}: ${q.severity1Open} blocking (severity-1) review item(s) open`,
      });
    }
    if (q.oldestOverdueAt !== null && nowMs - Date.parse(q.oldestOverdueAt) > t.reviewOverdueMs) {
      out.push({
        key: `review_overdue:${q.tenantId}`,
        kind: 'review_overdue',
        severity: 'ticket',
        tenantId: q.tenantId,
        summary: `tenant ${q.tenantId}: ${q.overdue} review item(s) past escalation, oldest opened ${hours(nowMs - Date.parse(q.oldestOverdueAt))}h ago`,
      });
    }
    if (q.open > t.reviewDepth) {
      out.push({
        key: `review_depth:${q.tenantId}`,
        kind: 'review_depth',
        severity: 'ticket',
        tenantId: q.tenantId,
        summary: `tenant ${q.tenantId}: ${q.open} review items open (threshold ${t.reviewDepth})`,
      });
    }
  }

  for (const p of s.postingExceptions) {
    if (p.oldestOpenAt !== null && nowMs - Date.parse(p.oldestOpenAt) > t.postingExceptionAgeMs) {
      const codes = Object.entries(p.byCode)
        .map(([c, n]) => `${c}=${n}`)
        .join(' ');
      out.push({
        key: `posting_exceptions:${p.tenantId}`,
        kind: 'posting_exceptions',
        severity: 'ticket',
        tenantId: p.tenantId,
        summary: `tenant ${p.tenantId}: ${p.open} settled document(s) not in the ledger (${codes}); oldest ${hours(nowMs - Date.parse(p.oldestOpenAt))}h. A period cannot close over them.`,
      });
    }
  }

  if (s.drill !== null) {
    if (s.drill.newestRanAt === null) {
      out.push({
        key: 'restore_drill_missing',
        kind: 'restore_drill_missing',
        severity: 'ticket',
        summary: 'no restore drill has ever been recorded: an untested backup is a belief, not a control (§9.5; pilot Stage 0 requires one within 30 days)',
      });
    } else {
      const ageDays = (nowMs - Date.parse(s.drill.newestRanAt)) / (24 * H);
      if (ageDays > t.drillMaxAgeDays) {
        out.push({
          key: 'restore_drill_stale',
          kind: 'restore_drill_stale',
          severity: 'ticket',
          summary: `newest restore drill is ${ageDays.toFixed(0)} days old (limit ${t.drillMaxAgeDays})`,
        });
      }
    }
    for (const sc of s.drill.undestroyedScratch) {
      if (nowMs - Date.parse(sc.ranAt) > t.scratchMaxAgeHours * H) {
        out.push({
          key: `scratch_alive:${sc.id}`,
          kind: 'scratch_alive',
          severity: 'page',
          summary: `restore drill ${sc.id} left a scratch copy of every tenant's books alive for more than ${t.scratchMaxAgeHours}h`,
        });
      }
    }
  }

  for (const j of s.jobs) {
    if (j.name === t.selfJob || j.lastSuccessAt === null) continue;
    const age = nowMs - Date.parse(j.lastSuccessAt);
    if (age > t.jobStaleFactor * j.intervalSeconds * 1000) {
      out.push({
        key: `job_stale:${j.name}`,
        kind: 'job_stale',
        severity: 'page',
        summary: `job ${j.name} last succeeded ${hours(age)}h ago (interval ${hours(j.intervalSeconds * 1000)}h)`,
      });
    }
  }

  for (const f of s.failedTenants) {
    out.push({
      key: `signals_unavailable:${f.tenantId}`,
      kind: 'signals_unavailable',
      severity: 'ticket',
      tenantId: f.tenantId,
      summary: `tenant ${f.tenantId}: monitoring could not read this tenant's signals (${f.error})`,
    });
  }

  return out;
}
