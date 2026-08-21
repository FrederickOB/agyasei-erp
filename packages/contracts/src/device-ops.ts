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
import type { DeviceOpKind } from './upload.js';

/**
 * kind → the schema BOTH sides use. The API parses with it; a client builder
 * must build to it. Exhaustive over `DeviceOpKind` by construction.
 */
export const deviceOpContracts = {
  'sale.create': createSaleInput,
  'stock.record_movement': recordMovementInput,
  'credit.open_account': openAccountInput,
  'credit.record_entry': recordEntryInput,
} as const satisfies Record<DeviceOpKind, ZodType>;

export type DeviceOpContracts = typeof deviceOpContracts;

/** The schema for one uploadable kind. */
export function contractFor<K extends DeviceOpKind>(kind: K): DeviceOpContracts[K] {
  return deviceOpContracts[kind];
}
