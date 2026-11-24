/**
 * BUSINESS EXPENSES AND THE MANAGEMENT P&L SHEET (migration 0033).
 *
 * An expense is an OPERATIONAL record — rent paid, fuel bought, the
 * electricity bill — kept so the business can see its actual profit. It is
 * NOT a journal entry: the chart of accounts, account mappings and any manual
 * journal are Track B, blocked until a qualified accountant exists (CLAUDE.md
 * §2.8; open-questions Q6, Q16). Nothing that crosses this contract posts.
 *
 * ── AMOUNTS TRAVEL AS DECIMAL TEXT IN MAJOR UNITS ────────────────────────
 * A person types "1250.50". It crosses as that TEXT and becomes an exact
 * integer of minor units on the server, against the tenant's jurisdiction
 * pack's `minor_units_per_major` — never assumed 100 (CLAUDE.md §2.3). A
 * value with more decimal places than the currency carries is REFUSED, not
 * rounded: "12.505" in a two-place currency is a typo, and a silently rounded
 * expense is wrong forever. `parseMajorAmount` is shared so the form can say
 * so before the request leaves the device; the server runs the same function.
 *
 * ── WHAT A REQUEST MAY NOT SAY ───────────────────────────────────────────
 * No tenant id (CLAUDE.md §2.1) — `.strict()` makes a forged one fail loudly.
 * No currency: that is the pack's, snapshotted server-side.
 */
import { z } from 'zod';
import { parseScaledDecimal } from './opening-stock.js';
import { mutationEnvelope, zBusinessDate, zUuid } from './wire.js';

/** Where the money came from. Platform vocabulary; the screen words each one. */
export const EXPENSE_PAID_FROM = ['CASH', 'BANK', 'MOBILE_MONEY', 'OTHER'] as const;
export type ExpensePaidFrom = (typeof EXPENSE_PAID_FROM)[number];

/** A plain non-negative decimal: digits, optionally one point and more digits. */
const AMOUNT_RE = /^\d+(\.\d+)?$/;

/**
 * How many decimal digits a currency carries, from its minor units per major
 * unit: 100 → 2, 1000 → 3, 1 → 0. Null when the pack's figure is not an
 * exact power of ten — a currency like that cannot be typed as a decimal, and
 * guessing a scale for it would be the "assume 100" bug in another form.
 */
export function minorScaleDigits(minorUnitsPerMajor: bigint): number | null {
  if (minorUnitsPerMajor < 1n) return null;
  let digits = 0;
  let rest = minorUnitsPerMajor;
  while (rest > 1n) {
    if (rest % 10n !== 0n) return null;
    rest /= 10n;
    digits += 1;
  }
  return digits;
}

/**
 * "1250.50" → 125050n at 100 minor units per major. EXACT — never through a
 * float. Null when the text is not a plain decimal, carries a non-zero digit
 * beyond the currency's places, or the pack's scale is not a power of ten.
 */
export function parseMajorAmount(text: string, minorUnitsPerMajor: bigint): bigint | null {
  const digits = minorScaleDigits(minorUnitsPerMajor);
  if (digits === null) return null;
  const trimmed = text.trim();
  if (!AMOUNT_RE.test(trimmed)) return null;
  return parseScaledDecimal(trimmed, digits);
}

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

/**
 * The category an expense is filed under: an existing one by id, or a NAME —
 * which the server matches case-insensitively against the live categories and
 * creates, in the same transaction, only when nothing matches.
 */
export const expenseCategoryRef = z.union([
  z.object({ id: zUuid }).strict(),
  z.object({ name: z.string().trim().min(1).max(80) }).strict(),
]);
export type ExpenseCategoryRef = z.input<typeof expenseCategoryRef>;

export const recordExpenseInput = z
  .object({
    ...mutationEnvelope,
    /** The business date it was paid. */
    expenseDate: zBusinessDate,
    /** One outlet or warehouse — or null for the whole business. Never omitted. */
    locationId: zUuid.nullable(),
    category: expenseCategoryRef,
    /** Major units as typed, e.g. "1250.50". Parsed exactly on the server. */
    amount: z.string().trim().min(1).max(24).regex(AMOUNT_RE, 'expected a plain decimal amount, e.g. 1250.50'),
    paidFrom: z.enum(EXPENSE_PAID_FROM),
    payee: optionalText(120),
    reference: optionalText(80),
    note: optionalText(500),
  })
  .strict();
export type RecordExpenseInput = z.input<typeof recordExpenseInput>;
export type RecordExpenseParsed = z.output<typeof recordExpenseInput>;

/** A correction is a void plus a new record — never an edit. The reason is required. */
export const voidExpenseInput = z
  .object({
    ...mutationEnvelope,
    expenseId: zUuid,
    reason: z.string().trim().min(1).max(200),
  })
  .strict();
export type VoidExpenseInput = z.input<typeof voidExpenseInput>;

/**
 * An inclusive business-date range, narrowed to locations. The same range rule
 * as the reports (`to` before `from` is REFUSED, never swapped), capped at 400
 * days — a year and a little, which covers a fiscal year.
 *
 * `locationIds` NARROWS: absent means the whole business, including expenses
 * recorded for the whole business. Present means only those locations, and
 * whole-business expenses are left out because they belong to no one of them.
 */
export const expenseRangeInput = z
  .object({
    from: zBusinessDate,
    to: zBusinessDate,
    locationIds: z.array(zUuid).min(1).max(500).optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, { message: 'from must not be after to', path: ['from'] })
  .refine(
    (v) => Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`) <= 399 * 86_400_000,
    { message: 'a range covers at most 400 days', path: ['to'] },
  );
export type ExpenseRangeInput = z.input<typeof expenseRangeInput>;

export const listExpensesInput = expenseRangeInput;
export type ListExpensesInput = ExpenseRangeInput;

export const profitSheetInput = expenseRangeInput;
export type ProfitSheetInput = ExpenseRangeInput;
