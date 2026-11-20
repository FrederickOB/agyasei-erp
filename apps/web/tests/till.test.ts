/**
 * THE TILL ON THE DEVICE (08 §8.2a) — opening, cashing up, the midnight close.
 *
 * Real SQLite over the device's own schema and SQL, and every queued payload
 * parsed with the SHARED contract the API parses with. Money (category 1):
 * the expected-cash and variance arithmetic, in bigint. Sync (category 2):
 * both writes are outbox ops with one idempotency key each, queued in the
 * order they happened. Every refusal has a positive control.
 */
import { closeCashSessionInput, createSaleInput, openCashSessionInput } from '@erp/contracts';
import { describe, expect, it } from 'vitest';
import type { LocalDb } from '../src/data/db';
import { addProductToCart, createCart } from '../src/data/mutations/cart';
import { checkout } from '../src/data/mutations/checkout';
import {
  autoCloseStaleTill,
  closeTill,
  openTill,
  readOpenTill,
  TillError,
  tillExpectedCash,
} from '../src/data/mutations/till';
import { readPendingOps } from '../src/data/sync/upload';
import { WIRE_KINDS } from '../src/data/sync/transport';
import { fixedHlc, provisionDevice, seedProduct, seedTenderMethods } from './helpers/fixtures';
import { openTestDb } from './helpers/node-db';

const DAY = '2026-08-21';
const MORNING = `${DAY}T07:00:00.000Z`;

async function freshDevice(timeZone = 'UTC'): Promise<{ db: LocalDb; priceListId: string; locationId: string }> {
  const db = openTestDb();
  const device = await provisionDevice(db, { till: false, timeZone });
  return { db, priceListId: device.priceListId, locationId: device.locationId };
}

async function sell(db: LocalDb, priceListId: string, unitPriceE4: bigint, nowIso: string, tenders?: Parameters<typeof checkout>[1]['tenders']) {
  const product = await seedProduct(db, { code: `P-${nowIso}`, name: 'Thing', unitPriceE4, priceListId });
  const cartId = await createCart(db, { nowIso });
  await addProductToCart(db, cartId, product);
  return checkout(db, {
    cartId,
    hlc: fixedHlc(Date.parse(nowIso)),
    nowIso,
    ...(tenders === undefined ? { tenderedMinor: 10_000_000n } : { tenders }),
  });
}

describe('opening a till', () => {
  it('writes the local till AND one queued open, proven against the contract', async () => {
    const { db, locationId } = await freshDevice();
    const till = await openTill(db, {
      openingFloatMinor: 20_000n, businessDate: DAY, openedOffline: true, hlc: fixedHlc(), nowIso: MORNING,
    });
    expect(till).toMatchObject({ status: 'OPEN', businessDate: DAY, openingFloatMinor: 20_000n, openedOffline: true });
    expect((await readOpenTill(db))?.id).toBe(till.id);

    const ops = await readPendingOps(db);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('cash_session_open');
    expect(WIRE_KINDS[ops[0]!.kind]).toBe('cash_session.open');
    // The session id IS the open's idempotency key — one id, minted offline.
    expect(ops[0]!.idempotencyKey).toBe(till.id);
    const payload = openCashSessionInput.parse({ ...JSON.parse(ops[0]!.payloadJson) });
    expect(payload).toMatchObject({ locationId, businessDate: DAY, openingFloatMinor: 20_000n, openedOffline: true, drawer: 'DEVICE' });
  });

  it('one OPEN till at a time — refused, then allowed once the first is closed', async () => {
    const { db } = await freshDevice();
    const first = await openTill(db, { openingFloatMinor: 0n, businessDate: DAY, openedOffline: false, hlc: fixedHlc(), nowIso: MORNING });
    await expect(
      openTill(db, { openingFloatMinor: 0n, businessDate: '2026-08-22', openedOffline: false, hlc: fixedHlc(), nowIso: MORNING }),
    ).rejects.toThrow(/already open/);
    await closeTill(db, { tillId: first.id, countedMinor: 0n, hlc: fixedHlc(), nowIso: MORNING });
    await expect(
      openTill(db, { openingFloatMinor: 0n, businessDate: '2026-08-22', openedOffline: false, hlc: fixedHlc(), nowIso: MORNING }),
    ).resolves.toMatchObject({ businessDate: '2026-08-22' });
  });

  it('ONE till per business date: a second open for a day already opened is refused here, so it never becomes class #17', async () => {
    const { db } = await freshDevice();
    const first = await openTill(db, { openingFloatMinor: 0n, businessDate: DAY, openedOffline: false, hlc: fixedHlc(), nowIso: MORNING });
    await closeTill(db, { tillId: first.id, countedMinor: 0n, hlc: fixedHlc(), nowIso: MORNING });
    await expect(
      openTill(db, { openingFloatMinor: 0n, businessDate: DAY, openedOffline: false, hlc: fixedHlc(), nowIso: MORNING }),
    ).rejects.toThrow(/already been opened for 2026-08-21/);
    expect((await readPendingOps(db)).filter((o) => o.kind === 'cash_session_open')).toHaveLength(1);
  });

  it('never into a CLOSED or LOCKED accounting period it can see — offline too', async () => {
    const { db } = await freshDevice();
    await db.execute(
      `INSERT INTO accounting_period (id, tenant_id, fy_code, seq, starts_on, ends_on, status, updated_at)
       VALUES ('p1', NULL, 'FY27', 1, '2026-08-01', '2026-08-31', 'locked', NULL)`,
    );
    await expect(
      openTill(db, { openingFloatMinor: 0n, businessDate: DAY, openedOffline: true, hlc: fixedHlc(), nowIso: MORNING }),
    ).rejects.toThrow(/period covering 2026-08-21 is locked/);
    // Positive control: the next month is not in a closed period.
    await expect(
      openTill(db, { openingFloatMinor: 0n, businessDate: '2026-09-01', openedOffline: true, hlc: fixedHlc(), nowIso: MORNING }),
    ).resolves.toMatchObject({ status: 'OPEN' });
  });

  it('refuses a negative float', async () => {
    const { db } = await freshDevice();
    await expect(
      openTill(db, { openingFloatMinor: -1n, businessDate: DAY, openedOffline: false, hlc: fixedHlc(), nowIso: MORNING }),
    ).rejects.toBeInstanceOf(TillError);
  });
});

describe('cash-up: expected, counted, variance — in bigint, before anything is confirmed', () => {
  it('expected = float + the CASH applied to every sale in the till; mobile money is not in the drawer', async () => {
    const { db, priceListId } = await freshDevice();
    const till = await openTill(db, { openingFloatMinor: 20_000n, businessDate: DAY, openedOffline: false, hlc: fixedHlc(), nowIso: MORNING });
    const tm = await seedTenderMethods(db);
    // Sale 1: 5000 all cash (handed 10 000 — the CHANGE does not stay in the drawer).
    await sell(db, priceListId, 50_000_000n, `${DAY}T09:00:00.000Z`, [
      { method: tm.cash, amountMinor: null, tenderedMinor: 10_000n },
    ]);
    // Sale 2: 7000 split — 3000 on the phone wallet, 4000 cash.
    await sell(db, priceListId, 70_000_000n, `${DAY}T10:00:00.000Z`, [
      { method: tm.wallet, amountMinor: 3_000n, reference: 'W-1' },
      { method: tm.cash, amountMinor: null, tenderedMinor: 4_000n },
    ]);
    // Sale 3: 2000 entirely on the wallet.
    await sell(db, priceListId, 20_000_000n, `${DAY}T11:00:00.000Z`, [
      { method: tm.wallet, amountMinor: null, reference: 'W-2' },
    ]);
    expect(await tillExpectedCash(db, till)).toBe(20_000n + 5_000n + 4_000n);

    const closed = await closeTill(db, {
      tillId: till.id, countedMinor: 28_500n, bankedMinor: 20_000n, hlc: fixedHlc(), nowIso: `${DAY}T18:00:00.000Z`,
    });
    expect(closed.expectedMinor).toBe(29_000n);
    expect(closed.varianceMinor).toBe(-500n); // short
    expect(closed.till).toMatchObject({ status: 'CLOSED', countedMinor: 28_500n, bankedMinor: 20_000n, expectedMinor: 29_000n });

    const close = (await readPendingOps(db)).at(-1)!;
    expect(close.kind).toBe('cash_session_close');
    const payload = closeCashSessionInput.parse(JSON.parse(close.payloadJson));
    expect(payload).toMatchObject({
      cashSessionId: till.id, autoClosed: false, countedMinor: 28_500n, bankedMinor: 20_000n,
      clientExpectedMinor: 29_000n,
    });
  });

  it('the queue holds the day IN ORDER: open, the sales, the close', async () => {
    const { db, priceListId } = await freshDevice();
    const till = await openTill(db, { openingFloatMinor: 0n, businessDate: DAY, openedOffline: false, hlc: fixedHlc(), nowIso: MORNING });
    await sell(db, priceListId, 10_000_000n, `${DAY}T09:00:00.000Z`);
    await closeTill(db, { tillId: till.id, countedMinor: 1_000n, hlc: fixedHlc(), nowIso: `${DAY}T18:00:00.000Z` });
    const kinds = (await readPendingOps(db)).map((o) => o.kind);
    expect(kinds).toEqual(['cash_session_open', 'sale', 'cash_session_close']);
    const sale = createSaleInput.parse(JSON.parse((await readPendingOps(db))[1]!.payloadJson));
    expect(sale.cashSessionId).toBe(till.id);
  });

  it('refuses to close while a sale is in progress, without a count, or banking more than was counted', async () => {
    const { db, priceListId } = await freshDevice();
    const till = await openTill(db, { openingFloatMinor: 1_000n, businessDate: DAY, openedOffline: false, hlc: fixedHlc(), nowIso: MORNING });
    const product = await seedProduct(db, { code: 'P', name: 'Thing', unitPriceE4: 10_000_000n, priceListId });
    const cartId = await createCart(db, { nowIso: MORNING });
    await addProductToCart(db, cartId, product);
    await expect(closeTill(db, { tillId: till.id, countedMinor: 1_000n, hlc: fixedHlc(), nowIso: MORNING }))
      .rejects.toThrow(/sale is in progress/);
    await db.execute('DELETE FROM cart_line');
    await expect(closeTill(db, { tillId: till.id, hlc: fixedHlc(), nowIso: MORNING })).rejects.toThrow(/Count the drawer/);
    await expect(closeTill(db, { tillId: till.id, countedMinor: 1_000n, bankedMinor: 1_001n, hlc: fixedHlc(), nowIso: MORNING }))
      .rejects.toThrow(/bank more than you counted/);
    // Positive control: the clean close goes through, once.
    await expect(closeTill(db, { tillId: till.id, countedMinor: 1_000n, hlc: fixedHlc(), nowIso: MORNING }))
      .resolves.toMatchObject({ varianceMinor: 0n });
    await expect(closeTill(db, { tillId: till.id, countedMinor: 1_000n, hlc: fixedHlc(), nowIso: MORNING }))
      .rejects.toThrow(/already closed/);
  });
});

describe('the midnight close (08 §8.2a)', () => {
  it('past local midnight the till closes itself, UNCOUNTED, and the next till is a NEW one', async () => {
    const { db, priceListId } = await freshDevice('Africa/Accra');
    const till = await openTill(db, { openingFloatMinor: 5_000n, businessDate: DAY, openedOffline: false, hlc: fixedHlc(), nowIso: MORNING });
    await sell(db, priceListId, 10_000_000n, `${DAY}T20:00:00.000Z`);

    // Still the 21st: nothing to close.
    expect(await autoCloseStaleTill(db, { hlc: fixedHlc(), nowIso: `${DAY}T23:59:00.000Z` })).toBeNull();
    // Past midnight at the location.
    const closed = await autoCloseStaleTill(db, { hlc: fixedHlc(), nowIso: '2026-08-22T00:00:30.000Z' });
    expect(closed).not.toBeNull();
    expect(closed!.till).toMatchObject({ id: till.id, autoClosed: true, countedMinor: null, status: 'CLOSED' });
    expect(closed!.varianceMinor).toBeNull();
    expect(closed!.expectedMinor).toBe(5_000n + 1_000n); // carried into tomorrow's float
    const op = (await readPendingOps(db)).at(-1)!;
    const payload = closeCashSessionInput.parse(JSON.parse(op.payloadJson));
    expect(payload.autoClosed).toBe(true);
    expect(payload.countedMinor).toBeUndefined();

    expect(await readOpenTill(db)).toBeNull(); // no till → no sale until the new day's opens
    const next = await openTill(db, {
      openingFloatMinor: closed!.expectedMinor, businessDate: '2026-08-22', openedOffline: false,
      hlc: fixedHlc(), nowIso: '2026-08-22T00:01:00.000Z',
    });
    expect(next.id).not.toBe(till.id);
  });

  it('a till dated AHEAD of the device clock is left alone — that is a person’s question, not a reason to stop', async () => {
    const { db } = await freshDevice();
    await openTill(db, { openingFloatMinor: 0n, businessDate: '2026-08-23', openedOffline: true, hlc: fixedHlc(), nowIso: MORNING });
    expect(await autoCloseStaleTill(db, { hlc: fixedHlc(), nowIso: MORNING })).toBeNull();
  });
});
