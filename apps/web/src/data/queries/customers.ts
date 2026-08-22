/**
 * The tenant's customers, as far as this device is allowed to know them.
 *
 * `tenant_customers` is the sync bucket's own name for what it carries and its
 * header says the rest: **IDENTITY ONLY — no balances, no limits**
 * (`infra/powersync/sync_rules.yaml`). Code, name, phone and the flag that
 * says whether this customer buys on account. Nothing about money.
 *
 * That split is exactly right and it is the reason this file exists next to
 * `data/api/credit.ts` rather than inside it: WHO the customer is syncs and
 * works offline; WHAT THEY OWE does not sync and cannot be answered offline at
 * all. A screen may therefore let somebody find a customer with the radio off
 * and must not let them read a balance the same way.
 */
import type { DbExecutor } from '../db';

export interface CreditCustomer {
  readonly id: string;
  /** The tenant's own code for them. Rendered; never compared. */
  readonly code: string;
  readonly name: string;
  readonly phone: string | null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Customers flagged as buying on account.
 *
 * The flag is a hint about who to offer, not a claim that an account exists or
 * that it is in good standing — both of those live in the credit book, which
 * is not on this device. The server answers `NOT_FOUND` for a reference that
 * names no account, and that refusal is shown rather than smoothed over.
 */
export async function loadCreditCustomers(db: DbExecutor): Promise<CreditCustomer[]> {
  const rows = await db.getAll(
    `SELECT id, code, name, phone
       FROM customer
      WHERE is_credit_customer = 1
      ORDER BY name`,
  );
  return rows.map((row) => ({
    id: String(row['id']),
    code: String(row['code'] ?? ''),
    name: String(row['name'] ?? ''),
    phone: textOrNull(row['phone']),
  }));
}
