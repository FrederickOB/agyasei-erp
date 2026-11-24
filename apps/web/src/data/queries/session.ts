/**
 * The device's operating context — the answers a sale needs about WHERE it is
 * being rung, which the wire contract requires and which the counter used to
 * simply not know.
 *
 * Every value here is DATA, not a constant: the location id is provisioned at
 * enrolment into `local_config`; the location's code and timezone come from
 * the synced `location` row; the price list's code comes from the synced
 * `price_list` row; the receipt-number format is jurisdiction-pack + tenant
 * configuration (03 §3.7.5). No tenant's vocabulary appears in this file.
 *
 * `tenant_id` is deliberately absent and stays absent. It comes from the
 * verified token, server-side, on every write (CLAUDE.md §2.1) — the device
 * has no business asserting one.
 */
import {
  DEFAULT_RECEIPT_FORMAT,
  parseReceiptFormat,
  type ReceiptNumberFormat,
} from '../../lib/receipt-number';
import { uuidv7 } from '../../lib/uuidv7';
import type { DbExecutor, LocalDb } from '../db';

/** The location this device trades at. Provisioned at enrolment. */
export const CONFIG_KEY_LOCATION_ID = 'location_id';
/** Fallback location code, for a device provisioned before its rows synced. */
export const CONFIG_KEY_LOCATION_CODE = 'location_code';
/** The price list this counter sells from. Tenant data, provisioned per device. */
export const CONFIG_KEY_PRICE_LIST_ID = 'price_list_id';
/** The tenant's receipt-number format (JSON: {template,width,prefix}). */
export const CONFIG_KEY_RECEIPT_FORMAT = 'receipt_number_format';

export interface DeviceLocation {
  readonly id: string;
  /** The location's own code — printed on the receipt. */
  readonly code: string;
  /** The location's display name from the synced row; absent until it arrives. */
  readonly name?: string | null;
  /** IANA zone id from the synced row; null until it arrives. */
  readonly timeZone: string | null;
}

async function readConfig(db: DbExecutor, key: string): Promise<string | null> {
  const rows = await db.getAll('SELECT value FROM local_config WHERE key = ? LIMIT 1', [key]);
  const value = rows[0]?.['value'];
  return typeof value === 'string' ? value : null;
}

async function writeConfig(db: DbExecutor, key: string, value: string): Promise<void> {
  await db.execute('DELETE FROM local_config WHERE key = ?', [key]);
  await db.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
    uuidv7(),
    key,
    value,
  ]);
}

/**
 * Which location this device is. `null` means UNPROVISIONED — the caller must
 * refuse to record a sale and say so, never guess: a sale filed against the
 * wrong outlet moves stock and cash at a counter that never saw it.
 */
export async function readDeviceLocation(db: DbExecutor): Promise<DeviceLocation | null> {
  const id = await readConfig(db, CONFIG_KEY_LOCATION_ID);
  if (id === null) return null;

  const rows = await db.getAll('SELECT code, name, timezone FROM location WHERE id = ? LIMIT 1', [id]);
  const row = rows[0];
  const syncedCode = row?.['code'];
  const tz = row?.['timezone'];
  const syncedName = row?.['name'];
  const code =
    typeof syncedCode === 'string' && syncedCode.length > 0
      ? syncedCode
      : ((await readConfig(db, CONFIG_KEY_LOCATION_CODE)) ?? '');
  return {
    id,
    code,
    name: typeof syncedName === 'string' && syncedName.trim().length > 0 ? syncedName.trim() : null,
    timeZone: typeof tz === 'string' && tz.length > 0 ? tz : null,
  };
}

/**
 * The raw provisioned location id, with no lookup against the synced
 * `location` row. Enrolment needs to compare what is STORED against what the
 * session is scoped to, and it must be able to do that before the tenant's
 * rows have finished arriving — `readDeviceLocation` answers a different
 * question ("can this device name where it is?") and is the wrong tool for it.
 */
export async function readDeviceLocationId(db: DbExecutor): Promise<string | null> {
  return readConfig(db, CONFIG_KEY_LOCATION_ID);
}

export interface ProvisionLocationInput {
  readonly id: string;
  /** Only used until the synced `location` row arrives. */
  readonly code?: string;
}

/**
 * Enrolment: bind this device to a location.
 *
 * The code is rewritten in the SAME transaction as the id, always — including
 * being cleared when the caller cannot name one. A stored code that outlived
 * the id it belonged to is not a harmless leftover: `readDeviceLocation` uses
 * it as the fallback when the synced row has not arrived, so a device
 * re-bound to another location would print the previous location's code on
 * every receipt until sync caught up.
 */
export async function writeDeviceLocation(
  db: LocalDb,
  input: ProvisionLocationInput,
): Promise<void> {
  await db.writeTransaction(async (tx) => {
    await writeConfig(tx, CONFIG_KEY_LOCATION_ID, input.id);
    if (input.code !== undefined && input.code.length > 0) {
      await writeConfig(tx, CONFIG_KEY_LOCATION_CODE, input.code);
    } else {
      await tx.execute('DELETE FROM local_config WHERE key = ?', [CONFIG_KEY_LOCATION_CODE]);
    }
  });
  db.changes.notify();
}

/**
 * Un-bind this device. Used when the session no longer covers the location
 * this device holds: the stored value is stale or the device was re-enrolled,
 * and trading on it would file sales at a counter the session cannot write to.
 * Refusing to sell is the correct outcome; guessing a replacement is not.
 */
export async function clearDeviceLocation(db: LocalDb): Promise<void> {
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM local_config WHERE key IN (?, ?)', [
      CONFIG_KEY_LOCATION_ID,
      CONFIG_KEY_LOCATION_CODE,
    ]);
  });
  db.changes.notify();
}

/**
 * The price list this counter currently sells from. `null` until provisioned —
 * the counter must say so rather than price against whatever list happens to
 * be in the local catalogue.
 *
 * Provisioned by `data/session/device-price-list.ts` from the TENANT'S OWN
 * configuration (`price_list.priority` / `.location_id` / its effective
 * window, all of which sync). Never guessed here, and never a constant: the
 * lists are tenant rows and the default for a walk-in is the tenant's ranking
 * of them (08-client-architecture §8.7).
 */
export async function readActivePriceListId(db: DbExecutor): Promise<string | null> {
  return readConfig(db, CONFIG_KEY_PRICE_LIST_ID);
}

export async function writeActivePriceListId(db: LocalDb, priceListId: string): Promise<void> {
  await db.writeTransaction((tx) => writeConfig(tx, CONFIG_KEY_PRICE_LIST_ID, priceListId));
  db.changes.notify();
}

/**
 * Un-point this device at a price list. Used when configuration no longer
 * offers the stored list at this counter: it is the dev seed's placeholder, or
 * a list that has lapsed, and either one puts a code on the wire the server
 * refuses. Clearing makes `createCart` open a cart with no list, which
 * `checkout` refuses AT THE COUNTER — where someone can act on it — rather
 * than having the sale recorded and then rejected hours later at upload.
 */
export async function clearActivePriceListId(db: LocalDb): Promise<void> {
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM local_config WHERE key = ?', [CONFIG_KEY_PRICE_LIST_ID]);
  });
  db.changes.notify();
}

/**
 * The tenant's receipt-number format, or the neutral platform fallback while
 * configuration is still on its way.
 */
export async function readReceiptFormat(db: DbExecutor): Promise<ReceiptNumberFormat> {
  const raw = await readConfig(db, CONFIG_KEY_RECEIPT_FORMAT);
  if (raw === null) return DEFAULT_RECEIPT_FORMAT;
  try {
    return parseReceiptFormat(JSON.parse(raw));
  } catch {
    return DEFAULT_RECEIPT_FORMAT;
  }
}

export async function writeReceiptFormat(
  db: LocalDb,
  format: ReceiptNumberFormat,
): Promise<void> {
  await db.writeTransaction((tx) =>
    writeConfig(tx, CONFIG_KEY_RECEIPT_FORMAT, JSON.stringify(format)),
  );
  db.changes.notify();
}

/**
 * DELIBERATELY NOT HERE: resolving a cart's price-list id to the CODE the API
 * prices by. That lived here as `resolvePriceListCode` and asked one question
 * — "does a row with this id exist" — which a list that lapsed overnight
 * answers yes to, right up until the server refuses the sale hours later.
 *
 * It is now `resolveCartPriceList` in `data/session/device-price-list.ts`,
 * beside the rules about scope and effective windows it has to agree with. A
 * second copy of those rules living over here is how the two drift apart.
 */
