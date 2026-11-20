/**
 * Printer test page and SPIKE MODE (§8.8 "The Phase 1 printing spike").
 *
 * The founder runs this on the real tablet with the real printer. It sends N
 * synthetic receipts through the chosen route, one by one, and the numbers the
 * pass criteria are written in appear on screen as it goes: first-try success,
 * median and p95 time, hangs, and recovery time after a marked power cycle.
 * Nothing here touches a sale, the outbox or the print queue.
 *
 * The three "mark" buttons exist because the protocol has a human in it: press
 * the button the moment you power-cycle the printer / lock the screen /
 * background the app, and the first successful print afterwards reports how
 * long recovery took, with no human step in between.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { runSpike, summarize, toCsv, bpText, type SpikeSample } from '../../printing/spike';
import type { PrintService } from '../../printing/service';
import { useCurrencySpec } from '../../money/CurrencyContext';
import { Icon } from '../../ui/Icon';

function sec(ms: number | null): string {
  if (ms === null) return '-';
  return `${String(Math.floor(ms / 1000))}.${String(ms % 1000).padStart(3, '0')} s`;
}

export function PrinterSpike({ svc }: { readonly svc: PrintService }): ReactNode {
  const currency = useCurrencySpec();
  const [count, setCount] = useState('200');
  const [interval, setIntervalMs] = useState('1500');
  const [running, setRunning] = useState(false);
  const [samples, setSamples] = useState<readonly SpikeSample[]>([]);
  const stop = useRef(false);
  const mark = useRef<{ label: string; atMs: number } | null>(null);
  const [lastMark, setLastMark] = useState<string | null>(null);

  const timeoutMs = svc.settings.timeoutMs;
  const summary = useMemo(() => summarize(samples, timeoutMs), [samples, timeoutMs]);

  const start = (): void => {
    // `|| default` would turn a deliberate 0 ms pause into 1.5 s.
    const parse = (text: string, fallback: number): number => {
      const n = Number.parseInt(text, 10);
      return Number.isFinite(n) ? n : fallback;
    };
    const n = Math.max(1, Math.min(1000, parse(count, 200)));
    const gap = Math.max(0, Math.min(60_000, parse(interval, 1500)));
    stop.current = false;
    setSamples([]);
    setRunning(true);
    const acc: SpikeSample[] = [];
    void runSpike({
      transport: svc.transport(),
      makeJob: (i) => svc.spikeJob(currency, i),
      count: n,
      intervalMs: gap,
      timeoutMs,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      isStopped: () => stop.current,
      isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
      takeMark: () => {
        const m = mark.current;
        mark.current = null;
        return m;
      },
      onSample: (s) => {
        acc.push(s);
        setSamples([...acc]);
      },
    }).finally(() => setRunning(false));
  };

  const addMark = (label: string): void => {
    mark.current = { label, atMs: Date.now() };
    setLastMark(`${label} marked at ${new Date().toLocaleTimeString()}`);
  };

  const csv = useMemo(() => toCsv(samples), [samples]);
  const last = samples[samples.length - 1];

  return (
    <section className="printer-card" aria-label="Hardware test">
      <h3 className="printer-h3">Hardware test (spike)</h3>
      <p className="printer-note">
        Sends test receipts to the chosen route and records timings. Not sales: nothing is recorded or queued.
        Full protocol and pass criteria are in the printing spike protocol document.
      </p>
      <div className="printer-row">
        <label className="printer-field">
          <span>Receipts</span>
          <input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} disabled={running} />
        </label>
        <label className="printer-field">
          <span>Pause between (ms)</span>
          <input inputMode="numeric" value={interval} onChange={(e) => setIntervalMs(e.target.value)} disabled={running} />
        </label>
      </div>
      <div className="print-actions">
        {running ? (
          <button type="button" className="secondary-action pressable" onClick={() => (stop.current = true)}>
            <Icon name="close" size={20} />
            Stop run
          </button>
        ) : (
          <button type="button" className="primary-action pressable" onClick={start}>
            <Icon name="printer" size={20} />
            Start run
          </button>
        )}
      </div>
      <div className="print-actions" role="group" aria-label="Mark an event during the run">
        <button type="button" className="secondary-action pressable" onClick={() => addMark('printer power-cycled')}>
          Printer power-cycled
        </button>
        <button type="button" className="secondary-action pressable" onClick={() => addMark('screen locked')}>
          Screen locked
        </button>
        <button type="button" className="secondary-action pressable" onClick={() => addMark('app backgrounded')}>
          App backgrounded
        </button>
      </div>
      {lastMark === null ? null : <p className="printer-note">{lastMark}. The next successful receipt reports recovery time.</p>}

      <dl className="spike-stats" aria-label="Run results">
        <div><dt>Attempts</dt><dd className="tabular">{summary.attempts}</dd></div>
        <div><dt>Sent</dt><dd className="tabular">{summary.sent}</dd></div>
        <div><dt>First-try success</dt><dd className="tabular">{summary.attempts === 0 ? '-' : bpText(summary.successBp)}</dd></div>
        <div><dt>Median</dt><dd className="tabular">{sec(summary.medianMs)}</dd></div>
        <div><dt>95th percentile</dt><dd className="tabular">{sec(summary.p95Ms)}</dd></div>
        <div><dt>Slowest</dt><dd className="tabular">{sec(summary.maxMs)}</dd></div>
        <div><dt>Timeouts</dt><dd className="tabular">{summary.timeouts}</dd></div>
        <div><dt>Failed</dt><dd className="tabular">{summary.failed}</dd></div>
        <div><dt>Hangs (must be 0)</dt><dd className="tabular">{summary.hangs}</dd></div>
        <div><dt>While backgrounded</dt><dd className="tabular">{summary.hiddenAttempts}</dd></div>
        <div>
          <dt>Recovery after a mark</dt>
          <dd className="tabular">{summary.recoveriesMs.length === 0 ? '-' : summary.recoveriesMs.map(sec).join(', ')}</dd>
        </div>
      </dl>
      {last === undefined ? null : (
        <p className="printer-note" role="status">
          Last: #{last.n} {last.outcome} in {sec(last.durationMs)}
          {last.detail.length > 0 ? ` (${last.detail})` : ''}
        </p>
      )}
      {samples.length === 0 ? null : (
        <>
          <label className="printer-field">
            <span>Results (CSV)</span>
            <textarea readOnly rows={5} value={csv} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <button
            type="button"
            className="secondary-action pressable"
            onClick={() => {
              void navigator.clipboard?.writeText(csv).catch(() => undefined);
            }}
          >
            Copy results
          </button>
        </>
      )}
    </section>
  );
}
