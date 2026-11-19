import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import type { LocalDb } from './data/db';
import { authMode, deviceAuth } from './data/auth/runtime';
import { openLocalDb, readApiBearerToken, syncConfigured } from './data/powersync';
import type { DeviceLocationState } from './data/session/device-location';
import type { DevicePriceListState } from './data/session/device-price-list';
import { AuthGate } from './features/auth/AuthGate';
import { seedDevDataIfEmpty } from './data/seed';
import { reconcileDeviceLocation } from './data/session/device-location';
import { reconcileCurrencySpec } from './data/session/currency-spec';
import { reconcileDevicePriceList } from './data/session/device-price-list';
import { setupServiceWorker } from './sw/register';
import './app.css';

async function bootstrap(): Promise<void> {
  setupServiceWorker();
  const db = await openLocalDb();

  // BROWSER TESTS ONLY. `import.meta.env.MODE` is a build-time literal: in
  // every build but `--mode e2e` this is `if (false)`, and the branch and its
  // chunk are dropped. e2e/build-guard.spec.ts proves the production bundle
  // carries no trace of it. See src/e2e/download-seam.ts for what it may write.
  if (import.meta.env.MODE === 'e2e') {
    const { applyE2eDownload } = await import('./e2e/download-seam');
    await applyE2eDownload(db);
  }

  // ── ORDER MATTERS, AND IT IS LOAD-BEARING ────────────────────────────────
  // 1. The dev seed runs first. It is a FLOOR under a device with nothing —
  //    placeholder catalogue, placeholder CurrencySpec, placeholder location —
  //    so local-only mode is fully usable with zero backend.
  //
  //    In SYNC mode it writes only the placeholder CurrencySpec, and no synced
  //    table at all. That is not tidiness: a local write to a synced table sits
  //    in PowerSync's own queue and stops it applying ANY download, so the
  //    seeded floor froze the very rows it was standing in for — the counter
  //    waited on a price-list gate that could never clear (data/seed.ts).
  await seedDevDataIfEmpty(db, { syncConfigured: syncConfigured() });
  // 2. Then the session reconciles, and in sync mode it OVERWRITES the
  //    location the seed just wrote. That direction is not a preference: the
  //    seeded location is a placeholder that matches no row the server knows,
  //    and the API checks every write against the token's `locs` claim
  //    (`assertLocationInScope`, apps/api/src/trpc.ts). A sale filed against
  //    the placeholder is answered FORBIDDEN — every time, at a counter, hours
  //    after the customer left. The token's location wins, always.
  //
  //    This runs on EVERY start, not once at install: a device re-assigned to
  //    another location picks that up the next time it is switched on.
  const bearerToken = readApiBearerToken();
  const deviceLocation = await reconcileDeviceLocation(db, bearerToken);
  // 3. Then the price list, AFTER the location — "which list applies here" has
  //    no answer until "here" does. Same direction as step 2 and for the same
  //    reason: the seed points this device at a placeholder list coded
  //    'DEFAULT', which no tenant has, so a sale rung against it is recorded
  //    locally and then refused at upload (`no price list DEFAULT in force`).
  //    Unlike the location, the answer is not in the token — there is no
  //    price-list claim — it is in the tenant's own synced configuration:
  //    which lists cover this counter, in force today, ranked by the tenant.
  const devicePriceList = await reconcileDevicePriceList(db, bearerToken);
  // 4. And WHAT IT PRICES IN. The dev seed's placeholder CurrencySpec is a
  //    test currency and a generic sign; the tenant's real one is in the
  //    jurisdiction pack, over the sync stream (data/session/currency-spec.ts).
  //    That reconciler was written and never called, so a synced, trading till
  //    printed the placeholder glyph at a real customer. It is additive and
  //    never blocks: a pack that has not arrived leaves what the device has.
  await reconcileCurrencySpec(db, bearerToken !== null);

  const container = document.getElementById('root');
  if (container === null) throw new Error('missing #root element');

  // ── THE DEVICE PATH (production) ─────────────────────────────────────────
  // No token in the build: the device enrols, a person signs in, a PIN
  // unlocks. Steps 2–4 above re-run per UNLOCKED SESSION, because "which
  // counter is this, for whom" is the session's answer, not the build's.
  const auth = deviceAuth();
  if (authMode() === 'device' && auth !== null) {
    createRoot(container).render(
      <AuthGate auth={auth}>{(userId) => <DeviceSessionApp key={userId} db={db} />}</AuthGate>,
    );
    return;
  }

  // ── THE DEV-BEARER AND LOCAL-ONLY PATHS ─────────────────────────────────
  createRoot(container).render(
    <App db={db} deviceLocation={deviceLocation} devicePriceList={devicePriceList} />,
  );
}

/** Reconcile this session's location, price list and currency, then the app. */
function DeviceSessionApp({ db }: { readonly db: LocalDb }): ReactNode {
  const [ready, setReady] = useState<{ location: DeviceLocationState; priceList: DevicePriceListState } | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const descriptor = readApiBearerToken();
      const location = await reconcileDeviceLocation(db, descriptor);
      const priceList = await reconcileDevicePriceList(db, descriptor);
      await reconcileCurrencySpec(db, descriptor !== null);
      if (live) setReady({ location, priceList });
    })();
    return () => {
      live = false;
    };
  }, [db]);
  if (ready === null) return null;
  return <App db={db} deviceLocation={ready.location} devicePriceList={ready.priceList} />;
}

void bootstrap();
