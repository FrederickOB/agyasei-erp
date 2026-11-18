/**
 * The tender methods that ship with the "construction-materials-gh" template.
 *
 * THIS FILE IS DATA, NOT LOGIC (ADR-0006; CLAUDE.md §2.9). applyTemplate()
 * inserts these once as ORDINARY EDITABLE ROWS in app.tender_method; after
 * that the tenant owns them — renames them, retires one, adds a second
 * mobile-money network. Nothing on the platform reads a `code` or a `name`.
 *
 * What the platform DOES read is `postingRole`, a value from the platform's
 * own posting-role catalogue (migration 0016), and the two properties the
 * database derives from it (migration 0020): whether the money is in the
 * drawer (`TILL_CASH`) and whether it is the customer's debt (`AR_TRADE`).
 * `requiresReference` is tenant policy: the counter asks for a transaction id
 * or a cheque number when the tenant says the method needs one.
 *
 * NEEDS AN ACCOUNTANT (CLAUDE.md §2.8, 05 §5.12): which posting role a CHEQUE
 * belongs to. It is seeded as `BANK` — a cheque is not drawer cash, and the
 * catalogue has no "cheques in hand" role — so it posts as a bank receipt on
 * the day it is taken and is matched at bank reconciliation when it clears.
 * Whether the reviewing accountant wants a separate undeposited-funds role is
 * a platform catalogue change with its own review, not a template edit.
 */
export interface TemplateTenderMethod {
  /** Stable provenance key. Never read by business logic (01 §1.6). */
  readonly ref: string;
  /** The tenant's word. Editable. Never branched on. */
  readonly code: string;
  readonly name: string;
  readonly postingRole: 'TILL_CASH' | 'MOMO_WALLET' | 'BANK' | 'AR_TRADE';
  readonly requiresReference: boolean;
  readonly sortOrder: number;
}

export const TEMPLATE_TENDER_METHODS: readonly TemplateTenderMethod[] = [
  { ref: 'cash', code: 'CASH', name: 'Cash', postingRole: 'TILL_CASH', requiresReference: false, sortOrder: 10 },
  // Most counter payments in the pilot's market. The transaction id is what
  // momo reconciliation matches on (05 §5.7.1), so the tenant requires it.
  { ref: 'momo', code: 'MOMO', name: 'Mobile Money', postingRole: 'MOMO_WALLET', requiresReference: true, sortOrder: 20 },
  { ref: 'bank_transfer', code: 'BANK_TRANSFER', name: 'Bank Transfer', postingRole: 'BANK', requiresReference: true, sortOrder: 30 },
  { ref: 'cheque', code: 'CHEQUE', name: 'Cheque', postingRole: 'BANK', requiresReference: true, sortOrder: 40 },
  { ref: 'on_account', code: 'ON_ACCOUNT', name: 'On Account', postingRole: 'AR_TRADE', requiresReference: false, sortOrder: 50 },
];
