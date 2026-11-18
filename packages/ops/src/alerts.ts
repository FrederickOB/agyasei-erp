/**
 * Alerts: what a job found that needs a human, its lifecycle, and where it is
 * sent.
 *
 * LIFECYCLE (platform.ops_alert). A standing problem pages ONCE, repeats on a
 * schedule while it stands, and announces its resolution. Re-paging every
 * fifteen minutes is how a pager gets muted — and the three pages that matter
 * (§9.4) need a pager nobody has muted.
 *
 * QUIET. A dark device at 03:00 is still dark, but the outlet is closed and
 * waking someone teaches them to ignore the pager (§9.4). A quiet signal keeps
 * its alert OPEN (it is not resolved by night falling) and sends nothing.
 *
 * CONTENT. Ids and counts only — never a name, an amount, a receipt line or a
 * customer. The webhook leaves the platform; what it carries must be safe to
 * land in whatever SMS gateway, chat channel or inbox the founder chooses.
 */
import type { OpsDb } from './db.js';

export type Severity = 'page' | 'ticket';

export interface AlertSignal {
  /** Stable identity: the same problem produces the same key every evaluation. */
  readonly key: string;
  readonly kind: string;
  readonly severity: Severity;
  readonly tenantId?: string | undefined;
  /** Ids and counts only. */
  readonly summary: string;
  /** Still true, but not worth waking anyone for right now (outside trading hours). */
  readonly quiet?: boolean | undefined;
}

export interface AlertNotification {
  readonly state: 'firing' | 'repeat' | 'resolved';
  readonly key: string;
  readonly kind: string;
  readonly severity: Severity;
  readonly tenantId: string | null;
  readonly summary: string;
  readonly source: string;
  readonly firstSeenAt: string;
}

export interface AlertSink {
  send(batch: readonly AlertNotification[]): Promise<void>;
}

const SAFE_KEY = /^[A-Za-z0-9_.:\-]{1,200}$/;

/**
 * Reconcile this source's current signals against the stored alert state and
 * return what should be sent. Call `markSent` with the keys that were
 * delivered; an undelivered firing alert is retried on the next evaluation.
 */
export async function reconcileAlerts(
  ops: OpsDb,
  source: string,
  current: readonly AlertSignal[],
  opts: { repeatAfterMs: number },
): Promise<AlertNotification[]> {
  for (const s of current) {
    if (!SAFE_KEY.test(s.key)) throw new Error(`alert key has unexpected characters: ${JSON.stringify(s.key)}`);
  }
  return ops.transaction(async (tx) => {
    const open = await tx.query<{
      key: string;
      kind: string;
      severity: Severity;
      tenant_id: string | null;
      summary: string;
      first_seen_at: string;
      last_sent_at: string | null;
      resolved_at: string | null;
    }>(
      `select key, kind, severity, tenant_id::text, summary, first_seen_at::text,
              last_sent_at::text, resolved_at::text
         from platform.ops_alert where source_job = $1 or key = any($2::text[])
         for update`,
      [source, current.map((c) => c.key)],
    );
    const byKey = new Map(open.rows.map((r) => [r.key, r]));
    const out: AlertNotification[] = [];
    const nowRes = await tx.query<{ now: string }>(`select clock_timestamp()::text as now`);
    const now = Date.parse(nowRes.rows[0]!.now);

    for (const s of current) {
      const prev = byKey.get(s.key);
      if (!prev || prev.resolved_at !== null) {
        const row = await tx.query<{ first_seen_at: string }>(
          `insert into platform.ops_alert (key, source_job, kind, severity, tenant_id, summary)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (key) do update
             set source_job = excluded.source_job, kind = excluded.kind, severity = excluded.severity,
                 tenant_id = excluded.tenant_id, summary = excluded.summary,
                 first_seen_at = clock_timestamp(), last_seen_at = clock_timestamp(),
                 last_sent_at = null, resolved_at = null
           returning first_seen_at::text`,
          [s.key, source, s.kind, s.severity, s.tenantId ?? null, s.summary],
        );
        if (!s.quiet) {
          out.push(note('firing', s, source, row.rows[0]!.first_seen_at));
        }
        continue;
      }
      await tx.query(
        `update platform.ops_alert set last_seen_at = clock_timestamp(), summary = $2, severity = $3 where key = $1`,
        [s.key, s.summary, s.severity],
      );
      if (s.quiet) continue;
      const lastSent = prev.last_sent_at === null ? null : Date.parse(prev.last_sent_at);
      if (lastSent === null) out.push(note('firing', s, source, prev.first_seen_at));
      else if (now - lastSent >= opts.repeatAfterMs) out.push(note('repeat', s, source, prev.first_seen_at));
    }

    const live = new Set(current.map((c) => c.key));
    for (const prev of open.rows) {
      if (prev.resolved_at !== null || live.has(prev.key)) continue;
      // Only this source resolves its own alerts.
      const owned = await tx.query(
        `update platform.ops_alert set resolved_at = clock_timestamp()
          where key = $1 and source_job = $2 and resolved_at is null returning key`,
        [prev.key, source],
      );
      if (owned.rows.length > 0 && prev.last_sent_at !== null) {
        out.push({
          state: 'resolved',
          key: prev.key,
          kind: prev.kind,
          severity: prev.severity,
          tenantId: prev.tenant_id,
          summary: prev.summary,
          source,
          firstSeenAt: prev.first_seen_at,
        });
      }
    }
    return out;
  });
}

function note(
  state: 'firing' | 'repeat',
  s: AlertSignal,
  source: string,
  firstSeenAt: string,
): AlertNotification {
  return {
    state,
    key: s.key,
    kind: s.kind,
    severity: s.severity,
    tenantId: s.tenantId ?? null,
    summary: s.summary,
    source,
    firstSeenAt,
  };
}

export async function markSent(ops: OpsDb, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await ops.query(
    `update platform.ops_alert
        set last_sent_at = clock_timestamp(), send_count = send_count + 1
      where key = any($1::text[])`,
    [[...keys]],
  );
}

/** One line per alert, suitable for SMS-length channels and chat alike. */
export function renderAlertLine(n: AlertNotification): string {
  const head = n.state === 'resolved' ? 'RESOLVED' : n.severity === 'page' ? 'PAGE' : 'TICKET';
  const again = n.state === 'repeat' ? ' (still open)' : '';
  return `[${head}] ${n.kind}${again}: ${n.summary}`;
}

/**
 * POST a JSON document to a webhook. `text` makes it readable by chat-style
 * incoming webhooks as-is; `alerts` is the structured form for anything that
 * routes on severity. The provider behind the URL (SMS gateway, email relay,
 * paging service) is the founder's choice and configuration, never code.
 */
export function webhookSink(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; environment?: string } = {},
): AlertSink {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async send(batch) {
      if (batch.length === 0) return;
      const env = opts.environment ? `[${opts.environment}] ` : '';
      const body = JSON.stringify({
        text: batch.map((n) => env + renderAlertLine(n)).join('\n'),
        alerts: batch,
      });
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      if (!res.ok) throw new Error(`alert webhook answered HTTP ${res.status}`);
    },
  };
}

/** Development / unconfigured: alerts go to the structured log only. */
export function logSink(log: (line: string, fields: Record<string, unknown>) => void): AlertSink {
  return {
    async send(batch) {
      for (const n of batch) log(renderAlertLine(n), { alert_key: n.key, tenant_id: n.tenantId, state: n.state });
    },
  };
}
