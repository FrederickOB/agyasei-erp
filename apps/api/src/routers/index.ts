import { router } from '../trpc.js';
import { adminRouter } from './admin.js';
import { catalogueRouter } from './catalogue.js';
import { creditRouter } from './credit.js';
import { inventoryRouter } from './inventory.js';
import { ledgerRouter } from './ledger.js';
import { logisticsRouter } from './logistics.js';
import { procurementRouter } from './procurement.js';
import { provisioningRouter } from './provisioning.js';
import { receivingRouter } from './receiving.js';
import { reportsRouter } from './reports.js';
import { reviewRouter } from './review.js';
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
  // The human review queue (CLAUDE.md §2.2). Three writers filled it from
  // Phase 1; until this mount nothing could take a row out — see review.ts.
  review: reviewRouter,
  // Phase 2 (CLAUDE.md §3). Mounted EMPTY and on purpose: the namespaces exist
  // so the agents that fill them change one file each and never this one — a
  // mount somebody forgot is how a written route ends up reachable by nothing
  // (docs/phase1-status.md §0). Owners and scope are in each file's header.
  procurement: procurementRouter, // suppliers, multi-source supply, purchase orders
  receiving: receivingRouter, // goods receipts matched against those orders
  logistics: logisticsRouter, // third-party dispatch and delivery status (ADR-0001)
  // Phase 3 Track A's read surface. Read-only by construction — every
  // procedure is a query, and no write capability exists (see ledger.ts).
  ledger: ledgerRouter,
  // Go-live work package B: users, assignments, roles, devices (02 §2.4–§2.7).
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;
