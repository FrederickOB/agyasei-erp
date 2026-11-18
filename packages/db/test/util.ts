/** Shared fixtures for the @erp/db test suites. */
import { createHlcClock, randomHlcNode } from '../src/hlc.js';
import { sha256Hex, uuidv7 } from '../src/ids.js';
import { seedGhanaJurisdiction } from '../src/seed/ghana.js';
import { createTenant, createTestDb, type Queryable, type TestDb } from '../src/testing/harness.js';
import {
  saleEntry,
  type ProposedEntry,
  type SaleDocument,
  type SettlementRole,
} from '../src/posting/rules.js';

export const TENANT_A = '018f0000-0000-8000-8000-0000000000aa';
export const TENANT_B = '018f0000-0000-8000-8000-0000000000bb';

const clock = createHlcClock(randomHlcNode());

export async function setupDb(): Promise<TestDb> {
  const db = await createTestDb();
  await db.asAdmin((tx) => seedGhanaJurisdiction(tx));
  return db;
}

export async function setupTwoTenants(db: TestDb): Promise<void> {
  await createTenant(db, { id: TENANT_A, slug: 'tenant-a', legalName: 'Tenant A Ltd' });
  await createTenant(db, { id: TENANT_B, slug: 'tenant-b', legalName: 'Tenant B Ltd' });
}

/**
 * Insert a DEVICE-origin write_log row for the current tenant and return its
 * id — the unit-of-work spine every business row must reference.
 */
export async function newWrite(tx: Queryable, tenantId: string, op = 'test.write'): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `insert into app.write_log
       (tenant_id, id, origin, hlc, claimed_hlc, device_id, user_id, location_id,
        op, schema_version, request_hash)
     values ($1, $2, 'DEVICE', $3, $4, $5, $6, null, $7, 1, decode($8, 'hex'))`,
    [tenantId, id, clock.next(), clock.next(), uuidv7(), uuidv7(), op, sha256Hex(op + id)],
  );
  return id;
}

export function nextHlc(): string {
  return clock.next();
}

// ---------------------------------------------------------------------------
// One-tender sale documents for the posting tests.
//
// Since migration 0021 a sale's settlement is a LIST of tender parts read from
// app.sale_tender. Most posting tests are about something other than split
// tender — revenue, tax, discount, mappings, periods — and want "a cash sale"
// or "a credit sale"; this builds that document with exactly one part for the
// whole total, so the test still says what it is about.
// ---------------------------------------------------------------------------
export type OneTender = 'CASH' | 'MOMO' | 'BANK' | 'CREDIT';
const ROLE_OF: Record<OneTender, SettlementRole> = {
  CASH: 'TILL_CASH',
  MOMO: 'MOMO_WALLET',
  BANK: 'BANK',
  CREDIT: 'AR_TRADE',
};
export type OneTenderSale = Omit<SaleDocument, 'tenders'> & { tender: OneTender };

export function oneTender(doc: OneTenderSale): SaleDocument {
  const { tender, ...rest } = doc;
  const total =
    doc.revenueMinor - doc.discountMinor + doc.taxes.reduce((a, t) => a + t.taxMinor, 0n);
  return { ...rest, tenders: [{ role: ROLE_OF[tender], amountMinor: total }] };
}

/** `saleEntry` over a one-tender document. */
export function saleWith(doc: OneTenderSale): ProposedEntry {
  return saleEntry(oneTender(doc));
}
