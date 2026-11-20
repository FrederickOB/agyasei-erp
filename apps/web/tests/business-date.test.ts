/**
 * The trading day (03-offline-sync §3.4.2, CLAUDE.md §2.5).
 *
 * `businessDate` is a money test in disguise: the server reprices the sale
 * from the price list in force on that date and computes tax from the
 * effective-dated rate row in force on that date. A sale rung at 22:00 in
 * Techiman that lands on the wrong side of midnight prices against the wrong
 * day, and a rate change is exactly where that stops being harmless.
 */
import { createSaleInput } from '@erp/contracts';
import { describe, expect, it } from 'vitest';
import { addProductToCart, createCart } from '../src/data/mutations/cart';
import { checkout, TillClosedAtMidnightError } from '../src/data/mutations/checkout';
import { autoCloseStaleTill, openTill, readLatestTill } from '../src/data/mutations/till';
import { assertBusinessDate, businessDateFor, BusinessDateError } from '../src/lib/business-date';
import { openTestDb } from './helpers/node-db';
import { fixedHlc, provisionDevice, seedProduct } from './helpers/fixtures';
import type { LocalDb } from '../src/data/db';

describe('businessDateFor', () => {
  it('uses the LOCATION timezone, not the tablet locale', () => {
    // 23:30 UTC is already the next day east of UTC and still today west of it.
    const instant = '2026-08-21T23:30:00.000Z';
    expect(businessDateFor(instant, 'UTC')).toBe('2026-08-21');
    expect(businessDateFor(instant, 'Africa/Accra')).toBe('2026-08-21'); // UTC+0
    expect(businessDateFor(instant, 'Africa/Lagos')).toBe('2026-08-22'); // UTC+1
    expect(businessDateFor(instant, 'America/New_York')).toBe('2026-08-21'); // UTC-4
  });

  it('puts an early-morning instant on the previous trading day west of UTC', () => {
    expect(businessDateFor('2026-08-21T02:00:00.000Z', 'America/Chicago')).toBe('2026-08-20');
  });

  it('falls back to UTC — deterministically — when the zone is missing or unusable', () => {
    expect(businessDateFor('2026-08-21T23:30:00.000Z', null)).toBe('2026-08-21');
    expect(businessDateFor('2026-08-21T23:30:00.000Z', '')).toBe('2026-08-21');
    expect(businessDateFor('2026-08-21T23:30:00.000Z', 'Not/AZone')).toBe('2026-08-21');
  });

  it('refuses an instant it cannot read rather than inventing a day', () => {
    expect(() => businessDateFor('yesterday', 'UTC')).toThrow(BusinessDateError);
  });

  it('refuses an asserted date that is not a calendar date', () => {
    expect(assertBusinessDate('2026-08-21')).toBe('2026-08-21');
    expect(() => assertBusinessDate('21/08/2026')).toThrow(BusinessDateError);
  });
});

/**
 * Since migration 0020 a sale's trading day is its TILL's (08 §8.2a; 03
 * §3.4.2): asserted by a person when the till opened, never by the tablet's
 * clock at the moment of the sale. The location's zone still matters — it is
 * what decides when local midnight has passed and the till must close.
 */
describe('the business date a sale actually carries is its TILL’s', () => {
  async function ring(db: LocalDb, opts: { timeZone: string; till: string | false; nowIso: string }) {
    const device = await provisionDevice(db, { timeZone: opts.timeZone, till: opts.till });
    const product = await seedProduct(db, {
      code: 'P1',
      name: 'Thing',
      unitPriceE4: 50_000_000n,
      priceListId: device.priceListId,
    });
    const cartId = await createCart(db, { nowIso: opts.nowIso });
    await addProductToCart(db, cartId, product);
    return { device, cartId };
  }

  it('the sale names its till, and carries no date of its own', async () => {
    const db = openTestDb();
    const { device, cartId } = await ring(db, { timeZone: 'UTC', till: '2026-08-21', nowIso: '2026-08-21T14:00:00.000Z' });
    const result = await checkout(db, { cartId, tenderedMinor: 10_000n, hlc: fixedHlc(), nowIso: '2026-08-21T14:00:00.000Z' });
    expect(result.businessDate).toBe('2026-08-21');
    expect(result.cashSessionId).toBe(device.tillId);
    const rows = await db.getAll('SELECT payload FROM outbox');
    const payload = createSaleInput.parse(JSON.parse(String(rows[0]!['payload'])));
    expect(payload.cashSessionId).toBe(device.tillId);
    expect('businessDate' in payload).toBe(false);
    // occurredAt is the device instant, separate from the trading day.
    expect(payload.occurredAt).toBe('2026-08-21T14:00:00.000Z');
  });

  it('no till, no sale — and the cart survives the refusal', async () => {
    const db = openTestDb();
    const { cartId } = await ring(db, { timeZone: 'UTC', till: false, nowIso: '2026-08-21T14:00:00.000Z' });
    await expect(
      checkout(db, { cartId, tenderedMinor: 10_000n, hlc: fixedHlc(), nowIso: '2026-08-21T14:00:00.000Z' }),
    ).rejects.toThrow(/No till is open/);
    expect(await db.getAll('SELECT 1 FROM cart_line')).toHaveLength(1);
    expect(await db.getAll('SELECT 1 FROM outbox')).toHaveLength(0);
  });

  it('past LOCAL midnight the old till refuses the sale; the midnight close and a new till let it through', async () => {
    const db = openTestDb();
    // 23:30 UTC on the 21st is already the 22nd in Lagos (UTC+1).
    const late = '2026-08-21T23:30:00.000Z';
    const { cartId } = await ring(db, { timeZone: 'Africa/Lagos', till: '2026-08-21', nowIso: late });
    await expect(
      checkout(db, { cartId, tenderedMinor: 10_000n, hlc: fixedHlc(), nowIso: late }),
    ).rejects.toBeInstanceOf(TillClosedAtMidnightError);

    const closed = await autoCloseStaleTill(db, { hlc: fixedHlc(), nowIso: late });
    expect(closed?.till).toMatchObject({ businessDate: '2026-08-21', autoClosed: true, countedMinor: null });
    // A NEW till for the new day — never the old one extended.
    await openTill(db, { openingFloatMinor: 0n, businessDate: '2026-08-22', openedOffline: true, hlc: fixedHlc(), nowIso: late });
    const result = await checkout(db, { cartId, tenderedMinor: 10_000n, hlc: fixedHlc(), nowIso: late });
    expect(result.businessDate).toBe('2026-08-22');
    expect((await readLatestTill(db))?.businessDate).toBe('2026-08-22');
  });

  it('…and the SAME instant in a zone where it is still the 21st does not close the till', async () => {
    const db = openTestDb();
    const late = '2026-08-21T23:30:00.000Z';
    const { cartId } = await ring(db, { timeZone: 'UTC', till: '2026-08-21', nowIso: late });
    expect(await autoCloseStaleTill(db, { hlc: fixedHlc(), nowIso: late })).toBeNull();
    const result = await checkout(db, { cartId, tenderedMinor: 10_000n, hlc: fixedHlc(), nowIso: late });
    expect(result.businessDate).toBe('2026-08-21');
  });
});

