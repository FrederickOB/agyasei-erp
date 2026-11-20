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
 * - A REMEMBERED room wins, while the session can still hold it.
 * - With nothing remembered, the room follows the FORM FACTOR (ADR-0003 A1):
 *   a laptop — a fine pointer that hovers, on a desk-width screen — opens into
 *   the office; every touch device opens into the COUNTER, because a tablet
 *   handed to a cashier mid-shift must come up selling, not reporting. This is
 *   a first landing only: one tap on either door is remembered from then on.
 * - Storage and media queries are best-effort. A private window, cleared site
 *   data, a blocked accessor or no `matchMedia` all mean "counter", never an
 *   error.
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

/**
 * A laptop, as ADR-0003 A1 means it: the primary pointer is fine and hovers,
 * and the screen is desk-width. Android tablets and phones report a coarse
 * pointer whatever their width, so a tablet in landscape is still a counter.
 */
export const LAPTOP_FORM_FACTOR = '(pointer: fine) and (hover: hover) and (min-width: 1024px)';

function defaultRoom(): Room {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(LAPTOP_FORM_FACTOR).matches
      ? 'office'
      : 'counter';
  } catch {
    return 'counter';
  }
}

export function rememberedRoom(): Room {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === 'office' || stored === 'counter') return stored;
  } catch {
    // Unreadable storage is "nothing remembered".
  }
  return defaultRoom();
}

export function rememberRoom(room: Room): void {
  try {
    window.localStorage.setItem(KEY, room);
  } catch {
    // Nothing to do: the next launch opens into the counter, which is safe.
  }
}
