/**
 * `webusb-escpos` — WebUSB to a USB printer-class device.
 *
 * Not a fleet answer (§8.8 point 3): it needs USB OTG on a tablet, and a cheap
 * tablet that is charging usually has no free port. It is useful at a powered
 * desk — a flagship counter, or a laptop. On Windows the OS print driver claims
 * the interface first and WebUSB cannot take it back; that is a finding for the
 * spike, reported here as an ordinary failure with the browser's own words.
 *
 * Permission persists: `getDevices()` returns previously granted devices with no
 * gesture, so a paired printer prints without a chooser. The chooser is only
 * opened by `pair()`.
 */
import {
  chunk,
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

export interface UsbEndpointLike {
  readonly endpointNumber: number;
  readonly direction: 'in' | 'out';
}
export interface UsbAlternateLike {
  readonly interfaceClass: number;
  readonly endpoints: readonly UsbEndpointLike[];
}
export interface UsbInterfaceLike {
  readonly interfaceNumber: number;
  readonly alternates: readonly UsbAlternateLike[];
}
export interface UsbDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string | undefined;
  readonly opened: boolean;
  readonly configuration: { readonly interfaces: readonly UsbInterfaceLike[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: Uint8Array): Promise<{ readonly status: string; readonly bytesWritten?: number }>;
}
export interface UsbLike {
  getDevices(): Promise<UsbDeviceLike[]>;
  requestDevice(options: { filters: { classCode: number }[] }): Promise<UsbDeviceLike>;
}
export interface UsbEnv {
  readonly usb: () => UsbLike | undefined;
}

export function defaultUsbEnv(): UsbEnv {
  return {
    usb: () =>
      typeof navigator === 'undefined' ? undefined : (navigator as unknown as { usb?: UsbLike }).usb,
  };
}

const PRINTER_CLASS = 7;
const USB_CHUNK = 4096;

function deviceKey(d: UsbDeviceLike): string {
  return `${d.vendorId.toString(16)}:${d.productId.toString(16)}`;
}

function findOutEndpoint(d: UsbDeviceLike): { iface: number; endpoint: number } | null {
  for (const i of d.configuration?.interfaces ?? []) {
    for (const alt of i.alternates) {
      if (alt.interfaceClass !== PRINTER_CLASS) continue;
      const out = alt.endpoints.find((e) => e.direction === 'out');
      if (out !== undefined) return { iface: i.interfaceNumber, endpoint: out.endpointNumber };
    }
  }
  return null;
}

export function createWebUsbTransport(deps: TransportDeps, env: UsbEnv = defaultUsbEnv()): ReceiptTransport {
  let active: UsbDeviceLike | null = null;

  async function resolve(): Promise<UsbDeviceLike | null> {
    const usb = env.usb();
    if (usb === undefined) return null;
    const remembered = deps.tuning().device;
    if (remembered === null) return null;
    const granted = await usb.getDevices();
    return granted.find((d) => deviceKey(d) === remembered.id) ?? null;
  }

  return {
    id: 'webusb-escpos',
    label: 'USB printer (WebUSB)',
    raw: true,

    async probe(): Promise<TransportHealth> {
      try {
        if (env.usb() === undefined) {
          return { state: 'unsupported', detail: 'This browser has no WebUSB.' };
        }
        const dev = await resolve();
        if (dev === null) return { state: 'needs-pairing', detail: 'No USB printer chosen yet.' };
        return { state: 'ready', detail: 'USB printer chosen.', printerName: dev.productName ?? null };
      } catch (err) {
        return { state: 'unknown', detail: err instanceof Error ? err.message : 'Could not check USB.' };
      }
    },

    async pair(): Promise<PairResult> {
      try {
        const usb = env.usb();
        if (usb === undefined) return { ok: false, detail: 'WebUSB is not available here.', printerName: null };
        const picked = await usb.requestDevice({ filters: [{ classCode: PRINTER_CLASS }] });
        active = picked;
        deps.remember('webusb-escpos', { id: deviceKey(picked), name: picked.productName ?? null });
        return { ok: true, detail: 'Printer chosen.', printerName: picked.productName ?? null };
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        return {
          ok: false,
          detail: name === 'NotFoundError' ? 'No printer was chosen.' : err instanceof Error ? err.message : 'Pairing failed.',
          printerName: null,
        };
      }
    },

    async forget(): Promise<void> {
      active = null;
      deps.remember('webusb-escpos', null);
    },

    print(job: PrintJob, timeoutMs: number = DEFAULT_PRINT_TIMEOUT_MS): Promise<PrintAttempt> {
      let claimed: { dev: UsbDeviceLike; iface: number } | null = null;
      const release = (): void => {
        const c = claimed;
        claimed = null;
        if (c === null) return;
        void c.dev.releaseInterface(c.iface).catch(() => undefined);
        void c.dev.close().catch(() => undefined);
      };
      return guardedPrint(
        'webusb-escpos',
        timeoutMs,
        job.bytes.length,
        deps,
        async (signal) => {
          try {
            return await run(signal);
          } catch (err) {
            release(); // a failed transfer must hand the interface back
            throw err;
          }
        },
        release,
      );
      async function run(signal: AbortSignal): Promise<GuardResult> {
          const dev = active ?? (await resolve());
          if (dev === null) {
            settleAs(
              'needs-pairing',
              env.usb() === undefined ? 'WebUSB is not available here.' : 'No USB printer chosen yet.',
            );
          }
          active = dev;
          if (!dev.opened) await dev.open();
          if (dev.configuration === null) await dev.selectConfiguration(1);
          const target = findOutEndpoint(dev);
          if (target === null) settleAs('failed', 'No printer-class output endpoint found on this USB device.');
          await dev.claimInterface(target.iface);
          claimed = { dev, iface: target.iface };
          for (const piece of chunk(job.bytes, USB_CHUNK)) {
            if (signal.aborted) break;
            const res = await dev.transferOut(target.endpoint, piece);
            if (res.status !== 'ok') settleAs('failed', `USB transfer ended with status "${res.status}".`);
          }
          release();
          return { evidence: 'bytes-accepted', detail: 'Bytes accepted by the USB endpoint.' };
      }
    },
  };
}
