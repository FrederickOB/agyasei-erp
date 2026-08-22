/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHELL — navigation, and the rules a new screen has to follow
 * ═══════════════════════════════════════════════════════════════════════════
 * Read this before adding a destination. Everything below is a decision, not
 * a default, and each one has a counter behind it.
 *
 * ---------------------------------------------------------------------------
 * 1. THE COUNTER IS NEVER UNMOUNTED
 * ---------------------------------------------------------------------------
 * The cart survives a battery pull, because it lives in local-only SQLite
 * (§8.2). What does NOT live in SQLite is everything around it: which step of
 * the sale is on screen, an open tender panel with an amount half typed, the
 * five-second undo of a removed line. Unmounting the counter to look at a
 * stock alert throws all of that away, and the person coming back to a cart
 * that has silently reset to step one is the person who re-rings a sale.
 *
 * So the counter is rendered once and HIDDEN when another destination is
 * active — `hidden`, which takes it out of the accessibility tree and out of
 * the tab order, not merely out of view. Every other destination mounts on
 * demand and unmounts when it is left, which is also what §8.10 asks for:
 * a cashier's device should not be holding a reporting screen alive.
 *
 * The nav also carries the cart's line count, so somebody two screens away
 * can see that the cart is still there rather than having to go and check.
 *
 * ---------------------------------------------------------------------------
 * 2. PERMISSIONS HIDE. THEY DO NOT AUTHORISE.
 * ---------------------------------------------------------------------------
 * A destination whose capability this session does not hold is not offered —
 * a courtesy that saves somebody walking into a refusal. It is NOT a control:
 * the server re-authorises every read and every write at ingest, and this
 * file is editable by anyone holding the tablet. Nothing may ever be reasoned
 * about "safely" on the grounds that its tab is hidden (CLAUDE.md §2.6).
 *
 * When the capability list cannot be fetched, everything is offered and the
 * screen behind each tab says what it cannot answer. See `data/api/session.ts`
 * for why guessing the other way is worse.
 *
 * ---------------------------------------------------------------------------
 * 3. THE SHELL KNOWS NO TENANT WORDS
 * ---------------------------------------------------------------------------
 * "Counter", "Sales", "Reports", "Stock" are PRODUCT chrome (§8.9). Anything
 * that is one tenant's word for one tenant's thing — a location type, a role,
 * a customer segment, a price list — arrives as configuration and is rendered
 * from data, never typed into this file.
 *
 * ---------------------------------------------------------------------------
 * ADDING A DESTINATION
 * ---------------------------------------------------------------------------
 * Add a row to `VIEWS`, add its case to `renderView`, and give it a
 * capability code if the server guards it. If it reads from the server, its
 * screen must handle `ServerUnavailable` — there is no shared fallback that
 * would render an empty state for it, deliberately.
 */
import { Suspense, lazy, useState, type ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import type { ApiCallOptions } from '../../data/api/client';
import { CAPABILITY, holdsCapability, type PermissionsState } from '../../data/api/session';
import { countCartLines, getOpenCart } from '../../data/queries/cart';
import { useLiveQuery } from '../../data/use-live-query';
import { Counter } from '../counter/Counter';
import { SalesList } from '../sales/SalesList';
import { ServerPending } from './ServerAnswer';
import { Icon, type IconName } from '../../ui/Icon';

// §8.10: a cashier's device should never parse the reporting screen's
// JavaScript. The counter and its own sales are in the initial chunk because
// they are what the till is for; everything else is fetched the first time
// somebody asks for it, and is then in the precache like any other asset.
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
const Deliveries = lazy(async () => ({
  default: (await import('../deliveries/Deliveries')).Deliveries,
}));

export type ViewId =
  | 'counter'
  | 'sales'
  | 'reports'
  | 'stock'
  | 'adjust'
  | 'credit'
  | 'receive'
  | 'buying'
  | 'suppliers'
  | 'deliveries';

interface ViewDef {
  readonly id: ViewId;
  /** Product chrome. Never tenant vocabulary. */
  readonly label: string;
  readonly icon: IconName;
  /** The PLATFORM capability that makes this worth offering. Null = always. */
  readonly requires: string | null;
  /** Kept alive across navigation. True for exactly one destination, and why. */
  readonly keepMounted: boolean;
}

const VIEWS: readonly ViewDef[] = [
  { id: 'counter', label: 'Counter', icon: 'cart', requires: null, keepMounted: true },
  // Local data, so it works offline and needs no capability: these are this
  // device's own sales, which it already holds.
  { id: 'sales', label: 'Sales', icon: 'receipt', requires: null, keepMounted: false },
  { id: 'reports', label: 'Reports', icon: 'tag', requires: CAPABILITY.reportLocation, keepMounted: false },
  { id: 'stock', label: 'Stock', icon: 'alert', requires: CAPABILITY.stockView, keepMounted: false },
  // The only destination here that WRITES, and the only one that works with
  // the radio off: an adjustment goes into the same ordered outbox a sale does
  // (features/inventory/StockAdjust.tsx). Kept out of the counter's initial
  // chunk all the same — a cashier who holds no `stock.adjust` never parses it.
  { id: 'adjust', label: 'Adjust', icon: 'undo', requires: CAPABILITY.stockAdjust, keepMounted: false },
  // Strictly online: the credit book is in no sync bucket, so the screen
  // behind this tab says so rather than showing a balance it cannot stand
  // behind (features/credit/Credit.tsx).
  { id: 'credit', label: 'Credit', icon: 'clock', requires: CAPABILITY.creditView, keepMounted: false },
  // ── Phase 2 ──────────────────────────────────────────────────────────────
  // The SECOND destination that writes, and the second that works with the
  // radio off: a goods receipt goes into the same ordered outbox a sale does
  // (features/receiving/Receiving.tsx). `goods.receive` is deliberately not
  // `purchase.order.approve` — one person who can authorise an order and also
  // sign for its goods can fabricate a receipt against an order they invented.
  { id: 'receive', label: 'Receive', icon: 'download', requires: CAPABILITY.goodsReceive, keepMounted: false },
  // Strictly online: orders and suppliers are in no sync bucket, and raising
  // or approving one is a commitment against terms a partitioned device may
  // hold a stale copy of. The screens behind these tabs say so.
  { id: 'buying', label: 'Buying', icon: 'receipt', requires: CAPABILITY.purchaseOrderView, keepMounted: false },
  { id: 'suppliers', label: 'Supply', icon: 'tag', requires: CAPABILITY.supplierView, keepMounted: false },
  // "Where is my order?" is a counter question, so `logistics.delivery.view`
  // is the wider grant. A status move rides the outbox; booking a load does
  // not (features/deliveries/Deliveries.tsx).
  { id: 'deliveries', label: 'On the road', icon: 'sync', requires: CAPABILITY.deliveryView, keepMounted: false },
];

export interface ShellProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  /** The persistent sync status (§8.4). Rendered by the caller, placed here. */
  readonly status: ReactNode;
  /** Non-blocking device notices, if any. */
  readonly notice?: ReactNode;
  /** Test seam for the server reads behind Reports and Stock. */
  readonly apiOptions?: ApiCallOptions;
}

export function Shell({ db, permissions, status, notice, apiOptions }: ShellProps): ReactNode {
  const [view, setView] = useState<ViewId>('counter');

  // The cart's size, read live, so the badge on the Counter tab is right from
  // any other screen. Deliberately a count and not the total: a number of
  // lines is unambiguous at a glance, and a money figure on a nav item would
  // be one more place a stale amount could appear.
  const cartLines = useLiveQuery(
    db,
    async (d) => {
      const cart = await getOpenCart(d);
      return countCartLines(d, cart?.id ?? null);
    },
    [],
  );
  const lineCount = cartLines ?? 0;

  const offered = VIEWS.filter((v) => v.requires === null || holdsCapability(permissions, v.requires));
  // If the active destination stops being offered — a capability list arrives
  // and it is narrower than this device assumed — fall back to the counter
  // rather than render a screen with no way back to it.
  const active = offered.some((v) => v.id === view) ? view : 'counter';

  return (
    <div className="app-shell">
      {/* Status and the destinations travel together as one sticky app bar, so
          the connection state is never scrolled off the screen — it is the
          answer to "did that sale go?" and it has to be there when asked. */}
      <header className="app-bar">
        {status}
        {notice}
        <nav className="view-switch" aria-label="Main">
          {offered.map((v) => {
            const badge = v.id === 'counter' && lineCount > 0 ? lineCount : null;
            return (
              <button
                key={v.id}
                type="button"
                className="view-switch-item pressable"
                aria-current={active === v.id}
                {...(badge === null
                  ? {}
                  : {
                      'aria-label': `${v.label} — ${String(badge)} ${badge === 1 ? 'line' : 'lines'} in the cart`,
                    })}
                onClick={() => setView(v.id)}
              >
                <Icon name={v.icon} size={20} />
                <span className="view-switch-label">{v.label}</span>
                {badge === null ? null : (
                  <span className="view-switch-badge tabular" aria-hidden="true">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </header>
      <main className="app-main">
        {/* The counter is always rendered; `hidden` removes it from the
            accessibility tree and the tab order without unmounting it. */}
        <div className="view-pane" hidden={active !== 'counter'}>
          <Counter db={db} />
        </div>
        {active === 'sales' ? <SalesList db={db} /> : null}
        {/* The fallback is the same skeleton a server read shows, so arriving
            at a destination never flashes a blank screen — on these devices
            the chunk comes off eMMC, and that is not instant. */}
        {active === 'reports' ? (
          <Suspense fallback={<ServerPending what="Reporting" rows={2} />}>
            <Reports db={db} permissions={permissions} {...(apiOptions === undefined ? {} : { apiOptions })} />
          </Suspense>
        ) : null}
        {active === 'stock' ? (
          <Suspense fallback={<ServerPending what="The low-stock list" rows={4} />}>
            <LowStock db={db} permissions={permissions} {...(apiOptions === undefined ? {} : { apiOptions })} />
          </Suspense>
        ) : null}
        {/* No `apiOptions`: this screen never talks to the API. It reads local
            rows and writes to the local outbox, which is what lets it work in
            a partition. */}
        {active === 'adjust' ? (
          <Suspense fallback={<ServerPending what="Stock adjustments" rows={3} />}>
            <StockAdjust db={db} permissions={permissions} />
          </Suspense>
        ) : null}
        {active === 'credit' ? (
          <Suspense fallback={<ServerPending what="The credit position" rows={3} />}>
            <Credit db={db} permissions={permissions} {...(apiOptions === undefined ? {} : { apiOptions })} />
          </Suspense>
        ) : null}
        {active === 'receive' ? (
          <Suspense fallback={<ServerPending what="Deliveries expected here" rows={3} />}>
            <Receiving db={db} permissions={permissions} {...(apiOptions === undefined ? {} : { apiOptions })} />
          </Suspense>
        ) : null}
        {active === 'buying' ? (
          <Suspense fallback={<ServerPending what="The order list" rows={3} />}>
            <Purchasing db={db} permissions={permissions} {...(apiOptions === undefined ? {} : { apiOptions })} />
          </Suspense>
        ) : null}
        {active === 'suppliers' ? (
          <Suspense fallback={<ServerPending what="The supplier list" rows={3} />}>
            <Suppliers db={db} permissions={permissions} {...(apiOptions === undefined ? {} : { apiOptions })} />
          </Suspense>
        ) : null}
        {active === 'deliveries' ? (
          <Suspense fallback={<ServerPending what="The delivery list" rows={3} />}>
            <Deliveries db={db} permissions={permissions} {...(apiOptions === undefined ? {} : { apiOptions })} />
          </Suspense>
        ) : null}
      </main>
    </div>
  );
}
