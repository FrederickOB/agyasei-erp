/**
 * Words for the review queue.
 *
 * A conflict class and an entity table are CODES — `RECEIPT_NUMBER_COLLISION`,
 * `app.sequence_block`. They are what the server files an item under, and
 * they stay on screen (smaller, under the title) so a support call can quote
 * them. But the person deciding needs a sentence first: what kind of thing
 * this is, and roughly what went wrong.
 *
 * These are PLATFORM classes raised by platform code (apps/api), so naming
 * them is product chrome, not tenant vocabulary (§2.9). A class this table
 * does not know — one added on the server after this client shipped — falls
 * back to its own code, softened, never to a blank.
 */

interface ClassWords {
  /** A short noun phrase: the title of the card. */
  readonly title: string;
  /** One line on what happened, without guessing the cause. */
  readonly summary: string;
}

const CLASS_WORDS: Readonly<Record<string, ClassWords>> = {
  RECEIPT_NUMBER_COLLISION: {
    title: 'Two sales share a receipt number',
    summary: 'Two receipts arrived carrying the same number. Both sales are kept; one number needs to be settled.',
  },
  SEQUENCE_CONSUMED_UPTO_REGRESSION: {
    title: 'Receipt numbering went backwards',
    summary: 'A device reported using fewer receipt numbers than it had already reported. Check the device before it sells again.',
  },
  CASH_SESSION_TILL_CLAIMED_TWICE: {
    title: 'One till opened twice',
    summary: 'Two devices opened the same till for overlapping sessions while apart.',
  },
  CASH_SESSION_DATE_DIVERGENCE: {
    title: 'Till session on an unexpected date',
    summary: 'A till session carries a business date that does not match when it was recorded. Check that device’s clock.',
  },
  CASH_SESSION_PERIOD_CLOSED: {
    title: 'Till session in a closed period',
    summary: 'A till session arrived for an accounting period that has already been closed.',
  },
  SALE_AFTER_TILL_CLOSED: {
    title: 'Sale recorded after the till closed',
    summary: 'A sale arrived dated after its till session was cashed up.',
  },
  SALE_TENDER_RECONCILED: {
    title: 'Payment did not match the sale',
    summary: 'The payments recorded for a sale did not add up the way the server expected. No figure is lost; a person must look.',
  },
  SALE_RETURN_REFUND_RECONCILED: {
    title: 'Refund did not match the return',
    summary: 'The refund recorded for a return did not add up the way the server expected. No figure is lost; a person must look.',
  },
  SALE_VOID_VS_SETTLED: {
    title: 'Voided sale had already been paid',
    summary: 'A sale was voided on one device after it had been settled elsewhere.',
  },
  PRODUCT_RETIRED_BEFORE_SYNC: {
    title: 'Recorded for a product that had been taken off',
    summary:
      'A device recorded this before it heard the product was switched off or removed. It was kept exactly as recorded — check it, and bring the product back if it is still in use.',
  },
  CONVERSION_OUT_OF_TOLERANCE: {
    title: 'Received quantity outside tolerance',
    summary: 'A confirmed delivery quantity is further from its unit conversion than the unit allows.',
  },
  PERMISSION_BOUND_EXCEEDED: {
    title: 'Done beyond someone’s permission',
    summary: 'An action recorded offline went beyond what the person’s role allows. It needs approval or reversal.',
  },
  REVOKED_DEVICE_WRITE: {
    title: 'Revoked device sent records',
    summary: 'A device that had been revoked sent records afterwards. They were held, not applied.',
  },
  REVOKED_DEVICE_DRAIN_ABANDONED: {
    title: 'Revoked device left records unsent',
    summary: 'A revoked device stopped before sending everything it held. Some of its records may never arrive.',
  },
};

const ENTITY_WORDS: Readonly<Record<string, string>> = {
  sale: 'Sale',
  sale_return: 'Return',
  cash_session: 'Till session',
  sequence_block: 'Receipt numbers',
  goods_receipt_line: 'Goods received',
  goods_receipt: 'Goods received',
  device: 'Device',
  customer: 'Customer',
  credit_account: 'Credit account',
  stock_movement: 'Stock movement',
  stock_adjustment: 'Stock adjustment',
};

/** `SOME_CODE` → `Some code`. The fallback for anything not named above. */
export function softenCode(code: string): string {
  const t = code.replace(/^app\./, '').replace(/[_.-]+/g, ' ').trim().toLowerCase();
  return t.length === 0 ? code : t[0]!.toUpperCase() + t.slice(1);
}

export function conflictTitle(conflictClass: string): string {
  return CLASS_WORDS[conflictClass]?.title ?? softenCode(conflictClass);
}

export function conflictSummary(conflictClass: string): string | null {
  return CLASS_WORDS[conflictClass]?.summary ?? null;
}

export function entityLabel(entityTable: string): string {
  const bare = entityTable.replace(/^app\./, '');
  return ENTITY_WORDS[bare] ?? softenCode(bare);
}

/**
 * "in 3 days", "in 5 hours", "2 days ago" — escalation is a deadline, and a
 * deadline is read relative to now. `nowMs` is a parameter so it is testable.
 */
export function relativeTo(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const diff = at - nowMs;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const [n, unit] =
    abs >= day ? [Math.round(abs / day), 'day'] : abs >= hour ? [Math.round(abs / hour), 'hour'] : [Math.max(1, Math.round(abs / minute)), 'minute'];
  const span = `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
  return diff >= 0 ? `in ${span}` : `${span} ago`;
}

/** "Escalates in 2 days" / "Overdue by 4 hours". */
export function escalationLabel(escalateAt: string, nowMs: number): string {
  const at = Date.parse(escalateAt);
  if (Number.isNaN(at)) return `Escalates ${escalateAt}`;
  return at >= nowMs ? `Escalates ${relativeTo(escalateAt, nowMs)}` : `Overdue by ${relativeTo(escalateAt, nowMs).replace(/ ago$/, '')}`;
}
