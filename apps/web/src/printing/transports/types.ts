/**
 * The transport seam (§8.8). Nothing in the sale path knows which transport is
 * in use; the sale is committed before any of this runs, and nothing in here
 * can reach back into it.
 *
 * Two promises every transport makes, and the guard below enforces for all of
 * them in one place so a new transport cannot forget either:
 *
 *   1. `print()` NEVER REJECTS. Every failure is a value (`PrintAttempt`).
 *   2. `print()` NEVER HANGS. It settles within `timeoutMs` (default 12 s) as
 *      `{outcome:'timeout'}`. A promise that cannot reject can still hang
 *      forever on a dropped GATT connection or a printer that stopped reading —
 *      the same outage with a friendlier stack trace.
 *
 * What an outcome of 'sent' MEANS is deliberately weak. There is no back-channel
 * on any of these paths: the printer cannot tell us the paper ran out. 'sent'
 * means "the bytes were accepted" (or "handed to the print app", or "the print
 * dialog closed") — the `evidence` field says which, and the UI says exactly
 * that and no more.
 */
import type { ReceiptDocument } from '../document';

export type TransportId =
  | 'ble-escpos'
  | 'webusb-escpos'
  | 'web-serial'
  | 'android-print-bridge'
  | 'system-print'
  | 'none';

export const ALL_TRANSPORT_IDS: readonly TransportId[] = [
  'ble-escpos',
  'webusb-escpos',
  'web-serial',
  'android-print-bridge',
  'system-print',
  'none',
];

export const DEFAULT_PRINT_TIMEOUT_MS = 12_000;

export type PrintOutcome =
  /** The transport accepted the job. See `evidence` for how strong that is. */
  | 'sent'
  /** Did not settle in time. The bytes may or may not have reached the printer. */
  | 'timeout'
  | 'failed'
  /** This device cannot use this transport at all (API missing, wrong OS). */
  | 'unavailable'
  /** No printer is chosen, or the browser needs a person to choose one. */
  | 'needs-pairing'
  /** The `none` transport: the receipt is on screen, nothing was sent anywhere. */
  | 'shown';

export type PrintEvidence =
  | 'bytes-accepted'
  | 'handed-off'
  | 'dialog-closed'
  | 'shown'
  | 'none';

export interface PrintAttempt {
  readonly transport: TransportId;
  readonly outcome: PrintOutcome;
  readonly evidence: PrintEvidence;
  /** One plain sentence for a person, or machine detail for the spike log. */
  readonly detail: string | null;
  readonly durationMs: number;
  readonly byteCount: number;
}

/** What a transport is handed. Raw transports send `bytes`; document transports read `doc`. */
export interface PrintJob {
  readonly doc: ReceiptDocument;
  readonly bytes: Uint8Array;
  readonly isCopy: boolean;
}

export type HealthState = 'unsupported' | 'needs-pairing' | 'ready' | 'unreachable' | 'unknown';

export interface TransportHealth {
  readonly state: HealthState;
  readonly detail: string;
  /** Name of the paired printer, when one is known. */
  readonly printerName?: string | null;
}

export interface PairResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly printerName: string | null;
}

export interface ReceiptTransport {
  readonly id: TransportId;
  readonly label: string;
  /** True for transports whose job is a byte stream; false for document transports. */
  readonly raw: boolean;
  /** Passive by default; `connect: true` actively reaches for the printer. Never throws. */
  probe(options?: { readonly connect?: boolean }): Promise<TransportHealth>;
  print(job: PrintJob, timeoutMs?: number): Promise<PrintAttempt>;
  /** Choose/pair a printer. MUST be called from a user gesture. Never throws. */
  pair?(): Promise<PairResult>;
  /** Forget the chosen printer. Never throws. */
  forget?(): Promise<void>;
  /** Fires when the printer link drops or comes back. Returns unsubscribe. */
  onLinkChange?(listener: (up: boolean) => void): () => void;
}

/** Per-device tuning every transport may read. Values come from device settings. */
export interface TransportTuning {
  readonly chunkBytes: number;
  readonly chunkDelayMs: number;
  readonly baudRate: number;
  /** The Android print-service app the bridge hands bytes to. */
  readonly bridgePackage: string;
  readonly paperWidthMm: 58 | 80;
  /** What `system-print` lays out: a roll receipt at the paper width, or an A4 invoice. */
  readonly systemLayout: 'roll' | 'a4';
  /** The remembered printer for this transport, if any. */
  readonly device: RememberedDevice | null;
}

export interface RememberedDevice {
  readonly id: string;
  readonly name: string | null;
}

export interface TransportDeps {
  readonly tuning: () => TransportTuning;
  readonly remember: (transport: TransportId, device: RememberedDevice | null) => void;
  readonly now: () => number;
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export interface GuardResult {
  readonly evidence: PrintEvidence;
  readonly detail?: string;
  /** Override the default 'sent' (for the `none` transport's 'shown'). */
  readonly outcome?: PrintOutcome;
}

class OutcomeError extends Error {
  constructor(
    readonly outcome: PrintOutcome,
    message: string,
  ) {
    super(message);
    this.name = 'OutcomeError';
  }
}

/** Throw from inside guarded work to settle with a specific, non-failure outcome. */
export function settleAs(outcome: PrintOutcome, message: string): never {
  throw new OutcomeError(outcome, message);
}

/** Map a thrown browser error to an outcome a person can act on. */
export function classifyError(err: unknown): { outcome: PrintOutcome; detail: string } {
  if (err instanceof OutcomeError) return { outcome: err.outcome, detail: err.message };
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'NotFoundError') {
    return { outcome: 'needs-pairing', detail: 'No printer was chosen, or it is out of range.' };
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { outcome: 'needs-pairing', detail: 'The browser needs the printer to be chosen again.' };
  }
  if (name === 'NetworkError') {
    return { outcome: 'failed', detail: 'The printer link dropped.' };
  }
  return { outcome: 'failed', detail: message.length > 0 ? message : name || 'Unknown error' };
}

/**
 * Run `work`, and ALWAYS settle: success, failure, or timeout. `work` receives an
 * AbortSignal that is aborted on timeout so it can stop writing; `onTimeout`
 * lets the transport tear down a wedged link (e.g. disconnect GATT) so the next
 * attempt starts clean. Neither this function nor its caller can be made to
 * reject or hang by anything `work` does, including throwing synchronously.
 */
export async function guardedPrint(
  id: TransportId,
  timeoutMs: number,
  byteCount: number,
  deps: Pick<TransportDeps, 'now'>,
  work: (signal: AbortSignal) => Promise<GuardResult>,
  onTimeout?: () => void,
): Promise<PrintAttempt> {
  const started = deps.now();
  const controller = new AbortController();
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PRINT_TIMEOUT_MS;
  const elapsed = (): number => Math.max(0, deps.now() - started);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), limit);
    });
    let running: Promise<GuardResult>;
    try {
      running = Promise.resolve(work(controller.signal));
    } catch (err) {
      running = Promise.reject(err);
    }
    const settled = running.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const winner = await Promise.race([settled, timedOut]);
    if (winner === 'timeout') {
      controller.abort();
      try {
        onTimeout?.();
      } catch {
        // tearing down a wedged link must not turn a timeout into a throw
      }
      return {
        transport: id,
        outcome: 'timeout',
        evidence: 'none',
        detail: 'The printer did not answer in time. It may or may not have printed.',
        durationMs: elapsed(),
        byteCount,
      };
    }
    if (winner.ok) {
      return {
        transport: id,
        outcome: winner.value.outcome ?? 'sent',
        evidence: winner.value.evidence,
        detail: winner.value.detail ?? null,
        durationMs: elapsed(),
        byteCount,
      };
    }
    const c = classifyError(winner.error);
    return {
      transport: id,
      outcome: c.outcome,
      evidence: 'none',
      detail: c.detail,
      durationMs: elapsed(),
      byteCount,
    };
  } catch (err) {
    // Defensive: nothing above should reach here, and if it does the contract
    // (never reject) still holds.
    return {
      transport: id,
      outcome: 'failed',
      evidence: 'none',
      detail: err instanceof Error ? err.message : 'Unexpected printing error',
      durationMs: 0,
      byteCount,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Split bytes into chunks no larger than `size` (min 1). */
export function chunk(bytes: Uint8Array, size: number): Uint8Array[] {
  const n = Math.max(1, Math.trunc(size));
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += n) out.push(bytes.subarray(i, Math.min(bytes.length, i + n)));
  return out;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted === true) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
