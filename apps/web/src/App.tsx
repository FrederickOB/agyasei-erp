/**
 * The shell: permanent status bar, two-tab navigation (counter / recent
 * sales). Until the tenant's currency configuration exists locally the app
 * shows a provisioning state — it never invents a currency (§8.9).
 *
 * Two gates come before the counter, in this order:
 *   1. WHERE this device is. A device whose session cannot tell it which
 *      counter it stands at may not sell, and is told which of the two
 *      possible reasons applies (§8.1: name the specific failure and the fix).
 *      This gate comes first because it needs no currency to be honest about.
 *   2. WHAT it prices in. No CurrencySpec, no counter — never a fallback
 *      symbol.
 */
import { useCallback, useState, type ReactNode } from 'react';
import type { LocalDb } from './data/db';
import { countCartLines, getOpenCart } from './data/queries/cart';
import { readCurrencySpec } from './data/queries/config';
import { useLiveQuery } from './data/use-live-query';
import { Counter } from './features/counter/Counter';
import { SalesList } from './features/sales/SalesList';
import { StatusBar } from './features/shell/StatusBar';
import { useUpdateReady } from './features/shell/use-update';
import { CurrencyProvider } from './money/CurrencyContext';
import { readApiBearerToken, syncConfigured } from './data/powersync';
import { blocksSales, type DeviceLocationState } from './data/session/device-location';
import { DeviceLocationGate } from './features/setup/DeviceLocationGate';
import { applyUpdateIfSanctioned } from './sw/register';
import { useSyncStatus } from './state/use-sync-status';

type View = 'counter' | 'sales';

export interface AppProps {
  readonly db: LocalDb;
  /** Reconciled against the session at startup (main.tsx), on every start. */
  readonly deviceLocation: DeviceLocationState;
}

export function App({ db, deviceLocation }: AppProps): ReactNode {
  const [view, setView] = useState<View>('counter');
  const [location, setLocation] = useState<DeviceLocationState>(deviceLocation);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const spec = useLiveQuery(db, readCurrencySpec, []);
  const syncState = useSyncStatus(db);
  const updateReady = useUpdateReady();

  const onApplyUpdate = useCallback(() => {
    void (async () => {
      // §8.11: apply only at a safe point — cart empty, no sale in flight.
      const cart = await getOpenCart(db);
      const lineCount = await countCartLines(db, cart?.id ?? null);
      await applyUpdateIfSanctioned({ cartEmpty: lineCount === 0, saleInFlight: false });
    })();
  }, [db]);

  if (blocksSales(location)) {
    // No currency needed to say this, and no half-working till behind it.
    return (
      <DeviceLocationGate
        db={db}
        state={location}
        bearerToken={readApiBearerToken()}
        onChosen={setLocation}
      />
    );
  }

  if (spec === undefined) {
    // First paint before the local read resolves — single frame, not a spinner.
    return null;
  }

  if (spec === null) {
    return (
      <main className="provisioning">
        <h1>Setting up this till</h1>
        <p>
          This device has no configuration yet. It will be ready once provisioning completes on
          first sync.
        </p>
      </main>
    );
  }

  return (
    <CurrencyProvider spec={spec}>
      <div className="app-shell">
        <StatusBar
          state={syncState}
          localOnly={!syncConfigured()}
          updateReady={updateReady}
          onApplyUpdate={onApplyUpdate}
        />
        {location.message !== null && !noticeDismissed ? (
          // A reconciliation that MOVED this device says so, out loud, once —
          // the previous location is not being traded on any more and whoever
          // is standing here should know that before the first sale.
          <p className="device-notice" role="status">
            <span>{location.message}</span>
            <button type="button" onClick={() => setNoticeDismissed(true)}>
              Got it
            </button>
          </p>
        ) : null}
        <nav className="tab-nav" aria-label="Main">
          <button
            type="button"
            className={`tab${view === 'counter' ? ' active' : ''}`}
            aria-current={view === 'counter'}
            onClick={() => setView('counter')}
          >
            Counter
          </button>
          <button
            type="button"
            className={`tab${view === 'sales' ? ' active' : ''}`}
            aria-current={view === 'sales'}
            onClick={() => setView('sales')}
          >
            Recent sales
          </button>
        </nav>
        <main className="app-main">
          {view === 'counter' ? <Counter db={db} /> : <SalesList db={db} />}
        </main>
      </div>
    </CurrencyProvider>
  );
}
