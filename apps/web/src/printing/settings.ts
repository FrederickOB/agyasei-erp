/**
 * Per-device printer settings, kept in the device-local `local_config` table.
 *
 * Per DEVICE, not per user and not synced: the printer sitting beside this
 * tablet is a fact about this tablet. Every field is read defensively — a
 * settings blob written by an older build, or hand-edited, degrades to the safe
 * default rather than throwing on the counter's start path.
 *
 * The default transport is `none`: until someone chooses a printer, the receipt
 * is shown on screen. That is the only default that is always true.
 */
import type { LocalDb } from '../data/db';
import { uuidv7 } from '../lib/uuidv7';
import type { CodePageId } from './codepage';
import type { CutMode, DrawerKick } from './escpos';
import { DEFAULT_DRAWER_KICK } from './escpos';
import { DEFAULT_BRIDGE_PACKAGE, isAndroidPackageName } from './transports/android-bridge';
import {
  ALL_TRANSPORT_IDS,
  DEFAULT_PRINT_TIMEOUT_MS,
  type RememberedDevice,
  type TransportId,
  type TransportTuning,
} from './transports/types';

export const CONFIG_KEY_PRINTER_SETTINGS = 'printer_settings';

export interface PrinterSettings {
  readonly transport: TransportId;
  readonly paperWidthMm: 58 | 80;
  readonly codePage: CodePageId;
  readonly cut: CutMode;
  /** Open the cash drawer on the ORIGINAL print of each sale (never on a reprint). */
  readonly kickDrawer: boolean;
  readonly drawerKick: DrawerKick;
  /** Print as soon as the sale is committed, without a tap. */
  readonly autoPrint: boolean;
  readonly timeoutMs: number;
  readonly chunkBytes: number;
  readonly chunkDelayMs: number;
  readonly baudRate: number;
  readonly bridgePackage: string;
  readonly systemLayout: 'roll' | 'a4';
  /** The remembered printer per transport. */
  readonly devices: Readonly<Partial<Record<TransportId, RememberedDevice>>>;
}

export const DEFAULT_PRINTER_SETTINGS: PrinterSettings = {
  transport: 'none',
  paperWidthMm: 58,
  codePage: 'cp437',
  cut: 'partial',
  kickDrawer: false,
  drawerKick: DEFAULT_DRAWER_KICK,
  autoPrint: true,
  timeoutMs: DEFAULT_PRINT_TIMEOUT_MS,
  chunkBytes: 100,
  chunkDelayMs: 20,
  baudRate: 9600,
  bridgePackage: DEFAULT_BRIDGE_PACKAGE,
  systemLayout: 'roll',
  devices: {},
};

function int(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;
}

/** Turn anything into valid settings. Exported for tests. */
export function sanitizeSettings(raw: unknown): PrinterSettings {
  const d = DEFAULT_PRINTER_SETTINGS;
  if (typeof raw !== 'object' || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const devices: Partial<Record<TransportId, RememberedDevice>> = {};
  if (typeof r['devices'] === 'object' && r['devices'] !== null) {
    for (const id of ALL_TRANSPORT_IDS) {
      const dev = (r['devices'] as Record<string, unknown>)[id];
      if (typeof dev === 'object' && dev !== null && typeof (dev as { id?: unknown }).id === 'string') {
        const name = (dev as { name?: unknown }).name;
        devices[id] = { id: (dev as { id: string }).id, name: typeof name === 'string' ? name : null };
      }
    }
  }
  const kick = r['drawerKick'] as Partial<DrawerKick> | undefined;
  return {
    transport: ALL_TRANSPORT_IDS.includes(r['transport'] as TransportId) ? (r['transport'] as TransportId) : d.transport,
    paperWidthMm: r['paperWidthMm'] === 80 ? 80 : 58,
    codePage: r['codePage'] === 'ascii' ? 'ascii' : 'cp437',
    cut: r['cut'] === 'none' || r['cut'] === 'full' ? r['cut'] : 'partial',
    kickDrawer: r['kickDrawer'] === true,
    drawerKick: {
      pin: kick?.pin === 1 ? 1 : 0,
      onUnits: int(kick?.onUnits, d.drawerKick.onUnits, 0, 255),
      offUnits: int(kick?.offUnits, d.drawerKick.offUnits, 0, 255),
    },
    autoPrint: r['autoPrint'] !== false,
    timeoutMs: int(r['timeoutMs'], d.timeoutMs, 1000, 60_000),
    chunkBytes: int(r['chunkBytes'], d.chunkBytes, 20, 512),
    chunkDelayMs: int(r['chunkDelayMs'], d.chunkDelayMs, 0, 500),
    baudRate: int(r['baudRate'], d.baudRate, 1200, 921_600),
    bridgePackage:
      typeof r['bridgePackage'] === 'string' && isAndroidPackageName(r['bridgePackage'])
        ? r['bridgePackage']
        : d.bridgePackage,
    systemLayout: r['systemLayout'] === 'a4' ? 'a4' : 'roll',
    devices,
  };
}

export async function readPrinterSettings(db: LocalDb): Promise<PrinterSettings> {
  try {
    const rows = await db.getAll('SELECT value FROM local_config WHERE key = ? LIMIT 1', [CONFIG_KEY_PRINTER_SETTINGS]);
    const value = rows[0]?.['value'];
    return typeof value === 'string' ? sanitizeSettings(JSON.parse(value)) : DEFAULT_PRINTER_SETTINGS;
  } catch {
    return DEFAULT_PRINTER_SETTINGS;
  }
}

export async function writePrinterSettings(db: LocalDb, settings: PrinterSettings): Promise<void> {
  const clean = sanitizeSettings(settings);
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM local_config WHERE key = ?', [CONFIG_KEY_PRINTER_SETTINGS]);
    await tx.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
      uuidv7(),
      CONFIG_KEY_PRINTER_SETTINGS,
      JSON.stringify(clean),
    ]);
  });
  db.changes.notify();
}

/** What transports read, derived from the settings and the transport they serve. */
export function tuningFor(settings: PrinterSettings, transport: TransportId): TransportTuning {
  return {
    chunkBytes: settings.chunkBytes,
    chunkDelayMs: settings.chunkDelayMs,
    baudRate: settings.baudRate,
    bridgePackage: settings.bridgePackage,
    paperWidthMm: settings.paperWidthMm,
    systemLayout: settings.systemLayout,
    device: settings.devices[transport] ?? null,
  };
}
