import { createRoot } from 'react-dom/client';
import { App } from './App';
import { openLocalDb } from './data/powersync';
import { seedDevDataIfEmpty } from './data/seed';
import { setupServiceWorker } from './sw/register';
import './app.css';

async function bootstrap(): Promise<void> {
  setupServiceWorker();
  const db = await openLocalDb();
  // Dev convenience only: local-only mode seeds a placeholder catalogue and a
  // placeholder CurrencySpec so the app is fully usable with zero backend.
  await seedDevDataIfEmpty(db);

  const container = document.getElementById('root');
  if (container === null) throw new Error('missing #root element');
  createRoot(container).render(<App db={db} />);
}

void bootstrap();
