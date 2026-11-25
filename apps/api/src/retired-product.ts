/**
 * A PRODUCT TAKEN OFF AFTER A DEVICE USED IT.
 *
 * The office can take a product off two ways (routers/products.ts): SWITCH IT
 * OFF (`is_sellable = false` — still in the catalogue, not offered at the
 * counter) or REMOVE it (`deleted_at` set — "Remove all products"). Either
 * reaches a tablet at its next sync. Until then the tablet is trading on ITS
 * copy of the catalogue, and an outlet can be offline for days.
 *
 * So a sale, a stock adjustment or a goods receipt can arrive naming a product
 * the office has since taken off. That write describes something that already
 * HAPPENED: the bags left the yard, the cash is in the drawer, the truck was
 * unloaded. Refusing it does not undo any of that. Worse, the upload path
 * classes NOT_FOUND and PRECONDITION_FAILED as retryable (apps/web
 * data/sync/upload.ts — wrongly dead-lettering is the loss path), so a refusal
 * here is retried every thirty seconds for ever: the outlet's outbox never
 * drains and its till never reaches the books.
 *
 * THE RULE: the write LANDS, exactly as recorded, against the catalogue AS IT
 * STOOD when the product was taken off — and a person is told.
 *
 *  - A REMOVED product's units and prices are the rows that were still live at
 *    the moment it was removed: `deleted_at is null`, or archived in the same
 *    act or after it (`deleted_at >= product.deleted_at`; remove-all stamps
 *    every row it archives with one transaction time). A price superseded
 *    BEFORE the removal stays superseded.
 *  - A SWITCHED-OFF product changed nothing else; it prices as it always did.
 *  - A review (`PRODUCT_RETIRED_BEFORE_SYNC`, severity 2) names the product and
 *    the record, in the same transaction as the write. Nothing is overwritten;
 *    the record stands as the device made it (`first_applied`).
 *
 * WHAT DOES NOT CHANGE: a product id this tenant does not hold is still
 * NOT_FOUND. Row-level security makes another tenant's product exactly that —
 * dropping the `deleted_at` predicate widens nothing across the tenant
 * boundary (test: retired-products.test.ts).
 */
import { deterministicUuid } from '@erp/db';
import type { Queryable } from './db.js';
import { openConflictReview } from './routers/sequence.js';

export const PRODUCT_RETIRED_CLASS = 'PRODUCT_RETIRED_BEFORE_SYNC';
/** The record stands and nothing is blocked; a person should still look. */
const RETIRED_SEVERITY = 2;
/** The same queue every other trade review is routed to. */
const REVIEW_PERMISSION = 'sync.conflict.review';

/**
 * SQL: row `alias` was live as the device knew it. `param` is the product's
 * `removed_at` as text — null for a product that has not been removed, which
 * reduces this to the ordinary `deleted_at is null`.
 */
export function liveAsOfRemoval(alias: string, param: string): string {
  return `(${alias}.deleted_at is null or (${param}::timestamptz is not null and ${alias}.deleted_at >= ${param}::timestamptz))`;
}

/** How a product had been taken off, as read inside the write's transaction. */
export interface ProductTakenOff {
  readonly productId: string;
  readonly skuCode: string;
  readonly name: string;
  /** When it was removed (timestamptz as text), or null if it has not been. */
  readonly removedAt: string | null;
  /** True when it is (still) switched off for sale. */
  readonly switchedOff: boolean;
  /** The record's own line number, where the record has lines. */
  readonly lineNo: number | null;
}

export async function openProductTakenOffReview(
  atx: Queryable,
  input: {
    readonly tenantId: string;
    readonly writeId: string;
    readonly hlc: string;
    readonly entityTable: string;
    readonly entityId: string;
    readonly locationId: string;
    /** What the device recorded, in a few words ("a sale", "a stock adjustment"). */
    readonly recorded: string;
    readonly products: readonly ProductTakenOff[];
  },
): Promise<void> {
  const removed = input.products.some((p) => p.removedAt !== null);
  const switchedOff = input.products.some((p) => p.removedAt === null && p.switchedOff);
  const how = removed && switchedOff ? 'removed or switched off' : removed ? 'removed' : 'switched off';
  await openConflictReview(atx, {
    tenantId: input.tenantId,
    writeId: input.writeId,
    hlc: input.hlc,
    reviewId: deterministicUuid(input.writeId, 'conflict_review', 'product_taken_off'),
    conflictClass: PRODUCT_RETIRED_CLASS,
    severity: RETIRED_SEVERITY,
    entityTable: input.entityTable,
    entityId: input.entityId,
    fieldPath: 'product_id',
    proposals: [
      {
        party: 'device',
        detail: `${input.recorded}, made while the device still had these products on its list`,
        products: input.products.map((p) => ({
          lineNo: p.lineNo,
          productId: p.productId,
          code: p.skuCode,
          name: p.name,
        })),
      },
      {
        party: 'office',
        detail: `these products had been ${how} before the record reached the server`,
        products: input.products.map((p) => ({
          code: p.skuCode,
          removedAt: p.removedAt,
          switchedOff: p.switchedOff,
        })),
      },
    ],
    pendingState: 'first_applied',
    pendingValue: {
      note:
        `Recorded exactly as the device made it, at the prices in force when it was made. ` +
        `Check the record, and switch the product back on or load it again if it is still in use.`,
      codes: input.products.map((p) => p.skuCode),
    },
    requiredPermission: REVIEW_PERMISSION,
    locationIds: [input.locationId],
  });
}
