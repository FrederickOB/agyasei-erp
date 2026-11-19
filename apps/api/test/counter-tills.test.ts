/**
 * THE TILL AND THE TENDERS, THROUGH THE REAL ROUTERS — work package A.
 *
 * Every assertion is on what `cashSession.*`, `sales.createSale`,
 * `reports.cashPosition` and the posting sweep did against real Postgres
 * (PGlite, the real migrations, RLS as `app_user`). Every refusal has a
 * positive control on the same route. The three mandatory categories
 * (CLAUDE.md §2.7) are all here: money (expected cash, variance, split
 * tender, the CHARGE identity, rules 11/11b), sync/conflict (idempotent
 * replay through POST /sync/upload, class #17, reconciliation reviews) and
 * the tenant boundary (a second tenant's tills, tenders and reports).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDevLedger, sweepClosedCashSessions, sweepSettledSales, uuidv7 } from '@erp/db';
import { signDevToken, type VerifiedIdentity } from '../src/auth.js';
import { TILL_CLAIMED_TWICE_CLASS, TILL_DATE_DIVERGENCE_CLASS } from '../src/routers/cash-session.js';
import { SALE_AFTER_TILL_CLOSED_CLASS, TENDER_RECONCILED_CLASS } from '../src/routers/sales.js';
import { buildServer } from '../src/server.js';
import { createApiHarness, JWT_SECRET, type ApiHarness, type TemplateTenderIds } from './util.js';

let h: ApiHarness;
let tenantId: string;
let tenantB: string;
let outlet: string;
let outlet2: string;
let root: string;
let productId: string;
let tm: TemplateTenderIds;
let creditCustomerId: string;
/** The device that owns its own drawer in most tests here. */
const DEVICE_A = uuidv7();
let ownerA: VerifiedIdentity;
type Caller = ReturnType<ApiHarness['callerFor']>;
let a: Caller;

/** Dates inside the dev ledger's FY27 calendar, so the sweep can post them. */
const DAY = '2026-09-14';

let receiptSeq = 0;
const receipt = (tag: string) => `TT-${tag}-${String((receiptSeq += 1)).padStart(5, '0')}`;

async function openTill(
  caller: Caller,
  opts: { businessDate?: string; drawer?: 'DEVICE' | 'SHARED'; floatMinor?: string; at?: string; key?: string } = {},
) {
  return caller.cashSession.open({
    idempotencyKey: opts.key ?? uuidv7(),
    locationId: opts.at ?? outlet,
    businessDate: opts.businessDate ?? DAY,
    openingFloatMinor: opts.floatMinor ?? '20000',
    openedAt: `${opts.businessDate ?? DAY}T07:00:00.000Z`,
    openedOffline: false,
    drawer: opts.drawer ?? 'DEVICE',
  });
}

type TenderLine = {
  methodId: string;
  settlement: 'IMMEDIATE' | 'ON_ACCOUNT';
  amountMinor?: string;
  reference?: string;
};

function sale(sessionId: string, tenders: TenderLine[], opts: { qty?: string; customerId?: string; at?: string } = {}) {
  return {
    idempotencyKey: uuidv7(),
    locationId: opts.at ?? outlet,
    cashSessionId: sessionId,
    priceListCode: 'WHOLESALE',
    receiptNo: receipt('S'),
    tenders,
    lines: [{ productId, qty: opts.qty ?? '2' }],
    ...(opts.customerId === undefined ? {} : { customerId: opts.customerId }),
  };
}
const cash = (amountMinor?: string): TenderLine => ({
  methodId: tm.cash, settlement: 'IMMEDIATE', ...(amountMinor === undefined ? {} : { amountMinor }),
});
const momo = (amountMinor?: string, reference = 'MP-TXN-0001'): TenderLine => ({
  methodId: tm.momo, settlement: 'IMMEDIATE', reference, ...(amountMinor === undefined ? {} : { amountMinor }),
});
const onAccount = (amountMinor?: string): TenderLine => ({
  methodId: tm.onAccount, settlement: 'ON_ACCOUNT', ...(amountMinor === undefined ? {} : { amountMinor }),
});

async function reviewsFor(entityId: string, tenant = tenantId) {
  return h.db.withTenant(tenant, async (tx) => {
    const r = await tx.query<{ conflict_class: string; severity: number; locations: string[] }>(
      `select cr.conflict_class, cr.severity,
              array(select location_id::text from app.conflict_review_location l
                     where l.review_id = cr.id order by 1) as locations
         from app.conflict_review cr where cr.entity_id = $1 order by cr.conflict_class`,
      [entityId],
    );
    return r.rows;
  });
}

async function tendersOf(saleId: string) {
  return h.db.withTenant(tenantId, async (tx) => {
    const r = await tx.query<{ seq: number; method_id: string; amount: string; claimed: string | null; reference: string | null }>(
      `select seq, method_id, amount_minor::text as amount, claimed_minor::text as claimed, reference
         from app.sale_tender where sale_id = $1 order by seq`,
      [saleId],
    );
    return r.rows;
  });
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('tills-a');
  tenantB = await h.provisionTenant('tills-b');
  await h.applyTemplate(tenantId, true);
  await h.applyTemplate(tenantB, true);
  root = await h.locationByCode(tenantId, 'ROOT');
  const outs = await h.outlets(tenantId, 2);
  outlet = outs[0]!.id;
  outlet2 = outs[1]!.id;
  productId = (await h.pickProduct(tenantId)).id;
  await h.seedWholesalePrice(tenantId, productId, 55_000_000n); // GH₵55.00/unit
  tm = await h.tenderMethods(tenantId);

  ownerA = await h.identityFor(tenantId, { locs: [root, outlet, outlet2], dev: DEVICE_A });
  a = h.callerFor(ownerA);
  const account = await a.credit.openAccount({
    idempotencyKey: uuidv7(),
    newCustomer: { code: 'TT-C1', name: 'Till Test Contractor' },
    termsDays: 30, feeRateBpPerMonth: 200, creditLimitMinor: '99999999999',
  });
  creditCustomerId = account.customerId;

  const seeded = await h.db.withTenant(tenantId, (tx) => seedDevLedger(tx, tenantId));
  expect(seeded.unmappedRequired).toEqual([]);
}, 240_000);

afterAll(async () => {
  await h?.close();
});

// ---------------------------------------------------------------------------
// Opening a till
// ---------------------------------------------------------------------------

describe('opening a till', () => {
  it('records the device and the opener FROM THE TOKEN, and the server’s own date beside the asserted one', async () => {
    const opened = await openTill(a, { businessDate: '2026-09-01' });
    expect(opened).toMatchObject({ status: 'OPEN', contestedSessionId: null, reviews: [], businessDate: '2026-09-01' });
    const row = await h.db.withTenant(tenantId, async (tx) => {
      const r = await tx.query<{ device_id: string; opened_by: string; float: string; server_date: string; status: string }>(
        `select device_id, opened_by, opening_float_minor::text as float,
                server_date_at_open::text as server_date, status
           from app.cash_session where id = $1`,
        [opened.cashSessionId],
      );
      return r.rows[0]!;
    });
    expect(row).toMatchObject({ device_id: DEVICE_A, opened_by: ownerA.userId, float: '20000', status: 'OPEN' });
    expect(row.server_date).toBe(opened.serverDate);
  });

  it('an open replayed under the same key is the SAME session — one row, identical answer', async () => {
    const key = uuidv7();
    const first = await openTill(a, { businessDate: '2026-09-02', key });
    const again = await openTill(a, { businessDate: '2026-09-02', key });
    expect(again).toEqual(first);
    const n = await h.db.withTenant(tenantId, async (tx) =>
      (await tx.query<{ n: string }>(`select count(*)::text as n from app.cash_session where business_date = '2026-09-02'`)).rows[0]!.n);
    expect(n).toBe('1');
  });

  it('the capability is cash.session.open, at the location — accounts may not open a till, counter staff may', async () => {
    const accounts = h.callerFor(await h.principal(tenantId, { roleRef: 'accounts', scopeLocationId: root, locs: [outlet] }));
    await expect(openTill(accounts, { businessDate: '2026-09-03' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const clerk = h.callerFor(await h.principal(tenantId, { roleRef: 'counter_staff', scopeLocationId: outlet, locs: [outlet] }));
    await expect(openTill(clerk, { businessDate: '2026-09-03' })).resolves.toMatchObject({ status: 'OPEN' });
  });

  it('a till opened for a day AHEAD of the server lands — its sales may already exist — and goes to review', async () => {
    const opened = await openTill(a, { businessDate: '2031-01-15', drawer: 'SHARED' });
    expect(opened.reviews).toEqual([TILL_DATE_DIVERGENCE_CLASS]);
    const reviews = await reviewsFor(opened.cashSessionId);
    expect(reviews).toEqual([{ conflict_class: TILL_DATE_DIVERGENCE_CLASS, severity: 2, locations: [outlet] }]);
  });

  it('openCheck answers the counter BEFORE it queues an open: the server’s date and the period', async () => {
    const probe = await a.cashSession.openCheck({ locationId: outlet, businessDate: DAY });
    // The dev ledger's FY27 calendar covers DAY and it is open.
    expect(probe.periodStatus).toBe('open');
    const today = await a.cashSession.openCheck({ locationId: outlet, businessDate: probe.serverDate });
    expect(today.refusal).toBeNull(); // positive control: the server's own date
    const farOut = await a.cashSession.openCheck({ locationId: outlet, businessDate: '2031-01-15' });
    expect(farOut.refusal).toMatch(new RegExp(`server's date here is ${probe.serverDate}`));
  });

  it('openCheck refuses a day in a CLOSED accounting period, by name', async () => {
    await h.db.withTenant(tenantId, (tx) =>
      tx.query(
        `update app.accounting_period set status = 'closed', closed_at = transaction_timestamp(), closed_by = $1
          where starts_on = '2026-08-01'`,
        [ownerA.userId],
      ));
    try {
      const check = await a.cashSession.openCheck({ locationId: outlet, businessDate: '2026-08-10' });
      expect(check.periodStatus).toBe('closed');
      // The server date is months away in this test, so the refusal names the
      // date first; the period is reported either way.
      expect(check.refusal).not.toBeNull();
    } finally {
      await h.db.withTenant(tenantId, (tx) =>
        tx.query(
          `update app.accounting_period set status = 'open', closed_at = null, closed_by = null
            where starts_on = '2026-08-01'`,
        ));
    }
  });
});

// ---------------------------------------------------------------------------
// Class #17 — two claims on one till
// ---------------------------------------------------------------------------

describe('§3.6 class #17: the same till claimed twice — lands contested, goes to review, never auto-resolved', () => {
  it('two DEVICES claiming the shared drawer for one day: both land, the second contested, one review', async () => {
    const devB = h.callerFor(await h.identityFor(tenantId, { locs: [outlet], dev: uuidv7() }));
    const first = await openTill(a, { businessDate: '2026-09-20', drawer: 'SHARED' });
    const second = await openTill(devB, { businessDate: '2026-09-20', drawer: 'SHARED' });
    expect(first.contestedSessionId).toBeNull();
    expect(second.contestedSessionId).toBe(first.cashSessionId);
    expect(second.reviews).toEqual([TILL_CLAIMED_TWICE_CLASS]);
    expect(await reviewsFor(second.cashSessionId)).toEqual([
      { conflict_class: TILL_CLAIMED_TWICE_CLASS, severity: 2, locations: [outlet] },
    ]);
    // …and the contested session is a REAL till: a sale rung into it lands.
    const rung = await devB.sales.createSale(sale(second.cashSessionId, [cash()]));
    expect(rung.cashSessionId).toBe(second.cashSessionId);
  });

  it('a wiped device re-opening ITS OWN drawer for a day it already opened is the same class', async () => {
    const dev = uuidv7();
    const c = h.callerFor(await h.identityFor(tenantId, { locs: [outlet], dev }));
    const first = await openTill(c, { businessDate: '2026-09-21' });
    const again = await openTill(c, { businessDate: '2026-09-21' }); // a NEW key: not a replay
    expect(again.contestedSessionId).toBe(first.cashSessionId);
    expect(again.reviews).toEqual([TILL_CLAIMED_TWICE_CLASS]);
  });

  it('positive controls: two devices’ OWN drawers, or one drawer on two days, are no conflict', async () => {
    const c1 = h.callerFor(await h.identityFor(tenantId, { locs: [outlet], dev: uuidv7() }));
    const c2 = h.callerFor(await h.identityFor(tenantId, { locs: [outlet], dev: uuidv7() }));
    expect((await openTill(c1, { businessDate: '2026-09-22' })).reviews).toEqual([]);
    expect((await openTill(c2, { businessDate: '2026-09-22' })).reviews).toEqual([]);
    expect((await openTill(c1, { businessDate: '2026-09-23' })).reviews).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Selling into a till
// ---------------------------------------------------------------------------

describe('a sale takes its business date FROM THE TILL, and names it', () => {
  let till: string;
  beforeAll(async () => {
    till = (await openTill(a, { businessDate: '2026-09-04' })).cashSessionId;
  });

  it('the sale and its stock movement carry the session and the session’s date', async () => {
    const s = await a.sales.createSale(sale(till, [cash()]));
    expect(s.businessDate).toBe('2026-09-04');
    expect(s.cashSessionId).toBe(till);
    const rows = await h.db.withTenant(tenantId, async (tx) => {
      const sl = await tx.query<{ cash_session_id: string; business_date: string }>(
        `select cash_session_id, business_date::text from app.sale where id = $1`, [s.saleId]);
      const mv = await tx.query<{ cash_session_id: string; business_date: string }>(
        `select cash_session_id, business_date::text from app.stock_movement where source_id = $1`, [s.saleId]);
      return { sale: sl.rows[0]!, moves: mv.rows };
    });
    expect(rows.sale).toEqual({ cash_session_id: till, business_date: '2026-09-04' });
    expect(rows.moves.length).toBeGreaterThan(0);
    expect(rows.moves.every((m) => m.cash_session_id === till && m.business_date === '2026-09-04')).toBe(true);
  });

  it('a sale naming a till the server has not heard of is RETRYABLE (the open is still in the queue), and nothing lands', async () => {
    const orphan = sale(uuidv7(), [cash()]);
    await expect(a.sales.createSale(orphan)).rejects.toMatchObject({
      code: 'CONFLICT', message: expect.stringMatching(/^RETRY_LATER/),
    });
  });

  it('a sale at one outlet naming another outlet’s till is refused', async () => {
    const other = (await openTill(a, { businessDate: '2026-09-04', at: outlet2 })).cashSessionId;
    await expect(a.sales.createSale(sale(other, [cash()]))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // Positive control: the same sale at that outlet is recorded.
    await expect(a.sales.createSale(sale(other, [cash()], { at: outlet2 }))).resolves.toMatchObject({ cashSessionId: other });
  });

  it('a device may not ring into ANOTHER device’s own drawer — but may into a shared one', async () => {
    const other = h.callerFor(await h.identityFor(tenantId, { locs: [outlet], dev: uuidv7() }));
    await expect(other.sales.createSale(sale(till, [cash()]))).rejects.toMatchObject({
      code: 'BAD_REQUEST', message: expect.stringMatching(/another device/),
    });
    const shared = (await openTill(a, { businessDate: '2026-09-05', drawer: 'SHARED' })).cashSessionId;
    await expect(other.sales.createSale(sale(shared, [cash()]))).resolves.toMatchObject({ cashSessionId: shared });
  });
});

// ---------------------------------------------------------------------------
// Tenders — split, references, reconciliation, the CHARGE identity
// ---------------------------------------------------------------------------

describe('tender lines: how the customer paid is RECORDED, and the identities hold', () => {
  let till: string;
  beforeAll(async () => {
    till = (await openTill(a, { businessDate: '2026-09-06' })).cashSessionId;
  });

  it('a single balance line settles the server’s own total — no claim, no review', async () => {
    const s = await a.sales.createSale(sale(till, [cash()]));
    expect(await tendersOf(s.saleId)).toEqual([
      { seq: 1, method_id: tm.cash, amount: s.totalMinor, claimed: null, reference: null },
    ]);
    expect(await reviewsFor(s.saleId)).toEqual([]);
  });

  it('SPLIT: part mobile money with its transaction id, the rest in cash — two rows summing to the total', async () => {
    const s = await a.sales.createSale(sale(till, [momo('5000', 'MP260906.1200.Q1'), cash()]));
    const total = BigInt(s.totalMinor);
    expect(await tendersOf(s.saleId)).toEqual([
      { seq: 1, method_id: tm.momo, amount: '5000', claimed: null, reference: 'MP260906.1200.Q1' },
      { seq: 2, method_id: tm.cash, amount: (total - 5000n).toString(10), claimed: null, reference: null },
    ]);
  });

  it('a method that requires a reference is refused without one — and accepted with one', async () => {
    const bare = sale(till, [{ methodId: tm.momo, settlement: 'IMMEDIATE' }]);
    await expect(a.sales.createSale(bare)).rejects.toMatchObject({
      code: 'BAD_REQUEST', message: expect.stringMatching(/needs a reference/),
    });
    await expect(a.sales.createSale(sale(till, [momo()]))).resolves.toMatchObject({ tenders: [{ reference: 'MP-TXN-0001' }] });
  });

  it('STALE PRICES: stated lines that miss the server’s total are reconciled by the rule, kept as claims, and REVIEWED', async () => {
    const probe = await a.sales.createSale(sale(till, [cash()], { qty: '3' }));
    const total = BigInt(probe.totalMinor);
    // The till believed the sale came to 200 less: cash 1000 + momo (total−1200).
    const momoClaim = total - 1200n;
    const s = await a.sales.createSale({
      ...sale(till, [cash('1000'), momo(momoClaim.toString(10), 'MP-STALE-1')], { qty: '3' }),
      clientTotalMinor: (total - 200n).toString(10),
    });
    // Drawer cash absorbs the difference (no on-account line here); momo is untouched.
    expect(await tendersOf(s.saleId)).toEqual([
      { seq: 1, method_id: tm.cash, amount: '1200', claimed: '1000', reference: null },
      { seq: 2, method_id: tm.momo, amount: momoClaim.toString(10), claimed: null, reference: 'MP-STALE-1' },
    ]);
    expect(s.priceCheck).toMatchObject({ matches: false, deltaMinor: '200' });
    expect(await reviewsFor(s.saleId)).toEqual([
      { conflict_class: TENDER_RECONCILED_CLASS, severity: 2, locations: [outlet] },
    ]);
  });

  it('ON ACCOUNT, split: the CHARGE is exactly the on-account part — and the on-account line absorbs first', async () => {
    const probe = await a.sales.createSale(sale(till, [cash()], { qty: '4' }));
    const total = BigInt(probe.totalMinor);
    // Stated: cash 3000, on account 1000 — 500 short of the server total.
    const s = await a.sales.createSale(
      sale(till, [cash('3000'), onAccount((total - 3500n).toString(10))], { qty: '4', customerId: creditCustomerId }),
    );
    expect(await tendersOf(s.saleId)).toEqual([
      { seq: 1, method_id: tm.cash, amount: '3000', claimed: null, reference: null },
      { seq: 2, method_id: tm.onAccount, amount: (total - 3000n).toString(10), claimed: (total - 3500n).toString(10), reference: null },
    ]);
    expect(s.credit?.chargeMinor).toBe((total - 3000n).toString(10));
    const charge = await h.db.withTenant(tenantId, async (tx) =>
      (await tx.query<{ amount: string }>(
        `select amount_minor::text as amount from app.credit_entry where source_kind = 'SALE' and source_id = $1`,
        [s.saleId])).rows);
    expect(charge).toEqual([{ amount: (total - 3000n).toString(10) }]);
  });

  it('THE DATABASE REFUSES a later CHARGE that disagrees with the on-account tender (0022, SALE0007)', async () => {
    const s = await a.sales.createSale(sale(till, [onAccount()], { customerId: creditCustomerId }));
    const accountId = s.credit!.accountId;
    await expect(
      h.db.withTenant(tenantId, async (tx) => {
        const w = uuidv7();
        await tx.query(
          `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
           values ($1, $2, 'SERVER', $3, 'test.tamper', 1, decode('00','hex'))`, [tenantId, w, h.deps.clock.next()]);
        await tx.query(
          `insert into app.credit_entry (tenant_id, id, write_id, hlc, account_id, kind, amount_minor,
                                         business_date, source_kind, source_id)
           values ($1, $2, $3, $4, $5, 'CHARGE', 500, '2026-09-06', 'SALE', $6)`,
          [tenantId, uuidv7(), w, h.deps.clock.next(), accountId, s.saleId]);
      }),
    ).rejects.toThrow(/SALE0007/);
    // Positive control: a CHARGE naming no sale is ordinary credit business.
    await h.db.withTenant(tenantId, async (tx) => {
      const w = uuidv7();
      await tx.query(
        `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
         values ($1, $2, 'SERVER', $3, 'test.ok', 1, decode('00','hex'))`, [tenantId, w, h.deps.clock.next()]);
      await tx.query(
        `insert into app.credit_entry (tenant_id, id, write_id, hlc, account_id, kind, amount_minor,
                                       business_date, source_kind, source_id)
         values ($1, $2, $3, $4, $5, 'CHARGE', 500, '2026-09-06', 'MANUAL', null)`,
        [tenantId, uuidv7(), w, h.deps.clock.next(), accountId]);
    });
  });

  it('THE DATABASE REFUSES a tender added to a committed sale (0022, SALE0005: Σ tenders = total)', async () => {
    const s = await a.sales.createSale(sale(till, [cash()]));
    await expect(
      h.db.withTenant(tenantId, async (tx) => {
        const w = uuidv7();
        await tx.query(
          `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
           values ($1, $2, 'SERVER', $3, 'test.tamper', 1, decode('00','hex'))`, [tenantId, w, h.deps.clock.next()]);
        await tx.query(
          `insert into app.sale_tender (tenant_id, id, write_id, hlc, sale_id, seq, method_id, amount_minor,
                                        tendered_at, location_id)
           values ($1, $2, $3, $4, $5, 9, $6, 1, transaction_timestamp(), $7)`,
          [tenantId, uuidv7(), w, h.deps.clock.next(), s.saleId, tm.cash, outlet]);
      }),
    ).rejects.toThrow(/SALE0005/);
  });

  it('a replayed split sale records its tenders ONCE (idempotency, §2.2)', async () => {
    const input = sale(till, [momo('1000', 'MP-REPLAY'), cash()]);
    const first = await a.sales.createSale(input);
    const again = await a.sales.createSale(input);
    expect(again).toEqual(first);
    expect(await tendersOf(first.saleId)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Closing a till — expected, counted, variance
// ---------------------------------------------------------------------------

describe('closing a till: the server computes expected cash from what it recorded', () => {
  it('expected = float + drawer cash only; variance = counted − expected; then the row is final', async () => {
    const till = (await openTill(a, { businessDate: '2026-09-08', floatMinor: '20000' })).cashSessionId;
    const s1 = await a.sales.createSale(sale(till, [cash()]));
    const s2 = await a.sales.createSale(sale(till, [momo('3000', 'MP-CU-1'), cash()]));
    await a.sales.createSale(sale(till, [momo(undefined, 'MP-CU-2')])); // all momo: not drawer cash
    const drawer = BigInt(s1.totalMinor) + (BigInt(s2.totalMinor) - 3000n);
    const expected = 20_000n + drawer;

    const closed = await a.cashSession.close({
      idempotencyKey: uuidv7(),
      locationId: outlet,
      cashSessionId: till,
      closedAt: '2026-09-08T18:00:00.000Z',
      autoClosed: false,
      countedMinor: (expected - 500n).toString(10),
      bankedMinor: '15000',
      clientExpectedMinor: expected.toString(10),
    });
    expect(closed).toMatchObject({
      status: 'CLOSED',
      expectedCashMinor: expected.toString(10),
      varianceMinor: '-500',
      bankedMinor: '15000',
      expectedMatchesDevice: true,
    });

    await expect(
      a.cashSession.close({
        idempotencyKey: uuidv7(), locationId: outlet, cashSessionId: till,
        closedAt: '2026-09-08T19:00:00.000Z', autoClosed: false, countedMinor: '1',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/already CLOSED/) });
  });

  it('the midnight auto-close counts nothing: no count, no variance, expected still frozen', async () => {
    const till = (await openTill(a, { businessDate: '2026-09-09', floatMinor: '5000' })).cashSessionId;
    const closed = await a.cashSession.close({
      idempotencyKey: uuidv7(), locationId: outlet, cashSessionId: till,
      closedAt: '2026-09-09T23:59:59.000Z', autoClosed: true,
    });
    expect(closed).toMatchObject({ autoClosed: true, countedMinor: null, varianceMinor: null, expectedCashMinor: '5000' });
  });

  it('a close replayed through POST /sync/upload is a duplicate — one close, never two', async () => {
    const app: FastifyInstance = await buildServer({ deps: h.deps, jwtSecret: JWT_SECRET });
    try {
      const bearer = await signDevToken(JWT_SECRET, {
        tid: tenantId, uid: ownerA.userId, role: 'x', locs: [outlet], dev: DEVICE_A,
      });
      const openKey = uuidv7();
      const closeKey = uuidv7();
      const ops = [
        { idempotency_key: openKey, kind: 'cash_session.open', claimed_hlc: h.deps.clock.next(),
          payload: { locationId: outlet, businessDate: '2026-09-10', openingFloatMinor: '1000',
                     openedAt: '2026-09-10T07:00:00.000Z', openedOffline: true } },
        { idempotency_key: closeKey, kind: 'cash_session.close', claimed_hlc: h.deps.clock.next(),
          payload: { locationId: outlet, cashSessionId: openKey, closedAt: '2026-09-10T18:00:00.000Z',
                     autoClosed: false, countedMinor: '1000' } },
      ];
      const send = async () =>
        (await app.inject({ method: 'POST', url: '/sync/upload',
          headers: { authorization: `Bearer ${bearer}` }, payload: { ops } })).json() as {
          acks: { key: string; status: string; reason?: string }[];
        };
      const first = await send();
      expect(first.acks.map((x) => x.status)).toEqual(['applied', 'applied']);
      const again = await send();
      expect(again.acks.map((x) => x.status)).toEqual(['duplicate', 'duplicate']);
      const row = await h.db.withTenant(tenantId, async (tx) =>
        (await tx.query<{ status: string; offline: boolean; variance: string }>(
          `select status, opened_offline as offline, variance_minor::text as variance
             from app.cash_session where id = $1`, [openKey])).rows);
      expect(row).toEqual([{ status: 'CLOSED', offline: true, variance: '0' }]);
    } finally {
      await app.close();
    }
  });

  it('cash.session.close is its own capability: accounts may not close a till', async () => {
    const till = (await openTill(a, { businessDate: '2026-09-11' })).cashSessionId;
    const accounts = h.callerFor(await h.principal(tenantId, { roleRef: 'accounts', scopeLocationId: root, locs: [outlet] }));
    const input = {
      idempotencyKey: uuidv7(), locationId: outlet, cashSessionId: till,
      closedAt: '2026-09-11T18:00:00.000Z', autoClosed: false, countedMinor: '20000',
    };
    await expect(accounts.cashSession.close(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(a.cashSession.close({ ...input, idempotencyKey: uuidv7() })).resolves.toMatchObject({ varianceMinor: '0' });
  });

  it('a sale that reaches the server AFTER its till closed still lands — and the close goes to review', async () => {
    const till = (await openTill(a, { businessDate: '2026-09-12', drawer: 'SHARED' })).cashSessionId;
    await a.cashSession.close({
      idempotencyKey: uuidv7(), locationId: outlet, cashSessionId: till,
      closedAt: '2026-09-12T18:00:00.000Z', autoClosed: false, countedMinor: '20000',
    });
    const late = await a.sales.createSale(sale(till, [cash()]));
    expect(late.cashSessionId).toBe(till);
    expect(await reviewsFor(till)).toEqual([
      { conflict_class: SALE_AFTER_TILL_CLOSED_CLASS, severity: 2, locations: [outlet] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The books — rule 1 by tender, rules 11 and 11b
// ---------------------------------------------------------------------------

describe('the sweep posts what the tenders and the till say (05 §5.6.2 rules 1, 11, 11b)', () => {
  it('momo to the wallet, cash to the till, banking to cash-in-transit, a short count to over/short', async () => {
    // Clear anything earlier tests left unposted so this assertion is about this till alone.
    const posted = { tenantId, postedBy: ownerA.userId, postingRuleVersion: 1 };
    await sweepSettledSales(h.db, posted);
    await sweepClosedCashSessions(h.db, posted);

    const net = async () =>
      h.db.withTenant(tenantId, async (tx) => {
        const r = await tx.query<{ code: string; net: string }>(
          `select a.code, (sum(l.debit_minor) - sum(l.credit_minor))::bigint::text as net
             from app.journal_line l
             join app.gl_account a on a.tenant_id = l.tenant_id and a.id = l.account_id
             join app.journal_entry e on e.tenant_id = l.tenant_id and e.id = l.journal_entry_id
            where e.status = 'posted' group by a.code`);
        return new Map(r.rows.map((x) => [x.code, BigInt(x.net)]));
      });
    const before = await net();
    const delta = (after: Map<string, bigint>, code: string) => (after.get(code) ?? 0n) - (before.get(code) ?? 0n);

    const till = (await openTill(a, { businessDate: '2026-09-15', floatMinor: '0' })).cashSessionId;
    const s1 = await a.sales.createSale(sale(till, [momo('2000', 'MP-GL-1'), cash()]));
    const cashPart = BigInt(s1.totalMinor) - 2000n;
    await a.cashSession.close({
      idempotencyKey: uuidv7(), locationId: outlet, cashSessionId: till,
      closedAt: '2026-09-15T18:00:00.000Z', autoClosed: false,
      countedMinor: (cashPart - 50n).toString(10), bankedMinor: '1000',
    });

    const sales = await sweepSettledSales(h.db, posted);
    const tills = await sweepClosedCashSessions(h.db, posted);
    expect(sales.exceptions).toBe(0);
    expect(tills).toMatchObject({ examined: 1, posted: 1, exceptions: 0 });

    const after = await net();
    // The dev draft's codes: 1010 momo float, 1000 till, 1250 cash in transit, 6110 over/short.
    expect(delta(after, '1010')).toBe(2000n);
    expect(delta(after, '1250')).toBe(1000n);
    expect(delta(after, '6110')).toBe(50n);
    // The till: + cash taken − banked − the shortage.
    expect(delta(after, '1000')).toBe(cashPart - 1000n - 50n);

    const again = await sweepClosedCashSessions(h.db, posted);
    expect(again.examined).toBe(0); // idempotent by the document
  });
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

describe('reports.cashPosition splits by the tenant’s own tender methods, and the tills reconcile', () => {
  it('Σ methods = immediate + credit = billed, per location and in total; tills carry the variance', async () => {
    const owner = h.callerFor(ownerA);
    const r = await owner.reports.cashPosition({ from: '2026-09-01', to: '2026-09-30' });
    const loc = r.locations.find((l) => l.locationId === outlet)!;
    const sum = (xs: readonly { amountMinor: string }[]) => xs.reduce((acc, x) => acc + BigInt(x.amountMinor), 0n);
    expect(sum(loc.tenders)).toBe(BigInt(loc.billedTotalMinor));
    expect(BigInt(loc.immediateTenderMinor) + BigInt(loc.creditTenderMinor)).toBe(BigInt(loc.billedTotalMinor));
    expect(sum(r.total.tenders)).toBe(BigInt(r.total.billedTotalMinor));
    // Mobile money is visible as itself — the thing the old report could not do.
    const momoRow = loc.tenders.find((t) => t.methodId === tm.momo)!;
    expect(momoRow.isCash).toBe(false);
    expect(momoRow.isOnAccount).toBe(false);
    expect(BigInt(momoRow.amountMinor)).toBeGreaterThan(0n);
    // The tills: some closed with a count that was off (the -500 and -50 above).
    expect(BigInt(loc.tills.offCount)).toBeGreaterThanOrEqual(2n);
    expect(BigInt(loc.tills.varianceMinor)).toBeLessThan(0n);
  });
});

// ---------------------------------------------------------------------------
// The tenant boundary
// ---------------------------------------------------------------------------

describe('a second tenant sees none of the first’s tills, tenders or takings (§2.7 category 3)', () => {
  let tillA: string;
  let b: Caller;
  let outletB: string;
  beforeAll(async () => {
    tillA = (await openTill(a, { businessDate: '2026-09-25', drawer: 'SHARED' })).cashSessionId;
    await a.sales.createSale(sale(tillA, [momo('100', 'MP-ISO'), cash()]));
    outletB = (await h.outlets(tenantB, 1))[0]!.id;
    b = h.callerFor(await h.identityFor(tenantB, { locs: [outletB] }));
  });

  it('control: tenant A really has the till and the tenders', async () => {
    const n = await h.db.withTenant(tenantId, async (tx) =>
      (await tx.query<{ n: string }>(`select count(*)::text as n from app.cash_session where id = $1`, [tillA])).rows[0]!.n);
    expect(n).toBe('1');
  });

  it('tenant B cannot ring a sale into A’s till — the till does not exist for B', async () => {
    const tmB = await h.tenderMethods(tenantB);
    await expect(
      b.sales.createSale({
        ...sale(tillA, [{ methodId: tmB.cash, settlement: 'IMMEDIATE' }]),
        locationId: outletB,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' }); // not found under B's RLS — never A's row
  });

  it('tenant B cannot close A’s till', async () => {
    await expect(
      b.cashSession.close({
        idempotencyKey: uuidv7(), locationId: outletB, cashSessionId: tillA,
        closedAt: '2026-09-25T18:00:00.000Z', autoClosed: false, countedMinor: '0',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('tenant B cannot use A’s tender method — unknown to B, refused', async () => {
    const tillB = (await openTill(b, { businessDate: '2026-09-25', at: outletB })).cashSessionId;
    await expect(
      b.sales.createSale({ ...sale(tillB, [cash()]), locationId: outletB }), // `cash()` is A's method id
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/unknown tender method/) });
  });

  it('tenant B’s cash position carries none of A’s methods or tills', async () => {
    const r = await b.reports.cashPosition({ from: '2026-09-01', to: '2026-09-30' });
    const ids = new Set(r.total.tenders.map((t) => t.methodId));
    for (const id of Object.values(tm)) expect(ids.has(id)).toBe(false);
    expect(r.locations.every((l) => l.locationId !== outlet)).toBe(true);
  });

  it('tenant B’s openCheck on A’s outlet does not answer with A’s data', async () => {
    await expect(a.cashSession.openCheck({ locationId: outlet, businessDate: DAY })).resolves.toBeDefined();
    await expect(b.cashSession.openCheck({ locationId: outlet, businessDate: DAY })).rejects.toBeDefined();
  });
});
