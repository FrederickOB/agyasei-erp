import { router } from '../trpc.js';
import { catalogueRouter } from './catalogue.js';
import { creditRouter } from './credit.js';
import { inventoryRouter } from './inventory.js';
import { provisioningRouter } from './provisioning.js';
import { salesRouter } from './sales.js';
import { sequenceRouter } from './sequence.js';

export const appRouter = router({
  provisioning: provisioningRouter,
  catalogue: catalogueRouter,
  inventory: inventoryRouter,
  sales: salesRouter,
  credit: creditRouter,
  sequence: sequenceRouter,
});

export type AppRouter = typeof appRouter;
