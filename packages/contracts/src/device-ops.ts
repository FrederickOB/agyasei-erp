/**
 * The registry: every operation a device may upload, mapped to the ONE schema
 * that defines its payload.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, in one sentence: so that "a client→server payload shape
 * that only one side has ever seen" becomes impossible to add by accident.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Two bugs of the same class reached the running app before this file: CORS
 * (the drills use a Node client with no browser origin, so nothing ever
 * checked that a browser could reach the API at all) and the sale payload
 * (the drills built their own API-shaped JSON, so nothing ever checked the
 * PWA's actual payload against the API's actual schema). Both were invisible
 * to a green test suite because in both cases the two sides were only ever
 * tested against a third thing that agreed with neither.
 *
 * The `satisfies` clause below is the structural part. Adding a kind to
 * `DEVICE_OP_KINDS` without a schema here is a COMPILE error; the conformance
 * suite then asserts, per kind, that the API router actually validates with
 * this exact schema object and that the ack vocabulary matches. So the next
 * uploadable operation cannot ship with a private, client-invisible shape —
 * not by convention, by the build.
 *
 * Note what a registry entry is NOT: it is not a handler, a route or a
 * permission. Dispatch, authorization and location scoping stay server-side
 * in `apps/api`. This is the shape of the bytes and nothing else — the file
 * must remain importable by the browser bundle (zod only).
 */
import type { ZodType } from 'zod';
import { createSaleInput } from './sale.js';
import { recordMovementInput } from './inventory.js';
import { openAccountInput, recordEntryInput } from './credit.js';
import { syncBlockInput } from './sequence.js';
import { recordGoodsReceiptInput, updateDeliveryStatusInput } from './procurement.js';
import type { DeviceOpKind } from './upload.js';

/**
 * kind → the schema BOTH sides use. The API parses with it; a client builder
 * must build to it. Exhaustive over `DeviceOpKind` by construction.
 */
/**
 * PHASE 2. `procurement.ts` declares `PROCUREMENT_UPLOADABLE_OPS`: the two
 * operations that must be uploadable (`goods.record_receipt`,
 * `logistics.update_delivery_status`) and the exact schema object each must be
 * registered with. Both are registered below AGAINST THOSE SAME OBJECTS — not
 * a copy, not a near-identical redeclaration — in the same change that landed
 * their handlers (`apps/api/src/routers/receiving.ts`, `./logistics.ts`) and
 * wired `DEVICE_OPS` in `apps/api/src/sync.ts`. `procurement.test.ts` fails if
 * a procurement kind is ever registered against a different schema object, and
 * `wire-conformance/test/outbox-surface.test.ts` fails if the server does not
 * really dispatch it — which is what stops a green tick appearing on a path
 * that would answer UNKNOWN_KIND at a yard.
 *
 * Raising and approving a purchase order stay ONLINE: they are commitments
 * made against supplier terms and an approval bound a device may hold a stale
 * copy of. Receiving and delivery status are not — the goods and the driver do
 * not wait for a radio.
 */
export const deviceOpContracts = {
  'sale.create': createSaleInput,
  'stock.record_movement': recordMovementInput,
  'credit.open_account': openAccountInput,
  'credit.record_entry': recordEntryInput,
  'sequence.sync_block': syncBlockInput,
  'goods.record_receipt': recordGoodsReceiptInput,
  'logistics.update_delivery_status': updateDeliveryStatusInput,
} as const satisfies Record<DeviceOpKind, ZodType>;

export type DeviceOpContracts = typeof deviceOpContracts;

/** The schema for one uploadable kind. */
export function contractFor<K extends DeviceOpKind>(kind: K): DeviceOpContracts[K] {
  return deviceOpContracts[kind];
}
