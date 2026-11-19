/**
 * Which ROOM a device opens into: the counter, or the back office.
 *
 * The product has two rooms (docs/design/back-office-dashboard.html §1). The
 * till is task-first and never unmounts its cart; the office is overview-first
 * and is a lazy chunk a counter-only session never downloads. This file
 * decides where a session lands and remembers where it was.
 *
 * Rules:
 * - A session that holds none of the office capabilities is never offered the
 *   office at all. This is a courtesy, not a control (Shell.tsx rule 2).
 * - The default is the COUNTER. The office is a room a person chose, and a
 *   tablet handed to a cashier mid-shift must come up selling, not reporting.
 *   The remembered room wins only while the session can still hold it.
 * - Storage is best-effort. A private window, cleared site data, or a blocked
 *   accessor all mean "counter", never an error.
 */
import { CAPABILITY, holdsCapability, type PermissionsState } from '../../data/api/session';

export type Room = 'counter' | 'office';

const KEY = 'erp.room';

/** The capabilities that make the office worth offering. Product chrome. */
export const OFFICE_CAPABILITIES: readonly string[] = [
  CAPABILITY.reportLocation,
  CAPABILITY.reportTenant,
  CAPABILITY.reportMargin,
  CAPABILITY.stockView,
  CAPABILITY.creditView,
  CAPABILITY.purchaseOrderView,
  CAPABILITY.supplierView,
  CAPABILITY.deliveryView,
  CAPABILITY.conflictReview,
  CAPABILITY.glView,
];

export function officeOffered(permissions: PermissionsState): boolean {
  // `no-session` holds nothing; `unknown` holds everything — both are the
  // `holdsCapability` contract, and both are the right answer here.
  return OFFICE_CAPABILITIES.some((code) => holdsCapability(permissions, code));
}

export function rememberedRoom(): Room {
  try {
    return window.localStorage.getItem(KEY) === 'office' ? 'office' : 'counter';
  } catch {
    return 'counter';
  }
}

export function rememberRoom(room: Room): void {
  try {
    window.localStorage.setItem(KEY, room);
  } catch {
    // Nothing to do: the next launch opens into the counter, which is safe.
  }
}
