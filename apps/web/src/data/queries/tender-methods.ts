/**
 * The tenant's tender methods, as the counter offers them (04 §4.8).
 *
 * A method's `name` is the TENANT's word and is only ever rendered. What the
 * counter reasons about is platform vocabulary the server derives from the
 * method's posting role:
 *
 *   isCash       the money goes in the drawer — change can be given, and
 *                cash-up counts it;
 *   isOnAccount  the money is the customer's debt — it needs a customer and
 *                `sale.record.credit`, and it settles ON_ACCOUNT on the wire;
 *   requiresReference  the tenant wants a transaction id or cheque number.
 *
 * Nothing here — or anywhere in the client — compares a code or a name to a
 * string (CLAUDE.md §2.9; `tests/no-hardcoded-vocabulary.test.ts`).
 */
import type { TenderSettlement } from '@erp/contracts';
import type { DbExecutor, DbRow } from '../db';

export interface TenderMethod {
  readonly id: string;
  /** The tenant's own label. Render it; never test it. */
  readonly name: string;
  readonly isCash: boolean;
  readonly isOnAccount: boolean;
  readonly requiresReference: boolean;
  /** The platform settlement this method's lines carry on the wire. */
  readonly settlement: TenderSettlement;
}

function flag(v: unknown): boolean {
  return v === 1 || v === '1' || v === true;
}

function mapMethod(row: DbRow): TenderMethod {
  const isOnAccount = flag(row['is_on_account']);
  return {
    id: String(row['id']),
    name: String(row['name'] ?? ''),
    isCash: flag(row['is_cash']),
    isOnAccount,
    requiresReference: flag(row['requires_reference']),
    settlement: isOnAccount ? 'ON_ACCOUNT' : 'IMMEDIATE',
  };
}

/** Every method this counter may offer, in the tenant's own order. */
export async function loadTenderMethods(db: DbExecutor): Promise<TenderMethod[]> {
  const rows = await db.getAll(
    `SELECT id, name, is_cash, is_on_account, requires_reference
       FROM tender_method
      WHERE COALESCE(is_active, 1) = 1
      ORDER BY COALESCE(sort_order, 0), name, id`,
  );
  return rows.map(mapMethod);
}

/**
 * The drawer's own method — the first active cash method in the tenant's
 * order. Null when the tenant has none synced yet; the counter then says so
 * rather than guessing at an id.
 */
export async function defaultCashMethod(db: DbExecutor): Promise<TenderMethod | null> {
  const methods = await loadTenderMethods(db);
  return methods.find((m) => m.isCash) ?? null;
}

/** One method by id, active or not — a receipt names what was used. */
export async function tenderMethodById(db: DbExecutor, id: string): Promise<TenderMethod | null> {
  const rows = await db.getAll(
    `SELECT id, name, is_cash, is_on_account, requires_reference
       FROM tender_method WHERE id = ? LIMIT 1`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? null : mapMethod(row);
}
