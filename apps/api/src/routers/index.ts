import { router } from '../trpc.js';
import { catalogueRouter } from './catalogue.js';
import { creditRouter } from './credit.js';
import { inventoryRouter } from './inventory.js';
import { provisioningRouter } from './provisioning.js';
import { reportsRouter } from './reports.js';
import { salesRouter } from './sales.js';
import { sequenceRouter } from './sequence.js';
import { sessionRouter } from './session.js';

export const appRouter = router({
  provisioning: provisioningRouter,
  session: sessionRouter,
  catalogue: catalogueRouter,
  inventory: inventoryRouter,
  sales: salesRouter,
  credit: creditRouter,
  sequence: sequenceRouter,
  reports: reportsRouter,
});

export type AppRouter = typeof appRouter;
