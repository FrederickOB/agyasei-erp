/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THING A DEVICE MAY REMEMBER ABOUT CREDIT: AN IDENTIFIER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **An identifier may be remembered. A figure may never be.** That single rule
 * is what this module is, and the difference between the two is the difference
 * between a screen that is merely inconvenient offline and one that lies.
 *
 *  · An account id that has gone wrong FAILS LOUDLY on the next read: the
 *    server answers `NOT_FOUND: credit account not found`, the screen shows
 *    the refusal, and nobody has been told anything about money.
 *  · A balance that has gone stale renders EXACTLY like a fresh one. There is
 *    no visual difference between GH-worth-of-headroom that existed on Tuesday
 *    and headroom that exists now, and the person reading it is deciding
 *    whether to load a truck.
 *
 * So `data/api/credit.ts` holds no cache at all, and this holds no money.
 *
 * ---------------------------------------------------------------------------
 * WHY A DEVICE NOTE IS NEEDED AT ALL — the platform gap, stated
 * ---------------------------------------------------------------------------
 * `credit.exposure`, `credit.ageing` and `credit.previewFacilityFee` are all
 * addressed by ACCOUNT id. Everything a counter actually holds is addressed by
 * CUSTOMER: the synced `customer` rows, and `sales.createSale`, which resolves
 * the account from the customer server-side. There is no route that maps one
 * to the other and no bucket that syncs `customer_account`, so a device cannot
 * derive the account for a customer it can see.
 *
 * That is a real gap in the platform's read surface, not something this client
 * can paper over — so it is not papered over. The reference is entered once,
 * by a person who has it, and remembered against that customer on THIS device
 * so nobody retypes a UUID at a counter. When an account-by-customer route
 * lands, this module is deleted and the screen asks the server instead.
 *
 * Device-local, never synced, never uploaded, and scoped to nothing but this
 * device's own `local_config`.
 */
import { uuidv7 } from '../../lib/uuidv7';
import type { DbExecutor, LocalDb } from '../db';

/** One row per customer this device has looked up. Prefix, then the customer id. */
export const CONFIG_KEY_CREDIT_ACCOUNT_PREFIX = 'credit_account:';

function keyFor(customerId: string): string {
  return `${CONFIG_KEY_CREDIT_ACCOUNT_PREFIX}${customerId}`;
}

/** The account reference this device has noted for a customer, if any. */
export async function readCreditAccountRef(
  db: DbExecutor,
  customerId: string,
): Promise<string | null> {
  const rows = await db.getAll('SELECT value FROM local_config WHERE key = ? LIMIT 1', [
    keyFor(customerId),
  ]);
  const value = rows[0]?.['value'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Note it, replacing whatever was there.
 *
 * Replaced whole, never merged: a customer has one account (the server's own
 * `openAccount` refuses a second), and two remembered references for one
 * customer would mean the device could show one person's position under
 * another person's name.
 */
export async function writeCreditAccountRef(
  db: LocalDb,
  customerId: string,
  accountId: string,
): Promise<void> {
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM local_config WHERE key = ?', [keyFor(customerId)]);
    await tx.execute('INSERT INTO local_config (id, key, value) VALUES (?, ?, ?)', [
      uuidv7(),
      keyFor(customerId),
      accountId,
    ]);
  });
  db.changes.notify();
}

/** Forget it — for a reference the server refused, so it is not offered again. */
export async function clearCreditAccountRef(db: LocalDb, customerId: string): Promise<void> {
  await db.writeTransaction(async (tx) => {
    await tx.execute('DELETE FROM local_config WHERE key = ?', [keyFor(customerId)]);
  });
  db.changes.notify();
}
