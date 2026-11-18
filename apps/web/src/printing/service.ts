/**
 * The print service: the only thing the UI talks to.
 *
 * What it guarantees, and where each guarantee is enforced:
 *
 *  - THE SALE COMES FIRST. `afterSale` refuses to do anything for a sale that is
 *    not already committed in the outbox on this device. It cannot be used to
 *    print a sale that does not exist, and nothing it does can precede, delay or
 *    undo a commit: the counter calls it from the `.then` of `checkout()`.
 *  - A PRINT NEVER TOUCHES A SALE. Every write here goes to `local_print_queue`
 *    (queue.ts); nothing imports the outbox mutators. A transport that throws,
 *    hangs, or reports garbage ends as a recorded attempt, never an exception
 *    into the counter.
 *  - ONE PRINT AT A TIME. Jobs are serialised, so two receipts can never
 *    interleave on one printer's byte stream, and a double-tap on Reprint joins
 *    the in-flight job rather than printing twice.
 *  - NOTHING BLOCKS THE NEXT CUSTOMER. `afterSale` returns as soon as the
 *    snapshot is queued; the print itself runs behind it.
 *  - A PRINTER THAT COMES BACK CATCHES UP. `startAutoRetry` drains the pending
 *    queue, oldest first, with backoff; a link-up, the network returning, or the
 *    app coming to the foreground nudges it immediately.
 */
import type { CurrencySpec } from '@erp/money';
import type { LocalDb } from '../data/db';
import { CODE_PAGES } from './codepage';
import { buildReceiptDocument, type ReceiptDocument } from './document';
import { encodeReceipt, fromBase64, toBase64, type EncodeOptions } from './escpos';
import {
  cacheBytes,
  enqueueReceipt,
  ensureEntry,
  getQueueEntry,
  listPending,
  purgeExpired,
  recordAttempt,
  requestReprint,
  type QueueEntry,
} from './queue';
import { readPrinterSettings, writePrinterSettings, DEFAULT_PRINTER_SETTINGS, type PrinterSettings } from './settings';
import {
  documentForCommittedSale,
  documentFromSyncedSale,
  readCommittedSale,
  type PricedCartForReceipt,
} from './sources';
import { createTransports, defaultTransportEnvs, type TransportEnvs } from './transports/registry';
import type {
  PairResult,
  PrintAttempt,
  ReceiptTransport,
  RememberedDevice,
  TransportHealth,
  TransportId,
} from './transports/types';

/** An outstanding print older than this is not auto-retried: a stale request surprising someone later is worse than a manual retry. */
export const AUTO_RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;

export type AfterSaleResult =
  | { readonly status: 'queued' }
  /** No committed sale with this id on this device. Nothing was queued or printed. */
  | { readonly status: 'no-such-sale' };

export interface PrintServiceOptions {
  readonly now?: () => number;
  readonly envs?: TransportEnvs;
  /** Replace transports (tests, spike rigs). */
  readonly transports?: Readonly<Record<TransportId, ReceiptTransport>>;
  readonly retry?: { readonly baseMs: number; readonly maxMs: number };
}

export class PrintService {
  private settingsNow: PrinterSettings = DEFAULT_PRINTER_SETTINGS;
  private readonly transports: Readonly<Record<TransportId, ReceiptTransport>>;
  private readonly now: () => number;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Map<string, Promise<PrintAttempt | null>>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 0;
  private retryOn = false;
  private readonly retryCfg: { baseMs: number; maxMs: number };
  private readonly unsubscribers: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private busy = 0;

  constructor(
    private readonly db: LocalDb,
    options: PrintServiceOptions = {},
  ) {
    this.now = options.now ?? ((): number => Date.now());
    this.retryCfg = { baseMs: options.retry?.baseMs ?? 4000, maxMs: options.retry?.maxMs ?? 30_000 };
    this.transports =
      options.transports ??
      createTransports(
        () => this.settingsNow,
        (id, device) => this.rememberDevice(id, device),
        this.now,
        options.envs ?? defaultTransportEnvs(),
      );
  }

  // ---- settings -----------------------------------------------------------

  get settings(): PrinterSettings {
    return this.settingsNow;
  }

  async loadSettings(): Promise<PrinterSettings> {
    this.settingsNow = await readPrinterSettings(this.db);
    return this.settingsNow;
  }

  async saveSettings(patch: Partial<PrinterSettings>): Promise<PrinterSettings> {
    const next = { ...this.settingsNow, ...patch };
    await writePrinterSettings(this.db, next);
    this.settingsNow = await readPrinterSettings(this.db);
    this.emit();
    return this.settingsNow;
  }

  private rememberDevice(id: TransportId, device: RememberedDevice | null): void {
    const devices = { ...this.settingsNow.devices };
    if (device === null) delete devices[id];
    else devices[id] = device;
    // The in-memory copy updates at once (the next print reads it); the write
    // is fire-and-forget and can only fail into a log, never into a print.
    this.settingsNow = { ...this.settingsNow, devices };
    void writePrinterSettings(this.db, this.settingsNow).catch(() => undefined);
  }

  transport(id: TransportId = this.settingsNow.transport): ReceiptTransport {
    return this.transports[id];
  }

  probe(id: TransportId = this.settingsNow.transport, connect = false): Promise<TransportHealth> {
    return this.transport(id).probe({ connect }).catch(
      (): TransportHealth => ({ state: 'unknown', detail: 'Could not check this printer.' }),
    );
  }

  /** MUST be called from a user gesture (a tap handler). */
  async pair(id: TransportId = this.settingsNow.transport): Promise<PairResult> {
    const t = this.transport(id);
    if (t.pair === undefined) return { ok: false, detail: 'This route needs no pairing.', printerName: null };
    const result = await t.pair().catch((): PairResult => ({ ok: false, detail: 'Pairing failed.', printerName: null }));
    if (result.ok) this.nudge();
    return result;
  }

  async forget(id: TransportId = this.settingsNow.transport): Promise<void> {
    await this.transport(id).forget?.().catch(() => undefined);
    this.emit();
  }

  // ---- change notifications (UI "is something printing?") ------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get isBusy(): boolean {
    return this.busy > 0;
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // a UI listener must not break printing
      }
    }
  }

  // ---- after a sale --------------------------------------------------------

  /**
   * Called by the counter AFTER `checkout()` has committed. Queues the receipt
   * snapshot, then (if auto-print is on) starts printing behind it. Resolves as
   * soon as the snapshot is queued — it does not wait for the printer.
   */
  async afterSale(
    saleId: string,
    cart: PricedCartForReceipt,
    currency: CurrencySpec,
  ): Promise<AfterSaleResult> {
    const facts = await readCommittedSale(this.db, saleId);
    if (facts === null) return { status: 'no-such-sale' };
    const doc = await documentForCommittedSale(this.db, facts, cart, currency);
    await enqueueReceipt(this.db, doc, new Date(this.now()).toISOString());
    if (this.settingsNow.autoPrint) void this.print(saleId);
    return { status: 'queued' };
  }

  // ---- printing ------------------------------------------------------------

  /** Print (or retry) the outstanding request for a sale. Never rejects. */
  print(saleId: string): Promise<PrintAttempt | null> {
    const running = this.inflight.get(saleId);
    if (running !== undefined) return running;
    const job = this.enqueueRun(() => this.runOne(saleId));
    this.inflight.set(saleId, job);
    void job.finally(() => this.inflight.delete(saleId));
    return job;
  }

  /**
   * A person asked for another copy. Works for any sale this device rang, even
   * one whose queue row expired: the document is then rebuilt from the synced
   * rows (and says plainly if they have not arrived).
   */
  async reprint(saleId: string): Promise<PrintAttempt | 'no-document'> {
    try {
      const nowIso = new Date(this.now()).toISOString();
      let entry = await getQueueEntry(this.db, saleId);
      if (entry === null || entry.doc === null) {
        const rebuilt = await documentFromSyncedSale(this.db, saleId);
        if (rebuilt === null) return 'no-document';
        await ensureEntry(this.db, rebuilt, nowIso);
        entry = await getQueueEntry(this.db, saleId);
      }
      if (entry === null) return 'no-document';
      await requestReprint(this.db, saleId, nowIso);
      return (await this.print(saleId)) ?? 'no-document';
    } catch {
      return 'no-document';
    }
  }

  private enqueueRun<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private encodeOptions(isCopy: boolean): EncodeOptions {
    const s = this.settingsNow;
    return {
      paperWidthMm: s.paperWidthMm,
      codePage: s.codePage,
      cut: s.cut,
      // The drawer opens for the ORIGINAL receipt only; a reprint never pops it.
      drawerKick: s.kickDrawer && !isCopy ? s.drawerKick : null,
      qrModuleSize: 5,
      qrErrorLevel: 'M',
      trailingLines: 3,
      isCopy,
    };
  }

  private async runOne(saleId: string): Promise<PrintAttempt | null> {
    this.busy += 1;
    this.emit();
    try {
      const entry = await getQueueEntry(this.db, saleId);
      if (entry === null) return null;
      const doc: ReceiptDocument | null = entry.doc ?? (await documentFromSyncedSale(this.db, saleId));
      const transport = this.transport();
      const timeoutMs = this.settingsNow.timeoutMs;
      let attempt: PrintAttempt;
      if (doc === null) {
        attempt = {
          transport: transport.id,
          outcome: 'failed',
          evidence: 'none',
          detail: 'The receipt details are no longer on this device.',
          durationMs: 0,
          byteCount: 0,
        };
      } else {
        const bytes = await this.bytesFor(entry, doc, transport);
        attempt = await Promise.resolve(
          transport.print({ doc, bytes, isCopy: entry.isCopy }, timeoutMs),
        ).catch(
          // Transports promise never to reject. If one does, that is its bug —
          // and it still must not reach the counter.
          (err: unknown): PrintAttempt => ({
            transport: transport.id,
            outcome: 'failed',
            evidence: 'none',
            detail: err instanceof Error ? err.message : 'Printing failed.',
            durationMs: 0,
            byteCount: bytes.length,
          }),
        );
      }
      await recordAttempt(this.db, saleId, attempt, new Date(this.now()).toISOString());
      return attempt;
    } catch {
      return null;
    } finally {
      this.busy -= 1;
      this.emit();
    }
  }

  private async bytesFor(entry: QueueEntry, doc: ReceiptDocument, transport: ReceiptTransport): Promise<Uint8Array> {
    if (!transport.raw) return new Uint8Array(0);
    if (entry.bytesB64 !== null && entry.paperWidthMm === this.settingsNow.paperWidthMm) {
      return fromBase64(entry.bytesB64);
    }
    const bytes = encodeReceipt(doc, this.encodeOptions(entry.isCopy));
    await cacheBytes(this.db, entry.saleId, toBase64(bytes), this.settingsNow.paperWidthMm).catch(() => undefined);
    return bytes;
  }

  /** Try every outstanding print, oldest first; stop at the first that fails (the printer is down). */
  async drain(): Promise<{ attempted: number; sent: number }> {
    let attempted = 0;
    let sent = 0;
    try {
      await purgeExpired(this.db, new Date(this.now()).toISOString());
      const cutoff = this.now() - AUTO_RETRY_WINDOW_MS;
      const pending = (await listPending(this.db)).filter((e) => Date.parse(e.requestedAt) >= cutoff);
      for (const entry of pending) {
        attempted += 1;
        const result = await this.print(entry.saleId);
        if (result !== null && (result.outcome === 'sent' || result.outcome === 'shown')) sent += 1;
        else break;
      }
    } catch {
      // draining is best-effort
    }
    return { attempted, sent };
  }

  // ---- auto retry ----------------------------------------------------------

  startAutoRetry(): void {
    if (this.retryOn) return;
    this.retryOn = true;
    this.retryDelay = this.retryCfg.baseMs;
    const t = this.transports['ble-escpos'];
    const unsub = t.onLinkChange?.((up) => {
      if (up) this.nudge();
    });
    if (unsub !== undefined) this.unsubscribers.push(unsub);
    if (typeof window !== 'undefined') {
      const wake = (): void => this.nudge();
      window.addEventListener('online', wake);
      const vis = (): void => {
        if (document.visibilityState === 'visible') this.nudge();
      };
      document.addEventListener('visibilitychange', vis);
      this.unsubscribers.push(() => {
        window.removeEventListener('online', wake);
        document.removeEventListener('visibilitychange', vis);
      });
    }
    this.schedule(0);
  }

  stopAutoRetry(): void {
    this.retryOn = false;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const u of this.unsubscribers.splice(0)) u();
  }

  /** Something changed that may make a print succeed now: try straight away. */
  nudge(): void {
    if (!this.retryOn) return;
    this.retryDelay = this.retryCfg.baseMs;
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.retryOn) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    this.retryTimer = null;
    if (!this.retryOn) return;
    const { attempted, sent } = await this.drain();
    if (!this.retryOn) return;
    if (attempted === 0 || sent === attempted) {
      // Nothing outstanding (or all caught up): idle at the slow poll.
      this.retryDelay = this.retryCfg.maxMs;
    } else {
      this.retryDelay = Math.min(this.retryCfg.maxMs, this.retryDelay * 2);
    }
    this.schedule(this.retryDelay);
  }

  // ---- test page -----------------------------------------------------------

  async printTest(currency: CurrencySpec): Promise<PrintAttempt> {
    const transport = this.transport();
    const doc = buildTestDocument(currency, this.settingsNow.paperWidthMm, 1, new Date(this.now()).toISOString());
    const options = { ...this.encodeOptions(false), drawerKick: null };
    const bytes = transport.raw ? encodeReceipt(doc, options) : new Uint8Array(0);
    return transport.print({ doc, bytes, isCopy: false }, this.settingsNow.timeoutMs);
  }

  codePageFor(): (typeof CODE_PAGES)[keyof typeof CODE_PAGES] {
    return CODE_PAGES[this.settingsNow.codePage];
  }
}

/**
 * A synthetic receipt for the test page and the spike: 12 lines, a mix of long
 * names and quantities, a tax line, a total, and the pack's currency sign (so
 * the page itself shows whether the glyph prints). Never a sale; never queued.
 */
export function buildTestDocument(
  currency: CurrencySpec,
  paperWidthMm: 58 | 80,
  serial = 1,
  nowIso: string = new Date().toISOString(),
): ReceiptDocument {
  const names = [
    'Test item - long product name that must wrap',
    'Short',
    'Twelve millimetre reinforcement bar',
    'Cement 50 kg bag',
    'Nails 4 inch',
    'Roofing sheet 3 m',
  ];
  const lines = Array.from({ length: 12 }, (_, i) => ({
    name: names[i % names.length] as string,
    qtyScaled: BigInt(((i % 4) + 1) * 1000),
    qtyScale: 3,
    uomLabel: 'unit',
    unitPriceE4: BigInt(12 + i) * 10n ** BigInt(currency.scale) * 10_000n,
    amountMinor: BigInt(((i % 4) + 1) * (12 + i)) * 10n ** BigInt(currency.scale),
  }));
  const totalMinor = lines.reduce((n, l) => n + l.amountMinor, 0n);
  return buildReceiptDocument({
    saleId: `test-${String(serial)}`,
    receiptNo: `TEST-${String(serial).padStart(4, '0')}`,
    issuedAtIso: nowIso,
    timeZone: 'UTC',
    businessDate: nowIso.slice(0, 10),
    currency,
    businessName: `PRINTER TEST ${String(paperWidthMm)}mm`,
    headerLines: ['Not a sale. Nothing was recorded.'],
    pricesIncludeTax: false,
    lines,
    netMinor: totalMinor,
    taxLines: [],
    totalMinor,
    tenders: [{ method: 'Test', amountMinor: totalMinor, reference: null }],
    changeMinor: 0n,
    footerLines: ['If you can read this, bytes reached the printer.', `Currency: ${currency.code} ${currency.symbol}`],
  });
}
