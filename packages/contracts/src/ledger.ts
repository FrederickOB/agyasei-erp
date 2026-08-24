/**
 * THE LEDGER, OVER THE WIRE — read-only, and shaped for honesty about
 * emptiness.
 *
 * Until Track B seeds a chart of accounts (blocked on the §2.8 accountant
 * review, open-questions Q6), every one of these reads answers EMPTY on a
 * real tenant. That is the correct answer and the client renders it as a
 * state, not an error: an empty ledger is a fact about the tenant, and
 * dressing it up as a failure would train an operator to ignore failures.
 *
 * Money crosses as decimal strings of minor units (ADR-0004). Two figures per
 * statement row, deliberately: `netDebitMinor` is the ledger's raw primitive
 * (Σ debit − Σ credit) and `amountMinor` is the natural-direction figure a
 * reader expects. Sending only the second hides the primitive; sending only
 * the first makes every client re-derive the sign convention, which is the
 * mistake §5.2.1 exists to prevent.
 */
import { z } from 'zod';
import { zUuid } from './wire.js';

export const statementQueryInput = z
  .object({
    /** Accounting periods to include. Absent = every posted entry. */
    periodIds: z.array(zUuid).min(1).optional(),
    /** Narrow to locations. Absent = the whole tenant. */
    locationIds: z.array(zUuid).min(1).optional(),
    /** Group rows per location. False = the consolidated statement. */
    byLocation: z.boolean().default(false),
  })
  .strict();
export type StatementQueryInput = z.input<typeof statementQueryInput>;

export const listPostingExceptionsInput = z
  .object({
    /** Default: only the open ones — the close gate's population. */
    includeResolved: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();
export type ListPostingExceptionsInput = z.input<typeof listPostingExceptionsInput>;

/** The five account types, as the schema constrains them. Platform vocabulary. */
export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;
export type AccountTypeWire = (typeof ACCOUNT_TYPES)[number];
