/**
 * Every transport against mocked Web Bluetooth / WebUSB / Web Serial / intent /
 * print-dialog APIs. The two promises under test, for each of them:
 *
 *   1. print() NEVER REJECTS — a throwing API is a value, not an exception.
 *   2. print() NEVER HANGS — an API that never answers settles as 'timeout'.
 *
 * plus the transport-specific behaviour: chunking, persistent permission
 * (getDevices) with no chooser, reconnect, disconnect mid-print, and a missing
 * API reported as unsupported instead of thrown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleDoc } from './helpers/receipt-fixtures';
import { createAndroidBridgeTransport, buildBridgeUrl } from '../src/printing/transports/android-bridge';
import { BLE_MIN_CHUNK, KNOWN_PRINTER_GATT, createBleTransport, type BleCharacteristicLike, type BleDeviceLike } from '../src/printing/transports/ble';
import { createNoneTransport } from '../src/printing/transports/none';
import { createSystemPrintTransport } from '../src/printing/transports/system-print';
import {
  chunk,
  guardedPrint,
  type PrintJob,
  type RememberedDevice,
  type TransportDeps,
  type TransportTuning,
} from '../src/printing/transports/types';
import { createWebSerialTransport, type SerialPortLike } from '../src/printing/transports/webserial';
import { createWebUsbTransport, type UsbDeviceLike } from '../src/printing/transports/webusb';
import { fromBase64 } from '../src/printing/escpos';
import { detectSupport, type TransportEnvs } from '../src/printing/transports/registry';

const TUNING: TransportTuning = {
  chunkBytes: 100,
  chunkDelayMs: 0,
  baudRate: 9600,
  bridgePackage: 'pkg.example.print',
  paperWidthMm: 58,
  systemLayout: 'roll',
  device: null,
};

function makeDeps(over: Partial<TransportTuning> = {}): {
  deps: TransportDeps;
  remembered: { id: string; device: RememberedDevice | null }[];
  tuning: TransportTuning;
} {
  const remembered: { id: string; device: RememberedDevice | null }[] = [];
  const tuning = { ...TUNING, ...over };
  const deps: TransportDeps = {
    tuning: () => tuning,
    remember: (id, device) => remembered.push({ id, device }),
    now: () => Date.now(),
  };
  return { deps, remembered, tuning };
}

function job(size = 250): PrintJob {
  return { doc: sampleDoc(), bytes: Uint8Array.from({ length: size }, (_, i) => i % 256), isCopy: false };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
describe('guardedPrint — the never-reject, never-hang contract', () => {
  it('settles as timeout when the work never settles, within the limit', async () => {
    const p = guardedPrint('none', 12_000, 0, { now: () => Date.now() }, () => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(12_000);
    const attempt = await p;
    expect(attempt.outcome).toBe('timeout');
    expect(attempt.durationMs).toBeGreaterThanOrEqual(12_000);
    expect(attempt.durationMs).toBeLessThan(12_100);
  });

  it('turns a throw (sync or async) into a failed value, never a rejection', async () => {
    const sync = await guardedPrint('none', 1000, 0, { now: () => 0 }, () => {
      throw new Error('boom');
    });
    expect(sync.outcome).toBe('failed');
    expect(sync.detail).toBe('boom');
    const async_ = await guardedPrint('none', 1000, 0, { now: () => 0 }, () => Promise.reject(new Error('later')));
    expect(async_.outcome).toBe('failed');
  });

  it('aborts the work and runs the teardown on timeout, and a teardown that throws changes nothing', async () => {
    let aborted = false;
    const p = guardedPrint(
      'none',
      500,
      0,
      { now: () => Date.now() },
      (signal) => {
        signal.addEventListener('abort', () => (aborted = true));
        return new Promise(() => undefined);
      },
      () => {
        throw new Error('teardown failed');
      },
    );
    await vi.advanceTimersByTimeAsync(500);
    expect((await p).outcome).toBe('timeout');
    expect(aborted).toBe(true);
  });

  it('maps browser errors to outcomes a person can act on', async () => {
    const mk = (name: string) => Object.assign(new Error('x'), { name });
    const a = await guardedPrint('none', 1000, 0, { now: () => 0 }, () => Promise.reject(mk('NotFoundError')));
    const b = await guardedPrint('none', 1000, 0, { now: () => 0 }, () => Promise.reject(mk('SecurityError')));
    expect(a.outcome).toBe('needs-pairing');
    expect(b.outcome).toBe('needs-pairing');
  });

  it('falls back to the default limit for a nonsense timeout instead of hanging forever', async () => {
    const p = guardedPrint('none', Number.NaN, 0, { now: () => Date.now() }, () => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await p).outcome).toBe('timeout');
  });

  it('chunk() splits exactly and never returns an empty chunk', () => {
    const parts = chunk(Uint8Array.from({ length: 250 }), 100);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(chunk(new Uint8Array(0), 100)).toEqual([]);
    expect(chunk(Uint8Array.from({ length: 3 }), 0).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('ble-escpos', () => {
  interface Rig {
    writes: Uint8Array[];
    device: BleDeviceLike;
    disconnect: () => void;
    connectCalls: number;
    char: BleCharacteristicLike;
    setHang: (h: boolean) => void;
  }

  function rig(opts: { writeMode?: 'ok' | 'hang' | 'hang-then-drop' | 'reject-long' } = {}): Rig {
    const writes: Uint8Array[] = [];
    let hang = opts.writeMode === 'hang' || opts.writeMode === 'hang-then-drop';
    const listeners = new Set<() => void>();
    const state = { connected: false, connectCalls: 0 };
    const char: BleCharacteristicLike = {
      uuid: KNOWN_PRINTER_GATT[0]!.characteristic!,
      properties: { write: true, writeWithoutResponse: true },
      writeValue: () => Promise.resolve(),
      writeValueWithoutResponse: (v) => {
        if (opts.writeMode === 'reject-long' && v.length > BLE_MIN_CHUNK) {
          return Promise.reject(new Error('GATT operation failed: invalid attribute length'));
        }
        if (hang) return new Promise<void>(() => undefined);
        writes.push(Uint8Array.from(v));
        return Promise.resolve();
      },
    };
    const device: BleDeviceLike = {
      id: 'dev-1',
      name: 'Test Printer',
      gatt: {
        get connected() {
          return state.connected;
        },
        connect: () => {
          state.connected = true;
          state.connectCalls += 1;
          return Promise.resolve({
            getPrimaryServices: () =>
              Promise.resolve([{ uuid: KNOWN_PRINTER_GATT[0]!.service, getCharacteristics: () => Promise.resolve([char]) }]),
          });
        },
        disconnect: () => {
          state.connected = false;
        },
      },
      addEventListener: (_t, l) => listeners.add(l),
      removeEventListener: (_t, l) => listeners.delete(l),
    };
    return {
      writes,
      device,
      char,
      get connectCalls() {
        return state.connectCalls;
      },
      disconnect: () => {
        state.connected = false;
        for (const l of listeners) l();
      },
      setHang: (h) => {
        hang = h;
      },
    };
  }

  it('without a granted printer it asks for pairing and never opens a chooser by itself', async () => {
    const r = rig();
    const requestDevice = vi.fn(() => Promise.resolve(r.device));
    const { deps } = makeDeps();
    const t = createBleTransport(deps, { bluetooth: () => ({ requestDevice, getDevices: () => Promise.resolve([]) }) });
    const attempt = await t.print(job());
    expect(attempt.outcome).toBe('needs-pairing');
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it('pair() (a user gesture) chooses and remembers the printer; print() then sends every byte in MTU-sized chunks', async () => {
    const r = rig();
    const { deps, remembered } = makeDeps();
    const t = createBleTransport(deps, {
      bluetooth: () => ({ requestDevice: () => Promise.resolve(r.device), getDevices: () => Promise.resolve([r.device]) }),
    });
    const pair = await t.pair!();
    expect(pair.ok).toBe(true);
    expect(remembered.at(-1)).toEqual({ id: 'ble-escpos', device: { id: 'dev-1', name: 'Test Printer' } });
    const j = job(250);
    const attempt = await t.print(j);
    expect(attempt.outcome).toBe('sent');
    expect(attempt.evidence).toBe('bytes-accepted');
    expect(r.writes.map((w) => w.length)).toEqual([100, 100, 50]);
    expect(Uint8Array.from(r.writes.flatMap((w) => [...w]))).toEqual(j.bytes);
  });

  it('uses getDevices() for persistent permission after a restart: no chooser, and it reconnects', async () => {
    const r = rig();
    const requestDevice = vi.fn();
    const { deps } = makeDeps({ device: { id: 'dev-1', name: 'Test Printer' } });
    const t = createBleTransport(deps, {
      bluetooth: () => ({ requestDevice, getDevices: () => Promise.resolve([r.device]) }),
    });
    expect((await t.print(job())).outcome).toBe('sent');
    r.disconnect(); // printer power-cycled
    expect((await t.print(job())).outcome).toBe('sent');
    expect(r.connectCalls).toBe(2);
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it('a write that never completes settles as timeout, and the stale link is torn down', async () => {
    const r = rig({ writeMode: 'hang' });
    const { deps } = makeDeps({ device: { id: 'dev-1', name: 'P' } });
    const t = createBleTransport(deps, { bluetooth: () => ({ requestDevice: vi.fn(), getDevices: () => Promise.resolve([r.device]) }) });
    const p = t.print(job(), 12_000);
    await vi.advanceTimersByTimeAsync(12_000);
    const attempt = await p;
    expect(attempt.outcome).toBe('timeout');
    expect(r.device.gatt!.connected).toBe(false);
    // The next receipt starts clean: reconnects and goes through.
    r.setHang(false);
    expect((await t.print(job())).outcome).toBe('sent');
  });

  it('a disconnect in the middle of a print fails fast with the printer-link message (not a hang)', async () => {
    const r = rig({ writeMode: 'hang-then-drop' });
    const { deps } = makeDeps({ device: { id: 'dev-1', name: 'P' } });
    const t = createBleTransport(deps, { bluetooth: () => ({ requestDevice: vi.fn(), getDevices: () => Promise.resolve([r.device]) }) });
    const p = t.print(job(), 12_000);
    await vi.advanceTimersByTimeAsync(50);
    r.disconnect();
    const attempt = await p;
    expect(attempt.outcome).toBe('failed');
    expect(attempt.detail).toMatch(/link dropped/i);
    expect(attempt.durationMs).toBeLessThan(1000);
  });

  it('falls back to the 20-byte floor when the stack rejects a larger write, and remembers it', async () => {
    const r = rig({ writeMode: 'reject-long' });
    const { deps } = makeDeps({ device: { id: 'dev-1', name: 'P' } });
    const t = createBleTransport(deps, { bluetooth: () => ({ requestDevice: vi.fn(), getDevices: () => Promise.resolve([r.device]) }) });
    const first = await t.print(job(60));
    expect(first.outcome).toBe('sent');
    expect(r.writes.every((w) => w.length <= BLE_MIN_CHUNK)).toBe(true);
    r.writes.length = 0;
    await t.print(job(60));
    expect(r.writes.every((w) => w.length <= BLE_MIN_CHUNK)).toBe(true);
  });

  it('reports a missing API as unsupported/unavailable, never as a throw', async () => {
    const { deps } = makeDeps();
    const t = createBleTransport(deps, { bluetooth: () => undefined });
    expect((await t.probe()).state).toBe('unsupported');
    expect((await t.print(job())).outcome).toBe('needs-pairing');
    expect((await t.pair!()).ok).toBe(false);
  });

  it('says plainly when the browser cannot remember a printer (no getDevices)', async () => {
    const r = rig();
    const { deps } = makeDeps();
    const t = createBleTransport(deps, { bluetooth: () => ({ requestDevice: () => Promise.resolve(r.device) }) });
    const health = await t.probe();
    expect(health.state).toBe('needs-pairing');
    expect(health.detail).toMatch(/not remembered/i);
  });

  it('notifies when the link drops', async () => {
    const r = rig();
    const { deps } = makeDeps({ device: { id: 'dev-1', name: 'P' } });
    const t = createBleTransport(deps, { bluetooth: () => ({ requestDevice: vi.fn(), getDevices: () => Promise.resolve([r.device]) }) });
    const events: boolean[] = [];
    t.onLinkChange!((up) => events.push(up));
    await t.print(job());
    r.disconnect();
    expect(events).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
describe('webusb-escpos', () => {
  function usbDevice(mode: 'ok' | 'hang' | 'status-error' | 'throw' = 'ok'): { dev: UsbDeviceLike; sent: Uint8Array[]; log: string[] } {
    const sent: Uint8Array[] = [];
    const log: string[] = [];
    const dev: UsbDeviceLike = {
      vendorId: 0x0416,
      productId: 0x5011,
      productName: 'USB Printer',
      opened: false,
      configuration: { interfaces: [{ interfaceNumber: 0, alternates: [{ interfaceClass: 7, endpoints: [{ endpointNumber: 1, direction: 'out' }] }] }] },
      open: () => {
        log.push('open');
        return Promise.resolve();
      },
      close: () => {
        log.push('close');
        return Promise.resolve();
      },
      selectConfiguration: () => Promise.resolve(),
      claimInterface: () => {
        log.push('claim');
        return Promise.resolve();
      },
      releaseInterface: () => {
        log.push('release');
        return Promise.resolve();
      },
      transferOut: (_e, data) => {
        if (mode === 'hang') return new Promise(() => undefined);
        if (mode === 'throw') return Promise.reject(Object.assign(new Error('device unplugged'), { name: 'NetworkError' }));
        sent.push(Uint8Array.from(data));
        return Promise.resolve({ status: mode === 'status-error' ? 'stall' : 'ok' });
      },
    };
    return { dev, sent, log };
  }
  const key = '416:5011';

  it('uses a previously granted device with no chooser, sends all bytes, and releases the interface', async () => {
    const { dev, sent, log } = usbDevice();
    const requestDevice = vi.fn();
    const { deps } = makeDeps({ device: { id: key, name: 'USB Printer' } });
    const t = createWebUsbTransport(deps, { usb: () => ({ getDevices: () => Promise.resolve([dev]), requestDevice }) });
    const j = job(5000);
    const attempt = await t.print(j);
    expect(attempt.outcome).toBe('sent');
    expect(Uint8Array.from(sent.flatMap((s) => [...s]))).toEqual(j.bytes);
    expect(log).toContain('release');
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it('a transfer that never completes times out, and the interface is released', async () => {
    const { dev, log } = usbDevice('hang');
    const { deps } = makeDeps({ device: { id: key, name: 'U' } });
    const t = createWebUsbTransport(deps, { usb: () => ({ getDevices: () => Promise.resolve([dev]), requestDevice: vi.fn() }) });
    const p = t.print(job(), 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).outcome).toBe('timeout');
    expect(log).toContain('release');
  });

  it('a stalled endpoint and an unplugged device are failures, not exceptions', async () => {
    for (const mode of ['status-error', 'throw'] as const) {
      const { dev } = usbDevice(mode);
      const { deps } = makeDeps({ device: { id: key, name: 'U' } });
      const t = createWebUsbTransport(deps, { usb: () => ({ getDevices: () => Promise.resolve([dev]), requestDevice: vi.fn() }) });
      expect((await t.print(job())).outcome).toBe('failed');
    }
  });

  it('is unsupported without WebUSB and asks for pairing without a chosen printer', async () => {
    const { deps } = makeDeps();
    expect((await createWebUsbTransport(deps, { usb: () => undefined }).probe()).state).toBe('unsupported');
    const t = createWebUsbTransport(deps, { usb: () => ({ getDevices: () => Promise.resolve([]), requestDevice: vi.fn() }) });
    expect((await t.print(job())).outcome).toBe('needs-pairing');
  });
});

// ---------------------------------------------------------------------------
describe('web-serial', () => {
  function port(mode: 'ok' | 'hang' | 'throw' = 'ok'): { p: SerialPortLike; written: Uint8Array[]; log: string[] } {
    const written: Uint8Array[] = [];
    const log: string[] = [];
    const p: SerialPortLike = {
      open: () => {
        log.push('open');
        return Promise.resolve();
      },
      close: () => {
        log.push('close');
        return Promise.resolve();
      },
      writable: {
        getWriter: () => ({
          write: (c) => {
            if (mode === 'hang') return new Promise<void>(() => undefined);
            if (mode === 'throw') return Promise.reject(new Error('port lost'));
            written.push(Uint8Array.from(c));
            return Promise.resolve();
          },
          releaseLock: () => log.push('release'),
          abort: () => {
            log.push('abort');
            return Promise.resolve();
          },
        }),
      },
      getInfo: () => ({ usbVendorId: 1, usbProductId: 2 }),
    };
    return { p, written, log };
  }

  it('opens the granted port, writes everything, closes it (so the next receipt starts clean)', async () => {
    const { p, written, log } = port();
    const { deps } = makeDeps({ device: { id: JSON.stringify([1, 2, null]), name: 'S' } });
    const t = createWebSerialTransport(deps, { serial: () => ({ requestPort: vi.fn(), getPorts: () => Promise.resolve([p]) }) });
    const j = job();
    expect((await t.print(j)).outcome).toBe('sent');
    expect(written[0]).toEqual(j.bytes);
    expect(log).toEqual(['open', 'release', 'close']);
  });

  it('a hung write times out and the port is aborted and closed', async () => {
    const { p, log } = port('hang');
    const { deps } = makeDeps({ device: { id: JSON.stringify([1, 2, null]), name: 'S' } });
    const t = createWebSerialTransport(deps, { serial: () => ({ requestPort: vi.fn(), getPorts: () => Promise.resolve([p]) }) });
    const pr = t.print(job(), 3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pr).outcome).toBe('timeout');
    await vi.advanceTimersByTimeAsync(10);
    expect(log).toContain('abort');
    expect(log).toContain('close');
  });

  it('a write failure closes the port and reports failed', async () => {
    const { p, log } = port('throw');
    const { deps } = makeDeps({ device: { id: JSON.stringify([1, 2, null]), name: 'S' } });
    const t = createWebSerialTransport(deps, { serial: () => ({ requestPort: vi.fn(), getPorts: () => Promise.resolve([p]) }) });
    const a = await t.print(job());
    expect(a.outcome).toBe('failed');
    await vi.advanceTimersByTimeAsync(10);
    expect(log).toContain('close');
  });

  it('is unsupported without Web Serial (a tablet) and says where to go instead', async () => {
    const { deps } = makeDeps();
    const t = createWebSerialTransport(deps, { serial: () => undefined });
    const h = await t.probe();
    expect(h.state).toBe('unsupported');
    expect((await t.print(job())).outcome).toBe('needs-pairing');
  });
});

// ---------------------------------------------------------------------------
describe('android-print-bridge', () => {
  const ANDROID = 'Mozilla/5.0 (Linux; Android 12; Tablet) Chrome/120';

  it('hands the exact bytes to the configured print app as an intent URL, and says only "handed off"', async () => {
    const opened: string[] = [];
    const { deps } = makeDeps();
    const t = createAndroidBridgeTransport(deps, { userAgent: () => ANDROID, open: (u) => opened.push(u) });
    const j = job(300);
    const attempt = await t.print(j);
    expect(attempt.outcome).toBe('sent');
    expect(attempt.evidence).toBe('handed-off');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toBe(buildBridgeUrl(j.bytes, 'pkg.example.print'));
    expect(opened[0]).toMatch(/^intent:base64,.+#Intent;scheme=rawbt;package=pkg\.example\.print;end;$/);
    const b64 = opened[0]!.slice('intent:base64,'.length, opened[0]!.indexOf('#Intent'));
    expect(fromBase64(b64)).toEqual(j.bytes);
  });

  it('never splices an edited package name into the intent: anything but an app id falls back to the default', () => {
    const bytes = new Uint8Array([0x1b, 0x40]);
    // A value that would add a browser fallback and redirect the till away from the PWA.
    const hostile = 'pkg.example;S.browser_fallback_url=https%3A%2F%2Fevil.example;end';
    const url = buildBridgeUrl(bytes, hostile);
    expect(url).not.toContain('browser_fallback_url');
    expect(url).toMatch(/;package=ru\.a402d\.rawbtprinter;end;$/);
    // Positive control: a real app id is used as given.
    expect(buildBridgeUrl(bytes, 'com.example.print_app')).toMatch(/;package=com\.example\.print_app;end;$/);
    for (const bad of ['', 'nodots', '1pkg.x', 'pkg..x', 'pkg.x;end']) {
      expect(buildBridgeUrl(bytes, bad)).toMatch(/;package=ru\.a402d\.rawbtprinter;end;$/);
    }
  });

  it('is unavailable off Android, and a throwing navigation is a failed value', async () => {
    const { deps } = makeDeps();
    const desktop = createAndroidBridgeTransport(deps, { userAgent: () => 'Windows NT 10', open: () => undefined });
    expect((await desktop.print(job())).outcome).toBe('unavailable');
    expect((await desktop.probe()).state).toBe('unsupported');
    const throwing = createAndroidBridgeTransport(deps, {
      userAgent: () => ANDROID,
      open: () => {
        throw new Error('blocked');
      },
    });
    expect((await throwing.print(job())).outcome).toBe('failed');
  });

  it('cannot detect the app, and says so', async () => {
    const { deps } = makeDeps();
    const t = createAndroidBridgeTransport(deps, { userAgent: () => ANDROID, open: () => undefined });
    const h = await t.probe();
    expect(h.state).toBe('unknown');
    expect(h.detail).toMatch(/cannot detect/i);
  });
});

// ---------------------------------------------------------------------------
describe('system-print and none', () => {
  it('system-print renders the document at the configured layout and reports only that the dialog closed', async () => {
    const printed: string[] = [];
    const { deps } = makeDeps({ systemLayout: 'a4' });
    const t = createSystemPrintTransport(deps, { available: () => true, printHtml: (h) => (printed.push(h), Promise.resolve()) });
    const a = await t.print(job());
    expect(a.outcome).toBe('sent');
    expect(a.evidence).toBe('dialog-closed');
    expect(printed[0]).toMatch(/size: A4/);
    expect(printed[0]).toContain('R-0042');
  });

  it('system-print uses a roll layout at the paper width, and a hung dialog still settles', async () => {
    const printed: string[] = [];
    const { deps } = makeDeps({ paperWidthMm: 80 });
    const t = createSystemPrintTransport(deps, { available: () => true, printHtml: (h) => (printed.push(h), Promise.resolve()) });
    await t.print(job());
    expect(printed[0]).toMatch(/size: 80mm auto/);
    const hung = createSystemPrintTransport(deps, { available: () => true, printHtml: () => new Promise(() => undefined) });
    const p = hung.print(job(), 4000);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await p).outcome).toBe('timeout');
  });

  it('system-print is unavailable where there is no print dialog', async () => {
    const { deps } = makeDeps();
    const t = createSystemPrintTransport(deps, { available: () => false, printHtml: () => Promise.resolve() });
    expect((await t.print(job())).outcome).toBe('unavailable');
    expect((await t.probe()).state).toBe('unsupported');
  });

  it('none always works and reports "shown", never "sent"', async () => {
    const { deps } = makeDeps();
    const a = await createNoneTransport(deps).print(job());
    expect(a.outcome).toBe('shown');
    expect(a.evidence).toBe('shown');
  });
});

describe('feature detection', () => {
  it('never throws when every browser API is missing or throws', () => {
    const throwing = (): never => {
      throw new Error('no');
    };
    const envs: TransportEnvs = {
      ble: { bluetooth: throwing },
      usb: { usb: throwing },
      serial: { serial: () => undefined },
      bridge: { userAgent: throwing, open: () => undefined },
      system: { available: throwing, printHtml: () => Promise.resolve() },
    };
    const support = detectSupport(envs);
    expect(support['ble-escpos'].supported).toBe(false);
    expect(support['web-serial'].supported).toBe(false);
    expect(support['android-print-bridge'].supported).toBe(false);
    expect(support.none.supported).toBe(true);
  });
});
