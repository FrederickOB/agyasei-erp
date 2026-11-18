/**
 * The spike runner's arithmetic (it is how the pass criteria get read off a
 * screen, so it has to be right), the document snapshot round-trip, settings
 * sanitising, and the browser-print HTML.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReceiptDocument,
  deserializeDocument,
  formatIssuedAt,
  rateBpText,
  serializeDocument,
  tendersFromLegacySale,
} from '../src/printing/document';
import { escapeHtml, renderReceiptHtml } from '../src/printing/html';
import { DEFAULT_PRINTER_SETTINGS, sanitizeSettings } from '../src/printing/settings';
import { bpText, runSpike, summarize, toCsv, type SpikeSample } from '../src/printing/spike';
import type { PrintAttempt, PrintJob, ReceiptTransport } from '../src/printing/transports/types';
import { sampleDoc, sampleInput } from './helpers/receipt-fixtures';

function sample(n: number, outcome: string, durationMs: number, extra: Partial<SpikeSample> = {}): SpikeSample {
  return { n, atIso: '2026-12-01T00:00:00.000Z', outcome, evidence: 'none', durationMs, visible: true, afterEvent: null, recoveryMs: null, detail: '', ...extra };
}

describe('spike summary', () => {
  it('computes first-try success, median, p95 and max from the samples', () => {
    const samples = [
      ...Array.from({ length: 19 }, (_, i) => sample(i + 1, 'sent', 1000 + i * 100)), // 1000..2800
      sample(20, 'sent', 4000),
    ];
    const s = summarize(samples, 12_000);
    expect(s.attempts).toBe(20);
    expect(s.successBp).toBe(10_000);
    expect(s.medianMs).toBe(1900);
    expect(s.p95Ms).toBe(2800);
    expect(s.maxMs).toBe(4000);
    expect(bpText(s.successBp)).toBe('100.00%');
  });

  it('counts failures, timeouts and hangs separately, and never calls a hang a success', () => {
    const s = summarize(
      [sample(1, 'sent', 900), sample(2, 'failed', 50), sample(3, 'timeout', 12_000), sample(4, 'hang', 40_000), sample(5, 'sent', 1100)],
      12_000,
    );
    expect(s).toMatchObject({ attempts: 5, sent: 2, failed: 1, timeouts: 1, hangs: 1, successBp: 4000 });
    expect(bpText(9950)).toBe('99.50%');
    expect(bpText(9905)).toBe('99.05%');
  });

  it('an attempt that settled long after its timeout counts as a hang even if the transport called it a timeout', () => {
    expect(summarize([sample(1, 'timeout', 30_000)], 12_000).hangs).toBe(1);
  });

  it('is empty-safe', () => {
    expect(summarize([], 12_000)).toMatchObject({ attempts: 0, medianMs: null, p95Ms: null, successBp: 0 });
  });

  it('writes CSV a spreadsheet can open, quoting commas', () => {
    const csv = toCsv([sample(1, 'failed', 5, { detail: 'a, "b"' })]);
    expect(csv.split('\n')[1]).toContain('"a, ""b"""');
  });
});

describe('spike runner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function transport(print: (n: number) => Promise<PrintAttempt>): ReceiptTransport {
    let n = 0;
    return {
      id: 'ble-escpos',
      label: 'x',
      raw: true,
      probe: () => Promise.resolve({ state: 'ready', detail: '' }),
      print: () => print(++n),
    };
  }
  const job: PrintJob = { doc: sampleDoc(), bytes: new Uint8Array(1), isCopy: false };
  const ok = (ms: number): PrintAttempt => ({ transport: 'ble-escpos', outcome: 'sent', evidence: 'bytes-accepted', detail: null, durationMs: ms, byteCount: 1 });

  it('a transport that never settles is recorded as a HANG, not waited on forever', async () => {
    const out: SpikeSample[] = [];
    const run = runSpike({
      transport: transport(() => new Promise(() => undefined)),
      makeJob: () => job,
      count: 1,
      intervalMs: 0,
      timeoutMs: 1000,
      now: () => Date.now(),
      sleep: () => Promise.resolve(),
      isStopped: () => false,
      isVisible: () => true,
      takeMark: () => null,
      onSample: (s) => out.push(s),
    });
    await vi.advanceTimersByTimeAsync(3100);
    const samples = await run;
    expect(samples[0]?.outcome).toBe('hang');
    expect(summarize(samples, 1000).hangs).toBe(1);
  });

  it('a transport that rejects (breaking its contract) is recorded, not thrown', async () => {
    const samples = await runSpike({
      transport: transport(() => Promise.reject(new Error('nope'))),
      makeJob: () => job,
      count: 2,
      intervalMs: 0,
      timeoutMs: 1000,
      now: () => Date.now(),
      sleep: () => Promise.resolve(),
      isStopped: () => false,
      isVisible: () => true,
      takeMark: () => null,
      onSample: () => undefined,
    });
    expect(samples.map((s) => s.outcome)).toEqual(['failed', 'failed']);
    expect(samples[0]?.detail).toMatch(/REJECTED/);
  });

  it('measures recovery from a marked power cycle to the first success, with no human step', async () => {
    let clock = 1_000_000;
    const results = ['failed', 'failed', 'sent', 'sent'] as const;
    const samples = await runSpike({
      transport: transport((n) =>
        Promise.resolve({ ...ok(10), outcome: results[n - 1] ?? 'sent', evidence: results[n - 1] === 'sent' ? 'bytes-accepted' : 'none' }),
      ),
      makeJob: () => job,
      count: 4,
      intervalMs: 1500,
      timeoutMs: 12_000,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      isStopped: () => false,
      isVisible: () => true,
      takeMark: (() => {
        let given = false;
        return () => (given ? null : ((given = true), { label: 'printer power-cycled', atMs: 1_000_000 }));
      })(),
      onSample: () => undefined,
    });
    expect(samples[2]?.recoveryMs).toBe(3000); // two failed attempts, 1.5 s apart, then success
    expect(samples[2]?.afterEvent).toBe('printer power-cycled');
    expect(samples[3]?.recoveryMs).toBeNull();
    expect(summarize(samples, 12_000).recoveriesMs).toEqual([3000]);
  });

  it('stops when asked, and notes attempts made while the page was hidden', async () => {
    let stopped = false;
    let visible = true;
    const samples = await runSpike({
      transport: transport(() => Promise.resolve(ok(5))),
      makeJob: () => job,
      count: 10,
      intervalMs: 0,
      timeoutMs: 1000,
      now: () => Date.now(),
      sleep: () => Promise.resolve(),
      isStopped: () => stopped,
      isVisible: () => visible,
      takeMark: () => null,
      onSample: (s) => {
        if (s.n === 1) visible = false;
        if (s.n === 3) stopped = true;
      },
    });
    expect(samples).toHaveLength(3);
    expect(summarize(samples, 1000).hiddenAttempts).toBe(2);
  });
});

describe('the receipt document snapshot', () => {
  it('survives serialisation with every bigint exact (no float, no precision loss)', () => {
    const big = 9_007_199_254_740_993n; // beyond Number.MAX_SAFE_INTEGER
    const doc = sampleDoc({ totalMinor: big, tenders: [{ method: 'Cash', amountMinor: big, reference: 'ref' }] });
    const back = deserializeDocument(serializeDocument(doc));
    expect(back?.totalMinor).toBe(big);
    expect(back?.tenders[0]?.amountMinor).toBe(big);
    expect(back).toEqual(doc);
  });

  it('refuses a snapshot it cannot trust', () => {
    expect(deserializeDocument('{"version":2}')).toBeNull();
    expect(deserializeDocument('not json')).toBeNull();
    expect(deserializeDocument('{"version":1,"receiptNo":"x","totalMinor":{"$bigint":"1"},"currency":{"code":"X","symbol":"","scale":9}}')).toBeNull();
  });

  it('carries its own scale: a document at scale 3 formats at 3 whatever the live pack says', () => {
    const doc = buildReceiptDocument(sampleInput({ currency: { code: 'TST', symbol: 'T', scale: 3 } }));
    expect(doc.currency.scale).toBe(3);
    const back = deserializeDocument(serializeDocument(doc));
    expect(back?.currency.scale).toBe(3);
  });

  it('rounds the display unit price half-up from the e4 price, and states it', () => {
    const doc = buildReceiptDocument(
      sampleInput({ lines: [{ name: 'x', qtyScaled: 1n, qtyScale: 0, uomLabel: 'u', unitPriceE4: 125_000n, amountMinor: 13n }] }),
    );
    expect(doc.lines[0]?.unitPriceMinor).toBe(13n); // 12.5 minor -> 13
  });

  it('formats the issue time in the sale\'s own zone, deterministically', () => {
    expect(formatIssuedAt('2026-12-01T23:30:00.000Z', 'UTC')).toBe('2026-12-01 23:30');
    expect(formatIssuedAt('2026-12-01T23:30:00.000Z', 'Asia/Tokyo')).toBe('2026-12-02 08:30');
    expect(formatIssuedAt('2026-12-01T23:30:00.000Z', 'Not/AZone')).toBe('2026-12-01 23:30');
  });

  it('renders basis points as exact percent text', () => {
    expect(rateBpText(1500n)).toBe('15%');
    expect(rateBpText(1250n)).toBe('12.5%');
    expect(rateBpText(5n)).toBe('0.05%');
    expect(rateBpText(null)).toBe('');
  });

  it('turns the current CASH/CREDIT sale shape into a tenders array in one place', () => {
    expect(tendersFromLegacySale({ tender: 'CASH', totalMinor: 100n, tenderedMinor: 150n, changeMinor: 50n })).toEqual({
      tenders: [{ method: 'Cash', amountMinor: 150n, reference: null }],
      changeMinor: 50n,
    });
    expect(tendersFromLegacySale({ tender: 'CREDIT', totalMinor: 100n, tenderedMinor: null, changeMinor: null })).toEqual({
      tenders: [{ method: 'On account', amountMinor: 100n, reference: null }],
      changeMinor: 0n,
    });
  });
});

describe('browser print HTML', () => {
  it('escapes tenant text (names are data, never markup)', () => {
    const doc = sampleDoc({ businessName: '<script>alert(1)</script>', customerName: 'A & "B"' });
    for (const layout of ['58', '80', 'a4'] as const) {
      const html = renderReceiptHtml(doc, layout);
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    }
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('A4 invoice carries the lines, tax lines, tenders and the pack slot; roll sizes the page to the paper', () => {
    const doc = sampleDoc({ pack: { slot: 'configured', fields: [{ label: 'Pack field', value: 'V1' }], qr: null } });
    const a4 = renderReceiptHtml(doc, 'a4', true);
    expect(a4).toContain('size: A4');
    expect(a4).toContain('Cement 50kg');
    expect(a4).toContain('Tax one 15%');
    expect(a4).toContain('Pack field: V1');
    expect(a4).toContain('COPY - REPRINT');
    expect(renderReceiptHtml(doc, '58')).toContain('size: 58mm auto');
  });
});

describe('device printer settings', () => {
  it('degrades anything malformed to safe defaults and clamps tuning', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_PRINTER_SETTINGS);
    expect(sanitizeSettings('x')).toEqual(DEFAULT_PRINTER_SETTINGS);
    const s = sanitizeSettings({ transport: 'carrier-pigeon', paperWidthMm: 99, chunkBytes: 1, timeoutMs: 10 ** 9, devices: { 'ble-escpos': { id: 'd', name: 5 } } });
    expect(s.transport).toBe('none');
    expect(s.paperWidthMm).toBe(58);
    expect(s.chunkBytes).toBe(20);
    expect(s.timeoutMs).toBe(60_000);
    expect(s.devices['ble-escpos']).toEqual({ id: 'd', name: null });
  });

  it('keeps a real print-app id and drops anything that is not one', () => {
    expect(sanitizeSettings({ bridgePackage: 'com.example.printer' }).bridgePackage).toBe('com.example.printer');
    expect(sanitizeSettings({ bridgePackage: 'x;S.browser_fallback_url=https://evil;end' }).bridgePackage).toBe(
      DEFAULT_PRINTER_SETTINGS.bridgePackage,
    );
  });

  it('defaults to no printer, so the receipt is shown on screen until someone chooses one', () => {
    expect(DEFAULT_PRINTER_SETTINGS.transport).toBe('none');
  });
});
