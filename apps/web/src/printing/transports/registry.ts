/**
 * Builds the set of transports for a device and feature-detects each one.
 * Detection NEVER throws on a missing API: an absent `navigator.bluetooth` is a
 * normal answer ("unsupported, and here is why"), not an error.
 */
import type { PrinterSettings } from '../settings';
import { tuningFor } from '../settings';
import { createAndroidBridgeTransport, defaultBridgeEnv, type BridgeEnv } from './android-bridge';
import { createBleTransport, defaultBleEnv, type BleEnv } from './ble';
import { createNoneTransport } from './none';
import { createSystemPrintTransport, defaultSystemPrintEnv, type SystemPrintEnv } from './system-print';
import type { ReceiptTransport, RememberedDevice, TransportDeps, TransportId } from './types';
import { createWebSerialTransport, defaultSerialEnv, type SerialEnv } from './webserial';
import { createWebUsbTransport, defaultUsbEnv, type UsbEnv } from './webusb';

export interface TransportEnvs {
  readonly ble: BleEnv;
  readonly usb: UsbEnv;
  readonly serial: SerialEnv;
  readonly bridge: BridgeEnv;
  readonly system: SystemPrintEnv;
}

export function defaultTransportEnvs(): TransportEnvs {
  return {
    ble: defaultBleEnv(),
    usb: defaultUsbEnv(),
    serial: defaultSerialEnv(),
    bridge: defaultBridgeEnv(),
    system: defaultSystemPrintEnv(),
  };
}

export interface TransportSupport {
  readonly supported: boolean;
  /** One plain sentence. */
  readonly reason: string;
}

export function detectSupport(envs: TransportEnvs): Readonly<Record<TransportId, TransportSupport>> {
  const safe = (f: () => boolean): boolean => {
    try {
      return f();
    } catch {
      return false;
    }
  };
  const android = safe(() => /Android/i.test(envs.bridge.userAgent()));
  const ble = safe(() => envs.ble.bluetooth() !== undefined);
  const usb = safe(() => envs.usb.usb() !== undefined);
  const serial = safe(() => envs.serial.serial() !== undefined);
  const system = safe(() => envs.system.available());
  return {
    'ble-escpos': {
      supported: ble,
      reason: ble ? 'Bluetooth LE printers only (not classic/SPP).' : 'This browser has no Web Bluetooth.',
    },
    'webusb-escpos': {
      supported: usb,
      reason: usb ? 'USB printer, needs a free USB port (OTG on a tablet).' : 'This browser has no WebUSB.',
    },
    'web-serial': {
      supported: serial,
      reason: serial
        ? 'Paired Bluetooth-classic or USB-serial printers shown as ports.'
        : 'Needs desktop Chrome or Edge.',
    },
    'android-print-bridge': {
      supported: android,
      reason: android
        ? 'Reaches classic Bluetooth and built-in printers through an installed print app.'
        : 'Android devices only.',
    },
    'system-print': {
      supported: system,
      reason: system ? 'Opens the device print dialog (A4 or roll).' : 'This browser cannot open a print dialog.',
    },
    none: { supported: true, reason: 'Always available. Shows the receipt on screen.' },
  };
}

export function createTransports(
  getSettings: () => PrinterSettings,
  remember: (transport: TransportId, device: RememberedDevice | null) => void,
  now: () => number,
  envs: TransportEnvs = defaultTransportEnvs(),
): Readonly<Record<TransportId, ReceiptTransport>> {
  const depsFor = (id: TransportId): TransportDeps => ({
    tuning: () => tuningFor(getSettings(), id),
    remember,
    now,
  });
  return {
    'ble-escpos': createBleTransport(depsFor('ble-escpos'), envs.ble),
    'webusb-escpos': createWebUsbTransport(depsFor('webusb-escpos'), envs.usb),
    'web-serial': createWebSerialTransport(depsFor('web-serial'), envs.serial),
    'android-print-bridge': createAndroidBridgeTransport(depsFor('android-print-bridge'), envs.bridge),
    'system-print': createSystemPrintTransport(depsFor('system-print'), envs.system),
    none: createNoneTransport(depsFor('none')),
  };
}
