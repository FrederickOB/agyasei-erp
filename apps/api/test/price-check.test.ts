/**
 * `clientTotalMinor` — the stale-price-list detector (@erp/contracts
 * packages/contracts/src/sale.ts, design decision (b)).
 *
 * A device that has traded offline for days holds a price list that may have
 * moved. It prices the receipt the customer walks out with; the server
 * reprices from the list and the tax rates in force on the BUSINESS DATE
 * (CLAUDE.md §2.5) and writes ITS figure. Before this field, that divergence
 * was completely silent.
 *
 * What these tests pin down is the direction of authority: the server's
 * number is what lands in `app.sale`, the client's is only ever compared, and
 * the comparison is RECORDED — durably, in `write_log.response_body`, so it
 * replays verbatim on a retry — rather than turned into a rejection that
 * would lose a sale whose goods have already left the yard.
 *
 * This is money code, so it is tested (CLAUDE.md §2.7).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@erp/db';
import { createApiHarness, type ApiHarness } from './util.js';

let h: ApiHarness;
let tenantId: string;
let outletId: string;
let productId: string;
let caller: ReturnType<ApiHarness['callerFor']>;

/** 5 units at GH₵55.00 on the post-2026 regime: net 27500, tax 5501. */
const SERVER_TOTAL = '33001';

beforeAll(async () => {
  h = await createApiHarness();
  tenantId = await h.provisionTenant('price-check');
  await h.applyTemplate(tenantId);
  outletId = (await h.firstOutlet(tenantId)).id;
  productId = (await h.pickProduct(tenantId)).id;
  await h.seedWholesalePrice(tenantId, productId, 55_000_000n);
  caller = h.callerFor(await h.identityFor(tenantId, { locs: [outletId] }));
}, 180_000);

afterAll(async () => {
  await h.close();
});

function saleInput(receiptNo: string, clientTotalMinor?: string) {
  return {
    idempotencyKey: uuidv7(),
    locationId: outletId,
    priceListCode: 'WHOLESALE',
    receiptNo,
    businessDate: '2026-01-01',
    tender: 'CASH' as const,
    lines: [{ productId, qty: '5' }],
    ...(clientTotalMinor === undefined ? {} : { clientTotalMinor }),
  };
}

async function storedTotal(saleId: string): Promise<string> {
  return h.db.withTenant(tenantId, async (tx) => {
    const res = await tx.query<{ total_minor: string }>(
      `select total_minor::text from app.sale where id = $1`,
      [saleId],
    );
    return res.rows[0]!.total_minor;
  });
}

describe('clientTotalMinor: the server compares, and never obeys', () => {
  it('omits priceCheck entirely when the client did not send a total', async () => {
    const sale = await caller.sales.createSale(saleInput('R-PC-NONE'));
    expect(sale.totalMinor).toBe(SERVER_TOTAL);
    expect('priceCheck' in sale).toBe(false);
  });

  it('records agreement when the till priced the sale correctly', async () => {
    const sale = await caller.sales.createSale(saleInput('R-PC-OK', SERVER_TOTAL));
    expect(sale.priceCheck).toEqual({
      clientTotalMinor: SERVER_TOTAL,
      serverTotalMinor: SERVER_TOTAL,
      deltaMinor: '0',
      matches: true,
    });
  });

  it('records the divergence when the device traded on a stale price list', async () => {
    // The till believed GH₵300.00; the server reprices to GH₵330.01.
    const sale = await caller.sales.createSale(saleInput('R-PC-STALE', '30000'));
    expect(sale.priceCheck).toEqual({
      clientTotalMinor: '30000',
      serverTotalMinor: SERVER_TOTAL,
      deltaMinor: '3001',
      matches: false,
    });
    // The mismatch is REPORTED, not enforced: the sale is recorded.
    expect(sale.totalMinor).toBe(SERVER_TOTAL);
    expect(await storedTotal(sale.saleId)).toBe(SERVER_TOTAL);
  });

  it('never lets the client number reach app.sale, in either direction', async () => {
    const high = await caller.sales.createSale(saleInput('R-PC-HIGH', '99999999'));
    expect(high.priceCheck).toMatchObject({ deltaMinor: '-99966998', matches: false });
    expect(await storedTotal(high.saleId)).toBe(SERVER_TOTAL);

    const zero = await caller.sales.createSale(saleInput('R-PC-ZERO', '0'));
    expect(zero.priceCheck).toMatchObject({ deltaMinor: SERVER_TOTAL, matches: false });
    expect(await storedTotal(zero.saleId)).toBe(SERVER_TOTAL);
  });

  it('carries every magnitude as a decimal string, never a JSON number', async () => {
    const sale = await caller.sales.createSale(saleInput('R-PC-STRINGS', '30000'));
    const check = sale.priceCheck!;
    for (const field of ['clientTotalMinor', 'serverTotalMinor', 'deltaMinor'] as const) {
      expect(typeof check[field]).toBe('string');
    }
    // A jsonb round trip must not turn any of them into a float64 (03 §3.6.2).
    expect(JSON.parse(JSON.stringify(check))).toEqual(check);
  });

  it('is durable: an idempotent retry replays the recorded discrepancy verbatim', async () => {
    const input = saleInput('R-PC-REPLAY', '30000');
    const first = await caller.sales.createSale(input);
    const replay = await caller.sales.createSale(input);
    expect(replay).toEqual(first);
    expect(replay.priceCheck).toMatchObject({ matches: false, deltaMinor: '3001' });
  });

  it('refuses a client total that is not a decimal string of minor units', async () => {
    for (const bad of [30000, '300.00', '-1', null]) {
      await expect(
        caller.sales.createSale({ ...saleInput('R-PC-BAD'), clientTotalMinor: bad } as never),
      ).rejects.toThrow();
    }
  });
});
