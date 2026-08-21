import { createRoot } from 'react-dom/client';
import { App } from './App';
import { openLocalDb, readApiBearerToken } from './data/powersync';
import { seedDevDataIfEmpty } from './data/seed';
import { reconcileDeviceLocation } from './data/session/device-location';
import { setupServiceWorker } from './sw/register';
import './app.css';

async function bootstrap(): Promise<void> {
  setupServiceWorker();
  const db = await openLocalDb();

  // ── ORDER MATTERS, AND IT IS LOAD-BEARING ────────────────────────────────
  // 1. The dev seed runs first. It is a FLOOR under a device with nothing —
  //    placeholder catalogue, placeholder CurrencySpec, placeholder location —
  //    so local-only mode is fully usable with zero backend.
  await seedDevDataIfEmpty(db);
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
  const deviceLocation = await reconcileDeviceLocation(db, readApiBearerToken());

  const container = document.getElementById('root');
  if (container === null) throw new Error('missing #root element');
  createRoot(container).render(<App db={db} deviceLocation={deviceLocation} />);
}

void bootstrap();
