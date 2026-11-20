/**
 * The destinations both rooms can open, and the one place they are rendered.
 *
 * The counter room (Shell.tsx) and the back office (features/office) offer
 * overlapping sets of screens. Each screen's chunk boundary, its skeleton and
 * its props are decided ONCE here so that the two rails cannot drift — a
 * screen that gains a prop gains it for both rooms in one edit.
 *
 * §8.10: a cashier's device should never parse the reporting screen's
 * JavaScript. The counter and its own sales are in the initial chunk because
 * they are what the till is for; everything else is fetched the first time
 * somebody asks for it, and is then in the precache like any other asset.
 */
import { Suspense, lazy, type ReactNode } from 'react';
import type { ApiCallOptions } from '../../data/api/client';
import { CAPABILITY, type PermissionsState } from '../../data/api/session';
import type { LocalDb } from '../../data/db';
import type { IconName } from '../../ui/Icon';
import { ServerPending } from './ServerAnswer';

const Reports = lazy(async () => ({ default: (await import('../reports/Reports')).Reports }));
const LowStock = lazy(async () => ({ default: (await import('../stock/LowStock')).LowStock }));
const StockAdjust = lazy(async () => ({
  default: (await import('../inventory/StockAdjust')).StockAdjust,
}));
const Credit = lazy(async () => ({ default: (await import('../credit/Credit')).Credit }));
// Phase 2. A counter clerk holds none of these capabilities and therefore
// never downloads any of these chunks — which is the whole point of splitting
// them out on a device with 2GB of RAM and a slow disk.
const Receiving = lazy(async () => ({
  default: (await import('../receiving/Receiving')).Receiving,
}));
const Purchasing = lazy(async () => ({
  default: (await import('../purchasing/Purchasing')).Purchasing,
}));
const Suppliers = lazy(async () => ({
  default: (await import('../suppliers/Suppliers')).Suppliers,
}));
const Review = lazy(async () => ({ default: (await import('../review/Review')).Review }));
const Books = lazy(async () => ({ default: (await import('../books/Books')).Books }));
const Deliveries = lazy(async () => ({
  default: (await import('../deliveries/Deliveries')).Deliveries,
}));
// Back-office administration (work package B). Office-only, online-only.
const PeopleAdmin = lazy(async () => ({ default: (await import('../admin/Admin')).PeopleAdmin }));
const DevicesAdmin = lazy(async () => ({ default: (await import('../admin/Admin')).DevicesAdmin }));
const RolesAdmin = lazy(async () => ({ default: (await import('../admin/Admin')).RolesAdmin }));
const PrinterSettings = lazy(async () => ({
  default: (await import('../printing/PrinterSettings')).PrinterSettings,
}));

export type DestinationId =
  | 'reports'
  | 'stock'
  | 'adjust'
  | 'credit'
  | 'receive'
  | 'buying'
  | 'suppliers'
  | 'deliveries'
  | 'review'
  | 'books'
  | 'people'
  | 'devices'
  | 'roles'
  | 'printer';

export interface DestinationDef {
  readonly id: DestinationId;
  /** Product chrome. Never tenant vocabulary. */
  readonly label: string;
  readonly icon: IconName;
  /** The PLATFORM capability that makes this worth offering. Null = always. */
  readonly requires: string | null;
  /** Which group of the office rail it sits in. Product chrome. */
  readonly group: 'trade' | 'stock' | 'control';
  /** True for the two outbox writers that belong at the counter, radio off. */
  readonly counterWork: boolean;
  /**
   * Back office only: never on the counter's rail. Administration is a laptop
   * job (ADR-0003 A1) and is online-only by construction.
   */
  readonly officeOnly?: boolean;
}

/** In rail order. The counter room offers the same list in the same order. */
export const DESTINATIONS: readonly DestinationDef[] = [
  { id: 'reports', label: 'Reports', icon: 'chart', requires: CAPABILITY.reportLocation, group: 'trade', counterWork: false },
  { id: 'stock', label: 'Stock', icon: 'box', requires: CAPABILITY.stockView, group: 'stock', counterWork: false },
  // The only counter-room destination that WRITES with the radio off: an
  // adjustment rides the same ordered outbox a sale does.
  { id: 'adjust', label: 'Adjust', icon: 'undo', requires: CAPABILITY.stockAdjust, group: 'stock', counterWork: true },
  // Strictly online: the credit book is in no sync bucket.
  { id: 'credit', label: 'Credit', icon: 'clock', requires: CAPABILITY.creditView, group: 'trade', counterWork: false },
  // The second outbox writer: a goods receipt is signed for at the door.
  { id: 'receive', label: 'Receive', icon: 'download', requires: CAPABILITY.goodsReceive, group: 'stock', counterWork: true },
  { id: 'buying', label: 'Buying', icon: 'receipt', requires: CAPABILITY.purchaseOrderView, group: 'stock', counterWork: false },
  { id: 'suppliers', label: 'Supply', icon: 'building', requires: CAPABILITY.supplierView, group: 'stock', counterWork: false },
  { id: 'deliveries', label: 'On the road', icon: 'truck', requires: CAPABILITY.deliveryView, group: 'stock', counterWork: false },
  // The human review queue (CLAUDE.md §2.2): a destination, not a notification.
  { id: 'review', label: 'Decisions', icon: 'alert', requires: CAPABILITY.conflictReview, group: 'control', counterWork: false },
  // Read-only: the books are the server's; a correction is a reversing entry.
  { id: 'books', label: 'Books', icon: 'book', requires: CAPABILITY.glView, group: 'control', counterWork: false },
  // Administration (02 §2.4–§2.7). Offered by the capability that makes each
  // screen useful; the server re-checks every act, escalation rule included.
  { id: 'people', label: 'People', icon: 'grid', requires: CAPABILITY.adminUser, group: 'control', counterWork: false, officeOnly: true },
  { id: 'devices', label: 'Devices', icon: 'pin', requires: CAPABILITY.adminDeviceEnrol, group: 'control', counterWork: false, officeOnly: true },
  { id: 'roles', label: 'Roles', icon: 'tag', requires: CAPABILITY.adminRole, group: 'control', counterWork: false, officeOnly: true },
  // The printer beside THIS device. Local, offered to everyone: choosing the
  // printer at the counter must not need a manager, it must work offline, and
  // a laptop at HQ needs it for A4 invoices just as a tablet does for receipts.
  { id: 'printer', label: 'Printer', icon: 'printer', requires: null, group: 'control', counterWork: false },
];

export interface DestinationProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly apiOptions?: ApiCallOptions | undefined;
}

/**
 * The fallback is the same skeleton a server read shows, so arriving at a
 * destination never flashes a blank screen — on these devices the chunk comes
 * off eMMC, and that is not instant.
 */
export function renderDestination(id: DestinationId, { db, permissions, apiOptions }: DestinationProps): ReactNode {
  const api = apiOptions === undefined ? {} : { apiOptions };
  switch (id) {
    case 'reports':
      return (
        <Suspense fallback={<ServerPending what="Reporting" rows={2} />}>
          <Reports db={db} permissions={permissions} {...api} />
        </Suspense>
      );
    case 'stock':
      return (
        <Suspense fallback={<ServerPending what="The low-stock list" rows={4} />}>
          <LowStock db={db} permissions={permissions} {...api} />
        </Suspense>
      );
    case 'adjust':
      // No `apiOptions`: this screen never talks to the API. It reads local
      // rows and writes to the local outbox, which is what lets it work in a
      // partition.
      return (
        <Suspense fallback={<ServerPending what="Stock adjustments" rows={3} />}>
          <StockAdjust db={db} permissions={permissions} />
        </Suspense>
      );
    case 'credit':
      return (
        <Suspense fallback={<ServerPending what="The credit position" rows={3} />}>
          <Credit db={db} permissions={permissions} {...api} />
        </Suspense>
      );
    case 'receive':
      return (
        <Suspense fallback={<ServerPending what="Deliveries expected here" rows={3} />}>
          <Receiving db={db} permissions={permissions} {...api} />
        </Suspense>
      );
    case 'buying':
      return (
        <Suspense fallback={<ServerPending what="The order list" rows={3} />}>
          <Purchasing db={db} permissions={permissions} {...api} />
        </Suspense>
      );
    case 'suppliers':
      return (
        <Suspense fallback={<ServerPending what="The supplier list" rows={3} />}>
          <Suppliers db={db} permissions={permissions} {...api} />
        </Suspense>
      );
    case 'deliveries':
      return (
        <Suspense fallback={<ServerPending what="The delivery list" rows={3} />}>
          <Deliveries db={db} permissions={permissions} {...api} />
        </Suspense>
      );
    case 'review':
      return (
        <Suspense fallback={<ServerPending what="Items needing a decision" rows={3} />}>
          <Review {...api} />
        </Suspense>
      );
    case 'books':
      return (
        <Suspense fallback={<ServerPending what="The books" rows={4} />}>
          <Books {...api} />
        </Suspense>
      );
    case 'people':
      return (
        <Suspense fallback={<ServerPending what="People" rows={3} />}>
          <PeopleAdmin {...api} />
        </Suspense>
      );
    case 'devices':
      return (
        <Suspense fallback={<ServerPending what="Devices" rows={3} />}>
          <DevicesAdmin {...api} />
        </Suspense>
      );
    case 'roles':
      return (
        <Suspense fallback={<ServerPending what="Roles" rows={3} />}>
          <RolesAdmin {...api} />
        </Suspense>
      );
    case 'printer':
      return (
        <Suspense fallback={<ServerPending what="Printer settings" rows={3} />}>
          <PrinterSettings db={db} />
        </Suspense>
      );
  }
}
