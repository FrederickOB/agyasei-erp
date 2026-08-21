/**
 * Device-local configuration records. Presentation reads configuration —
 * currency symbol and minor-unit scale come from the tenant's jurisdiction
 * pack via config, NEVER from a constant in a component (§8.9, ADR-0007).
 */
import { assertCurrencySpec, type CurrencySpec } from '@erp/money';
import { randomDeviceNode } from '../../lib/hlc';
import { uuidv7 } from '../../lib/uuidv7';
import type { LocalDb } from '../db';

export const CONFIG_KEY_CURRENCY_SPEC = 'currency_spec';
export const CONFIG_KEY_DEVICE_NODE = 'device_hlc_node';

async function readConfigValue(db: LocalDb, key: string): Promise<string | null> {
  const rows = await db.getAll('SELECT value FROM local_config WHERE key = ? LIMIT 1', [key]);
  const value = rows[0]?.['value'];
  return typeof value === 'string' ? value : null;
}

/**
 * The CurrencySpec this device displays money with. `null` until the tenant's
 * configuration has arrived (or the dev seed has run) — callers must render a
 * provisioning state, never fall back to a hard-coded symbol.
 */
export async function readCurrencySpec(db: LocalDb): Promise<CurrencySpec | null> {
  const raw = await readConfigValue(db, CONFIG_KEY_CURRENCY_SPEC);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  assertCurrencySpec(parsed as CurrencySpec);
  return parsed as CurrencySpec;
}

export async function writeCurrencySpec(db: LocalDb, spec: CurrencySpec): Promise<void> {
  assertCurrencySpec(spec);
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM local_config WHERE key = ?', [CONFIG_KEY_CURRENCY_SPEC]);
    await tx.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
      uuidv7(),
      CONFIG_KEY_CURRENCY_SPEC,
      JSON.stringify(spec),
    ]);
  });
  db.changes.notify();
}

/** The device's stable 32-hex HLC node id, created on first use. */
export async function getOrCreateDeviceNode(db: LocalDb): Promise<string> {
  const existing = await readConfigValue(db, CONFIG_KEY_DEVICE_NODE);
  if (existing !== null) return existing;
  const node = randomDeviceNode();
  await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
    uuidv7(),
    CONFIG_KEY_DEVICE_NODE,
    node,
  ]);
  return node;
}
