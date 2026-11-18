/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BACK OFFICE — the second room
 * ═══════════════════════════════════════════════════════════════════════════
 * A light SaaS overview (docs/design/mockups/office-dashboard.html): the
 * tenant's mark and the session's scope on the left, pill tabs across the
 * top, the sync chip and the way back to the counter on the right, and a
 * page below. It looks nothing like the counter on purpose — the counter is
 * a tool for a queue; this is a page for a desk.
 *
 * What it inherits from the counter room, unchanged:
 *   · Permissions HIDE, they do not authorise (Shell.tsx rule 2).
 *   · No tenant words in the chrome (rule 3). "Dashboard", "Reports",
 *     "Stock" are product copy; the tenant's name is DATA, rendered from the
 *     session, and the mark is its initials.
 *   · The status bar is persistent chrome, never a toast (§8.4). Here it is
 *     the same component wearing the office's chip.
 *
 * What it does NOT own: the counter. The counter stays mounted in Shell.tsx
 * while this room is open — a mis-tap into the office must not reset a sale.
 * This component is itself a lazy chunk, so a counter-only session never
 * downloads a page it would never see (§8.10).
 */
import { Suspense, lazy, useState, type ReactNode } from 'react';
import { holdsCapability, type PermissionsState } from '../../data/api/session';
import type { LocalDb } from '../../data/db';
import type { ApiCallOptions } from '../../data/api/client';
import { Icon } from '../../ui/Icon';
import { DESTINATIONS, renderDestination, type DestinationId } from '../shell/destinations';
import { ServerPending } from '../shell/ServerAnswer';

const Dashboard = lazy(async () => ({ default: (await import('./Dashboard')).Dashboard }));
// The office has its own reporting page — periods, comparisons, charts, CSV.
// The counter room keeps the plain one for an outlet manager on a tablet.
const OfficeReports = lazy(async () => ({ default: (await import('./Reports')).OfficeReports }));

export type OfficeViewId = 'dashboard' | DestinationId;

export interface OfficeShellProps {
  readonly db: LocalDb;
  readonly permissions: PermissionsState;
  readonly status: ReactNode;
  readonly notice?: ReactNode;
  readonly apiOptions?: ApiCallOptions;
  /** Back to the till. */
  readonly onOpenCounter: () => void;
  /** Lines in the open cart, so the way back says the cart is still there. */
  readonly cartLines: number;
  /** The tenant's own name, from the session. Absent until it is known. */
  readonly tenantName?: string | undefined;
}

/** "Agyasei Jnr & Company Limited" → "AJ". Initials of the first two words. */
function markFor(name: string | undefined): string {
  if (name === undefined) return '·';
  const words = name.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w));
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function OfficeShell({
  db,
  permissions,
  status,
  notice,
  apiOptions,
  onOpenCounter,
  cartLines,
  tenantName,
}: OfficeShellProps): ReactNode {
  const [view, setView] = useState<OfficeViewId>('dashboard');
  // The two outbox writers are counter work; the office does not offer them.
  const offered = DESTINATIONS.filter((d) => !d.counterWork && holdsCapability(permissions, d.requires));
  const active: OfficeViewId =
    view === 'dashboard' || offered.some((d) => d.id === view) ? view : 'dashboard';
  const props = { db, permissions, apiOptions };

  return (
    <div className="office">
      <header className="office-top">
        <div className="office-bar">
          <div className="office-brand" title={tenantName}>
            <span className="office-brand-mark" aria-hidden="true">
              {markFor(tenantName)}
            </span>
            <span>
              {tenantName ?? 'Back office'}
              {tenantName === undefined ? null : <small>Back office</small>}
            </span>
          </div>
          <nav className="office-tabs" aria-label="Office">
            <button
              type="button"
              className="office-tab pressable"
              aria-current={active === 'dashboard' ? 'page' : undefined}
              onClick={() => setView('dashboard')}
            >
              Dashboard
            </button>
            {offered.map((d) => (
              <button
                key={d.id}
                type="button"
                className="office-tab pressable"
                aria-current={active === d.id ? 'page' : undefined}
                onClick={() => setView(d.id)}
              >
                {d.label}
              </button>
            ))}
          </nav>
          <div className="office-right">
            <div className="office-status">{status}</div>
            <button
              type="button"
              className="office-iconbtn pressable"
              onClick={onOpenCounter}
              aria-label={
                cartLines > 0
                  ? `Open counter — ${String(cartLines)} ${cartLines === 1 ? 'line' : 'lines'} in the cart`
                  : 'Open counter'
              }
            >
              <Icon name="cart" size={16} />
              {cartLines > 0 ? (
                <span className="office-iconbtn-count tabular" aria-hidden="true">
                  {cartLines}
                </span>
              ) : null}
            </button>
          </div>
        </div>
        {notice}
      </header>
      <main className="office-main">
        {active === 'dashboard' ? (
          <Suspense fallback={<ServerPending what="The dashboard" rows={4} />}>
            <Dashboard {...props} onOpen={(id) => setView(id)} />
          </Suspense>
        ) : active === 'reports' ? (
          <Suspense fallback={<ServerPending what="Reporting" rows={4} />}>
            <OfficeReports {...props} />
          </Suspense>
        ) : (
          renderDestination(active, props)
        )}
      </main>
    </div>
  );
}
