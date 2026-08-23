import { router } from '../trpc.js';
import { catalogueRouter } from './catalogue.js';
import { creditRouter } from './credit.js';
import { inventoryRouter } from './inventory.js';
import { logisticsRouter } from './logistics.js';
import { procurementRouter } from './procurement.js';
import { provisioningRouter } from './provisioning.js';
import { receivingRouter } from './receiving.js';
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
  // Phase 2 (CLAUDE.md §3). Mounted EMPTY and on purpose: the namespaces exist
  // so the agents that fill them change one file each and never this one — a
  // mount somebody forgot is how a written route ends up reachable by nothing
  // (docs/phase1-status.md §0). Owners and scope are in each file's header.
  procurement: procurementRouter, // suppliers, multi-source supply, purchase orders
  receiving: receivingRouter, // goods receipts matched against those orders
  logistics: logisticsRouter, // third-party dispatch and delivery status (ADR-0001)
});

export type AppRouter = typeof appRouter;
