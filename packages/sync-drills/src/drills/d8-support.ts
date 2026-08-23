/**
 * D8 support — the credit sync surface's fixtures and raw-file assertions.
 *
 * Split from d8.ts only so neither file grows past the point where a reviewer
 * stops reading. Nothing here decides anything; the rulings are in
 * docs/credit-offline-plan.md R1/R5 and the checks are in d8.ts.
 */
import { SignJWT } from 'jose';
import { DrillDevice } from '../device.js';
import { RawDeviceDb, grepDeviceFiles, clientTableOf } from '../rawdb.js';
import { DEV_JWT_SECRET } from '../env.js';
import type { DrillResult } from '../report.js';

const encoder = new TextEncoder();

/** Every client table the two credit buckets can deliver. */
export const CREDIT_BOOK_TABLES = [
  'customer_account',
  'credit_limit_version',
  'credit_entry',
  'credit_position_snapshot',
  'credit_position_bucket',
] as const;

export const CREDIT_TILL_TABLE = 'credit_allowance';

export interface CreditMarkers {
  tenantId: string;
  customerName: string;
  balanceDecimal: string;
}

/** One byte-grep probe: a foreign marker that must be absent, paired with an
 *  own marker from the SAME file that must be present. A probe without a live
 *  positive control is the vacuous assertion R5 exists to forbid. */
export interface Probe {
  what: string;
  foreign: string;
  ownMarker: string;
}

/** Counts of every credit table physically on disk in one device file. */
export function creditCounts(dbPath: string): Record<string, number> {
  const raw = new RawDeviceDb(dbPath);
  try {
    const physical = new Set(raw.dataTables());
    const out: Record<string, number> = {};
    for (const t of [...CREDIT_BOOK_TABLES, CREDIT_TILL_TABLE]) {
      const phys = `ps_data__${t}`;
      out[t] = physical.has(phys) ? raw.countRows(phys) : 0;
    }
    return out;
  } finally {
    raw.close();
  }
}

/** Distinct values of a JSON field in one credit table on disk. */
export function distinctOnDisk(dbPath: string, table: string, field: string): string[] {
  const raw = new RawDeviceDb(dbPath);
  try {
    const phys = `ps_data__${table}`;
    if (!raw.dataTables().includes(phys)) return [];
    return raw.distinctJson(phys, field);
  } finally {
    raw.close();
  }
}

/**
 * The cross-tenant proof for ONE device file, in the three layers R5.1/R5.2
 * demand: exact own-tenant counts, zero foreign rows in every physical table,
 * and zero foreign MARKERS in the file's bytes — each paired with a positive
 * control taken from the same file in the same run.
 */
export function proveTenantAbsence(
  r: DrillResult,
  deviceName: string,
  dbPath: string,
  own: CreditMarkers,
  other: CreditMarkers,
  otherLabel: string,
  extraProbes: Probe[] = [],
  skipBalanceProbe = false,
): void {
  const raw = new RawDeviceDb(dbPath);
  let physical: string[];
  let foreignRows: string[] = [];
  let ownRowTotal = 0;
  try {
    physical = raw.dataTables();
    for (const phys of physical) {
      const n = raw.countTenantRows(phys, other.tenantId);
      if (n > 0) foreignRows.push(`${clientTableOf(phys)}: ${n}`);
      ownRowTotal += raw.countTenantRows(phys, own.tenantId);
    }
  } finally {
    raw.close();
  }

  r.check(
    `${deviceName}: ZERO rows carrying ${otherLabel}'s tenant_id in any of ${physical.length} physical tables`,
    foreignRows.length === 0 && ownRowTotal > 0,
    foreignRows.length > 0
      ? `LEAK — ${foreignRows.join('; ')}`
      : `0 foreign rows, ${ownRowTotal} own-tenant rows present (non-vacuous)`,
  );

  // ---- The file, not the table (R5.2). Bytes, including freed pages and
  // the -wal sidecar, for three markers a leak would have to carry.
  const probes: Probe[] = [
    { what: 'tenant uuid', foreign: other.tenantId, ownMarker: own.tenantId },
    { what: 'customer name', foreign: other.customerName, ownMarker: own.customerName },
    // A device that is not entitled to the book holds NO balance — its own
    // included — so the balance probe has no honest positive control there and
    // is replaced by the caller's own (the allowance headroom). Running it
    // anyway would fail on a device that is behaving exactly as designed.
    ...(skipBalanceProbe
      ? []
      : [{
          what: 'balance decimal string',
          foreign: other.balanceDecimal,
          ownMarker: own.balanceDecimal,
        }]),
    ...extraProbes,
  ];
  for (const probe of probes) {
    const foreignHits = grepDeviceFiles(dbPath, probe.foreign);
    const ownHits = grepDeviceFiles(dbPath, probe.ownMarker);
    r.check(
      `${deviceName}: ${otherLabel}'s ${probe.what} appears NOWHERE in the device's bytes`,
      foreignHits === 0 && ownHits > 0,
      `foreign="${probe.foreign}" hits=${foreignHits}; positive control own="${probe.ownMarker}" hits=${ownHits}`,
    );
  }
}

/** A PowerSync client token minted OUTSIDE the API — the forged-claim probe. */
export async function forgedSyncToken(
  subUserId: string,
  claimedTenantId: string,
  locationId: string,
): Promise<string> {
  return new SignJWT({ tid: claimedTenantId, location_id: locationId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subUserId)
    .setAudience('powersync')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(encoder.encode(DEV_JWT_SECRET));
}

/** Open, connect, wait for first sync — the three lines every phase repeats. */
export async function bringUp(dev: DrillDevice): Promise<void> {
  await dev.open();
  await dev.connect();
  await dev.waitForFirstSync();
}
