/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHELL — two rooms, and the rules a new screen has to follow
 * ═══════════════════════════════════════════════════════════════════════════
 * Read this before adding a destination. Everything below is a decision, not
 * a default, and each one has a counter behind it.
 *
 * The product has TWO ROOMS (docs/design/back-office-dashboard.html):
 *   · the COUNTER room — this file's layout: a sticky app bar, a segmented
 *     switch, the cart dock. Task-first, built for a queue and a thumb.
 *   · the BACK OFFICE — `features/office/OfficeShell`: a rail, a top bar and
 *     a dashboard. Overview-first, scanned rather than operated. A lazy chunk
 *     a counter-only session never downloads.
 * `features/office/room.ts` decides where a session lands. The default is
 * the counter; the office is a room somebody chose.
 *
 * ---------------------------------------------------------------------------
 * 1. THE COUNTER IS NEVER UNMOUNTED — IN EITHER ROOM
 * ---------------------------------------------------------------------------
 * The cart survives a battery pull, because it lives in local-only SQLite
 * (§8.2). What does NOT live in SQLite is everything around it: which step of
 * the sale is on screen, an open tender panel with an amount half typed, the
 * five-second undo of a removed line. Unmounting the counter to look at a
 * stock alert — or the dashboard — throws all of that away, and the person
 * coming back to a cart that has silently reset to step one is the person
 * who re-rings a sale.
 *
 * So the counter is rendered once and HIDDEN when another destination or the
 * other room is active — `hidden`, which takes it out of the accessibility
 * tree and out of the tab order, not merely out of view. Every other
 * destination mounts on demand and unmounts when it is left (§8.10).
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
 * "Counter", "Sales", "Reports", "Stock", "Office" are PRODUCT chrome (§8.9).
 * Anything that is one tenant's word for one tenant's thing — a location
 * type, a role, a customer segment, a price list — arrives as configuration
 * and is rendered from data, never typed into this file.
 *
 * ---------------------------------------------------------------------------
 * ADDING A DESTINATION
 * ---------------------------------------------------------------------------
 * Add a row to `DESTINATIONS` in `destinations.tsx` and its case to
 * `renderDestination`. Both rooms pick it up. If it reads from the server,
 * its screen must handle `ServerUnavailable` — there is no shared fallback
 * that would render an empty state for it, deliberately.
 */
import { Suspense, lazy, useState, type ReactNode } from 'react';
import type { LocalDb } from '../../data/db';
import type { ApiCallOptions } from '../../data/api/client';
import { holdsCapability, type PermissionsState } from '../../data/api/session';
import { countCartLines, getOpenCart } from '../../data/queries/cart';
import { useLiveQuery } from '../../data/use-live-query';
import { Counter } from '../counter/Counter';
import { officeOffered, rememberRoom, rememberedRoom, type Room } from '../office/room';
import { SalesList } from '../sales/SalesList';
import { DESTINATIONS, renderDestination, type DestinationId } from './destinations';
import { ServerPending } from './ServerAnswer';
import { Icon, type IconName } from '../../ui/Icon';

const OfficeShell = lazy(async () => ({
  default: (await import('../office/OfficeShell')).OfficeShell,
}));

export type ViewId = 'counter' | 'sales' | DestinationId;

interface ViewDef {
  readonly id: ViewId;
  /** Product chrome. Never tenant vocabulary. */
  readonly label: string;
  readonly icon: IconName;
  /** The PLATFORM capability that makes this worth offering. Null = always. */
  readonly requires: string | null;
}

const VIEWS: readonly ViewDef[] = [
  { id: 'counter', label: 'Counter', icon: 'cart', requires: null },
  // Local data, so it works offline and needs no capability: these are this
  // device's own sales, which it already holds.
  { id: 'sales', label: 'Sales', icon: 'receipt', requires: null },
  ...DESTINATIONS.map((d) => ({ id: d.id, label: d.label, icon: d.icon, requires: d.requires })),
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
  const [room, setRoomState] = useState<Room>(() => rememberedRoom());
  const setRoom = (next: Room): void => {
    rememberRoom(next);
    setRoomState(next);
  };

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
  // Same rule for the room: a remembered office is honoured only while the
  // session can still hold something the office shows.
  const officeAvailable = officeOffered(permissions);
  const inOffice = room === 'office' && officeAvailable;

  return (
    <>
      {inOffice ? (
        <Suspense fallback={<ServerPending what="The office" rows={4} />}>
          <OfficeShell
            db={db}
            permissions={permissions}
            status={status}
            notice={notice}
            {...(apiOptions === undefined ? {} : { apiOptions })}
            onOpenCounter={() => setRoom('counter')}
            cartLines={lineCount}
          />
        </Suspense>
      ) : null}
      <div className="app-shell" hidden={inOffice}>
        {/* Status and the destinations travel together as one sticky app bar, so
            the connection state is never scrolled off the screen — it is the
            answer to "did that sale go?" and it has to be there when asked. */}
        <header className="app-bar">
          {status}
          {notice}
          {officeAvailable ? (
            <button
              type="button"
              className="office-door pressable"
              onClick={() => setRoom('office')}
              aria-label="Open the office"
            >
              <Icon name="grid" size={18} />
              <span>Office</span>
            </button>
          ) : null}
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
            <Counter
              db={db}
              permissions={permissions}
              {...(apiOptions === undefined ? {} : { apiOptions })}
              onOpenPrinterSettings={() => setView('printer')}
            />
          </div>
          {active === 'sales' ? (
            <SalesList db={db} onOpenPrinterSettings={() => setView('printer')} />
          ) : null}
          {active !== 'counter' && active !== 'sales'
            ? renderDestination(active, { db, permissions, apiOptions })
            : null}
        </main>
      </div>
    </>
  );
}
