/**
 * VOIDS AND RETURNS, THROUGH THE REAL ROUTERS — work package R (migration 0030).
 *
 * Every assertion is on what `returns.record`, `cashSession.close`,
 * `POST /sync/upload` and the posting sweep did against real Postgres (PGlite,
 * the real migrations, RLS as `app_user`). The three mandatory categories
 * (CLAUDE.md §2.7):
 *   · money — the void mirrors the sale to the pesewa; a return reprices at the
 *     ORIGINAL's price and tax rate row after both changed; pieces sum back
 *     exactly; cash refunds come off the till's expected cash; an on-account
 *     sale's return is a credit note applied to its CHARGE; the refund bound is
 *     measured against the server's figure; posting rule 10 and the mirrored
 *     void entry balance and unwind;
 *   · sync/conflict — a replayed void or return refunds and restocks ONCE; a key
 *     reused with another payload is refused; class #5 (void vs settled) lands
 *     and goes to a severity-1 review, never auto-resolved;
 *   · the tenant boundary — another tenant's sale answers exactly as a
 *     nonexistent one, and its return rows are invisible.
 * Every refusal is paired with a positive control on the same route.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDevLedger, sweepSaleReturns, sweepSettledSales, uuidv7 } from '@erp/db';
import { signDevToken, type VerifiedIdentity } from '../src/auth.js';
import { RETURN_REFUND_RECONCILED_CLASS, SALE_VOID_VS_SETTLED_CLASS } from '../src/routers/sale-returns.js';
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
let creditAccountId: string;
const DEVICE_A = uuidv7();
let ownerA: VerifiedIdentity;
type Caller = ReturnType<ApiHarness['callerFor']>;
let a: Caller;

let seq = 0;
const docNo = (tag: string) => `RT-${tag}-${String((seq += 1)).padStart(5, '0')}`;

/** One DEVICE till per business date for DEVICE_A; reused within a date. */
const tills = new Map<string, string>();
async function till(day: string, floatMinor = '20000'): Promise<string> {
  const hit = tills.get(day);
  if (hit) return hit;
  const id = uuidv7();
  await a.cashSession.open({
    idempotencyKey: id, locationId: outlet, businessDate: day, openingFloatMinor: floatMinor,
    openedAt: `${day}T07:00:00.000Z`, openedOffline: false, drawer: 'DEVICE',
  });
  tills.set(day, id);
  return id;
}

type Tender = { methodId: string; settlement: 'IMMEDIATE' | 'ON_ACCOUNT'; amountMinor?: string; reference?: string };
const cash = (amountMinor?: string): Tender => ({
  methodId: tm.cash, settlement: 'IMMEDIATE', ...(amountMinor === undefined ? {} : { amountMinor }),
});
const onAccount = (amountMinor?: string): Tender => ({
  methodId: tm.onAccount, settlement: 'ON_ACCOUNT', ...(amountMinor === undefined ? {} : { amountMinor }),
});

async function ring(day: string, tenders: Tender[], qty = '3', opts: { customerId?: string; caller?: Caller } = {}) {
  return (opts.caller ?? a).sales.createSale({
    idempotencyKey: uuidv7(),
    locationId: outlet,
    cashSessionId: await till(day),
    priceListCode: 'WHOLESALE',
    receiptNo: docNo('S'),
    tenders,
    lines: [{ productId, qty }],
    ...(opts.customerId === undefined ? {} : { customerId: opts.customerId }),
  });
}

function voidInput(saleId: string, cashSessionId: string, key = uuidv7()) {
  return {
    idempotencyKey: key, kind: 'VOID' as const, originalSaleId: saleId, locationId: outlet,
    cashSessionId, returnNo: docNo('V'), reason: 'rung in error',
  };
}

function returnInput(
  saleId: string,
  cashSessionId: string,
  lines: { originalLineNo: number; qty: string; disposition: 'RESTOCK' | 'DAMAGED' }[],
  refund: { methodId?: string; onAccountClaimMinor: string; immediateClaimMinor: string; reference?: string },
  key = uuidv7(),
) {
  return {
    idempotencyKey: key, kind: 'RETURN' as const, originalSaleId: saleId, locationId: outlet,
    cashSessionId, returnNo: docNo('R'), reason: 'customer brought it back',
    lines, refund: { methodId: refund.methodId ?? tm.cash, ...refund },
  };
}

async function q<T>(sql: string, params: unknown[] = [], tenant = tenantId): Promise<T[]> {
  return h.db.withTenant(tenant, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function onHand(): Promise<bigint> {
  const r = await q<{ n: string }>(
    `select coalesce(sum(qty_delta), 0)::text n from app.stock_movement where location_id = $1 and product_id = $2`,
    [outlet, productId],
  );
  return BigInt(r[0]!.n);
}

async function reviewsOn(entityId: string) {
  return q<{ conflict_class: string; severity: number }>(
    `select conflict_class, severity from app.conflict_review where entity_id = $1 order by conflict_class`,
    [entityId],
  );
}

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('returns-a');
  tenantB = await h.provisionTenant('returns-b');
  await h.applyTemplate(tenantId, true);
  await h.applyTemplate(tenantB, true);
  root = await h.locationByCode(tenantId, 'ROOT');
  const outs = await h.outlets(tenantId, 2);
  outlet = outs[0]!.id;
  outlet2 = outs[1]!.id;
  productId = (await h.pickProduct(tenantId)).id;
  await h.seedWholesalePrice(tenantId, productId, 55_000_000n); // GH₵55.00
  tm = await h.tenderMethods(tenantId);
  ownerA = await h.identityFor(tenantId, { locs: [root, outlet, outlet2], dev: DEVICE_A });
  a = h.callerFor(ownerA);
  const account = await a.credit.openAccount({
    idempotencyKey: uuidv7(),
    newCustomer: { code: 'RT-C1', name: 'Returns Test Contractor' },
    termsDays: 30, feeRateBpPerMonth: 200, creditLimitMinor: '99999999999',
  });
  creditCustomerId = account.customerId;
  creditAccountId = account.accountId;
  const seeded = await h.db.withTenant(tenantId, (tx) => seedDevLedger(tx, tenantId));
  expect(seeded.unmappedRequired).toEqual([]);
}, 240_000);

afterAll(async () => {
  await h?.close();
});

describe('a VOID — the whole sale, same till, figure for figure', () => {
  it('mirrors the sale, restocks it, and takes its cash back off the till’s expected cash', async () => {
    const day = '2026-09-03';
    const session = await till(day, '20000');
    const before = await onHand();
    const sale = await ring(day, [cash()]);
    expect(await onHand()).toBe(before - 3n);

    const v = await a.returns.record(voidInput(sale.saleId, session));
    expect(v).toMatchObject({
      kind: 'VOID', originalSaleId: sale.saleId, businessDate: day,
      subtotalNetMinor: sale.subtotalNetMinor, taxTotalMinor: sale.taxTotalMinor, totalMinor: sale.totalMinor,
      reviews: [],
    });
    expect(v.refunds).toEqual([
      { seq: 1, methodId: tm.cash, settlement: 'IMMEDIATE', amountMinor: sale.totalMinor, claimedMinor: null, reference: null },
    ]);
    expect(await onHand()).toBe(before);
    const moved = await q<{ kind: string; qty: string; session: string | null }>(
      `select source_kind as kind, qty_delta::text as qty, cash_session_id as session
         from app.stock_movement where source_id = $1`, [v.returnId]);
    expect(moved).toEqual([{ kind: 'SALE_RETURN', qty: '3', session }]);

    // Cash-up: the sale's cash came in and the void's went out — expected is the float.
    const closed = await a.cashSession.close({
      idempotencyKey: uuidv7(), locationId: outlet, cashSessionId: session,
      closedAt: `${day}T18:00:00.000Z`, autoClosed: false, countedMinor: '20000',
    });
    expect(closed).toMatchObject({ expectedCashMinor: '20000', varianceMinor: '0' });
  });

  it('is refused in a later till (a later refund is a RETURN) — and lands in its own', async () => {
    const saleDay = '2026-09-04';
    const saleTill = await till(saleDay);
    const sale = await ring(saleDay, [cash()]);
    const later = await till('2026-09-05');
    await expect(a.returns.record(voidInput(sale.saleId, later))).rejects.toThrow(/a void is made in the till its sale was rung in/);
    expect(await q(`select 1 from app.sale_return where original_sale_id = $1`, [sale.saleId])).toEqual([]);
    const ok = await a.returns.record(voidInput(sale.saleId, saleTill));
    expect(ok.kind).toBe('VOID');
  });

  it('a void of an on-account sale is a credit note against the CHARGE, never cash', async () => {
    const day = '2026-09-06';
    const session = await till(day);
    const sale = await ring(day, [onAccount()], '2', { customerId: creditCustomerId });
    const v = await a.returns.record(voidInput(sale.saleId, session));
    expect(v.refunds.map((r) => r.settlement)).toEqual(['ON_ACCOUNT']);
    expect(v.creditNote).toEqual({ accountId: creditAccountId, appliedMinor: sale.totalMinor, unappliedMinor: '0' });
    const entries = await q<{ kind: string; amount: string; applies: string | null }>(
      `select kind, amount_minor::text amount, applies_to_id applies from app.credit_entry
        where source_kind = 'SALE_RETURN' and source_id = $1`, [v.returnId]);
    const charge = await q<{ id: string }>(
      `select id from app.credit_entry where source_kind = 'SALE' and source_id = $1`, [sale.saleId]);
    expect(entries).toEqual([{ kind: 'ADJUSTMENT', amount: `-${sale.totalMinor}`, applies: charge[0]!.id }]);
    // The customer's balance is back where it was before the sale.
    const bal = await q<{ b: string }>(
      `select coalesce(sum(amount_minor),0)::text b from app.credit_entry
        where account_id = $1 and (source_id = $2 or source_id = $3)`, [creditAccountId, sale.saleId, v.returnId]);
    expect(bal[0]!.b).toBe('0');
  });
});

describe('a RETURN — some lines, later, at the ORIGINAL’s prices and rates', () => {
  it('reprices at the original’s snapshot after the price changed; pieces sum back exactly', async () => {
    const saleDay = '2026-09-07';
    await till(saleDay);
    const sale = await ring(saleDay, [cash()], '3');
    // The price moves the next day. A return must not see it.
    await h.seedWholesalePrice(tenantId, productId, 61_000_000n, '2026-09-08');
    const later = await till('2026-09-08', '10000');
    const fresh = await ring('2026-09-08', [cash()], '1');
    expect(BigInt(fresh.subtotalNetMinor)).toBe(6100n);

    const r1 = await a.returns.record(returnInput(sale.saleId, later, [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }],
      { onAccountClaimMinor: '0', immediateClaimMinor: '0' }));
    const r2 = await a.returns.record(returnInput(sale.saleId, later, [{ originalLineNo: 1, qty: '2', disposition: 'RESTOCK' }],
      { onAccountClaimMinor: '0', immediateClaimMinor: '0' }));
    // Priced from the ORIGINAL: GH₵55.00 a unit, not today's 61.00.
    expect(r1.subtotalNetMinor).toBe('5500');
    expect(BigInt(r1.totalMinor) + BigInt(r2.totalMinor)).toBe(BigInt(sale.totalMinor));
    expect(BigInt(r1.taxTotalMinor) + BigInt(r2.taxTotalMinor)).toBe(BigInt(sale.taxTotalMinor));
    // Tax lines are pinned to the sale's own rate rows (ADR-0002).
    const pinned = await q<{ same: boolean }>(
      `select bool_and(rt.tax_rate_id = st.tax_rate_id and rt.rate_bp = st.rate_bp) as same
         from app.sale_return_tax_line rt
         join app.sale_tax_line st on st.id = rt.original_tax_line_id
        where rt.return_id = any($1::uuid[])`, [[r1.returnId, r2.returnId]]);
    expect(pinned[0]!.same).toBe(true);
    // The device claimed 0 and the server refunded cash: recorded, compared, reviewed.
    expect(r1.refunds[0]).toMatchObject({ amountMinor: r1.totalMinor, claimedMinor: '0' });
    expect(r1.reviews).toEqual([RETURN_REFUND_RECONCILED_CLASS]);
    expect((await reviewsOn(r1.returnId)).map((x) => x.severity)).toEqual([2]);
  });

  it('a cash refund comes off the LATER till’s expected cash, not the sale’s', async () => {
    const saleDay = '2026-09-09';
    await till(saleDay);
    const sale = await ring(saleDay, [cash()], '2');
    const later = await till('2026-09-10', '30000');
    const one = await a.returns.record(returnInput(sale.saleId, later, [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }],
      { onAccountClaimMinor: '0', immediateClaimMinor: '0' }));
    const closed = await a.cashSession.close({
      idempotencyKey: uuidv7(), locationId: outlet, cashSessionId: later,
      closedAt: '2026-09-10T18:00:00.000Z', autoClosed: false, countedMinor: '30000',
    });
    expect(closed.expectedCashMinor).toBe((30000n - BigInt(one.totalMinor)).toString());
  });

  it('damaged goods come back (cost reversed) and are written off (a loss): net on-hand unchanged', async () => {
    const day = '2026-09-11';
    const session = await till(day);
    const sale = await ring(day, [cash()], '2');
    const before = await onHand();
    const r = await a.returns.record(returnInput(sale.saleId, session, [{ originalLineNo: 1, qty: '2', disposition: 'DAMAGED' }],
      { onAccountClaimMinor: '0', immediateClaimMinor: sale.totalMinor }));
    expect(r.reviews).toEqual([]);
    expect(await onHand()).toBe(before);
    const moved = await q<{ kind: string; qty: string; reason: string }>(
      `select m.source_kind kind, m.qty_delta::text qty, r.code reason from app.stock_movement m
         join app.movement_reason r on r.id = m.reason_id where m.source_id = $1 order by m.qty_delta desc`, [r.returnId]);
    expect(moved).toEqual([
      { kind: 'SALE_RETURN', qty: '2', reason: 'RETURN_DAMAGED' },
      { kind: 'WRITE_OFF', qty: '-2', reason: 'RETURN_DAMAGED' },
    ]);
  });

  it('an on-account sale’s return is credited to the account first, never paid out in cash', async () => {
    const day = '2026-09-12';
    const session = await till(day);
    const sale = await ring(day, [onAccount()], '2', { customerId: creditCustomerId });
    // The device chose cash and claimed it all as cash. The server's rule wins:
    // the account takes it, the claim is kept, and a person is told.
    const r = await a.returns.record(returnInput(sale.saleId, session, [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }],
      { onAccountClaimMinor: '0', immediateClaimMinor: '1' }));
    const half = r.totalMinor;
    expect(r.refunds).toEqual([
      expect.objectContaining({ settlement: 'ON_ACCOUNT', amountMinor: half, claimedMinor: '0' }),
      expect.objectContaining({ settlement: 'IMMEDIATE', amountMinor: '0', claimedMinor: '1' }),
    ]);
    expect(r.creditNote).toMatchObject({ appliedMinor: half, unappliedMinor: '0' });
    expect(r.reviews).toEqual([RETURN_REFUND_RECONCILED_CLASS]);
  });

  it('refuses an account credit on a sale that charged no account — positive control: cash', async () => {
    const day = '2026-09-13';
    const session = await till(day);
    const sale = await ring(day, [cash()], '1');
    await expect(a.returns.record(returnInput(sale.saleId, session, [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }],
      { onAccountClaimMinor: sale.totalMinor, immediateClaimMinor: '0' }))).rejects.toThrow(/charged no account/);
    const ok = await a.returns.record(returnInput(sale.saleId, session, [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }],
      { onAccountClaimMinor: '0', immediateClaimMinor: sale.totalMinor }));
    expect(ok.reviews).toEqual([]);
  });

  it('refuses a cross-outlet return, a line the sale does not have, and more of a line than it sold', async () => {
    const day = '2026-09-15';
    const session = await till(day);
    const sale = await ring(day, [cash()], '2');
    const refund = { onAccountClaimMinor: '0', immediateClaimMinor: '0' };
    await expect(a.returns.record({
      ...returnInput(sale.saleId, session, [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }], refund),
      locationId: outlet2,
    })).rejects.toThrow(/cross-outlet/);
    await expect(a.returns.record(returnInput(sale.saleId, session, [{ originalLineNo: 9, qty: '1', disposition: 'RESTOCK' }], refund)))
      .rejects.toThrow(/no line 9/);
    await expect(a.returns.record(returnInput(sale.saleId, session, [{ originalLineNo: 1, qty: '3', disposition: 'RESTOCK' }], refund)))
      .rejects.toThrow(/more than the 2 it sold/);
    expect(await q(`select 1 from app.sale_return where original_sale_id = $1`, [sale.saleId])).toEqual([]);
    const ok = await a.returns.record(returnInput(sale.saleId, session, [{ originalLineNo: 1, qty: '2', disposition: 'RESTOCK' }], refund));
    expect(BigInt(ok.totalMinor)).toBe(BigInt(sale.totalMinor));
  });
});

describe('capabilities: sale.void and sale.return, at the location, bound on the SERVER’s figure', () => {
  it('counter staff can do neither; an outlet manager can, up to the template bound', async () => {
    const day = '2026-09-17';
    const sharedTill = await h.openTill(tenantId, outlet, day);
    const clerk = h.callerFor(await h.principal(tenantId, { roleRef: 'counter_staff', scopeLocationId: outlet }));
    const manager = h.callerFor(await h.principal(tenantId, { roleRef: 'outlet_manager', scopeLocationId: outlet }));
    const sale = await manager.sales.createSale({
      idempotencyKey: uuidv7(), locationId: outlet, cashSessionId: sharedTill, priceListCode: 'WHOLESALE',
      receiptNo: docNo('S'), tenders: [cash()], lines: [{ productId, qty: '1' }],
    });
    const refund = { onAccountClaimMinor: '0', immediateClaimMinor: sale.totalMinor };
    await expect(clerk.returns.record(voidInput(sale.saleId, sharedTill))).rejects.toThrow(/sale\.void/);
    await expect(clerk.returns.record(returnInput(sale.saleId, sharedTill, [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }], refund)))
      .rejects.toThrow(/sale\.return/);
    // A sale far above GH₵5,000: 200 units at GH₵55 + tax.
    const big = await manager.sales.createSale({
      idempotencyKey: uuidv7(), locationId: outlet, cashSessionId: sharedTill, priceListCode: 'WHOLESALE',
      receiptNo: docNo('S'), tenders: [cash()], lines: [{ productId, qty: '200' }],
    });
    await expect(manager.returns.record(returnInput(big.saleId, sharedTill, [{ originalLineNo: 1, qty: '200', disposition: 'RESTOCK' }],
      { onAccountClaimMinor: '0', immediateClaimMinor: big.totalMinor }))).rejects.toThrow(/max_refund_minor=500000/);
    expect(await q(`select 1 from app.sale_return where original_sale_id = $1`, [big.saleId])).toEqual([]);
    // Positive controls: within the bound, and the void (unbounded) of the same small sale.
    const within = await manager.returns.record(returnInput(big.saleId, sharedTill, [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }],
      { onAccountClaimMinor: '0', immediateClaimMinor: '0' }));
    expect(BigInt(within.totalMinor) <= 500000n).toBe(true);
    const voided = await manager.returns.record(voidInput(sale.saleId, sharedTill));
    expect(voided.kind).toBe('VOID');
  });
});

describe('offline replay and class #5', () => {
  it('a void and a return replayed through /sync/upload refund and restock ONCE', async () => {
    const day = '2026-09-19';
    const session = await till(day);
    const sale1 = await ring(day, [cash()], '1');
    const sale2 = await ring(day, [cash()], '2');
    const app: FastifyInstance = await buildServer({ deps: h.deps, jwtSecret: JWT_SECRET });
    try {
      const bearer = await signDevToken(JWT_SECRET, { tid: tenantId, uid: ownerA.userId, role: 'x', locs: [outlet], dev: DEVICE_A });
      const { idempotencyKey: vKey, ...vPayload } = voidInput(sale1.saleId, session);
      const { idempotencyKey: rKey, ...rPayload } = returnInput(sale2.saleId, session,
        [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }], { onAccountClaimMinor: '0', immediateClaimMinor: '0' });
      const ops = [
        { idempotency_key: vKey, kind: 'sale.return', claimed_hlc: h.deps.clock.next(), payload: vPayload },
        { idempotency_key: rKey, kind: 'sale.return', claimed_hlc: h.deps.clock.next(), payload: rPayload },
      ];
      const send = async (body: unknown) =>
        (await app.inject({ method: 'POST', url: '/sync/upload', headers: { authorization: `Bearer ${bearer}` }, payload: body as Record<string, unknown> })).json() as {
          acks: { key: string; status: string; reason?: string }[];
        };
      const stockBefore = await onHand();
      expect((await send({ ops })).acks.map((x) => x.status)).toEqual(['applied', 'applied']);
      const stockAfter = await onHand();
      expect(stockAfter - stockBefore).toBe(2n);
      expect((await send({ ops })).acks.map((x) => x.status)).toEqual(['duplicate', 'duplicate']);
      expect(await onHand()).toBe(stockAfter);
      const counts = await q<{ docs: string; refunds: string; moves: string }>(
        `select (select count(*) from app.sale_return where id = any($1::uuid[]))::text docs,
                (select count(*) from app.sale_return_refund where return_id = any($1::uuid[]))::text refunds,
                (select count(*) from app.stock_movement where source_id = any($1::uuid[]))::text moves`,
        [[vKey, rKey]]);
      expect(counts).toEqual([{ docs: '2', refunds: '2', moves: '2' }]);
      // The same key with a different payload is a client bug, refused — never applied.
      const reused = await send({ ops: [{ ...ops[1], payload: { ...rPayload, reason: 'something else' } }] });
      expect(reused.acks[0]).toMatchObject({ status: 'rejected' });
      expect(reused.acks[0]!.reason).toMatch(/IDEMPOTENCY_KEY_REUSE/);
    } finally {
      await app.close();
    }
  });

  it('two tills each return the last unit while offline: both land, the second goes to a severity-1 review', async () => {
    const day = '2026-09-20';
    const session = await till(day);
    const sale = await ring(day, [cash()], '1');
    const first = await a.returns.record(returnInput(sale.saleId, session, [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }],
      { onAccountClaimMinor: '0', immediateClaimMinor: sale.totalMinor }));
    expect(first.reviews).toEqual([]);
    const second = await a.returns.record(returnInput(sale.saleId, session, [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }],
      { onAccountClaimMinor: '0', immediateClaimMinor: sale.totalMinor }));
    // The cash physically left twice; the record says so, and a person decides.
    expect(second.totalMinor).toBe(sale.totalMinor);
    expect(second.reviews).toEqual([SALE_VOID_VS_SETTLED_CLASS]);
    expect(await reviewsOn(sale.saleId)).toEqual([{ conflict_class: SALE_VOID_VS_SETTLED_CLASS, severity: 1 }]);
  });

  it('a void arriving after a return of the same sale lands and is flagged (never auto-resolved)', async () => {
    const day = '2026-09-21';
    const session = await till(day);
    const sale = await ring(day, [cash()], '2');
    await a.returns.record(returnInput(sale.saleId, session, [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }],
      { onAccountClaimMinor: '0', immediateClaimMinor: '0' }));
    const v = await a.returns.record(voidInput(sale.saleId, session));
    expect(v.totalMinor).toBe(sale.totalMinor);
    expect(v.reviews).toContain(SALE_VOID_VS_SETTLED_CLASS);
    const open = await q<{ status: string }>(
      `select status from app.conflict_review where entity_id = $1 and conflict_class = $2`, [sale.saleId, SALE_VOID_VS_SETTLED_CLASS]);
    expect(open).toEqual([{ status: 'open' }]);
  });

  it('a void of a credit sale the customer already PAID leaves unapplied credit and a severity-1 review', async () => {
    const day = '2026-09-22';
    const session = await till(day);
    const sale = await ring(day, [onAccount()], '1', { customerId: creditCustomerId });
    const charge = (await q<{ id: string }>(
      `select id from app.credit_entry where source_kind = 'SALE' and source_id = $1`, [sale.saleId]))[0]!.id;
    await a.credit.recordEntry({
      idempotencyKey: uuidv7(), accountId: creditAccountId, kind: 'PAYMENT', amountMinor: `-${sale.totalMinor}`,
      businessDate: day, appliesToId: charge,
    });
    const v = await a.returns.record(voidInput(sale.saleId, session));
    expect(v.creditNote).toMatchObject({ appliedMinor: '0', unappliedMinor: sale.totalMinor });
    expect(v.reviews).toContain(SALE_VOID_VS_SETTLED_CLASS);
  });
});

describe('the tenant boundary', () => {
  it('another tenant’s sale answers exactly as a sale that does not exist, and its rows are invisible', async () => {
    const day = '2026-09-23';
    const session = await till(day);
    const ownerB = await h.identityFor(tenantB, { locs: [await h.locationByCode(tenantB, 'ROOT')] });
    const outletB = (await h.outlets(tenantB, 1))[0]!.id;
    const bProduct = (await h.pickProduct(tenantB)).id;
    await h.seedWholesalePrice(tenantB, bProduct, 40_000_000n);
    const bTill = await h.openTill(tenantB, outletB, day);
    const b = h.callerFor(await h.identityFor(tenantB, { locs: [outletB] }));
    const bSale = await b.sales.createSale({
      idempotencyKey: uuidv7(), locationId: outletB, cashSessionId: bTill, priceListCode: 'WHOLESALE',
      receiptNo: 'B-1', tenders: [{ methodId: (await h.tenderMethods(tenantB)).cash, settlement: 'IMMEDIATE' }],
      lines: [{ productId: bProduct, qty: '1' }],
    });
    await b.returns.record({ ...voidInput(bSale.saleId, bTill), locationId: outletB });
    expect(ownerB.tenantId).toBe(tenantB);

    const crossTenant = a.returns.record(voidInput(bSale.saleId, session)).then(() => 'resolved', (e: Error) => e.message);
    const missingId = uuidv7();
    const nonexistent = a.returns.record(voidInput(missingId, session)).then(() => 'resolved', (e: Error) => e.message);
    expect((await crossTenant).replace(bSale.saleId, 'X')).toBe((await nonexistent).replace(missingId, 'X'));
    expect(await crossTenant).toMatch(/RETRY_LATER/);

    const seenByA = await q<{ n: string }>(`select count(*)::text n from app.sale_return where original_sale_id = $1`, [bSale.saleId]);
    expect(seenByA[0]!.n).toBe('0');
    const seenByB = await q<{ n: string }>(`select count(*)::text n from app.sale_return where original_sale_id = $1`, [bSale.saleId], tenantB);
    expect(seenByB[0]!.n).toBe('1'); // positive control: B's own row is there
  });
});

describe('the document identities, enforced by the database at COMMIT', () => {
  /** Insert a return directly, in one transaction, then mutate one thing. */
  async function plant(mutate: 'none' | 'refund_short' | 'foreign_rate' | 'cross_location') {
    const day = '2026-09-24';
    const session = await till(day);
    const sale = await ring(day, [cash()], '1');
    return h.db.withTenant(tenantId, async (tx) => {
      const w = uuidv7();
      await tx.query(
        `insert into app.write_log (tenant_id, id, origin, hlc, op, schema_version, request_hash)
         values ($1, $2, 'SERVER', $3, 'test.plant', 1, decode(md5($4), 'hex'))`,
        [tenantId, w, h.deps.clock.next(), w]);
      const s = (await tx.query<Record<string, string>>(`select * from app.sale where id = $1`, [sale.saleId])).rows[0]!;
      const l = (await tx.query<Record<string, string>>(`select * from app.sale_line where sale_id = $1`, [sale.saleId])).rows[0]!;
      const taxes = (await tx.query<Record<string, string>>(`select * from app.sale_tax_line where sale_id = $1`, [sale.saleId])).rows;
      const loc = mutate === 'cross_location' ? outlet2 : outlet;
      await tx.query(
        `insert into app.sale_return (tenant_id, id, write_id, hlc, kind, original_sale_id, location_id, cash_session_id,
           business_date, occurred_at, return_no, reason, currency_code, money_scale,
           subtotal_net_minor, discount_minor, tax_total_minor, total_minor)
         values ($1,$2,$3,$4,'RETURN',$5,$6,$7,$8::date,now(),$9,'planted',$10,$11,$12,$13,$14,$15)`,
        [tenantId, w, w, h.deps.clock.next(), sale.saleId, loc, session, day, docNo('P'), s['currency_code'], s['money_scale'],
          s['subtotal_net_minor'], s['discount_minor'], s['tax_total_minor'], s['total_minor']]);
      const lineId = uuidv7();
      await tx.query(
        `insert into app.sale_return_line (tenant_id, id, write_id, hlc, return_id, line_no, original_sale_line_id, product_id,
           location_id, qty_sell, qty_sell_scale, unit_price_e4, stocking_uom_id, qty_stock, qty_stock_scale,
           line_net_minor, line_discount_minor, tax_minor, disposition)
         values ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'RESTOCK')`,
        [tenantId, lineId, w, h.deps.clock.next(), w, l['id'], l['product_id'], loc, l['qty_sell'], l['qty_sell_scale'],
          l['unit_price_e4'], l['stocking_uom_id'], l['qty_stock'], l['qty_stock_scale'], l['line_net_minor'],
          l['line_discount_minor'], l['tax_minor']]);
      const foreignRate = mutate === 'foreign_rate'
        ? (await tx.query<{ id: string }>(`select id from platform.tax_rate where id <> $1 limit 1`, [taxes[0]!['tax_rate_id']])).rows[0]!.id
        : null;
      for (const t of taxes) {
        await tx.query(
          `insert into app.sale_return_tax_line (tenant_id, id, write_id, hlc, return_id, return_line_id, original_tax_line_id,
             location_id, seq, tax_code, rate_bp, base_minor, tax_minor, tax_rate_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [tenantId, uuidv7(), w, h.deps.clock.next(), w, lineId, t['id'], loc, t['seq'], t['tax_code'], t['rate_bp'],
            t['base_minor'], t['tax_minor'], foreignRate ?? t['tax_rate_id']]);
      }
      const refund = mutate === 'refund_short' ? (BigInt(s['total_minor']!) - 1n).toString() : s['total_minor'];
      await tx.query(
        `insert into app.sale_return_refund (tenant_id, id, write_id, hlc, return_id, seq, method_id, amount_minor,
           refunded_at, location_id) values ($1,$2,$3,$4,$5,1,$6,$7,now(),$8)`,
        [tenantId, uuidv7(), w, h.deps.clock.next(), w, tm.cash, refund, loc]);
      return w;
    });
  }

  it('positive control: a planted, consistent return commits', async () => {
    await expect(plant('none')).resolves.toBeTypeOf('string');
  });
  it('SRET0006: refunds that do not sum to the document are refused', async () => {
    await expect(plant('refund_short')).rejects.toThrow(/SRET0006/);
  });
  it('SRET0012: a tax line reversed at a rate row other than the sale’s is refused', async () => {
    await expect(plant('foreign_rate')).rejects.toThrow(/SRET0012/);
  });
  it('SRET0001: a return at another location than its sale is refused', async () => {
    await expect(plant('cross_location')).rejects.toThrow(/SRET0001/);
  });
});

describe('posting: rule 10 for a return, the sale’s entry mirrored for a void', () => {
  it('a void unwinds its sale on every account; a return debits SALES_RETURNS and output tax', async () => {
    const day = '2026-09-25';
    const session = await till(day);
    const sale = await ring(day, [cash()], '2');
    const v = await a.returns.record(voidInput(sale.saleId, session));
    const sale2 = await ring(day, [cash()], '2');
    const r = await a.returns.record(returnInput(sale2.saleId, session, [{ originalLineNo: 1, qty: '1', disposition: 'RESTOCK' }],
      { onAccountClaimMinor: '0', immediateClaimMinor: '0' }));
    const opts = { tenantId, postedBy: ownerA.userId, postingRuleVersion: 1 };
    await sweepSettledSales(h.db, opts);
    const swept = await sweepSaleReturns(h.db, opts);
    expect(swept.exceptions).toBe(0);
    expect(swept.posted).toBeGreaterThanOrEqual(2);

    const netByAccount = await q<{ code: string; net: string }>(
      `select a.code, (sum(l.debit_minor) - sum(l.credit_minor))::text as net
         from app.journal_line l
         join app.journal_entry e on e.tenant_id = l.tenant_id and e.id = l.journal_entry_id
         join app.gl_account a on a.tenant_id = l.tenant_id and a.id = l.account_id
        where e.source_id = any($1::uuid[])
        group by a.code order by a.code`, [[sale.saleId, v.returnId]]);
    expect(netByAccount.length).toBeGreaterThan(0);
    for (const row of netByAccount) expect(row.net).toBe('0');

    const ret = await q<{ code: string; dr: string; cr: string }>(
      `select a.code, sum(l.debit_minor)::text dr, sum(l.credit_minor)::text cr
         from app.journal_line l
         join app.journal_entry e on e.tenant_id = l.tenant_id and e.id = l.journal_entry_id
         join app.gl_account a on a.tenant_id = l.tenant_id and a.id = l.account_id
        where e.source_id = $1 group by a.code order by a.code`, [r.returnId]);
    const byCode = new Map(ret.map((x) => [x.code, x]));
    expect(byCode.get('4195')).toMatchObject({ dr: r.subtotalNetMinor, cr: '0' }); // SALES_RETURNS (draft CoA)
    expect(byCode.get('1000')).toMatchObject({ dr: '0', cr: r.totalMinor }); // TILL_CASH
    const dr = ret.reduce((x, y) => x + BigInt(y.dr), 0n);
    const cr = ret.reduce((x, y) => x + BigInt(y.cr), 0n);
    expect(dr).toBe(cr);
    // Idempotent: a second sweep finds nothing new.
    expect((await sweepSaleReturns(h.db, opts)).examined).toBe(0);
  });
});
