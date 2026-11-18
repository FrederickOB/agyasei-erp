/**
 * `web-serial` — the Web Serial API, desktop Chrome/Edge.
 *
 * This is how the LAPTOP case reaches a Bluetooth Classic (SPP) printer: once
 * the OS has paired it, Windows and macOS expose it as a COM / serial port, and
 * Web Serial can open that port — which Web Bluetooth never can (§8.8 point 1).
 * USB-serial printers appear the same way. Chrome for Android has no Web Serial
 * on the target builds; on a tablet use `android-print-bridge`.
 *
 * Each print opens the port, writes, flushes and closes. Holding a port open
 * between receipts is faster but turns "the printer was switched off for an
 * hour" into a wedged handle; open-per-print makes every receipt start clean at
 * a cost the spike will measure.
 */
import {
  guardedPrint,
  settleAs,
  type GuardResult,
  DEFAULT_PRINT_TIMEOUT_MS,
  type PairResult,
  type PrintAttempt,
  type PrintJob,
  type ReceiptTransport,
  type TransportDeps,
  type TransportHealth,
} from './types';

export interface SerialWriterLike {
  write(chunk: Uint8Array): Promise<void>;
  releaseLock(): void;
  abort?(reason?: unknown): Promise<void>;
  close?(): Promise<void>;
}
export interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly writable: { getWriter(): SerialWriterLike } | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number; bluetoothServiceClassId?: string | number };
}
export interface SerialLike {
  requestPort(options?: object): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}
export interface SerialEnv {
  readonly serial: () => SerialLike | undefined;
}

export function defaultSerialEnv(): SerialEnv {
  return {
    serial: () =>
      typeof navigator === 'undefined' ? undefined : (navigator as unknown as { serial?: SerialLike }).serial,
  };
}

function portKey(p: SerialPortLike): string {
  const info = p.getInfo?.() ?? {};
  return JSON.stringify([info.usbVendorId ?? null, info.usbProductId ?? null, info.bluetoothServiceClassId ?? null]);
}

export function createWebSerialTransport(deps: TransportDeps, env: SerialEnv = defaultSerialEnv()): ReceiptTransport {
  let chosen: SerialPortLike | null = null;

  async function resolve(): Promise<SerialPortLike | null> {
    if (chosen !== null) return chosen;
    const serial = env.serial();
    const remembered = deps.tuning().device;
    if (serial === undefined || remembered === null) return null;
    const ports = await serial.getPorts();
    return ports.find((p) => portKey(p) === remembered.id) ?? (ports.length === 1 ? (ports[0] ?? null) : null);
  }

  return {
    id: 'web-serial',
    label: 'Serial / Bluetooth-classic printer (laptop)',
    raw: true,

    async probe(): Promise<TransportHealth> {
      try {
        if (env.serial() === undefined) {
          return {
            state: 'unsupported',
            detail: 'This browser has no Web Serial. Use desktop Chrome or Edge, or the print-app route on a tablet.',
          };
        }
        const port = await resolve();
        return port === null
          ? { state: 'needs-pairing', detail: 'No serial printer chosen yet.' }
          : { state: 'ready', detail: 'Serial printer chosen.', printerName: deps.tuning().device?.name ?? null };
      } catch (err) {
        return { state: 'unknown', detail: err instanceof Error ? err.message : 'Could not check serial ports.' };
      }
    },

    async pair(): Promise<PairResult> {
      try {
        const serial = env.serial();
        if (serial === undefined) return { ok: false, detail: 'Web Serial is not available here.', printerName: null };
        const port = await serial.requestPort();
        chosen = port;
        deps.remember('web-serial', { id: portKey(port), name: 'Serial printer' });
        return { ok: true, detail: 'Printer port chosen.', printerName: 'Serial printer' };
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        return {
          ok: false,
          detail: name === 'NotFoundError' ? 'No port was chosen.' : err instanceof Error ? err.message : 'Pairing failed.',
          printerName: null,
        };
      }
    },

    async forget(): Promise<void> {
      chosen = null;
      deps.remember('web-serial', null);
    },

    print(job: PrintJob, timeoutMs: number = DEFAULT_PRINT_TIMEOUT_MS): Promise<PrintAttempt> {
      let port: SerialPortLike | null = null;
      let writer: SerialWriterLike | null = null;
      const teardown = (): void => {
        const w = writer;
        const p = port;
        writer = null;
        port = null;
        void (async () => {
          try {
            if (w !== null) {
              if (w.abort !== undefined) await w.abort();
              else w.releaseLock();
            }
          } catch {
            // already released
          }
          try {
            await p?.close();
          } catch {
            // already closed
          }
        })();
      };
      return guardedPrint(
        'web-serial',
        timeoutMs,
        job.bytes.length,
        deps,
        async () => {
          try {
            return await run();
          } catch (err) {
            teardown(); // a failed write must not leave the port open and locked
            throw err;
          }
        },
        teardown,
      );
      async function run(): Promise<GuardResult> {
          const found = await resolve();
          if (found === null) {
            settleAs(
              'needs-pairing',
              env.serial() === undefined ? 'Web Serial is not available here.' : 'No serial printer chosen yet.',
            );
          }
          port = found;
          await found.open({ baudRate: deps.tuning().baudRate });
          if (found.writable === null) settleAs('failed', 'The serial port is not writable.');
          writer = found.writable.getWriter();
          await writer.write(job.bytes);
          // Graceful end: release the lock and close, so the port is free for the next receipt.
          const w = writer;
          writer = null;
          w.releaseLock();
          port = null;
          await found.close();
          return { evidence: 'bytes-accepted', detail: 'Bytes accepted by the serial port.' };
      }
    },
  };
}
