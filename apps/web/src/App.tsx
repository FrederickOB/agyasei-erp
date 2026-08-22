/**
 * The shell: permanent status bar, two-tab navigation (counter / recent
 * sales). Until the tenant's currency configuration exists locally the app
 * shows a provisioning state — it never invents a currency (§8.9).
 *
 * Three gates come before the counter, in this order:
 *   1. WHERE this device is. A device whose session cannot tell it which
 *      counter it stands at may not sell, and is told which of the two
 *      possible reasons applies (§8.1: name the specific failure and the fix).
 *      This gate comes first because it needs no currency to be honest about,
 *      and because the next gate's question is "which list applies HERE".
 *   2. WHAT PRICES it charges. A device pointed at a price list its tenant
 *      does not have records sales the server then refuses — so it does not
 *      sell until the tenant's own configuration names one for this counter.
 *   3. WHAT it prices in. No CurrencySpec, no counter — never a fallback
 *      symbol. The spec itself is reconciled from the tenant's jurisdiction
 *      pack (data/session/currency-spec.ts), never invented here.
 *
 * The price-list state is re-derived through `useLiveQuery`, unlike the
 * location. The location's answer is in the token and is fixed for the
 * session; the price list's answer is in SYNCED ROWS that may still be on
 * their way, so this gate has to dismiss itself when they land — and has to
 * re-run after a location is chosen, because that changes the question.
 */
import { useCallback, useState, type ReactNode } from 'react';
import type { LocalDb } from './data/db';
import { countCartLines, getOpenCart } from './data/queries/cart';
import { reconcileCurrencySpec } from './data/session/currency-spec';
import { useLiveQuery } from './data/use-live-query';
import { Counter } from './features/counter/Counter';
import { SalesList } from './features/sales/SalesList';
import { StatusBar } from './features/shell/StatusBar';
import { useUpdateReady } from './features/shell/use-update';
import { CurrencyProvider } from './money/CurrencyContext';
import { Icon } from './ui/Icon';
import { readApiBearerToken, syncConfigured } from './data/powersync';
import { blocksSales, type DeviceLocationState } from './data/session/device-location';
import {
  blocksSales as priceListBlocksSales,
  reconcileDevicePriceList,
  type DevicePriceListState,
} from './data/session/device-price-list';
import { DeviceLocationGate } from './features/setup/DeviceLocationGate';
import { DevicePriceListGate } from './features/setup/DevicePriceListGate';
import { applyUpdateIfSanctioned } from './sw/register';
import { useSyncStatus } from './state/use-sync-status';

type View = 'counter' | 'sales';

export interface AppProps {
  readonly db: LocalDb;
  /** Reconciled against the session at startup (main.tsx), on every start. */
  readonly deviceLocation: DeviceLocationState;
  /** Reconciled against the tenant's price lists at startup, and live after. */
  readonly devicePriceList: DevicePriceListState;
}

export function App({ db, deviceLocation, devicePriceList }: AppProps): ReactNode {
  const [view, setView] = useState<View>('counter');
  const [location, setLocation] = useState<DeviceLocationState>(deviceLocation);
  // Keyed on the TEXT, not a boolean. Two things can raise a notice now, and a
  // dismissal of one must not swallow the other: "this device has moved
  // counter" and "this device now charges different prices" are separately
  // load-bearing, and the second arriving after the first was waved away is
  // exactly when someone most needs to see it.
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const bearerToken = readApiBearerToken();
  // Re-derived like the price list, and for the same reason: the tenant's
  // currency is in a synced row that may still be arriving, and a till holding
  // the dev placeholder must upgrade itself the moment the pack lands rather
  // than print a test currency's sign until someone reloads it.
  const spec = useLiveQuery(
    db,
    async (d) => (await reconcileCurrencySpec(d, bearerToken !== null)).spec,
    [bearerToken],
  );
  // Re-runs the SAME policy rather than reimplementing it, on every local
  // change and — since downloads now ring the change bus (data/powersync.ts) —
  // on every arrival of synced rows. It settles: reconciliation writes only
  // when the stored value and the configuration disagree, so the pass after a
  // write is a no-op.
  const livePriceList = useLiveQuery(
    db,
    (d) => reconcileDevicePriceList(d, bearerToken),
    [bearerToken],
  );
  const priceList = livePriceList ?? devicePriceList;
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
        bearerToken={bearerToken}
        onChosen={setLocation}
      />
    );
  }

  if (priceListBlocksSales(priceList)) {
    // Also before the currency gate: a till that cannot name its price list
    // must not take a sale, and "we are still receiving your price lists" is
    // a more useful thing to say than "setting up this till".
    return (
      <DevicePriceListGate
        db={db}
        state={priceList}
        bearerToken={bearerToken}
        // Nothing to hold: the choice writes, the write rings the change bus,
        // and the live query above re-derives the state through the same
        // policy. A local copy here would be a second answer to one question.
        onChosen={() => undefined}
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
        <span className="gate-crest waiting">
          <Icon name="sync" size={28} />
        </span>
        <h1>Setting up this till</h1>
        <p>
          This device has no configuration yet. It will be ready once provisioning completes on
          first sync.
        </p>
      </main>
    );
  }

  // Only the non-blocking messages reach here — a blocking one was a gate.
  const notices = [location.message, priceList.message].filter(
    (m): m is string => m !== null && m.length > 0,
  );
  const notice = notices.length > 0 ? notices.join(' ') : null;

  return (
    <CurrencyProvider spec={spec}>
      <div className="app-shell">
        {/* Status and view switch travel together as one sticky app bar, so
            the connection state is never scrolled off the screen — it is the
            answer to "did that sale go?" and it has to be there when asked. */}
        <header className="app-bar">
          <StatusBar
            state={syncState}
            localOnly={!syncConfigured()}
            updateReady={updateReady}
            onApplyUpdate={onApplyUpdate}
          />
          {notice !== null && notice !== dismissedNotice ? (
            // A reconciliation that MOVED this device says so, out loud, once —
            // the previous location is not being traded on any more, or the
            // prices it charges have changed to the ones this counter is set up
            // for, and whoever is standing here should know before the first
            // sale. Both are the same kind of news, so they share one notice.
            <p className="device-notice" role="status">
              <Icon name="pin" size={20} />
              <span>{notice}</span>
              <button type="button" className="pressable" onClick={() => setDismissedNotice(notice)}>
                Got it
              </button>
            </p>
          ) : null}
          {/* TWO views, mutually exclusive: a segmented control, not tabs and
              not a bottom bar. The bottom of a phone screen is the only part a
              thumb reaches without regripping, and on this app it belongs to
              the cart — putting navigation there would have the till's primary
              action and its navigation fighting over the same 56px. */}
          <nav className="view-switch" aria-label="Main">
            <button
              type="button"
              className="view-switch-item pressable"
              aria-current={view === 'counter'}
              onClick={() => setView('counter')}
            >
              <Icon name="cart" size={20} />
              Counter
            </button>
            <button
              type="button"
              className="view-switch-item pressable"
              aria-current={view === 'sales'}
              onClick={() => setView('sales')}
            >
              <Icon name="receipt" size={20} />
              Recent sales
            </button>
          </nav>
        </header>
        <main className="app-main">
          {view === 'counter' ? <Counter db={db} /> : <SalesList db={db} />}
        </main>
      </div>
    </CurrencyProvider>
  );
}
