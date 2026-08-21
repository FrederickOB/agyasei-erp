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
import { checkout } from '../src/data/mutations/checkout';
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

describe('the business date a sale actually carries', () => {
  async function saleAt(db: LocalDb, timeZone: string, nowIso: string, businessDate?: string) {
    const device = await provisionDevice(db, { timeZone });
    const product = await seedProduct(db, {
      code: 'P1',
      name: 'Thing',
      unitPriceE4: 50_000_000n,
      priceListId: device.priceListId,
    });
    const cartId = await createCart(db, { nowIso });
    await addProductToCart(db, cartId, product);
    await checkout(db, {
      cartId,
      tenderedMinor: 10_000n,
      hlc: fixedHlc(),
      nowIso,
      ...(businessDate === undefined ? {} : { businessDate }),
    });
    const rows = await db.getAll('SELECT payload FROM outbox');
    return createSaleInput.parse(JSON.parse(String(rows[0]!['payload'])));
  }

  it('derives it from the location timezone at the moment of the sale', async () => {
    const late = await saleAt(openTestDb(), 'Africa/Lagos', '2026-08-21T23:30:00.000Z');
    expect(late.businessDate).toBe('2026-08-22');

    const same = await saleAt(openTestDb(), 'UTC', '2026-08-21T23:30:00.000Z');
    expect(same.businessDate).toBe('2026-08-21');
  });

  it('accepts an asserted trading day, for the day-open control that will own it', async () => {
    // §3.4.2 makes business_date human-asserted under an open cash session.
    // The session does not exist yet; the seam does, and it is honoured.
    const sale = await saleAt(openTestDb(), 'UTC', '2026-08-22T01:00:00.000Z', '2026-08-21');
    expect(sale.businessDate).toBe('2026-08-21');
  });

  it('records occurredAt as the device instant, separate from the trading day', async () => {
    const sale = await saleAt(openTestDb(), 'Africa/Lagos', '2026-08-21T23:30:00.000Z');
    expect(sale.occurredAt).toBe('2026-08-21T23:30:00.000Z');
    expect(sale.businessDate).toBe('2026-08-22');
  });
});
