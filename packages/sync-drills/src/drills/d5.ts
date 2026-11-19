/**
 * D5 — TENANT ISOLATION AT THE SYNC LAYER (acceptance criterion 5 — the
 * unrecoverable one).
 *
 * The sync rules are where data actually leaves the server, so this drill
 * inspects what physically landed ON DISK: after both tenants' devices are
 * fully synced, each device file is opened RAW (node:sqlite, read-only,
 * not through the PowerSync client) and checked table by physical table.
 *
 * HARD ASSERTIONS, per device (B1 vs tenant A, then A1 vs tenant B):
 *   - ABSENCE: zero rows whose tenant_id is the other tenant's, in every
 *     physical table — and zero occurrences of the other tenant's uuid
 *     ANYWHERE in any stored row (id or data blob, synced, local or untyped).
 *   - EXACT COUNTS: per synced table, the raw row count equals what the
 *     tenant-scoped server-side queries predict the sync rules deliver —
 *     absence proven by counting, not by failing to find.
 *   - NON-VACUOUS: both tenants demonstrably have rows in the operational
 *     tables, so "no leak" is not "no data".
 */
import { pollUntil, type DrillDevice } from '../device.js';
import { RawDeviceDb, clientTableOf } from '../rawdb.js';
import { SYNCED_TABLE_NAMES } from '../schema.js';
import type { DrillContext } from '../context.js';
import { DrillResult } from '../report.js';

async function settleDevice(
  dev: DrillDevice,
  predicted: Record<string, number>,
): Promise<void> {
  // Convergence gate: the client VIEW counts must reach the predictions for
  // the operationally active tables before we freeze and inspect the file.
  for (const table of [
    'product', 'sale', 'sale_line', 'sale_tax_line', 'stock_movement', 'customer',
    'price_list_item', 'customer_account', 'credit_entry', 'credit_position_snapshot',
  ]) {
    const want = predicted[table] ?? 0;
    await pollUntil(`${dev.name}: ${table} = ${want} rows`, async () => {
      const rows = await dev.getAll<{ n: number }>(`select count(*) as n from "${table}"`);
      return (rows[0]?.n ?? 0) === want;
    });
  }
}

function inspect(
  r: DrillResult,
  deviceName: string,
  dbPath: string,
  predicted: Record<string, number>,
  ownTenantId: string,
  otherTenantId: string,
  otherTenantLabel: string,
): void {
  const raw = new RawDeviceDb(dbPath);
  try {
    const physical = raw.dataTables();

    // 1) EXACT COUNTS: every synced table matches the tenant-scoped
    //    server-side prediction (a table the service never delivered counts 0).
    const mismatches: string[] = [];
    let totalRows = 0;
    for (const table of SYNCED_TABLE_NAMES) {
      const phys = `ps_data__${table}`;
      const have = physical.includes(phys) ? raw.countRows(phys) : 0;
      totalRows += have;
      const want = predicted[table] ?? 0;
      if (have !== want) mismatches.push(`${table}: raw=${have} predicted=${want}`);
    }
    r.check(
      `${deviceName}: raw row count equals tenant-scoped prediction for all ${SYNCED_TABLE_NAMES.length} synced tables`,
      mismatches.length === 0,
      mismatches.length === 0 ? `all match (${totalRows} rows on disk)` : mismatches.join('; '),
    );

    // 2) ABSENCE by tenant_id, every physical table on disk.
    const leaks: string[] = [];
    let ownRows = 0;
    for (const phys of physical) {
      const other = raw.countTenantRows(phys, otherTenantId);
      if (other > 0) leaks.push(`${clientTableOf(phys)}: ${other} rows with ${otherTenantLabel} tenant_id`);
      ownRows += raw.countTenantRows(phys, ownTenantId);
    }
    r.check(
      `${deviceName}: ZERO rows with ${otherTenantLabel}'s tenant_id in any of ${physical.length} physical tables`,
      leaks.length === 0,
      leaks.length === 0 ? `0 foreign rows (${ownRows} own-tenant rows present)` : leaks.join('; '),
    );

    // 3) The bluntest sweep: the other tenant's uuid may not appear ANYWHERE.
    const mentions: string[] = [];
    for (const phys of physical) {
      const n = raw.countUuidMentions(phys, otherTenantId);
      if (n > 0) mentions.push(`${phys}: ${n}`);
    }
    r.check(
      `${deviceName}: ${otherTenantLabel}'s uuid appears NOWHERE in the file's stored rows`,
      mentions.length === 0,
      mentions.length === 0 ? 'zero occurrences' : mentions.join('; '),
    );

    r.measure(`${deviceName}: ${physical.length} physical tables, ${totalRows} synced rows on disk`);
  } finally {
    raw.close();
  }
}

export async function runD5(cx: DrillContext): Promise<DrillResult> {
  const r = new DrillResult('D5', 'Tenant isolation at the sync layer — raw device files');
  const tenantA = cx.tenants.tenantA.id;
  const tenantB = cx.tenants.tenantB.id;

  // Tenant-scoped server predictions of what the sync rules deliver.
  // Predictions are per (tenant, location, USER): the credit buckets are gated
  // on the gate tables keyed by user_id, so a prediction that ignored the user
  // would be predicting a different device's slice.
  const predictA = await cx.server.predictDeviceRows(tenantA, cx.locA1, cx.a1.userId, cx.a1.deviceId);
  const predictB = await cx.server.predictDeviceRows(tenantB, cx.locB, cx.b1.userId, cx.b1.deviceId);

  // Non-vacuity: both tenants must actually HAVE operational data.
  for (const [label, p] of [
    ['tenant A/OUT-01', predictA],
    ['tenant B/MAIN', predictB],
  ] as const) {
    const ok =
      (p['product'] ?? 0) > 0 &&
      (p['sale'] ?? 0) > 0 &&
      (p['sale_line'] ?? 0) > 0 &&
      (p['stock_movement'] ?? 0) > 0 &&
      (p['customer'] ?? 0) > 0;
    r.check(
      `non-vacuous: ${label} predicts rows in product/sale/sale_line/stock_movement/customer`,
      ok,
      `product=${p['product']} sale=${p['sale']} sale_line=${p['sale_line']} stock_movement=${p['stock_movement']} customer=${p['customer']}`,
    );
  }

  // Let both sides settle to exactly the predicted counts, then freeze.
  await settleDevice(cx.a1, predictA);
  await settleDevice(cx.b1, predictB);
  await Promise.all([cx.a1.close(), cx.a2.close(), cx.b1.close(), cx.a3.close()]);

  // B1 (tenant B) must hold ZERO tenant-A data — and exactly its own.
  inspect(r, 'B1 (tenant B device)', cx.b1.dbPath, predictB, tenantB, tenantA, 'tenant A');
  // The reverse: A1 must hold ZERO tenant-B data — and exactly its own.
  inspect(r, 'A1 (tenant A device)', cx.a1.dbPath, predictA, tenantA, tenantB, 'tenant B');

  return r;
}
