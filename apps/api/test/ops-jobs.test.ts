/**
 * The scheduled jobs against REAL flows — sales rung through the real sale
 * router, receipt blocks issued through the real sequence router — on PGlite
 * with RLS genuinely enforced.
 *
 * CLAUDE.md §2.7, all three categories:
 *   1. money — the posting sweep job posts settled sales once, as the system
 *      actor; the backup manifest's trial balance agrees with the ledger's
 *      own statements to the minor unit;
 *   2. sync — the lost-write control finds a receipt number a device issued
 *      that no sale carries, and only that one;
 *   3. tenant boundary — tenant B's ledger, sales and receipt numbers never
 *      satisfy, inflate or appear in tenant A's figures, and vice versa.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDevLedger, trialBalance, uuidv7 } from '@erp/db';
import {
  creditSyncScopeJob,
  POSTING_SWEEP_ACTOR,
  postingSweepJob,
  receiptContinuity,
  runJob,
  silentLogger,
  trialBalanceLines,
  type LockProvider,
  type OpsDb,
  type RunnerDeps,
} from '@erp/ops';
import { renderNumber } from '@erp/sequence';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantA: string;
let tenantB: string;
let outletA: { id: string; code: string };
let outletB: { id: string; code: string };
let productA: string;
let productB: string;
let deps: RunnerDeps;

function opsOf(): OpsDb {
  return {
    query: (sql, params) => h.db.asAdmin((tx) => tx.query(sql, params)),
    transaction: (fn) => h.db.asAdmin(fn),
  };
}

const locks: LockProvider = {
  async tryWithLock(_name, fn) {
    return { acquired: true, value: await fn() };
  },
};

let receiptSeq = 0;
function sale(locationId: string, productId: string, opts: { qty: string; receiptNo?: string }) {
  receiptSeq += 1;
  return {
    idempotencyKey: uuidv7(),
    locationId,
    priceListCode: 'WHOLESALE',
    receiptNo: opts.receiptNo ?? `OPS-${String(receiptSeq).padStart(5, '0')}`,
    businessDate: '2026-08-21',
    tender: 'CASH' as const,
    lines: [{ productId, qty: opts.qty }],
  };
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantA = await h.provisionTenant('ops-a');
  tenantB = await h.provisionTenant('ops-b');
  await h.applyTemplate(tenantA, true);
  await h.applyTemplate(tenantB, true);
  outletA = (await h.outlets(tenantA, 1))[0]!;
  outletB = (await h.outlets(tenantB, 1))[0]!;
  productA = (await h.pickProduct(tenantA)).id;
  productB = (await h.pickProduct(tenantB)).id;
  await h.seedWholesalePrice(tenantA, productA, 55_000_000n); // GH₵55.00 / unit
  await h.seedWholesalePrice(tenantB, productB, 12_340_000n);
  // Tenant A has books; tenant B deliberately has none.
  const seeded = await h.db.withTenant(tenantA, (tx) => seedDevLedger(tx, tenantA));
  expect(seeded.unmappedRequired).toEqual([]);

  deps = {
    runner: h.db,
    ops: opsOf(),
    locks,
    sink: { send: async () => undefined },
    log: silentLogger,
    runnerId: 'api-test',
    build: null,
    alertRepeatMs: 3_600_000,
  };
}, 300_000);

afterAll(async () => {
  await h?.close();
});

describe('ledger.posting_sweep, scheduled', () => {
  it('posts every settled sale once, as the system actor, and skips a tenant with no ledger', async () => {
    const ownerA = h.callerFor(await h.identityFor(tenantA, { locs: [outletA.id] }));
    const ownerB = h.callerFor(await h.identityFor(tenantB, { locs: [outletB.id] }));
    await ownerA.sales.createSale(await h.legacySale(sale(outletA.id, productA, { qty: '3' })));
    await ownerA.sales.createSale(await h.legacySale(sale(outletA.id, productA, { qty: '7' })));
    await ownerB.sales.createSale(await h.legacySale(sale(outletB.id, productB, { qty: '2' })));

    const out = await runJob(postingSweepJob(), deps);
    expect(out.status).toBe('succeeded');
    const run = await h.db.asAdmin(async (tx) =>
      (await tx.query<{ summary: { tenants: Record<string, { posted: number; exceptions: number }>; skipped_no_ledger: number } }>(
        `select summary from platform.job_run where id = $1`,
        [out.jobRunId],
      )).rows[0]!.summary,
    );
    expect(run.tenants[tenantA]).toMatchObject({ posted: 2, exceptions: 0 });
    expect(run.tenants[tenantB]).toBeUndefined();
    expect(run.skipped_no_ledger).toBeGreaterThanOrEqual(1);

    const entries = await h.db.withTenant(tenantA, async (tx) =>
      (await tx.query<{ created_by: string; status: string }>(
        `select created_by::text, status from app.journal_entry where source_kind in ('cash_sale', 'credit_sale')`,
      )).rows,
    );
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.created_by === POSTING_SWEEP_ACTOR && e.status === 'posted')).toBe(true);

    // Tenant B: no ledger, so no entries and — just as important — no
    // exception per sale manufactured by sweeping books that do not exist.
    const b = await h.db.withTenant(tenantB, async (tx) =>
      (await tx.query<{ je: number; pe: number }>(
        `select (select count(*) from app.journal_entry)::int as je, (select count(*) from app.posting_exception)::int as pe`,
      )).rows[0]!,
    );
    expect(b).toEqual({ je: 0, pe: 0 });
  });

  it('is idempotent: a second run posts nothing new', async () => {
    const out = await runJob(postingSweepJob(), deps);
    expect(out.status).toBe('succeeded');
    const n = await h.db.withTenant(tenantA, async (tx) =>
      (await tx.query<{ n: number }>(`select count(*)::int as n from app.journal_entry where source_kind in ('cash_sale', 'credit_sale')`)).rows[0]!.n,
    );
    expect(n).toBe(2);
  });

  it("the backup manifest's trial balance equals the ledger's own, to the minor unit, per tenant", async () => {
    const [mine, theirs] = await h.db.withTenant(tenantA, async (tx) => [await trialBalanceLines(tx), await trialBalance(tx)] as const);
    expect(mine.balanced).toBe(true);
    expect(BigInt(mine.debitMinor)).toBeGreaterThan(0n);
    expect(BigInt(mine.debitMinor)).toBe(theirs.debitMinor);
    expect(BigInt(mine.creditMinor)).toBe(theirs.creditMinor);

    const sales = await h.db.withTenant(tenantA, async (tx) =>
      (await tx.query<{ total: string }>(`select sum(total_minor)::text as total from app.sale`)).rows[0]!.total,
    );
    // Cash sales: the till is debited with exactly what the customers paid.
    const till = mine.lines.filter((l) => l.code === '1000').reduce((s, l) => s + BigInt(l.debitMinor) - BigInt(l.creditMinor), 0n);
    expect(till).toBe(BigInt(sales));

    const b = await h.db.withTenant(tenantB, (tx) => trialBalanceLines(tx));
    expect(b).toEqual({ lines: [], debitMinor: '0', creditMinor: '0', balanced: true });
  });
});

describe('ops.lost_write_control (receipt-number continuity)', () => {
  it('finds the number a device issued that no sale carries — and only in its own tenant', async () => {
    const deviceId = uuidv7();
    const identity = await h.identityFor(tenantA, { locs: [outletA.id], dev: deviceId });
    const till = h.callerFor(identity);

    const issued = (await till.sequence.syncBlock({
      idempotencyKey: uuidv7(),
      locationId: outletA.id,
      sequenceKey: 'RECEIPT',
      report: null,
      wantBlock: true,
    })) as { block: { blockStart: string }; format: { format: string; prefix: string; locationCode: string } };
    const start = BigInt(issued.block.blockStart);
    const n = (k: bigint) => renderNumber(issued.format, start + k);

    // The device prints three receipts; only two sales reach the server.
    await till.sales.createSale(await h.legacySale(sale(outletA.id, productA, { qty: '1', receiptNo: n(0n) })));
    await till.sales.createSale(await h.legacySale(sale(outletA.id, productA, { qty: '1', receiptNo: n(2n) })));
    // ...and then reports, on the same ordered outbox, that it issued all three.
    await till.sequence.syncBlock({
      idempotencyKey: uuidv7(),
      locationId: outletA.id,
      sequenceKey: 'RECEIPT',
      report: { blockStart: start.toString(10), consumedUpto: (start + 2n).toString(10) },
      wantBlock: false,
    });

    // Tenant B holds a sale carrying the very string A is missing — same
    // template, same location code, same format. It must not count for A.
    const ownerB = h.callerFor(await h.identityFor(tenantB, { locs: [outletB.id] }));
    await ownerB.sales.createSale(await h.legacySale(sale(outletB.id, productB, { qty: '1', receiptNo: n(1n) })));

    const a = await h.db.withTenant(tenantA, (tx) => receiptContinuity(tx));
    expect(a.findings).toEqual([
      {
        locationId: outletA.id,
        deviceId,
        sequenceKey: 'RECEIPT',
        blocks: 1,
        issued: 3,
        present: 2,
        missing: 1,
        missingSample: [(start + 1n).toString(10)],
      },
    ]);

    // B issued no blocks: nothing to reconcile, and A's numbers are invisible.
    const b = await h.db.withTenant(tenantB, (tx) => receiptContinuity(tx));
    expect(b).toEqual({ findings: [], clean: 0, unverifiableKeys: [], blocksChecked: 0 });
  });

  it('a device whose every issued number is on a sale is clean', async () => {
    const deviceId = uuidv7();
    const till = h.callerFor(await h.identityFor(tenantA, { locs: [outletA.id], dev: deviceId }));
    const issued = (await till.sequence.syncBlock({
      idempotencyKey: uuidv7(),
      locationId: outletA.id,
      sequenceKey: 'RECEIPT',
      report: null,
      wantBlock: true,
    })) as { block: { blockStart: string }; format: { format: string; prefix: string; locationCode: string } };
    const start = BigInt(issued.block.blockStart);
    await till.sales.createSale(await h.legacySale(sale(outletA.id, productA, { qty: '1', receiptNo: renderNumber(issued.format, start) })));
    await till.sequence.syncBlock({
      idempotencyKey: uuidv7(),
      locationId: outletA.id,
      sequenceKey: 'RECEIPT',
      report: { blockStart: start.toString(10), consumedUpto: start.toString(10) },
      wantBlock: false,
    });
    const a = await h.db.withTenant(tenantA, (tx) => receiptContinuity(tx));
    expect(a.findings.map((f) => f.deviceId)).not.toContain(deviceId);
    expect(a.clean).toBeGreaterThanOrEqual(1);
  });
});

describe('credit.sync_scope_refresh, scheduled', () => {
  it("removes a grant that lapsed with no DML from the credit book's sync scope", async () => {
    const root = await h.locationByCode(tenantA, 'ROOT');
    const uid = uuidv7();
    await h.grantRole(tenantA, uid, 'accounts', root);
    const inScope = () =>
      h.db.withTenant(tenantA, async (tx) =>
        (await tx.query<{ n: number }>(`select count(*)::int as n from app.credit_sync_book_scope where user_id = $1`, [uid])).rows[0]!.n,
      );
    expect(await inScope()).toBe(1);

    // The grant ends in a moment. Nothing writes when it does — which is the
    // whole hole (phase2-gate §5.2 D8).
    await h.db.withTenant(tenantA, (tx) =>
      tx.query(
        `update app.user_role_assignment set effective_to = clock_timestamp() + interval '1 second'
          where user_id = $1`,
        [uid],
      ),
    );
    await new Promise((r) => setTimeout(r, 1500));
    expect(await inScope()).toBe(1); // still on the device

    const out = await runJob(creditSyncScopeJob(), deps);
    expect(out.status).toBe('succeeded');
    expect(await inScope()).toBe(0); // off the device on its next sync
  });
});
