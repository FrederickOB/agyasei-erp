/**
 * Shared drill setup: tenants, products, seeded prices, and the device
 * fleet. Devices:
 *
 *   A1, A2 — tenant A (agyasei-jnr), BOTH at OUT-01 Techiman Flagship: two
 *            real clients, two sqlite files, two identities, one location.
 *   A3     — tenant A at OUT-03 (Techiman Micro-Outlet 1): upload-only
 *            device for the cross-location HQ drill (D3).
 *   B1     — tenant B (kumasi-builders) at MAIN: the isolation probe (D5).
 */
import { rmSync, mkdirSync } from 'node:fs';
import { DrillDevice, pollUntil } from './device.js';
import { ServerDb } from './serverdb.js';
import { DRILL_DATA_DIR, loadDevTenants, todayBusinessDate, type DevTenants } from './env.js';

export interface ProductPick {
  id: string;
  skuCode: string;
  uomId: string;
}

export interface DrillContext {
  tenants: DevTenants;
  server: ServerDb;
  businessDate: string;
  runId: string;
  productA: ProductPick;
  productB: ProductPick;
  locA1: string; // OUT-01
  locA3: string; // OUT-03
  locB: string; // MAIN
  a1: DrillDevice;
  a2: DrillDevice;
  a3: DrillDevice;
  b1: DrillDevice;
}

export function saleOp(
  locationId: string,
  productId: string,
  receiptNo: string,
  businessDate: string,
  qty = '2',
): Record<string, unknown> {
  return {
    locationId,
    priceListCode: 'WHOLESALE',
    receiptNo,
    businessDate,
    tender: 'CASH',
    lines: [{ productId, qty }],
  };
}

export function movementOp(
  locationId: string,
  productId: string,
  qtyDelta: string,
  sourceKind: string,
  reasonCode: string,
  businessDate: string,
): Record<string, unknown> {
  return { locationId, productId, qtyDelta, sourceKind, reasonCode, businessDate };
}

export async function createContext(): Promise<DrillContext> {
  rmSync(DRILL_DATA_DIR, { recursive: true, force: true });
  mkdirSync(DRILL_DATA_DIR, { recursive: true });

  const tenants = loadDevTenants();
  const server = new ServerDb();
  const businessDate = todayBusinessDate();
  const runId = Date.now().toString(36);

  const [locA1, locA3, locB] = await Promise.all([
    server.locationByCode(tenants.tenantA.id, 'OUT-01'),
    server.locationByCode(tenants.tenantA.id, 'OUT-03'),
    server.locationByCode(tenants.tenantB.id, 'MAIN'),
  ]);
  const [productA, productB] = await Promise.all([
    server.pickProduct(tenants.tenantA.id),
    server.pickProduct(tenants.tenantB.id),
  ]);
  // Dev price seed (no price mutation API exists yet): GHS 25.00 / 40.00 per
  // unit expressed in e4 minor units — 25_000_000 e4 = 2500 minor.
  await server.seedWholesalePrice(tenants.tenantA.id, productA.id, 25_000_000n);
  await server.seedWholesalePrice(tenants.tenantB.id, productB.id, 40_000_000n);

  const a1 = new DrillDevice('device-a1', tenants.tenantA.id, locA1);
  const a2 = new DrillDevice('device-a2', tenants.tenantA.id, locA1);
  const a3 = new DrillDevice('device-a3', tenants.tenantA.id, locA3);
  const b1 = new DrillDevice('device-b1', tenants.tenantB.id, locB);
  await Promise.all([a1.open(), a2.open(), a3.open(), b1.open()]);

  return { tenants, server, businessDate, runId, productA, productB, locA1, locA3, locB, a1, a2, a3, b1 };
}

/** Online seed activity + first sync. Proves the upload path works before
 *  any timing starts, and gives every synced table rows on both tenants so
 *  the D5 absence assertions are non-vacuous. */
export async function warmUp(cx: DrillContext): Promise<void> {
  console.log('[setup] online seed writes through /sync/upload…');
  // Tenant A: opening stock at OUT-01 + a credit account (customer row).
  await cx.a1.recordToOutbox(
    'stock.record_movement',
    movementOp(cx.locA1, cx.productA.id, '500', 'OPENING', 'OPENING', cx.businessDate),
  );
  await cx.a1.recordToOutbox('credit.open_account', {
    newCustomer: { code: `CUST-A-${cx.runId}`, name: 'Drill Contractor A' },
    termsDays: 30,
    feeRateBpPerMonth: 200,
    creditLimitMinor: '1000000',
  });
  const acksA = await cx.a1.flushOutbox();
  // Tenant B: opening stock + a sale + a credit account, so tenant B has
  // rows in sale/sale_line/sale_tax_line/stock_movement/customer.
  await cx.b1.recordToOutbox(
    'stock.record_movement',
    movementOp(cx.locB, cx.productB.id, '200', 'OPENING', 'OPENING', cx.businessDate),
  );
  await cx.b1.recordToOutbox(
    'sale.create',
    saleOp(cx.locB, cx.productB.id, `B-${cx.runId}-1`, cx.businessDate, '3'),
  );
  await cx.b1.recordToOutbox('credit.open_account', {
    newCustomer: { code: `CUST-B-${cx.runId}`, name: 'Drill Contractor B' },
    termsDays: 30,
    feeRateBpPerMonth: 200,
    creditLimitMinor: '500000',
  });
  const acksB = await cx.b1.flushOutbox();
  const bad = [...acksA, ...acksB].filter((a) => a.status !== 'applied');
  if (bad.length > 0) {
    throw new Error(`setup writes not applied: ${JSON.stringify(bad)}`);
  }

  console.log('[setup] connecting devices and waiting for first sync…');
  await Promise.all([cx.a1.connect(), cx.a2.connect(), cx.b1.connect()]);
  await Promise.all([cx.a1.waitForFirstSync(), cx.a2.waitForFirstSync(), cx.b1.waitForFirstSync()]);

  // The catalogue must actually be on the devices before any drill starts.
  const productCountA = await cx.server.countScoped(
    cx.tenants.tenantA.id,
    `select count(*)::text as n from app.product where deleted_at is null`,
  );
  const productCountB = await cx.server.countScoped(
    cx.tenants.tenantB.id,
    `select count(*)::text as n from app.product where deleted_at is null`,
  );
  for (const [dev, expected] of [
    [cx.a1, productCountA],
    [cx.a2, productCountA],
    [cx.b1, productCountB],
  ] as const) {
    await pollUntil(`${dev.name} catalogue (${expected} products)`, async () => {
      const r = await dev.getAll<{ n: number }>(`select count(*) as n from product`);
      return (r[0]?.n ?? 0) === expected;
    });
  }
  console.log('[setup] devices synced and stocked.');
}
