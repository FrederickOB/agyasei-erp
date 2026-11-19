/**
 * `ble-escpos` — Web Bluetooth to a BLE GATT thermal printer.
 *
 * WHAT THIS CAN AND CANNOT REACH (§8.8 point 1). Web Bluetooth speaks BLE GATT
 * only. It cannot open a Bluetooth Classic RFCOMM/SPP socket, on any platform.
 * Most sub-$60 58 mm printers sold into West African markets are SPP-only; for
 * those this transport does not exist, and `web-serial` (laptop) or
 * `android-print-bridge` (tablet) is the route. Which printer the tenant buys is
 * the first thing the spike decides.
 *
 * PERSISTENT PERMISSION (§8.8 point 2). A chooser dialog per receipt is not a
 * POS. `navigator.bluetooth.getDevices()` returns devices the user granted
 * earlier, without a gesture. Where the build lacks it, `probe()` says so
 * plainly and print() reports 'needs-pairing' instead of popping a chooser it is
 * not allowed to pop. The chooser is only ever opened by `pair()`, which the
 * settings screen calls from a tap.
 *
 * NO BACK-CHANNEL (§8.8 point 4). Writes go out in MTU-sized chunks with no
 * acknowledgement from the printer. 'sent' means the GATT stack accepted every
 * chunk — never that paper came out.
 *
 * THE SERVICE LIST IS A STARTING POINT, NOT A PROMISE. These are the GATT
 * service/characteristic pairs commonly used by ESC/POS BLE printers and
 * "transparent UART" modules. A printer using another one will connect and then
 * report "no writable characteristic"; that finding goes into the spike matrix
 * and the UUID into this table.
 */
import {
  guardedPrint,
  settleAs,
  sleep,
  DEFAULT_PRINT_TIMEOUT_MS,
  type PairResult,
  type PrintAttempt,
  type PrintJob,
  type ReceiptTransport,
  type TransportDeps,
  type TransportHealth,
} from './types';

export const KNOWN_PRINTER_GATT: readonly { readonly service: string; readonly characteristic: string | null }[] = [
  // Common on generic ESC/POS BLE printers.
  { service: '000018f0-0000-1000-8000-00805f9b34fb', characteristic: '00002af1-0000-1000-8000-00805f9b34fb' },
  // Microchip/ISSC transparent UART, used by many Bluetooth printer modules.
  { service: '49535343-fe7d-4ae5-8fa9-9fafd205e455', characteristic: '49535343-8841-43f4-a8d4-ecbe34729bb3' },
  // HM-10 style serial modules.
  { service: '0000ffe0-0000-1000-8000-00805f9b34fb', characteristic: '0000ffe1-0000-1000-8000-00805f9b34fb' },
  // Vendor-specific UART seen on several portable printers.
  { service: '0000ff00-0000-1000-8000-00805f9b34fb', characteristic: '0000ff02-0000-1000-8000-00805f9b34fb' },
  { service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', characteristic: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f' },
];

/** Smallest write that works on every BLE link (default ATT MTU 23 minus 3 header bytes). */
export const BLE_MIN_CHUNK = 20;

// ---- the slice of Web Bluetooth this file touches (typed structurally; tests mock it) ----
export interface BleCharacteristicLike {
  readonly uuid: string;
  readonly properties: { readonly write: boolean; readonly writeWithoutResponse: boolean };
  writeValue(value: Uint8Array): Promise<void>;
  writeValueWithoutResponse?(value: Uint8Array): Promise<void>;
}
export interface BleServiceLike {
  readonly uuid: string;
  getCharacteristics(): Promise<BleCharacteristicLike[]>;
}
export interface BleServerLike {
  getPrimaryServices(): Promise<BleServiceLike[]>;
}
export interface BleGattLike {
  readonly connected: boolean;
  connect(): Promise<BleServerLike>;
  disconnect(): void;
}
export interface BleDeviceLike {
  readonly id: string;
  readonly name?: string | undefined;
  readonly gatt?: BleGattLike | undefined;
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void;
  removeEventListener(type: 'gattserverdisconnected', listener: () => void): void;
}
export interface BluetoothLike {
  requestDevice(options: {
    acceptAllDevices: true;
    optionalServices: string[];
  }): Promise<BleDeviceLike>;
  getDevices?(): Promise<BleDeviceLike[]>;
}

export interface BleEnv {
  readonly bluetooth: () => BluetoothLike | undefined;
}

export function defaultBleEnv(): BleEnv {
  return {
    bluetooth: () =>
      typeof navigator === 'undefined'
        ? undefined
        : (navigator as unknown as { bluetooth?: BluetoothLike }).bluetooth,
  };
}

function pickWritable(
  services: readonly BleServiceLike[],
): Promise<BleCharacteristicLike | null> {
  return (async () => {
    // Known pairs first, in table order, so a printer with several services
    // always resolves to the same one.
    for (const known of KNOWN_PRINTER_GATT) {
      const svc = services.find((s) => s.uuid.toLowerCase() === known.service);
      if (svc === undefined) continue;
      const chars = await svc.getCharacteristics();
      const exact = chars.find((c) => c.uuid.toLowerCase() === known.characteristic);
      const any = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
      const found = exact ?? any;
      if (found !== undefined) return found;
    }
    return null;
  })();
}

export function createBleTransport(deps: TransportDeps, env: BleEnv = defaultBleEnv()): ReceiptTransport {
  let device: BleDeviceLike | null = null;
  let characteristic: BleCharacteristicLike | null = null;
  // Learned the hard way: some stacks reject a 100-byte write; remember the
  // size that worked so the next receipt does not relearn it.
  let learnedChunk: number | null = null;
  const listeners = new Set<(up: boolean) => void>();
  let activeDisconnect: (() => void) | null = null;

  const emit = (up: boolean): void => {
    for (const l of listeners) {
      try {
        l(up);
      } catch {
        // a UI listener must not break the link
      }
    }
  };

  const onDisconnected = (): void => {
    characteristic = null;
    activeDisconnect?.();
    emit(false);
  };

  const adopt = (next: BleDeviceLike): void => {
    if (device !== null && device !== next) device.removeEventListener('gattserverdisconnected', onDisconnected);
    if (device !== next) next.addEventListener('gattserverdisconnected', onDisconnected);
    device = next;
    deps.remember('ble-escpos', { id: next.id, name: next.name ?? null });
  };

  /** A device we may use WITHOUT a gesture: the one in memory, else a previously granted one. */
  async function knownDevice(): Promise<BleDeviceLike | null> {
    if (device !== null) return device;
    const bt = env.bluetooth();
    const remembered = deps.tuning().device;
    if (bt?.getDevices === undefined || remembered === null) return null;
    const granted = await bt.getDevices();
    const match = granted.find((d) => d.id === remembered.id);
    if (match === undefined) return null;
    adopt(match);
    return match;
  }

  async function connect(): Promise<BleCharacteristicLike> {
    const dev = await knownDevice();
    if (dev === null) {
      settleAs(
        'needs-pairing',
        env.bluetooth()?.getDevices === undefined
          ? 'This browser cannot remember a Bluetooth printer. Choose it again.'
          : 'No printer is chosen yet. Open Printer settings and choose one.',
      );
    }
    const gatt = dev.gatt;
    if (gatt === undefined) settleAs('failed', 'This Bluetooth device exposes no GATT server.');
    if (characteristic !== null && gatt.connected) return characteristic;
    const server = await gatt.connect();
    const found = await pickWritable(await server.getPrimaryServices());
    if (found === null) {
      settleAs('failed', 'Connected, but found no writable printer characteristic. Note the model for the spike log.');
    }
    characteristic = found;
    emit(true);
    return found;
  }

  async function writeAll(
    ch: BleCharacteristicLike,
    bytes: Uint8Array,
    signal: AbortSignal,
    gone: Promise<never>,
  ): Promise<void> {
    const tuning = deps.tuning();
    let size = Math.max(BLE_MIN_CHUNK, learnedChunk ?? tuning.chunkBytes);
    let offset = 0;
    while (offset < bytes.length) {
      if (signal.aborted) return;
      const piece = bytes.subarray(offset, offset + size);
      try {
        const write =
          ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse !== undefined
            ? ch.writeValueWithoutResponse(piece)
            : ch.writeValue(piece);
        await Promise.race([write, gone]);
      } catch (err) {
        // A "too long" write above the floor: drop to the floor, once, and
        // remember it so the next receipt does not relearn it.
        if (size > BLE_MIN_CHUNK && /length|too long|invalid|size/i.test(String((err as Error)?.message))) {
          size = BLE_MIN_CHUNK;
          learnedChunk = BLE_MIN_CHUNK;
          continue;
        }
        throw err;
      }
      offset += piece.length;
      if (tuning.chunkDelayMs > 0) await sleep(tuning.chunkDelayMs, signal);
    }
  }

  return {
    id: 'ble-escpos',
    label: 'Bluetooth printer (BLE)',
    raw: true,

    async probe(options): Promise<TransportHealth> {
      try {
        const bt = env.bluetooth();
        if (bt === undefined) {
          return {
            state: 'unsupported',
            detail: 'This browser has no Web Bluetooth. Use the print-app or USB route instead.',
          };
        }
        if (bt.getDevices === undefined) {
          return {
            state: 'needs-pairing',
            detail: 'Printer choice is not remembered by this browser, so each receipt would need a chooser.',
          };
        }
        const dev = await knownDevice();
        if (dev === null) return { state: 'needs-pairing', detail: 'No printer chosen yet.' };
        if (options?.connect === true) {
          try {
            await connect();
          } catch {
            return { state: 'unreachable', detail: 'Printer is not in range or is off.', printerName: dev.name ?? null };
          }
        }
        const up = dev.gatt?.connected === true;
        return {
          state: up || options?.connect !== true ? 'ready' : 'unreachable',
          detail: up ? 'Connected.' : 'Chosen. Will connect when printing.',
          printerName: dev.name ?? null,
        };
      } catch (err) {
        return { state: 'unknown', detail: err instanceof Error ? err.message : 'Could not check Bluetooth.' };
      }
    },

    async pair(): Promise<PairResult> {
      try {
        const bt = env.bluetooth();
        if (bt === undefined) return { ok: false, detail: 'Web Bluetooth is not available here.', printerName: null };
        const picked = await bt.requestDevice({
          acceptAllDevices: true,
          optionalServices: [...new Set(KNOWN_PRINTER_GATT.map((k) => k.service))],
        });
        adopt(picked);
        characteristic = null;
        return { ok: true, detail: 'Printer chosen.', printerName: picked.name ?? null };
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
      try {
        device?.gatt?.disconnect();
        device?.removeEventListener('gattserverdisconnected', onDisconnected);
      } catch {
        // already gone
      }
      device = null;
      characteristic = null;
      deps.remember('ble-escpos', null);
    },

    onLinkChange(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    print(job: PrintJob, timeoutMs: number = DEFAULT_PRINT_TIMEOUT_MS): Promise<PrintAttempt> {
      return guardedPrint(
        'ble-escpos',
        timeoutMs,
        job.bytes.length,
        deps,
        async (signal) => {
          const gone = new Promise<never>((_, reject) => {
            activeDisconnect = () => reject(Object.assign(new Error('The printer disconnected mid-print.'), { name: 'NetworkError' }));
          });
          // Never leave an unhandled rejection if nothing is racing it.
          gone.catch(() => undefined);
          try {
            const ch = await Promise.race([connect(), gone]);
            await writeAll(ch, job.bytes, signal, gone);
            return { evidence: 'bytes-accepted', detail: 'Bytes accepted by the printer link.' };
          } finally {
            activeDisconnect = null;
          }
        },
        () => {
          // A link that stopped answering is torn down so the next attempt
          // reconnects from scratch instead of reusing a wedged handle.
          characteristic = null;
          device?.gatt?.disconnect();
        },
      );
    },
  };
}
