/**
 * The printing spike runner (§8.8 "The Phase 1 printing spike").
 *
 * Runs N synthetic receipts through the CHOSEN transport, one after another,
 * and records for each: when, how long, the outcome, whether the app was
 * foregrounded, and which operator-marked event (printer power-cycled, screen
 * locked, app backgrounded) preceded it. `summarize` turns that into the
 * numbers the pass criteria are written in, so the run can be read off the
 * screen on the day without a developer:
 *
 *   - first-try success rate (target >= 99.5 %)
 *   - median and p95 time per receipt (target < 3 s / < 5 s for 12 lines, 58 mm)
 *   - time to the first success after a marked power cycle (target < 5 s, no human step)
 *   - HANGS (target zero): attempts that did not settle within the timeout
 *
 * It never touches a sale, the outbox or the print queue: it calls the
 * transport directly with a synthetic receipt, so a spike run cannot alter,
 * delay or duplicate anything real.
 */
import type { PrintJob, ReceiptTransport } from './transports/types';

export interface SpikeSample {
  readonly n: number;
  readonly atIso: string;
  readonly outcome: string;
  readonly evidence: string;
  readonly durationMs: number;
  /** Whether the page was in the foreground when the attempt started. */
  readonly visible: boolean;
  /** The operator-marked event this attempt is the first after, if any. */
  readonly afterEvent: string | null;
  /** Time from that event to this attempt succeeding. Set only on the first success after a mark. */
  readonly recoveryMs: number | null;
  readonly detail: string;
}

export interface SpikeSummary {
  readonly attempts: number;
  readonly sent: number;
  readonly failed: number;
  readonly timeouts: number;
  readonly hangs: number;
  /** Success rate in hundredths of a percent (9950 = 99.50 %). */
  readonly successBp: number;
  readonly medianMs: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
  readonly recoveriesMs: readonly number[];
  readonly hiddenAttempts: number;
}

export interface SpikeOptions {
  readonly transport: ReceiptTransport;
  readonly makeJob: (n: number) => PrintJob;
  readonly count: number;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly isStopped: () => boolean;
  readonly isVisible: () => boolean;
  /** Returns (and clears) the operator's pending event mark, if any. */
  readonly takeMark: () => { readonly label: string; readonly atMs: number } | null;
  readonly onSample: (s: SpikeSample) => void;
}

const HANG = 'hang';

export async function runSpike(o: SpikeOptions): Promise<SpikeSample[]> {
  const samples: SpikeSample[] = [];
  let openMark: { label: string; atMs: number } | null = null;
  for (let n = 1; n <= o.count && !o.isStopped(); n++) {
    const fresh = o.takeMark();
    if (fresh !== null) openMark = fresh;
    const started = o.now();
    const visible = o.isVisible();
    // The watchdog is how a HANG is observed: the transport promises to settle
    // within its timeout, and if it has not by twice that, it did not keep it.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<typeof HANG>((resolve) => {
      watchdog = setTimeout(() => resolve(HANG), o.timeoutMs * 2 + 1000);
    });
    let result: Awaited<ReturnType<ReceiptTransport['print']>> | typeof HANG;
    try {
      result = await Promise.race([o.transport.print(o.makeJob(n), o.timeoutMs), guard]);
    } catch (err) {
      // A transport that rejects broke its contract; record it as a failure.
      result = {
        transport: o.transport.id,
        outcome: 'failed',
        evidence: 'none',
        detail: `REJECTED: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: o.now() - started,
        byteCount: 0,
      };
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
    }
    const finished = o.now();
    const ok = result !== HANG && (result.outcome === 'sent' || result.outcome === 'shown');
    const sample: SpikeSample = {
      n,
      atIso: new Date(finished).toISOString(),
      outcome: result === HANG ? HANG : result.outcome,
      evidence: result === HANG ? 'none' : result.evidence,
      durationMs: result === HANG ? finished - started : result.durationMs,
      visible,
      afterEvent: openMark?.label ?? null,
      recoveryMs: ok && openMark !== null ? finished - openMark.atMs : null,
      detail: result === HANG ? 'transport did not settle within twice its timeout' : (result.detail ?? ''),
    };
    if (ok) openMark = null;
    samples.push(sample);
    o.onSample(sample);
    if (n < o.count && !o.isStopped()) await o.sleep(o.intervalMs);
  }
  return samples;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}

export function summarize(samples: readonly SpikeSample[], timeoutMs: number): SpikeSummary {
  const sent = samples.filter((s) => s.outcome === 'sent' || s.outcome === 'shown');
  const times = sent.map((s) => s.durationMs).sort((a, b) => a - b);
  const hangs = samples.filter((s) => s.outcome === HANG || s.durationMs > timeoutMs + 1000).length;
  const total = samples.length;
  return {
    attempts: total,
    sent: sent.length,
    failed: samples.filter((s) => s.outcome === 'failed' || s.outcome === 'needs-pairing' || s.outcome === 'unavailable').length,
    timeouts: samples.filter((s) => s.outcome === 'timeout').length,
    hangs,
    successBp: total === 0 ? 0 : Math.floor((sent.length * 10_000) / total),
    medianMs: percentile(times, 50),
    p95Ms: percentile(times, 95),
    maxMs: times.length === 0 ? null : (times[times.length - 1] ?? null),
    recoveriesMs: samples.flatMap((s) => (s.recoveryMs === null ? [] : [s.recoveryMs])),
    hiddenAttempts: samples.filter((s) => !s.visible).length,
  };
}

/** Hundredths of a percent as text, with no float arithmetic: 9950 -> "99.50%". */
export function bpText(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = String(bp % 100).padStart(2, '0');
  return `${String(whole)}.${frac}%`;
}

export function toCsv(samples: readonly SpikeSample[]): string {
  const head = 'n,at,outcome,evidence,duration_ms,visible,after_event,recovery_ms,detail';
  const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [
    head,
    ...samples.map((s) =>
      [s.n, s.atIso, s.outcome, s.evidence, s.durationMs, s.visible ? 1 : 0, esc(s.afterEvent ?? ''), s.recoveryMs ?? '', esc(s.detail)].join(','),
    ),
  ].join('\n');
}
